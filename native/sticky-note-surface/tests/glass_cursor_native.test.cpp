// Compile the real subclass procedures in this translation unit. Only cursor
// coordinates are substituted: these tests never move the user's mouse.
#include <windows.h>
#include <cstdio>
#include <functional>
#include <stdexcept>
#include <node_api.h>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace {
POINT fixtureCursor{};
bool cursorPositionAvailable = true;
BOOL WINAPI FixtureGetCursorPos(LPPOINT point) {
  if (!cursorPositionAvailable) return FALSE;
  *point = fixtureCursor;
  return TRUE;
}
// Substitute only the N-API value transport for Inspect. Window ownership,
// subclass queries, child enumeration and capture remain real USER32 calls.
struct InspectValue {
  double number = 0;
  std::unordered_map<std::string, napi_value> properties;
};
std::vector<std::unique_ptr<InspectValue>> inspectValues;
void* inspectState = nullptr;
HWND inspectWindow = nullptr;
napi_value NewInspectValue(double number = 0) {
  auto value = std::make_unique<InspectValue>();
  value->number = number;
  const auto result = reinterpret_cast<napi_value>(value.get());
  inspectValues.push_back(std::move(value));
  return result;
}
napi_status FixtureGetInstanceData(napi_env, void** value) { *value = inspectState; return napi_ok; }
napi_status FixtureGetCbInfo(napi_env, napi_callback_info, size_t* count, napi_value* args, napi_value*, void**) {
  *count = 1; args[0] = NewInspectValue(); return napi_ok;
}
napi_status FixtureGetBigInt(napi_env, napi_value, uint64_t* value, bool* lossless) {
  *value = reinterpret_cast<uintptr_t>(inspectWindow); *lossless = true; return napi_ok;
}
napi_status FixtureCreateObject(napi_env, napi_value* value) { *value = NewInspectValue(); return napi_ok; }
napi_status FixtureGetBoolean(napi_env, bool value, napi_value* result) { *result = NewInspectValue(value); return napi_ok; }
napi_status FixtureCreateDouble(napi_env, double value, napi_value* result) { *result = NewInspectValue(value); return napi_ok; }
napi_status FixtureSetProperty(napi_env, napi_value object, const char* key, napi_value value) {
  reinterpret_cast<InspectValue*>(object)->properties[key] = value; return napi_ok;
}
}
#define GetCursorPos FixtureGetCursorPos
#define napi_get_instance_data FixtureGetInstanceData
#define napi_get_cb_info FixtureGetCbInfo
#define napi_get_value_bigint_uint64 FixtureGetBigInt
#define napi_create_object FixtureCreateObject
#define napi_get_boolean FixtureGetBoolean
#define napi_create_double FixtureCreateDouble
#define napi_set_named_property FixtureSetProperty
#include "../src/addon.cpp"
#undef GetCursorPos
#undef napi_get_instance_data
#undef napi_get_cb_info
#undef napi_get_value_bigint_uint64
#undef napi_create_object
#undef napi_get_boolean
#undef napi_create_double
#undef napi_set_named_property

