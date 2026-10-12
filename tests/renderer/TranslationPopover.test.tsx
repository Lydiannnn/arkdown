import { fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { TranslationPopover } from '../../src/renderer/editor/TranslationPopover'
import type { TranslationUiState } from '../../src/renderer/editor/translation-ui-state'
import { installUiSelectionGuard } from '../../src/renderer/app/ui-selection-guard'

const anchorRect = {
  left: 120,
  top: 100,
  right: 180,
  bottom: 120,
  width: 60,
  height: 20,
}

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

const POPOVER_CSS = readFileSync(
  join(process.cwd(), 'src', 'renderer', 'editor', 'selection-translation.css'),
  'utf8',
)

function renderPopover(
  value: TranslationUiState,
  overrides: Partial<Parameters<typeof TranslationPopover>[0]> = {},
) {
  const callbacks = {
    onTranslate: vi.fn(),
    onStop: vi.fn(),
    onCopy: vi.fn(),
    onClose: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenHistory: vi.fn(),
    onRetry: vi.fn(),
  }
  const result = render(
    <TranslationPopover
      anchorRect={anchorRect}
      state={value}
      viewport={{ width: 800, height: 600 }}
      {...callbacks}
      {...overrides}
    />,
  )
  return { ...result, callbacks }
}

it.each(['starting', 'streaming', 'failed'] as const)(
  'keeps the history entry enabled with records while %s',
  (status) => {
    const { callbacks } = renderPopover(state(
      status,
      status === 'streaming' ? 'partial' : '',
      status === 'failed' ? 'failed' : null,
    ), { historyRecordId: 'record-current' })

    const button = screen.getByRole('button', { name: '翻译记录' })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(callbacks.onOpenHistory).toHaveBeenCalledWith('record-current', button)
  },
)

it.each(['completed', 'streaming'] as const)(
  'closes the popover when Arkdown receives a pointer press outside during %s',
  (status) => {
    const { callbacks } = renderPopover(state(status, 'translated output'))
    const popover = screen.getByRole('dialog', { name: '划词翻译' })

    fireEvent.pointerDown(popover)
    expect(callbacks.onClose).not.toHaveBeenCalled()

    fireEvent.pointerDown(document.body)
    expect(callbacks.onClose).toHaveBeenCalledOnce()
  },
)

it('does not render the history entry in the ready trigger', () => {
  renderPopover(state('ready'))
  expect(screen.queryByRole('button', { name: '翻译记录' })).not.toBeInTheDocument()
})

function sendFocusedSelectAll(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    key: 'a',
  })
  document.activeElement?.dispatchEvent(event)
  return event
}

it('shows only the shared 30px editor marker while ready', () => {
  const { callbacks } = renderPopover(state('ready'))

  const trigger = screen.getByRole('button', { name: '翻译选中的文本' })
  expect(trigger).toBeVisible()
  expect(trigger).toHaveClass('translation-popover-trigger')
  expect(screen.getByRole('dialog', { name: '划词翻译' })).toHaveClass('translation-popover--ready')
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(screen.queryByRole('button', { name: '翻译记录' })).not.toBeInTheDocument()
  expect(screen.queryByText('正在翻译…')).not.toBeInTheDocument()

  fireEvent.click(trigger)
  expect(callbacks.onTranslate).toHaveBeenCalledTimes(1)
})

it('shows a loading label and prevents duplicate ready submissions', () => {
  const { callbacks } = renderPopover(state('ready'))
  const translate = screen.getByRole('button', { name: '翻译选中的文本' })

  fireEvent.click(translate)
  fireEvent.click(translate)

  expect(callbacks.onTranslate).toHaveBeenCalledTimes(1)
  expect(translate).toBeDisabled()
})

it('positions the 30px ready trigger ten CSS pixels lower below the pointer release point', () => {
  const releaseRect = {
    left: 244,
    top: 166,
    right: 244,
    bottom: 166,
    width: 0,
    height: 0,
  }
  renderPopover(state('ready'), {
    anchorRect: releaseRect,
    popoverSize: { width: 30, height: 30 },
  })

  expect(screen.getByRole('dialog', { name: '划词翻译' })).toHaveStyle({
    left: '229px',
    top: '184px',
  })
  expect(screen.getByRole('dialog', { name: '划词翻译' })).toHaveAttribute('data-placement', 'below')
})

