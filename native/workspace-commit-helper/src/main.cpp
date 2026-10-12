#include <windows.h>
#include <winioctl.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <map>
#include <limits>
#include <memory>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace {

constexpr std::uint32_t kProtocolVersion = 1;
constexpr std::uint32_t kMaxRequestBytes = 32U * 1024U * 1024U;
constexpr std::size_t kMaxContentBytes = 24U * 1024U * 1024U;
constexpr std::size_t kMaxDepth = 32;
constexpr std::uint64_t kWindowsToUnixTicks = 116444736000000000ULL;
constexpr ULONG kObjCaseInsensitive = 0x00000040UL;
constexpr ULONG kObjDontReparse = 0x00001000UL;
constexpr ULONG kFileDirectoryFile = 0x00000001UL;
constexpr ULONG kFileWriteThrough = 0x00000002UL;
constexpr ULONG kFileSynchronousIoNonAlert = 0x00000020UL;
constexpr ULONG kFileNonDirectoryFile = 0x00000040UL;
constexpr ULONG kFileOpenForBackupIntent = 0x00004000UL;
constexpr ULONG kFileOpenReparsePoint = 0x00200000UL;
constexpr ULONG kFileOpen = 0x00000001UL;
constexpr ULONG kFileCreate = 0x00000002UL;
constexpr int kFileRenameInformationEx = 65;

struct nt_unicode_string {
  USHORT length;
  USHORT maximum_length;
  wchar_t* buffer;
};

struct nt_object_attributes {
  ULONG length;
  HANDLE root_directory;
  nt_unicode_string* object_name;
  ULONG attributes;
  void* security_descriptor;
  void* security_quality_of_service;
};

struct nt_io_status_block {
  union { LONG status; void* pointer; };
  ULONG_PTR information;
};

using nt_create_file = LONG (NTAPI*)(
    HANDLE*, ACCESS_MASK, nt_object_attributes*, nt_io_status_block*, LARGE_INTEGER*,
    ULONG, ULONG, ULONG, ULONG, void*, ULONG);
using nt_set_information_file = LONG (NTAPI*)(HANDLE, nt_io_status_block*, void*, ULONG, int);
using rtl_status_to_dos_error = ULONG (WINAPI*)(LONG);

struct nt_api {
  nt_create_file create = nullptr;
  nt_set_information_file set = nullptr;
  rtl_status_to_dos_error to_dos = nullptr;
};

nt_api native_api() {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  return {
    ntdll ? reinterpret_cast<nt_create_file>(GetProcAddress(ntdll, "NtCreateFile")) : nullptr,
    ntdll ? reinterpret_cast<nt_set_information_file>(GetProcAddress(ntdll, "NtSetInformationFile")) : nullptr,
    ntdll ? reinterpret_cast<rtl_status_to_dos_error>(GetProcAddress(ntdll, "RtlNtStatusToDosError")) : nullptr,
  };
}

class unique_handle {
 public:
  unique_handle() noexcept = default;
  explicit unique_handle(HANDLE value) noexcept : value_(value) {}
  ~unique_handle() { reset(); }
  unique_handle(const unique_handle&) = delete;
  unique_handle& operator=(const unique_handle&) = delete;
  unique_handle(unique_handle&& other) noexcept : value_(other.release()) {}
  unique_handle& operator=(unique_handle&& other) noexcept {
    if (this != &other) reset(other.release());
    return *this;
  }
  HANDLE get() const noexcept { return value_; }
  explicit operator bool() const noexcept { return value_ != INVALID_HANDLE_VALUE && value_ != nullptr; }
  HANDLE release() noexcept { HANDLE result = value_; value_ = INVALID_HANDLE_VALUE; return result; }
  void reset(HANDLE value = INVALID_HANDLE_VALUE) noexcept {
    if (*this) CloseHandle(value_);
    value_ = value;
  }

 private:
  HANDLE value_ = INVALID_HANDLE_VALUE;
};

struct Json {
  enum class Type { null_value, boolean, number, string, array, object };
  Type type = Type::null_value;
  bool boolean = false;
  std::int64_t number = 0;
  std::string string;
  std::vector<Json> array;
  std::vector<std::pair<std::string, Json>> object;
};

class JsonParser {
 public:
  explicit JsonParser(std::string_view input) : input_(input) {}

  Json parse() {
    skip_space();
    Json value = parse_value(0);
    skip_space();
    if (position_ != input_.size()) fail();
    return value;
  }

 private:
  [[noreturn]] static void fail() { throw std::runtime_error("invalid json"); }

  void skip_space() {
    while (position_ < input_.size()) {
      const char value = input_[position_];
      if (value != ' ' && value != '\t' && value != '\r' && value != '\n') break;
      ++position_;
    }
  }

  bool consume(char value) {
    if (position_ < input_.size() && input_[position_] == value) {
      ++position_;
      return true;
    }
    return false;
  }

  Json parse_value(std::size_t depth) {
    if (depth > kMaxDepth || position_ >= input_.size()) fail();
    switch (input_[position_]) {
      case '{': return parse_object(depth + 1);
      case '[': return parse_array(depth + 1);
      case '"': { Json value; value.type = Json::Type::string; value.string = parse_string(); return value; }
      case 't': return parse_literal("true", Json::Type::boolean, true);
      case 'f': return parse_literal("false", Json::Type::boolean, false);
      case 'n': return parse_literal("null", Json::Type::null_value, false);
      default: return parse_number();
    }
  }

  Json parse_literal(std::string_view text, Json::Type type, bool boolean) {
    if (input_.substr(position_, text.size()) != text) fail();
    position_ += text.size();
    Json value; value.type = type; value.boolean = boolean; return value;
  }

  Json parse_number() {
    const std::size_t start = position_;
    if (consume('-') && position_ >= input_.size()) fail();
    if (consume('0')) {
      if (position_ < input_.size() && input_[position_] >= '0' && input_[position_] <= '9') fail();
    } else {
      if (position_ >= input_.size() || input_[position_] < '1' || input_[position_] > '9') fail();
      while (position_ < input_.size() && input_[position_] >= '0' && input_[position_] <= '9') ++position_;
    }
    if (position_ < input_.size()
        && (input_[position_] == '.' || input_[position_] == 'e' || input_[position_] == 'E')) fail();
    std::int64_t number = 0;
    const auto result = std::from_chars(input_.data() + start, input_.data() + position_, number);
    if (result.ec != std::errc{} || result.ptr != input_.data() + position_) fail();
    Json value; value.type = Json::Type::number; value.number = number; return value;
  }

  static unsigned hex(char value) {
    if (value >= '0' && value <= '9') return static_cast<unsigned>(value - '0');
    if (value >= 'a' && value <= 'f') return static_cast<unsigned>(value - 'a' + 10);
    if (value >= 'A' && value <= 'F') return static_cast<unsigned>(value - 'A' + 10);
    fail();
  }

  std::uint32_t unicode_escape() {
    if (position_ + 4 > input_.size()) fail();
    std::uint32_t value = 0;
    for (int index = 0; index < 4; ++index) value = (value << 4U) | hex(input_[position_++]);
    if (value >= 0xD800U && value <= 0xDBFFU) {
      if (position_ + 6 > input_.size() || input_[position_] != '\\' || input_[position_ + 1] != 'u') fail();
      position_ += 2;
      std::uint32_t low = 0;
      for (int index = 0; index < 4; ++index) low = (low << 4U) | hex(input_[position_++]);
      if (low < 0xDC00U || low > 0xDFFFU) fail();
      value = 0x10000U + ((value - 0xD800U) << 10U) + (low - 0xDC00U);
    } else if (value >= 0xDC00U && value <= 0xDFFFU) {
      fail();
    }
    if (value == 0) fail();
    return value;
  }

