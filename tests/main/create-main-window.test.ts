import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nativeSurface = vi.hoisted(() => ({ bind: vi.fn() }))
vi.mock('../../src/main/main-window-native-surface', () => ({ bindMainWindowNativeSurface: nativeSurface.bind }))

const electron = vi.hoisted(() => ({
  constructed: vi.fn(),
  nextWindow: undefined as unknown,
  getPrimaryDisplay: vi.fn(),
  BrowserWindow: class BrowserWindow {
    constructor(options: unknown) {
      electron.constructed(options)
      Object.assign(this, electron.nextWindow)
    }
  },
}))

vi.mock('electron', () => ({
  BrowserWindow: electron.BrowserWindow,
  screen: { getPrimaryDisplay: electron.getPrimaryDisplay },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}))

import {
  buildWindowOptions,
  configureWindowChrome,
  createMainWindow,
  initialWindowSizeForDisplay,
  installMainWindowExternalLinkHandler,
  installMainWindowReadyPresentation,
  isAllowedExternalUrl,
  preloadPathForBuild,
} from '../../src/main/create-main-window'

describe('secure main window', () => {
  describe('initial content sizing', () => {
    beforeEach(() => {
      electron.getPrimaryDisplay.mockReturnValue({
        size: { width: 2560, height: 1440 },
        workAreaSize: { width: 2560, height: 1410 },
        scaleFactor: 1.5,
      })
      vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://127.0.0.1:5173')
    })

    afterEach(() => {
      electron.nextWindow = undefined
      vi.unstubAllGlobals()
    })

    function windowTarget() {
      const window = {
        setContentSize: vi.fn(),
        setMenuBarVisibility: vi.fn(),
        webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn() },
        loadURL: vi.fn(async (_url: string) => undefined),
        loadFile: vi.fn(async () => undefined),
        once: vi.fn(),
        show: vi.fn(),
      }
      electron.nextWindow = window
      return window
    }

    it('passes the blank-startup guide intent through the development URL', () => {
      const window = windowTarget()
      createMainWindow(undefined, { startupGuide: true })
      expect(new URL(window.loadURL.mock.calls[0]![0]).searchParams.get('startup')).toBe('guide')
    })

    it('passes guide intent in the packaged query and keeps ordinary New unmarked', () => {
      vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined)
      vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window')
      const window = windowTarget()
      createMainWindow(undefined, { startupGuide: true })
      expect(window.loadFile).toHaveBeenLastCalledWith(expect.any(String), { query: { startup: 'guide' } })
      createMainWindow()
      expect(window.loadFile).toHaveBeenLastCalledWith(expect.any(String), { query: {} })
    })

    it('corrects default content once before loading when the work area has native-frame headroom', () => {
      const window = windowTarget()

      createMainWindow()

      expect(window.setContentSize).toHaveBeenCalledExactlyOnceWith(1800, 1080)
      expect(nativeSurface.bind.mock.invocationCallOrder.at(-1)).toBeGreaterThan(window.setContentSize.mock.invocationCallOrder[0]!)
      expect(nativeSurface.bind.mock.invocationCallOrder.at(-1)).toBeLessThan(window.loadURL.mock.invocationCallOrder[0]!)
      expect(window.setContentSize.mock.invocationCallOrder[0])
        .toBeLessThan(window.loadURL.mock.invocationCallOrder[0]!)
      expect(electron.constructed).toHaveBeenCalledWith(expect.objectContaining({
        width: 1800,
        height: 1080,
        thickFrame: true,
        show: false,
      }))
    })

    it('preserves saved outer bounds without applying the default content correction', () => {
      const window = windowTarget()

      createMainWindow({ x: 240, y: 120, width: 1300, height: 900 })

      expect(window.setContentSize).not.toHaveBeenCalled()
      expect(electron.constructed).toHaveBeenCalledWith(expect.objectContaining({
        x: 240,
        y: 120,
        width: 1300,
        height: 900,
      }))
    })

    it.each([
      { workAreaSize: { width: 1920, height: 1040 }, expected: { width: 1800, height: 1040 } },
      { workAreaSize: { width: 1707, height: 960 }, expected: { width: 1707, height: 960 } },
      { workAreaSize: { width: 1800, height: 1440 }, expected: { width: 1800, height: 1080 } },
      { workAreaSize: { width: 2560, height: 1080 }, expected: { width: 1800, height: 1080 } },
    ])('preserves outer clamping without content correction for work area $workAreaSize', ({
      workAreaSize,
      expected,
    }) => {
      electron.getPrimaryDisplay.mockReturnValue({
        size: { width: 2560, height: 1440 },
        workAreaSize,
        scaleFactor: 1.5,
      })
      const window = windowTarget()

      createMainWindow()

      expect(window.setContentSize).not.toHaveBeenCalled()
      expect(electron.constructed).toHaveBeenCalledWith(expect.objectContaining(expected))
    })
  })

  it('uses the approved 1800 by 1080 DIP initial size without dividing it by display scale', () => {
    expect(initialWindowSizeForDisplay({ size: { width: 1920, height: 1080 }, scaleFactor: 1 }))
      .toEqual({ width: 1800, height: 1080 })
    expect(initialWindowSizeForDisplay({ size: { width: 2560, height: 1440 }, scaleFactor: 1 }))
      .toEqual({ width: 1800, height: 1080 })
    expect(initialWindowSizeForDisplay({ size: { width: 3840, height: 2160 }, scaleFactor: 1 }))
      .toEqual({ width: 1800, height: 1080 })

    expect(initialWindowSizeForDisplay({ size: { width: 1280, height: 720 }, scaleFactor: 1.5 }))
      .toEqual({ width: 1280, height: 720 })
    expect(initialWindowSizeForDisplay({ size: { width: 1707, height: 960 }, scaleFactor: 1.5 }))
      .toEqual({ width: 1707, height: 960 })
    expect(initialWindowSizeForDisplay({ size: { width: 2560, height: 1440 }, scaleFactor: 1.5 }))
      .toEqual({ width: 1800, height: 1080 })
  })

  it('clamps a new window to the usable work area below a taskbar', () => {
    const display = {
      size: { width: 1920, height: 1080 },
      workAreaSize: { width: 1920, height: 1040 },
      scaleFactor: 1,
    }

    expect(initialWindowSizeForDisplay(display)).toEqual({ width: 1800, height: 1040 })
    expect(buildWindowOptions('C:\\app\\preload.js', undefined, display)).toMatchObject({
      width: 1800,
      height: 1040,
      center: true,
    })
  })

  it('uses the initial DIP default only when no saved window bounds exist', () => {
    const display = { size: { width: 2560, height: 1440 }, scaleFactor: 1 }

    expect(buildWindowOptions('C:\\app\\preload.js', undefined, display)).toMatchObject({
      width: 1800,
      height: 1080,
      center: true,
    })
    const savedBounds = buildWindowOptions('C:\\app\\preload.js', {
      width: 1300,
      height: 900,
      x: 240,
      y: 120,
    }, display)
    expect(savedBounds).toMatchObject({
      width: 1300,
      height: 900,
      x: 240,
      y: 120,
    })
    expect(savedBounds.center).toBeUndefined()
  })

  it('uses the fixed DIP minimums for a 1800 by 1080 default at high scaling', () => {
    const display = { size: { width: 960, height: 540 }, scaleFactor: 2 }

    expect(buildWindowOptions('C:\\app\\preload.js', undefined, display)).toMatchObject({
      width: 960,
      height: 540,
      minWidth: 760,
      minHeight: 520,
    })
  })

  it('does not let the current display minimum enlarge bounds saved at another scale', () => {
    const display = { size: { width: 1920, height: 1080 }, scaleFactor: 1 }

    expect(buildWindowOptions('C:\\app\\preload.js', {
      width: 600,
      height: 400,
    }, display)).toMatchObject({
      width: 600,
      height: 400,
      minWidth: 600,
      minHeight: 400,
    })
  })
  it('uses the Windows Mica shell with renderer-owned window controls', () => {
    const options = buildWindowOptions('C:\\app\\preload.js')

    // Native maximize must remain available so Windows emits title-bar double-clicks;
    // the coordinator consumes their default result and routes them to fullscreen.
    expect(options).toMatchObject({
      backgroundMaterial: 'mica',
      roundedCorners: true,
      hasShadow: true,
      thickFrame: true,
      maximizable: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: false,
    })
    expect(options.backgroundColor).toBeUndefined()
    expect(options.transparent).not.toBe(true)
  })

  it('keeps the Electron menu for accelerators without showing a second menu row', () => {
    let visible = true

    configureWindowChrome({
      setMenuBarVisibility(nextVisible) {
        visible = nextVisible
      },
    })

    expect(visible).toBe(false)
  })

  it('keeps startup-intent windows hidden until their opener explicitly promotes them', () => {
    const show = vi.fn()
    const once = vi.fn()

    installMainWindowReadyPresentation({ once, show }, false)

    expect(once).not.toHaveBeenCalled()
    expect(show).not.toHaveBeenCalled()
  })

  it('preserves ready-to-show promotion for ordinary windows', () => {
    const show = vi.fn()
    let ready: (() => void) | undefined

    installMainWindowReadyPresentation({
      once: vi.fn((_event: 'ready-to-show', listener: () => void) => { ready = listener }),
      show,
    }, true)
    expect(show).not.toHaveBeenCalled()
    ready?.()

    expect(show).toHaveBeenCalledOnce()
  })

  it('isolates and sandboxes renderer code', () => {
    const options = buildWindowOptions('C:\\app\\preload.js')
    expect(options.webPreferences).toMatchObject({
      preload: 'C:\\app\\preload.js',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    })
  })

  it('only delegates HTTP(S) links to the system browser', () => {
    expect(isAllowedExternalUrl('https://example.com')).toBe(true)
    expect(isAllowedExternalUrl('http://example.com')).toBe(true)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedExternalUrl('file:///C:/secret.txt')).toBe(false)
  })

  it('opens window.open targets through the exact owning window focus transaction', async () => {
    let handler: ((details: { url: string }) => { action: 'deny' }) | undefined
    const owner = {
      blur: vi.fn(),
      focus: vi.fn(),
      isDestroyed: vi.fn(() => false),
      webContents: {
        setWindowOpenHandler: vi.fn((next) => { handler = next }),
      },
    }
    const openExternal = vi.fn(async () => undefined)
    installMainWindowExternalLinkHandler(owner, {
      realpath: vi.fn(async (value: string) => value),
      openExternal,
      openPath: vi.fn(async () => ''),
    })

    expect(handler?.({ url: 'https://example.com/from-window-open' }))
      .toEqual({ action: 'deny' })
    await vi.waitFor(() => expect(openExternal)
      .toHaveBeenCalledWith('https://example.com/from-window-open'))
    expect(owner.blur).toHaveBeenCalledOnce()
    expect(owner.focus).not.toHaveBeenCalled()

    openExternal.mockRejectedValueOnce(new Error('launch failed'))
    expect(handler?.({ url: 'https://example.com/failure' })).toEqual({ action: 'deny' })
    await vi.waitFor(() => expect(owner.focus).toHaveBeenCalledOnce())

    expect(handler?.({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })
    expect(owner.blur).toHaveBeenCalledTimes(2)
    expect(openExternal).toHaveBeenCalledTimes(2)
  })

  it('loads the Forge Vite preload output emitted as index.js', () => {
    expect(preloadPathForBuild('C:\\app\\.vite\\build'))
      .toBe('C:\\app\\.vite\\build\\index.js')
  })
})
