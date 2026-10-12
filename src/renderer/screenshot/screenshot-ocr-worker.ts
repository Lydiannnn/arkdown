import { PaddleOCR } from '@paddleocr/paddleocr-js'
import { parseScreenshotSessionId } from '../../shared/screenshot-translation'
import { SCREENSHOT_OCR_RESOURCE_URLS } from '../../shared/screenshot-ocr-manifest'
import {
  ScreenshotOcrMappingError,
  type ScreenshotOcrMappingFailureCode,
  mapPaddleOcrResult,
  planScreenshotOcrPreparation,
} from './screenshot-ocr-mapping'
import {
  createFileCompatiblePaddleOcr,
  type DirectScreenshotPaddleOcr,
  type PaddleOcrConstructor,
  type ScreenshotPaddleOcrOptions,
} from './screenshot-ocr-sdk-compat'

type DirectPaddleOcr = DirectScreenshotPaddleOcr

interface OcrWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  postMessage(value: unknown): void
}

type WorkerFailureCode = 'OCR_UNAVAILABLE' | 'OCR_TIMEOUT' | 'OCR_FAILED'
type WorkerDiagnosticCode =
  | 'DECODE_IMAGE_FAILED'
  | 'PREPARE_IMAGE_FAILED'
  | 'SDK_INITIALIZE_FAILED'
  | 'SDK_PREDICT_FAILED'
  | 'SDK_RESULT_INVALID'
  | 'RESULT_MAPPING_FAILED'
  | ScreenshotOcrMappingFailureCode

interface RequestIdentity { requestId: number; sessionId: string; generation: number }

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const own = Reflect.ownKeys(value)
  return own.length === keys.length
    && own.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.hasOwn(value, key))
}

function positiveSafe(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function identity(value: unknown): RequestIdentity | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const sessionId = parseScreenshotSessionId(record.sessionId)
  return positiveSafe(record.requestId) && positiveSafe(record.generation) && sessionId
    ? { requestId: record.requestId, sessionId, generation: record.generation }
    : undefined
}

function validRequest(value: unknown): value is Record<string, unknown> & RequestIdentity & {
  type: 'recognize'; tier: 'small' | 'medium'; image: { width: number; height: number; bytes: ArrayBuffer }
} {
  if (!exactRecord(value, ['type', 'requestId', 'sessionId', 'generation', 'image', 'tier'])
    || value.type !== 'recognize' || (value.tier !== 'small' && value.tier !== 'medium') || !identity(value)
    || !exactRecord(value.image, ['width', 'height', 'bytes'])
    || !positiveSafe(value.image.width) || !positiveSafe(value.image.height)
    || !(value.image.bytes instanceof ArrayBuffer) || value.image.bytes.byteLength === 0) return false
  try { planScreenshotOcrPreparation({ width: value.image.width, height: value.image.height }) } catch { return false }
  return true
}

const pipelinePromises = new Map<'small' | 'medium', Promise<DirectPaddleOcr>>()
let busy = false

function pipeline(tier: 'small' | 'medium'): Promise<DirectPaddleOcr> {
  let pipelinePromise = pipelinePromises.get(tier)
  if (!pipelinePromise) {
    const medium = tier === 'medium'
    const options: ScreenshotPaddleOcrOptions = {
      lang: 'ch',
      ocrVersion: 'PP-OCRv6',
      textDetectionModelName: medium ? 'PP-OCRv6_medium_det' : 'PP-OCRv6_small_det',
      textDetectionModelAsset: { url: medium ? SCREENSHOT_OCR_RESOURCE_URLS.mediumDetection : SCREENSHOT_OCR_RESOURCE_URLS.smallDetection },
      textRecognitionModelName: medium ? 'PP-OCRv6_medium_rec' : 'PP-OCRv6_small_rec',
      textRecognitionModelAsset: { url: medium ? SCREENSHOT_OCR_RESOURCE_URLS.mediumRecognition : SCREENSHOT_OCR_RESOURCE_URLS.smallRecognition },
      ortOptions: {
        backend: 'wasm',
        wasmPaths: SCREENSHOT_OCR_RESOURCE_URLS.ortPrefix,
        numThreads: 1,
        simd: true,
        proxy: false,
      },
    }
    pipelinePromise = createFileCompatiblePaddleOcr(options, PaddleOCR as unknown as PaddleOcrConstructor).catch(() => {
      pipelinePromises.delete(tier)
      throw new Error('OCR_UNAVAILABLE')
    })
    pipelinePromises.set(tier, pipelinePromise)
  }
  return pipelinePromise
}

function safePost(scope: OcrWorkerScope, value: unknown): void {
  try { scope.postMessage(value) } catch { /* transport failure terminates at the client boundary */ }
}

function failure(scope: OcrWorkerScope, id: RequestIdentity, code: WorkerFailureCode): void {
  safePost(scope, { type: 'result', ...id, ok: false, code })
}

function diagnostic(scope: OcrWorkerScope, code: WorkerDiagnosticCode): void {
  safePost(scope, { type: 'diagnostic', code })
}

async function preparedBitmap(
  source: ImageBitmap,
  preparation: ReturnType<typeof planScreenshotOcrPreparation>,
): Promise<ImageBitmap> {
  if (preparation.scale === 1 && preparation.paddingPx === 0) return source
  const canvas = new OffscreenCanvas(preparation.preparedWidth, preparation.preparedHeight)
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new ScreenshotOcrMappingError()
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, preparation.preparedWidth, preparation.preparedHeight)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(
    source,
    preparation.paddingPx * preparation.scale,
    preparation.paddingPx * preparation.scale,
    preparation.originalWidth * preparation.scale,
    preparation.originalHeight * preparation.scale,
  )
  return canvas.transferToImageBitmap()
}

const scope = self as unknown as OcrWorkerScope
scope.onmessage = (event: MessageEvent<unknown>) => {
  const id = identity(event.data)
  if (!id) return
  if (!validRequest(event.data) || busy) { failure(scope, id, 'OCR_FAILED'); return }
  const request = event.data
  busy = true
  void (async () => {
    let source: ImageBitmap | undefined
    let prepared: ImageBitmap | undefined
    let phase: WorkerDiagnosticCode = 'DECODE_IMAGE_FAILED'
    try {
      const plan = planScreenshotOcrPreparation({ width: request.image.width, height: request.image.height })
      source = await createImageBitmap(new Blob([request.image.bytes], { type: 'image/png' }))
      if (source.width !== plan.originalWidth || source.height !== plan.originalHeight) throw new ScreenshotOcrMappingError()
      phase = 'PREPARE_IMAGE_FAILED'
      prepared = await preparedBitmap(source, plan)
      phase = 'SDK_INITIALIZE_FAILED'
      const sdk = await pipeline(request.tier)
      phase = 'SDK_PREDICT_FAILED'
      const results = await sdk.predict(prepared)
      phase = 'SDK_RESULT_INVALID'
      if (!Array.isArray(results) || results.length !== 1) throw new ScreenshotOcrMappingError()
      phase = 'RESULT_MAPPING_FAILED'
      const result = mapPaddleOcrResult(results[0], plan)
      safePost(scope, { type: 'result', ...id, ok: true, result })
    } catch (error) {
      diagnostic(scope, error instanceof ScreenshotOcrMappingError ? error.code : phase)
      failure(scope, id, error instanceof Error && error.message === 'OCR_UNAVAILABLE' ? 'OCR_UNAVAILABLE' : 'OCR_FAILED')
    } finally {
      if (prepared && prepared !== source) prepared.close()
      source?.close()
      busy = false
    }
  })()
}
