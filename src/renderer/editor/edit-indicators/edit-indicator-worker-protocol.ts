import type { EditIndicatorSnapshot } from './line-diff'

export interface EditIndicatorWorkerRequest {
  requestId: number
  documentKey: string
  openingMarkdown: string
  savedMarkdown: string
  currentMarkdown: string
}

export type EditIndicatorWorkerResponse =
  | {
      requestId: number
      documentKey: string
      ok: true
      snapshot: EditIndicatorSnapshot
    }
  | {
      requestId: number
      documentKey: string
      ok: false
      message: string
    }

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => actual.includes(key))
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function isDenseStateArray(
  value: unknown,
  expectedLength: number,
): value is EditIndicatorSnapshot['states'] {
  if (!Array.isArray(value) || value.length !== expectedLength) return false
  const keys = Object.keys(value)
  if (
    keys.length !== value.length
    || keys.some((key, index) => key !== String(index))
  ) return false
  return value.every((state, index) => (
    Object.hasOwn(value, String(index))
    && (state === 'none' || state === 'saved' || state === 'unsaved')
  ))
}

function isSnapshot(value: unknown): value is EditIndicatorSnapshot {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !hasExactKeys(value, [
      'states', 'openingLineCount', 'savedLineCount', 'currentLineCount',
    ])
  ) return false
  const candidate = value as Partial<EditIndicatorSnapshot>
  return isNonNegativeSafeInteger(candidate.openingLineCount)
    && isNonNegativeSafeInteger(candidate.savedLineCount)
    && isNonNegativeSafeInteger(candidate.currentLineCount)
    && isDenseStateArray(candidate.states, candidate.currentLineCount)
}

export function isEditIndicatorWorkerRequest(
  value: unknown,
): value is EditIndicatorWorkerRequest {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !hasExactKeys(value, [
      'requestId',
      'documentKey',
      'openingMarkdown',
      'savedMarkdown',
      'currentMarkdown',
    ])
  ) return false
  const candidate = value as Partial<EditIndicatorWorkerRequest>
  return isPositiveSafeInteger(candidate.requestId)
    && typeof candidate.documentKey === 'string'
    && typeof candidate.openingMarkdown === 'string'
    && typeof candidate.savedMarkdown === 'string'
    && typeof candidate.currentMarkdown === 'string'
}

export function isEditIndicatorWorkerResponse(
  value: unknown,
): value is EditIndicatorWorkerResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<EditIndicatorWorkerResponse>
  if (!isPositiveSafeInteger(candidate.requestId)) return false
  if (typeof candidate.documentKey !== 'string' || typeof candidate.ok !== 'boolean') return false
  return candidate.ok
    ? hasExactKeys(value, ['requestId', 'documentKey', 'ok', 'snapshot'])
      && isSnapshot(candidate.snapshot)
    : hasExactKeys(value, ['requestId', 'documentKey', 'ok', 'message'])
      && typeof (candidate as { message?: unknown }).message === 'string'
}
