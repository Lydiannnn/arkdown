# Native screen translation component

Independent .NET Framework 4.8 STA helper extracted from the ArkTranslate 1.3.0 handover. This component contains no old MainForm, tray, hotkey registration, backend client, credentials, settings persistence or model selection. Electron owns the control panel, backend services and keyboard shortcuts.

## Build and pure tests

From the repository root on Windows:

```text
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/build-screen-translation.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON native/screen-translation/tests/run-tests.ts
```

The exported `buildScreenTranslation({repoRoot?} = {})` returns the absolute executable path. It invokes the installed Framework64 `csc.exe` with argument arrays, the DPI/asInvoker manifest and a .NET 4.8 runtime configuration; no PowerShell Add-Type. Output is `.native-cache/screen-translation/Arkdown.ScreenTranslation.exe` plus `.exe.config`. Package both files. Launch with redirected pipes and `windowsHide: true`, passing `--parent-pid <Electron main PID>`.

The tests compile separate console entry points using the same source, then exercise bitmap algorithms, crop mapping, protocol parsing, cancellation and the real Controller with a fake surface and synchronization-context pump. They do **not** construct Forms, capture the desktop, start the production helper, or send images to a service.

## Source mechanism map

- `Core.cs`: ArkTranslate Core.cs layout, fingerprint, full-width changed bands and LatestWork; product settings and backend prompts removed. Layout coordinates now reject nonnumeric values.
- `ScreenFrame.cs`: Services.cs PNG encoding and crops, retaining integer pixel crop bounds for mapping.
- `Controller.cs`: MainForm.cs sampling/latest queue/retry control extracted into a window-independent controller. Both backends can use partial crops. Successful frame baseline and currently visible blocks are separate: failure/cancellation never refills visible blocks, while a later successful partial merge retains all baseline regions confirmed to match the new source, including regions that reverted to their baseline content.
- `Native.cs`, `Surface.cs`, `TranslationLayer.cs`: source window-affinity, nonactivating forms and color-keyed click-through overlay. The selection UI is a thin themed border/corners and crosshair title bar, with no product controls.
- `Protocol.cs`, `Program.cs`: bounded UTF-8 JSON-lines translation delegate and ApplicationContext. JSON is parsed on the background reader then dispatched to STA. All controller transitions and request completion/cancellation run there.

The original mechanisms were adapted from the local ArkTranslate handover, not a third-party downloaded package. The original CoreTests geometry/fingerprint/latest-work cases are retained under `tests/CoreTests.cs`; old backend/settings tests are intentionally outside this helper's boundary.

## Correctness and desktop limits

The tool and native caption are named **悬浮翻译窗**. The title uses the same red circular crosshair as the panel, and vertically centers its text. At the 150% acceptance baseline the old 132 × 23 physical-pixel drag header becomes 172 × 30 after a 30% increase (114.4 × 19.9333 CSS px before rounding), with a 4 CSS px corner radius. The lower-right grip is a painted 15 × 15 CSS px hit target, rounded to 23 × 23 physical pixels at 150%; painting the entire grip is necessary because color-key-transparent pixels would otherwise pass mouse input through before hit testing. Both metrics use the actual per-window DPI. No component engine binary is modified.

`clear` pauses, invalidates active/pending/encoding work and clears the baseline and visible layout while keeping frame bounds. It also resets original-only mode. Stale capture failures and translation results cannot refill the cleared state, and the same source can be translated again.

Startup and configure are paused. Mode changes pause; explicit automatic=true resumes. Every second the controller checks changes, with one active and one latest pending item. Automatic samples replace only pending work; the active request finishes normally and a stale response is discarded before the newest sample runs. Explicit invalidation (pause/mode/configuration/once/geometry) still cancels work, keeping the active LatestWork slot until its callback completes. A changed region is withdrawn before sending the request, failed/cancelled results never restore it, and only current successful results advance the baseline. Whole-frame manual refreshes with no changed pixels keep valid visible text during the request, failure and pause. Geometry/configuration changes invalidate the baseline; automatic geometry changes clear visible results, while paused geometry changes move/resize the retained normalized layout with the frame. Empty results are valid. The helper bounds selection to 20 million physical pixels, fingerprints at a maximum dimension of 1024 and sends PNGs at a maximum dimension of 2400. A complete work item times out after 90 seconds, then uses 5–60 second exponential retry delay.

Own HWND display affinity is applied on handle creation and queried each capture. External registered HWNDs must belong to `--parent-pid`; ownership and current affinity are checked each time. Only `0x11` on Windows build 19041+ is treated as exclusion. Otherwise visible module HWNDs are hidden, DwmFlush completes, the screenshot is taken, and all hidden windows are restored with SW_SHOWNA in finally. External affinity is never assumed or modified. Invalid/reused handles belonging to another process stop capture. Forms use WS_EX_NOACTIVATE; the translation layer also uses WS_EX_TRANSPARENT and color-key transparency.

Actual desktop behavior remains a separate integration check: mixed-DPI monitors/negative coordinates, click-through in other applications, foreground retention during move/resize, external Electron HWND affinity and fallback hiding, DWM capture, and production EOF/close/parent-exit cleanup must be tested with synthetic content in a serial native fixture. Pure tests and successful compilation do not establish these desktop outcomes.

See [protocol.md](protocol.md) for the exact transport boundary.
