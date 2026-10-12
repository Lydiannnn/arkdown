param(
  [Parameter(Mandatory = $true)]
  [string]$SignalPath,
  [int]$Left = 120,
  [int]$Top = 120,
  [double]$ScaleFactor = 1.0,
  [Parameter(Mandatory = $true)]
  [string]$OcrEvidencePath,
  [ValidateSet('region', 'window')]
  [string]$OcrEvidenceKind = 'window',
  [switch]$OccupyShortcut
)

$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class ArkdownSourceWindowNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT rect, int size);

  [DllImport("dwmapi.dll")]
  public static extern int DwmFlush();

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint virtualKey);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool UnregisterHotKey(IntPtr hwnd, int id);
}
'@

[void][ArkdownSourceWindowNative]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()

$target = [System.Windows.Forms.Form]::new()
$target.Text = 'Arkdown Screenshot OCR Target'
$target.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$target.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedSingle
$target.MaximizeBox = $false
$target.MinimizeBox = $false
$target.TopMost = $true
$target.BackColor = [System.Drawing.Color]::White
$target.ClientSize = [System.Drawing.Size]::new(680, 300)

$heading = [System.Windows.Forms.Label]::new()
$heading.AutoSize = $false
$heading.Location = [System.Drawing.Point]::new(28, 34)
$heading.Size = [System.Drawing.Size]::new(620, 70)
$heading.Font = [System.Drawing.Font]::new('Segoe UI', 24, [System.Drawing.FontStyle]::Bold)
$heading.ForeColor = [System.Drawing.Color]::Black
$heading.Text = 'ARKDOWN OCR TARGET 8172'
$target.Controls.Add($heading)

$body = [System.Windows.Forms.Label]::new()
$body.AutoSize = $false
$body.Location = [System.Drawing.Point]::new(30, 132)
$body.Size = [System.Drawing.Size]::new(620, 130)
$body.Font = [System.Drawing.Font]::new('Segoe UI', 18, [System.Drawing.FontStyle]::Regular)
$body.ForeColor = [System.Drawing.Color]::FromArgb(28, 28, 28)
$body.Text = "Screenshot translation source line`r`nLOCAL OCR TEXT ONLY"
$target.Controls.Add($body)

$decoy = [System.Windows.Forms.Form]::new()
$decoy.Text = 'Adjacent Decoy'
$decoy.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$decoy.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedSingle
$decoy.MaximizeBox = $false
$decoy.MinimizeBox = $false
$decoy.TopMost = $true
$decoy.BackColor = [System.Drawing.Color]::FromArgb(255, 244, 244)
$decoy.ClientSize = [System.Drawing.Size]::new(330, 160)
$decoyLabel = [System.Windows.Forms.Label]::new()
$decoyLabel.AutoSize = $false
$decoyLabel.Dock = [System.Windows.Forms.DockStyle]::Fill
$decoyLabel.Font = [System.Drawing.Font]::new('Segoe UI', 18, [System.Drawing.FontStyle]::Bold)
$decoyLabel.ForeColor = [System.Drawing.Color]::DarkRed
$decoyLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$decoyLabel.Text = 'ADJACENT-DECOY-SECRET-9917'
$decoy.Controls.Add($decoyLabel)

$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 100
$timer.Add_Tick({
  if ([System.IO.File]::Exists($SignalPath)) {
    $timer.Stop()
    if ($OccupyShortcut) { [void][ArkdownSourceWindowNative]::UnregisterHotKey($target.Handle, 8172) }
    $decoy.Close()
    $target.Close()
  }
})

