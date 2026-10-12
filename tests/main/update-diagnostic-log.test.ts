// @vitest-environment node
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { UpdateDiagnosticFile, UpdateDiagnosticLog, UpdateDiagnosticLogOptions } from '../../src/main/updates/update-diagnostic-log'
const modulePath = '../../src/main/updates/update-diagnostic-log'
const implementation = await import(modulePath).catch(() => ({})) as typeof import('../../src/main/updates/update-diagnostic-log')
const roots: string[] = [], logs: UpdateDiagnosticLog[] = []
const instanceId = '550e8400-e29b-41d4-a716-446655440000'
const filename = (index: number) => `arkdown-update-${instanceId}-${index}.json`
const diagnostic = () => ({ schemaVersion: 1, origin: 'helper', phase: 'stage.verify.open', operation: 'CreateFileW',
  pathScope: 'stage', relativePath: 'resources/app.asar', pathPrecision: 'exact', ancestorLevelsAboveSession: null,
  exceptionType: 'System.ComponentModel.Win32Exception', nativeErrorCode: 32, nativeCodeSource: 'Win32Exception',
  hresult: -2147467259, access: 2147483648, share: 1, creation: 3, flags: 2097152, validationReason: null,
  primaryStack: 'at Arkdown.Update.Native.Validate(SafeFileHandle h) in C:\\Users\\PRIVATE\\Safety.cs:line 95', terminalStack: null })
const context = () => ({ version: '1.0.4', edition: 'Lite' as const, kind: 'portable' as const,
  helperSha256: 'a'.repeat(64), helperStarted: true, helperPid: 12345 })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function openOwned(file: string): Promise<UpdateDiagnosticFile> {
  const handle = await open(file, 'wx', 0o600)
  return { write: async (bytes, position) => (await handle.write(bytes, 0, bytes.byteLength, position)).bytesWritten, close: () => handle.close() }
}
async function fixture(options: Partial<UpdateDiagnosticLogOptions> = {}) {
  expect(implementation.createUpdateDiagnosticLog).toBeTypeOf('function')
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-update-diagnostic-')); roots.push(root)
  const directory = path.join(root, 'diagnostics'), log = implementation.createUpdateDiagnosticLog({ directory, instanceId, ...options })
  logs.push(log); return { root, directory, log }
}
afterEach(async () => { for (const log of logs.splice(0)) await log.settled(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('does no filesystem work before failure and writes immutable private snapshots under the injected directory', async () => {
  const { root, directory, log } = await fixture()
  await log.settled(); expect(await readdir(root)).toEqual([])
  const input = diagnostic(), metadata = context()
  expect(log.record(input, metadata)).toBeUndefined(); input.nativeErrorCode = 5; metadata.version = '9.9.9'
  await log.settled()
  const text = await readFile(path.join(directory, filename(0)), 'utf8'), record = JSON.parse(text)
  expect(record).toMatchObject({ ...context(), parentPid: process.pid, diagnostic: { nativeErrorCode: 32,
    primaryStack: 'at Arkdown.Update.Native.Validate' } })
  expect(record.timestamp).toMatch(/^\d{4}-\d\d-\d\dT/)
  expect(text).not.toMatch(/PRIVATE|Users|Safety\.cs|token|url|documents/)
})

it('rejects malformed fields and throwing getters without creating files', async () => {
  const { root, log } = await fixture()
  log.record({ ...diagnostic(), path: 'C:\\PRIVATE\\document.md' }, context())
  log.record(diagnostic(), { ...context(), helperSha256: 'PRIVATE' })
  log.record({ ...diagnostic(), primaryStack: '\n'.repeat(8192) }, context())
  const metadata = context(); Object.defineProperty(metadata, 'version', { get() { throw new Error('PRIVATE') } })
  expect(() => log.record(diagnostic(), metadata)).not.toThrow()
  await log.settled(); expect(await readdir(root)).toEqual([])
})

it('never overwrites a colliding exclusive file or touches unrelated diagnostic files', async () => {
  const { directory, log } = await fixture()
  // The logger has no eager mkdir; an unrelated owner creates the directory first.
  const { mkdir } = await import('node:fs/promises'); await mkdir(directory)
  await writeFile(path.join(directory, filename(0)), 'existing first evidence', 'utf8')
  await writeFile(path.join(directory, 'unrelated.json'), 'unrelated', 'utf8')
  log.record(diagnostic(), context()); await expect(log.settled()).resolves.toBeUndefined()
  log.record({ ...diagnostic(), nativeErrorCode: 5 }, context()); await log.settled()
  expect(await readFile(path.join(directory, filename(0)), 'utf8')).toBe('existing first evidence')
  expect(await readFile(path.join(directory, 'unrelated.json'), 'utf8')).toBe('unrelated')
  expect(JSON.parse(await readFile(path.join(directory, filename(1)), 'utf8')).diagnostic.nativeErrorCode).toBe(5)
})

it('bounds admitted files while a write never completes without making unrelated failure handling wait', async () => {
  const started = deferred(), release = deferred()
  const { directory, log } = await fixture({ openFile: async file => {
    const owned = await openOwned(file)
    return { ...owned, write: async (bytes, position) => { started.resolve(); await release.promise; return owned.write(bytes, position) } }
  } })
  log.record(diagnostic(), context()); await started.promise
  for (let i = 0; i < 1000; i++) log.record(diagnostic(), context())
  await expect((async () => { log.record(diagnostic(), context()); return 'revoked-and-lease-closed' })()).resolves.toBe('revoked-and-lease-closed')
  release.resolve(); await log.settled()
  expect(await readdir(directory)).toHaveLength(8)
  for (const file of await readdir(directory)) expect((await stat(path.join(directory, file))).size).toBeLessThanOrEqual(36 * 1024)
})

it('completes partial writes without duplicate bytes and closes its owned handle', async () => {
  let closes = 0
  const { directory, log } = await fixture({ openFile: async file => {
    const owned = await openOwned(file)
    return { write: (bytes, position) => owned.write(bytes.subarray(0, 7), position), close: async () => { closes++; await owned.close() } }
  } })
  log.record(diagnostic(), context()); await log.settled()
  expect(JSON.parse(await readFile(path.join(directory, filename(0)), 'utf8')).diagnostic.nativeErrorCode).toBe(32)
  expect(closes).toBe(1)
})

it.each(['EACCES', 'ENOSPC', 'zero-write'] as const)('swallows %s without a retry or rejected diagnostic promise', async failure => {
  let closes = 0, writes = 0
  const { log } = await fixture({ openFile: async () => {
    if (failure === 'EACCES') throw Object.assign(new Error('PRIVATE'), { code: failure })
    return { write: async () => { writes++; if (failure === 'ENOSPC') throw Object.assign(new Error('PRIVATE'), { code: failure }); return 0 }, close: async () => { closes++ } }
  } })
  expect(() => log.record(diagnostic(), context())).not.toThrow()
  await expect(log.settled()).resolves.toBeUndefined()
  expect(writes).toBe(failure === 'EACCES' ? 0 : 1); expect(closes).toBe(failure === 'EACCES' ? 0 : 1)
})
