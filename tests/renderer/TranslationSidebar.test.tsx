import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import {
  computeTranslationSidebarTopOffset,
  computeTranslationSidebarReadyTopOffset,
  TranslationSidebar,
} from '../../src/renderer/editor/TranslationSidebar'
import type { TranslationHistoryRecord } from '../../src/renderer/editor/translation-history'
import type { TranslationUiState } from '../../src/renderer/editor/translation-ui-state'

function state(
  status: TranslationUiState['status'],
  output = '',
  error: string | null = null,
  errorCode: TranslationUiState['errorCode'] = null,
): TranslationUiState {
  return {
    requestId: status === 'ready' ? null : 'request-1',
    status,
    output,
    errorCode,
    error,
  }
}

const baseProps = {
  alignmentHeight: 600,
  containerWidth: 1200,
  mode: 'visual' as const,
  resultHeight: 180,
  selectionTop: 180,
  surfaceTop: 100,
}

it.each([
  ['gpt-6-astra', 'https://api.openai.com/v1', 'other', false, true],
  ['kimi-k2.5', 'https://api.moonshot.ai/v1', 'kimi', true, false],
  ['unknown', 'https://example.com/v1', 'other', false, false],
] as const)('uses shared truthful controls for %s without replacing output', (modelId, baseUrl, provider, toggle, effort) => {
  renderSidebar(state('completed', 'Existing translation'), {
    thinkingConnection: { provider, protocol: 'openai', baseUrl, modelId },
    thinkingPreference: { thinkingMode: 'disabled', reasoningEffort: 'low' },
    onThinkingChange: vi.fn(),
  })
  expect(Boolean(screen.queryByRole('switch', { name: '翻译思考' }))).toBe(toggle)
  expect(Boolean(screen.queryByRole('combobox', { name: '翻译推理强度' }))).toBe(effort)
  expect(screen.getByText('Existing translation')).toBeVisible()
})

function renderSidebar(
  value: TranslationUiState,
  overrides: Partial<Parameters<typeof TranslationSidebar>[0]> = {},
) {
  const callbacks = {
    onTranslate: vi.fn(),
    onStop: vi.fn(),
    onCopy: vi.fn(),
    onClose: vi.fn(),
    onOpenSettings: vi.fn(),
    onRetry: vi.fn(),
    onWidthChange: vi.fn(),
    onOpenHistory: vi.fn(),
    onReturnToLive: vi.fn(),
    onSelectHistory: vi.fn(),
  }
  const result = render(
    <TranslationSidebar
      {...baseProps}
      {...callbacks}
      state={value}
      {...overrides}
    />,
  )
  return { ...result, callbacks }
}

function historyRecord(): TranslationHistoryRecord {
  return {
    id: 'record-1',
    requestId: 'request-1',
    documentKey: 'note.md',
    workspaceAbsolutePath: null,
    documentRelativePath: null,
    documentAbsolutePath: null,
    documentRevision: null,
    mode: 'visual',
    source: { markdown: 'source', plainText: 'source' },
    translatedMarkdown: 'saved translation',
    modelId: 'chat-model',
    targetLanguage: 'zh-CN',
    terminal: 'completed',
    createdAt: 1,
    anchor: {
      mode: 'visual',
      from: 1,
      to: 7,
      blockStart: 0,
      fingerprint: { before: '', selected: 'source', after: '' },
      status: 'valid',
    },
  }
}

it('keeps the fixed history footer outside the scroll area and disables it without records', () => {
  const { rerender } = renderSidebar(state('completed', 'result'))
  const sidebar = screen.getByRole('complementary', { name: '右侧栏' })
  const scroll = sidebar.querySelector('.translation-sidebar-scroll')!
  const entry = screen.getByRole('button', { name: '查看翻译记录' })
  const footer = entry.closest<HTMLElement>('.translation-sidebar-footer')!

  expect(entry).toBeDisabled()
  expect(footer.parentElement).toBe(sidebar.querySelector('.translation-sidebar-content'))
  expect(scroll).not.toContainElement(footer)

  rerender(
    <TranslationSidebar
      {...baseProps}
      historyRecordId="record-1"
      onClose={() => undefined}
      onCopy={() => undefined}
      onOpenHistory={() => undefined}
      onRetry={() => undefined}
      onReturnToLive={() => undefined}
      onSelectHistory={() => undefined}
      onStop={() => undefined}
      onTranslate={() => undefined}
      onWidthChange={() => undefined}
      state={state('completed', 'result')}
    />,
  )
  expect(screen.getByRole('button', { name: '查看翻译记录' })).toBeEnabled()
})

