import { DEFAULT_EDITOR_APPEARANCE, normalizeEditorAppearancePreferences } from '../../shared/editor-appearance-preferences'
import type { AppSettings } from './settings-store'

export const FONT_DEFAULTS_VERSION = 3

const MICROSOFT_YAHEI = 'Microsoft YaHei'

export interface FontDefaultsMigrationResult {
  settings: AppSettings
  changed: boolean
}

export function migrateFontDefaults(settings: AppSettings): FontDefaultsMigrationResult {
  if (settings.fontDefaultsVersion === FONT_DEFAULTS_VERSION) {
    return { settings, changed: false }
  }

  const appearance = normalizeEditorAppearancePreferences(settings.appearance)
  // Settings did not distinguish explicit choices from defaults. Upgrade only a
  // complete previous default set; preserve mixed/custom fonts and later YaHei choices.
  const fonts = [appearance.headingLatinFont, appearance.headingCjkFont,
    appearance.bodyLatinFont, appearance.bodyCjkFont]
  const allOldDefaults = fonts.every((font) => font === 'Noto Sans SC')
    || ((settings.fontDefaultsVersion ?? 0) < 2 && fonts.every((font) => font === MICROSOFT_YAHEI))

  return {
    changed: true,
    settings: {
      ...settings,
      fontDefaultsVersion: FONT_DEFAULTS_VERSION,
      appearance: allOldDefaults ? {
        ...appearance,
        headingLatinFont: DEFAULT_EDITOR_APPEARANCE.headingLatinFont,
        headingCjkFont: DEFAULT_EDITOR_APPEARANCE.headingCjkFont,
        bodyLatinFont: DEFAULT_EDITOR_APPEARANCE.bodyLatinFont,
        bodyCjkFont: DEFAULT_EDITOR_APPEARANCE.bodyCjkFont,
      } : appearance,
    },
  }
}
