import { WORKSPACE_ENTRY_MIME } from '../workspace/workspace-drag'
import type { Slice } from '@milkdown/kit/prose/model'
import { Plugin, Selection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

export interface VisualDropTarget {
  pos: number
  left: number
  top: number
  height: number
}

let nextVisualDropRequestId = 0
const visualDropRequestIds = new WeakMap<Event, number>()

export function registerVisualDropRequest(event: Event): number {
  nextVisualDropRequestId += 1
  visualDropRequestIds.set(event, nextVisualDropRequestId)
  return nextVisualDropRequestId
}

export function visualDropRequestIdForEvent(event: Event): number | undefined {
  return visualDropRequestIds.get(event)
}

export interface VisualDropSource {
  from: number
  to: number
}

export interface VisualDropTransactionOptions {
  move: boolean
  source?: VisualDropSource | null
}

export type VisualExternalDropRequest =
  | { status: 'idle' }
  | { status: 'dragging' }
  | { status: 'pending'; requestId: number; target: VisualDropTarget }
  | { status: 'invalidated'; requestId: number }

export interface VisualDropTargetHandle {
  request: VisualExternalDropRequest
}

export interface VisualDropInsertionPluginOptions {
  externalDropTarget?: VisualDropTargetHandle
}

export function resolveVisualDropTarget(
  view: EditorView,
  clientX: number,
  clientY: number,
): VisualDropTarget | null {
  try {
    const located = view.posAtCoords({ left: clientX, top: clientY })
    if (!located) return null
    const pos = Math.max(0, Math.min(view.state.doc.content.size, located.pos))
    const coords = view.coordsAtPos(pos)
    return {
      pos,
      left: coords.left,
      top: coords.top,
      height: Math.max(1, coords.bottom - coords.top),
    }
  } catch {
    return null
  }
}

function sourceForMove(
  state: EditorState,
  source: VisualDropSource | null | undefined,
): VisualDropSource | null {
  if (source) return source
  if (state.selection.empty) return null
  return { from: state.selection.from, to: state.selection.to }
}

export function buildVisualDropTransaction(
  state: EditorState,
  target: VisualDropTarget,
  slice: Slice,
  options: VisualDropTransactionOptions,
): Transaction | null {
  if (slice.size === 0 || target.pos < 0 || target.pos > state.doc.content.size) return null
  const source = options.move ? sourceForMove(state, options.source) : null
  if (options.move && !source) return null
  if (source && target.pos >= source.from && target.pos <= source.to) return null

  const transaction = state.tr
  if (source) transaction.delete(source.from, source.to)
  const insertPos = transaction.mapping.map(target.pos)
  const beforeInsert = transaction.doc
  transaction.replaceRange(insertPos, insertPos, slice)
  if (transaction.doc.eq(beforeInsert)) return null

  let selectionPos = insertPos
  const insertionMap = transaction.mapping.maps[transaction.mapping.maps.length - 1]
  insertionMap?.forEach((_oldFrom, _oldTo, _newFrom, newTo) => {
    selectionPos = newTo
  })
  transaction.setSelection(Selection.near(
    transaction.doc.resolve(Math.max(0, Math.min(transaction.doc.content.size, selectionPos))),
    -1,
  ))
  return transaction.setMeta('uiEvent', 'drop')
}

class VisualDropCaretController {
  target: VisualDropTarget | null = null
  private caret: HTMLElement | null = null
  private readonly document: Document
  private readonly window: Window | null

  private readonly onDocumentKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') this.cancel()
  }

  private readonly onDocumentDrop = () => {
    const droppedTarget = this.target
    queueMicrotask(() => this.removeCaret())
    setTimeout(() => {
      if (
        this.externalDropTarget.request.status === 'dragging'
        && this.target === droppedTarget
      ) this.finishDragGesture()
    }, 0)
  }

  private readonly onVisibilityChange = () => {
    if (this.document.visibilityState === 'hidden') this.cancel()
  }

  private readonly onWindowBlur = () => this.finishDragGesture()

  constructor(
    private readonly view: EditorView,
    private readonly externalDropTarget: VisualDropTargetHandle,
  ) {
    this.document = view.dom.ownerDocument
    this.window = this.document.defaultView
    this.document.addEventListener('keydown', this.onDocumentKeyDown, true)
    this.document.addEventListener('drop', this.onDocumentDrop, true)
    this.document.addEventListener('visibilitychange', this.onVisibilityChange)
    this.window?.addEventListener('blur', this.onWindowBlur)
  }

  updateDragTarget(target: VisualDropTarget | null): void {
    this.externalDropTarget.request = { status: 'dragging' }
    this.target = target
    if (!target) {
      this.hideCaret()
      return
    }
    const parent = this.document.body
    if (!this.caret || this.caret.parentElement !== parent) {
      this.caret?.remove()
      this.caret = this.document.createElement('div')
      this.caret.className = 'arkdown-visual-drop-caret'
      this.caret.setAttribute('aria-hidden', 'true')
      const textColor = this.window?.getComputedStyle(this.view.dom).color.trim()
      if (textColor) this.caret.style.color = textColor
      parent.append(this.caret)
    }
    this.caret.dataset.dropPos = String(target.pos)
    this.caret.style.left = `${target.left}px`
    this.caret.style.top = `${target.top}px`
    this.caret.style.height = `${target.height}px`
  }

  takeDropTarget(): VisualDropTarget | null {
    const target = this.target
    this.hideCaret()
    return target
  }

  cancel(): void {
    const request = this.externalDropTarget.request
    if (request.status === 'pending') {
      this.externalDropTarget.request = {
        status: 'invalidated',
        requestId: request.requestId,
      }
    } else if (request.status === 'dragging') {
      this.externalDropTarget.request = { status: 'idle' }
    }
    this.hideCaret()
  }

  finishDragGesture(): void {
    if (this.externalDropTarget.request.status === 'dragging') {
      this.externalDropTarget.request = { status: 'idle' }
    }
    this.hideCaret()
  }

  clearForDocumentChange(): void {
    if (this.externalDropTarget.request.status === 'dragging') {
      this.externalDropTarget.request = { status: 'idle' }
    }
    this.hideCaret()
  }

  private hideCaret(): void {
    this.target = null
    this.removeCaret()
  }

  private removeCaret(): void {
    this.caret?.remove()
    this.caret = null
  }

  destroy(): void {
    this.cancel()
    this.document.removeEventListener('keydown', this.onDocumentKeyDown, true)
    this.document.removeEventListener('drop', this.onDocumentDrop, true)
    this.document.removeEventListener('visibilitychange', this.onVisibilityChange)
    this.window?.removeEventListener('blur', this.onWindowBlur)
  }
}