namespace {
int assertions = 0;
void Check(bool value, const char* message) {
  ++assertions;
  if (!value) throw std::runtime_error(message);
}
double InspectNumber(AddonState& state, HWND hwnd, const char* key) {
  inspectValues.clear(); inspectState = &state; inspectWindow = hwnd;
  const auto result = Inspect(nullptr, nullptr);
  Check(result != nullptr, "native diagnostic snapshot succeeds");
  const auto& fields = reinterpret_cast<InspectValue*>(result)->properties;
  const auto found = fields.find(key);
  Check(found != fields.end(), key);
  return reinterpret_cast<InspectValue*>(found->second)->number;
}
struct BaseState {
  int hit = HTCLIENT;
  int cursorMessages = 0;
  int nonClientMoves = 0;
  int clientMoves = 0;
  int sizingCommands = 0;
  int frameChanges = 0;
  int activationMessages = 0;
  WPARAM sizingCommand = 0;
  std::function<void()> duringHit;
  std::function<void()> duringMove;
};
LRESULT CALLBACK FixtureWindowProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
  auto* base = reinterpret_cast<BaseState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
  if (message == WM_NCCREATE) {
    base = static_cast<BaseState*>(reinterpret_cast<CREATESTRUCTW*>(lparam)->lpCreateParams);
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(base));
  }
  if (base) {
    if (message == WM_WINDOWPOSCHANGING && lparam
      && (reinterpret_cast<WINDOWPOS*>(lparam)->flags & SWP_FRAMECHANGED)) ++base->frameChanges;
    if (message == WM_ACTIVATE) ++base->activationMessages;
    if (message == WM_SYSCOMMAND && (wparam & 0xfff0) == SC_SIZE) {
      ++base->sizingCommands;
      base->sizingCommand = wparam;
      return 0; // Observe real USER32 dispatch without entering its modal loop.
    }
    if (message == WM_NCHITTEST) {
      const auto hit = base->hit;
      auto action = std::move(base->duringHit);
      base->duringHit = {};
      if (action) action();
      return hit;
    }
    // Reproduce Chromium's consuming OnSetCursor and its subsequent Aura move
    // resetting the cursor. Merely handling WM_SETCURSOR must fail this test.
    if (message == WM_SETCURSOR) { ++base->cursorMessages; return 0; }
    if (message == WM_NCMOUSEMOVE) {
      ++base->nonClientMoves;
      SetCursor(LoadCursorW(nullptr, IDC_ARROW));
      auto action = std::move(base->duringMove);
      base->duringMove = {};
      if (action) action();
      return 73; // Verify the subclass preserves its downstream result.
    }
    if (message == WM_MOUSEMOVE) {
      ++base->clientMoves;
      SetCursor(LoadCursorW(nullptr, IDC_IBEAM));
      return 0;
    }
  }
  return DefWindowProcW(hwnd, message, wparam, lparam);
}
struct Fixture {
  AddonState state;
  BaseState parentBase, childBase;
  HWND parent = nullptr, child = nullptr;
  std::shared_ptr<Decoration> decoration = std::make_shared<Decoration>();
  Fixture(bool install = true) {
    parent = CreateWindowExW(0, L"ArkdownCursorTestParent", L"", WS_POPUP,
      100, 100, 400, 300, nullptr, nullptr, GetModuleHandleW(nullptr), &parentBase);
    Check(parent != nullptr, "create hidden parent");
    child = CreateWindowExW(0, L"Chrome_RenderWidgetHostHWND", L"", WS_CHILD,
      0, 0, 400, 300, parent, nullptr, GetModuleHandleW(nullptr), &childBase);
    Check(child != nullptr, "create hidden legacy child");
    if (!install) return;
    decoration->enabled = true;
    decoration->originalStyleBits = WS_THICKFRAME;
    decoration->resizable = true;
    state.decorations.emplace(parent, decoration);
    Check(SetWindowSubclass(parent, DecorationWindowProc, reinterpret_cast<UINT_PTR>(&state),
      reinterpret_cast<DWORD_PTR>(&state)) != FALSE, "install real parent subclass");
    InstallLegacyResizeChild(state, child, parent, decoration);
    Check(state.resizeChildren.contains(child), "install real child subclass");
  }
  ~Fixture() {
    if (GetCapture() == parent || GetCapture() == child) ReleaseCapture();
    if (IsWindow(parent)) DestroyWindow(parent);
    if (IsWindow(child)) DestroyWindow(child);
    cursorPositionAvailable = true;
  }
  LPARAM Point(int x, int y) {
    fixtureCursor = {x, y};
    Check(ClientToScreen(parent, &fixtureCursor) != FALSE, "convert fixture coordinates");
    return MAKELPARAM(fixtureCursor.x, fixtureCursor.y);
  }
  void RunFor(HWND target, BaseState& base) {
    struct Direction { int x, y, hit; LPCWSTR cursor; };
    const Direction directions[] = {
      {1, 100, HTLEFT, IDC_SIZEWE}, {398, 100, HTRIGHT, IDC_SIZEWE},
      {200, 298, HTBOTTOM, IDC_SIZENS}, {1, 298, HTBOTTOMLEFT, IDC_SIZENESW},
      {398, 298, HTBOTTOMRIGHT, IDC_SIZENWSE},
    };
    for (const auto& d : directions) {
      const auto point = Point(d.x, d.y);
      const auto expected = LoadCursorW(nullptr, d.cursor);
      SetCursor(expected);
      // Control: the exact downstream message being repaired really would
      // clobber the resize cursor, so an inert fixture cannot produce a pass.
      CallWindowProcW(FixtureWindowProc, target, WM_NCMOUSEMOVE, d.hit, point);
      Check(GetCursor() == LoadCursorW(nullptr, IDC_ARROW), "fixture reproduces downstream cursor overwrite");
      SetCursor(LoadCursorW(nullptr, IDC_ARROW));
      Check(SendMessageW(target, WM_NCHITTEST, 0, point) == d.hit, "real subclass resize hit");
      const int beforeCursor = base.cursorMessages, beforeMove = base.nonClientMoves;
      Check(SendMessageW(target, WM_SETCURSOR, reinterpret_cast<WPARAM>(target),
        MAKELPARAM(d.hit, WM_MOUSEMOVE)) == TRUE, "claims supplemental cursor");
      Check(GetCursor() == expected, "sets correct system cursor");
      Check(SendMessageW(target, WM_NCMOUSEMOVE, d.hit, point) == 73,
        "non-client move preserves downstream return value");
      Check(GetCursor() == expected, "non-client move must not overwrite resize cursor");
      Check(base.cursorMessages == beforeCursor && base.nonClientMoves == beforeMove + 1,
        "move reaches legacy procedure once for hover and leave processing");
      const int beforeSizing = parentBase.sizingCommands;
      SendMessageW(target, WM_NCLBUTTONDOWN, d.hit, point);
      Check(parentBase.sizingCommands == beforeSizing + 1, "resize press reaches parent USER32 sizing command");
      Check(parentBase.sizingCommand == static_cast<WPARAM>(SC_SIZE + d.hit - HTLEFT + 1),
        "resize press preserves the selected edge direction");
      Point(200, 100);
      SendMessageW(target, WM_SETCURSOR, reinterpret_cast<WPARAM>(target), MAKELPARAM(HTCLIENT, WM_MOUSEMOVE));
      SendMessageW(target, WM_MOUSEMOVE, 0, MAKELPARAM(200, 100));
      Check(GetCursor() == LoadCursorW(nullptr, IDC_IBEAM), "return to client keeps normal cursor handling");
    }
    const auto edge = Point(1, 100);
    auto expectForward = [&](UINT message, WPARAM wparam, LPARAM lparam, const char* reason) {
      const int previous = message == WM_SETCURSOR ? base.cursorMessages : base.nonClientMoves;
      SendMessageW(target, message, wparam, lparam);
      Check((message == WM_SETCURSOR ? base.cursorMessages : base.nonClientMoves) == previous + 1, reason);
    };
    expectForward(WM_SETCURSOR, reinterpret_cast<WPARAM>(target == parent ? child : parent),
      MAKELPARAM(HTLEFT, WM_MOUSEMOVE), "foreign cursor HWND passes through");
    expectForward(WM_SETCURSOR, reinterpret_cast<WPARAM>(target),
      MAKELPARAM(HTRIGHT, WM_MOUSEMOVE), "stale cursor hit passes through");
    expectForward(WM_NCMOUSEMOVE, HTRIGHT, edge, "stale move hit passes through");
    cursorPositionAvailable = false;
    expectForward(WM_SETCURSOR, reinterpret_cast<WPARAM>(target),
      MAKELPARAM(HTLEFT, WM_MOUSEMOVE), "cursor-position failure passes through");
    cursorPositionAvailable = true;
    SetCapture(target);
    Check(GetCapture() == target, "fixture acquires real capture");
    expectForward(WM_SETCURSOR, reinterpret_cast<WPARAM>(target),
      MAKELPARAM(HTLEFT, WM_MOUSEMOVE), "capture owns cursor");
    expectForward(WM_NCMOUSEMOVE, HTLEFT, edge, "capture owns non-client move");
    ReleaseCapture();
    for (const int hit : {HTTOP, HTTOPLEFT, HTTOPRIGHT, HTCAPTION, HTCLOSE, HTTRANSPARENT}) {
      base.hit = hit;
      expectForward(WM_SETCURSOR, reinterpret_cast<WPARAM>(target),
        MAKELPARAM(HTLEFT, WM_MOUSEMOVE), "native hit has cursor precedence");
      expectForward(WM_NCMOUSEMOVE, HTLEFT, edge, "native hit has move precedence");
    }
    base.hit = HTCLIENT;
    decoration->enabled = false;
    expectForward(WM_SETCURSOR, reinterpret_cast<WPARAM>(target), MAKELPARAM(HTLEFT, WM_MOUSEMOVE), "disabled glass cursor scope");
    expectForward(WM_NCMOUSEMOVE, HTLEFT, edge, "disabled glass move scope");
    decoration->enabled = true;
    decoration->resizable = false;
    expectForward(WM_SETCURSOR, reinterpret_cast<WPARAM>(target), MAKELPARAM(HTLEFT, WM_MOUSEMOVE), "non-resizable cursor scope");
    expectForward(WM_NCMOUSEMOVE, HTLEFT, edge, "non-resizable move scope");
    decoration->resizable = true;
    EnableWindow(parent, FALSE);
    expectForward(WM_SETCURSOR, reinterpret_cast<WPARAM>(target), MAKELPARAM(HTLEFT, WM_MOUSEMOVE), "disabled window cursor scope");
    expectForward(WM_NCMOUSEMOVE, HTLEFT, edge, "disabled window move scope");
    EnableWindow(parent, TRUE);
    base.duringHit = [&] { decoration->enabled = false; };
    expectForward(WM_SETCURSOR, reinterpret_cast<WPARAM>(target), MAKELPARAM(HTLEFT, WM_MOUSEMOVE), "reentrant scope change is respected");
    decoration->enabled = true;
    base.duringMove = [&] { decoration->enabled = false; };
    expectForward(WM_NCMOUSEMOVE, HTLEFT, edge, "move processes downstream reentrant scope change once");
    Check(GetCursor() == LoadCursorW(nullptr, IDC_ARROW), "does not restore resize after reentrant disable");
    decoration->enabled = true;
    base.duringMove = [&] { SetCapture(target); };
    expectForward(WM_NCMOUSEMOVE, HTLEFT, edge, "move processes downstream capture change once");
    Check(GetCapture() == target, "downstream capture is retained");
    Check(GetCursor() == LoadCursorW(nullptr, IDC_ARROW), "does not restore resize over newly captured input");
    ReleaseCapture();
  }
};
// Deliver real out-of-context accessibility events on their registering UI
// thread. The parent remains hidden, so no desktop focus or pointer is moved.
void PumpWindowEvents() {
  const auto deadline = GetTickCount64() + 100;
  do {
    MSG message{};
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
    MsgWaitForMultipleObjectsEx(0, nullptr, 5, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
  } while (GetTickCount64() < deadline);
}

void CheckLateRendererLifecycle() {
  Fixture f(false);
  Check(ApplyGlassDecoration(f.state, f.parent, true, false, true), "late-child fixture enters glass");
  f.decoration = f.state.decorations.at(f.parent);
  Check(DestroyWindow(f.child) != FALSE, "remove original renderer child");
  f.child = CreateWindowExW(WS_EX_NOPARENTNOTIFY, L"Chrome_RenderWidgetHostHWND", L"", WS_CHILD,
    0, 0, 400, 300, f.parent, nullptr, GetModuleHandleW(nullptr), &f.childBase);
  Check(f.child != nullptr, "create renderer without WM_PARENTNOTIFY after glass");
  PumpWindowEvents();
  const auto edge = f.Point(1, 100);
  std::printf("late renderer before assertions: eligible=%.0f hooked=%.0f usable=%.0f childHit=%lld parentHit=%lld\n",
    InspectNumber(f.state, f.parent, "resizeEligibleChildCount"),
    InspectNumber(f.state, f.parent, "resizeHookedChildCount"),
    InspectNumber(f.state, f.parent, "resizeUsableChildCount"),
    static_cast<long long>(SendMessageW(f.child, WM_NCHITTEST, 0, edge)),
    static_cast<long long>(SendMessageW(f.parent, WM_NCHITTEST, 0, edge)));
  Check(SendMessageW(f.child, WM_NCHITTEST, 0, edge) == HTLEFT,
    "late unnotified renderer receives glass edge hit without movement or reapplication");
  Check(InspectNumber(f.state, f.parent, "resizeUsableChildCount") == 1,
    "late unnotified renderer has a live usable subclass");
  f.RunFor(f.child, f.childBase);
}

void CheckRendererReparenting() {
  Fixture first(false), second(false), mica(false);
  Check(ApplyGlassDecoration(first.state, first.parent, true, false, true), "first note enters glass");
  Check(ApplyGlassDecoration(first.state, second.parent, true, false, true), "second note enters glass in same addon");
  first.decoration = first.state.decorations.at(first.parent);
  second.decoration = first.state.decorations.at(second.parent);
  PumpWindowEvents();
  const auto observer = first.state.resizeObserver;
  Check(observer && resizeObservers.size() == 1, "multiple notes share one scoped observer");
  const auto child = mica.child;
  Check(SetParent(child, first.parent) == mica.parent, "reparent existing Mica renderer into first note");
  PumpWindowEvents();
  Check(SendMessageW(child, WM_NCHITTEST, 0, first.Point(1, 100)) == HTLEFT,
    "existing renderer reparented into glass gains resize hit");
  Check(InspectNumber(first.state, first.parent, "resizeUsableChildCount") == 2,
    "reparented existing renderer receives usable subclass");
  first.RunFor(child, mica.childBase);
  Check(SetParent(child, second.parent) == first.parent, "transfer renderer between decorated notes");
  // Before event delivery, a stale parent association must already be inert.
  Check(SendMessageW(child, WM_NCHITTEST, 0, second.Point(1, 100)) == HTCLIENT,
    "old parent association never supplies resize to new parent");
  PumpWindowEvents();
  Check(InspectNumber(first.state, first.parent, "resizeUsableChildCount") == 1,
    "old note loses transferred renderer");
  Check(InspectNumber(first.state, second.parent, "resizeUsableChildCount") == 2,
    "new note owns transferred renderer subclass");
  second.RunFor(child, mica.childBase);
  Check(ApplyGlassDecoration(first.state, first.parent, false), "first note leaves glass");
  Check(first.state.resizeObserver == observer, "observer survives while another glass note exists");
  Check(SendMessageW(child, WM_NCHITTEST, 0, second.Point(1, 100)) == HTLEFT,
    "removing old decoration does not detach transferred child");
  Check(SetParent(child, mica.parent) == second.parent, "renderer returns to unrelated Mica parent");
  PumpWindowEvents();
  Check(!first.state.resizeChildren.contains(child) && !HasLegacyResizeSubclass(first.state, child),
    "leaving glass removes stale child record and real subclass");
  Check(SendMessageW(child, WM_NCHITTEST, 0, mica.Point(1, 100)) == HTCLIENT,
    "unrelated Mica renderer keeps native hit handling");
  Check(ApplyGlassDecoration(first.state, second.parent, false), "last glass note exits");
  Check(!first.state.resizeObserver && resizeObservers.empty() && observer->state == nullptr,
    "last decoration invalidates and unregisters observer");
  PumpWindowEvents();
}

void CheckRendererShowAndRepair() {
  Fixture f(false);
  Check(ApplyGlassDecoration(f.state, f.parent, true, false, true), "repair fixture enters glass");
  f.decoration = f.state.decorations.at(f.parent);
  PumpWindowEvents();
  Check(RemoveWindowSubclass(f.child, LegacyResizeWindowProc, reinterpret_cast<UINT_PTR>(&f.state)) != FALSE,
    "remove real child subclass while registry remains");
  Check(InspectNumber(f.state, f.parent, "resizeHookedChildCount") == 0, "inspection observes lost subclass");
  Check(f.state.resizeChildren.contains(f.child), "read-only inspection retains stale registry");
  const auto frameChanges = f.parentBase.frameChanges;
  const auto activationMessages = f.parentBase.activationMessages;
  const auto style = ReadWindowStyle(f.parent);
  const auto corner = ReadCorner(f.parent);
  const auto foreground = GetForegroundWindow();
  const auto focus = GetFocus();
  SetCapture(f.child);
  Check(GetCapture() == f.child, "capture established before lifecycle repair");
  ShowWindow(f.child, SW_SHOWNOACTIVATE); // Ancestor stays hidden.
  // USER32 suppresses SHOW accessibility notifications under a hidden ancestor.
  // Publish the same event through the real WinEvent queue without showing UI.
  NotifyWinEvent(EVENT_OBJECT_SHOW, f.child, OBJID_WINDOW, CHILDID_SELF);
  PumpWindowEvents();
  Check(f.parentBase.frameChanges == frameChanges && f.parentBase.activationMessages == activationMessages,
    "lifecycle repair does not refresh frame or activate note");
  Check(ReadWindowStyle(f.parent) == style && ReadCorner(f.parent) == corner,
    "lifecycle repair preserves frame style and corner policy");
  Check(GetForegroundWindow() == foreground && GetFocus() == focus && GetCapture() == f.child,
    "lifecycle repair preserves foreground, focus and capture");
  ReleaseCapture();
  Check(SendMessageW(f.child, WM_NCHITTEST, 0, f.Point(1, 100)) == HTLEFT,
    "queued SHOW repairs lost subclass despite surviving registry");
  Check(InspectNumber(f.state, f.parent, "resizeUsableChildCount") == 1, "SHOW restores usable hook");
  auto stale = f.state.decorations.at(f.parent);
  auto current = std::make_shared<Decoration>(*stale);
  f.state.decorations[f.parent] = current;
  f.decoration = current;
  Check(InspectNumber(f.state, f.parent, "resizeLinkedChildCount") == 0, "fixture has stale decoration link");
  ShowWindow(f.child, SW_HIDE);
  ShowWindow(f.child, SW_SHOWNOACTIVATE);
  NotifyWinEvent(EVENT_OBJECT_SHOW, f.child, OBJID_WINDOW, CHILDID_SELF);
  PumpWindowEvents();
  Check(InspectNumber(f.state, f.parent, "resizeLinkedChildCount") == 1,
    "SHOW rebinds stale decoration record");
  f.RunFor(f.child, f.childBase);
  // A queued create for an already destroyed HWND is only a wake-up. It must
  // not keep a dead record or block the replacement's real CREATE event.
  Check(DestroyWindow(f.child) != FALSE, "destroy hooked renderer");
  f.child = CreateWindowExW(WS_EX_NOPARENTNOTIFY, L"Chrome_RenderWidgetHostHWND", L"", WS_CHILD,
    0, 0, 400, 300, f.parent, nullptr, GetModuleHandleW(nullptr), &f.childBase);
  Check(f.child != nullptr, "create first replacement");
  Check(DestroyWindow(f.child) != FALSE, "destroy replacement before event delivery");
  f.child = CreateWindowExW(WS_EX_NOPARENTNOTIFY, L"Chrome_RenderWidgetHostHWND", L"", WS_CHILD,
    0, 0, 400, 300, f.parent, nullptr, GetModuleHandleW(nullptr), &f.childBase);
  Check(f.child != nullptr, "create final replacement");
  PumpWindowEvents();
  Check(f.state.resizeChildren.size() == 1, "queued destruction leaves only live replacement record");
  Check(SendMessageW(f.child, WM_NCHITTEST, 0, f.Point(1, 100)) == HTLEFT,
    "replacement receives live resize handling");
  for (int cycle = 0; cycle < 2; ++cycle) {
    Check(ApplyGlassDecoration(f.state, f.parent, false), "replacement returns to Mica");
    Check(!f.state.resizeObserver && resizeObservers.empty(), "Mica unregisters observer");
    Check(SendMessageW(f.child, WM_NCHITTEST, 0, f.Point(1, 100)) == HTCLIENT, "Mica has no supplemental child hit");
    Check(ApplyGlassDecoration(f.state, f.parent, true, false, true), "replacement returns to glass");
    Check(SendMessageW(f.child, WM_NCHITTEST, 0, f.Point(1, 100)) == HTLEFT, "glass re-entry installs existing child");
  }
}

void CheckObserverScopeAndTeardown() {
  Fixture f(false), unrelated(false);
  Check(ApplyGlassDecoration(f.state, f.parent, true, false, true), "observer scope fixture enters glass");
  PumpWindowEvents();
  const HWND foreignClass = CreateWindowExW(WS_EX_NOPARENTNOTIFY, L"ArkdownCursorTestParent", L"", WS_CHILD,
    0, 0, 400, 300, f.parent, nullptr, GetModuleHandleW(nullptr), &f.childBase);
  Check(foreignClass != nullptr, "create unrelated child class");
  Check(SetParent(unrelated.child, f.child) == unrelated.parent, "nest renderer below direct child");
  PumpWindowEvents();
  Check(!f.state.resizeChildren.contains(foreignClass) && !f.state.resizeChildren.contains(unrelated.child),
    "unrelated class and nested renderer are never hooked");
  Check(SetParent(unrelated.child, unrelated.parent) == f.child, "restore unrelated renderer parent");
  const auto observer = f.state.resizeObserver;
  const auto hook = observer->hook;
  Check(RemoveWindowSubclass(f.child, LegacyResizeWindowProc, reinterpret_cast<UINT_PTR>(&f.state)) != FALSE,
    "remove hook for event-filter checks");
  ResizeLifecycleEvent(hook, EVENT_OBJECT_SHOW, f.child, OBJID_CLIENT, CHILDID_SELF, f.state.threadId, 0);
  ResizeLifecycleEvent(hook, EVENT_OBJECT_SHOW, f.child, OBJID_WINDOW, 1, f.state.threadId, 0);
  ResizeLifecycleEvent(hook, EVENT_OBJECT_SHOW, f.child, OBJID_WINDOW, CHILDID_SELF, f.state.threadId + 1, 0);
  ResizeLifecycleEvent(hook, EVENT_OBJECT_FOCUS, f.child, OBJID_WINDOW, CHILDID_SELF, f.state.threadId, 0);
  Check(!HasLegacyResizeSubclass(f.state, f.child), "irrelevant object, child, thread and event cannot install hooks");
  NotifyWinEvent(EVENT_OBJECT_SHOW, f.child, OBJID_WINDOW, CHILDID_SELF);
  Check(ApplyGlassDecoration(f.state, f.parent, false), "exit glass with queued lifecycle callback and absent subclass");
  PumpWindowEvents();
  Check(!f.state.resizeObserver && resizeObservers.empty() && f.state.resizeChildren.empty(),
    "queued event cannot reinstall hooks after last decoration exits");
  Check(UnhookWinEvent(hook) == FALSE, "last-exit observer was really unhooked");
  Check(ApplyGlassDecoration(f.state, f.parent, true, false, true), "reenter glass before parent destruction");
  const auto destructionHook = f.state.resizeObserver->hook;
  NotifyWinEvent(EVENT_OBJECT_SHOW, f.child, OBJID_WINDOW, CHILDID_SELF);
  Check(DestroyWindow(f.parent) != FALSE, "destroy decorated parent with callback queued");
  PumpWindowEvents();
  Check(f.state.decorations.empty() && f.state.resizeChildren.empty() && !f.state.resizeObserver,
    "parent destruction clears all lifecycle ownership");
  Check(UnhookWinEvent(destructionHook) == FALSE, "parent destruction really unregisters observer");
  // Run the production environment finalizer with live windows and queued
  // accessibility events, then dispatch again after its state was deleted.
  auto* state = new AddonState;
  Check(ApplyGlassDecoration(*state, unrelated.parent, true, false, true), "teardown fixture enters glass");
  const auto teardownObserver = state->resizeObserver;
  const auto teardownHook = teardownObserver->hook;
  NotifyWinEvent(EVENT_OBJECT_SHOW, unrelated.child, OBJID_WINDOW, CHILDID_SELF);
  Finalize(nullptr, state, nullptr);
  Check(teardownObserver->state == nullptr && resizeObservers.empty(), "finalizer invalidates callback state before free");
  PumpWindowEvents();
  ResizeLifecycleEvent(teardownHook, EVENT_OBJECT_SHOW, unrelated.child, OBJID_WINDOW, CHILDID_SELF, GetCurrentThreadId(), 0);
  Check(SendMessageW(unrelated.child, WM_NCHITTEST, 0, unrelated.Point(1, 100)) == HTCLIENT,
    "queued callback after addon finalization cannot restore child hook");
  Check(UnhookWinEvent(teardownHook) == FALSE, "addon finalizer really unregisters observer");
}

struct RestoreCursor {
  HCURSOR previous = nullptr;
  RestoreCursor() {
    CURSORINFO info{sizeof(CURSORINFO)};
    previous = GetCursorInfo(&info) ? info.hCursor : GetCursor();
  }
  ~RestoreCursor() { SetCursor(previous); }
};
}

