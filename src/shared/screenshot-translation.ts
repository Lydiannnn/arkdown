import type { ScreenshotOcrTier } from './screenshot-ocr-models'

export const SCREENSHOT_SESSION_ID_MAX_LENGTH = 36
export const SCREENSHOT_IMAGE_DATA_URL_MAX_BYTES = 32 * 1024 * 1024
export const SCREENSHOT_IMAGE_MAX_DIMENSION_PX = 32_768
export const SCREENSHOT_IMAGE_MAX_PIXELS = 25_000_000
export const SCREENSHOT_OCR_BLOCK_LIMIT = 4_096
export const SCREENSHOT_OCR_WORD_LIMIT = 32_768
export const SCREENSHOT_OCR_TEXT_MAX_LENGTH = 200_000
export const SCREENSHOT_OCR_BLOCK_TEXT_MAX_LENGTH = 8_192
export const SCREENSHOT_TRANSLATED_TEXT_MAX_LENGTH = 16_384
export const SCREENSHOT_TRANSLATED_TEXT_TOTAL_MAX_LENGTH = 2 * 1024 * 1024
export const SCREENSHOT_TRANSLATED_TEXT_TOTAL_MAX_BYTES = 2 * 1024 * 1024
export const SCREENSHOT_DISPLAY_ID_MAX_LENGTH = 256
export const SCREENSHOT_TRANSLATION_ACCELERATOR = 'Ctrl+Shift+Q'

export interface ScreenshotPoint { x: number; y: number }
export interface ScreenshotSize { width: number; height: number }
export interface ScreenshotRect extends ScreenshotPoint, ScreenshotSize {}

export interface CaptureDisplaySnapshot {
  displayId: string
  boundsDip: ScreenshotRect
  scaleFactor: number
  imageSizePx: ScreenshotSize
  dataUrl: string
}

export interface ScreenshotImage {
  width: number
  height: number
  dataUrl: string
}

export interface ScreenshotOcrWord {
  text: string
  rectPx: ScreenshotRect
}

export interface ScreenshotOcrBlock {
  id: string
  text: string
  rectPx: ScreenshotRect
  words: readonly ScreenshotOcrWord[]
}

export interface ScreenshotOcrResult {
  width: number
  height: number
  language: string
  blocks: readonly ScreenshotOcrBlock[]
}

export type ScreenshotOcrFailureCode = 'OCR_UNAVAILABLE' | 'OCR_TIMEOUT' | 'OCR_FAILED'

export type ScreenshotOcrSubmission =
  | { sessionId: string; generation: number; status: 'success'; result: ScreenshotOcrResult }
  | { sessionId: string; generation: number; status: 'failure'; code: ScreenshotOcrFailureCode }

export type ScreenshotOcrHostCommand =
  | {
      type: 'recognize'
      sessionId: string
      generation: number
      image: ScreenshotImage
      tier: ScreenshotOcrTier
      cacheKey: string
    }
  | { type: 'cancel'; sessionId: string; generation: number }

export interface ScreenshotTranslatedBlock {
  id: string
  text: string
}

export type ScreenshotPublicErrorCode =
  | 'CAPTURE_UNAVAILABLE'
  | 'CAPTURE_EMPTY'
  | 'OCR_UNAVAILABLE'
  | 'OCR_LANGUAGE_UNAVAILABLE'
  | 'OCR_TIMEOUT'
  | 'OCR_FAILED'
  | 'MODEL_NOT_CONFIGURED'
  | 'MODEL_TIMEOUT'
  | 'MODEL_AUTHENTICATION_FAILED'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_RATE_LIMITED'
  | 'MODEL_QUOTA_EXCEEDED'
  | 'MODEL_RESPONSE_INVALID'
  | 'TRANSLATION_FAILED'

