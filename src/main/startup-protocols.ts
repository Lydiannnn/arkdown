import type { CustomScheme } from 'electron'
import type { DesktopAppMode } from './app-mode'
import { ASSET_PROTOCOL } from '../shared/asset-protocol'
import { SCREENSHOT_OCR_PROTOCOL } from '../shared/screenshot-ocr-manifest'

/** Electron requires exactly one registration before ready, before lazy entrypoints. */
export function registerStartupProtocols(mode: DesktopAppMode, protocol: { registerSchemesAsPrivileged(schemes: CustomScheme[]): void }): void {
  const schemes: CustomScheme[] = [{
    scheme: ASSET_PROTOCOL,
    privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true },
  }]
  if (mode === 'arkdown') schemes.push({
    scheme: SCREENSHOT_OCR_PROTOCOL,
    privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  })
  protocol.registerSchemesAsPrivileged(schemes)
}
