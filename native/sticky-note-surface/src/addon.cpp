#include <windows.h>
#include <commctrl.h>
#include <dwmapi.h>
#include <node_api.h>
#include <Windows.UI.Composition.Interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.System.h>
#include <winrt/Windows.UI.Composition.h>
#include <winrt/Windows.UI.Composition.Desktop.h>
#include "material_effects.h"
#include "glass_resize_hit_test.h"
#include "workspace_shell_drag.h"
#include "update_executable_pin.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <exception>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace {
using winrt::Windows::System::DispatcherQueue;
using winrt::Windows::System::DispatcherQueueController;
using winrt::Windows::UI::Composition::Compositor;
using winrt::Windows::UI::Composition::CompositionBackdropBrush;
using winrt::Windows::UI::Composition::CompositionGeometricClip;
using winrt::Windows::UI::Composition::CompositionRoundedRectangleGeometry;
using winrt::Windows::UI::Composition::ContainerVisual;
using winrt::Windows::UI::Composition::SpriteVisual;
using winrt::Windows::UI::Composition::Desktop::DesktopWindowTarget;
using sticky_note_material::Appearance;
using sticky_note_material::Material;

struct QueueOptions { DWORD size; DWORD threadType; DWORD apartmentType; };
extern "C" HRESULT WINAPI CreateDispatcherQueueController(
  QueueOptions options, ABI::Windows::System::IDispatcherQueueController** controller);

class ArgumentError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

enum class SourceKind { Wallpaper, Host };

struct Surface {
  SourceKind source = SourceKind::Wallpaper;
  Compositor compositor{nullptr};
  CompositionBackdropBrush brush{nullptr};
  DesktopWindowTarget target{nullptr};
  ContainerVisual root{nullptr};
  SpriteVisual sprite{nullptr};
  CompositionRoundedRectangleGeometry clipGeometry{nullptr};
  CompositionGeometricClip roundedClip{nullptr};
  Material material;
  Appearance appearance;
  bool subclassInstalled = false;
  float width = 0;
  float height = 0;
  float clipRadius = 0;
  bool clipEnabled = false;

  // Releasing composition objects never dereferences or mutates the HWND.
  ~Surface() {
    if (target) {
      try { target.Root(nullptr); } catch (...) {}
      try { target.Close(); } catch (...) {}
    }
  }
};

constexpr DWORD kGlassStyleBits = WS_CAPTION | WS_THICKFRAME;
constexpr DWORD RestoreGlassStyleBits(DWORD current, DWORD original) {
  return (current & ~kGlassStyleBits) | (original & kGlassStyleBits);
}
static_assert(RestoreGlassStyleBits(WS_VISIBLE | WS_MINIMIZE | WS_POPUP,
  WS_CAPTION | WS_THICKFRAME) == (WS_VISIBLE | WS_MINIMIZE | WS_POPUP | WS_CAPTION | WS_THICKFRAME));
static_assert(RestoreGlassStyleBits(WS_CAPTION | WS_THICKFRAME | WS_DISABLED, 0) == WS_DISABLED);

struct Decoration {
  DWORD originalStyleBits = 0;
  bool resizable = false;
  DWM_WINDOW_CORNER_PREFERENCE originalCorner = DWMWCP_DEFAULT;
  bool applying = false;
  bool frameRefreshPending = false;
  bool enabled = false;
  bool subclassInstalled = false;
};

struct LegacyResizeChild {
  HWND parent = nullptr;
  std::weak_ptr<Decoration> decoration;
};

struct HostPolicy {
  DWORD originalBackdrop = DWMSBT_AUTO;
  bool baselineEstablished = false;
  bool enabledByApp = false;
  bool restoreHost = false;
  bool restoreBackdrop = false;
  bool active = false;
  bool applying = false;
};

struct AcrylicBorder {
  bool desiredHidden = false;
  bool hidden = false;
  bool pending = true;
  bool applying = false;
};

struct ApplyingScope {
  bool& flag;
  explicit ApplyingScope(bool& value) : flag(value) { flag = true; }
  ~ApplyingScope() { flag = false; }
};

struct AddonState;
struct ResizeLifecycleObserver {
  AddonState* state = nullptr;
  HWINEVENTHOOK hook = nullptr;
  bool synchronizing = false;
};
// OUTOFCONTEXT callbacks run only on the registering UI thread. The registry
// holds no owning state pointer; removal invalidates queued callbacks before
// USER32 is unhooked, including during environment teardown.
thread_local std::unordered_map<HWINEVENTHOOK, std::weak_ptr<ResizeLifecycleObserver>> resizeObservers;

struct AddonState {
  const DWORD threadId = GetCurrentThreadId();
  std::shared_ptr<ResizeLifecycleObserver> resizeObserver;
  bool stoppingResizeObserver = false;
  ~AddonState();
  DispatcherQueueController ownedQueue{nullptr};
  std::unordered_map<HWND, std::shared_ptr<Surface>> surfaces;
  std::unordered_map<HWND, std::shared_ptr<Decoration>> decorations;
  std::unordered_map<HWND, std::shared_ptr<LegacyResizeChild>> resizeChildren;
  std::unordered_map<HWND, std::shared_ptr<HostPolicy>> hostPolicies;
  std::unordered_map<HWND, std::shared_ptr<AcrylicBorder>> acrylicBorders;
};

LRESULT CALLBACK SurfaceWindowProc(HWND, UINT, WPARAM, LPARAM, UINT_PTR, DWORD_PTR);
LRESULT CALLBACK DecorationWindowProc(HWND, UINT, WPARAM, LPARAM, UINT_PTR, DWORD_PTR);
LRESULT CALLBACK LegacyResizeWindowProc(HWND, UINT, WPARAM, LPARAM, UINT_PTR, DWORD_PTR);
LRESULT CALLBACK HostPolicyWindowProc(HWND, UINT, WPARAM, LPARAM, UINT_PTR, DWORD_PTR);
LRESULT CALLBACK AcrylicBorderWindowProc(HWND, UINT, WPARAM, LPARAM, UINT_PTR, DWORD_PTR);
void UpdateSurfaceClip(Surface&, HWND, bool);
bool ResizeSurface(Surface&, HWND);

void CheckNapi(napi_status status) {
  if (status != napi_ok) throw std::runtime_error("Native surface N-API operation failed");
}

AddonState& StateFor(napi_env env) {
  AddonState* state = nullptr;
  CheckNapi(napi_get_instance_data(env, reinterpret_cast<void**>(&state)));
  if (!state) throw std::runtime_error("Native surface environment is unavailable");
  if (state->threadId != GetCurrentThreadId()) throw std::runtime_error("Native surfaces must be used on their owning thread");
  return *state;
}

HWND ReadHandleValue(napi_env env, napi_value value) {
  bool lossless = false;
  uint64_t raw = 0;
  if (napi_get_value_bigint_uint64(env, value, &raw, &lossless) != napi_ok || !lossless)
    throw ArgumentError("HWND must be a lossless unsigned bigint");
  return reinterpret_cast<HWND>(static_cast<uintptr_t>(raw));
}

HWND ReadHandle(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2]{};
  CheckNapi(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
  if (count != 1) throw ArgumentError("Expected one HWND bigint");
  return ReadHandleValue(env, args[0]);
}

std::string ReadString(napi_env env, napi_value value) {
  napi_valuetype type;
  CheckNapi(napi_typeof(env, value, &type));
  if (type != napi_string) throw ArgumentError("Appearance field names and tintColor must be strings");
  size_t length = 0;
  CheckNapi(napi_get_value_string_utf8(env, value, nullptr, 0, &length));
  if (length > 32) throw ArgumentError("Invalid appearance field name or tintColor");
  std::array<char, 33> bytes{};
  CheckNapi(napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &length));
  return std::string(bytes.data(), length);
}

double ReadUnitInterval(napi_env env, napi_value object, const char* key) {
  napi_value value;
  CheckNapi(napi_get_named_property(env, object, key, &value));
  double number = 0;
  if (napi_get_value_double(env, value, &number) != napi_ok || !std::isfinite(number) || number < 0 || number > 1)
    throw ArgumentError(std::string(key) + " must be a finite number from 0 to 1");
  return number;
}

Appearance ReadAppearance(napi_env env, napi_value value) {
  napi_valuetype type;
  CheckNapi(napi_typeof(env, value, &type));
  bool array = false;
  CheckNapi(napi_is_array(env, value, &array));
  napi_value nullValue;
  CheckNapi(napi_get_null(env, &nullValue));
  bool isNull = false;
  CheckNapi(napi_strict_equals(env, value, nullValue, &isNull));
  if (type != napi_object || array || isNull) throw ArgumentError("Appearance must be a complete settings object");

  napi_value keys;
  CheckNapi(napi_get_all_property_names(env, value, napi_key_own_only, napi_key_all_properties,
    napi_key_numbers_to_strings, &keys));
  uint32_t count = 0;
  CheckNapi(napi_get_array_length(env, keys, &count));
  if (count != 4) throw ArgumentError("Appearance requires exactly tintColor, tintOpacity, luminosityOpacity and saturation");
  unsigned seen = 0;
  for (uint32_t index = 0; index < count; ++index) {
    napi_value key;
    CheckNapi(napi_get_element(env, keys, index, &key));
    const auto name = ReadString(env, key);
    if (name == "tintColor") seen |= 1;
    else if (name == "tintOpacity") seen |= 2;
    else if (name == "luminosityOpacity") seen |= 4;
    else if (name == "saturation") seen |= 8;
    else throw ArgumentError("Unknown appearance field");
  }
  if (seen != 15) throw ArgumentError("Appearance fields must be own properties");
  napi_value color;
  CheckNapi(napi_get_named_property(env, value, "tintColor", &color));
  Appearance result;
  result.tintColor = ReadString(env, color);
  if (result.tintColor.size() != 7 || result.tintColor[0] != '#') throw ArgumentError("tintColor must be #RRGGBB");
  uint32_t rgb = 0;
  for (size_t index = 1; index < result.tintColor.size(); ++index) {
    const char digit = result.tintColor[index];
    unsigned nibble;
    if (digit >= '0' && digit <= '9') nibble = digit - '0';
    else if (digit >= 'A' && digit <= 'F') nibble = digit - 'A' + 10;
    else if (digit >= 'a' && digit <= 'f') nibble = digit - 'a' + 10;
    else throw ArgumentError("tintColor must be #RRGGBB");
    rgb = (rgb << 4) | nibble;
  }
  result.red = static_cast<uint8_t>(rgb >> 16);
  result.green = static_cast<uint8_t>(rgb >> 8);
  result.blue = static_cast<uint8_t>(rgb);
  result.tintOpacity = ReadUnitInterval(env, value, "tintOpacity");
  result.luminosityOpacity = ReadUnitInterval(env, value, "luminosityOpacity");
  result.saturation = ReadUnitInterval(env, value, "saturation");
  return result;
}

