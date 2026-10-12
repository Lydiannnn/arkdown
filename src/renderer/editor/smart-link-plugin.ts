import { getMarkRange } from '@milkdown/kit/prose'
import type { Mark, Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import {
  normalizeAutomaticLinkText,
  parseLinkTarget,
  type LinkTarget,
} from '../../shared/link-target'

function targetValue(target: LinkTarget): string {
  return target.kind === 'web' ? target.url : target.path
}

function sameTarget(left: LinkTarget | null, right: LinkTarget | null): boolean {
  return left !== null
    && right !== null
    && left.kind === right.kind
    && targetValue(left) === targetValue(right)
}

function typedCandidate(doc: ProseMirrorNode, position: number): {
  from: number
  text: string
  target: LinkTarget
} | null {
  const resolved = doc.resolve(position)
  if (!resolved.parent.isTextblock) return null
  const before = resolved.parent.textBetween(0, resolved.parentOffset, '\0', '\0')
  const match = /"[^"\n\0]+"$/.exec(before) ?? /[^\s"\n\0]+$/.exec(before)
  if (!match) return null
  const target = normalizeAutomaticLinkText(match[0])
  return target ? { from: position - match[0].length, text: match[0], target } : null
}

function linkMarkAt(doc: ProseMirrorNode, position: number, type: Mark['type']) {
  const safe = Math.max(0, Math.min(position, doc.content.size))
  return getMarkRange(doc.resolve(safe), type)
    ?? (safe > 0 ? getMarkRange(doc.resolve(safe - 1), type) : null)
    ?? (safe < doc.content.size ? getMarkRange(doc.resolve(safe + 1), type) : null)
}

function manualLinkMarkCovering(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  type: Mark['type'],
): Mark | null {
  if (from >= to) return null
  const range = linkMarkAt(doc, Math.min(to, from + 1), type)
  if (!range || range.from > from || range.to < to) return null
  const label = doc.textBetween(range.from, range.to, '\n')
  return sameTarget(
    normalizeAutomaticLinkText(label),
    parseLinkTarget(range.mark.attrs.href),
  ) ? null : range.mark
}

function mappedAutomaticLinkRanges(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  previousMark: Mark,
): Array<NonNullable<ReturnType<typeof getMarkRange>>> {
  if (from >= to) return []
  const found: Array<NonNullable<ReturnType<typeof getMarkRange>>> = []
  const seen = new Set<string>()
  doc.nodesBetween(from, to, (node, position) => {
    if (!node.isText || !previousMark.isInSet(node.marks)) return
    const range = linkMarkAt(doc, position + 1, previousMark.type)
    if (
      range
      && range.mark.eq(previousMark)
      && range.from < to
      && range.to > from
    ) {
      const key = `${range.from}:${range.to}`
      if (!seen.has(key)) {
        seen.add(key)
        found.push(range)
      }
    }
  })
  return found
}

function automaticLinkRanges(doc: ProseMirrorNode, type: Mark['type']) {
  const ranges: Array<{ from: number; to: number; mark: Mark }> = []
  const seen = new Set<string>()
  doc.descendants((node, position) => {
    if (!node.isText || !type.isInSet(node.marks)) return
    const range = linkMarkAt(doc, position + 1, type)
    if (!range) return
    const key = `${range.from}:${range.to}`
    if (seen.has(key)) return
    seen.add(key)
    const label = doc.textBetween(range.from, range.to, '\n')
    if (sameTarget(normalizeAutomaticLinkText(label), parseLinkTarget(range.mark.attrs.href))) {
      ranges.push(range)
    }
  })
  return ranges
}

export function applyManualLink(
  view: Pick<EditorView, 'state' | 'dispatch'>,
  from: number,
  to: number,
  href: string,
): boolean {
  const type = view.state.schema.marks.link
  const target = parseLinkTarget(href.trim())
  if (!type || !target || from >= to || from < 0 || to > view.state.doc.content.size) return false
  const transaction = view.state.tr
    .removeMark(from, to, type)
    .addMark(from, to, type.create({ href: targetValue(target), title: null }))
  view.dispatch(transaction
    .setSelection(TextSelection.create(transaction.doc, to))
    .removeStoredMark(type)
    .scrollIntoView())
  return true
}

