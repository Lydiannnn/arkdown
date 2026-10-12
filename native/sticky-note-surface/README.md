# Native sticky-note wallpaper and host materials

This Windows x64 N-API module places an OS backdrop brush beneath the
transparent renderer. `attach(hwnd, source?)` creates the surface; `resize(hwnd)` resizes
it; `detach(hwnd)` and `clear()` release owned resources. Handles are lossless
unsigned bigints. Attachment requires a live window on the calling process and
thread. Source is exactly `wallpaper` or `host`; omission selects wallpaper.
Electron must initialize its Mica/Acrylic translucent window first. Mica and
the two glass presets use TryCreateBlurredWallpaperBackdropBrush; Acrylic uses
CreateHostBackdropBrush to sample behind the window. Same-source attachment
resizes the existing target. A source change releases the old target first.

Host attachment is an application-owned policy for product-created notes only.
USE_HOSTBACKDROPBRUSH (17) is a documented setter, not a supported getter. The
addon registers its record and destruction hook before a checked FALSE write
establishes the baseline; it then writes TRUE before creating the graph. Normal
detach, failed-attach rollback and clear restore FALSE. This does not preserve
an arbitrary pre-existing external Host flag. No Host getter/readback is used.
SYSTEMBACKDROP_TYPE (38) supports Get and Set: its actual value is still read
before mutation and restored on detach. Electron's preceding Acrylic bootstrap
does not replace this snapshot, because Electron logs DWM failures without
throwing. The system backdrop is disabled only after the target is ready.
Failed restoration retains each pending step and blocks replacement until
detach/clear retries successfully, including failure of the first FALSE write.
Wallpaper detach retains its existing graph-only behavior. WM_NCDESTROY only
drops records. State exposes source (`windows-host-backdrop` or
`windows-blurred-wallpaper`), hostBackdropOwned/hostPolicyCount/hostRestorePending.
Owned Host records also expose hostBackdropOwnership
(`application-controlled-false-true-false`), hostBackdropBaselineEstablished and
hostBackdropEnabledByApp. These describe successful application setters, not
an OS readback or a saved original Host value.

`setAcrylicBorderHidden(hwnd, hidden)` takes exactly bigint and boolean, validates
the same live process/thread ownership, and owns a separate border record.
True writes DWMWA_COLOR_NONE; false restores DWMWA_COLOR_DEFAULT (system default
behavior), not an alleged saved custom color. The controller only uses this
contract for product-created notes. The historical Acrylic API name also serves
shadow-enabled glass, where hiding the system border preserves the renderer's
configured inner glow. BORDER_COLOR Get is not required. Border state survives
graph fallback/detach and is restored when the selected material no longer requests it.
Activation/theme messages reassert a requested hidden border after the normal
window handler, including WM_ACTIVATE: Chromium's final Widget activation
callback makes Electron write the accent border after the nested WM_NCACTIVATE.
Failures remain pending for explicit retry. False for an
untracked handle is a no-op. State exposes acrylicBorderHidden, pending and count.
The border-color setter never changes style bits, corner preference, frame margins
or shadow. Acrylic independently retains the full-client policy below in both
border settings, so toggling its border cannot move the client area.

`setGlassDecoration(hwnd, enabled, shadowEnabled?, resizable?)` takes a lossless unsigned bigint,
a boolean, an optional boolean shadow selection (default false), and an optional
application resize capability. The controller supplies `BrowserWindow.isResizable()`:
Chromium can remove WS_THICKFRAME from a translucent Mica window after creation,
so a later material switch must not infer this capability from its frame snapshot.
Omitting the capability preserves the legacy initial-WS_THICKFRAME behavior.
The snapshot still controls exact visual restoration and is never rewritten to
add a resize frame. A true
shadow selection requires an enabled client-area scope. The exported name is
retained for ABI compatibility; this policy covers both glass presets and Acrylic.
Enabling requires a live HWND on the calling process and thread and does not
require an attached composition surface. It owns only WS_CAPTION and
WS_THICKFRAME plus the original DWM corner enum: glass without shadow clears those two
style bits and requests DWMWCP_DONOTROUND; glass with shadow restores them while
retaining its layout scope. Disabling restores only the saved bits
and corner enum, preserving current visibility, minimization and other dynamic
style bits. Disabling an untracked handle returns true. Repeated calls avoid
SWP_FRAMECHANGED when the owned bits already match, except that entering or
leaving the layout scope always refreshes the frame. Within that scope,
WM_NCCALCSIZE preserves the proposed full client rectangle after Chromium's
normal processing. Both glass shadow states and both Acrylic border settings use the same client
layout policy; minimized and maximized windows retain normal processing.
Selecting Mica or classic releases that policy before restoring the original frame.
Material attachment precedes initial scope application. A frame refresh explicitly
resizes the composition surface to the measured client rectangle, because Electron
may emit no resize event when only the client area changes.
Native failures throw and
retain the snapshot for retry; synchronous frame-refresh reentry returns false.

Decoration records and their WM_NCDESTROY hook are independent of composition
resources. `detach` leaves client-area and border policy independent.
`clear` releases graphs and attempts all live Host, border and glass restorations,
preserving failed records for a
retry; environment finalization attempts restoration and always removes hooks.
WM_NCDESTROY only drops bookkeeping and never applies decoration setters.