void ValidateOwnedWindow(HWND hwnd, const AddonState& state) {
  DWORD processId = 0;
  const DWORD threadId = GetWindowThreadProcessId(hwnd, &processId);
  if (!hwnd || !IsWindow(hwnd) || processId != GetCurrentProcessId() || threadId != state.threadId)
    throw ArgumentError("HWND must be a live window owned by this process and thread");
}

template<typename T> void ValidateRecord(AddonState& state, HWND hwnd,
  const std::unordered_map<HWND, std::shared_ptr<T>>& records, const std::shared_ptr<T>& record) {
  ValidateOwnedWindow(hwnd, state);
  const auto found = records.find(hwnd);
  if (found == records.end() || found->second != record)
    throw std::runtime_error("Native policy window was destroyed or replaced");
}

template<typename F> decltype(auto) NativeStage(const char* stage, F operation) {
  try { return operation(); }
  catch (const winrt::hresult_error& error) {
    // Preserve the original HRESULT while identifying the failing native call.
    throw winrt::hresult_error(error.code(), winrt::to_hstring(stage) + L": " + error.message());
  }
}

bool RestoreHostPolicy(AddonState& state, HWND hwnd) {
  const auto found = state.hostPolicies.find(hwnd);
  if (found == state.hostPolicies.end()) return true;
  const auto policy = found->second;
  ValidateRecord(state, hwnd, state.hostPolicies, policy);
  if (policy->applying) return false;
  ApplyingScope applying(policy->applying);
  policy->active = false;
  // Each successful restoration is remembered independently. A failed setter
  // keeps the original snapshot and HWND hook so detach/clear can retry.
  if (policy->restoreBackdrop) {
    NativeStage("host.restore.system-backdrop", [&] {
      winrt::check_hresult(DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE,
        &policy->originalBackdrop, sizeof(policy->originalBackdrop)));
    });
    ValidateRecord(state, hwnd, state.hostPolicies, policy);
    policy->restoreBackdrop = false;
  }
  if (policy->restoreHost) {
    const BOOL disabled = FALSE;
    NativeStage("host.restore.enable-flag", [&] {
      winrt::check_hresult(DwmSetWindowAttribute(hwnd, DWMWA_USE_HOSTBACKDROPBRUSH,
        &disabled, sizeof(disabled)));
    });
    ValidateRecord(state, hwnd, state.hostPolicies, policy);
    policy->enabledByApp = false;
    policy->restoreHost = false;
  }
  winrt::check_bool(RemoveWindowSubclass(hwnd, HostPolicyWindowProc, reinterpret_cast<UINT_PTR>(&state)));
  state.hostPolicies.erase(hwnd);
  return true;
}

std::shared_ptr<HostPolicy> BeginHostPolicy(AddonState& state, HWND hwnd) {
  if (!RestoreHostPolicy(state, hwnd)) throw std::runtime_error("Host backdrop restoration is busy; retry attach");
  ValidateOwnedWindow(hwnd, state);
  auto policy = std::make_shared<HostPolicy>();
  // SYSTEMBACKDROP_TYPE supports Get. Host flag 17 only supports Set: these
  // application-owned notes establish FALSE, enable TRUE, then restore FALSE.
  // This is an owned policy, not restoration of an unknown external Host value.
  NativeStage("host.snapshot.system-backdrop", [&] {
    winrt::check_hresult(DwmGetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE,
      &policy->originalBackdrop, sizeof(policy->originalBackdrop)));
  });
  state.hostPolicies.emplace(hwnd, policy);
  if (!SetWindowSubclass(hwnd, HostPolicyWindowProc,
    reinterpret_cast<UINT_PTR>(&state), reinterpret_cast<DWORD_PTR>(&state))) {
    state.hostPolicies.erase(hwnd);
    winrt::throw_last_error();
  }
  ApplyingScope applying(policy->applying);
  // Record cleanup before either write, including a failed baseline setter.
  policy->restoreHost = true;
  const BOOL disabled = FALSE;
  NativeStage("host.claim.disable-baseline", [&] {
    winrt::check_hresult(DwmSetWindowAttribute(hwnd, DWMWA_USE_HOSTBACKDROPBRUSH, &disabled, sizeof(disabled)));
  });
  ValidateRecord(state, hwnd, state.hostPolicies, policy);
  policy->baselineEstablished = true;
  const BOOL enabled = TRUE;
  NativeStage("host.enable.set", [&] {
    winrt::check_hresult(DwmSetWindowAttribute(hwnd, DWMWA_USE_HOSTBACKDROPBRUSH, &enabled, sizeof(enabled)));
  });
  ValidateRecord(state, hwnd, state.hostPolicies, policy);
  policy->enabledByApp = true;
  return policy;
}

LRESULT CALLBACK HostPolicyWindowProc(HWND hwnd, UINT message, WPARAM wparam,
  LPARAM lparam, UINT_PTR subclassId, DWORD_PTR reference) {
  if (message == WM_NCDESTROY) {
    auto* state = reinterpret_cast<AddonState*>(reference);
    RemoveWindowSubclass(hwnd, HostPolicyWindowProc, subclassId);
    state->hostPolicies.erase(hwnd);
  }
  return DefSubclassProc(hwnd, message, wparam, lparam);
}

bool ApplyAcrylicBorder(AddonState& state, HWND hwnd, bool hidden, bool refresh = false) {
  auto found = state.acrylicBorders.find(hwnd);
  if (found == state.acrylicBorders.end() && !hidden) return true;
  ValidateOwnedWindow(hwnd, state);
  if (found == state.acrylicBorders.end()) {
    auto border = std::make_shared<AcrylicBorder>();
    found = state.acrylicBorders.emplace(hwnd, border).first;
    if (!SetWindowSubclass(hwnd, AcrylicBorderWindowProc,
      reinterpret_cast<UINT_PTR>(&state), reinterpret_cast<DWORD_PTR>(&state))) {
      state.acrylicBorders.erase(found);
      winrt::throw_last_error();
    }
  }
  const auto border = found->second;
  if (border->applying) return false;
  if (!refresh && !border->pending && border->hidden == hidden) return true;
  ApplyingScope applying(border->applying);
  border->desiredHidden = hidden;
  border->pending = true;
  // This API owns the product's NONE / system DEFAULT contract. BORDER_COLOR
  // is documented as Set-only; no fabricated original custom-color snapshot.
  const COLORREF color = hidden ? DWMWA_COLOR_NONE : DWMWA_COLOR_DEFAULT;
  winrt::check_hresult(DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, &color, sizeof(color)));
  ValidateRecord(state, hwnd, state.acrylicBorders, border);
  border->hidden = hidden;
  if (!hidden) {
    winrt::check_bool(RemoveWindowSubclass(hwnd, AcrylicBorderWindowProc, reinterpret_cast<UINT_PTR>(&state)));
    state.acrylicBorders.erase(hwnd);
  }
  border->pending = false;
  return true;
}

LRESULT CALLBACK AcrylicBorderWindowProc(HWND hwnd, UINT message, WPARAM wparam,
  LPARAM lparam, UINT_PTR subclassId, DWORD_PTR reference) {
  auto* state = reinterpret_cast<AddonState*>(reference);
  if (message == WM_NCDESTROY) {
    RemoveWindowSubclass(hwnd, AcrylicBorderWindowProc, subclassId);
    state->acrylicBorders.erase(hwnd);
    return DefSubclassProc(hwnd, message, wparam, lparam);
  }
  const auto result = DefSubclassProc(hwnd, message, wparam, lparam);
  // Electron/DWM can update border colors during activation or theme changes.
  // Reassert after the normal handler, without faking focus or touching shadow.
  // Chromium forwards Widget activation, and Electron updates its accent
  // border, at the end of WM_ACTIVATE (after the nested WM_NCACTIVATE).
  if (message == WM_ACTIVATE || message == WM_NCACTIVATE
    || message == WM_THEMECHANGED || message == WM_DWMCOLORIZATIONCOLORCHANGED) {
    const auto found = state->acrylicBorders.find(hwnd);
    if (found != state->acrylicBorders.end() && found->second->desiredHidden) {
      try { ApplyAcrylicBorder(*state, hwnd, true, true); }
      catch (...) {} // pending remains observable/retryable; never throw through USER32.
    }
  }
  return result;
}

DWORD ReadWindowStyle(HWND hwnd) {
  SetLastError(ERROR_SUCCESS);
  const auto style = GetWindowLongPtr(hwnd, GWL_STYLE);
  if (!style && GetLastError() != ERROR_SUCCESS) winrt::throw_last_error();
  return static_cast<DWORD>(style);
}

DWM_WINDOW_CORNER_PREFERENCE ReadCorner(HWND hwnd) {
  DWM_WINDOW_CORNER_PREFERENCE corner{};
  winrt::check_hresult(DwmGetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, &corner, sizeof(corner)));
  if (corner < DWMWCP_DEFAULT || corner > DWMWCP_ROUNDSMALL)
    throw std::runtime_error("Unexpected DWM corner preference");
  return corner;
}

void ValidateDecoration(AddonState& state, HWND hwnd, const std::shared_ptr<Decoration>& decoration) {
  ValidateOwnedWindow(hwnd, state);
  const auto found = state.decorations.find(hwnd);
  if (found == state.decorations.end() || found->second != decoration)
    throw std::runtime_error("Glass decoration window was destroyed or replaced");
}

