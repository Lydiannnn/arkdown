import { describe, expect, it, vi } from 'vitest'
import {
  parseScreenshotCaptureEvent,
  SCREENSHOT_DISPLAY_ID_MAX_LENGTH,
  SCREENSHOT_IMAGE_DATA_URL_MAX_BYTES,
  SCREENSHOT_IMAGE_MAX_PIXELS,
  SCREENSHOT_IMAGE_MAX_DIMENSION_PX,
  SCREENSHOT_OCR_BLOCK_LIMIT,
  SCREENSHOT_OCR_BLOCK_TEXT_MAX_LENGTH,
  SCREENSHOT_OCR_TEXT_MAX_LENGTH,
  SCREENSHOT_OCR_WORD_LIMIT,
  SCREENSHOT_SESSION_ID_MAX_LENGTH,
  SCREENSHOT_TRANSLATED_TEXT_MAX_LENGTH,
  SCREENSHOT_TRANSLATED_TEXT_TOTAL_MAX_BYTES,
  SCREENSHOT_TRANSLATED_TEXT_TOTAL_MAX_LENGTH,
  clipRectToBounds,
  cropDipToPixels,
  parseCaptureDisplaySnapshot,
  parseScreenshotCaptureCommitInput,
  parseScreenshotCapturePointerInput,
  parseScreenshotOcrBlocks,
  parseScreenshotOcrHostCommand,
  parseScreenshotSessionInput,
  parseScreenshotTranslationEvent,
  parseScreenshotTranslationGenerationInput,
  parseScreenshotWindowHighlightResult,
  type CaptureDisplaySnapshot,
} from '../../src/shared/screenshot-translation'

const captureSessionId = '123e4567-e89b-42d3-a456-426614174000'

it('accepts only exact model-bound OCR host commands', () => {
  const image = { width: 20, height: 10, dataUrl: 'data:image/png;base64,AAAA' }
  const command = {
    type: 'recognize' as const,
    sessionId: captureSessionId,
    generation: 1,
    image,
    tier: 'small' as const,
    cacheKey: 'small:6.0.0',
  }
  expect(parseScreenshotOcrHostCommand(command)).toEqual(command)
  expect(parseScreenshotOcrHostCommand({ ...command, cacheKey: 'medium:6.0.0' })).toBeUndefined()
  expect(parseScreenshotOcrHostCommand({ ...command, cacheKey: 'small:https://remote' })).toBeUndefined()
  expect(parseScreenshotOcrHostCommand({ ...command, extra: true })).toBeUndefined()
  expect(parseScreenshotOcrHostCommand({
    type: 'cancel', sessionId: captureSessionId, generation: 1,
  })).toEqual({ type: 'cancel', sessionId: captureSessionId, generation: 1 })
})

it('accepts only exact nullable native window hit results', () => {
  const hit = { processId: 77, rectDip: { x: 10, y: 20, width: 30, height: 40 } }
  expect(parseScreenshotWindowHighlightResult(hit)).toEqual(hit)
  expect(parseScreenshotWindowHighlightResult(null)).toBeNull()
  expect(parseScreenshotWindowHighlightResult({ ...hit, extra: true })).toBeUndefined()
  expect(parseScreenshotWindowHighlightResult({ ...hit, processId: 0 })).toBeUndefined()
})

it('accepts only exact screenshot capture events', () => {
  const display = {
    displayId: '1', boundsDip: { x: 0, y: 0, width: 20, height: 10 }, scaleFactor: 1,
    imageSizePx: { width: 20, height: 10 }, dataUrl: 'data:image/png;base64,AAAA',
  }
  expect(parseScreenshotCaptureEvent({ sessionId: captureSessionId, type: 'selection-ready', display })).toEqual({
    sessionId: captureSessionId, type: 'selection-ready', display,
  })
  expect(parseScreenshotCaptureEvent({
    sessionId: captureSessionId, type: 'window-highlight', displayId: '1',
    hit: { processId: 2, rectDip: { x: 0, y: 0, width: 2, height: 2 } },
  })).toEqual({
    sessionId: captureSessionId, type: 'window-highlight', displayId: '1',
    hit: { processId: 2, rectDip: { x: 0, y: 0, width: 2, height: 2 } },
  })
  expect(parseScreenshotCaptureEvent({ sessionId: captureSessionId, type: 'committing', extra: true })).toBeUndefined()
  expect(parseScreenshotCaptureEvent({ sessionId: captureSessionId.toUpperCase(), type: 'cancelled' })).toBeUndefined()
})

