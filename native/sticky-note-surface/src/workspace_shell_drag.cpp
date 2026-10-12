#include "workspace_shell_drag.h"
#include <shlobj.h>
#include <shobjidl.h>
#include <wrl/client.h>
#include <atomic>

namespace workspace_shell_drag {
namespace {
using Microsoft::WRL::ComPtr;
constexpr DWORD kAllowedEffects = DROPEFFECT_COPY | DROPEFFECT_LINK;
thread_local bool dragging = false;

class OleScope {
 public:
  HRESULT result = OleInitialize(nullptr);
  ~OleScope() { if (SUCCEEDED(result)) OleUninitialize(); }
};
class DragScope {
 public:
  DragScope() { dragging = true; }
  ~DragScope() { dragging = false; }
};

class DropSource final : public IDropSource {
 public:
  explicit DropSource(HWND owner) : owner_(owner) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** value) override {
    if (!value) return E_POINTER;
    *value = nullptr;
    if (iid != IID_IUnknown && iid != IID_IDropSource) return E_NOINTERFACE;
    *value = static_cast<IDropSource*>(this); AddRef(); return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }
  ULONG STDMETHODCALLTYPE Release() override {
    const auto remaining = --references_;
    if (!remaining) delete this;
    return remaining;
  }
  HRESULT STDMETHODCALLTYPE QueryContinueDrag(BOOL escape, DWORD keys) override {
    if (escape || !IsWindow(owner_)) return DRAGDROP_S_CANCEL;
    return (keys & MK_LBUTTON) ? S_OK : DRAGDROP_S_DROP;
  }
  HRESULT STDMETHODCALLTYPE GiveFeedback(DWORD) override { return DRAGDROP_S_USEDEFAULTCURSORS; }
 private:
  std::atomic<ULONG> references_{1};
  HWND owner_;
};

HRESULT PreferCopy(IDataObject* data) {
  STGMEDIUM medium{};
  medium.tymed = TYMED_HGLOBAL;
  medium.hGlobal = GlobalAlloc(GMEM_MOVEABLE, sizeof(DWORD));
  if (!medium.hGlobal) return E_OUTOFMEMORY;
  auto* value = static_cast<DWORD*>(GlobalLock(medium.hGlobal));
  if (!value) { GlobalFree(medium.hGlobal); return E_OUTOFMEMORY; }
  *value = DROPEFFECT_COPY;
  GlobalUnlock(medium.hGlobal);
  FORMATETC format{static_cast<CLIPFORMAT>(RegisterClipboardFormatW(CFSTR_PREFERREDDROPEFFECT)),
    nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
  const HRESULT result = data->SetData(&format, &medium, TRUE);
  if (FAILED(result)) ReleaseStgMedium(&medium);
  return result;
}
}

bool IsAbsoluteSavedPath(std::wstring_view path) {
  if (path.empty() || path.size() > 32767 || path.find(L'\0') != std::wstring_view::npos) return false;
  const bool drive = path.size() > 3 && ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z'))
    && path[1] == L':' && (path[2] == L'\\' || path[2] == L'/');
  const bool unc = path.size() > 4 && path[0] == L'\\' && path[1] == L'\\' && path[2] != L'.' && path[2] != L'?';
  return drive || unc;
}

HRESULT CreateFileDataObject(const wchar_t* path, IDataObject** data) {
  if (!data) return E_POINTER;
  *data = nullptr;
  if (!path || !IsAbsoluteSavedPath(path)) return E_INVALIDARG;
  const DWORD attributes = GetFileAttributesW(path);
  if (attributes == INVALID_FILE_ATTRIBUTES) return HRESULT_FROM_WIN32(GetLastError());
  if (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) return E_INVALIDARG;
  ComPtr<IShellItem> item;
  HRESULT result = SHCreateItemFromParsingName(path, nullptr, IID_PPV_ARGS(&item));
  if (FAILED(result)) return result;
  // Use the filesystem Shell provider, preserving CF_HDROP and Shell IDList.
  // A filename-only IDataObject is insufficient for Explorer's LINK behavior.
  ComPtr<IDataObject> object;
  result = item->BindToHandler(nullptr, BHID_DataObject, IID_PPV_ARGS(&object));
  if (FAILED(result)) return result;
  result = PreferCopy(object.Get());
  if (FAILED(result)) return result;
  *data = object.Detach();
  return S_OK;
}

Result Start(HWND owner, const wchar_t* path) {
  DWORD process = 0;
  const DWORD thread = GetWindowThreadProcessId(owner, &process);
  if (!IsWindow(owner) || process != GetCurrentProcessId() || thread != GetCurrentThreadId()) return {E_INVALIDARG, DROPEFFECT_NONE};
  if (dragging) return {E_UNEXPECTED, DROPEFFECT_NONE};
  // STA COM can reenter during initialization, Shell preparation and cleanup.
  // Construct first so the guard also outlives all COM object releases.
  DragScope active;
  OleScope ole;
  if (FAILED(ole.result)) return {ole.result, DROPEFFECT_NONE};
  ComPtr<IDataObject> data;
  const HRESULT prepared = CreateFileDataObject(path, &data);
  if (FAILED(prepared)) return {prepared, DROPEFFECT_NONE};
  ComPtr<IDropSource> source;
  source.Attach(new DropSource(owner));
  process = 0;
  const DWORD currentOwnerThread = GetWindowThreadProcessId(owner, &process);
  if (!IsWindow(owner) || process != GetCurrentProcessId() || currentOwnerThread != GetCurrentThreadId()) return {E_INVALIDARG, DROPEFFECT_NONE};
  DWORD effect = DROPEFFECT_NONE;
  const HRESULT result = SHDoDragDrop(owner, data.Get(), source.Get(), kAllowedEffects, &effect);
  if (result != DRAGDROP_S_DROP) return {result, DROPEFFECT_NONE};
  // Never implement source deletion or interpret an unexpected MOVE as consent.
  if (effect & ~kAllowedEffects) return {E_UNEXPECTED, DROPEFFECT_NONE};
  return {result, effect};
}
}
