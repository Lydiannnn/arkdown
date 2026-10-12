$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Globalization;
public static class ArkdownWindowHitTest {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder name, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern IntPtr GetDpiAwarenessContextForProcess(IntPtr process);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW", SetLastError=true)] static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW", SetLastError=true)] static extern int GetWindowLong32(IntPtr hwnd, int index);
  [DllImport("kernel32.dll")] static extern void SetLastError(uint value);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetLayeredWindowAttributes(IntPtr hwnd, out uint colorKey, out byte alpha, out uint flags);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint Low, High; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);

  public static string HandleString(IntPtr hwnd) { return (IntPtr.Size == 8 ? unchecked((ulong)hwnd.ToInt64()) : unchecked((uint)hwnd.ToInt32())).ToString(CultureInfo.InvariantCulture); }
  public static bool ReadExtendedStyle(IntPtr hwnd, out long style) {
    SetLastError(0);
    style = IntPtr.Size == 8 ? GetWindowLongPtr64(hwnd, -20).ToInt64() : GetWindowLong32(hwnd, -20);
    return style != 0 || Marshal.GetLastWin32Error() == 0;
  }
  public static string CreationIdentity(uint pid) {
    IntPtr process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) return null;
    try {
      FILETIME creation, exit, kernel, user;
      if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) return null;
      ulong ticks = ((ulong)creation.High << 32) | creation.Low;
      return ticks == 0 ? null : ticks.ToString(CultureInfo.InvariantCulture);
    } finally { CloseHandle(process); }
  }
  // Pure policy: tests call this without enumerating or inspecting any real window.
  public static bool CandidateAllowed(bool exists, bool visible, bool iconic, bool cloakedKnown, int cloaked, bool shell,
      bool styleKnown, long style, bool alphaKnown, byte alpha, uint alphaFlags) {
    if (!exists || !visible || iconic || !cloakedKnown || cloaked != 0 || shell || !styleKnown) return false;
    const long rejectedStyles = 0x80L | 0x08000000L | 0x20L; // tool, noactivate, explicitly transparent
    if ((style & rejectedStyles) != 0) return false;
    // WS_EX_LAYERED alone is normal for many application windows, so never reject it alone.
    return (style & 0x80000L) == 0 || !alphaKnown || (alphaFlags & 2) == 0 || alpha != 0;
  }
  public static bool BoundsContain(RECT rect, int x, int y) {
    long width = (long)rect.Right - rect.Left, height = (long)rect.Bottom - rect.Top;
    return width > 0 && height > 0 && width <= 32768 && height <= 32768 &&
      rect.Left >= -1000000 && rect.Top >= -1000000 && rect.Right <= 1000000 && rect.Bottom <= 1000000 &&
      x >= rect.Left && x < rect.Right && y >= rect.Top && y < rect.Bottom;
  }
  public static bool LayeredPointAllowed(IntPtr hwnd, int x, int y) {
    if (x < short.MinValue || x > short.MaxValue || y < short.MinValue || y > short.MaxValue) return false;
    int packed = unchecked(((y & 0xffff) << 16) | (x & 0xffff));
    IntPtr result;
    if (SendMessageTimeout(hwnd, 0x84, IntPtr.Zero, new IntPtr(packed), 3, 50, out result) == IntPtr.Zero) return false;
    // HTERROR, HTTRANSPARENT and HTNOWHERE are not candidate content.
    return result.ToInt64() > 0;
  }
}
'@

function Initialize-DpiAwareness {
  try {
    $perMonitorV2 = [IntPtr](-4)
    if ([ArkdownWindowHitTest]::SetProcessDpiAwarenessContext($perMonitorV2)) { return $true }
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 5) { return $false }
    $current = [ArkdownWindowHitTest]::GetDpiAwarenessContextForProcess(
      [ArkdownWindowHitTest]::GetCurrentProcess()
    )
    if ($current -eq [IntPtr]::Zero) { return $false }
    return [ArkdownWindowHitTest]::AreDpiAwarenessContextsEqual($current, $perMonitorV2)
  } catch {
    return $false
  }
}

$script:DpiReady = Initialize-DpiAwareness

