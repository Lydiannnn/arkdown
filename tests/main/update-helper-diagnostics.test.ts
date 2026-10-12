// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const { spawn, pin } = vi.hoisted(() => ({ spawn: vi.fn(), pin: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn }))
// This file never loads the addon or starts a native process. The existing native launch test remains separate.
vi.mock('../../src/main/updates/update-executable', () => ({ pinTrustedUpdateExecutable: pin }))
import { prepareRecoveryHelper, prepareUpdateHelper } from '../../src/main/updates/update-helper'
import { createUpdateDiagnosticLog, type UpdateDiagnosticLog } from '../../src/main/updates/update-diagnostic-log'
const roots: string[] = [], logs: UpdateDiagnosticLog[] = []
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
afterEach(async () => { for (const log of logs.splice(0)) await log.settled(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.resetAllMocks(); vi.unstubAllGlobals() })
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-update-ts-diagnostic-')); roots.push(root)
  const resourcesPath = path.join(root, 'app', 'resources'), bytes = Buffer.from('synthetic-update-bytes')
  const trust = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  await mkdir(path.join(resourcesPath, 'application-updater'), { recursive: true })
  await writeFile(path.join(resourcesPath, 'application-updater', 'Arkdown.Update.exe'), bytes)
  const verifiedFile = path.join(root, 'verified.zip'); await writeFile(verifiedFile, bytes)
  const directory = path.join(root, 'profile', 'diagnostics', 'update')
  const diagnostics = createUpdateDiagnosticLog({ directory }); logs.push(diagnostics)
  const options = { resourcesPath, executablePath: path.join(root, 'app', 'Arkdown.exe'), version: '1.0.4', verifiedFile, trust, diagnostics,
    artifact: { version: '1.0.5', channel: 'stable' as const, edition: 'Lite' as const, kind: 'portable' as const,
      filename: 'update.zip', url: 'https://download.cotax.tech/update.zip', ...trust } }
  return { root, directory, diagnostics, options }
}
const helperDiagnostic = () => ({ schemaVersion: 1, origin: 'helper', phase: 'stage.verify.open', operation: 'CreateFileW',
  pathScope: 'stage', relativePath: 'resources/app.asar', pathPrecision: 'exact', ancestorLevelsAboveSession: null,
  exceptionType: 'System.ComponentModel.Win32Exception', nativeErrorCode: 32, nativeCodeSource: 'Win32Exception', hresult: -2147467259,
  access: 2147483648, share: 1, creation: 3, flags: 2097152, validationReason: null, primaryStack: null, terminalStack: null })
function helper(failure = false) {
  const messages: string[] = [], child = Object.assign(new EventEmitter(), { pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn() })
  child.stdin.on('data', chunk => {
    const request = JSON.parse(chunk.toString()); messages.push(request.type ?? 'request')
    child.stdout.write(JSON.stringify(request.type === 'revoke' ? { type: 'revoked' } : failure
      ? { type: 'error', message: '原始助手错误', diagnostic: helperDiagnostic() } : { type: 'ready' }) + '\n')
  })
  spawn.mockReturnValue(child); return { child, messages }
}

it('records parent pin failure without spawning and rethrows the identical original Error', async () => {
  const f = await fixture(), original = new Error('原始 pin 错误')
  pin.mockImplementation((file: string) => { Object.assign(original, { updateDiagnostic: { operation: 'CreateFileW', path: file,
    directory: false, nativeErrorCode: 32, nativeCodeSource: 'GetLastError', access: 2147483648, share: 1, creation: 3,
    flags: 2097152, validationReason: null } }); throw original })
  await expect(prepareUpdateHelper(f.options)).rejects.toBe(original)
  expect(spawn).not.toHaveBeenCalled(); await f.diagnostics.settled()
  const files = await readdir(f.directory); expect(files).toHaveLength(1)
  const text = await readFile(path.join(f.directory, files[0]), 'utf8')
  expect(JSON.parse(text)).toMatchObject({ helperStarted: false, helperPid: null, edition: 'Lite', kind: 'portable',
    diagnostic: { origin: 'parent', phase: 'parent.pin', pathScope: 'session', relativePath: 'Arkdown.Update.exe', nativeErrorCode: 32 } })
  expect(text).not.toContain(f.root); expect(text).not.toContain('download.cotax.tech')
})

