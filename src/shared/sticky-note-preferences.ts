import {
  stickyNoteMaterialDescriptor,
  type StickyNoteMaterialPresetId,
} from './sticky-note-materials'

export type StickyNoteColorPresetId =
  | 'yellow'
  | 'red'
  | 'green'
  | 'blue'
  | 'purple'
  | 'orange'
  | 'gray'
  | 'custom'

export type StickyNoteTexturePresetId =
  | 'plain'
  | 'ruled'
  | 'grid'
  | 'dots'
  | 'diagonal'
  | 'paper'
  | 'fabric'

export type StickyNoteTexturePattern =
  | 'none'
  | 'horizontal-lines'
  | 'grid'
  | 'dots'
  | 'diagonal'
  | 'paper'
  | 'fabric'

export interface StickyNoteColorPreset {
  id: StickyNoteColorPresetId
  name: string
  value: string
}

export interface StickyNoteTextureSnapshot {
  pattern: StickyNoteTexturePattern
  foregroundColor: string
  opacityPercent: number
  scalePx: number
}

export interface StickyNoteTexturePreset extends StickyNoteTextureSnapshot {
  id: StickyNoteTexturePresetId
  name: string
}

export interface StickyNotePreferences {
  defaultAppearance: 'mica-light' | 'warm-frosted-glass' | 'clear-glass' | 'flowing-glass' | 'color'
  defaultColor: string
  colorPresets: StickyNoteColorPreset[]
  texturePresets: StickyNoteTexturePreset[]
}

export type StickyNoteStyleReference =
  | {
      mode: 'preset'
      colorPresetId: StickyNoteColorPresetId
      texturePresetId: StickyNoteTexturePresetId
    }
  | {
      mode: 'independent'
      color: string
      texture: StickyNoteTextureSnapshot
    }
  | {
      mode: 'material'
      materialPresetId: StickyNoteMaterialPresetId
    }

export const DEFAULT_STICKY_NOTE_COLOR_PRESET_ID: StickyNoteColorPresetId = 'yellow'
export const DEFAULT_STICKY_NOTE_TEXTURE_PRESET_ID: StickyNoteTexturePresetId = 'plain'

const LEGACY_STICKY_NOTE_MATERIAL_PRESET_IDS: Readonly<Record<string, StickyNoteMaterialPresetId>> = {
  'mica-dark': 'mica-light',
  'acrylic-dark': 'flowing-glass',
  'acrylic-light': 'flowing-glass',
}

export const STICKY_NOTE_COLOR_PRESET_IDS = Object.freeze([
  'yellow',
  'red',
  'green',
  'blue',
  'purple',
  'orange',
  'gray',
  'custom',
] as const satisfies readonly StickyNoteColorPresetId[])

export const STICKY_NOTE_TEXTURE_PRESET_IDS = Object.freeze([
  'plain',
  'ruled',
  'grid',
  'dots',
  'diagonal',
  'paper',
  'fabric',
] as const satisfies readonly StickyNoteTexturePresetId[])

const TEXTURE_PATTERNS = new Set<StickyNoteTexturePattern>([
  'none',
  'horizontal-lines',
  'grid',
  'dots',
  'diagonal',
  'paper',
  'fabric',
])

const DEFAULT_COLOR_PRESETS: readonly StickyNoteColorPreset[] = Object.freeze([
  Object.freeze({ id: 'yellow', name: '黄色', value: '#FFF3B3' }),
  Object.freeze({ id: 'red', name: '红色', value: '#F6C9C9' }),
  Object.freeze({ id: 'green', name: '绿色', value: '#C8E8D5' }),
  Object.freeze({ id: 'blue', name: '蓝色', value: '#CADAFB' }),
  Object.freeze({ id: 'purple', name: '紫色', value: '#E0C9E0' }),
  Object.freeze({ id: 'orange', name: '橙色', value: '#F6D6B3' }),
  Object.freeze({ id: 'gray', name: '灰色', value: '#DADBDD' }),
  Object.freeze({ id: 'custom', name: '自定义', value: '#F9E78B' }),
])