function Write-NullReply([long]$RequestId) {
  [Console]::Out.WriteLine((@{ requestId = $RequestId; hit = $null } | ConvertTo-Json -Compress))
}
function Get-ExactKeys($Value, [string[]]$Keys) {
  if ($null -eq $Value) { return $false }
  $actual = @($Value.PSObject.Properties.Name)
  if ($actual.Count -ne $Keys.Count) { return $false }
  foreach ($key in $Keys) { if ($actual -cnotcontains $key) { return $false } }
  return $true
}
function Is-SafeInteger($Value, [long]$Minimum, [long]$Maximum) {
  if ($Value -isnot [long] -and $Value -isnot [int]) { return $false }
  return $Value -ge $Minimum -and $Value -le $Maximum
}
function Test-Request($Request) {
  if (-not (Get-ExactKeys $Request @('requestId','x','y','excludedWindowHandles'))) { return $false }
  if (-not (Is-SafeInteger $Request.requestId 1 9007199254740991) -or -not (Is-SafeInteger $Request.x -1000000 1000000) -or -not (Is-SafeInteger $Request.y -1000000 1000000)) { return $false }
  $idsValue = $Request.PSObject.Properties['excludedWindowHandles'].Value
  if ($idsValue -isnot [System.Array]) { return $false }
  $ids = @($idsValue)
  if ($ids.Count -gt 256) { return $false }
  $seen = @{}
  foreach ($id in $ids) {
    [uint64]$parsedHandle = 0
    if ($id -isnot [string] -or $id -cnotmatch '^[1-9][0-9]{0,19}$' -or -not [uint64]::TryParse($id, [ref]$parsedHandle) -or $seen.ContainsKey($id)) { return $false }
    $seen[$id] = $true
  }
  return $true
}
function Get-RecoverableRequestId($Request) {
  if ($null -eq $Request) { return 0 }
  foreach ($property in $Request.PSObject.Properties) {
    if ($property.Name -ceq 'requestId' -and (Is-SafeInteger $property.Value 1 9007199254740991)) { return [long]$property.Value }
  }
  return 0
}
function Get-Hit($Request) {
  $point = [ArkdownWindowHitTest+POINT]::new(); $point.X = $Request.x; $point.Y = $Request.y
  # Walk top-level windows in Z order instead of trusting WindowFromPoint: the
  # fullscreen Arkdown selection overlays are deliberately excluded and must
  # not hide the underlying application from window selection.
  $root = [ArkdownWindowHitTest]::GetTopWindow([IntPtr]::Zero)
  $seen = [System.Collections.Generic.HashSet[string]]::new()
  $shell = [ArkdownWindowHitTest]::GetShellWindow()
  while ($root -ne [IntPtr]::Zero -and $seen.Count -lt 4096) {
    $handle = [ArkdownWindowHitTest]::HandleString($root)
    if (-not $seen.Add($handle)) { return $null }
    $hit = Get-Candidate $root $handle $point $Request $shell
    if ($null -ne $hit) { return $hit }
    $root = [ArkdownWindowHitTest]::GetWindow($root, 2)
  }
  return $null
}
function Get-Candidate([IntPtr]$root, [string]$handle, $point, $Request, [IntPtr]$shell) {
  if (@($Request.excludedWindowHandles) -contains $handle -or $root -eq $shell) { return $null }
  if (-not [ArkdownWindowHitTest]::IsWindow($root) -or -not [ArkdownWindowHitTest]::IsWindowVisible($root) -or [ArkdownWindowHitTest]::IsIconic($root)) { return $null }
  [long]$style = 0
  $styleKnown = [ArkdownWindowHitTest]::ReadExtendedStyle($root, [ref]$style)
  [int]$cloaked = 0
  $cloakedKnown = [ArkdownWindowHitTest]::DwmGetWindowAttribute($root, 14, [ref]$cloaked, 4) -eq 0
  $className = [System.Text.StringBuilder]::new(256)
  if ([ArkdownWindowHitTest]::GetClassName($root, $className, $className.Capacity) -le 0) { return $null }
  $isShellClass = @('Progman','WorkerW','Shell_TrayWnd','Shell_SecondaryTrayWnd','#32768','tooltips_class32') -contains $className.ToString()
  [byte]$alpha = 255; [uint32]$alphaFlags = 0; [uint32]$colorKey = 0; $alphaKnown = $false
  if (($style -band 0x80000) -ne 0) {
    $alphaKnown = [ArkdownWindowHitTest]::GetLayeredWindowAttributes($root, [ref]$colorKey, [ref]$alpha, [ref]$alphaFlags)
  }
  if (-not [ArkdownWindowHitTest]::CandidateAllowed($true, $true, $false, $cloakedKnown, $cloaked, $isShellClass, $styleKnown, $style, $alphaKnown, $alpha, $alphaFlags)) { return $null }
  $rect = [ArkdownWindowHitTest+RECT]::new()
  if ([ArkdownWindowHitTest]::DwmGetWindowAttribute($root, 9, [ref]$rect, [Runtime.InteropServices.Marshal]::SizeOf($rect)) -ne 0) {
    if (-not [ArkdownWindowHitTest]::GetWindowRect($root, [ref]$rect)) { return $null }
  }
  # Use the same physical visible rectangle for both point containment and returned crop bounds.
  if (-not [ArkdownWindowHitTest]::BoundsContain($rect, $point.X, $point.Y)) { return $null }
  if (($style -band 0x80000) -ne 0 -and -not [ArkdownWindowHitTest]::LayeredPointAllowed($root, $point.X, $point.Y)) { return $null }
  [uint32]$hitProcessId = 0
  [void][ArkdownWindowHitTest]::GetWindowThreadProcessId($root, [ref]$hitProcessId)
  if ($hitProcessId -eq 0) { return $null }
  $identity = [ArkdownWindowHitTest]::CreationIdentity($hitProcessId)
  if ([string]::IsNullOrEmpty($identity)) { return $null }
  # Normal destruction / ownership races fail closed; commit performs the same probe again.
  [uint32]$confirmedProcessId = 0
  [void][ArkdownWindowHitTest]::GetWindowThreadProcessId($root, [ref]$confirmedProcessId)
  if (-not [ArkdownWindowHitTest]::IsWindow($root) -or $confirmedProcessId -ne $hitProcessId) { return $null }
  return @{
    hwnd = $handle; processId = [long]$hitProcessId; processCreationIdentity = $identity
    boundsPx = @{ x = [long]$rect.Left; y = [long]$rect.Top; width = ([long]$rect.Right - $rect.Left); height = ([long]$rect.Bottom - $rect.Top) }
  }
}

while (($line = [Console]::In.ReadLine()) -ne $null) {
  $requestId = 0
  try {
    $request = $line | ConvertFrom-Json -ErrorAction Stop
    $requestId = Get-RecoverableRequestId $request
    if (-not (Test-Request $request)) { Write-NullReply $requestId; continue }
    $requestId = $request.requestId
    if (-not $script:DpiReady) { Write-NullReply $requestId; continue }
    $hit = Get-Hit $request
    [Console]::Out.WriteLine((@{ requestId = $requestId; hit = $hit } | ConvertTo-Json -Compress -Depth 4))
  } catch { Write-NullReply $requestId }
}
