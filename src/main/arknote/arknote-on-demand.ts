import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { arknotePaths } from './arknote-paths'
import { arknoteSettingsFromLegacy, copyArknoteSettings, DEFAULT_ARKNOTE_SETTINGS, parseArknoteSettings, type ArknoteSettings } from './arknote-settings-store'

async function readOptionalJson(file: string): Promise<unknown> {
  try { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as unknown }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if (error instanceof SyntaxError) return null
    throw error
  }
}

/** Read only: actual migration and corrupt-file recovery remain owned by Arknote. */
export async function readArknoteSettingsSnapshot(applicationDirectory: string): Promise<ArknoteSettings> {
  const current = await readOptionalJson(arknotePaths(applicationDirectory).settings)
  if (current !== undefined) {
    const parsed = parseArknoteSettings(current)
    if (!parsed) return copyArknoteSettings(DEFAULT_ARKNOTE_SETTINGS)
    if (typeof current === 'object' && current !== null && !Object.hasOwn(current, 'themeColor')) {
      const legacy = await readOptionalJson(path.join(applicationDirectory, 'portable-data', 'settings.json'))
      if (legacy !== undefined) parsed.themeColor = arknoteSettingsFromLegacy(legacy).themeColor
    }
    return parsed
  }
  return arknoteSettingsFromLegacy(await readOptionalJson(path.join(applicationDirectory, 'portable-data', 'settings.json')))
}

export async function initializeArknoteOnDemand(
  readSettings: () => Promise<ArknoteSettings>,
  start: () => Promise<void>,
): Promise<void> {
  const settings = await readSettings()
  if (settings.launchAtLogin) await start()
  // Existing desktop registration survives a service exit. Creation/restoration
  // stays in Arknote's settings queue when that application next starts, so a
  // stale Arkdown snapshot cannot recreate a menu the user just disabled.
}
