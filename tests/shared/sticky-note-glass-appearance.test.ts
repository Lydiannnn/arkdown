import { describe, expect, it } from 'vitest'
import { DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS } from '../../src/shared/sticky-note-material-effects'
import {
  DEFAULT_STICKY_NOTE_GLASS_APPEARANCES,
  copyStickyNoteGlassAppearances,
  copyStickyNoteWallpaperAppearances,
  parseStickyNoteGlassAppearances,
  parseStickyNoteWallpaperAppearances,
  isStickyNoteWallpaperPresetId,
  stickyNoteWallpaperAppearanceForPreset,
} from '../../src/shared/sticky-note-glass-appearance'

const mica = { tintColor: '#ABCDEF', tintOpacity: 0.3, luminosityOpacity: 0.4, saturation: 0.5 }
const materialEffects = DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS
const glass = {
  'warm-frosted-glass': { tintColor: '#123abc', tintOpacity: 0, luminosityOpacity: 1, saturation: 0 },
  'clear-glass': { tintColor: '#FEDCBA', tintOpacity: 1, luminosityOpacity: 0, saturation: 1 },
}

describe('independent wallpaper glass recipes', () => {
  it('routes each custom recipe independently and returns defensive copies', () => {
    const warm = stickyNoteWallpaperAppearanceForPreset('warm-frosted-glass', mica, glass)!
    expect(warm).toEqual({ tintColor: '#123abc', tintOpacity: 0, luminosityOpacity: 1, saturation: 0 })
    warm.luminosityOpacity = 0.2
    expect(glass['warm-frosted-glass'].luminosityOpacity).toBe(1)
    expect(stickyNoteWallpaperAppearanceForPreset('clear-glass', mica, glass)).toEqual(glass['clear-glass'])
    expect(stickyNoteWallpaperAppearanceForPreset('mica-light', mica, glass)).toEqual(mica)
    expect(stickyNoteWallpaperAppearanceForPreset('acrylic-light', mica, glass)).toBeNull()
  })

  it('validates all three recipes without coercion and copies every nested recipe', () => {
    const parsed = parseStickyNoteWallpaperAppearances({ micaAppearance: mica, glassAppearances: glass, materialEffects })!
    expect(parsed.glassAppearances['warm-frosted-glass'].tintColor).toBe('#123ABC')
    const copied = copyStickyNoteWallpaperAppearances(parsed)
    copied.micaAppearance.tintOpacity = 0
    copied.glassAppearances['clear-glass'].tintOpacity = 0
    expect(parsed.micaAppearance.tintOpacity).toBe(0.3)
    expect(parsed.glassAppearances['clear-glass'].tintOpacity).toBe(1)
  })

  it.each([
    undefined, null, [], {}, { ...glass, extra: mica },
    { ...glass, 'clear-glass': { ...mica, tintOpacity: -0.1 } },
    { ...glass, 'clear-glass': { ...mica, luminosityOpacity: 1.1 } },
    { ...glass, 'clear-glass': { ...mica, saturation: '1' } },
    { ...glass, 'clear-glass': { ...mica, blur: 0.3 } },
    { ...glass, [Symbol('hidden')]: mica },
  ])('rejects missing recipes and malformed or unknown glass parameters: %s', value => {
    expect(parseStickyNoteGlassAppearances(value)).toBeUndefined()
  })

  it('rejects extra full-map keys and invalid Mica without accepting a partial map', () => {
    expect(parseStickyNoteWallpaperAppearances({ micaAppearance: mica })).toBeUndefined()
    expect(parseStickyNoteWallpaperAppearances({ micaAppearance: null, glassAppearances: glass, materialEffects })).toBeUndefined()
    expect(parseStickyNoteWallpaperAppearances({ micaAppearance: mica, glassAppearances: glass, materialEffects, blur: 1 })).toBeUndefined()
  })

  it('uses stable defaults without sharing mutable glass state', () => {
    const copied = copyStickyNoteGlassAppearances(DEFAULT_STICKY_NOTE_GLASS_APPEARANCES)
    copied['warm-frosted-glass'].luminosityOpacity = 0
    expect(stickyNoteWallpaperAppearanceForPreset('warm-frosted-glass', mica)?.luminosityOpacity).toBe(1)
    expect(stickyNoteWallpaperAppearanceForPreset('clear-glass', mica)?.luminosityOpacity).toBe(0.5)
    expect(Object.isFrozen(DEFAULT_STICKY_NOTE_GLASS_APPEARANCES['clear-glass'])).toBe(true)
  })
})

describe('sticky-note wallpaper recipe selection', () => {
  const mica = { tintColor: '#AABBCC', tintOpacity: 0.6, luminosityOpacity: 0.7, saturation: 0.8 }

  it.each([
    ['mica-light', true],
    ['warm-frosted-glass', true],
    ['clear-glass', true],
    ['flowing-glass', false],
    ['mica', false],
    ['WARM-FROSTED-GLASS', false],
    ['', false],
    [null, false],
    [undefined, false],
    [1, false],
    [{ materialPresetId: 'mica-light' }, false],
  ])('classifies only wallpaper preset ID %j as %s', (id, expected) => {
    expect(isStickyNoteWallpaperPresetId(id)).toBe(expected)
    if (!expected) expect(stickyNoteWallpaperAppearanceForPreset(id, mica)).toBeNull()
  })

  it.each([
    ['warm-frosted-glass', { tintColor: '#ECE5CB', tintOpacity: 0, luminosityOpacity: 1, saturation: 1 }],
    ['clear-glass', { tintColor: '#000000', tintOpacity: 0, luminosityOpacity: 0.5, saturation: 1 }],
  ] as const)('routes %s independently of saved Mica settings and caller mutations', (id, expected) => {
    const first = stickyNoteWallpaperAppearanceForPreset(id, mica)!
    expect(first).toEqual(expected)
    expect(Reflect.ownKeys(first).sort()).toEqual(['luminosityOpacity', 'saturation', 'tintColor', 'tintOpacity'])
    first.tintColor = '#000000'
    first.tintOpacity = 1
    first.luminosityOpacity = 1
    first.saturation = 0
    const second = stickyNoteWallpaperAppearanceForPreset(id, { ...mica, tintColor: '#FFFFFF', saturation: 0 })
    expect(second).toEqual(expected)
    expect(second).not.toBe(first)
  })

  it('copies the current Mica recipe without sharing caller state or adding native fields', () => {
    const input = { ...mica, unrelatedPreference: true }
    const result = stickyNoteWallpaperAppearanceForPreset('mica-light', input)!
    expect(result).toEqual(mica)
    input.tintOpacity = 0
    expect(result.tintOpacity).toBe(0.6)
    result.saturation = 0
    expect(input.saturation).toBe(0.8)
  })

  it('retains the exact raw Mica recipe instead of replacing it with a glass recipe', () => {
    const raw = { tintColor: '#F3F3F3', tintOpacity: 0, luminosityOpacity: 0, saturation: 1 }
    const selected = stickyNoteWallpaperAppearanceForPreset('mica-light', raw)
    expect(selected).toEqual(raw)
    expect(selected).not.toBe(raw)
  })
})
