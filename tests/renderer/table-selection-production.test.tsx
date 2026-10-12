import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { CellSelection } from '@milkdown/kit/prose/tables'
import { TextSelection } from '@milkdown/kit/prose/state'
import { createRef } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { VisualEditor, type VisualEditorHandle } from '../../src/renderer/editor/VisualEditor'
import * as targets from '../../src/renderer/editor/editor-selection-target'
import { ContextMenuContext } from '../../src/renderer/context-menu/ContextMenuProvider'
import type { ContextMenuRequest } from '../../src/renderer/context-menu/context-menu-types'
import { commandItemById } from '../../src/renderer/context-menu/context-menu-types'

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const originalApi = window.arkdown
const rangeRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
const rangeRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
let view: EditorView | undefined
beforeEach(() => {
  const create = targets.createSelectionTargetPlugin
  vi.spyOn(targets, 'createSelectionTargetPlugin').mockImplementation(() => {
    const plugin = create()
    // Observe the real production view; retain the complete plugin state/props implementation.
    plugin.spec.view = current => { view = current; return {} }
    return plugin
  })
  const rect = { x: 10, y: 20, left: 10, top: 20, right: 90, bottom: 38, width: 80, height: 18, toJSON: () => ({}) } as DOMRect
  const rects = { 0: rect, length: 1, item: () => rect, *[Symbol.iterator]() { yield rect } } as DOMRectList
  for (const prototype of [Range.prototype, Element.prototype]) {
    if (!prototype.getBoundingClientRect) Object.defineProperty(prototype, 'getBoundingClientRect', { configurable: true, value: () => rect })
    else vi.spyOn(prototype, 'getBoundingClientRect').mockReturnValue(rect)
    if (!prototype.getClientRects) Object.defineProperty(prototype, 'getClientRects', { configurable: true, value: () => rects })
    else vi.spyOn(prototype, 'getClientRects').mockReturnValue(rects)
  }
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  window.arkdown = undefined as never
})
afterEach(() => {
  cleanup(); view = undefined
  window.arkdown = originalApi
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (rangeRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', rangeRect)
  else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
  if (rangeRects) Object.defineProperty(Range.prototype, 'getClientRects', rangeRects)
  else Reflect.deleteProperty(Range.prototype, 'getClientRects')
})

async function mount(markdown = '| A | B | C |\n| --- | --- | --- |\n| D | E | F |\n| G | H | I |') {
  let request: ContextMenuRequest | undefined
  const onChange = vi.fn()
  const onStickyNoteSelection = vi.fn()
  const ref = createRef<VisualEditorHandle>()
  const mounted = render(<ContextMenuContext.Provider value={{ openMenu: next => { request = next }, closeMenu() {}, isOpen: false }}>
    <VisualEditor ref={ref} documentKey="synthetic-table" markdown={markdown} onChange={onChange} onStickyNoteSelection={onStickyNoteSelection} />
  </ContextMenuContext.Provider>)
  await waitFor(() => expect(view?.dom.querySelectorAll('th, td')).toHaveLength(9), { timeout: 10_000 })
  const positions: number[] = []
  view!.state.doc.descendants((node, pos) => { if (['table_cell', 'table_header'].includes(node.type.name)) positions.push(pos) })
  act(() => { view!.dispatch(view!.state.tr.setSelection(CellSelection.create(view!.state.doc, positions[0]!, positions[4]!))) })
  await act(async () => { await Promise.resolve() })
  onChange.mockClear()
  return { ref, mounted, positions, onChange, onStickyNoteSelection, get request() { return request! } }
}

function secondaryClick(cell: Element, surface: 'text' | 'padding' | 'empty-paragraph', pointerEvents = true) {
  const paragraph = cell.querySelector('p')!
  const target = surface === 'padding' ? cell : paragraph
  const options = { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: 40, clientY: 28 }
  const pointerDown = new MouseEvent('pointerdown', options)
  if (pointerEvents) fireEvent(target, pointerDown)
  const mouseDown = new MouseEvent('mousedown', options)
  if (!pointerDown.defaultPrevented) fireEvent(target, mouseDown)
  // JSDOM has no native mouse selection default. Model that boundary only; the
  // production ProseMirror observer must read the resulting real DOM selection.
  if (!pointerDown.defaultPrevented && !mouseDown.defaultPrevented) {
    const range = document.createRange()
    if (surface === 'text') range.selectNodeContents(paragraph.firstChild!)
    else { range.selectNodeContents(paragraph); range.collapse(false) }
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    fireEvent(document, new Event('selectionchange'))
  }
  if (pointerEvents) fireEvent(target, new MouseEvent('pointerup', { ...options, buttons: 0 }))
  if (!pointerDown.defaultPrevented) fireEvent(target, new MouseEvent('mouseup', { ...options, buttons: 0 }))
  fireEvent(target, new MouseEvent('contextmenu', { ...options, buttons: 0 }))
  return { pointerDown, mouseDown }
}

it.each([
  ['padding', true], ['text', true], ['padding', false], ['text', false],
] as const)('keeps the rectangle through secondary press, DOM selection and contextmenu on %s (pointer=%s)', async (surface, pointerEvents) => {
  const f = await mount()
  const doc = view!.state.doc
  act(() => view!.focus())
  const selected = view!.state.selection
  vi.spyOn(view!, 'posAtCoords').mockReturnValue({ pos: f.positions[0]! + 2, inside: f.positions[0]! })
  act(() => { secondaryClick(view!.dom.querySelector('th')!, surface, pointerEvents) })
  expect(view!.state.selection.eq(selected)).toBe(true)
  expect(view!.dom.querySelectorAll('.selectedCell')).toHaveLength(4)
  expect(commandItemById(f.request.items, 'table-delete-row')).not.toBeNull()
  expect(commandItemById(f.request.items, 'table-row-after')).toMatchObject({ disabled: true })
  let copied = ''
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied = text } } })
  await f.request.execute('copy-plain')
  expect(copied).toBe('A\tB\nD\tE')
  expect(view!.state.doc).toBe(doc)
  expect(f.onChange).not.toHaveBeenCalled()
})

