import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import path from 'node:path'
import {
  parseCaptureDisplaySnapshot,
  parseScreenshotSessionInput,
  type CaptureDisplaySnapshot,
  type ScreenshotRect,
} from '../shared/screenshot-translation'
import { preloadPathForBuild } from './create-main-window'

function validBounds(value: ScreenshotRect): boolean {
  return parseCaptureDisplaySnapshot({
    displayId: 'bounds-validation',
    boundsDip: value,
    scaleFactor: 1,
    imageSizePx: { width: 1, height: 1 },
    dataUrl: 'data:image/png;base64,AAAA',
  }) !== undefined
}

export function buildScreenshotSelectionWindowOptions(
  preload: string,
  boundsDip: ScreenshotRect,
): BrowserWindowConstructorOptions {
  if (!validBounds(boundsDip)) throw new Error('Invalid screenshot overlay bounds')
  return {
    x: boundsDip.x, y: boundsDip.y, width: boundsDip.width, height: boundsDip.height,
    frame: false, transparent: true, backgroundColor: '#00000000', show: false, fullscreen: true,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: true, skipTaskbar: true, focusable: true, hasShadow: false,
    roundedCorners: false, thickFrame: false, alwaysOnTop: true,
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  }
}

export function screenshotSelectionWindowUrl(rendererUrl: string, sessionId: string, displayId: string): string {
  const display = parseCaptureDisplaySnapshot({
    displayId, boundsDip: { x: 0, y: 0, width: 1, height: 1 }, scaleFactor: 1,
    imageSizePx: { width: 1, height: 1 }, dataUrl: 'data:image/png;base64,AAAA',
  })
  if (!display || !parseScreenshotSessionInput({ sessionId })) throw new Error('Invalid screenshot overlay route')
  const url = new URL(rendererUrl)
  url.search = ''
  url.searchParams.set('surface', 'screenshot-selection')
  url.searchParams.set('sessionId', sessionId)
  url.searchParams.set('displayId', display.displayId)
  return url.toString()
}

export function createScreenshotSelectionWindow(input: { sessionId: string; display: CaptureDisplaySnapshot }): BrowserWindow {
  const display = parseCaptureDisplaySnapshot(input.display)
  if (!display) throw new Error('Invalid screenshot display')
  if (!parseScreenshotSessionInput({ sessionId: input.sessionId })) throw new Error('Invalid screenshot overlay route')
  const window = new BrowserWindow(buildScreenshotSelectionWindowOptions(preloadPathForBuild(__dirname), display.boundsDip))
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(screenshotSelectionWindowUrl(MAIN_WINDOW_VITE_DEV_SERVER_URL, input.sessionId, display.displayId))
  } else {
    void window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), {
      query: { surface: 'screenshot-selection', sessionId: input.sessionId, displayId: display.displayId },
    })
  }
  return window
}
