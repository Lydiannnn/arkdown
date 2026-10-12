import { parserCtx } from '@milkdown/kit/core'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArkdownApi, ClipboardFormatsSnapshot } from '../../src/shared/contracts'
import type { ContextMenuRequest } from '../../src/renderer/context-menu/context-menu-types'
import { commandItemById } from '../../src/renderer/context-menu/context-menu-types'
import { createVisualContextMenuHandler } from '../../src/renderer/editor/context-menu/visual-context-menu'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    heading: {
      attrs: { level: { default: 1 } },
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'h1', attrs: { level: 1 } }],
      toDOM: () => ['h1', 0],
    },
    code_block: {
      attrs: { language: { default: '' } },
      content: 'text*',
      group: 'block',
      code: true,
      defining: true,
      marks: '',
      parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
      toDOM: (node) => ['pre', { 'data-language': node.attrs.language }, ['code', 0]],
    },
    table: { content: 'table_row+', group: 'block', parseDOM: [{ tag: 'table' }], toDOM: () => ['table', ['tbody', 0]] },
    table_row: { content: 'table_cell+', parseDOM: [{ tag: 'tr' }], toDOM: () => ['tr', 0] },
    table_cell: { content: 'block+', parseDOM: [{ tag: 'td' }], toDOM: () => ['td', 0] },
    text: { group: 'inline' },
  },
  marks: {
    strong: { parseDOM: [{ tag: 'strong' }], toDOM: () => ['strong', 0] },
    strike_through: { parseDOM: [{ tag: 'del' }], toDOM: () => ['del', 0] },
    underline: { parseDOM: [{ tag: 'u' }], toDOM: () => ['u', 0] },
    highlight: { parseDOM: [{ tag: 'mark' }], toDOM: () => ['mark', 0] },
    superscript: { parseDOM: [{ tag: 'sup' }], toDOM: () => ['sup', 0] },
    subscript: { parseDOM: [{ tag: 'sub' }], toDOM: () => ['sub', 0] },
    link: {
      attrs: { href: {} },
      inclusive: false,
      parseDOM: [{ tag: 'a[href]', getAttrs: (element) => ({ href: (element as Element).getAttribute('href') }) }],
      toDOM: (mark) => ['a', { href: mark.attrs.href }, 0],
    },
  },
})

const originalArkdown = window.arkdown
let view: EditorView | null = null

afterEach(() => {
  view?.destroy()
  view = null
  window.arkdown = originalArkdown
  document.body.replaceChildren()
})

async function executeClipboardCommand(
  command: 'paste-plain' | 'paste-markdown' | 'paste-html' | 'paste-mermaid',
  formats: ClipboardFormatsSnapshot,
): Promise<EditorState> {
  const host = document.body.appendChild(document.createElement('div'))
  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [schema.node('paragraph', null, schema.text('old'))]),
    selection: TextSelection.create(
      schema.node('doc', null, [schema.node('paragraph', null, schema.text('old'))]),
      1,
      4,
    ),
  })
  view = new EditorView(host, {
    state,
    dispatchTransaction(transaction) {
      state = state.apply(transaction)
      view!.updateState(state)
    },
  })
  vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 2, inside: 0 })
  const parser = vi.fn((markdown: string) => schema.node('doc', null, [
    schema.node('heading', { level: 1 }, schema.text(markdown.replace(/^#\s*/u, ''))),
  ]))
  window.arkdown = {
    readClipboardFormats: vi.fn(async () => ({ ok: true as const, value: formats })),
  } as unknown as ArkdownApi
  let request: ContextMenuRequest | null = null
  const handler = createVisualContextMenuHandler({
    crepe: {
      editor: {
        action: (run: (context: { get(key: unknown): unknown }) => void) => run({
          get: (key) => key === parserCtx ? parser : view!,
        }),
      },
    } as never,
    menu: {
      openMenu(next) { request = next },
      closeMenu: () => undefined,
      isOpen: false,
    },
    commit: vi.fn(),
    getMarkdown: () => 'old',
  })
  view.dom.addEventListener('contextmenu', handler)
  view.dom.querySelector('p')!.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    clientX: 8,
    clientY: 8,
  }))
  await vi.waitFor(() => expect(request).not.toBeNull())
  await request!.execute(command)
  return state
}