it('still selects an unselected cell on secondary press even inside the rectangle numeric envelope', async () => {
  const f = await mount()
  act(() => view!.focus())
  vi.spyOn(view!, 'posAtCoords').mockReturnValue({ pos: f.positions[2]! + 2, inside: f.positions[2]! })
  let press!: ReturnType<typeof secondaryClick>
  act(() => { press = secondaryClick(view!.dom.querySelectorAll('th')[2]!, 'text') })
  expect(press.pointerDown.defaultPrevented).toBe(false)
  expect(press.mouseDown.defaultPrevented).toBe(false)
  expect(view!.state.selection).toBeInstanceOf(TextSelection)
  expect(view!.state.doc.textBetween(view!.state.selection.from, view!.state.selection.to)).toBe('C')
  expect(commandItemById(f.request.items, 'table-row-after')?.disabled).not.toBe(true)
})

it('keeps a single-cell text selection as text through the full secondary press sequence', async () => {
  const f = await mount()
  act(() => {
    view!.dispatch(view!.state.tr.setSelection(TextSelection.create(view!.state.doc, f.positions[3]! + 2, f.positions[3]! + 3)))
    view!.focus()
  })
  vi.spyOn(view!, 'posAtCoords').mockReturnValue({ pos: f.positions[3]! + 2, inside: f.positions[3]! })
  let press!: ReturnType<typeof secondaryClick>
  act(() => { press = secondaryClick(view!.dom.querySelector('td')!, 'text') })
  expect(press.pointerDown.defaultPrevented).toBe(false)
  expect(press.mouseDown.defaultPrevented).toBe(false)
  expect(view!.state.selection).toBeInstanceOf(TextSelection)
  expect(view!.dom.querySelectorAll('.selectedCell')).toHaveLength(0)
  let copied = ''
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied = text } } })
  await f.request.execute('copy-plain')
  expect(copied).toBe('D')
  expect(commandItemById(f.request.items, 'table-row-after')?.disabled).not.toBe(true)
})

it.each(['padding', 'empty-paragraph'] as const)('uses the selected DOM cell when %s coordinates resolve into an adjacent unselected cell', async surface => {
  const f = await mount('| A | B | C |\n| --- | --- | --- |\n| D |  | F |\n| G | H | I |')
  act(() => view!.focus())
  const selected = view!.state.selection
  vi.spyOn(view!, 'posAtCoords').mockReturnValue({ pos: f.positions[5]! + 2, inside: f.positions[5]! })
  act(() => { secondaryClick(view!.dom.querySelectorAll('td')[1]!, surface) })
  expect(view!.state.selection.eq(selected)).toBe(true)
  expect(view!.dom.querySelectorAll('.selectedCell')).toHaveLength(4)
  expect(commandItemById(f.request.items, 'table-row-after')).toMatchObject({ disabled: true })
  let copied = ''
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied = text } } })
  await f.request.execute('copy-plain')
  expect(copied).toBe('A\tB\nD\t')
})

