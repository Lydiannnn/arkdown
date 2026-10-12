import { expect, it, vi } from 'vitest'
import { createScreenshotResultCloseLifecycle } from '../../src/main/screenshot-translation/screenshot-result-close-lifecycle'
import type { CloseAttemptCoordinator } from '../../src/main/close/close-attempt-coordinator'
import type { ClosePreparationResult } from '../../src/shared/close-preparation'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
function harness() {
  let close!: (event: { preventDefault(): void }) => void, closed!: () => void
  let controller!: CloseAttemptCoordinator
  const requester = { prepare: vi.fn(async (): Promise<ClosePreparationResult> => ({ status: 'ready' })), isCurrent: vi.fn(() => true), dispose: vi.fn() }
  const finalize = vi.fn(async () => {})
  const window = { on: vi.fn((_event: string, callback: typeof close) => { close = callback }),
    once: vi.fn((_event: string, callback: typeof closed) => { closed = callback }),
    isDestroyed: vi.fn(() => false), focus: vi.fn(), destroy: vi.fn(() => closed()) }
  const feedback = { bind: vi.fn((value: CloseAttemptCoordinator) => { controller = value }), notify: vi.fn(), dispose: vi.fn() }
  const lifecycle = createScreenshotResultCloseLifecycle({ window, requester, finalize, feedback })
  return { lifecycle, requester, finalize, window, feedback, controller: () => controller,
    nativeClose: () => { const event = { preventDefault: vi.fn() }; close(event); return event } }
}

it('keeps native and parent close single flight until preferences and cleanup really settle', async () => {
  const h = harness(), prepared = deferred<ClosePreparationResult>(), drained = deferred<void>()
  h.requester.prepare.mockReturnValueOnce(prepared.promise); h.finalize.mockReturnValueOnce(drained.promise)
  const parent = h.lifecycle.requestClose()
  expect(h.nativeClose().preventDefault).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(h.requester.prepare).toHaveBeenCalledOnce())
  expect(h.window.destroy).not.toHaveBeenCalled()
  prepared.resolve({ status: 'ready' })
  await vi.waitFor(() => expect(h.finalize).toHaveBeenCalledOnce())
  expect(h.window.destroy).not.toHaveBeenCalled()
  expect(h.requester.dispose).not.toHaveBeenCalled()
  drained.resolve()
  expect(await parent).toBe(true)
  expect(h.window.destroy).toHaveBeenCalledOnce()
  expect(h.requester.dispose).toHaveBeenCalledOnce()
})

it('leaves a failed settings draft in its child and allows an explicit new close attempt', async () => {
  const h = harness()
  h.requester.prepare.mockResolvedValueOnce({ status: 'failed', code: 'preferences-save-failed' })
  expect(await h.lifecycle.requestClose()).toBe(false)
  expect(h.finalize).not.toHaveBeenCalled(); expect(h.window.destroy).not.toHaveBeenCalled()
  expect(await h.lifecycle.requestClose()).toBe(true)
  expect(h.requester.prepare).toHaveBeenCalledTimes(2)
})

it('does not bless an unknown renderer outcome or a timeout as successful cleanup', async () => {
  const h = harness()
  h.requester.prepare.mockResolvedValueOnce({ status: 'blocked', code: 'document-result-unknown' })
  let settled = false
  void h.lifecycle.requestClose().then(() => { settled = true })
  await vi.waitFor(() => expect(h.controller().snapshot()?.state).toBe('failed'))
  expect(h.controller().snapshot()?.canReturn).toBe(false)
  expect(settled).toBe(false); expect(h.finalize).not.toHaveBeenCalled()
  h.window.destroy() // Synthetic external destruction for teardown only.
})

it('keeps one caller promise during retry restoration and a reentrant close', async () => {
  const h = harness(), prepared = deferred<ClosePreparationResult>()
  h.requester.prepare.mockResolvedValueOnce({ status: 'failed', code: 'preferences-save-failed' })
  expect(await h.lifecycle.requestClose()).toBe(false)
  h.requester.prepare.mockReturnValueOnce(prepared.promise)
  let reentrant: Promise<boolean> | undefined
  h.window.focus.mockImplementationOnce(() => { reentrant = h.lifecycle.requestClose() })
  const retry = h.lifecycle.requestClose()
  expect(reentrant).toBe(retry)
  prepared.resolve({ status: 'ready' })
  expect(await retry).toBe(true)
  expect(h.requester.prepare).toHaveBeenCalledTimes(2)
  expect(h.window.destroy).toHaveBeenCalledOnce()
})

it('retains lifetime proof through cleanup and blocks native destruction after frame replacement', async () => {
  const h = harness(), pending = deferred<void>()
  h.finalize.mockReturnValueOnce(pending.promise)
  void h.lifecycle.requestClose()
  await vi.waitFor(() => expect(h.finalize).toHaveBeenCalledOnce())
  h.requester.isCurrent.mockReturnValue(false); pending.resolve()
  await vi.waitFor(() => expect(h.controller().snapshot()?.error).toBe('document-result-unknown'))
  expect(h.window.destroy).not.toHaveBeenCalled()
  h.window.destroy()
})
