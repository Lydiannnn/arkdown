import {
  SCREENSHOT_IMAGE_DATA_URL_MAX_BYTES,
  parseScreenshotOcrResult,
  parseScreenshotTranslationEvent,
  type ScreenshotImage,
  type ScreenshotOcrResult,
} from '../../shared/screenshot-translation'
import type { ScreenshotOcrTier } from '../../shared/screenshot-ocr-models'

export type ScreenshotOcrClientErrorCode = 'OCR_UNAVAILABLE' | 'OCR_TIMEOUT' | 'OCR_FAILED' | 'OCR_CANCELLED'

export class ScreenshotOcrClientError extends Error {
  readonly code: ScreenshotOcrClientErrorCode
  constructor(code: ScreenshotOcrClientErrorCode) { super(code); this.name = 'ScreenshotOcrClientError'; this.code = code }
}

interface WorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null
  postMessage(message: unknown, transfer: Transferable[]): void
  terminate(): void
}

export interface ScreenshotOcrClientDependencies {
  createWorker?: () => Worker
  encodeImage?: (image: ScreenshotImage) => Promise<ArrayBuffer>
}

export interface ScreenshotOcrRecognizeInput {
  sessionId: string
  generation: number
  image: ScreenshotImage
  tier: ScreenshotOcrTier
  signal?: AbortSignal
}

export interface ScreenshotOcrClient {
  recognize(input: ScreenshotOcrRecognizeInput): Promise<ScreenshotOcrResult>
  stop(): void
  dispose(): void
}

const VALIDATION_EVENT = (input: ScreenshotOcrRecognizeInput) => parseScreenshotTranslationEvent({
  sessionId: input.sessionId, generation: input.generation, type: 'snapshot-ready', image: input.image, tier: input.tier,
})

async function defaultEncodeImage(image: ScreenshotImage): Promise<ArrayBuffer> {
  const prefix = 'data:image/png;base64,'
  if (!image.dataUrl.startsWith(prefix)) throw new ScreenshotOcrClientError('OCR_FAILED')
  const encoded = image.dataUrl.slice(prefix.length)
  let binary = atob(encoded)
  if (binary.length < 24 || binary.length > SCREENSHOT_IMAGE_DATA_URL_MAX_BYTES) {
    throw new ScreenshotOcrClientError('OCR_FAILED')
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  binary = ''
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (!signature.every((byte, index) => bytes[index] === byte)
    || new DataView(bytes.buffer).getUint32(8) !== 13
    || bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) {
    throw new ScreenshotOcrClientError('OCR_FAILED')
  }
  const view = new DataView(bytes.buffer)
  if (view.getUint32(16) !== image.width || view.getUint32(20) !== image.height) {
    throw new ScreenshotOcrClientError('OCR_FAILED')
  }
  return bytes.buffer
}

function createDefaultWorker(): Worker {
  return new Worker(new URL('./screenshot-ocr-bootstrap-worker.ts', import.meta.url), { type: 'module', name: 'arkdown-screenshot-ocr' })
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const own = Reflect.ownKeys(value)
  return own.length === keys.length
    && own.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.hasOwn(value, key))
}