it('preserves preflight rejection, acknowledged revoke and lease closure while diagnostic storage is stalled', async () => {
  const f = await fixture(), release = deferred(); let closes = 0, attempts = 0
  const diagnostics = createUpdateDiagnosticLog({ directory: f.directory, openFile: async () => {
    attempts++
    await release.promise; throw Object.assign(new Error('PRIVATE disk failure'), { code: 'EACCES' })
  } }); logs.push(diagnostics)
  pin.mockReturnValue({ bytes: Buffer.from('ignored'), close() { closes++ } }); const child = helper(true)
  try {
    await expect(prepareUpdateHelper({ ...f.options, diagnostics })).rejects.toThrow('原始助手错误')
    expect(child.messages).toEqual(['request', 'revoke']); expect(closes).toBe(1)
  } finally { release.resolve() }
  await diagnostics.settled(); expect(attempts).toBe(1)
})

it('creates no diagnostic directory through successful ready, revoke and pin lease release', async () => {
  const f = await fixture(); let closes = 0
  pin.mockReturnValue({ bytes: Buffer.from('ignored'), close() { closes++ } }); const child = helper()
  const handoff = await prepareUpdateHelper(f.options); await handoff.revoke()
  expect(child.messages).toEqual(['request', 'revoke']); expect(closes).toBe(1)
  await f.diagnostics.settled(); expect(await readdir(f.root)).not.toContain('profile')
})

it('uses the same failure recorder for recovery pinning and excludes stored restart documents', async () => {
  const f = await fixture(), session = path.join(f.root, '.ArkdownUpdate-' + 'a'.repeat(32)), target = path.dirname(f.options.executablePath)
  await mkdir(session)
  await writeFile(path.join(session, 'request.json'), JSON.stringify({ target, kind: 'portable', edition: 'Lite', token: 'PRIVATE' }), 'utf8')
  await writeFile(path.join(session, 'journal.json'), JSON.stringify({ schemaVersion: 1, target, state: 'rolled-back', oldVersion: '1.0.4' }), 'utf8')
  await writeFile(path.join(session, 'commit.json'), JSON.stringify({ documents: ['C:\\PRIVATE\\document.md'], restoreArknote: false }), 'utf8')
  vi.stubGlobal('__ARKDOWN_APPLICATION_UPDATER_TRUST__', f.options.trust)
  const original = new Error('原始恢复错误')
  pin.mockImplementation((file: string) => { Object.assign(original, { updateDiagnostic: { operation: 'CreateFileW', path: file,
    directory: false, nativeErrorCode: 5, nativeCodeSource: 'GetLastError', access: 2147483648, share: 1, creation: 3,
    flags: 2097152, validationReason: null } }); throw original })
  await expect(prepareRecoveryHelper({ ...f.options, session })).rejects.toBe(original)
  expect(spawn).not.toHaveBeenCalled(); await f.diagnostics.settled()
  const files = await readdir(f.directory); expect(files).toHaveLength(1)
  const text = await readFile(path.join(f.directory, files[0]), 'utf8'), record = JSON.parse(text)
  expect(record.diagnostic).toMatchObject({ origin: 'parent', phase: 'parent.pin', pathScope: 'session', nativeErrorCode: 5 })
  expect(record.diagnostic.relativePath).toMatch(/^Arkdown\.Recover-[a-f0-9-]+\.exe$/)
  expect(text).not.toMatch(/PRIVATE|documents|token|document\.md/)
})