const DEFAULT_TEXTURE_PRESETS: readonly StickyNoteTexturePreset[] = Object.freeze([
  Object.freeze({
    id: 'plain',
    name: '纯色',
    pattern: 'none',
    foregroundColor: '#000000',
    opacityPercent: 0,
    scalePx: 16,
  }),
  Object.freeze({
    id: 'ruled',
    name: '横线',
    pattern: 'horizontal-lines',
    foregroundColor: '#000000',
    opacityPercent: 12,
    scalePx: 24,
  }),
  Object.freeze({
    id: 'grid',
    name: '方格',
    pattern: 'grid',
    foregroundColor: '#000000',
    opacityPercent: 10,
    scalePx: 20,
  }),
  Object.freeze({
    id: 'dots',
    name: '圆点',
    pattern: 'dots',
    foregroundColor: '#000000',
    opacityPercent: 12,
    scalePx: 16,
  }),
  Object.freeze({
    id: 'diagonal',
    name: '斜纹',
    pattern: 'diagonal',
    foregroundColor: '#000000',
    opacityPercent: 8,
    scalePx: 18,
  }),
  Object.freeze({
    id: 'paper',
    name: '纸张',
    pattern: 'paper',
    foregroundColor: '#6B5A3A',
    opacityPercent: 8,
    scalePx: 28,
  }),
  Object.freeze({
    id: 'fabric',
    name: '织物',
    pattern: 'fabric',
    foregroundColor: '#000000',
    opacityPercent: 7,
    scalePx: 12,
  }),
])

export const DEFAULT_STICKY_NOTE_PREFERENCES: StickyNotePreferences = Object.freeze({
  defaultAppearance: 'mica-light',
  defaultColor: '#F9E78B',
  colorPresets: DEFAULT_COLOR_PRESETS,
  texturePresets: DEFAULT_TEXTURE_PRESETS,
}) as unknown as StickyNotePreferences

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactOwnKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
}

function isExactArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1 || !keys.includes('length')) return false
  return value.every((_entry, index) => Object.hasOwn(value, String(index)))
}

function isSafeName(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value === value.trim()
    && value.length >= 1
    && value.length <= 40
    && !/[\u0000-\u001f\u007f]/u.test(value)
  )
}

function normalizeHexColor(value: unknown): string | undefined {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value)
    ? value.toUpperCase()
    : undefined
}

function parseTextureSnapshot(value: unknown): StickyNoteTextureSnapshot | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'pattern',
    'foregroundColor',
    'opacityPercent',
    'scalePx',
  ])) return undefined

  const foregroundColor = normalizeHexColor(value.foregroundColor)
  if (
    typeof value.pattern !== 'string'
    || !TEXTURE_PATTERNS.has(value.pattern as StickyNoteTexturePattern)
    || foregroundColor === undefined
    || typeof value.opacityPercent !== 'number'
    || !Number.isSafeInteger(value.opacityPercent)
    || value.opacityPercent < 0
    || value.opacityPercent > 100
    || typeof value.scalePx !== 'number'
    || !Number.isSafeInteger(value.scalePx)
    || value.scalePx < 4
    || value.scalePx > 64
  ) return undefined

  return {
    pattern: value.pattern as StickyNoteTexturePattern,
    foregroundColor,
    opacityPercent: value.opacityPercent,
    scalePx: value.scalePx,
  }
}

export function parseStickyNoteStyleReference(
  value: unknown,
): StickyNoteStyleReference | undefined {
  if (!isRecord(value) || typeof value.mode !== 'string') return undefined

  if (value.mode === 'preset') {
    if (!hasExactOwnKeys(value, ['mode', 'colorPresetId', 'texturePresetId'])) return undefined
    if (
      typeof value.colorPresetId !== 'string'
      || !STICKY_NOTE_COLOR_PRESET_IDS.includes(value.colorPresetId as StickyNoteColorPresetId)
      || typeof value.texturePresetId !== 'string'
      || !STICKY_NOTE_TEXTURE_PRESET_IDS.includes(
        value.texturePresetId as StickyNoteTexturePresetId,
      )
    ) return undefined

    return {
      mode: 'preset',
      colorPresetId: value.colorPresetId as StickyNoteColorPresetId,
      texturePresetId: value.texturePresetId as StickyNoteTexturePresetId,
    }
  }

  if (value.mode === 'material') {
    if (!hasExactOwnKeys(value, ['mode', 'materialPresetId'])) return undefined
    const materialPresetId = typeof value.materialPresetId === 'string'
      ? LEGACY_STICKY_NOTE_MATERIAL_PRESET_IDS[value.materialPresetId] ?? value.materialPresetId
      : value.materialPresetId
    const material = stickyNoteMaterialDescriptor(materialPresetId)
    return material === null
      ? undefined
      : { mode: 'material', materialPresetId: material.id }
  }

  if (value.mode !== 'independent' || !hasExactOwnKeys(value, [
    'mode',
    'color',
    'texture',
  ])) return undefined
  const color = normalizeHexColor(value.color)
  const texture = parseTextureSnapshot(value.texture)
  if (color === undefined || texture === undefined) return undefined

  return { mode: 'independent', color, texture }
}

