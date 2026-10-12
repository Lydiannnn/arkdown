import type { StickyNoteStyleReference } from './sticky-note-preferences'

export type StickyNoteMaterialPresetId =
  | 'mica-light'
  | 'flowing-glass'
  | 'warm-frosted-glass'
  | 'clear-glass'

export type StickyNoteNativeMaterial = 'mica' | 'acrylic'
export type StickyNoteMaterialColorScheme = 'light' | 'dark'

export interface StickyNoteMaterialRendererTokens {
  surfaceLayer: string
  toolbarLayer: string
  textColor: string
  mutedTextColor: string
  borderColor: string
  hoverLayer: string
  pressedLayer: string
  selectionLayer: string
}

export interface StickyNoteMaterialDescriptor {
  id: StickyNoteMaterialPresetId
  name: string
  nativeMaterial: StickyNoteNativeMaterial
  fallbackColor: string
  colorScheme: StickyNoteMaterialColorScheme
  renderer: Readonly<StickyNoteMaterialRendererTokens>
}

function descriptor(
  value: StickyNoteMaterialDescriptor,
): Readonly<StickyNoteMaterialDescriptor> {
  return Object.freeze({
    ...value,
    renderer: Object.freeze({ ...value.renderer }),
  })
}

export const STICKY_NOTE_MATERIAL_PRESETS = Object.freeze([
  descriptor({
    id: 'mica-light',
    name: 'Mica',
    nativeMaterial: 'mica',
    fallbackColor: '#F3F3F3',
    colorScheme: 'light',
    renderer: {
      surfaceLayer: 'rgb(255 255 255 / 0%)',
      toolbarLayer: '#F3F3F3',
      textColor: '#242629',
      mutedTextColor: '#62666B',
      borderColor: 'rgb(0 0 0 / 8%)',
      hoverLayer: 'rgb(0 0 0 / 5%)',
      pressedLayer: 'rgb(0 0 0 / 11%)',
      selectionLayer: 'rgb(0 0 0 / 11%)',
    },
  }),
  descriptor({
    id: 'flowing-glass',
    name: 'Acrylic',
    nativeMaterial: 'acrylic',
    fallbackColor: '#E9EEF2',
    colorScheme: 'light',
    renderer: {
      surfaceLayer: 'rgb(242 247 251 / 0%)',
      toolbarLayer: '#E9EEF2',
      textColor: '#172331',
      mutedTextColor: '#526170',
      borderColor: 'rgb(255 255 255 / 58%)',
      hoverLayer: 'rgb(255 255 255 / 42%)',
      pressedLayer: 'rgb(255 255 255 / 58%)',
      selectionLayer: 'rgb(255 255 255 / 78%)',
    },
  }),
  descriptor({
    id: 'warm-frosted-glass',
    name: '暖雾玻璃',
    nativeMaterial: 'mica',
    fallbackColor: '#D7C8B5',
    colorScheme: 'light',
    renderer: {
      surfaceLayer: 'transparent',
      toolbarLayer: '#F3F3F3',
      textColor: '#242629',
      mutedTextColor: '#62666B',
      borderColor: 'rgb(255 251 241 / 64%)',
      hoverLayer: 'rgb(0 0 0 / 5%)',
      pressedLayer: 'rgb(0 0 0 / 11%)',
      selectionLayer: 'rgb(0 0 0 / 11%)',
    },
  }),
  descriptor({
    id: 'clear-glass',
    name: '深色玻璃',
    nativeMaterial: 'mica',
    fallbackColor: '#444847',
    colorScheme: 'dark',
    renderer: {
      surfaceLayer: 'transparent',
      toolbarLayer: '#303332',
      textColor: '#FFFFFF',
      mutedTextColor: '#E3E3E3',
      borderColor: 'rgb(255 255 255 / 40%)',
      hoverLayer: 'rgb(255 255 255 / 8%)',
      pressedLayer: 'rgb(255 255 255 / 14%)',
      selectionLayer: 'rgb(255 255 255 / 22%)',
    },
  }),
] as const satisfies readonly Readonly<StickyNoteMaterialDescriptor>[])

export function stickyNoteMaterialDescriptor(
  id: unknown,
): Readonly<StickyNoteMaterialDescriptor> | null {
  if (typeof id !== 'string') return null
  return STICKY_NOTE_MATERIAL_PRESETS.find((preset) => preset.id === id) ?? null
}

export function stickyNoteMaterialPresetIdForStyle(
  style: StickyNoteStyleReference,
): StickyNoteMaterialPresetId | null {
  return style.mode === 'material' ? style.materialPresetId : null
}
