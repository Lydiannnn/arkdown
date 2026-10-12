import type { TargetLanguage } from './large-model-settings'
import {
  isPublicErrorCode,
  PUBLIC_ERROR_MESSAGES,
  type PublicErrorCode,
} from './public-errors'

// Matches the existing bounded document/path identity contract.
export const TRANSLATION_DOCUMENT_KEY_MAX_LENGTH = 32_767
export const TRANSLATION_CONTENT_MAX_LENGTH = 200_000
// The model transport accepts SSE lines no larger than 256 KiB.
export const TRANSLATION_DELTA_MAX_BYTES = 256 * 1024
export const TRANSLATION_DELTA_CHUNK_MAX_BYTES = 240 * 1024

const TRANSLATION_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isCanonicalTranslationRequestId(value: string): boolean {
  return TRANSLATION_REQUEST_ID_PATTERN.test(value)
}

export type TranslationEditorMode = 'visual' | 'source'
export type TranslationPresentation = 'popover' | 'sidebar'

export interface SelectionAnchorRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface TranslationSelectionContent {
  markdown: string
  plainText: string
}

export interface TranslationSelectionGeometry {
  anchorRect: SelectionAnchorRect
  focusRect: SelectionAnchorRect
}

export interface TranslationSelection extends TranslationSelectionGeometry {
  range?: Readonly<{ from: number; to: number }>
  source?: Readonly<{ id: string; displayName: string; revision: number }>
  content: TranslationSelectionContent
  mode: TranslationEditorMode
  releaseRect: SelectionAnchorRect
  scope?: 'selection' | 'document'
}

export interface StartTranslationInput {
  documentKey: string
  content: TranslationSelectionContent
  mode: TranslationEditorMode
}

export interface TranslationStarted {
  requestId: string
  targetLanguage: Exclude<TargetLanguage, 'auto'>
  modelId: string
}

export type TranslationEvent =
  | { requestId: string; type: 'started' }
  | { requestId: string; type: 'delta'; delta: string }
  | { requestId: string; type: 'completed' }
  | { requestId: string; type: 'stopped' }
  | { requestId: string; type: 'failed'; code: PublicErrorCode; message: string }

export function countVisibleCharacters(value: string): number {
  if (typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length
  }

  return Array.from(value).length
}

export function chooseTranslationPresentation(
  selection: Pick<TranslationSelection, 'content' | 'mode'>,
): TranslationPresentation {
  if (selection.mode === 'source' || /[\r\n]/u.test(selection.content.plainText)) return 'sidebar'
  return countVisibleCharacters(selection.content.plainText) >= 100 ? 'sidebar' : 'popover'
}

function isExactOwnRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const ownKeys = Reflect.ownKeys(value)
  return (
    ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  )
}

export function isTranslationSelectionContent(
  value: unknown,
): value is TranslationSelectionContent {
  return (
    isExactOwnRecord(value, ['markdown', 'plainText'])
    && typeof value.markdown === 'string'
    && value.markdown.length <= TRANSLATION_CONTENT_MAX_LENGTH
    && value.markdown.trim().length > 0
    && typeof value.plainText === 'string'
    && value.plainText.length <= TRANSLATION_CONTENT_MAX_LENGTH
  )
}

export function isStartTranslationInput(value: unknown): value is StartTranslationInput {
  return (
    isExactOwnRecord(value, ['documentKey', 'content', 'mode'])
    && typeof value.documentKey === 'string'
    && value.documentKey.length <= TRANSLATION_DOCUMENT_KEY_MAX_LENGTH
    && value.documentKey.trim().length > 0
    && isTranslationSelectionContent(value.content)
    && (value.mode === 'visual' || value.mode === 'source')
  )
}

export function parseTranslationEvent(value: unknown): TranslationEvent | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const type = Object.prototype.hasOwnProperty.call(value, 'type')
    ? (value as Record<string, unknown>).type
    : undefined
  const keys = type === 'delta'
    ? ['requestId', 'type', 'delta']
    : type === 'failed'
      ? ['requestId', 'type', 'code', 'message']
      : ['requestId', 'type']
  if (!isExactOwnRecord(value, keys)) return undefined
  if (
    typeof value.requestId !== 'string'
    || !isCanonicalTranslationRequestId(value.requestId)
  ) return undefined
  if (value.type === 'started' || value.type === 'completed' || value.type === 'stopped') {
    return { requestId: value.requestId, type: value.type }
  }
  if (value.type === 'delta') {
    if (
      typeof value.delta !== 'string'
      || value.delta.length > TRANSLATION_DELTA_MAX_BYTES
      || new TextEncoder().encode(value.delta).byteLength > TRANSLATION_DELTA_MAX_BYTES
    ) return undefined
    return { requestId: value.requestId, type: 'delta', delta: value.delta }
  }
  if (
    value.type !== 'failed'
    || !isPublicErrorCode(value.code)
    || typeof value.message !== 'string'
    || value.message !== PUBLIC_ERROR_MESSAGES[value.code]
  ) return undefined
  return {
    requestId: value.requestId,
    type: 'failed',
    code: value.code,
    message: PUBLIC_ERROR_MESSAGES[value.code],
  }
}

export function translationEventUtf8ByteLength(event: TranslationEvent): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength
}

export function translationOverflowEvent(requestId: string): TranslationEvent {
  return {
    requestId,
    type: 'failed',
    code: 'OPERATION_FAILED',
    message: PUBLIC_ERROR_MESSAGES.OPERATION_FAILED,
  }
}
