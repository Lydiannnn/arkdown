import { Schema } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContextMenuRequest } from '../../src/renderer/context-menu/context-menu-types'
import { createVisualContextMenuHandler } from '../../src/renderer/editor/context-menu/visual-context-menu'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0] },
    code_block: {
      attrs: {
        language: { default: '' },
        frontmatter: { default: false },
      },
      content: 'text*',
      group: 'block',
      code: true,
      defining: true,
      marks: '',
      toDOM: (node) => ['pre', {
        'data-language': node.attrs.language,
        'data-frontmatter': String(node.attrs.frontmatter),
      }, ['code', 0]],
    },
    text: { group: 'inline' },
  },
})

let view: EditorView | null = null

afterEach(() => {
  view?.destroy()
  view = null
  document.body.replaceChildren()
})

function openMenu(markdown = 'alpha', allowYamlFrontmatter = true): {
  request: ContextMenuRequest
  commit: ReturnType<typeof vi.fn>
  alert: ReturnType<typeof vi.fn>
} {
  const host = document.body.appendChild(document.createElement('div'))
  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, markdown ? schema.text(markdown) : undefined),
    ]),
  })
  view = new EditorView(host, {
    state,
    dispatchTransaction(transaction) {
      state = state.apply(transaction)
      view!.updateState(state)
    },
  })
  vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: markdown ? 3 : 1, inside: 0 })
  const commit = vi.fn()
  const alert = vi.fn(async () => undefined)
  let request: ContextMenuRequest | null = null
  const handler = createVisualContextMenuHandler({
    crepe: {
      editor: {
        action: (run: (context: { get(): EditorView }) => void) => run({ get: () => view! }),
      },
    } as never,
    menu: {
      openMenu(next) { request = next },
      closeMenu: () => undefined,
      isOpen: false,
    },
    commit,
    dialogs: {
      alert,
      confirm: vi.fn(async () => 'cancel' as const),
      prompt: vi.fn(async () => null),
    },
    getMarkdown: () => markdown,
    allowYamlFrontmatter,
  })
  view.dom.addEventListener('contextmenu', handler)

  view.dom.querySelector('p')!.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    clientX: 8,
    clientY: 8,
  }))
  return { request: request!, commit, alert }
}

describe('structured block context menu insertion', () => {
  it.each([
    ['insert-code-block', '', false],
    ['insert-math-block', 'LaTeX', false],
  ] as const)('executes %s as a real editor transaction', async (command, language, frontmatter) => {
    const { request, commit } = openMenu()

    await request.execute(command)
    await Promise.resolve()

    const blocks: Array<{ language: string; frontmatter: boolean }> = []
    view!.state.doc.descendants((node) => {
      if (node.type.name === 'code_block') blocks.push(node.attrs as never)
    })
    expect(blocks).toContainEqual(expect.objectContaining({ language, frontmatter }))
    expect(view!.state.selection.$from.parent.type.name).toBe('code_block')
    expect(commit).toHaveBeenCalledOnce()
  })

  it('inserts Front Matter only into an empty document', async () => {
    const { request, commit } = openMenu('')

    await request.execute('insert-yaml')
    await Promise.resolve()

    expect(view!.state.doc.firstChild?.attrs).toMatchObject({
      language: 'YAML',
      frontmatter: true,
    })
    expect(view!.state.selection.$from.parent.attrs.frontmatter).toBe(true)
    expect(commit).toHaveBeenCalledOnce()
  })

  it('retains the existing Front Matter restriction for non-empty documents', async () => {
    const { request, commit, alert } = openMenu('alpha')

    await request.execute('insert-yaml')
    await Promise.resolve()

    expect(alert).toHaveBeenCalledWith({ title: 'YAML Front Matter 只能插入到空白 Markdown 文档开头。' })
    expect(view!.state.doc.firstChild?.type.name).toBe('paragraph')
    expect(commit).not.toHaveBeenCalled()
  })

  it('rejects Front Matter for non-Markdown documents even when they are empty', async () => {
    const { request, commit, alert } = openMenu('', false)

    await request.execute('insert-yaml')

    expect(alert).toHaveBeenCalledWith({ title: 'YAML Front Matter 只能插入到空白 Markdown 文档开头。' })
    expect(view!.state.doc.firstChild?.type.name).toBe('paragraph')
    expect(commit).not.toHaveBeenCalled()
  })
})