it('preserves the live result DOM and scroll position while history is shown and after return', () => {
  const records = [historyRecord()]
  const { container, rerender } = renderSidebar(state('streaming', 'live output'), {
    historyRecordId: 'record-1',
    historyRecords: records,
  })
  const liveScroll = container.querySelector<HTMLElement>('.translation-sidebar-live-scroll')!
  const liveResult = screen.getByTestId('translation-sidebar-result')
  liveScroll.scrollTop = 137

  rerender(
    <TranslationSidebar
      {...baseProps}
      historyRecordId="record-1"
      historyRecords={records}
      onClose={() => undefined}
      onCopy={() => undefined}
      onOpenHistory={() => undefined}
      onReturnToLive={() => undefined}
      onSelectHistory={() => undefined}
      onStop={() => undefined}
      onTranslate={() => undefined}
      state={state('streaming', 'live output grows')}
      view={{ kind: 'history', recordId: 'record-1' }}
    />,
  )

  expect(container.querySelector('.translation-sidebar-result')).toBe(liveResult)
  expect(container.querySelector('.translation-sidebar-live-scroll')).toBe(liveScroll)
  expect(liveScroll).toHaveAttribute('hidden')
  expect(liveScroll.scrollTop).toBe(137)
  expect(liveResult).toHaveTextContent('live output grows')
  expect(screen.getByRole('region', { name: '翻译记录' })).toBeVisible()
  for (const name of ['复制译文', '上一条', '下一条', '返回当前翻译', '停止翻译']) {
    expect(screen.getByRole('button', { name })).toBeVisible()
  }

  rerender(
    <TranslationSidebar
      {...baseProps}
      historyRecordId="record-1"
      historyRecords={records}
      onClose={() => undefined}
      onCopy={() => undefined}
      onOpenHistory={() => undefined}
      onReturnToLive={() => undefined}
      onSelectHistory={() => undefined}
      onStop={() => undefined}
      onTranslate={() => undefined}
      state={state('streaming', 'live output grows')}
      view={{ kind: 'live' }}
    />,
  )
  expect(screen.getByTestId('translation-sidebar-result')).toBe(liveResult)
  expect(liveScroll).not.toHaveAttribute('hidden')
  expect(liveScroll.scrollTop).toBe(137)
})

it('hides the history entry beside close-history when history becomes empty', () => {
  renderSidebar(state('completed', 'live output'), {
    historyRecordId: null,
    historyRecords: [],
    view: { kind: 'history', recordId: 'removed-record' },
    canReturnToLive: false,
  })

  expect(screen.queryByRole('button', { name: '查看翻译记录' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '关闭翻译记录' })).toBeEnabled()
})

it('places history navigation on the left of the retained footer actions', () => {
  const records = [
    historyRecord(),
    { ...historyRecord(), id: 'record-2', createdAt: 2 },
  ]
  const { callbacks, container } = renderSidebar(state('completed', 'live output'), {
    historyRecords: records,
    view: { kind: 'history', recordId: 'record-1' },
  })

  const footer = container.querySelector<HTMLElement>('.translation-sidebar-footer')!
  const left = footer.querySelector<HTMLElement>('.translation-sidebar-footer-left')!
  const right = footer.querySelector<HTMLElement>('.translation-sidebar-footer-right')!
  const previous = screen.getByRole('button', { name: '上一条' })
  const next = screen.getByRole('button', { name: '下一条' })
  const close = screen.getByRole('button', { name: '返回当前翻译' })

  expect(previous).toHaveClass('translation-history-navigation-button')
  expect(next).toHaveClass('translation-history-navigation-button')
  expect(previous).toHaveTextContent('')
  expect(next).toHaveTextContent('')
  expect(previous.querySelector('svg')).toBeInTheDocument()
  expect(next.querySelector('svg')).toBeInTheDocument()
  expect(left).toHaveTextContent('1/2')
  expect(close).toHaveClass('translation-icon-action')
  expect(close).toHaveTextContent('')
  expect(close.querySelector('svg')).toBeInTheDocument()

  expect(left).toContainElement(previous)
  expect(left).toContainElement(next)
  expect(right).toContainElement(close)
  expect(previous).toBeDisabled()
  expect(next).toBeEnabled()
  fireEvent.click(next)
  expect(callbacks.onSelectHistory).toHaveBeenCalledWith('record-2', 'center')
})

