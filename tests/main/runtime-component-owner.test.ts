import { expect, it, vi } from 'vitest'
import { createRuntimeComponentOwner } from '../../src/main/components/runtime-component-owner'
import { installWindowBoundsSaveOnClose } from '../../src/main/settings/window-bounds-close'

it('aborts this owner before screenshot cleanup and rotates the published signal after a failed close', async () => {
  let published!: AbortSignal
  let finish!: () => void
  const close = vi.fn(() => {
    expect(published.aborted).toBe(true)
    return new Promise<void>(resolve => { finish = resolve })
  })
  const abort = vi.fn()
  const owner = createRuntimeComponentOwner({ publishSignal: signal => { published = signal }, closeOwnedResources: close, abortOwnedResourcesClose: abort })
  const other = createRuntimeComponentOwner({ publishSignal: vi.fn(), closeOwnedResources: async () => {}, abortOwnedResourcesClose: vi.fn() })
  const previous = owner.signal
  const pending = owner.prepareClose()
  expect(previous.aborted).toBe(true)
  expect(other.signal.aborted).toBe(false)
  finish(); await pending
  owner.abortClose()
  expect(owner.signal).not.toBe(previous)
  expect(owner.signal).toBe(published)
  expect(owner.signal.aborted).toBe(false)
  expect(previous.aborted).toBe(true)
  expect(abort).toHaveBeenCalledOnce()
})

it('lets the real close gate drain an installation waiter and permits a fresh request after save failure', async () => {
  let closeListener!: (event: { preventDefault(): void }) => void
  const window = { on: (_event: 'close', listener: typeof closeListener) => { closeListener = listener },
    getSize: () => [800, 600], getPosition: () => [0, 0], close: vi.fn(), setEnabled: vi.fn(), focus: vi.fn() }
  const owner = createRuntimeComponentOwner({ publishSignal: vi.fn(), closeOwnedResources: async () => {}, abortOwnedResourcesClose: vi.fn() })
  const oldSignal = owner.signal
  const ipcWaiter = new Promise<void>(resolve => oldSignal.addEventListener('abort', () => resolve(), { once: true }))
  const gate = { pauseAndDrain: vi.fn(() => ipcWaiter), resume: vi.fn() }
  const save = vi.fn().mockRejectedValueOnce(new Error('synthetic save failure')).mockResolvedValue(undefined)
  const report = vi.fn()
  const close = installWindowBoundsSaveOnClose(window, {
    saveWindowBounds: save, reportError: report, closeGate: gate,
    prepareRendererClose: async () => ({ status: 'ready' }),
    closeOwnedResources: owner.prepareClose, abortOwnedResourcesClose: owner.abortClose,
  })
  closeListener({ preventDefault: vi.fn() })
  await vi.waitFor(() => expect(report).toHaveBeenCalledOnce())
  await close.returnToEditor()
  expect(oldSignal.aborted).toBe(true)
  expect(gate.pauseAndDrain).toHaveBeenCalledOnce()
  expect(gate.resume).toHaveBeenCalledOnce()
  expect(window.close).not.toHaveBeenCalled()
  const retrySignal = owner.signal
  expect(retrySignal.aborted).toBe(false)
  closeListener({ preventDefault: vi.fn() })
  await vi.waitFor(() => expect(window.close).toHaveBeenCalledOnce())
  expect(retrySignal.aborted).toBe(true)
  close.closed()
})

it('keeps renderer invalidation separate from close hooks', () => {
  const close = vi.fn(), abort = vi.fn()
  const owner = createRuntimeComponentOwner({ publishSignal: vi.fn(), closeOwnedResources: close, abortOwnedResourcesClose: abort })
  const previous = owner.signal
  owner.invalidate()
  expect(previous.aborted).toBe(true)
  expect(owner.signal.aborted).toBe(false)
  expect(close).not.toHaveBeenCalled()
  expect(abort).not.toHaveBeenCalled()
})