export type ScreenshotTranslationEvent =
  | { sessionId: string; generation: number; type: 'snapshot-ready'; image: ScreenshotImage; tier: ScreenshotOcrTier }
  | { sessionId: string; generation: number; type: 'ocr-started'; tier: ScreenshotOcrTier }
  | { sessionId: string; generation: number; type: 'ocr-completed'; blocks: readonly ScreenshotOcrBlock[] }
  | { sessionId: string; generation: number; type: 'translation-started' }
  | { sessionId: string; generation: number; type: 'translation-completed'; translations: readonly ScreenshotTranslatedBlock[] }
  | {
      sessionId: string
      generation: number
      type: 'document-translation-progress'
      text: string
      completedChunks: number
      totalChunks: number
    }
  | { sessionId: string; generation: number; type: 'document-translation-completed'; text: string }
  | { sessionId: string; generation: number; type: 'translation-cancelled' }
  | { sessionId: string; generation: number; type: 'failed'; stage: 'capture' | 'ocr' | 'translation'; code: ScreenshotPublicErrorCode }

export interface ScreenshotWindowHighlight {
  processId: number
  rectDip: ScreenshotRect
}

export function parseScreenshotWindowHighlightResult(value: unknown): ScreenshotWindowHighlight | null | undefined {
  if (value === null) return null
  if (!isExactOwnRecord(value, ['processId', 'rectDip'])) return undefined
  const processId = parseGeneration(value.processId)
  const rectDip = parseDipRect(value.rectDip)
  return processId && rectDip ? { processId, rectDip } : undefined
}

export type ScreenshotCaptureEvent =
  | { sessionId: string; type: 'selection-ready'; display: CaptureDisplaySnapshot }
  | { sessionId: string; type: 'window-highlight'; displayId: string; hit: ScreenshotWindowHighlight | null }
  | { sessionId: string; type: 'committing' }
  | { sessionId: string; type: 'cancelled' }
  | { sessionId: string; type: 'failed'; code: 'CAPTURE_UNAVAILABLE' | 'CAPTURE_EMPTY' }

export interface ScreenshotCapturePointerInput {
  sessionId: string
  displayId: string
  screenPointDip: ScreenshotPoint
}

export interface ScreenshotCaptureReadyInput {
  sessionId: string
  displayId: string
}

export type ScreenshotCaptureCommitInput =
  | { sessionId: string; displayId: string; kind: 'region'; rectDip: ScreenshotRect }
  | { sessionId: string; displayId: string; kind: 'window'; rectDip: ScreenshotRect; processId: number }

export interface ScreenshotSessionInput { sessionId: string }
export interface ScreenshotTranslationGenerationInput extends ScreenshotSessionInput { generation: number }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const LINE_ID_PATTERN = /^line-([1-9][0-9]*)$/
const MAX_DIP_COORDINATE = 1_000_000

function isExactOwnRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === value.length + 1
    && ownKeys.includes('length')
    && ownKeys.every((key) => key === 'length' || (
      typeof key === 'string'
      && /^(0|[1-9][0-9]*)$/.test(key)
      && Number(key) < value.length
    ))
}

function isFiniteDip(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_DIP_COORDINATE
}

function isPositivePixelDimension(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && value <= SCREENSHOT_IMAGE_MAX_DIMENSION_PX
}

function parseDipPoint(value: unknown): ScreenshotPoint | undefined {
  if (!isExactOwnRecord(value, ['x', 'y']) || !isFiniteDip(value.x) || !isFiniteDip(value.y)) return undefined
  return { x: value.x, y: value.y }
}

function parseDipRect(value: unknown): ScreenshotRect | undefined {
  if (!isExactOwnRecord(value, ['x', 'y', 'width', 'height'])
    || !isFiniteDip(value.x)
    || !isFiniteDip(value.y)
    || !isFiniteDip(value.width)
    || !isFiniteDip(value.height)
    || value.width <= 0
    || value.height <= 0) return undefined
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}

