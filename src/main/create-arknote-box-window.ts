import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import path from 'node:path'
import type { StickyNoteWindowBounds } from '../shared/sticky-notes'
import { preloadPathForBuild } from './create-main-window'

const DEFAULT_WIDTH = 420
const DEFAULT_HEIGHT = 720
const MINIMUM_WIDTH = 360
const MINIMUM_HEIGHT = 480


export interface ArknoteSurfaceWindowTarget {
  setMenuBarVisibility(visible: boolean): void
  webContents: {
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
    on(event: 'will-navigate', handler: (event: { preventDefault(): void }) => void): void
  }
}

export function configureArknoteSurfaceWindow(window: ArknoteSurfaceWindowTarget): void {
  window.setMenuBarVisibility(false)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
}

function validBounds(value: StickyNoteWindowBounds | null | undefined): value is StickyNoteWindowBounds {
  return !!value
    && Number.isSafeInteger(value.x)
    && Number.isSafeInteger(value.y)
    && Number.isSafeInteger(value.width)
    && Number.isSafeInteger(value.height)
    && value.width >= MINIMUM_WIDTH
    && value.height >= MINIMUM_HEIGHT
    && value.width <= 10_000
    && value.height <= 10_000
}

export function buildArknoteBoxWindowOptions(
  preload: string,
  bounds?: StickyNoteWindowBounds | null,
): BrowserWindowConstructorOptions {
  return {
    width: validBounds(bounds) ? bounds.width : DEFAULT_WIDTH,
    height: validBounds(bounds) ? bounds.height : DEFAULT_HEIGHT,
    ...(validBounds(bounds) ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: MINIMUM_WIDTH,
    minHeight: MINIMUM_HEIGHT,
    show: false,
    title: '便签盒子 — Arknote',
    roundedCorners: true,
    hasShadow: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#303030',
      height: 40,
    },
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  }
}

export function arknoteBoxWindowUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  url.searchParams.set('surface', 'arknote-box')
  return url.toString()
}

export function createArknoteBoxWindow(
  bounds?: StickyNoteWindowBounds | null,
): BrowserWindow {
  const window = new BrowserWindow(
    buildArknoteBoxWindowOptions(preloadPathForBuild(__dirname), bounds),
  )
  configureArknoteSurfaceWindow(window)
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(arknoteBoxWindowUrl(MAIN_WINDOW_VITE_DEV_SERVER_URL))
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      { query: { surface: 'arknote-box' } },
    )
  }
  return window
}
