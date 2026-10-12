# YPF. Copyright (c) 2026 Miterh.
# Compiled into the uninstaller; does not depend on files in the installed package.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$cu = [Microsoft.Win32.Registry]::CurrentUser
$classes = 'Software\Classes\'
$fileExts = 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\'
$capabilities = 'Software\Arkdown\Capabilities'
$state = 'Software\Arkdown\DefaultApplicationsState'
$registered = 'Software\RegisteredApplications'
$isolated = $env:ARKDOWN_E2E -eq '1' -and $env:ARKDOWN_REGISTRY_TEST_ROOT -match '^Software\\ArkdownNativeTests\\[a-z0-9-]{1,80}$'
if ($env:ARKDOWN_E2E -eq '1' -and -not $isolated) { exit 20 }
if ($isolated) {
  $base = $env:ARKDOWN_REGISTRY_TEST_ROOT
  $classes = $base + '\Classes\'; $fileExts = $base + '\FileExts\'
  $capabilities = $base + '\Capabilities'; $state = $base + '\DefaultApplicationsState'; $registered = $base + '\RegisteredApplications'
}
$executable = $env:ARKDOWN_UNINSTALL_EXECUTABLE
if (-not [IO.Path]::IsPathRooted($executable) -or $executable -match '["\r\n\x00]' -or [IO.Path]::GetFileName($executable) -ine 'Arkdown.exe') { exit 20 }
$command = '"' + $executable + '" "%1"'
$appIcon = '"' + $executable + '",0'
$directory = [IO.Path]::GetDirectoryName($executable)
$candidates = '__ARKDOWN_CANDIDATES_JSON__' | ConvertFrom-Json

