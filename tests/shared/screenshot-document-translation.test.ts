import { expect, it } from 'vitest'
import type { ScreenshotOcrBlock } from '../../src/shared/screenshot-translation'
import {
  buildScreenshotDocumentChunks,
  selectScreenshotTranslationDisplayMode,
} from '../../src/shared/screenshot-document-translation'

function block(id: number, text: string): ScreenshotOcrBlock {
  return {
    id: `line-${id}`,
    text,
    rectPx: { x: 0, y: id, width: 10, height: 1 },
    words: [{ text, rectPx: { x: 0, y: id, width: 10, height: 1 } }],
  }
}

it('locks document mode at the literal 600-character and 12-block/240-character boundaries', () => {
  expect(selectScreenshotTranslationDisplayMode([block(1, 'a'.repeat(599))])).toBe('overlay')
  expect(selectScreenshotTranslationDisplayMode([block(1, 'a'.repeat(600))])).toBe('document')

  const blocksAt = (length: number) => Array.from(
    { length: 12 },
    (_, index) => block(index + 1, 'b'.repeat(index === 11 ? length - 11 : 1)),
  )
  expect(selectScreenshotTranslationDisplayMode(blocksAt(239))).toBe('overlay')
  expect(selectScreenshotTranslationDisplayMode(blocksAt(240))).toBe('document')
})

it('preserves reading order and bounds every document chunk by exact UTF-8 bytes', () => {
  const blocks = [
    block(1, 'first paragraph'),
    block(2, '汉'.repeat(7)),
    block(3, 'last paragraph'),
  ]

  const chunks = buildScreenshotDocumentChunks(blocks, 24)

  expect(chunks.join('')).toBe('first paragraph\n汉汉汉汉汉汉汉\nlast paragraph')
  expect(chunks.every((chunk) => chunk.length > 0)).toBe(true)
  expect(chunks.map((chunk) => new TextEncoder().encode(chunk).byteLength))
    .toEqual([15, 22, 15])
})

it('splits one oversized OCR block only at Unicode code-point boundaries', () => {
  const source = `A${'😀'.repeat(5)}Z`

  const chunks = buildScreenshotDocumentChunks([block(1, source)], 9)

  expect(chunks.join('')).toBe(source)
  expect(chunks).toEqual(['A😀😀', '😀😀', '😀Z'])
  expect(chunks.every((chunk) => !/[\ud800-\udbff]$/u.test(chunk))).toBe(true)
})