void SetOwnedStyleBits(AddonState& state, HWND hwnd, DWORD bits, const std::shared_ptr<Decoration>& decoration) {
  ValidateDecoration(state, hwnd, decoration);
  const auto current = ReadWindowStyle(hwnd);
  const auto desired = RestoreGlassStyleBits(current, bits);
  if (current == desired && !decoration->frameRefreshPending) return;
  if (current != desired) {
    // A partial style write or failed frame refresh must remain retryable even
    // when the next call already reads the requested style bits.
    decoration->frameRefreshPending = true;
    SetLastError(ERROR_SUCCESS);
    const auto previous = SetWindowLongPtr(hwnd, GWL_STYLE, static_cast<LONG_PTR>(desired));
    if (!previous && GetLastError() != ERROR_SUCCESS) winrt::throw_last_error();
  }
  ValidateDecoration(state, hwnd, decoration);
  winrt::check_bool(SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
    SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED));
  ValidateDecoration(state, hwnd, decoration);
  if ((ReadWindowStyle(hwnd) & kGlassStyleBits) != (bits & kGlassStyleBits))
    throw std::runtime_error("Glass decoration style readback mismatch");
  decoration->frameRefreshPending = false;
}

bool IsOwnedLegacyChild(const AddonState& state, HWND child, HWND parent) {
  DWORD childProcess = 0, parentProcess = 0;
  wchar_t className[64]{};
  return IsWindow(child) && IsWindow(parent) && GetParent(child) == parent
    && GetAncestor(parent, GA_ROOT) == parent
    && GetWindowThreadProcessId(child, &childProcess) == state.threadId
    && GetWindowThreadProcessId(parent, &parentProcess) == state.threadId
    && childProcess == GetCurrentProcessId() && parentProcess == childProcess
    && GetClassNameW(child, className, static_cast<int>(std::size(className)))
    && lstrcmpW(className, L"Chrome_RenderWidgetHostHWND") == 0;
}

bool CanSupplementChild(AddonState& state, HWND child,
  const std::shared_ptr<LegacyResizeChild>& record, const std::shared_ptr<Decoration>& decoration) {
  const auto current = state.resizeChildren.find(child);
  const auto parent = state.decorations.find(record->parent);
  return decoration && current != state.resizeChildren.end() && current->second == record
    && parent != state.decorations.end() && parent->second == decoration && decoration->enabled
    && decoration->resizable
    && IsOwnedLegacyChild(state, child, record->parent)
    && IsWindowEnabled(child) && IsWindowEnabled(record->parent)
    && !IsIconic(record->parent) && !IsZoomed(record->parent);
}

int SupplementalParentHit(HWND parent, LRESULT original, LPARAM screenPoint) {
  RECT client{};
  POINT point{static_cast<short>(LOWORD(screenPoint)), static_cast<short>(HIWORD(screenPoint))};
  if (!GetClientRect(parent, &client) || !ScreenToClient(parent, &point)) return static_cast<int>(original);
  return sticky_note_resize::SupplementalHit(static_cast<int>(original), point.x, point.y,
    client.right - client.left, client.bottom - client.top, GetDpiForWindow(parent), true, true);
}

bool SetSupplementalResizeCursor(LRESULT original, int supplemented, LPARAM cursorMessage) {
  const auto resource = sticky_note_resize::SupplementalCursorResource(
    static_cast<int>(original), supplemented, static_cast<short>(LOWORD(cursorMessage)));
  if (!resource) return false;
  const auto cursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(resource));
  if (!cursor) return false;
  SetCursor(cursor);
  return true;
}

bool IsOwnedResizeThread(const AddonState& state, HWND hwnd) {
  DWORD process = 0;
  return GetCurrentThreadId() == state.threadId && IsWindow(hwnd)
    && GetWindowThreadProcessId(hwnd, &process) == state.threadId
    && process == GetCurrentProcessId();
}

bool HasLegacyResizeSubclass(const AddonState& state, HWND child) {
  DWORD_PTR reference = 0;
  return IsOwnedResizeThread(state, child)
    && GetWindowSubclass(child, LegacyResizeWindowProc, reinterpret_cast<UINT_PTR>(&state), &reference)
    && reference == reinterpret_cast<DWORD_PTR>(&state);
}

bool RemoveLegacyResizeChild(AddonState& state, HWND child) {
  // An HWND may have been destroyed/reused or moved to an unrelated parent.
  // Never subclass across threads; a missing subclass is already removed.
  if (IsOwnedResizeThread(state, child)) {
    DWORD_PTR reference = 0;
    if (GetWindowSubclass(child, LegacyResizeWindowProc, reinterpret_cast<UINT_PTR>(&state), &reference)
      && !RemoveWindowSubclass(child, LegacyResizeWindowProc, reinterpret_cast<UINT_PTR>(&state))) return false;
  }
  state.resizeChildren.erase(child);
  return true;
}

void InstallLegacyResizeChild(AddonState& state, HWND child, HWND parent,
  const std::shared_ptr<Decoration>& decoration) {
  if (GetCurrentThreadId() != state.threadId) return;
  const auto current = state.decorations.find(parent);
  DWORD_PTR parentReference = 0;
  const bool eligible = decoration && decoration->enabled
    && current != state.decorations.end() && current->second == decoration
    && IsOwnedLegacyChild(state, child, parent)
    && GetWindowSubclass(parent, DecorationWindowProc, reinterpret_cast<UINT_PTR>(&state), &parentReference)
    && parentReference == reinterpret_cast<DWORD_PTR>(&state);
  const auto previous = state.resizeChildren.find(child);
  if (previous != state.resizeChildren.end()) {
    if (eligible && previous->second->parent == parent
      && previous->second->decoration.lock() == decoration && HasLegacyResizeSubclass(state, child)) return;
    winrt::check_bool(RemoveLegacyResizeChild(state, child));
  }
  if (!eligible) return;
  auto record = std::make_shared<LegacyResizeChild>();
  record->parent = parent;
  record->decoration = decoration;
  state.resizeChildren.emplace(child, record);
  if (!SetWindowSubclass(child, LegacyResizeWindowProc,
    reinterpret_cast<UINT_PTR>(&state), reinterpret_cast<DWORD_PTR>(&state))) {
    state.resizeChildren.erase(child);
    winrt::throw_last_error();
  }
}

void InstallLegacyResizeChildren(AddonState& state, HWND parent, const std::shared_ptr<Decoration>& decoration) {
  struct Context {
    AddonState& state;
    HWND parent;
    const std::shared_ptr<Decoration>& decoration;
    std::exception_ptr failure;
  } context{state, parent, decoration, nullptr};
  // Initial enumeration and parent notifications remain fast paths. Lifecycle
  // events also cover NOPARENTNOTIFY creation, showing and renderer reparenting.
  EnumChildWindows(parent, [](HWND child, LPARAM parameter) -> BOOL {
    auto& data = *reinterpret_cast<Context*>(parameter);
    try { InstallLegacyResizeChild(data.state, child, data.parent, data.decoration); }
    catch (...) { data.failure = std::current_exception(); return FALSE; }
    return TRUE;
  }, reinterpret_cast<LPARAM>(&context));
  if (context.failure) std::rethrow_exception(context.failure);
}

bool RemoveLegacyResizeChildren(AddonState& state, HWND parent) {
  bool removed = true;
  for (auto current = state.resizeChildren.begin(); current != state.resizeChildren.end();) {
    if (current->second->parent != parent) { ++current; continue; }
    const HWND child = current++->first;
    if (!RemoveLegacyResizeChild(state, child)) removed = false;
  }
  return removed;
}

void StopResizeLifecycleObserver(AddonState& state) noexcept {
  const auto observer = std::move(state.resizeObserver);
  if (!observer) return;
  observer->state = nullptr;
  resizeObservers.erase(observer->hook);
  UnhookWinEvent(observer->hook);
  observer->hook = nullptr;
}

AddonState::~AddonState() { StopResizeLifecycleObserver(*this); }

void CALLBACK ResizeLifecycleEvent(HWINEVENTHOOK hook, DWORD event, HWND hwnd,
  LONG object, LONG child, DWORD eventThread, DWORD) {
  if (object != OBJID_WINDOW || child != CHILDID_SELF
    || (event != EVENT_OBJECT_CREATE && event != EVENT_OBJECT_SHOW && event != EVENT_OBJECT_PARENTCHANGE)) return;
  const auto found = resizeObservers.find(hook);
  if (found == resizeObservers.end()) return;
  const auto observer = found->second.lock();
  if (!observer || !observer->state || observer->synchronizing) return;
  auto& state = *observer->state;
  if (eventThread != state.threadId || !IsOwnedResizeThread(state, hwnd)) return;
  ApplyingScope synchronizing(observer->synchronizing);
  try {
    // Treat the event only as a wake-up, never as an identity snapshot. Recheck
    // the current HWND, direct parent, class, decoration and real subclasses.
    // This also makes delayed events harmless after HWND/hook handle reuse.
    const auto parent = GetParent(hwnd);
    const auto decoration = state.decorations.find(parent);
    InstallLegacyResizeChild(state, hwnd, parent,
      decoration == state.decorations.end() ? nullptr : decoration->second);
    const auto ownDecoration = state.decorations.find(hwnd);
    if (ownDecoration != state.decorations.end() && ownDecoration->second->enabled)
      InstallLegacyResizeChildren(state, hwnd, ownDecoration->second);
  } catch (...) {} // Never unwind through USER32; the next lifecycle event can retry.
}

void UpdateResizeLifecycleObserver(AddonState& state) {
  const bool needed = std::any_of(state.decorations.begin(), state.decorations.end(),
    [](const auto& entry) { return entry.second->enabled; });
  if (!needed || state.stoppingResizeObserver) {
    StopResizeLifecycleObserver(state);
    return;
  }
  if (state.resizeObserver) return;
  auto observer = std::make_shared<ResizeLifecycleObserver>();
  observer->state = &state;
  observer->hook = SetWinEventHook(EVENT_OBJECT_CREATE, EVENT_OBJECT_PARENTCHANGE, nullptr,
    ResizeLifecycleEvent, GetCurrentProcessId(), state.threadId, WINEVENT_OUTOFCONTEXT);
  winrt::check_bool(observer->hook != nullptr);
  try { resizeObservers.emplace(observer->hook, observer); }
  catch (...) { UnhookWinEvent(observer->hook); throw; }
  state.resizeObserver = std::move(observer);
}

