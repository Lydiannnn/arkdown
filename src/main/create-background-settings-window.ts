import { BrowserWindow, screen, type BrowserWindowConstructorOptions } from 'electron'
import path from 'node:path'
import type { BackgroundTarget } from '../shared/background-settings'
import type { EditorTheme } from '../shared/editor-appearance-preferences'
import { isCanonicalStickyNoteId } from '../shared/sticky-notes'
import { preloadPathForBuild } from './create-main-window'

export function buildBackgroundSettingsWindowOptions(
  preload: string,
  workArea?: { x: number; y: number; width: number; height: number },
  theme?: EditorTheme,
): BrowserWindowConstructorOptions {
  const width = Math.min(600, workArea?.width ?? 600)
  const height = Math.min(1000, workArea?.height ?? 1000)
  return {
    width,
    height,
    minWidth: Math.min(576, width),
    minHeight: Math.min(560, height),
    ...(workArea ? {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
    } : {}),
    minimizable: false,
    maximizable: false,
    show: false,
    title: '设置背景 — Arkdown',
    ...(theme ? { backgroundColor: theme === 'dark' ? '#181818' : '#FFFFFF' } : {}),
    roundedCorners: true,
    hasShadow: true,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  }
}

function backgroundSettingsTargetQuery(target: BackgroundTarget): Record<string, string> {
  if (target.kind === 'main') return { target: 'main' }
  if (target.kind === 'sticky-note' && isCanonicalStickyNoteId(target.noteId)) {
    return { target: 'sticky-note', noteId: target.noteId }
  }
  throw new Error('便签 ID 无效')
}

export function backgroundSettingsWindowUrl(
  rendererUrl: string,
  target: BackgroundTarget,
  theme?: EditorTheme,
): string {
  const url = new URL(rendererUrl)
  const query = backgroundSettingsTargetQuery(target)
  url.search = ''
  url.searchParams.set('surface', 'background-settings')
  url.searchParams.set('target', query.target)
  if (query.noteId) url.searchParams.set('noteId', query.noteId)
  if (theme) url.searchParams.set('theme', theme)
  return url.toString()
}

export function createBackgroundSettingsWindow(target: BackgroundTarget, theme?: EditorTheme): BrowserWindow {
  const query = backgroundSettingsTargetQuery(target)
  const window = new BrowserWindow(buildBackgroundSettingsWindowOptions(
    preloadPathForBuild(__dirname),
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
    theme,
  ))
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(backgroundSettingsWindowUrl(MAIN_WINDOW_VITE_DEV_SERVER_URL, target, theme))
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      { query: { surface: 'background-settings', ...query, ...(theme ? { theme } : {}) } },
    )
  }
  return window
}
