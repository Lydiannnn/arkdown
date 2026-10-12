import { TextSelection } from '@milkdown/kit/prose/state'
import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

const LINE_SCOPE_SELECTOR = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
  'pre',
  'td',
  'th',
  'figcaption',
].join(',')

const NON_TEXT_SURFACE_SELECTOR = [
  '.cm-editor',
  '[contenteditable="false"]',
  'button',
  'input',
  'textarea',
  'select',
].join(',')

const INTERACTIVE_TARGET_SELECTOR = [
  '.cm-editor',
  '[contenteditable="false"]',
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
].join(',')

const HARD_BREAK_SELECTOR = [
  'br:not(.ProseMirror-trailingBreak)',
  'span[data-type="hardbreak"][data-is-inline="true"]',
].join(',')

const INLINE_ATOM_SELECTOR = [
  'img',
  '[contenteditable="false"]',
].join(',')

const LINE_Y_TOLERANCE_PX = 1
const LINE_END_X_TOLERANCE_PX = 0.5
const SHORT_CLICK_MAX_DISTANCE_PX = 4

export type CharacterRectMeasurer = (text: Text, index: number) => DOMRect | null
export type TextFragmentMeasurer = (text: Text) => readonly DOMRect[]
export type ElementFragmentMeasurer = (element: Element) => readonly DOMRect[]

export interface RenderedLineEndInput {
  root: HTMLElement
  target: EventTarget | null
  clientX: number
  clientY: number
  posAtDOM(node: Node, offset: number, bias?: number): number
  measureCharacter?: CharacterRectMeasurer
  measureTextFragments?: TextFragmentMeasurer
  measureElementFragments?: ElementFragmentMeasurer
}

function defaultCharacterRect(text: Text, index: number): DOMRect | null {
  try {
    const range = text.ownerDocument.createRange()
    range.setStart(text, index)
    range.setEnd(text, index + 1)
    return Array.from(range.getClientRects()).at(0) ?? null
  } catch {
    return null
  }
}

function defaultTextFragments(text: Text): readonly DOMRect[] {
  try {
    const range = text.ownerDocument.createRange()
    range.selectNodeContents(text)
    return Array.from(range.getClientRects())
  } catch {
    return []
  }
}

function defaultElementFragments(element: Element): readonly DOMRect[] {
  try {
    return Array.from(element.getClientRects())
  } catch {
    return []
  }
}

function elementForTarget(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target
  return target instanceof Node ? target.parentElement : null
}

function lineScope(root: HTMLElement, target: EventTarget | null): Element | null {
  const candidate = elementForTarget(target)?.closest(LINE_SCOPE_SELECTOR)
  return candidate && candidate !== root && root.contains(candidate) ? candidate : null
}

function isInteractiveTarget(root: HTMLElement, target: EventTarget | null): boolean {
  const interactive = elementForTarget(target)?.closest(INTERACTIVE_TARGET_SELECTOR)
  return Boolean(interactive && root.contains(interactive))
}

function isEditorTextNode(root: HTMLElement, node: Text): boolean {
  if (!node.data.length || !root.contains(node)) return false
  const parent = node.parentElement
  return !parent?.closest(NON_TEXT_SURFACE_SELECTOR)
}

function textNodesWithin(scope: Element): Text[] {
  const ownerDocument = scope.ownerDocument
  const showText = ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4
  const walker = ownerDocument.createTreeWalker(scope, showText)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) nodes.push(node as Text)
  }
  return nodes
}

function rectContainsRow(rect: DOMRect, clientY: number): boolean {
  return clientY >= rect.top - LINE_Y_TOLERANCE_PX
    && clientY <= rect.bottom + LINE_Y_TOLERANCE_PX
}

function hasMeasurableBounds(rect: DOMRect): boolean {
  return rect.width > 0 || rect.height > 0
}

function isRowAbovePointer(rect: DOMRect, clientY: number): boolean {
  return rect.bottom < clientY - LINE_Y_TOLERANCE_PX
}

interface TextRowEnd {
  offset: number
  right: number
}

