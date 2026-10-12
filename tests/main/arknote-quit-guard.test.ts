import { describe, expect, it, vi } from 'vitest'
import { createArknoteQuitGuard } from '../../src/main/arknote/arknote-quit-guard'

describe('createArknoteQuitGuard', () => {
  it('restores the guard after app.quit throws so a later before-quit still flushes', () => {
    const failure = new Error('quit failed')
    const flushAndQuit = vi.fn(async () => undefined)
    const guard = createArknoteQuitGuard({
      quitApp: vi.fn(() => { throw failure }),
      flushAndQuit,
      reportError: vi.fn(),
    })
    const event = { preventDefault: vi.fn() }

    expect(() => guard.quitApp()).toThrow(failure)
    guard.handleBeforeQuit(event)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(flushAndQuit).toHaveBeenCalledTimes(1)
  })

  it('keeps the guard open after app.quit succeeds', () => {
    const flushAndQuit = vi.fn(async () => undefined)
    const guard = createArknoteQuitGuard({
      quitApp: vi.fn(),
      flushAndQuit,
      reportError: vi.fn(),
    })
    const event = { preventDefault: vi.fn() }

    guard.quitApp()
    guard.handleBeforeQuit(event)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(flushAndQuit).not.toHaveBeenCalled()
  })
})
