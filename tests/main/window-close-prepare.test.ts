import { afterEach, expect, it, vi } from 'vitest'
import { installWindowBoundsSaveOnClose, type WindowCloseOptions } from '../../src/main/settings/window-bounds-close'

const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).forEach(stop => stop()); vi.useRealTimers() })

class FakeWindow {
  closeCalls = 0
  listener?: (event: { defaultPrevented: boolean; preventDefault(): void }) => void
  on(_event: 'close', listener: NonNullable<FakeWindow['listener']>): void { this.listener = listener }
  getSize() { return [1200, 800] }
  getPosition() { return [80, 60] }
  readonly focus = vi.fn()
  close(): void { this.closeCalls += 1 }
  triggerClose() {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    this.listener?.(event)
    return event
  }
}
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function setup(overrides: Partial<WindowCloseOptions> = {}) {
  const window = new FakeWindow()
  const options = {
    saveWindowBounds: vi.fn(async () => undefined),
    reportError: vi.fn(),
    prepareRendererClose: vi.fn(async () => ({ status: 'ready' as const })),
    closeGate: { pauseAndDrain: vi.fn(async () => undefined), resume: vi.fn(async (beforeAdmission?: () => void | Promise<void>) => { await beforeAdmission?.() }) },
    closeOwnedResources: vi.fn(async () => undefined),
    abortOwnedResourcesClose: vi.fn(async () => undefined),
    finalizeClose: vi.fn(async () => undefined),
    notify: vi.fn(),
    ...overrides,
  }
  const close = installWindowBoundsSaveOnClose(window, options)
  cleanups.push(() => close.dispose())
  return { window, options, close }
}
it.each([false, true])('waits verified port recovery before restoring AI admission and editor focus (failure: %s)', async fail => {
  const verification = deferred()
  const restorePreparation = vi.fn(async () => undefined)
  const resume = vi.fn(async (beforeAdmission?: () => void | Promise<void>) => {
    await verification.promise
    await beforeAdmission?.()
  })
  const { window, close } = setup({ saveWindowBounds: async () => { throw new Error('synthetic save failure') },
    restorePreparation, closeGate: { pauseAndDrain: async () => undefined, resume } })
  window.triggerClose()
  await vi.waitFor(() => expect(close.snapshot()?.state).toBe('failed'))
  const returning = close.returnToEditor()
  await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce())
  expect(restorePreparation).not.toHaveBeenCalled()
  expect(window.focus).not.toHaveBeenCalled()
  if (fail) verification.reject(new Error('synthetic workspace changed'))
  else verification.resolve()
  expect(await returning).toBe(!fail)
  expect(restorePreparation).toHaveBeenCalledTimes(fail ? 0 : 1)
  expect(window.focus).toHaveBeenCalledTimes(fail ? 0 : 1)
})