it('numbers the oldest history record as one and the newest as the total', () => {
  const records = [
    historyRecord(),
    { ...historyRecord(), id: 'record-2', createdAt: 2 },
    { ...historyRecord(), id: 'record-3', createdAt: 3 },
  ]
  const { container, rerender } = renderSidebar(state('completed', 'live output'), {
    historyRecords: records,
    view: { kind: 'history', recordId: 'record-1' },
  })

  expect(container.querySelector('.translation-history-counter')).toHaveTextContent('1/3')
  rerender(
    <TranslationSidebar
      {...baseProps}
      historyRecords={records}
      onClose={() => undefined}
      onCopy={() => undefined}
      onReturnToLive={() => undefined}
      onSelectHistory={() => undefined}
      onStop={() => undefined}
      onTranslate={() => undefined}
      state={state('completed', 'live output')}
      view={{ kind: 'history', recordId: 'record-3' }}
    />,
  )
  expect(container.querySelector('.translation-history-counter')).toHaveTextContent('3/3')
})

it('uses a text control to view history and icon controls to return or close it', () => {
  const record = historyRecord()
  const { rerender } = renderSidebar(state('completed', 'live output'), {
    historyRecordId: record.id,
    historyRecords: [record],
  })

  const viewHistory = screen.getByRole('button', { name: '查看翻译记录' })
  expect(viewHistory).toHaveTextContent('查看翻译记录')

  rerender(
    <TranslationSidebar
      {...baseProps}
      canReturnToLive
      historyRecords={[record]}
      onClose={() => undefined}
      onCopy={() => undefined}
      onReturnToLive={() => undefined}
      onSelectHistory={() => undefined}
      onStop={() => undefined}
      onTranslate={() => undefined}
      state={state('completed', 'live output')}
      view={{ kind: 'history', recordId: record.id }}
    />,
  )
  expect(screen.getByRole('button', { name: '返回当前翻译' })).toHaveTextContent('')

  rerender(
    <TranslationSidebar
      {...baseProps}
      canReturnToLive={false}
      historyRecords={[record]}
      onClose={() => undefined}
      onCopy={() => undefined}
      onReturnToLive={() => undefined}
      onSelectHistory={() => undefined}
      onStop={() => undefined}
      onTranslate={() => undefined}
      state={state('completed', 'live output')}
      view={{ kind: 'history', recordId: record.id }}
    />,
  )
  const closeHistory = screen.getByRole('button', { name: '关闭翻译记录' })
  expect(closeHistory).toHaveClass('translation-icon-action')
  expect(closeHistory).toHaveTextContent('')
  expect(closeHistory.querySelector('svg')).toBeInTheDocument()
})

it('renders translation tab content without owning the generic complementary region', () => {
  const { container } = render(
    <TranslationSidebar
      {...baseProps}
      containerWidth={undefined}
      onClose={() => undefined}
      onCopy={() => undefined}
      onOpenHistory={() => undefined}
      onRetry={() => undefined}
      onReturnToLive={() => undefined}
      onSelectHistory={() => undefined}
      onStop={() => undefined}
      onTranslate={() => undefined}
      state={state('completed', 'result')}
    />,
  )

  expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  expect(container.querySelector('.translation-sidebar-content')).toBeInTheDocument()
})

it('routes an unconfigured model to settings without offering retry', () => {
  const { callbacks } = renderSidebar(state(
    'failed',
    '',
    '尚未配置划词翻译使用的大模型',
    'MODEL_NOT_CONFIGURED',
  ))

  expect(screen.getByRole('alert')).toHaveTextContent('尚未配置大模型')
  expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '前往配置' }))
  fireEvent.click(screen.getByRole('button', { name: '暂不' }))
  expect(callbacks.onOpenSettings).toHaveBeenCalledOnce()
  expect(callbacks.onClose).toHaveBeenCalledOnce()
})

it.each(['starting', 'streaming'] as const)(
  'keeps stop and return actions reachable from history during %s',
  (status) => {
    const { callbacks } = renderSidebar(state(status, status === 'streaming' ? 'x'.repeat(5000) : ''), {
      historyRecordId: 'record-1',
      historyRecords: [],
      view: { kind: 'history', recordId: 'record-1' },
    })

    const stop = screen.getByRole('button', { name: '停止翻译' })
    const back = screen.getByRole('button', { name: '返回当前翻译' })
    expect(stop.closest('.translation-sidebar-footer')).toBe(back.closest('.translation-sidebar-footer'))
    fireEvent.click(back)
    fireEvent.click(stop)
    expect(callbacks.onReturnToLive).toHaveBeenCalledOnce()
    expect(callbacks.onStop).toHaveBeenCalledOnce()
  },
)

