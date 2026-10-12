// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaddleOCR } from '@paddleocr/paddleocr-js'
import {
  createFileCompatiblePaddleOcr,
  type ScreenshotPaddleOcrOptions,
} from '../../src/renderer/screenshot/screenshot-ocr-sdk-compat'

const localOptions: ScreenshotPaddleOcrOptions = {
  lang: 'ch',
  ocrVersion: 'PP-OCRv6',
  textDetectionModelName: 'PP-OCRv6_small_det',
  textDetectionModelAsset: { url: 'arkdown-ocr://bundle/small-det.tar' },
  textRecognitionModelName: 'PP-OCRv6_small_rec',
  textRecognitionModelAsset: { url: 'arkdown-ocr://bundle/small-rec.tar' },
  ortOptions: {
    backend: 'wasm', wasmPaths: 'arkdown-ocr://bundle/ort/', numThreads: 1, simd: true, proxy: false,
  },
}
const mediumOptions: ScreenshotPaddleOcrOptions = {
  ...localOptions,
  textDetectionModelName: 'PP-OCRv6_medium_det',
  textDetectionModelAsset: { url: 'arkdown-ocr://bundle/medium-det.tar' },
  textRecognitionModelName: 'PP-OCRv6_medium_rec',
  textRecognitionModelAsset: { url: 'arkdown-ocr://bundle/medium-rec.tar' },
}

afterEach(() => vi.unstubAllGlobals())

