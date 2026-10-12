import { act, render, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from 'vitest'
import { Crepe } from '@milkdown/crepe'
import { editorViewCtx, serializerCtx } from '@milkdown/kit/core'
import { VisualEditor } from '../../src/renderer/editor/VisualEditor'

const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
const originalRangeBounds = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
const originalElementRects = Object.getOwnPropertyDescriptor(Element.prototype, 'getClientRects')
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
const originalElementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')

function rect(): DOMRect {
  return {
    x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 24,
    width: 640, height: 24, toJSON: () => ({}),
  } as DOMRect
}

function rects(): DOMRectList {
  const value = rect()
  return {
    0: value,
    length: 1,
    item: (index) => index === 0 ? value : null,
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
  const restore = (target: object, key: PropertyKey, descriptor?: PropertyDescriptor) => {
    if (descriptor) Object.defineProperty(target, key, descriptor)
    else Reflect.deleteProperty(target, key)
  }
  restore(Range.prototype, 'getClientRects', originalRangeRects)
  restore(Range.prototype, 'getBoundingClientRect', originalRangeBounds)
  restore(Element.prototype, 'getClientRects', originalElementRects)
  restore(Element.prototype, 'scrollIntoView', originalScrollIntoView)
  restore(document, 'elementFromPoint', originalElementFromPoint)
  vi.unstubAllGlobals()
})

it('toggles spelling on the live production Milkdown view without rebuilding or emitting Markdown', async () => {
  const onChange = vi.fn()
  const onReady = vi.fn()
  const { container, rerender } = render(
    <VisualEditor
      markdown="# Live heading\n\nRendered body"
      onChange={onChange}
      onReady={onReady}
      spellCheckEnabled={false}
    />,
  )
  await waitFor(() => expect(onReady).toHaveBeenCalledOnce(), { timeout: 10_000 })
  const proseMirror = container.querySelector<HTMLElement>('.ProseMirror')!
  await waitFor(() => expect(proseMirror).toHaveAttribute('spellcheck', 'false'))
  const htmlBefore = proseMirror.innerHTML

  rerender(
    <VisualEditor
      markdown="# Live heading\n\nRendered body"
      onChange={onChange}
      onReady={onReady}
      spellCheckEnabled
    />,
  )

  await waitFor(() => expect(proseMirror).toHaveAttribute('spellcheck', 'true'))
  expect(container.querySelector('.ProseMirror')).toBe(proseMirror)
  expect(proseMirror.innerHTML).toBe(htmlBefore)
  expect(onReady).toHaveBeenCalledOnce()
  expect(onChange).not.toHaveBeenCalled()
}, 15_000)

it('passes each real ordered-list start to its visual counter and keeps it current after edits', async () => {
  const editorAccess = vi.spyOn(Crepe.prototype, 'editor', 'get')
  onTestFinished(() => editorAccess.mockRestore())
  const onReady = vi.fn()
  const onChange = vi.fn()
  const markdown = '5. First\n\n   3. Nested\n   4. Next nested\n\n6. Second\n\nSeparator\n\n9. Continued\n\nSeparator\n\n1. Ordinary\n\nTail'
  const { container } = render(
    <VisualEditor markdown={markdown} onChange={onChange} onReady={onReady} />,
  )
  await waitFor(() => expect(onReady).toHaveBeenCalledOnce(), { timeout: 10_000 })
  const lists = () => Array.from(container.querySelectorAll('ol'), (ol) => ({
    start: ol.start,
    counterStart: ol.style.getPropertyValue('--arkdown-ordered-list-start'),
  }))
  expect(lists()).toEqual([
    { start: 5, counterStart: '4' },
    { start: 3, counterStart: '2' },
    { start: 9, counterStart: '8' },
    { start: 1, counterStart: '0' },
  ])
  expect(onChange).not.toHaveBeenCalled()
  const editor = editorAccess.mock.results[0]!.value as Crepe['editor']
  const view = editor.action((ctx) => ctx.get(editorViewCtx))
  const serialize = () => editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc))
  const originalDocument = view.state.doc.toJSON()
  expect(serialize()).not.toContain('--arkdown')
  expect(view.state.doc.toJSON()).toEqual(originalDocument)

  // Real ProseMirror insert/delete transactions leave the list's own start intact.
  const added = view.state.schema.nodes.list_item.create(null,
    view.state.schema.nodes.paragraph.create(null, view.state.schema.text('Inserted')))
  await act(async () => { view.dispatch(view.state.tr.insert(1, added)) })
  expect(container.querySelector('ol')!.children).toHaveLength(3)
  expect(lists()[0]).toEqual({ start: 5, counterStart: '4' })
  await act(async () => { view.dispatch(view.state.tr.delete(1, 1 + added.nodeSize)) })
  expect(container.querySelector('ol')!.children).toHaveLength(2)
  expect(view.state.doc.toJSON()).toEqual(originalDocument)
  await act(async () => {
    view.dispatch(view.state.tr.setNodeMarkup(0, undefined, { ...view.state.doc.firstChild!.attrs, order: 12 }))
  })
  expect(lists()[0]).toEqual({ start: 12, counterStart: '11' })
  expect(lists()[1]).toEqual({ start: 3, counterStart: '2' })
  expect(serialize()).toMatch(/^12\. First/u)
}, 15_000)