export function copyStickyNoteStyleReference(
  style: StickyNoteStyleReference,
): StickyNoteStyleReference {
  return style.mode === 'independent'
    ? { ...style, texture: { ...style.texture } }
    : { ...style }
}

function parseColorPreset(value: unknown): StickyNoteColorPreset | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, ['id', 'name', 'value'])) return undefined
  const color = normalizeHexColor(value.value)
  if (
    typeof value.id !== 'string'
    || !STICKY_NOTE_COLOR_PRESET_IDS.includes(value.id as StickyNoteColorPresetId)
    || !isSafeName(value.name)
    || color === undefined
  ) return undefined
  return { id: value.id as StickyNoteColorPresetId, name: value.name, value: color }
}

function parseTexturePreset(value: unknown): StickyNoteTexturePreset | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'id',
    'name',
    'pattern',
    'foregroundColor',
    'opacityPercent',
    'scalePx',
  ])) return undefined
  if (
    typeof value.id !== 'string'
    || !STICKY_NOTE_TEXTURE_PRESET_IDS.includes(value.id as StickyNoteTexturePresetId)
    || !isSafeName(value.name)
  ) return undefined
  const texture = parseTextureSnapshot({
    pattern: value.pattern,
    foregroundColor: value.foregroundColor,
    opacityPercent: value.opacityPercent,
    scalePx: value.scalePx,
  })
  return texture === undefined
    ? undefined
    : { id: value.id as StickyNoteTexturePresetId, name: value.name, ...texture }
}

function hasEveryFixedId<T extends string>(
  values: readonly { id: T }[],
  ids: readonly T[],
): boolean {
  return values.length === ids.length
    && new Set(values.map(({ id }) => id)).size === ids.length
    && ids.every((id) => values.some((value) => value.id === id))
}

export function parseStickyNotePreferences(
  value: unknown,
): StickyNotePreferences | undefined {
  if (!isRecord(value)) return undefined
  const legacy = hasExactOwnKeys(value, ['colorPresets', 'texturePresets'])
  if (!legacy && !hasExactOwnKeys(value, ['colorPresets', 'texturePresets', 'defaultAppearance', 'defaultColor'])) return undefined
  const defaultAppearance = legacy ? 'mica-light' : value.defaultAppearance
  if (defaultAppearance !== 'mica-light' && defaultAppearance !== 'warm-frosted-glass'
    && defaultAppearance !== 'clear-glass' && defaultAppearance !== 'flowing-glass'
    && defaultAppearance !== 'color') return undefined
  if (!legacy && normalizeHexColor(value.defaultColor) === undefined) return undefined
  if (!isExactArray(value.colorPresets) || !isExactArray(value.texturePresets)) return undefined

  const colorPresets: StickyNoteColorPreset[] = []
  for (const candidate of value.colorPresets) {
    const preset = parseColorPreset(candidate)
    if (preset === undefined) return undefined
    colorPresets.push(preset)
  }
  const texturePresets: StickyNoteTexturePreset[] = []
  for (const candidate of value.texturePresets) {
    const preset = parseTexturePreset(candidate)
    if (preset === undefined) return undefined
    texturePresets.push(preset)
  }
  if (
    !hasEveryFixedId(colorPresets, STICKY_NOTE_COLOR_PRESET_IDS)
    || !hasEveryFixedId(texturePresets, STICKY_NOTE_TEXTURE_PRESET_IDS)
  ) return undefined

  const defaultColor = legacy
    ? colorPresets.find(({ id }) => id === 'custom')!.value
    : normalizeHexColor(value.defaultColor)!
  return { colorPresets, texturePresets, defaultAppearance, defaultColor }
}

export function copyStickyNotePreferences(
  value: StickyNotePreferences,
): StickyNotePreferences {
  return {
    defaultAppearance: value.defaultAppearance,
    defaultColor: value.defaultColor,
    colorPresets: value.colorPresets.map((preset) => ({ ...preset })),
    texturePresets: value.texturePresets.map((preset) => ({ ...preset })),
  }
}

export function normalizeStickyNotePreferences(value: unknown): StickyNotePreferences {
  return parseStickyNotePreferences(value)
    ?? copyStickyNotePreferences(DEFAULT_STICKY_NOTE_PREFERENCES)
}

/** Snapshot creation defaults so subsequent preference edits leave existing notes unchanged. */
export function defaultStickyNoteStyle(preferences: StickyNotePreferences): StickyNoteStyleReference {
  return preferences.defaultAppearance === 'color'
    ? {
        mode: 'independent',
        color: preferences.defaultColor,
        texture: { pattern: 'none', foregroundColor: '#000000', opacityPercent: 0, scalePx: 16 },
      }
    : { mode: 'material', materialPresetId: preferences.defaultAppearance }
}