function Value($path, $name = '') {
  $key = $cu.OpenSubKey($path)
  try {
    if ($key -and $key.GetValueNames() -contains $name) {
      if ($key.GetValueKind($name) -ne 'String') { throw 'Unknown registry value type' }
      return $key.GetValue($name)
    }
  } finally { if ($key) { $key.Dispose() } }
  return $null
}
function Children($path) {
  $key = $cu.OpenSubKey($path)
  try { if ($key) { return @($key.GetSubKeyNames()) } } finally { if ($key) { $key.Dispose() } }
  return @()
}
function Empty-Key($path, $allowedChild = '') {
  $key = $cu.OpenSubKey($path)
  try {
    return -not $key -or ($key.ValueCount -eq 0 -and ($key.SubKeyCount -eq 0 -or
      ($allowedChild -and $key.SubKeyCount -eq 1 -and $key.GetSubKeyNames()[0] -ieq $allowedChild -and (Empty-Key ($path + '\' + $allowedChild)))))
  } finally { if ($key) { $key.Dispose() } }
}
function Replace-Value($path, $name, $expected, $replacement = $null, $required = $false) {
  $key = $cu.OpenSubKey($path, $true)
  try {
    if ($key -and $key.GetValueNames() -contains $name -and $key.GetValueKind($name) -eq 'String' -and $key.GetValue($name) -ceq $expected) {
      if ($null -eq $replacement) { $key.DeleteValue($name, $false) } else { $key.SetValue($name, $replacement, [Microsoft.Win32.RegistryValueKind]::String) }
    } elseif ($required) { throw 'Association changed during cleanup' }
  } finally { if ($key) { $key.Dispose() } }
}
function Assert-Owner($progId) {
  if ((Value ($classes + $progId + '\shell\open\command')) -ine $command) { throw 'Association owner changed' }
  $key = $cu.OpenSubKey($classes + $progId + '\shell\open\command')
  try { if ($key.SubKeyCount -ne 0 -or $key.ValueCount -ne 1) { throw 'Unknown command handler' } } finally { $key.Dispose() }
  $key = $cu.OpenSubKey($classes + $progId + '\shell\open')
  try { if ($key.ValueCount -ne 0 -or $key.SubKeyCount -ne 1) { throw 'Unknown activation handler' } } finally { $key.Dispose() }
  if (@(Children ($classes + $progId)) | Where-Object { $_ -in @('CurVer', 'CLSID') }) { throw 'Redirected handler' }
  $verb = Value ($classes + $progId + '\shell')
  if ($verb -and $verb -ine 'open') { throw 'Unknown default verb' }
}
function Previous-Value($text) {
  $backup = ConvertFrom-Json -InputObject $text
  if ($backup -isnot [pscustomobject] -or $backup.version -isnot [int] -or $backup.version -ne 1 -or
      'previous' -notin $backup.PSObject.Properties.Name -or ($null -ne $backup.previous -and
      ($backup.previous -isnot [pscustomobject] -or $backup.previous.kind -cne 'String' -or $backup.previous.data -isnot [string]))) { throw 'Invalid saved association' }
  return $backup.previous.data
}
function Remove-Reference($path, $name, $expected) {
  $actual = Value $path $name
  # Windows paths/ProgIDs are case-insensitive; retain the actual value for CAS.
  if ($actual -is [string] -and $actual -ieq $expected) { Replace-Value $path $name $actual }
}
function Points-ToUninstallingCopy($progId) {
  if ($isolated) { return (Value ($classes + $progId + '\shell\open\command')) -ieq $command }
  $key = [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey($progId + '\shell\open\command')
  try { return $key -and $key.GetValue('') -ieq $command } finally { if ($key) { $key.Dispose() } }
}
function Remove-OpenWith($path, $progId) {
  $key = $cu.OpenSubKey($path, $true)
  try {
    if ($key -and $key.GetValueNames() -contains $progId) {
      $value = $key.GetValue($progId)
      if (($value -is [string] -and $value -eq '') -or ($value -is [byte[]] -and $value.Length -eq 0)) { $key.DeleteValue($progId, $false) }
    }
  } finally { if ($key) { $key.Dispose() } }
}

try {
  $owned = @{}
  foreach ($candidate in $candidates) {
    if ((Value ($classes + $candidate[0] + '\shell\open\command')) -ieq $command) { $owned[[string]$candidate[0]] = $candidate }
  }
  # Windows may also create an executable-based Open With candidate.
  foreach ($legacy in @('Applications\Arkdown.exe', 'Arkdown.Markdown')) {
    if ((Value ($classes + $legacy + '\shell\open\command')) -ieq $command) { $owned[$legacy] = @($legacy, 'Markdown 文档', 'ark-md.ico', @()) }
  }
  if ($owned.Count -eq 0) { exit 0 }
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ArkdownUninstallRegistry { [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] public static extern int RegDeleteKeyW(UIntPtr root, string path); [DllImport("shell32.dll")] public static extern void SHChangeNotify(uint e, uint f, IntPtr a, IntPtr b); }'
  $extensions = @($candidates | ForEach-Object { $_[3] | ForEach-Object { '.' + $_ } }) + @(Children $fileExts) + @(Children $classes)
  $extensions = @($extensions | Where-Object { $_.StartsWith('.') -and -not $_.Contains('\') } | Sort-Object -Unique)
  foreach ($progId in @($owned.Keys)) { Assert-Owner $progId }
  # Inspect every protected selection before removing any handler metadata.
  foreach ($extension in $extensions) {
    $choice = Value ($fileExts + $extension + '\UserChoice') 'ProgId'
    $latest = Value ($fileExts + $extension + '\UserChoiceLatest\ProgId') 'ProgId'
    if (-not $latest) { $latest = Value ($fileExts + $extension + '\UserChoiceLatest') 'ProgId' }
    if ($latest -and $owned.ContainsKey([string]$latest)) { throw 'Protected association requires manual selection' }
    if ($choice -and $owned.ContainsKey([string]$choice)) {
      $key = $cu.OpenSubKey($fileExts + $extension + '\UserChoice')
      try { if ($key.SubKeyCount -ne 0 -or @($key.GetValueNames() | Where-Object { $_ -notin @('ProgId', 'Hash') }).Count -ne 0) { throw 'Unknown association contents' } } finally { $key.Dispose() }
    }
    $current = Value ($classes + $extension)
    if ($current -and $owned.ContainsKey([string]$current)) {
      $saved = Value $state $extension
      if ($null -ne $saved) { $null = Previous-Value $saved }
    }
  }
  foreach ($extension in $extensions) {
    $choicePath = $fileExts + $extension + '\UserChoice'
    $progId = Value $choicePath 'ProgId'
    if ($progId -and $owned.ContainsKey([string]$progId)) {
      Assert-Owner $progId
      $key = $cu.OpenSubKey($choicePath)
      try {
        if ($key -and $key.GetValue('ProgId') -ieq $progId) {
          if ($key.SubKeyCount -ne 0 -or @($key.GetValueNames() | Where-Object { $_ -notin @('ProgId', 'Hash') }).Count -ne 0) { throw 'Unknown association contents' }
          $code = [ArkdownUninstallRegistry]::RegDeleteKeyW([UIntPtr]::new([uint32]2147483649), $choicePath)
          if ($code -ne 0 -and $code -ne 2) { throw 'Association release failed' }
        }
      } finally { if ($key) { $key.Dispose() } }
    }
  }
  foreach ($extension in $extensions) {
    foreach ($progId in @($owned.Keys)) {
      Assert-Owner $progId
      $current = Value ($classes + $extension)
      if ($current -ieq $progId) {
        $backupText = Value $state $extension
        $previous = $null
        if ($null -ne $backupText) {
          $previous = Previous-Value $backupText
          if ($previous -and ($owned.ContainsKey([string]$previous) -or (Points-ToUninstallingCopy $previous))) { $previous = $null }
        }
        Replace-Value ($classes + $extension) '' $current $previous $true
        if ($backupText) { Replace-Value $state $extension $backupText }
      }
      Remove-OpenWith ($classes + $extension + '\OpenWithProgids') $progId
      Remove-OpenWith ($fileExts + $extension + '\OpenWithProgids') $progId
      Remove-Reference ($capabilities + '\FileAssociations') $extension $progId
    }
  }
  foreach ($progId in @($owned.Keys)) {
    Assert-Owner $progId
    $candidate = $owned[$progId]
    $type = $classes + $progId
    $icon = '"' + [IO.Path]::Combine($directory, 'resources', 'branding', [string]$candidate[2]) + '",0'
    Remove-Reference ($type + '\DefaultIcon') '' $icon
    Remove-Reference ($type + '\DefaultIcon') '' $appIcon
    Replace-Value $type '' ([string]$candidate[1])
    Remove-Reference ($type + '\shell\open\command') '' $command
  }
  if ((Value $capabilities 'ApplicationIcon') -ieq $appIcon) {
    Remove-Reference $capabilities 'ApplicationIcon' $appIcon
    if ((Empty-Key ($capabilities + '\FileAssociations')) -and -not (@(Children $capabilities) | Where-Object { $_ -ine 'FileAssociations' })) {
      Replace-Value $capabilities 'ApplicationName' 'Arkdown'
      Replace-Value $capabilities 'ApplicationDescription' 'Markdown 和文本文档编辑器'
      if (Empty-Key $capabilities 'FileAssociations') { Remove-Reference $registered 'Arkdown' 'Software\Arkdown\Capabilities' }
    }
  }
  if (-not $isolated) { [ArkdownUninstallRegistry]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero) }
  exit 0
} catch {
  [Console]::Error.WriteLine('Arkdown association cleanup was not completed; application files must be retained.')
  exit 21
}