it('defaults to 530 pixels independently of container width', () => {
  const { rerender } = renderSidebar(state('completed', '结果'), { containerWidth: 600 })
  const sidebar = screen.getByRole('complementary', { name: '右侧栏' })
  expect(sidebar).toHaveStyle({ width: '530px' })

  rerender(
    <TranslationSidebar
      {...baseProps}
      containerWidth={1200}
      onClose={() => undefined}
      onCopy={() => undefined}
      onRetry={() => undefined}
      onStop={() => undefined}
      onTranslate={() => undefined}
      onWidthChange={() => undefined}
      state={state('completed', '结果')}
    />,
  )
  expect(sidebar).toHaveStyle({ width: '530px' })

  rerender(
    <TranslationSidebar
      {...baseProps}
      containerWidth={2000}
      onClose={() => undefined}
      onCopy={() => undefined}
      onRetry={() => undefined}
      onStop={() => undefined}
      onTranslate={() => undefined}
      onWidthChange={() => undefined}
      state={state('completed', '结果')}
    />,
  )
  expect(sidebar).toHaveStyle({ width: '530px' })
})

it('dragging the splitter changes only application layout width', () => {
  const resizeWindow = vi.spyOn(window, 'resizeTo')
  const { callbacks } = renderSidebar(state('streaming', '部分结果'))
  const splitter = screen.getByRole('separator', { name: '调整右侧栏宽度' })

  fireEvent.pointerDown(splitter, { button: 0, clientX: 500, pointerId: 1 })
  fireEvent.pointerMove(document, { clientX: 400, pointerId: 1 })
  fireEvent.pointerUp(document, { clientX: 400, pointerId: 1 })

  expect(screen.getByRole('complementary', { name: '右侧栏' }))
    .toHaveStyle({ width: '630px' })
  expect(callbacks.onWidthChange).toHaveBeenCalledTimes(1)
  expect(callbacks.onWidthChange).toHaveBeenCalledWith(630)
  expect(resizeWindow).not.toHaveBeenCalled()
  resizeWindow.mockRestore()
})

it('aligns to the selection relative to the editor surface and clamps the offset', () => {
  const { rerender } = renderSidebar(state('completed', '结果'))
  const result = screen.getByTestId('translation-sidebar-result')
  expect(result).toHaveStyle({ marginTop: '32px' })

  rerender(
    <TranslationSidebar
      {...baseProps}
      onClose={() => undefined}
      onCopy={() => undefined}
      onRetry={() => undefined}
      onStop={() => undefined}
      onTranslate={() => undefined}
      onWidthChange={() => undefined}
      selectionTop={900}
      state={state('completed', '结果')}
    />,
  )
  expect(result).toHaveStyle({ marginTop: '420px' })

  rerender(
    <TranslationSidebar
      {...baseProps}
      alignmentHeight={300}
      onClose={() => undefined}
      onCopy={() => undefined}
      onRetry={() => undefined}
      onStop={() => undefined}
      onTranslate={() => undefined}
      onWidthChange={() => undefined}
      resultHeight={80}
      selectionTop={180}
      state={state('completed', '结果')}
    />,
  )
  expect(result).toHaveStyle({ marginTop: '32px' })

  rerender(
    <TranslationSidebar
      {...baseProps}
      onClose={() => undefined}
      onCopy={() => undefined}
      onRetry={() => undefined}
      onStop={() => undefined}
      onTranslate={() => undefined}
      onWidthChange={() => undefined}
      selectionTop={10}
      state={state('completed', '结果')}
    />,
  )
  expect(result).toHaveStyle({ marginTop: '0px' })
})

it('puts a selected-content translation action in the first sidebar row', () => {
  renderSidebar(state('ready'))

  const result = screen.getByTestId('translation-sidebar-result')
  const action = screen.getByRole('button', { name: '翻译选中的文本' })
  expect(result).toHaveStyle({ marginTop: '60px' })
  expect(result.firstElementChild).toBe(action)
  expect(action).toHaveClass('translation-sidebar-ready-action')
})

it('does not offer selected-text translation when the editor has no selection', () => {
  renderSidebar(state('ready'), { hasSelection: false })

  expect(screen.queryByRole('button', { name: '翻译选中的文本' })).not.toBeInTheDocument()
})

it('styles and positions the no-history state at the requested measured size', () => {
  const style = document.createElement('style')
  style.textContent = readFileSync(
    path.join(process.cwd(), 'src/renderer/editor/selection-translation.css'),
    'utf8',
  )
  document.head.append(style)
  try {
    renderSidebar(state('ready'), {
      hasSelection: false,
      view: { kind: 'history', recordId: '' },
    })
    const empty = screen.getByText('暂无翻译记录')
    expect(empty).toHaveClass('translation-history-empty-state')
    expect(getComputedStyle(empty).fontSize).toBe('14px')
    expect(getComputedStyle(empty).color).toBe('rgba(0, 0, 0, 0.2)')
    expect(getComputedStyle(empty).marginTop).toBe('34.6667px')
  } finally {
    style.remove()
  }
})