it('flips the ready trigger above a bottom-edge release point while retaining its ten-pixel offset', () => {
  const releaseRect = {
    left: 244,
    top: 590,
    right: 244,
    bottom: 590,
    width: 0,
    height: 0,
  }
  renderPopover(state('ready'), {
    anchorRect: releaseRect,
    popoverSize: { width: 30, height: 30 },
  })

  const popover = screen.getByRole('dialog', { name: '划词翻译' })
  expect(popover).toHaveStyle({ top: '562px' })
  expect(popover).toHaveAttribute('data-placement', 'above')
})

it('removes ready card chrome and reuses the marker interaction surface', () => {
  expect(POPOVER_CSS).toMatch(/\.translation-popover--ready\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*box-shadow:\s*none;/s)
  expect(POPOVER_CSS).toMatch(/\.translation-popover-trigger\s*\{[^}]*position:\s*static;/s)
  expect(POPOVER_CSS).toMatch(/\.translation-history-rail-button\.translation-popover-trigger\s*\{[^}]*opacity:\s*1;/s)
})

it('shows progress and the exact stop action while starting', () => {
  const { callbacks } = renderPopover(state('starting'))

  expect(screen.getByText('正在翻译…')).toHaveAttribute('aria-live', 'polite')
  fireEvent.click(screen.getByRole('button', { name: '停止' }))
  expect(callbacks.onStop).toHaveBeenCalledTimes(1)
  expect(screen.getAllByRole('button')).toHaveLength(2)
  expect(screen.getByRole('button', { name: '翻译记录' })).toBeDisabled()
})

it('renders accumulated streaming output in the supplied order as plain text', () => {
  const { callbacks, rerender } = renderPopover(state('streaming', '第一段'))
  const output = document.querySelector<HTMLElement>('.translation-output')!

  expect(output).toHaveClass('translation-output')
  expect(output).toHaveAttribute('aria-live', 'polite')
  expect(output).toHaveTextContent('第一段')
  fireEvent.click(screen.getByRole('button', { name: '停止' }))
  expect(callbacks.onStop).toHaveBeenCalledTimes(1)

  rerender(
    <TranslationPopover
      anchorRect={anchorRect}
      onClose={() => undefined}
      onCopy={() => undefined}
      onOpenSettings={() => undefined}
      onRetry={() => undefined}
      onStop={() => undefined}
      onTranslate={() => undefined}
      state={state('streaming', '第一段第二段')}
      viewport={{ width: 800, height: 600 }}
    />,
  )
  expect(output).toHaveTextContent('第一段第二段')
  expect(screen.queryByText('第二段第一段')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '停止' })).toBeVisible()
})

it('copies only completed result text and invokes close exactly once', () => {
  const { callbacks } = renderPopover(state('completed', '仅复制这段译文'))

  fireEvent.click(screen.getByRole('button', { name: '复制' }))
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))

  expect(callbacks.onCopy).toHaveBeenCalledTimes(1)
  expect(callbacks.onCopy).toHaveBeenCalledWith('仅复制这段译文')
  expect(callbacks.onClose).toHaveBeenCalledTimes(1)
})

it('focuses a completed translation region and routes Ctrl+A to that output only', () => {
  const { container } = render(
    <div className="app-shell">
      <TranslationPopover
        anchorRect={anchorRect}
        onClose={() => undefined}
        onCopy={() => undefined}
        onOpenSettings={() => undefined}
        onRetry={() => undefined}
        onStop={() => undefined}
        onTranslate={() => undefined}
        state={state('completed', '只选择这段译文')}
        viewport={{ width: 800, height: 600 }}
      />
    </div>,
  )
  const shell = container.querySelector<HTMLElement>('.app-shell')!
  const cleanup = installUiSelectionGuard(shell)
  const output = container.querySelector<HTMLElement>('.translation-output')!

  expect(output).toHaveAttribute('data-ui-selectable', 'true')
  expect(output).toHaveAttribute('tabindex', '0')
  output.focus()
  const event = sendFocusedSelectAll()

  expect(document.activeElement).toBe(output)
  expect(event.defaultPrevented).toBe(true)
  expect(window.getSelection()?.toString()).toBe('只选择这段译文')

  cleanup()
})

