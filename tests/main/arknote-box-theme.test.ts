// @vitest-environment node
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { ArknoteBoxThemeController } from '../../src/main/arknote/arknote-box-theme'
import { ARKNOTE_BOX_THEME_CHANNEL, ARKNOTE_BOX_THEME_EVENT, parseArknoteBoxTheme } from '../../src/shared/arknote-box-theme'
import { parseArknoteSettings, copyArknoteSettings, DEFAULT_ARKNOTE_SETTINGS, arknotePreferencesUpdateFromSettings } from '../../src/main/arknote/arknote-settings-store'

describe('independent Arknote box theme', () => {
  it('limits theme reads to each registered main frame and publishes only successful persisted changes', async () => {
    const handlers = new Map<string, (event: unknown) => unknown>()
    const ipc = { handle: vi.fn((name, handler) => handlers.set(name, handler)), removeHandler: vi.fn(name => handlers.delete(name)) }
    const persist = vi.fn(async () => undefined)
    const controller = new ArknoteBoxThemeController(ipc as never, { mode: 'light', themeColor: '#C62828' }, persist)
    const window = Object.assign(new EventEmitter(), {
      isDestroyed: () => false, webContents: { mainFrame: {}, send: vi.fn(), isDestroyed: () => false },
      setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(),
    })
    controller.register(window as never)
    const read = handlers.get(ARKNOTE_BOX_THEME_CHANNEL)!
    expect(() => read({ sender: {}, senderFrame: window.webContents.mainFrame })).toThrow()
    expect(() => read({ sender: window.webContents, senderFrame: {} })).toThrow()
    expect(read({ sender: window.webContents, senderFrame: window.webContents.mainFrame })).toMatchObject({ mode: 'light' })
    await controller.set({ mode: 'dark', themeColor: '#2563eb' })
    expect(persist).toHaveBeenCalledWith({ mode: 'dark', themeColor: '#2563EB' })
    expect(window.webContents.send).toHaveBeenCalledWith(ARKNOTE_BOX_THEME_EVENT, { mode: 'dark', themeColor: '#2563EB' })
    expect(window.setTitleBarOverlay).toHaveBeenCalledWith(expect.objectContaining({ symbolColor: '#E3E3E3' }))
    persist.mockRejectedValueOnce(new Error('synthetic write failure'))
    await expect(controller.set({ mode: 'light', themeColor: '#C62828' })).rejects.toThrow()
    expect(read({ sender: window.webContents, senderFrame: window.webContents.mainFrame })).toMatchObject({ mode: 'dark' })
    window.emit('closed')
    expect(() => read({ sender: window.webContents, senderFrame: window.webContents.mainFrame })).toThrow()
    controller.dispose()
    expect(ipc.removeHandler).toHaveBeenCalledWith(ARKNOTE_BOX_THEME_CHANNEL)
  })
  it('validates exact theme fields and preserves persisted mode without exposing it as a writable ordinary preference', () => {
    expect(parseArknoteBoxTheme({ mode: 'auto', themeColor: '#000000' })).toBeUndefined()
    expect(parseArknoteBoxTheme({ mode: 'dark', themeColor: '#000000', path: 'unwanted' })).toBeUndefined()
    const saved = parseArknoteSettings({ ...DEFAULT_ARKNOTE_SETTINGS, boxTheme: { mode: 'dark', themeColor: '#2563EB' } })!
    expect(saved.boxTheme?.mode).toBe('dark')
    const copy = copyArknoteSettings(saved)
    copy.boxTheme!.mode = 'light'
    expect(saved.boxTheme?.mode).toBe('dark')
    expect(arknotePreferencesUpdateFromSettings(saved)).not.toHaveProperty('boxTheme')
  })
})
