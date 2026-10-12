import { undo, undoDepth } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef, forwardRef, useImperativeHandle, useState } from 'react'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { ArkdownApi } from '../../src/shared/contracts'
import { useTranslationHistory } from '../../src/renderer/app/use-translation-history'
import type { TranslationHistoryRecord } from '../../src/renderer/editor/translation-history'
import type { TranslationEvent } from '../../src/shared/selection-translation'
import { modelObservation } from '../helpers/model-observation'

vi.mock('../../src/renderer/editor/VisualEditor', () => ({
  VisualEditor: forwardRef<{ flush(): string | null }, { markdown: string }>(
    function VisualEditorMock({ markdown }, ref) {
      useImperativeHandle(ref, () => ({ flush: () => markdown }), [markdown])
      return <div>{markdown}</div>
    },
  ),
}))

import { SourceEditor, type SourceEditorHandle } from '../../src/renderer/editor/SourceEditor'
import { EditorPane } from '../../src/renderer/editor/EditorPane'

const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
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

function rect(top: number, height: number, width = 700): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: width,
    top,
    width,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

function testRectList(): DOMRectList {
  const value = rect(20, 18, 80)
  return {
    0: value,
    length: 1,
    item: (index: number) => index === 0 ? value : null,
    [Symbol.iterator]: function* () {
      yield value
    },
  } as DOMRectList
}

class TestResizeObserver {
  static instances: TestResizeObserver[] = []
  readonly disconnect = vi.fn()
  readonly observe = vi.fn()
  readonly unobserve = vi.fn()

  constructor(readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this)
  }

  emit(): void {
    this.callback([], this as unknown as ResizeObserver)
  }
}

class TestIntersectionObserver {
  root = null
  rootMargin = '0px'
  thresholds = [0]
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

function restoreDescriptor(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, key, descriptor)
  else Reflect.deleteProperty(target, key)
}

beforeAll(() => {
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: testRectList,
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => rect(20, 18, 80),
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
})

afterAll(() => {
  restoreDescriptor(Range.prototype, 'getClientRects', rangeClientRectsDescriptor)
  restoreDescriptor(Range.prototype, 'getBoundingClientRect', rangeBoundingRectDescriptor)
  restoreDescriptor(Element.prototype, 'getClientRects', elementClientRectsDescriptor)
  restoreDescriptor(Element.prototype, 'scrollIntoView', scrollIntoViewDescriptor)
  restoreDescriptor(document, 'elementFromPoint', elementFromPointDescriptor)
  vi.unstubAllGlobals()
})

beforeEach(() => {
  TestResizeObserver.instances = []
  vi.restoreAllMocks()
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
})

