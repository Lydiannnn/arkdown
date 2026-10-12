import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import { CellSelection, tableEditing, tableNodes } from '@milkdown/kit/prose/tables'
import { history, undo } from '@milkdown/kit/prose/history'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContextMenuRequest } from '../../src/renderer/context-menu/context-menu-types'
import { commandItemById } from '../../src/renderer/context-menu/context-menu-types'
import { createVisualContextMenuHandler } from '../../src/renderer/editor/context-menu/visual-context-menu'
import { createSelectionTargetPlugin } from '../../src/renderer/editor/editor-selection-target'

const originalApi = window.arkdown
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
let view: EditorView | undefined
afterEach(() => {
  view?.destroy(); view = undefined
  window.arkdown = originalApi
  window.getSelection()?.removeAllRanges()
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function fixture(reverse = false) {
  const schema = new Schema({ nodes: {
    doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
    ...tableNodes({ tableGroup: 'block', cellContent: 'block+', cellAttributes: {} }), text: {},
  } })
  const rows = [0, 1, 2].map(row => schema.nodes.table_row!.create(null, [0, 1, 2].map(col =>
    schema.nodes.table_cell!.create(null, schema.nodes.paragraph!.create(null, schema.text(`${row}${col}`))))))
  const doc = schema.nodes.doc!.create(null, schema.nodes.table!.create(null, rows))
  const positions: number[] = []
  doc.descendants((node, pos) => { if (node.type.name === 'table_cell') positions.push(pos) })
  const state = EditorState.create({ doc,
    selection: CellSelection.create(doc, positions[reverse ? 5 : 0]!, positions[reverse ? 0 : 5]!),
    plugins: [tableEditing(), history(), createSelectionTargetPlugin()],
  })
  const host = document.body.appendChild(document.createElement('div'))
  view = new EditorView(host, { state, dispatchTransaction(tr) { view!.updateState(view!.state.apply(tr)) } })
  const commit = vi.fn()
  let menu: ContextMenuRequest | undefined
  let lifetime = 1
  window.arkdown = undefined as never
  const handler = createVisualContextMenuHandler({
    crepe: { editor: { action: (run: (context: { get(): EditorView }) => unknown) => run({ get: () => view! }) } } as never,
    menu: { openMenu: next => { menu = next }, closeMenu() {}, isOpen: false },
    commit, getMarkdown: () => '', getSelectionIdentity: () => ({ documentKey: 'synthetic', lifetime }),
  })
  view.dom.addEventListener('contextmenu', handler)
  const paragraphs = [...view.dom.querySelectorAll('td p')]
  function nativeRange(index: number) {
    const text = paragraphs[index]!.firstChild!
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, text.textContent!.length)
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  }
  function rightClick(index: number) {
    vi.spyOn(view!, 'posAtCoords').mockReturnValue({ pos: positions[index]! + 2, inside: positions[index]! })
    paragraphs[index]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 8, clientY: 8 }))
  }
  return { doc, positions, nativeRange, rightClick, commit, advanceLifetime: () => { lifetime += 1 }, get menu() { return menu! } }
}