it.each([
  ['completed', '最终译文', null, null],
  ['stopped', '部分译文', null, null],
  ['failed', '超时部分译文', '大模型请求超时', 'MODEL_TIMEOUT'],
] as const)(
  'uses copy and close icons for the %s result actions',
  (status, output, error, errorCode) => {
    const { container } = renderSidebar(state(status, output, error, errorCode))
    expect(screen.getByTestId('translation-sidebar-result')).not.toHaveClass('has-terminal-surface')
    expect(container.querySelector('.translation-output')).toHaveClass('has-terminal-surface')

    for (const name of ['复制', '关闭']) {
      const button = screen.getByRole('button', { name })
      expect(button).toHaveClass('translation-icon-action', 'translation-result-icon-action')
      expect(button).toHaveAttribute('data-tooltip', name)
      expect(button).toHaveTextContent('')
      expect(button.querySelector('svg')).toBeInTheDocument()
    }
  },
)

it.each([
  ['ready', '', null, null],
  ['starting', '', null, null],
  ['streaming', 'partial', null, null],
  ['completed', '', null, null],
  ['failed', '', '尚未配置划词翻译使用的大模型', 'MODEL_NOT_CONFIGURED'],
  ['failed', '', '操作未能完成', 'OPERATION_FAILED'],
] as const)(
  'does not apply the terminal result surface to %s without a retained result',
  (status, output, error, errorCode) => {
    const { container } = renderSidebar(state(status, output, error, errorCode))
    expect(screen.getByTestId('translation-sidebar-result')).not.toHaveClass('has-terminal-surface')
    expect(container.querySelector('.translation-output.has-terminal-surface')).toBeNull()
  },
)

it('clamps the selected-content action between ten and seventy percent of the sidebar height', () => {
  expect(computeTranslationSidebarTopOffset({
    selectionTop: 300,
    surfaceTop: 100,
    alignmentHeight: 600,
    resultHeight: 30,
  })).toBe(152)
  expect(computeTranslationSidebarReadyTopOffset({
    selectionTop: 300,
    surfaceTop: 100,
    alignmentHeight: 600,
    resultHeight: 30,
  })).toBe(152)
  expect(computeTranslationSidebarReadyTopOffset({
    selectionTop: 0,
    surfaceTop: 0,
    alignmentHeight: 600,
    resultHeight: 30,
  })).toBe(60)
  expect(computeTranslationSidebarReadyTopOffset({
    selectionTop: 580,
    surfaceTop: 0,
    alignmentHeight: 600,
    resultHeight: 30,
  })).toBe(420)
})

it('centers the unconfigured guide independently of the selected text', () => {
  const { container } = renderSidebar(state('failed', '', '尚未配置划词翻译使用的大模型', 'MODEL_NOT_CONFIGURED'))
  expect(container.querySelector('.translation-sidebar-live-scroll')).toHaveClass('is-unconfigured')
  expect(screen.getByTestId('translation-sidebar-result')).toHaveStyle({ marginTop: '0px' })
})

it('gives the sidebar translation action distinct hover and pressed states', () => {
  const css = readFileSync(
    path.join(process.cwd(), 'src/renderer/editor/selection-translation.css'),
    'utf8',
  )

  expect(css).toMatch(/\.translation-sidebar-ready-action\s*\{[^}]*background:\s*#fff;[^}]*60%/s)
  expect(css).toMatch(/\.translation-sidebar-ready-action:not\(:disabled\):hover\s*\{[^}]*background:\s*rgb\(var\(--theme-color-rgb\)\s*\/\s*5%\);[^}]*box-shadow:/s)
  expect(css).toMatch(/\.translation-sidebar-ready-action:not\(:disabled\):active\s*\{[^}]*background:\s*rgb\(var\(--theme-color-rgb\)\s*\/\s*10%\);/s)
})