it('focuses a translation error and routes Ctrl+A to that error only', () => {
  const { container } = render(
    <div className="app-shell">
      <TranslationPopover
        anchorRect={anchorRect}
        onClose={() => undefined}
        onCopy={() => undefined}
        onOpenSettings={() => undefined}
        onRetry={() => undefined}
        onStop={() => undefined}
        onTranslate={() => undefined}
        state={state('failed', '', '只选择这条错误')}
        viewport={{ width: 800, height: 600 }}
      />
    </div>,
  )
  const shell = container.querySelector<HTMLElement>('.app-shell')!
  const cleanup = installUiSelectionGuard(shell)
  const error = screen.getByRole('alert')

  expect(error).toHaveAttribute('tabindex', '0')
  error.focus()
  const event = sendFocusedSelectAll()

  expect(document.activeElement).toBe(error)
  expect(event.defaultPrevented).toBe(true)
  expect(window.getSelection()?.toString()).toBe('只选择这条错误')

  cleanup()
})

it('retains stopped output and offers copy only when output is nonempty', () => {
  const { callbacks, rerender } = renderPopover(state('stopped', '部分译文'))

  expect(screen.getByText('已停止')).toBeVisible()
  expect(screen.getByText('部分译文')).toBeVisible()
  expect(screen.getByRole('button', { name: '复制' })).toBeVisible()
  expect(screen.getByRole('button', { name: '关闭' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '复制' }))
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  expect(callbacks.onCopy).toHaveBeenCalledTimes(1)
  expect(callbacks.onCopy).toHaveBeenCalledWith('部分译文')
  expect(callbacks.onClose).toHaveBeenCalledTimes(1)


  rerender(
    <TranslationPopover
      anchorRect={anchorRect}
      onClose={() => undefined}
      onCopy={() => undefined}
      onOpenSettings={() => undefined}
      onRetry={() => undefined}
      onStop={() => undefined}
      onTranslate={() => undefined}
      state={state('stopped')}
      viewport={{ width: 800, height: 600 }}
    />,
  )
  expect(screen.queryByRole('button', { name: '复制' })).not.toBeInTheDocument()
})

it('shows only the supplied public failure and exact retry and close actions', () => {
  const { callbacks } = renderPopover(
    state('failed', '已保留的部分译文', '连接暂时不可用，请重试。'),
  )

  expect(screen.getByRole('alert')).toHaveTextContent('连接暂时不可用，请重试。')
  expect(screen.getByRole('alert')).toHaveAttribute('data-ui-selectable', 'true')
  expect(screen.getByText('已保留的部分译文')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  expect(callbacks.onRetry).toHaveBeenCalledTimes(1)
  expect(callbacks.onClose).toHaveBeenCalledTimes(1)
})

it('shows the unconfigured-model guidance and routes settings or dismissal actions', () => {
  const { callbacks } = renderPopover(state(
    'failed',
    '',
    '尚未配置划词翻译使用的大模型',
    'MODEL_NOT_CONFIGURED',
  ))

  const alert = screen.getByRole('alert')
  expect(screen.getByRole('heading', { name: '尚未配置大模型' })).toBeVisible()
  expect(alert).toHaveAttribute('data-ui-selectable', 'true')
  expect(alert).toHaveAttribute('tabindex', '0')
  expect(alert).toHaveTextContent('请先配置大模型，再使用此功能。')
  expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '翻译记录' })).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: '前往配置' }))
  fireEvent.click(screen.getByRole('button', { name: '暂不' }))

  expect(callbacks.onOpenSettings).toHaveBeenCalledTimes(1)
  expect(callbacks.onClose).toHaveBeenCalledTimes(1)
})

it('keeps MODEL_TIMEOUT on the ordinary retry presentation', () => {
  renderPopover(state(
    'failed',
    '',
    '大模型请求超时',
    'MODEL_TIMEOUT',
  ))

  expect(screen.getByRole('alert')).toHaveTextContent('大模型请求超时')
  expect(screen.getByRole('button', { name: '重试' })).toBeVisible()
  expect(screen.queryByRole('button', { name: '配置模型' })).not.toBeInTheDocument()
})