describe('visual clipboard format commands', () => {
  it('turns clipboard plain text into one Mermaid code block', async () => {
    const state = await executeClipboardCommand('paste-mermaid', {
      plainText: 'flowchart LR\r\n  A --> B',
      markdown: '# Rich clipboard representation must not win',
      html: '<pre>wrong</pre>',
    })
    expect(state.doc.childCount).toBe(1)
    expect(state.doc.firstChild?.type.name).toBe('code_block')
    expect(state.doc.firstChild?.attrs.language).toBe('mermaid')
    expect(state.doc.firstChild?.textContent).toBe('flowchart LR\n  A --> B')
  })

  it('inserts plain text without parsing Markdown syntax', async () => {
    const state = await executeClipboardCommand('paste-plain', {
      plainText: '# Plain',
      markdown: '# Markdown',
      html: '<h1>HTML</h1>',
    })
    expect(state.doc.firstChild?.type.name).toBe('paragraph')
    expect(state.doc.textContent).toBe('# Plain')
  })

  it('parses the Markdown representation into editor structure', async () => {
    const state = await executeClipboardCommand('paste-markdown', {
      plainText: '# Plain',
      markdown: '# Markdown',
      html: '<h1>HTML</h1>',
    })
    expect(state.doc.firstChild?.type.name).toBe('heading')
    expect(state.doc.textContent).toBe('Markdown')
  })

  it('sanitizes and parses only the real HTML representation', async () => {
    const state = await executeClipboardCommand('paste-html', {
      plainText: '# Plain',
      markdown: '# Markdown',
      html: '<h1 onclick="steal()">HTML</h1><script>steal()</script>',
    })
    expect(state.doc.firstChild?.type.name).toBe('heading')
    expect(state.doc.textContent).toBe('HTML')
  })

  it('keeps safe HTML structure and formatting while removing executable URLs', async () => {
    const state = await executeClipboardCommand('paste-html', {
      plainText: 'fallback',
      markdown: null,
      html: [
        '<p><strong>Bold</strong> <a href="https://example.com">safe</a>',
        '<a href="javascript:bad()">bad</a></p>',
        '<table><tbody><tr><td>Cell</td></tr></tbody></table>',
      ].join(''),
    })
    const strong = state.doc.nodeAt(1)?.marks.find((mark) => mark.type.name === 'strong')
    const links: string[] = []
    let hasTable = false
    state.doc.descendants((node) => {
      if (node.type.name === 'table') hasTable = true
      for (const mark of node.marks) {
        if (mark.type.name === 'link') links.push(String(mark.attrs.href))
      }
    })
    expect(strong).toBeDefined()
    expect(links).toEqual(['https://example.com'])
    expect(hasTable).toBe(true)
    expect(state.doc.textContent).toContain('Cell')
  })
})