const SESSION_ID = '9b6d8d86-7a68-4cab-951c-6a25e09dd14b'
const DATA_URL = 'data:image/png;base64,AA=='

function image(overrides: Record<string, unknown> = {}) {
  return { width: 800, height: 600, dataUrl: DATA_URL, ...overrides }
}

function block(overrides: Record<string, unknown> = {}) {
  return {
    id: 'line-1',
    text: 'Hello',
    rectPx: { x: 10, y: 20, width: 50, height: 40 },
    words: [{ text: 'Hello', rectPx: { x: 10, y: 20, width: 50, height: 40 } }],
    ...overrides,
  }
}

const DISPLAY_125: CaptureDisplaySnapshot = {
  displayId: 'display-1',
  boundsDip: { x: -1200, y: 0, width: 1200, height: 800 },
  scaleFactor: 1.25,
  imageSizePx: { width: 1500, height: 1000 },
  dataUrl: DATA_URL,
}

describe('screenshot translation protocol', () => {
  it('defines the published protocol limits', () => {
    expect(SCREENSHOT_SESSION_ID_MAX_LENGTH).toBe(36)
    expect(SCREENSHOT_IMAGE_DATA_URL_MAX_BYTES).toBe(33_554_432)
    expect(SCREENSHOT_IMAGE_MAX_PIXELS).toBe(25_000_000)
    expect(SCREENSHOT_IMAGE_MAX_DIMENSION_PX).toBe(32_768)
    expect(SCREENSHOT_OCR_BLOCK_LIMIT).toBe(4_096)
    expect(SCREENSHOT_OCR_WORD_LIMIT).toBe(32_768)
    expect(SCREENSHOT_OCR_TEXT_MAX_LENGTH).toBe(200_000)
    expect(SCREENSHOT_TRANSLATED_TEXT_TOTAL_MAX_LENGTH).toBe(2 * 1024 * 1024)
    expect(SCREENSHOT_TRANSLATED_TEXT_TOTAL_MAX_BYTES).toBe(2 * 1024 * 1024)
    expect(SCREENSHOT_OCR_BLOCK_TEXT_MAX_LENGTH).toBe(8_192)
    expect(SCREENSHOT_TRANSLATED_TEXT_MAX_LENGTH).toBe(16_384)
    expect(SCREENSHOT_DISPLAY_ID_MAX_LENGTH).toBe(256)
  })

  it('rejects selected result images above the decoded OCR pixel budget', () => {
    expect(parseScreenshotTranslationEvent({
      sessionId: SESSION_ID,
      generation: 1,
      type: 'snapshot-ready', tier: 'small',
      image: { width: 5_001, height: 5_000, dataUrl: DATA_URL },
    })).toBeUndefined()
  })

  it('accepts an exact display snapshot with PNG bytes', () => {
    expect(parseCaptureDisplaySnapshot(DISPLAY_125)).toEqual(DISPLAY_125)
  })

  it.each([
    ['extra own key', { ...DISPLAY_125, extra: true }],
    ['inherited field', Object.assign(Object.create(DISPLAY_125), { displayId: 'display-1' })],
    ['blank display id', { ...DISPLAY_125, displayId: ' ' }],
    ['non-canonical data URL', { ...DISPLAY_125, dataUrl: 'data:image/jpeg;base64,AA==' }],
    ['malformed base64', { ...DISPLAY_125, dataUrl: 'data:image/png;base64,=A==' }],
    ['non-canonical base64 padding bits', { ...DISPLAY_125, dataUrl: 'data:image/png;base64,AB==' }],
    ['fractional pixel width', { ...DISPLAY_125, imageSizePx: { width: 1.5, height: 2 } }],
    ['invalid scale factor', { ...DISPLAY_125, scaleFactor: 8.1 }],
  ])('rejects display snapshots with %s', (_label, value) => {
    expect(parseCaptureDisplaySnapshot(value)).toBeUndefined()
  })

  it('rejects a data URL whose decoded image exceeds the bounded transport size', () => {
    expect(parseCaptureDisplaySnapshot({
      ...DISPLAY_125,
      dataUrl: `data:image/png;base64,${'A'.repeat(Math.ceil((SCREENSHOT_IMAGE_DATA_URL_MAX_BYTES + 1) / 3) * 4)}`,
    })).toBeUndefined()
  })

  it('accepts exactly 32 MiB of canonical PNG bytes and rejects one byte more', () => {
    const exactly32MiB = `${'A'.repeat(44_739_243)}=`
    expect(parseCaptureDisplaySnapshot({
      ...DISPLAY_125,
      dataUrl: `data:image/png;base64,${exactly32MiB}`,
    })).toBeDefined()
    expect(parseCaptureDisplaySnapshot({
      ...DISPLAY_125,
      dataUrl: `data:image/png;base64,${'A'.repeat(44_739_244)}`,
    })).toBeUndefined()
  })

  it('accepts maximum capture dimensions and rejects dimensions beyond the protocol boundary', () => {
    expect(parseCaptureDisplaySnapshot({
      ...DISPLAY_125,
      imageSizePx: { width: 32_768, height: 32_768 },
    })).toBeDefined()
    expect(parseCaptureDisplaySnapshot({
      ...DISPLAY_125,
      imageSizePx: { width: 32_769, height: 32_768 },
    })).toBeUndefined()
  })

  it('accepts an exact maximum-length display ID and rejects a longer one', () => {
    expect(parseCaptureDisplaySnapshot({
      ...DISPLAY_125,
      displayId: 'd'.repeat(256),
    })).toBeDefined()
    expect(parseCaptureDisplaySnapshot({
      ...DISPLAY_125,
      displayId: 'd'.repeat(257),
    })).toBeUndefined()
  })

  it('rejects non-NFC and NUL display IDs in every capture input', () => {
    expect(parseCaptureDisplaySnapshot({ ...DISPLAY_125, displayId: 'e\u0301' })).toBeUndefined()
    expect(parseScreenshotCapturePointerInput({
      sessionId: SESSION_ID,
      displayId: 'display\0id',
      screenPointDip: { x: 1, y: 1 },
    })).toBeUndefined()
    expect(parseScreenshotCaptureCommitInput({
      sessionId: SESSION_ID,
      displayId: 'e\u0301',
      kind: 'region',
      rectDip: { x: 1, y: 1, width: 2, height: 2 },
    })).toBeUndefined()
  })

  it('accepts OCR blocks only when IDs, text, arrays, and word geometry are valid', () => {
    const valid = [block(), block({ id: 'line-2', text: 'World' })]
    expect(parseScreenshotOcrBlocks(valid)).toEqual(valid)

    const sparse = [block(), block({ id: 'line-2' })]
    delete sparse[1]
    for (const invalid of [
      [block(), { ...block({ id: 'line-2' }), unexpected: true }],
      sparse,
      [block(), block({ id: 'line-1' })],
      [block({ id: 'line-2' }), block({ id: 'line-1' })],
      [block({ text: '   ' })],
      [block({ words: [{ text: 'outside', rectPx: { x: 0, y: 20, width: 50, height: 40 } }] })],
      [block({ text: 'e\u0301' })],
      [block({ text: 'bad\u0001' })],
      [block({ text: '\ud800' })],
      [block({ words: [{ text: '\udc00', rectPx: { x: 10, y: 20, width: 50, height: 40 } }] })],
      [block({ words: [] })],
      [block({ id: 'line-2' })],
      [block({ rectPx: { x: 10, y: 20, width: 100, height: 40 } })],
    ]) {
      expect(parseScreenshotOcrBlocks(invalid)).toBeUndefined()
    }
  })

  it('enforces OCR count and total text limits', () => {
    expect(parseScreenshotOcrBlocks(Array.from(
      { length: SCREENSHOT_OCR_BLOCK_LIMIT + 1 },
      (_, index) => block({ id: `line-${index + 1}` }),
    ))).toBeUndefined()
    expect(parseScreenshotOcrBlocks([
      block({ text: 'a'.repeat(SCREENSHOT_OCR_TEXT_MAX_LENGTH) }),
    ])).toBeUndefined()
  })

  it('accepts exactly 4096 OCR blocks and rejects 4097', () => {
    const atLimit = Array.from(
      { length: 4_096 },
      (_, index) => block({ id: `line-${index + 1}` }),
    )
    expect(parseScreenshotOcrBlocks(atLimit)).toBeDefined()
    expect(parseScreenshotOcrBlocks([
      ...atLimit,
      block({ id: 'line-4097' }),
    ])).toBeUndefined()
  })

  it('accepts exactly 32768 OCR words and rejects 32769', () => {
    const word = { text: 'word', rectPx: { x: 10, y: 20, width: 50, height: 40 } }
    expect(parseScreenshotOcrBlocks([
      block({ words: Array.from({ length: 32_768 }, () => word) }),
    ])).toBeDefined()
    expect(parseScreenshotOcrBlocks([
      block({ words: Array.from({ length: 32_769 }, () => word) }),
    ])).toBeUndefined()
  })

  it('counts total OCR text independently from the per-block text boundary', () => {
    const word = { text: 'w', rectPx: { x: 10, y: 20, width: 50, height: 40 } }
    const atLimit = Array.from(
      { length: 25 },
      (_, index) => block({ id: `line-${index + 1}`, text: 'a'.repeat(7_999), words: [word] }),
    )
    const aboveLimit = [
      ...Array.from(
        { length: 24 },
        (_, index) => block({ id: `line-${index + 1}`, text: 'a'.repeat(8_191), words: [word] }),
      ),
      block({ id: 'line-25', text: 'a'.repeat(3_392), words: [word] }),
    ]
    expect(parseScreenshotOcrBlocks(atLimit)).toBeDefined()
    expect(parseScreenshotOcrBlocks(aboveLimit)).toBeUndefined()
  })

  it('accepts block text at 8192 UTF-16 code units and rejects 8193', () => {
    expect(parseScreenshotOcrBlocks([
      block({ text: 'b'.repeat(8_192) }),
    ])).toBeDefined()
    expect(parseScreenshotOcrBlocks([
      block({ text: 'b'.repeat(8_193) }),
    ])).toBeUndefined()
  })

  it('allows an OCR word above the block-text limit when global text remains bounded', () => {
    expect(parseScreenshotOcrBlocks([
      block({ words: [{ text: 'w'.repeat(8_193), rectPx: { x: 10, y: 20, width: 50, height: 40 } }] }),
    ])).toBeDefined()
  })

  it('counts OCR word text toward the exact global text budget', () => {
    expect(parseScreenshotOcrBlocks([
      block({ text: 'b', words: [{ text: 'w'.repeat(199_999), rectPx: { x: 10, y: 20, width: 50, height: 40 } }] }),
    ])).toBeDefined()
    expect(parseScreenshotOcrBlocks([
      block({ text: 'b', words: [{ text: 'w'.repeat(200_000), rectPx: { x: 10, y: 20, width: 50, height: 40 } }] }),
    ])).toBeUndefined()
  })

  it('rejects an over-budget word before attempting NFC normalization', () => {
    const overBudgetWord = 'w'.repeat(200_000)
    const normalizedValues: string[] = []
    const normalize = vi.spyOn(String.prototype, 'normalize').mockImplementation(function(this: string) {
      const value = String(this)
      normalizedValues.push(value)
      return value
    })
    try {
      expect(parseScreenshotOcrBlocks([
        block({ text: 'b', words: [{ text: overBudgetWord, rectPx: { x: 10, y: 20, width: 50, height: 40 } }] }),
      ])).toBeUndefined()
    } finally {
      normalize.mockRestore()
    }
    expect(normalizedValues).not.toContain(overBudgetWord)
  })

  it('rejects non-image-contained and non-integer OCR pixel rectangles', () => {
    for (const rectPx of [
      { x: -1, y: 0, width: 1, height: 1 },
      { x: 0, y: -1, width: 1, height: 1 },
      { x: 0.5, y: 0, width: 1, height: 1 },
      { x: Number.MAX_SAFE_INTEGER, y: 0, width: 1, height: 1 },
      { x: 32_768, y: 0, width: 1, height: 1 },
      { x: 32_767, y: 0, width: 2, height: 1 },
      { x: 0, y: 32_767, width: 1, height: 2 },
    ]) {
      expect(parseScreenshotOcrBlocks([
        block({ rectPx, words: [{ text: 'word', rectPx }] }),
      ])).toBeUndefined()
    }
    const maximumEdge = { x: 32_767, y: 32_767, width: 1, height: 1 }
    expect(parseScreenshotOcrBlocks([
      block({ rectPx: maximumEdge, words: [{ text: 'word', rectPx: maximumEdge }] }),
    ])).toBeDefined()
  })

  it('accepts only exact UUID session inputs with positive generations', () => {
    expect(parseScreenshotSessionInput({ sessionId: SESSION_ID })).toEqual({ sessionId: SESSION_ID })
    expect(parseScreenshotTranslationGenerationInput({ sessionId: SESSION_ID, generation: 1 }))
      .toEqual({ sessionId: SESSION_ID, generation: 1 })
    expect(parseScreenshotSessionInput({ sessionId: SESSION_ID.toUpperCase() })).toBeUndefined()
    expect(parseScreenshotTranslationGenerationInput({ sessionId: SESSION_ID, generation: 0 })).toBeUndefined()
  })

  it('accepts exact capture inputs and rejects cross-process invalid geometry', () => {
    expect(parseScreenshotCapturePointerInput({
      sessionId: SESSION_ID,
      displayId: 'display-1',
      screenPointDip: { x: -20.5, y: 10 },
    })).toEqual({
      sessionId: SESSION_ID,
      displayId: 'display-1',
      screenPointDip: { x: -20.5, y: 10 },
    })
    expect(parseScreenshotCaptureCommitInput({
      sessionId: SESSION_ID,
      displayId: 'display-1',
      kind: 'window',
      rectDip: { x: -10, y: 10, width: 20, height: 30 },
      processId: 42,
    })).toMatchObject({ kind: 'window', processId: 42 })
    expect(parseScreenshotCaptureCommitInput({
      sessionId: SESSION_ID,
      displayId: 'display-1',
      kind: 'region',
      rectDip: { x: 10, y: 10, width: -20, height: 30 },
    })).toBeUndefined()
  })

  it('parses only exact screenshot events with matching failure stage and code', () => {
    expect(parseScreenshotTranslationEvent({
      sessionId: SESSION_ID,
      generation: 1,
      type: 'snapshot-ready', tier: 'small',
      image: image(),
    })).toEqual({ sessionId: SESSION_ID, generation: 1, type: 'snapshot-ready', image: image(), tier: 'small' })
    expect(parseScreenshotTranslationEvent({
      sessionId: SESSION_ID,
      generation: 2,
      type: 'ocr-completed',
      blocks: [block()],
    })).toMatchObject({ type: 'ocr-completed' })
    expect(parseScreenshotTranslationEvent({
      sessionId: SESSION_ID,
      generation: 3,
      type: 'translation-completed',
      translations: [{ id: 'line-2', text: 'World' }, { id: 'line-1', text: 'Hello' }],
    })).toMatchObject({ type: 'translation-completed' })
    expect(parseScreenshotTranslationEvent({
      sessionId: SESSION_ID,
      generation: 1,
      type: 'failed',
      stage: 'capture',
      code: 'OCR_TIMEOUT',
    })).toBeUndefined()
    expect(parseScreenshotTranslationEvent({
      sessionId: SESSION_ID,
      generation: 1,
      type: 'ocr-started',
      tier: 'small',
      extra: true,
    })).toBeUndefined()
  })

  it('accepts only bounded cumulative document translation progress', () => {
    const progress = {
      sessionId: SESSION_ID,
      generation: 4,
      type: 'document-translation-progress' as const,
      text: '第一段译文',
      completedChunks: 0,
      totalChunks: 2,
    }
    expect(parseScreenshotTranslationEvent(progress)).toEqual(progress)
    expect(parseScreenshotTranslationEvent({
      sessionId: SESSION_ID,
      generation: 4,
      type: 'document-translation-completed',
      text: '完整译文',
    })).toEqual({
      sessionId: SESSION_ID,
      generation: 4,
      type: 'document-translation-completed',
      text: '完整译文',
    })
    for (const invalid of [
      { ...progress, completedChunks: 3 },
      { ...progress, totalChunks: 0 },
      { ...progress, text: '' },
      { ...progress, text: 'e\u0301' },
      { ...progress, text: 'bad\u0001' },
      { ...progress, text: '\ud800' },
      { ...progress, extra: true },
    ]) expect(parseScreenshotTranslationEvent(invalid)).toBeUndefined()
  })

  it('accepts translations at the text boundary and rejects a longer mapping', () => {
    expect(parseScreenshotTranslationEvent({
      sessionId: SESSION_ID,
      generation: 1,
      type: 'translation-completed',
      translations: [{ id: 'line-1', text: 't'.repeat(16_384) }],
    })).toBeDefined()
    expect(parseScreenshotTranslationEvent({
      sessionId: SESSION_ID,
      generation: 1,
      type: 'translation-completed',
      translations: [{ id: 'line-1', text: 't'.repeat(16_385) }],
    })).toBeUndefined()
  })

  it('enforces total translated character and UTF-8 byte limits across blocks', () => {
    const event = (translations: Array<{ id: string; text: string }>) => ({
      sessionId: SESSION_ID,
      generation: 1,
      type: 'translation-completed' as const,
      translations,
    })
    const ascii = Array.from({ length: 128 }, (_, index) => ({
      id: `line-${index + 1}`,
      text: 'a'.repeat(16_384),
    }))
    expect(parseScreenshotTranslationEvent(event(ascii))).toBeDefined()
    expect(parseScreenshotTranslationEvent(event([
      ...ascii,
      { id: 'line-129', text: 'x' },
    ]))).toBeUndefined()

    const multibyte = Array.from({ length: 43 }, (_, index) => ({
      id: `line-${index + 1}`,
      text: '汉'.repeat(16_384),
    }))
    expect(multibyte.reduce((sum, item) => sum + item.text.length, 0))
      .toBeLessThan(SCREENSHOT_TRANSLATED_TEXT_TOTAL_MAX_LENGTH)
    expect(parseScreenshotTranslationEvent(event(multibyte))).toBeUndefined()
  })

  it('clips trusted inverted UI rectangles to their bounds', () => {
    expect(clipRectToBounds(
      { x: 80, y: 70, width: -60, height: -50 },
      { x: 0, y: 0, width: 100, height: 100 },
    )).toEqual({ x: 20, y: 20, width: 60, height: 50 })
  })

  it('converts negative-origin DIP crops to every touched physical pixel', () => {
    expect(cropDipToPixels({ x: -1200, y: 100, width: 400, height: 200 }, DISPLAY_125)).toEqual({
      x: 0, y: 125, width: 500, height: 250,
    })
    expect(cropDipToPixels({ x: -1199.6, y: 0.1, width: 1, height: 1 }, DISPLAY_125)).toEqual({
      x: 0, y: 0, width: 2, height: 2,
    })
  })

  it('clips crops to the actual screenshot dimensions after scaling drift', () => {
    expect(cropDipToPixels(
      { x: -10, y: 10, width: 100, height: 100 },
      { ...DISPLAY_125, boundsDip: { x: -10, y: 0, width: 100, height: 100 }, imageSizePx: { width: 120, height: 120 } },
    )).toEqual({ x: 0, y: 12, width: 120, height: 108 })
  })
})