it('insets the five-percent theme surface around only terminal output text', () => {
  const style = document.createElement('style')
  style.textContent = readFileSync(
    path.join(process.cwd(), 'src/renderer/editor/selection-translation.css'),
    'utf8',
  )
  document.head.append(style)
  try {
    const { container } = renderSidebar(state('completed', 'result'))
    const result = screen.getByTestId('translation-sidebar-result')
    const output = container.querySelector<HTMLElement>('.translation-output')!
    const footer = container.querySelector<HTMLElement>('.translation-sidebar-footer')!
    expect(getComputedStyle(result).borderTopWidth).toBe('0px')
    expect(getComputedStyle(result).borderRadius).toBe('0px')
    expect(getComputedStyle(output).borderRadius).toBe('8px')
    expect(getComputedStyle(output).padding).toBe('8px 16px 6px')
    expect(getComputedStyle(output).marginLeft).toBe('-12px')
    expect(getComputedStyle(output).marginRight).toBe('-12px')
    expect(getComputedStyle(output).width).toBe('calc(100% + 24px)')
    const terminalRule = Array.from(style.sheet?.cssRules ?? []).find((rule) => (
      rule instanceof CSSStyleRule
      && rule.selectorText === '.translation-output.has-terminal-surface'
    )) as CSSStyleRule | undefined
    expect(terminalRule?.style.background).toBe('rgb(var(--theme-color-rgb) / 5%)')
    expect(getComputedStyle(result).boxShadow).toBe('none')
    expect(getComputedStyle(footer).borderTopColor).toBe('rgba(0, 0, 0, 0.05)')
  } finally {
    style.remove()
  }
})

it.each(['starting', 'streaming'] as const)(
  'keeps near-bottom %s content inside the measured active scroll viewport',
  (status) => {
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function getClientHeight(this: HTMLElement) {
        return this.classList.contains('translation-sidebar-scroll') ? 540 : 0
      })

    try {
      renderSidebar(state(status, status === 'streaming' ? 'partial output' : ''), {
        alignmentHeight: 600,
        resultHeight: 180,
        selectionTop: 900,
        surfaceTop: 100,
      })

      expect(screen.getByTestId('translation-sidebar-result'))
        .toHaveStyle({ marginTop: '360px' })
    } finally {
      clientHeight.mockRestore()
    }
  },
)

it('falls back to editor alignment when the measured active scroll viewport is zero', () => {
  const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get')
    .mockReturnValue(0)

  try {
    renderSidebar(state('streaming', 'partial output'))
    expect(screen.getByTestId('translation-sidebar-result'))
      .toHaveStyle({ marginTop: '32px' })
  } finally {
    clientHeight.mockRestore()
  }
})

it('preserves completed-state alignment when the fixed stop bar is absent', () => {
  const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get')
    .mockImplementation(function getClientHeight(this: HTMLElement) {
      return this.classList.contains('translation-sidebar-scroll') ? 540 : 0
    })

  try {
    renderSidebar(state('completed', 'result'), {
      alignmentHeight: 600,
      resultHeight: 180,
      selectionTop: 900,
      surfaceTop: 100,
    })

    expect(screen.getByTestId('translation-sidebar-result'))
      .toHaveStyle({ marginTop: '420px' })
  } finally {
    clientHeight.mockRestore()
  }
})

it('uses the shared structured Markdown renderer in source and visual modes without interpreting HTML', () => {
  const unsafe = '第一段\n\n**第二段**\n\n<img src=x onerror="alert(1)">'
  const { container, rerender } = renderSidebar(
    state('completed', unsafe),
    { mode: 'source' },
  )

  const sourceOutput = container.querySelector<HTMLElement>('.translation-output-source')!
  expect(sourceOutput.tagName).toBe('DIV')
  expect(sourceOutput).toHaveClass('translation-output-source')
  expect(sourceOutput).toHaveAttribute('data-ui-selectable', 'true')
  expect(sourceOutput).toHaveAttribute('tabindex', '0')
  expect(sourceOutput.querySelector('strong')).toHaveTextContent('第二段')
  expect(sourceOutput).not.toHaveTextContent('<img')
  expect(sourceOutput.querySelector('img')).toBeNull()

  rerender(
    <TranslationSidebar
      {...baseProps}
      onClose={() => undefined}
      onCopy={() => undefined}
      onRetry={() => undefined}
      onStop={() => undefined}
      onTranslate={() => undefined}
      onWidthChange={() => undefined}
      state={state('completed', unsafe)}
    />,
  )
  const style = document.createElement('style')
  style.textContent = readFileSync(
    path.join(process.cwd(), 'src/renderer/editor/selection-translation.css'),
    'utf8',
  )
  document.head.append(style)
  try {
    const visualOutput = container.querySelector<HTMLElement>('.translation-output-visual')!
    expect(visualOutput.tagName).toBe('DIV')
    expect(visualOutput).toHaveClass('translation-output-visual')
    expect(visualOutput).toHaveAttribute('data-ui-selectable', 'true')
    expect(visualOutput).toHaveAttribute('tabindex', '0')
    expect(visualOutput.querySelector('strong')).toHaveTextContent('第二段')
    expect(visualOutput).not.toHaveTextContent('<img')
    expect(visualOutput.querySelector('img')).toBeNull()
  } finally {
    style.remove()
  }
})