  static void append_utf8(std::string& output, std::uint32_t value) {
    if (value <= 0x7FU) output.push_back(static_cast<char>(value));
    else if (value <= 0x7FFU) {
      output.push_back(static_cast<char>(0xC0U | (value >> 6U)));
      output.push_back(static_cast<char>(0x80U | (value & 0x3FU)));
    } else if (value <= 0xFFFFU) {
      output.push_back(static_cast<char>(0xE0U | (value >> 12U)));
      output.push_back(static_cast<char>(0x80U | ((value >> 6U) & 0x3FU)));
      output.push_back(static_cast<char>(0x80U | (value & 0x3FU)));
    } else {
      output.push_back(static_cast<char>(0xF0U | (value >> 18U)));
      output.push_back(static_cast<char>(0x80U | ((value >> 12U) & 0x3FU)));
      output.push_back(static_cast<char>(0x80U | ((value >> 6U) & 0x3FU)));
      output.push_back(static_cast<char>(0x80U | (value & 0x3FU)));
    }
  }

  std::string parse_string() {
    if (!consume('"')) fail();
    std::string output;
    while (position_ < input_.size()) {
      const unsigned char value = static_cast<unsigned char>(input_[position_++]);
      if (value == '"') return output;
      if (value < 0x20U || value == 0) fail();
      if (value != '\\') { output.push_back(static_cast<char>(value)); continue; }
      if (position_ >= input_.size()) fail();
      switch (input_[position_++]) {
        case '"': output.push_back('"'); break;
        case '\\': output.push_back('\\'); break;
        case '/': output.push_back('/'); break;
        case 'b': output.push_back('\b'); break;
        case 'f': output.push_back('\f'); break;
        case 'n': output.push_back('\n'); break;
        case 'r': output.push_back('\r'); break;
        case 't': output.push_back('\t'); break;
        case 'u': append_utf8(output, unicode_escape()); break;
        default: fail();
      }
    }
    fail();
  }

  Json parse_array(std::size_t depth) {
    consume('[');
    Json value; value.type = Json::Type::array;
    skip_space();
    if (consume(']')) return value;
    do {
      skip_space();
      value.array.push_back(parse_value(depth));
      if (value.array.size() > 64) fail();
      skip_space();
      if (consume(']')) return value;
      if (!consume(',')) fail();
    } while (true);
  }

  Json parse_object(std::size_t depth) {
    consume('{');
    Json value; value.type = Json::Type::object;
    skip_space();
    if (consume('}')) return value;
    do {
      skip_space();
      const std::string key = parse_string();
      if (std::any_of(value.object.begin(), value.object.end(), [&](const auto& item) { return item.first == key; })) fail();
      skip_space();
      if (!consume(':')) fail();
      skip_space();
      value.object.emplace_back(key, parse_value(depth));
      if (value.object.size() > 32) fail();
      skip_space();
      if (consume('}')) return value;
      if (!consume(',')) fail();
    } while (true);
  }

  std::string_view input_;
  std::size_t position_ = 0;
};

const Json& field(const Json& value, std::string_view name) {
  if (value.type != Json::Type::object) throw std::runtime_error("schema");
  for (const auto& item : value.object) if (item.first == name) return item.second;
  throw std::runtime_error("schema");
}

bool exact_keys(const Json& value, std::initializer_list<std::string_view> keys) {
  if (value.type != Json::Type::object || value.object.size() != keys.size()) return false;
  std::set<std::string_view> expected(keys);
  for (const auto& item : value.object) if (!expected.contains(item.first)) return false;
  return true;
}

const std::string& string_value(const Json& value) {
  if (value.type != Json::Type::string) throw std::runtime_error("schema");
  return value.string;
}

std::uint64_t unsigned_number(const Json& value) {
  if (value.type != Json::Type::number || value.number < 0) throw std::runtime_error("schema");
  return static_cast<std::uint64_t>(value.number);
}

std::wstring utf16(std::string_view value) {
  if (value.empty()) return {};
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (size <= 0) throw std::runtime_error("utf8");
  std::wstring result(static_cast<std::size_t>(size), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size) != size) {
    throw std::runtime_error("utf8");
  }
  return result;
}

std::string utf8(std::wstring_view value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) throw std::runtime_error("utf16");
  std::string result(static_cast<std::size_t>(size), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr) != size) {
    throw std::runtime_error("utf16");
  }
  return result;
}

bool equals_path(std::wstring_view first, std::wstring_view second) {
  if (first.size() > static_cast<std::size_t>(INT_MAX) || second.size() > static_cast<std::size_t>(INT_MAX)) return false;
  return CompareStringOrdinal(first.data(), static_cast<int>(first.size()), second.data(), static_cast<int>(second.size()), TRUE) == CSTR_EQUAL;
}

std::wstring extended(std::wstring_view path) {
  return path.rfind(L"\\\\", 0) == 0 ? L"\\\\?\\UNC\\" + std::wstring(path.substr(2)) : L"\\\\?\\" + std::wstring(path);
}

std::wstring final_path(HANDLE handle) {
  const DWORD needed = GetFinalPathNameByHandleW(handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (needed == 0 || needed > 32768) throw std::runtime_error("final path");
  std::wstring buffer(static_cast<std::size_t>(needed), L'\0');
  const DWORD written = GetFinalPathNameByHandleW(handle, buffer.data(), needed, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (written == 0 || written >= needed) throw std::runtime_error("final path");
  buffer.resize(written);
  if (buffer.rfind(L"\\\\?\\UNC\\", 0) == 0) buffer = L"\\\\" + buffer.substr(8);
  else if (buffer.rfind(L"\\\\?\\", 0) == 0) buffer.erase(0, 4);
  return buffer;
}

bool valid_uuid(std::string_view value) {
  if (value.size() != 36) return false;
  for (std::size_t index = 0; index < value.size(); ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (value[index] != '-') return false;
    } else if (!((value[index] >= '0' && value[index] <= '9') || (value[index] >= 'a' && value[index] <= 'f'))) return false;
  }
  return value[14] >= '1' && value[14] <= '5'
      && (value[19] == '8' || value[19] == '9' || value[19] == 'a' || value[19] == 'b');
}

bool valid_hex(std::string_view value, std::size_t exact = 0) {
  if (value.empty() || (exact != 0 && value.size() != exact)) return false;
  return std::all_of(value.begin(), value.end(), [](char item) {
    return (item >= '0' && item <= '9') || (item >= 'a' && item <= 'f');
  });
}

std::uint64_t parse_hex(std::string_view value) {
  if (!valid_hex(value) || value.size() > 16) throw std::runtime_error("hex");
  std::uint64_t result = 0;
  const auto parsed = std::from_chars(value.data(), value.data() + value.size(), result, 16);
  if (parsed.ec != std::errc{} || parsed.ptr != value.data() + value.size()) throw std::runtime_error("hex");
  return result;
}

bool reserved_component(std::wstring value) {
  const std::size_t dot = value.find(L'.');
  if (dot != std::wstring::npos) value.resize(dot);
  std::transform(value.begin(), value.end(), value.begin(), towupper);
  if (value == L"CON" || value == L"PRN" || value == L"AUX" || value == L"NUL"
      || value == L"CONIN$" || value == L"CONOUT$") return true;
  if (value.size() == 4 && (value.rfind(L"COM", 0) == 0 || value.rfind(L"LPT", 0) == 0)
      && ((value[3] >= L'1' && value[3] <= L'9')
          || value[3] == L'\u00b9' || value[3] == L'\u00b2' || value[3] == L'\u00b3')) return true;
  return false;
}

std::vector<std::wstring> validate_relative(std::string_view value, bool allow_empty) {
  if (value.empty()) {
    if (allow_empty) return {};
    throw std::runtime_error("path");
  }
  if (value.size() > 32760 || value.front() == '/' || value.back() == '/' || value.find('\\') != std::string_view::npos) {
    throw std::runtime_error("path");
  }
  std::vector<std::wstring> result;
  std::size_t start = 0;
  while (start < value.size()) {
    const std::size_t slash = value.find('/', start);
    const std::string_view raw = value.substr(start, slash == std::string_view::npos ? value.size() - start : slash - start);
    if (raw.empty() || raw == "." || raw == ".." || raw.size() > 1024) throw std::runtime_error("path");
    if (raw.find_first_of(":*?\"<>|") != std::string_view::npos) throw std::runtime_error("path");
    std::wstring component = utf16(raw);
    if (component.empty() || component.size() > 255 || component.back() == L'.' || component.back() == L' '
        || reserved_component(component)) throw std::runtime_error("path");
    for (const wchar_t item : component) if (item < 0x20) throw std::runtime_error("path");
    result.push_back(std::move(component));
    if (slash == std::string_view::npos) break;
    start = slash + 1;
  }
  return result;
}

std::wstring join_relative(std::wstring_view root, const std::vector<std::wstring>& components) {
  std::wstring result(root);
  for (const auto& component : components) {
    if (!result.empty() && result.back() != L'\\') result.push_back(L'\\');
    result += component;
  }
  return result;
}

std::wstring validate_root(std::string_view raw) {
  std::wstring root = utf16(raw);
  if (root.size() < 3 || root.size() > 32760 || root[1] != L':' || root[2] != L'\\'
      || !((root[0] >= L'A' && root[0] <= L'Z') || (root[0] >= L'a' && root[0] <= L'z'))
      || root.rfind(L"\\\\", 0) == 0 || root.rfind(L"\\\\?\\", 0) == 0 || root.rfind(L"\\\\.\\", 0) == 0
      || root.find(L'/', 0) != std::wstring::npos || root.find(L':', 2) != std::wstring::npos) {
    throw std::runtime_error("root path");
  }
  const DWORD needed = GetFullPathNameW(root.c_str(), 0, nullptr, nullptr);
  if (needed == 0 || needed > 32768) throw std::runtime_error("root path");
  std::wstring normalized(static_cast<std::size_t>(needed), L'\0');
  const DWORD written = GetFullPathNameW(root.c_str(), needed, normalized.data(), nullptr);
  if (written == 0 || written >= needed) throw std::runtime_error("root path");
  normalized.resize(written);
  if (!equals_path(root, normalized)) throw std::runtime_error("root path");
  return root;
}

struct Identity { std::uint64_t volume = 0; std::uint64_t file = 0; };

Identity identity(HANDLE handle) {
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(handle, &info)) throw std::runtime_error("identity");
  return { info.dwVolumeSerialNumber, (static_cast<std::uint64_t>(info.nFileIndexHigh) << 32U) | info.nFileIndexLow };
}