function firePointer(
  target: Element,
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

function createAiConversationApiStubs() {
  return {
    startAiConversation: vi.fn(async (input: { requestId: string }) => ({
      ok: true as const,
      value: { requestId: input.requestId, modelId: 'configured-model' },
    })),
    cancelAiConversation: vi.fn(async () => ({ ok: true as const, value: null })),
    submitAiDocumentResult: vi.fn(async () => ({ ok: true as const, value: null })),
    onAiConversationEvent: vi.fn(() => () => undefined),
  }
}

function installApi() {
  let eventHandler: ((event: TranslationEvent) => void) | null = null
  const api = {
    ...createAiConversationApiStubs(),
    acceptTranslationPrivacyNotice: vi.fn(),
    cancelTranslation: vi.fn(async () => ({ ok: true as const, value: null })),
    getLargeModelSettings: vi.fn(async () => ({
      ok: true as const,
      value: {
        version: 3 as const,
        codexCli: null,
        connections: [{
          id: '11111111-1111-4111-8111-111111111111',
          name: 'Configured model',
          provider: 'deepseek' as const,
          accessType: 'standard-api' as const,
          protocol: 'openai' as const,
          baseUrl: 'https://example.invalid',
          modelId: 'configured-model',
          apiKeyHint: '***',
          status: 'connected' as const,
          lastTestedAt: null,
        }],
        selectionTranslation: {
          connectionId: '11111111-1111-4111-8111-111111111111',
          privacyNoticeAccepted: true,
          reasoningEffort: 'off' as const,
          targetLanguage: 'auto' as const,
        },
        screenshotTranslation: {
          connectionId: '11111111-1111-4111-8111-111111111111',
          reasoningEffort: 'off' as const,
          targetLanguage: 'auto' as const,
        },
      },
    })),
    onTranslationEvent: vi.fn((handler: (event: TranslationEvent) => void) => {
      eventHandler = handler
      return vi.fn()
    }),
    startTranslation: vi.fn(async () => ({
      ok: true as const,
      value: { requestId: REQUEST_ID, targetLanguage: 'zh-CN' },
    })),
  } as unknown as ArkdownApi
  api.getModelSettingsSnapshot = vi.fn(async () => {
    const result = await api.getLargeModelSettings()
    return result.ok ? { ok: true as const, value: modelObservation(result.value) } : result
  })
  Object.defineProperty(window, 'arkdown', {
    configurable: true,
    value: api,
  })
  return { api, emit: (event: TranslationEvent) => act(() => eventHandler?.(event)) }
}

it('uses the real CodeMirror scroller for source capture, alignment, resizing, and cleanup', async () => {
  const { api } = installApi()
  const markdown = 'a'.repeat(120)
  const mounted = render(
    <div className="app-shell">
      <EditorPane
        documentKey="note.md"
        markdown={markdown}
        onChange={vi.fn()}
        onOpenLargeModelSettings={() => undefined}
      />
    </div>,
  )
  act(() => window.dispatchEvent(new CustomEvent('arkdown:editor-command', {
    detail: 'toggle-source-mode',
  })))

  const content = await waitFor(() => {
    const value = document.querySelector<HTMLElement>('.cm-content')
    expect(value).not.toBeNull()
    return value!
  })
  const editorDom = content.closest<HTMLElement>('.cm-editor')!
  const editorView = EditorView.findFromDOM(editorDom)!
  const wrapper = content.closest<HTMLElement>('.source-editor-context')!
  const scroller = content.closest<HTMLElement>('.cm-scroller')!
  const surface = document.querySelector<HTMLElement>('.editor-surface')!
  const pane = document.querySelector<HTMLElement>('.editor-pane')!
  const scrollerAdd = vi.spyOn(scroller, 'addEventListener')
  const scrollerRemove = vi.spyOn(scroller, 'removeEventListener')
  const surfaceAdd = vi.spyOn(surface, 'addEventListener')
  let scrollTop = 400
  let clientHeight = 300
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, get: () => clientHeight },
    scrollHeight: { configurable: true, get: () => 1_200 },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value },
    },
  })
  vi.spyOn(scroller, 'getBoundingClientRect').mockImplementation(() => rect(50, clientHeight))
  vi.spyOn(surface, 'getBoundingClientRect').mockImplementation(() => rect(50, 300))
  vi.spyOn(pane, 'getBoundingClientRect').mockImplementation(() => rect(50, 300, 1_000))
  vi.spyOn(editorView, 'coordsAtPos').mockImplementation(() => ({
    bottom: 198,
    left: 20,
    right: 80,
    top: 180,
  }))
  vi.spyOn(editorView, 'posAtCoords').mockReturnValue(0)

  editorView.dispatch({ selection: { anchor: 0 } })
  firePointer(content, 'pointerdown', 90, 30, 189)
  editorView.dispatch({ selection: { anchor: 0, head: markdown.length } })
  firePointer(content, 'pointerup', 90)
  fireEvent.click(await screen.findByRole('button', { name: '翻译选中的文本' }))
  await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())

  const result = screen.getByTestId('translation-sidebar-result')
  vi.spyOn(result, 'getBoundingClientRect').mockImplementation(() => rect(0, 30, 320))
  act(() => {
    TestResizeObserver.instances
      .filter((observer) => observer.observe.mock.calls.some(([target]) => target === result))
      .forEach((observer) => observer.emit())
  })
  expect(result).toHaveStyle({ marginTop: '82px' })
  expect(scrollerAdd).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true })
  expect(surfaceAdd).not.toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true })

  scrollTop = 450
  fireEvent.scroll(scroller)
  expect(result).toHaveStyle({ marginTop: '32px' })

  clientHeight = 100
  act(() => {
    TestResizeObserver.instances
      .filter((observer) => observer.observe.mock.calls.some(([target]) => target === scroller))
      .forEach((observer) => observer.emit())
  })
  expect(result).toHaveStyle({ marginTop: '32px' })

  mounted.unmount()
  expect(scrollerRemove).toHaveBeenCalledWith('scroll', expect.any(Function))
  expect(wrapper.contains(scroller)).toBe(false)
})

