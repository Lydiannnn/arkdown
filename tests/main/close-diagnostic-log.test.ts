// @vitest-environment node
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CloseDiagnosticEvent } from '../../src/shared/close-diagnostics'
import type { CloseDiagnosticFile, CloseDiagnosticLog, CloseDiagnosticLogOptions } from '../../src/main/close/close-diagnostic-log'

const modulePath = '../../src/main/close/close-diagnostic-log'
const implementation = await import(modulePath).catch(() => ({})) as typeof import('../../src/main/close/close-diagnostic-log')
const roots: string[] = []
const logs: CloseDiagnosticLog[] = []
const instanceId = '550e8400-e29b-41d4-a716-446655440000'
const otherId = '550e8400-e29b-41d4-a716-446655440099'
const filename = (id: string, slot: number) => `arkdown-close-${id}.${slot}.jsonl`
const event = (counter = 100_000_000): CloseDiagnosticEvent => ({
  version: '1.0.4', platform: 'win32', windowId: instanceId,
  attemptId: '550e8400-e29b-41d4-a716-446655440001', stage: 'drain-ipc', event: 'exit',
  stageElapsedMs: counter, dirty: false, pending: { ipc: 1 }, errorCode: null,
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function openOwned(file: string): Promise<CloseDiagnosticFile> {
  const handle = await open(file, 'wx', 0o600)
  return {
    write: async (bytes, position) => (await handle.write(bytes, 0, bytes.byteLength, position)).bytesWritten,
    truncate: () => handle.truncate(0), close: () => handle.close(),
  }
}
async function fixture(options: Partial<CloseDiagnosticLogOptions> = {}, existingRoot?: string) {
  expect(implementation.createCloseDiagnosticLog).toBeTypeOf('function')
  const root = existingRoot ?? await mkdtemp(path.join(tmpdir(), 'arkdown-close-diagnostic-'))
  if (!existingRoot) roots.push(root)
  const log = implementation.createCloseDiagnosticLog({ directory: root, instanceId, ...options })
  logs.push(log)
  return { root, log }
}
afterEach(async () => {
  for (const log of logs.splice(0)) { log.dispose(); await log.settled() }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function lines(root: string, id = instanceId): Promise<CloseDiagnosticEvent[]> {
  const files = (await readdir(root)).filter(name => [0, 1, 2].some(slot => name === filename(id, slot)))
  const content = await Promise.all(files.map(name => readFile(path.join(root, name), 'utf8')))
  return content.flatMap(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
}

describe('bounded best-effort close diagnostic log', () => {
  it('writes accepted immutable snapshots in enqueue order using exclusive instance files', async () => {
    const { root, log } = await fixture()
    const first = event()
    expect(log.record(first)).toBeUndefined()
    first.stageElapsedMs = 99
    log.record(event(100_000_001)); log.record(event(100_000_002))
    await log.settled()
    expect((await lines(root)).map(row => row.stageElapsedMs)).toEqual([100_000_000, 100_000_001, 100_000_002])
    expect(await readdir(root)).toEqual([filename(instanceId, 0)])
  })

  it('never sends private or malformed input to disk', async () => {
    const { root, log } = await fixture()
    log.record({ ...event(), stack: 'PRIVATE synthetic path' })
    log.record({ ...event(), errorCode: 'PRIVATE secret' })
    log.record({ ...event(), version: `1.0.4-${'界'.repeat(1000)}` })
    const input = event(); Object.defineProperty(input, 'version', { get() { throw new Error('PRIVATE') } })
    expect(() => log.record(input)).not.toThrow()
    await log.settled()
    expect(await readdir(root)).toEqual([])
  })

  it.each(['events', 'bytes'] as const)('bounds queued and in-flight %s while a filesystem operation never completes', async limit => {
    const started = deferred(); const release = deferred()
    const { root, log } = await fixture({ openFile: async file => { started.resolve(); await release.promise; return openOwned(file) } })
    const input = limit === 'events' ? event() : { ...event(), version: `1.0.4-${'x'.repeat(58)}`,
      pending: { editor: 9007199254740991, document: 9007199254740991, draft: 9007199254740991, preferences: 9007199254740991,
        owner: 9007199254740991, ai: 9007199254740991, ipc: 9007199254740991, 'window-settings': 9007199254740991,
        cleanup: 9007199254740991, restore: 9007199254740991 } }
    log.record(input); await started.promise
    for (let index = 0; index < 10_000; index++) log.record(input)
    // This unrelated close/save result cannot depend on the diagnostic I/O promise.
    await expect((async () => { log.record(input); return 'synthetic-save-committed' })()).resolves.toBe('synthetic-save-committed')
    release.resolve(); await log.settled()
    const rowBytes = Buffer.byteLength(JSON.stringify(input) + '\n', 'utf8')
    expect(rowBytes > 512).toBe(limit === 'bytes')
    expect((await lines(root)).length).toBe(Math.min(implementation.CLOSE_DIAGNOSTIC_QUEUE_MAX_EVENTS,
      Math.floor(implementation.CLOSE_DIAGNOSTIC_QUEUE_MAX_BYTES / rowBytes)))
    log.record(event(100_000_001)); await log.settled()
    expect((await lines(root)).at(-1)?.stageElapsedMs).toBe(100_000_001)
  })

  it('drains a record enqueued at the end of the previous write without requiring another record', async () => {
    const written = deferred()
    const { root, log } = await fixture({ openFile: async file => {
      const owned = await openOwned(file)
      return { ...owned, write: async (bytes, position) => {
        const count = await owned.write(bytes, position); written.resolve(); return count
      } }
    } })
    log.record(event()); await written.promise
    await Promise.resolve(); await Promise.resolve()
    log.record(event(100_000_001))
    await log.settled()
    expect((await lines(root)).map(row => row.stageElapsedMs)).toEqual([100_000_000, 100_000_001])
  })

  it('closes its handle when disposed just after the final write completes', async () => {
    const written = deferred(); let closes = 0
    const { log } = await fixture({ openFile: async file => {
      const owned = await openOwned(file)
      return { ...owned, write: async (bytes, position) => {
        const count = await owned.write(bytes, position); written.resolve(); return count
      }, close: async () => { closes++; await owned.close() } }
    } })
    log.record(event()); await written.promise
    await Promise.resolve(); await Promise.resolve()
    log.dispose(); await log.settled()
    expect(closes).toBe(1)
  })

  it('rotates only its three owned segments at the actual 256 KiB byte bound', async () => {
    const { root, log } = await fixture()
    const unrelated = [filename(otherId, 0), `${filename(instanceId, 0)}.backup`, 'settings.json']
    for (const name of unrelated) await writeFile(path.join(root, name), 'PRIVATE other owner', 'utf8')
    const rowBytes = Buffer.byteLength(JSON.stringify(event()) + '\n', 'utf8')
    const count = Math.floor((256 * 1024) / rowBytes) * 3 + 10
    for (let index = 0; index < count; index++) {
      log.record(event(100_000_000 + index))
      if (index % 32 === 31) await log.settled()
    }
    await log.settled()
    const own = (await readdir(root)).filter(name => [0, 1, 2].some(slot => name === filename(instanceId, slot)))
    expect(own).toHaveLength(3)
    for (const name of own) expect((await stat(path.join(root, name))).size).toBeLessThanOrEqual(256 * 1024)
    const retained = await lines(root)
    expect(retained.some(row => row.stageElapsedMs === 100_000_000)).toBe(false)
    expect(retained.some(row => row.stageElapsedMs === 100_000_000 + count - 1)).toBe(true)
    for (const name of unrelated) expect(await readFile(path.join(root, name), 'utf8')).toBe('PRIVATE other owner')
    expect((await readdir(root)).length).toBe(6)
  }, 15_000)

  it('keeps two concurrent instances separate in the same diagnostics directory', async () => {
    const first = await fixture()
    const second = await fixture({ instanceId: otherId }, first.root)
    first.log.record(event()); second.log.record(event(100_000_001))
    await Promise.all([first.log.settled(), second.log.settled()])
    expect((await lines(first.root)).map(row => row.stageElapsedMs)).toEqual([100_000_000])
    expect((await lines(first.root, otherId)).map(row => row.stageElapsedMs)).toEqual([100_000_001])
  })

  it('does not adopt or overwrite a pre-existing file with a colliding instance name', async () => {
    const { root, log } = await fixture()
    await writeFile(path.join(root, filename(instanceId, 0)), 'PRIVATE existing owner', 'utf8')
    expect(() => log.record(event())).not.toThrow()
    await expect(log.settled()).resolves.toBeUndefined()
    log.record(event()); await log.settled()
    expect(await readFile(path.join(root, filename(instanceId, 0)), 'utf8')).toBe('PRIVATE existing owner')
  })

  it('finishes partial writes without losing or duplicating bytes', async () => {
    const { root, log } = await fixture({ openFile: async file => {
      const owned = await openOwned(file)
      return { ...owned, write: (bytes, position) => owned.write(bytes.subarray(0, 7), position) }
    } })
    log.record(event()); log.record(event(100_000_001)); await log.settled()
    expect((await lines(root)).map(row => row.stageElapsedMs)).toEqual([100_000_000, 100_000_001])
  })

  it('stops after a write with an unknown partial result without rejecting or replaying it', async () => {
    let calls = 0
    const { root, log } = await fixture({ openFile: async file => {
      const owned = await openOwned(file)
      return { ...owned, write: async (bytes, position) => {
        calls++; await owned.write(bytes.subarray(0, 7), position)
        throw new Error('PRIVATE disk failure')
      } }
    } })
    log.record(event()); log.record(event(100_000_001))
    await expect(log.settled()).resolves.toBeUndefined()
    log.record(event(100_000_002)); await log.settled()
    expect(calls).toBe(1)
    expect((await stat(path.join(root, filename(instanceId, 0)))).size).toBe(7)
  })

  it('isolates rotation failure and never creates a fourth segment or retries truncation', async () => {
    let truncations = 0
    const { root, log } = await fixture({ openFile: async file => {
      const owned = await openOwned(file)
      return { ...owned, truncate: async () => { truncations++; throw new Error('PRIVATE rotation failure') } }
    } })
    const count = Math.floor((256 * 1024) / Buffer.byteLength(JSON.stringify(event()) + '\n')) * 3 + 2
    for (let index = 0; index < count; index++) {
      log.record(event()); if (index % 32 === 31) await log.settled()
    }
    await expect(log.settled()).resolves.toBeUndefined()
    log.record(event()); await log.settled()
    expect(truncations).toBe(1)
    expect(await readdir(root)).toHaveLength(3)
    for (const name of await readdir(root)) expect((await stat(path.join(root, name))).size).toBeLessThanOrEqual(256 * 1024)
  }, 15_000)

  it('disposes without waiting for pending I/O, drops queued work and closes owned handles once it settles', async () => {
    const started = deferred(); const release = deferred(); let closes = 0
    const { root, log } = await fixture({ openFile: async file => {
      const owned = await openOwned(file)
      return { ...owned, write: async (bytes, position) => { started.resolve(); await release.promise; return owned.write(bytes, position) },
        close: async () => { closes++; await owned.close() } }
    } })
    log.record(event()); await started.promise; log.record(event(100_000_001))
    expect(log.dispose()).toBeUndefined()
    log.record(event(100_000_002)); release.resolve(); await log.settled(); log.dispose()
    expect(closes).toBe(1)
    expect((await lines(root)).map(row => row.stageElapsedMs)).toEqual([100_000_000])
  })

  it('tolerates directory creation failure and refuses a path-like instance identity', async () => {
    const { root } = await fixture()
    const unavailable = path.join(root, 'not-a-directory'); await writeFile(unavailable, 'synthetic', 'utf8')
    const failed = await fixture({ directory: unavailable }, root)
    const invalid = await fixture({ instanceId: '../outside' }, root)
    failed.log.record(event()); invalid.log.record(event())
    await expect(failed.log.settled()).resolves.toBeUndefined()
    await expect(invalid.log.settled()).resolves.toBeUndefined()
    expect(await readdir(root)).toEqual(['not-a-directory'])
  })
})
