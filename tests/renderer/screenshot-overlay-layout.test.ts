import { expect, it, vi } from 'vitest'
import {
  computeScreenshotOverlayLayout,
  fitScreenshotOverlayText,
} from '../../src/renderer/screenshot/screenshot-overlay-layout'
import type { ScreenshotOcrBlock } from '../../src/shared/screenshot-translation'

const block = (overrides: Partial<ScreenshotOcrBlock> = {}): ScreenshotOcrBlock => ({
  id: 'line-1',
  text: 'source',
  rectPx: { x: 100, y: 50, width: 200, height: 50 },
  words: [
    { text: 'source', rectPx: { x: 100, y: 50, width: 90, height: 20 } },
    { text: 'source', rectPx: { x: 100, y: 80, width: 200, height: 20 } },
  ],
  ...overrides,
})

function layout(text = 'translated', options: Record<string, unknown> = {}) {
  return computeScreenshotOverlayLayout({
    imageSizePx: { width: 400, height: 200 },
    containerRectCss: { x: 0, y: 0, width: 400, height: 400 },
    blocks: [block()],
    translations: [{ id: 'line-1', text }],
    devicePixelRatio: 1,
    ...options,
  })
}

it('maps physical OCR rectangles through object-fit contain letterboxing', () => {
  const result = layout()
  expect(result.imageRectCss).toEqual({ x: 0, y: 100, width: 400, height: 200 })
  expect(result.blocks[0]?.rectCss).toEqual({ x: 100, y: 150, width: 200, height: 50 })
})

it.each([1, 1.25, 1.5, 2])('keeps CSS overlay coordinates invariant at DPR %s', (devicePixelRatio) => {
  expect(layout('translated', { devicePixelRatio })).toEqual(layout('translated', { devicePixelRatio: 1 }))
})

it('accounts for a visible sidebar before fitting the image', () => {
  const result = layout('translated', {
    containerRectCss: { x: 20, y: 10, width: 800, height: 400 },
    sidebarWidthCss: 320,
  })
  expect(result.imageRectCss).toEqual({ x: 20, y: 90, width: 480, height: 240 })
})

it('rejects zero, non-finite, or impossible layout dimensions safely', () => {
  expect(layout('translated', { containerRectCss: { x: 0, y: 0, width: 0, height: 400 } }).blocks).toEqual([])
  expect(layout('translated', { imageSizePx: { width: Number.NaN, height: 200 } }).blocks).toEqual([])
  expect(layout('translated', { devicePixelRatio: 0 }).blocks).toEqual([])
})

it('distinguishes original-size, wrapped, shrunk-to-minimum, and unfit translations', () => {
  expect(layout('短句').blocks[0]?.fit).toBe('original-size')
  expect(layout('这是一个需要换行显示的中文翻译文本').blocks[0]?.fit).toBe('wrapped')
  expect(layout('a somewhat longer translated sentence that must shrink').blocks[0]?.fit).toBe('shrunk')
  const atMinimum = layout('W'.repeat(58)).blocks[0]
  expect(atMinimum?.fit).toBe('shrunk')
  expect(atMinimum?.fontSizeCss).toBeGreaterThanOrEqual(10)
  expect(layout('W'.repeat(500)).blocks[0]?.fit).toBe('unfit')
})

it('marks a long unbreakable LTR token unfit instead of hiding its source block', () => {
  const result = layout('https://example.invalid/' + 'x'.repeat(500))
  expect(result.blocks[0]).toMatchObject({ id: 'line-1', fit: 'unfit' })
})

it('precomputes a 16 KiB translation once and uses bounded fit probes', () => {
  const measureUnits = vi.fn((text: string) => text.length * 0.56)
  const result = fitScreenshotOverlayText('a'.repeat(16 * 1024), {
    x: 0, y: 0, width: 400, height: 3_000,
  }, 40, measureUnits)
  expect(measureUnits).toHaveBeenCalledOnce()
  expect(result.probes).toBeLessThanOrEqual(18)
  expect(result.fit).toBe('shrunk')
})

it.each([0.01, 0.25, 1, 2])('retains every nonempty overlapping block at image scale %s', (scale) => {
  const sourceBlocks = [
    block(),
    block({ id: 'overlap', rectPx: { x: 100, y: 50, width: 1, height: 1 } }),
    block({ id: 'empty' }),
    block({ id: 'outside', rectPx: { x: 399, y: 50, width: 2, height: 1 } }),
  ]
  const result = layout('unused', {
    containerRectCss: { x: 0, y: 0, width: 400 * scale, height: 200 * scale },
    blocks: sourceBlocks,
    translations: [
      { id: 'line-1', text: 'x'.repeat(16 * 1024) },
      { id: 'overlap', text: '译文' },
      { id: 'empty', text: '' },
      { id: 'outside', text: 'invalid bounds' },
    ],
  })
  expect(result.blocks.map(({ id }) => id)).toEqual(['line-1', 'overlap'])
  expect(result.blocks[0]?.text).toHaveLength(16 * 1024)
  expect(result.blocks[1]?.rectCss).toEqual({ x: 100 * scale, y: 50 * scale, width: scale, height: scale })
})