it('binds renderer preparation to the single main attempt and orders durable phases', async () => {
  const ready = deferred<{ status: 'ready' }>()
  const prepare = vi.fn(() => ready.promise)
  const { window, options, close } = setup({ prepareRendererClose: prepare })
  expect(window.triggerClose().defaultPrevented).toBe(true)
  window.triggerClose()
  expect(prepare).toHaveBeenCalledOnce()
  expect(prepare).toHaveBeenCalledWith(expect.any(Object), { attemptId: close.snapshot()!.attemptId, generation: 1 })
  expect(options.closeGate.pauseAndDrain).not.toHaveBeenCalled()
  ready.resolve({ status: 'ready' })
  await vi.waitFor(() => expect(window.closeCalls).toBe(1))
  const steps = [prepare, options.closeOwnedResources, options.closeGate.pauseAndDrain, options.saveWindowBounds, options.finalizeClose]
  const order = steps.map(step => vi.mocked(step).mock.invocationCallOrder[0])
  expect(order).toEqual([...order].sort((a, b) => a! - b!))
  expect(options.saveWindowBounds).toHaveBeenCalledWith({ width: 1200, height: 800, x: 80, y: 60 })
  expect(close.snapshot()!.state).toBe('awaiting-native-close')
  close.closed()
  expect(close.snapshot()!.state).toBe('closed')
})
it('does not release pending owner work or IPC drain because wall time elapsed', async () => {
  vi.useFakeTimers()
  const owner = deferred()
  const ipc = deferred()
  const { window, options, close } = setup({ closeOwnedResources: () => owner.promise, closeGate: { pauseAndDrain: () => ipc.promise, resume: vi.fn() } })
  window.triggerClose()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(close.snapshot()).toMatchObject({ state: 'running', canRetry: false, canReturn: false, progress: { stage: 'quiesce-owner', feedback: 'long-wait' } })
  expect(options.abortOwnedResourcesClose).not.toHaveBeenCalled()
  expect(window.closeCalls).toBe(0)
  owner.resolve()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(close.snapshot()).toMatchObject({ state: 'running', progress: { stage: 'drain-ipc' } })
  expect(options.closeGate.resume).not.toHaveBeenCalled()
  expect(options.saveWindowBounds).not.toHaveBeenCalled()
  ipc.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(window.closeCalls).toBe(1)
})
it('retains a failed attempt until explicit retry restores gates, without duplicate saves on close', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('private disk error')).mockResolvedValue(undefined)
  const { window, options, close } = setup({ saveWindowBounds: save })
  window.triggerClose()
  await vi.waitFor(() => expect(close.snapshot()?.state).toBe('failed'))
  expect(close.snapshot()).toMatchObject({ error: 'window-settings-failed', canRetry: true, canReturn: true })
  expect(options.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: 'window-settings-failed' }))
  expect(options.closeGate.resume).not.toHaveBeenCalled()
  window.triggerClose()
  expect(save).toHaveBeenCalledOnce()
  await close.retry()
  await vi.waitFor(() => expect(window.closeCalls).toBe(1))
  expect(options.abortOwnedResourcesClose).toHaveBeenCalledOnce()
  expect(options.closeGate.resume).toHaveBeenCalledOnce()
  expect(save).toHaveBeenCalledTimes(2)
})
it('never closes or restores partially disposed resources after a failed irreversible finalizer', async () => {
  const { window, options, close } = setup({ finalizeClose: vi.fn(async () => { throw new Error('cleanup failed') }), reportError: () => { throw new Error('sink failed') } })
  window.triggerClose()
  await vi.waitFor(() => expect(close.snapshot()?.error).toBe('cleanup-failed'))
  expect(window.closeCalls).toBe(0)
  expect(close.snapshot()).toMatchObject({ canReturn: false, canRetry: false })
  expect(await close.returnToEditor()).toBe(false)
  expect(options.abortOwnedResourcesClose).not.toHaveBeenCalled()
  expect(options.closeGate.resume).not.toHaveBeenCalled()
})
it('allows a later native-only retry and scopes native bypass to the actual synchronous close call', async () => {
  const { window, options, close } = setup()
  let nativeEvents = 0
  window.close = vi.fn(() => {
    expect(window.triggerClose().defaultPrevented).toBe(false)
    nativeEvents++
    if (nativeEvents === 1) throw new Error('native close failed')
  })
  window.triggerClose()
  await vi.waitFor(() => expect(close.snapshot()?.error).toBe('native-close-failed'))
  expect(window.triggerClose().defaultPrevented).toBe(true)
  expect(nativeEvents).toBe(1)
  await close.retry()
  expect(nativeEvents).toBe(2)
  expect(options.finalizeClose).toHaveBeenCalledOnce()
  expect(options.saveWindowBounds).toHaveBeenCalledOnce()
})
it.each(['cancelled', 'failed', 'blocked'] as const)('distinguishes preparation %s from permission to close', async status => {
  const { window, options, close } = setup({ prepareRendererClose: async () => status === 'cancelled' ? { status } : { status, code: 'editor-unavailable' } })
  window.triggerClose()
  await vi.waitFor(() => expect(close.snapshot()?.state).toBe(status === 'cancelled' ? 'cancelled' : 'failed'))
  expect(window.closeCalls).toBe(0)
  expect(options.closeOwnedResources).not.toHaveBeenCalled()
  expect(options.saveWindowBounds).not.toHaveBeenCalled()
  expect(close.snapshot()?.canReturn).toBe(status === 'failed')
})
it('does not supersede a close prevented by the tray owner', () => {
  const { window, options } = setup()
  window.listener?.({ defaultPrevented: true, preventDefault: vi.fn() })
  expect(options.prepareRendererClose).not.toHaveBeenCalled()
})
