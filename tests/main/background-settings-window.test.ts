import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackgroundTarget } from '../../src/shared/background-settings'

const browserWindowHarness = vi.hoisted(() => {
  const instances: Array<{
    webContents: {
      setWindowOpenHandler: ReturnType<typeof vi.fn>
      on: ReturnType<typeof vi.fn>
    }
    loadURL: ReturnType<typeof vi.fn>
    loadFile: ReturnType<typeof vi.fn>
  }> = []
  const BrowserWindow = vi.fn(function MockBrowserWindow() {
    const instance = {
      webContents: {
        setWindowOpenHandler: vi.fn(),
        on: vi.fn(),
      },
      loadURL: vi.fn(async () => undefined),
      loadFile: vi.fn(async () => undefined),
    }
    instances.push(instance)
    return instance
  })
  return { BrowserWindow, instances }
})

vi.mock('electron', () => ({
  BrowserWindow: browserWindowHarness.BrowserWindow,
  screen: {
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 2560, height: 1400 } }),
  },
}))

import {
  backgroundSettingsWindowUrl,
  buildBackgroundSettingsWindowOptions,
  createBackgroundSettingsWindow,
} from '../../src/main/create-background-settings-window'

const NOTE_ID = '00000000-0000-4000-8000-000000000001'

describe('background settings BrowserWindow', () => {
  beforeEach(() => {
    browserWindowHarness.BrowserWindow.mockClear()
    browserWindowHarness.instances.length = 0
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://127.0.0.1:5173')
    vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window')
  })

  it('uses a hidden, dedicated, secure settings surface that can outgrow a sticky note', () => {
    const options = buildBackgroundSettingsWindowOptions('C:\\app\\preload.js')
    expect(options).toMatchObject({
      width: 600,
      height: 1000,
      minWidth: 576,
      minHeight: 560,
      minimizable: false,
      maximizable: false,
      show: false,
      titleBarStyle: 'hidden',
      webPreferences: {
        preload: 'C:\\app\\preload.js',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    expect(options.titleBarOverlay).toBeUndefined()
  })

  it('builds exact background-settings routes for main and canonical sticky-note targets', () => {
    expect(backgroundSettingsWindowUrl('http://127.0.0.1:5173/?extra=value', { kind: 'main' }))
      .toBe('http://127.0.0.1:5173/?surface=background-settings&target=main')
    expect(backgroundSettingsWindowUrl('http://127.0.0.1:5173', {
      kind: 'sticky-note', noteId: NOTE_ID,
    })).toBe(
      `http://127.0.0.1:5173/?surface=background-settings&target=sticky-note&noteId=${NOTE_ID}`,
    )
    expect(() => backgroundSettingsWindowUrl('http://127.0.0.1:5173', {
      kind: 'sticky-note', noteId: 'ABCDEFAB-0000-4000-8000-000000000001',
    } as BackgroundTarget)).toThrow('便签 ID 无效')
  })

  it('passes the resolved dark theme before the first renderer paint', () => {
    expect(buildBackgroundSettingsWindowOptions('preload.js', undefined, 'dark').backgroundColor).toBe('#181818')
    createBackgroundSettingsWindow({ kind: 'main' }, 'dark')
    expect(browserWindowHarness.instances[0]!.loadURL).toHaveBeenCalledWith(
      'http://127.0.0.1:5173/?surface=background-settings&target=main&theme=dark',
    )
    expect(browserWindowHarness.BrowserWindow).toHaveBeenLastCalledWith(expect.objectContaining({ backgroundColor: '#181818' }))
  })

  it('fits the default window and minimum bounds inside a smaller display work area', () => {
    const options = buildBackgroundSettingsWindowOptions('preload.js', { x: -500, y: 40, width: 500, height: 500 })
    expect(options).toMatchObject({ x: -500, y: 40, width: 500, height: 500, minWidth: 500, minHeight: 500 })
  })

  it('creates an independent hidden window that loads its target route and blocks navigation', () => {
    const target: BackgroundTarget = { kind: 'sticky-note', noteId: NOTE_ID }
    createBackgroundSettingsWindow(target)
    createBackgroundSettingsWindow(target)

    expect(browserWindowHarness.BrowserWindow).toHaveBeenCalledTimes(2)
    expect(browserWindowHarness.BrowserWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({ show: false, width: 600, height: 1000 }),
    )
    const created = browserWindowHarness.instances[0]!
    expect(created.loadURL).toHaveBeenCalledWith(
      `http://127.0.0.1:5173/?surface=background-settings&target=sticky-note&noteId=${NOTE_ID}`,
    )
    expect(created.webContents.setWindowOpenHandler).toHaveBeenCalledWith(expect.any(Function))
    expect(created.webContents.on).toHaveBeenCalledWith('will-navigate', expect.any(Function))
  })
})
