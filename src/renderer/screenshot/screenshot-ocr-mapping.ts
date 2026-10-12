import {
  SCREENSHOT_IMAGE_MAX_DIMENSION_PX,
  SCREENSHOT_IMAGE_MAX_PIXELS,
  SCREENSHOT_OCR_BLOCK_LIMIT,
  SCREENSHOT_OCR_BLOCK_TEXT_MAX_LENGTH,
  type ScreenshotOcrBlock,
  type ScreenshotOcrResult,
  type ScreenshotSize,
} from '../../shared/screenshot-translation'

export const SCREENSHOT_OCR_MIN_SHORT_SIDE_PX = 80
export const SCREENSHOT_OCR_MAX_UPSCALE = 4
export const SCREENSHOT_OCR_PADDING_PX = 2
export const SCREENSHOT_OCR_MIN_SCORE = 0.5
export const SCREENSHOT_OCR_MAX_LONG_SIDE_PX = 2_560
export const SCREENSHOT_OCR_MAX_WORKING_PIXELS = 4_000_000
export const SCREENSHOT_OCR_PREFERRED_SCALE = 1.5

export interface ScreenshotOcrPreparation {
  originalWidth: number
  originalHeight: number
  preparedWidth: number
  preparedHeight: number
  scale: number
  paddingPx: number
}

export type ScreenshotOcrMappingFailureCode =
  | 'PREPARATION_INVALID'
  | 'RESULT_SHAPE_INVALID'
  | 'RESULT_IMAGE_INVALID'
  | 'RESULT_ITEMS_INVALID'
  | 'RESULT_METRICS_INVALID'
  | 'RESULT_RUNTIME_INVALID'
  | 'ITEM_INVALID'
  | 'GEOMETRY_INVALID'

export class ScreenshotOcrMappingError extends Error {
  readonly code: ScreenshotOcrMappingFailureCode
  constructor(code: ScreenshotOcrMappingFailureCode = 'RESULT_SHAPE_INVALID') {
    super('OCR_MAPPING_FAILED')
    this.name = 'ScreenshotOcrMappingError'
    this.code = code
  }
}

function fail(code: ScreenshotOcrMappingFailureCode): never { throw new ScreenshotOcrMappingError(code) }

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const own = Reflect.ownKeys(value)
  return own.length === keys.length
    && own.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.hasOwn(value, key))
}

function dense(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false
  const keys = Reflect.ownKeys(value)
  return keys.length === value.length + 1
    && keys.includes('length')
    && keys.every((key) => key === 'length' || (
      typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length
    ))
}

function safeDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value > 0 && value <= SCREENSHOT_IMAGE_MAX_DIMENSION_PX
}

export function planScreenshotOcrPreparation(size: ScreenshotSize): ScreenshotOcrPreparation {
  if (!safeDimension(size.width) || !safeDimension(size.height)
    || size.width * size.height > SCREENSHOT_IMAGE_MAX_PIXELS) fail('PREPARATION_INVALID')
  const shortSide = Math.min(size.width, size.height)
  if (shortSide >= SCREENSHOT_OCR_MIN_SHORT_SIDE_PX) {
    const scale = Math.min(
      SCREENSHOT_OCR_PREFERRED_SCALE,
      SCREENSHOT_OCR_MAX_LONG_SIDE_PX / Math.max(size.width, size.height),
      Math.sqrt(SCREENSHOT_OCR_MAX_WORKING_PIXELS / (size.width * size.height)),
    )
    const preparedWidth = Math.max(1, Math.floor(size.width * scale))
    const preparedHeight = Math.max(1, Math.floor(size.height * scale))
    return {
      originalWidth: size.width,
      originalHeight: size.height,
      preparedWidth,
      preparedHeight,
      scale,
      paddingPx: 0,
    }
  }
  const scale = Math.min(SCREENSHOT_OCR_MAX_UPSCALE, SCREENSHOT_OCR_MIN_SHORT_SIDE_PX / shortSide)
  const paddingPx = SCREENSHOT_OCR_PADDING_PX
  const preparedWidth = Math.ceil((size.width + paddingPx * 2) * scale)
  const preparedHeight = Math.ceil((size.height + paddingPx * 2) * scale)
  if (!safeDimension(preparedWidth) || !safeDimension(preparedHeight)
    || preparedWidth * preparedHeight > SCREENSHOT_IMAGE_MAX_PIXELS) fail('PREPARATION_INVALID')
  return { originalWidth: size.width, originalHeight: size.height, preparedWidth, preparedHeight, scale, paddingPx }
}

function canonicalText(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0
    || value.length > SCREENSHOT_OCR_BLOCK_TEXT_MAX_LENGTH
    || value.normalize('NFC') !== value
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function safeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function canonicalRuntimeName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
    && value.normalize('NFC') === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}

function validPreparation(value: ScreenshotOcrPreparation): boolean {
  return safeDimension(value.originalWidth) && safeDimension(value.originalHeight)
    && safeDimension(value.preparedWidth) && safeDimension(value.preparedHeight)
    && typeof value.scale === 'number' && Number.isFinite(value.scale)
    && value.scale > 0 && value.scale <= SCREENSHOT_OCR_MAX_UPSCALE
    && Number.isSafeInteger(value.paddingPx) && value.paddingPx >= 0 && value.paddingPx <= 64
    && value.preparedWidth === (value.paddingPx === 0
      ? Math.max(1, Math.floor(value.originalWidth * value.scale))
      : Math.ceil((value.originalWidth + value.paddingPx * 2) * value.scale))
    && value.preparedHeight === (value.paddingPx === 0
      ? Math.max(1, Math.floor(value.originalHeight * value.scale))
      : Math.ceil((value.originalHeight + value.paddingPx * 2) * value.scale))
}

