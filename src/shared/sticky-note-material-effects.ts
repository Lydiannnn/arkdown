import { copyStickyNoteMicaAppearance, type StickyNoteMicaAppearance } from './sticky-note-mica-appearance'

export const STICKY_NOTE_MATERIAL_EFFECTS_CHANNEL = 'arkdown:sticky-note-material-effects'

export type StickyNoteMaterialEffectsPresetId = 'warm-frosted-glass' | 'clear-glass' | 'flowing-glass'

export interface StickyNoteMaterialEffect {
  transparency: number
  innerGlowIntensity: number
  /** Physical screen pixels; the renderer converts this using its devicePixelRatio. */
  innerGlowRangePx: number
  shadowEnabled?: boolean
  borderHidden?: boolean
}

export type StickyNoteMaterialEffects = Record<StickyNoteMaterialEffectsPresetId, StickyNoteMaterialEffect>

export const DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS: Readonly<StickyNoteMaterialEffects> = Object.freeze({
  'warm-frosted-glass': Object.freeze({ transparency: 0.19, innerGlowIntensity: 0.74, innerGlowRangePx: 30, shadowEnabled: true }),
  'clear-glass': Object.freeze({ transparency: 0.63, innerGlowIntensity: 0.5, innerGlowRangePx: 23, shadowEnabled: true }),
  'flowing-glass': Object.freeze({ transparency: 0, innerGlowIntensity: 0.7, innerGlowRangePx: 30, borderHidden: true }),
})

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length && keys.every(key => typeof key === 'string' && expected.includes(key))
}

export function copyStickyNoteMaterialEffect(value: StickyNoteMaterialEffect): StickyNoteMaterialEffect {
  const copied: StickyNoteMaterialEffect = { transparency: value.transparency, innerGlowIntensity: value.innerGlowIntensity, innerGlowRangePx: value.innerGlowRangePx }
  for (const key of ['shadowEnabled', 'borderHidden'] as const) {
    if (Object.hasOwn(value, key) && typeof value[key] === 'boolean') copied[key] = value[key]
  }
  return copied
}

export function parseStickyNoteMaterialEffect(value: unknown): StickyNoteMaterialEffect | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const optionalKeys = ['shadowEnabled', 'borderHidden'] as const
  const presentOptionalKeys = optionalKeys.filter(key => Object.hasOwn(value, key))
  if (!hasExactKeys(value, ['transparency', 'innerGlowIntensity', 'innerGlowRangePx', ...presentOptionalKeys])) return undefined
  if (presentOptionalKeys.some(key => typeof value[key] !== 'boolean')) return undefined
  for (const key of ['transparency', 'innerGlowIntensity', 'innerGlowRangePx'] as const) {
    const number = value[key]
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > (key === 'innerGlowRangePx' ? 60 : 1)) return undefined
  }
  return copyStickyNoteMaterialEffect(value as unknown as StickyNoteMaterialEffect)
}

export function copyStickyNoteMaterialEffects(value: StickyNoteMaterialEffects): StickyNoteMaterialEffects {
  return {
    'warm-frosted-glass': copyStickyNoteMaterialEffect(value['warm-frosted-glass']),
    'clear-glass': copyStickyNoteMaterialEffect(value['clear-glass']),
    'flowing-glass': copyStickyNoteMaterialEffect(value['flowing-glass']),
  }
}

export function parseStickyNoteMaterialEffects(value: unknown): StickyNoteMaterialEffects | undefined {
  if (!hasExactKeys(value, ['warm-frosted-glass', 'clear-glass', 'flowing-glass'])) return undefined
  const warm = parseStickyNoteMaterialEffect(value['warm-frosted-glass'])
  const clear = parseStickyNoteMaterialEffect(value['clear-glass'])
  const acrylic = parseStickyNoteMaterialEffect(value['flowing-glass'])
  return warm && clear && acrylic ? { 'warm-frosted-glass': warm, 'clear-glass': clear, 'flowing-glass': acrylic } : undefined
}

/** Scale coverage at the final native boundary without changing the stored base recipe. */
export function effectiveStickyNoteMaterialAppearance(
  base: StickyNoteMicaAppearance,
  effect: StickyNoteMaterialEffect,
): StickyNoteMicaAppearance {
  const appearance = copyStickyNoteMicaAppearance(base)
  appearance.tintOpacity *= 1 - effect.transparency
  appearance.luminosityOpacity *= 1 - effect.transparency
  return appearance
}
