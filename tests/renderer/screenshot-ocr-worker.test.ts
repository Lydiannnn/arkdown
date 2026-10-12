import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  initialize: vi.fn(),
  predict: vi.fn(),
}))

vi.mock('@paddleocr/paddleocr-js', () => ({
  PaddleOCR: class PaddleOCR {
    static create = sdk.create
    ensureServedFromHttp = () => undefined
    sourceToMat = (_runtime: unknown, _source: unknown) => undefined
    initialize = sdk.initialize
    predict = sdk.predict
    dispose = vi.fn()
  },
}))

beforeEach(() => {
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(readonly width: number, readonly height: number) {}
    getContext() { return { fillRect: vi.fn(), drawImage: vi.fn(), imageSmoothingEnabled: false, imageSmoothingQuality: 'low' } }
    transferToImageBitmap() { return { width: this.width, height: this.height, close: vi.fn() } }
  })
})

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  sdk.create.mockReset()
  sdk.initialize.mockReset()
  sdk.predict.mockReset()
})

it('initializes one direct PP-OCRv6 Small pipeline with exact local assets and no nested Worker/CDN fallback', async () => {
  const { PaddleOCR } = await import('@paddleocr/paddleocr-js')
  sdk.create.mockImplementation(async () => new PaddleOCR({} as never))
  sdk.initialize.mockResolvedValue({})
  sdk.predict.mockResolvedValue([{
    image: { width: 960, height: 540 }, items: [],
    metrics: { detMs: 1, recMs: 1, totalMs: 2, detectedBoxes: 0, recognizedCount: 0 },
    runtime: { requestedBackend: 'wasm', detProvider: 'wasm', recProvider: 'wasm', webgpuAvailable: false },
  }])
  const posted: unknown[] = []
  const scope = {
    onmessage: undefined as ((event: MessageEvent<unknown>) => void) | undefined,
    postMessage: vi.fn((value: unknown) => posted.push(value)),
  }
  vi.stubGlobal('self', scope)
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 640, height: 360, close: vi.fn() })))

  await import('../../src/renderer/screenshot/screenshot-ocr-worker')
  const request = (requestId: number) => scope.onmessage?.({ data: {
    type: 'recognize', requestId,
    sessionId: '123e4567-e89b-42d3-a456-426614174000', generation: requestId,
    image: { width: 640, height: 360, bytes: new Uint8Array([1, 2, 3]).buffer }, tier: 'small',
  } } as MessageEvent<unknown>)
  request(1)
  await vi.waitFor(() => expect(posted).toHaveLength(1))
  request(2)
  await vi.waitFor(() => expect(posted).toHaveLength(2))
  expect(sdk.predict.mock.calls[0]![0]).toMatchObject({ width: 960, height: 540 })
  expect(posted[0]).toMatchObject({ ok: true, result: { width: 640, height: 360, blocks: [] } })

  expect(sdk.create).toHaveBeenCalledOnce()
  const options = sdk.create.mock.calls[0]![0]
  expect(options).toMatchObject({
    initialize: false,
    lang: 'ch',
    ocrVersion: 'PP-OCRv6',
    textDetectionModelName: 'PP-OCRv6_small_det',
    textDetectionModelAsset: { url: 'arkdown-ocr://bundle/small-det.tar' },
    textRecognitionModelName: 'PP-OCRv6_small_rec',
    textRecognitionModelAsset: { url: 'arkdown-ocr://bundle/small-rec.tar' },
    ortOptions: { backend: 'wasm', wasmPaths: 'arkdown-ocr://bundle/ort/', proxy: false },
  })
  expect(options).not.toHaveProperty('worker')
  expect(JSON.stringify(options)).not.toMatch(/https?:|cdn/i)
})

it('initializes Medium with exact local custom model names and URLs', async () => {
  const { PaddleOCR } = await import('@paddleocr/paddleocr-js')
  sdk.create.mockImplementation(async () => new PaddleOCR({} as never))
  sdk.initialize.mockResolvedValue({})
  sdk.predict.mockResolvedValue([{ image: { width: 960, height: 540 }, items: [], metrics: { detMs: 1, recMs: 1, totalMs: 2, detectedBoxes: 0, recognizedCount: 0 }, runtime: { requestedBackend: 'wasm', detProvider: 'wasm', recProvider: 'wasm', webgpuAvailable: false } }])
  const posted: unknown[] = []
  const scope = { onmessage: undefined as any, postMessage: vi.fn((value: unknown) => posted.push(value)) }
  vi.stubGlobal('self', scope)
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 640, height: 360, close: vi.fn() })))
  await import('../../src/renderer/screenshot/screenshot-ocr-worker')
  scope.onmessage?.({ data: { type: 'recognize', requestId: 1, sessionId: '123e4567-e89b-42d3-a456-426614174000', generation: 1, image: { width: 640, height: 360, bytes: new Uint8Array([1]).buffer }, tier: 'medium' } })
  await vi.waitFor(() => expect(posted).toHaveLength(1))
  expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({
    textDetectionModelName: 'PP-OCRv6_medium_det', textDetectionModelAsset: { url: 'arkdown-ocr://bundle/medium-det.tar' },
    textRecognitionModelName: 'PP-OCRv6_medium_rec', textRecognitionModelAsset: { url: 'arkdown-ocr://bundle/medium-rec.tar' },
  }))
})

it('rejects extra request keys without invoking the SDK or logging private input', async () => {
  const posted: unknown[] = []
  const scope = {
    onmessage: undefined as ((event: MessageEvent<unknown>) => void) | undefined,
    postMessage: vi.fn((value: unknown) => posted.push(value)),
  }
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.stubGlobal('self', scope)
  await import('../../src/renderer/screenshot/screenshot-ocr-worker')
  scope.onmessage?.({ data: {
    type: 'recognize', requestId: 1,
    sessionId: '123e4567-e89b-42d3-a456-426614174000', generation: 1,
    image: { width: 4, height: 3, bytes: new Uint8Array([9]).buffer }, tier: 'medium', extra: 'secret',
  } } as MessageEvent<unknown>)
  await vi.waitFor(() => expect(posted).toHaveLength(1))
  expect(posted[0]).toEqual({
    type: 'result', requestId: 1,
    sessionId: '123e4567-e89b-42d3-a456-426614174000', generation: 1,
    ok: false, code: 'OCR_FAILED',
  })
  expect(sdk.create).not.toHaveBeenCalled()
  expect(JSON.stringify(log.mock.calls)).not.toContain('secret')
  log.mockRestore()
})
