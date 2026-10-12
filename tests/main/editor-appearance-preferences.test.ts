import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EDITOR_APPEARANCE,
  normalizeEditorAppearancePreferences,
  parseCompleteEditorAppearancePreferences,
  parseEditorAppearancePreferences,
} from '../../src/shared/editor-appearance-preferences'
import type { EditorAppearancePreferences } from '../../src/shared/editor-appearance-preferences'

const canonicalMicaOpacity: EditorAppearancePreferences['micaOpacityPercent'] = 0
// @ts-expect-error Canonical preferences never carry historical nonzero Mica opacity.
const nonCanonicalMicaOpacity: EditorAppearancePreferences['micaOpacityPercent'] = 30
void canonicalMicaOpacity
void nonCanonicalMicaOpacity

const defaults = {
  minimumContentMarginPx: 50,
  maximumContentWidthPx: 800,
  preserveSingleLineBreaks: true,
  spellCheckEnabled: false,
  showEditIndicators: true,
  editorTheme: 'system' as const,
  headingLatinFont: 'Segoe UI Variable Text',
  headingCjkFont: 'Microsoft YaHei UI',
  bodyLatinFont: 'Segoe UI Variable Text',
  bodyCjkFont: 'Microsoft YaHei UI',
  themeColor: '#C62828',
  micaOpacityPercent: 0,
}

