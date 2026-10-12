$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class ArkdownDisplayProbe {
  private const uint QDC_ONLY_ACTIVE_PATHS = 0x00000002;
  public const uint DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO = 9;

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct LUID { public uint LowPart; public int HighPart; }

  [StructLayout(LayoutKind.Sequential)]
  public struct DISPLAYCONFIG_RATIONAL { public uint Numerator; public uint Denominator; }

  [StructLayout(LayoutKind.Sequential)]
  public struct DISPLAYCONFIG_PATH_SOURCE_INFO {
    public LUID adapterId;
    public uint id;
    public uint modeInfoIdx;
    public uint statusFlags;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct DISPLAYCONFIG_PATH_TARGET_INFO {
    public LUID adapterId;
    public uint id;
    public uint modeInfoIdx;
    public uint outputTechnology;
    public uint rotation;
    public uint scaling;
    public DISPLAYCONFIG_RATIONAL refreshRate;
    public uint scanLineOrdering;
    [MarshalAs(UnmanagedType.Bool)] public bool targetAvailable;
    public uint statusFlags;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct DISPLAYCONFIG_PATH_INFO {
    public DISPLAYCONFIG_PATH_SOURCE_INFO sourceInfo;
    public DISPLAYCONFIG_PATH_TARGET_INFO targetInfo;
    public uint flags;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct DISPLAYCONFIG_DEVICE_INFO_HEADER {
    public uint type;
    public uint size;
    public LUID adapterId;
    public uint id;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO {
    public DISPLAYCONFIG_DEVICE_INFO_HEADER header;
    public uint value;
    public uint colorEncoding;
    public uint bitsPerColorChannel;
  }

  [DllImport("user32.dll")]
  public static extern IntPtr MonitorFromPoint(POINT point, uint flags);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  [DllImport("shcore.dll")]
  public static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);

  [DllImport("user32.dll")]
  private static extern int GetDisplayConfigBufferSizes(
    uint flags,
    out uint pathCount,
    out uint modeCount
  );

  [DllImport("user32.dll")]
  private static extern int QueryDisplayConfig(
    uint flags,
    ref uint pathCount,
    [Out] DISPLAYCONFIG_PATH_INFO[] paths,
    ref uint modeCount,
    IntPtr modes,
    IntPtr topologyId
  );

  [DllImport("user32.dll")]
  private static extern int DisplayConfigGetDeviceInfo(
    ref DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO request
  );

  public static int ProbeAdvancedColor() {
    for (int attempt = 0; attempt < 3; attempt++) {
      uint pathCount;
      uint modeCount;
      int result = GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, out pathCount, out modeCount);
      if (result != 0 || pathCount == 0 || pathCount > 4096 || modeCount > 16384) return -1;
      DISPLAYCONFIG_PATH_INFO[] paths = new DISPLAYCONFIG_PATH_INFO[pathCount];
      IntPtr modes = IntPtr.Zero;
      try {
        if (modeCount > 0) modes = Marshal.AllocHGlobal(checked((int)modeCount * 128));
        result = QueryDisplayConfig(
          QDC_ONLY_ACTIVE_PATHS,
          ref pathCount,
          paths,
          ref modeCount,
          modes,
          IntPtr.Zero
        );
        if (result == 122) continue;
        if (result != 0) return -1;
        bool enabled = false;
        for (int index = 0; index < pathCount; index++) {
          DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO info = new DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO();
          info.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO;
          info.header.size = (uint)Marshal.SizeOf(typeof(DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO));
          info.header.adapterId = paths[index].targetInfo.adapterId;
          info.header.id = paths[index].targetInfo.id;
          result = DisplayConfigGetDeviceInfo(ref info);
          if (result == 50 || result == 1168) continue;
          if (result != 0) return -1;
          if ((info.value & 0x00000002) != 0) enabled = true;
        }
        return enabled ? 1 : 0;
      } catch {
        return -1;
      } finally {
        if (modes != IntPtr.Zero) Marshal.FreeHGlobal(modes);
      }
    }
    return -1;
  }
}
'@

[void][ArkdownDisplayProbe]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type -AssemblyName System.Windows.Forms

$displays = @()
$primaryScale = $null
foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
  $point = [ArkdownDisplayProbe+POINT]::new()
  $point.X = [int]($screen.Bounds.Left + [Math]::Floor($screen.Bounds.Width / 2))
  $point.Y = [int]($screen.Bounds.Top + [Math]::Floor($screen.Bounds.Height / 2))
  $monitor = [ArkdownDisplayProbe]::MonitorFromPoint($point, 2)
  [uint32]$dpiX = 0
  [uint32]$dpiY = 0
  $dpiResult = [ArkdownDisplayProbe]::GetDpiForMonitor($monitor, 0, [ref]$dpiX, [ref]$dpiY)
  if ($dpiResult -ne 0 -or $dpiX -lt 48 -or $dpiX -gt 768) {
    throw "GetDpiForMonitor failed"
  }
  $scale = [Math]::Round(([double]$dpiX / 96.0), 4)
  if ($screen.Primary) { $primaryScale = $scale }
  $dip = {
    param([int]$value)
    [Math]::Round(([double]$value / $scale), 4)
  }
  $displays += [ordered]@{
    id = [string]$screen.DeviceName
    bounds = [ordered]@{
      x = & $dip $screen.Bounds.X
      y = & $dip $screen.Bounds.Y
      width = & $dip $screen.Bounds.Width
      height = & $dip $screen.Bounds.Height
    }
    workArea = [ordered]@{
      x = & $dip $screen.WorkingArea.X
      y = & $dip $screen.WorkingArea.Y
      width = & $dip $screen.WorkingArea.Width
      height = & $dip $screen.WorkingArea.Height
    }
    scaleFactor = $scale
  }
}

if ($null -eq $primaryScale -or $displays.Count -eq 0) {
  throw 'Primary display metadata unavailable'
}

$advancedColorProbe = [ArkdownDisplayProbe]::ProbeAdvancedColor()
$hdr = if ($advancedColorProbe -eq 1) {
  'exercised'
} elseif ($advancedColorProbe -eq 0) {
  'unavailable'
} else {
  'probe-error'
}

$affinityWindow = [System.Windows.Forms.Form]::new()
$affinityWindow.ShowInTaskbar = $false
$affinityWindow.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$affinityWindow.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$affinityWindow.Location = [System.Drawing.Point]::new(-32000, -32000)
$affinityWindow.Size = [System.Drawing.Size]::new(1, 1)
$affinityWindow.Opacity = 0
$protectedContent = 'unsupported'
try {
  $affinityWindow.Show()
  $affinity = [uint32]0
  $setAffinity = [ArkdownDisplayProbe]::SetWindowDisplayAffinity($affinityWindow.Handle, [uint32]0x00000011)
  $getAffinity = [ArkdownDisplayProbe]::GetWindowDisplayAffinity($affinityWindow.Handle, [ref]$affinity)
  $resetAffinity = [ArkdownDisplayProbe]::SetWindowDisplayAffinity($affinityWindow.Handle, [uint32]0)
  if ($setAffinity -and $getAffinity -and $resetAffinity -and $affinity -eq [uint32]0x00000011) {
    $protectedContent = 'exercised'
  }
} finally {
  $affinityWindow.Close()
  $affinityWindow.Dispose()
}

$result = [ordered]@{
  primaryScaleFactor = $primaryScale
  displays = $displays
  hdr = $hdr
  protectedContent = $protectedContent
}

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
ConvertTo-Json -InputObject $result -Depth 8 -Compress
