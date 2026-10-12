param(
  [Parameter(Mandatory = $true)]
  [string]$PackageRoot,
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'
$packageRootPath = [System.IO.Path]::GetFullPath($PackageRoot)
$guideSource = Join-Path $ProjectRoot 'user-guide\dist'
$outputDirectory = Join-Path $ProjectRoot 'user-guide\assets\images'
$output = Join-Path $outputDirectory 'portable-folder.png'
$temporaryParent = Join-Path $env:TEMP ('arkdown-guide-portable-' + [guid]::NewGuid().ToString('N'))
$target = Join-Path $temporaryParent 'Arkdown'
$targetUri = ([System.Uri]$target).AbsoluteUri.TrimEnd('/')

if (-not (Test-Path -LiteralPath (Join-Path $packageRootPath 'Arkdown.exe'))) {
  throw "Packaged Arkdown.exe is missing: $packageRootPath"
}
if (-not (Test-Path -LiteralPath (Join-Path $guideSource '使用说明书.html'))) {
  throw "Built user guide is missing: $guideSource"
}
if (-not $temporaryParent.StartsWith((Join-Path $env:TEMP 'arkdown-guide-portable-'), [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Temporary capture directory is outside the expected location: $temporaryParent"
}

New-Item -ItemType Directory -Path $temporaryParent -Force | Out-Null
Copy-Item -LiteralPath $packageRootPath -Destination $target -Recurse
Copy-Item -LiteralPath (Join-Path $guideSource '使用说明书.html') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $guideSource '使用说明书') -Destination $target -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $target 'portable-data') -Force | Out-Null
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class ArkdownExplorerCapture {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    public static extern bool MoveWindow(
        IntPtr hWnd,
        int x,
        int y,
        int width,
        int height,
        bool repaint
    );

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr deviceContext, uint flags);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@

[void][ArkdownExplorerCapture]::SetProcessDpiAwarenessContext([IntPtr](-4))
$openedWindow = $null

try {
  Start-Process -FilePath 'explorer.exe' -ArgumentList @($target) | Out-Null
  $shell = New-Object -ComObject Shell.Application
  for ($attempt = 0; $attempt -lt 60 -and $null -eq $openedWindow; $attempt++) {
    Start-Sleep -Milliseconds 250
    foreach ($window in @($shell.Windows())) {
      if ([string]$window.LocationURL -and ([string]$window.LocationURL).TrimEnd('/') -eq $targetUri) {
        $openedWindow = $window
        break
      }
    }
  }

  if ($null -eq $openedWindow) {
    throw "Could not locate the sanitized Explorer window for $targetUri"
  }

  $windowHandle = [IntPtr]::new([int64]$openedWindow.HWND)
  [void][ArkdownExplorerCapture]::ShowWindow($windowHandle, 9)
  if (-not [ArkdownExplorerCapture]::MoveWindow($windowHandle, 70, 45, 1200, 760, $true)) {
    throw 'Could not position the sanitized Explorer window.'
  }
  $openedWindow.Document.CurrentViewMode = 1
  Start-Sleep -Milliseconds 800

  $rect = New-Object ArkdownExplorerCapture+RECT
  if (-not [ArkdownExplorerCapture]::GetWindowRect($windowHandle, [ref]$rect)) {
    throw 'Could not read the Explorer window bounds.'
  }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 700 -or $height -lt 400) {
    throw "Explorer capture is unexpectedly small: ${width}x${height}"
  }

  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $deviceContext = $graphics.GetHdc()
  try {
    if (-not [ArkdownExplorerCapture]::PrintWindow($windowHandle, $deviceContext, 2)) {
      throw 'Windows could not render the sanitized Explorer window.'
    }
  } finally {
    $graphics.ReleaseHdc($deviceContext)
    $graphics.Dispose()
  }
  $cropLeft = 360
  $croppedBitmap = New-Object System.Drawing.Bitmap ($width - $cropLeft), $height
  $croppedGraphics = [System.Drawing.Graphics]::FromImage($croppedBitmap)
  try {
    $sourceRectangle = New-Object System.Drawing.Rectangle $cropLeft, 0, ($width - $cropLeft), $height
    $destinationRectangle = New-Object System.Drawing.Rectangle 0, 0, ($width - $cropLeft), $height
    $croppedGraphics.DrawImage($bitmap, $destinationRectangle, $sourceRectangle, [System.Drawing.GraphicsUnit]::Pixel)
    $croppedBitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $croppedGraphics.Dispose()
    $croppedBitmap.Dispose()
    $bitmap.Dispose()
  }
} finally {
  if ($null -ne $openedWindow) {
    $openedWindow.Quit()
    Start-Sleep -Milliseconds 500
  }
  if ($temporaryParent.StartsWith((Join-Path $env:TEMP 'arkdown-guide-portable-'), [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $temporaryParent -Recurse -Force -ErrorAction SilentlyContinue
  }
}
