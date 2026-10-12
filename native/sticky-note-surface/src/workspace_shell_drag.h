#pragma once
#include <windows.h>
#include <objidl.h>
#include <string_view>

namespace workspace_shell_drag {
bool IsAbsoluteSavedPath(std::wstring_view path);
HRESULT CreateFileDataObject(const wchar_t* path, IDataObject** data);
struct Result { HRESULT status; DWORD effect; };
// The effect is advisory: returning from the loop is not a file-copy receipt.
Result Start(HWND owner, const wchar_t* path);
}
