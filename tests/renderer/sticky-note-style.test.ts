import { describe, expect, it } from 'vitest'
import {
  independentStickyNoteStyle,
  resolveStickyNoteStyle,
  stickyNoteStyleCssVariables,
} from '../../src/renderer/sticky-notes/sticky-note-style'
import {
  DEFAULT_STICKY_NOTE_PREFERENCES,
  copyStickyNotePreferences,
} from '../../src/shared/sticky-note-preferences'

describe('sticky note style resolution', () => {
  it('combines any color and texture preset over the 20% note-color surface', () => {
    const resolved = resolveStickyNoteStyle({
      mode: 'preset',
      colorPresetId: 'blue',
      texturePresetId: 'grid',
    }, DEFAULT_STICKY_NOTE_PREFERENCES)
    expect(resolved.backgroundColor).toBe('#F4F8FE')
    expect(resolved.backgroundImage).toContain('linear-gradient')
    expect(resolved.backgroundSize).toBe('20px 20px')
  })

  it('mixes the saved yellow source color with 80% white while keeping the surface opaque', () => {
    const resolved = resolveStickyNoteStyle({
      mode: 'preset',
      colorPresetId: 'yellow',
      texturePresetId: 'plain',
    }, DEFAULT_STICKY_NOTE_PREFERENCES)
    expect(resolved.backgroundColor).toBe('#FFFDF0')
    expect(resolved.opacity).toBe(1)
  })

  it('takes an independent snapshot that ignores future global preset edits', () => {
    const source = copyStickyNotePreferences(DEFAULT_STICKY_NOTE_PREFERENCES)
    const independent = independentStickyNoteStyle({
      mode: 'preset',
      colorPresetId: 'purple',
      texturePresetId: 'dots',
    }, source)
    source.colorPresets.find(({ id }) => id === 'purple')!.value = '#000000'
    source.texturePresets.find(({ id }) => id === 'dots')!.scalePx = 44

    expect(resolveStickyNoteStyle(independent, source)).toMatchObject({
      backgroundColor: '#F9F4F9',
      backgroundSize: '16px 16px',
    })
  })

  it('chooses text against the actual 20%-color surface instead of the darker saved source color', () => {
    expect(resolveStickyNoteStyle({
      mode: 'independent',
      color: '#101010',
      texture: {
        pattern: 'none',
        foregroundColor: '#000000',
        opacityPercent: 0,
        scalePx: 16,
      },
    }, DEFAULT_STICKY_NOTE_PREFERENCES).textColor).toBe('#252525')
    expect(resolveStickyNoteStyle({
      mode: 'preset',
      colorPresetId: 'yellow',
      texturePresetId: 'plain',
    }, DEFAULT_STICKY_NOTE_PREFERENCES).textColor).toBe('#252525')
  })

  it('exports one shared set of CSS custom properties', () => {
    expect(stickyNoteStyleCssVariables({
      mode: 'preset',
      colorPresetId: 'green',
      texturePresetId: 'ruled',
    }, DEFAULT_STICKY_NOTE_PREFERENCES)).toMatchObject({
      '--sticky-note-background-color': '#F4FAF7',
      '--sticky-note-text-color': '#252525',
      '--sticky-note-background-size': '24px 24px',
      '--sticky-note-opacity': '1',
    })
  })

  it.each([
    ['mica-light', '#F3F3F3', 'rgb(255 255 255 / 0%)', '#F3F3F3', '#242629', '#62666B', 'rgb(0 0 0 / 8%)', 'rgb(0 0 0 / 5%)', 'rgb(0 0 0 / 11%)', 'rgb(0 0 0 / 11%)'],
    ['flowing-glass', '#E9EEF2', 'rgb(242 247 251 / 0%)', '#E9EEF2', '#172331', '#526170', 'rgb(255 255 255 / 58%)', 'rgb(255 255 255 / 42%)', 'rgb(255 255 255 / 58%)', 'rgb(255 255 255 / 78%)'],
  ] as const)('resolves %s from the shared material catalog to literal surface tokens', (
    materialPresetId,
    fallbackColor,
    surfaceLayer,
    toolbarLayer,
    textColor,
    mutedTextColor,
    borderColor,
    hoverLayer,
    pressedLayer,
    selectionLayer,
  ) => {
    const variables = stickyNoteStyleCssVariables({
      mode: 'material',
      materialPresetId,
    }, DEFAULT_STICKY_NOTE_PREFERENCES)
    expect(variables).toMatchObject({
      '--sticky-note-background-color': fallbackColor,
      '--sticky-note-preview-background-color': materialPresetId === 'mica-light' ? '#FFFFFF' : fallbackColor,
      '--sticky-note-surface-layer': surfaceLayer,
      '--sticky-note-toolbar-layer': toolbarLayer,
      '--sticky-note-text-color': textColor,
      '--sticky-note-muted-text-color': mutedTextColor,
      '--sticky-note-border-color': borderColor,
      '--sticky-note-hover-layer': hoverLayer,
      '--sticky-note-pressed-layer': pressedLayer,
      '--sticky-note-selection-layer': selectionLayer,
      '--control-hover-layer': hoverLayer,
      '--control-pressed-layer': pressedLayer,
      '--sticky-note-background-image': 'none',
      '--sticky-note-opacity': '1',
    })
    expect(variables).not.toHaveProperty('--sticky-note-highlight-strength')
  })
})