describe('table selection commands retain their rectangle', () => {
  it.each([0, 1, 5])('retains all six cells with a residual range on right-clicked cell %i', index => {
    const f = fixture(); f.nativeRange(5); f.rightClick(index)
    expect(view!.state.selection).toBeInstanceOf(CellSelection)
    expect(view!.dom.querySelectorAll('.selectedCell')).toHaveLength(6)
    expect(view!.state.doc).toBe(f.doc); expect(f.commit).not.toHaveBeenCalled()
  })
  it.each([false, true])('retains the rectangle without a native range, reverse=%s', reverse => {
    const f = fixture(reverse); window.getSelection()!.removeAllRanges(); f.rightClick(1)
    expect(view!.state.selection).toBeInstanceOf(CellSelection)
    expect(view!.dom.querySelectorAll('.selectedCell')).toHaveLength(6)
  })
  it('retains ordinary selected text and restores normal selection styling on exit', async () => {
    const f = fixture()
    expect(view!.dom.dataset.arkdownCrossCellSelection).toBe('true')
    view!.dispatch(view!.state.tr.setSelection(TextSelection.create(f.doc, f.positions[5]! + 2, f.positions[5]! + 4)))
    f.nativeRange(5); f.rightClick(5)
    expect(view!.state.selection).toBeInstanceOf(TextSelection)
    expect(view!.dom.hasAttribute('data-arkdown-cross-cell-selection')).toBe(false)
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied = value } } })
    await f.menu.execute('copy-plain'); expect(copied).toBe('12')
  })
  it('copies every selected cell in plain text and HTML without committing', async () => {
    const f = fixture(); f.nativeRange(5); f.rightClick(0)
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied = value } } })
    await f.menu.execute('copy-plain'); expect(copied).toBe('00\t01\t02\n10\t11\t12')
    window.getSelection()!.removeAllRanges()
    await f.menu.execute('copy-html')
    const holder = document.createElement('div'); holder.innerHTML = copied
    expect(holder.querySelectorAll('td')).toHaveLength(6)
    expect(holder.textContent).toBe('000102101112')
    expect(view!.state.doc).toBe(f.doc); expect(f.commit).not.toHaveBeenCalled()
  })
  it('deletes both selected rows and supports undo', async () => {
    const f = fixture(); f.nativeRange(5); f.rightClick(1)
    await f.menu.execute('table-delete-row')
    expect(view!.state.doc.firstChild!.childCount).toBe(1)
    expect(view!.state.doc.textContent).toBe('202122')
    undo(view!.state, view!.dispatch)
    expect(view!.state.doc.eq(f.doc)).toBe(true)
  })
  it('clears every selected cell while preserving the table and unselected row', async () => {
    const f = fixture(); f.rightClick(0); await f.menu.execute('delete-selection')
    expect(view!.state.doc.firstChild!.childCount).toBe(3)
    expect(view!.state.doc.textContent).toBe('202122')
  })
  it('deletes both selected columns after a right-click in an interior cell', async () => {
    const f = fixture()
    view!.dispatch(view!.state.tr.setSelection(CellSelection.create(f.doc, f.positions[0]!, f.positions[4]!)))
    f.rightClick(3); await f.menu.execute('table-delete-column')
    expect(view!.state.doc.firstChild!.childCount).toBe(3)
    expect(view!.state.doc.firstChild!.child(0).childCount).toBe(1)
    expect(view!.state.doc.textContent).toBe('021222')
  })
  it('moves to an unselected cell even when it falls inside the rectangle numeric envelope', () => {
    const f = fixture()
    view!.dispatch(view!.state.tr.setSelection(CellSelection.create(f.doc, f.positions[1]!, f.positions[5]!)))
    f.rightClick(3)
    expect(view!.state.selection).toBeInstanceOf(TextSelection)
    expect(view!.state.selection.from).toBe(f.positions[3]! + 2)
    expect(view!.dom.querySelectorAll('.selectedCell')).toHaveLength(0)
  })
  it.each(['reject', 'missing', 'changed', 'lifetime'] as const)('never cuts after clipboard/target failure: %s', async fault => {
    const f = fixture(); f.rightClick(1)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: fault === 'missing' ? {} : {
      writeText: async () => {
        if (fault === 'reject') throw new Error('denied')
        if (fault === 'lifetime') f.advanceLifetime()
        if (fault === 'changed') view!.dispatch(view!.state.tr.insertText('x', f.positions[8]! + 2))
      },
    } })
    await f.menu.execute('cut')
    expect(view!.state.doc.firstChild!.child(0).textContent).toBe('000102')
    expect(view!.state.doc.firstChild!.child(1).textContent).toBe('101112')
    expect(f.commit).not.toHaveBeenCalled()
  })
  it('cuts only after successful copy and ignores live selection drift', async () => {
    const f = fixture(); f.rightClick(1)
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => {
      copied = text
      expect(view!.state.doc).toBe(f.doc)
      view!.dispatch(view!.state.tr.setSelection(TextSelection.create(f.doc, f.positions[8]! + 2)))
    } } })
    await f.menu.execute('cut')
    expect(copied).toBe('00\t01\t02\n10\t11\t12')
    expect(view!.state.doc.textContent).toBe('202122')
  })
  it('rejects a delayed menu after the document lifetime changed', async () => {
    const f = fixture()
    let resolve!: (value: unknown) => void
    window.arkdown = { readClipboardFormats: () => new Promise(done => { resolve = done }) } as never
    f.rightClick(1); f.advanceLifetime()
    resolve({ ok: true, value: { plainText: 'paste', markdown: null, html: null } })
    await Promise.resolve()
    expect(f.menu).toBeUndefined()
  })
  it('does not let an earlier clipboard read reopen an obsolete menu', async () => {
    const f = fixture()
    const pending: Array<(value: unknown) => void> = []
    window.arkdown = { readClipboardFormats: () => new Promise(done => { pending.push(done) }) } as never
    f.rightClick(0); f.rightClick(1)
    pending[1]!({ ok: true, value: { plainText: 'new', markdown: null, html: null } })
    await Promise.resolve()
    const latest = f.menu
    pending[0]!({ ok: true, value: { plainText: 'old', markdown: null, html: null } })
    await Promise.resolve()
    expect(f.menu).toBe(latest)
  })
  it('visibly disables unsupported cross-cell commands and rejects direct execution', async () => {
    const f = fixture(); f.rightClick(0)
    for (const id of ['paste', 'paste-html', 'table-align-left', 'table-move-row-down', 'table-row-after']) {
      expect(commandItemById(f.menu.items, id)).toMatchObject({ disabled: true, disabledReason: expect.any(String) })
      await f.menu.execute(id)
    }
    expect(view!.state.doc).toBe(f.doc); expect(f.commit).not.toHaveBeenCalled()
  })
})