LRESULT CALLBACK LegacyResizeWindowProc(HWND hwnd, UINT message, WPARAM wparam,
  LPARAM lparam, UINT_PTR subclassId, DWORD_PTR reference) {
  auto* state = reinterpret_cast<AddonState*>(reference);
  if (message == WM_NCDESTROY) {
    RemoveWindowSubclass(hwnd, LegacyResizeWindowProc, subclassId);
    state->resizeChildren.erase(hwnd);
    return DefSubclassProc(hwnd, message, wparam, lparam);
  }
  // Keep Chromium's hover/leave bookkeeping, then restore our gutter cursor
  // after its mouse dispatcher. Never dispatch the same move twice.
  const bool cursorMove = message == WM_NCMOUSEMOVE;
  const auto moveResult = cursorMove ? DefSubclassProc(hwnd, message, wparam, lparam) : 0;
  if (message == WM_NCHITTEST || message == WM_NCLBUTTONDOWN
    || message == WM_SETCURSOR || message == WM_NCMOUSEMOVE) {
    const auto found = state->resizeChildren.find(hwnd);
    if (found != state->resizeChildren.end()) {
      const auto record = found->second;
      const auto decoration = record->decoration.lock();
      if (CanSupplementChild(*state, hwnd, record, decoration)) {
        LPARAM screenPoint = lparam;
        if (message == WM_SETCURSOR) {
          POINT point{};
          // This message contains a hit code, not coordinates. Do not interfere
          // with another HWND's cursor or with captured text/scroll/drag input.
          if (reinterpret_cast<HWND>(wparam) != hwnd || GetCapture() || !GetCursorPos(&point))
            return DefSubclassProc(hwnd, message, wparam, lparam);
          screenPoint = MAKELPARAM(point.x, point.y);
        }
        // Chromium's legacy child forwards directly to its parent's C++ event
        // target, bypassing the parent's HWND subclass. Preserve its own hit
        // first, including top resizing, caption controls and draggable areas.
        const auto original = DefSubclassProc(hwnd, WM_NCHITTEST, 0, screenPoint);
        if (CanSupplementChild(*state, hwnd, record, decoration)) {
          const int supplemented = SupplementalParentHit(record->parent, original, screenPoint);
          if (message == WM_NCHITTEST) return supplemented;
          // LegacyRenderWidgetHostHWND::OnSetCursor consumes the message without
          // setting a cursor. Return TRUE after supplying only our gutter cursor.
          if (message == WM_SETCURSOR && !GetCapture()
            && SetSupplementalResizeCursor(original, supplemented, lparam))
            return TRUE;
          // Aura may overwrite WM_SETCURSOR's result while processing a move.
          // Its normal handler has run; restore only our gutter cursor after
          // rechecking the window's current scope and capture state.
          if (message == WM_NCMOUSEMOVE && !GetCapture()
            && SetSupplementalResizeCursor(original, supplemented, static_cast<LPARAM>(wparam)))
            return moveResult;
          if (sticky_note_resize::ShouldRouteResizePress(message, static_cast<int>(original),
            supplemented, static_cast<int>(wparam))) {
            // Let USER32 issue SC_SIZE to the parent before Aura consumes the
            // press and captures it as renderer input. The modal loop may destroy
            // either HWND; do not touch state/records after this call.
            return DefWindowProcW(record->parent, message, wparam, lparam);
          }
        } else if (message == WM_NCHITTEST) {
          return original;
        } else if (!IsWindow(hwnd)) {
          return moveResult;
        }
      }
    }
  }
  return cursorMove ? moveResult : DefSubclassProc(hwnd, message, wparam, lparam);
}

bool ApplyGlassDecoration(AddonState& state, HWND hwnd, bool enabled, bool shadowEnabled = false,
  std::optional<bool> resizable = std::nullopt) {
  auto found = state.decorations.find(hwnd);
  if (found == state.decorations.end() && !enabled) return true;
  ValidateOwnedWindow(hwnd, state);
  if (found == state.decorations.end()) {
    auto decoration = std::make_shared<Decoration>();
    decoration->originalStyleBits = ReadWindowStyle(hwnd) & kGlassStyleBits;
    decoration->resizable = (decoration->originalStyleBits & WS_THICKFRAME) != 0;
    decoration->originalCorner = ReadCorner(hwnd);
    found = state.decorations.emplace(hwnd, decoration).first;
    if (!SetWindowSubclass(hwnd, DecorationWindowProc,
      reinterpret_cast<UINT_PTR>(&state), reinterpret_cast<DWORD_PTR>(&state))) {
      state.decorations.erase(found);
      winrt::throw_last_error();
    }
    decoration->subclassInstalled = true;
  }
  // A frame refresh can synchronously produce Electron resize callbacks. Keep
  // the record alive through reentrancy/destruction and never recursively refresh.
  const auto decoration = found->second;
  if (decoration->applying) return false;
  struct ApplyingGuard {
    bool& flag;
    explicit ApplyingGuard(bool& value) : flag(value) { flag = true; }
    ~ApplyingGuard() { flag = false; }
  } applying(decoration->applying);

  // Chromium may clear WS_THICKFRAME after making a Mica window translucent.
  // Preserve the exact frame snapshot for restoration; it is not the app's
  // resize capability. Explicit callers supply BrowserWindow.isResizable().
  if (resizable.has_value()) decoration->resizable = *resizable;

  // Keep the same full client area in both glass modes. Install the layout
  // policy before FRAMECHANGED so Chromium cannot inset the renderer when the
  // system frame bits are restored for a shadow. Leaving glass releases it.
  if (decoration->enabled != enabled) decoration->frameRefreshPending = true;
  decoration->enabled = enabled;
  UpdateResizeLifecycleObserver(state);
  if (enabled) InstallLegacyResizeChildren(state, hwnd, decoration);
  else winrt::check_bool(RemoveLegacyResizeChildren(state, hwnd));
  // A failed operation deliberately retains the original snapshot and hook so
  // either enable or restore can retry; dynamic style bits are never restored.
  SetOwnedStyleBits(state, hwnd, enabled && !shadowEnabled ? 0 : decoration->originalStyleBits, decoration);
  ValidateDecoration(state, hwnd, decoration);
  const auto desiredCorner = enabled && !shadowEnabled ? DWMWCP_DONOTROUND : decoration->originalCorner;
  if (ReadCorner(hwnd) != desiredCorner) {
    winrt::check_hresult(DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE,
      &desiredCorner, sizeof(desiredCorner)));
    ValidateDecoration(state, hwnd, decoration);
    if (ReadCorner(hwnd) != desiredCorner) throw std::runtime_error("Glass corner preference readback mismatch");
  }
  if (const auto surface = state.surfaces.find(hwnd); surface != state.surfaces.end()) {
    // FRAMECHANGED can alter the client without emitting Electron's resize.
    // Measure here so the composition graph never retains the old inset size.
    ResizeSurface(*surface->second, hwnd);
    UpdateSurfaceClip(*surface->second, hwnd, enabled);
  }
  decoration->enabled = enabled;
  if (!enabled) {
    if (decoration->subclassInstalled)
      winrt::check_bool(RemoveWindowSubclass(hwnd, DecorationWindowProc, reinterpret_cast<UINT_PTR>(&state)));
    state.decorations.erase(hwnd);
  }
  return true;
}

LRESULT CALLBACK DecorationWindowProc(HWND hwnd, UINT message, WPARAM wparam,
  LPARAM lparam, UINT_PTR subclassId, DWORD_PTR reference) {
  auto* state = reinterpret_cast<AddonState*>(reference);
  if (message == WM_NCDESTROY) {
    RemoveLegacyResizeChildren(*state, hwnd);
    RemoveWindowSubclass(hwnd, DecorationWindowProc, subclassId);
    // No DWM setters during destruction; the record must not survive HWND reuse.
    state->decorations.erase(hwnd);
    try { UpdateResizeLifecycleObserver(*state); } catch (...) {}
    return DefSubclassProc(hwnd, message, wparam, lparam);
  }
  // Let renderer hover/leave processing finish before supplying the native
  // sizing cursor. Default processing can disable glass or destroy the HWND.
  const bool cursorMove = message == WM_NCMOUSEMOVE;
  const auto moveResult = cursorMove ? DefSubclassProc(hwnd, message, wparam, lparam) : 0;
  if (message == WM_PARENTNOTIFY && LOWORD(wparam) == WM_CREATE) {
    const auto result = DefSubclassProc(hwnd, message, wparam, lparam);
    const auto found = state->decorations.find(hwnd);
    if (found != state->decorations.end() && found->second->enabled) {
      try { InstallLegacyResizeChild(*state, reinterpret_cast<HWND>(lparam), hwnd, found->second); }
      catch (...) {} // A later policy application can retry; never unwind through USER32.
    }
    return result;
  }
  if (message == WM_NCCALCSIZE && lparam && !IsIconic(hwnd) && !IsZoomed(hwnd)) {
    const auto found = state->decorations.find(hwnd);
    if (found != state->decorations.end() && found->second->enabled) {
      const auto decoration = found->second;
      const RECT proposed = wparam ? reinterpret_cast<NCCALCSIZE_PARAMS*>(lparam)->rgrc[0]
        : *reinterpret_cast<RECT*>(lparam);
      const auto result = DefSubclassProc(hwnd, message, wparam, lparam);
      // Default processing may reenter, leave glass, or destroy this window.
      const auto current = state->decorations.find(hwnd);
      if (current != state->decorations.end() && current->second == decoration
        && decoration->enabled && IsWindow(hwnd) && !IsIconic(hwnd) && !IsZoomed(hwnd)) {
        if (wparam) reinterpret_cast<NCCALCSIZE_PARAMS*>(lparam)->rgrc[0] = proposed;
        else *reinterpret_cast<RECT*>(lparam) = proposed;
        return 0;
      }
      return result;
    }
  }
  if (((message == WM_SETCURSOR && reinterpret_cast<HWND>(wparam) == hwnd)
    || message == WM_NCMOUSEMOVE) && !GetCapture()) {
    const auto found = state->decorations.find(hwnd);
    if (found != state->decorations.end() && found->second->enabled) {
      const auto decoration = found->second;
      POINT point{};
      if (GetCursorPos(&point)) {
        const auto screenPoint = MAKELPARAM(point.x, point.y);
        const auto original = DefSubclassProc(hwnd, WM_NCHITTEST, 0, screenPoint);
        const auto current = state->decorations.find(hwnd);
        if (!IsWindow(hwnd)) return moveResult;
        if (current != state->decorations.end() && current->second == decoration
          && decoration->enabled && !GetCapture() && IsWindowEnabled(hwnd) && !IsIconic(hwnd) && !IsZoomed(hwnd)
          && decoration->resizable
          && SetSupplementalResizeCursor(original, SupplementalParentHit(hwnd, original, screenPoint),
            message == WM_SETCURSOR ? lparam : static_cast<LPARAM>(wparam)))
          return message == WM_SETCURSOR ? TRUE : moveResult;
      }
    }
  }
  if (message == WM_NCLBUTTONDOWN) {
    const auto found = state->decorations.find(hwnd);
    if (found != state->decorations.end() && found->second->enabled) {
      const auto decoration = found->second;
      // A legacy-child non-client hit can route the actual press to this
      // ancestor. Query Chromium's unmodified hit before its mouse dispatcher
      // can consume the press as renderer input and establish normal capture.
      const auto original = DefSubclassProc(hwnd, WM_NCHITTEST, 0, lparam);
      const auto current = state->decorations.find(hwnd);
      if (!IsWindow(hwnd)) return 0;
      if (current != state->decorations.end() && current->second == decoration
        && decoration->enabled && IsWindowEnabled(hwnd) && !IsIconic(hwnd) && !IsZoomed(hwnd)
        && decoration->resizable
        && sticky_note_resize::ShouldRouteResizePress(message, static_cast<int>(original),
          SupplementalParentHit(hwnd, original, lparam), static_cast<int>(wparam))) {
        // Preserve the normal SC_SIZE/minimum-size handling and modal loop.
        // It may destroy the window, so do not access addon state afterward.
        return DefWindowProcW(hwnd, message, wparam, lparam);
      }
    }
  }
  if (message == WM_NCHITTEST) {
    const auto found = state->decorations.find(hwnd);
    if (found != state->decorations.end() && found->second->enabled) {
      const auto decoration = found->second;
      const auto result = DefSubclassProc(hwnd, message, wparam, lparam);
      const auto current = state->decorations.find(hwnd);
      if ((result != HTCLIENT && result != HTNOWHERE)
        || current == state->decorations.end() || current->second != decoration
        || !decoration->enabled || !IsWindow(hwnd) || !IsWindowEnabled(hwnd)
        || IsIconic(hwnd) || IsZoomed(hwnd)
        || !decoration->resizable) return result;
      RECT client{};
      POINT point{static_cast<short>(LOWORD(lparam)), static_cast<short>(HIWORD(lparam))};
      if (!GetClientRect(hwnd, &client) || !ScreenToClient(hwnd, &point)) return result;
      // Electron's WinFrameView disables inner side/bottom hits when its cached
      // thick-frame flag expects outer insets. Full-client glass has no such
      // insets, so restore only those narrow gutters after its normal hit test.
      return sticky_note_resize::SupplementalHit(static_cast<int>(result), point.x, point.y,
        client.right - client.left, client.bottom - client.top, GetDpiForWindow(hwnd), true, true);
    }
  }
  return cursorMove ? moveResult : DefSubclassProc(hwnd, message, wparam, lparam);
}