$target.Add_Shown({
  $physicalLeft = [int][Math]::Round($Left * $ScaleFactor)
  $physicalTop = [int][Math]::Round($Top * $ScaleFactor)
  [void][ArkdownSourceWindowNative]::SetWindowPos($target.Handle, [IntPtr](-1), $physicalLeft, $physicalTop, $target.Width, $target.Height, 0x0010)
  $targetRect = [ArkdownSourceWindowNative+RECT]::new()
  if ([ArkdownSourceWindowNative]::DwmGetWindowAttribute(
    $target.Handle,
    9,
    [ref]$targetRect,
    [Runtime.InteropServices.Marshal]::SizeOf($targetRect)
  ) -ne 0 -and -not [ArkdownSourceWindowNative]::GetWindowRect($target.Handle, [ref]$targetRect)) {
    throw 'Unable to read target window bounds'
  }
  [void][ArkdownSourceWindowNative]::SetWindowPos(
    $decoy.Handle,
    [IntPtr](-1),
    $targetRect.Right + [int][Math]::Round(28 * $ScaleFactor),
    $physicalTop + [int][Math]::Round(60 * $ScaleFactor),
    $decoy.Width,
    $decoy.Height,
    0x0010
  )
  $decoy.Show()
  $decoyRect = [ArkdownSourceWindowNative+RECT]::new()
  if ([ArkdownSourceWindowNative]::DwmGetWindowAttribute(
    $decoy.Handle,
    9,
    [ref]$decoyRect,
    [Runtime.InteropServices.Marshal]::SizeOf($decoyRect)
  ) -ne 0 -and -not [ArkdownSourceWindowNative]::GetWindowRect($decoy.Handle, [ref]$decoyRect)) {
    throw 'Unable to read decoy window bounds'
  }
  $hotkeyOccupied = $false
  if ($OccupyShortcut) {
    $hotkeyOccupied = [ArkdownSourceWindowNative]::RegisterHotKey($target.Handle, 8172, 0x0006, 0x51)
    if (-not $hotkeyOccupied) { throw 'Unable to occupy Ctrl+Shift+Q for fallback coverage' }
  }
  $target.Refresh()
  $decoy.Refresh()
  [System.Windows.Forms.Application]::DoEvents()
  if ([ArkdownSourceWindowNative]::DwmFlush() -ne 0) { throw 'Unable to flush source window composition' }
  $insetLeft = if ($OcrEvidenceKind -eq 'region') { [int][Math]::Round(12 * $ScaleFactor) } else { 0 }
  $insetTop = if ($OcrEvidenceKind -eq 'region') { [int][Math]::Round(30 * $ScaleFactor) } else { 0 }
  $insetRight = if ($OcrEvidenceKind -eq 'region') { [int][Math]::Round(12 * $ScaleFactor) } else { 0 }
  $insetBottom = if ($OcrEvidenceKind -eq 'region') { [int][Math]::Round(12 * $ScaleFactor) } else { 0 }
  $targetWidth = $targetRect.Right - $targetRect.Left
  $targetHeight = $targetRect.Bottom - $targetRect.Top
  $evidenceWidth = $targetWidth - $insetLeft - $insetRight
  $evidenceHeight = $targetHeight - $insetTop - $insetBottom
  if ($evidenceWidth -le 0 -or $evidenceHeight -le 0) { throw 'Invalid OCR evidence bounds' }
  $evidenceBitmap = [System.Drawing.Bitmap]::new($evidenceWidth, $evidenceHeight)
  $evidenceGraphics = [System.Drawing.Graphics]::FromImage($evidenceBitmap)
  try {
    $evidenceGraphics.CopyFromScreen(
      $targetRect.Left + $insetLeft,
      $targetRect.Top + $insetTop,
      0,
      0,
      [System.Drawing.Size]::new($evidenceWidth, $evidenceHeight),
      [System.Drawing.CopyPixelOperation]::SourceCopy
    )
    $evidenceBitmap.Save($OcrEvidencePath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $evidenceGraphics.Dispose()
    $evidenceBitmap.Dispose()
  }
  $timer.Start()
  $metadata = [ordered]@{
    pid = [int]$PID
    target = [ordered]@{
      hwnd = [int64]$target.Handle
      bounds = [ordered]@{
        x = [Math]::Round($targetRect.Left / $ScaleFactor, 4)
        y = [Math]::Round($targetRect.Top / $ScaleFactor, 4)
        width = [Math]::Round($targetWidth / $ScaleFactor, 4)
        height = [Math]::Round($targetHeight / $ScaleFactor, 4)
      }
    }
    decoy = [ordered]@{
      hwnd = [int64]$decoy.Handle
      bounds = [ordered]@{
        x = [Math]::Round($decoyRect.Left / $ScaleFactor, 4)
        y = [Math]::Round($decoyRect.Top / $ScaleFactor, 4)
        width = [Math]::Round(($decoyRect.Right - $decoyRect.Left) / $ScaleFactor, 4)
        height = [Math]::Round(($decoyRect.Bottom - $decoyRect.Top) / $ScaleFactor, 4)
      }
    }
    perMonitorDpiAware = $true
    hotkeyOccupied = $hotkeyOccupied
  }
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $metadata -Depth 6 -Compress))
  [Console]::Out.Flush()
})

[System.Windows.Forms.Application]::Run($target)
$timer.Dispose()
$decoy.Dispose()
$target.Dispose()
