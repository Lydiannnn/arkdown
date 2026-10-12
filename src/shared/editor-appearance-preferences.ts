import { DEFAULT_THEME_COLOR, isThemeColor, normalizeThemeColor } from './theme-color'

export const DEFAULT_EDITOR_THEME = 'system' as const
export const EDITOR_THEMES = ['system', 'minimal', 'dark'] as const
export type EditorTheme = typeof EDITOR_THEMES[number]

export function isEditorTheme(value: unknown): value is EditorTheme {
  return value === 'system' || value === 'minimal' || value === 'dark'
}

export function resolveEditorTheme(theme: EditorTheme, systemDark: boolean): 'minimal' | 'dark' {
  return theme === 'system' ? (systemDark ? 'dark' : 'minimal') : theme
}

export interface EditorAppearancePreferences {
  minimumContentMarginPx: number
  maximumContentWidthPx: number
  preserveSingleLineBreaks: boolean
  spellCheckEnabled: boolean
  showEditIndicators: boolean
  editorTheme: EditorTheme
  headingLatinFont: string
  headingCjkFont: string
  bodyLatinFont: string
  bodyCjkFont: string
  themeColor: string
  micaOpacityPercent: 0
}

export const DEFAULT_FONT_CHOICES = Object.freeze([
  'Segoe UI Variable Text',
  'Segoe UI',
  'Microsoft YaHei UI',
  'Microsoft YaHei',
  'Arial',
  'SimHei',
  'SimSun',
])

export const DEFAULT_EDITOR_APPEARANCE: EditorAppearancePreferences = Object.freeze({
  minimumContentMarginPx: 50,
  maximumContentWidthPx: 800,
  preserveSingleLineBreaks: true,
  spellCheckEnabled: false,
  showEditIndicators: true,
  editorTheme: DEFAULT_EDITOR_THEME,
  headingLatinFont: 'Segoe UI Variable Text',
  headingCjkFont: 'Microsoft YaHei UI',
  bodyLatinFont: 'Segoe UI Variable Text',
  bodyCjkFont: 'Microsoft YaHei UI',
  themeColor: DEFAULT_THEME_COLOR,
  micaOpacityPercent: 0,
})

// Keep Segoe's static fallback ahead of the CJK choice on older Windows versions.
// Explicit custom families remain a single quoted family.
export function editorFontFamilyCss(family: string): string {
  return family === 'Segoe UI Variable Text'
    ? '"Segoe UI Variable Text", "Segoe UI"'
    : JSON.stringify(family)
}

export function editorAppearancePreferencesEqual(
  left: EditorAppearancePreferences,
  right: EditorAppearancePreferences,
): boolean {
  return left.minimumContentMarginPx === right.minimumContentMarginPx
    && left.maximumContentWidthPx === right.maximumContentWidthPx
    && left.preserveSingleLineBreaks === right.preserveSingleLineBreaks
    && left.spellCheckEnabled === right.spellCheckEnabled
    && left.showEditIndicators === right.showEditIndicators
    && left.editorTheme === right.editorTheme
    && left.headingLatinFont === right.headingLatinFont
    && left.headingCjkFont === right.headingCjkFont
    && left.bodyLatinFont === right.bodyLatinFont
    && left.bodyCjkFont === right.bodyCjkFont
    && left.themeColor === right.themeColor
    && left.micaOpacityPercent === right.micaOpacityPercent
}

export interface EditorAppearanceSnapshot {
  appearance: EditorAppearancePreferences
  revision: number
}

const COMMON_REQUIRED_APPEARANCE_KEYS = Object.freeze([
  'preserveSingleLineBreaks',
  'headingLatinFont',
  'headingCjkFont',
  'bodyLatinFont',
  'bodyCjkFont',
])
const CURRENT_APPEARANCE_KEYS = Object.freeze([
  'minimumContentMarginPx',
  'maximumContentWidthPx',
  ...COMMON_REQUIRED_APPEARANCE_KEYS,
  'spellCheckEnabled',
  'showEditIndicators',
  'editorTheme',
  'themeColor',
  'micaOpacityPercent',
])
const LEGACY_APPEARANCE_KEYS = Object.freeze([
  'contentWidthPercent',
  ...COMMON_REQUIRED_APPEARANCE_KEYS,
  'spellCheckEnabled',
  'showEditIndicators',
  'editorTheme',
  'themeColor',
  'micaOpacityPercent',
])

function hasExactAllowedKeys(record: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const keys = Reflect.ownKeys(record)
  return keys.every((key) => typeof key === 'string' && allowedKeys.includes(key))
}

export function isSafeFontFamilyName(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value === value.trim()
    && value.length >= 1
    && value.length <= 120
    && !/[\u0000-\u001f\u007f";{}\\]/u.test(value)
  )
}

