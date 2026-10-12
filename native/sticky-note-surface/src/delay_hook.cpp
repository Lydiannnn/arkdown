#include <windows.h>
#include <delayimp.h>
#include <cstring>

// Adapted from @electron/node-gyp/src/win_delay_load_hook.cc; see NOTICE.
// Electron exports Node symbols from the host EXE. Redirect the delayed
// node.exe import to that image, including renamed packaged executables.
static FARPROC WINAPI SurfaceHostHook(unsigned int event, DelayLoadInfo* info) {
  if (event != dliNotePreLoadLibrary || _stricmp(info->szDll, "node.exe") != 0) return nullptr;
  return reinterpret_cast<FARPROC>(GetModuleHandleW(nullptr));
}
decltype(__pfnDliNotifyHook2) __pfnDliNotifyHook2 = SurfaceHostHook;
