import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STICKY_NOTE_COLOR_PRESET_ID,
  DEFAULT_STICKY_NOTE_PREFERENCES,
  DEFAULT_STICKY_NOTE_TEXTURE_PRESET_ID,
  copyStickyNoteStyleReference,
  normalizeStickyNotePreferences,
  parseStickyNotePreferences,
  parseStickyNoteStyleReference,
} from '../../src/shared/sticky-note-preferences'

describe('sticky note preferences', () => {
  it('provides seven fixed colors, one warm yellow custom color, and seven textures', () => {
    expect(DEFAULT_STICKY_NOTE_PREFERENCES.colorPresets).toHaveLength(8)
    expect(DEFAULT_STICKY_NOTE_PREFERENCES.texturePresets).toHaveLength(7)
    expect(DEFAULT_STICKY_NOTE_COLOR_PRESET_ID).toBe('yellow')
    expect(DEFAULT_STICKY_NOTE_TEXTURE_PRESET_ID).toBe('plain')
    expect(
      DEFAULT_STICKY_NOTE_PREFERENCES.colorPresets.find(({ id }) => id === 'yellow'),
    ).toMatchObject({
      name: '黄色',
      value: '#FFF3B3',
    })
    expect(
      DEFAULT_STICKY_NOTE_PREFERENCES.colorPresets.find(({ id }) => id === 'custom'),
    ).toMatchObject({
      name: '自定义',
      value: '#F9E78B',
    })
  })

  it('parses customized values while preserving the eight fixed ids', () => {
    const source = structuredClone(DEFAULT_STICKY_NOTE_PREFERENCES)
    source.colorPresets[0].value = '#AABBCC'
    source.texturePresets[1].opacityPercent = 35
    source.texturePresets[1].scalePx = 18

    expect(parseStickyNotePreferences(source)).toEqual(source)
  })

  it.each([
    ['missing color', () => {
      const value = structuredClone(DEFAULT_STICKY_NOTE_PREFERENCES)
      value.colorPresets.pop()
      return value
    }],
    ['duplicate color id', () => {
      const value = structuredClone(DEFAULT_STICKY_NOTE_PREFERENCES)
      value.colorPresets[1].id = value.colorPresets[0].id
      return value
    }],
    ['unknown texture pattern', () => {
      const value = structuredClone(DEFAULT_STICKY_NOTE_PREFERENCES)
      Object.assign(value.texturePresets[0], { pattern: 'remote-image' })
      return value
    }],
    ['unsafe color', () => {
      const value = structuredClone(DEFAULT_STICKY_NOTE_PREFERENCES)
      value.colorPresets[0].value = 'rgba(0,0,0,.5)'
      return value
    }],
    ['out-of-range texture opacity', () => {
      const value = structuredClone(DEFAULT_STICKY_NOTE_PREFERENCES)
      value.texturePresets[0].opacityPercent = 101
      return value
    }],
    ['extra field', () => ({
      ...structuredClone(DEFAULT_STICKY_NOTE_PREFERENCES),
      unexpected: true,
    })],
  ] as const)('rejects %s', (_label, createValue) => {
    expect(parseStickyNotePreferences(createValue())).toBeUndefined()
  })

  it('normalizes invalid input to a detached default value', () => {
    const normalized = normalizeStickyNotePreferences(null)
    expect(normalized).toEqual(DEFAULT_STICKY_NOTE_PREFERENCES)
    expect(normalized).not.toBe(DEFAULT_STICKY_NOTE_PREFERENCES)
    expect(normalized.colorPresets[0]).not.toBe(
      DEFAULT_STICKY_NOTE_PREFERENCES.colorPresets[0],
    )
  })

  it('accepts and copies a known material style', () => {
    const input = { mode: 'material', materialPresetId: 'flowing-glass' } as const
    expect(parseStickyNoteStyleReference(input)).toEqual(input)
    expect(copyStickyNoteStyleReference(input)).toEqual(input)
  })

  it.each([
    ['mica-dark', 'mica-light'],
    ['acrylic-dark', 'flowing-glass'],
    ['acrylic-light', 'flowing-glass'],
  ] as const)('migrates the removed %s material to %s', (legacyId, currentId) => {
    expect(parseStickyNoteStyleReference({
      mode: 'material',
      materialPresetId: legacyId,
    })).toEqual({
      mode: 'material',
      materialPresetId: currentId,
    })
  })

  it.each([
    { mode: 'material', materialPresetId: 'unknown' },
    { mode: 'material', materialPresetId: 'mica-light', extra: true },
  ])('rejects malformed material style %#', (input) => {
    expect(parseStickyNoteStyleReference(input)).toBeUndefined()
  })
})
