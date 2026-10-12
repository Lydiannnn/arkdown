// Exercise real Shell data/target negotiation with a substituted modal loop and
// COM boundary reentry probes. No visible window, input or Explorer drop.
#include <windows.h>
#include <shlobj.h>
#include <shellapi.h>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>

HRESULT WINAPI FixtureSHDoDragDrop(HWND, IDataObject*, IDropSource*, DWORD, DWORD*);
HRESULT WINAPI FixtureOleInitialize(LPVOID);
void WINAPI FixtureOleUninitialize();
HRESULT WINAPI FixtureSHCreateItemFromParsingName(PCWSTR, IBindCtx*, REFIID, void**);
#define SHDoDragDrop FixtureSHDoDragDrop
#define OleInitialize FixtureOleInitialize
#define OleUninitialize FixtureOleUninitialize
#define SHCreateItemFromParsingName FixtureSHCreateItemFromParsingName
#include "../src/workspace_shell_drag.cpp"
#undef SHDoDragDrop
#undef OleInitialize
#undef OleUninitialize
#undef SHCreateItemFromParsingName

namespace {
int assertions = 0, loops = 0;
DWORD requestedEffect = DROPEFFECT_COPY;
HRESULT requestedResult = DRAGDROP_S_DROP;
std::wstring sourceFile, sourceRoot, destinationRoot;
bool destroyOwner = false;
enum class Probe { None, Initialize, Prepare, Cleanup, DestroyPreparing };
Probe probe = Probe::None;
HWND probeOwner = nullptr;
HRESULT reentryStatus = S_OK;
void TryReentry(Probe boundary) {
  if (probe != boundary) return;
  probe = Probe::None;
  reentryStatus = workspace_shell_drag::Start(probeOwner, sourceFile.c_str()).status;
}
void Check(bool value, const char* message) {
  ++assertions;
  if (!value) throw std::runtime_error(message);
}
void CheckFormat(IDataObject* data, CLIPFORMAT type, const char* message) {
  FORMATETC format{type, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
  Check(data->QueryGetData(&format) == S_OK, message);
}
// Mirror Electron's filename-list payload at the external COM boundary while
// keeping the same real file. This isolates Shell identity from effect flags.
class FilenameOnlyData final : public IDataObject {
 public:
  explicit FilenameOnlyData(IDataObject* source) : source_(source) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** value) override {
    if (!value) return E_POINTER;
    *value = nullptr;
    if (iid != IID_IUnknown && iid != IID_IDataObject) return E_NOINTERFACE;
    *value = static_cast<IDataObject*>(this); AddRef(); return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }
  ULONG STDMETHODCALLTYPE Release() override { return --references_; }
  HRESULT STDMETHODCALLTYPE GetData(FORMATETC* format, STGMEDIUM* medium) override {
    return format && format->cfFormat == CF_HDROP ? source_->GetData(format, medium) : DV_E_FORMATETC;
  }
  HRESULT STDMETHODCALLTYPE GetDataHere(FORMATETC*, STGMEDIUM*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE QueryGetData(FORMATETC* format) override {
    return format && format->cfFormat == CF_HDROP ? source_->QueryGetData(format) : DV_E_FORMATETC;
  }
  HRESULT STDMETHODCALLTYPE GetCanonicalFormatEtc(FORMATETC*, FORMATETC*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE SetData(FORMATETC*, STGMEDIUM*, BOOL) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE EnumFormatEtc(DWORD direction, IEnumFORMATETC** enumerator) override {
    FORMATETC format{CF_HDROP, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
    return direction == DATADIR_GET ? SHCreateStdEnumFmtEtc(1, &format, enumerator) : E_NOTIMPL;
  }
  HRESULT STDMETHODCALLTYPE DAdvise(FORMATETC*, DWORD, IAdviseSink*, DWORD*) override { return OLE_E_ADVISENOTSUPPORTED; }
  HRESULT STDMETHODCALLTYPE DUnadvise(DWORD) override { return OLE_E_ADVISENOTSUPPORTED; }
  HRESULT STDMETHODCALLTYPE EnumDAdvise(IEnumSTATDATA**) override { return OLE_E_ADVISENOTSUPPORTED; }
 private:
  IDataObject* source_;
  ULONG references_ = 1;
};
void CheckTarget(IDataObject* data, const std::wstring& folder) {
  Microsoft::WRL::ComPtr<IShellItem> item;
  Check(SUCCEEDED(SHCreateItemFromParsingName(folder.c_str(), nullptr, IID_PPV_ARGS(&item))), "real destination Shell item");
  Microsoft::WRL::ComPtr<IDropTarget> target;
  Check(SUCCEEDED(item->BindToHandler(nullptr, BHID_SFUIObject, IID_PPV_ARGS(&target))), "real destination drop target");
  FilenameOnlyData filenameOnly(data);
  DWORD baselineEffect = DROPEFFECT_COPY | DROPEFFECT_LINK;
  Check(SUCCEEDED(target->DragEnter(&filenameOnly, MK_CONTROL | MK_SHIFT, POINTL{}, &baselineEffect)), "filename-only baseline DragEnter");
  Check(baselineEffect == DROPEFFECT_NONE, "filename-only data reproduces forbidden shortcut cursor despite LINK flag");
  Check(SUCCEEDED(target->DragLeave()), "baseline DragLeave");
  for (const auto keys : {MK_CONTROL, MK_CONTROL | MK_SHIFT}) {
    DWORD effect = DROPEFFECT_COPY | DROPEFFECT_LINK;
    Check(SUCCEEDED(target->DragEnter(data, static_cast<DWORD>(keys), POINTL{}, &effect)), "Shell DragEnter");
    Check(effect == static_cast<DWORD>(keys == MK_CONTROL ? DROPEFFECT_COPY : DROPEFFECT_LINK), "Shell accepts copy and shortcut modifiers");
    Check(SUCCEEDED(target->DragLeave()), "Shell DragLeave without performing any drop");
  }
}
}

HRESULT WINAPI FixtureOleInitialize(LPVOID reserved) {
  TryReentry(Probe::Initialize);
  return OleInitialize(reserved);
}
void WINAPI FixtureOleUninitialize() {
  // Record the result without throwing through a production destructor.
  TryReentry(Probe::Cleanup);
  OleUninitialize();
}
HRESULT WINAPI FixtureSHCreateItemFromParsingName(PCWSTR path, IBindCtx* context, REFIID iid, void** item) {
  TryReentry(Probe::Prepare);
  const auto result = SHCreateItemFromParsingName(path, context, iid, item);
  if (probe == Probe::DestroyPreparing) {
    probe = Probe::None;
    DestroyWindow(probeOwner);
  }
  return result;
}

HRESULT WINAPI FixtureSHDoDragDrop(HWND owner, IDataObject* data, IDropSource* source, DWORD allowed, DWORD* effect) {
  ++loops;
  if (!IsWindow(owner)) return E_INVALIDARG;
  Check(allowed == (DROPEFFECT_COPY | DROPEFFECT_LINK), "MOVE is never offered");
  CheckFormat(data, CF_HDROP, "file list present");
  CheckFormat(data, static_cast<CLIPFORMAT>(RegisterClipboardFormatW(CFSTR_SHELLIDLIST)), "Shell identity present");
  FORMATETC files{CF_HDROP, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
  STGMEDIUM medium{};
  Check(SUCCEEDED(data->GetData(&files, &medium)), "read real Shell file list");
  std::vector<wchar_t> path(32768);
  Check(DragQueryFileW(static_cast<HDROP>(medium.hGlobal), 0, path.data(), static_cast<UINT>(path.size())) > 0, "one saved file");
  Check(std::wstring(path.data()) == sourceFile, "original saved path, not a temporary file");
  ReleaseStgMedium(&medium);
  FORMATETC preferred{static_cast<CLIPFORMAT>(RegisterClipboardFormatW(CFSTR_PREFERREDDROPEFFECT)), nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
  Check(SUCCEEDED(data->GetData(&preferred, &medium)), "preferred effect available");
  const auto* preferredValue = static_cast<DWORD*>(GlobalLock(medium.hGlobal));
  Check(preferredValue && *preferredValue == DROPEFFECT_COPY, "plain drag prefers COPY");
  GlobalUnlock(medium.hGlobal); ReleaseStgMedium(&medium);
  Check(source->QueryContinueDrag(TRUE, MK_LBUTTON) == DRAGDROP_S_CANCEL, "Escape cancels");
  Check(source->QueryContinueDrag(FALSE, MK_LBUTTON) == S_OK, "held button continues");
  Check(source->QueryContinueDrag(FALSE, 0) == DRAGDROP_S_DROP, "button release drops");
  Check(source->GiveFeedback(DROPEFFECT_LINK) == DRAGDROP_S_USEDEFAULTCURSORS, "Windows owns modifier cursor");
  Check(workspace_shell_drag::Start(owner, sourceFile.c_str()).status == E_UNEXPECTED, "nested drag refused");
  CheckTarget(data, sourceRoot);
  CheckTarget(data, destinationRoot);
  if (destroyOwner) {
    DestroyWindow(owner);
    Check(source->QueryContinueDrag(FALSE, MK_LBUTTON) == DRAGDROP_S_CANCEL, "owner destruction cancels");
  }
  *effect = requestedEffect;
  return requestedResult;
}

int wmain() {
  std::filesystem::path root;
  HWND owner = nullptr;
  try {
    wchar_t temp[MAX_PATH]{};
    Check(GetTempPathW(MAX_PATH, temp) > 0, "temporary root available");
    GUID id{}; Check(SUCCEEDED(CoCreateGuid(&id)), "unique isolated test directory");
    wchar_t suffix[40]{}; StringFromGUID2(id, suffix, 40);
    root = std::filesystem::path(temp) / (std::wstring(L"arkdown-shell-drag-") + suffix);
    std::filesystem::create_directories(root / L"source");
    std::filesystem::create_directories(root / L"destination");
    sourceRoot = (root / L"source").wstring(); destinationRoot = (root / L"destination").wstring();
    sourceFile = (root / L"source" / L"synthetic-note.txt").wstring();
    std::ofstream(sourceFile) << "synthetic saved content\n";
    owner = CreateWindowExW(0, L"STATIC", L"", WS_POPUP, 0, 0, 1, 1, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    Check(owner && !IsWindowVisible(owner), "hidden owned HWND only");
    probeOwner = owner;
    for (const auto boundary : {Probe::Initialize, Probe::Prepare, Probe::Cleanup}) {
      probe = boundary; reentryStatus = S_OK;
      const int before = loops;
      Check(workspace_shell_drag::Start(owner, sourceFile.c_str()).status == DRAGDROP_S_DROP, "outer drag remains usable during reentry probe");
      std::printf("COM boundary %d nested status: 0x%08lx\n", static_cast<int>(boundary), static_cast<unsigned long>(reentryStatus));
      Check(reentryStatus == E_UNEXPECTED, "COM preparation and cleanup reject nested drag");
      Check(loops == before + 1, "reentry never begins a second modal loop");
    }
    for (DWORD effect : {DROPEFFECT_COPY, DROPEFFECT_LINK, DROPEFFECT_NONE}) {
      requestedEffect = effect;
      const auto result = workspace_shell_drag::Start(owner, sourceFile.c_str());
      Check(result.status == DRAGDROP_S_DROP && result.effect == effect, "advisory result preserved");
    }
    requestedResult = DRAGDROP_S_CANCEL; requestedEffect = DROPEFFECT_COPY;
    const auto cancelled = workspace_shell_drag::Start(owner, sourceFile.c_str());
    Check(cancelled.status == DRAGDROP_S_CANCEL && cancelled.effect == DROPEFFECT_NONE, "cancel is not error or success receipt");
    requestedResult = DRAGDROP_S_DROP; requestedEffect = DROPEFFECT_MOVE;
    Check(FAILED(workspace_shell_drag::Start(owner, sourceFile.c_str()).status), "unexpected MOVE rejected without source deletion");
    const int beforeInvalid = loops;
    Check(FAILED(workspace_shell_drag::Start(nullptr, sourceFile.c_str()).status), "invalid owner rejected");
    Check(FAILED(workspace_shell_drag::Start(owner, sourceRoot.c_str()).status), "directory rejected");
    Check(FAILED(workspace_shell_drag::Start(owner, (root / L"missing.txt").c_str()).status), "missing file rejected");
    Check(loops == beforeInvalid, "invalid inputs never enter the loop");
    probe = Probe::DestroyPreparing;
    Check(workspace_shell_drag::Start(owner, sourceFile.c_str()).status == E_INVALIDARG, "preparation owner destruction rejected");
    Check(loops == beforeInvalid, "destroyed preparation owner never enters modal loop");
    owner = CreateWindowExW(0, L"STATIC", L"", WS_POPUP, 0, 0, 1, 1, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    Check(owner && !IsWindowVisible(owner), "fresh hidden owner after preparation cancellation");
    destroyOwner = true; requestedEffect = DROPEFFECT_NONE; requestedResult = DRAGDROP_S_CANCEL;
    Check(workspace_shell_drag::Start(owner, sourceFile.c_str()).status == DRAGDROP_S_CANCEL, "destroyed owner loop cancelled");
    owner = nullptr;
    std::ifstream input(sourceFile); const std::string content((std::istreambuf_iterator<char>(input)), {});
    input.close();
    Check(content == "synthetic saved content\n", "source content remains unchanged");
    Check(std::filesystem::is_empty(root / L"destination"), "negotiation never creates destination files");
    const auto resolvedRoot = std::filesystem::canonical(root);
    Check(resolvedRoot.parent_path() == std::filesystem::canonical(temp)
      && resolvedRoot.filename().wstring().starts_with(L"arkdown-shell-drag-"), "cleanup confined to generated temporary directory");
    std::filesystem::remove_all(resolvedRoot);
    std::printf("workspace shell drag: %d assertions passed; no OS drag/drop performed\n", assertions);
    return 0;
  } catch (const std::exception& error) {
    if (owner && IsWindow(owner)) DestroyWindow(owner);
    std::fprintf(stderr, "workspace shell drag: %s\n", error.what());
    // Preserve synthetic evidence on failure, rather than deleting a computed path.
    return 1;
  }
}
