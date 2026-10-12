param(
  [string]$InputPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$script:MaxPixels = 25000000L
$script:MaxDimension = 32768
$script:MaxBlocks = 4096
$script:MaxWords = 32768
$script:MaxBlockText = 8192
$script:MaxTotalText = 200000
$script:Phase = 'decode'

function Initialize-ArkdownOcrWinRt {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.IBuffer, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
  [Windows.Foundation.IAsyncAction, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.ExifOrientationMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.ColorManagementMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.PixelDataProvider, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrLine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrWord, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
  [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
}

function Write-BridgeResult($Value) {
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 8))
}

function Write-BridgeError([string]$Code) {
  Write-BridgeResult ([ordered]@{ status = 'error'; code = $Code })
}

function Await-WinRt($Operation, [Type]$ResultType = $null) {
  if ($null -eq $ResultType) {
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
      Where-Object { $_.Name -ceq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -ceq 'IAsyncAction' } |
      Select-Object -First 1
    if ($null -eq $method) { throw 'WinRT await unavailable' }
    return $method.Invoke($null, @($Operation)).GetAwaiter().GetResult()
  }
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -ceq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -ceq 'IAsyncOperation`1' } |
    Select-Object -First 1
  if ($null -eq $method) { throw 'WinRT await unavailable' }
  return $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation)).GetAwaiter().GetResult()
}

function Await-WinRtAction($Operation) {
  $null = Await-WinRt $Operation
}

function Convert-Text([string]$Text, [int]$Limit) {
  if ($null -eq $Text) { throw 'Invalid text' }
  $normalized = $Text.Normalize([Text.NormalizationForm]::FormC)
  if ($normalized.Length -eq 0 -or $normalized.Length -gt $Limit -or $normalized.Contains([char]0)) { throw 'Invalid text' }
  for ($index = 0; $index -lt $normalized.Length; $index++) {
    $code = [int]$normalized[$index]
    if ($code -lt 32 -or ($code -ge 127 -and $code -le 159)) { throw 'Invalid text' }
    if ($code -ge 0xD800 -and $code -le 0xDBFF) {
      if ($index + 1 -ge $normalized.Length) { throw 'Invalid text' }
      $next = [int]$normalized[$index + 1]
      if ($next -lt 0xDC00 -or $next -gt 0xDFFF) { throw 'Invalid text' }
      $index++
    } elseif ($code -ge 0xDC00 -and $code -le 0xDFFF) { throw 'Invalid text' }
  }
  return $normalized
}

function Convert-Rectangle($Rectangle, [double]$ScaleX, [double]$ScaleY, [int]$Width, [int]$Height) {
  $left = [Math]::Max(0, [Math]::Min($Width, [Math]::Floor([double]$Rectangle.X * $ScaleX)))
  $top = [Math]::Max(0, [Math]::Min($Height, [Math]::Floor([double]$Rectangle.Y * $ScaleY)))
  $right = [Math]::Max(0, [Math]::Min($Width, [Math]::Ceiling(([double]$Rectangle.X + [double]$Rectangle.Width) * $ScaleX)))
  $bottom = [Math]::Max(0, [Math]::Min($Height, [Math]::Ceiling(([double]$Rectangle.Y + [double]$Rectangle.Height) * $ScaleY)))
  if ($right -le $left -or $bottom -le $top) { throw 'Invalid OCR rectangle' }
  return [ordered]@{ x = [int]$left; y = [int]$top; width = [int]($right - $left); height = [int]($bottom - $top) }
}