function findLastCharacterOnRow(
  text: Text,
  clientY: number,
  right: number,
  measureCharacter: CharacterRectMeasurer,
): TextRowEnd | null {
  let low = 0
  let high = text.data.length - 1
  let lastIndex = -1

  while (low <= high) {
    const index = Math.floor((low + high) / 2)
    const rect = measureCharacter(text, index)
    if (!rect) {
      high = index - 1
      continue
    }
    if (rectContainsRow(rect, clientY)) {
      lastIndex = index
      low = index + 1
    } else if (isRowAbovePointer(rect, clientY)) {
      low = index + 1
    } else {
      high = index - 1
    }
  }

  return lastIndex >= 0 ? { offset: lastIndex + 1, right } : null
}

function findLastCharacterLinearly(
  text: Text,
  clientY: number,
  measureCharacter: CharacterRectMeasurer,
): TextRowEnd | null {
  let result: TextRowEnd | null = null
  for (let index = 0; index < text.data.length; index += 1) {
    const rect = measureCharacter(text, index)
    if (!rect || !rectContainsRow(rect, clientY)) continue
    if (!result || rect.right >= result.right) {
      result = { offset: index + 1, right: rect.right }
    }
  }
  return result
}

function textRowEnd(
  text: Text,
  clientY: number,
  measureCharacter: CharacterRectMeasurer,
  measureTextFragments: TextFragmentMeasurer,
): TextRowEnd | null {
  const rowFragments = measureTextFragments(text)
    .filter((fragment) => rectContainsRow(fragment, clientY))
  if (!rowFragments.length) {
    // Character measurers are injected by geometry unit tests. The production
    // path always obtains the whole text node's row fragments in one layout read.
    return measureTextFragments === defaultTextFragments
      && measureCharacter !== defaultCharacterRect
      ? findLastCharacterLinearly(text, clientY, measureCharacter)
      : null
  }
  const right = Math.max(...rowFragments.map((fragment) => fragment.right))
  return findLastCharacterOnRow(text, clientY, right, measureCharacter)
}

interface DomRowEnd {
  node: Node
  offset: number
  right: number
}

function updateRightmost(current: DomRowEnd | null, candidate: DomRowEnd): DomRowEnd {
  return !current || candidate.right >= current.right ? candidate : current
}

function childOffset(element: Element): { parent: Node; index: number } | null {
  const parent = element.parentNode
  if (!parent) return null
  const index = Array.prototype.indexOf.call(parent.childNodes, element) as number
  return index >= 0 ? { parent, index } : null
}

function structuralElementsWithin(scope: Element): Element[] {
  const selector = `${HARD_BREAK_SELECTOR},${INLINE_ATOM_SELECTOR}`
  return Array.from(scope.querySelectorAll(selector)).filter((element) => {
    if (element.matches(HARD_BREAK_SELECTOR)) return true
    const containingAtom = element.parentElement?.closest('[contenteditable="false"]')
    return !containingAtom || !scope.contains(containingAtom)
  })
}

function scopeContainsEditableContent(root: HTMLElement, scope: Element): boolean {
  return textNodesWithin(scope).some((text) => isEditorTextNode(root, text))
    || structuralElementsWithin(scope).length > 0
}

/**
 * Resolves the last editable position on the rendered row under the pointer.
 * A whole-text Range first identifies the row fragment, then a binary search
 * locates that fragment's final DOM offset without measuring every UTF-16 unit.
 */
