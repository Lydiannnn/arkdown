import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClosePreparationBridge, type ClosePreparationHandlerContext } from '../../src/preload/close-preparation'
import type { ClosePreparationEvent, ClosePreparationResult } from '../../src/shared/close-preparation'

const identity = { attemptId: '550e8400-e29b-41d4-a716-446655440001', generation: 1,
  requestId: '550e8400-e29b-41d4-a716-446655440002' }
const next = { attemptId: '550e8400-e29b-41d4-a716-446655440003', generation: 2,
  requestId: '550e8400-e29b-41d4-a716-446655440004' }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function setup() {
  vi.useFakeTimers()
  let listener: ((input: unknown) => void) | undefined
  const events: ClosePreparationEvent[] = []
  const detach = vi.fn(() => { listener = undefined })
  const send = vi.fn((event: ClosePreparationEvent) => { events.push(event) })
  const bridge = createClosePreparationBridge({ transport: {
    subscribe(callback) { listener = callback; return detach }, send,
  } })
  return { bridge, events, send, detach, request: (value: unknown = identity) => listener?.(value) }
}
afterEach(() => vi.useRealTimers())

describe('close preparation preload bridge', () => {
  it('keeps one handler flight and untimed human wait, then publishes its original result once', async () => {
    const { bridge, events, request } = setup(), result = deferred<ClosePreparationResult>()
    const handler = vi.fn((context: ClosePreparationHandlerContext) => { context.enter('await-user'); return result.promise })
    bridge.setHandler(handler)
    request(); request()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(handler).toHaveBeenCalledOnce()
    expect(events.filter(event => event.type === 'stage')).toEqual([expect.objectContaining({ stage: 'await-user' })])
    expect(events.filter(event => event.type === 'heartbeat').length).toBeGreaterThan(30)
    expect(events.some(event => event.type === 'result')).toBe(false)
    result.resolve({ status: 'cancelled' })
    await vi.advanceTimersByTimeAsync(0)
    expect(events.at(-1)).toMatchObject({ ...identity, type: 'result', result: { status: 'cancelled' } })
    expect(vi.getTimerCount()).toBe(0)
    request()
    expect(handler).toHaveBeenCalledOnce()
    expect(events.at(-1)).toEqual(events.at(-2))
    bridge.dispose()
  })

  it('blocks a different attempt while work remains pending and fences stale handler callbacks', async () => {
    const { bridge, events, request } = setup(), first = deferred<ClosePreparationResult>()
    let context!: ClosePreparationHandlerContext
    const handler = vi.fn((value: ClosePreparationHandlerContext) => { context = value; return first.promise })
    bridge.setHandler(handler)
    request(); await vi.advanceTimersByTimeAsync(0)
    context.enter('settle-document')
    request(next)
    expect(handler).toHaveBeenCalledOnce()
    expect(events.at(-1)).toMatchObject({ ...next, type: 'result', result: { status: 'blocked', code: 'document-result-unknown' } })
    context.enter('settle-preferences'); first.resolve({ status: 'ready' })
    await vi.advanceTimersByTimeAsync(0)
    const saved = context
    bridge.setHandler(async current => { current.enter('settle-preferences'); return { status: 'ready' } })
    request(next); await vi.advanceTimersByTimeAsync(0)
    const count = events.length
    saved.enter('await-user'); request(identity)
    expect(events.slice(count).every(event => event.type !== 'stage')).toBe(true)
    expect(handler).toHaveBeenCalledOnce()
    bridge.dispose()
  })

  it('keeps a captured handler through subscriber replacement but dispose never blesses pending work', async () => {
    const { bridge, events, request, detach } = setup(), result = deferred<ClosePreparationResult>()
    const old = vi.fn(() => result.promise), replacement = vi.fn(async () => ({ status: 'ready' as const }))
    const unregisterOld = bridge.setHandler(old)
    request(); await vi.advanceTimersByTimeAsync(0)
    bridge.setHandler(replacement); unregisterOld(); request()
    expect(replacement).not.toHaveBeenCalled()
    bridge.dispose()
    const count = events.length
    result.resolve({ status: 'ready' }); await vi.advanceTimersByTimeAsync(0)
    expect(events).toHaveLength(count)
    expect(detach).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('maps thrown document work to unknown, never cancellation or an exposed exception', async () => {
    const { bridge, events, request } = setup()
    bridge.setHandler(async context => { context.enter('settle-document'); throw new Error('C:/private/API_KEY') })
    request(); await vi.advanceTimersByTimeAsync(0)
    expect(events.at(-1)).toMatchObject({ type: 'result', result: { status: 'blocked', code: 'document-result-unknown' } })
    expect(JSON.stringify(events)).not.toContain('private')
    bridge.dispose()
  })

  it('rejects malformed requests and refuses premature ready or malformed results', async () => {
    const { bridge, events, request } = setup(), handler = vi.fn(async () => ({ status: 'ready' as const }))
    bridge.setHandler(handler)
    request({ ...identity, extra: true }); await vi.advanceTimersByTimeAsync(0)
    expect(handler).not.toHaveBeenCalled(); expect(events).toEqual([])
    request(); await vi.advanceTimersByTimeAsync(0)
    expect(events.at(-1)).toMatchObject({ type: 'result', result: { status: 'blocked', code: 'editor-unavailable' } })
    bridge.setHandler(async context => { context.enter('settle-preferences'); return { status: 'ready', extra: 'secret' } as ClosePreparationResult })
    request(next); await vi.advanceTimersByTimeAsync(0)
    expect(events.at(-1)).toMatchObject({ type: 'result', result: { status: 'blocked', code: 'editor-unavailable' } })
    bridge.dispose()
  })

  it('can replay a cached terminal after a send failure without rerunning document work', async () => {
    const { bridge, events, request, send } = setup()
    const handler = vi.fn(async (context: ClosePreparationHandlerContext) => { context.enter('settle-preferences'); return { status: 'ready' as const } })
    bridge.setHandler(handler)
    let failTerminal = true
    send.mockImplementation(event => {
      if (event.type === 'result' && failTerminal) { failTerminal = false; throw new Error('transport unavailable') }
      events.push(event)
    })
    request(); await vi.advanceTimersByTimeAsync(0)
    expect(handler).toHaveBeenCalledOnce()
    expect(events.some(event => event.type === 'result')).toBe(false)
    request()
    expect(events.at(-1)).toMatchObject({ type: 'result', result: { status: 'ready' } })
    expect(handler).toHaveBeenCalledOnce()
    bridge.dispose()
  })

  it('makes unregister ownership specific to the registration, even when the same callback is reused', async () => {
    const { bridge, events, request } = setup()
    const handler = vi.fn(async (context: ClosePreparationHandlerContext) => { context.enter('settle-preferences'); return { status: 'ready' as const } })
    const unregisterOld = bridge.setHandler(handler)
    bridge.setHandler(handler)
    unregisterOld()
    request(); await vi.advanceTimersByTimeAsync(0)
    expect(handler).toHaveBeenCalledOnce()
    expect(events.at(-1)).toMatchObject({ type: 'result', result: { status: 'ready' } })
    bridge.dispose()
  })

  it('reports absent handler as a known failed preparation without starting a heartbeat', () => {
    const { bridge, events, request } = setup()
    request()
    expect(events).toEqual([expect.objectContaining({ type: 'result', result: { status: 'failed', code: 'editor-unavailable' } })])
    expect(vi.getTimerCount()).toBe(0)
    bridge.dispose()
  })
})
