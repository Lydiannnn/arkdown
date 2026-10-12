import { Schema } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContextMenuRequest } from '../../src/renderer/context-menu/context-menu-types'
import { createVisualContextMenuHandler } from '../../src/renderer/editor/context-menu/visual-context-menu'
import { defaultHorizontalRuleView } from '../../src/renderer/editor/horizontal-rule-view'
import { createLocalMediaHtmlView } from '../../src/renderer/editor/local-media-view'
import { executeHorizontalRuleCommand } from '../../src/renderer/editor/context-menu/visual-editor-commands'

vi.mock('@milkdown/kit/utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('@milkdown/kit/utils')>(),
  $view: (type: unknown, factory: () => unknown) => ({ type, view: factory() }),
}))

const CONTROLLED_RULE = '<hr data-arkdown-style="blue" data-arkdown-height="6" data-arkdown-opacity="70" />'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
    hr: { group: 'block', atom: true, toDOM: () => ['hr'] },
    html: {
      group: 'block',
      atom: true,
      attrs: { value: { default: '' } },
      toDOM: (node) => ['div', { 'data-value': node.attrs.value }],
    },
  },
})

let mountedView: EditorView | null = null

afterEach(() => {
  mountedView?.destroy()
  mountedView = null
  document.body.replaceChildren()
})

function mountEditor(node: ReturnType<typeof schema.node>): EditorView {
  const host = document.body.appendChild(document.createElement('div'))
  let state = EditorState.create({
    schema,
    doc: schema.nodes.doc.create(undefined, [
      schema.nodes.paragraph.create(),
      node,
      schema.nodes.paragraph.create(),
    ]),
  })
  mountedView = new EditorView(host, {
    state,
    dispatchTransaction(transaction) {
      state = state.apply(transaction)
      mountedView!.updateState(state)
    },
    nodeViews: {
      hr: defaultHorizontalRuleView.view,
      html: createLocalMediaHtmlView().view,
    },
  })
  return mountedView
}

function rulePosition(view: EditorView): number {
  let position = -1
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'hr' || node.type.name === 'html') {
      position = pos
      return false
    }
    return true
  })
  return position
}

describe('horizontal rule editor transactions', () => {
  it('persists an adjustment made through the controlled HTML NodeView', async () => {
    const view = mountEditor(schema.nodes.html.create({ value: CONTROLLED_RULE }))
    const rule = view.dom.querySelector<HTMLHRElement>('hr')!

    await executeHorizontalRuleCommand(rule, 'horizontal-rule-height-increase')

    expect(view.state.doc.nodeAt(rulePosition(view))?.attrs.value).toBe(
      '<hr data-arkdown-style="blue" data-arkdown-height="7" data-arkdown-opacity="70" />',
    )
  })

  it('converts an ordinary Markdown rule through a real transaction', async () => {
    const view = mountEditor(schema.nodes.hr.create())
    const rule = view.dom.querySelector<HTMLHRElement>('hr')!

    await executeHorizontalRuleCommand(rule, 'horizontal-rule-opacity-increase')

    const persisted = view.state.doc.nodeAt(rulePosition(view))
    expect(persisted?.type.name).toBe('html')
    expect(persisted?.attrs.value).toBe(
      '<hr data-arkdown-style="black" data-arkdown-height="2" data-arkdown-opacity="50" />',
    )
  })

  it('routes a right-click adjustment through the editor transaction and commit path', async () => {
    const view = mountEditor(schema.nodes.html.create({ value: CONTROLLED_RULE }))
    const rule = view.dom.querySelector<HTMLHRElement>('hr')!
    const position = rulePosition(view)
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: position, inside: position })
    const commit = vi.fn()
    let request: ContextMenuRequest | null = null
    const handler = createVisualContextMenuHandler({
      crepe: {
        editor: {
          action: (run: (context: { get(): EditorView }) => void) => run({ get: () => view }),
        },
      } as never,
      menu: {
        openMenu: (next) => { request = next },
        closeMenu: () => undefined,
        isOpen: false,
      },
      commit,
      getMarkdown: () => '',
    })
    view.dom.addEventListener('contextmenu', handler)

    rule.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 8, clientY: 8 }))
    const action = request!.items.find((item) => (
      item.kind === 'command' && item.id === 'horizontal-rule-height-decrease'
    ))
    expect(action).toMatchObject({ kind: 'command', disabled: false })
    expect(action && action.kind === 'command' ? action.onSelect : undefined).toBeUndefined()

    await request!.execute('horizontal-rule-height-decrease')
    await Promise.resolve()

    expect(view.state.doc.nodeAt(position)?.attrs.value).toBe(
      '<hr data-arkdown-style="blue" data-arkdown-height="5" data-arkdown-opacity="70" />',
    )
    expect(commit).toHaveBeenCalledOnce()
  })
})