Custom wallpaper and Host SpriteVisuals use a CompositionRoundedRectangleGeometry clip
with radius 8 DIP, converted using GetDpiForWindow (12 physical px at 144 DPI).
The clip follows actual client size on resize and does not change HWND regions.
The full-client policy separately supplements side/bottom resize edges and bottom
corners on normal resizable windows, only after native HTCLIENT/HTNOWHERE results;
existing native/caption hit tests and control areas remain available.
Chromium's Legacy renderer child can bypass the parent's window procedure.
Only direct `Chrome_RenderWidgetHostHWND` children on the same process/UI thread
receive the corresponding edge hook. A real non-client press, whether delivered to the child or its parent, enters USER32's
parent sizing loop only when its hit matches an added edge; ordinary input keeps
Chromium's normal handling. Child replacement, scope release and destruction
remove these hooks. `childResizeHookCount` and `windowChildResizeHookCount` expose
their current ownership for diagnostics.
Both glass shadow states and both Acrylic border settings keep
the clip; leaving the custom-material client-area scope removes it. The addon
does not write NC rendering policy, frame margins or a whole-window region.
`state` retains the historical glassDecoration and decorationCount names for
client-area ownership independently of attachment;
an attached surface also exposes clipRadius in physical pixels (0 without clip).

`configure(hwnd, { tintColor, tintOpacity, luminosityOpacity, saturation })`
requires exactly those four own properties. `tintColor` is `#RRGGBB`; the three
numbers must be finite and within 0–1. Invalid arguments throw before any
composition change; a valid request for an unattached handle returns `false`.
Synchronous native errors throw while preserving the previous complete material.

The custom graph uses the selected OS source, followed by saturation,
luminosity blending and tint blending. The luminosity and tint sources share the
chosen RGB color. Native `CompositionColorBrush` alpha supplies each opacity
(rounded to 8-bit alpha). The initial graph uses the actual Color-then-Luminosity
blend enum order documented in Microsoft's material source, including its
historical enum-name inversion. It is a tunable custom wallpaper material,
not a claim of pixel identity with current standard Mica or Desktop Acrylic.
Acrylic's fixed starting recipe is #E9EEF2 / tint .30 / luminosity .65 /
saturation .90. The main controller scales only tint/luminosity coverage for
the three material transparency controls; the stored base and native four-field
contract stay unchanged. There is no new blur radius, raw-wallpaper pipeline,
window opacity, forced activation or WinAppSDK controller.

The factory is compiled on first use. Each update configures a lightweight new
brush instance off-tree using that cached factory. Native color brush properties
and the named saturation property are fully set before a single brush swap.
Failures preserve the previous material. The HWND, target, root and wallpaper
brush are retained. Opacities 0/0 and saturation 1 bypass the
graph and restore the original wallpaper brush. Each HWND has independent
resources. Source composition is never replaced on focus/activation; the only
activation hook reasserts the independent material border policy.

Primary references:

- [OS blurred wallpaper brush](https://learn.microsoft.com/en-us/uwp/api/windows.ui.composition.compositor.trycreateblurredwallpaperbackdropbrush?view=winrt-26100)
- [Host backdrop brush and system transparency/power policies](https://learn.microsoft.com/en-us/uwp/api/windows.ui.composition.compositor.createhostbackdropbrush?view=winrt-26100)
- [DWM Host backdrop and border attributes](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute)
- [Native effect descriptor interop](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.effects.interop/nn-windows-graphics-effects-interop-igraphicseffectd2d1interop)
- [Dynamic Composition effect properties](https://learn.microsoft.com/en-us/uwp/api/windows.ui.composition.compositioneffectbrush?view=winrt-26100)
- [Microsoft material luminosity/tint order and enum caveat](https://github.com/microsoft/microsoft-ui-xaml/blob/main/controls/dev/Materials/Acrylic/AcrylicBrush.cpp#L347)
- [Direct2D saturation](https://learn.microsoft.com/en-us/windows/win32/direct2d/saturation)
- [DWM corner preference enum](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwm_window_corner_preference)
- [Composition rounded rectangle geometry](https://learn.microsoft.com/en-us/uwp/api/windows.ui.composition.compositionroundedrectanglegeometry?view=winrt-26100)
- [Composition geometric clipping](https://learn.microsoft.com/en-us/uwp/api/windows.ui.composition.compositiongeometricclip?view=winrt-26100)

The descriptor implementation is local code using SDK interfaces and built-in
effect identifiers. It needs no Win2D or Windows App SDK runtime. `dxguid.lib`
provides effect GUID constants; it does not add a runtime DLL dependency.
Existing delay-load code attribution is preserved in `NOTICE`.

Build with `npm run build:sticky-note-native`. Run the real, window-free API
boundary tests with `node --test native/sticky-note-surface/tests/api.test.mjs`.
These tests validate arguments and absent-window behavior. Effect compilation,
live parameter changes, decoration restore, corner quality, physical mouse
resizing, visual quality and inactive persistence require the
separate isolated packaged Electron acceptance test.
Host support or an attached state alone does not prove inactive persistence or
background-window blur. Acceptance must establish actual foreground transitions
and corresponding blurred updates from an owned window behind inactive Acrylic.
