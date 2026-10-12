import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { AiConversationSidebar } from '../../src/renderer/editor/AiConversationSidebar'
import { createAiProcessRecord, beginAiProcessRound, applyAiProcessEvent, finishAiProcess } from '../../src/renderer/editor/ai-process-buffer'
import { ContextMenuProvider } from '../../src/renderer/context-menu/ContextMenuProvider'
import { AI_CONVERSATION_MESSAGE_MAX_CHARS } from '../../src/shared/ai-conversation'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { addAiSelectionQuote, composeAiMessage, createAiComposerDraft } from '../../src/renderer/editor/ai-composer-draft'
import type { AiBudgetPausedEvent } from '../../src/shared/ai-budget-result'

function props(overrides: Partial<Parameters<typeof AiConversationSidebar>[0]> = {}) {
  return {
    configurationState: 'configured' as const,
    capabilities: { currentDocument: false, workspace: false },
    writePolicy: 'ask-every-time' as const,
    pendingAuthorization: null,
    authorizationRecords: [],
    auditRecords: [],
    error: null,
    messages: [],
    activeAssistantMessageId: null,
    status: 'idle' as const,
    onClear: vi.fn(),
    onClose: vi.fn(),
    onOpenSettings: vi.fn(),
    onRetryConfiguration: vi.fn(),
    onSend: vi.fn(async () => true),
    onStop: vi.fn(),
    onCurrentDocumentAccessChange: vi.fn(),
    onWorkspaceAccessChange: vi.fn(),
    onWritePolicyChange: vi.fn(),
    onAuthorizationDecision: vi.fn(),
    ...overrides,
  }
}

it('renders a paused segment and offers continuation only for the current main receipt', async () => {
  const record: AiBudgetPausedEvent = { requestId: '550e8400-e29b-41d4-a716-000000000001', type: 'budget-paused',
    transcriptRevision: 2, continuationId: '550e8400-e29b-41d4-a716-000000000002', reason: 'tool-rounds',
    counts: { readAdmitted: 64, writeAdmitted: 0, rejectedNewCalls: 1, toolRounds: 80 },
    outcomes: { readSucceeded: 64, readFailed: 0, readDenied: 0, readUnavailable: 0,
      writeSucceeded: 0, writeFailed: 0, writeDenied: 0, writeUnavailable: 0, writeUnknown: 0, notExecuted: 1 },
    finalization: { status: 'tools-returned' } }
  const value = props({ timeline: [{ kind: 'incomplete-message', outcome: 'paused',
    message: { id: 'partial', role: 'assistant', content: 'Keep my partial analysis' } }, { kind: 'budget-pause', record }],
    continueRequestId: record.requestId, onContinueAnalysis: vi.fn(async () => false) })
  const view = render(<AiConversationSidebar {...value} />)
  expect(screen.getByText('回复未完成 · 达到本段额度')).toBeInTheDocument()
  expect(screen.getByText('Keep my partial analysis')).toBeInTheDocument()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '继续分析' })) })
  expect(value.onContinueAnalysis).toHaveBeenCalledExactlyOnceWith(record.requestId)
  view.rerender(<AiConversationSidebar {...value} modelSwitchPending />)
  expect(screen.getByRole('button', { name: '继续分析' })).toBeDisabled()
  view.rerender(<AiConversationSidebar {...value} continueRequestId={null} />)
  expect(screen.queryByRole('button', { name: '继续分析' })).not.toBeInTheDocument()
  expect(screen.getByLabelText('分析暂停记录')).toBeInTheDocument()
})

it('renders one process group without duplicate timing rows and follows its capped inner region through the existing scroll owner', () => {
  const requestId = '550e8400-e29b-41d4-a716-000000000001', messageId = '550e8400-e29b-41d4-a716-000000000002'
  const record = createAiProcessRecord(requestId, performance.now())
  beginAiProcessRound(record, messageId, performance.now())
  const delta = { type: 'process-text' as const, requestId, messageId, round: 1, sequence: 1,
    itemId: messageId, segmentIndex: 0, kind: 'reasoning-summary' as const, delta: 'first visible summary', delivery: 'stream' as const }
  applyAiProcessEvent(record, delta, performance.now())
  const elapsed = { kind: 'elapsed' as const, requestId, messageIds: [messageId], elapsedMs: 0, active: true, observedAt: performance.now() }
  const thinking = { kind: 'thinking' as const, messageId, elapsedMs: 1200, active: false, observedAt: performance.now() }
  const timeline = [elapsed, { kind: 'process' as const, record }, thinking, { kind: 'message' as const, messageId }]
  const value = props({ status: 'streaming', messages: [{ id: messageId, role: 'assistant', content: 'Final answer separate' }], timeline })
  const mounted = render(<AiConversationSidebar {...value} />)
  const list = screen.getByRole('log', { name: 'AI 对话消息' })
  const inner = screen.getByRole('region', { name: '过程内容' })
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 900 })
  Object.defineProperty(inner, 'scrollHeight', { configurable: true, value: 600 })
  const composer = screen.getByRole('textbox', { name: '发送消息给 AI' }); composer.focus()
  list.scrollTop = 50; inner.scrollTop = 30
  applyAiProcessEvent(record, { ...delta, sequence: 2, delta: ' next' }, performance.now())
  mounted.rerender(<AiConversationSidebar {...value} timeline={[...timeline]} />)
  expect(list.scrollTop).toBe(900)
  expect(inner.scrollTop).toBe(600)
  expect(composer).toHaveFocus()
  expect(screen.getAllByText(/思考用时/)).toHaveLength(1)
  expect(screen.getAllByText(/用时 ·/)).toHaveLength(1)
  expect(screen.getByText('Final answer separate').closest('article')).not.toContainElement(inner)
  record.userExpanded = true
  finishAiProcess(record, 'completed', performance.now())
  list.scrollTop = 70; inner.scrollTop = 40; fireEvent.scroll(list)
  mounted.rerender(<AiConversationSidebar {...value} status="idle" timeline={[...timeline]} />)
  expect(list.scrollTop).toBe(70)
  expect(inner.scrollTop).toBe(40)
  mounted.unmount()
})

