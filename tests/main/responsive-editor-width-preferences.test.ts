import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EDITOR_APPEARANCE,
  parseEditorAppearancePreferences,
} from '../../src/shared/editor-appearance-preferences'

const responsiveDefaults = {
  minimumContentMarginPx: 50,
  maximumContentWidthPx: 800,
  preserveSingleLineBreaks: true,
  spellCheckEnabled: false,
  showEditIndicators: true,
  editorTheme: 'system',
  headingLatinFont: 'Segoe UI Variable Text',
  headingCjkFont: 'Microsoft YaHei UI',
  bodyLatinFont: 'Segoe UI Variable Text',
  bodyCjkFont: 'Microsoft YaHei UI',
  themeColor: '#C62828',
  micaOpacityPercent: 0,
}

describe('responsive editor width preferences', () => {
  it('uses the approved logical-pixel defaults', () => {
    expect(DEFAULT_EDITOR_APPEARANCE).toEqual(responsiveDefaults)
  })

  it('accepts only the approved margin and body-width ranges', () => {
    expect(parseEditorAppearancePreferences({
      ...responsiveDefaults,
      minimumContentMarginPx: 30,
      maximumContentWidthPx: 600,
    })).toEqual({
      ...responsiveDefaults,
      minimumContentMarginPx: 30,
      maximumContentWidthPx: 600,
    })
    expect(parseEditorAppearancePreferences({
      ...responsiveDefaults,
      minimumContentMarginPx: 150,
      maximumContentWidthPx: 1200,
    })).toEqual({
      ...responsiveDefaults,
      minimumContentMarginPx: 150,
      maximumContentWidthPx: 1200,
    })
    expect(parseEditorAppearancePreferences({
      ...responsiveDefaults,
      minimumContentMarginPx: 29,
    })).toBeUndefined()
    expect(parseEditorAppearancePreferences({
      ...responsiveDefaults,
      minimumContentMarginPx: 151,
    })).toBeUndefined()
    expect(parseEditorAppearancePreferences({
      ...responsiveDefaults,
      maximumContentWidthPx: 599,
    })).toBeUndefined()
    expect(parseEditorAppearancePreferences({
      ...responsiveDefaults,
      maximumContentWidthPx: 1201,
    })).toBeUndefined()
  })

  it('migrates a complete percentage-width preference without resetting unrelated values', () => {
    expect(parseEditorAppearancePreferences({
      contentWidthPercent: 92,
      preserveSingleLineBreaks: false,
      showEditIndicators: false,
      headingLatinFont: 'Arial',
      headingCjkFont: 'SimHei',
      bodyLatinFont: 'Arial',
      bodyCjkFont: 'SimHei',
      themeColor: '#800080',
      micaOpacityPercent: 45,
    })).toEqual({
      ...responsiveDefaults,
      preserveSingleLineBreaks: false,
      showEditIndicators: false,
      headingLatinFont: 'Arial',
      headingCjkFont: 'SimHei',
      bodyLatinFont: 'Arial',
      bodyCjkFont: 'SimHei',
      themeColor: '#800080',
      micaOpacityPercent: 0,
    })
  })
})
