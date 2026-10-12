import { undoDepth } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef, useState, type CSSProperties } from 'react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { SourceEditor } from '../../src/renderer/editor/SourceEditor'
import type { SourceEditorHandle } from '../../src/renderer/editor/SourceEditor'
import { VisualEditor } from '../../src/renderer/editor/VisualEditor'
import type { VisualEditorHandle } from '../../src/renderer/editor/VisualEditor'
import type {
  TranslationHistoryEditorPort,
  TranslationHistoryRecord,
} from '../../src/renderer/editor/translation-history'
import { createSourceTranslationHistoryAnchor } from '../../src/renderer/editor/source-translation-history'

const rangeClientRectsDescriptor = Object.getOwnPropertyDescriptor(
  Range.prototype,
  'getClientRects',
)
const rangeBoundingRectDescriptor = Object.getOwnPropertyDescriptor(
  Range.prototype,
  'getBoundingClientRect',
)
const elementClientRectsDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'getClientRects',
)
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'scrollIntoView',
)
const elementFromPointDescriptor = Object.getOwnPropertyDescriptor(
  document,
  'elementFromPoint',
)

let currentSelectionRect: DOMRect | null = null

function testRect(): DOMRect {
  if (currentSelectionRect) return currentSelectionRect
  return {
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    right: 90,
    bottom: 38,
    width: 80,
    height: 18,
    toJSON: () => ({}),
  } as DOMRect
}

afterEach(() => {
  currentSelectionRect = null
})

function testRectList(): DOMRectList {
  const rect = testRect()
  return {
    0: rect,
    length: 1,
    item: (index: number) => index === 0 ? rect : null,
    [Symbol.iterator]: function* () {
      yield rect
    },
  } as DOMRectList
}

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class TestIntersectionObserver {
  root = null
  rootMargin = '0px'
  scrollMargin = '0px'
  thresholds = [0]
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

beforeAll(() => {
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: testRectList,
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: testRect,
  })
  Object.defineProperty(Element.prototype, 'getClientRects', {
    configurable: true,
    value: testRectList,
  })
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => undefined,
  })
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => null,
  })
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
})

afterAll(() => {
  const restore = (
    target: object,
    key: PropertyKey,
    descriptor: PropertyDescriptor | undefined,
  ) => {
    if (descriptor) Object.defineProperty(target, key, descriptor)
    else Reflect.deleteProperty(target, key)
  }
  restore(Range.prototype, 'getClientRects', rangeClientRectsDescriptor)
  restore(Range.prototype, 'getBoundingClientRect', rangeBoundingRectDescriptor)
  restore(Element.prototype, 'getClientRects', elementClientRectsDescriptor)
  restore(Element.prototype, 'scrollIntoView', scrollIntoViewDescriptor)
  restore(document, 'elementFromPoint', elementFromPointDescriptor)
  vi.unstubAllGlobals()
})

function firePointer(
  target: Element | Document,
  type: 'pointerdown' | 'pointerup',
  pointerId: number,
  clientX = 0,
  clientY = 0,
): void {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY })
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: pointerId },
    pointerType: { value: 'mouse' },
  })
  fireEvent(target, event)
}

function findTextNode(root: Element, text: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.includes(text)) return node as Text
  }
  throw new Error(`Text node not found: ${text}`)
}

it('captures a real Milkdown DOM selection only after composition ends and a new gesture starts', async () => {
  const onChange = vi.fn()
  const onTranslationSelection = vi.fn()
  const mounted = render(
    <VisualEditor
      markdown="Rendered text"
      onChange={onChange}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = await waitFor(() => {
    const surface = root.querySelector<HTMLElement>('.ProseMirror')
    expect(surface).not.toBeNull()
    expect(surface?.textContent).toContain('Rendered text')
    return surface!
  }, { timeout: 10_000 })
  const textNode = findTextNode(proseMirror, 'Rendered text')
  const range = document.createRange()
  range.setStart(textNode, 0)
  range.setEnd(textNode, 'Rendered text'.length)
  const browserSelection = window.getSelection()!

  fireEvent.compositionStart(proseMirror)
  firePointer(proseMirror, 'pointerdown', 40)
  browserSelection.removeAllRanges()
  browserSelection.addRange(range)
  firePointer(proseMirror, 'pointerup', 40)
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
  expect(onTranslationSelection).not.toHaveBeenCalled()

  fireEvent.compositionEnd(proseMirror)
  firePointer(proseMirror, 'pointerdown', 41)
  browserSelection.removeAllRanges()
  browserSelection.addRange(range)
  firePointer(proseMirror, 'pointerup', 41)
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })

  expect(onTranslationSelection).toHaveBeenCalledOnce()
  expect(onTranslationSelection).toHaveBeenCalledWith({
    content: { markdown: 'Rendered text', plainText: 'Rendered text' },
    range: { from: 1, to: 14 },
    mode: 'visual',
    anchorRect: {
      left: 10,
      top: 20,
      right: 90,
      bottom: 38,
      width: 80,
      height: 18,
    },
    focusRect: {
      left: 90,
      top: 20,
      right: 90,
      bottom: 38,
      width: 0,
      height: 18,
    },
    releaseRect: {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    },
  })
  expect(proseMirror.textContent).toContain('Rendered text')
  expect(browserSelection.toString()).toBe('Rendered text')
  expect(onChange).not.toHaveBeenCalled()
  mounted.unmount()
  await act(async () => {
    await Promise.resolve()
  })
})