export function resolveRenderedLineEndPosition({
  root,
  target,
  clientX,
  clientY,
  posAtDOM,
  measureCharacter = defaultCharacterRect,
  measureTextFragments = defaultTextFragments,
  measureElementFragments = defaultElementFragments,
}: RenderedLineEndInput): number | null {
  if (isInteractiveTarget(root, target)) return null
  const scope = lineScope(root, target)
  if (!scope) return null

  const scopeRect = scope.getBoundingClientRect()
  if (hasMeasurableBounds(scopeRect) && !rectContainsRow(scopeRect, clientY)) return null

  let rightmost: DomRowEnd | null = null
  for (const text of textNodesWithin(scope)) {
    if (!isEditorTextNode(root, text)) continue
    const rowEnd = textRowEnd(text, clientY, measureCharacter, measureTextFragments)
    if (rowEnd) {
      rightmost = updateRightmost(rightmost, {
        node: text,
        offset: rowEnd.offset,
        right: rowEnd.right,
      })
    }
  }

  for (const element of structuralElementsWithin(scope)) {
    const rowFragments = measureElementFragments(element)
      .filter((fragment) => rectContainsRow(fragment, clientY))
    if (!rowFragments.length) continue
    const position = childOffset(element)
    if (!position) continue
    const offset = position.index + (element.matches(HARD_BREAK_SELECTOR) ? 0 : 1)
    rightmost = updateRightmost(rightmost, {
      node: position.parent,
      offset,
      right: Math.max(...rowFragments.map((fragment) => fragment.right)),
    })
  }

  if (!rightmost && !scopeContainsEditableContent(root, scope)) {
    if (hasMeasurableBounds(scopeRect)
      && clientX >= scopeRect.left - LINE_END_X_TOLERANCE_PX) {
      try {
        return posAtDOM(scope, 0, 1)
      } catch {
        return null
      }
    }
    return null
  }

  if (!rightmost || clientX < rightmost.right - LINE_END_X_TOLERANCE_PX) return null
  try {
    return posAtDOM(rightmost.node, rightmost.offset, 1)
  } catch {
    return null
  }
}

interface PendingLineEndClick {
  clientX: number
  clientY: number
  target: EventTarget | null
  maximumDistance: number
}

function isPlainPrimaryClick(event: MouseEvent): boolean {
  return event.button === 0
    && event.detail <= 1
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey
}

function selectionWithin(root: HTMLElement): Selection | null {
  const selection = root.ownerDocument.defaultView?.getSelection() ?? null
  if (!selection || selection.isCollapsed) return null
  const anchorInside = selection.anchorNode && root.contains(selection.anchorNode)
  const focusInside = selection.focusNode && root.contains(selection.focusNode)
  return anchorInside || focusInside ? selection : null
}

export interface VisualLineEndCaretPluginOptions {
  resolvePosition?: (input: RenderedLineEndInput) => number | null
}

export function createVisualLineEndCaretPlugin({
  resolvePosition = resolveRenderedLineEndPosition,
}: VisualLineEndCaretPluginOptions = {}): Plugin {
  let pending: PendingLineEndClick | null = null

  const updateMaximumDistance = (event: MouseEvent) => {
    if (!pending) return
    pending.maximumDistance = Math.max(
      pending.maximumDistance,
      Math.hypot(event.clientX - pending.clientX, event.clientY - pending.clientY),
    )
  }

  return new Plugin({
    props: {
      handleDOMEvents: {
        mousedown: (view: EditorView, event: Event) => {
          if (!(event instanceof MouseEvent)
            || !isPlainPrimaryClick(event)
            || view.composing
            || isInteractiveTarget(view.dom, event.target)) {
            pending = null
            return false
          }
          pending = {
            clientX: event.clientX,
            clientY: event.clientY,
            target: event.target,
            maximumDistance: 0,
          }
          return false
        },
        mousemove: (_view: EditorView, event: Event) => {
          if (event instanceof MouseEvent) updateMaximumDistance(event)
          return false
        },
        mouseleave: () => {
          if (pending) pending.maximumDistance = Number.POSITIVE_INFINITY
          return false
        },
        mouseup: (view: EditorView, event: Event) => {
          const click = pending
          if (event instanceof MouseEvent) updateMaximumDistance(event)
          pending = null
          if (!(event instanceof MouseEvent)
            || !click
            || !isPlainPrimaryClick(event)
            || click.maximumDistance > SHORT_CLICK_MAX_DISTANCE_PX
            || !view.editable
            || view.composing
            || !view.state.selection.empty
            || selectionWithin(view.dom)) return false

          const position = resolvePosition({
            root: view.dom,
            target: click.target,
            clientX: click.clientX,
            clientY: click.clientY,
            posAtDOM: (node, offset, bias) => view.posAtDOM(node, offset, bias),
          })
          if (position === null || position < 0 || position > view.state.doc.content.size) return false

          const selection = TextSelection.create(view.state.doc, position)
          if (!view.state.selection.eq(selection)) {
            view.dispatch(view.state.tr.setSelection(selection))
          }
          view.focus()
          event.preventDefault()
          return true
        },
      },
    },
  })
}
