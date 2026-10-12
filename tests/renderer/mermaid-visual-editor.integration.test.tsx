import { act, render, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import type {
  MermaidAppearance,
  MermaidRenderRequest,
  MermaidRenderResult,
} from '../../src/renderer/editor/mermaid/mermaid-types'

const rendererBridge = vi.hoisted(() => ({
  createCount: 0,
  sharedRenderer: null as { render: (request: MermaidRenderRequest) => Promise<MermaidRenderResult> } | null,
  render: vi.fn<(request: MermaidRenderRequest) => Promise<MermaidRenderResult>>(),
}))

vi.mock('../../src/renderer/editor/mermaid/mermaid-render-service', () => ({
  createMermaidRenderService: () => {
    rendererBridge.createCount += 1
    return { render: rendererBridge.render }
  },
  getWindowMermaidRenderService: () => {
    if (!rendererBridge.sharedRenderer) {
      rendererBridge.createCount += 1
      rendererBridge.sharedRenderer = { render: rendererBridge.render }
    }
    return rendererBridge.sharedRenderer
  },
}))

import {
  VisualEditor,
  type VisualEditorHandle,
} from '../../src/renderer/editor/VisualEditor'
import {
  CODE_EXPLANATION_REQUEST_EVENT,
} from '../../src/renderer/editor/mermaid/adaptive-code-block-view'

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
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.callback([{
      target,
      isIntersecting: true,
      intersectionRatio: 1,
    } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] { return [] }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const lightAppearance: MermaidAppearance = Object.freeze({
  revision: 4,
  editorTheme: 'minimal',
  colorScheme: 'light',
  themeColor: '#336699',
  bodyFontFamily: '"Arial", "Microsoft YaHei"',
})

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

afterEach(() => {
  rendererBridge.createCount = 0
  rendererBridge.sharedRenderer = null
  rendererBridge.render.mockReset()
})

it('forwards structured code-explanation requests from the current visual editor root', async () => {
  const onCodeExplanationRequest = vi.fn()
  const rendered = render(
    <VisualEditor
      markdown={'```ts\nconst value = 1\n```'}
      onChange={vi.fn()}
      onCodeExplanationRequest={onCodeExplanationRequest}
    />,
  )
  await waitFor(() => expect(rendered.container.querySelector('.ProseMirror'))
    .toBeInstanceOf(HTMLElement))
  const proseMirror = rendered.container.querySelector('.ProseMirror')!

  act(() => {
    proseMirror.dispatchEvent(new CustomEvent(CODE_EXPLANATION_REQUEST_EVENT, {
      bubbles: true,
      detail: { language: 'ts', code: 'const value = 1' },
    }))
  })

  expect(onCodeExplanationRequest).toHaveBeenCalledWith({
    language: 'ts',
    code: 'const value = 1',
  })
})

it('installs the adaptive view while preserving Mermaid source and ordinary/LaTeX round-trips', async () => {
  const readyDataUrl = 'data:image/svg+xml;base64,PHN2Zy8+'
  rendererBridge.render.mockResolvedValue({ status: 'ready', dataUrl: readyDataUrl })
  const ref = createRef<VisualEditorHandle>()
  const onReady = vi.fn()
  const markdown = [
    '```mermaid',
    'flowchart LR',
    '  A --> B',
    '```',
    '',
    '```typescript',
    'const answer = 42',
    '```',
    '',
    '$$',
    'E = mc^2',
    '$$',
  ].join('\n')
  const { container } = render(
    <VisualEditor
      ref={ref}
      markdown={markdown}
      mermaidAppearance={lightAppearance}
      onChange={vi.fn()}
      onReady={onReady}
    />,
  )

  await waitFor(() => expect(onReady).toHaveBeenCalledOnce(), { timeout: 10_000 })
  expect(container.querySelector('.arkdown-mermaid-block')).toBeInstanceOf(HTMLElement)
  expect(container.querySelector('.milkdown-code-block')).toBeInstanceOf(HTMLElement)

  await act(async () => {
    await ref.current?.whenRenderIdle?.()
  })

  expect(rendererBridge.createCount).toBe(1)
  expect(rendererBridge.render).toHaveBeenCalledWith(expect.objectContaining({
    source: 'flowchart LR\n  A --> B',
    appearance: lightAppearance,
  }))
  expect(container.querySelector('img[alt="Mermaid diagram"]')).toHaveAttribute('src', readyDataUrl)
  const checkpoint = ref.current?.captureModeSwitch?.(markdown)?.checkpoint ?? ''
  expect(checkpoint.trimEnd()).toBe(markdown)
  expect(checkpoint).not.toContain(readyDataUrl)
}, 15_000)

it('refreshes theme in place and discards a late result from the old appearance', async () => {
  const requests: Array<{
    request: MermaidRenderRequest
    result: ReturnType<typeof deferred<MermaidRenderResult>>
  }> = []
  rendererBridge.render.mockImplementation((request) => {
    const result = deferred<MermaidRenderResult>()
    requests.push({ request, result })
    return result.promise
  })
  const ref = createRef<VisualEditorHandle>()
  const onReady = vi.fn()
  const props = {
    ref,
    markdown: '```mermaid\nflowchart LR\nA --> B\n```',
    onChange: vi.fn(),
    onReady,
  }
  const rendered = render(
    <VisualEditor {...props} mermaidAppearance={lightAppearance} />,
  )
  await waitFor(() => expect(onReady).toHaveBeenCalledOnce(), { timeout: 10_000 })
  const proseMirror = rendered.container.querySelector('.ProseMirror')

  let idle!: Promise<void>
  act(() => {
    idle = ref.current!.whenRenderIdle!()
  })
  expect(requests).toHaveLength(1)
  expect(requests[0]!.request.appearance.themeColor).toBe('#336699')

  const darkAppearance: MermaidAppearance = Object.freeze({
    ...lightAppearance,
    revision: 5,
    colorScheme: 'dark',
    themeColor: '#CC5500',
  })
  rendered.rerender(<VisualEditor {...props} mermaidAppearance={darkAppearance} />)
  await waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[1]!.request.appearance).toEqual(darkAppearance)
  expect(rendered.container.querySelector('.ProseMirror')).toBe(proseMirror)
  expect(onReady).toHaveBeenCalledOnce()

  requests[1]!.result.resolve({
    status: 'ready',
    dataUrl: 'data:image/svg+xml;base64,bmV3',
  })
  await waitFor(() => expect(rendered.container.querySelector('img[alt="Mermaid diagram"]'))
    .toHaveAttribute('src', 'data:image/svg+xml;base64,bmV3'))
  requests[0]!.result.resolve({
    status: 'ready',
    dataUrl: 'data:image/svg+xml;base64,b2xk',
  })
  await act(async () => { await idle })

  expect(rendered.container.querySelector('img[alt="Mermaid diagram"]'))
    .toHaveAttribute('src', 'data:image/svg+xml;base64,bmV3')
}, 15_000)

it('uses one renderer-window Mermaid service when two VisualEditors render independently', async () => {
  rendererBridge.render.mockResolvedValue({
    status: 'ready',
    dataUrl: 'data:image/svg+xml;base64,c2hhcmVk',
  })
  const markdown = '```mermaid\nflowchart LR\nA --> B\n```'
  const rendered = render(<>
    <VisualEditor markdown={markdown} mermaidAppearance={lightAppearance} onChange={vi.fn()} />
    <VisualEditor markdown={markdown} mermaidAppearance={lightAppearance} onChange={vi.fn()} />
  </>)

  await waitFor(() => expect(rendered.container.querySelectorAll('img[alt="Mermaid diagram"]'))
    .toHaveLength(2), { timeout: 10_000 })

  expect(rendererBridge.createCount).toBe(1)
})