describe('visual extended format routing', () => {
  it('checks a format only when every selected text segment carries its mark', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const doc = schema.node('doc', null, schema.node('paragraph', null, [
      schema.text('yes', [schema.marks.underline!.create()]),
      schema.text(' no'),
    ]))
    view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 1, 7),
      }),
    })
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 2, inside: 0 })
    let request: ContextMenuRequest | null = null
    const handler = createVisualContextMenuHandler({
      crepe: { editor: { action: (run: (context: { get(): EditorView }) => void) => run({ get: () => view! }) } } as never,
      menu: { openMenu(next) { request = next }, closeMenu: () => undefined, isOpen: false },
      commit: vi.fn(),
      getMarkdown: () => 'yes no',
    })
    view.dom.addEventListener('contextmenu', handler)

    view.dom.querySelector('p')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    await vi.waitFor(() => expect(request).not.toBeNull())

    const more = request!.items.find((item) => item.kind === 'submenu' && item.id === 'more-format')
    expect(more?.kind).toBe('submenu')
    if (more?.kind !== 'submenu') return
    expect(more.items.find((item) => item.id === 'toggle-underline'))
      .toMatchObject({ checked: false })
  })

  it('uses current marks for all five checks at a collapsed caret', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const marks = [
      schema.marks.strike_through!.create(),
      schema.marks.underline!.create(),
      schema.marks.highlight!.create(),
      schema.marks.superscript!.create(),
      schema.marks.subscript!.create(),
    ]
    const doc = schema.node('doc', null, schema.node('paragraph', null, schema.text('xy', marks)))
    view = new EditorView(host, {
      state: EditorState.create({ schema, doc, selection: TextSelection.create(doc, 2) }),
    })
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 2, inside: 0 })
    let request: ContextMenuRequest | null = null
    const handler = createVisualContextMenuHandler({
      crepe: { editor: { action: (run: (context: { get(): EditorView }) => void) => run({ get: () => view! }) } } as never,
      menu: { openMenu(next) { request = next }, closeMenu: () => undefined, isOpen: false },
      commit: vi.fn(),
      getMarkdown: () => 'xy',
    })
    view.dom.addEventListener('contextmenu', handler)

    view.dom.querySelector('p')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    await vi.waitFor(() => expect(request).not.toBeNull())

    const more = request!.items.find((item) => item.kind === 'submenu' && item.id === 'more-format')
    expect(more?.kind).toBe('submenu')
    if (more?.kind !== 'submenu') return
    expect(more.items.filter((item) => item.kind === 'command' && item.checked).map((item) => item.id))
      .toEqual([
        'toggle-strike',
        'toggle-underline',
        'toggle-highlight',
        'toggle-superscript',
        'toggle-subscript',
      ])
  })

  it('routes every more-format command through the editor command boundary', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    view = new EditorView(host, {
      state: EditorState.create({ schema, doc: schema.node('doc', null, schema.node('paragraph', null, schema.text('text'))) }),
    })
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 2, inside: 0 })
    let request: ContextMenuRequest | null = null
    const handler = createVisualContextMenuHandler({
      crepe: { editor: { action: (run: (context: { get(): EditorView }) => void) => run({ get: () => view! }) } } as never,
      menu: { openMenu(next) { request = next }, closeMenu: () => undefined, isOpen: false },
      commit: vi.fn(),
      getMarkdown: () => 'text',
    })
    const received: string[] = []
    const listener = (event: Event) => received.push((event as CustomEvent<string>).detail)
    window.addEventListener('arkdown:editor-command', listener)
    view.dom.addEventListener('contextmenu', handler)
    view.dom.querySelector('p')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    await vi.waitFor(() => expect(request).not.toBeNull())
    for (const command of [
      'toggle-underline', 'clear-inline-formatting', 'toggle-inline-formula',
      'toggle-highlight', 'toggle-superscript', 'toggle-subscript',
    ]) await request!.execute(command)
    window.removeEventListener('arkdown:editor-command', listener)
    expect(received).toEqual([
      'underline', 'clear-inline-formatting', 'inline-formula',
      'highlight', 'superscript', 'subscript',
    ])
  })
})

