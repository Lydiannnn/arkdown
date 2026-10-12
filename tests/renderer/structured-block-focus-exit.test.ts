import { Schema } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStructuredBlockFocusExitPlugin } from '../../src/renderer/editor/structured-block-focus-exit'

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

function mountEditor() {
  const plugin = createStructuredBlockFocusExitPlugin()
  const host = document.body.appendChild(document.createElement('div'))
  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, schema.text('正文位置')),
    ]),
    plugins: [plugin],
  })
  mountedView = new EditorView(host, {
    state,
    dispatchTransaction(transaction) {
      state = state.apply(transaction)
      mountedView!.updateState(state)
    },
  })
  return { plugin, view: mountedView }
}

describe('structured block focus exit', () => {
  it('hands focus back to the outer editor at the clicked body position', () => {
    const { plugin, view } = mountEditor()
    const block = view.dom.appendChild(document.createElement('div'))
    block.className = 'milkdown-code-block'
    block.contentEditable = 'false'
    const codeMirror = block.appendChild(document.createElement('div'))
    codeMirror.className = 'cm-editor'
    codeMirror.tabIndex = 0
    codeMirror.focus()
    expect(document.activeElement).toBe(codeMirror)

    const paragraph = view.dom.querySelector('p')!
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 3, inside: -1 })
    const handler = plugin.props.handleDOMEvents?.mousedown
    const event = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 80,
      clientY: 40,
    })
    Object.defineProperty(event, 'target', { configurable: true, value: paragraph })

    expect(handler?.call(plugin, view, event)).toBe(false)
    expect(view.state.selection.from).toBe(3)
    expect(document.activeElement).toBe(view.dom)
  })

  it('does not intercept clicks while the outer editor already owns focus', () => {
    const { plugin, view } = mountEditor()
    const paragraph = view.dom.querySelector('p')!
    paragraph.dispatchEvent(new MouseEvent('mousedown'))
    const position = vi.spyOn(view, 'posAtCoords')
    const event = new MouseEvent('mousedown', { button: 0, clientX: 80, clientY: 40 })
    Object.defineProperty(event, 'target', { configurable: true, value: paragraph })

    expect(plugin.props.handleDOMEvents?.mousedown?.call(plugin, view, event)).toBe(false)
    expect(position).not.toHaveBeenCalled()
  })
})