it('opens the actual code language picker and persists a chosen language', async () => {
  vi.stubGlobal('IntersectionObserver', class extends TestIntersectionObserver {
    constructor(private callback: IntersectionObserverCallback) { super() }
    observe(target?: Element) {
      if (target) queueMicrotask(() => this.callback([{ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry], this))
    }
  })
  const onChange = vi.fn()
  const mounted = render(<VisualEditor markdown={'```javascript\nconst answer = 42\n```'} onChange={onChange} />)
  try {
    const button = await waitFor(() => {
      const value = mounted.container.querySelector<HTMLButtonElement>('.milkdown-code-block .language-button')
      expect(value).toHaveTextContent('javascript')
      return value!
    }, { timeout: 10_000 })
    fireEvent.click(button)
    const input = await waitFor(() => {
      const value = mounted.container.querySelector<HTMLInputElement>('.language-picker .search-input')
      expect(value).not.toBeNull()
      return value!
    })
    fireEvent.input(input, { target: { value: 'typescript' } })
    const option = await waitFor(() => {
      const value = mounted.container.querySelector<HTMLElement>('.language-list-item[data-language="TypeScript"]')
      expect(value).not.toBeNull()
      return value!
    })
    fireEvent.click(option)
    await waitFor(() => expect(button).toHaveTextContent('TypeScript'))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.stringContaining('```TypeScript\nconst answer = 42')))
  } finally {
    mounted.unmount()
    await act(async () => { await Promise.resolve() })
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
  }
})

it('renders CommonMark autolinks and literal edge cases with real Crepe', async () => {
  const delAutolink = `<https://example.com/${String.fromCharCode(0x7f)}>`
  const markdown = [
    'before',
    '',
    '<https://example.com/docs>',
    '',
    '[https://example.com/docs](https://example.com/docs)',
    '',
    '<user@example.com>',
    '',
    '<mailto:user@example.com>',
    '',
    '<https://example.com/a_b~c?q=x_y>',
    '',
    '<foo_bar@example.com>',
    '',
    '<mailto:foo_bar@example.com>',
    '',
    '<https://example.com/\\_x>',
    '',
    delAutolink,
    '',
    '<foo!bar@example.com>',
    '',
    '`<https://example.com/docs>`',
    '',
    '<https://example.com/docs>',
    '',
    'after',
  ].join('\n')
  const mounted = render(
    <VisualEditor
      documentKey="autolinks.md"
      markdown={markdown}
      onChange={() => undefined}
    />,
  )
  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = await waitFor(() => {
    const surface = root.querySelector<HTMLElement>('.ProseMirror')
    expect(surface).not.toBeNull()
    expect(surface?.textContent).toContain('before')
    expect(surface?.textContent).toContain('user@example.com')
    expect(surface?.textContent).toContain('https://example.com/a_b~c?q=x_y')
    expect(surface?.textContent).toContain('foo_bar@example.com')
    expect(surface?.textContent).toContain('https://example.com/\\_x')
    expect(surface?.textContent).toContain(delAutolink)
    expect(surface?.textContent).toContain('<foo!bar@example.com>')
    return surface!
  }, { timeout: 10_000 })

  expect(proseMirror.querySelector('a[href="https://example.com/docs"]'))
    .toHaveTextContent('https://example.com/docs')
  mounted.unmount()
  await act(async () => {
    await Promise.resolve()
  })
})