function dragSource(view: EditorView): VisualDropSource | null {
  const draggedNode = (view.dragging as (typeof view.dragging & {
    node?: { from: number; to: number }
  }))?.node
  if (draggedNode) return { from: draggedNode.from, to: draggedNode.to }
  if (view.state.selection.empty) return null
  return { from: view.state.selection.from, to: view.state.selection.to }
}

export function createVisualDropInsertionPlugin(
  options: VisualDropInsertionPluginOptions = {},
): Plugin {
  const externalDropTarget = options.externalDropTarget ?? { request: { status: 'idle' as const } }
  const controllers = new WeakMap<EditorView, VisualDropCaretController>()
  const controllerFor = (view: EditorView) => controllers.get(view)
  const cancel = (view: EditorView) => controllerFor(view)?.cancel()

  return new Plugin({
    state: {
      init: () => null,
      apply(transaction, value) {
        const request = externalDropTarget.request
        if (!transaction.docChanged || request.status !== 'pending') return value
        const mapped = transaction.mapping.mapResult(request.target.pos, 1)
        if (
          mapped.deletedAcross
          || mapped.pos < 0
          || mapped.pos > transaction.doc.content.size
        ) {
          externalDropTarget.request = {
            status: 'invalidated',
            requestId: request.requestId,
          }
        } else {
          externalDropTarget.request = {
            status: 'pending',
            requestId: request.requestId,
            target: { ...request.target, pos: mapped.pos },
          }
        }
        return value
      },
    },
    view(view) {
      const controller = new VisualDropCaretController(view, externalDropTarget)
      controllers.set(view, controller)
      return {
        update(nextView, previousState) {
          if (previousState.doc !== nextView.state.doc) controller.clearForDocumentChange()
        },
        destroy() {
          controller.destroy()
          controllers.delete(view)
        },
      }
    },
    props: {
      handleDOMEvents: {
        dragover(view, event) {
          const controller = controllerFor(view)
          if (!controller || !view.editable) {
            cancel(view)
            return false
          }
          const target = resolveVisualDropTarget(view, event.clientX, event.clientY)
          controller.updateDragTarget(target)
          return false
        },
        dragleave(view, event) {
          const relatedTarget = event.relatedTarget
          if (!(relatedTarget instanceof Node) || !view.dom.contains(relatedTarget)) {
            controllerFor(view)?.finishDragGesture()
          }
          return false
        },
        dragend(view) {
          controllerFor(view)?.finishDragGesture()
          return false
        },
        drop(view, event) {
          // Crepe's earlier upload plugin claims every non-empty FileList in handleDrop.
          if (!event.dataTransfer?.files.length
            && !Array.from(event.dataTransfer?.types ?? []).includes(WORKSPACE_ENTRY_MIME)) return false
          const target = controllerFor(view)?.takeDropTarget()
          const requestId = registerVisualDropRequest(event)
          externalDropTarget.request = target
            ? { status: 'pending', requestId, target }
            : { status: 'invalidated', requestId }
          event.preventDefault()
          return true
        },
      },
      handleKeyDown(view, event) {
        if (event.key === 'Escape') cancel(view)
        return false
      },
      handleDrop(view, event, _parsedSlice, move) {
        const controller = controllerFor(view)
        const target = controller?.takeDropTarget()
        const originalSlice = view.dragging?.slice
        if (!originalSlice) {
          const requestId = registerVisualDropRequest(event)
          externalDropTarget.request = target
            ? { status: 'pending', requestId, target }
            : { status: 'invalidated', requestId }
          return false
        }
        externalDropTarget.request = { status: 'idle' }
        if (!target) return true
        const transaction = buildVisualDropTransaction(
          view.state,
          target,
          originalSlice,
          { move, source: move ? dragSource(view) : null },
        )
        if (transaction) {
          view.dispatch(transaction)
          view.focus()
        }
        return true
      },
    },
  })
}
