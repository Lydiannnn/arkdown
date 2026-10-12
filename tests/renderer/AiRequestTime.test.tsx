import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AiRequestTime } from '../../src/renderer/editor/AiRequestTime'
import { freezeRequestTime, type AiRequestTime as Timing } from '../../src/renderer/editor/ai-request-time'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('ticks total elapsed independently of thinking, then remains frozen and cleans up its interval', () => {
  vi.useFakeTimers()
  let now = 100
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const record: Timing = { kind: 'elapsed', requestId: 'one', messageIds: [], active: true, elapsedMs: 0, observedAt: 100 }
  const view = render(<AiRequestTime record={record} />)
  now = 5100
  act(() => vi.advanceTimersByTime(100))
  expect(screen.getByText('用时 · 5.0秒')).toHaveAttribute('data-tooltip', expect.stringContaining('授权等待'))
  const frozen = freezeRequestTime(record)
  view.rerender(<AiRequestTime record={frozen} />)
  expect(vi.getTimerCount()).toBe(0)
  now = 100000
  act(() => vi.advanceTimersByTime(100))
  expect(screen.getByText('用时 · 5.0秒')).toBeVisible()
  expect(freezeRequestTime(frozen)).toBe(frozen)
  view.rerender(<AiRequestTime record={{ ...record, requestId: 'two', observedAt: now }} />)
  expect(screen.getByText('用时 · 0.0秒')).toBeVisible()
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