function parsePixelRect(value: unknown): ScreenshotRect | undefined {
  if (!isExactOwnRecord(value, ['x', 'y', 'width', 'height'])
    || typeof value.x !== 'number'
    || typeof value.y !== 'number'
    || !Number.isSafeInteger(value.x)
    || !Number.isSafeInteger(value.y)
    || value.x < 0
    || value.y < 0
    || !isPositivePixelDimension(value.width)
    || !isPositivePixelDimension(value.height)
    || value.x > SCREENSHOT_IMAGE_MAX_DIMENSION_PX - value.width
    || value.y > SCREENSHOT_IMAGE_MAX_DIMENSION_PX - value.height) return undefined
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}

function parsePixelSize(value: unknown): ScreenshotSize | undefined {
  if (!isExactOwnRecord(value, ['width', 'height'])
    || !isPositivePixelDimension(value.width)
    || !isPositivePixelDimension(value.height)) return undefined
  return { width: value.width, height: value.height }
}

function isCanonicalText(value: unknown, maxLength?: number): value is string {
  return typeof value === 'string'
    && (maxLength === undefined || value.length <= maxLength)
    && value.length > 0
    && value.trim().length > 0
    && !value.includes('\0')
    && value.normalize('NFC') === value
}

function isCanonicalOcrText(value: unknown, maxLength?: number): value is string {
  if (!isCanonicalText(value, maxLength) || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

function isCanonicalDocumentText(value: unknown): value is string {
  if (!isCanonicalText(value, SCREENSHOT_TRANSLATED_TEXT_TOTAL_MAX_LENGTH)
    || new TextEncoder().encode(value).byteLength > SCREENSHOT_TRANSLATED_TEXT_TOTAL_MAX_BYTES
    || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(value)) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

function isCanonicalDataUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('data:image/png;base64,')) return false
  const encoded = value.slice('data:image/png;base64,'.length)
  if (encoded.length === 0 || encoded.length % 4 !== 0) return false
  const maxEncodedLength = Math.ceil(SCREENSHOT_IMAGE_DATA_URL_MAX_BYTES / 3) * 4
  if (encoded.length > maxEncodedLength) return false
  const firstPadding = encoded.indexOf('=')
  const unpaddedEnd = firstPadding === -1 ? encoded.length : firstPadding
  const paddingLength = encoded.length - unpaddedEnd
  if (paddingLength > 2 || (paddingLength > 0 && unpaddedEnd % 4 < 2)) return false
  for (let index = 0; index < unpaddedEnd; index += 1) {
    const code = encoded.charCodeAt(index)
    const isBase64Character = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47
    if (!isBase64Character) return false
  }
  for (let index = unpaddedEnd; index < encoded.length; index += 1) {
    if (encoded[index] !== '=') return false
  }
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  if (padding > 0) {
    const lastValue = base64Value(encoded.charCodeAt(unpaddedEnd - 1))
    if (lastValue === undefined || (padding === 2 && lastValue % 16 !== 0) || (padding === 1 && lastValue % 4 !== 0)) return false
  }
  const byteLength = (encoded.length / 4) * 3 - padding
  return byteLength > 0 && byteLength <= SCREENSHOT_IMAGE_DATA_URL_MAX_BYTES
}

function base64Value(code: number): number | undefined {
  if (code >= 65 && code <= 90) return code - 65
  if (code >= 97 && code <= 122) return code - 71
  if (code >= 48 && code <= 57) return code + 4
  if (code === 43) return 62
  if (code === 47) return 63
  return undefined
}

function parseDisplayId(value: unknown): string | undefined {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > SCREENSHOT_DISPLAY_ID_MAX_LENGTH
    || value.trim() !== value
    || value.includes('\0')
    || value.normalize('NFC') !== value) return undefined
  return value
}

export function parseScreenshotSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length !== SCREENSHOT_SESSION_ID_MAX_LENGTH || !UUID_PATTERN.test(value)) return undefined
  return value
}