it('follows late layout inside a capped process panel through its existing observer after the panel appears', () => {
  const observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element>; disconnect: ReturnType<typeof vi.fn> }> = []
  const frames = new Map<number, FrameRequestCallback>(); let serial = 0
  vi.stubGlobal('ResizeObserver', class {
    targets = new Set<Element>()
    disconnect = vi.fn()
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    constructor(readonly callback: ResizeObserverCallback) { observers.push(this) }
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++serial, callback); return serial })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const value = props({ status: 'streaming' })
  const mounted = render(<AiConversationSidebar {...value} />)
  try {
    const record = createAiProcessRecord('550e8400-e29b-41d4-a716-000000000001', performance.now())
    beginAiProcessRound(record, '550e8400-e29b-41d4-a716-000000000002', performance.now())
    applyAiProcessEvent(record, { type: 'process-text', requestId: record.requestId, messageId: record.messageId!,
      round: 1, sequence: 1, kind: 'reasoning-summary', itemId: record.messageId!, segmentIndex: 0,
      delta: 'Readable content with deferred font layout', delivery: 'stream' }, performance.now())
    mounted.rerender(<AiConversationSidebar {...value} timeline={[{ kind: 'process', record }]} />)
    const list = screen.getByRole('log', { name: 'AI 对话消息' })
    const inner = screen.getByRole('region', { name: '过程内容' })
    const body = inner.firstElementChild!
    const observer = observers.at(-1)!
    expect(body).not.toBeNull()
    expect(observer.targets.has(body)).toBe(true)
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 900 })
    Object.defineProperty(inner, 'scrollHeight', { configurable: true, value: 1200 })
    list.scrollTop = 100; inner.scrollTop = 200
    const composer = screen.getByRole('textbox', { name: '发送消息给 AI' }); composer.focus()
    act(() => observer.callback([{ target: body } as ResizeObserverEntry], observer as unknown as ResizeObserver))
    expect(frames.size).toBe(1)
    act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(16)) })
    expect(inner.scrollTop).toBe(1200)
    expect(list.scrollTop).toBe(900)
    expect(composer).toHaveFocus()
    mounted.rerender(<AiConversationSidebar {...value} status="idle" timeline={[{ kind: 'process', record }]} />)
    expect(observer.disconnect).toHaveBeenCalledOnce()
    act(() => observer.callback([{ target: body } as ResizeObserverEntry], observer as unknown as ResizeObserver))
    expect(frames.size).toBe(0)
  } finally { mounted.unmount(); vi.unstubAllGlobals() }
})

