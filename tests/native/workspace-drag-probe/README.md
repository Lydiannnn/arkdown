# Workspace drag probe (manual only)

This isolated probe preserves the **Electron `webContents.startDrag` baseline**. Production Windows drag now uses the Shell data-object adapter, so this probe does not validate that new path. It is not product code and is never started by Vitest, packaging or Arkdown. The user resumed desktop acceptance on 2026-10-04. See the 1.0.4 execution record for actual results and limitations.

After desktop testing resumes, launch the local Electron version explicitly from the repository root:

```powershell
& .\node_modules\electron\dist\electron.exe .\tests\native\workspace-drag-probe\main.cjs
```

It creates a unique `arkdown-drag-probe-*` temporary directory with synthetic MD, TXT and JSON sources, a same-volume destination, an isolated browser profile and `events.jsonl`. It never reads Arkdown user settings, keys, documents or network endpoints. All generated artifacts are retained; no delete, move or automatic cleanup operation exists.

1. Use the HTML rows for the current internal MIME baseline, then drag the native rows back into the observation area. Record whether Files and the custom MIME survive, modifier keys, event order and native return timing. This area is **not** a substitute for the real visual/source editor acceptance.
2. Use only unique synthetic targets. Test ordinary drag, Ctrl, Shift, Alt and Ctrl+Shift separately to the same-volume destination, a dedicated desktop folder and a real writable different-volume folder. Do not count a shortcut as a copy. No key combination may move the source. A different path or SUBST alias on the same volume does not prove cross-volume behavior.
3. Check source hashes after each operation; also inspect the destination file bytes or shortcut target. The source checkpoint alone does not prove a successful copy, nor does before/after hashing prove that the source was never transiently moved. Record cancellation, denied targets, same-name replace and skip separately.
4. Inspect `events.jsonl` for native begin/return versus drop/dragend ordering before designing a production drag-session adapter. Logs retain only synthetic source IDs; external paths/content are not recorded. `trusted` describes the DOM event, not a security authorization.
5. Exit normally and confirm the root and child processes have exited for at least 1200 ms before another native test. Retain the fixture and logs for review.

The approved rule permits Windows copy/link semantics: ordinary copy, Alt or Ctrl+Shift shortcut, never move the source. The Shell adapter offers only COPY and LINK and retains the original saved-file identity. Its noninteractive regression is `node tests/scripts/run-workspace-shell-drag-native.mjs`: real Shell data objects and destination negotiation, hidden HWNDs, no actual drop. Desktop copy/shortcut creation, same-directory Ctrl duplication, and existing editor/sticky-note imports still require native acceptance; neither this baseline probe nor drag admission alone proves those outcomes.