export function recognizeAutomaticLinkAtCursor(
  view: Pick<EditorView, 'state' | 'dispatch'>,
): boolean {
  if (!view.state.selection.empty) return false
  const position = view.state.selection.from
  const candidate = typedCandidate(view.state.doc, position)
  const type = view.state.schema.marks.link
  if (!candidate || !type) return false
  const manualMark = manualLinkMarkCovering(
    view.state.doc,
    candidate.from,
    position,
    type,
  )
  let transaction = view.state.tr
  if (!manualMark) {
    transaction = transaction.addMark(candidate.from, position, type.create({
      href: targetValue(candidate.target),
      title: null,
    }))
  }
  view.dispatch(transaction.removeStoredMark(type))
  return true
}

export function createSmartLinkPlugin(): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        if (text !== ' ' || from !== to) return false
        const candidate = typedCandidate(view.state.doc, from)
        const type = view.state.schema.marks.link
        if (!candidate || !type) return false
        const manualMark = manualLinkMarkCovering(
          view.state.doc,
          candidate.from,
          from,
          type,
        )
        let transaction = view.state.tr
        if (!manualMark) {
          transaction = transaction.addMark(candidate.from, from, type.create({
            href: targetValue(candidate.target),
            title: null,
          }))
        }
        transaction = transaction
          .insertText(text, from, to)
          .removeMark(from, from + text.length, type)
          .removeStoredMark(type)
          .scrollIntoView()
        view.dispatch(transaction)
        return true
      },
      handleKeyDown(view, event) {
        if (
          event.key !== 'Enter'
          || event.metaKey
          || event.altKey
          || event.shiftKey
          || event.isComposing
          || !view.state.selection.empty
        ) return false
        recognizeAutomaticLinkAtCursor(view)
        return false
      },
      handlePaste(view, event) {
        const clipboard = event.clipboardData
        if (!clipboard || clipboard.types.includes('text/html')) return false
        const text = clipboard.getData('text/plain')
        const target = parseLinkTarget(text) ?? normalizeAutomaticLinkText(text)
        const type = view.state.schema.marks.link
        if (!text || !target || !type) return false
        const linkedText = view.state.schema.text(text, [type.create({
          href: targetValue(target),
          title: null,
        })])
        view.dispatch(view.state.tr.replaceSelectionWith(linkedText, false).scrollIntoView())
        return true
      },
    },
    appendTransaction(transactions, oldState, newState) {
      if (!transactions.some((transaction) => transaction.docChanged)) return null
      const type = newState.schema.marks.link
      if (!type) return null
      const automatic = automaticLinkRanges(oldState.doc, type)
      if (!automatic.length) return null

      let transaction = newState.tr
      let changed = false
      for (const previous of automatic) {
        let from = previous.from
        let to = previous.to
        for (const applied of transactions) {
          from = applied.mapping.map(from, -1)
          to = applied.mapping.map(to, 1)
        }
        const currentRanges = mappedAutomaticLinkRanges(
          newState.doc,
          from,
          to,
          previous.mark,
        )
        for (const current of currentRanges) {
          const label = newState.doc.textBetween(current.from, current.to, '\n')
          const target = normalizeAutomaticLinkText(label)
          if (!target) {
            transaction = transaction.removeMark(current.from, current.to, current.mark)
            changed = true
            continue
          }
          const nextHref = targetValue(target)
          if (!sameTarget(target, parseLinkTarget(current.mark.attrs.href))) {
            transaction = transaction
              .removeMark(current.from, current.to, current.mark)
              .addMark(current.from, current.to, type.create({
                ...current.mark.attrs,
                href: nextHref,
              }))
            changed = true
          }
        }
      }
      return changed ? transaction : null
    },
  })
}