bool same_identity(Identity first, Identity second) { return first.volume == second.volume && first.file == second.file; }

Identity compatibility_identity(std::string_view value) {
  const std::size_t dot = value.find('.');
  if (dot == std::string_view::npos || value.find('.', dot + 1) != std::string_view::npos) throw std::runtime_error("identity");
  return { parse_hex(value.substr(0, dot)), parse_hex(value.substr(dot + 1)) };
}

void reject_reparse(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info))
      || (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw std::runtime_error("reparse");
}

bool safe_held_directory(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  BY_HANDLE_FILE_INFORMATION metadata{};
  return handle != nullptr && handle != INVALID_HANDLE_VALUE
      && GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &attributes, sizeof(attributes))
      && (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0
      && (attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0
      && GetFileInformationByHandle(handle, &metadata)
      && (metadata.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0
      && (metadata.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

unique_handle open_path(const std::wstring& absolute, DWORD access, DWORD share, bool directory) {
  const DWORD flags = FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0);
  unique_handle handle(CreateFileW(extended(absolute).c_str(), access, share, nullptr, OPEN_EXISTING, flags, nullptr));
  if (!handle) throw std::runtime_error("open");
  reject_reparse(handle.get());
  const DWORD type = GetFileType(handle.get());
  if (type != FILE_TYPE_DISK) throw std::runtime_error("type");
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(handle.get(), &info)) throw std::runtime_error("metadata");
  const bool actual_directory = (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  if (actual_directory != directory) throw std::runtime_error("type");
  if (!equals_path(final_path(handle.get()), absolute)) throw std::runtime_error("path changed");
  return handle;
}

void wait_at_named_test_barrier(const wchar_t* environment_name);
bool dispose_handle(HANDLE handle);

unique_handle relative_file(
    HANDLE parent,
    std::wstring_view name,
    ACCESS_MASK access,
    ULONG share,
    ULONG disposition,
    ULONG attributes,
    bool directory,
    void* security_descriptor = nullptr) {
  if (!safe_held_directory(parent) || name.empty() || name.size() > 255
      || name.find_first_of(L"\\/") != std::wstring_view::npos) throw std::runtime_error("parent changed");
  const Identity parent_identity = identity(parent);
  nt_api api = native_api();
  if (!api.create || !api.to_dos) throw std::runtime_error("native api");
  std::wstring owned_name(name);
  nt_unicode_string unicode{
    static_cast<USHORT>(owned_name.size() * sizeof(wchar_t)),
    static_cast<USHORT>(owned_name.size() * sizeof(wchar_t)),
    owned_name.data(),
  };
  nt_object_attributes object{
    sizeof(object), parent, &unicode, kObjCaseInsensitive | kObjDontReparse,
    security_descriptor, nullptr,
  };
  nt_io_status_block status{};
  HANDLE raw = INVALID_HANDLE_VALUE;
  const ULONG options = (directory ? kFileDirectoryFile : kFileNonDirectoryFile)
      | kFileSynchronousIoNonAlert | kFileOpenForBackupIntent | kFileOpenReparsePoint
      | (disposition == kFileCreate ? kFileWriteThrough : 0UL);
  if (disposition != kFileOpen) {
    wait_at_named_test_barrier(L"ARKDOWN_WORKSPACE_COMMIT_TEST_NAMESPACE_BARRIER");
  }
  const LONG result = api.create(&raw, access, &object, &status, nullptr, attributes,
      share, disposition, options, nullptr, 0);
  if (result < 0) {
    SetLastError(api.to_dos(result));
    throw std::runtime_error("relative open");
  }
  unique_handle handle(raw);
  reject_reparse(handle.get());
  BY_HANDLE_FILE_INFORMATION metadata{};
  if (GetFileType(handle.get()) != FILE_TYPE_DISK
      || !GetFileInformationByHandle(handle.get(), &metadata)
      || (((metadata.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory)) {
    throw std::runtime_error("relative type");
  }
  bool parent_still_safe = false;
  try {
    parent_still_safe = safe_held_directory(parent)
        && same_identity(identity(parent), parent_identity);
  } catch (...) { parent_still_safe = false; }
  if (!parent_still_safe) {
    if (disposition == kFileOpen) throw std::runtime_error("parent changed");
    const bool created = status.information == 2;
    const bool cleaned = !created || dispose_handle(handle.get());
    throw std::runtime_error(cleaned ? "parent changed" : "cleanup_ambiguous");
  }
  return handle;
}

std::string hex_bytes(const unsigned char* bytes, std::size_t length) {
  static constexpr char alphabet[] = "0123456789abcdef";
  std::string result(length * 2, '0');
  for (std::size_t index = 0; index < length; ++index) {
    result[index * 2] = alphabet[bytes[index] >> 4U];
    result[index * 2 + 1] = alphabet[bytes[index] & 0x0FU];
  }
  return result;
}

std::string sha256_handle(HANDLE handle, std::vector<unsigned char>* captured = nullptr, std::size_t limit = kMaxContentBytes) {
  LARGE_INTEGER zero{};
  if (!SetFilePointerEx(handle, zero, nullptr, FILE_BEGIN)) throw std::runtime_error("seek");
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  std::vector<unsigned char> object;
  std::array<unsigned char, 32> digest{};
  DWORD object_size = 0;
  DWORD returned = 0;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0
      || BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size), &returned, 0) < 0) {
    if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
    throw std::runtime_error("hash");
  }
  object.resize(object_size);
  if (BCryptCreateHash(algorithm, &hash, object.data(), object_size, nullptr, 0, 0) < 0) {
    BCryptCloseAlgorithmProvider(algorithm, 0); throw std::runtime_error("hash");
  }
  std::array<unsigned char, 64 * 1024> buffer{};
  std::size_t total = 0;
  try {
    while (true) {
      DWORD read = 0;
      if (!ReadFile(handle, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) throw std::runtime_error("read");
      if (read == 0) break;
      total += read;
      if (total > limit) throw std::runtime_error("oversize");
      if (captured) captured->insert(captured->end(), buffer.begin(), buffer.begin() + read);
      if (BCryptHashData(hash, buffer.data(), read, 0) < 0) throw std::runtime_error("hash");
    }
    if (BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) < 0) throw std::runtime_error("hash");
  } catch (...) {
    BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(algorithm, 0); throw;
  }
  BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  return hex_bytes(digest.data(), digest.size());
}

std::vector<unsigned char> decode_base64(std::string_view input) {
  if (input.size() > (kMaxContentBytes * 4U / 3U + 8U) || input.size() % 4U != 0) throw std::runtime_error("base64");
  std::array<int, 256> table{};
  table.fill(-1);
  const std::string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (std::size_t index = 0; index < alphabet.size(); ++index) table[static_cast<unsigned char>(alphabet[index])] = static_cast<int>(index);
  std::vector<unsigned char> output;
  output.reserve(input.size() / 4U * 3U);
  for (std::size_t index = 0; index < input.size(); index += 4U) {
    const bool last = index + 4U == input.size();
    const char a = input[index], b = input[index + 1], c = input[index + 2], d = input[index + 3];
    if (table[static_cast<unsigned char>(a)] < 0 || table[static_cast<unsigned char>(b)] < 0
        || (c != '=' && table[static_cast<unsigned char>(c)] < 0)
        || (d != '=' && table[static_cast<unsigned char>(d)] < 0)
        || (!last && (c == '=' || d == '=')) || (c == '=' && d != '=')) throw std::runtime_error("base64");
    const std::uint32_t packed = (static_cast<std::uint32_t>(table[static_cast<unsigned char>(a)]) << 18U)
        | (static_cast<std::uint32_t>(table[static_cast<unsigned char>(b)]) << 12U)
        | (c == '=' ? 0U : static_cast<std::uint32_t>(table[static_cast<unsigned char>(c)]) << 6U)
        | (d == '=' ? 0U : static_cast<std::uint32_t>(table[static_cast<unsigned char>(d)]));
    output.push_back(static_cast<unsigned char>(packed >> 16U));
    if (c != '=') output.push_back(static_cast<unsigned char>(packed >> 8U));
    if (d != '=') output.push_back(static_cast<unsigned char>(packed));
  }
  if (output.size() > kMaxContentBytes) throw std::runtime_error("base64");
  return output;
}

struct RootRequest {
  std::wstring absolute;
  std::uint64_t activation_epoch = 0;
  Identity identity;
};
struct DirectoryRequest { std::wstring absolute; std::string relative_utf8; std::vector<std::wstring> components; Identity identity; };
struct FileRequest {
  std::wstring absolute;
  std::string relative_utf8;
  std::vector<std::wstring> components;
  Identity identity;
  std::uint64_t size = 0;
  std::uint64_t mtime_ms = 0;
  std::string ctime_ns;
  std::string revision;
};
struct DestinationRequest { std::wstring absolute; std::string relative_utf8; std::vector<std::wstring> components; };
enum class Operation { edit, create, rename, recycle };
struct Request {
  std::string request_id;
  Operation operation{};
  RootRequest root;
  std::vector<DirectoryRequest> parents;
  std::optional<FileRequest> source;
  std::optional<DestinationRequest> destination;
  std::vector<unsigned char> content;
};

std::wstring expected_absolute(const RootRequest& root, const std::vector<std::wstring>& components, std::string_view supplied) {
  const std::wstring absolute = utf16(supplied);
  const std::wstring expected = join_relative(root.absolute, components);
  if (!equals_path(absolute, expected)) throw std::runtime_error("path mismatch");
  return absolute;
}

RootRequest parse_root(const Json& value) {
  if (!exact_keys(value, {"rootFinalPath", "activationEpoch", "rootVolumeSerial", "rootFileId"})) throw std::runtime_error("schema");
  RootRequest root;
  root.absolute = validate_root(string_value(field(value, "rootFinalPath")));
  root.activation_epoch = unsigned_number(field(value, "activationEpoch"));
  if (root.activation_epoch == 0) throw std::runtime_error("schema");
  root.identity = { parse_hex(string_value(field(value, "rootVolumeSerial"))), parse_hex(string_value(field(value, "rootFileId"))) };
  return root;
}

DirectoryRequest parse_directory(const Json& value, const RootRequest& root) {
  if (!exact_keys(value, {"absolutePath", "relativePath", "fileId"})) throw std::runtime_error("schema");
  DirectoryRequest result;
  result.relative_utf8 = string_value(field(value, "relativePath"));
  result.components = validate_relative(result.relative_utf8, true);
  result.absolute = expected_absolute(root, result.components, string_value(field(value, "absolutePath")));
  result.identity = compatibility_identity(string_value(field(value, "fileId")));
  return result;
}

FileRequest parse_file(const Json& value, const RootRequest& root) {
  if (!exact_keys(value, {"absolutePath", "relativePath", "fileId", "size", "mtimeMs", "ctimeNs", "revision"})) throw std::runtime_error("schema");
  FileRequest result;
  result.relative_utf8 = string_value(field(value, "relativePath"));
  result.components = validate_relative(result.relative_utf8, false);
  result.absolute = expected_absolute(root, result.components, string_value(field(value, "absolutePath")));
  result.identity = compatibility_identity(string_value(field(value, "fileId")));
  result.size = unsigned_number(field(value, "size"));
  result.mtime_ms = unsigned_number(field(value, "mtimeMs"));
  result.ctime_ns = string_value(field(value, "ctimeNs"));
  result.revision = string_value(field(value, "revision"));
  if (result.size > kMaxContentBytes || result.ctime_ns.empty()
      || !std::all_of(result.ctime_ns.begin(), result.ctime_ns.end(), [](char item) { return item >= '0' && item <= '9'; })
      || !valid_hex(result.revision, 64)) throw std::runtime_error("schema");
  return result;
}

DestinationRequest parse_destination(const Json& value, const RootRequest& root) {
  if (!exact_keys(value, {"absolutePath", "relativePath"})) throw std::runtime_error("schema");
  DestinationRequest result;
  result.relative_utf8 = string_value(field(value, "relativePath"));
  result.components = validate_relative(result.relative_utf8, false);
  result.absolute = expected_absolute(root, result.components, string_value(field(value, "absolutePath")));
  return result;
}

std::string parent_relative(std::string_view relative) {
  const std::size_t slash = relative.rfind('/');
  return slash == std::string_view::npos ? std::string{} : std::string(relative.substr(0, slash));
}

Request parse_request(const Json& envelope) {
  if (!exact_keys(envelope, {"protocolVersion", "requestId", "command", "request"})
      || unsigned_number(field(envelope, "protocolVersion")) != kProtocolVersion
      || string_value(field(envelope, "command")) != "commit") throw std::runtime_error("schema");
  Request request;
  request.request_id = string_value(field(envelope, "requestId"));
  if (!valid_uuid(request.request_id)) throw std::runtime_error("schema");
  const Json& body = field(envelope, "request");
  const std::string kind = string_value(field(body, "kind"));
  if (kind == "edit") request.operation = Operation::edit;
  else if (kind == "create") request.operation = Operation::create;
  else if (kind == "rename") request.operation = Operation::rename;
  else if (kind == "recycle") request.operation = Operation::recycle;
  else throw std::runtime_error("schema");
  if ((request.operation == Operation::edit && !exact_keys(body, {"kind", "root", "source", "parents", "contentBase64"}))
      || (request.operation == Operation::create && !exact_keys(body, {"kind", "root", "destination", "parents", "contentBase64"}))
      || (request.operation == Operation::rename && !exact_keys(body, {"kind", "root", "source", "destination", "parents"}))
      || (request.operation == Operation::recycle && !exact_keys(body, {"kind", "root", "source", "parents"}))) throw std::runtime_error("schema");
  request.root = parse_root(field(body, "root"));
  const Json& parents = field(body, "parents");
  if (parents.type != Json::Type::array || parents.array.empty() || parents.array.size() > 2) throw std::runtime_error("schema");
  for (const Json& parent : parents.array) request.parents.push_back(parse_directory(parent, request.root));
  if (request.operation != Operation::create) request.source = parse_file(field(body, "source"), request.root);
  if (request.operation == Operation::create || request.operation == Operation::rename) {
    request.destination = parse_destination(field(body, "destination"), request.root);
  }
  if (request.operation == Operation::edit || request.operation == Operation::create) {
    request.content = decode_base64(string_value(field(body, "contentBase64")));
  }
  std::set<std::string> required;
  if (request.source) required.insert(parent_relative(request.source->relative_utf8));
  if (request.destination) required.insert(parent_relative(request.destination->relative_utf8));
  std::set<std::string> supplied;
  for (const auto& parent : request.parents) supplied.insert(parent.relative_utf8);
  if (required != supplied || supplied.size() != request.parents.size()) throw std::runtime_error("schema");
  return request;
}

bool read_exact(HANDLE input, void* target, DWORD length) {
  auto* bytes = static_cast<unsigned char*>(target);
  DWORD offset = 0;
  while (offset < length) {
    DWORD read = 0;
    if (!ReadFile(input, bytes + offset, length - offset, &read, nullptr) || read == 0) return false;
    offset += read;
  }
  return true;
}

bool write_all(HANDLE output, const void* source, DWORD length) {
  const auto* bytes = static_cast<const unsigned char*>(source);
  DWORD offset = 0;
  while (offset < length) {
    DWORD written = 0;
    if (!WriteFile(output, bytes + offset, length - offset, &written, nullptr) || written == 0) return false;
    offset += written;
  }
  return true;
}

bool write_response(const std::string& request_id, std::string_view status, std::string_view reason = {}) {
  std::string body = "{\"protocolVersion\":1,\"requestId\":\"" + request_id + "\",\"status\":\"" + std::string(status) + "\"";
  if (!reason.empty()) body += ",\"reason\":\"" + std::string(reason) + "\"";
  body.push_back('}');
  const std::uint32_t length = static_cast<std::uint32_t>(body.size());
  std::array<unsigned char, 4> header{
    static_cast<unsigned char>(length), static_cast<unsigned char>(length >> 8U),
    static_cast<unsigned char>(length >> 16U), static_cast<unsigned char>(length >> 24U),
  };
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  return write_all(output, header.data(), static_cast<DWORD>(header.size()))
      && write_all(output, body.data(), length);
}

std::optional<Json> read_input() {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  std::array<unsigned char, 4> header{};
  if (!read_exact(input, header.data(), static_cast<DWORD>(header.size()))) return std::nullopt;
  const std::uint32_t length = static_cast<std::uint32_t>(header[0])
      | (static_cast<std::uint32_t>(header[1]) << 8U)
      | (static_cast<std::uint32_t>(header[2]) << 16U)
      | (static_cast<std::uint32_t>(header[3]) << 24U);
  if (length == 0 || length > kMaxRequestBytes) return std::nullopt;
  std::string body(length, '\0');
  if (!read_exact(input, body.data(), length)) return std::nullopt;
  unsigned char extra = 0;
  DWORD read = 0;
  if (!ReadFile(input, &extra, 1, &read, nullptr)) {
    if (GetLastError() != ERROR_BROKEN_PIPE) return std::nullopt;
    read = 0;
  }
  if (read != 0) return std::nullopt;
  if (body.size() >= 3 && static_cast<unsigned char>(body[0]) == 0xEFU
      && static_cast<unsigned char>(body[1]) == 0xBBU && static_cast<unsigned char>(body[2]) == 0xBFU) return std::nullopt;
  if (!body.empty() && MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, body.data(), static_cast<int>(body.size()), nullptr, 0) <= 0) return std::nullopt;
  try { return JsonParser(body).parse(); } catch (...) { return std::nullopt; }
}

struct OpenedContext {
  RootRequest request;
  unique_handle root;
  std::map<std::string, unique_handle> directories;
  std::map<std::string, Identity> directory_identities;
  std::map<std::string, std::wstring> directory_paths;
};

std::string folded(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char item) { return static_cast<char>(std::tolower(item)); });
  return value;
}

