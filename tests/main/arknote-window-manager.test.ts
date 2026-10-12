import { describe, expect, it, vi } from 'vitest'
import {
  buildArknoteBoxWindowOptions,
  arknoteBoxWindowUrl,
  configureArknoteSurfaceWindow,
} from '../../src/main/create-arknote-box-window'
import { ArknoteWindowManager } from '../../src/main/arknote/arknote-window-manager'
import { buildArknoteSettingsWindowOptions } from '../../src/main/create-arknote-settings-window'
import type { StickyNoteWindowBounds } from '../../src/shared/sticky-notes'

function fakeWindow(bounds: StickyNoteWindowBounds) {
  const listeners = new Map<string, Array<(event?: { preventDefault(): void }) => void>>()
  let destroyed = false
  return {
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
    destroy: vi.fn(() => { destroyed = true }),
    isDestroyed: vi.fn(() => destroyed),
    getBounds: vi.fn(() => bounds),
    on: vi.fn((event: string, listener: (event?: { preventDefault(): void }) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    }),
    once: vi.fn((event: string, listener: (event?: { preventDefault(): void }) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    }),
    emit(event: string, payload?: { preventDefault(): void }) {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
  }
}

describe('Arknote standalone windows', () => {
  it('uses the approved box size, minimum size, route and secure renderer settings', () => {
    expect(buildArknoteBoxWindowOptions('C:\\app\\preload.js')).toMatchObject({
      width: 420,
      height: 720,
      minWidth: 360,
      minHeight: 480,
      show: false,
      title: '便签盒子 — Arknote',
      webPreferences: {
        preload: 'C:\\app\\preload.js',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    expect(buildArknoteSettingsWindowOptions('C:\\app\\preload.js')).toMatchObject({ title: '设置 — Arknote' })
    expect(arknoteBoxWindowUrl('http://127.0.0.1:5173'))
      .toBe('http://127.0.0.1:5173/?surface=arknote-box')
  })

  it('remembers box bounds, focuses repeated opens and hides user closes to the tray', async () => {
    const initialBounds = { x: 20, y: 30, width: 480, height: 620 }
    const currentBounds = { x: 40, y: 50, width: 520, height: 680 }
    const box = fakeWindow(currentBounds)
    const settings = fakeWindow({ x: 80, y: 90, width: 760, height: 700 })
    const persistBoxBounds = vi.fn(async () => undefined)
    const createBoxWindow = vi.fn(() => box)
    const createSettingsWindow = vi.fn(() => settings)
    const manager = new ArknoteWindowManager({
      initialBoxBounds: initialBounds,
      createBoxWindow,
      createSettingsWindow,
      persistBoxBounds,
      reportError: vi.fn(),
    })

    await manager.openBox()
    await manager.openBox()
    await manager.openSettings('colors')
    await manager.openSettings('tray')

    expect(createBoxWindow).toHaveBeenCalledOnce()
    expect(createBoxWindow).toHaveBeenCalledWith(initialBounds)
    expect(box.show).toHaveBeenCalledTimes(2)
    expect(box.focus).toHaveBeenCalledTimes(2)
    expect(createSettingsWindow).toHaveBeenCalledOnce()
    expect(settings.show).toHaveBeenCalledTimes(2)
    expect(settings.focus).toHaveBeenCalledTimes(2)

    const closeEvent = { preventDefault: vi.fn() }
    box.emit('close', closeEvent)
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce()
    expect(box.hide).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(persistBoxBounds).toHaveBeenCalledWith(currentBounds))

    await manager.closeAll()
    expect(box.close).toHaveBeenCalledOnce()
    expect(settings.close).toHaveBeenCalledOnce()
  })

  it('reuses the most recently persisted bounds when a destroyed box is recreated', async () => {
    const initialBounds = { x: 20, y: 30, width: 480, height: 620 }
    const movedBounds = { x: 90, y: 110, width: 560, height: 700 }
    const first = fakeWindow(movedBounds)
    const second = fakeWindow(movedBounds)
    const createBoxWindow = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    const manager = new ArknoteWindowManager({
      initialBoxBounds: initialBounds,
      createBoxWindow,
      createSettingsWindow: vi.fn(() => fakeWindow(movedBounds)),
      persistBoxBounds: vi.fn(async () => undefined),
      reportError: vi.fn(),
    })

    await manager.openBox()
    first.emit('close', { preventDefault: vi.fn() })
    first.destroy()
    first.emit('closed')
    await manager.openBox()

    expect(createBoxWindow).toHaveBeenNthCalledWith(1, initialBounds)
    expect(createBoxWindow).toHaveBeenNthCalledWith(2, movedBounds)
  })

  it('denies popup and top-level navigation for every Arknote surface', () => {
    let openHandler: ((details: { url: string }) => { action: string }) | undefined
    let navigationHandler: ((event: { preventDefault(): void }) => void) | undefined
    const target = {
      setMenuBarVisibility: vi.fn(),
      webContents: {
        setWindowOpenHandler: vi.fn((handler) => { openHandler = handler }),
        on: vi.fn((event: string, handler: (event: { preventDefault(): void }) => void) => {
          if (event === 'will-navigate') navigationHandler = handler
        }),
      },
    }

    configureArknoteSurfaceWindow(target)

    expect(openHandler?.({ url: 'https://attacker.example' })).toEqual({ action: 'deny' })
    const event = { preventDefault: vi.fn() }
    navigationHandler?.(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('destroys a cancelled settings window so reopening reloads service state', async () => {
    const box = fakeWindow({ x: 10, y: 10, width: 420, height: 720 })
    const first = fakeWindow({ x: 20, y: 20, width: 900, height: 760 })
    const second = fakeWindow({ x: 30, y: 30, width: 900, height: 760 })
    const createSettingsWindow = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const manager = new ArknoteWindowManager({
      initialBoxBounds: null,
      createBoxWindow: vi.fn(() => box),
      createSettingsWindow,
      persistBoxBounds: vi.fn(async () => undefined),
      reportError: vi.fn(),
    })

    await manager.openSettings('colors')
    const event = { preventDefault: vi.fn() }
    first.emit('close', event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(first.hide).not.toHaveBeenCalled()
    first.destroy()
    first.emit('closed')
    await manager.openSettings('tray')

    expect(createSettingsWindow).toHaveBeenNthCalledWith(1, 'colors')
    expect(createSettingsWindow).toHaveBeenNthCalledWith(2, 'tray')
  })

  it('restores hide-on-close behavior and reports errors after bounds persistence fails', async () => {
    const box = fakeWindow({ x: 10, y: 20, width: 420, height: 720 })
    const failure = new Error('disk unavailable')
    const persistBoxBounds = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
    const reportError = vi.fn()
    const manager = new ArknoteWindowManager({
      initialBoxBounds: null,
      createBoxWindow: vi.fn(() => box),
      createSettingsWindow: vi.fn(() => fakeWindow({ x: 1, y: 1, width: 900, height: 760 })),
      persistBoxBounds,
      reportError,
    })
    await manager.openBox()

    await expect(manager.closeAll()).rejects.toThrow('disk unavailable')
    const event = { preventDefault: vi.fn() }
    box.emit('close', event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(box.hide).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(failure))
  })

  it('limits shutdown close behavior to one closeAll call so a recovered service hides new boxes', async () => {
    const first = fakeWindow({ x: 10, y: 20, width: 420, height: 720 })
    const second = fakeWindow({ x: 30, y: 40, width: 460, height: 740 })
    const createBoxWindow = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const manager = new ArknoteWindowManager({
      initialBoxBounds: null,
      createBoxWindow,
      createSettingsWindow: vi.fn(() => fakeWindow({ x: 1, y: 1, width: 900, height: 760 })),
      persistBoxBounds: vi.fn(async () => undefined),
      reportError: vi.fn(),
    })
    await manager.openBox()
    await manager.closeAll()
    first.destroy()
    first.emit('closed')

    await manager.openBox()
    const event = { preventDefault: vi.fn() }
    second.emit('close', event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(second.hide).toHaveBeenCalledOnce()
  })
})