function Invoke-ArkdownWindowsOcr([string]$Path) {
  $script:Phase = 'decode'
  $stream = $null
  $bitmap = $null
  try {
    Initialize-ArkdownOcrWinRt
    $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
  $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $width = [int64]$decoder.PixelWidth
  $height = [int64]$decoder.PixelHeight
  if ($width -le 0 -or $height -le 0 -or $width -gt $script:MaxDimension -or $height -gt $script:MaxDimension -or $width * $height -gt $script:MaxPixels) { throw 'Image bounds' }

  $script:Phase = 'language'
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) { Write-BridgeError 'language-unavailable'; return }

  $script:Phase = 'ocr'
  $maxOcrDimension = [double][Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  $dimensionScale = $maxOcrDimension / [Math]::Max($width, $height)
  $pixelScale = [Math]::Sqrt($script:MaxPixels / [double]($width * $height))
  $scale = [Math]::Min(1.0, [Math]::Min($dimensionScale, $pixelScale))
  $scaledWidth = [Math]::Max(1, [int][Math]::Floor($width * $scale))
  $scaledHeight = [Math]::Max(1, [int][Math]::Floor($height * $scale))
  while ($scaledWidth -gt $maxOcrDimension -or $scaledHeight -gt $maxOcrDimension -or [int64]$scaledWidth * [int64]$scaledHeight -gt $script:MaxPixels) {
    if ($scaledWidth -ge $scaledHeight) { $scaledWidth-- } else { $scaledHeight-- }
  }

  $transform = [Windows.Graphics.Imaging.BitmapTransform]::new()
  $transform.ScaledWidth = [uint32]$scaledWidth
  $transform.ScaledHeight = [uint32]$scaledHeight
  $provider = Await-WinRt ($decoder.GetPixelDataAsync(
    [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
    [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
    $transform,
    [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
    [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage
  )) ([Windows.Graphics.Imaging.PixelDataProvider])
  [byte[]]$pixels = $provider.DetachPixelData()
  $stream.Dispose()
  $stream = $null
  $buffer = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($pixels)
  $bitmap = [Windows.Graphics.Imaging.SoftwareBitmap]::CreateCopyFromBuffer(
    $buffer,
    [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
    $scaledWidth,
    $scaledHeight,
    [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied
  )
  $ocr = Await-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $language = Convert-Text $engine.RecognizerLanguage.LanguageTag 64
  $scaleX = $width / [double]$scaledWidth
  $scaleY = $height / [double]$scaledHeight
  $blocks = [System.Collections.Generic.List[object]]::new()
  $blockIndex = 0
  $wordCount = 0
  $totalText = 0
  foreach ($line in $ocr.Lines) {
    $blockIndex++
    if ($blockIndex -gt $script:MaxBlocks) { throw 'Output limit' }
    $lineText = Convert-Text $line.Text $script:MaxBlockText
    $totalText += $lineText.Length
    $words = [System.Collections.Generic.List[object]]::new()
    $left = [int]::MaxValue; $top = [int]::MaxValue; $right = 0; $bottom = 0
    foreach ($word in $line.Words) {
      $wordCount++
      if ($wordCount -gt $script:MaxWords) { throw 'Output limit' }
      $wordText = Convert-Text $word.Text $script:MaxTotalText
      $totalText += $wordText.Length
      if ($totalText -gt $script:MaxTotalText) { throw 'Output limit' }
      $rect = Convert-Rectangle $word.BoundingRect $scaleX $scaleY $width $height
      $left = [Math]::Min($left, $rect.x); $top = [Math]::Min($top, $rect.y)
      $right = [Math]::Max($right, $rect.x + $rect.width); $bottom = [Math]::Max($bottom, $rect.y + $rect.height)
      $words.Add([ordered]@{ text = $wordText; rectPx = $rect })
    }
    if ($words.Count -eq 0 -or $totalText -gt $script:MaxTotalText) { throw 'Output limit' }
    $lineRect = [ordered]@{ x = $left; y = $top; width = $right - $left; height = $bottom - $top }
    $blocks.Add([ordered]@{ id = "line-$blockIndex"; text = $lineText; rectPx = $lineRect; words = @($words) })
  }
  Write-BridgeResult ([ordered]@{
    status = 'ok'; width = [int]$width; height = [int]$height
    language = $language; blocks = @($blocks)
  })
  } catch {
    if ($script:Phase -ceq 'decode') { Write-BridgeError 'decode-failed' }
    elseif ($script:Phase -ceq 'language') { Write-BridgeError 'language-unavailable' }
    elseif ($_.Exception.Message -ceq 'Output limit') { Write-BridgeError 'output-limit' }
    else { Write-BridgeError 'ocr-failed' }
  } finally {
    if ($null -ne $bitmap) { $bitmap.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  Invoke-ArkdownWindowsOcr $InputPath
}
