import { app, BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import path from 'node:path'
import { preloadPathForBuild } from './create-main-window'

export function buildStickyNoteContextMenuWindowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    width: 1,
    height: 1,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    opacity: 0,
    hasShadow: false,
    thickFrame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    title: 'Arknote Menu',
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  }
}

export function stickyNoteContextMenuWindowUrl(rendererUrl: string): string {
  const url = new URL(rendererUrl)
  url.search = ''
  url.searchParams.set('surface', 'sticky-note-context-menu')
  return url.toString()
}

export function withoutStickyNoteContextMenuAnimation(changeVisibility: () => void): void {
  const animationSwitch = 'wm-window-animations-disabled'
  if (process.platform !== 'win32' || app.commandLine.hasSwitch(animationSwitch)) {
    changeVisibility()
    return
  }

  // Aura checks this switch synchronously for BOTH visibility transitions.
  // Mixing an animated hide with an unanimated show can leave the cached layer
  // transparent. Keep both transitions under the same visibility policy.
  // Scope the override to this call so other windows retain their animation policy.
  app.commandLine.appendSwitch(animationSwitch)
  try {
    changeVisibility()
  } finally {
    app.commandLine.removeSwitch(animationSwitch)
  }
}

export function createStickyNoteContextMenuBrowserWindow(): BrowserWindow & { whenReady(): Promise<void> } {
  const window = new BrowserWindow(buildStickyNoteContextMenuWindowOptions(
    preloadPathForBuild(__dirname),
  ))
  window.setAlwaysOnTop(true, 'pop-up-menu')
  // The idle surface stays native-visible after its first show. Ignore input
  // completely while idle, including Chromium's optional mouse-move forwarding.
  window.setIgnoreMouseEvents(true)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  const ready = new Promise<void>((resolve) => window.webContents.once('did-finish-load', () => resolve()))

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(stickyNoteContextMenuWindowUrl(MAIN_WINDOW_VITE_DEV_SERVER_URL))
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      { query: { surface: 'sticky-note-context-menu' } },
    )
  }
  const showInactive = window.showInactive.bind(window)
  const hide = window.hide.bind(window)
  return Object.assign(window, {
    whenReady: () => ready,
    showInactive: () => withoutStickyNoteContextMenuAnimation(showInactive),
    hide: () => withoutStickyNoteContextMenuAnimation(hide),
  })
}
