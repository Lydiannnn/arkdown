import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { SCREENSHOT_TRANSLATION_ACCELERATOR } from '../../src/shared/screenshot-translation'
import {
  registerScreenshotTranslationShortcut,
  type ScreenshotShortcutDiagnosticCode,
} from '../../src/main/screenshot-translation/screenshot-shortcut'

function dependencies(overrides: Record<string, unknown> = {}) {
  const callback = { current: undefined as (() => void) | undefined }
  const owner = { id: 'current-owner' } as unknown as BrowserWindow
  const globalShortcut = {
    register: vi.fn((_accelerator: string, listener: () => void) => {
      callback.current = listener
      return true
    }),
    isRegistered: vi.fn(() => true),
    unregister: vi.fn(),
    unregisterAll: vi.fn(),
  }
  const result = {
    callback,
    owner,
    globalShortcut,
    getOwner: vi.fn((): BrowserWindow | undefined => owner),
    beginCapture: vi.fn(),
    onDiagnostic: vi.fn<(code: ScreenshotShortcutDiagnosticCode) => void>(),
    ...overrides,
  }
  return result
}

describe('screenshot translation global shortcut', () => {
  it('registers and verifies the shared accelerator, then resolves the owner at invocation time', () => {
    const firstOwner = { id: 'first' } as unknown as BrowserWindow
    const secondOwner = { id: 'second' } as unknown as BrowserWindow
    let currentOwner: BrowserWindow | undefined = firstOwner
    const deps = dependencies({ getOwner: vi.fn(() => currentOwner) })

    const registration = registerScreenshotTranslationShortcut(deps)
    currentOwner = secondOwner
    deps.callback.current?.()

    expect(registration.registered).toBe(true)
    expect(deps.globalShortcut.register).toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_ACCELERATOR,
      expect.any(Function),
    )
    expect(deps.globalShortcut.isRegistered).toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_ACCELERATOR,
    )
    expect(deps.beginCapture).toHaveBeenCalledWith(secondOwner)
  })

  it('does nothing when no Arkdown owner exists at invocation time', () => {
    const deps = dependencies({ getOwner: vi.fn(() => undefined) })
    registerScreenshotTranslationShortcut(deps)

    deps.callback.current?.()

    expect(deps.beginCapture).not.toHaveBeenCalled()
    expect(deps.onDiagnostic).not.toHaveBeenCalled()
  })

  it('keeps the menu-independent path safe on OS conflict and registration exceptions', () => {
    const conflict = dependencies()
    conflict.globalShortcut.register.mockReturnValue(false)
    const conflicted = registerScreenshotTranslationShortcut(conflict)

    expect(conflicted.registered).toBe(false)
    expect(conflict.globalShortcut.isRegistered).not.toHaveBeenCalled()
    expect(conflict.onDiagnostic).toHaveBeenCalledWith('REGISTRATION_CONFLICT')
    conflicted.dispose()
    expect(conflict.globalShortcut.unregister).not.toHaveBeenCalled()

    const failed = dependencies()
    failed.globalShortcut.register.mockImplementation(() => { throw new Error('private OS detail') })
    const thrown = registerScreenshotTranslationShortcut(failed)

    expect(thrown.registered).toBe(false)
    expect(failed.onDiagnostic).toHaveBeenCalledWith('REGISTRATION_FAILED')
    expect(failed.onDiagnostic.mock.calls.flat().join(' ')).not.toContain('private OS detail')
    thrown.dispose()
    expect(failed.globalShortcut.unregister).not.toHaveBeenCalled()
  })

  it('reports failed verification but retains ownership for exact cleanup', () => {
    const unverified = dependencies()
    unverified.globalShortcut.isRegistered.mockReturnValue(false)
    const registration = registerScreenshotTranslationShortcut(unverified)

    expect(registration.registered).toBe(false)
    expect(unverified.onDiagnostic).toHaveBeenCalledWith('REGISTRATION_UNVERIFIED')
    registration.dispose()
    registration.dispose()
    expect(unverified.globalShortcut.unregister).toHaveBeenCalledOnce()
    expect(unverified.globalShortcut.unregister).toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_ACCELERATOR,
    )
    expect(unverified.globalShortcut.unregisterAll).not.toHaveBeenCalled()

    const checkFailed = dependencies()
    checkFailed.globalShortcut.isRegistered.mockImplementation(() => { throw new Error('private check detail') })
    const checked = registerScreenshotTranslationShortcut(checkFailed)
    expect(checked.registered).toBe(false)
    expect(checkFailed.onDiagnostic).toHaveBeenCalledWith('VERIFICATION_FAILED')
    checked.dispose()
    expect(checkFailed.globalShortcut.unregister).toHaveBeenCalledOnce()
  })

  it('bounds synchronous and asynchronous capture failures to fixed diagnostic codes', async () => {
    const synchronous = dependencies({
      beginCapture: vi.fn(() => { throw new Error('sensitive synchronous detail') }),
    })
    registerScreenshotTranslationShortcut(synchronous)
    synchronous.callback.current?.()
    expect(synchronous.onDiagnostic).toHaveBeenCalledWith('CAPTURE_LAUNCH_FAILED')

    const asynchronous = dependencies({
      beginCapture: vi.fn(async () => { throw new Error('sensitive asynchronous detail') }),
    })
    registerScreenshotTranslationShortcut(asynchronous)
    asynchronous.callback.current?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(asynchronous.onDiagnostic).toHaveBeenCalledWith('CAPTURE_LAUNCH_FAILED')
    for (const code of [
      ...synchronous.onDiagnostic.mock.calls.flat(),
      ...asynchronous.onDiagnostic.mock.calls.flat(),
    ]) {
      expect(code.length).toBeLessThanOrEqual(32)
      expect(code).not.toContain('sensitive')
    }
  })

  it('disposes its successful registration once without unregisterAll and swallows diagnostic failures', () => {
    const deps = dependencies({
      onDiagnostic: vi.fn(() => { throw new Error('diagnostic sink failed') }),
    })
    const registration = registerScreenshotTranslationShortcut(deps)

    registration.dispose()
    registration.dispose()
    deps.callback.current?.()

    expect(deps.globalShortcut.unregister).toHaveBeenCalledOnce()
    expect(deps.globalShortcut.unregister).toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_ACCELERATOR,
    )
    expect(deps.globalShortcut.unregisterAll).not.toHaveBeenCalled()
    expect(deps.beginCapture).not.toHaveBeenCalled()

    const unregisterFailed = dependencies({
      onDiagnostic: vi.fn(() => { throw new Error('diagnostic sink failed') }),
    })
    unregisterFailed.globalShortcut.unregister.mockImplementation(() => {
      throw new Error('private unregister detail')
    })
    const failed = registerScreenshotTranslationShortcut(unregisterFailed)
    expect(() => failed.dispose()).not.toThrow()
  })
})
