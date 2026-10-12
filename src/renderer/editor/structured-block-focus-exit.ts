import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

const STRUCTURED_EDITOR_SELECTOR = '.milkdown-code-block .cm-editor'

function elementForTarget(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target
  return target instanceof Node ? target.parentElement : null
}

function hasFocusedStructuredEditor(view: EditorView): boolean {
  const active = view.dom.ownerDocument.activeElement
  return active instanceof Element
    && view.dom.contains(active)
    && Boolean(active.closest(STRUCTURED_EDITOR_SELECTOR))
}

export function createStructuredBlockFocusExitPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        mousedown: (view: EditorView, event: Event) => {
          if (!(event instanceof MouseEvent)
            || event.defaultPrevented
            || event.button !== 0
            || event.altKey
            || event.ctrlKey
            || event.metaKey
            || event.shiftKey
            || !view.editable
            || view.composing
            || !hasFocusedStructuredEditor(view)) return false

          const target = elementForTarget(event.target)
          if (!target
            || !view.dom.contains(target)
            || target.closest(STRUCTURED_EDITOR_SELECTOR)
            || target.closest('[contenteditable="false"]')) return false

          const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
          if (position === undefined) return false
          const next = TextSelection.near(view.state.doc.resolve(position), 1)
          if (!view.state.selection.eq(next)) {
            view.dispatch(view.state.tr.setSelection(next))
          }
          view.focus()
          return false
        },
      },
    },
  })
}
