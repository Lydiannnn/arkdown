import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProcessEntry, AiProcessRecord, AiProcessTextRecord, AiProcessToolRecord } from '../../src/renderer/editor/ai-process-buffer'
import type { AiRequestTime } from '../../src/renderer/editor/ai-request-time'
import type { AiThinkingTime } from '../../src/renderer/editor/ai-thinking-time'

const modulePath = '../../src/renderer/editor/AiProcessPanel'
const implementation = await import(modulePath).catch(() => ({})) as typeof import('../../src/renderer/editor/AiProcessPanel')
let now = 1_000
beforeEach(() => { vi.useFakeTimers(); now = 1_000; vi.spyOn(performance, 'now').mockImplementation(() => now) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

function record(patch: Partial<AiProcessRecord> = {}): AiProcessRecord {
  return { requestId: 'request-one', messageId: 'message-one', round: 1, sequence: 1,
    stage: 'waiting-model', outcome: 'active', startedAt: 1_000, endedAt: null,
    lastSemanticProgressAt: 1_000, userExpanded: null, entries: [], textBytes: 0,
    omitted: false, revision: 1, ...patch }
}
function text(id: string, channel: AiProcessTextRecord['channel'], content: string, round = 1): AiProcessTextRecord {
  return { type: 'text', id, round, itemId: id, segmentIndex: 0, channel,
    delivery: 'stream', text: content, bytes: new TextEncoder().encode(content).length, omittedBefore: false }
}
function tool(id: string, status: AiProcessToolRecord['status'], patch: Partial<AiProcessToolRecord> = {}): AiProcessToolRecord {
  return { type: 'tool', id, requestId: 'request-one', messageId: 'message-one', round: 1,
    toolCallId: id, toolName: 'edit_workspace_document', status,
    operationId: 'operation-one', paths: ['docs/synthetic.md'], displayName: null, cached: false, ...patch }
}
function panel(value: AiProcessRecord, props: { elapsed?: AiRequestTime; thinking?: readonly AiThinkingTime[]; thinkingElapsedMs?: number; onExpandedChange?(expanded: boolean): void } = {}) {
  expect(implementation.AiProcessPanel).toBeTypeOf('function')
  return <implementation.AiProcessPanel record={value} {...props} />
}

describe('readable AI process panel', () => {
  it('reports absent readable thinking only after an observed thinking turn ends, without claiming model incapability', () => {
    const value = record({ stage: 'thinking' })
    const mounted = render(panel(value, { thinkingElapsedMs: 600 }))
    expect(screen.queryByText('本次未收到可展示的思考内容。')).not.toBeInTheDocument()
    value.outcome = 'completed'; value.endedAt = now
    mounted.rerender(panel(value, { thinkingElapsedMs: 600 }))
    expect(screen.getByText('本次未收到可展示的思考内容。')).toBeVisible()
    expect(screen.queryByText(/模型不支持/)).not.toBeInTheDocument()
    value.entries.push(text('commentary', 'commentary', 'Provider progress only'))
    mounted.rerender(panel(value, { thinkingElapsedMs: 600 }))
    expect(screen.getByText('本次未收到可展示的思考内容。')).toBeVisible()
    value.entries.push(text('summary', 'reasoning-summary', 'Actual summary'))
    mounted.rerender(panel(value, { thinkingElapsedMs: 600 }))
    expect(screen.queryByText('本次未收到可展示的思考内容。')).not.toBeInTheDocument()
    value.entries = []; value.omitted = true
    mounted.rerender(panel(value, { thinkingElapsedMs: 600 }))
    expect(screen.queryByText('本次未收到可展示的思考内容。')).not.toBeInTheDocument()
    value.omitted = false
    mounted.rerender(panel(value))
    expect(screen.queryByText('本次未收到可展示的思考内容。')).not.toBeInTheDocument()
  })
  it('renders the three readable channels as literal text without creating markup or links', () => {
    const literal = '<img src="https://example.com/pixel">\n[link](https://example.com) **literal**'
    const { container } = render(panel(record({ entries: [text('a', 'reasoning-text', literal), text('b', 'reasoning-summary', 'Summary'), text('c', 'commentary', 'Progress')] })))
    expect(screen.getByText('思考内容')).toBeVisible()
    expect(screen.getByText('思考摘要')).toBeVisible()
    expect(screen.getByText('进展说明')).toBeVisible()
    expect(screen.getByText((_content, element) => element?.classList.contains('ai-process-text') === true && element.textContent === literal)).toBeVisible()
    expect(container.querySelector('img, a, strong')).toBeNull()
    expect(container.querySelector('[data-ai-process-scroll]')).toHaveAttribute('aria-live', 'off')
    expect(container.querySelector('[data-ai-process-scroll]')).toHaveAttribute('data-ai-process-active', 'true')
  })

  it.each([
    ['active', true], ['completed', false], ['failed', true], ['stopped', true],
  ] as const)('defaults %s to expanded=%s without inventing a text block', (outcome, expanded) => {
    const { container } = render(panel(record({ outcome })))
    const toggle = screen.getByRole('button', { name: /处理过程/ })
    expect(toggle).toHaveAttribute('aria-expanded', String(expanded))
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBeInTheDocument()
    expect(container.querySelector('.ai-process-text')).toBeNull()
    expect(container.querySelector('[data-ai-process-scroll]')).toHaveAttribute('data-ai-process-active', String(outcome === 'active' && expanded))
  })

  it('retains a manual collapse through deltas, completion and unmount without taking focus', () => {
    const value = record({ entries: [text('a', 'reasoning-text', 'First')] })
    const change = vi.fn()
    const mounted = render(<><input aria-label="Draft" />{panel(value, { onExpandedChange: change })}</>)
    const toggle = screen.getByRole('button', { name: /处理过程/ })
    toggle.focus(); fireEvent.click(toggle)
    expect(toggle).toHaveFocus()
    expect(value.userExpanded).toBe(false)
    expect(change).toHaveBeenCalledWith(false)
    value.entries.push(text('b', 'commentary', 'Later')); value.revision++
    screen.getByRole('textbox').focus()
    mounted.rerender(<><input aria-label="Draft" />{panel(value)}</>)
    expect(screen.getByRole('textbox')).toHaveFocus()
    expect(screen.getByRole('button', { name: /处理过程/ })).toHaveAttribute('aria-expanded', 'false')
    value.outcome = 'completed'; value.endedAt = now
    mounted.rerender(<>{panel(value)}</>)
    expect(screen.getByRole('button', { name: /处理过程/ })).toHaveAttribute('aria-expanded', 'false')
    mounted.unmount(); render(panel(value))
    expect(screen.getByRole('button', { name: /处理过程/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps manual expansion after success and uses a different request’s own preference', () => {
    const value = record({ outcome: 'completed' })
    const mounted = render(panel(value))
    fireEvent.click(screen.getByRole('button', { name: /处理过程/ }))
    expect(value.userExpanded).toBe(true)
    mounted.rerender(panel(value))
    expect(screen.getByRole('button', { name: /处理过程/ })).toHaveAttribute('aria-expanded', 'true')
    mounted.rerender(panel(record({ requestId: 'other', outcome: 'completed' })))
    expect(screen.getByRole('button', { name: /处理过程/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('groups retained entries by round and marks both whole-record and local omissions', () => {
    render(panel(record({ omitted: true, entries: [
      text('one', 'reasoning-text', 'First round'),
      { ...text('two', 'reasoning-summary', 'Retained tail', 2), omittedBefore: true, delivery: 'complete' },
    ] })))
    const rounds = screen.getAllByRole('group', { name: /第 \d+ 轮/ })
    expect(rounds).toHaveLength(2)
    expect(within(rounds[0]!).getByText('First round')).toBeVisible()
    expect(within(rounds[1]!).getByText('Retained tail')).toBeVisible()
    expect(screen.getByText('部分早期过程已省略。')).toBeVisible()
    expect(within(rounds[1]!).getByText('此处省略了较早的过程内容。')).toBeVisible()
    expect(within(rounds[1]!).getByText('结果返回时收到')).toBeVisible()
  })

  it('shows real tool outcomes and cached results separately from the action and display target', () => {
    const entries: AiProcessEntry[] = [
      tool('success', 'succeeded'), tool('unknown', 'unknown'), tool('denied', 'denied'),
      tool('unavailable', 'unavailable'), tool('failed', 'failed'), tool('not-executed', 'not-executed'),
      tool('read', 'succeeded', { toolName: 'read_current_document', operationId: null, paths: [], displayName: 'Untitled.md', cached: true }),
      tool('delete', 'succeeded', { toolName: 'delete_workspace_document' }),
    ]
    render(panel(record({ entries })))
    expect(screen.getAllByText('编辑工作区文档')).toHaveLength(6)
    for (const status of ['结果待确认', '已拒绝', '文件不可用', '失败', '未执行']) expect(screen.getByText(status)).toBeVisible()
    expect(screen.getAllByText('已完成')).toHaveLength(3)
    expect(screen.getByText('移至回收站')).toBeVisible()
    expect(screen.getByText('读取当前文档')).toBeVisible()
    expect(screen.getByText('Untitled.md')).toBeVisible()
    expect(screen.getByText('复用已有结果')).toBeVisible()
    expect(screen.getByText(/工具记录：/)).toHaveTextContent('3 项已完成')
  })

  it.each(['completed', 'failed', 'stopped'] as const)('does not leave tools looking active after %s', outcome => {
    render(panel(record({ outcome, userExpanded: true, entries: [tool('running', 'running'), tool('approval', 'awaiting-approval')] })))
    expect(screen.getAllByText('未收到结果')).toHaveLength(2)
    expect(screen.queryByText('执行中')).not.toBeInTheDocument()
    expect(screen.queryByText('等待许可')).not.toBeInTheDocument()
  })

  it('shows quiet feedback after 15 seconds of semantic silence and clears it for new progress', () => {
    const value = record({ stage: 'thinking' })
    const mounted = render(panel(value))
    now = 15_999; act(() => vi.advanceTimersByTime(1_000))
    expect(screen.queryByText('暂未收到新进展，仍在等待')).not.toBeInTheDocument()
    now = 16_000; act(() => vi.advanceTimersByTime(1_000))
    expect(screen.getByText('暂未收到新进展，仍在等待')).toBeVisible()
    value.lastSemanticProgressAt = now; value.revision++
    mounted.rerender(panel(value))
    expect(screen.queryByText('暂未收到新进展，仍在等待')).not.toBeInTheDocument()
  })

  it.each(['stage', 'tool'] as const)('does not describe an outstanding %s approval as model silence', source => {
    render(panel(record(source === 'stage' ? { stage: 'awaiting-approval' } : { entries: [tool('approval', 'awaiting-approval')] })))
    now = 61_000; act(() => vi.advanceTimersByTime(60_000))
    expect(screen.queryByText('暂未收到新进展，仍在等待')).not.toBeInTheDocument()
  })

  it('uses the supplied total and thinking times, freezing all ticking at a terminal result', () => {
    const value = record({ stage: 'thinking' })
    const elapsed: AiRequestTime = { kind: 'elapsed', requestId: value.requestId, messageIds: [], elapsedMs: 3_000, active: true, observedAt: now }
    const mounted = render(panel(value, { elapsed, thinkingElapsedMs: 400 }))
    expect(screen.getByText('用时 · 3.0秒')).toBeVisible()
    expect(screen.getByText('思考用时 0.4秒')).toBeVisible()
    now = 2_000; act(() => vi.advanceTimersByTime(1_000))
    expect(screen.getByText('用时 · 4.0秒')).toBeVisible()
    value.outcome = 'failed'; value.endedAt = now
    mounted.rerender(panel(value, { elapsed, thinkingElapsedMs: 400 }))
    expect(vi.getTimerCount()).toBe(0)
    now = 100_000; act(() => vi.advanceTimersByTime(20_000))
    expect(screen.getByText('用时 · 4.0秒')).toBeVisible()
    expect(screen.getByText(/已失败/)).toHaveTextContent('正在思考')
  })

  it('advances observed thinking during silent intervals across rounds and freezes at the request end', () => {
    const value = record({ stage: 'thinking' })
    const thinking: readonly AiThinkingTime[] = [
      { kind: 'thinking', messageId: 'earlier-round', elapsedMs: 800, active: false, observedAt: 500 },
      { kind: 'thinking', messageId: 'current-round', elapsedMs: 200, active: true, observedAt: now },
    ]
    const mounted = render(panel(value, { thinking, thinkingElapsedMs: 99_000 }))
    expect(screen.getByText('思考用时 1.0秒')).toBeVisible()
    now = 3_000; act(() => vi.advanceTimersByTime(2_000))
    expect(screen.getByText('思考用时 3.0秒')).toBeVisible()
    value.outcome = 'completed'; value.endedAt = now
    mounted.rerender(panel(value, { thinking, thinkingElapsedMs: 99_000 }))
    expect(vi.getTimerCount()).toBe(0)
    now = 13_000; act(() => vi.advanceTimersByTime(10_000))
    mounted.rerender(panel(value, { thinking, thinkingElapsedMs: 99_000 }))
    expect(screen.getByText('思考用时 3.0秒')).toBeVisible()
  })

  it('suspends its only timer while the document is hidden and cleans it on unmount', () => {
    let hidden = false
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    const mounted = render(panel(record()))
    expect(vi.getTimerCount()).toBe(1)
    hidden = true; act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(vi.getTimerCount()).toBe(0)
    hidden = false; act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(vi.getTimerCount()).toBe(1)
    mounted.unmount()
    expect(vi.getTimerCount()).toBe(0)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(vi.getTimerCount()).toBe(0)
  })
})

it('shows application-owned safe recycle guidance for the failed attempt', () => {
  const value = record({ outcome: 'completed', entries: [tool('delete', 'failed', { toolName: 'delete_workspace_document', reason: 'recycle-unavailable' } as Partial<AiProcessToolRecord>)] })
  const mounted = render(panel(value))
  const guidance = '当前版本的 AI 暂不支持安全移入回收站，本次删除未执行，文件保留在原位置。请在资源管理器中手动移入回收站。'
  expect(screen.getByRole('button', { name: /处理过程/ })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText(guidance)).toBeVisible()
  value.entries = [tool('delete', 'unknown', { toolName: 'delete_workspace_document' })]
  mounted.rerender(panel(value))
  expect(screen.queryByText(guidance)).not.toBeInTheDocument()
  value.entries = [tool('edit', 'failed')]
  mounted.rerender(panel(value))
  expect(screen.queryByText(guidance)).not.toBeInTheDocument()
})
