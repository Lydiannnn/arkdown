import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVisualInputCaretPlugin } from '../../src/renderer/editor/visual-input-caret'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
})

let mountedView: EditorView | null = null

afterEach(() => {
  mountedView?.destroy()
  mountedView = null
  document.body.replaceChildren()
})

function mountEditor(): EditorView {
  const style = document.createElement('style')
  style.textContent = `
    .ProseMirror { caret-color: auto; }
    .ProseMirror.arkdown-visual-input-caret-active { caret-color: transparent; }
  `
  document.head.append(style)
  const host = document.body.appendChild(document.createElement('div'))
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, schema.text('输入法')),
  ])
  let state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, 2),
    plugins: [createVisualInputCaretPlugin()],
  })
  mountedView = new EditorView(host, {
    state,
    dispatchTransaction(transaction) {
      state = state.apply(transaction)
      mountedView!.updateState(state)
    },
  })
  return mountedView
}

describe('visual input caret IME lifecycle', () => {
  it('does not dispatch from composition handlers and restores the custom caret after PM flushes', async () => {
    const view = mountEditor()
    view.dom.dispatchEvent(new FocusEvent('focus'))
    expect(view.dom).toHaveClass('arkdown-visual-input-caret-active')
    expect(view.dom.querySelector('.arkdown-visual-input-caret')).toBeNull()
    expect(document.body.querySelector('.arkdown-visual-input-caret')).not.toBeNull()
    expect(view.dom.querySelector('p')?.childNodes).toHaveLength(1)
    expect(getComputedStyle(view.dom).caretColor).toBe('rgba(0, 0, 0, 0)')
    const dispatch = vi.spyOn(view, 'dispatch')

    view.dom.dispatchEvent(new CompositionEvent('compositionstart', {
      bubbles: true,
      data: '拼',
    }))

    expect(dispatch).not.toHaveBeenCalled()
    expect(view.dom).not.toHaveClass('arkdown-visual-input-caret-active')
    expect(view.dom).toHaveAttribute('contenteditable', 'true')
    expect(view.dom.querySelector('.arkdown-visual-input-caret')).toBeNull()
    expect(document.body.querySelector('.arkdown-visual-input-caret')).not.toBeNull()

    dispatch.mockClear()
    view.dom.dispatchEvent(new CompositionEvent('compositionend', {
      bubbles: true,
      data: '拼音',
    }))

    expect(dispatch).not.toHaveBeenCalled()
    expect(view.dom).not.toHaveClass('arkdown-visual-input-caret-active')
    expect(view.dom).toHaveAttribute('contenteditable', 'true')

    await new Promise((resolve) => setTimeout(resolve, 45))

    expect(view.dom).toHaveClass('arkdown-visual-input-caret-active')
    expect(view.dom.querySelector('.arkdown-visual-input-caret')).toBeNull()
    expect(document.body.querySelector('.arkdown-visual-input-caret')).not.toBeNull()
    expect(view.dom.querySelector('p')?.childNodes).toHaveLength(1)
    expect(getComputedStyle(view.dom).caretColor).toBe('rgba(0, 0, 0, 0)')
  })
})