function parseGeneration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function parseLineId(value: unknown): { id: string; number: number } | undefined {
  if (typeof value !== 'string') return undefined
  const match = LINE_ID_PATTERN.exec(value)
  if (!match) return undefined
  const number = Number(match[1])
  if (!Number.isSafeInteger(number) || number <= 0) return undefined
  return { id: value, number }
}

function rectContains(bounds: ScreenshotRect, rect: ScreenshotRect): boolean {
  return rect.x >= bounds.x
    && rect.y >= bounds.y
    && rect.x + rect.width <= bounds.x + bounds.width
    && rect.y + rect.height <= bounds.y + bounds.height
}

function parseScreenshotImage(value: unknown): ScreenshotImage | undefined {
  if (!isExactOwnRecord(value, ['width', 'height', 'dataUrl'])
    || !isPositivePixelDimension(value.width)
    || !isPositivePixelDimension(value.height)
    || value.width * value.height > SCREENSHOT_IMAGE_MAX_PIXELS
    || !isCanonicalDataUrl(value.dataUrl)) return undefined
  return { width: value.width, height: value.height, dataUrl: value.dataUrl }
}

export function parseCaptureDisplaySnapshot(value: unknown): CaptureDisplaySnapshot | undefined {
  if (!isExactOwnRecord(value, ['displayId', 'boundsDip', 'scaleFactor', 'imageSizePx', 'dataUrl'])) return undefined
  const displayId = parseDisplayId(value.displayId)
  const boundsDip = parseDipRect(value.boundsDip)
  const imageSizePx = parsePixelSize(value.imageSizePx)
  if (!displayId || !boundsDip || !imageSizePx || !isCanonicalDataUrl(value.dataUrl)
    || typeof value.scaleFactor !== 'number'
    || !Number.isFinite(value.scaleFactor)
    || value.scaleFactor < 0.5
    || value.scaleFactor > 8) return undefined
  return { displayId, boundsDip, scaleFactor: value.scaleFactor, imageSizePx, dataUrl: value.dataUrl }
}

export function parseScreenshotOcrBlocks(value: unknown): readonly ScreenshotOcrBlock[] | undefined {
  if (!isDenseArray(value) || value.length > SCREENSHOT_OCR_BLOCK_LIMIT) return undefined
  const blocks: ScreenshotOcrBlock[] = []
  let previousId = 0
  let wordCount = 0
  let textLength = 0
  for (const candidate of value) {
    if (!isExactOwnRecord(candidate, ['id', 'text', 'rectPx', 'words'])) return undefined
    const parsedId = parseLineId(candidate.id)
    const rectPx = parsePixelRect(candidate.rectPx)
    if (!parsedId || parsedId.number !== previousId + 1 || !rectPx
      || !isCanonicalOcrText(candidate.text, SCREENSHOT_OCR_BLOCK_TEXT_MAX_LENGTH)
      || !isDenseArray(candidate.words) || candidate.words.length === 0) return undefined
    previousId = parsedId.number
    textLength += candidate.text.length
    const words: ScreenshotOcrWord[] = []
    for (const word of candidate.words) {
      if (!isExactOwnRecord(word, ['text', 'rectPx'])
        || typeof word.text !== 'string'
        || word.text.length > SCREENSHOT_OCR_TEXT_MAX_LENGTH - textLength
        || !isCanonicalOcrText(word.text)) return undefined
      const wordRect = parsePixelRect(word.rectPx)
      if (!wordRect || !rectContains(rectPx, wordRect)) return undefined
      wordCount += 1
      textLength += word.text.length
      if (wordCount > SCREENSHOT_OCR_WORD_LIMIT || textLength > SCREENSHOT_OCR_TEXT_MAX_LENGTH) return undefined
      words.push({ text: word.text, rectPx: wordRect })
    }
    let left = Number.POSITIVE_INFINITY
    let top = Number.POSITIVE_INFINITY
    let right = 0
    let bottom = 0
    for (const word of words) {
      left = Math.min(left, word.rectPx.x)
      top = Math.min(top, word.rectPx.y)
      right = Math.max(right, word.rectPx.x + word.rectPx.width)
      bottom = Math.max(bottom, word.rectPx.y + word.rectPx.height)
    }
    if (rectPx.x !== left || rectPx.y !== top || rectPx.width !== right - left || rectPx.height !== bottom - top) return undefined
    if (textLength > SCREENSHOT_OCR_TEXT_MAX_LENGTH) return undefined
    blocks.push({ id: parsedId.id, text: candidate.text, rectPx, words })
  }
  return blocks
}

