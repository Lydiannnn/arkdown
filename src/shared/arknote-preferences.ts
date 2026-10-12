import {
  copyStickyNotePreferences,
  DEFAULT_STICKY_NOTE_PREFERENCES,
  parseStickyNotePreferences,
  type StickyNotePreferences,
} from './sticky-note-preferences'
import { DEFAULT_THEME_COLOR, isThemeColor, normalizeThemeColor } from './theme-color'
import { copyStickyNoteMicaAppearance, DEFAULT_STICKY_NOTE_MICA_APPEARANCE, parseStickyNoteMicaAppearance, type StickyNoteMicaAppearance } from './sticky-note-mica-appearance'
import { copyStickyNoteGlassAppearances, DEFAULT_STICKY_NOTE_GLASS_APPEARANCES, parseStickyNoteGlassAppearances, type StickyNoteGlassAppearances } from './sticky-note-glass-appearance'
import { copyStickyNoteMaterialEffects, DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS, parseStickyNoteMaterialEffects, type StickyNoteMaterialEffects } from './sticky-note-material-effects'
import type { StickyNoteWallpaperAppearances } from './sticky-note-glass-appearance'

export interface ArknotePreferences {
  launchAtLogin: boolean
  registerDesktopContextMenu: boolean
  startupHintDismissed: boolean
  stickyNotes: StickyNotePreferences
  themeColor: string
  micaAppearance: StickyNoteMicaAppearance
  glassAppearances: StickyNoteGlassAppearances
  materialEffects: StickyNoteMaterialEffects
}

export type ArknotePreferencesUpdate =
  Omit<ArknotePreferences, keyof StickyNoteWallpaperAppearances>
  & Partial<StickyNoteWallpaperAppearances>

export const ARKNOTE_MATERIAL_PREFERENCE_KEYS = [
  'micaAppearance', 'glassAppearances', 'materialEffects',
] as const

export const DEFAULT_ARKNOTE_PREFERENCES: ArknotePreferences = Object.freeze({
  launchAtLogin: false,
  registerDesktopContextMenu: true,
  startupHintDismissed: false,
  stickyNotes: copyStickyNotePreferences(DEFAULT_STICKY_NOTE_PREFERENCES),
  themeColor: DEFAULT_THEME_COLOR,
  micaAppearance: copyStickyNoteMicaAppearance(DEFAULT_STICKY_NOTE_MICA_APPEARANCE),
  glassAppearances: copyStickyNoteGlassAppearances(DEFAULT_STICKY_NOTE_GLASS_APPEARANCES),
  materialEffects: copyStickyNoteMaterialEffects(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseArknotePreferences(value: unknown): ArknotePreferences | undefined {
  if (!isRecord(value)) return undefined
  const keys = Reflect.ownKeys(value)
  if (
    (keys.length < 3 || keys.length > 8)
    || !keys.every((key) => typeof key === 'string' && [
      'launchAtLogin',
      'registerDesktopContextMenu',
      'startupHintDismissed',
      'stickyNotes',
      'themeColor',
      'micaAppearance',
      'glassAppearances',
      'materialEffects',
    ].includes(key))
  ) return undefined
  const stickyNotes = parseStickyNotePreferences(value.stickyNotes)
  const micaAppearance = Object.hasOwn(value, 'micaAppearance')
    ? parseStickyNoteMicaAppearance(value.micaAppearance)
    : copyStickyNoteMicaAppearance(DEFAULT_STICKY_NOTE_MICA_APPEARANCE)
  const glassAppearances = Object.hasOwn(value, 'glassAppearances')
    ? parseStickyNoteGlassAppearances(value.glassAppearances)
    : copyStickyNoteGlassAppearances(DEFAULT_STICKY_NOTE_GLASS_APPEARANCES)
  const materialEffects = Object.hasOwn(value, 'materialEffects')
    ? parseStickyNoteMaterialEffects(value.materialEffects)
    : copyStickyNoteMaterialEffects(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS)
  if (
    typeof value.launchAtLogin !== 'boolean'
    || typeof value.registerDesktopContextMenu !== 'boolean'
    || !(value.startupHintDismissed === undefined || typeof value.startupHintDismissed === 'boolean')
    || !(value.themeColor === undefined || isThemeColor(value.themeColor))
    || !stickyNotes
    || !micaAppearance
    || !glassAppearances
    || !materialEffects
  ) return undefined
  return {
    launchAtLogin: value.launchAtLogin,
    registerDesktopContextMenu: value.registerDesktopContextMenu,
    startupHintDismissed: value.startupHintDismissed ?? false,
    stickyNotes,
    micaAppearance,
    glassAppearances,
    materialEffects,
    themeColor: value.themeColor === undefined ? DEFAULT_THEME_COLOR : normalizeThemeColor(value.themeColor),
  }
}

export function copyArknotePreferences(value: ArknotePreferences): ArknotePreferences {
  return {
    launchAtLogin: value.launchAtLogin,
    registerDesktopContextMenu: value.registerDesktopContextMenu,
    startupHintDismissed: value.startupHintDismissed,
    stickyNotes: copyStickyNotePreferences(value.stickyNotes),
    themeColor: normalizeThemeColor(value.themeColor),
    micaAppearance: copyStickyNoteMicaAppearance(value.micaAppearance),
    glassAppearances: copyStickyNoteGlassAppearances(value.glassAppearances),
    materialEffects: copyStickyNoteMaterialEffects(value.materialEffects),
  }
}

/** Reads migrate missing fields; writes keep omission until the service's queued merge. */
export function parseArknotePreferencesUpdate(value: unknown): ArknotePreferencesUpdate | undefined {
  const parsed: ArknotePreferencesUpdate | undefined = parseArknotePreferences(value)
  if (!parsed || !isRecord(value)) return undefined
  for (const key of ARKNOTE_MATERIAL_PREFERENCE_KEYS) {
    if (!Object.hasOwn(value, key)) delete parsed[key]
  }
  return parsed
}

/** Rebase ordinary preferences without re-submitting material values from an earlier read. */
export function arknotePreferencesForUpdate(
  current: ArknotePreferences,
  patch: Partial<ArknotePreferences>,
): ArknotePreferencesUpdate {
  const input: ArknotePreferencesUpdate = { ...current, ...patch }
  for (const key of ARKNOTE_MATERIAL_PREFERENCE_KEYS) {
    if (!Object.hasOwn(patch, key)) delete input[key]
  }
  const parsed = parseArknotePreferencesUpdate(input)
  if (!parsed) throw new Error('Arknote 设置无效')
  return parsed
}

export interface ArknoteThemeColorEvent {
  type: 'theme-color-changed'
  themeColor: string
}

export function parseArknoteThemeColorEvent(value: unknown): ArknoteThemeColorEvent | undefined {
  if (
    !isRecord(value)
    || Reflect.ownKeys(value).length !== 2
    || value.type !== 'theme-color-changed'
    || !isThemeColor(value.themeColor)
  ) return undefined
  return {
    type: 'theme-color-changed',
    themeColor: normalizeThemeColor(value.themeColor),
  }
}