OpenedContext open_context(const Request& request) {
  OpenedContext context;
  context.request = request.root;
  // Delete sharing remains forbidden so a held directory identity cannot be
  // renamed/replaced. NTFS requires write sharing for the helper's own
  // handle-relative namespace operations; reparse changes are detected by
  // before/after checks and can never redirect a RootDirectory-relative call.
  context.root = open_path(request.root.absolute, FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | FILE_TRAVERSE | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE, true);
  wchar_t filesystem[32]{};
  if (!GetVolumeInformationByHandleW(context.root.get(), nullptr, 0, nullptr, nullptr, nullptr, filesystem, static_cast<DWORD>(std::size(filesystem)))
      || _wcsicmp(filesystem, L"NTFS") != 0) throw std::runtime_error("unsupported filesystem");
  if (!same_identity(identity(context.root.get()), request.root.identity)) throw std::runtime_error("root changed");
  context.directories.emplace("", unique_handle{});

  for (const auto& parent : request.parents) {
    std::wstring current = request.root.absolute;
    std::string relative;
    HANDLE namespace_parent = context.root.get();
    for (std::size_t index = 0; index < parent.components.size(); ++index) {
      if (!relative.empty()) relative.push_back('/');
      relative += utf8(parent.components[index]);
      const std::string key = folded(relative);
      if (!context.directories.contains(key)) {
        if (!current.empty() && current.back() != L'\\') current.push_back(L'\\');
        current += parent.components[index];
        unique_handle opened = relative_file(namespace_parent, parent.components[index],
            FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | FILE_TRAVERSE | SYNCHRONIZE,
            FILE_SHARE_READ | FILE_SHARE_WRITE, kFileOpen, FILE_ATTRIBUTE_NORMAL, true);
        if (!equals_path(final_path(opened.get()), current)) throw std::runtime_error("parent changed");
        context.directory_identities.emplace(key, identity(opened.get()));
        context.directory_paths.emplace(key, current);
        context.directories.emplace(key, std::move(opened));
      } else {
        if (!current.empty() && current.back() != L'\\') current.push_back(L'\\');
        current += parent.components[index];
      }
      namespace_parent = context.directories.at(key).get();
    }
  }
  for (const auto& parent : request.parents) {
    HANDLE handle = parent.relative_utf8.empty() ? context.root.get() : context.directories.at(folded(parent.relative_utf8)).get();
    if (!same_identity(identity(handle), parent.identity) || !equals_path(final_path(handle), parent.absolute)) {
      throw std::runtime_error("parent changed");
    }
  }
  return context;
}

