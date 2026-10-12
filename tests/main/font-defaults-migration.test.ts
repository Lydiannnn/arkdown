import { expect, it, vi } from 'vitest'
import { migrateFontDefaults } from '../../src/main/settings/font-defaults-migration'
import type { AppSettings } from '../../src/main/settings/settings-store'
import { loadStartupSettings } from '../../src/main/settings/startup-settings'

const legacyAppearance = {
  minimumContentMarginPx: 30,
  maximumContentWidthPx: 1200,
  preserveSingleLineBreaks: false,
  spellCheckEnabled: false,
  showEditIndicators: false,
  editorTheme: 'minimal' as const,
  headingLatinFont: 'Georgia',
  headingCjkFont: 'SimHei',
  bodyLatinFont: 'Arial',
  bodyCjkFont: 'SimSun',
  themeColor: '#800080',
  micaOpacityPercent: 0 as const,
}

const options = {
  executablePath: 'C:\\Arkdown\\Arkdown.exe',
  fallbackUserDataPath: 'C:\\fallback',
  isPackaged: true,
}

const resolveDataRoot = async () => ({
  path: 'C:\\Arkdown',
  portable: true,
})

it('preserves every custom font while updating the migration marker', async () => {
  const legacySettings: AppSettings = {
    lastWorkspace: 'C:\\workspace',
    appearance: legacyAppearance,
  }
  const store = {
    load: vi.fn(async () => legacySettings),
    save: vi.fn(async () => undefined),
  }

  const result = await loadStartupSettings(
    options,
    resolveDataRoot,
    () => store,
    vi.fn(),
  )

  expect(result.settings).toEqual({
    lastWorkspace: 'C:\\workspace',
    fontDefaultsVersion: 3,
    appearance: {
      ...legacyAppearance,
      micaOpacityPercent: 0,
    },
  })
  expect(store.save).toHaveBeenCalledOnce()
  expect(store.save).toHaveBeenCalledWith(result.settings)
})

it('does not overwrite a later font choice after the migration marker is current', async () => {
  const currentSettings = {
    lastWorkspace: null,
    fontDefaultsVersion: 3,
    appearance: {
      ...legacyAppearance,
      headingLatinFont: 'Georgia',
      bodyLatinFont: 'Georgia',
    },
  } as AppSettings
  const store = {
    load: vi.fn(async () => currentSettings),
    save: vi.fn(async () => undefined),
  }

  const result = await loadStartupSettings(
    options,
    resolveDataRoot,
    () => store,
    vi.fn(),
  )

  expect(result.settings).toBe(currentSettings)
  expect(result.settings.appearance?.headingLatinFont).toBe('Georgia')
  expect(result.settings.appearance?.bodyLatinFont).toBe('Georgia')
  expect(store.save).not.toHaveBeenCalled()
})

it('uses migrated fonts for the current run when persisting the marker fails', async () => {
  const saveError = new Error('disk full')
  const reportError = vi.fn()
  const store = {
    load: vi.fn(async (): Promise<AppSettings> => ({
      lastWorkspace: null,
      appearance: legacyAppearance,
    })),
    save: vi.fn(async () => Promise.reject(saveError)),
  }

  const result = await loadStartupSettings(
    options,
    resolveDataRoot,
    () => store,
    reportError,
  )

  expect(result.settings.fontDefaultsVersion).toBe(3)
  expect(result.settings.appearance?.bodyCjkFont).toBe('SimSun')
  expect(result.settingsStore).toBe(store)
  expect(reportError).toHaveBeenCalledWith(
    'Could not persist font defaults migration',
    saveError,
  )
})

const oldDefaults = { ...legacyAppearance,
  headingLatinFont: 'Microsoft YaHei', headingCjkFont: 'Microsoft YaHei',
  bodyLatinFont: 'Microsoft YaHei', bodyCjkFont: 'Microsoft YaHei',
}

it.each([undefined, 1])('migrates all old default fonts together from marker %s without mutating input', (marker) => {
  const settings = { lastWorkspace: null, fontDefaultsVersion: marker, appearance: oldDefaults }
  const original = structuredClone(settings)
  expect(migrateFontDefaults(settings)).toEqual({ changed: true, settings: {
    ...settings, fontDefaultsVersion: 3, appearance: { ...oldDefaults,
      headingLatinFont: 'Segoe UI Variable Text', headingCjkFont: 'Microsoft YaHei UI',
      bodyLatinFont: 'Segoe UI Variable Text', bodyCjkFont: 'Microsoft YaHei UI',
    },
  } })
  expect(settings).toEqual(original)
})

it('preserves all four fonts in a mixed custom/default configuration', () => {
  const appearance = { ...oldDefaults, bodyLatinFont: 'Georgia' }
  const result = migrateFontDefaults({ lastWorkspace: null, appearance })
  expect(result.settings.appearance).toEqual(appearance)
  expect(result.settings.fontDefaultsVersion).toBe(3)
})

it('uses system fonts for absent appearance and preserves later all-YaHei choice', () => {
  expect(migrateFontDefaults({ lastWorkspace: null }).settings.appearance).toMatchObject({
    headingLatinFont: 'Segoe UI Variable Text', headingCjkFont: 'Microsoft YaHei UI',
    bodyLatinFont: 'Segoe UI Variable Text', bodyCjkFont: 'Microsoft YaHei UI',
  })
  const settings = { lastWorkspace: null, fontDefaultsVersion: 3, appearance: oldDefaults }
  expect(migrateFontDefaults(settings)).toEqual({ changed: false, settings })
})