it('invokes exact stop, copy, close, retry, and ready callbacks', () => {
  const { callbacks, rerender } = renderSidebar(state('starting'))
  fireEvent.click(screen.getByRole('button', { name: '停止翻译' }))
  expect(callbacks.onStop).toHaveBeenCalledTimes(1)

  rerender(
    <TranslationSidebar
      {...baseProps}
      {...callbacks}
      state={state('streaming', '流式译文')}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: '停止翻译' }))
  expect(callbacks.onStop).toHaveBeenCalledTimes(2)

  rerender(
    <TranslationSidebar
      {...baseProps}
      {...callbacks}
      state={state('completed', '最终译文')}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: '复制' }))
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  expect(callbacks.onCopy).toHaveBeenCalledWith('最终译文')
  expect(callbacks.onClose).toHaveBeenCalledTimes(1)

  rerender(
    <TranslationSidebar
      {...baseProps}
      {...callbacks}
      state={state('stopped', '部分译文')}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: '复制' }))
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  expect(callbacks.onCopy).toHaveBeenCalledTimes(2)
  expect(callbacks.onCopy).toHaveBeenLastCalledWith('部分译文')
  expect(callbacks.onClose).toHaveBeenCalledTimes(2)

  rerender(
    <TranslationSidebar
      {...baseProps}
      {...callbacks}
      state={state('failed', '', '连接暂时不可用')}
    />,
  )
  expect(screen.getByRole('alert')).toHaveTextContent('连接暂时不可用')
  expect(screen.getByRole('alert')).toHaveAttribute('data-ui-selectable', 'true')
  expect(screen.getByRole('alert')).toHaveAttribute('tabindex', '0')
  expect(screen.queryByText('最终译文')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(callbacks.onRetry).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  expect(callbacks.onClose).toHaveBeenCalledTimes(3)

  rerender(
    <TranslationSidebar
      {...baseProps}
      {...callbacks}
      state={state('ready')}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
  expect(callbacks.onTranslate).toHaveBeenCalledTimes(1)
})

it.each(['starting', 'streaming'] as const)(
  'renders exactly one 停止翻译 button in a non-scrolling fixed stop bar for %s',
  (status) => {
    renderSidebar(state(status, status === 'streaming' ? 'partial output' : ''))

    const buttons = screen.getAllByRole('button', { name: '停止翻译' })
    expect(buttons).toHaveLength(1)

  const sidebar = screen.getByRole('complementary', { name: '右侧栏' })
    const scroll = sidebar.querySelector('.translation-sidebar-scroll')!
    const stopBar = buttons[0].closest('.translation-sidebar-stop-bar') as HTMLElement
    expect(stopBar.parentElement).toBe(sidebar.querySelector('.translation-sidebar-content'))
    expect(stopBar.previousElementSibling).toBe(scroll)
    expect(scroll).not.toContainElement(stopBar)
  },
)

it.each(['ready', 'completed', 'stopped', 'failed'] as const)(
  'does not render the fixed stop bar when the sidebar is %s',
  (status) => {
    renderSidebar(state(status, status === 'completed' ? 'result' : ''))
    expect(document.querySelector('.translation-sidebar-stop-bar')).toBeNull()
  },
)

it('defines the non-scrolling fixed sidebar layout contract', () => {
  const css = [
    'editor-right-sidebar.css',
    'selection-translation.css',
  ].map((fileName) => readFileSync(
    path.join(process.cwd(), 'src/renderer/editor', fileName),
    'utf8',
  )).join('\n')

  expect(css).toMatch(/\.editor-right-sidebar\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s)
  expect(css).toMatch(/\.translation-sidebar-content\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s)
  expect(css).toMatch(/\.translation-sidebar-scroll\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s)
  expect(css).toMatch(/\.translation-sidebar-footer\s*\{[^}]*flex:\s*none;/s)
  expect(css).toMatch(/\.translation-sidebar-stop-bar\s*\{[^}]*flex:\s*none;/s)
})