HANDLE parent_handle(OpenedContext& context, std::string_view relative) {
  if (relative.empty()) return context.root.get();
  return context.directories.at(folded(std::string(relative))).get();
}

std::uint64_t filetime_to_unix_ns(LARGE_INTEGER value) {
  const std::uint64_t ticks = static_cast<std::uint64_t>(value.QuadPart);
  if (ticks < kWindowsToUnixTicks) throw std::runtime_error("time");
  return (ticks - kWindowsToUnixTicks) * 100ULL;
}

bool verify_source_metadata(HANDLE handle, const FileRequest& source, bool hash_content = true) {
  try {
    if (!same_identity(identity(handle), source.identity) || !equals_path(final_path(handle), source.absolute)) return false;
    FILE_STANDARD_INFO standard{};
    FILE_BASIC_INFO basic{};
    if (!GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard))
        || !GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic))
        || standard.Directory || standard.NumberOfLinks != 1 || standard.EndOfFile.QuadPart < 0) return false;
    const std::uint64_t size = static_cast<std::uint64_t>(standard.EndOfFile.QuadPart);
    const std::uint64_t mtime = filetime_to_unix_ns(basic.LastWriteTime) / 1000000ULL;
    const std::uint64_t ctime = filetime_to_unix_ns(basic.ChangeTime);
    if (size != source.size || mtime != source.mtime_ms || std::to_string(ctime) != source.ctime_ns) return false;
    return !hash_content || sha256_handle(handle) == source.revision;
  } catch (...) { return false; }
}