export function parseScreenshotOcrResult(value: unknown): ScreenshotOcrResult | undefined {
  if (!isExactOwnRecord(value, ['width', 'height', 'language', 'blocks'])
    || !isPositivePixelDimension(value.width)
    || !isPositivePixelDimension(value.height)
    || value.width * value.height > SCREENSHOT_IMAGE_MAX_PIXELS
    || typeof value.language !== 'string'
    || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(value.language)) return undefined
  const blocks = parseScreenshotOcrBlocks(value.blocks)
  if (!blocks) return undefined
  const bounds = { x: 0, y: 0, width: value.width, height: value.height }
  if (blocks.some((block) => !rectContains(bounds, block.rectPx)
    || block.words.some((word) => !rectContains(bounds, word.rectPx)))) return undefined
  return { width: value.width, height: value.height, language: value.language, blocks }
}

export function parseScreenshotOcrSubmission(value: unknown): ScreenshotOcrSubmission | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const sessionId = parseScreenshotSessionId(record.sessionId)
  const generation = parseGeneration(record.generation)
  if (!sessionId || !generation) return undefined
  if (record.status === 'success' && isExactOwnRecord(record, ['sessionId', 'generation', 'status', 'result'])) {
    const result = parseScreenshotOcrResult(record.result)
    return result ? { sessionId, generation, status: 'success', result } : undefined
  }
  if (record.status === 'failure' && isExactOwnRecord(record, ['sessionId', 'generation', 'status', 'code'])
    && (record.code === 'OCR_UNAVAILABLE' || record.code === 'OCR_TIMEOUT' || record.code === 'OCR_FAILED')) {
    return { sessionId, generation, status: 'failure', code: record.code }
  }
  return undefined
}

export function parseScreenshotOcrHostCommand(value: unknown): ScreenshotOcrHostCommand | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const sessionId = parseScreenshotSessionId(record.sessionId)
  const generation = parseGeneration(record.generation)
  if (!sessionId || !generation) return undefined
  if (record.type === 'cancel' && isExactOwnRecord(record, ['type', 'sessionId', 'generation'])) {
    return { type: 'cancel', sessionId, generation }
  }
  if (record.type !== 'recognize'
    || !isExactOwnRecord(record, ['type', 'sessionId', 'generation', 'image', 'tier', 'cacheKey'])
    || (record.tier !== 'small' && record.tier !== 'medium')
    || typeof record.cacheKey !== 'string'
    || !/^(?:small|medium):[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(record.cacheKey)
    || !record.cacheKey.startsWith(`${record.tier}:`)) return undefined
  const image = parseScreenshotImage(record.image)
  return image ? {
    type: 'recognize', sessionId, generation, image, tier: record.tier, cacheKey: record.cacheKey,
  } : undefined
}

