import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenuContext, ContextMenuProvider } from '../../src/renderer/context-menu/ContextMenuProvider'
import type { ContextMenuRequest } from '../../src/renderer/context-menu/context-menu-types'
import { SourceEditor } from '../../src/renderer/editor/SourceEditor'

const contextMenuStyle = document.createElement('style')
contextMenuStyle.textContent = readFileSync(
  path.join(process.cwd(), 'src/renderer/context-menu/context-menu.css'),
  'utf8',
)

beforeAll(() => document.head.append(contextMenuStyle))
afterAll(() => contextMenuStyle.remove())

beforeEach(() => {
  codeMirror.view.state.doc.length = 13
  codeMirror.view.state.doc.toString = () => 'selected text'
  codeMirror.view.state.selection.main = { from: 0, to: 8, anchor: 0, head: 8 }
  codeMirror.view.state.sliceDoc = (from: number, to: number) => 'selected text'.slice(from, to)
})

const codeMirror = vi.hoisted(() => {
  const dispatch = vi.fn()
  const focus = vi.fn()
  const dom = document.createElement('div')
  return {
    dispatch,
    focus,
    view: {
      state: {
        doc: {
          length: 13,
          toString: (): string => 'selected text',
        },
        selection: { main: { from: 0, to: 8, anchor: 0, head: 8 } },
        sliceDoc: (from: number, to: number) => 'selected text'.slice(from, to),
      },
      posAtCoords: vi.fn(() => 10),
      dispatch,
      dom,
      focus,
      scrollDOM: document.createElement('div'),
    },
  }
})

vi.mock('@codemirror/lang-markdown', () => ({
  markdown: () => ({ name: 'markdown' }),
}))

vi.mock('@codemirror/commands', () => ({
  undo: vi.fn(),
  redo: vi.fn(),
}))

vi.mock('@uiw/react-codemirror', () => ({
  default: (props: {
    value: string
    onChange(value: string): void
    onCreateEditor?(view: unknown): void
  }) => {
    props.onCreateEditor?.(codeMirror.view)
    return <textarea aria-label="Markdown source" value={props.value} readOnly />
  },
}))