unique_handle open_source(const Request& request, OpenedContext& context) {
  DWORD access = GENERIC_READ | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  if (request.operation == Operation::edit) access |= GENERIC_WRITE;
  if (request.operation == Operation::rename || request.operation == Operation::recycle) access |= DELETE;
  // A held source identity never permits a concurrent writer or deleter. The
  // helper itself owns DELETE access when a handle rename is required.
  const DWORD share = FILE_SHARE_READ;
  HANDLE parent = parent_handle(context, parent_relative(request.source->relative_utf8));
  unique_handle source = relative_file(parent, request.source->components.back(), access, share,
      kFileOpen, FILE_ATTRIBUTE_NORMAL, false);
  if (!verify_source_metadata(source.get(), *request.source)) throw std::runtime_error("source changed");
  return source;
}

bool reverify_context(OpenedContext& context, const Request& request) {
  try {
    if (!safe_held_directory(context.root.get())
        || !same_identity(identity(context.root.get()), request.root.identity)
        || !equals_path(final_path(context.root.get()), request.root.absolute)) return false;
    for (const auto& [key, held] : context.directories) {
      if (!held) continue;
      const auto expected_identity = context.directory_identities.find(key);
      const auto expected_path = context.directory_paths.find(key);
      if (expected_identity == context.directory_identities.end()
          || expected_path == context.directory_paths.end()
          || !safe_held_directory(held.get())
          || !same_identity(identity(held.get()), expected_identity->second)
          || !equals_path(final_path(held.get()), expected_path->second)) return false;
    }
    for (const auto& parent : request.parents) {
      HANDLE handle = parent_handle(context, parent.relative_utf8);
      if (!safe_held_directory(handle)
          || !same_identity(identity(handle), parent.identity)
          || !equals_path(final_path(handle), parent.absolute)) return false;
    }
    return true;
  } catch (...) { return false; }
}

#ifdef ARKDOWN_HELPER_TEST_HOOKS
void wait_and_invalidate_intermediate_pin(
    OpenedContext& context,
    const Request& request,
    const wchar_t* environment_name) {
  std::array<wchar_t, 2> enabled{};
  if (GetEnvironmentVariableW(environment_name, enabled.data(), static_cast<DWORD>(enabled.size())) == 0) return;
  wait_at_named_test_barrier(environment_name);
  std::set<std::string> direct;
  for (const auto& parent : request.parents) direct.insert(folded(parent.relative_utf8));
  for (auto& [key, expected] : context.directory_identities) {
    if (!direct.contains(key)) {
      expected.file ^= 1ULL;
      return;
    }
  }
  throw std::runtime_error("test intermediate pin");
}
#else
void wait_and_invalidate_intermediate_pin(OpenedContext&, const Request&, const wchar_t*) {}
#endif

enum class rename_result { failed, succeeded, postcondition_failed };

rename_result rename_handle(HANDLE source, HANDLE destination_parent, std::wstring_view destination_name) {
  if (!safe_held_directory(destination_parent) || destination_name.empty()
      || destination_name.find_first_of(L"\\/") != std::wstring_view::npos) {
    SetLastError(ERROR_ACCESS_DENIED);
    return rename_result::failed;
  }
  const Identity parent_identity = identity(destination_parent);
  const std::size_t bytes = destination_name.size() * sizeof(wchar_t);
  // The API contract uses FileNameLength, but a terminating NUL keeps file-system
  // filter drivers from reading beyond the bounded allocation.
  const std::size_t total = offsetof(FILE_RENAME_INFO, FileName) + bytes + sizeof(wchar_t);
  std::vector<unsigned char> buffer(total, 0);
  auto* info = reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
  info->Flags = 0;
  info->RootDirectory = destination_parent;
  info->FileNameLength = static_cast<DWORD>(bytes);
  std::memcpy(info->FileName, destination_name.data(), bytes);
  nt_api api = native_api();
  if (!api.set || !api.to_dos) {
    SetLastError(ERROR_CALL_NOT_IMPLEMENTED);
    return rename_result::failed;
  }
  nt_io_status_block status{};
  // FileRenameInformationEx (65) consumes the same flags/root/name layout
  // and, unlike the Win32 thunk on current Windows, honors RootDirectory.
  wait_at_named_test_barrier(L"ARKDOWN_WORKSPACE_COMMIT_TEST_NAMESPACE_BARRIER");
  const LONG result = api.set(source, &status, info, static_cast<ULONG>(total), kFileRenameInformationEx);
  if (result < 0) {
    SetLastError(api.to_dos(result));
    return rename_result::failed;
  }
  try {
    return safe_held_directory(destination_parent)
        && same_identity(identity(destination_parent), parent_identity)
        ? rename_result::succeeded : rename_result::postcondition_failed;
  } catch (...) {
    return rename_result::postcondition_failed;
  }
}

bool dispose_handle(HANDLE handle) {
  FILE_DISPOSITION_INFO_EX info{};
  info.Flags = FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE;
  if (SetFileInformationByHandle(handle, FileDispositionInfoEx, &info, sizeof(info))) return true;
  FILE_DISPOSITION_INFO legacy{};
  legacy.DeleteFile = TRUE;
  return SetFileInformationByHandle(handle, FileDispositionInfo, &legacy, sizeof(legacy)) != FALSE;
}

bool write_handle(HANDLE handle, const std::vector<unsigned char>& bytes) {
  LARGE_INTEGER zero{};
  if (!SetFilePointerEx(handle, zero, nullptr, FILE_BEGIN)) return false;
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const DWORD wanted = static_cast<DWORD>((std::min)(bytes.size() - offset, static_cast<std::size_t>(64 * 1024)));
    DWORD written = 0;
    if (!WriteFile(handle, bytes.data() + offset, wanted, &written, nullptr) || written == 0) return false;
    offset += written;
  }
  if (!SetEndOfFile(handle) || !FlushFileBuffers(handle)) return false;
  return true;
}

bool single_link_regular_file(HANDLE handle, std::uint64_t expected_size) {
  FILE_STANDARD_INFO standard{};
  return GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard))
      && !standard.Directory && standard.NumberOfLinks == 1
      && standard.EndOfFile.QuadPart >= 0
      && static_cast<std::uint64_t>(standard.EndOfFile.QuadPart) == expected_size;
}

