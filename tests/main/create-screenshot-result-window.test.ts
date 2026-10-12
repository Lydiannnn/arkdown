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
  buildScreenshotResultWindowOptions,
  calculateScreenshotResultWindowBounds,
  createScreenshotResultWindow,
  screenshotResultWindowUrl,
} from '../../src/main/create-screenshot-result-window'

const sessionId = '123e4567-e89b-42d3-a456-426614174000'
const imageSizePx = { width: 1600, height: 900 }
const workAreaDip = { x: -1920, y: 0, width: 1920, height: 1080 }

beforeEach(() => {
  electron.constructed.mockReset()
  electron.nextWindow = undefined
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:3000/')
})

it('preserves capture aspect ratio inside 80% of a negative-coordinate work area', () => {
  const bounds = calculateScreenshotResultWindowBounds(imageSizePx, workAreaDip)
  expect(bounds.width / bounds.height).toBeCloseTo(16 / 9, 5)
  expect(bounds.width).toBeLessThanOrEqual(workAreaDip.width * 0.8)
  expect(bounds.height).toBeLessThanOrEqual(workAreaDip.height * 0.8)
  expect(bounds.x).toBeGreaterThanOrEqual(workAreaDip.x)
  expect(bounds.y).toBeGreaterThanOrEqual(workAreaDip.y)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(workAreaDip.x + workAreaDip.width)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(workAreaDip.y + workAreaDip.height)
})

it('uses a hardened frameless dark result-window configuration', () => {
  const bounds = { x: 20, y: 30, width: 960, height: 540 }
  expect(buildScreenshotResultWindowOptions('preload.js', bounds)).toMatchObject({
    ...bounds,
    title: 'Arkdown截图翻译',
    minWidth: 480,
    minHeight: 320,
    frame: false,
    show: false,
    resizable: true,
    backgroundColor: '#171717',
    autoHideMenuBar: true,
    webPreferences: {
      preload: 'preload.js',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
})

it('encodes only the result surface and canonical session in the route', () => {
  const url = new URL(screenshotResultWindowUrl('http://localhost:3000/?secret=value#hash', sessionId))
  expect([...url.searchParams.entries()]).toEqual([
    ['surface', 'screenshot-translation'],
    ['sessionId', sessionId],
  ])
  expect(url.hash).toBe('')
})

it('rejects invalid session and geometry before BrowserWindow construction', () => {
  expect(() => createScreenshotResultWindow({ sessionId: 'bad', imageSizePx, workAreaDip })).toThrow()
  expect(() => createScreenshotResultWindow({
    sessionId,
    imageSizePx: { width: 0, height: 900 },
    workAreaDip,
  })).toThrow()
  expect(() => createScreenshotResultWindow({
    sessionId,
    imageSizePx,
    workAreaDip: { ...workAreaDip, width: 0 },
  })).toThrow()
  expect(() => createScreenshotResultWindow({
    sessionId,
    imageSizePx: { width: 10_000, height: 3_000 },
    workAreaDip,
  })).toThrow('Invalid screenshot result geometry')
  expect(electron.constructed).not.toHaveBeenCalled()
})

it('rejects work areas that cannot satisfy both the minimum and 80% cap', () => {
  expect(() => calculateScreenshotResultWindowBounds(imageSizePx, {
    x: 0, y: 0, width: 500, height: 350,
  })).toThrow('Invalid screenshot result geometry')
})

it('denies navigation and popups, removes the menu, and shows only when ready', () => {
  let navigate: ((event: { preventDefault(): void }) => void) | undefined
  let ready: (() => void) | undefined
  const window = {
    show: vi.fn(),
    focus: vi.fn(),
    removeMenu: vi.fn(),
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
    once: vi.fn((event: string, listener: () => void) => {
      if (event === 'ready-to-show') ready = listener
    }),
    webContents: {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, listener: (event: { preventDefault(): void }) => void) => {
        if (event === 'will-navigate') navigate = listener
      }),
    },
  }
  electron.nextWindow = window

  createScreenshotResultWindow({ sessionId, imageSizePx, workAreaDip })
  expect(window.removeMenu).toHaveBeenCalledOnce()
  expect(window.show).not.toHaveBeenCalled()
  expect(window.focus).not.toHaveBeenCalled()
  expect(window.webContents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: 'deny' })
  const preventDefault = vi.fn()
  navigate?.({ preventDefault })
  expect(preventDefault).toHaveBeenCalledOnce()
  ready?.()
  expect(window.show).toHaveBeenCalledOnce()
  expect(window.focus).toHaveBeenCalledOnce()
})

it('configures least-privilege ownership before loading and destroys on configuration failure', () => {
  const order: string[] = []
  const window = {
    show: vi.fn(), focus: vi.fn(), removeMenu: vi.fn(), destroy: vi.fn(),
    loadURL: vi.fn(async () => { order.push('load') }),
    loadFile: vi.fn(async () => { order.push('load') }),
    once: vi.fn(),
    webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn() },
  }
  electron.nextWindow = window
  createScreenshotResultWindow(
    { sessionId, imageSizePx, workAreaDip },
    () => { order.push('configure') },
  )
  expect(order).toEqual(['configure', 'load'])

  expect(() => createScreenshotResultWindow(
    { sessionId, imageSizePx, workAreaDip },
    () => { throw new Error('registration failed') },
  )).toThrow('registration failed')
  expect(window.destroy).toHaveBeenCalledTimes(1)
  expect(window.loadURL).toHaveBeenCalledTimes(1)
})

it('destroys the configured result when asynchronous surface loading rejects', async () => {
  const window = {
    show: vi.fn(), focus: vi.fn(), removeMenu: vi.fn(), destroy: vi.fn(),
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn().mockRejectedValue(new Error('private load detail')),
    loadFile: vi.fn().mockRejectedValue(new Error('private load detail')),
    once: vi.fn(),
    webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn() },
  }
  electron.nextWindow = window
  createScreenshotResultWindow({ sessionId, imageSizePx, workAreaDip }, vi.fn())
  await vi.waitFor(() => expect(window.destroy).toHaveBeenCalledOnce())
})