napi_value Boolean(napi_env env, bool value) {
  napi_value result; CheckNapi(napi_get_boolean(env, value, &result)); return result;
}

void SetBoolean(napi_env env, napi_value object, const char* key, bool value) {
  CheckNapi(napi_set_named_property(env, object, key, Boolean(env, value)));
}

void SetNumber(napi_env env, napi_value object, const char* key, double value) {
  napi_value number; CheckNapi(napi_create_double(env, value, &number));
  CheckNapi(napi_set_named_property(env, object, key, number));
}

void SetString(napi_env env, napi_value object, const char* key, const char* value) {
  napi_value text; CheckNapi(napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &text));
  CheckNapi(napi_set_named_property(env, object, key, text));
}

template<typename F> napi_value Guard(napi_env env, F operation) {
  try { return operation(); }
  catch (const ArgumentError& error) { napi_throw_type_error(env, "ERR_NATIVE_SURFACE_ARGUMENT", error.what()); }
  catch (const update_executable_pin::Failure& error) {
    // Keep the existing code/message even when best-effort diagnostic creation fails.
    napi_value code, message, value;
    if (napi_create_string_utf8(env, "ERR_NATIVE_SURFACE", NAPI_AUTO_LENGTH, &code) != napi_ok
        || napi_create_string_utf8(env, error.what(), NAPI_AUTO_LENGTH, &message) != napi_ok
        || napi_create_error(env, code, message, &value) != napi_ok) {
      napi_throw_error(env, "ERR_NATIVE_SURFACE", error.what()); return nullptr;
    }
    try {
      napi_value diagnostic, rawPath, nothing;
      CheckNapi(napi_create_object(env, &diagnostic));
      CheckNapi(napi_get_null(env, &nothing));
      SetString(env, diagnostic, "operation", error.operation);
      CheckNapi(napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(error.path.data()), error.path.size(), &rawPath));
      CheckNapi(napi_set_named_property(env, diagnostic, "path", rawPath));
      SetBoolean(env, diagnostic, "directory", error.directory);
      if (error.hasNativeError) {
        SetNumber(env, diagnostic, "nativeErrorCode", error.nativeErrorCode);
        SetString(env, diagnostic, "nativeCodeSource", "GetLastError");
      } else {
        CheckNapi(napi_set_named_property(env, diagnostic, "nativeErrorCode", nothing));
        CheckNapi(napi_set_named_property(env, diagnostic, "nativeCodeSource", nothing));
      }
      if (error.validationReason) SetString(env, diagnostic, "validationReason", error.validationReason);
      else CheckNapi(napi_set_named_property(env, diagnostic, "validationReason", nothing));
      SetNumber(env, diagnostic, "access", error.directory ? FILE_READ_ATTRIBUTES : GENERIC_READ);
      SetNumber(env, diagnostic, "share", FILE_SHARE_READ | (error.directory ? FILE_SHARE_WRITE : 0));
      SetNumber(env, diagnostic, "creation", OPEN_EXISTING);
      SetNumber(env, diagnostic, "flags", FILE_FLAG_OPEN_REPARSE_POINT | (error.directory ? FILE_FLAG_BACKUP_SEMANTICS : 0));
      CheckNapi(napi_set_named_property(env, value, "updateDiagnostic", diagnostic));
    } catch (...) {
      bool pending = false;
      if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
        napi_value ignored; napi_get_and_clear_last_exception(env, &ignored);
      }
    }
    napi_throw(env, value);
  }
  catch (const winrt::hresult_error& error) {
    const auto message = "Windows native surface failed (HRESULT " +
      std::to_string(static_cast<int32_t>(error.code())) + "): " + winrt::to_string(error.message());
    napi_throw_error(env, "ERR_NATIVE_SURFACE", message.c_str());
  }
  catch (const std::exception& error) { napi_throw_error(env, "ERR_NATIVE_SURFACE", error.what()); }
  return nullptr;
}

// Geometry restoration is restricted to a not-yet-shown, normal top-level
// window. It never changes coordinates, activation, z-order, or frame policy.
void ValidateHiddenGeometryWindow(HWND hwnd, const AddonState& state) {
  ValidateOwnedWindow(hwnd, state);
  if (GetAncestor(hwnd, GA_ROOT) != hwnd || (ReadWindowStyle(hwnd) & WS_CHILD)
    || IsWindowVisible(hwnd) || IsIconic(hwnd) || IsZoomed(hwnd))
    throw ArgumentError("Bounds restoration requires a hidden normal top-level window");
}

struct PhysicalGeometry {
  RECT rect{};
  UINT dpi = 0;
  DWORD style = 0;
  DWORD extendedStyle = 0;
  HMONITOR monitor = nullptr;
};

PhysicalGeometry ReadPhysicalGeometry(HWND hwnd) {
  PhysicalGeometry value;
  if (!GetWindowRect(hwnd, &value.rect)) throw std::runtime_error("GetWindowRect failed");
  const int64_t width = static_cast<int64_t>(value.rect.right) - value.rect.left;
  const int64_t height = static_cast<int64_t>(value.rect.bottom) - value.rect.top;
  if (width <= 0 || height <= 0 || width > INT32_MAX || height > INT32_MAX)
    throw std::runtime_error("Invalid physical window rectangle");
  value.dpi = GetDpiForWindow(hwnd);
  value.style = ReadWindowStyle(hwnd);
  SetLastError(ERROR_SUCCESS);
  value.extendedStyle = static_cast<DWORD>(GetWindowLongW(hwnd, GWL_EXSTYLE));
  if (GetLastError() != ERROR_SUCCESS) throw std::runtime_error("Could not read extended window style");
  value.monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
  if (!value.dpi || !value.monitor) throw std::runtime_error("Could not read window DPI or monitor");
  return value;
}

double ReadGeometryNumber(napi_env env, napi_value object, const char* key, double minimum, double maximum) {
  napi_value field;
  CheckNapi(napi_get_named_property(env, object, key, &field));
  double number = 0;
  if (napi_get_value_double(env, field, &number) != napi_ok || !std::isfinite(number)
    || std::floor(number) != number || number < minimum || number > maximum)
    throw ArgumentError(std::string("Invalid geometry field: ") + key);
  return number;
}

napi_value GetPhysicalRect(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    auto& state = StateFor(env);
    const HWND hwnd = ReadHandle(env, info);
    ValidateHiddenGeometryWindow(hwnd, state);
    const auto value = ReadPhysicalGeometry(hwnd);
    napi_value result, monitor;
    CheckNapi(napi_create_object(env, &result));
    SetNumber(env, result, "x", value.rect.left); SetNumber(env, result, "y", value.rect.top);
    SetNumber(env, result, "width", static_cast<double>(static_cast<int64_t>(value.rect.right) - value.rect.left));
    SetNumber(env, result, "height", static_cast<double>(static_cast<int64_t>(value.rect.bottom) - value.rect.top));
    SetNumber(env, result, "dpi", value.dpi); SetNumber(env, result, "style", value.style);
    SetNumber(env, result, "extendedStyle", value.extendedStyle);
    CheckNapi(napi_create_bigint_uint64(env, reinterpret_cast<uintptr_t>(value.monitor), &monitor));
    CheckNapi(napi_set_named_property(env, result, "monitor", monitor));
    return result;
  });
}

