import { useRef } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranslationHistoryRecord } from '../../src/renderer/editor/translation-history'
import { TranslationHistoryRail } from '../../src/renderer/editor/TranslationHistoryRail'

function record(id: string, mode: 'visual' | 'source', createdAt = 1): TranslationHistoryRecord {
  return {
    id,
    requestId: `request-${id}`,
    documentKey: 'note.md',
    workspaceAbsolutePath: null,
    documentRelativePath: null,
    documentAbsolutePath: null,
    documentRevision: null,
    mode,
    source: { markdown: id, plainText: id },
    translatedMarkdown: `translated ${id}`,
    modelId: 'model',
    targetLanguage: 'zh-CN',
    terminal: 'completed',
    createdAt,
    anchor: mode === 'visual'
      ? {
          mode,
          from: 1,
          to: 2,
          blockStart: 0,
          fingerprint: { before: '', selected: id, after: '' },
          status: 'valid',
        }
      : {
          mode,
          from: 1,
          to: 2,
          lineStart: 0,
          fingerprint: { before: '', selected: id, after: '' },
          status: 'valid',
        },
  }
}

function Harness({
  mode,
  records,
  onOpenRecord,
  centerRequest,
}: {
  mode: 'visual' | 'source'
  records: readonly TranslationHistoryRecord[]
  onOpenRecord(recordId: string, initiator: HTMLElement): void
  centerRequest?: { recordId: string; token: number } | null
}) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  return <div className="editor-surface" ref={surfaceRef}>
    <div className={mode === 'visual' ? 'visual-editor' : 'source-editor-context'}>
      <div className={mode === 'visual' ? 'ProseMirror' : 'source-editor'}>
        <div className={mode === 'source' ? 'cm-scroller' : undefined}>
          {records.map((item, index) => <span
            data-translation-history-anchor-id={item.id}
            data-test-anchor-index={index}
            key={item.id}
          />)}
        </div>
      </div>
    </div>
    <TranslationHistoryRail
      centerRequest={centerRequest}
      mode={mode}
      onOpenRecord={onOpenRecord}
      records={records}
      refreshKey="test"
      surfaceRef={surfaceRef}
    />
  </div>
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('TranslationHistoryRail', () => {
  it('renders external visual buttons and a connector, then opens the exact record', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('editor-surface')) return new DOMRect(0, 0, 400, 240)
      if (this.classList.contains('ProseMirror')) return new DOMRect(40, 0, 300, 240)
      if (this.hasAttribute('data-translation-history-anchor-id')) return new DOMRect(80, 40, 60, 20)
      return new DOMRect(0, 0, 0, 0)
    })
    const onOpenRecord = vi.fn()
    render(<Harness mode="visual" records={[record('one', 'visual')]} onOpenRecord={onOpenRecord} />)

    const button = await screen.findByRole('button', { name: '打开翻译记录 1' })
    expect(button.closest('.visual-editor')).toBeNull()
    expect(document.querySelector('.translation-history-rail-connector-horizontal')).not.toBeNull()
    expect(document.querySelector('.translation-history-rail-connector-vertical')).not.toBeNull()
    fireEvent.click(button)
    expect(onOpenRecord).toHaveBeenCalledWith('one', button)
  })

  it('keeps separate source buttons in stable order and never draws a connector', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('editor-surface')) return new DOMRect(0, 0, 400, 240)
      if (this.classList.contains('source-editor-context')) return new DOMRect(0, 0, 360, 240)
      const index = Number(this.getAttribute('data-test-anchor-index') ?? 0)
      if (this.hasAttribute('data-translation-history-anchor-id')) return new DOMRect(200, 40 + index, 0, 20)
      return new DOMRect(0, 0, 0, 0)
    })
    render(<Harness
      mode="source"
      records={[record('later', 'source', 2), record('earlier', 'source', 1)]}
      onOpenRecord={vi.fn()}
    />)

    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(2))
    expect(screen.getAllByRole('button').map((button) => button.dataset.recordId))
      .toEqual(['later', 'earlier'])
    expect(document.querySelector('.translation-history-rail-connector-horizontal')).toBeNull()
    expect(document.querySelector('.translation-history-rail-connector-vertical')).toBeNull()
  })

  it('omits offscreen anchors and removes the layer on unmount', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('editor-surface')) return new DOMRect(0, 0, 400, 240)
      if (this.classList.contains('ProseMirror')) return new DOMRect(40, 0, 300, 240)
      if (this.hasAttribute('data-translation-history-anchor-id')) return new DOMRect(80, 400, 60, 20)
      return new DOMRect(0, 0, 0, 0)
    })
    const rendered = render(<Harness mode="visual" records={[record('offscreen', 'visual')]} onOpenRecord={vi.fn()} />)

    await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument())
    rendered.unmount()
    expect(document.querySelector('.translation-history-rail-layer')).toBeNull()
  })

  it('ignores already queued observer callbacks after unmount', async () => {
    const callbacks: ResizeObserverCallback[] = []
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) { callbacks.push(callback) }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('editor-surface')) return new DOMRect(0, 0, 400, 240)
      if (this.classList.contains('ProseMirror')) return new DOMRect(40, 0, 300, 240)
      if (this.hasAttribute('data-translation-history-anchor-id')) return new DOMRect(80, 40, 60, 20)
      return new DOMRect(0, 0, 0, 0)
    })
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame')
    const rendered = render(<Harness mode="visual" records={[record('one', 'visual')]} onOpenRecord={vi.fn()} />)
    await screen.findByRole('button', { name: '打开翻译记录 1' })
    rendered.unmount()
    const callsBeforeLateObserver = requestFrame.mock.calls.length

    act(() => callbacks.forEach((callback) => callback([], {} as ResizeObserver)))

    expect(requestFrame).toHaveBeenCalledTimes(callsBeforeLateObserver)
  })

  it.each([
    ['visual', 'editor-surface', 1],
    ['source', 'cm-scroller', 2],
  ] as const)('centers the final collision-adjusted %s button exactly once', async (mode, scrollClass, scrollScale) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('editor-surface')) return new DOMRect(0, 0, 400, 240)
      if (this.classList.contains('cm-scroller')) return new DOMRect(0, 0, 400, 240 * scrollScale)
      if (this.classList.contains('ProseMirror') || this.classList.contains('source-editor')) {
        return new DOMRect(40, 0, 300, 800)
      }
      if (this.hasAttribute('data-translation-history-anchor-id')) {
        const scrollTarget = document.querySelector<HTMLElement>(`.${scrollClass}`)!
        const visualShift = scrollTarget.scrollTop * scrollScale
        return mode === 'visual'
          ? new DOMRect(80, 80 - visualShift, 60, 20)
          : new DOMRect(200, 190 - visualShift, 0, 20)
      }
      return new DOMRect(0, 0, 0, 0)
    })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains(scrollClass) ? 240 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains(scrollClass) ? 1_000 : 0
    })
    const records = [record('one', mode, 1), record('two', mode, 2)]
    const view = render(<Harness
      centerRequest={{ recordId: 'two', token: 1 }}
      mode={mode}
      records={records}
      onOpenRecord={vi.fn()}
    />)
    const scrollTarget = document.querySelector<HTMLElement>(`.${scrollClass}`)!

    await waitFor(() => expect(scrollTarget.scrollTop).toBeGreaterThan(0))
    await waitFor(() => {
      const button = document.querySelector<HTMLElement>('[data-record-id="two"]')!
      expect(Number.parseFloat(button.style.top) + 15).toBeCloseTo(120, 1)
    })
    const expectedSettledScrollTop = mode === 'visual' ? 31 : 57
    await waitFor(() => expect(scrollTarget.scrollTop).toBeCloseTo(expectedSettledScrollTop, 1))
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    })
    const centeredScrollTop = scrollTarget.scrollTop

    view.rerender(<Harness
      centerRequest={{ recordId: 'two', token: 1 }}
      mode={mode}
      records={records}
      onOpenRecord={vi.fn()}
    />)
    await act(async () => undefined)
    expect(scrollTarget.scrollTop).toBe(centeredScrollTop)

    scrollTarget.scrollTop = centeredScrollTop + 40
    fireEvent.scroll(scrollTarget)
    await waitFor(() => {
      const button = document.querySelector<HTMLElement>('[data-record-id="two"]')!
      expect(Number.parseFloat(button.style.top) + 15).not.toBeCloseTo(120, 1)
    })
    expect(scrollTarget.scrollTop).toBe(centeredScrollTop + 40)
  })

  it.each([
    ['visual', 'editor-surface'],
    ['source', 'cm-scroller'],
  ] as const)('keeps the requested %s button centered when the document is already at its top boundary', async (mode, scrollClass) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('editor-surface')) return new DOMRect(0, 0, 400, 240)
      if (this.classList.contains('cm-scroller')) return new DOMRect(0, 0, 400, 240)
      if (this.classList.contains('ProseMirror') || this.classList.contains('source-editor')) {
        return new DOMRect(40, 0, 300, 800)
      }
      if (this.hasAttribute('data-translation-history-anchor-id')) {
        return mode === 'visual'
          ? new DOMRect(80, 10, 60, 20)
          : new DOMRect(200, 10, 0, 20)
      }
      return new DOMRect(0, 0, 0, 0)
    })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains(scrollClass) ? 240 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains(scrollClass) ? 1_000 : 0
    })
    render(<Harness
      centerRequest={{ recordId: 'top', token: 1 }}
      mode={mode}
      records={[record('top', mode)]}
      onOpenRecord={vi.fn()}
    />)

    await waitFor(() => {
      const button = document.querySelector<HTMLElement>('[data-record-id="top"]')!
      expect(Number.parseFloat(button.style.top) + 15).toBeCloseTo(120, 1)
    })
    expect(document.querySelector<HTMLElement>(`.${scrollClass}`)!.scrollTop).toBe(0)
  })
})
