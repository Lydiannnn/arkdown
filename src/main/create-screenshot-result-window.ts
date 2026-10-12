import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import path from 'node:path'
import {
  SCREENSHOT_IMAGE_MAX_DIMENSION_PX,
  SCREENSHOT_IMAGE_MAX_PIXELS,
  parseScreenshotSessionInput,
  type ScreenshotRect,
  type ScreenshotSize,
} from '../shared/screenshot-translation'
import { preloadPathForBuild } from './create-main-window'

const MIN_WIDTH = 480
const MIN_HEIGHT = 320
const WORK_AREA_FRACTION = 0.8
const MAX_DIP_VALUE = 1_000_000

function isValidImageSize(value: ScreenshotSize): boolean {
  return Number.isSafeInteger(value.width)
    && Number.isSafeInteger(value.height)
    && value.width > 0
    && value.height > 0
    && value.width <= SCREENSHOT_IMAGE_MAX_DIMENSION_PX
    && value.height <= SCREENSHOT_IMAGE_MAX_DIMENSION_PX
    && value.width * value.height <= SCREENSHOT_IMAGE_MAX_PIXELS
}

function isValidWorkArea(value: ScreenshotRect): boolean {
  return [value.x, value.y, value.width, value.height].every(Number.isFinite)
    && Math.abs(value.x) <= MAX_DIP_VALUE
    && Math.abs(value.y) <= MAX_DIP_VALUE
    && value.width >= MIN_WIDTH
    && value.height >= MIN_HEIGHT
    && value.width <= MAX_DIP_VALUE
    && value.height <= MAX_DIP_VALUE
}

export function calculateScreenshotResultWindowBounds(
  imageSizePx: ScreenshotSize,
  workAreaDip: ScreenshotRect,
): ScreenshotRect {
  if (!isValidImageSize(imageSizePx) || !isValidWorkArea(workAreaDip)) {
    throw new Error('Invalid screenshot result geometry')
  }
  if (workAreaDip.width * WORK_AREA_FRACTION < MIN_WIDTH
    || workAreaDip.height * WORK_AREA_FRACTION < MIN_HEIGHT) {
    throw new Error('Invalid screenshot result geometry')
  }
  const maximumScale = Math.min(
    workAreaDip.width * WORK_AREA_FRACTION / imageSizePx.width,
    workAreaDip.height * WORK_AREA_FRACTION / imageSizePx.height,
  )
  const minimumScale = Math.max(MIN_WIDTH / imageSizePx.width, MIN_HEIGHT / imageSizePx.height)
  const scale = Math.min(maximumScale, Math.max(minimumScale, 1))
  const width = Math.max(MIN_WIDTH, Math.min(Math.round(imageSizePx.width * scale), Math.floor(workAreaDip.width * WORK_AREA_FRACTION)))
  const height = Math.max(MIN_HEIGHT, Math.min(Math.round(imageSizePx.height * scale), Math.floor(workAreaDip.height * WORK_AREA_FRACTION)))
  return {
    x: Math.round(workAreaDip.x + (workAreaDip.width - width) / 2),
    y: Math.round(workAreaDip.y + (workAreaDip.height - height) / 2),
    width,
    height,
  }
}

export function buildScreenshotResultWindowOptions(
  preload: string,
  boundsDip: ScreenshotRect,
): BrowserWindowConstructorOptions {
  if (!isValidWorkArea(boundsDip)) throw new Error('Invalid screenshot result bounds')
  return {
    ...boundsDip,
    title: 'Arkdown截图翻译',
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    show: false,
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    backgroundColor: '#171717',
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  }
}

export function screenshotResultWindowUrl(rendererUrl: string, sessionId: string): string {
  if (!parseScreenshotSessionInput({ sessionId })) throw new Error('Invalid screenshot result route')
  const url = new URL(rendererUrl)
  url.search = ''
  url.hash = ''
  url.searchParams.set('surface', 'screenshot-translation')
  url.searchParams.set('sessionId', sessionId)
  return url.toString()
}

export function createScreenshotResultWindow(input: {
  sessionId: string
  imageSizePx: ScreenshotSize
  workAreaDip: ScreenshotRect
}, configure: (window: BrowserWindow) => void = () => undefined): BrowserWindow {
  if (!parseScreenshotSessionInput({ sessionId: input.sessionId })) {
    throw new Error('Invalid screenshot result route')
  }
  const bounds = calculateScreenshotResultWindowBounds(input.imageSizePx, input.workAreaDip)
  const window = new BrowserWindow(buildScreenshotResultWindowOptions(preloadPathForBuild(__dirname), bounds))
  window.removeMenu()
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.once('ready-to-show', () => {
    window.show()
    window.focus()
  })
  try {
    configure(window)
    let loading: Promise<void>
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      loading = window.loadURL(screenshotResultWindowUrl(MAIN_WINDOW_VITE_DEV_SERVER_URL, input.sessionId))
    } else {
      loading = window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), {
        query: { surface: 'screenshot-translation', sessionId: input.sessionId },
      })
    }
    void loading.catch(() => {
      if (!window.isDestroyed()) window.destroy()
    })
  } catch (error) {
    window.destroy()
    throw error
  }
  return window
}