function parseTranslatedBlocks(value: unknown): readonly ScreenshotTranslatedBlock[] | undefined {
  if (!isDenseArray(value) || value.length > SCREENSHOT_OCR_BLOCK_LIMIT) return undefined
  const translations: ScreenshotTranslatedBlock[] = []
  const ids = new Set<string>()
  let totalLength = 0
  let totalBytes = 0
  for (const candidate of value) {
    if (!isExactOwnRecord(candidate, ['id', 'text'])) return undefined
    const id = parseLineId(candidate.id)?.id
    if (!id || ids.has(id) || !isCanonicalText(candidate.text, SCREENSHOT_TRANSLATED_TEXT_MAX_LENGTH)) return undefined
    totalLength += candidate.text.length
    totalBytes += new TextEncoder().encode(candidate.text).byteLength
    if (totalLength > SCREENSHOT_TRANSLATED_TEXT_TOTAL_MAX_LENGTH
      || totalBytes > SCREENSHOT_TRANSLATED_TEXT_TOTAL_MAX_BYTES) return undefined
    ids.add(id)
    translations.push({ id, text: candidate.text })
  }
  return translations
}

export function parseScreenshotTranslationEvent(value: unknown): ScreenshotTranslationEvent | undefined {
  if (!isExactOwnRecord(value, ['sessionId', 'generation', 'type']) && (typeof value !== 'object' || value === null || Array.isArray(value))) return undefined
  const record = value as Record<string, unknown>
  const sessionId = parseScreenshotSessionId(record.sessionId)
  const generation = parseGeneration(record.generation)
  if (!sessionId || !generation || typeof record.type !== 'string') return undefined
  if (record.type === 'snapshot-ready') {
    if (!isExactOwnRecord(record, ['sessionId', 'generation', 'type', 'image', 'tier'])
      || (record.tier !== 'small' && record.tier !== 'medium')) return undefined
    const image = parseScreenshotImage(record.image)
    return image ? { sessionId, generation, type: 'snapshot-ready', image, tier: record.tier } : undefined
  }
  if (record.type === 'ocr-started') {
    if (!isExactOwnRecord(record, ['sessionId', 'generation', 'type', 'tier'])
      || (record.tier !== 'small' && record.tier !== 'medium')) return undefined
    return { sessionId, generation, type: 'ocr-started', tier: record.tier }
  }
  if (record.type === 'translation-started' || record.type === 'translation-cancelled') {
    if (!isExactOwnRecord(record, ['sessionId', 'generation', 'type'])) return undefined
    return { sessionId, generation, type: record.type }
  }
  if (record.type === 'ocr-completed') {
    if (!isExactOwnRecord(record, ['sessionId', 'generation', 'type', 'blocks'])) return undefined
    const blocks = parseScreenshotOcrBlocks(record.blocks)
    return blocks ? { sessionId, generation, type: 'ocr-completed', blocks } : undefined
  }
  if (record.type === 'translation-completed') {
    if (!isExactOwnRecord(record, ['sessionId', 'generation', 'type', 'translations'])) return undefined
    const translations = parseTranslatedBlocks(record.translations)
    return translations ? { sessionId, generation, type: 'translation-completed', translations } : undefined
  }
  if (record.type === 'document-translation-progress') {
    if (!isExactOwnRecord(record, [
      'sessionId', 'generation', 'type', 'text', 'completedChunks', 'totalChunks',
    ])
      || !isCanonicalDocumentText(record.text)
      || typeof record.completedChunks !== 'number'
      || !Number.isSafeInteger(record.completedChunks)
      || record.completedChunks < 0
      || typeof record.totalChunks !== 'number'
      || !Number.isSafeInteger(record.totalChunks)
      || record.totalChunks <= 0
      || record.completedChunks >= record.totalChunks) return undefined
    return {
      sessionId,
      generation,
      type: 'document-translation-progress',
      text: record.text,
      completedChunks: record.completedChunks,
      totalChunks: record.totalChunks,
    }
  }
  if (record.type === 'document-translation-completed') {
    if (!isExactOwnRecord(record, ['sessionId', 'generation', 'type', 'text'])
      || !isCanonicalDocumentText(record.text)) return undefined
    return { sessionId, generation, type: 'document-translation-completed', text: record.text }
  }
  if (record.type !== 'failed' || !isExactOwnRecord(record, ['sessionId', 'generation', 'type', 'stage', 'code'])) return undefined
  const codesByStage = {
    capture: ['CAPTURE_UNAVAILABLE', 'CAPTURE_EMPTY'],
    ocr: ['OCR_UNAVAILABLE', 'OCR_LANGUAGE_UNAVAILABLE', 'OCR_TIMEOUT', 'OCR_FAILED'],
    translation: ['MODEL_NOT_CONFIGURED', 'MODEL_TIMEOUT', 'MODEL_AUTHENTICATION_FAILED',
      'MODEL_NOT_FOUND', 'MODEL_UNAVAILABLE', 'MODEL_RATE_LIMITED', 'MODEL_QUOTA_EXCEEDED',
      'MODEL_RESPONSE_INVALID', 'TRANSLATION_FAILED'],
  } as const
  if ((record.stage !== 'capture' && record.stage !== 'ocr' && record.stage !== 'translation')
    || typeof record.code !== 'string'
    || !codesByStage[record.stage].includes(record.code as never)) return undefined
  return { sessionId, generation, type: 'failed', stage: record.stage, code: record.code as ScreenshotPublicErrorCode }
}

