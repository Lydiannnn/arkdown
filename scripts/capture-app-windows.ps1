param(
  [Parameter(Mandatory = $true)]
  [string]$PackageRoot,
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'
$packageRootPath = [System.IO.Path]::GetFullPath($PackageRoot)
$packageExe = Join-Path $packageRootPath 'Arkdown.exe'
$imageDirectory = Join-Path $ProjectRoot 'user-guide\assets\images'
if (-not (Test-Path -LiteralPath $packageExe)) {
  throw "Arkdown.exe is missing: $packageExe"
}
New-Item -ItemType Directory -Path $imageDirectory -Force | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class ArkdownCaptureNative {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr deviceContext, uint flags);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@

[void][ArkdownCaptureNative]::SetProcessDpiAwarenessContext([IntPtr](-4))

function New-CaptureRuntime {
  $runtimeRoot = Join-Path $env:TEMP ('arkdown-guide-native-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $runtimeRoot | Out-Null
  $runtimeApplication = Join-Path $runtimeRoot 'Arkdown'
  Copy-Item -LiteralPath $packageRootPath -Destination $runtimeApplication -Recurse
  $portableData = Join-Path $runtimeApplication 'portable-data'
  if (Test-Path -LiteralPath $portableData) {
    Remove-Item -LiteralPath $portableData -Recurse -Force
  }
  return [PSCustomObject]@{
    Root = $runtimeRoot
    Application = $runtimeApplication
    Executable = (Join-Path $runtimeApplication 'Arkdown.exe')
  }
}

function Find-AppWindow {
  param([int]$ProcessId)

  for ($attempt = 0; $attempt -lt 80; $attempt++) {
    $script:captureWindow = [IntPtr]::Zero
    [ArkdownCaptureNative]::EnumWindows({
      param($handle, $lParam)
      if (-not [ArkdownCaptureNative]::IsWindowVisible($handle)) { return $true }
      $owner = [uint32]0
      [void][ArkdownCaptureNative]::GetWindowThreadProcessId($handle, [ref]$owner)
      if ($owner -eq $ProcessId) {
        $script:captureWindow = $handle
        return $false
      }
      return $true
    }, [IntPtr]::Zero) | Out-Null
    if ($script:captureWindow -ne [IntPtr]::Zero) {
      return $script:captureWindow
    }
    Start-Sleep -Milliseconds 125
  }
  throw "Arkdown window did not appear for process $ProcessId"
}

function Position-AppWindow {
  param([IntPtr]$Handle)
  [void][ArkdownCaptureNative]::SetWindowPos($Handle, [IntPtr](-1), 90, 60, 1360, 900, 0x0040)
  [void][ArkdownCaptureNative]::SetForegroundWindow($Handle)
  Start-Sleep -Milliseconds 500
}

function Click-ClientPoint {
  param([IntPtr]$Handle, [int]$X, [int]$Y)
  $point = New-Object ArkdownCaptureNative+POINT
  $point.X = $X
  $point.Y = $Y
  if (-not [ArkdownCaptureNative]::ClientToScreen($Handle, [ref]$point)) {
    throw 'Could not locate the Arkdown click target.'
  }
  [void][ArkdownCaptureNative]::SetForegroundWindow($Handle)
  [void][ArkdownCaptureNative]::SetCursorPos($point.X, $point.Y)
  [ArkdownCaptureNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [ArkdownCaptureNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function Render-WindowBitmap {
  param(
    [IntPtr]$Handle,
    [int]$MinimumWidth,
    [int]$MinimumHeight
  )

  $rect = New-Object ArkdownCaptureNative+RECT
  if (-not [ArkdownCaptureNative]::GetWindowRect($Handle, [ref]$rect)) {
    throw 'Could not read Arkdown window bounds.'
  }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt $MinimumWidth -or $height -lt $MinimumHeight) {
    throw "Arkdown capture is unexpectedly small: ${width}x${height}"
  }

  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::White)
  $deviceContext = $graphics.GetHdc()
  try {
    if (-not [ArkdownCaptureNative]::PrintWindow($Handle, $deviceContext, 2)) {
      throw 'Windows could not render the Arkdown window.'
    }
  } finally {
    $graphics.ReleaseHdc($deviceContext)
    $graphics.Dispose()
  }
  return $bitmap
}

function Save-FullWindow {
  param([IntPtr]$Handle, [string]$FileName)
  $bitmap = Render-WindowBitmap -Handle $Handle -MinimumWidth 900 -MinimumHeight 500
  try {
    $bitmap.Save((Join-Path $imageDirectory $FileName), [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $bitmap.Dispose()
  }
}

function Save-Sidebar {
  param([IntPtr]$Handle)
  $windowRect = New-Object ArkdownCaptureNative+RECT
  $client = New-Object ArkdownCaptureNative+RECT
  $origin = New-Object ArkdownCaptureNative+POINT
  if (-not [ArkdownCaptureNative]::GetWindowRect($Handle, [ref]$windowRect)) {
    throw 'Could not read the Arkdown window bounds.'
  }
  if (-not [ArkdownCaptureNative]::GetClientRect($Handle, [ref]$client)) {
    throw 'Could not read the Arkdown client bounds.'
  }
  if (-not [ArkdownCaptureNative]::ClientToScreen($Handle, [ref]$origin)) {
    throw 'Could not locate the Arkdown client area.'
  }

  $sourceX = $origin.X - $windowRect.Left
  $sourceY = ($origin.Y - $windowRect.Top) + 42
  $width = 260
  $height = ($client.Bottom - $client.Top) - 66
  $windowBitmap = Render-WindowBitmap -Handle $Handle -MinimumWidth 900 -MinimumHeight 500
  $sidebarBitmap = New-Object System.Drawing.Bitmap $width, $height
  $sidebarGraphics = [System.Drawing.Graphics]::FromImage($sidebarBitmap)
  try {
    $sourceRectangle = New-Object System.Drawing.Rectangle $sourceX, $sourceY, $width, $height
    $destinationRectangle = New-Object System.Drawing.Rectangle 0, 0, $width, $height
    $sidebarGraphics.DrawImage(
      $windowBitmap,
      $destinationRectangle,
      $sourceRectangle,
      [System.Drawing.GraphicsUnit]::Pixel
    )
    $sidebarBitmap.Save((Join-Path $imageDirectory 'file-tree.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $sidebarGraphics.Dispose()
    $sidebarBitmap.Dispose()
    $windowBitmap.Dispose()
  }
}

function Save-SaveStateMontage {
  $files = @('save-unsaved.png', 'save-saving.png', 'save-saved.png')
  $panelWidth = 920
  $panelHeight = 160
  $gap = 20
  $sourceWidth = 460
  $sourceHeight = 80
  $canvas = New-Object System.Drawing.Bitmap $panelWidth, (($panelHeight * 3) + ($gap * 2))
  $graphics = [System.Drawing.Graphics]::FromImage($canvas)
  $graphics.Clear([System.Drawing.Color]::White)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  try {
    for ($index = 0; $index -lt $files.Count; $index++) {
      $path = Join-Path $imageDirectory $files[$index]
      $capture = [System.Drawing.Image]::FromFile($path)
      try {
        $sourceRectangle = New-Object System.Drawing.Rectangle (
          $capture.Width - $sourceWidth
        ), ($capture.Height - $sourceHeight), $sourceWidth, $sourceHeight
        $destinationRectangle = New-Object System.Drawing.Rectangle (
          0
        ), ($index * ($panelHeight + $gap)), $panelWidth, $panelHeight
        $graphics.DrawImage(
          $capture,
          $destinationRectangle,
          $sourceRectangle,
          [System.Drawing.GraphicsUnit]::Pixel
        )
      } finally {
        $capture.Dispose()
      }
    }
    $canvas.Save((Join-Path $imageDirectory 'save-states.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $canvas.Dispose()
  }
  foreach ($file in $files) {
    Remove-Item -LiteralPath (Join-Path $imageDirectory $file) -Force -ErrorAction SilentlyContinue
  }
}

function Start-CaptureApp {
  param(
    [string]$Executable,
    [string]$RuntimeRoot,
    [string]$Workspace,
    [string]$SaveDelayMs = '0'
  )

  $oldAppData = $env:APPDATA
  $oldLocalAppData = $env:LOCALAPPDATA
  $oldE2e = $env:ARKDOWN_E2E
  $oldWorkspace = $env:ARKDOWN_E2E_WORKSPACE
  $oldSaveDelay = $env:ARKDOWN_E2E_SAVE_DELAY_MS
  try {
    $env:APPDATA = $RuntimeRoot
    $env:LOCALAPPDATA = $RuntimeRoot
    if ($Workspace) {
      $env:ARKDOWN_E2E = '1'
      $env:ARKDOWN_E2E_WORKSPACE = $Workspace
      if ($SaveDelayMs -ne '0') {
        $env:ARKDOWN_E2E_SAVE_DELAY_MS = $SaveDelayMs
      } else {
        Remove-Item Env:ARKDOWN_E2E_SAVE_DELAY_MS -ErrorAction SilentlyContinue
      }
    } else {
      Remove-Item Env:ARKDOWN_E2E -ErrorAction SilentlyContinue
      Remove-Item Env:ARKDOWN_E2E_WORKSPACE -ErrorAction SilentlyContinue
      Remove-Item Env:ARKDOWN_E2E_SAVE_DELAY_MS -ErrorAction SilentlyContinue
    }
    return Start-Process -FilePath $Executable -ArgumentList @(
      '--disable-gpu',
      ('--user-data-dir=' + (Join-Path $RuntimeRoot 'user-data'))
    ) -PassThru
  } finally {
    $env:APPDATA = $oldAppData
    $env:LOCALAPPDATA = $oldLocalAppData
    if ($null -eq $oldE2e) { Remove-Item Env:ARKDOWN_E2E -ErrorAction SilentlyContinue } else { $env:ARKDOWN_E2E = $oldE2e }
    if ($null -eq $oldWorkspace) { Remove-Item Env:ARKDOWN_E2E_WORKSPACE -ErrorAction SilentlyContinue } else { $env:ARKDOWN_E2E_WORKSPACE = $oldWorkspace }
    if ($null -eq $oldSaveDelay) { Remove-Item Env:ARKDOWN_E2E_SAVE_DELAY_MS -ErrorAction SilentlyContinue } else { $env:ARKDOWN_E2E_SAVE_DELAY_MS = $oldSaveDelay }
  }
}

function Stop-CaptureApp {
  param([System.Diagnostics.Process]$Process)
  if ($null -eq $Process) { return }
  [void][ArkdownCaptureNative]::PostMessage($script:captureWindow, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 600
  if (-not $Process.HasExited) {
    & taskkill.exe /PID $Process.Id /T /F | Out-Null
  }
}

$utf8 = [System.Text.UTF8Encoding]::new($false)
$welcomeMarkdown = @'
# 欢迎使用 Arkdown

这是一份用于说明书截图的示例文档，不包含任何个人信息。

## 今天的学习计划

- 认识即时渲染编辑
- 查看 Markdown 源码
- 观察自动保存状态

> Markdown 文件始终保存在你选择的工作区。

**提示：** 按 Ctrl+S 可以立即保存。

```text
Arkdown 让本地 Markdown 编辑保持简单。
```
'@

$notesMarkdown = @'
# 学习笔记

## Markdown 练习

- 使用 **强调文字**
- 添加 [参考链接](https://example.com)

> 这是一个不含个人信息的示例引用。

```markdown
# 标题示例
```
'@

$startRuntime = New-CaptureRuntime
$startProcess = $null
try {
  $startProcess = Start-CaptureApp -Executable $startRuntime.Executable -RuntimeRoot $startRuntime.Root -Workspace ''
  $startHandle = Find-AppWindow -ProcessId $startProcess.Id
  Position-AppWindow -Handle $startHandle
  Save-FullWindow -Handle $startHandle -FileName 'app-start.png'
} finally {
  Stop-CaptureApp -Process $startProcess
  if ($startRuntime.Root.StartsWith((Join-Path $env:TEMP 'arkdown-guide-native-'), [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $startRuntime.Root -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$workspaceParent = Join-Path $env:TEMP ('arkdown-guide-workspace-' + [guid]::NewGuid().ToString('N'))
$workspaceRoot = Join-Path $workspaceParent 'Arkdown 示例'
New-Item -ItemType Directory -Path (Join-Path $workspaceRoot '资料') -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $workspaceRoot '欢迎使用.md'), $welcomeMarkdown, $utf8)
[System.IO.File]::WriteAllText((Join-Path $workspaceRoot '学习笔记.md'), $notesMarkdown, $utf8)
[System.IO.File]::WriteAllText((Join-Path $workspaceRoot '资料\Markdown 示例.md'), "# Markdown 示例`r`n`r`n- 标题`r`n- 列表`r`n- 引用`r`n", $utf8)

$workspaceRuntime = New-CaptureRuntime
$workspaceProcess = $null
try {
  $workspaceProcess = Start-CaptureApp -Executable $workspaceRuntime.Executable -RuntimeRoot $workspaceRuntime.Root -Workspace $workspaceRoot -SaveDelayMs '5000'
  $workspaceHandle = Find-AppWindow -ProcessId $workspaceProcess.Id
  Position-AppWindow -Handle $workspaceHandle
  Start-Sleep -Seconds 2
  Save-FullWindow -Handle $workspaceHandle -FileName 'app-workspace.png'

  Click-ClientPoint -Handle $workspaceHandle -X 105 -Y 250
  Start-Sleep -Milliseconds 900
  Save-FullWindow -Handle $workspaceHandle -FileName 'visual-mode.png'

  Click-ClientPoint -Handle $workspaceHandle -X 90 -Y 200
  Start-Sleep -Milliseconds 700
  Save-Sidebar -Handle $workspaceHandle

  Click-ClientPoint -Handle $workspaceHandle -X 1280 -Y 75
  Start-Sleep -Milliseconds 700
  Save-FullWindow -Handle $workspaceHandle -FileName 'source-mode.png'

  Click-ClientPoint -Handle $workspaceHandle -X 720 -Y 400
  [System.Windows.Forms.SendKeys]::SendWait('^{END}')
  [System.Windows.Forms.SendKeys]::SendWait('x')
  Start-Sleep -Milliseconds 100
  Save-FullWindow -Handle $workspaceHandle -FileName 'save-unsaved.png'
  [System.Windows.Forms.SendKeys]::SendWait('^s')
  Start-Sleep -Milliseconds 200
  Save-FullWindow -Handle $workspaceHandle -FileName 'save-saving.png'
  Start-Sleep -Milliseconds 5000
  Save-FullWindow -Handle $workspaceHandle -FileName 'save-saved.png'
  Save-SaveStateMontage

  Click-ClientPoint -Handle $workspaceHandle -X 1280 -Y 75
  Start-Sleep -Milliseconds 700
  [System.IO.File]::WriteAllText((Join-Path $workspaceRoot '欢迎使用.md'), "# 来自其他程序的修改`r`n", $utf8)
  Click-ClientPoint -Handle $workspaceHandle -X 720 -Y 400
  [System.Windows.Forms.SendKeys]::SendWait('^{END}')
  [System.Windows.Forms.SendKeys]::SendWait(' Local edit')
  [System.Windows.Forms.SendKeys]::SendWait('^s')
  Start-Sleep -Milliseconds 5200
  Save-FullWindow -Handle $workspaceHandle -FileName 'save-conflict.png'
} finally {
  Stop-CaptureApp -Process $workspaceProcess
  if ($workspaceRuntime.Root.StartsWith((Join-Path $env:TEMP 'arkdown-guide-native-'), [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $workspaceRuntime.Root -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($workspaceParent.StartsWith((Join-Path $env:TEMP 'arkdown-guide-workspace-'), [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $workspaceParent -Recurse -Force -ErrorAction SilentlyContinue
  }
}