it('exports the real Milkdown slice instead of rebuilding Markdown from DOM text', async () => {
  const onTranslationSelection = vi.fn()
  const mounted = render(
    <VisualEditor
      markdown="Before [linked](https://example.com) after"
      onChange={() => undefined}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  const proseMirror = await waitFor(() => {
    const surface = mounted.container.querySelector<HTMLElement>('.ProseMirror')
    expect(surface?.textContent).toContain('Before linked after')
    return surface!
  }, { timeout: 10_000 })
  const textNode = findTextNode(proseMirror, 'linked')
  const range = document.createRange()
  range.setStart(textNode, 0)
  range.setEnd(textNode, 'linked'.length)
  const browserSelection = window.getSelection()!

  firePointer(proseMirror, 'pointerdown', 45)
  browserSelection.removeAllRanges()
  browserSelection.addRange(range)
  firePointer(proseMirror, 'pointerup', 45)
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })

  expect(onTranslationSelection).toHaveBeenCalledWith({
    content: {
      markdown: '[linked](https://example.com)',
      plainText: 'linked',
    },
    range: { from: 8, to: 14 },
    mode: 'visual',
    anchorRect: {
      left: 10,
      top: 20,
      right: 90,
      bottom: 38,
      width: 80,
      height: 18,
    },
    focusRect: {
      left: 10,
      top: 20,
      right: 10,
      bottom: 38,
      width: 0,
      height: 18,
    },
    releaseRect: {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    },
  })
  expect(browserSelection.toString()).toBe('linked')
  mounted.unmount()
  await act(async () => { await Promise.resolve() })
})

it.each([
  {
    name: 'both items of a non-one-start ordered list',
    markdown: 'Outside before\n\n2. Lei\n3. Lin\n\nOutside after',
    startText: 'Lei', startOffset: 0, endText: 'Lin', endOffset: 3,
    expectedMarkdown: '2. Lei\n3. Lin',
  },
  {
    name: 'the middle item with its actual number',
    markdown: '2. Lei\n3. Lin\n4. Outside after',
    startText: 'Lin', startOffset: 0, endText: 'Lin', endOffset: 3,
    expectedMarkdown: '3. Lin',
  },
  {
    name: 'only selected characters without adjacent item text',
    markdown: '2. Outside before\n3. left KEEP right\n4. Outside after',
    startText: 'left KEEP right', startOffset: 5, endText: 'left KEEP right', endOffset: 9,
    expectedMarkdown: '3. KEEP',
  },
  {
    name: 'the selected nested list without unselected parent or sibling text',
    markdown: '2. Outside parent\n\n   4. Outside inner\n   5. Lei\n   6. Lin\n3. Outside after',
    startText: 'Lei', startOffset: 0, endText: 'Lin', endOffset: 3,
    expectedMarkdown: '5. Lei\n6. Lin',
  },
  {
    name: 'a nested-to-outer selection without unselected ancestor text',
    markdown: '2. Outside parent\n\n   4. Outside inner\n   5. Lei\n3. Lin',
    startText: 'Lei', startOffset: 0, endText: 'Lin', endOffset: 3,
    expectedMarkdown: '2.\n   5. Lei\n3. Lin',
    compareStructure: true,
  },
])('exports $name from real Milkdown DOM endpoints', async (fixture) => {
  const onChange = vi.fn()
  const onTranslationSelection = vi.fn()
  const mounted = render(<VisualEditor markdown={fixture.markdown} onChange={onChange}
    onTranslationSelection={onTranslationSelection} />)
  try {
    const proseMirror = await waitFor(() => {
      const surface = mounted.container.querySelector<HTMLElement>('.ProseMirror')
      expect(surface?.textContent).toContain(fixture.endText)
      return surface!
    }, { timeout: 10_000 })
    const before = proseMirror.textContent
    const startNode = findTextNode(proseMirror, fixture.startText)
    const endNode = findTextNode(proseMirror, fixture.endText)
    expect(startNode.textContent).toBe(fixture.startText)
    expect(endNode.textContent).toBe(fixture.endText)
    const range = document.createRange()
    range.setStart(startNode, fixture.startOffset)
    range.setEnd(endNode, fixture.endOffset)
    firePointer(proseMirror, 'pointerdown', 47)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    firePointer(proseMirror, 'pointerup', 47)
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

    expect(onTranslationSelection).toHaveBeenCalledOnce()
    const output = onTranslationSelection.mock.calls[0]![0].content.markdown
    if (fixture.compareStructure) {
      const structure = (markdown: string) => JSON.stringify(
        fromMarkdown(markdown), (key, value) => key === 'position' ? undefined : value,
      )
      expect(structure(output)).toBe(structure(fixture.expectedMarkdown))
    } else expect(output).toBe(fixture.expectedMarkdown)
    expect(onChange).not.toHaveBeenCalled()
    expect(proseMirror.textContent).toBe(before)
  } finally {
    mounted.unmount()
    await act(async () => { await Promise.resolve() })
  }
})

