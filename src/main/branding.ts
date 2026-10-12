import path from 'node:path'
import { app } from 'electron'
import type { BrandingRuntimeFile } from '../shared/branding'
import type { DesktopAppMode } from './app-mode'

export function brandingResourcePath(file: BrandingRuntimeFile): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'branding', file)
    : path.join(app.getAppPath(), 'assets', 'branding', file)
}

/** Set the native icon without changing custom title bars or window behavior. */
export function configureApplicationBranding(mode: DesktopAppMode): void {
  if (process.platform === 'win32') app.setAppUserModelId(mode === 'arknote' ? 'Arknote.Desktop' : 'Arkdown.Desktop')
  app.on('browser-window-created', (_event, window) => {
    window.setIcon(brandingResourcePath(mode === 'arknote' ? 'arknote-app-256.png' : 'arkdown-app-rounded-256.png'))
  })
}