describe('AiConversationSidebar', () => {
  it('reserves a trailing shared check icon for the selected write policy without changing labels or selection', () => {
    const value = props()
    render(<AiConversationSidebar {...value} />)
    fireEvent.click(screen.getByRole('button', { name: '写入策略：每次询问' }))
    const options = screen.getAllByRole('menuitemradio')
    for (const option of options) {
      const status = option.querySelector('.ai-composer-menu-check')
      expect(status).toBe(option.lastElementChild)
      expect(status).toHaveAttribute('aria-hidden', 'true')
      expect(status?.querySelector('svg')).toBe(option.getAttribute('aria-checked') === 'true'
        ? option.querySelector('.app-icon') : null)
    }
    expect(options[0].querySelector('svg')).toHaveAttribute('width', '16')
    fireEvent.click(options[1])
    expect(value.onWritePolicyChange).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('uses standard tips for inline and reference link titles without changing message content', () => {
    const content = '[Inline](https://example.com "Inline title")\n\n[Reference][ref]\n\n[ref]: https://example.org "Reference title"'
    const message = { id: 'tip-message', role: 'assistant' as const, content }
    render(<AiConversationSidebar {...props({ messages: [message] })} />)
    for (const label of ['Inline', 'Reference']) {
      const link = screen.getByRole('link', { name: label })
      expect(link).toHaveAttribute('data-tooltip', `${label} title`)
      expect(link).not.toHaveAttribute('title')
    }
    expect(message.content).toBe(content)
  })

  it('shows legal off-mode Claude effort, retains the preferred grade through toggling, and has no model/input tips', () => {
    const onThinkingChange = vi.fn()
    const value = props({ modelConnections: [{ id: 'claude', name: 'Claude' }], selectedModelId: 'claude',
      onModelChange: vi.fn(), onThinkingChange,
      thinkingConnection: { provider: 'other', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', modelId: 'claude-opus-5' },
      thinkingPreference: { thinkingMode: 'disabled', reasoningEffort: 'max' } })
    render(<AiConversationSidebar {...value} />)
    expect(screen.getByRole('combobox', { name: 'AI 对话思考' })).toHaveTextContent('关')
    fireEvent.click(screen.getByRole('combobox', { name: 'AI 对话推理强度' }))
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['默认', '低', '中', '高'])
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    fireEvent.click(screen.getByRole('combobox', { name: 'AI 对话思考' }))
    expect(screen.getByRole('option', { name: '关' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('option', { name: '开' }))
    expect(onThinkingChange).toHaveBeenCalledWith({ thinkingMode: 'enabled' })
    expect(screen.getByRole('combobox', { name: 'AI 对话快速模型选择' }).closest('[data-tooltip], [title]')).toBeNull()
    expect(screen.getByRole('textbox').closest('[data-tooltip], [title]')).toBeNull()
    expect(screen.getByRole('button', { name: '让 AI 查看文档' })).toHaveTextContent('AI')
    expect(screen.getByRole('button', { name: '让 AI 查看工作区' })).toHaveTextContent('AI')
  })

  it('blocks Enter while a model or thinking preference is being saved', () => {
    const value = props({ modelSwitchPending: true })
    render(<AiConversationSidebar {...value} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'wait' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(value.onSend).not.toHaveBeenCalled()
  })
  it('retains the submitted draft until async acceptance and preserves edits made while waiting', async () => {
    let accept!: (accepted: boolean) => void
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { accept = resolve }))
    render(<AiConversationSidebar {...props({ onSend })} />)
    const input = screen.getByRole('textbox', { name: '发送消息给 AI' })
    fireEvent.change(input, { target: { value: 'first question' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('first question')
    fireEvent.change(input, { target: { value: 'next question' } })
    await act(async () => accept(true))
    await vi.waitFor(() => expect(input).toHaveValue('next question'))
  })

  it('does not submit or stop on Enter during generation', () => {
    const input = props({ status: 'streaming' })
    render(<AiConversationSidebar {...input} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'next question' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(input.onSend).not.toHaveBeenCalled()
    expect(input.onStop).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '停止生成' }))
    expect(input.onStop).toHaveBeenCalledOnce()
  })

  it('retains quotes and draft across unmount/settings, rejection, then clears them on acceptance', async () => {
    const draft = createAiComposerDraft()
    addAiSelectionQuote(draft, { sourceId: 'A', documentName: 'A.md', revision: 1,
      range: { mode: 'source', from: 0, to: 3 }, content: 'quoted', plainText: 'quoted' })
    const first = render(<AiConversationSidebar {...props({ draft })} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'my question' } })
    first.unmount()
    const onSend = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const second = render(<AiConversationSidebar {...props({ draft, onSend, configurationState: 'unconfigured' })} />)
    expect(screen.getByRole('status')).toHaveTextContent('尚未配置大模型')
    second.rerender(<AiConversationSidebar {...props({ draft, onSend })} />)
    expect(screen.getByRole('textbox')).toHaveValue('my question')
    expect(screen.getByRole('button', { name: '移除引用：A.md · 片段 1' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(screen.getByRole('textbox')).toHaveValue('my question')
    expect(draft.quotes).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(draft.quotes).toHaveLength(0)
    expect(onSend.mock.calls[0]).toEqual(onSend.mock.calls[1])
  })

  it('updates a remounted composer when an earlier submission is accepted during settings return', async () => {
    const draft = createAiComposerDraft()
    let accept!: (value: boolean) => void
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { accept = resolve }))
    const first = render(<AiConversationSidebar {...props({ draft, onSend })} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'submitted' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    first.unmount()
    render(<AiConversationSidebar {...props({ draft })} />)
    expect(screen.getByRole('textbox')).toHaveValue('submitted')
    await act(async () => accept(true))
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('counts the complete quote envelope at the 48,000 character boundary without truncation', async () => {
    const draft = createAiComposerDraft()
    addAiSelectionQuote(draft, { sourceId: 'A', documentName: 'A.md', revision: 1,
      range: { mode: 'source', from: 0, to: 3 }, content: 'quoted', plainText: 'quoted' })
    const contentLength = composeAiMessage('q', draft.quotes).length
    const exact = 'q'.repeat(AI_CONVERSATION_MESSAGE_MAX_CHARS - contentLength + 1)
    const onSend = vi.fn(async (_content: string) => true)
    render(<AiConversationSidebar {...props({ draft, onSend })} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: exact + 'x' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('请缩小引用')
    expect(draft.quotes[0]?.content).toBe('quoted')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: exact } })
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(onSend.mock.calls[0]![0]).toHaveLength(AI_CONVERSATION_MESSAGE_MAX_CHARS)
  })
  it('shows the accepted unconfigured guidance and opens model settings', async () => {
    function Harness() {
      const [settingsOpen, setSettingsOpen] = useState(false)
      return settingsOpen ? <h1>管理大模型</h1> : <AiConversationSidebar {...props({
        configurationState: 'unconfigured', onOpenSettings: () => setSettingsOpen(true),
      })} />
    }
    render(<Harness />)
    expect(screen.getByRole('status')).toHaveTextContent('尚未配置大模型')
    expect(screen.getByRole('status')).toHaveTextContent('请先配置大模型，再使用此功能。')
    await userEvent.click(screen.getByRole('button', { name: '前往配置' }))
    expect(screen.getByRole('heading', { name: '管理大模型' })).toBeVisible()
  })

  it('dismisses the unconfigured notice through its parent close callback', async () => {
    const input = props({ configurationState: 'unconfigured' })
    render(<AiConversationSidebar {...input} />)
    await userEvent.click(screen.getByRole('button', { name: '暂不' }))
    expect(input.onClose).toHaveBeenCalledOnce()
    expect(input.onOpenSettings).not.toHaveBeenCalled()
  })

  it.each(['outside', 'blur', 'Escape'])('dismisses the current write-policy popup on %s', async (method) => {
    const user = userEvent.setup()
    render(<AiConversationSidebar {...props({ writePolicy: 'document-grant' })} />)
    const trigger = screen.getByRole('button', { name: '写入策略：按文档许可' })
    await user.click(trigger)
    expect(screen.getByRole('menu')).toBeVisible()
    if (method === 'outside') await user.click(screen.getByRole('log'))
    else if (method === 'blur') fireEvent.blur(trigger, { relatedTarget: screen.getByRole('textbox') })
    else await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    if (method === 'Escape') expect(trigger).toHaveFocus()
  })


  it('replaces the disclaimer with an optional right-aligned context usage value', () => {
    const style = document.createElement('style')
    style.textContent = readFileSync(
      path.join(process.cwd(), 'src/renderer/editor/ai-conversation-sidebar.css'),
      'utf8',
    )
    document.head.append(style)
    try {
      const { rerender } = render(<AiConversationSidebar {...props({
        contextUsage: { usedTokens: 23_410, contextWindowTokens: 128_000 },
      })} />)

      const usage = screen.getByText('18% · 23,410 / 128,000')
      expect(usage).toHaveClass('ai-conversation-context-usage')
      expect(getComputedStyle(usage).textAlign).toBe('right')
      expect(screen.queryByText('AI 可能出错，请核对重要信息。')).not.toBeInTheDocument()

      rerender(<AiConversationSidebar {...props({ contextUsage: null })} />)
      expect(screen.queryByText(/\d+% ·/u)).not.toBeInTheDocument()
      expect(screen.getByLabelText('上下文占用')).toHaveTextContent('等待用量信息')
    } finally {
      style.remove()
    }
  })

  it('shows available token usage without inventing unknown capacity and marks estimates', () => {
    const { rerender } = render(<AiConversationSidebar {...props({
      contextUsage: { usedTokens: 23_410, contextWindowTokens: null, estimated: false },
    })} />)
    expect(screen.getByLabelText('上下文占用')).toHaveTextContent('23,410 tokens · 容量未知')
    expect(screen.getByLabelText('上下文占用')).not.toHaveTextContent('%')
    rerender(<AiConversationSidebar {...props({
      contextUsage: { usedTokens: 23_410, contextWindowTokens: 128_000, estimated: true },
    })} />)
    expect(screen.getByLabelText('上下文占用')).toHaveTextContent('约 18% · 23,410 / 128,000')
  })

  it('offers Copy only for a selection contained by the message area', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(
      <ContextMenuProvider>
        <AiConversationSidebar {...props({
          messages: [{ id: 'u', role: 'user', content: 'select this text' }],
        })} />
      </ContextMenuProvider>,
    )
    const message = screen.getByRole('article', { name: '你的消息' })
    const text = message.querySelector('p')!.firstChild!
    const range = document.createRange()
    range.selectNodeContents(text)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    range.setStart(text, 0)
    range.setEnd(text, 'select this text'.length)
    selection.addRange(range)

    fireEvent.contextMenu(message, { clientX: 30, clientY: 40 })
    await user.click(screen.getByRole('menuitem', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('select this text')

    selection.removeAllRanges()
    fireEvent.contextMenu(message, { clientX: 30, clientY: 40 })
    expect(screen.queryByRole('menuitem', { name: '复制' })).not.toBeInTheDocument()
  })

  it('opens and copies both web links and local paths through the dedicated link handler', async () => {
    const user = userEvent.setup()
    const onOpenLink = vi.fn()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(
      <ContextMenuProvider>
        <AiConversationSidebar {...props({
          messages: [{
            id: 'a',
            role: 'assistant',
            content: [
              '[官网](https://example.com/guide)',
              '',
              'C:\\Work Space\\notes.md',
              '',
              '[本地](file:///C:/Work/report.md)',
              '',
              '[同路径伪装](file:///C:/Work%20Space/notes.md)',
              '',
              '[文档](<C:/Work Space/report%20.md>)',
              '',
              'C:\\Work\\run.ps1',
              '',
              '[脚本](javascript:alert(1))',
              '',
              '[数据](data:text/plain,secret)',
            ].join('\n'),
          }],
          onOpenLink,
        })} />
      </ContextMenuProvider>,
    )

    const web = screen.getByRole('link', { name: '官网' })
    const plainLocal = screen.getByRole('link', { name: 'C:\\Work Space\\notes.md' })
    const markdownLocal = screen.getByRole('link', { name: '文档' })
    const copyOnlyPath = screen.getByRole('link', { name: 'C:\\Work\\run.ps1' })
    expect(plainLocal).toHaveAttribute('href', 'file:///C:/Work%20Space/notes.md')
    expect(plainLocal).toHaveAttribute('data-ai-message-copy-target', 'C:\\Work Space\\notes.md')
    expect(markdownLocal).toHaveAttribute('href', 'file:///C:/Work%20Space/report%2520.md')
    expect(markdownLocal).toHaveAttribute('data-ai-message-copy-target', 'C:\\Work Space\\report%20.md')
    expect(copyOnlyPath).toHaveAttribute('href', 'file:///C:/Work/run.ps1')
    expect(copyOnlyPath).toHaveAttribute('data-ai-message-copy-target', 'C:\\Work\\run.ps1')
    expect(screen.queryByRole('link', { name: '脚本' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '数据' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '本地' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '同路径伪装' })).not.toBeInTheDocument()
    await user.click(screen.getByText('本地'))
    await user.click(screen.getByText('同路径伪装'))
    expect(onOpenLink).not.toHaveBeenCalled()

    await user.click(web)
    await user.click(plainLocal)
    await user.click(markdownLocal)
    expect(onOpenLink).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: 'web',
      target: 'https://example.com/guide',
    }))
    expect(onOpenLink).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: 'local', target: 'C:\\Work Space\\notes.md',
    }))
    expect(onOpenLink).toHaveBeenNthCalledWith(3, expect.objectContaining({
      kind: 'local', target: 'C:\\Work Space\\report%20.md',
    }))
    expect(onOpenLink).toHaveBeenCalledTimes(3)

    fireEvent.contextMenu(web, { clientX: 25, clientY: 30 })
    await user.click(screen.getByRole('menuitem', { name: '复制链接' }))
    expect(writeText).toHaveBeenLastCalledWith('https://example.com/guide')
    fireEvent.contextMenu(screen.getByRole('link', { name: 'C:\\Work Space\\notes.md' }), { clientX: 25, clientY: 30 })
    await user.click(screen.getByRole('menuitem', { name: '复制路径' }))
    expect(writeText).toHaveBeenLastCalledWith('C:\\Work Space\\notes.md')
    fireEvent.contextMenu(screen.getByRole('link', { name: '文档' }), { clientX: 25, clientY: 30 })
    await user.click(screen.getByRole('menuitem', { name: '复制路径' }))
    expect(writeText).toHaveBeenLastCalledWith('C:\\Work Space\\report%20.md')
  })

  it('opens and copies a local path outside the document extension set as reveal-only', async () => {
    const user = userEvent.setup()
    const onOpenLink = vi.fn()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(
      <ContextMenuProvider>
        <AiConversationSidebar {...props({
          messages: [{ id: 'a', role: 'assistant', content: 'C:\\Work\\run.ps1' }],
          onOpenLink,
        })} />
      </ContextMenuProvider>,
    )

    const path = screen.getByRole('link', { name: 'C:\\Work\\run.ps1' })
    await user.click(path)
    fireEvent.contextMenu(path, { clientX: 25, clientY: 30 })
    await user.click(screen.getByRole('menuitem', { name: '复制路径' }))

    expect(writeText).toHaveBeenCalledWith('C:\\Work\\run.ps1')
    expect(onOpenLink).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'local', target: 'C:\\Work\\run.ps1', revealOnly: true,
    }))
  })

  it('presents document and workspace permissions as independent authorization toggles', async () => {
    const user = userEvent.setup()
    const initial = props()
    const { rerender } = render(<AiConversationSidebar {...initial} />)
    const allow = screen.getByRole('button', { name: '让 AI 查看文档' })
    const allowWorkspace = screen.getByRole('button', { name: '让 AI 查看工作区' })
    expect(allow).toHaveAttribute('aria-pressed', 'false')
    expect(allowWorkspace).toHaveAttribute('aria-pressed', 'false')

    await user.click(allow)
    await user.click(allowWorkspace)
    expect(initial.onCurrentDocumentAccessChange).toHaveBeenCalledWith(true)
    expect(initial.onWorkspaceAccessChange).toHaveBeenCalledWith(true)

    const allowed = props({
      capabilities: { currentDocument: true, workspace: true },
    })
    rerender(<AiConversationSidebar {...allowed} />)
    const revoke = screen.getByRole('button', { name: '让 AI 查看文档' })
    const revokeWorkspace = screen.getByRole('button', { name: '让 AI 查看工作区' })
    expect(revoke).toHaveAttribute('aria-pressed', 'true')
    await user.click(revoke)
    await user.click(revokeWorkspace)
    expect(allowed.onCurrentDocumentAccessChange).toHaveBeenCalledWith(false)
    expect(allowed.onWorkspaceAccessChange).toHaveBeenCalledWith(false)
  })

  it('offers all write policies with their explanations and retains the selected value', async () => {
    const user = userEvent.setup()
    const input = props({ writePolicy: 'document-grant' })
    const { rerender } = render(<AiConversationSidebar {...input} />)

    await user.click(screen.getByRole('button', { name: '写入策略：按文档许可' }))
    expect(screen.getByText('每次询问')).toBeVisible()
    expect(screen.getByText('编辑、创建、重命名或删除工作区文档时，每次都申请本次操作许可')).toBeVisible()
    expect(within(screen.getByRole('menu')).getByText('按文档许可')).toBeVisible()
    expect(screen.getByText('直接编辑当前文档；其他文档在当前会话首次写入时申请许可')).toBeVisible()
    expect(screen.getByText('按工作区许可')).toBeVisible()
    expect(screen.getByText('选择即允许直接编辑、创建、重命名或删除当前工作区文档，仍须开启工作区访问')).toBeVisible()
    expect(screen.getByRole('menuitemradio', { name: /按文档许可/u })).toHaveAttribute('aria-checked', 'true')

    await user.click(screen.getByRole('menuitemradio', { name: /按工作区许可/u }))
    expect(input.onWritePolicyChange).toHaveBeenCalledWith('workspace-grant')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '写入策略：按文档许可' })).toHaveFocus()

    rerender(<AiConversationSidebar {...props({ writePolicy: 'workspace-grant' })} />)
    await user.click(screen.getByRole('button', { name: '写入策略：按工作区许可' }))
    expect(screen.getByRole('menuitemradio', { name: /按工作区许可/u }))
      .toHaveAttribute('aria-checked', 'true')
  })

  it('closes the write-policy menu even when the current option is chosen', async () => {
    const user = userEvent.setup()
    const input = props()
    render(<AiConversationSidebar {...input} />)
    const summary = screen.getByRole('button', { name: '写入策略：每次询问' })
    await user.click(summary)
    await user.click(screen.getByRole('menuitemradio', { name: /每次询问/u }))

    expect(summary).toHaveAttribute('aria-expanded', 'false')
    expect(summary).toHaveFocus()
    expect(input.onWritePolicyChange).toHaveBeenCalledExactlyOnceWith('ask-every-time')
    expect(input.onAuthorizationDecision).not.toHaveBeenCalled()
  })

  it.each(['{Enter}', ' '])('closes the write-policy menu after keyboard activation with %j', async (key) => {
    const user = userEvent.setup()
    const input = props()
    render(<AiConversationSidebar {...input} />)
    const summary = screen.getByRole('button', { name: '写入策略：每次询问' })
    await user.click(summary)
    screen.getByRole('menuitemradio', { name: /按文档许可/u }).focus()

    await user.keyboard(key)

    expect(summary).toHaveAttribute('aria-expanded', 'false')
    expect(summary).toHaveFocus()
    expect(input.onWritePolicyChange).toHaveBeenCalledExactlyOnceWith('document-grant')
    expect(input.onAuthorizationDecision).not.toHaveBeenCalled()
  })

  it('labels a grant for an unopened document without claiming it is the current document', async () => {
    const user = userEvent.setup()
    const input = props({
      pendingAuthorization: {
        requestId: 'request-1',
        operationId: 'operation-1',
        toolName: 'create_workspace_document',
        scope: 'workspace',
        paths: ['C:\\Notes\\draft.md'],
        allowed: null,
      },
      authorizationRecords: [{
        requestId: 'request-0',
        operationId: 'operation-0',
        toolName: 'edit_workspace_document',
        scope: 'document',
        paths: ['C:\\Notes\\unopened.md'],
        allowed: true,
      }],
      auditRecords: [{
        id: 'audit-1',
        action: 'created',
        absolutePaths: ['C:\\Notes\\draft.md'],
      }],
    })
    render(<AiConversationSidebar {...input} />)

    const request = screen.getByRole('group', { name: 'AI 写入许可申请' })
    expect(request).toHaveTextContent('允许当前会话内AI对工作区文档进行编辑与操作。')
    await user.click(within(request).getByRole('button', { name: '允许' }))
    expect(input.onAuthorizationDecision).toHaveBeenCalledWith(true)
    expect(screen.getByText(/编辑 · 该文档 · 已允许/u)).toHaveTextContent('C:\\Notes\\unopened.md')
    expect(screen.queryByText(/编辑 · 当前文档 · 已允许/u)).not.toBeInTheDocument()
    expect(screen.getByText(/已创建/u)).toHaveTextContent('C:\\Notes\\draft.md')
  })

  it('renders messages, authorization results, and exact audits in one ordered timeline', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(
      <ContextMenuProvider>
        <AiConversationSidebar {...props({
          messages: [
            { id: 'u', role: 'user', content: '先创建文件' },
            { id: 'a1', role: 'assistant', content: '准备操作' },
            { id: 'a2', role: 'assistant', content: '操作完成' },
          ],
          authorizationRecords: [{
            requestId: 'request-1', operationId: 'operation-1',
            toolName: 'edit_workspace_document', scope: 'document',
            paths: ['note.md'], allowed: true,
          }],
          auditRecords: [
            { id: 'audit-auth', action: 'authorization-allowed', absolutePaths: [] },
            { id: 'audit-created', action: 'created', absolutePaths: ['C:\\Notes\\draft.md'] },
            { id: 'audit-renamed', action: 'renamed', absolutePaths: ['C:\\Notes\\draft.md', 'C:\\Notes\\final.md'] },
            { id: 'audit-deleted', action: 'deleted', absolutePaths: ['C:\\Notes\\old.md'] },
          ],
          timeline: [
            { kind: 'message', messageId: 'u' },
            { kind: 'message', messageId: 'a1' },
            { kind: 'authorization', operationId: 'operation-1' },
            { kind: 'audit', auditId: 'audit-auth' },
            { kind: 'audit', auditId: 'audit-created' },
            { kind: 'audit', auditId: 'audit-renamed' },
            { kind: 'audit', auditId: 'audit-deleted' },
            { kind: 'message', messageId: 'a2' },
          ],
        })} />
      </ContextMenuProvider>,
    )

    const log = screen.getByRole('log', { name: 'AI 对话消息' })
    const entries = log.querySelector('.ai-conversation-message-content')!
    expect([...entries.children].map((element) => element.textContent)).toEqual([
      '你先创建文件',
      'AI准备操作',
      '编辑 · 该文档 · 已允许：note.md',
      '已创建：C:\\Notes\\draft.md',
      '已重命名：C:\\Notes\\draft.md → C:\\Notes\\final.md',
      '已移至回收站：C:\\Notes\\old.md',
      'AI操作完成',
    ])
    expect(screen.queryByText('许可已允许')).not.toBeInTheDocument()

    const createdPath = screen.getAllByRole('link', { name: 'C:\\Notes\\draft.md' })[0]!
    await user.pointer({ keys: '[MouseRight]', target: createdPath })
    await user.click(screen.getByRole('menuitem', { name: '复制路径' }))
    expect(writeText).toHaveBeenCalledWith('C:\\Notes\\draft.md')
  })

  it('renders streaming assistant Markdown through the safe readonly renderer', () => {
    const input = props({
      messages: [
        { id: 'u', role: 'user', content: 'show code' },
        { id: 'a', role: 'assistant', content: '**answer**\n\n```ts\nconst n = 1\n```' },
      ],
      status: 'streaming',
    })
    render(<AiConversationSidebar {...input} />)

    expect(screen.getByRole('article', { name: 'AI 消息' })).toHaveTextContent('answer')
    expect(screen.getByRole('article', { name: 'AI 消息' }).querySelector('strong')).toBeVisible()
    expect(screen.getByRole('button', { name: '停止生成' })).toBeEnabled()
  })

  it.each(['', ' \n '])('omits a completed tool-only assistant message with content %j', (content) => {
    render(<AiConversationSidebar {...props({
      messages: [
        { id: 'u', role: 'user', content: '读取当前文档' },
        { id: 'tool', role: 'assistant', content },
        { id: 'answer', role: 'assistant', content: '文档总结完成' },
      ],
      timeline: [
        { kind: 'message', messageId: 'u' },
        { kind: 'message', messageId: 'tool' },
        { kind: 'message', messageId: 'answer' },
      ],
      status: 'idle',
    })} />)

    expect(screen.getAllByRole('article', { name: 'AI 消息' })).toHaveLength(1)
    expect(screen.getByRole('article', { name: 'AI 消息' })).toHaveTextContent('文档总结完成')
    expect(screen.queryByLabelText('AI 正在回复')).not.toBeInTheDocument()
  })

  it.each(['', ' \n '])('shows a waiting bubble only for the active empty assistant with content %j', (content) => {
    const initial = props({
      messages: [
        { id: 'u', role: 'user', content: '读取当前文档' },
        { id: 'tool', role: 'assistant', content },
      ],
      activeAssistantMessageId: 'tool',
      status: 'streaming',
    })
    const { rerender } = render(<AiConversationSidebar {...initial} />)
    expect(screen.getByLabelText('AI 正在回复')).toBeVisible()

    rerender(<AiConversationSidebar {...initial} activeAssistantMessageId={null} />)
    expect(screen.queryByRole('article', { name: 'AI 消息' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('AI 正在回复')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '停止生成' })).toBeVisible()

    rerender(<AiConversationSidebar {...initial}
      messages={[...initial.messages, { id: 'answer', role: 'assistant', content }]}
      activeAssistantMessageId="answer"
    />)
    expect(screen.getAllByRole('article', { name: 'AI 消息' })).toHaveLength(1)
    expect(screen.getByLabelText('AI 正在回复')).toBeVisible()

    rerender(<AiConversationSidebar {...initial}
      messages={[...initial.messages, { id: 'answer', role: 'assistant', content: '文档总结' }]}
      activeAssistantMessageId="answer"
    />)
    expect(screen.getByRole('article', { name: 'AI 消息' })).toHaveTextContent('文档总结')
    expect(screen.queryByLabelText('AI 正在回复')).not.toBeInTheDocument()
  })

  it('stops generation and clears the current conversation', async () => {
    const user = userEvent.setup()
    const input = props({
      messages: [{ id: 'a', role: 'assistant', content: 'working' }],
      status: 'streaming',
    })
    render(<AiConversationSidebar {...input} />)

    await user.click(screen.getByRole('button', { name: '停止生成' }))
    await user.click(screen.getByRole('button', { name: '清空对话' }))

    expect(input.onStop).toHaveBeenCalledOnce()
    expect(input.onClear).toHaveBeenCalledOnce()
  })

  it('guides an unconfigured user to the large-model settings', async () => {
    const user = userEvent.setup()
    const input = props({ configurationState: 'unconfigured' })
    render(<AiConversationSidebar {...input} />)

    expect(screen.getByRole('status')).toHaveTextContent('尚未配置大模型')
    await user.click(screen.getByRole('button', { name: '前往配置' }))
    expect(input.onOpenSettings).toHaveBeenCalledOnce()
    expect(screen.queryByLabelText('发送消息给 AI')).not.toBeInTheDocument()
  })

  it('shows a non-interactive status while configuration is being checked', () => {
    render(<AiConversationSidebar {...props({ configurationState: 'checking' })} />)

    expect(screen.getByRole('status')).toHaveTextContent('正在检查 AI 对话配置')
    expect(screen.queryByRole('textbox', { name: '发送消息给 AI' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '前往配置' })).not.toBeInTheDocument()
  })

  it.each(['checking', 'unconfigured'] as const)(
    'keeps Stop and Revoke available during an active authorized turn while %s',
    (configurationState) => {
      render(<AiConversationSidebar {...props({
        configurationState,
        capabilities: { currentDocument: true, workspace: false },
        messages: [{ id: 'u', role: 'user', content: 'active' }],
        status: 'streaming',
      })} />)

      expect(screen.getByRole('button', { name: '停止生成' })).toBeVisible()
      expect(screen.getByRole('button', { name: '让 AI 查看文档' })).toBeVisible()
    },
  )

  it('shows a distinct configuration read error and retries it', async () => {
    const user = userEvent.setup()
    const input = props({ configurationState: 'error' as const })
    render(<AiConversationSidebar {...input} />)

    expect(screen.getByRole('status')).toHaveTextContent('无法检查 AI 对话配置')
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(input.onRetryConfiguration).toHaveBeenCalledOnce()
  })

  it('restores focus to the composer after a transient authorization decision', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [pending, setPending] = useState(true)
      return <AiConversationSidebar {...props({
        pendingAuthorization: pending ? {
          requestId: '10000000-0000-4000-8000-000000000001',
          operationId: 'focus_call',
          toolName: 'edit_workspace_document',
          scope: 'action',
          paths: ['C:\\Notes\\note.md'],
          allowed: null,
        } : null,
        onAuthorizationDecision: () => setPending(false),
      })} />
    }
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: '拒绝' }))

    expect(screen.getByRole('textbox', { name: '发送消息给 AI' })).toHaveFocus()
  })

  it('keeps authorization actions disabled after submission until the result event arrives', () => {
    render(<AiConversationSidebar {...props({
      pendingAuthorization: {
        requestId: '10000000-0000-4000-8000-000000000001',
        operationId: 'decision_pending',
        toolName: 'edit_workspace_document',
        scope: 'action',
        paths: ['C:\\Notes\\note.md'],
        allowed: null,
        decisionPending: true,
      },
    })} />)

    expect(screen.getByRole('status')).toHaveTextContent('正在提交许可决定')
    expect(screen.getByRole('button', { name: '允许' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '拒绝' })).toBeDisabled()
  })

  it('restores focus to the composer after Stop disappears', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [status, setStatus] = useState<'streaming' | 'idle'>('streaming')
      return <AiConversationSidebar {...props({
        messages: [{ id: 'a', role: 'assistant', content: 'partial' }],
        status,
        onStop: () => setStatus('idle'),
      })} />
    }
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: '停止生成' }))

    expect(screen.getByRole('textbox', { name: '发送消息给 AI' })).toHaveFocus()
  })

  it('disables empty submission and sends trimmed content', async () => {
    const user = userEvent.setup()
    const input = props()
    render(<AiConversationSidebar {...input} />)
    const composer = screen.getByRole('textbox', { name: '发送消息给 AI' })
    const send = screen.getByRole('button', { name: '发送' })
    expect(send).toBeDisabled()

    await user.type(composer, '  hello  ')
    await user.click(send)

    expect(input.onSend).toHaveBeenCalledWith('hello')
    expect(composer).toHaveValue('')
  })

  it('keeps oversize text editable and reports the shared user-message boundary', () => {
    const input = props()
    render(<AiConversationSidebar {...input} />)
    const composer = screen.getByRole('textbox', { name: '发送消息给 AI' })
    const oversized = 'a'.repeat(AI_CONVERSATION_MESSAGE_MAX_CHARS + 1)
    fireEvent.change(composer, { target: { value: oversized } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(composer).toHaveValue(oversized)
    expect(input.onSend).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('48,000')
  })

  it('sends with Enter while Shift+Enter inserts a new line', async () => {
    const user = userEvent.setup()
    const input = props()
    render(<AiConversationSidebar {...input} />)
    const composer = screen.getByRole('textbox', { name: '发送消息给 AI' })

    await user.type(composer, 'line one{shift>}{enter}{/shift}line two')
    expect(composer).toHaveValue('line one\nline two')
    expect(input.onSend).not.toHaveBeenCalled()

    await user.type(composer, '{enter}')
    expect(input.onSend).toHaveBeenCalledWith('line one\nline two')
  })

  it('keeps the message list at the latest message while streaming', () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 900,
    })
    const first = props({
      messages: [{ id: 'a', role: 'assistant', content: 'first' }],
      status: 'streaming',
    })
    const { rerender } = render(<AiConversationSidebar {...first} />)
    const list = screen.getByRole('log', { name: 'AI 对话消息' })
    expect(list.scrollTop).toBe(900)

    rerender(<AiConversationSidebar {...props({
      messages: [{ id: 'a', role: 'assistant', content: 'first delta' }],
      status: 'streaming',
    })} />)
    expect(list.scrollTop).toBe(900)

    if (original) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', original)
    else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight
  })

  it('follows new deltas despite upward scrolling, but lets idle readers browse history', async () => {
    const user = userEvent.setup()
    const first = props({
      messages: [{ id: 'a', role: 'assistant', content: 'first' }],
      status: 'streaming',
    })
    const { rerender } = render(<AiConversationSidebar {...first} />)
    const list = screen.getByRole('log', { name: 'AI 对话消息' })
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1_000 },
    })
    list.scrollTop = 100
    fireEvent.scroll(list)

    rerender(<AiConversationSidebar {...props({
      messages: [{ id: 'a', role: 'assistant', content: 'first delta' }],
      status: 'streaming',
    })} />)
    expect(list.scrollTop).toBe(1_000)

    list.scrollTop = 100
    fireEvent.scroll(list)
    rerender(<AiConversationSidebar {...props({
      messages: [{ id: 'a', role: 'assistant', content: 'complete' }],
      status: 'idle',
    })} />)
    expect(list.scrollTop).toBe(100)
    fireEvent.change(screen.getByRole('textbox', { name: '发送消息给 AI' }), {
      target: { value: 'follow me' },
    })
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(list.scrollTop).toBe(1_000)
  })

  it('exposes an error without replacing the composer', () => {
    render(<AiConversationSidebar {...props({ error: '操作未能完成' })} />)
    expect(screen.getByRole('alert')).toHaveTextContent('操作未能完成')
    expect(screen.getByRole('textbox', { name: '发送消息给 AI' })).toBeVisible()
  })

  it('does not submit while composing text with an IME', () => {
    const input = props()
    render(<AiConversationSidebar {...input} />)
    const composer = screen.getByRole('textbox', { name: '发送消息给 AI' })
    fireEvent.change(composer, { target: { value: '文档' } })
    fireEvent.keyDown(composer, { key: 'Enter', isComposing: true })
    expect(input.onSend).not.toHaveBeenCalled()
  })
})


