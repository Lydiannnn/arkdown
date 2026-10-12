import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS,
  copyStickyNoteMaterialEffect,
  copyStickyNoteMaterialEffects,
  effectiveStickyNoteMaterialAppearance,
  parseStickyNoteMaterialEffect,
  parseStickyNoteMaterialEffects,
} from '../../src/shared/sticky-note-material-effects'

const effect = { transparency: 0.25, innerGlowIntensity: 0.8, innerGlowRangePx: 18 }
const map = {
  'warm-frosted-glass': effect,
  'clear-glass': { transparency: 1, innerGlowIntensity: 0, innerGlowRangePx: 60 },
  'flowing-glass': { transparency: 0, innerGlowIntensity: 1, innerGlowRangePx: 0 },
}

describe('independent material effect settings', () => {
  it('validates all three recipes and keeps copies independent of each other and caller state', () => {
    const parsed = parseStickyNoteMaterialEffects(map)!
    expect(parsed).toEqual(map)
    const copied = copyStickyNoteMaterialEffects(parsed)
    copied['warm-frosted-glass'].transparency = 0
    expect(parsed['warm-frosted-glass'].transparency).toBe(0.25)
    expect(copyStickyNoteMaterialEffect(effect)).not.toBe(effect)
    parsed['clear-glass'].innerGlowRangePx = 0
    expect(map['clear-glass'].innerGlowRangePx).toBe(60)
  })

  it('round-trips legacy JSON unchanged and new optional decoration flags without sharing objects', () => {
    expect(parseStickyNoteMaterialEffects(JSON.parse(JSON.stringify(map)))).toEqual(map)
    const decorated = { ...effect, shadowEnabled: true, borderHidden: false }
    const parsed = parseStickyNoteMaterialEffect(JSON.parse(JSON.stringify(decorated)))!
    expect(parsed).toEqual(decorated)
    const copied = copyStickyNoteMaterialEffect(parsed)
    copied.shadowEnabled = false
    copied.borderHidden = true
    expect(parsed).toEqual(decorated)
    expect(copyStickyNoteMaterialEffect(effect)).toEqual(effect)
    expect(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS['flowing-glass']).toEqual({ transparency: 0, innerGlowIntensity: 0.7, innerGlowRangePx: 30, borderHidden: true })
  })

  it('copies only present valid optional flags', () => {
    expect(copyStickyNoteMaterialEffect({ ...effect, shadowEnabled: undefined, borderHidden: 'yes' } as never)).toEqual(effect)
    expect(copyStickyNoteMaterialEffect({ ...effect, shadowEnabled: false, borderHidden: true, unknown: 1 } as never)).toEqual({ ...effect, shadowEnabled: false, borderHidden: true })
  })

  it.each(['shadowEnabled', 'borderHidden'])('strictly validates optional %s values', key => {
    for (const value of [undefined, null, 0, 1, 'true', {}, []]) {
      expect(parseStickyNoteMaterialEffect({ ...effect, [key]: value })).toBeUndefined()
    }
    expect(parseStickyNoteMaterialEffect({ ...effect, [key]: false })).toEqual({ ...effect, [key]: false })
    expect(parseStickyNoteMaterialEffect({ ...effect, [key]: true, extra: false })).toBeUndefined()
    expect(parseStickyNoteMaterialEffect({ ...effect, [key]: true, [Symbol('extra')]: false })).toBeUndefined()
  })

  it.each([
    undefined, null, [], {}, Object.create(effect), { ...effect, blur: 1 },
    { ...effect, [Symbol('hidden')]: true }, { ...effect, transparency: -0.01 },
    { ...effect, transparency: 1.01 }, { ...effect, transparency: '0.5' },
    { ...effect, innerGlowIntensity: -0.1 }, { ...effect, innerGlowIntensity: 1.1 },
    { ...effect, innerGlowIntensity: Number.NaN }, { ...effect, innerGlowRangePx: Infinity },
    { ...effect, innerGlowRangePx: -1 }, { ...effect, innerGlowRangePx: 60.1 },
  ])('rejects malformed or out-of-range effect input %s', value => {
    expect(parseStickyNoteMaterialEffect(value)).toBeUndefined()
  })

  it.each([undefined, null, [], {}, { ...map, other: effect },
    { ...map, 'flowing-glass': undefined }, { ...map, 'clear-glass': { ...effect, opacity: 1 } },
    { ...map, [Symbol('extra')]: true },
  ])('requires a complete strict material-effects map %s', value => {
    expect(parseStickyNoteMaterialEffects(value)).toBeUndefined()
  })

  it('uses the tuned defaults and keeps all nested defaults immutable', () => {
    const copied = copyStickyNoteMaterialEffects(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS)
    copied['warm-frosted-glass'].transparency = 1
    expect(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS['warm-frosted-glass']).toEqual({ transparency: 0.19, innerGlowIntensity: 0.74, innerGlowRangePx: 30, shadowEnabled: true })
    expect(copied['clear-glass']).toEqual({ transparency: 0.63, innerGlowIntensity: 0.5, innerGlowRangePx: 23, shadowEnabled: true })
    expect(Object.isFrozen(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS['flowing-glass'])).toBe(true)
  })

  it.each([
    [0, 0.8, 0.6], [0.25, 0.6, 0.45], [1, 0, 0],
  ])('transparency %s scales only tint and luminosity, leaving the stored recipe unchanged', (transparency, tint, luminosity) => {
    const base = { tintColor: '#ABCDEF', tintOpacity: 0.8, luminosityOpacity: 0.6, saturation: 0.9 }
    const result = effectiveStickyNoteMaterialAppearance(base, { ...effect, transparency })
    expect(result.tintOpacity).toBeCloseTo(tint)
    expect(result.luminosityOpacity).toBeCloseTo(luminosity)
    expect(result.tintColor).toBe('#ABCDEF')
    expect(result.saturation).toBe(0.9)
    expect(Reflect.ownKeys(result).sort()).toEqual(['luminosityOpacity', 'saturation', 'tintColor', 'tintOpacity'])
    expect(base).toEqual({ tintColor: '#ABCDEF', tintOpacity: 0.8, luminosityOpacity: 0.6, saturation: 0.9 })
  })
})
