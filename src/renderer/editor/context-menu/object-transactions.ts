import { getMarkRange } from '@milkdown/kit/prose'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import { documentTypeForPath } from '../../../shared/document-types'
import { isWindowsAbsolutePath } from '../../../shared/local-resource-path'
import { serializeLocalImage } from '../local-media-view'

export interface ObjectCommandView {
  readonly state: EditorState
  dispatch(transaction: Transaction): void
}

type ImageSyntax = 'markdown' | 'html'

function safeEditedLink(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (isWindowsAbsolutePath(trimmed)) return true
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase()
  if (!scheme) return true
  if (scheme !== 'http' && scheme !== 'https') return false
  try {
    const parsed = new URL(trimmed)
    return parsed.username === '' && parsed.password === ''
  } catch {
    return false
  }
}

function imageNodeAt(
  view: ObjectCommandView,
  position: number,
): { node: ReturnType<EditorState['doc']['nodeAt']> & {}; position: number } | null {
  const candidates = [position, position - 1, position + 1]
  for (const candidate of candidates) {
    if (candidate < 0 || candidate > view.state.doc.content.size) continue
    const node = view.state.doc.nodeAt(candidate)
    if (node && (node.type.name === 'image' || node.type.name === 'html')) {
      return { node, position: candidate }
    }
  }
  return null
}

export function replaceImageSyntaxAtPosition(
  view: ObjectCommandView,
  position: number,
  syntax: ImageSyntax,
  source: string,
  alt: string,
  zoom: number | null,
): boolean {
  if (
    !isWindowsAbsolutePath(source)
    || documentTypeForPath(source)?.category !== 'image'
    || alt.length > 4096
  ) return false
  const target = imageNodeAt(view, position)
  if (!target) return false
  if (
    (syntax === 'markdown' && target.node.type.name === 'image')
    || (syntax === 'html' && target.node.type.name === 'html')
  ) return true

  const type = view.state.schema.nodes[syntax === 'markdown' ? 'image' : 'html']
  if (!type) return false
  const replacement = syntax === 'markdown'
    ? type.create({ src: source, alt, title: alt })
    : type.create({
        value: serializeLocalImage({ source, alt, zoom }),
      })
  view.dispatch(view.state.tr.replaceWith(
    target.position,
    target.position + target.node.nodeSize,
    replacement,
  ).scrollIntoView())
  return true
}

export function deleteImageAtPosition(
  view: ObjectCommandView,
  position: number,
): boolean {
  const target = imageNodeAt(view, position)
  if (!target) return false
  view.dispatch(view.state.tr.delete(
    target.position,
    target.position + target.node.nodeSize,
  ).scrollIntoView())
  return true
}

export function updateLinkAtPosition(
  view: ObjectCommandView,
  position: number,
  nextHref: string | null,
): boolean {
  const type = view.state.schema.marks.link
  if (!type || position < 0 || position > view.state.doc.content.size) return false
  const range = getMarkRange(view.state.doc.resolve(position), type)
  if (!range) return false

  const transaction = view.state.tr.removeMark(range.from, range.to, range.mark)
  if (nextHref !== null) {
    const href = nextHref.trim()
    if (!safeEditedLink(href)) return false
    transaction.addMark(
      range.from,
      range.to,
      type.create({ ...range.mark.attrs, href }),
    )
  }
  view.dispatch(transaction.scrollIntoView())
  return true
}
