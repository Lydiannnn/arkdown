import { describe, expect, it, vi } from 'vitest'
import { createModelReasoningTimer } from '../../src/main/models/model-reasoning-timer'

describe('observed reasoning time', () => {
  it('counts only signalled segments and closes before tools and permission waits', () => {
    let now = 100
    const emit = vi.fn()
    const timer = createModelReasoningTimer(new AbortController().signal, emit, () => now)
    now = 5_000
    timer.update(true)
    now = 5_100
    timer.update(true)
    now = 5_250
    timer.update(false)
    now = 20_000
    timer.update(true)
    now = 20_500
    timer.dispose()
    now = 90_000
    timer.update(true)
    expect(emit.mock.calls.map(([value]) => value)).toEqual([
      { active: true, elapsedMs: 0 }, { active: false, elapsedMs: 250 },
      { active: true, elapsedMs: 250 }, { active: false, elapsedMs: 750 },
    ])
  })
  it('freezes synchronously on cancellation, without counting asynchronous cleanup', () => {
    let now = 0
    const abort = new AbortController(), emit = vi.fn()
    const timer = createModelReasoningTimer(abort.signal, emit, () => now)
    timer.update(true)
    now = 1234
    abort.abort()
    now = 80_000
    timer.update(true)
    timer.dispose()
    expect(emit.mock.calls).toEqual([[{ active: true, elapsedMs: 0 }], [{ active: false, elapsedMs: 1234 }]])
  })
  it('emits no fabricated duration for silent providers or an already aborted request', () => {
    const emit = vi.fn(), abort = new AbortController()
    createModelReasoningTimer(abort.signal, emit).dispose()
    abort.abort()
    const timer = createModelReasoningTimer(abort.signal, emit)
    timer.update(true)
    timer.dispose()
    expect(emit).not.toHaveBeenCalled()
  })
})