napi_value SetPhysicalSize(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    size_t count = 4;
    napi_value args[4]{};
    CheckNapi(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    if (count != 3) throw ArgumentError("Expected HWND, physical snapshot and target size");
    const HWND hwnd = ReadHandleValue(env, args[0]);
    const auto x = ReadGeometryNumber(env, args[1], "x", INT32_MIN, INT32_MAX);
    const auto y = ReadGeometryNumber(env, args[1], "y", INT32_MIN, INT32_MAX);
    const auto width = ReadGeometryNumber(env, args[1], "width", 1, INT32_MAX);
    const auto height = ReadGeometryNumber(env, args[1], "height", 1, INT32_MAX);
    const auto dpi = ReadGeometryNumber(env, args[1], "dpi", 1, UINT32_MAX);
    const auto style = ReadGeometryNumber(env, args[1], "style", 0, UINT32_MAX);
    const auto extendedStyle = ReadGeometryNumber(env, args[1], "extendedStyle", 0, UINT32_MAX);
    napi_value monitorField;
    CheckNapi(napi_get_named_property(env, args[1], "monitor", &monitorField));
    uint64_t monitor = 0;
    bool lossless = false;
    if (napi_get_value_bigint_uint64(env, monitorField, &monitor, &lossless) != napi_ok || !lossless)
      throw ArgumentError("Expected lossless monitor bigint");
    const auto targetWidth = static_cast<int32_t>(ReadGeometryNumber(env, args[2], "width", 1, INT32_MAX));
    const auto targetHeight = static_cast<int32_t>(ReadGeometryNumber(env, args[2], "height", 1, INT32_MAX));
    // Read all JS properties before validating current state: a property getter
    // may itself run JS and change the window. The comparison is then atomic
    // with respect to this UI thread until USER32 processes the single resize.
    auto& state = StateFor(env);
    ValidateHiddenGeometryWindow(hwnd, state);
    const auto current = ReadPhysicalGeometry(hwnd);
    if (current.rect.left != x || current.rect.top != y
      || static_cast<double>(static_cast<int64_t>(current.rect.right) - current.rect.left) != width
      || static_cast<double>(static_cast<int64_t>(current.rect.bottom) - current.rect.top) != height
      || current.dpi != dpi || current.style != style || current.extendedStyle != extendedStyle
      || reinterpret_cast<uintptr_t>(current.monitor) != monitor) return Boolean(env, false);
    const int64_t right = static_cast<int64_t>(current.rect.left) + targetWidth;
    const int64_t bottom = static_cast<int64_t>(current.rect.top) + targetHeight;
    if (right > INT32_MAX || bottom > INT32_MAX) return Boolean(env, false);
    RECT candidate{current.rect.left, current.rect.top, static_cast<LONG>(right), static_cast<LONG>(bottom)};
    // A resize can change the dominant monitor even though the origin stays
    // fixed. Never apply a conversion calculated for a different monitor.
    if (MonitorFromRect(&candidate, MONITOR_DEFAULTTONEAREST) != current.monitor) return Boolean(env, false);
    if (!SetWindowPos(hwnd, nullptr, 0, 0, targetWidth, targetHeight,
      SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER))
      throw std::runtime_error("Physical bounds restoration failed: " + std::to_string(GetLastError()));
    return Boolean(env, true);
  });
}


bool EraseSurface(AddonState& state, HWND hwnd, bool removeSubclass) noexcept {
  const auto found = state.surfaces.find(hwnd);
  if (found == state.surfaces.end()) return false;
  if (removeSubclass && found->second->subclassInstalled) {
    // RemoveWindowSubclass safely returns false for a destroyed HWND. This
    // happens before releasing composition resources and never changes DWM.
    RemoveWindowSubclass(hwnd, SurfaceWindowProc, reinterpret_cast<UINT_PTR>(&state));
  }
  state.surfaces.erase(found);
  return true;
}

LRESULT CALLBACK SurfaceWindowProc(HWND hwnd, UINT message, WPARAM wparam,
  LPARAM lparam, UINT_PTR subclassId, DWORD_PTR reference) {
  if (message == WM_NCDESTROY) {
    auto* state = reinterpret_cast<AddonState*>(reference);
    RemoveWindowSubclass(hwnd, SurfaceWindowProc, subclassId);
    // The HWND can no longer be reused with an orphaned entry. There are no
    // activation, focus, painting, or policy hooks in this subclass.
    EraseSurface(*state, hwnd, false);
  }
  return DefSubclassProc(hwnd, message, wparam, lparam);
}

void ClearSurfaces(AddonState& state) noexcept {
  while (!state.surfaces.empty()) EraseSurface(state, state.surfaces.begin()->first, true);
}

bool DetachSurface(AddonState& state, HWND hwnd) {
  const auto policy = state.hostPolicies.find(hwnd);
  if (policy != state.hostPolicies.end() && policy->second->applying)
    throw std::runtime_error("Host backdrop operation is busy; retry detach");
  const bool erased = EraseSurface(state, hwnd, true);
  if (!RestoreHostPolicy(state, hwnd)) throw std::runtime_error("Host backdrop restore is busy; retry detach");
  return erased;
}

template<typename Map, typename Restore> void RestoreAll(Map& records, Restore restore, std::exception_ptr& failure) {
  std::vector<HWND> windows;
  windows.reserve(records.size());
  for (const auto& entry : records) windows.push_back(entry.first);
  for (const auto hwnd : windows) {
    try {
      if (!restore(hwnd)) throw std::runtime_error("Native policy is busy; clear can be retried");
    } catch (...) { if (!failure) failure = std::current_exception(); }
  }
}

void ClearWindowPolicies(AddonState& state) {
  std::exception_ptr failure;
  RestoreAll(state.hostPolicies, [&](HWND hwnd) { return RestoreHostPolicy(state, hwnd); }, failure);
  RestoreAll(state.acrylicBorders, [&](HWND hwnd) { return ApplyAcrylicBorder(state, hwnd, false); }, failure);
  RestoreAll(state.decorations, [&](HWND hwnd) { return ApplyGlassDecoration(state, hwnd, false); }, failure);
  if (failure) std::rethrow_exception(failure);
}

void Finalize(napi_env, void* data, void*) {
  auto* state = static_cast<AddonState*>(data);
  state->stoppingResizeObserver = true;
  StopResizeLifecycleObserver(*state);
  ClearSurfaces(*state);
  try { ClearWindowPolicies(*state); } catch (...) {}
  // If a live-window restore failed during environment teardown, never leave a
  // subclass pointing at the state that is about to be freed.
  for (const auto& entry : state->resizeChildren) {
    try {
      ValidateOwnedWindow(entry.first, *state);
      RemoveWindowSubclass(entry.first, LegacyResizeWindowProc, reinterpret_cast<UINT_PTR>(state));
    } catch (...) {}
  }
  state->resizeChildren.clear();
  for (const auto& entry : state->decorations) {
    try {
      ValidateOwnedWindow(entry.first, *state);
      RemoveWindowSubclass(entry.first, DecorationWindowProc, reinterpret_cast<UINT_PTR>(state));
    } catch (...) {}
  }
  state->decorations.clear();
  for (const auto& entry : state->hostPolicies) {
    try { ValidateOwnedWindow(entry.first, *state);
      RemoveWindowSubclass(entry.first, HostPolicyWindowProc, reinterpret_cast<UINT_PTR>(state));
    } catch (...) {}
  }
  state->hostPolicies.clear();
  for (const auto& entry : state->acrylicBorders) {
    try { ValidateOwnedWindow(entry.first, *state);
      RemoveWindowSubclass(entry.first, AcrylicBorderWindowProc, reinterpret_cast<UINT_PTR>(state));
    } catch (...) {}
  }
  state->acrylicBorders.clear();
  if (state->ownedQueue) {
    // Never wait on the current UI thread for its own queue to drain.
    try { state->ownedQueue.ShutdownQueueAsync(); } catch (...) {}
    state->ownedQueue = nullptr;
  }
  delete state;
}

void EnsureQueue(AddonState& state) {
  if (state.ownedQueue || DispatcherQueue::GetForCurrentThread()) return;
  ABI::Windows::System::IDispatcherQueueController* controller = nullptr;
  winrt::check_hresult(CreateDispatcherQueueController({sizeof(QueueOptions), 2, 0}, &controller));
  state.ownedQueue = DispatcherQueueController{controller, winrt::take_ownership_from_abi};
}

void UpdateSurfaceClip(Surface& surface, HWND hwnd, bool enabled) {
  if (!enabled) {
    if (surface.clipEnabled) surface.sprite.Clip(nullptr);
    surface.clipGeometry = nullptr;
    surface.roundedClip = nullptr;
    surface.clipEnabled = false;
    surface.clipRadius = 0;
    return;
  }
  const UINT dpi = GetDpiForWindow(hwnd);
  if (!dpi) throw std::runtime_error("Cannot read wallpaper clip DPI");
  const float radius = std::min(8.0f * static_cast<float>(dpi) / 96.0f,
    std::min(surface.width, surface.height) / 2.0f);
  const winrt::Windows::Foundation::Numerics::float2 size{surface.width, surface.height};
  if (!surface.roundedClip) {
    auto geometry = surface.compositor.CreateRoundedRectangleGeometry();
    geometry.Size(size);
    geometry.CornerRadius({radius, radius});
    auto clip = surface.compositor.CreateGeometricClip(geometry);
    surface.sprite.Clip(clip);
    surface.clipGeometry = std::move(geometry);
    surface.roundedClip = std::move(clip);
  } else {
    if (surface.clipGeometry.Size() != size) surface.clipGeometry.Size(size);
    if (surface.clipRadius != radius) surface.clipGeometry.CornerRadius({radius, radius});
  }
  surface.clipEnabled = true;
  surface.clipRadius = radius;
}

bool ResizeSurface(Surface& surface, HWND hwnd) {
  RECT rect{};
  winrt::check_bool(GetClientRect(hwnd, &rect));
  const float width = static_cast<float>(rect.right - rect.left);
  const float height = static_cast<float>(rect.bottom - rect.top);
  surface.root.Size({width, height});
  surface.width = width;
  surface.height = height;
  if (surface.clipEnabled) UpdateSurfaceClip(surface, hwnd, true);
  return true;
}

