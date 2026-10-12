import { Schema } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import { history, undo } from '@milkdown/kit/prose/history'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContextMenuRequest } from '../../src/renderer/context-menu/context-menu-types'
import { createVisualContextMenuHandler } from '../../src/renderer/editor/context-menu/visual-context-menu'
import { createSelectionTargetPlugin } from '../../src/renderer/editor/editor-selection-target'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0] },
    code_block: {
      content: 'text*', group: 'block', code: true,
      attrs: { language: { default: '' } },
      toDOM: () => ['pre', ['code', 0]],
    },
    text: {},
  },
})
let view: EditorView | null = null
const originalArkdown = window.arkdown

afterEach(() => {
  if (view && !view.isDestroyed) view.destroy()
  view = null
  window.arkdown = originalArkdown
  document.body.replaceChildren()
})

function setup(texts: string[], clicked: number, edge: 'before' | 'after', insideOverride?: number) {
  // An opaque NodeView reproduces CodeMirror's DOM ownership. The headless
  // Crepe reproduction established the real boundary-valued posAtCoords result.
  const nodes = texts.map((text, index) => schema.node('code_block',
    { language: index === 0 ? 'javascript' : 'python' }, text ? schema.text(text) : undefined))
  const doc = schema.node('doc', null, nodes)
  const position = nodes.slice(0, clicked).reduce((sum, node) => sum + node.nodeSize, 0)
  view = new EditorView(document.body.appendChild(document.createElement('div')), {
    state: EditorState.create({ schema, doc, plugins: [createSelectionTargetPlugin(), history()] }),
    nodeViews: {
      code_block(node) {
        const dom = document.createElement('div')
        dom.className = 'milkdown-code-block'
        dom.contentEditable = 'false'
        const text = dom.appendChild(document.createElement('span'))
        text.className = 'cm-line'
        text.textContent = node.textContent
        return { dom }
      },
    },
  })
  vi.spyOn(view, 'posAtCoords').mockReturnValue({
    pos: edge === 'before' ? position : position + nodes[clicked].nodeSize,
    inside: insideOverride ?? position,
  })
  window.arkdown = undefined as never
  let request: ContextMenuRequest | undefined
  let resolvePrompt!: (result: string | null) => void
  const prompt = vi.fn(() => new Promise<string | null>(resolve => { resolvePrompt = resolve }))
  const commit = vi.fn()
  const identity = { documentKey: 'first', lifetime: 1 }
  const handler = createVisualContextMenuHandler({
    crepe: { editor: { action: (run: (ctx: { get(): EditorView }) => unknown) => run({ get: () => view! }) } } as never,
    menu: { openMenu(next) { request = next }, closeMenu() {}, isOpen: false },
    commit, getMarkdown: () => '', getSelectionIdentity: () => identity,
    dialogs: { prompt, alert: async () => undefined, confirm: async () => 'cancel' },
  })
  view.dom.addEventListener('contextmenu', handler)
  const open = () => {
    view!.dom.querySelectorAll('.cm-line')[clicked].dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, clientX: 8, clientY: 8,
    }))
    expect(request).toBeDefined()
    return request!
  }
  return { open, prompt, commit, identity, resolve: (result: string | null) => resolvePrompt(result) }
}

describe('code language on opaque code-block NodeViews', () => {
  it.each([
    { texts: ['const greeting = "Hello, Arkdown";'], clicked: 0, edge: 'before' as const },
    { texts: ['const greeting = "Hello, Arkdown";'], clicked: 0, edge: 'after' as const },
    { texts: [''], clicked: 0, edge: 'before' as const },
    { texts: [''], clicked: 0, edge: 'after' as const },
    { texts: ['first\nsecond', 'neighbor'], clicked: 0, edge: 'after' as const },
    { texts: ['neighbor', 'first\nsecond'], clicked: 1, edge: 'before' as const },
  ])('updates only the clicked block at $edge (block $clicked, $texts)', async ({ texts, clicked, edge }) => {
    const test = setup(texts, clicked, edge)
    const execution = Promise.resolve(test.open().execute('code-language'))
    expect(test.prompt).toHaveBeenCalledWith(expect.objectContaining({
      defaultValue: clicked === 0 ? 'javascript' : 'python',
    }))
    test.resolve(' typescript ')
    await execution
    texts.forEach((text, index) => {
      expect(view!.state.doc.child(index).textContent).toBe(text)
      expect(view!.state.doc.child(index).attrs.language).toBe(index === clicked
        ? 'typescript' : index === 0 ? 'javascript' : 'python')
    })
    expect(test.commit).toHaveBeenCalledOnce()
  })

  it('does not use a neighboring inside node whose DOM does not own the click', async () => {
    const test = setup(['first', 'second'], 1, 'before', 0)
    const before = view!.state.doc
    await test.open().execute('code-language')
    expect(test.prompt).not.toHaveBeenCalled()
    expect(view!.state.doc).toBe(before)
    expect(test.commit).not.toHaveBeenCalled()
  })

  it('leaves the document unchanged when the boundary-targeted prompt is canceled', async () => {
    const test = setup(['const value = 1'], 0, 'after')
    const before = view!.state.doc
    const execution = Promise.resolve(test.open().execute('code-language'))
    expect(test.prompt).toHaveBeenCalledOnce()
    test.resolve(null)
    await execution
    expect(view!.state.doc).toBe(before)
    expect(test.commit).not.toHaveBeenCalled()
  })

  it.each(['document-edit', 'undo', 'document-switch', 'lifetime', 'destroy', 'new-menu'] as const)(
    'ignores a boundary-targeted prompt after %s', async (stale) => {
      const test = setup(['const value = 1'], 0, 'after')
      const execution = Promise.resolve(test.open().execute('code-language'))
      expect(test.prompt).toHaveBeenCalledOnce()
      if (stale === 'document-edit' || stale === 'undo') {
        view!.dispatch(view!.state.tr.insertText('x', 1))
        if (stale === 'undo') undo(view!.state, view!.dispatch)
      } else if (stale === 'document-switch') test.identity.documentKey = 'second'
      else if (stale === 'lifetime') test.identity.lifetime += 1
      else if (stale === 'destroy') view!.destroy()
      else test.open()
      const beforeResolution = view!.state.doc
      test.resolve('typescript')
      await execution
      expect(view!.state.doc).toBe(beforeResolution)
      expect(view!.state.doc.firstChild!.attrs.language).toBe('javascript')
      expect(test.commit).not.toHaveBeenCalled()
    },
  )
})
