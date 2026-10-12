// @vitest-environment node
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { enableDefaultApplications, unregisterDefaultApplications, refreshOwnedDefaultApplications } from '../../src/main/default-applications/service'
import { createRegistryWorker, WindowsShellRegistry } from '../../src/main/shell-integration/windows-registry'

const fixtureScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$p = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($p.root -notmatch '^Software\\ArkdownNativeTests\\fta-toggle-[a-f0-9-]+$') { throw 'Invalid fixture root' }
if ($p.cleanup) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($p.root, $false); exit }
foreach ($row in $p.rows) {
  if ($row.key -match '\.\.' -or $row.key.StartsWith('\')) { throw 'Invalid fixture key' }
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($p.root + '\' + $row.key)
  try {
    if ($row.kind -eq 'MultiString') { $key.SetValue($row.name, [string[]]@($row.value), [Microsoft.Win32.RegistryValueKind]::MultiString) }
    else { $key.SetValue($row.name, [string]$row.value, [Microsoft.Win32.RegistryValueKind]::String) }
  } finally { $key.Dispose() }
}
`

async function fixture(root: string, rows: { key: string; name: string; value: string; kind?: string }[] = [], cleanup = false) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(fixtureScript, 'utf16le').toString('base64')], { shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
    let error = ''
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { error += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(error || `fixture exit ${code}`)))
    child.stdin.end(JSON.stringify({ root, rows, cleanup }))
  })
}

it.skipIf(process.env.ARKDOWN_NATIVE_DEFAULT_APPLICATIONS !== '1').each([
  ['Classes\\Arkdown.Document.Text\\CurVer', '', 'Foreign.Editor', 'String'],
  ['Classes\\Arkdown.Document.Text\\CLSID', '', '{foreign}', 'String'],
  ['Classes\\Arkdown.Document.Text\\shell', '', 'edit', 'String'],
  ['Classes\\Arkdown.Document.Text\\shell\\open', 'DelegateExecute', '{foreign}', 'String'],
  ['FileExts\\.txt\\UserChoice', 'ProgId', 'Arkdown.Document.Text', 'MultiString'],
])('native release refuses redirected or malformed ownership: %s', async (key, name, value, kind) => {
  const root = `Software\\ArkdownNativeTests\\fta-toggle-${randomUUID()}`
  vi.stubEnv('ARKDOWN_E2E', '1'); vi.stubEnv('ARKDOWN_REGISTRY_TEST_ROOT', root)
  const exe = 'C:\\AssociationTest\\Arkdown.exe'
  const registry = new WindowsShellRegistry(createRegistryWorker())
  try {
    await fixture(root, [
      { key: 'Classes\\Arkdown.Document.Text\\shell\\open\\command', name: '', value: `"${exe}" "%1"` },
      { key: 'FileExts\\.txt\\UserChoice', name: 'ProgId', value: 'Arkdown.Document.Text' },
      { key: 'FileExts\\.txt\\UserChoice', name: 'Hash', value: 'fixture' },
      { key, name, value, kind },
    ])
    await expect(registry.releaseOwnedDefault('.txt', 'Arkdown.Document.Text', exe)).rejects.toThrow()
  } finally { await registry.close(); await fixture(root, [], true); vi.unstubAllEnvs() }
}, 90_000)

it.skipIf(process.env.ARKDOWN_NATIVE_DEFAULT_APPLICATIONS !== '1')('native isolated enable/disable preserves other handlers, restores fallback and refuses protected choices', async () => {
  expect(process.platform).toBe('win32')
  const root = `Software\\ArkdownNativeTests\\fta-toggle-${randomUUID()}`
  vi.stubEnv('ARKDOWN_E2E', '1'); vi.stubEnv('ARKDOWN_REGISTRY_TEST_ROOT', root)
  const exe = 'C:\\关联测试\\Arkdown.exe'
  // Run the real PowerShell boundary; the worker-thread bundle is tested by build/runtime checks.
  const registry = new WindowsShellRegistry(createRegistryWorker())
  try {
    await fixture(root, [{ key: 'Classes\\.txt', name: '', value: 'txtfile' }])
    await enableDefaultApplications(registry, exe)
    expect((await registry.read('.md', 'user'))?.values[''].data).toBe('Arkdown.Document.Markdown')
    expect((await registry.read('.txt', 'user'))?.values[''].data).toBe('Arkdown.Document.Text')
    await fixture(root, [
      { key: 'FileExts\\.md\\UserChoice', name: 'ProgId', value: 'Arkdown.Document.Markdown' },
      { key: 'FileExts\\.md\\UserChoice', name: 'Hash', value: 'isolated-fixture' },
      { key: 'FileExts\\.txt\\UserChoice', name: 'ProgId', value: 'Notepad' },
      { key: 'FileExts\\.text\\UserChoice', name: 'ProgId', value: 'Arkdown.Document.Text' },
    ])
    await unregisterDefaultApplications(registry, exe)
    expect(await registry.userChoice('.md')).toBeNull()
    expect(await registry.userChoice('.txt')).toBe('Notepad')
    expect(await registry.userChoice('.text')).toBe('Arkdown.Document.Text')
    expect((await registry.read('.txt', 'user'))?.values[''].data).toBe('txtfile')
    expect((await registry.read('.md', 'user'))?.values['']).toBeUndefined()
    expect((await registry.read('@Capabilities\\FileAssociations'))?.values).not.toHaveProperty('.md')
    await refreshOwnedDefaultApplications(registry, exe)
    expect((await registry.read('@Capabilities\\FileAssociations'))?.values).not.toHaveProperty('.md')
    await enableDefaultApplications(registry, exe)
    expect((await registry.read('.md', 'user'))?.values[''].data).toBe('Arkdown.Document.Markdown')
    expect((await registry.read('.txt', 'user'))?.values[''].data).toBe('txtfile')
    await fixture(root, [{ key: 'FileExts\\.md\\UserChoiceLatest\\ProgId', name: 'ProgId', value: 'Arkdown.Document.Markdown' }])
    await expect(unregisterDefaultApplications(registry, exe)).rejects.toThrow()
    expect((await registry.read('Arkdown.Document.Markdown\\shell\\open\\command'))?.values[''].data).toBe(`"${exe}" "%1"`)
    expect(await registry.userChoice('.md')).toBe('Arkdown.Document.Markdown')
  } finally {
    await registry.close()
    await fixture(root, [], true)
    vi.unstubAllEnvs()
  }
}, 90_000)

it.skipIf(process.env.ARKDOWN_NATIVE_DEFAULT_APPLICATIONS !== '1')('preserves a foreign choice replaced between inspection and release', async () => {
  const root = `Software\\ArkdownNativeTests\\fta-toggle-${randomUUID()}`
  vi.stubEnv('ARKDOWN_E2E', '1'); vi.stubEnv('ARKDOWN_REGISTRY_TEST_ROOT', root)
  const exe = 'C:\\关联测试\\Arkdown.exe'
  let injected = false
  const worker = createRegistryWorker((file, args, options) => {
    const index = args.indexOf('-EncodedCommand') + 1
    const original = Buffer.from(args[index], 'base64').toString('utf16le')
    const anchor = '  if ($removeChoice) {'
    expect(original).toContain(anchor)
    // Replace the inspected key at a deterministic boundary. The injected fixture
    // is allowed only inside this test's isolated root, never real FileExts.
    const replacement = String.raw`
  if ($removeChoice) {
    if ($isolated -ne '${root}') { throw 'Unexpected test root' }
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($base + '\UserChoice', $false)
    $foreign = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($base + '\UserChoice')
    try { $foreign.SetValue('ProgId', 'Another.Editor'); $foreign.SetValue('Hash', 'replacement') } finally { $foreign.Dispose() }
  }
`
    const updated = [...args]
    updated[index] = Buffer.from(original.replace(anchor, replacement + anchor), 'utf16le').toString('base64')
    injected = true
    return spawn(file, updated, options)
  })
  const registry = new WindowsShellRegistry(worker)
  try {
    await fixture(root, [
      { key: 'Classes\\Arkdown.Document.Markdown\\shell\\open\\command', name: '', value: `"${exe}" "%1"` },
      { key: 'FileExts\\.md\\UserChoice', name: 'ProgId', value: 'Arkdown.Document.Markdown' },
      { key: 'FileExts\\.md\\UserChoice', name: 'Hash', value: 'original' },
    ])
    await registry.releaseOwnedDefault('.md', 'Arkdown.Document.Markdown', exe)
    expect(injected).toBe(true)
    expect(await registry.userChoice('.md')).toBe('Another.Editor')
  } finally {
    await registry.close()
    await fixture(root, [], true)
    vi.unstubAllEnvs()
  }
}, 90_000)
