# Screen translation protocol 1

UTF-8 without output BOM, one JSON object per newline. Input permits a leading UTF-8 BOM and CRLF. Maximum line length is 32,000,000 UTF-8 bytes; maximum serialized `result` is 2,000,000 bytes and 256 blocks. Invalid JSON/commands emit an `error` without leaking the rejected content. Oversized/invalid UTF-8 input terminates the session. An incomplete final record is discarded on EOF, then the session closes. Stdout is reserved for protocol data.

Start: `Arkdown.ScreenTranslation.exe --parent-pid <positive integer>`. No other arguments. Parent PID is optional only when no external window handles are registered. Parent liveness is checked every second. EOF, `close`, a broken stdout pipe, or parent exit disposes the controller, cancels pending requests, destroys both Forms and stops the timer/message loop. No shell execution is exposed.

## Host → helper

```json
{"type":"configure","backend":"baidu","target":"简体中文","triggerMode":"automatic","bounds":{"x":-1200,"y":80,"width":600,"height":280},"theme":{"background":"#f8f8f8","foreground":"#202020","accent":"#705bc4","border":"#b8b0c8"},"excludedWindowHandles":["123456"]}
{"type":"automatic","enabled":true}
{"type":"mode","mode":"hotkey"}
{"type":"once"}
{"type":"clear"}
{"type":"original","show":true}
{"type":"theme","theme":{"background":"#181818","foreground":"#eeeeee","accent":"#c3b0ed","border":"#504858"}}
{"type":"result","id":1,"result":{"blocks":[]}}
{"type":"result","id":2,"error":"Please configure the backend.","needsSettings":true}
{"type":"close"}
```

`configure` requires backend `baidu|model`, a target (1–64 characters, no newlines; `auto` is resolved by the host from the complete OCR text), and triggerMode `automatic|hotkey`. It always pauses. Optional `bounds` are the **captured content rectangle**, in physical screen pixels; the frame border/title are outside it. Width ≥80, height ≥40, at most 20 million pixels, x/y may be negative. The actual returned bounds are intersected with the virtual desktop. Omitted bounds retain the current geometry. Optional `fontPath` is an absolute font file path ≤20 MB; absent font/theme retain current appearance. Theme updates require all four `#RRGGBB` colors. `excludedWindowHandles` is at most 32 nonzero signed decimal HWND strings; omitted means none. The handles must belong to the supplied parent PID.

`automatic=true` selects automatic mode and starts checking immediately. `automatic=false` cancels work and preserves visible blocks. `mode` always pauses. `once` invalidates any earlier request and submits the current frame, independent of mode; it leaves the automatic setting unchanged. If the pixels match the successful baseline, `once` requests the whole frame while retaining valid visible translations during the request, failure or pause. Frame movement/resizing invalidates the baseline and in-flight work; while paused, the retained normalized layout follows the frame, while automatic movement clears it. `original` toggles visibility without discarding translations. `result` accepts either result or error, never both. A settings error stops automatic mode; other failures use backoff. Late/unknown result IDs are ignored.

## Helper → host

`clear` pauses automatic translation, cancels active and pending work, clears both the successful baseline and visible translated blocks, resets original-only display, and retains the selection frame geometry. Late translation responses and capture-encoding failures are ignored. A subsequent `once` can translate the same unchanged source again.

```json
{"type":"ready","protocol":1}
{"type":"request","id":1,"image":"<base64 PNG>","target":"简体中文","backend":"baidu"}
{"type":"cancel","id":1}
{"type":"state","automatic":false,"triggerMode":"automatic","busy":false,"showOriginal":false,"bounds":{"x":-1200,"y":80,"width":600,"height":280},"result":{"blocks":[]},"error":null,"status":"已暂停，拖动取景框后翻译。"}
{"type":"error","message":"Invalid screen translation command."}
```

Request IDs increase within the process, starting at 1 (maximum 2,147,483,647). Only one translation request is outstanding at a time. One frame may produce several sequential cropped requests. Each returned block is relative to that request's image. New automatic samples replace the pending frame without cancelling the active request; once it completes, stale output is discarded and only the newest pending frame runs. `cancel` means the host must abort the matching backend request; returning a late response is harmless. The helper completes the cancelled bridge task internally but keeps the LatestWork slot until its controller continuation releases it. Failed/cancelled work does not refill withdrawn visible blocks; a later successful partial result merges unchanged regions from the complete successful baseline, so a region that reverts to baseline content is not permanently omitted.

The host supplies blocks as `{box:[left,top,right,bottom],text,background?,foreground?}`. Coordinates must be numeric, finite, normalized 0–1000, with positive width/height. Text must be a string; empty/whitespace strings are skipped. Colors use `#RRGGBB`; missing/unusable colors get readable defaults. State always includes the currently retained complete-frame block positions, mapped back from exact integer crop bounds, and the physical capture bounds. State contains no screenshot or credentials. `error` is null on normal state, otherwise a user-facing failure; no extra needsSettings state field is introduced.
