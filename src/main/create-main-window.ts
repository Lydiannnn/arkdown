import { BrowserWindow, screen, shell, type BrowserWindowConstructorOptions } from 'electron'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { bindMainWindowNativeSurface } from './main-window-native-surface'
import type { EditorTheme } from '../shared/editor-appearance-preferences'
import { sanitizeWindowBounds, type WindowBounds } from './settings/settings-store'
import {
  createOwnerAwareLinkTargetOpener,
  type LinkTargetOwner,
  type SystemLinkTargetAdapters,
} from './link-target-opener'

export interface WindowChromeTarget {
  setMenuBarVisibility(visible: boolean): void
}

export interface InitialDisplayMetrics {
  size: { width: number; height: number }
  workAreaSize?: { width: number; height: number }
  scaleFactor: number
}

export function initialWindowSizeForDisplay(
  display: InitialDisplayMetrics,
): { width: number; height: number } {
  const usableSize = display.workAreaSize ?? display.size
  const displayWidth = Number.isFinite(usableSize.width) && usableSize.width > 0
    ? Math.floor(usableSize.width)
    : 1800
  const displayHeight = Number.isFinite(usableSize.height) && usableSize.height > 0
    ? Math.floor(usableSize.height)
    : 1080
  return {
    width: Math.min(1800, displayWidth),
    height: Math.min(1080, displayHeight),
  }
}

export function configureWindowChrome(window: WindowChromeTarget): void {
  window.setMenuBarVisibility(false)
}

export function buildWindowOptions(
  preload: string,
  bounds?: WindowBounds,
  display?: InitialDisplayMetrics,
): BrowserWindowConstructorOptions {
  const initialSize = display
    ? initialWindowSizeForDisplay(display)
    : { width: 1800, height: 1080 }
  const safeBounds = sanitizeWindowBounds(bounds)
  const minimumSizeReference = safeBounds ?? initialSize
  const centerWindow = safeBounds?.x === undefined || safeBounds.y === undefined
  const options: BrowserWindowConstructorOptions = {
    ...initialSize,
    minWidth: Math.min(760, minimumSizeReference.width),
    minHeight: Math.min(520, minimumSizeReference.height),
    ...(centerWindow ? { center: true } : {}),
    show: false,
    backgroundMaterial: 'mica',
    roundedCorners: true,
    hasShadow: true,
    thickFrame: true,
    maximizable: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  }
  if (!safeBounds) return options

  const { width, height, x, y } = safeBounds
  return {
    ...options,
    width,
    height,
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
  }
}

export function isAllowedExternalUrl(url: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

export interface MainWindowExternalLinkTarget extends LinkTargetOwner {
  webContents: {
    setWindowOpenHandler(
      handler: (details: { url: string }) => { action: 'deny' },
    ): void
  }
}

export function installMainWindowExternalLinkHandler(
  window: MainWindowExternalLinkTarget,
  adapters: SystemLinkTargetAdapters,
): void {
  const open = createOwnerAwareLinkTargetOpener(window, adapters)
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void open(url).catch(() => undefined)
    return { action: 'deny' }
  })
}

export function preloadPathForBuild(buildDirectory: string): string {
  return path.join(buildDirectory, 'index.js')
}

export interface MainWindowReadyPresentationTarget {
  once(event: 'ready-to-show', listener: () => void): unknown
  show(): void
}

export function installMainWindowReadyPresentation(
  window: MainWindowReadyPresentationTarget,
  showWhenReady: boolean,
): void {
  if (showWhenReady) window.once('ready-to-show', () => window.show())
}

export function createMainWindow(
  bounds?: WindowBounds,
  options: { showWhenReady?: boolean; startupGuide?: boolean; editorTheme?: EditorTheme } = {},
): BrowserWindow {
  const primaryDisplay = screen.getPrimaryDisplay()
  const window = new BrowserWindow(buildWindowOptions(
    preloadPathForBuild(__dirname),
    bounds,
    {
      size: primaryDisplay.size,
      workAreaSize: primaryDisplay.workAreaSize,
      scaleFactor: primaryDisplay.scaleFactor,
    },
  ))
  configureWindowChrome(window)
  if (
    !sanitizeWindowBounds(bounds)
    && primaryDisplay.workAreaSize.width > 1800
    && primaryDisplay.workAreaSize.height > 1080
  ) {
    // Fractional-DPI native frames can inflate the constructor's content size.
    // Correct only the new-window default where the work area has frame headroom.
    window.setContentSize(1800, 1080)
  }

  bindMainWindowNativeSurface(window, options.editorTheme)

  installMainWindowExternalLinkHandler(window, {
    realpath,
    openExternal: (target) => shell.openExternal(target),
    openPath: (target) => shell.openPath(target),
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
    if (options.editorTheme) url.searchParams.set('theme', options.editorTheme)
    if (options.startupGuide) url.searchParams.set('startup', 'guide')
    void window.loadURL(url.href)
  } else {
    void window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), {
      query: {
        ...(options.startupGuide ? { startup: 'guide' } : {}),
        ...(options.editorTheme ? { theme: options.editorTheme } : {}),
      },
    })
  }

  installMainWindowReadyPresentation(window, options.showWhenReady !== false)
  return window
}
