import { beforeEach, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  constructed: vi.fn(),
  nextWindow: undefined as unknown,
  BrowserWindow: class BrowserWindow {
    constructor(options: unknown) {
      electron.constructed(options)
      Object.assign(this, electron.nextWindow)
    }
  },
}))

vi.mock('electron', () => ({ BrowserWindow: electron.BrowserWindow }))

import {
  buildScreenshotSelectionWindowOptions,
  createScreenshotSelectionWindow,
  screenshotSelectionWindowUrl,
} from '../../src/main/create-screenshot-selection-window'

const sessionId = '123e4567-e89b-42d3-a456-426614174000'
const display = {
  displayId: 'display / 1', boundsDip: { x: -100, y: 20, width: 300, height: 200 },
  scaleFactor: 1.5, imageSizePx: { width: 450, height: 300 }, dataUrl: 'data:image/png;base64,AAAA',
}

beforeEach(() => {
  electron.constructed.mockReset()
  electron.nextWindow = undefined
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:3000/')
})

it('builds a hardened transparent overlay at exact display bounds', () => {
  expect(buildScreenshotSelectionWindowOptions('preload.js', display.boundsDip)).toEqual({
    x: -100, y: 20, width: 300, height: 200,
    frame: false, transparent: true, backgroundColor: '#00000000', show: false,
    fullscreen: true,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: true, skipTaskbar: true, focusable: true, hasShadow: false,
    roundedCorners: false, thickFrame: false, alwaysOnTop: true,
    webPreferences: {
      preload: 'preload.js', sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true,
    },
  })
})

it('rejects bounds outside the shared safe DIP range', () => {
  expect(() => buildScreenshotSelectionWindowOptions('preload.js', {
    x: 1_000_001, y: 0, width: 100, height: 100,
  })).toThrow('Invalid screenshot overlay bounds')
  expect(() => buildScreenshotSelectionWindowOptions('preload.js', {
    x: 0, y: 0, width: 1_000_001, height: 100,
  })).toThrow('Invalid screenshot overlay bounds')
})

it('encodes only the exact selection route fields', () => {
  const url = new URL(screenshotSelectionWindowUrl('http://localhost:3000/?old=1#hash', sessionId, display.displayId))
  expect([...url.searchParams.entries()]).toEqual([
    ['surface', 'screenshot-selection'],
    ['sessionId', sessionId],
    ['displayId', display.displayId],
  ])
  expect(url.hash).toBe('#hash')
})

it('rejects an invalid session before constructing a BrowserWindow', () => {
  expect(() => createScreenshotSelectionWindow({ sessionId: 'invalid', display })).toThrow('Invalid screenshot overlay route')
  expect(electron.constructed).not.toHaveBeenCalled()
})

it('installs always-on-top and navigation guards without showing the window', () => {
  let navigationHandler: ((event: { preventDefault(): void }) => void) | undefined
  const window = {
    show: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    loadFile: vi.fn().mockResolvedValue(undefined),
    loadURL: vi.fn().mockResolvedValue(undefined),
    webContents: {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, handler: (event: { preventDefault(): void }) => void) => {
        if (event === 'will-navigate') navigationHandler = handler
      }),
    },
  }
  electron.nextWindow = window

  const created = createScreenshotSelectionWindow({ sessionId, display })
  expect(created.setAlwaysOnTop).toBe(window.setAlwaysOnTop)
  expect(electron.constructed).toHaveBeenCalledOnce()
  expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver')
  expect(window.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true })
  expect(window.webContents.setWindowOpenHandler.mock.results[0]?.value).toBeUndefined()
  expect(window.webContents.setWindowOpenHandler).toHaveBeenCalledOnce()
  const openHandler = window.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as () => unknown
  expect(openHandler()).toEqual({ action: 'deny' })
  const preventDefault = vi.fn()
  navigationHandler?.({ preventDefault })
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(window.show).not.toHaveBeenCalled()
})