it('degrades a same-cell Milkdown link selection using its real document context', async () => {
  const onTranslationSelection = vi.fn()
  const mounted = render(
    <VisualEditor
      markdown={'| Name |\n| --- |\n| [linked](https://example.com) |'}
      onChange={() => undefined}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  const proseMirror = await waitFor(() => {
    const surface = mounted.container.querySelector<HTMLElement>('.ProseMirror')
    expect(surface?.querySelector('table')).not.toBeNull()
    expect(surface?.textContent).toContain('linked')
    return surface!
  }, { timeout: 10_000 })
  const textNode = findTextNode(proseMirror, 'linked')
  const range = document.createRange()
  range.setStart(textNode, 0)
  range.setEnd(textNode, 'linked'.length)
  const browserSelection = window.getSelection()!

  firePointer(proseMirror, 'pointerdown', 46)
  browserSelection.removeAllRanges()
  browserSelection.addRange(range)
  firePointer(proseMirror, 'pointerup', 46)
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })

  expect(onTranslationSelection).toHaveBeenCalledWith({
    content: { markdown: 'linked', plainText: 'linked' },
    range: { from: 14, to: 20 },
    mode: 'visual',
    anchorRect: {
      left: 10,
      top: 20,
      right: 90,
      bottom: 38,
      width: 80,
      height: 18,
    },
    focusRect: {
      left: 90,
      top: 20,
      right: 90,
      bottom: 38,
      width: 0,
      height: 18,
    },
    releaseRect: {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    },
  })
  expect(browserSelection.toString()).toBe('linked')
  mounted.unmount()
  await act(async () => { await Promise.resolve() })
})

