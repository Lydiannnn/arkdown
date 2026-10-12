import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import type { Transaction } from '@milkdown/kit/prose/state'
import type {
  TranslationAnchorFingerprint,
  TranslationHistoryAnchor,
} from './translation-history'

export const TRANSLATION_ANCHOR_FINGERPRINT_LIMIT = 32

function boundedText(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): string {
  const start = Math.max(0, Math.min(doc.content.size, from))
  const end = Math.max(start, Math.min(doc.content.size, to))
  return doc.textBetween(start, end, '\n', '\n')
}

function visualFingerprint(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): TranslationAnchorFingerprint {
  return {
    before: boundedText(doc, from - TRANSLATION_ANCHOR_FINGERPRINT_LIMIT, from),
    selected: boundedText(doc, from, to),
    after: boundedText(doc, to, to + TRANSLATION_ANCHOR_FINGERPRINT_LIMIT),
  }
}

function outerBlockStart(doc: ProseMirrorNode, position: number): number {
  const resolved = doc.resolve(Math.max(0, Math.min(doc.content.size, position)))
  return resolved.depth > 0 ? resolved.before(1) : 0
}

export function createVisualTranslationHistoryAnchor(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): Extract<TranslationHistoryAnchor, { mode: 'visual' }> {
  const start = Math.max(0, Math.min(doc.content.size, Math.min(from, to)))
  const end = Math.max(start, Math.min(doc.content.size, Math.max(from, to)))
  return {
    mode: 'visual',
    from: start,
    to: end,
    blockStart: outerBlockStart(doc, start),
    fingerprint: visualFingerprint(doc, start, end),
    status: 'valid',
  }
}

export function matchesVisualTranslationAnchorFingerprint(
  doc: ProseMirrorNode,
  anchor: Extract<TranslationHistoryAnchor, { mode: 'visual' }>,
): boolean {
  if (
    anchor.status !== 'valid'
    || anchor.from < 0
    || anchor.to <= anchor.from
    || anchor.to > doc.content.size
  ) return false
  const current = visualFingerprint(doc, anchor.from, anchor.to)
  return current.before === anchor.fingerprint.before
    && current.selected === anchor.fingerprint.selected
    && current.after === anchor.fingerprint.after
}

export function mapVisualTranslationHistoryAnchor(
  anchor: Extract<TranslationHistoryAnchor, { mode: 'visual' }>,
  transaction: Transaction,
): Extract<TranslationHistoryAnchor, { mode: 'visual' }> {
  let from = anchor.from
  let to = anchor.to
  let blockStart = anchor.blockStart
  let deletedThrough = anchor.status === 'location-changed'
    || !matchesVisualTranslationAnchorFingerprint(transaction.before, anchor)

  for (const stepMap of transaction.mapping.maps) {
    stepMap.forEach((oldStart, oldEnd) => {
      if (oldEnd > oldStart && oldStart < to && oldEnd > from) deletedThrough = true
    })
    from = stepMap.map(from, 1)
    to = stepMap.map(to, -1)
    blockStart = stepMap.map(blockStart, -1)
  }

  const safeFrom = Math.max(0, Math.min(transaction.doc.content.size, from))
  const safeTo = Math.max(safeFrom, Math.min(transaction.doc.content.size, to))
  const status = deletedThrough || safeFrom === safeTo ? 'location-changed' : 'valid'
  return {
    ...anchor,
    from: safeFrom,
    to: safeTo,
    blockStart: status === 'valid'
      ? outerBlockStart(transaction.doc, safeFrom)
      : Math.max(0, Math.min(transaction.doc.content.size, blockStart)),
    fingerprint: status === 'valid'
      ? visualFingerprint(transaction.doc, safeFrom, safeTo)
      : anchor.fingerprint,
    status,
  }
}
