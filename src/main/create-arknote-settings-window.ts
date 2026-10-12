import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import path from 'node:path'
import { preloadPathForBuild } from './create-main-window'
import { configureArknoteSurfaceWindow } from './create-arknote-box-window'

export type ArknoteSettingsSection = 'startup' | 'colors' | 'textures' | 'tray'

export function buildArknoteSettingsWindowOptions(
  preload: string,
): BrowserWindowConstructorOptions {
  return {
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    show: false,
    title: '设置 — Arknote',
    roundedCorners: true,
    hasShadow: true,
    frame: false,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  }
}

export function arknoteSettingsWindowUrl(
  baseUrl: string,
  section?: ArknoteSettingsSection,
): string {
  const url = new URL(baseUrl)
  url.searchParams.set('surface', 'arknote-settings')
  if (section) url.searchParams.set('section', section)
  return url.toString()
}

export function createArknoteSettingsWindow(
  section?: ArknoteSettingsSection,
): BrowserWindow {
  const window = new BrowserWindow(
    buildArknoteSettingsWindowOptions(preloadPathForBuild(__dirname)),
  )
  configureArknoteSurfaceWindow(window)
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(arknoteSettingsWindowUrl(MAIN_WINDOW_VITE_DEV_SERVER_URL, section))
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      { query: {
        surface: 'arknote-settings',
        ...(section ? { section } : {}),
      } },
    )
  }
  return window
}