it('preserves a tool-only round time and avoids fabricated thinking before a signal', () => {
  const { rerender } = render(<AiConversationSidebar {...props({ status: 'streaming', messages: [{ id: 'one', role: 'assistant', content: '' }], activeAssistantMessageId: 'one' })} />)
  expect(screen.queryByText(/思考中|思考用时/)).not.toBeInTheDocument()
  rerender(<AiConversationSidebar {...props({ messages: [{ id: 'one', role: 'assistant', content: '' }], timeline: [
    { kind: 'thinking', messageId: 'one', elapsedMs: 1250, active: false, observedAt: 0 },
    { kind: 'message', messageId: 'one' },
  ] })} />)
  expect(screen.getByText('思考用时 1.3秒')).toBeVisible()
})

it('shows one request elapsed time beside its latest thinking round, and alone without reasoning signals', () => {
  const timing = { kind: 'elapsed' as const, requestId: 'request', messageIds: ['first', 'second'], elapsedMs: 9200, active: false, observedAt: 0 }
  const { rerender } = render(<AiConversationSidebar {...props({ messages: [{ id: 'second', role: 'assistant', content: 'done' }], timeline: [
    timing,
    { kind: 'thinking', messageId: 'first', elapsedMs: 1000, active: false, observedAt: 0 },
    { kind: 'thinking', messageId: 'second', elapsedMs: 2000, active: false, observedAt: 0 },
    { kind: 'message', messageId: 'second' },
  ] })} />)
  expect(screen.getAllByText('用时 · 9.2秒')).toHaveLength(1)
  expect(screen.getByText('思考用时 2.0秒').parentElement).toContainElement(screen.getByText('用时 · 9.2秒'))
  expect(screen.getByText('思考用时 1.0秒').parentElement).not.toContainElement(screen.getByText('用时 · 9.2秒'))
  rerender(<AiConversationSidebar {...props({ timeline: [timing] })} />)
  expect(screen.getByText('用时 · 9.2秒')).toBeVisible()
  expect(screen.queryByText(/思考用时/)).not.toBeInTheDocument()
})


