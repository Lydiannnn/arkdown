import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EDITOR_APPEARANCE,
  normalizeEditorAppearancePreferences,
  parseEditorAppearancePreferences,
} from '../../src/shared/editor-appearance-preferences'

const legacyAppearance = {
  minimumContentMarginPx: 30,
  maximumContentWidthPx: 1200,
  preserveSingleLineBreaks: false,
  spellCheckEnabled: false,
  showEditIndicators: false,
  headingLatinFont: 'Arial',
  headingCjkFont: 'Microsoft YaHei',
  bodyLatinFont: 'Arial',
  bodyCjkFont: 'Microsoft YaHei',
}

describe('theme color appearance preferences', () => {
  it('defaults to red without resetting legacy appearance values', () => {
    expect(DEFAULT_EDITOR_APPEARANCE.themeColor).toBe('#C62828')
    expect(normalizeEditorAppearancePreferences(legacyAppearance)).toEqual({
      ...legacyAppearance,
      editorTheme: 'system',
      themeColor: '#C62828',
      micaOpacityPercent: 0,
    })
  })

  it('accepts only canonical six-digit hexadecimal colors', () => {
    expect(parseEditorAppearancePreferences({
      ...legacyAppearance,
      themeColor: '#2563EB',
    })).toEqual({
      ...legacyAppearance,
      editorTheme: 'system',
      themeColor: '#2563EB',
      micaOpacityPercent: 0,
    })

    for (const themeColor of ['#fff', '800080', '#GG0080', '#80008080', '']) {
      expect(parseEditorAppearancePreferences({
        ...legacyAppearance,
        themeColor,
      })).toBeUndefined()
    }
  })
})