describe('editor appearance preferences', () => {
  it('defaults fresh appearance to system and defaults Mica opacity to zero', () => {
    expect(DEFAULT_EDITOR_APPEARANCE).toMatchObject({
      editorTheme: 'system',
      micaOpacityPercent: 0,
    })
    expect(normalizeEditorAppearancePreferences(undefined)).toMatchObject({
      editorTheme: 'system',
      micaOpacityPercent: 0,
    })
  })

  it('migrates missing current and legacy theme/Mica fields without resetting saved values', () => {
    const currentBeforeTheme = {
      minimumContentMarginPx: 42,
      maximumContentWidthPx: 1110,
      preserveSingleLineBreaks: false,
      spellCheckEnabled: true,
      showEditIndicators: false,
      headingLatinFont: 'Georgia',
      headingCjkFont: 'SimHei',
      bodyLatinFont: 'Arial',
      bodyCjkFont: 'SimSun',
      themeColor: '#2563EB',
    }
    expect(parseEditorAppearancePreferences(currentBeforeTheme)).toEqual({
      ...currentBeforeTheme,
      editorTheme: 'system',
      micaOpacityPercent: 0,
    })

    const legacyBeforeTheme = {
      contentWidthPercent: 100,
      preserveSingleLineBreaks: false,
      spellCheckEnabled: true,
      showEditIndicators: false,
      headingLatinFont: 'Georgia',
      headingCjkFont: 'SimHei',
      bodyLatinFont: 'Arial',
      bodyCjkFont: 'SimSun',
      themeColor: '#2563EB',
    }
    expect(parseEditorAppearancePreferences(legacyBeforeTheme)).toEqual({
      minimumContentMarginPx: 50,
      maximumContentWidthPx: 800,
      preserveSingleLineBreaks: false,
      spellCheckEnabled: true,
      showEditIndicators: false,
      headingLatinFont: 'Georgia',
      headingCjkFont: 'SimHei',
      bodyLatinFont: 'Arial',
      bodyCjkFont: 'SimSun',
      themeColor: '#2563EB',
      editorTheme: 'system',
      micaOpacityPercent: 0,
    })
  })

  it.each([0, 30, 72, 100])('normalizes explicitly stored Mica opacity %i to zero', (micaOpacityPercent) => {
    const saved = { ...defaults, micaOpacityPercent }
    expect(parseEditorAppearancePreferences(saved)).toEqual({
      ...saved,
      micaOpacityPercent: 0,
    })
  })

  it('accepts only the stable minimal theme and rejects old menu labels', () => {
    expect(parseEditorAppearancePreferences({
      ...defaults,
    })).toEqual({
      ...defaults,
    })
    for (const editorTheme of ['GitHub', 'github', 'unknown', null, undefined]) {
      expect(parseEditorAppearancePreferences({ ...defaults, editorTheme })).toBeUndefined()
    }
  })

  it('exposes a complete parser that rejects migration-shaped current payloads', () => {
    const complete = { ...defaults }
    expect(parseCompleteEditorAppearancePreferences(complete)).toEqual(complete)
    const { editorTheme: _missingTheme, ...missingTheme } = complete
    const { micaOpacityPercent: _missingMica, ...missingMica } = complete
    expect(parseCompleteEditorAppearancePreferences(missingTheme)).toBeUndefined()
    expect(parseCompleteEditorAppearancePreferences(missingMica)).toBeUndefined()
    expect(parseCompleteEditorAppearancePreferences({
      ...complete,
      micaOpacityPercent: 72,
    })).toBeUndefined()
    expect(parseCompleteEditorAppearancePreferences({ ...complete, extra: true })).toBeUndefined()
  })

  it('defaults heading and body text to the Windows Latin and CJK font families', () => {
    expect(DEFAULT_EDITOR_APPEARANCE).toEqual(defaults)
    expect(normalizeEditorAppearancePreferences(undefined)).toEqual(defaults)
  })

  it('preserves layout values explicitly saved by existing users', () => {
    const existing = {
      ...defaults,
      minimumContentMarginPx: 30,
      maximumContentWidthPx: 1200,
    }

    expect(normalizeEditorAppearancePreferences(existing)).toEqual(existing)
  })

  it('migrates a missing spelling preference to false without resetting unrelated values', () => {
    const { spellCheckEnabled: _missing, ...storedBeforeSpelling } = {
      ...defaults,
      minimumContentMarginPx: 30,
      maximumContentWidthPx: 1200,
      preserveSingleLineBreaks: false,
      themeColor: '#2563EB',
      micaOpacityPercent: 72,
    }

    expect(parseEditorAppearancePreferences(storedBeforeSpelling)).toEqual({
      ...storedBeforeSpelling,
      spellCheckEnabled: false,
      micaOpacityPercent: 0,
    })
  })

  it.each([true, false])('round-trips the exact boolean spelling value %s', (spellCheckEnabled) => {
    expect(parseEditorAppearancePreferences({
      ...defaults,
      spellCheckEnabled,
    })).toEqual({
      ...defaults,
      spellCheckEnabled,
    })
  })

  it('defaults only a missing edit-indicator preference while preserving current values', () => {
    const { showEditIndicators: _missing, ...storedBeforeEditIndicators } = {
      ...defaults,
      minimumContentMarginPx: 42,
      maximumContentWidthPx: 1110,
      preserveSingleLineBreaks: false,
      spellCheckEnabled: true,
      themeColor: '#2563EB',
      micaOpacityPercent: 72,
    }

    expect(parseEditorAppearancePreferences(storedBeforeEditIndicators)).toEqual({
      ...storedBeforeEditIndicators,
      showEditIndicators: true,
      micaOpacityPercent: 0,
    })
  })

  it.each([true, false])('round-trips the exact edit-indicator value %s', (showEditIndicators) => {
    expect(parseEditorAppearancePreferences({
      ...defaults,
      showEditIndicators,
    })).toEqual({
      ...defaults,
      showEditIndicators,
    })
  })

  it.each([undefined, null, 0, 1, 'true'])('rejects a present malformed edit-indicator value %j', (showEditIndicators) => {
    expect(parseEditorAppearancePreferences({
      ...defaults,
      showEditIndicators,
    })).toBeUndefined()
  })

  it.each([null, 1, 'true'])('rejects malformed spelling value %j', (spellCheckEnabled) => {
    expect(parseEditorAppearancePreferences({
      ...defaults,
      spellCheckEnabled,
    })).toBeUndefined()
  })

  it('accepts exact responsive width settings only inside their approved ranges', () => {
    expect(parseEditorAppearancePreferences({
      ...defaults,
      minimumContentMarginPx: 150,
      maximumContentWidthPx: 600,
    })).toEqual({
      ...defaults,
      minimumContentMarginPx: 150,
      maximumContentWidthPx: 600,
    })
    expect(parseEditorAppearancePreferences({
      ...defaults,
      minimumContentMarginPx: 29,
    })).toBeUndefined()
    expect(parseEditorAppearancePreferences({
      ...defaults,
      maximumContentWidthPx: 1200.5,
    })).toBeUndefined()
    expect(parseEditorAppearancePreferences({ ...defaults, extra: true })).toBeUndefined()
  })

  it('defaults legacy appearance to zero percent Mica opacity without resetting other values', () => {
    const { micaOpacityPercent: _missing, ...legacyAppearance } = defaults

    expect(normalizeEditorAppearancePreferences(legacyAppearance)).toEqual(defaults)
  })

  it('accepts safe historical Mica opacity values only to canonicalize them to zero', () => {
    expect(parseEditorAppearancePreferences({
      ...defaults,
      micaOpacityPercent: 0,
    })).toEqual({
      ...defaults,
      micaOpacityPercent: 0,
    })
    expect(parseEditorAppearancePreferences({
      ...defaults,
      micaOpacityPercent: 100,
    })).toEqual({
      ...defaults,
      micaOpacityPercent: 0,
    })
    for (const micaOpacityPercent of [-1, 101, 30.5]) {
      expect(parseEditorAppearancePreferences({
        ...defaults,
        micaOpacityPercent,
      })).toBeUndefined()
    }
  })

  it('rejects unsafe or empty font family values', () => {
    expect(parseEditorAppearancePreferences({ ...defaults, bodyCjkFont: '' })).toBeUndefined()
    expect(parseEditorAppearancePreferences({
      ...defaults,
      headingLatinFont: 'Arial; color: red',
    })).toBeUndefined()
  })
})