/** Strict event boundary for the untrusted selection overlay. */
export function parseScreenshotCaptureEvent(value: unknown): ScreenshotCaptureEvent | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const sessionId = parseScreenshotSessionId(record.sessionId)
  if (!sessionId || typeof record.type !== 'string') return undefined
  if (record.type === 'selection-ready') {
    if (!isExactOwnRecord(record, ['sessionId', 'type', 'display'])) return undefined
    const display = parseCaptureDisplaySnapshot(record.display)
    return display ? { sessionId, type: 'selection-ready', display } : undefined
  }
  if (record.type === 'window-highlight') {
    if (!isExactOwnRecord(record, ['sessionId', 'type', 'displayId', 'hit'])) return undefined
    const displayId = parseDisplayId(record.displayId)
    if (!displayId) return undefined
    const hit = parseScreenshotWindowHighlightResult(record.hit)
    return hit !== undefined ? { sessionId, type: 'window-highlight', displayId, hit } : undefined
  }
  if (record.type === 'committing' || record.type === 'cancelled') {
    return isExactOwnRecord(record, ['sessionId', 'type'])
      ? { sessionId, type: record.type }
      : undefined
  }
  if (record.type === 'failed'
    && isExactOwnRecord(record, ['sessionId', 'type', 'code'])
    && (record.code === 'CAPTURE_UNAVAILABLE' || record.code === 'CAPTURE_EMPTY')) {
    return { sessionId, type: 'failed', code: record.code }
  }
  return undefined
}

export function parseScreenshotCapturePointerInput(value: unknown): ScreenshotCapturePointerInput | undefined {
  if (!isExactOwnRecord(value, ['sessionId', 'displayId', 'screenPointDip'])) return undefined
  const sessionId = parseScreenshotSessionId(value.sessionId)
  const displayId = parseDisplayId(value.displayId)
  const screenPointDip = parseDipPoint(value.screenPointDip)
  return sessionId && displayId && screenPointDip ? { sessionId, displayId, screenPointDip } : undefined
}

export function parseScreenshotCaptureReadyInput(value: unknown): ScreenshotCaptureReadyInput | undefined {
  if (!isExactOwnRecord(value, ['sessionId', 'displayId'])) return undefined
  const sessionId = parseScreenshotSessionId(value.sessionId)
  const displayId = parseDisplayId(value.displayId)
  return sessionId && displayId ? { sessionId, displayId } : undefined
}