describe('PaddleOCR 0.4.2 packaged-file compatibility', () => {
  it('characterizes the official direct SDK rejecting its otherwise local pipeline at a file origin', async () => {
    vi.stubGlobal('location', { protocol: 'file:' })
    const pipeline = await PaddleOCR.create({ ...localOptions, initialize: false })
    await expect(pipeline.initialize()).rejects.toThrow('requires an HTTP(S) origin')
  })

  it('initializes the locked direct SDK shape at a file origin only after validating exact local assets', async () => {
    vi.stubGlobal('location', { protocol: 'file:' })
    class PaddleOCR {
      static create = vi.fn(async (options: unknown) => new PaddleOCR(options))
      readonly options: unknown
      ensureServedFromHttp = () => { throw new Error('requires an HTTP(S) origin') }
      sourceToMat = (_runtime: unknown, _source: unknown) => { throw new Error('DOM adapter') }
      initialize = vi.fn(async () => { this.ensureServedFromHttp(); return { backend: 'wasm' } })
      predict = vi.fn()
      dispose = vi.fn()
      constructor(options: unknown) { this.options = options }
    }

    const pipeline = await createFileCompatiblePaddleOcr(localOptions, PaddleOCR)
    expect(PaddleOCR.create).toHaveBeenCalledWith({ ...localOptions, initialize: false })
    expect(pipeline).toBeInstanceOf(PaddleOCR)
    expect(pipeline.initialize).toHaveBeenCalledOnce()
    expect(JSON.stringify(PaddleOCR.create.mock.calls)).not.toMatch(/https?:|cdn/i)
  })

  it('accepts a minified guard function name because production bundling may rename it', async () => {
    class a {
      static create = vi.fn(async () => new a())
      ensureServedFromHttp = function a() { throw new Error('file origin') }
      sourceToMat = (_runtime: unknown, _source: unknown) => { throw new Error('DOM adapter') }
      initialize = vi.fn(async () => { this.ensureServedFromHttp() })
      predict = vi.fn()
      dispose = vi.fn(async () => undefined)
    }
    await expect(createFileCompatiblePaddleOcr(localOptions, a)).resolves.toBeInstanceOf(a)
    expect(a.create).toHaveBeenCalledOnce()
  })

  it('replaces the pinned DOM source adapter with a worker-safe OffscreenCanvas adapter', async () => {
    class TestImageBitmap {
      readonly width = 8
      readonly height = 6
    }
    const pixels = new Uint8ClampedArray(8 * 6 * 4)
    const context = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ width: 8, height: 6, data: pixels })),
    }
    class TestOffscreenCanvas {
      constructor(readonly width: number, readonly height: number) {}
      getContext = vi.fn(() => context)
    }
    vi.stubGlobal('ImageBitmap', TestImageBitmap)
    vi.stubGlobal('OffscreenCanvas', TestOffscreenCanvas)
    const mat = { delete: vi.fn() }
    const cv = { CV_8UC4: 24, matFromArray: vi.fn(() => mat) }

    class PaddleOCR {
      static create = vi.fn(async () => new PaddleOCR())
      ensureServedFromHttp = () => undefined
      sourceToMat = (_runtime: unknown, _source: unknown) => { throw new Error('DOM source adapter reached inside worker') }
      initialize = vi.fn(async () => undefined)
      predict = vi.fn()
      dispose = vi.fn(async () => undefined)
    }

    const pipeline = await createFileCompatiblePaddleOcr(localOptions, PaddleOCR)
    const adapter = (pipeline as unknown as {
      sourceToMat(runtime: unknown, source: unknown): Promise<{
        width: number; height: number; mat: unknown; dispose(): void
      }>
    }).sourceToMat
    const bitmap = new TestImageBitmap()
    const converted = await adapter(cv, bitmap)

    expect(converted).toMatchObject({ width: 8, height: 6, mat })
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0)
    expect(cv.matFromArray).toHaveBeenCalledWith(6, 8, 24, pixels)
    converted.dispose()
    expect(mat.delete).toHaveBeenCalledOnce()
  })

  it('accepts only the exact paired local Medium custom model options and rejects mixed tiers', async () => {
    class PaddleOCR {
      static create = vi.fn(async () => new PaddleOCR())
      ensureServedFromHttp = () => undefined
      sourceToMat = (_runtime: unknown, _source: unknown) => { throw new Error('DOM adapter') }
      initialize = vi.fn(async () => undefined)
      predict = vi.fn()
      dispose = vi.fn(async () => undefined)
    }
    await expect(createFileCompatiblePaddleOcr(mediumOptions, PaddleOCR)).resolves.toBeInstanceOf(PaddleOCR)
    await expect(createFileCompatiblePaddleOcr({
      ...mediumOptions,
      textRecognitionModelName: 'PP-OCRv6_small_rec',
      textRecognitionModelAsset: { url: 'arkdown-ocr://bundle/small-rec.tar' },
    }, PaddleOCR)).rejects.toThrow('OCR_SDK_INCOMPATIBLE')
    expect(PaddleOCR.create).toHaveBeenCalledTimes(1)
  })

  it('disposes partial SDK initialization before returning a fixed compatibility failure', async () => {
    const dispose = vi.fn(async () => undefined)
    class PaddleOCR {
      static create = vi.fn(async () => new PaddleOCR())
      ensureServedFromHttp = () => undefined
      sourceToMat = (_runtime: unknown, _source: unknown) => { throw new Error('DOM adapter') }
      initialize = vi.fn(async () => { throw new Error('private ORT detail') })
      predict = vi.fn()
      dispose = dispose
    }
    await expect(createFileCompatiblePaddleOcr(localOptions, PaddleOCR))
      .rejects.toThrow('OCR_SDK_INCOMPATIBLE')
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('fails closed before SDK creation for remote assets or on any incompatible direct SDK shape', async () => {
    class PaddleOCR {
      static create = vi.fn(async () => new PaddleOCR())
      ensureServedFromHttp = () => undefined
      sourceToMat = (_runtime: unknown, _source: unknown) => { throw new Error('DOM adapter') }
      initialize = vi.fn(async () => undefined)
      predict = vi.fn()
      dispose = vi.fn()
    }
    await expect(createFileCompatiblePaddleOcr({
      ...localOptions,
      textDetectionModelAsset: { url: 'https://example.test/model.tar' },
    }, PaddleOCR)).rejects.toThrow('OCR_SDK_INCOMPATIBLE')
    expect(PaddleOCR.create).not.toHaveBeenCalled()

    class MissingGuardPaddleOCR {
      static create = vi.fn(async () => new MissingGuardPaddleOCR())
      initialize = vi.fn(async () => undefined)
      predict = vi.fn()
      dispose = vi.fn()
    }
    Object.defineProperty(MissingGuardPaddleOCR, 'name', { value: 'PaddleOCR' })
    await expect(createFileCompatiblePaddleOcr(localOptions, MissingGuardPaddleOCR))
      .rejects.toThrow('OCR_SDK_INCOMPATIBLE')

    class WrongConstructorPaddleOCR extends PaddleOCR {
      static override create = vi.fn(async () => new PaddleOCR())
    }
    Object.defineProperty(WrongConstructorPaddleOCR, 'name', { value: 'PaddleOCR' })
    await expect(createFileCompatiblePaddleOcr(localOptions, WrongConstructorPaddleOCR))
      .rejects.toThrow('OCR_SDK_INCOMPATIBLE')
  })
})
