import { afterEach, describe, expect, it, vi } from 'vitest'
import * as module from '../../src/main/close/close-attempt-coordinator'

afterEach(() => vi.useRealTimers())

it('binds preparation to immutable attempt identity and treats renderer loss as feedback only', async () => {
  const first = deferred<module.ClosePreparationResult>()
  const prepare = vi.fn((_progress: module.ClosePreparationProgress, _attempt: { attemptId: string; generation: number }) => first.promise)
  const { coordinator, options } = setup({ prepare })
  coordinator.requestClose()
  const [progress, attempt] = prepare.mock.calls[0]!
  expect(attempt).toEqual({ attemptId: coordinator.snapshot()!.attemptId, generation: 1 })
  expect(Object.isFrozen(attempt)).toBe(true)
  progress.unavailable('renderer-process-gone')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(coordinator.snapshot()).toMatchObject({ state: 'running', rendererUnavailable: 'renderer-process-gone', canRetry: false, canReturn: false })
  expect(options.quiesceOwner).not.toHaveBeenCalled()
  first.resolve({ status: 'cancelled' })
  await vi.advanceTimersByTimeAsync(0)
  coordinator.requestClose()
  const second = prepare.mock.calls[1]![1]
  expect(second).toEqual({ attemptId: 'attempt-2', generation: 2 })
  progress.unavailable('renderer-destroyed')
  expect(coordinator.snapshot()!.rendererUnavailable).toBeNull()
  coordinator.dispose()
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup(overrides: Record<string, unknown> = {}) {
  vi.useFakeTimers()
  let serial = 0
  const options = {
    prepare: vi.fn(async () => ({ status: 'ready' as const })),
    quiesceOwner: vi.fn(async () => undefined),
    drainIpc: vi.fn(async () => undefined),
    persistWindow: vi.fn(async () => undefined),
    finalize: vi.fn(async () => undefined),
    nativeClose: vi.fn(),
    restore: vi.fn(async () => undefined),
    notify: vi.fn(),
    createAttemptId: () => `attempt-${++serial}`,
    now: () => Date.now(),
    ...overrides,
  }
  expect(module.CloseAttemptCoordinator).toBeTypeOf('function')
  const coordinator = new module.CloseAttemptCoordinator(options)
  return { coordinator, options }
}

describe('single-owner safe close attempts', () => {
  it('orders all settled phases and waits for an actual closed event', async () => {
    const { coordinator, options } = setup()
    coordinator.requestClose()
    await vi.advanceTimersByTimeAsync(0)
    expect(options.prepare).toHaveBeenCalledOnce()
    const steps = [options.prepare, options.quiesceOwner, options.drainIpc, options.persistWindow, options.finalize, options.nativeClose]
    expect(steps.map(step => step.mock.invocationCallOrder[0])).toEqual([...steps].map(step => step.mock.invocationCallOrder[0]).sort((a, b) => a! - b!))
    expect(coordinator.snapshot()).toMatchObject({ state: 'awaiting-native-close', canReturn: false })
    coordinator.closed()
    expect(coordinator.snapshot()).toMatchObject({ state: 'closed' })
    coordinator.requestClose()
    expect(options.prepare).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows no-progress despite heartbeat but never releases a pending save on timeout or repeat close', async () => {
    const save = deferred<{ status: 'ready' }>()
    let preparation: module.ClosePreparationProgress | undefined
    const { coordinator, options } = setup({ prepare: vi.fn((context: module.ClosePreparationProgress) => {
      preparation = context
      context.enter('settle-document')
      return save.promise
    }) })
    coordinator.requestClose()
    await vi.advanceTimersByTimeAsync(12_000)
    preparation!.heartbeat()
    coordinator.requestClose()
    expect(coordinator.snapshot()).toMatchObject({ state: 'running', canRetry: false, canReturn: false, progress: { stage: 'settle-document', feedback: 'no-progress' } })
    expect(await coordinator.retry()).toBe(false)
    expect(await coordinator.returnToEditor()).toBe(false)
    expect(options.prepare).toHaveBeenCalledOnce()
    expect(options.restore).not.toHaveBeenCalled()
    expect(options.nativeClose).not.toHaveBeenCalled()
    save.resolve({ status: 'ready' })
    await vi.advanceTimersByTimeAsync(0)
    expect(options.nativeClose).toHaveBeenCalledOnce()
    coordinator.closed()
  })

  it('keeps a long user choice alive and treats explicit cancel without an error', async () => {
    const decision = deferred<{ status: 'cancelled' }>()
    const { coordinator, options } = setup({ prepare: vi.fn((context: module.ClosePreparationProgress) => {
      context.enter('await-user'); return decision.promise
    }) })
    coordinator.requestClose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(coordinator.snapshot()).toMatchObject({ progress: { feedback: 'await-user' }, canRetry: false })
    decision.resolve({ status: 'cancelled' })
    await vi.advanceTimersByTimeAsync(0)
    expect(coordinator.snapshot()).toMatchObject({ state: 'cancelled', error: null })
    expect(coordinator.snapshot()!.progress.pending).toEqual({})
    expect(options.restore).toHaveBeenCalledOnce()
    expect(options.quiesceOwner).not.toHaveBeenCalled()
    coordinator.dispose()
  })

  it.each(['quiesceOwner', 'drainIpc'])('retains pending %s and only permits recovery after its real rejection', async (phase) => {
    const work = deferred()
    const { coordinator, options } = setup({ [phase]: vi.fn(() => work.promise) })
    coordinator.requestClose()
    await vi.advanceTimersByTimeAsync(35_000)
    expect(coordinator.snapshot()).toMatchObject({ state: 'running', canReturn: false, progress: { feedback: 'long-wait' } })
    expect(options.restore).not.toHaveBeenCalled()
    work.reject(new Error('private path and stack must stay out of snapshot'))
    await vi.advanceTimersByTimeAsync(0)
    expect(coordinator.snapshot()).toMatchObject({ state: 'failed', canReturn: true, canRetry: true })
    expect(JSON.stringify(coordinator.snapshot())).not.toContain('private path')
    expect(await coordinator.returnToEditor()).toBe(true)
    expect(options.restore).toHaveBeenCalledOnce()
    expect(options.finalize).not.toHaveBeenCalled()
    coordinator.dispose()
  })

  it('does not restart before restoration settles, and drops an old preparation callback after retry', async () => {
    const restoration = deferred()
    const contexts: module.ClosePreparationProgress[] = []
    const prepare = vi.fn(async (context: module.ClosePreparationProgress) => {
      contexts.push(context)
      return contexts.length === 1 ? { status: 'failed' as const, code: 'document-save-failed' as const } : new Promise<module.ClosePreparationResult>(() => {})
    })
    const { coordinator, options } = setup({ prepare, restore: vi.fn(() => restoration.promise) })
    coordinator.requestClose()
    await vi.advanceTimersByTimeAsync(0)
    const retry = coordinator.retry()
    expect(await coordinator.retry()).toBe(false)
    coordinator.requestClose()
    expect(prepare).toHaveBeenCalledOnce()
    restoration.resolve()
    expect(await retry).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(prepare).toHaveBeenCalledTimes(2)
    contexts[0]!.enter('await-user')
    contexts[0]!.heartbeat()
    expect(coordinator.snapshot()).toMatchObject({ attemptId: 'attempt-2', progress: { stage: 'prepare-editor', rendererAliveAt: null } })
    expect(options.nativeClose).not.toHaveBeenCalled()
    coordinator.dispose()
  })

  it('blocks after irreversible finalizer failure and never resumes or retries partially disposed resources', async () => {
    const { coordinator, options } = setup({ finalize: vi.fn(async () => { throw new Error('failure') }) })
    coordinator.requestClose()
    await vi.advanceTimersByTimeAsync(0)
    expect(coordinator.snapshot()).toMatchObject({ state: 'failed', error: 'cleanup-failed', canReturn: false, canRetry: false })
    expect(await coordinator.returnToEditor()).toBe(false)
    expect(await coordinator.retry()).toBe(false)
    coordinator.requestClose()
    expect(options.finalize).toHaveBeenCalledOnce()
    expect(options.restore).not.toHaveBeenCalled()
    expect(options.nativeClose).not.toHaveBeenCalled()
    coordinator.dispose()
  })

  it('retries only the native close call after finalization and survives a broken diagnostic listener', async () => {
    const nativeClose = vi.fn().mockImplementationOnce(() => { throw new Error('native') })
    const { coordinator, options } = setup({ nativeClose, notify: vi.fn(() => { throw new Error('observer') }) })
    coordinator.requestClose()
    await vi.advanceTimersByTimeAsync(0)
    expect(coordinator.snapshot()).toMatchObject({ state: 'failed', error: 'native-close-failed', canReturn: false, canRetry: true })
    expect(await coordinator.retry()).toBe(true)
    expect(nativeClose).toHaveBeenCalledTimes(2)
    expect(options.prepare).toHaveBeenCalledOnce()
    expect(options.finalize).toHaveBeenCalledOnce()
    expect(options.restore).not.toHaveBeenCalled()
    coordinator.closed()
  })

  it('does not advance a disposed coordinator when a pending operation later succeeds', async () => {
    const work = deferred()
    const { coordinator, options } = setup({ quiesceOwner: vi.fn(() => work.promise) })
    coordinator.requestClose()
    await vi.advanceTimersByTimeAsync(0)
    coordinator.dispose()
    work.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(options.drainIpc).not.toHaveBeenCalled()
    expect(options.nativeClose).not.toHaveBeenCalled()
    expect(options.restore).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps native retry waiting visible until the native closed event really arrives', async () => {
    const nativeClose = vi.fn().mockImplementationOnce(() => { throw new Error('native') })
    const { coordinator, options } = setup({ nativeClose })
    coordinator.requestClose()
    await vi.advanceTimersByTimeAsync(0)
    expect(await coordinator.retry()).toBe(true)
    options.notify.mockClear()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(coordinator.snapshot()).toMatchObject({ state: 'awaiting-native-close', progress: { stage: 'native-close', feedback: 'long-wait' } })
    expect(options.notify).toHaveBeenCalled()
    coordinator.closed()
  })

  it('blocks all recovery for an unknown document result and does not retry a write', async () => {
    const { coordinator, options } = setup({ prepare: vi.fn(async () => ({ status: 'blocked', code: 'document-result-unknown' })) })
    coordinator.requestClose()
    await vi.advanceTimersByTimeAsync(0)
    expect(coordinator.snapshot()).toMatchObject({ state: 'failed', error: 'document-result-unknown', canReturn: false, canRetry: false })
    expect(await coordinator.retry()).toBe(false)
    expect(await coordinator.returnToEditor()).toBe(false)
    expect(options.restore).not.toHaveBeenCalled()
    expect(options.nativeClose).not.toHaveBeenCalled()
    coordinator.dispose()
  })

  it('does not silently restart if restoring a reversible gate itself fails', async () => {
    const { coordinator, options } = setup({ persistWindow: vi.fn(async () => { throw new Error('disk') }), restore: vi.fn(async () => { throw new Error('gate') }) })
    coordinator.requestClose()
    await vi.advanceTimersByTimeAsync(0)
    expect(await coordinator.retry()).toBe(false)
    expect(coordinator.snapshot()).toMatchObject({ state: 'failed', error: 'restore-failed', canReturn: false, canRetry: false })
    expect(options.prepare).toHaveBeenCalledOnce()
    expect(options.finalize).not.toHaveBeenCalled()
    coordinator.dispose()
  })

  it('blocks an unknown document result even if an adapter incorrectly labels it failed', async () => {
    const { coordinator, options } = setup({ prepare: vi.fn(async () => ({ status: 'failed', code: 'document-result-unknown' })) })
    coordinator.requestClose()
    await vi.advanceTimersByTimeAsync(0)
    expect(coordinator.snapshot()).toMatchObject({ error: 'document-result-unknown', canReturn: false, canRetry: false })
    expect(await coordinator.retry()).toBe(false)
    expect(await coordinator.returnToEditor()).toBe(false)
    expect(options.prepare).toHaveBeenCalledOnce()
    expect(options.restore).not.toHaveBeenCalled()
    coordinator.dispose()
  })

  it('prevents synchronous observer reentry from duplicating the native call or calling it after closed', async () => {
    let coordinator!: module.CloseAttemptCoordinator
    let attempted = false
    const nested: Promise<boolean>[] = []
    const fixture = setup({
      notify: (state: module.CloseAttemptSnapshot) => {
        if (state.state === 'awaiting-native-close' && !attempted) {
          attempted = true
          nested.push(coordinator.retry())
        }
      },
      nativeClose: vi.fn(() => coordinator.closed()),
    })
    coordinator = fixture.coordinator
    coordinator.requestClose()
    await vi.advanceTimersByTimeAsync(0)
    expect(await nested[0]).toBe(false)
    expect(fixture.options.nativeClose).toHaveBeenCalledOnce()
    expect(coordinator.snapshot()).toMatchObject({ state: 'closed' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['prepare-editor', 'persist-window', 'native-close', 'restore-editor'] as const)('does not start %s work after a notification disposes the owner', async stage => {
    let coordinator!: module.CloseAttemptCoordinator
    const fixture = setup({
      prepare: vi.fn(async () => ({ status: stage === 'restore-editor' ? 'cancelled' : 'ready' })),
      notify: (state: module.CloseAttemptSnapshot) => {
        if (state.progress.stage === stage || stage === 'restore-editor' && state.state === 'restoring') coordinator.dispose()
      },
    })
    coordinator = fixture.coordinator
    coordinator.requestClose()
    await vi.advanceTimersByTimeAsync(0)
    const operation = stage === 'prepare-editor' ? fixture.options.prepare : stage === 'persist-window' ? fixture.options.persistWindow
      : stage === 'restore-editor' ? fixture.options.restore : fixture.options.nativeClose
    expect(operation).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows a stalled restoration after an explicit user cancellation as machine work', async () => {
    const work = deferred()
    const { coordinator, options } = setup({
      prepare: vi.fn(async (context: module.ClosePreparationProgress) => {
        context.enter('await-user'); return { status: 'cancelled' }
      }), restore: vi.fn(() => work.promise),
    })
    coordinator.requestClose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(coordinator.snapshot()).toMatchObject({ state: 'restoring', canRetry: false, canReturn: false,
      progress: { stage: 'restore-editor', feedback: 'long-wait', pending: { restore: 1 } } })
    coordinator.requestClose()
    expect(options.restore).toHaveBeenCalledOnce()
    work.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(coordinator.snapshot()).toMatchObject({ state: 'cancelled', error: null })
    coordinator.dispose()
  })
})