#ifdef ARKDOWN_HELPER_TEST_HOOKS
void wait_at_named_test_barrier(const wchar_t* environment_name) {
  std::array<wchar_t, 32768> buffer{};
  const DWORD length = GetEnvironmentVariableW(environment_name, buffer.data(), static_cast<DWORD>(buffer.size()));
  if (length == 0) return;
  if (length >= buffer.size() || length < 3 || buffer[1] != L':' || buffer[2] != L'\\') {
    throw std::runtime_error("test barrier");
  }
  const std::wstring root(buffer.data(), length);
  const std::wstring ready = root + L"\\ready";
  unique_handle signal(CreateFileW(extended(ready).c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW,
      FILE_ATTRIBUTE_HIDDEN | FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!signal || !FlushFileBuffers(signal.get())) throw std::runtime_error("test barrier");
  signal.reset();
  const std::wstring release = root + L"\\continue";
  const ULONGLONG deadline = GetTickCount64() + 5000ULL;
  while (GetTickCount64() < deadline) {
    const DWORD attributes = GetFileAttributesW(extended(release).c_str());
    if (attributes != INVALID_FILE_ATTRIBUTES
        && (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0) return;
    Sleep(10);
  }
  throw std::runtime_error("test barrier timeout");
}

int test_set_mount_point(std::wstring_view directory, std::wstring_view external_target) {
  unique_handle handle(CreateFileW(extended(directory).c_str(), GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!handle) return GetLastError() == ERROR_SHARING_VIOLATION ? 73 : 74;

  const std::wstring substitute = L"\\??\\" + std::wstring(external_target);
  const std::wstring print(external_target);
  const USHORT substitute_bytes = static_cast<USHORT>(substitute.size() * sizeof(wchar_t));
  const USHORT print_bytes = static_cast<USHORT>(print.size() * sizeof(wchar_t));
  const std::size_t path_bytes = substitute_bytes + sizeof(wchar_t) + print_bytes + sizeof(wchar_t);
  struct mount_point_buffer {
    DWORD tag;
    USHORT data_length;
    USHORT reserved;
    USHORT substitute_offset;
    USHORT substitute_length;
    USHORT print_offset;
    USHORT print_length;
    wchar_t path[1];
  };
  const std::size_t total = offsetof(mount_point_buffer, path) + path_bytes;
  std::vector<unsigned char> storage(total, 0);
  auto* buffer = reinterpret_cast<mount_point_buffer*>(storage.data());
  buffer->tag = IO_REPARSE_TAG_MOUNT_POINT;
  buffer->data_length = static_cast<USHORT>(8U + path_bytes);
  buffer->substitute_offset = 0;
  buffer->substitute_length = substitute_bytes;
  buffer->print_offset = static_cast<USHORT>(substitute_bytes + sizeof(wchar_t));
  buffer->print_length = print_bytes;
  std::memcpy(buffer->path, substitute.data(), substitute_bytes);
  std::memcpy(reinterpret_cast<unsigned char*>(buffer->path) + buffer->print_offset, print.data(), print_bytes);
  DWORD returned = 0;
  return DeviceIoControl(handle.get(), FSCTL_SET_REPARSE_POINT, buffer, static_cast<DWORD>(total),
      nullptr, 0, &returned, nullptr) ? 0 : 75;
}

#else
void wait_at_named_test_barrier(const wchar_t*) {}
#endif

std::wstring random_hex_name(std::wstring_view prefix) {
  std::array<unsigned char, 16> bytes{};
  if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) {
    throw std::runtime_error("random");
  }
  const std::string value = hex_bytes(bytes.data(), bytes.size());
  return std::wstring(prefix) + utf16(value);
}

std::string run_create(const Request& request, OpenedContext& context) {
  const auto& destination = *request.destination;
  HANDLE destination_parent = parent_handle(context, parent_relative(destination.relative_utf8));
  unique_handle stage;
  std::wstring stage_path;
  for (int attempt = 0; attempt < 10 && !stage; ++attempt) {
    const std::wstring name = random_hex_name(L".arkdown-ai-stage-") + L".tmp";
    const std::string parent_rel = parent_relative(destination.relative_utf8);
    std::wstring parent_path = parent_rel.empty() ? request.root.absolute : join_relative(request.root.absolute, validate_relative(parent_rel, true));
    stage_path = parent_path + L"\\" + name;
    if (!safe_held_directory(destination_parent)) return "parent-changed";
    try {
      stage = relative_file(destination_parent, name, GENERIC_READ | GENERIC_WRITE | DELETE | SYNCHRONIZE,
          FILE_SHARE_READ, kFileCreate, FILE_ATTRIBUTE_HIDDEN, false);
    } catch (const std::exception& error) {
      if (std::string_view(error.what()) == "parent changed") return "parent-changed";
      if (std::string_view(error.what()) == "cleanup_ambiguous") return "cleanup_ambiguous";
      if (GetLastError() != ERROR_FILE_EXISTS && GetLastError() != ERROR_ALREADY_EXISTS) return "unsupported";
    }
  }
  if (!stage) return "unsupported";
  bool crossed = false;
  try {
    if (!write_handle(stage.get(), request.content)) throw std::runtime_error("stage write");
    const std::string expected_hash = [&]() {
      BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr; DWORD object_size = 0, returned = 0;
      std::vector<unsigned char> object; std::array<unsigned char, 32> digest{};
      if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0
          || BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size), &returned, 0) < 0) throw std::runtime_error("hash");
      object.resize(object_size);
      if (BCryptCreateHash(algorithm, &hash, object.data(), object_size, nullptr, 0, 0) < 0
          || (!request.content.empty() && BCryptHashData(hash, const_cast<PUCHAR>(request.content.data()), static_cast<ULONG>(request.content.size()), 0) < 0)
          || BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) < 0) {
        if (hash) BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(algorithm, 0); throw std::runtime_error("hash");
      }
      BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(algorithm, 0); return hex_bytes(digest.data(), digest.size());
    }();
    const Identity stage_identity = identity(stage.get());
    wait_at_named_test_barrier(L"ARKDOWN_WORKSPACE_COMMIT_TEST_STAGE_BARRIER");
    FILE_BASIC_INFO stage_basic{};
    if (!GetFileInformationByHandleEx(stage.get(), FileBasicInfo, &stage_basic, sizeof(stage_basic))) {
      throw std::runtime_error("stage attributes");
    }
    // Publish a visible document while preserving the held stage's other attributes.
    // Zero timestamps leave them unchanged; zero attributes would leave Hidden unchanged.
    FILE_BASIC_INFO visible_basic{};
    visible_basic.FileAttributes = stage_basic.FileAttributes & ~FILE_ATTRIBUTE_HIDDEN;
    if (visible_basic.FileAttributes == 0) visible_basic.FileAttributes = FILE_ATTRIBUTE_NORMAL;
    if (!SetFileInformationByHandle(stage.get(), FileBasicInfo, &visible_basic, sizeof(visible_basic))
        || !GetFileInformationByHandleEx(stage.get(), FileBasicInfo, &stage_basic, sizeof(stage_basic))
        || (stage_basic.FileAttributes & FILE_ATTRIBUTE_HIDDEN) != 0) {
      throw std::runtime_error("stage attributes");
    }
    if (!single_link_regular_file(stage.get(), request.content.size())
        || sha256_handle(stage.get()) != expected_hash || !reverify_context(context, request)) {
      throw std::runtime_error("stage verify");
    }
    const rename_result publication = rename_handle(stage.get(), destination_parent, destination.components.back());
    if (publication == rename_result::postcondition_failed) {
      crossed = true;
      return "commit_verification_failed";
    }
    if (publication == rename_result::failed) {
      const DWORD error = GetLastError();
      if (!dispose_handle(stage.get())) return "cleanup_ambiguous";
      return (error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS || error == ERROR_ACCESS_DENIED)
          ? "destination-exists" : "unsupported";
    }
    crossed = true;
    const bool identity_matches = same_identity(identity(stage.get()), stage_identity);
    const bool path_matches = equals_path(final_path(stage.get()), destination.absolute);
    const bool metadata_matches = single_link_regular_file(stage.get(), request.content.size());
    FILE_BASIC_INFO published_basic{};
    const bool attributes_match = GetFileInformationByHandleEx(
        stage.get(), FileBasicInfo, &published_basic, sizeof(published_basic))
        && (published_basic.FileAttributes & FILE_ATTRIBUTE_HIDDEN) == 0;
    const bool hash_matches = sha256_handle(stage.get()) == expected_hash;
    const bool context_matches = reverify_context(context, request);
    if (!identity_matches || !path_matches || !metadata_matches || !attributes_match || !hash_matches || !context_matches) {
      return "commit_verification_failed";
    }
    return "committed";
  } catch (...) {
    if (crossed) return "commit_verification_failed";
    return dispose_handle(stage.get()) ? "unsupported" : "cleanup_ambiguous";
  }
}

