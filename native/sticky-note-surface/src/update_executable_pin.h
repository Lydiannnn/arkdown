#pragma once
#include <windows.h>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace update_executable_pin {
struct CloseHandleDeleter { void operator()(void* h) const noexcept { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); } };
using Handle = std::unique_ptr<void, CloseHandleDeleter>;

// Constructed only in a failure branch. Raw paths remain internal to the main
// process; its logger converts them to trusted root aliases before writing.
struct Failure : std::runtime_error {
  const char* operation;
  std::wstring path;
  bool directory, hasNativeError;
  DWORD nativeErrorCode;
  const char* validationReason;
  Failure(const char* message, const char* operation, const std::wstring& path, bool directory,
      bool hasNativeError, DWORD nativeErrorCode, const char* validationReason)
    : std::runtime_error(message), operation(operation), path(path), directory(directory),
      hasNativeError(hasNativeError), nativeErrorCode(nativeErrorCode), validationReason(validationReason) {}
};
[[noreturn]] inline void Fail(const char* message, const char* operation, const std::wstring& path,
    bool directory, bool native, DWORD code, const char* reason) {
  // Diagnostic allocation must not replace the original product error.
  try { throw Failure(message, operation, path, directory, native, code, reason); }
  catch (const Failure&) { throw; }
  catch (...) { throw std::runtime_error(message); }
}

inline std::wstring Canonical(const std::wstring& input) {
  if (input.size() < 4 || input.size() > 32760 || input.find(L'\0') != std::wstring::npos
      || input[1] != L':' || (input[2] != L'\\' && input[2] != L'/') || input.find(L':', 2) != std::wstring::npos)
    throw std::runtime_error("Invalid update executable path");
  std::vector<wchar_t> text(32768);
  const DWORD n = GetFullPathNameW(input.c_str(), static_cast<DWORD>(text.size()), text.data(), nullptr);
  if (!n || n >= text.size()) throw std::runtime_error("Invalid update executable path");
  return std::wstring(text.data(), n);
}
inline Handle Open(const std::wstring& path, bool directory) {
  Handle handle(CreateFileW((L"\\\\?\\" + path).c_str(), directory ? FILE_READ_ATTRIBUTES : GENERIC_READ,
    FILE_SHARE_READ | (directory ? FILE_SHARE_WRITE : 0), nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr));
  if (handle.get() == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    Fail("Cannot pin update executable path", "CreateFileW", path, directory, true, error, nullptr);
  }
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(handle.get(), &info)) {
    const DWORD error = GetLastError();
    Fail("Unsafe update executable path", "GetFileInformationByHandle", path, directory, true, error, nullptr);
  }
  if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
      || !!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory || (!directory && info.nNumberOfLinks != 1))
    Fail("Unsafe update executable path", "GetFileInformationByHandle", path, directory, false, 0,
      (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ? "reparse-point" :
      (!!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory ? "entry-kind" : "hard-link"));
  std::vector<wchar_t> text(32768);
  const DWORD n = GetFinalPathNameByHandleW(handle.get(), text.data(), static_cast<DWORD>(text.size()), FILE_NAME_NORMALIZED);
  if (!n) {
    const DWORD error = GetLastError();
    Fail("Update executable path changed", "GetFinalPathNameByHandleW", path, directory, true, error, nullptr);
  }
  const std::wstring expected = L"\\\\?\\" + path;
  if (n >= text.size() || CompareStringOrdinal(text.data(), static_cast<int>(n), expected.c_str(),
      static_cast<int>(expected.size()), TRUE) != CSTR_EQUAL)
    Fail("Update executable path changed", "GetFinalPathNameByHandleW", path, directory, false, 0,
      n >= text.size() ? "path-too-long" : "path-identity");
  return handle;
}
// The image remains readable by CreateProcess, but cannot be written, removed,
// hard-link substituted or redirected through a replaced ancestor until Close.
class Lease {
  std::vector<Handle> held;
public:
  std::vector<unsigned char> bytes;
  explicit Lease(const std::wstring& input) {
    const auto path = Canonical(input);
    held.push_back(Open(path.substr(0, 3), true));
    for (size_t i = 3; i < path.size(); ++i) if (path[i] == L'\\') held.push_back(Open(path.substr(0, i), true));
    held.push_back(Open(path, false));
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(held.back().get(), &size)) {
      const DWORD error = GetLastError();
      Fail("Invalid update executable size", "GetFileSizeEx", path, false, true, error, nullptr);
    }
    if (size.QuadPart <= 0 || size.QuadPart > 2 * 1024 * 1024)
      Fail("Invalid update executable size", "GetFileSizeEx", path, false, false, 0, "invalid-size");
    bytes.resize(static_cast<size_t>(size.QuadPart));
    DWORD count = 0;
    if (!ReadFile(held.back().get(), bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr)) {
      const DWORD error = GetLastError();
      Fail("Cannot read pinned update executable", "ReadFile", path, false, true, error, nullptr);
    }
    if (count != bytes.size()) Fail("Cannot read pinned update executable", "ReadFile", path, false, false, 0, "short-read");
  }
  void Close() noexcept { held.clear(); }
};
}
