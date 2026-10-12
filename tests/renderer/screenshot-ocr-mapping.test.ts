import { describe, expect, it } from 'vitest'
import {
  SCREENSHOT_OCR_MAX_LONG_SIDE_PX,
  SCREENSHOT_OCR_MAX_WORKING_PIXELS,
  ScreenshotOcrMappingError,
  mapPaddleOcrResult,
  planScreenshotOcrPreparation,
} from '../../src/renderer/screenshot/screenshot-ocr-mapping'

function sdkResult(items: unknown[], width = 176, height = 96): unknown {
  return {
    image: { width, height },
    items,
    metrics: { detMs: 1, recMs: 2, totalMs: 3, detectedBoxes: items.length, recognizedCount: items.length },
    runtime: { requestedBackend: 'wasm', detProvider: 'wasm', recProvider: 'wasm', webgpuAvailable: false },
  }
}

const preparation = {
  originalWidth: 40,
  originalHeight: 20,
  preparedWidth: 176,
  preparedHeight: 96,
  scale: 4,
  paddingPx: 2,
}

describe('screenshot OCR preparation', () => {
  it('pads and uniformly upscales a small crop within fixed limits', () => {
    expect(planScreenshotOcrPreparation({ width: 40, height: 20 })).toEqual(preparation)
  })

  it('enlarges a normal crop to 150 percent before OCR without changing source dimensions', () => {
    expect(planScreenshotOcrPreparation({ width: 640, height: 360 })).toEqual({
      originalWidth: 640,
      originalHeight: 360,
      preparedWidth: 960,
      preparedHeight: 540,
      scale: 1.5,
      paddingPx: 0,
    })
    expect(() => planScreenshotOcrPreparation({ width: 32_768, height: 32_768 })).toThrow(ScreenshotOcrMappingError)
  })

  it('keeps 150 percent preprocessing within the existing long-side and pixel budgets', () => {
    expect(SCREENSHOT_OCR_MAX_LONG_SIDE_PX).toBe(2_560)
    expect(SCREENSHOT_OCR_MAX_WORKING_PIXELS).toBe(4_000_000)
    expect(planScreenshotOcrPreparation({ width: 3_840, height: 2_160 })).toEqual({
      originalWidth: 3_840,
      originalHeight: 2_160,
      preparedWidth: 2_560,
      preparedHeight: 1_440,
      scale: 2 / 3,
      paddingPx: 0,
    })
    for (const size of [{ width: 2_560, height: 1_440 }, { width: 1_920, height: 1_080 }]) {
      expect(planScreenshotOcrPreparation(size)).toEqual({
        originalWidth: size.width,
        originalHeight: size.height,
        preparedWidth: 2_560,
        preparedHeight: 1_440,
        scale: 2_560 / size.width,
        paddingPx: 0,
      })
    }
  })

  it('uses the total working-pixel cap independently of the long-side cap', () => {
    const result = planScreenshotOcrPreparation({ width: 2_500, height: 2_000 })
    expect(result.scale).toBeCloseTo(Math.sqrt(4_000_000 / 5_000_000), 12)
    expect(result.preparedWidth * result.preparedHeight).toBeLessThanOrEqual(4_005_000)
    expect(result.preparedWidth).toBeLessThan(2_500)
  })
})