std::string run_edit(const Request& request, OpenedContext& context, unique_handle& source) {
  std::vector<unsigned char> original;
  try {
    if (sha256_handle(source.get(), &original) != request.source->revision || !reverify_context(context, request)) return "source-changed";
  } catch (...) { return "source-changed"; }
  bool crossed = false;
  LARGE_INTEGER zero{};
  if (!SetFilePointerEx(source.get(), zero, nullptr, FILE_BEGIN)) return "source-changed";
  std::size_t offset = 0;
  while (offset < request.content.size()) {
    DWORD written = 0;
    const DWORD wanted = static_cast<DWORD>((std::min)(request.content.size() - offset, static_cast<std::size_t>(64 * 1024)));
    if (!WriteFile(source.get(), request.content.data() + offset, wanted, &written, nullptr) || written == 0) {
      if (crossed) { write_handle(source.get(), original); return "post_commit_verification_failed"; }
      return "source-changed";
    }
    crossed = true;
    offset += written;
  }
  if (!SetEndOfFile(source.get()) || !FlushFileBuffers(source.get())) {
    if (crossed) write_handle(source.get(), original);
    return "post_commit_verification_failed";
  }
  try {
    wait_and_invalidate_intermediate_pin(
        context, request, L"ARKDOWN_WORKSPACE_COMMIT_TEST_EDIT_POSTWRITE_BARRIER");
  } catch (...) { return "post_commit_verification_failed"; }
  try {
    BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr; DWORD object_size = 0, returned = 0;
    std::vector<unsigned char> object; std::array<unsigned char, 32> digest{};
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0
        || BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size), &returned, 0) < 0) throw std::runtime_error("hash");
    object.resize(object_size);
    if (BCryptCreateHash(algorithm, &hash, object.data(), object_size, nullptr, 0, 0) < 0
        || (!request.content.empty() && BCryptHashData(hash, const_cast<PUCHAR>(request.content.data()), static_cast<ULONG>(request.content.size()), 0) < 0)
        || BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) < 0) throw std::runtime_error("hash");
    BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(algorithm, 0);
    if (!single_link_regular_file(source.get(), request.content.size())
        || sha256_handle(source.get()) != hex_bytes(digest.data(), digest.size())
        || !same_identity(identity(source.get()), request.source->identity)
        || !equals_path(final_path(source.get()), request.source->absolute)
        || !reverify_context(context, request)) return "post_commit_verification_failed";
    return "committed";
  } catch (...) { return "post_commit_verification_failed"; }
}

std::string run_rename(const Request& request, OpenedContext& context, unique_handle& source) {
  if (!reverify_context(context, request) || !verify_source_metadata(source.get(), *request.source)) return "source-changed";
  HANDLE destination_parent = parent_handle(context, parent_relative(request.destination->relative_utf8));
  const rename_result publication = rename_handle(source.get(), destination_parent, request.destination->components.back());
  if (publication == rename_result::postcondition_failed) return "commit_verification_failed";
  if (publication == rename_result::failed) {
    const DWORD error = GetLastError();
    return (error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS || error == ERROR_ACCESS_DENIED)
        ? "destination-exists" : "unsupported";
  }
  try {
    return same_identity(identity(source.get()), request.source->identity)
        && equals_path(final_path(source.get()), request.destination->absolute)
        && single_link_regular_file(source.get(), request.source->size)
        && sha256_handle(source.get()) == request.source->revision
        && reverify_context(context, request)
        ? "committed" : "commit_verification_failed";
  } catch (...) { return "commit_verification_failed"; }
}

// The source pin denies competing deletes, including Shell's pathname-based
// recycle operation. Releasing that pin would permit identity substitution.
// Until an identity-safe, non-permanent handoff is supported, reject before
// creating quarantine state or changing the source's location. Existing recovery
// items from older helpers remain untouched.
std::string run_recycle(const Request& request, OpenedContext& context, unique_handle& source) {
  if (!reverify_context(context, request) || !verify_source_metadata(source.get(), *request.source)) return "source-changed";
  return "recycle-unavailable";
}

std::pair<std::string_view, std::string_view> classify(const std::string& result) {
  if (result == "committed") return {"committed", {}};
  if (result == "destination-exists" || result == "source-changed" || result == "parent-changed"
      || result == "root-changed" || result == "unsupported" || result == "recycle-unavailable") return {"rejected", result};
  return {"unknown", result};
}

void wait_at_test_barrier() {
  wait_at_named_test_barrier(L"ARKDOWN_WORKSPACE_COMMIT_TEST_BARRIER");
}

int execute_request(const Request& request) {
  OpenedContext context;
  try { context = open_context(request); }
  catch (const std::exception& error) {
    const std::string reason = error.what();
    const std::string result = reason == "root changed" ? "root-changed"
        : reason == "parent changed" || reason == "reparse" ? "parent-changed" : "unsupported";
    const auto [status, detail] = classify(result);
    return write_response(request.request_id, status, detail) ? 0 : 3;
  }
  unique_handle source;
  if (request.source) {
    try { source = open_source(request, context); }
    catch (...) { return write_response(request.request_id, "rejected", "source-changed") ? 0 : 3; }
  }
  try { wait_at_test_barrier(); }
  catch (...) { return write_response(request.request_id, "rejected", "unsupported") ? 0 : 3; }
  try {
    wait_and_invalidate_intermediate_pin(
        context, request, L"ARKDOWN_WORKSPACE_COMMIT_TEST_INTERMEDIATE_PIN_BARRIER");
  } catch (...) {
    return write_response(request.request_id, "rejected", "unsupported") ? 0 : 3;
  }
  if (!reverify_context(context, request)) {
    return write_response(request.request_id, "rejected", "parent-changed") ? 0 : 3;
  }
  std::string result;
  if (request.operation == Operation::create) result = run_create(request, context);
  else if (request.operation == Operation::edit) result = run_edit(request, context, source);
  else if (request.operation == Operation::rename) result = run_rename(request, context, source);
  else result = run_recycle(request, context, source);
  const auto [status, reason] = classify(result);
  return write_response(request.request_id, status, reason) ? 0 : 3;
}

#include "document-replacement.h"

}  // namespace

int wmain(int argc, wchar_t** argv) {
#ifdef ARKDOWN_HELPER_TEST_HOOKS
  if (argc == 4 && std::wstring_view(argv[1]) == L"--test-set-mount-point-v1") {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    return test_set_mount_point(argv[2], argv[3]);
  }
#endif
  if (argc != 2 || std::wstring_view(argv[1]) != L"--stdio-json-v1") return 2;
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  const std::optional<Json> input = read_input();
  if (!input) return 2;
  std::string request_id;
  try {
    request_id = string_value(field(*input, "requestId"));
    if (!valid_uuid(request_id)) return 2;
  } catch (...) { return 2; }
  try {
    if (string_value(field(*input, "command")) == "replace-document") {
      return replace_document(*input, request_id);
    }
    const Request request = parse_request(*input);
    return execute_request(request);
  } catch (...) {
    return write_response(request_id, "rejected", "unsupported") ? 0 : 3;
  }
}
