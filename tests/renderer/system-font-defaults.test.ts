import { expect, it } from 'vitest'
import { DEFAULT_EDITOR_APPEARANCE, editorFontFamilyCss } from '../../src/shared/editor-appearance-preferences'
import { migrateFontDefaults } from '../../src/main/settings/font-defaults-migration'

it('uses system Latin/CJK defaults with Segoe UI fallback before Chinese fonts', () => {
  expect(DEFAULT_EDITOR_APPEARANCE.bodyLatinFont).toBe('Segoe UI Variable Text')
  expect(DEFAULT_EDITOR_APPEARANCE.bodyCjkFont).toBe('Microsoft YaHei UI')
  expect(editorFontFamilyCss('Segoe UI Variable Text')).toBe('"Segoe UI Variable Text", "Segoe UI"')
  expect(editorFontFamilyCss('Georgia')).toBe('"Georgia"')
  expect(editorFontFamilyCss('Microsoft YaHei UI')).toBe('"Microsoft YaHei UI"')
})

it('upgrades the complete previous Noto default set and keeps other preferences', () => {
  const appearance = { ...DEFAULT_EDITOR_APPEARANCE, maximumContentWidthPx: 1050,
    headingLatinFont: 'Noto Sans SC', headingCjkFont: 'Noto Sans SC',
    bodyLatinFont: 'Noto Sans SC', bodyCjkFont: 'Noto Sans SC' }
  const result = migrateFontDefaults({ lastWorkspace: null, fontDefaultsVersion: 2, appearance })
  expect(result.changed).toBe(true)
  expect(result.settings.appearance).toEqual({ ...DEFAULT_EDITOR_APPEARANCE, maximumContentWidthPx: 1050 })
  expect(result.settings.fontDefaultsVersion).toBe(3)
  expect(appearance.bodyCjkFont).toBe('Noto Sans SC')
})

it('preserves mixed fonts and explicit all-YaHei choices from the Noto release', () => {
  for (const latin of ['Georgia', 'Microsoft YaHei']) {
    const appearance = { ...DEFAULT_EDITOR_APPEARANCE,
      headingLatinFont: latin, bodyLatinFont: latin,
      headingCjkFont: 'Microsoft YaHei', bodyCjkFont: 'Microsoft YaHei' }
    expect(migrateFontDefaults({ lastWorkspace: null, fontDefaultsVersion: 2, appearance }).settings.appearance).toEqual(appearance)
  }
})
