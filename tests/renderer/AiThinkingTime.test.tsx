import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiThinkingTime } from '../../src/renderer/editor/AiThinkingTime'
import { freezeThinkingTime, type AiThinkingTime as Record } from '../../src/renderer/editor/ai-thinking-time'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
describe('observed thinking UI', () => {
  it('ticks only an active phase, reconciles the authoritative final time, and cleans every timer', () => {
    vi.useFakeTimers()
    let now = 100
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const record: Record = { kind: 'thinking', messageId: 'one', active: true, elapsedMs: 500, observedAt: 100 }
    const { rerender, unmount } = render(<AiThinkingTime record={record} />)
    expect(screen.getByText('思考中 · 0.5秒')).toBeVisible()
    now = 1_200
    act(() => vi.advanceTimersByTime(100))
    expect(screen.getByText('思考中 · 1.6秒')).toBeVisible()
    rerender(<AiThinkingTime record={{ ...record, active: false, elapsedMs: 1_520 }} />)
    expect(screen.getByText('思考用时 1.5秒')).toHaveAttribute('data-tooltip', expect.stringContaining('不代表供应商计费时间'))
    expect(screen.getByText('思考用时 1.5秒')).not.toHaveAttribute('title')
    expect(screen.getByText('思考用时 1.5秒')).toHaveClass('ai-conversation-thinking-time')
    expect(vi.getTimerCount()).toBe(0)
    now = 100_000
    act(() => vi.advanceTimersByTime(10_000))
    expect(screen.getByText('思考用时 1.5秒')).toBeVisible()
    rerender(<AiThinkingTime record={{ ...record, messageId: 'two', observedAt: now }} />)
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('freezes only the observed phase at local cancellation or ownership revocation', () => {
    const record: Record = { kind: 'thinking', messageId: 'one', active: true, elapsedMs: 500, observedAt: 100 }
    const frozen = freezeThinkingTime(record, 1_200)
    expect(frozen).toMatchObject({ active: false, elapsedMs: 1_600 })
    expect(freezeThinkingTime(frozen, 90_000)).toBe(frozen)
  })
})