napi_value Attach(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    size_t count = 3;
    napi_value args[3]{};
    CheckNapi(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    if (count < 1 || count > 2) throw ArgumentError("Expected HWND bigint and optional wallpaper or host source");
    const HWND hwnd = ReadHandleValue(env, args[0]);
    SourceKind source = SourceKind::Wallpaper;
    if (count == 2) {
      const auto name = ReadString(env, args[1]);
      if (name == "host") source = SourceKind::Host;
      else if (name != "wallpaper") throw ArgumentError("Source must be exactly wallpaper or host");
    }
    auto& state = StateFor(env);
    ValidateOwnedWindow(hwnd, state);
    if (const auto existing = state.surfaces.find(hwnd); existing != state.surfaces.end()) {
      if (existing->second->source == source) return Boolean(env, ResizeSurface(*existing->second, hwnd));
    }
    // Cross-source replacement never creates competing desktop targets. A
    // previous failed Host restore must finish before a new source can attach.
    NativeStage("attach.detach-previous-source", [&] { DetachSurface(state, hwnd); });

    if (!winrt::Windows::Foundation::Metadata::ApiInformation::IsMethodPresent(
      L"Windows.UI.Composition.Compositor", source == SourceKind::Host
        ? L"CreateHostBackdropBrush" : L"TryCreateBlurredWallpaperBackdropBrush")) return Boolean(env, false);
    NativeStage("attach.ensure-dispatcher-queue", [&] { EnsureQueue(state); });

    auto surface = std::make_shared<Surface>();
    surface->source = source;
    std::shared_ptr<HostPolicy> host;
    std::unique_ptr<ApplyingScope> hostApplying;
    const char* stage = "attach.host-policy";
    try {
      if (source == SourceKind::Host) {
        host = BeginHostPolicy(state, hwnd);
        hostApplying = std::make_unique<ApplyingScope>(host->applying);
      }
      stage = "attach.create-compositor";
      surface->compositor = Compositor{};
      stage = source == SourceKind::Host ? "attach.create-host-backdrop-brush" : "attach.create-wallpaper-backdrop-brush";
      surface->brush = source == SourceKind::Host ? surface->compositor.CreateHostBackdropBrush()
        : surface->compositor.TryCreateBlurredWallpaperBackdropBrush();
      if (!surface->brush) {
        if (source == SourceKind::Host) throw std::runtime_error("Host backdrop brush unavailable");
        return Boolean(env, false);
      }
      stage = "attach.create-container-visual";
      surface->root = surface->compositor.CreateContainerVisual();
      stage = "attach.create-sprite-visual";
      surface->sprite = surface->compositor.CreateSpriteVisual();
      stage = "attach.sprite-relative-size";
      surface->sprite.RelativeSizeAdjustment({1.0f, 1.0f});
      stage = "attach.sprite-direct-backdrop-brush";
      surface->sprite.Brush(surface->brush);
      stage = "attach.insert-sprite";
      surface->root.Children().InsertAtBottom(surface->sprite);
      stage = "attach.resize-surface";
      ResizeSurface(*surface, hwnd);
      stage = "attach.glass-clip";
      if (const auto decoration = state.decorations.find(hwnd);
        decoration != state.decorations.end() && decoration->second->enabled)
        UpdateSurfaceClip(*surface, hwnd, true);

      stage = "attach.desktop-interop";
      auto interop = surface->compositor.as<ABI::Windows::UI::Composition::Desktop::ICompositorDesktopInterop>();
      stage = "attach.create-desktop-window-target";
      winrt::check_hresult(interop->CreateDesktopWindowTarget(hwnd, false,
        reinterpret_cast<ABI::Windows::UI::Composition::Desktop::IDesktopWindowTarget**>(winrt::put_abi(surface->target))));
      stage = "attach.set-target-root";
      surface->target.Root(surface->root);

      // Stage all resources and bookkeeping before changing the Electron/DWM
      // material. Any failure tears down the candidate and leaves fallback to JS.
      state.surfaces.emplace(hwnd, surface);
      stage = "attach.install-surface-subclass";
      winrt::check_bool(SetWindowSubclass(hwnd, SurfaceWindowProc,
        reinterpret_cast<UINT_PTR>(&state), reinterpret_cast<DWORD_PTR>(&state)) != FALSE);
      surface->subclassInstalled = true;
      if (host) {
        ValidateRecord(state, hwnd, state.hostPolicies, host);
        host->restoreBackdrop = true;
      }
      const DWORD none = DWMSBT_NONE;
      stage = "attach.disable-system-backdrop";
      winrt::check_hresult(DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, &none, sizeof(none)));
      if (host) {
        ValidateRecord(state, hwnd, state.hostPolicies, host);
        host->active = true;
      }
      const auto installed = state.surfaces.find(hwnd);
      if (installed == state.surfaces.end() || installed->second != surface)
        throw std::runtime_error("Composition window was destroyed during attachment");
    } catch (...) {
      const auto failure = std::current_exception();
      hostApplying.reset();
      const auto installed = state.surfaces.find(hwnd);
      if (installed != state.surfaces.end() && installed->second == surface) EraseSurface(state, hwnd, true);
      // Close any staged target before restoring its HWND's system material.
      surface.reset();
      if (source == SourceKind::Host && !RestoreHostPolicy(state, hwnd))
        throw std::runtime_error("Host attach rollback is busy; retry detach");
      NativeStage(stage, [&] { std::rethrow_exception(failure); });
    }
    return Boolean(env, true);
  });
}

napi_value Resize(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    const HWND hwnd = ReadHandle(env, info);
    auto& state = StateFor(env);
    const auto found = state.surfaces.find(hwnd);
    if (found == state.surfaces.end()) return Boolean(env, false);
    if (!IsWindow(hwnd)) { EraseSurface(state, hwnd, false); return Boolean(env, false); }
    return Boolean(env, ResizeSurface(*found->second, hwnd));
  });
}

napi_value Configure(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    size_t count = 3;
    napi_value args[3]{};
    CheckNapi(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    if (count != 2) throw ArgumentError("Expected HWND bigint and complete appearance settings");
    const HWND hwnd = ReadHandleValue(env, args[0]);
    auto appearance = ReadAppearance(env, args[1]);
    auto& state = StateFor(env);
    const auto found = state.surfaces.find(hwnd);
    if (found == state.surfaces.end()) return Boolean(env, false);
    ValidateOwnedWindow(hwnd, state);
    auto& surface = *found->second;
    if (surface.appearance == appearance) return Boolean(env, true);

    // HWND, target, root, raw wallpaper and focus all stay untouched. Build a
    // complete off-tree candidate before exposing it. Only the inexpensive
    // brush instance changes; the compiled factory is cached. Any synchronous
    // failure leaves the previous displayed material and settings untouched.
    if (appearance.IsRaw()) {
      if (!surface.appearance.IsRaw()) surface.sprite.Brush(surface.brush);
    } else {
      auto candidate = surface.material.factory
        ? Material::CreateInstance(surface.compositor, surface.material.factory, surface.brush, appearance)
        : Material::Create(surface.compositor, surface.brush, appearance);
      surface.sprite.Brush(candidate.brush);
      surface.material = std::move(candidate);
    }
    surface.appearance = std::move(appearance);
    return Boolean(env, true);
  });
}

napi_value Detach(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    const HWND hwnd = ReadHandle(env, info);
    return Boolean(env, DetachSurface(StateFor(env), hwnd));
  });
}

napi_value SetGlassDecoration(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    size_t count = 5;
    napi_value args[5]{};
    CheckNapi(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    if (count < 2 || count > 4) throw ArgumentError("Expected HWND bigint, glass decoration boolean, optional shadow and resizable booleans");
    const HWND hwnd = ReadHandleValue(env, args[0]);
    bool enabled = false;
    if (napi_get_value_bool(env, args[1], &enabled) != napi_ok)
      throw ArgumentError("Glass decoration enabled must be a boolean");
    bool shadowEnabled = false;
    if (count >= 3 && napi_get_value_bool(env, args[2], &shadowEnabled) != napi_ok)
      throw ArgumentError("Glass shadow enabled must be a boolean");
    if (!enabled && shadowEnabled) throw ArgumentError("Glass shadow requires an enabled glass decoration scope");
    std::optional<bool> resizable;
    if (count == 4) {
      bool value = false;
      if (napi_get_value_bool(env, args[3], &value) != napi_ok)
        throw ArgumentError("Glass resizable must be a boolean");
      resizable = value;
    }
    return Boolean(env, ApplyGlassDecoration(StateFor(env), hwnd, enabled, shadowEnabled, resizable));
  });
}

napi_value SetAcrylicBorderHidden(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    size_t count = 3;
    napi_value args[3]{};
    CheckNapi(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    if (count != 2) throw ArgumentError("Expected HWND bigint and Acrylic border boolean");
    const HWND hwnd = ReadHandleValue(env, args[0]);
    bool hidden = false;
    if (napi_get_value_bool(env, args[1], &hidden) != napi_ok)
      throw ArgumentError("Acrylic border hidden must be a boolean");
    return Boolean(env, ApplyAcrylicBorder(StateFor(env), hwnd, hidden));
  });
}

napi_value Clear(napi_env env, napi_callback_info) {
  return Guard(env, [&]() {
    auto& state = StateFor(env);
    ClearSurfaces(state);
    ClearWindowPolicies(state);
    napi_value undefined; CheckNapi(napi_get_undefined(env, &undefined)); return undefined;
  });
}

