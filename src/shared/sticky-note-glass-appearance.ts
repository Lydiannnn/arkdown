import { copyStickyNoteMicaAppearance, parseStickyNoteMicaAppearance, type StickyNoteMicaAppearance } from './sticky-note-mica-appearance'
import { copyStickyNoteMaterialEffects, parseStickyNoteMaterialEffects, type StickyNoteMaterialEffects } from './sticky-note-material-effects'

export type StickyNoteGlassPresetId = 'warm-frosted-glass' | 'clear-glass'
export type StickyNoteGlassAppearances = Record<StickyNoteGlassPresetId, StickyNoteMicaAppearance>
export interface StickyNoteWallpaperAppearances {
  micaAppearance: StickyNoteMicaAppearance
  glassAppearances: StickyNoteGlassAppearances
  materialEffects: StickyNoteMaterialEffects
}

// Independent recipes over the same OS blurred-wallpaper source. Mica settings
// and mutable addon arguments never become shared state for these presets.
const WARM_FROSTED_GLASS_APPEARANCE: Readonly<StickyNoteMicaAppearance> = Object.freeze({
  tintColor: '#ECE5CB', tintOpacity: 0, luminosityOpacity: 1, saturation: 1,
})
const CLEAR_GLASS_APPEARANCE: Readonly<StickyNoteMicaAppearance> = Object.freeze({
  tintColor: '#000000', tintOpacity: 0, luminosityOpacity: 0.5, saturation: 1,
})

export const DEFAULT_STICKY_NOTE_GLASS_APPEARANCES: Readonly<StickyNoteGlassAppearances> = Object.freeze({
  'warm-frosted-glass': WARM_FROSTED_GLASS_APPEARANCE,
  'clear-glass': CLEAR_GLASS_APPEARANCE,
})

export function copyStickyNoteGlassAppearances(value: StickyNoteGlassAppearances): StickyNoteGlassAppearances {
  return {
    'warm-frosted-glass': copyStickyNoteMicaAppearance(value['warm-frosted-glass']),
    'clear-glass': copyStickyNoteMicaAppearance(value['clear-glass']),
  }
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length && keys.every(key => typeof key === 'string' && expected.includes(key))
}

export function parseStickyNoteGlassAppearances(value: unknown): StickyNoteGlassAppearances | undefined {
  if (!hasExactKeys(value, ['warm-frosted-glass', 'clear-glass'])) return undefined
  const warm = parseStickyNoteMicaAppearance(value['warm-frosted-glass'])
  const clear = parseStickyNoteMicaAppearance(value['clear-glass'])
  return warm && clear ? { 'warm-frosted-glass': warm, 'clear-glass': clear } : undefined
}

export function copyStickyNoteWallpaperAppearances(value: StickyNoteWallpaperAppearances): StickyNoteWallpaperAppearances {
  return {
    micaAppearance: copyStickyNoteMicaAppearance(value.micaAppearance),
    glassAppearances: copyStickyNoteGlassAppearances(value.glassAppearances),
    materialEffects: copyStickyNoteMaterialEffects(value.materialEffects),
  }
}

export function parseStickyNoteWallpaperAppearances(value: unknown): StickyNoteWallpaperAppearances | undefined {
  if (!hasExactKeys(value, ['micaAppearance', 'glassAppearances', 'materialEffects'])) return undefined
  const micaAppearance = parseStickyNoteMicaAppearance(value.micaAppearance)
  const glassAppearances = parseStickyNoteGlassAppearances(value.glassAppearances)
  const materialEffects = parseStickyNoteMaterialEffects(value.materialEffects)
  return micaAppearance && glassAppearances && materialEffects ? { micaAppearance, glassAppearances, materialEffects } : undefined
}

export function isStickyNoteWallpaperPresetId(id: unknown): boolean {
  return id === 'mica-light' || id === 'warm-frosted-glass' || id === 'clear-glass'
}

export function stickyNoteWallpaperAppearanceForPreset(
  id: unknown,
  mica: StickyNoteMicaAppearance,
  glass: StickyNoteGlassAppearances = DEFAULT_STICKY_NOTE_GLASS_APPEARANCES,
): StickyNoteMicaAppearance | null {
  if (id === 'mica-light') return copyStickyNoteMicaAppearance(mica)
  if (id === 'warm-frosted-glass' || id === 'clear-glass') return copyStickyNoteMicaAppearance(glass[id])
  return null
}
