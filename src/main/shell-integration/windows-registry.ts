import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { PublicError } from '../../shared/public-errors'
import type { DefaultApplicationsStatus } from '../../shared/default-applications'
import { createSerializedRegistryWorker } from './serialized-registry-worker'

export interface RegistryValue { kind: string; data: unknown }
export interface RegistryKey { values: Record<string, RegistryValue>; subkeys: string[] }
export interface RegistryBoundary {
  read(key: string, scope?: 'user' | 'effective'): Promise<RegistryKey | null>
  userChoice(extension: string): Promise<string | null>
  releaseOwnedDefault?(extension: '.md' | '.txt', progId: string, executable: string): Promise<void>
  change(key: string, name: string, before: RegistryValue | null, after: RegistryValue | null): Promise<string[]>
  removeEmpty(key: string): Promise<void>
  notify(): Promise<void>
  close?(): Promise<void>
}

// Fixed script, structured stdin, explicit Unicode output. No reg.exe locale parsing.
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
while ($null -ne ($line = [Console]::In.ReadLine())) {
try {
$p = $line | ConvertFrom-Json
$isolated = $p.testRoot
$classes = 'Software\Classes\'
if ($isolated) { $classes = $isolated + '\Classes\' }
function Key-Path($logical) {
  if ($logical -eq '@DefaultApplicationsState') { if ($isolated) { return $isolated + '\DefaultApplicationsState' }; return 'Software\Arkdown\DefaultApplicationsState' }
  if ($logical -eq '@Capabilities') { if ($isolated) { return $isolated + '\Capabilities' }; return 'Software\Arkdown\Capabilities' }
  if ($logical -eq '@Capabilities\FileAssociations') { if ($isolated) { return $isolated + '\Capabilities\FileAssociations' }; return 'Software\Arkdown\Capabilities\FileAssociations' }
  if ($logical -eq '@RegisteredApplications') { if ($isolated) { return $isolated + '\RegisteredApplications' }; return 'Software\RegisteredApplications' }
  if ($logical.StartsWith('@')) { throw 'CONFLICT' }
  return $classes + $logical
}
function Read-Value($key, $name) {
  if ($null -eq $key -or $key.GetValueNames() -notcontains $name) { return $null }
  return @{ kind = $key.GetValueKind($name).ToString(); data = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
}
$result = $null
if ($p.action -eq 'associations') {
  if (-not $isolated -and -not ('ArkdownAssociations' -as [type])) {
    Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class ArkdownAssociations { [DllImport("shlwapi.dll", CharSet=CharSet.Unicode)] private static extern uint AssocQueryStringW(uint flags, uint str, string assoc, string extra, StringBuilder output, ref uint count); public static string Query(string ext, uint field) { uint count = 32768; var output = new StringBuilder((int)count); uint result = AssocQueryStringW(0, field, ext, null, output, ref count); if (result == 0) return output.ToString(); if (result == 0x80070483 || result == 0x80070002) return null; throw new InvalidOperationException("Association query failed"); } }'
  }
  $result = @{}
  foreach ($extension in @('.md', '.txt')) {
    if ($isolated) {
      $fixture = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($isolated + '\Associations\' + $extension)
      try { if ($fixture) { $result[$extension] = @{ progId = $fixture.GetValue('ProgId', $null); executable = $fixture.GetValue('Executable', $null) } } } finally { if ($fixture) { $fixture.Dispose() } }
      if (-not $result.ContainsKey($extension)) { $result[$extension] = @{ progId = $null; executable = $null } }
    } else { $result[$extension] = @{ progId = [ArkdownAssociations]::Query($extension, 20); executable = [ArkdownAssociations]::Query($extension, 2) } }
  }
} elseif ($p.action -eq 'notify' -and $isolated) {
  # Isolated verification never broadcasts test classes to Explorer.
} elseif ($p.action -eq 'notify') {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ArkdownShellNotify { [DllImport("shell32.dll")] public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2); }'
  [ArkdownShellNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
} elseif ($p.action -eq 'release-default') {
  $expected = @{ '.md' = 'Arkdown.Document.Markdown'; '.txt' = 'Arkdown.Document.Text' }
  if (-not $expected.ContainsKey([string]$p.extension) -or $p.progId -cne $expected[$p.extension]) { throw 'CONFLICT' }
  # Compile before inspecting ownership; first-use compilation can take seconds.
  if (-not ('ArkdownReleaseAssociation' -as [type])) {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ArkdownReleaseAssociation { [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] private static extern int RegDeleteKeyW(UIntPtr root, string path); public static void Delete(string path) { int code = RegDeleteKeyW(new UIntPtr(0x80000001u), path); if (code != 0 && code != 2) throw new System.ComponentModel.Win32Exception(code); } }'
  }
  function Open-OwnedHandlerKey($suffix) {
    if ($isolated) { return [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($classes + $p.progId + $suffix) }
    return [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey($p.progId + $suffix)
  }
  function Assert-OwnedHandler {
  $handler = Open-OwnedHandlerKey '\shell\open\command'
  try {
    if (-not $handler -or $handler.GetValueNames() -notcontains '' -or $handler.GetValueKind('') -ne 'String' -or $handler.GetValue('') -ine ('"' + $p.executable + '" "%1"') -or $handler.ValueCount -ne 1 -or $handler.SubKeyCount -ne 0) { throw 'CONFLICT' }
  } finally { if ($handler) { $handler.Dispose() } }
  $open = Open-OwnedHandlerKey '\shell\open'
  try { if (-not $open -or $open.ValueCount -ne 0 -or $open.SubKeyCount -ne 1 -or $open.GetSubKeyNames()[0] -ine 'command') { throw 'CONFLICT' } } finally { if ($open) { $open.Dispose() } }
  $root = Open-OwnedHandlerKey ''
  try { if ($root -and @($root.GetSubKeyNames() | Where-Object { $_ -in @('CurVer','CLSID') }).Count -ne 0) { throw 'CONFLICT' } } finally { if ($root) { $root.Dispose() } }
  $shell = Open-OwnedHandlerKey '\shell'
  try {
    if ($shell -and $shell.GetValueNames() -contains '') {
      if ($shell.GetValueKind('') -ne 'String' -or $shell.GetValue('') -notin @('','open')) { throw 'CONFLICT' }
    }
  } finally { if ($shell) { $shell.Dispose() } }
  }
  function Assert-ChoiceType($choice) {
    if ($choice -and $choice.GetValueNames() -contains 'ProgId' -and $choice.GetValueKind('ProgId') -ne 'String') { throw 'CONFLICT' }
  }
  Assert-OwnedHandler
  $choiceRoot = 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\'
  if ($isolated) { $choiceRoot = $isolated + '\FileExts\' }
  $base = $choiceRoot + $p.extension
  $latest = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($base + '\UserChoiceLatest')
  if ($latest) { $latest.Dispose(); throw 'Protected association version' }
  $choice = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($base + '\UserChoice')
  $removeChoice = $false
  try {
    Assert-ChoiceType $choice
    if ($choice -and $choice.GetValue('ProgId') -ieq $p.progId) {
      if ($choice.SubKeyCount -ne 0 -or @($choice.GetValueNames() | Where-Object { $_ -notin @('ProgId','Hash') }).Count -ne 0) { throw 'CONFLICT' }
      $removeChoice = $true
    }
  } finally { if ($choice) { $choice.Dispose() } }
  if ($removeChoice) {
    # Recheck after preparation, including a replacement made by Windows Settings.
    Assert-OwnedHandler
    $latest = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($base + '\UserChoiceLatest')
    if ($latest) { $latest.Dispose(); throw 'Protected association version' }
    $choice = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($base + '\UserChoice')
    try {
      Assert-ChoiceType $choice
      if ($choice -and $choice.GetValue('ProgId') -ieq $p.progId) {
        if ($choice.SubKeyCount -ne 0 -or @($choice.GetValueNames() | Where-Object { $_ -notin @('ProgId','Hash') }).Count -ne 0) { throw 'CONFLICT' }
        # No hash generation, ACL changes, recursive deletion, or protection-driver changes.
        [ArkdownReleaseAssociation]::Delete($base + '\UserChoice')
      }
    } finally { if ($choice) { $choice.Dispose() } }
  }
  $openWith = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($base + '\OpenWithProgids', $true)
  try { if ($openWith) { $openWith.DeleteValue($p.progId, $false) } } finally { if ($openWith) { $openWith.Dispose() } }
} elseif ($p.action -eq 'choice') {
  $choiceRoot = 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\'
  if ($isolated) { $choiceRoot = $isolated + '\FileExts\' }
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($choiceRoot + $p.extension + '\UserChoiceLatest\ProgId')
  if (-not $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($choiceRoot + $p.extension + '\UserChoice') }
  try { if ($key) { $result = $key.GetValue('ProgId', $null) } } finally { if ($key) { $key.Dispose() } }
} else {
  $root = [Microsoft.Win32.Registry]::CurrentUser
  $name = Key-Path $p.key
  if (-not $isolated -and -not $p.key.StartsWith('@') -and $p.action -eq 'read' -and $p.scope -eq 'effective') { $root = [Microsoft.Win32.Registry]::ClassesRoot; $name = $p.key }
  $key = $root.OpenSubKey($name, $p.action -ne 'read')
  try {
    if ($p.action -eq 'read') {
      if ($key) {
        $values = @{}
        foreach ($valueName in $key.GetValueNames()) { $values[$valueName] = Read-Value $key $valueName }
        $result = @{ values = $values; subkeys = @($key.GetSubKeyNames()) }
      }
    } elseif ($p.action -eq 'change') {
      $current = Read-Value $key $p.name
      $matches = ($null -eq $current -and $null -eq $p.before) -or ($null -ne $current -and $null -ne $p.before -and $current.kind -ceq $p.before.kind -and ($current.data | ConvertTo-Json -Compress -Depth 8) -ceq ($p.before.data | ConvertTo-Json -Compress -Depth 8))
      if (-not $matches) { throw 'CONFLICT' }
      $created = @()
      try {
      if ($null -ne $p.after) {
        if (-not $key) {
          $parts = $p.key.Split('\')
          for ($i = 1; $i -le $parts.Length; $i++) {
            $part = ($parts[0..($i - 1)] -join '\')
            $probe = $root.OpenSubKey((Key-Path $part))
            if ($probe) { $probe.Dispose() } else { $created += $part }
          }
          $key = $root.CreateSubKey($name)
        }
        $key.SetValue($p.name, $p.after.data, [System.Enum]::Parse([Microsoft.Win32.RegistryValueKind], [string]$p.after.kind))
      } elseif ($key) { $key.DeleteValue($p.name, $false) }
      } catch {
        $failure = $_
        if ($key) { $key.Dispose(); $key = $null }
        foreach ($parent in @($created | Sort-Object { $_.Length } -Descending)) {
          $cleanup = $root.OpenSubKey((Key-Path $parent))
          if ($cleanup) {
            $empty = $cleanup.ValueCount -eq 0 -and $cleanup.SubKeyCount -eq 0
            $cleanup.Dispose()
            if ($empty) { $root.DeleteSubKey((Key-Path $parent), $false) }
          }
        }
        throw $failure
      }
      $result = @($created)
    } elseif ($p.action -eq 'removeEmpty') {
      if ($key -and $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0) {
        $key.Dispose(); $key = $null
        $root.DeleteSubKey($name, $false)
      }
    }
  } finally { if ($key) { $key.Dispose() } }
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ ok = $true; value = $result } -Compress -Depth 12))
} catch {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ ok = $false; conflict = $_.Exception.Message.Contains('CONFLICT') } -Compress))
}
}
`

export type RegistryProcessRunner = (payload: object) => Promise<unknown>
export function isolatedRegistryRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = env.ARKDOWN_REGISTRY_TEST_ROOT
  return env.ARKDOWN_E2E === '1' && typeof root === 'string' && /^Software\\ArkdownNativeTests\\[a-z0-9-]{1,80}$/i.test(root) ? root : null
}
export function canInitializeDesktopRegistration(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARKDOWN_E2E !== '1' || isolatedRegistryRoot(env) !== null
}
type WorkerLauncher = (file: string, args: string[], options: { shell: false; windowsHide: true; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcessWithoutNullStreams

/** A short-lived worker belongs to one serialized menu operation, including rollback. */
export function createRegistryWorker(launch: WorkerLauncher = spawn) {
  let child: ChildProcessWithoutNullStreams | null = null
  let exited: Promise<void> = Promise.resolve()
  let output = ''
  const pending: Array<{ resolve(value: unknown): void; reject(error: unknown): void }> = []
  const fail = () => {
    for (const request of pending.splice(0)) request.reject(new PublicError('OPERATION_FAILED'))
  }
  const execute: RegistryProcessRunner = (payload) => new Promise((resolve, reject) => {
    const testRoot = isolatedRegistryRoot()
    if (process.env.ARKDOWN_E2E === '1' && !testRoot) { reject(new PublicError('SHELL_INTEGRATION_UNSUPPORTED')); return }
    if (!child) {
      output = ''
      child = launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      })
      const current = child
      exited = new Promise<void>((complete) => {
        current.once('close', () => { if (child === current) child = null; fail(); complete() })
      })
      current.stdout.setEncoding('utf8')
      current.stdout.on('data', (chunk: string | Buffer) => {
        output += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        let newline: number
        while ((newline = output.indexOf('\n')) >= 0) {
          const line = output.slice(0, newline).replace(/^\uFEFF/, '')
          output = output.slice(newline + 1)
          const request = pending.shift()
          if (!request) continue
          try {
            const response = JSON.parse(line) as { ok: boolean; value?: unknown; conflict?: boolean }
            if (response.ok === true) request.resolve(response.value)
            else request.reject(new PublicError(response.conflict === true ? 'SHELL_INTEGRATION_CONFLICT' : 'OPERATION_FAILED'))
          } catch { request.reject(new PublicError('INVALID_RESPONSE')) }
        }
      })
      // Native diagnostics are never exposed as public setting errors.
      current.stderr.resume()
      current.once('error', fail)
      current.stdin.on('error', fail)
    }
    pending.push({ resolve, reject })
    child.stdin.write(JSON.stringify(testRoot ? { ...payload, testRoot } : payload) + '\n', 'utf8')
  })
  return {
    execute,
    async close(): Promise<void> {
      if (!child) return
      child.stdin.end()
      await exited
    },
  }
}

export class WindowsShellRegistry implements RegistryBoundary {
  constructor(private readonly worker = createSerializedRegistryWorker()) {}
  private execute(payload: object) { return this.worker.execute(payload) }
  close(): Promise<void> { return this.worker.close() }
  async defaultApplicationsStatus(executable: string): Promise<DefaultApplicationsStatus> {
    const value = await this.execute({ action: 'associations' }) as Record<string, { progId: unknown; executable: unknown }>
    const matches = (extension: string) => {
      const result = value?.[extension]
      if (!result || (result.progId !== null && typeof result.progId !== 'string')
        || (result.executable !== null && typeof result.executable !== 'string')) throw new PublicError('INVALID_RESPONSE')
      return typeof result.progId === 'string' && typeof result.executable === 'string'
        && result.executable.toLowerCase() === executable.toLowerCase()
    }
    return { markdown: matches('.md'), text: matches('.txt') }
  }
  async read(key: string, scope: 'user' | 'effective' = 'effective'): Promise<RegistryKey | null> {
    return await this.execute({ action: 'read', key, scope }) as RegistryKey | null
  }
  async userChoice(extension: string): Promise<string | null> {
    return await this.execute({ action: 'choice', extension }) as string | null
  }
  async releaseOwnedDefault(extension: '.md' | '.txt', progId: string, executable: string): Promise<void> {
    if (!['.md', '.txt'].includes(extension) || /["\r\n\0]/.test(executable)) throw new PublicError('INVALID_INPUT')
    await this.execute({ action: 'release-default', extension, progId, executable })
  }
  async change(key: string, name: string, before: RegistryValue | null, after: RegistryValue | null): Promise<string[]> {
    return await this.execute({ action: 'change', key, name, before, after }) as string[]
  }
  async removeEmpty(key: string): Promise<void> { await this.execute({ action: 'removeEmpty', key }) }
  async notify(): Promise<void> { await this.execute({ action: 'notify' }) }
}

export function registryValue(key: RegistryKey | null, name: string): RegistryValue | null {
  const found = Object.keys(key?.values ?? {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return found === undefined ? null : key!.values[found]
}
export function sameRegistryValue(left: RegistryValue | null, right: RegistryValue | null): boolean {
  return left === null ? right === null : right !== null && left.kind === right.kind && JSON.stringify(left.data) === JSON.stringify(right.data)
}