export function parseEditorAppearancePreferences(
  value: unknown,
): EditorAppearancePreferences | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const hasCommonKeys = COMMON_REQUIRED_APPEARANCE_KEYS.every((key) => Object.hasOwn(record, key))
  if (!hasCommonKeys) return undefined

  const isCurrent = (
    Object.hasOwn(record, 'minimumContentMarginPx')
    && Object.hasOwn(record, 'maximumContentWidthPx')
    && hasExactAllowedKeys(record, CURRENT_APPEARANCE_KEYS)
  )
  const isLegacy = (
    Object.hasOwn(record, 'contentWidthPercent')
    && hasExactAllowedKeys(record, LEGACY_APPEARANCE_KEYS)
  )
  if (!isCurrent && !isLegacy) return undefined

  const minimumContentMarginPx = isCurrent
    ? record.minimumContentMarginPx
    : DEFAULT_EDITOR_APPEARANCE.minimumContentMarginPx
  const maximumContentWidthPx = isCurrent
    ? record.maximumContentWidthPx
    : DEFAULT_EDITOR_APPEARANCE.maximumContentWidthPx
  if (isLegacy) {
    const legacyWidth = record.contentWidthPercent
    if (
      typeof legacyWidth !== 'number'
      || !Number.isSafeInteger(legacyWidth)
      || legacyWidth < 80
      || legacyWidth > 120
    ) return undefined
  }

  const {
    preserveSingleLineBreaks,
    headingLatinFont,
    headingCjkFont,
    bodyLatinFont,
    bodyCjkFont,
  } = record
  const themeColor = Object.hasOwn(record, 'themeColor')
    ? record.themeColor
    : DEFAULT_THEME_COLOR
  const storedMicaOpacityPercent = Object.hasOwn(record, 'micaOpacityPercent')
    ? record.micaOpacityPercent
    : DEFAULT_EDITOR_APPEARANCE.micaOpacityPercent
  const spellCheckEnabled = Object.hasOwn(record, 'spellCheckEnabled')
    ? record.spellCheckEnabled
    : DEFAULT_EDITOR_APPEARANCE.spellCheckEnabled
  const showEditIndicators = Object.hasOwn(record, 'showEditIndicators')
    ? record.showEditIndicators
    : DEFAULT_EDITOR_APPEARANCE.showEditIndicators
  const editorTheme = Object.hasOwn(record, 'editorTheme')
    ? record.editorTheme
    : DEFAULT_EDITOR_THEME
  if (
    typeof minimumContentMarginPx !== 'number'
    || !Number.isSafeInteger(minimumContentMarginPx)
    || minimumContentMarginPx < 30
    || minimumContentMarginPx > 150
    || typeof maximumContentWidthPx !== 'number'
    || !Number.isSafeInteger(maximumContentWidthPx)
    || maximumContentWidthPx < 600
    || maximumContentWidthPx > 1200
    || typeof preserveSingleLineBreaks !== 'boolean'
    || typeof spellCheckEnabled !== 'boolean'
    || typeof showEditIndicators !== 'boolean'
    || !isEditorTheme(editorTheme)
    || !isSafeFontFamilyName(headingLatinFont)
    || !isSafeFontFamilyName(headingCjkFont)
    || !isSafeFontFamilyName(bodyLatinFont)
    || !isSafeFontFamilyName(bodyCjkFont)
    || !isThemeColor(themeColor)
    || typeof storedMicaOpacityPercent !== 'number'
    || !Number.isSafeInteger(storedMicaOpacityPercent)
    || storedMicaOpacityPercent < 0
    || storedMicaOpacityPercent > 100
  ) return undefined

  return {
    minimumContentMarginPx,
    maximumContentWidthPx,
    preserveSingleLineBreaks,
    spellCheckEnabled,
    showEditIndicators,
    editorTheme,
    headingLatinFont,
    headingCjkFont,
    bodyLatinFont,
    bodyCjkFont,
    themeColor: normalizeThemeColor(themeColor),
    micaOpacityPercent: 0,
  }
}

export function parseCompleteEditorAppearancePreferences(
  value: unknown,
): EditorAppearancePreferences | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const record = value as Record<string, unknown>
  const keys = Reflect.ownKeys(record)
  if (
    keys.length !== CURRENT_APPEARANCE_KEYS.length
    || !keys.every((key) => typeof key === 'string' && CURRENT_APPEARANCE_KEYS.includes(key))
    || !CURRENT_APPEARANCE_KEYS.every((key) => Object.hasOwn(record, key))
    || record.micaOpacityPercent !== 0
  ) return undefined
  return parseEditorAppearancePreferences(record)
}

export function normalizeEditorAppearancePreferences(
  value: unknown,
): EditorAppearancePreferences {
  return parseEditorAppearancePreferences(value) ?? { ...DEFAULT_EDITOR_APPEARANCE }
}