it('shows 部分结果超时 with retained output, copy, and close but no retry', () => {
  const { callbacks } = renderPopover(state(
    'failed',
    '部分译文',
    '大模型请求超时',
    'MODEL_TIMEOUT',
  ))

  expect(screen.getByRole('alert')).toHaveTextContent('翻译内容过多，请分批次翻译')
  expect(screen.getByText('部分译文')).toBeVisible()
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
  renderPopover(state(
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

it('uses compact popover controls with opacity-only motion and a reduced-motion override', () => {
  expect(POPOVER_CSS).toMatch(/\.translation-popover\s*\{[\s\S]*?transition:\s*opacity 120ms[^;]*;/)
  expect(POPOVER_CSS).toMatch(/\.translation-actions button,[\s\S]*?\.translation-primary-action\s*\{[\s\S]*?(?:height|min-height):\s*32px;/)
  expect(POPOVER_CSS).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.translation-popover\s*\{[\s\S]*?transition:\s*none;/)
})

it('computes themed primary and neutral secondary action styles through every control state', () => {
  const stylesheet = document.createElement('style')
  stylesheet.textContent = (POPOVER_CSS + readFileSync(join(process.cwd(), 'src/renderer/editor/model-configuration-notice.css'), 'utf8'))
    .replaceAll('rgb(var(--theme-color-rgb) / 88%)', 'rgba(37, 99, 235, 0.88)')
    .replaceAll('rgb(var(--theme-color-rgb) / 76%)', 'rgba(37, 99, 235, 0.76)')
    .replaceAll('rgb(var(--theme-color-rgb) / 45%)', 'rgba(37, 99, 235, 0.45)')
    .replaceAll('rgb(var(--theme-color-rgb))', 'rgb(37, 99, 235)')
    .replaceAll('var(--control-hover-layer)', 'rgb(244, 244, 244)')
    .replaceAll('var(--control-pressed-layer)', 'rgb(226, 226, 226)')
    .replaceAll('var(--control-disabled-opacity)', '0.4')
    // jsdom has no interactive CSS state; equivalent-specificity attributes exercise the real cascade.
    .replaceAll(':hover', '[data-test-state~="hover"]')
    .replaceAll(':active', '[data-test-state~="active"]')
    .replaceAll(':focus-visible', '[data-test-state~="focus-visible"]')
  document.head.append(stylesheet)
  try {
    renderPopover(state(
      'failed',
      '',
      '尚未配置划词翻译使用的大模型',
      'MODEL_NOT_CONFIGURED',
    ))

    const primary = screen.getByRole('button', { name: '前往配置' }) as HTMLButtonElement
    const secondary = screen.getByRole('button', { name: '暂不' }) as HTMLButtonElement

    for (const control of [primary, secondary]) {
      const style = getComputedStyle(control)
      expect(style.height).toBe('32px')
      expect(style.borderRadius).toBe('8px')
      expect(style.fontSize).toBe(control === primary ? '13px' : '12px')
    }

    expect(getComputedStyle(primary).backgroundColor).toBe('rgb(37, 99, 235)')
    expect(getComputedStyle(primary).borderColor).toBe('rgb(37, 99, 235)')
    expect(getComputedStyle(primary).color).toBe('rgb(255, 255, 255)')
    expect(getComputedStyle(secondary).backgroundColor).toBe('rgb(255, 255, 255)')
    expect(getComputedStyle(secondary).borderColor).toBe('rgb(201, 201, 201)')
    expect(getComputedStyle(secondary).color).toBe('rgb(68, 68, 68)')

    primary.dataset.testState = 'hover'
    secondary.dataset.testState = 'hover'
    expect(getComputedStyle(primary).backgroundColor).toBe('rgba(37, 99, 235, 0.88)')
    expect(getComputedStyle(secondary).backgroundColor).toBe('rgb(244, 244, 244)')

    primary.dataset.testState = 'active'
    secondary.dataset.testState = 'active'
    expect(getComputedStyle(primary).backgroundColor).toBe('rgba(37, 99, 235, 0.76)')
    expect(getComputedStyle(secondary).backgroundColor).toBe('rgb(226, 226, 226)')

    primary.dataset.testState = 'focus-visible'
    secondary.dataset.testState = 'focus-visible'
    expect(getComputedStyle(primary).backgroundColor).toBe('rgba(37, 99, 235, 0.88)')
    expect(getComputedStyle(primary).borderColor).toBe('rgb(37, 99, 235)')
    expect(getComputedStyle(secondary).backgroundColor).toBe('rgb(244, 244, 244)')
    expect(getComputedStyle(secondary).borderColor).toBe('rgba(37, 99, 235, 0.45)')

    delete primary.dataset.testState
    delete secondary.dataset.testState
    primary.disabled = true
    secondary.disabled = true
    expect(getComputedStyle(primary).backgroundColor).toBe('rgb(37, 99, 235)')
    expect(getComputedStyle(primary).borderColor).toBe('rgb(37, 99, 235)')
    expect(getComputedStyle(primary).opacity).toBe('0.4')
    expect(getComputedStyle(secondary).backgroundColor).toBe('rgb(255, 255, 255)')
    expect(getComputedStyle(secondary).borderColor).toBe('rgb(201, 201, 201)')
    expect(getComputedStyle(secondary).opacity).toBe('0.4')
  } finally {
    stylesheet.remove()
  }
})

it('keeps secondary-action pointer hover neutral while reserving theme treatment for focus', () => {
  const declarationsFor = (selector: string) => POPOVER_CSS
    .split('}')
    .map((rule) => rule.split('{'))
    .find(([selectors]) => selectors
      ?.split(',')
      .some((candidate) => candidate.trim() === selector))?.[1]
  const secondaryHoverRules = declarationsFor(
    '.translation-actions button:not(:disabled):hover',
  )
  const secondaryFocusRules = declarationsFor(
    '.translation-actions button:not(:disabled):focus-visible',
  )

  expect(secondaryHoverRules).toContain('background: var(--control-hover-layer);')
  expect(secondaryHoverRules).not.toMatch(/(?:border|outline)(?:-color)?\s*:/)
  expect(secondaryHoverRules).not.toContain('--theme-color-rgb')
  expect(secondaryFocusRules).toContain('border-color: rgb(var(--theme-color-rgb) / 45%);')
})

it('flips below when space above is insufficient and clamps inside the viewport', () => {
  renderPopover(state('completed', '结果'), {
    anchorRect: {
      left: 280,
      top: 4,
      right: 300,
      bottom: 24,
      width: 20,
      height: 20,
    },
    popoverSize: { width: 120, height: 80 },
    viewport: { width: 300, height: 100 },
  })

  const popover = screen.getByRole('dialog', { name: '划词翻译' })
  expect(popover).toHaveAttribute('data-placement', 'below')
  expect(popover).toHaveStyle({ left: '172px', top: '12px' })
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
  const markdown = '- first\n- second\n\n```ts\nconst value = 1\n```'
  renderPopover(state(status, markdown, error, errorCode))
  const output = document.querySelector<HTMLElement>('.translation-popover .translation-output')!

  expect(output.querySelectorAll('li')).toHaveLength(2)
  expect(output.querySelector('pre > code')).toHaveTextContent('const value = 1')
})

it('copies the original Markdown instead of rendered DOM text', () => {
  const markdown = '**bold** and [link](https://example.com)'
  const { callbacks } = renderPopover(state('completed', markdown))

  expect(screen.getByText('bold').tagName).toBe('STRONG')
  fireEvent.click(screen.getByRole('button', { name: '复制' }))
  expect(callbacks.onCopy).toHaveBeenCalledWith(markdown)
})

it('never interprets returned HTML or changes editor content and selection', () => {
  const editor = document.createElement('div')
  editor.className = 'editor-surface'
  editor.textContent = '原文保持不变'
  document.body.append(editor)
  const sourceNode = editor.firstChild!
  const selection = window.getSelection()!
  const range = document.createRange()
  range.selectNodeContents(sourceNode)
  selection.removeAllRanges()
  selection.addRange(range)

  renderPopover(state('completed', '<img src=x onerror="alert(1)">'))

  expect(screen.queryByText('<img src=x onerror="alert(1)">')).not.toBeInTheDocument()
  expect(document.querySelector('.translation-popover img')).toBeNull()
  expect(editor).toHaveTextContent('原文保持不变')
  expect(selection.toString()).toBe('原文保持不变')

  selection.removeAllRanges()
  editor.remove()
})