it.each([
  {
    className: 'translation-output-source',
    mode: 'source' as const,
    surface: 'DIV',
  },
  {
    className: 'translation-output-visual',
    mode: 'visual' as const,
    surface: 'DIV',
  },
])('shows $mode 部分结果超时 as structured live output with copy and close but no retry', ({
  className,
  mode,
  surface,
}) => {
  const { callbacks, container } = renderSidebar(state(
    'failed',
    '部分译文',
    '大模型请求超时',
    'MODEL_TIMEOUT',
  ), { mode })

  expect(screen.getByRole('alert')).toHaveTextContent('翻译内容过多，请分批次翻译')
  const output = container.querySelector<HTMLElement>('.translation-output')!
  expect(output).toBeVisible()
  expect(output.tagName).toBe(surface)
  expect(output).toHaveClass(className)
  expect(output.textContent).toBe('部分译文')
  expect(output).toHaveAttribute('data-ui-selectable', 'true')
  expect(output).toHaveAttribute('tabindex', '0')
  expect(output).toHaveAttribute('aria-live', 'polite')
  expect(screen.getByRole('button', { name: '复制' })).toBeVisible()
  expect(screen.getByRole('button', { name: '关闭' })).toBeVisible()
  expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: '复制' }))
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  expect(callbacks.onCopy).toHaveBeenCalledTimes(1)
  expect(callbacks.onCopy).toHaveBeenCalledWith('部分译文')
  expect(callbacks.onClose).toHaveBeenCalledTimes(1)
})

it('shows 无结果超时 with retry and close but no copy or output surface', () => {
  renderSidebar(state(
    'failed',
    '',
    '大模型请求超时',
    'MODEL_TIMEOUT',
  ))

  expect(screen.getByRole('alert')).toHaveTextContent('大模型请求超时')
  expect(screen.getByRole('button', { name: '重试' })).toBeVisible()
  expect(screen.getByRole('button', { name: '关闭' })).toBeVisible()
  expect(screen.queryByRole('button', { name: '复制' })).not.toBeInTheDocument()
  expect(document.querySelector('.translation-output')).toBeNull()
})

it('adds no top inset beyond the computed selection alignment offset', () => {
  const style = document.createElement('style')
  style.textContent = readFileSync(
    path.join(process.cwd(), 'src/renderer/editor/selection-translation.css'),
    'utf8',
  )
  const scroll = document.createElement('div')
  scroll.className = 'translation-sidebar-scroll'
  document.head.append(style)
  document.body.append(scroll)

  try {
    expect(getComputedStyle(scroll).paddingTop).toBe('0px')
  } finally {
    scroll.remove()
    style.remove()
  }
})

it('supports keyboard resizing with arrows and range endpoints', () => {
  const { callbacks } = renderSidebar(state('streaming', '部分结果'))
  const splitter = screen.getByRole('separator', { name: '调整右侧栏宽度' })

  fireEvent.keyDown(splitter, { key: 'ArrowLeft' })
  expect(splitter).toHaveAttribute('aria-valuenow', '540')
  fireEvent.keyDown(splitter, { key: 'ArrowRight' })
  expect(splitter).toHaveAttribute('aria-valuenow', '530')
  fireEvent.keyDown(splitter, { key: 'Home' })
  expect(splitter).toHaveAttribute('aria-valuenow', '240')
  fireEvent.keyDown(splitter, { key: 'End' })
  expect(splitter).toHaveAttribute('aria-valuenow', '1800')
  expect(callbacks.onWidthChange.mock.calls.map(([width]) => width))
    .toEqual([540, 530, 240, 1800])
})

it('uses the inherited application theme without a fixed red fallback', () => {
  const css = readFileSync(
    path.join(process.cwd(), 'src/renderer/editor/selection-translation.css'),
    'utf8',
  )
  expect(css).not.toContain('var(--theme-color-rgb, 198 40 40)')
  expect(css).toContain('var(--theme-color-rgb)')
})

it.each([
  ['streaming', null, null],
  ['completed', null, null],
  ['stopped', null, null],
  ['failed', '大模型请求超时', 'MODEL_TIMEOUT'],
] as const)('renders %s output through the shared structured Markdown surface', (
  status,
  error,
  errorCode,
) => {
  const markdown = '- first\n- second\n\n| Name | Value |\n| --- | --- |\n| One | 1 |'
  renderSidebar(state(status, markdown, error, errorCode))
  const output = document.querySelector<HTMLElement>('.translation-sidebar-content .translation-output')!

  expect(output.querySelectorAll('li')).toHaveLength(2)
  expect(output.querySelector('table')).not.toBeNull()
})

it('copies original Markdown from the sidebar instead of rendered DOM text', () => {
  const markdown = '**bold** and [link](https://example.com)'
  const { callbacks } = renderSidebar(state('completed', markdown))

  expect(screen.getByText('bold').tagName).toBe('STRONG')
  fireEvent.click(screen.getByRole('button', { name: '复制' }))
  expect(callbacks.onCopy).toHaveBeenCalledWith(markdown)
})
