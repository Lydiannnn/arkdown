import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ARKNOTE_PREFERENCES,
  parseArknotePreferences,
} from '../../src/shared/arknote-preferences'
import { DEFAULT_THEME_COLOR } from '../../src/shared/theme-color'

describe('Arknote theme preferences', () => {
  it('defaults legacy preferences and strictly parses a saved theme color', () => {
    expect(DEFAULT_ARKNOTE_PREFERENCES.themeColor).toBe(DEFAULT_THEME_COLOR)
    expect(parseArknotePreferences({
      launchAtLogin: false,
      registerDesktopContextMenu: false,
      startupHintDismissed: false,
      stickyNotes: DEFAULT_ARKNOTE_PREFERENCES.stickyNotes,
    })?.themeColor).toBe(DEFAULT_THEME_COLOR)
    expect(parseArknotePreferences({
      ...DEFAULT_ARKNOTE_PREFERENCES,
      themeColor: '#2563EB',
    })?.themeColor).toBe('#2563EB')
    expect(parseArknotePreferences({
      ...DEFAULT_ARKNOTE_PREFERENCES,
      themeColor: 'blue',
    })).toBeUndefined()
  })
})