it('follows deferred content growth while generating and disconnects on idle without taking focus', () => {
  const observers: Array<{ callback: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> }> = []
  const frames = new Map<number, FrameRequestCallback>()
  let serial = 0
  vi.stubGlobal('ResizeObserver', class {
    disconnect = vi.fn()
    observe() {}
    unobserve() {}
    constructor(readonly callback: ResizeObserverCallback) { observers.push(this) }
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++serial, callback); return serial })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const first = props({ status: 'streaming', messages: [{ id: 'a', role: 'assistant', content: 'A table' }] })
  const mounted = render(<AiConversationSidebar {...first} />)
  try {
    const list = screen.getByRole('log', { name: 'AI 对话消息' })
    let height = 1_000
    Object.defineProperties(list, { clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, get: () => height } })
    const composer = screen.getByRole('textbox', { name: '发送消息给 AI' })
    composer.focus()
    list.scrollTop = 100; fireEvent.scroll(list)
    expect(observers).toHaveLength(1)
    const observer = observers[0]!
    height = 1_400
    act(() => {
      observer.callback([], observer as unknown as ResizeObserver)
      observer.callback([], observer as unknown as ResizeObserver)
    })
    expect(frames.size).toBe(1)
    act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(16)) })
    expect(list.scrollTop).toBe(1_400)
    expect(composer).toHaveFocus()
    list.scrollTop = 100; fireEvent.scroll(list)
    act(() => observer.callback([], observer as unknown as ResizeObserver))
    mounted.rerender(<AiConversationSidebar {...first} status="idle" />)
    expect(observer.disconnect).toHaveBeenCalledOnce()
    expect(frames.size).toBe(0)
    expect(list.scrollTop).toBe(100)
    act(() => observer.callback([], observer as unknown as ResizeObserver))
    expect(frames.size).toBe(0)
  } finally { mounted.unmount(); vi.unstubAllGlobals() }
})