describe('PaddleOCR result mapping', () => {
  it('maps the 150 percent recognition geometry back to original screenshot pixels', () => {
    const upscaled = planScreenshotOcrPreparation({ width: 640, height: 360 })
    const result = mapPaddleOcrResult(sdkResult([{
      poly: [[15, 30], [75, 30], [75, 60], [15, 60]], text: 'mapped', score: 0.9,
    }], upscaled.preparedWidth, upscaled.preparedHeight), upscaled)
    expect(result).toMatchObject({ width: 640, height: 360 })
    expect(result.blocks[0]?.rectPx).toEqual({ x: 10, y: 20, width: 40, height: 20 })
  })
  it('accepts the pinned SDK Point2D tuple contract', () => {
    expect(mapPaddleOcrResult(sdkResult([{
      poly: [[8, 8], [40, 8], [40, 40], [8, 40]], text: 'Codex', score: 0.9,
    }]), preparation).blocks).toHaveLength(1)
  })

  it('maps floor/ceil containment, clamps edges, sorts mixed scripts, and emits one exact word per line', () => {
    const result = mapPaddleOcrResult(sdkResult([
      { poly: [[82.2, 47.9], [175, 47.9], [175, 95], [82.2, 95]], text: '中文', score: 0.95 },
      { poly: [[7, 7], [84.4, 7], [84.4, 43.1], [7, 43.1]], text: 'Codex', score: 0.9 },
      { poly: [[8.1, 48], [70, 48], [70, 88], [8.1, 88]], text: 'Latin', score: 0.99 },
    ]), preparation)

    expect(result).toEqual({
      width: 40,
      height: 20,
      language: 'mul',
      blocks: [
        { id: 'line-1', text: 'Codex', rectPx: { x: 0, y: 0, width: 20, height: 9 }, words: [{ text: 'Codex', rectPx: { x: 0, y: 0, width: 20, height: 9 } }] },
        { id: 'line-2', text: '中文', rectPx: { x: 18, y: 9, width: 22, height: 11 }, words: [{ text: '中文', rectPx: { x: 18, y: 9, width: 22, height: 11 } }] },
        { id: 'line-3', text: 'Latin', rectPx: { x: 0, y: 10, width: 16, height: 10 }, words: [{ text: 'Latin', rectPx: { x: 0, y: 10, width: 16, height: 10 } }] },
      ],
    })
  })

  it('maps a fractional downscaled polygon back to touched original pixels', () => {
    const downscaled = planScreenshotOcrPreparation({ width: 3_840, height: 2_160 })
    const result = mapPaddleOcrResult(sdkResult([{
      poly: [[10.2, 5.1], [20.1, 5.1], [20.1, 15.4], [10.2, 15.4]],
      text: 'mapped',
      score: 0.9,
    }], downscaled.preparedWidth, downscaled.preparedHeight), downscaled)
    expect(result.blocks[0]?.rectPx).toEqual({ x: 15, y: 7, width: 16, height: 17 })
  })

  it('omits blank and below-threshold lines while keeping contiguous IDs', () => {
    const result = mapPaddleOcrResult(sdkResult([
      { poly: [[8, 8], [40, 8], [40, 40], [8, 40]], text: '   ', score: 0.99 },
      { poly: [[8, 8], [40, 8], [40, 40], [8, 40]], text: 'low', score: 0.2 },
      { poly: [[8, 8], [40, 8], [40, 40], [8, 40]], text: 'kept', score: 0.8 },
    ]), preparation)
    expect(result.blocks.map(({ id, text }) => ({ id, text }))).toEqual([{ id: 'line-1', text: 'kept' }])
  })

  it.each([
    ['sparse items', (() => { const items = Array(1); return sdkResult(items) })()],
    ['extra item key', sdkResult([{ poly: [], text: 'x', score: 1, secret: true }])],
    ['unsafe text', sdkResult([{ poly: [[8, 8], [40, 8], [40, 40], [8, 40]], text: 'x\nsecret', score: 1 }])],
    ['non-finite coordinate', sdkResult([{ poly: [[8, 8], [Number.NaN, 8], [40, 40], [8, 40]], text: 'x', score: 1 }])],
    ['extra result key', { ...(sdkResult([]) as object), extra: true }],
    ['fractional metric count', { ...(sdkResult([]) as Record<string, unknown>), metrics: { detMs: 1, recMs: 2, totalMs: 3, detectedBoxes: 0.5, recognizedCount: 0 } }],
    ['unsafe provider', { ...(sdkResult([]) as Record<string, unknown>), runtime: { requestedBackend: 'wasm', detProvider: 'wasm\nsecret', recProvider: 'wasm', webgpuAvailable: false } }],
    ['oversized provider', { ...(sdkResult([]) as Record<string, unknown>), runtime: { requestedBackend: 'x'.repeat(257), detProvider: 'wasm', recProvider: 'wasm', webgpuAvailable: false } }],
  ])('rejects malformed SDK output: %s', (_name, value) => {
    expect(() => mapPaddleOcrResult(value, preparation)).toThrow(ScreenshotOcrMappingError)
  })

  it('rejects a polygon wholly inside padding and a zero-area inverse rectangle', () => {
    for (const poly of [
      [[0, 0], [7, 0], [7, 7], [0, 7]],
      [[8, 8], [8, 8], [8, 8], [8, 8]],
    ]) {
      expect(() => mapPaddleOcrResult(sdkResult([{ poly, text: 'x', score: 1 }]), preparation))
        .toThrow(ScreenshotOcrMappingError)
    }
  })

  it('classifies malformed SDK boundaries with fixed non-sensitive codes', () => {
    try {
      mapPaddleOcrResult({
        ...(sdkResult([]) as Record<string, unknown>),
        runtime: { requestedBackend: 'wasm', detProvider: '', recProvider: 'wasm', webgpuAvailable: false },
      }, preparation)
      throw new Error('Expected mapping rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(ScreenshotOcrMappingError)
      expect(error).toMatchObject({ code: 'RESULT_RUNTIME_INVALID' })
      expect(JSON.stringify(error)).not.toMatch(/private|secret/iu)
    }
  })
})