export function parseScreenshotCaptureCommitInput(value: unknown): ScreenshotCaptureCommitInput | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const sessionId = parseScreenshotSessionId(record.sessionId)
  const displayId = parseDisplayId(record.displayId)
  const rectDip = parseDipRect(record.rectDip)
  if (!sessionId || !displayId || !rectDip) return undefined
  if (record.kind === 'region' && isExactOwnRecord(record, ['sessionId', 'displayId', 'kind', 'rectDip'])) {
    return { sessionId, displayId, kind: 'region', rectDip }
  }
  const processId = parseGeneration(record.processId)
  if (record.kind !== 'window' || !isExactOwnRecord(record, ['sessionId', 'displayId', 'kind', 'rectDip', 'processId'])
    || !processId) return undefined
  return { sessionId, displayId, kind: 'window', rectDip, processId }
}

export function parseScreenshotSessionInput(value: unknown): ScreenshotSessionInput | undefined {
  if (!isExactOwnRecord(value, ['sessionId'])) return undefined
  const sessionId = parseScreenshotSessionId(value.sessionId)
  return sessionId ? { sessionId } : undefined
}

export function parseScreenshotTranslationGenerationInput(value: unknown): ScreenshotTranslationGenerationInput | undefined {
  if (!isExactOwnRecord(value, ['sessionId', 'generation'])) return undefined
  const sessionId = parseScreenshotSessionId(value.sessionId)
  const generation = parseGeneration(value.generation)
  return sessionId && generation ? { sessionId, generation } : undefined
}

export function clipRectToBounds(rect: ScreenshotRect, bounds: ScreenshotRect): ScreenshotRect | undefined {
  const values = [rect.x, rect.y, rect.width, rect.height, bounds.x, bounds.y, bounds.width, bounds.height]
  if (!values.every(isFiniteDip) || bounds.width === 0 || bounds.height === 0) return undefined
  const rectLeft = Math.min(rect.x, rect.x + rect.width)
  const rectTop = Math.min(rect.y, rect.y + rect.height)
  const rectRight = Math.max(rect.x, rect.x + rect.width)
  const rectBottom = Math.max(rect.y, rect.y + rect.height)
  const boundsLeft = Math.min(bounds.x, bounds.x + bounds.width)
  const boundsTop = Math.min(bounds.y, bounds.y + bounds.height)
  const boundsRight = Math.max(bounds.x, bounds.x + bounds.width)
  const boundsBottom = Math.max(bounds.y, bounds.y + bounds.height)
  const left = Math.max(rectLeft, boundsLeft)
  const top = Math.max(rectTop, boundsTop)
  const right = Math.min(rectRight, boundsRight)
  const bottom = Math.min(rectBottom, boundsBottom)
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : undefined
}

export function cropDipToPixels(
  rectDip: ScreenshotRect,
  display: Pick<CaptureDisplaySnapshot, 'boundsDip' | 'scaleFactor' | 'imageSizePx'>,
): ScreenshotRect | undefined {
  const boundsDip = parseDipRect(display.boundsDip)
  const imageSizePx = parsePixelSize(display.imageSizePx)
  if (!boundsDip || !imageSizePx || typeof display.scaleFactor !== 'number'
    || !Number.isFinite(display.scaleFactor)
    || display.scaleFactor < 0.5
    || display.scaleFactor > 8) return undefined
  const clipped = clipRectToBounds(rectDip, boundsDip)
  if (!clipped) return undefined
  const left = Math.max(0, Math.min(imageSizePx.width, Math.floor((clipped.x - boundsDip.x) * display.scaleFactor)))
  const top = Math.max(0, Math.min(imageSizePx.height, Math.floor((clipped.y - boundsDip.y) * display.scaleFactor)))
  const right = Math.max(0, Math.min(imageSizePx.width, Math.ceil((clipped.x + clipped.width - boundsDip.x) * display.scaleFactor)))
  const bottom = Math.max(0, Math.min(imageSizePx.height, Math.ceil((clipped.y + clipped.height - boundsDip.y) * display.scaleFactor)))
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : undefined
}