describe('visual context-menu dialog lifecycle', () => {
  it.each([
    'table-delete-row',
    'table-delete-column',
  ] as const)('does not run %s on a stale editor after confirmation', async (command) => {
    const host = document.body.appendChild(document.createElement('div'))
    const doc = schema.node('doc', null, [
      schema.node('table', null, [
        schema.node('table_row', null, [
          schema.node('table_cell', null, [schema.node('paragraph', null, schema.text('cell'))]),
        ]),
      ]),
    ])
    view = new EditorView(host, { state: EditorState.create({ schema, doc }) })
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 4, inside: 0 })
    let alive = true
    let request: ContextMenuRequest | null = null
    let resolveConfirmation!: (result: 'confirm' | 'cancel') => void
    const confirm = vi.fn(() => new Promise<'confirm' | 'cancel'>((resolve) => {
      resolveConfirmation = resolve
    }))
    const action = vi.fn((run: (context: { get(): EditorView }) => void) => {
      if (!alive) throw new Error('old editor was destroyed')
      return run({ get: () => view! })
    })
    const commit = vi.fn()
    const options = {
      crepe: { editor: { action } } as never,
      menu: {
        openMenu(next: ContextMenuRequest) { request = next },
        closeMenu: () => undefined,
        isOpen: false,
      },
      commit,
      getMarkdown: () => '| cell |',
      dialogs: {
        alert: vi.fn(async () => undefined),
        confirm,
        prompt: vi.fn(async () => null),
      },
      isCurrent: () => alive,
    }
    const handler = createVisualContextMenuHandler(options)
    view.dom.addEventListener('contextmenu', handler)
    view.dom.querySelector('td')!.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: 8,
      clientY: 8,
    }))
    const execution = Promise.resolve(request!.execute(command))
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    const callsBeforeResolution = action.mock.calls.length

    alive = false
    resolveConfirmation('confirm')

    await expect(execution).resolves.toBeUndefined()
    expect(action).toHaveBeenCalledTimes(callsBeforeResolution)
    expect(commit).not.toHaveBeenCalled()
  })

  it.each([false, true])('routes the code language prompt and only applies it to the current editor (stale=%s)', async (stale) => {
    const host = document.body.appendChild(document.createElement('div'))
    const doc = schema.node('doc', null, [
      schema.node('code_block', { language: 'javascript' }, schema.text('const value = 1')),
    ])
    view = new EditorView(host, { state: EditorState.create({ schema, doc }) })
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 2, inside: 0 })
    let alive = true
    let request: ContextMenuRequest | null = null
    let resolvePrompt!: (result: string | null) => void
    const prompt = vi.fn(() => new Promise<string | null>((resolve) => { resolvePrompt = resolve }))
    const action = vi.fn((run: (context: { get(): EditorView }) => void) => {
      if (!alive) throw new Error('old editor was destroyed')
      return run({ get: () => view! })
    })
    const commit = vi.fn()
    const options = {
      crepe: { editor: { action } } as never,
      menu: {
        openMenu(next: ContextMenuRequest) { request = next },
        closeMenu: () => undefined,
        isOpen: false,
      },
      commit,
      getMarkdown: () => '```javascript\nconst value = 1\n```',
      dialogs: {
        alert: vi.fn(async () => undefined),
        confirm: vi.fn(async () => 'cancel' as const),
        prompt,
      },
      isCurrent: () => alive,
    }
    const handler = createVisualContextMenuHandler(options)
    view.dom.addEventListener('contextmenu', handler)
    view.dom.querySelector('code')!.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: 8,
      clientY: 8,
    }))
    expect(commandItemById(request!.items, 'code-language')).not.toBeNull()
    const execution = Promise.resolve(request!.execute('code-language'))
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      defaultValue: 'javascript',
    })))
    const callsBeforeResolution = action.mock.calls.length

    alive = !stale
    resolvePrompt('typescript')

    await expect(execution).resolves.toBeUndefined()
    expect(view.state.doc.firstChild?.textContent).toBe('const value = 1')
    if (stale) {
      expect(action).toHaveBeenCalledTimes(callsBeforeResolution)
      expect(view.state.doc.firstChild?.attrs.language).toBe('javascript')
      expect(commit).not.toHaveBeenCalled()
    } else {
      expect(view.state.doc.firstChild?.attrs.language).toBe('typescript')
      expect(commit).toHaveBeenCalledOnce()
    }
  })

})
