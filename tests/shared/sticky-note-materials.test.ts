import { describe, expect, it } from 'vitest'
import {
  STICKY_NOTE_MATERIAL_PRESETS,
  stickyNoteMaterialDescriptor,
  stickyNoteMaterialPresetIdForStyle,
} from '../../src/shared/sticky-note-materials'

describe('sticky note material catalog', () => {
  it('maps every built-in material to a stable native backdrop and fallback', () => {
    expect(STICKY_NOTE_MATERIAL_PRESETS.map((preset) => [
      preset.id,
      preset.name,
      preset.nativeMaterial,
      preset.fallbackColor,
    ])).toEqual([
      ['mica-light', 'Mica', 'mica', '#F3F3F3'],
      ['flowing-glass', 'Acrylic', 'acrylic', '#E9EEF2'],
      ['warm-frosted-glass', '暖雾玻璃', 'mica', '#D7C8B5'],
      ['clear-glass', '深色玻璃', 'mica', '#444847'],
    ])
    expect(stickyNoteMaterialDescriptor('missing')).toBeNull()
    expect(stickyNoteMaterialDescriptor('mica-dark')).toBeNull()
    expect(stickyNoteMaterialDescriptor('acrylic-dark')).toBeNull()
  })

  it('uses Mica as the first and default-facing material choice', () => {
    expect(STICKY_NOTE_MATERIAL_PRESETS[0]).toMatchObject({ id: 'mica-light', name: 'Mica' })
  })

  it('finds the material id only for material styles', () => {
    expect(stickyNoteMaterialPresetIdForStyle({
      mode: 'material',
      materialPresetId: 'mica-light',
    })).toBe('mica-light')
    expect(stickyNoteMaterialPresetIdForStyle({
      mode: 'preset',
      colorPresetId: 'yellow',
      texturePresetId: 'plain',
    })).toBeNull()
  })
})