it('keeps the real source session, focus, selection, history, scroll, mode, and wrapping on zoom', async () => {
  installApi()
  const onChange = vi.fn()
  const markdown = 'first line\nsecond line'
  const mounted = render(
    <div className="app-shell">
      <EditorPane
        documentKey="note.md"
        markdown={markdown}
        zoomPercent={100}
        onChange={onChange}
        onOpenLargeModelSettings={() => undefined}
      />
    </div>,
  )
  act(() => window.dispatchEvent(new CustomEvent('arkdown:editor-command', {
    detail: 'toggle-source-mode',
  })))
  const editorDom = await waitFor(() => {
    const value = mounted.container.querySelector<HTMLElement>('.cm-editor')
    expect(value).not.toBeNull()
    return value!
  })
  const editorView = EditorView.findFromDOM(editorDom)!
  act(() => {
    editorView.dispatch({
      changes: { from: editorView.state.doc.length, insert: '!' },
      selection: { anchor: 2, head: 8 },
    })
  })
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('first line\nsecond line!'))
  editorView.focus()
  editorView.scrollDOM.scrollTop = 41
  const selectionBefore = editorView.state.selection
  const historyBefore = undoDepth(editorView.state)
  expect(historyBefore).toBeGreaterThan(0)

  mounted.rerender(
    <div className="app-shell">
      <EditorPane
        documentKey="note.md"
        markdown={markdown}
        zoomPercent={200}
        onChange={onChange}
        onOpenLargeModelSettings={() => undefined}
      />
    </div>,
  )

  expect(screen.getByLabelText('Markdown editor')).toHaveAttribute('data-editor-zoom-percent', '200')
  expect(mounted.container.querySelector('.cm-editor')).toBe(editorDom)
  expect(EditorView.findFromDOM(editorDom)).toBe(editorView)
  expect(editorView.state.doc.toString()).toBe('first line\nsecond line!')
  expect(editorView.state.selection.eq(selectionBefore)).toBe(true)
  expect(undoDepth(editorView.state)).toBe(historyBefore)
  expect(editorView.scrollDOM.scrollTop).toBe(41)
  expect(editorView.contentDOM).toHaveClass('cm-lineWrapping')
  expect(document.activeElement).toBe(editorView.contentDOM)
  expect(mounted.container.querySelector('.cm-editor')).toBeVisible()
})


it('continues the preserved source range after settings with its original history anchor and latest target', async () => {
  const { api, emit } = installApi()
  const initial = await api.getLargeModelSettings()
  if (!initial.ok) throw new Error('Expected settings fixture')
  const configuredConnectionId = initial.value.selectionTranslation.connectionId
  let currentSettings = {
    ...initial.value,
    selectionTranslation: { ...initial.value.selectionTranslation, connectionId: null as string | null },
  }
  vi.mocked(api.getLargeModelSettings).mockImplementation(async () => ({ ok: true, value: currentSettings }))
  api.setSelectionTranslationSettings = vi.fn()
  vi.mocked(api.startTranslation).mockImplementation(async () => ({
    ok: true,
    value: { requestId: REQUEST_ID, modelId: 'configured-model', targetLanguage: 'fr' },
  }))
  const markdown = 'before chosen words after'
  function Harness() {
    const [settingsOpen, setSettingsOpen] = useState(false)
    const [revision, setRevision] = useState(0)
    const history = useTranslationHistory()
    return <>
      <div hidden={settingsOpen}>
        <EditorPane documentKey="note.md" markdown={markdown} initialMode="source"
          onChange={vi.fn()} onOpenLargeModelSettings={() => setSettingsOpen(true)}
          translationSettingsRevision={revision} translationHistory={history}
          translationHistoryRecords={history.records}
          translationHistoryIdentity={{ workspaceAbsolutePath: null, documentRelativePath: 'note.md', documentRevision: 'v1' }} />
      </div>
      {settingsOpen && <button onClick={() => {
        currentSettings = { ...currentSettings, selectionTranslation: {
          ...currentSettings.selectionTranslation,
          connectionId: configuredConnectionId,
          targetLanguage: 'fr',
        } }
        setRevision((value) => value + 1)
        setSettingsOpen(false)
      }}>完成配置</button>}
      <output data-testid="records">{JSON.stringify(history.records)}</output>
    </>
  }
  render(<Harness />)
  const content = await waitFor(() => {
    const element = document.querySelector<HTMLElement>('.cm-content')
    expect(element).not.toBeNull()
    return element!
  })
  const editorView = EditorView.findFromDOM(content.closest<HTMLElement>('.cm-editor')!)!
  vi.spyOn(editorView, 'coordsAtPos').mockReturnValue({ bottom: 38, top: 20, left: 10, right: 90 })
  vi.spyOn(editorView, 'posAtCoords').mockReturnValue(7)
  firePointer(content, 'pointerdown', 91, 30, 29)
  act(() => editorView.dispatch({ selection: { anchor: 7, head: 19 } }))
  firePointer(content, 'pointerup', 91)
  fireEvent.click(await screen.findByRole('button', { name: '翻译选中的文本' }))
  fireEvent.click(await screen.findByRole('button', { name: '前往配置' }))
  expect(content).not.toBeVisible()
  act(() => editorView.dispatch({ selection: { anchor: markdown.length } }))
  fireEvent.click(screen.getByRole('button', { name: '完成配置' }))
  const continueButton = await screen.findByRole('button', { name: '翻译选中的文本' })
  expect(api.startTranslation).not.toHaveBeenCalled()
  expect(EditorView.findFromDOM(content.closest<HTMLElement>('.cm-editor')!)).toBe(editorView)
  fireEvent.click(continueButton)
  await waitFor(() => expect(api.startTranslation).toHaveBeenCalledTimes(1))
  expect(api.startTranslation).toHaveBeenCalledWith({
    documentKey: 'note.md', mode: 'source',
    content: { markdown: 'chosen words', plainText: 'chosen words' },
  })
  expect(api.setSelectionTranslationSettings).not.toHaveBeenCalled()
  emit({ requestId: REQUEST_ID, type: 'delta', delta: 'mots choisis' })
  emit({ requestId: REQUEST_ID, type: 'completed' })
  const records = JSON.parse(screen.getByTestId('records').textContent!) as TranslationHistoryRecord[]
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    documentKey: 'note.md', documentRevision: 'v1', targetLanguage: 'fr',
    source: { markdown: 'chosen words', plainText: 'chosen words' },
    anchor: { from: 7, to: 19, status: 'valid', fingerprint: { selected: 'chosen words' } },
  })
})

