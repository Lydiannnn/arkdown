import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

interface VisualInputCaretRuntime {
  caret: HTMLSpanElement
  composing: boolean
  destroyed: boolean
  finishTimer: ReturnType<typeof setTimeout> | null
  focused: boolean
  frame: number | null
  resizeObserver: ResizeObserver | null
  schedule(): void
  synchronize(): void
}

function isActive(view: EditorView, runtime: VisualInputCaretRuntime): boolean {
  return Boolean(
    view.editable
    && runtime.focused
    && !runtime.composing
    && !view.composing
    && view.state.selection instanceof TextSelection
    && view.state.selection.empty,
  )
}

function hide(runtime: VisualInputCaretRuntime): void {
  runtime.caret.dataset.visible = 'false'
}

function placeCaret(view: EditorView, runtime: VisualInputCaretRuntime): void {
  const active = isActive(view, runtime)
  view.dom.classList.toggle('arkdown-visual-input-caret-active', active)
  if (!active) {
    hide(runtime)
    return
  }

  try {
    const coordinates = view.coordsAtPos(view.state.selection.head, 1)
    const height = Math.max(1, coordinates.bottom - coordinates.top)
    runtime.caret.style.left = `${coordinates.left}px`
    runtime.caret.style.top = `${coordinates.top}px`
    runtime.caret.style.height = `${height}px`
    runtime.caret.style.color = getComputedStyle(view.dom).color
    runtime.caret.dataset.visible = 'true'
  } catch {
    hide(runtime)
  }
}

export function createVisualInputCaretPlugin(): Plugin {
  const runtimes = new WeakMap<EditorView, VisualInputCaretRuntime>()
  return new Plugin({
    props: {
      handleDOMEvents: {
        focus: (view) => {
          const runtime = runtimes.get(view)
          if (!runtime) return false
          runtime.focused = true
          runtime.synchronize()
          return false
        },
        blur: (view) => {
          const runtime = runtimes.get(view)
          if (!runtime) return false
          runtime.focused = false
          runtime.synchronize()
          return false
        },
        compositionstart: (view) => {
          const runtime = runtimes.get(view)
          if (!runtime) return false
          if (runtime.finishTimer !== null) clearTimeout(runtime.finishTimer)
          runtime.finishTimer = null
          runtime.composing = true
          runtime.synchronize()
          return false
        },
        compositionend: (view) => {
          const runtime = runtimes.get(view)
          if (!runtime) return false
          if (runtime.finishTimer !== null) clearTimeout(runtime.finishTimer)
          const finishAfterProseMirror = () => {
            if (runtime.destroyed) return
            if (view.composing) {
              runtime.finishTimer = setTimeout(finishAfterProseMirror, 16)
              return
            }
            runtime.finishTimer = null
            runtime.composing = false
            runtime.synchronize()
          }
          runtime.finishTimer = setTimeout(finishAfterProseMirror, 25)
          return false
        },
      },
    },
    view: (view) => {
      const ownerDocument = view.dom.ownerDocument
      const ownerWindow = ownerDocument.defaultView
      const caret = ownerDocument.createElement('span')
      caret.className = 'arkdown-visual-input-caret'
      caret.dataset.visible = 'false'
      caret.setAttribute('aria-hidden', 'true')
      ownerDocument.body.append(caret)

      const runtime: VisualInputCaretRuntime = {
        caret,
        composing: false,
        destroyed: false,
        finishTimer: null,
        focused: view.hasFocus(),
        frame: null,
        resizeObserver: null,
        schedule: () => undefined,
        synchronize: () => undefined,
      }
      const synchronize = () => placeCaret(view, runtime)
      const schedule = () => {
        if (runtime.destroyed || runtime.frame !== null) return
        runtime.frame = ownerWindow?.requestAnimationFrame(() => {
          runtime.frame = null
          synchronize()
        }) ?? null
        if (runtime.frame === null) synchronize()
      }
      runtime.schedule = schedule
      runtime.synchronize = synchronize
      runtimes.set(view, runtime)

      ownerDocument.addEventListener('scroll', schedule, true)
      ownerWindow?.addEventListener('resize', schedule)
      if (typeof ResizeObserver !== 'undefined') {
        runtime.resizeObserver = new ResizeObserver(schedule)
        runtime.resizeObserver.observe(view.dom)
      }
      synchronize()

      return {
        update: synchronize,
        destroy: () => {
          runtime.destroyed = true
          if (runtime.finishTimer !== null) clearTimeout(runtime.finishTimer)
          if (runtime.frame !== null) ownerWindow?.cancelAnimationFrame(runtime.frame)
          runtime.resizeObserver?.disconnect()
          ownerDocument.removeEventListener('scroll', schedule, true)
          ownerWindow?.removeEventListener('resize', schedule)
          runtimes.delete(view)
          view.dom.classList.remove('arkdown-visual-input-caret-active')
          caret.remove()
        },
      }
    },
  })
}