it('uses the complete rectangle for native copy/cut and menu Markdown on a real production editor', async () => {
  const f = await mount()
  const doc = view!.state.doc
  const copied = new Map<string, string>()
  const nativeCopy = (type: 'copy' | 'cut') => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { setData: (mime: string, value: string) => copied.set(mime, value) } })
    fireEvent(view!.dom, event)
    expect(event.defaultPrevented).toBe(true)
  }
  nativeCopy('copy')
  expect(copied.get('text/plain')).toBe('A\tB\nD\tE')
  expect(copied.get('text/html')).toContain('<table')
  expect(view!.state.doc).toBe(doc)
  expect(f.onChange).not.toHaveBeenCalled()
  let markdown = ''
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { markdown = text } } })
  vi.spyOn(view!, 'posAtCoords').mockReturnValue({ pos: f.positions[0]! + 2, inside: f.positions[0]! })
  fireEvent.contextMenu(view!.dom.querySelector('th')!)
  await f.request.execute('copy-markdown')
  expect(markdown).toContain('| A | B |')
  expect(markdown).toContain('| D | E |')
  expect(markdown).not.toContain('C')
  expect(f.onChange).not.toHaveBeenCalled()
  await f.request.execute('create-sticky-note')
  const sticky = f.onStickyNoteSelection.mock.calls.at(-1)?.[0]
  expect(sticky.markdown).toBe('A\n\nB\n\nD\n\nE')
  expect(sticky.warnings).toEqual(['局部表格选区已转换为可读文本。'])
  nativeCopy('cut')
  expect(view!.state.doc.firstChild!.childCount).toBe(3)
  expect(view!.state.doc.textContent).toBe('CFGHI')
  expect(f.onChange).toHaveBeenCalled()
})

it('keeps the full rectangle when a native clipboard write fails', async () => {
  const f = await mount()
  const doc = view!.state.doc
  const event = new Event('cut', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { setData: () => { throw new Error('clipboard denied') } } })
  fireEvent(view!.dom, event)
  expect(event.defaultPrevented).toBe(true)
  expect(view!.state.doc).toBe(doc)
  expect(view!.state.selection).toBeInstanceOf(CellSelection)
  expect(f.onChange).not.toHaveBeenCalled()
})

it('serializes a body-only rectangle as Markdown without including the table header', async () => {
  const f = await mount()
  act(() => { view!.dispatch(view!.state.tr.setSelection(CellSelection.create(view!.state.doc, f.positions[3]!, f.positions[7]!))) })
  let markdown = ''
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { markdown = text } } })
  vi.spyOn(view!, 'posAtCoords').mockReturnValue({ pos: f.positions[3]! + 2, inside: f.positions[3]! })
  fireEvent.contextMenu(view!.dom.querySelector('td')!)
  await f.request.execute('copy-markdown')
  expect(markdown).toContain('| D | E |')
  expect(markdown).toContain('| G | H |')
  expect(markdown).not.toContain('A')
  expect(f.onChange).not.toHaveBeenCalled()
})

it('preserves CellSelection against a residual DOM range in toolbar capture and rejects stale insertion', async () => {
  const f = await mount()
  const doc = view!.state.doc
  const text = view!.dom.querySelector('th p')!.firstChild!
  const range = document.createRange(); range.selectNodeContents(text)
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  expect(f.ref.current!.captureSelection()).toBe(true)
  expect(view!.state.selection).toBeInstanceOf(CellSelection)
  expect(f.ref.current!.insertMarkdown('no shrinking')).toBe(false)
  act(() => { view!.dispatch(view!.state.tr.setSelection(TextSelection.create(doc, f.positions[0]! + 2))) })
  window.getSelection()!.removeAllRanges()
  expect(f.ref.current!.captureSelection()).toBe(true)
  act(() => { view!.dispatch(view!.state.tr.insertText('new', f.positions[8]! + 2)) })
  const changed = view!.state.doc
  expect(f.ref.current!.insertMarkdown('stale')).toBe(false)
  expect(view!.state.doc).toBe(changed)
})

it('blocks cross-cell native paste and restores ordinary selection', async () => {
  const f = await mount()
  const doc = view!.state.doc
  const paste = () => {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { types: ['text/plain'], getData: () => 'replacement' } })
    fireEvent(view!.dom, event)
    return event
  }
  expect(view!.dom.dataset.arkdownCrossCellSelection).toBe('true')
  expect(paste().defaultPrevented).toBe(true)
  expect(view!.state.doc).toBe(doc)
  act(() => { view!.dispatch(view!.state.tr.setSelection(TextSelection.create(doc, f.positions[0]! + 2))) })
  expect(view!.dom.hasAttribute('data-arkdown-cross-cell-selection')).toBe(false)
  expect(paste().defaultPrevented).toBe(true)
  expect(view!.state.doc.textContent).toContain('replacementA')
})
