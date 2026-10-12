import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { queryUpdateLaunchGate } from '../../../src/main/updates/update-launch-gate.ts'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { buildApplicationUpdater } from '../../../scripts/build-application-updater.ts'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
const execute = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const source = path.join(root, 'native/application-updater/src'), output = path.join(root, '.native-cache/application-updater/tests')
await mkdir(output, { recursive: true })
const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
const sources = await readdir(source).catch(() => [])
const executable = path.join(output, 'CoreTests.exe')
const result = await execute(compiler, ['/nologo', '/utf8output', '/codepage:65001', '/target:exe', '/main:CoreTests', `/out:${executable}`,
  '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
  '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
  ...sources.filter(f => f.endsWith('.cs')).map(f => path.join(source, f)), path.join(root, 'native/application-updater/tests/CoreTests.cs')],
  { windowsHide: true, encoding: 'utf8', timeout: 60_000 })
if (result.stdout) process.stdout.write(result.stdout)
const tests = await execute(executable, [], { windowsHide: true, encoding: 'utf8', timeout: 60_000 })
process.stdout.write(tests.stdout)
// Exercise the actual C# pipe server with the shipping Node client: neither side mocked.
const target = path.join(output, 'interop-' + randomUUID())
const gate = spawn(executable, ['--gate-server', target], { windowsHide: true, shell: false, stdio: 'pipe' })
const exited = once(gate, 'exit')
const lines = createInterface({ input: gate.stdout })
try {
  const [ready] = await once(lines, 'line', { signal: AbortSignal.timeout(5_000) })
  if (ready !== 'ready') throw new Error('Native gate failed to start: ' + ready)
  for (let i = 0; i < 50; i++) {
    const blocked = await queryUpdateLaunchGate(target, [], 'arkdown')
    const allowed = await queryUpdateLaunchGate(target, ['--arkdown-update-token=' + 'a'.repeat(64)], 'arkdown')
    if (blocked !== 'blocked' || allowed !== 'allowed') throw new Error('Native/Node gate interop mismatch')
  }
  process.stdout.write('PASS 100 native/Node launch-gate exchanges\n')
} finally {
  gate.stdin.end('\n'); lines.close()
  const [code] = await exited
  if (code !== 0) throw new Error('Native gate exit ' + code)
}
// The real shipping WinExe must enable long paths before its first path call;
// running only CoreTests.Main would miss an omitted Program.Main initialization.
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'arkdown-updater-entry-'))
try {
  const fixture = JSON.parse((await execute(executable, ['--preflight-fixture', fixtureRoot], { windowsHide: true, encoding: 'utf8' })).stdout)
  await cp(path.join(root, 'native/application-updater'), path.join(fixtureRoot, 'native/application-updater'), { recursive: true })
  await buildApplicationUpdater(fixtureRoot)
  const parent = spawn(path.join(fixture.target, 'Arkdown.exe'), ['--parent'], { windowsHide: true, stdio: 'pipe', shell: false })
  const parentExit = once(parent, 'exit'), parentLines = createInterface({ input: parent.stdout })
  try {
    await once(parentLines, 'line', { signal: AbortSignal.timeout(5_000) })
    const session = path.join(fixtureRoot, '.ArkdownUpdate-' + randomUUID().replaceAll('-', ''))
    await mkdir(session)
    const child = spawn(path.join(fixtureRoot, '.native-cache/application-updater/Arkdown.Update.exe'), ['--stdio'], { windowsHide: true, stdio: 'pipe', shell: false })
    const childExit = once(child, 'exit'), helperLines = createInterface({ input: child.stdout })
    const token = 'a'.repeat(64)
    child.stdin.on('error', () => {})
    try {
      const ready = once(helperLines, 'line', { signal: AbortSignal.timeout(20_000) })
      child.stdin.write(JSON.stringify({ protocolVersion: 1, parentPid: parent.pid, token, target: fixture.target, session,
        package: fixture.package, bytes: (await stat(fixture.package)).size,
        sha256: createHash('sha256').update(await readFile(fixture.package)).digest('hex'),
        oldVersion: '1.0.4', version: '1.0.5', edition: 'Lite', kind: 'portable' }) + '\n')
      const [line] = await ready
      if (JSON.parse(line).type !== 'ready') throw new Error('Shipping preflight failed: ' + line)
      if (await readFile(path.join(session, 'stage', fixture.relative), 'utf8') !== 'shipping-deep') throw new Error('Missing deep staged file')
      const revoked = once(helperLines, 'line', { signal: AbortSignal.timeout(5_000) })
      child.stdin.end(JSON.stringify({ type: 'revoke', token }) + '\n')
      if (JSON.parse((await revoked)[0]).type !== 'revoked') throw new Error('Preflight revoke failed')
      process.stdout.write('PASS shipping WinExe long-path preflight and revoke\n')
    } finally { child.stdin.end(); await childExit; helperLines.close() }
  } finally { parent.stdin.end('\n'); await parentExit; parentLines.close() }
} finally { await rm(fixtureRoot, { recursive: true, force: true }) }
