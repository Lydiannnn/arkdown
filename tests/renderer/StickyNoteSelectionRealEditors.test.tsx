import { EditorView } from '@codemirror/view'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { ContextMenuProvider } from '../../src/renderer/context-menu/ContextMenuProvider'
import { SourceEditor } from '../../src/renderer/editor/SourceEditor'
import { VisualEditor } from '../../src/renderer/editor/VisualEditor'

const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
const originalRangeBounds = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
const originalElementRects = Object.getOwnPropertyDescriptor(Element.prototype, 'getClientRects')
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
const originalElementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')

function rect(): DOMRect {
  return {
    x: 12, y: 24, left: 12, top: 24, right: 92, bottom: 44,
    width: 80, height: 20, toJSON: () => ({}),
  } as DOMRect
}

function rects(): DOMRectList {
  const value = rect()
  return {
    0: value,
    length: 1,
    item: (index: number) => index === 0 ? value : null,
    [Symbol.iterator]: function* () { yield value },
  } as DOMRectList
}

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
class IntersectionObserverStub {
  root = null
  rootMargin = '0px'
  thresholds = [0]
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] { return [] }
}

beforeAll(() => {
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: rects })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: rect })
  Object.defineProperty(Element.prototype, 'getClientRects', { configurable: true, value: rects })
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => undefined })
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null })
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
})

afterAll(() => {
  const restore = (target: object, key: PropertyKey, value?: PropertyDescriptor) => {
    if (value) Object.defineProperty(target, key, value)
    else Reflect.deleteProperty(target, key)
  }
  restore(Range.prototype, 'getClientRects', originalRangeRects)
  restore(Range.prototype, 'getBoundingClientRect', originalRangeBounds)
  restore(Element.prototype, 'getClientRects', originalElementRects)
  restore(Element.prototype, 'scrollIntoView', originalScrollIntoView)
  restore(document, 'elementFromPoint', originalElementFromPoint)
  vi.unstubAllGlobals()
})

it('freezes the exact real CodeMirror selection before opening its context menu', async () => {
  const markdown = 'Before\n\n- **bold**\n- [link](https://example.com)\n\nAfter'
  const onStickyNoteSelection = vi.fn()
  const onCreateStickyNote = vi.fn()
  render(
    <ContextMenuProvider>
      <SourceEditor
        markdown={markdown}
        onChange={() => undefined}
        onStickyNoteSelection={onStickyNoteSelection}
        onCreateStickyNote={onCreateStickyNote}
      />
    </ContextMenuProvider>,
  )
  const content = await waitFor(() => document.querySelector<HTMLElement>('.cm-content')!)
  const view = EditorView.findFromDOM(content.closest<HTMLElement>('.cm-editor')!)!
  const from = markdown.indexOf('- **bold**')
  const to = markdown.indexOf('\n\nAfter')
  view.dispatch({ selection: { anchor: from, head: to } })

  fireEvent.contextMenu(content.closest('.source-editor-context')!, { clientX: 40, clientY: 50 })
  fireEvent.click(screen.getByRole('menuitem', { name: '建立便签' }))
  expect(onCreateStickyNote).toHaveBeenCalledOnce()

  expect(onStickyNoteSelection).toHaveBeenCalledWith({
    markdown: '- **bold**\n- [link](https://example.com)',
    localResources: [],
    warnings: [],
  })
})

it('serializes a real full Milkdown selection with common Markdown structures and resources', async () => {
  const onStickyNoteSelection = vi.fn()
  const onCreateStickyNote = vi.fn()
  const markdown = [
    '# 标题',
    '',
    '**粗体**、*斜体*与[链接](https://example.com)',
    '',
    '> 引用',
    '',
    '```ts',
    'const value = 1',
    '```',
    '',
    '1. 有序项',
    '',
    '- 无序项',
    '',
    '- [ ] 任务项',
    '',
    '| 名称 | 值 |',
    '| --- | --- |',
    '| A | B |',
    '',
    '![本地图](C:\\workspace\\image.png)',
  ].join('\n')
  const mounted = render(
    <ContextMenuProvider>
      <VisualEditor
        markdown={markdown}
        onChange={() => undefined}
        onStickyNoteSelection={onStickyNoteSelection}
        onCreateStickyNote={onCreateStickyNote}
      />
    </ContextMenuProvider>,
  )
  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = await waitFor(() => {
    const value = root.querySelector<HTMLElement>('.ProseMirror')
    expect(value?.textContent).toContain('标题')
    expect(value?.textContent).toContain('任务项')
    return value!
  }, { timeout: 10_000 })
  const range = document.createRange()
  range.selectNodeContents(proseMirror)
  const browserSelection = window.getSelection()!
  browserSelection.removeAllRanges()
  browserSelection.addRange(range)

  fireEvent.contextMenu(proseMirror, { clientX: 30, clientY: 30 })
  await act(async () => { await Promise.resolve() })
  fireEvent.click(screen.getByRole('menuitem', { name: '建立便签' }))
  expect(onCreateStickyNote).toHaveBeenCalledOnce()

  expect(onStickyNoteSelection).toHaveBeenCalledOnce()
  const exported = onStickyNoteSelection.mock.calls[0]![0]
  expect(exported.markdown).toContain('# 标题')
  expect(exported.markdown).toContain('**粗体**')
  expect(exported.markdown).toContain('[链接](https://example.com)')
  expect(exported.markdown).toContain('> 引用')
  expect(exported.markdown).toContain('```ts')
  expect(exported.markdown).toContain('1. 有序项')
  expect(exported.markdown).toMatch(/[\*-] 无序项/u)
  expect(exported.markdown).toMatch(/[\*-] \[ \] 任务项/u)
  expect(exported.markdown).toContain('| 名称 | 值 |')
  expect(exported.markdown).toContain('![本地图]')
  expect(exported.localResources).toEqual([
    { originalReference: 'C:\\workspace\\image.png', absolutePath: 'C:\\workspace\\image.png' },
  ])

  mounted.unmount()
  await act(async () => { await Promise.resolve() })
})
