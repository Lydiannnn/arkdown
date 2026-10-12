using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Arkdown.ScreenTranslation
{
    internal static class Native
    {
        [DllImport("user32.dll")] internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] internal static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(IntPtr hwnd);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
        [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
        [DllImport("user32.dll")] internal static extern bool ShowWindow(IntPtr hwnd, int command);
        [DllImport("dwmapi.dll")] internal static extern int DwmFlush();
        [DllImport("user32.dll")] internal static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        internal static void EnableDpi()
        {
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (EntryPointNotFoundException) { }
            SetProcessDPIAware();
        }
        internal static bool IsExcluded(IntPtr hwnd)
        {
            // Before Windows 10 2004, 0x11 behaves as WDA_MONITOR (black capture), not exclusion.
            Version windows = Environment.OSVersion.Version;
            if (windows.Major < 10 || (windows.Major == 10 && windows.Build < 19041)) return false;
            uint affinity;
            try { return GetWindowDisplayAffinity(hwnd, out affinity) && affinity == 0x11; }
            catch (EntryPointNotFoundException) { return false; }
        }
        internal static void ShowQuietly(Form form) { form.Show(); SetWindowPos(form.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0013); }
    }
    internal class ProtectedForm : Form
    {
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams
        {
            get { var parameters = base.CreateParams; parameters.ExStyle |= 0x08000000 | 0x80; return parameters; }
        }
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try { Native.SetWindowDisplayAffinity(Handle, 0x11); } catch (EntryPointNotFoundException) { }
        }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x21) { message.Result = new IntPtr(3); return; } // MA_NOACTIVATE
            base.WndProc(ref message);
        }
    }
}