int main() {
  RestoreCursor restore;
  try {
    for (const auto* name : {L"ArkdownCursorTestParent", L"Chrome_RenderWidgetHostHWND"}) {
      WNDCLASSW type{};
      type.lpfnWndProc = FixtureWindowProc;
      type.hInstance = GetModuleHandleW(nullptr);
      type.lpszClassName = name;
      Check(RegisterClassW(&type) != 0, "register fixture window class");
    }
    {
      Fixture f;
      f.RunFor(f.child, f.childBase);
      f.RunFor(f.parent, f.parentBase);
      DestroyWindow(f.parent);
      Check(f.state.decorations.empty() && f.state.resizeChildren.empty(), "NCDESTROY clears both registries");
    }
    // Match a Mica-created window after Chromium's translucent size-constraint
    // update: app resizability remains true, but native WS_THICKFRAME is absent.
    // Use the real policy installation and real HWND hit/cursor procedures.
    for (const bool shadow : {false, true}) {
      Fixture f(false);
      const DWORD originalStyle = ReadWindowStyle(f.parent);
      Check(!(originalStyle & WS_THICKFRAME), "transition fixture has no native thick frame");
      for (int cycle = 0; cycle < 3; ++cycle) {
        Check(ApplyGlassDecoration(f.state, f.parent, true, shadow, true), "enter custom material after Mica");
        f.decoration = f.state.decorations.at(f.parent);
        Check(f.decoration->originalStyleBits == 0, "visual restoration snapshot stays exact");
        f.RunFor(f.child, f.childBase);
        f.RunFor(f.parent, f.parentBase);
        Check(ApplyGlassDecoration(f.state, f.parent, false), "return to Mica");
        Check(ReadWindowStyle(f.parent) == originalStyle, "transition preserves original frame style");
        Check(f.state.resizeChildren.empty(), "return to Mica removes child resize hooks");
        const auto edge = f.Point(1, 100);
        Check(SendMessageW(f.child, WM_NCHITTEST, 0, edge) == HTCLIENT, "Mica returns to native hit handling");
      }
    }
    for (bool child : {false, true}) {
      Fixture f;
      const auto target = child ? f.child : f.parent;
      auto& base = child ? f.childBase : f.parentBase;
      f.Point(1, 100);
      base.duringHit = [&] { DestroyWindow(target); };
      Check(SendMessageW(target, WM_SETCURSOR, reinterpret_cast<WPARAM>(target),
        MAKELPARAM(HTLEFT, WM_MOUSEMOVE)) == 0, "destruction during hit exits safely");
      Check(!IsWindow(target), "destroyed fixture is not resurrected");
    }
    for (bool child : {false, true}) {
      Fixture f;
      const auto target = child ? f.child : f.parent;
      auto& base = child ? f.childBase : f.parentBase;
      const auto point = f.Point(1, 100);
      base.duringMove = [&] { DestroyWindow(target); };
      Check(SendMessageW(target, WM_NCMOUSEMOVE, HTLEFT, point) == 73,
        "move destruction preserves downstream return without touching dead HWND");
      Check(!IsWindow(target), "move destruction is respected");
      Check(GetCursor() == LoadCursorW(nullptr, IDC_ARROW), "move destruction does not restore resize cursor");
    }
    {
      Fixture f(false);
      Check(ApplyGlassDecoration(f.state, f.parent, true, false, true), "diagnostic fixture enters glass");
      Check(InspectNumber(f.state, f.parent, "resizeEligibleChildCount") == 1, "diagnostics enumerate renderer child");
      Check(InspectNumber(f.state, f.parent, "resizeHookedChildCount") == 1, "diagnostics verify live child subclass");
      Check(InspectNumber(f.state, f.parent, "resizeLinkedChildCount") == 1, "diagnostics verify current decoration link");
      Check(InspectNumber(f.state, f.parent, "resizeUsableChildCount") == 1, "diagnostics verify usable resize child");
      Check(InspectNumber(f.state, f.parent, "glassResizable") == 1, "diagnostics retain app resize capability");
      Check(InspectNumber(f.state, f.parent, "glassParentSubclassInstalled") == 1, "diagnostics verify real parent subclass");
      Check(InspectNumber(f.state, f.parent, "glassFrameStyleBits") == 0, "diagnostics separate absent frame bits from resize capability");
      const auto currentDecoration = f.state.decorations.at(f.parent);
      currentDecoration->frameRefreshPending = true;
      Check(InspectNumber(f.state, f.parent, "glassFrameRefreshPending") == 1, "diagnostics observe unfinished frame refresh");
      Check(currentDecoration->frameRefreshPending, "inspection leaves pending refresh unchanged");
      currentDecoration->frameRefreshPending = false;
      EnableWindow(f.parent, FALSE);
      Check(InspectNumber(f.state, f.parent, "resizeWindowEnabled") == 0, "diagnostics observe disabled parent");
      Check(InspectNumber(f.state, f.parent, "resizeUsableChildCount") == 0, "diagnostics reject disabled parent");
      EnableWindow(f.parent, TRUE);
      BaseState missedBase;
      const auto missedChild = CreateWindowExW(WS_EX_NOPARENTNOTIFY, L"Chrome_RenderWidgetHostHWND", L"", WS_CHILD,
        0, 0, 400, 300, f.parent, nullptr, GetModuleHandleW(nullptr), &missedBase);
      Check(missedChild != nullptr, "create unnotified renderer child for diagnostic discrimination only");
      Check(InspectNumber(f.state, f.parent, "resizeEligibleChildCount") == 2, "diagnostics enumerate newly unhooked renderer child");
      Check(InspectNumber(f.state, f.parent, "resizeHookedChildCount") == 1, "diagnostics do not silently install missing hook");
      Check(f.state.resizeChildren.size() == 1, "inspection leaves native child registry unchanged");
      Check(DestroyWindow(missedChild) != FALSE, "destroy unnotified diagnostic child");
      Check(InspectNumber(f.state, f.parent, "resizeCaptureActive") == 0, "diagnostics report no capture");
      SetCapture(f.child);
      Check(InspectNumber(f.state, f.parent, "resizeCaptureActive") == 1, "diagnostics observe real thread capture");
      ReleaseCapture();
      Check(RemoveWindowSubclass(f.child, LegacyResizeWindowProc, reinterpret_cast<UINT_PTR>(&f.state)) != FALSE,
        "fixture simulates absent child hook with surviving registry record");
      Check(InspectNumber(f.state, f.parent, "resizeHookedChildCount") == 0, "diagnostics distinguish registry from actual subclass");
      const auto previous = f.state.decorations.at(f.parent);
      auto replacement = std::make_shared<Decoration>();
      replacement->enabled = true; replacement->resizable = true;
      f.state.decorations[f.parent] = replacement;
      Check(InspectNumber(f.state, f.parent, "resizeLinkedChildCount") == 0, "diagnostics distinguish stale weak decoration link");
      Check(InspectNumber(f.state, f.parent, "resizeUsableChildCount") == 0, "diagnostics reject stale decoration child");
      f.state.decorations[f.parent] = previous;
      Check(SetWindowSubclass(f.child, LegacyResizeWindowProc, reinterpret_cast<UINT_PTR>(&f.state),
        reinterpret_cast<DWORD_PTR>(&f.state)) != FALSE, "restore fixture child hook before normal cleanup");
      Check(ApplyGlassDecoration(f.state, f.parent, false), "diagnostic fixture exits glass");
      Check(InspectNumber(f.state, f.parent, "resizeEligibleChildCount") == 1, "Mica child remains visible to diagnostics");
      Check(InspectNumber(f.state, f.parent, "resizeHookedChildCount") == 0, "Mica child has no supplemental subclass");
      Check(InspectNumber(f.state, f.parent, "glassResizable") == 0, "Mica has no retained decoration capability");
    }
    CheckLateRendererLifecycle();
    CheckRendererReparenting();
    CheckRendererShowAndRepair();
    CheckObserverScopeAndTeardown();
    std::printf("glass cursor native: %d assertions passed (hidden HWNDs; no pointer movement)\n", assertions);
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "glass cursor native: %s (assertion %d)\n", error.what(), assertions);
  } catch (const winrt::hresult_error& error) {
    std::fprintf(stderr, "glass cursor native: HRESULT %ld %s (assertion %d)\n",
      static_cast<long>(error.code()), winrt::to_string(error.message()).c_str(), assertions);
  } catch (...) { std::fprintf(stderr, "glass cursor native: unexpected native exception\n"); }
  return 1;
}
