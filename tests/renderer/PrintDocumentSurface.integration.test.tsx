import { act, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { PrintDocumentSurface } from '../../src/renderer/printing/PrintDocumentSurface'
import { DEFAULT_EDITOR_APPEARANCE } from '../../src/shared/editor-appearance-preferences'
import { externalAssetUrl } from '../../src/shared/local-resource-path'

const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
const originalRangeBounds = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
const originalElementRects = Object.getOwnPropertyDescriptor(Element.prototype, 'getClientRects')
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
const originalElementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')
const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts')

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
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

afterEach(() => {
  if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts)
  else Reflect.deleteProperty(document, 'fonts')
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

it('renders real read-only Markdown and waits for fonts and every relative image before ready', async () => {
  const fonts = deferred<FontFaceSet>()
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: fonts.promise },
  })
  const token = '00000000-0000-4000-8000-000000000001'
  const readyPrintDocument = vi.fn(async () => ({ ok: true as const, value: null }))
  const api = {
    takePrintDocument: vi.fn(async () => ({
      ok: true as const,
      value: {
        markdown: [
          '# Printed title',
          '',
          'This is *rendered emphasis*.',
          '',
          '![first](images/one.png)',
          '',
          '![second](../shared/two.png)',
        ].join('\n'),
        documentName: 'plan.md',
        documentAbsolutePath: 'C:\\Docs\\plans\\plan.md',
        appearance: { ...DEFAULT_EDITOR_APPEARANCE },
        surfaceDeadlineEpochMs: Date.now() + 30_000,
      },
    })),
    readyPrintDocument,
  }
  const { container } = render(<PrintDocumentSurface api={api} token={token} />)
  const surface = await screen.findByRole(
    'main',
    { name: 'Rendered document for printing' },
    { timeout: 10_000 },
  )
  const proseMirror = await waitFor(() => {
    const editor = surface.querySelector<HTMLElement>('.ProseMirror')
    expect(editor).not.toBeNull()
    expect(editor?.querySelector('h1')).toHaveTextContent('Printed title')
    expect(editor?.querySelector('em')).toHaveTextContent('rendered emphasis')
    return editor!
  }, { timeout: 10_000 })

  expect(surface.textContent).not.toContain('# Printed title')
  expect(proseMirror).toHaveAttribute('contenteditable', 'false')
  expect(container.querySelector('.app-shell, nav, aside')).toBeNull()
  expect(container.querySelector(
    '.arkdown-image-alignment-toolbar, .arkdown-image-resize-handle',
  )).toBeNull()

  const documentImages = [...surface.querySelectorAll<HTMLImageElement>('img[data-source]')]
  expect(documentImages).toHaveLength(2)
  expect(documentImages.map((image) => image.dataset.source)).toEqual([
    'C:\\Docs\\plans\\images\\one.png',
    'C:\\Docs\\shared\\two.png',
  ])
  expect(documentImages.map((image) => image.src)).toEqual([
    externalAssetUrl('C:\\Docs\\plans\\images\\one.png'),
    externalAssetUrl('C:\\Docs\\shared\\two.png'),
  ])
  for (const image of surface.querySelectorAll<HTMLImageElement>('img')) {
    Object.defineProperty(image, 'complete', {
      configurable: true,
      value: !image.dataset.source,
    })
  }
  expect(readyPrintDocument).not.toHaveBeenCalled()

  await act(async () => {
    fonts.resolve({} as FontFaceSet)
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(readyPrintDocument).not.toHaveBeenCalled()

  documentImages[0]!.dispatchEvent(new Event('load'))
  await act(async () => { await Promise.resolve() })
  expect(readyPrintDocument).not.toHaveBeenCalled()

  documentImages[1]!.dispatchEvent(new Event('error'))
  await waitFor(() => expect(readyPrintDocument).toHaveBeenCalledWith(token))
}, 15_000)
