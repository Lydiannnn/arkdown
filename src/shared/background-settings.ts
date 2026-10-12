export type BackgroundMaskType =
  | 'none'
  | 'circle'
  | 'diagonal-top-left'
  | 'diagonal-top-right'
  | 'diagonal-bottom-left'
  | 'diagonal-bottom-right'
  | 'column-horizontal'
  | 'column-vertical'

export type BackgroundImageAlignment =
  | 'right-bottom'
  | 'left-top'
  | 'right-top'
  | 'left-bottom'
  | 'center'

export interface BackgroundSettings {
  imageRelativePath: string | null
  imageOpacityPercent: number
  imageAlignment: BackgroundImageAlignment
  maskType: BackgroundMaskType
  maskOpacityPercent: number
  maskTransitionPercent: number
  maskStrengthPercent: number
}

export type BackgroundTarget =
  | { kind: 'main' }
  | { kind: 'sticky-note'; noteId: string }

export interface BackgroundPresentation {
  settings: BackgroundSettings
  imageUrl: string | null
}

/** Main keeps this immutable observation for the lifetime of an opened settings draft. */
export interface ObservedMainBackgroundSnapshot {
  revision: number
  settings: BackgroundSettings
  fieldRevisions: Record<keyof BackgroundSettings, number>
}

export type BackgroundApplyResult = BackgroundPresentation | { status: 'conflict' }

export const BACKGROUND_MASK_TYPES = Object.freeze([
  'diagonal-bottom-right',
  'none',
  'circle',
  'diagonal-top-left',
  'diagonal-top-right',
  'diagonal-bottom-left',
  'column-horizontal',
  'column-vertical',
] as const satisfies readonly BackgroundMaskType[])

export const BACKGROUND_IMAGE_ALIGNMENTS = Object.freeze([
  'right-bottom',
  'left-top',
  'right-top',
  'left-bottom',
  'center',
] as const satisfies readonly BackgroundImageAlignment[])

export const DEFAULT_BACKGROUND_SETTINGS: BackgroundSettings = Object.freeze({
  imageRelativePath: null,
  imageOpacityPercent: 50,
  imageAlignment: 'right-bottom',
  maskType: 'diagonal-top-left',
  maskOpacityPercent: 0,
  maskTransitionPercent: 30,
  maskStrengthPercent: 80,
})

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

function isPercentage(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 100
}

export function parseBackgroundSettings(value: unknown): BackgroundSettings | undefined {
  if (!isRecord(value)) return undefined
  const legacyKeys = [
    'imageRelativePath',
    'imageOpacityPercent',
    'maskType',
    'maskOpacityPercent',
    'maskTransitionPercent',
  ] as const
  const currentKeys = [
    'imageRelativePath',
    'imageOpacityPercent',
    'imageAlignment',
    'maskType',
    'maskOpacityPercent',
    'maskTransitionPercent',
    'maskStrengthPercent',
  ] as const
  const legacy = hasExactOwnKeys(value, legacyKeys)
  if (!legacy && !hasExactOwnKeys(value, currentKeys)) return undefined
  if (
    !(value.imageRelativePath === null || typeof value.imageRelativePath === 'string')
    || !isPercentage(value.imageOpacityPercent)
    || typeof value.maskType !== 'string'
    || !isPercentage(value.maskOpacityPercent)
    || !isPercentage(value.maskTransitionPercent)
  ) return undefined

  if (legacy) {
    if (value.maskType !== 'diamond'
      && !BACKGROUND_MASK_TYPES.includes(value.maskType as BackgroundMaskType)) return undefined
    return {
      imageRelativePath: value.imageRelativePath,
      imageOpacityPercent: value.imageOpacityPercent,
      imageAlignment: DEFAULT_BACKGROUND_SETTINGS.imageAlignment,
      maskType: value.maskType === 'diamond'
        ? 'diagonal-bottom-right'
        : value.maskType as BackgroundMaskType,
      maskOpacityPercent: value.maskOpacityPercent,
      maskTransitionPercent: value.maskTransitionPercent,
      maskStrengthPercent: 50,
    }
  }

  if (
    typeof value.imageAlignment !== 'string'
    || !BACKGROUND_IMAGE_ALIGNMENTS.includes(value.imageAlignment as BackgroundImageAlignment)
    || !BACKGROUND_MASK_TYPES.includes(value.maskType as BackgroundMaskType)
    || !isPercentage(value.maskStrengthPercent)
  ) return undefined

  return {
    imageRelativePath: value.imageRelativePath,
    imageOpacityPercent: value.imageOpacityPercent,
    imageAlignment: value.imageAlignment as BackgroundImageAlignment,
    maskType: value.maskType as BackgroundMaskType,
    maskOpacityPercent: value.maskOpacityPercent,
    maskTransitionPercent: value.maskTransitionPercent,
    maskStrengthPercent: value.maskStrengthPercent,
  }
}

export function copyBackgroundSettings(value: BackgroundSettings): BackgroundSettings {
  return { ...value }
}

export function normalizeBackgroundSettings(value: unknown): BackgroundSettings {
  const parsed = parseBackgroundSettings(value)
  return parsed === undefined
    ? copyBackgroundSettings(DEFAULT_BACKGROUND_SETTINGS)
    : copyBackgroundSettings(parsed)
}