export function createScreenshotOcrClient(dependencies: ScreenshotOcrClientDependencies = {}): ScreenshotOcrClient {
  const createWorker = dependencies.createWorker ?? createDefaultWorker
  const encodeImage = dependencies.encodeImage ?? defaultEncodeImage
  let worker: WorkerLike | undefined
  let nextRequestId = 1
  let disposed = false
  let active: {
    requestId?: number
    sessionId: string
    generation: number
    resolve(value: ScreenshotOcrResult): void
    reject(error: ScreenshotOcrClientError): void
    removeAbort(): void
  } | undefined

  const stopWorker = (): void => {
    if (!worker) return
    worker.onmessage = null
    worker.onerror = null
    worker.onmessageerror = null
    worker.terminate()
    worker = undefined
  }
  const rejectActive = (code: ScreenshotOcrClientErrorCode, terminate: boolean): void => {
    const pending = active
    active = undefined
    pending?.removeAbort()
    pending?.reject(new ScreenshotOcrClientError(code))
    if (terminate) stopWorker()
  }
  const ensureWorker = (): WorkerLike => {
    if (worker) return worker
    const created = createWorker() as unknown as WorkerLike
    created.onmessage = ({ data }) => {
      const pending = active
      if (!pending) return
      if (!exactRecord(data, data && typeof data === 'object' && 'ok' in data && (data as { ok?: unknown }).ok === true
        ? ['type', 'requestId', 'sessionId', 'generation', 'ok', 'result']
        : ['type', 'requestId', 'sessionId', 'generation', 'ok', 'code'])) {
        if (typeof data === 'object' && data !== null && !Array.isArray(data)
          && Object.hasOwn(data, 'requestId')
          && (data as { requestId?: unknown }).requestId === pending.requestId) rejectActive('OCR_FAILED', false)
        return
      }
      if (data.type !== 'result' || data.requestId !== pending.requestId
        || data.sessionId !== pending.sessionId || data.generation !== pending.generation) return
      if (data.ok === false) {
        const code = data.code === 'OCR_UNAVAILABLE' || data.code === 'OCR_TIMEOUT' || data.code === 'OCR_FAILED'
          ? data.code : 'OCR_FAILED'
        rejectActive(code, false)
        return
      }
      if (data.ok !== true) { rejectActive('OCR_FAILED', false); return }
      const result = parseScreenshotOcrResult(data.result)
      if (!result) { rejectActive('OCR_FAILED', false); return }
      active = undefined
      pending.removeAbort()
      pending.resolve(result)
    }
    created.onerror = () => rejectActive('OCR_FAILED', true)
    created.onmessageerror = () => rejectActive('OCR_FAILED', true)
    worker = created
    return created
  }

  return {
    recognize(input) {
      if (disposed) return Promise.reject(new ScreenshotOcrClientError('OCR_CANCELLED'))
      if (!VALIDATION_EVENT(input) || (input.tier !== 'small' && input.tier !== 'medium')) {
        return Promise.reject(new ScreenshotOcrClientError('OCR_FAILED'))
      }
      if (input.signal?.aborted) return Promise.reject(new ScreenshotOcrClientError('OCR_CANCELLED'))
      if (active) rejectActive('OCR_CANCELLED', active.requestId !== undefined)
      return new Promise<ScreenshotOcrResult>((resolve, reject) => {
        const pending = {
          sessionId: input.sessionId,
          generation: input.generation,
          resolve,
          reject,
          removeAbort: () => input.signal?.removeEventListener('abort', onAbort),
        } as NonNullable<typeof active>
        const onAbort = () => {
          if (active === pending) rejectActive('OCR_CANCELLED', pending.requestId !== undefined)
        }
        input.signal?.addEventListener('abort', onAbort, { once: true })
        active = pending
        void (async () => {
          let bytes: ArrayBuffer
          try {
            bytes = await encodeImage(input.image)
          } catch {
            if (active === pending) rejectActive('OCR_FAILED', false)
            return
          }
          if (active !== pending) return
          if (disposed || input.signal?.aborted) { rejectActive('OCR_CANCELLED', false); return }
          if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) { rejectActive('OCR_FAILED', false); return }
          const requestId = nextRequestId++
          pending.requestId = requestId
          let currentWorker: WorkerLike
          try { currentWorker = ensureWorker() } catch { rejectActive('OCR_FAILED', false); return }
          if (active !== pending) return
          try {
            currentWorker.postMessage({
              type: 'recognize', requestId, sessionId: input.sessionId, generation: input.generation,
              image: { width: input.image.width, height: input.image.height, bytes }, tier: input.tier,
            }, [bytes])
          } catch {
            rejectActive('OCR_FAILED', true)
          }
        })()
      })
    },
    stop() {
      rejectActive('OCR_CANCELLED', true)
      stopWorker()
    },
    dispose() {
      if (disposed) return
      disposed = true
      rejectActive('OCR_CANCELLED', true)
      stopWorker()
    },
  }
}