it('follows a resumed streaming workspace without overwriting a different idle workspace viewport', () => {
  const idle = { followLatest: false, anchorMessageId: null, anchorOffset: 0, scrollTop: 120 }
  const active = { followLatest: false, anchorMessageId: null, anchorOffset: 0, scrollTop: 80 }
  const value = props({ messages: [{ id: 'a', role: 'assistant', content: 'current' }], viewport: idle })
  const mounted = render(<AiConversationSidebar {...value} />)
  const list = screen.getByRole('log', { name: 'AI 对话消息' })
  Object.defineProperties(list, { clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, value: 1_000 } })
  expect(list.scrollTop).toBe(120)
  mounted.rerender(<AiConversationSidebar {...value} viewport={active} status="streaming" />)
  expect(list.scrollTop).toBe(1_000)
  expect(idle.scrollTop).toBe(120)
  mounted.rerender(<AiConversationSidebar {...value} viewport={idle} status="idle" />)
  expect(list.scrollTop).toBe(120)
})

it('marks partial output as incomplete separately from final answers and retains Markdown rendering', () => {
  render(<AiConversationSidebar {...props({ messages: [], timeline: [
    { kind: 'incomplete-omission' },
    { kind: 'incomplete-message', message: { id: 'partial', role: 'assistant', content: '**Useful partial**' }, outcome: 'failed' },
  ] })} />)
  const partial = screen.getByRole('article', { name: 'AI 未完成回复' })
  expect(within(partial).getByText('Useful partial').tagName).toBe('STRONG')
  expect(within(partial).getByText('回复未完成 · 生成失败')).toBeVisible()
  expect(screen.getByText('较早的未完成回复已省略，仅保留最近 20 条。')).toBeVisible()
  expect(screen.queryByText('询问问题，或让 AI 在获得授权后查看当前文档。')).not.toBeInTheDocument()
  expect(screen.queryByRole('article', { name: 'AI 消息' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '清空对话' })).toBeEnabled()
})
