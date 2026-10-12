import type { DataRoot } from './portable-paths'
import { migrateFontDefaults } from './font-defaults-migration'
import { DEFAULT_SETTINGS, type AppSettings } from './settings-store'
import type { SettingsAuthority } from './settings-authority'
import type { FloatingTranslationSettings } from '../../shared/large-model-settings'

export interface StartupSettingsStore {
  load(): Promise<AppSettings>
  save(settings: AppSettings): Promise<void>
}

export interface StartupDataRootOptions {
  executablePath: string
  fallbackUserDataPath: string
  isPackaged: boolean
}

/** Transaction composition resolves one root and never substitutes a writable default profile. */
export async function loadAuthoritativeStartupSettings<T extends Pick<SettingsAuthority, 'migrateStartupSettings'>>(
  options: StartupDataRootOptions,
  resolveDataRoot: (options: StartupDataRootOptions) => Promise<DataRoot>,
  createAuthority: (root: string) => T,
  beforeLoad?: (root: string) => Promise<void>,
  readLegacyFloatingTranslation?: (root: string) => Promise<FloatingTranslationSettings | undefined>,
) {
  const dataRoot = await resolveDataRoot(options)
  await beforeLoad?.(dataRoot.path)
  const authority = createAuthority(dataRoot.path)
  const legacy = await readLegacyFloatingTranslation?.(dataRoot.path)
  const snapshot = await authority.migrateStartupSettings(legacy)
  return { dataRoot, authority, snapshot }
}

export async function loadStartupSettings<T extends StartupSettingsStore>(
  options: StartupDataRootOptions,
  resolveDataRoot: (options: StartupDataRootOptions) => Promise<DataRoot>,
  createStore: (root: string) => T,
  reportError: (message: string, error: unknown) => void,
  beforeLoad?: (root: string) => Promise<void>,
): Promise<{ settingsStore: T; settings: AppSettings }> {
  try {
    const dataRoot = await resolveDataRoot(options)
    const settingsStore = createStore(dataRoot.path)
    await beforeLoad?.(dataRoot.path)
    const loadedSettings = await settingsStore.load()
    const migration = migrateFontDefaults(loadedSettings)

    if (migration.changed) {
      try {
        await settingsStore.save(migration.settings)
      } catch (error) {
        reportError('Could not persist font defaults migration', error)
      }
    }

    return {
      settingsStore,
      settings: migration.settings,
    }
  } catch (error) {
    reportError('Could not initialize settings', error)
    return { settingsStore: createStore(options.fallbackUserDataPath), settings: { ...DEFAULT_SETTINGS } }
  }
}