describe('SourceEditor context menu', () => {
  it('opens nested balanced source wrappers with all five format checks', () => {
    const markdown = '~~<u><mark><sup><sub>x</sub></sup></mark></u>~~'
    const caret = markdown.indexOf('x')
    codeMirror.view.state.doc.length = markdown.length
    codeMirror.view.state.doc.toString = () => markdown
    codeMirror.view.state.selection.main = { from: caret, to: caret, anchor: caret, head: caret }
    codeMirror.view.state.sliceDoc = (from: number, to: number) => markdown.slice(from, to)
    const openMenu = vi.fn<(request: ContextMenuRequest) => void>()
    render(
      <ContextMenuContext.Provider value={{ closeMenu: vi.fn(), isOpen: false, openMenu }}>
        <SourceEditor markdown={markdown} onChange={() => undefined} />
      </ContextMenuContext.Provider>,
    )

    fireEvent.contextMenu(screen.getByRole('textbox', { name: 'Markdown source' }))

    const request = openMenu.mock.calls[0]![0]
    const more = request.items.find((item) => item.kind === 'submenu' && item.id === 'more-format')
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

  it('leaves ordinary Arkdown menu layout metadata unspecified at the producer', () => {
    const openMenu = vi.fn<(request: ContextMenuRequest) => void>()
    render(
      <ContextMenuContext.Provider value={{ closeMenu: vi.fn(), isOpen: false, openMenu }}>
        <SourceEditor markdown="selected text" onChange={() => undefined} />
      </ContextMenuContext.Provider>,
    )

    fireEvent.contextMenu(screen.getByRole('textbox', { name: 'Markdown source' }))

    expect(openMenu).toHaveBeenCalledOnce()
    const request = openMenu.mock.calls[0]![0]
    expect(request.widthCssPx).toBeUndefined()
    expect(request.rootIconGutter).toBeUndefined()
  })

  it('searches the selected source text with the default browser command', async () => {
    const searchSelection = vi.fn(async () => ({ ok: true as const, value: null }))
    window.arkdown = { ...window.arkdown, searchSelection }
    render(
      <ContextMenuProvider>
        <SourceEditor markdown="selected text" onChange={() => undefined} />
      </ContextMenuProvider>,
    )

    fireEvent.contextMenu(screen.getByRole('textbox', { name: 'Markdown source' }), {
      clientX: 60,
      clientY: 80,
    })
    const searchCommand = screen.getByRole('menuitem', { name: '使用默认浏览器搜索' })
    expect(getComputedStyle(screen.getByRole('menu')).width).toBe('272px')
    expect(getComputedStyle(searchCommand).gridTemplateColumns).toBe('24px minmax(0, 1fr) auto')
    fireEvent.click(searchCommand)

    await waitFor(() => expect(searchSelection).toHaveBeenCalledWith('selected'))
  })

  it('applies Markdown formatting through a CodeMirror transaction', () => {
    codeMirror.dispatch.mockClear()
    render(
      <ContextMenuProvider>
        <SourceEditor markdown="selected text" onChange={() => undefined} />
      </ContextMenuProvider>,
    )
    fireEvent.contextMenu(screen.getByRole('textbox', { name: 'Markdown source' }))
    const bold = screen.getByRole('menuitem', { name: '加粗' })
    expect(bold).not.toHaveAttribute('data-tooltip')
    fireEvent.click(bold)


    expect(codeMirror.dispatch).toHaveBeenCalledWith({
      changes: { from: 0, to: 13, insert: '**selected** text' },
      selection: { anchor: 0, head: 12 },
    })
  })

  it.each([
    ['paste-plain', 'Plain only'],
    ['paste-markdown', '# Markdown source'],
    ['paste-html', '<h1>Safe</h1>'],
  ] as const)('inserts the exact %s representation as literal source', async (command, inserted) => {
    codeMirror.dispatch.mockClear()
    window.arkdown = {
      ...window.arkdown,
      readClipboardFormats: vi.fn(async () => ({
        ok: true as const,
        value: {
          plainText: 'Plain only',
          markdown: '# Markdown source',
          html: '<h1 onclick="bad()">Safe</h1><script>bad()</script>',
        },
      })),
    }
    const openMenu = vi.fn<(request: ContextMenuRequest) => void>()
    render(
      <ContextMenuContext.Provider value={{ closeMenu: vi.fn(), isOpen: false, openMenu }}>
        <SourceEditor markdown="selected text" onChange={() => undefined} />
      </ContextMenuContext.Provider>,
    )

    fireEvent.contextMenu(screen.getByRole('textbox', { name: 'Markdown source' }))
    await waitFor(() => expect(openMenu).toHaveBeenCalledOnce())
    await openMenu.mock.calls[0]![0].execute(command)

    expect(codeMirror.dispatch).toHaveBeenLastCalledWith({
      changes: { from: 0, to: 8, insert: inserted },
      selection: { anchor: inserted.length },
    })
  })

  it('moves the source cursor to a right-click outside the current selection', () => {
    codeMirror.dispatch.mockClear()
    render(
      <ContextMenuProvider>
        <SourceEditor markdown="selected text" onChange={() => undefined} />
      </ContextMenuProvider>,
    )

    fireEvent.contextMenu(screen.getByRole('textbox', { name: 'Markdown source' }), {
      clientX: 120,
      clientY: 90,
    })

    expect(codeMirror.view.posAtCoords).toHaveBeenCalledWith({ x: 120, y: 90 })
    expect(codeMirror.dispatch).toHaveBeenCalledWith({
      selection: { anchor: 10 },
    })
  })
})
