import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createScreenshotOcrModelManager, type ScreenshotOcrModelManagerOptions } from '../../src/main/screenshot-translation/screenshot-ocr-model-manager'
import { createLazyScreenshotOcrModelManager } from '../../src/main/screenshot-translation/lazy-screenshot-ocr-model-manager'
import { DEFAULT_SETTINGS } from '../../src/main/settings/settings-store'

const roots: string[] = []
const observed = { revision: 0, preferredTier: 'medium' as const, tierRevision: 0 }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function options(): Promise<ScreenshotOcrModelManagerOptions> {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'arkdown-lazy-ocr-'))
  roots.push(dataRoot)
  const snapshot = { settings: { ...structuredClone(DEFAULT_SETTINGS), screenshotOcr: { preferredTier: 'medium' as const } },
    revision: 0, minimumBaseRevision: 0, fieldRevisions: { fields: {}, connections: {}, tombstones: {} } }
  return { dataRoot, processIdentity: 'test-process', processIdentityMatches: () => 'dead-or-mismatch',
    settings: { readFresh: async () => structuredClone(snapshot), getDisplaySnapshot: () => structuredClone(snapshot),
      apply: async () => { throw new Error('No mutation expected') } } }
}

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('lazy screenshot OCR manager', () => {
  it('captures the supplied observation before asynchronous initialization can yield to caller changes', async () => {
    const start = gate()
    const remove = vi.fn()
    const value = createLazyScreenshotOcrModelManager(await options(), async input => {
      await start.promise
      const real = await createScreenshotOcrModelManager(input)
      remove.mockImplementation(async () => real.getState())
      return { ...real, removeMedium: remove }
    })
    const input = { ...observed }
    const pending = value.removeMedium(input)
    input.revision = 8; input.tierRevision = 8
    start.resolve()
    await pending
    expect(remove).toHaveBeenCalledWith(observed)
    await value.dispose()
  })
  it('does not touch model storage for snapshots or disposal before first use', async () => {
    const config = await options()
    const value = createLazyScreenshotOcrModelManager(config)
    const snapshot = value.getState()
    expect(snapshot).toMatchObject({ activeTier: 'small', status: 'bundled-small', mediumVersion: null })
    snapshot.activeTier = 'medium'
    expect(value.getState().activeTier).toBe('small')
    expect(await readdir(config.dataRoot)).toEqual([])
    await value.dispose()
    expect(await readdir(config.dataRoot)).toEqual([])
  })

  it('shares first initialization across all consumers and publishes its validated state', async () => {
    const config = await options()
    const start = gate()
    const states: string[] = []
    let starts = 0
    const value = createLazyScreenshotOcrModelManager({ ...config, onState: state => { states.push(state.status) } }, async (input) => {
      starts += 1
      await start.promise
      return createScreenshotOcrModelManager(input)
    })
    const pending = Promise.all([value.initialize(), value.acquireTier(), value.resolveActiveTier(),
      value.resolveActiveResource('medium-det.tar'), value.cancelMediumDownload(), value.reportTierUnavailable('medium')])
    await Promise.resolve()
    expect(starts).toBe(1)
    expect(await readdir(config.dataRoot)).toEqual([])
    start.resolve()
    const [, lease, tier, resource, state] = await pending
    expect(lease.tier).toBe('small')
    expect(tier).toBe('small')
    expect(resource).toBeUndefined()
    expect(state.status).toBe('medium-absent')
    expect(states).toEqual(['medium-absent'])
    expect(value.getState().status).toBe('medium-absent')
    lease.release()
    await value.dispose()
  })

  it('waits for a pending factory on disposal, blocks its consumers, and disposes exactly once', async () => {
    const config = await options()
    const start = gate()
    let disposals = 0
    let emitted = 0
    const value = createLazyScreenshotOcrModelManager({ ...config, onState: () => { emitted += 1 } }, async input => {
      await start.promise
      const real = await createScreenshotOcrModelManager(input)
      return { ...real, dispose: async () => { disposals += 1; await real.dispose() } }
    })
    const consumer = expect(value.acquireTier()).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    let settled = false
    const disposal = value.dispose().then(() => { settled = true })
    const again = value.dispose()
    await Promise.resolve()
    expect(settled).toBe(false)
    start.resolve()
    await Promise.all([consumer, disposal, again])
    expect(disposals).toBe(1)
    expect(emitted).toBe(0)
  })

  it('rejects every operational call after disposal without constructing the manager', async () => {
    const config = await options()
    const value = createLazyScreenshotOcrModelManager(config)
    await value.dispose()
    for (const pending of [value.initialize(), value.acquireTier(), value.resolveActiveTier(),
      value.resolveActiveResource('medium-det.tar'), value.downloadMedium(observed), value.removeMedium(observed),
      value.cancelMediumDownload(), value.reportTierUnavailable('medium')]) {
      await expect(pending).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    }
    expect(await readdir(config.dataRoot)).toEqual([])
  })

  it('keeps a failed initialization in the shared flight and permits disposal', async () => {
    let starts = 0
    const failure = new Error('initialization failed')
    const value = createLazyScreenshotOcrModelManager(await options(), async () => { starts += 1; throw failure })
    await expect(value.downloadMedium(observed)).rejects.toBe(failure)
    await expect(value.removeMedium(observed)).rejects.toBe(failure)
    expect(starts).toBe(1)
    await value.dispose()
  })

  it('does not acquire a new lease when shutdown wins the ready-manager continuation', async () => {
    const value = createLazyScreenshotOcrModelManager(await options(), createScreenshotOcrModelManager)
    await value.initialize()
    const lease = value.acquireTier()
    const shutdown = Promise.resolve().then(() => value.dispose())
    await expect(lease).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    await shutdown
  })
})
