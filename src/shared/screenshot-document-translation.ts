import type { ScreenshotOcrBlock } from './screenshot-translation'

export type ScreenshotTranslationDisplayMode = 'overlay' | 'document'

export const SCREENSHOT_DOCUMENT_CHARACTER_THRESHOLD = 600
export const SCREENSHOT_DOCUMENT_BLOCK_THRESHOLD = 12
export const SCREENSHOT_DOCUMENT_BLOCK_CHARACTER_THRESHOLD = 240
export const SCREENSHOT_DOCUMENT_CHUNK_MAX_BYTES = 16 * 1024

const encoder = new TextEncoder()

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength
}

export function selectScreenshotTranslationDisplayMode(
  blocks: readonly Pick<ScreenshotOcrBlock, 'text'>[],
): ScreenshotTranslationDisplayMode {
  const characters = blocks.reduce((total, block) => total + block.text.length, 0)
  return characters >= SCREENSHOT_DOCUMENT_CHARACTER_THRESHOLD
    || (blocks.length >= SCREENSHOT_DOCUMENT_BLOCK_THRESHOLD
      && characters >= SCREENSHOT_DOCUMENT_BLOCK_CHARACTER_THRESHOLD)
    ? 'document'
    : 'overlay'
}

function splitUtf8Segment(segment: string, maxBytes: number): readonly string[] {
  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  for (const codePoint of segment) {
    const codePointBytes = utf8Bytes(codePoint)
    if (codePointBytes > maxBytes) throw new RangeError('Document chunk limit is too small')
    if (currentBytes + codePointBytes > maxBytes) {
      chunks.push(current)
      current = ''
      currentBytes = 0
    }
    current += codePoint
    currentBytes += codePointBytes
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export function buildScreenshotDocumentChunks(
  blocks: readonly Pick<ScreenshotOcrBlock, 'text'>[],
  maxBytes = SCREENSHOT_DOCUMENT_CHUNK_MAX_BYTES,
): readonly string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('Document chunk limit must be a positive safe integer')
  }
  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  for (let index = 0; index < blocks.length; index += 1) {
    const segment = `${index === 0 ? '' : '\n'}${blocks[index]!.text}`
    const segmentBytes = utf8Bytes(segment)
    if (currentBytes + segmentBytes <= maxBytes) {
      current += segment
      currentBytes += segmentBytes
      continue
    }
    if (current.length > 0) {
      chunks.push(current)
      current = ''
      currentBytes = 0
    }
    if (segmentBytes <= maxBytes) {
      current = segment
      currentBytes = segmentBytes
      continue
    }
    const split = splitUtf8Segment(segment, maxBytes)
    chunks.push(...split.slice(0, -1))
    current = split.at(-1) ?? ''
    currentBytes = utf8Bytes(current)
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}
