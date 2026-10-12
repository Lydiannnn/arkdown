import type { ArknotePreferencesUpdate } from '../../shared/arknote-preferences'
import type { ArknoteClientRuntime } from './arknote-client-runtime'
import { arknotePreferencesFromSettings, arknoteSettingsForPreferencesUpdate, parseArknoteSettings, type ArknoteSettings } from './arknote-settings-store'

/** Arkdown's existing settings pipe bridge, preserving omitted material groups end to end. */
export function createArknotePreferencesClient(
  client: Pick<ArknoteClientRuntime, 'request'> & Partial<Pick<ArknoteClientRuntime, 'requestIfConnected'>>,
  readOffline?: () => Promise<ArknoteSettings>,
) {
  const readSettings = async () => readOffline
    ? (await client.requestIfConnected?.('settings.get', {}, parseArknoteSettings)) ?? await readOffline()
    : client.request('settings.get', {}, parseArknoteSettings)
  return {
    readSettings,
    get: async () => arknotePreferencesFromSettings(await readSettings()),
    set: async (preferences: ArknotePreferencesUpdate) => {
      // A user edit is allowed to start Arknote. Read its live state after any
      // startup migration before constructing the existing single-writer update.
      const current = await client.request('settings.get', {}, parseArknoteSettings)
      const saved = await client.request('settings.set',
        arknoteSettingsForPreferencesUpdate(current, preferences), parseArknoteSettings)
      return arknotePreferencesFromSettings(saved)
    },
  }
}