napi_value Inspect(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    const HWND hwnd = ReadHandle(env, info);
    auto& state = StateFor(env);
    napi_value result; CheckNapi(napi_create_object(env, &result));
    const auto found = state.surfaces.find(hwnd);
    SetBoolean(env, result, "attached", found != state.surfaces.end());
    SetNumber(env, result, "targetCount", static_cast<double>(state.surfaces.size()));
    const auto decoration = state.decorations.find(hwnd);
    SetBoolean(env, result, "glassDecoration", decoration != state.decorations.end() && decoration->second->enabled);
    SetNumber(env, result, "decorationCount", static_cast<double>(state.decorations.size()));
    SetNumber(env, result, "childResizeHookCount", static_cast<double>(state.resizeChildren.size()));
    const auto childCount = std::count_if(state.resizeChildren.begin(), state.resizeChildren.end(),
      [hwnd](const auto& entry) { return entry.second->parent == hwnd; });
    SetNumber(env, result, "windowChildResizeHookCount", static_cast<double>(childCount));
    // Read-only diagnostics distinguish bookkeeping from live HWND hooks.
    // Do not install/rebind children, refresh the frame, query hit handlers or
    // alter capture while inspecting a failed material transition.
    DWORD processId = 0;
    const bool ownedWindow = IsWindow(hwnd)
      && GetWindowThreadProcessId(hwnd, &processId) == state.threadId
      && processId == GetCurrentProcessId();
    const auto policy = decoration == state.decorations.end() ? nullptr : decoration->second;
    DWORD_PTR parentReference = 0;
    SetBoolean(env, result, "glassParentSubclassInstalled", ownedWindow
      && GetWindowSubclass(hwnd, DecorationWindowProc, reinterpret_cast<UINT_PTR>(&state), &parentReference)
      && parentReference == reinterpret_cast<DWORD_PTR>(&state));
    SetBoolean(env, result, "glassResizable", policy && policy->resizable);
    SetBoolean(env, result, "glassFrameRefreshPending", policy && policy->frameRefreshPending);
    SetNumber(env, result, "glassFrameStyleBits", ownedWindow ? ReadWindowStyle(hwnd) & kGlassStyleBits : 0);
    SetBoolean(env, result, "resizeCaptureActive", GetCapture() != nullptr);
    SetBoolean(env, result, "resizeWindowEnabled", ownedWindow && IsWindowEnabled(hwnd));
    SetBoolean(env, result, "resizeWindowIconic", ownedWindow && IsIconic(hwnd));
    SetBoolean(env, result, "resizeWindowZoomed", ownedWindow && IsZoomed(hwnd));
    struct ResizeDiagnostic {
      AddonState& state;
      HWND parent;
      std::shared_ptr<Decoration> policy;
      unsigned eligible = 0, hooked = 0, linked = 0, usable = 0;
    } diagnostic{state, hwnd, policy};
    if (ownedWindow) EnumChildWindows(hwnd, [](HWND child, LPARAM parameter) -> BOOL {
      auto& data = *reinterpret_cast<ResizeDiagnostic*>(parameter);
      if (!IsOwnedLegacyChild(data.state, child, data.parent)) return TRUE;
      ++data.eligible;
      DWORD_PTR reference = 0;
      const bool hooked = GetWindowSubclass(child, LegacyResizeWindowProc,
        reinterpret_cast<UINT_PTR>(&data.state), &reference)
        && reference == reinterpret_cast<DWORD_PTR>(&data.state);
      if (hooked) ++data.hooked;
      const auto found = data.state.resizeChildren.find(child);
      if (found == data.state.resizeChildren.end()) return TRUE;
      const auto& record = found->second;
      const auto linkedPolicy = record->decoration.lock();
      if (record->parent == data.parent && linkedPolicy && linkedPolicy == data.policy) ++data.linked;
      if (hooked && CanSupplementChild(data.state, child, record, linkedPolicy)) ++data.usable;
      return TRUE;
    }, reinterpret_cast<LPARAM>(&diagnostic));
    SetNumber(env, result, "resizeEligibleChildCount", diagnostic.eligible);
    SetNumber(env, result, "resizeHookedChildCount", diagnostic.hooked);
    SetNumber(env, result, "resizeLinkedChildCount", diagnostic.linked);
    SetNumber(env, result, "resizeUsableChildCount", diagnostic.usable);
    const auto host = state.hostPolicies.find(hwnd);
    SetBoolean(env, result, "hostBackdropOwned", host != state.hostPolicies.end());
    SetNumber(env, result, "hostPolicyCount", static_cast<double>(state.hostPolicies.size()));
    SetBoolean(env, result, "hostRestorePending", host != state.hostPolicies.end() && !host->second->active);
    if (host != state.hostPolicies.end()) {
      SetString(env, result, "hostBackdropOwnership", "application-controlled-false-true-false");
      SetBoolean(env, result, "hostBackdropBaselineEstablished", host->second->baselineEstablished);
      SetBoolean(env, result, "hostBackdropEnabledByApp", host->second->enabledByApp);
    }
    const auto border = state.acrylicBorders.find(hwnd);
    SetBoolean(env, result, "acrylicBorderHidden", border != state.acrylicBorders.end() && border->second->hidden);
    SetBoolean(env, result, "acrylicBorderPending", border != state.acrylicBorders.end() && border->second->pending);
    SetNumber(env, result, "acrylicBorderCount", static_cast<double>(state.acrylicBorders.size()));
    if (found != state.surfaces.end()) {
      SetNumber(env, result, "width", found->second->width);
      SetNumber(env, result, "height", found->second->height);
      SetNumber(env, result, "clipRadius", found->second->clipRadius);
      SetBoolean(env, result, "nativeForeground", GetForegroundWindow() == hwnd);
      const auto& appearance = found->second->appearance;
      SetString(env, result, "brushClass", appearance.IsRaw()
        ? "Windows.UI.Composition.CompositionBackdropBrush" : "Windows.UI.Composition.CompositionEffectBrush");
      SetString(env, result, "source", found->second->source == SourceKind::Host ? "windows-host-backdrop" : "windows-blurred-wallpaper");
      napi_value settings; CheckNapi(napi_create_object(env, &settings));
      SetString(env, settings, "tintColor", appearance.tintColor.c_str());
      SetNumber(env, settings, "tintOpacity", appearance.tintOpacity);
      SetNumber(env, settings, "luminosityOpacity", appearance.luminosityOpacity);
      SetNumber(env, settings, "saturation", appearance.saturation);
      CheckNapi(napi_set_named_property(env, result, "appearance", settings));
    }
    return result;
  });
}

napi_value StartWorkspaceFileDrag(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    size_t count = 3;
    napi_value args[3]{};
    CheckNapi(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    if (count != 2) throw ArgumentError("Expected HWND and absolute saved file path");
    const HWND hwnd = ReadHandleValue(env, args[0]);
    size_t length = 0;
    if (napi_get_value_string_utf16(env, args[1], nullptr, 0, &length) != napi_ok || length > 32767)
      throw ArgumentError("Expected absolute saved file path");
    std::vector<char16_t> text(length + 1);
    CheckNapi(napi_get_value_string_utf16(env, args[1], text.data(), text.size(), &length));
    static_assert(sizeof(wchar_t) == sizeof(char16_t));
    const std::wstring file(reinterpret_cast<const wchar_t*>(text.data()), length);
    if (!workspace_shell_drag::IsAbsoluteSavedPath(file)) throw ArgumentError("Expected absolute saved file path");
    ValidateOwnedWindow(hwnd, StateFor(env));
    const auto outcome = workspace_shell_drag::Start(hwnd, file.c_str());
    if (FAILED(outcome.status)) throw std::runtime_error("Windows Shell file drag failed");
    const char* effect = outcome.status == DRAGDROP_S_CANCEL ? "cancelled"
      : outcome.effect == DROPEFFECT_COPY ? "copy" : outcome.effect == DROPEFFECT_LINK ? "link" : "none";
    napi_value result;
    CheckNapi(napi_create_string_utf8(env, effect, NAPI_AUTO_LENGTH, &result));
    return result;
  });
}

constexpr napi_type_tag kUpdateLeaseTag{0xa8fc32b613f64992ULL, 0x9dc703d5a753b290ULL};
napi_value CloseUpdateExecutable(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    napi_value self; size_t count = 0; bool tagged = false;
    CheckNapi(napi_get_cb_info(env, info, &count, nullptr, &self, nullptr));
    CheckNapi(napi_check_object_type_tag(env, self, &kUpdateLeaseTag, &tagged));
    if (!tagged) throw ArgumentError("Invalid update executable lease");
    update_executable_pin::Lease* lease = nullptr;
    CheckNapi(napi_unwrap(env, self, reinterpret_cast<void**>(&lease)));
    lease->Close(); napi_value result; CheckNapi(napi_get_undefined(env, &result)); return result;
  });
}
napi_value PinUpdateExecutable(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    size_t count = 2, length = 0; napi_value args[2]{};
    CheckNapi(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    if (count != 1 || napi_get_value_string_utf16(env, args[0], nullptr, 0, &length) != napi_ok || length > 32760)
      throw ArgumentError("Expected absolute update executable path");
    std::vector<char16_t> text(length + 1);
    CheckNapi(napi_get_value_string_utf16(env, args[0], text.data(), text.size(), &length));
    auto lease = std::make_unique<update_executable_pin::Lease>(std::wstring(reinterpret_cast<const wchar_t*>(text.data()), length));
    napi_value result, bytes, close; CheckNapi(napi_create_object(env, &result));
    CheckNapi(napi_type_tag_object(env, result, &kUpdateLeaseTag));
    CheckNapi(napi_create_buffer_copy(env, lease->bytes.size(), lease->bytes.data(), nullptr, &bytes));
    CheckNapi(napi_set_named_property(env, result, "bytes", bytes));
    CheckNapi(napi_create_function(env, "close", NAPI_AUTO_LENGTH, CloseUpdateExecutable, nullptr, &close));
    CheckNapi(napi_set_named_property(env, result, "close", close));
    CheckNapi(napi_wrap(env, result, lease.get(), [](napi_env, void* data, void*) {
      delete static_cast<update_executable_pin::Lease*>(data);
    }, nullptr, nullptr));
    lease.release(); return result;
  });
}

napi_value Init(napi_env env, napi_value exports) {
  return Guard(env, [&]() {
    auto state = std::make_unique<AddonState>();
    CheckNapi(napi_set_instance_data(env, state.get(), Finalize, nullptr));
    state.release();
    const napi_property_descriptor descriptors[] = {
      {"getPhysicalRect", nullptr, GetPhysicalRect, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setPhysicalSize", nullptr, SetPhysicalSize, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"pinUpdateExecutable", nullptr, PinUpdateExecutable, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"startWorkspaceFileDrag", nullptr, StartWorkspaceFileDrag, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"attach", nullptr, Attach, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"resize", nullptr, Resize, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"configure", nullptr, Configure, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setGlassDecoration", nullptr, SetGlassDecoration, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setAcrylicBorderHidden", nullptr, SetAcrylicBorderHidden, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"detach", nullptr, Detach, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"clear", nullptr, Clear, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"state", nullptr, Inspect, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    CheckNapi(napi_define_properties(env, exports, std::size(descriptors), descriptors));
    return exports;
  });
}
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
