import { PaddleOCR, type OcrResult } from '@paddleocr/paddleocr-js'
import { SCREENSHOT_OCR_RESOURCE_URLS } from '../../shared/screenshot-ocr-manifest'

export interface ScreenshotPaddleOcrOptions {
  lang: 'ch'
  ocrVersion: 'PP-OCRv6'
  textDetectionModelName: 'PP-OCRv6_small_det' | 'PP-OCRv6_medium_det'
  textDetectionModelAsset: { url: string }
  textRecognitionModelName: 'PP-OCRv6_small_rec' | 'PP-OCRv6_medium_rec'
  textRecognitionModelAsset: { url: string }
  ortOptions: {
    backend: 'wasm'
    wasmPaths: string
    numThreads: 1
    simd: true
    proxy: false
  }
}

export interface DirectScreenshotPaddleOcr {
  initialize(): Promise<unknown>
  predict(input: ImageBitmap): Promise<OcrResult[]>
  dispose(): Promise<void>
}

export interface PaddleOcrConstructor {
  readonly name: string
  readonly prototype: object
  create(options: ScreenshotPaddleOcrOptions & { initialize: false }): Promise<unknown>
}

export class ScreenshotOcrSdkCompatibilityError extends Error {
  constructor() { super('OCR_SDK_INCOMPATIBLE'); this.name = 'ScreenshotOcrSdkCompatibilityError' }
}

function fail(): never { throw new ScreenshotOcrSdkCompatibilityError() }

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  const own = Reflect.ownKeys(value)
  return own.length === keys.length
    && own.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.hasOwn(value, key))
}

function validateOptions(options: ScreenshotPaddleOcrOptions): void {
  if (!exactRecord(options, [
    'lang', 'ocrVersion', 'textDetectionModelName', 'textDetectionModelAsset',
    'textRecognitionModelName', 'textRecognitionModelAsset', 'ortOptions',
  ])
    || options.lang !== 'ch'
    || options.ocrVersion !== 'PP-OCRv6'
    || !exactRecord(options.textDetectionModelAsset, ['url'])
    || !exactRecord(options.textRecognitionModelAsset, ['url'])
    || !exactRecord(options.ortOptions, ['backend', 'wasmPaths', 'numThreads', 'simd', 'proxy'])
    || options.ortOptions.backend !== 'wasm'
    || options.ortOptions.wasmPaths !== SCREENSHOT_OCR_RESOURCE_URLS.ortPrefix
    || options.ortOptions.numThreads !== 1
    || options.ortOptions.simd !== true
    || options.ortOptions.proxy !== false) fail()
  const small = options.textDetectionModelName === 'PP-OCRv6_small_det'
    && options.textDetectionModelAsset.url === SCREENSHOT_OCR_RESOURCE_URLS.smallDetection
    && options.textRecognitionModelName === 'PP-OCRv6_small_rec'
    && options.textRecognitionModelAsset.url === SCREENSHOT_OCR_RESOURCE_URLS.smallRecognition
  const medium = options.textDetectionModelName === 'PP-OCRv6_medium_det'
    && options.textDetectionModelAsset.url === SCREENSHOT_OCR_RESOURCE_URLS.mediumDetection
    && options.textRecognitionModelName === 'PP-OCRv6_medium_rec'
    && options.textRecognitionModelAsset.url === SCREENSHOT_OCR_RESOURCE_URLS.mediumRecognition
  if (!small && !medium) fail()
}

function isDirectPipeline(value: unknown): value is DirectScreenshotPaddleOcr & Record<string, unknown> {
  return typeof value === 'object' && value !== null
    && typeof (value as DirectScreenshotPaddleOcr).initialize === 'function'
    && typeof (value as DirectScreenshotPaddleOcr).predict === 'function'
    && typeof (value as DirectScreenshotPaddleOcr).dispose === 'function'
}

function workerSourceToMat(cvValue: unknown, source: unknown): {
  width: number
  height: number
  mat: unknown
  dispose(): void
} {
  if (typeof ImageBitmap !== 'function' || !(source instanceof ImageBitmap)
    || typeof OffscreenCanvas !== 'function') fail()
  const cv = cvValue as {
    CV_8UC4?: unknown
    matFromArray?(rows: number, columns: number, type: unknown, data: Uint8ClampedArray): unknown
  }
  if (typeof cv.matFromArray !== 'function') fail()
  const canvas = new OffscreenCanvas(source.width, source.height)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) fail()
  context.drawImage(source, 0, 0)
  const imageData = context.getImageData(0, 0, source.width, source.height)
  const mat = cv.matFromArray(imageData.height, imageData.width, cv.CV_8UC4, imageData.data)
  if (typeof mat !== 'object' || mat === null
    || typeof (mat as { delete?: unknown }).delete !== 'function') fail()
  return {
    width: imageData.width,
    height: imageData.height,
    mat,
    dispose: () => { (mat as { delete(): void }).delete() },
  }
}

export async function createFileCompatiblePaddleOcr(
  options: ScreenshotPaddleOcrOptions,
  paddleOcr: PaddleOcrConstructor = PaddleOCR as unknown as PaddleOcrConstructor,
): Promise<DirectScreenshotPaddleOcr> {
  validateOptions(options)
  let candidate: unknown
  try { candidate = await paddleOcr.create({ ...options, initialize: false }) } catch { return fail() }
  if (!isDirectPipeline(candidate) || (candidate as object).constructor !== paddleOcr as unknown as Function) fail()
  const guard = Object.getOwnPropertyDescriptor(candidate, 'ensureServedFromHttp')
  if (!guard || typeof guard.value !== 'function' || guard.value.length !== 0
    || guard.writable !== true || guard.enumerable !== true
    || guard.configurable !== true || Object.hasOwn(guard, 'get') || Object.hasOwn(guard, 'set')) fail()
  const sourceAdapter = Object.getOwnPropertyDescriptor(candidate, 'sourceToMat')
  if (!sourceAdapter || typeof sourceAdapter.value !== 'function' || sourceAdapter.value.length !== 2
    || sourceAdapter.writable !== true || sourceAdapter.enumerable !== true
    || sourceAdapter.configurable !== true || Object.hasOwn(sourceAdapter, 'get') || Object.hasOwn(sourceAdapter, 'set')) fail()
  Object.defineProperty(candidate, 'ensureServedFromHttp', { ...guard, value: () => undefined })
  Object.defineProperty(candidate, 'sourceToMat', { ...sourceAdapter, value: workerSourceToMat })
  try {
    await candidate.initialize()
  } catch {
    try { await candidate.dispose() } catch { /* initialization failure remains fixed and fail-closed */ }
    return fail()
  }
  return candidate
}