interface MappedCandidate { text: string; score: number; left: number; top: number; right: number; bottom: number }

function parseItem(value: unknown, preparation: ScreenshotOcrPreparation): MappedCandidate {
  if (!exactRecord(value, ['poly', 'text', 'score']) || !dense(value.poly)
    || value.poly.length < 4 || value.poly.length > 32
    || !canonicalText(value.text)
    || typeof value.score !== 'number' || !Number.isFinite(value.score)
    || value.score < 0 || value.score > 1) fail('ITEM_INVALID')
  let preparedLeft = Number.POSITIVE_INFINITY
  let preparedTop = Number.POSITIVE_INFINITY
  let preparedRight = Number.NEGATIVE_INFINITY
  let preparedBottom = Number.NEGATIVE_INFINITY
  for (const point of value.poly) {
    if (!dense(point) || point.length !== 2
      || typeof point[0] !== 'number' || !Number.isFinite(point[0])
      || typeof point[1] !== 'number' || !Number.isFinite(point[1])
      || Math.abs(point[0]) > SCREENSHOT_IMAGE_MAX_DIMENSION_PX * SCREENSHOT_OCR_MAX_UPSCALE
      || Math.abs(point[1]) > SCREENSHOT_IMAGE_MAX_DIMENSION_PX * SCREENSHOT_OCR_MAX_UPSCALE) fail('ITEM_INVALID')
    preparedLeft = Math.min(preparedLeft, point[0])
    preparedTop = Math.min(preparedTop, point[1])
    preparedRight = Math.max(preparedRight, point[0])
    preparedBottom = Math.max(preparedBottom, point[1])
  }
  if (preparedRight <= preparedLeft || preparedBottom <= preparedTop) fail('GEOMETRY_INVALID')
  const inverse = (coordinate: number) => coordinate / preparation.scale - preparation.paddingPx
  const left = Math.max(0, Math.floor(inverse(preparedLeft)))
  const top = Math.max(0, Math.floor(inverse(preparedTop)))
  const right = Math.min(preparation.originalWidth, Math.ceil(inverse(preparedRight)))
  const bottom = Math.min(preparation.originalHeight, Math.ceil(inverse(preparedBottom)))
  if (right <= left || bottom <= top) fail('GEOMETRY_INVALID')
  return { text: value.text, score: value.score, left, top, right, bottom }
}

export function mapPaddleOcrResult(value: unknown, preparation: ScreenshotOcrPreparation): ScreenshotOcrResult {
  if (!validPreparation(preparation)) fail('PREPARATION_INVALID')
  if (!exactRecord(value, ['image', 'items', 'metrics', 'runtime'])) fail('RESULT_SHAPE_INVALID')
  if (!exactRecord(value.image, ['width', 'height'])
    || value.image.width !== preparation.preparedWidth
    || value.image.height !== preparation.preparedHeight) fail('RESULT_IMAGE_INVALID')
  if (!dense(value.items) || value.items.length > SCREENSHOT_OCR_BLOCK_LIMIT) fail('RESULT_ITEMS_INVALID')
  if (!exactRecord(value.metrics, ['detMs', 'recMs', 'totalMs', 'detectedBoxes', 'recognizedCount'])
    || !finiteNonNegative(value.metrics.detMs)
    || !finiteNonNegative(value.metrics.recMs)
    || !finiteNonNegative(value.metrics.totalMs)
    || !safeCount(value.metrics.detectedBoxes)
    || !safeCount(value.metrics.recognizedCount)) fail('RESULT_METRICS_INVALID')
  if (!exactRecord(value.runtime, ['requestedBackend', 'detProvider', 'recProvider', 'webgpuAvailable'])
    || !canonicalRuntimeName(value.runtime.requestedBackend)
    || !canonicalRuntimeName(value.runtime.detProvider)
    || !canonicalRuntimeName(value.runtime.recProvider)
    || typeof value.runtime.webgpuAvailable !== 'boolean') fail('RESULT_RUNTIME_INVALID')

  const retained: MappedCandidate[] = []
  for (const item of value.items) {
    const candidate = parseItem(item, preparation)
    if (candidate.text.trim().length === 0 || candidate.score < SCREENSHOT_OCR_MIN_SCORE) continue
    retained.push(candidate)
  }
  retained.sort((first, second) => first.top - second.top || first.left - second.left
    || first.bottom - second.bottom || first.right - second.right || first.text.localeCompare(second.text))
  const blocks: ScreenshotOcrBlock[] = retained.map((item, index) => {
    const rectPx = { x: item.left, y: item.top, width: item.right - item.left, height: item.bottom - item.top }
    return { id: `line-${index + 1}`, text: item.text, rectPx, words: [{ text: item.text, rectPx: { ...rectPx } }] }
  })
  return { width: preparation.originalWidth, height: preparation.originalHeight, language: 'mul', blocks }
}
