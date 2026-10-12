import { expect, it, vi } from 'vitest'
import {
  createScreenshotQuitGate,
  disposeScreenshotRuntime,
  installScreenshotQuitGate,
} from '../../src/main/screenshot-translation/screenshot-shutdown'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it('prevents quit until shortcut unregister and coordinator cleanup settle, then re-enters once', async () => {
  const cleanup = deferred()
  const quit = vi.fn()
  const shortcut = { dispose: vi.fn() }
  const coordinator = { dispose: vi.fn(() => cleanup.promise) }
  const gate = createScreenshotQuitGate({ coordinator, shortcut, quit })
  const first = { preventDefault: vi.fn() }
  const repeated = { preventDefault: vi.fn() }

  gate.handleWillQuit(first)
  gate.handleWillQuit(repeated)
  await Promise.resolve()
  expect(first.preventDefault).toHaveBeenCalledOnce()
  expect(repeated.preventDefault).toHaveBeenCalledOnce()
  expect(shortcut.dispose).toHaveBeenCalledOnce()
  expect(coordinator.dispose).toHaveBeenCalledOnce()
  expect(quit).not.toHaveBeenCalled()
  cleanup.resolve()
  await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())

  const reentered = { preventDefault: vi.fn() }
  gate.handleWillQuit(reentered)
  expect(reentered.preventDefault).not.toHaveBeenCalled()
  expect(coordinator.dispose).toHaveBeenCalledOnce()
})

it('continues final quit after cleanup failure and reports only a fixed code', async () => {
  const diagnostic = vi.fn()
  const quit = vi.fn()
  const gate = createScreenshotQuitGate({
    coordinator: { dispose: vi.fn(async () => { throw new Error('C:\\secret\\capture.png') }) },
    shortcut: { dispose: vi.fn(() => { throw new Error('shortcut detail') }) },
    quit,
    reportDiagnostic: diagnostic,
  })
  gate.handleWillQuit({ preventDefault: vi.fn() })
  await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
  expect(diagnostic.mock.calls.flat()).toEqual(['SHORTCUT_DISPOSE_FAILED', 'COORDINATOR_DISPOSE_FAILED'])
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('secret')
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('shortcut detail')
})

it('restores the gate after final quit throws so a later request can retry', async () => {
  const quit = vi.fn()
    .mockImplementationOnce(() => { throw new Error('native quit detail') })
    .mockImplementationOnce(() => undefined)
  const diagnostic = vi.fn()
  const coordinator = { dispose: vi.fn(async () => undefined) }
  const gate = createScreenshotQuitGate({
    coordinator,
    shortcut: { dispose: vi.fn() },
    quit,
    reportDiagnostic: diagnostic,
  })
  gate.handleWillQuit({ preventDefault: vi.fn() })
  await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
  expect(diagnostic).toHaveBeenCalledWith('FINAL_QUIT_FAILED')
  const retry = { preventDefault: vi.fn() }
  gate.handleWillQuit(retry)
  await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(2))
  expect(retry.preventDefault).toHaveBeenCalledOnce()
  expect(coordinator.dispose).toHaveBeenCalledTimes(2)
})

it('installs cleanup only at will-quit so a canceled window close leaves screenshot resources running', async () => {
  const listeners = new Map<string, (event: { preventDefault(): void }) => void>()
  const app = {
    on: vi.fn((event: string, listener: (quitEvent: { preventDefault(): void }) => void) => {
      listeners.set(event, listener)
    }),
  }
  const shortcut = { dispose: vi.fn() }
  const coordinator = { dispose: vi.fn(async () => undefined) }
  const quit = vi.fn()
  const gate = createScreenshotQuitGate({ coordinator, shortcut, quit })

  installScreenshotQuitGate(app, gate)

  expect([...listeners.keys()]).toEqual(['will-quit'])
  expect(shortcut.dispose).not.toHaveBeenCalled()
  expect(coordinator.dispose).not.toHaveBeenCalled()

  const event = { preventDefault: vi.fn() }
  listeners.get('will-quit')!(event)
  await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(shortcut.dispose).toHaveBeenCalledOnce()
  expect(coordinator.dispose).toHaveBeenCalledOnce()
})

it('still disposes OCR models after coordinator disposal rejects and exposes only a fixed cleanup error', async () => {
  const coordinator = {
    dispose: vi.fn(async () => { throw new Error('C:\\private\\capture.png') }),
  }
  const models = { dispose: vi.fn(async () => undefined) }

  await expect(disposeScreenshotRuntime(coordinator, models))
    .rejects.toThrow('Screenshot runtime cleanup failed')
  expect(coordinator.dispose).toHaveBeenCalledOnce()
  expect(models.dispose).toHaveBeenCalledOnce()
})