it('captures actual CodeMirror state only from its real content surface', async () => {
  const markdown = 'Before **bold** after'
  const onChange = vi.fn()
  const onTranslationSelection = vi.fn()
  render(
    <SourceEditor
      markdown={markdown}
      onChange={onChange}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  const content = await waitFor(() => {
    const surface = document.querySelector<HTMLElement>('.cm-content')
    expect(surface).not.toBeNull()
    return surface!
  })
  const editorDom = content.closest<HTMLElement>('.cm-editor')!
  const editorView = EditorView.findFromDOM(editorDom)!
  expect(editorView).not.toBeNull()
  const coordsAtPos = vi.spyOn(editorView, 'coordsAtPos').mockImplementation((position) => ({
    left: 10 + position * 4,
    right: 11 + position * 4,
    top: 20,
    bottom: 38,
  }))
  vi.spyOn(editorView, 'posAtCoords').mockReturnValue(7)
  const dispatch = vi.spyOn(editorView, 'dispatch')
  const wrapper = content.closest<HTMLElement>('.source-editor-context')!

  editorView.dispatch({ selection: { anchor: 7, head: 15 } })
  firePointer(wrapper, 'pointerdown', 50)
  firePointer(wrapper, 'pointerup', 50)
  expect(onTranslationSelection).not.toHaveBeenCalled()

  editorView.dispatch({ selection: { anchor: 0 } })
  firePointer(content, 'pointerdown', 51, 38, 29)
  editorView.dispatch({ selection: { anchor: 7, head: 15 } })
  const dispatchCountBeforeCapture = dispatch.mock.calls.length
  firePointer(document, 'pointerup', 51, 312, 204)

  expect(onTranslationSelection).toHaveBeenCalledOnce()
  expect(onTranslationSelection).toHaveBeenCalledWith({
    content: { markdown: '**bold**', plainText: 'bold' },
    range: { from: 7, to: 15 },
    mode: 'source',
    anchorRect: {
      left: 38,
      top: 20,
      right: 71,
      bottom: 38,
      width: 33,
      height: 18,
    },
    focusRect: {
      left: 70,
      top: 20,
      right: 71,
      bottom: 38,
      width: 1,
      height: 18,
    },
    releaseRect: {
      left: 312,
      top: 204,
      right: 312,
      bottom: 204,
      width: 0,
      height: 0,
    },
  })
  expect(editorView.state.doc.toString()).toBe(markdown)
  expect(editorView.state.selection.main.from).toBe(7)
  expect(editorView.state.selection.main.to).toBe(15)
  expect(dispatch).toHaveBeenCalledTimes(dispatchCountBeforeCapture)
  expect(coordsAtPos).toHaveBeenCalledWith(7)
  expect(coordsAtPos).toHaveBeenCalledWith(15)
  expect(onChange).not.toHaveBeenCalled()
})

it('remeasures a live Milkdown selection when zoom changes without replacing content or selection', async () => {
  const onChange = vi.fn()
  const onTranslationSelection = vi.fn()
  const onTranslationAnchorChange = vi.fn()
  const mounted = render(
    <VisualEditor
      markdown="Rendered text"
      onChange={onChange}
      onTranslationSelection={onTranslationSelection}
      onTranslationAnchorChange={onTranslationAnchorChange}
      translationAnchorRefreshKey={100}
    />,
  )
  const proseMirror = await waitFor(() => {
    const surface = mounted.container.querySelector<HTMLElement>('.ProseMirror')
    expect(surface?.textContent).toContain('Rendered text')
    return surface!
  }, { timeout: 10_000 })
  const textNode = findTextNode(proseMirror, 'Rendered text')
  const range = document.createRange()
  range.setStart(textNode, 0)
  range.setEnd(textNode, 'Rendered text'.length)
  const browserSelection = window.getSelection()!
  proseMirror.focus()
  browserSelection.removeAllRanges()
  browserSelection.addRange(range)
  const paragraphBefore = proseMirror.querySelector('p')

  currentSelectionRect = {
    x: 30,
    y: 50,
    left: 30,
    top: 50,
    right: 150,
    bottom: 78,
    width: 120,
    height: 28,
    toJSON: () => ({}),
  } as DOMRect
  mounted.rerender(
    <VisualEditor
      markdown="Rendered text"
      onChange={onChange}
      onTranslationSelection={onTranslationSelection}
      onTranslationAnchorChange={onTranslationAnchorChange}
      translationAnchorRefreshKey={200}
    />,
  )

  await waitFor(() => expect(onTranslationAnchorChange).toHaveBeenLastCalledWith({
    anchorRect: {
      left: 30,
      top: 50,
      right: 150,
      bottom: 78,
      width: 120,
      height: 28,
    },
    focusRect: {
      left: 150,
      top: 50,
      right: 150,
      bottom: 78,
      width: 0,
      height: 28,
    },
  }))
  expect(mounted.container.querySelector('.ProseMirror')).toBe(proseMirror)
  expect(proseMirror.querySelector('p')).toBe(paragraphBefore)
  expect(proseMirror.textContent).toContain('Rendered text')
  expect(browserSelection.toString()).toBe('Rendered text')
  expect(document.activeElement).toBe(proseMirror)
  expect(onTranslationSelection).not.toHaveBeenCalled()
  expect(onChange).not.toHaveBeenCalled()
})

it('remeasures a live CodeMirror selection when zoom changes without dispatching or losing editor state', async () => {
  const markdown = 'Before **bold** after'
  const onChange = vi.fn()
  const onTranslationSelection = vi.fn()
  const onTranslationAnchorChange = vi.fn()
  const mounted = render(
    <SourceEditor
      markdown={markdown}
      onChange={onChange}
      onTranslationSelection={onTranslationSelection}
      onTranslationAnchorChange={onTranslationAnchorChange}
      translationAnchorRefreshKey={100}
    />,
  )
  const content = await waitFor(() => {
    const surface = mounted.container.querySelector<HTMLElement>('.cm-content')
    expect(surface).not.toBeNull()
    return surface!
  })
  const editorDom = content.closest<HTMLElement>('.cm-editor')!
  const editorView = EditorView.findFromDOM(editorDom)!
  let coordinateOffset = 10
  vi.spyOn(editorView, 'coordsAtPos').mockImplementation((position) => ({
    left: coordinateOffset + position * 4,
    right: coordinateOffset + 1 + position * 4,
    top: coordinateOffset + 10,
    bottom: coordinateOffset + 28,
  }))
  const dispatch = vi.spyOn(editorView, 'dispatch')
  editorView.dispatch({ selection: { anchor: 7, head: 15 } })
  editorView.focus()
  editorView.scrollDOM.scrollTop = 43
  const selectionBeforeZoom = editorView.state.selection
  coordinateOffset = 100

  mounted.rerender(
    <SourceEditor
      markdown={markdown}
      onChange={onChange}
      onTranslationSelection={onTranslationSelection}
      onTranslationAnchorChange={onTranslationAnchorChange}
      translationAnchorRefreshKey={200}
    />,
  )

  await waitFor(() => expect(onTranslationAnchorChange).toHaveBeenLastCalledWith({
    anchorRect: {
      left: 128,
      top: 110,
      right: 161,
      bottom: 128,
      width: 33,
      height: 18,
    },
    focusRect: {
      left: 160,
      top: 110,
      right: 161,
      bottom: 128,
      width: 1,
      height: 18,
    },
  }))
  expect(EditorView.findFromDOM(editorDom)).toBe(editorView)
  expect(editorView.state.doc.toString()).toBe(markdown)
  expect(editorView.state.selection.eq(selectionBeforeZoom)).toBe(true)
  expect(editorView.scrollDOM.scrollTop).toBe(43)
  expect(document.activeElement).toBe(editorView.contentDOM)
  expect(dispatch.mock.calls.every(([transaction]) => (
    !transaction
    || typeof transaction !== 'object'
    || !('changes' in transaction)
  ))).toBe(true)
  expect(onTranslationSelection).not.toHaveBeenCalled()
  expect(onChange).not.toHaveBeenCalled()
})

it('preserves real CodeMirror focus, selection, history, scroll, and wrapping across a zoom rerender', async () => {
  function Harness({ zoomPercent }: { zoomPercent: number }) {
    const [markdown, setMarkdown] = useState('first line\nsecond line')
    return (
      <section
        data-testid="zoom-host"
        style={{ '--editor-zoom-factor': zoomPercent / 100 } as CSSProperties}
      >
        <SourceEditor markdown={markdown} onChange={setMarkdown} />
      </section>
    )
  }

  const mounted = render(<Harness zoomPercent={100} />)
  const editorDom = await waitFor(() => {
    const element = mounted.container.querySelector<HTMLElement>('.cm-editor')
    expect(element).not.toBeNull()
    return element!
  })
  const editorView = EditorView.findFromDOM(editorDom)!
  act(() => {
    editorView.dispatch({
      changes: { from: editorView.state.doc.length, insert: '!' },
      selection: { anchor: 2, head: 8 },
    })
  })
  await waitFor(() => expect(editorView.state.doc.toString()).toBe('first line\nsecond line!'))
  editorView.focus()
  editorView.scrollDOM.scrollTop = 37
  const selectionBefore = editorView.state.selection
  const historyBefore = undoDepth(editorView.state)
  expect(historyBefore).toBeGreaterThan(0)

  mounted.rerender(<Harness zoomPercent={200} />)

  expect(EditorView.findFromDOM(editorDom)).toBe(editorView)
  expect(editorView.state.doc.toString()).toBe('first line\nsecond line!')
  expect(editorView.state.selection.eq(selectionBefore)).toBe(true)
  expect(undoDepth(editorView.state)).toBe(historyBefore)
  expect(editorView.scrollDOM.scrollTop).toBe(37)
  expect(editorView.contentDOM).toHaveClass('cm-lineWrapping')
  expect(document.activeElement).toBe(editorView.contentDOM)
  expect(screen.getByTestId('zoom-host')).toHaveStyle('--editor-zoom-factor: 2')
})

function sourceHistoryRecord(id: string, documentKey: string, createdAt: number): TranslationHistoryRecord {
  const state = EditorState.create({ doc: 'before selected after' })
  return {
    id,
    requestId: `request-${id}`,
    documentKey,
    workspaceAbsolutePath: null,
    documentRelativePath: null,
    documentAbsolutePath: null,
    documentRevision: null,
    mode: 'source',
    source: { markdown: 'selected', plainText: 'selected' },
    translatedMarkdown: `translated ${id}`,
    modelId: 'model',
    targetLanguage: 'en',
    terminal: 'completed',
    createdAt,
    anchor: createSourceTranslationHistoryAnchor(state.doc, 7, 15),
  }
}

it('updates source history anchors in place and keeps editor-owned DOM non-interactive', async () => {
  const ref = createRef<SourceEditorHandle>()
  const firstRecord = sourceHistoryRecord('first', 'doc-a', 1)
  const secondRecord = sourceHistoryRecord('second', 'doc-a', 2)
  let records: readonly TranslationHistoryRecord[] = [firstRecord]
  const firstOpen = vi.fn()
  const firstAnchors = vi.fn()
  const secondOpen = vi.fn()
  const secondAnchors = vi.fn()
  const firstPort: TranslationHistoryEditorPort = {
    recordsForDocument: vi.fn(() => records),
    onAnchorsChanged: firstAnchors,
    onOpenRecord: firstOpen,
  }
  const secondPort: TranslationHistoryEditorPort = {
    recordsForDocument: vi.fn(() => records),
    onAnchorsChanged: secondAnchors,
    onOpenRecord: secondOpen,
  }
  const mounted = render(
    <SourceEditor
      ref={ref}
      documentKey="doc-a"
      markdown="before selected after"
      onChange={vi.fn()}
      translationHistory={firstPort}
    />,
  )
  const editorDom = await waitFor(() => {
    const current = mounted.container.querySelector<HTMLElement>('.cm-editor')
    expect(current).not.toBeNull()
    return current!
  })
  const editorView = EditorView.findFromDOM(editorDom)!

  records = [secondRecord]
  mounted.rerender(
    <SourceEditor
      ref={ref}
      documentKey="doc-a"
      markdown="before selected after"
      onChange={vi.fn()}
      translationHistory={secondPort}
    />,
  )

  expect(EditorView.findFromDOM(editorDom)).toBe(editorView)
  const anchor = await waitFor(() => {
    const current = mounted.container.querySelector<HTMLElement>(
      '[data-translation-history-anchor-id="second"]',
    )
    expect(current).not.toBeNull()
    return current!
  })
  expect(anchor.querySelector('button')).toBeNull()
  expect(mounted.container.querySelector('[data-translation-history-anchor-id="first"]')).toBeNull()
  expect(secondOpen).not.toHaveBeenCalled()
  expect(firstOpen).not.toHaveBeenCalled()

  act(() => editorView.dispatch({ changes: { from: 0, insert: 'new ' } }))
  expect(secondAnchors).toHaveBeenCalledWith('doc-a', [
    expect.objectContaining({
      recordId: 'second',
      anchor: expect.objectContaining({ from: 11, to: 19 }),
    }),
  ])
  expect(firstAnchors).not.toHaveBeenCalled()
  expect(ref.current?.revealTranslationHistoryRecord('second')).toBe(true)
  expect(editorView.state.selection.main).toMatchObject({ from: 11, to: 19 })
})

it('reinstalls only records for the keyed source document remount', async () => {
  const first = sourceHistoryRecord('first', 'doc-a', 1)
  const second = sourceHistoryRecord('second', 'doc-b', 2)
  const onOpenRecord = vi.fn()
  const history: TranslationHistoryEditorPort = {
    recordsForDocument: vi.fn((documentKey) => documentKey === 'doc-a' ? [first] : [second]),
    onAnchorsChanged: vi.fn(),
    onOpenRecord,
  }
  const mounted = render(
    <SourceEditor
      key="doc-a"
      documentKey="doc-a"
      markdown="before selected after"
      onChange={vi.fn()}
      translationHistory={history}
    />,
  )
  const firstDom = await waitFor(() => {
    const current = mounted.container.querySelector<HTMLElement>('.cm-editor')
    expect(current).not.toBeNull()
    return current!
  })
  const firstView = EditorView.findFromDOM(firstDom)!

  mounted.rerender(
    <SourceEditor
      key="doc-b"
      documentKey="doc-b"
      markdown="before selected after"
      onChange={vi.fn()}
      translationHistory={history}
    />,
  )

  const secondDom = await waitFor(() => {
    const current = mounted.container.querySelector<HTMLElement>('.cm-editor')
    expect(current).not.toBeNull()
    return current!
  })
  expect(EditorView.findFromDOM(secondDom)).not.toBe(firstView)
  const anchors = mounted.container.querySelectorAll<HTMLElement>(
    '[data-translation-history-anchor-id]',
  )
  expect(anchors).toHaveLength(1)
  expect(anchors[0]).toHaveAttribute('data-translation-history-anchor-id', 'second')
  expect(anchors[0]?.querySelector('button')).toBeNull()
  expect(onOpenRecord).not.toHaveBeenCalled()
  expect(history.recordsForDocument).toHaveBeenNthCalledWith(1, 'doc-a')
  expect(history.recordsForDocument).toHaveBeenNthCalledWith(2, 'doc-b')
})

it('signals source history readiness only after initial and hot records can be revealed', async () => {
  const ref = createRef<SourceEditorHandle>()
  const first = sourceHistoryRecord('first', 'doc-a', 1)
  const second = sourceHistoryRecord('second', 'doc-a', 2)
  let records: readonly TranslationHistoryRecord[] = [first]
  const history: TranslationHistoryEditorPort = {
    recordsForDocument: () => records,
    onAnchorsChanged: vi.fn(),
    onOpenRecord: vi.fn(),
  }
  const ready = vi.fn((key: string) => ({
    key,
    first: ref.current?.revealTranslationHistoryRecord('first') ?? false,
    second: ref.current?.revealTranslationHistoryRecord('second') ?? false,
  }))
  const mounted = render(
    <SourceEditor
      ref={ref}
      documentKey="doc-a"
      markdown="before selected after"
      onChange={vi.fn()}
      translationHistory={history}
      onTranslationHistoryReady={ready}
    />,
  )

  await waitFor(() => expect(ready).toHaveBeenCalledTimes(1))
  expect(ready.mock.results[0]?.value).toEqual({ key: 'doc-a', first: true, second: false })

  records = [second]
  mounted.rerender(
    <SourceEditor
      ref={ref}
      documentKey="doc-a"
      markdown="before selected after"
      onChange={vi.fn()}
      translationHistory={history}
      onTranslationHistoryReady={ready}
    />,
  )
  await waitFor(() => expect(ready).toHaveBeenCalledTimes(2))
  expect(ready.mock.results[1]?.value).toEqual({ key: 'doc-a', first: false, second: true })

  const editorDom = mounted.container.querySelector<HTMLElement>('.cm-editor')!
  const editorView = EditorView.findFromDOM(editorDom)!
  const selectionBeforeInvalid = editorView.state.selection
  records = [{
    ...second,
    id: 'invalid-source',
    requestId: 'request-invalid-source',
    anchor: {
      ...second.anchor,
      fingerprint: { before: '', selected: 'not-in-document', after: '' },
    },
  }]
  mounted.rerender(
    <SourceEditor
      ref={ref}
      documentKey="doc-a"
      markdown="before selected after"
      onChange={vi.fn()}
      translationHistory={history}
      onTranslationHistoryReady={ready}
    />,
  )
  await waitFor(() => expect(ready).toHaveBeenCalledTimes(3))
  expect(ref.current?.revealTranslationHistoryRecord('invalid-source')).toBe(false)
  expect(editorView.state.selection).toEqual(selectionBeforeInvalid)

  mounted.unmount()
  records = [first]
  await Promise.resolve()
  expect(ready).toHaveBeenCalledTimes(3)
})

it('signals visual history readiness after initial and hot sync while invalid reveals preserve selection', async () => {
  const ref = createRef<VisualEditorHandle>()
  const record: TranslationHistoryRecord = {
    id: 'visual-ready', requestId: 'request-visual-ready', documentKey: 'doc-visual',
    workspaceAbsolutePath: null, documentRelativePath: null, documentAbsolutePath: null,
    documentRevision: null, mode: 'visual',
    source: { markdown: 'selected', plainText: 'selected' },
    translatedMarkdown: 'translated', modelId: 'model', targetLanguage: 'en',
    terminal: 'completed', createdAt: 1,
    anchor: {
      mode: 'visual', from: 8, to: 16, blockStart: 0,
      fingerprint: { before: 'before ', selected: 'selected', after: ' after' },
      status: 'valid',
    },
  }
  const hotRecord: TranslationHistoryRecord = {
    ...record,
    id: 'visual-hot',
    requestId: 'request-visual-hot',
    createdAt: 2,
  }
  let records: readonly TranslationHistoryRecord[] = [record]
  const history: TranslationHistoryEditorPort = {
    recordsForDocument: () => records,
    onAnchorsChanged: vi.fn(),
    onOpenRecord: vi.fn(),
  }
  const ready = vi.fn((key: string) => ({
    key,
    initial: ref.current?.revealTranslationHistoryRecord(record.id) ?? false,
    hot: ref.current?.revealTranslationHistoryRecord(hotRecord.id) ?? false,
  }))
  const mounted = render(
    <VisualEditor
      ref={ref}
      documentKey="doc-visual"
      markdown="before selected after"
      onChange={vi.fn()}
      translationHistory={history}
      onTranslationHistoryReady={ready}
    />,
  )

  await waitFor(() => expect(ready).toHaveBeenCalledTimes(1), { timeout: 10_000 })
  expect(ready.mock.results[0]?.value).toEqual({ key: 'doc-visual', initial: true, hot: false })

  records = [hotRecord]
  mounted.rerender(
    <VisualEditor
      ref={ref}
      documentKey="doc-visual"
      markdown="before selected after"
      onChange={vi.fn()}
      translationHistory={history}
      onTranslationHistoryReady={ready}
    />,
  )
  await waitFor(() => expect(ready).toHaveBeenCalledTimes(2), { timeout: 10_000 })
  expect(ready.mock.results[1]?.value).toEqual({ key: 'doc-visual', initial: false, hot: true })

  const proseMirror = mounted.container.querySelector<HTMLElement>('.ProseMirror')!
  const selection = window.getSelection()!
  const stableRange = document.createRange()
  const stableText = findTextNode(proseMirror, 'before')
  stableRange.setStart(stableText, 0)
  stableRange.setEnd(stableText, 'before'.length)
  selection.removeAllRanges()
  selection.addRange(stableRange)
  const invalidRecord: TranslationHistoryRecord = {
    ...hotRecord,
    id: 'visual-invalid',
    requestId: 'request-visual-invalid',
    anchor: {
      ...hotRecord.anchor,
      fingerprint: { before: '', selected: 'not-in-document', after: '' },
    },
  }
  records = [invalidRecord]
  mounted.rerender(
    <VisualEditor
      ref={ref}
      documentKey="doc-visual"
      markdown="before selected after"
      onChange={vi.fn()}
      translationHistory={history}
      onTranslationHistoryReady={ready}
    />,
  )
  await waitFor(() => expect(ready).toHaveBeenCalledTimes(3), { timeout: 10_000 })
  selection.removeAllRanges()
  selection.addRange(stableRange)
  const selectionBeforeInvalid = selection.toString()
  expect(ref.current?.revealTranslationHistoryRecord(invalidRecord.id)).toBe(false)
  expect(selection.toString()).toBe(selectionBeforeInvalid)
  mounted.unmount()
  await Promise.resolve()
  expect(ready).toHaveBeenCalledTimes(3)
})