it('keeps the real source view, mode, selection and undo through a failed acceptance lock', async () => {
  installApi()
  const onChange = vi.fn()
  const pane = (locked: boolean) => <EditorPane documentKey="note.md" markdown="Before"
    initialMode="source" interactionLocked={locked} onChange={onChange} onOpenLargeModelSettings={() => undefined} />
  const mounted = render(pane(false))
  const dom = await waitFor(() => {
    const value = mounted.container.querySelector<HTMLElement>('.cm-editor')
    expect(value).not.toBeNull()
    return value!
  })
  const view = EditorView.findFromDOM(dom)!
  act(() => view.dispatch({ changes: { from: 6, insert: ' edit' }, selection: { anchor: 1, head: 4 } }))
  const selection = view.state.selection
  const depth = undoDepth(view.state)
  expect(depth).toBeGreaterThan(0)
  mounted.rerender(pane(true))
  expect(EditorView.findFromDOM(dom)).toBe(view)
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'Blocked' }, selection: { anchor: 0 } })
    window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: 'toggle-source-mode' }))
  })
  expect(mounted.container.querySelector('.cm-editor')).toBe(dom)
  expect(view.state.doc.toString()).toBe('Before edit')
  expect(view.state.selection.eq(selection)).toBe(true)
  expect(undoDepth(view.state)).toBe(depth)
  mounted.rerender(pane(false))
  expect(EditorView.findFromDOM(dom)).toBe(view)
  expect(view.state.selection.eq(selection)).toBe(true)
  act(() => { expect(undo(view)).toBe(true) })
  expect(view.state.doc.toString()).toBe('Before')
})

it('rejects planned AI and imperative source insertion while the real view is locked', async () => {
  installApi()
  const ref = createRef<SourceEditorHandle>()
  const editor = (locked: boolean) => <SourceEditor ref={ref} documentKey="note.md" markdown="Before"
    interactionLocked={locked} onChange={vi.fn()} />
  const mounted = render(editor(false))
  const dom = mounted.container.querySelector<HTMLElement>('.cm-editor')!
  const view = EditorView.findFromDOM(dom)!
  const port = ref.current!.createWorkspaceAiEditorPort!()
  const capture = await port.captureReadSnapshot({})
  if (capture.status !== 'captured') throw new Error('capture failed')
  const input = { operationId: 'locked-source-ai', expectedEditorRevision: capture.editorRevision,
    expectedContentHash: capture.contentHash, replacementMarkdown: 'AI text' }
  expect((await port.planReplacement(input)).status).toBe('planned')
  mounted.rerender(editor(true))
  expect((await port.applyTransaction(input)).status).not.toBe('applied')
  expect(ref.current!.insertDroppedMarkdown({ markdown: 'Blocked tool', clientX: 1, clientY: 1 })).toBe(false)
  expect(view.state.doc.toString()).toBe('Before')
  mounted.rerender(editor(false))
  expect(EditorView.findFromDOM(dom)).toBe(view)
  act(() => view.dispatch({ changes: { from: 6, insert: ' edit' } }))
  expect(view.state.doc.toString()).toBe('Before edit')
})
