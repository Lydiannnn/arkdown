import { isPublicErrorCode, type PublicErrorCode } from './public-errors'

export type ScreenshotOcrTier = 'small' | 'medium'

export interface ObservedOcrPreference {
  revision: number
  preferredTier: ScreenshotOcrTier
  tierRevision: number
  mediumSource?: 'managed' | 'bundled' | null
}

export interface ObservedScreenshotOcrState {
  state: ScreenshotOcrModelState
  observed: ObservedOcrPreference
}
export type ScreenshotOcrMutationResult = ScreenshotOcrModelState | { status: 'conflict' }

/** Finite main command outcome; contains no settings contents or filesystem detail. */
export class OcrPreferenceConflictError extends Error {
  constructor() { super('OCR preference changed'); this.name = 'OcrPreferenceConflictError' }
}

export function parseObservedScreenshotOcrState(value: unknown): ObservedScreenshotOcrState | undefined {
  if (!isExactOwnRecord(value, ['state', 'observed'])) return undefined
  const state = parseScreenshotOcrModelState(value.state)
  const observed = parseObservedOcrPreference(value.observed)
  return state && observed ? { state, observed } : undefined
}

export function parseScreenshotOcrMutationResult(value: unknown): ScreenshotOcrMutationResult | undefined {
  if (isExactOwnRecord(value, ['status']) && value.status === 'conflict') return { status: 'conflict' }
  return parseScreenshotOcrModelState(value)
}

export function parseObservedOcrPreference(value: unknown): ObservedOcrPreference | undefined {
  try {
    if (!isExactOwnRecord(value, ['revision', 'preferredTier', 'tierRevision'])
      && !isExactOwnRecord(value, ['revision', 'preferredTier', 'tierRevision', 'mediumSource'])) return undefined
    const hasSource = Object.hasOwn(value, 'mediumSource')
    if (hasSource && value.mediumSource !== null && value.mediumSource !== 'managed' && value.mediumSource !== 'bundled') return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.values(descriptors).some(item => !item.enumerable || !Object.hasOwn(item, 'value'))
      || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
      || !Number.isSafeInteger(value.tierRevision) || (value.tierRevision as number) < 0
      || (value.tierRevision as number) > (value.revision as number)
      || (value.preferredTier !== 'small' && value.preferredTier !== 'medium')) return undefined
    return { revision: value.revision as number, preferredTier: value.preferredTier,
      tierRevision: value.tierRevision as number,
      ...(hasSource ? { mediumSource: value.mediumSource as ObservedOcrPreference['mediumSource'] } : {}) }
  } catch { return undefined }
}

export type ScreenshotOcrModelStatus =
  | 'bundled-small'
  | 'medium-absent'
  | 'medium-downloading'
  | 'medium-installed'
  | 'medium-disabled'
  | 'medium-update-available'
  | 'medium-failed'

export interface ScreenshotOcrDownloadProgress {
  receivedBytes: number
  totalBytes: number
}

export interface ScreenshotOcrModelState {
  activeTier: ScreenshotOcrTier
  bundledVersion: string
  mediumVersion: string | null
  /** Additive public metadata; older state envelopes omit it. Never contains a path. */
  mediumSource?: 'managed' | 'bundled' | null
  availableMediumVersion: string | null
  status: ScreenshotOcrModelStatus
  progress: ScreenshotOcrDownloadProgress | null
  errorCode: PublicErrorCode | null
}

export interface ScreenshotOcrPreferences {
  preferredTier: ScreenshotOcrTier
}

export const MAX_SCREENSHOT_OCR_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024

export const DEFAULT_SCREENSHOT_OCR_PREFERENCES: ScreenshotOcrPreferences = Object.freeze({
  preferredTier: 'small',
})

const TIERS = new Set<ScreenshotOcrTier>(['small', 'medium'])
const STATUSES = new Set<ScreenshotOcrModelStatus>([
  'bundled-small',
  'medium-absent',
  'medium-downloading',
  'medium-installed',
  'medium-disabled',
  'medium-update-available',
  'medium-failed',
])
const VERSION_PATTERN = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/

function isExactOwnRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  try {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const ownKeys = Reflect.ownKeys(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.values(descriptors).every(item => item.enumerable && Object.hasOwn(item, 'value'))
  } catch { return false }
}

export function isCanonicalScreenshotOcrModelVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_PATTERN.test(value)
}

