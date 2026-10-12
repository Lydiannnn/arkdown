import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AllSelection, NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import { undo, redo } from '@milkdown/kit/prose/history'
import type { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { VisualEditor } from '../../src/renderer/editor/VisualEditor'
import { StickyNoteEditor } from '../../src/renderer/sticky-notes/StickyNoteEditor'
import { StickyNoteToolbar } from '../../src/renderer/sticky-notes/StickyNoteToolbar'
import { DocumentHeader } from '../../src/renderer/chrome/DocumentHeader'
import * as targets from '../../src/renderer/editor/editor-selection-target'
import { ContextMenuProvider } from '../../src/renderer/context-menu/ContextMenuProvider'

let view: EditorView | undefined
const rangeBounds = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
const rangeRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
beforeEach(() => {
  vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined)
  const create = targets.createSelectionTargetPlugin
  vi.spyOn(targets, 'createSelectionTargetPlugin').mockImplementation(() => {
    const plugin = create()
    plugin.spec.view = current => { view = current; return {} }
    return plugin
  })
  const rect = { x: 10, y: 20, left: 10, top: 20, right: 90, bottom: 38, width: 80, height: 18, toJSON: () => ({}) } as DOMRect
  const rects = { 0: rect, length: 1, item: () => rect, *[Symbol.iterator]() { yield rect } } as DOMRectList
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect })
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => rects })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
})
afterEach(() => {
  cleanup(); view = undefined
  window.getSelection()?.removeAllRanges()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  for (const [name, descriptor] of [['getBoundingClientRect', rangeBounds], ['getClientRects', rangeRects]] as const) {
    if (descriptor) Object.defineProperty(Range.prototype, name, descriptor)
    else Reflect.deleteProperty(Range.prototype, name)
  }
})

const markdown = '- [x] **first**\n- [ ] [second](https://example.com)\n- [x] third\n'
async function mount(kind: 'main' | 'sticky', source = markdown) {
  const onChange = vi.fn()
  const onStickyNoteSelection = vi.fn()
  const mounted = render(<ContextMenuProvider>{kind === 'sticky' ? <>
    <StickyNoteToolbar /><StickyNoteEditor documentKey="list-fixture" markdown={source} onChange={onChange} />
  </> : <>
    <DocumentHeader fileName="synthetic.md" hasOriginal onRename={async () => true}
      onCommand={command => window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: command }))} />
    <VisualEditor documentKey="list-fixture" markdown={source} onChange={onChange} onStickyNoteSelection={onStickyNoteSelection} />
  </>}</ContextMenuProvider>)
  await waitFor(() => expect(view?.state.doc.content.size).toBeGreaterThan(0), { timeout: 10_000 })
  await act(async () => { await Promise.resolve() })
  // Let the production trailing-block plugin normalize before capturing the undo baseline.
  act(() => view!.dispatch(view!.state.tr))
  onChange.mockClear()
  return { mounted, onChange, onStickyNoteSelection }
}

for (const kind of ['main', 'sticky'] as const) {
  for (const selectionKind of ['all', 'full-text', 'partial-reverse'] as const) {
    it.each(['有序列表', '无序列表', '任务列表'])(`${kind} ${selectionKind} toolbar %s transforms once and undo/redo restores rich content`, async label => {
      const f = await mount(kind)
      const before = view!.state.doc
      const text: Array<{ pos: number; size: number }> = []
      before.descendants((node, pos) => { if (node.isTextblock && node.content.size) text.push({ pos: pos + 1, size: node.content.size }) })
      act(() => view!.dispatch(view!.state.tr.setSelection(selectionKind === 'all' ? new AllSelection(before)
        : selectionKind === 'full-text' ? TextSelection.create(before, text[0]!.pos, text.at(-1)!.pos + text.at(-1)!.size)
          : TextSelection.create(before, text.at(-1)!.pos + text.at(-1)!.size - 1, text[0]!.pos + 1))))
      const dispatch = vi.spyOn(view!, 'dispatch')
      fireEvent.click(screen.getByRole('button', { name: label }))
      await act(async () => { await Promise.resolve() })
      const changed = dispatch.mock.calls.filter(([tr]) => tr.docChanged)
      expect(changed).toHaveLength(1)
      const after = view!.state.doc
      expect(after.textContent).toBe(before.textContent)
      expect(after.firstChild?.type.name).toBe(label === '任务列表' ? 'paragraph' : label === '有序列表' ? 'ordered_list' : 'bullet_list')
      if (label !== '任务列表') expect(after.firstChild?.childCount).toBe(3)
      expect(JSON.stringify(after.toJSON())).toContain('strong')
      expect(JSON.stringify(after.toJSON())).toContain('https://example.com')
      expect(f.onChange).toHaveBeenCalled()
      act(() => { expect(undo(view!.state, view!.dispatch)).toBe(true) })
      expect(view!.state.doc.toJSON()).toEqual(before.toJSON())
      act(() => { expect(redo(view!.state, view!.dispatch)).toBe(true) })
      expect(view!.state.doc.toJSON()).toEqual(after.toJSON())
    })
  }
}