function parseProgress(value: unknown): ScreenshotOcrDownloadProgress | undefined {
  if (!isExactOwnRecord(value, ['receivedBytes', 'totalBytes'])) return undefined
  if (
    typeof value.receivedBytes !== 'number'
    || !Number.isSafeInteger(value.receivedBytes)
    || value.receivedBytes < 0
    || typeof value.totalBytes !== 'number'
    || !Number.isSafeInteger(value.totalBytes)
    || value.totalBytes <= 0
    || value.totalBytes > MAX_SCREENSHOT_OCR_DOWNLOAD_BYTES
    || value.receivedBytes > value.totalBytes
  ) return undefined
  return { receivedBytes: value.receivedBytes, totalBytes: value.totalBytes }
}

export function parseScreenshotOcrModelState(value: unknown): ScreenshotOcrModelState | undefined {
  const keys = [
    'activeTier', 'bundledVersion', 'mediumVersion', 'availableMediumVersion',
    'status', 'progress', 'errorCode',
  ]
  if (!isExactOwnRecord(value, keys) && !isExactOwnRecord(value, [...keys, 'mediumSource'])) return undefined
  if (
    typeof value.activeTier !== 'string' || !TIERS.has(value.activeTier as ScreenshotOcrTier)
    || !isCanonicalScreenshotOcrModelVersion(value.bundledVersion)
    || !(value.mediumVersion === null || isCanonicalScreenshotOcrModelVersion(value.mediumVersion))
    || !(value.availableMediumVersion === null || isCanonicalScreenshotOcrModelVersion(value.availableMediumVersion))
    || typeof value.status !== 'string' || !STATUSES.has(value.status as ScreenshotOcrModelStatus)
    || !(value.progress === null || parseProgress(value.progress) !== undefined)
    || !(value.errorCode === null || isPublicErrorCode(value.errorCode))
  ) return undefined

  const activeTier = value.activeTier as ScreenshotOcrTier
  const status = value.status as ScreenshotOcrModelStatus
  const mediumVersion = value.mediumVersion as string | null
  const availableMediumVersion = value.availableMediumVersion as string | null
  const progress = value.progress === null ? null : parseProgress(value.progress)!
  const errorCode = value.errorCode as PublicErrorCode | null
  const hasMedium = mediumVersion !== null
  const hasSource = Object.hasOwn(value, 'mediumSource')
  const mediumSource = value.mediumSource as ScreenshotOcrModelState['mediumSource']
  if (hasSource && (mediumSource !== null && mediumSource !== 'managed' && mediumSource !== 'bundled'
    || (mediumSource !== null) !== hasMedium)) return undefined
  const canUseMedium = hasMedium && (status === 'medium-installed'
    || status === 'medium-update-available' || status === 'medium-downloading' || status === 'medium-failed')
  if (activeTier === 'medium' && !canUseMedium) return undefined

  if (status === 'bundled-small') {
    if (activeTier !== 'small' || hasMedium || availableMediumVersion !== null || progress !== null || errorCode !== null) return undefined
  } else if (status === 'medium-absent') {
    if (hasMedium || availableMediumVersion === null || progress !== null || errorCode !== null) return undefined
  } else if (status === 'medium-downloading') {
    if (availableMediumVersion === null || progress === null || errorCode !== null) return undefined
  } else if (status === 'medium-installed') {
    if (!hasMedium || availableMediumVersion !== null || progress !== null || errorCode !== null) return undefined
  } else if (status === 'medium-disabled') {
    if (activeTier !== 'small' || !hasMedium || mediumSource !== 'bundled'
      || availableMediumVersion === mediumVersion || progress !== null || errorCode !== null) return undefined
  } else if (status === 'medium-update-available') {
    if (!hasMedium || availableMediumVersion === null || mediumVersion === availableMediumVersion || progress !== null || errorCode !== null) return undefined
  } else if (progress !== null || availableMediumVersion === null || errorCode === null) {
    return undefined
  }

  return {
    activeTier,
    bundledVersion: value.bundledVersion,
    mediumVersion,
    ...(hasSource ? { mediumSource } : {}),
    availableMediumVersion,
    status,
    progress,
    errorCode,
  }
}

export function parseScreenshotOcrPreferences(value: unknown): ScreenshotOcrPreferences | undefined {
  if (!isExactOwnRecord(value, ['preferredTier'])
    || typeof value.preferredTier !== 'string'
    || !TIERS.has(value.preferredTier as ScreenshotOcrTier)) return undefined
  return { preferredTier: value.preferredTier as ScreenshotOcrTier }
}

export function normalizeScreenshotOcrPreferences(value: unknown): ScreenshotOcrPreferences {
  return parseScreenshotOcrPreferences(value) ?? { preferredTier: 'small' }
}

export function copyScreenshotOcrPreferences(value: ScreenshotOcrPreferences): ScreenshotOcrPreferences {
  return { preferredTier: value.preferredTier }
}