it('exports a reverse middle ordered selection with offset without mutating the production editor', async () => {
  const f = await mount('main', '5. first\n6. **middle**\n7. [last](https://example.com)\n8. after')
  const before = view!.state.doc
  const text: Array<{ pos: number; size: number }> = []
  before.descendants((node, pos) => { if (node.isTextblock && node.content.size) text.push({ pos: pos + 1, size: node.content.size }) })
  act(() => view!.dispatch(view!.state.tr.setSelection(TextSelection.create(before, text[2]!.pos + text[2]!.size, text[1]!.pos))))
  window.getSelection()?.removeAllRanges()
  f.onChange.mockClear()
  fireEvent.contextMenu(view!.dom)
  expect(f.onStickyNoteSelection).toHaveBeenCalled()
  const result = f.onStickyNoteSelection.mock.calls.at(-1)![0]
  expect(result.markdown).toContain('6. **middle**')
  expect(result.markdown).toContain('7. [last](https://example.com)')
  expect(result.markdown).not.toContain('first')
  expect(result.markdown).not.toContain('after')
  expect(view!.state.doc).toBe(before)
  expect(f.onChange).not.toHaveBeenCalled()
})

it.each([
  ['hr', '---', /(?:---|\*\*\*|___)/u],
  ['code_block', '```js\nconst selected = true\n```', /```js\nconst selected = true\n```/u],
] as const)('exports an authoritative %s NodeSelection without surrounding paragraphs', async (nodeName, content, expected) => {
  const f = await mount('main', `before\n\n${content}\n\nafter`)
  const before = view!.state.doc
  let position = -1
  before.descendants((node, pos) => { if (node.type.name === nodeName) position = pos })
  expect(position).toBeGreaterThanOrEqual(0)
  act(() => view!.dispatch(view!.state.tr.setSelection(NodeSelection.create(before, position))))
  window.getSelection()?.removeAllRanges()
  f.onChange.mockClear()
  fireEvent.contextMenu(view!.dom)
  const exported = f.onStickyNoteSelection.mock.calls[0]![0].markdown
  expect(exported).toMatch(expected)
  expect(exported).not.toContain('before')
  expect(exported).not.toContain('after')
  expect(view!.state.doc).toBe(before)
  expect(f.onChange).not.toHaveBeenCalled()
})

it('keeps a genuinely different DOM range around a leaf block exact', async () => {
  const f = await mount('main', 'before\n\n---\n\nafter')
  const hr = view!.dom.querySelector('hr')!
  const range = document.createRange()
  range.selectNode(hr)
  const selection = window.getSelection()!
  selection.removeAllRanges(); selection.addRange(range)
  fireEvent.contextMenu(view!.dom)
  const exported = f.onStickyNoteSelection.mock.calls[0]![0].markdown
  expect(exported).toMatch(/(?:---|\*\*\*|___)/u)
  expect(exported).not.toContain('before')
  expect(exported).not.toContain('after')
})

it.each(['有序列表', '无序列表', '任务列表'])('reopens serialized %s conversion with the same content, nesting and marks', async label => {
  const f = await mount('main')
  act(() => view!.dispatch(view!.state.tr.setSelection(new AllSelection(view!.state.doc))))
  fireEvent.click(screen.getByRole('button', { name: label }))
  await act(async () => { await Promise.resolve() })
  const semantic = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(semantic)
    if (value && typeof value === 'object') {
      const node = value as { type?: string; content?: Array<{ type?: string; content?: unknown[] }> }
      if (node.type === 'doc' && node.content) {
        const content = [...node.content]
        // The editor-only trailing insertion paragraph is omitted by Markdown serialization.
        while (content.at(-1)?.type === 'paragraph' && !content.at(-1)?.content?.length) content.pop()
        return { type: 'doc', content: content.map(semantic) }
      }
      return Object.fromEntries(Object.entries(value).filter(([key]) => !['label', 'spread'].includes(key)).map(([key, item]) => [key, semantic(item)]))
    }
    return value
  }
  const expected = semantic(view!.state.doc.toJSON())
  const serialized = f.onChange.mock.calls.at(-1)![0]
  f.mounted.unmount(); view = undefined
  await mount('main', serialized)
  expect(semantic(view!.state.doc.toJSON())).toEqual(expected)
})

it('serializes and reparses a nested boundary without restoring unselected parent text', async () => {
  const f = await mount('main', '5. first\n\n   9. skip\n   10. nested\n6. ending\n7. after')
  let from = 0; let to = 0
  view!.state.doc.descendants((node, pos) => { if (node.text === 'nested') from = pos + 2; if (node.text === 'ending') to = pos + 3 })
  expect(from).toBeGreaterThan(0)
  act(() => view!.dispatch(view!.state.tr.setSelection(TextSelection.create(view!.state.doc, from, to))))
  window.getSelection()?.removeAllRanges()
  fireEvent.contextMenu(view!.dom)
  const exported = f.onStickyNoteSelection.mock.calls.at(-1)![0].markdown
  expect(exported).toContain('10. sted')
  expect(exported).toContain('6. end')
  expect(exported).not.toContain('first')
  expect(exported).not.toContain('skip')
  expect(exported).toBe('5.\n   10. sted\n6. end')
  f.mounted.unmount(); view = undefined
  await mount('main', exported)
  const outer = view!.state.doc.firstChild!
  expect(outer.type.name).toBe('ordered_list')
  expect(outer.attrs.order).toBe(5)
  expect(outer.firstChild?.child(1).attrs.order).toBe(10)
  expect(outer.textContent).toBe('stedend')
})
