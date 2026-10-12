import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiProcessEvent } from '../../src/shared/ai-process-events'
import { AiConversationProgress } from '../../src/main/models/ai-conversation-progress'
import { parseAiConversationEvent } from '../../src/shared/ai-conversation'
import { applyAiProcessEvent, beginAiProcessRound, createAiProcessRecord } from '../../src/renderer/editor/ai-process-buffer'

const requestId = '550e8400-e29b-41d4-a716-446655440004'
const messageId = '550e8400-e29b-41d4-a716-446655440002'
const nextMessageId = '550e8400-e29b-41d4-a716-446655440003'
const delta = { kind: 'reasoning-summary', itemId: 'provider-secret', segmentIndex: 0, delta: 'First', delivery: 'stream' } as const
function setup() {
  const events: AiProcessEvent[] = [], controller = new AbortController()
  let current = true
  const progress = new AiConversationProgress({ requestId, signal: controller.signal,
    isCurrent: () => current, emit: event => events.push(event) })
  return { events, controller, progress, invalidate: () => { current = false } }
}
afterEach(() => vi.useRealTimers())

describe('main conversation process ownership', () => {
  it('uses the 50 ms batcher and 16 KiB Unicode packets before answering, with one request sequence', () => {
    vi.useFakeTimers()
    const { progress, events } = setup()
    const round = progress.beginRound(messageId)
    progress.append(round, delta)
    vi.advanceTimersByTime(49)
    expect(events.map(event => event.type)).toEqual(['process-stage'])
    vi.advanceTimersByTime(1)
    expect(events.at(-1)).toMatchObject({ type: 'process-text', delta: 'First' })
    const long = '😀'.repeat(9000)
    progress.append(round, { ...delta, delta: long })
    progress.answering(round)
    const text = events.filter(event => event.type === 'process-text')
    expect(text.slice(1).map(event => event.delta).join('')).toBe(long)
    expect(text.every(event => Buffer.byteLength(event.delta) <= 16384 && !event.delta.includes('\ufffd'))).toBe(true)
    expect(new Set(text.map(event => event.itemId)).size).toBe(1)
    expect(events.at(-1)).toMatchObject({ type: 'process-stage', stage: 'answering' })
    expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1))
    progress.finish()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('drops ownership-invalidated pending text and rejects old-round callbacks', () => {
    vi.useFakeTimers()
    const state = setup(), round = state.progress.beginRound(messageId)
    state.progress.append(round, delta)
    state.progress.closeText()
    const next = state.progress.beginRound(nextMessageId)
    state.progress.append(round, { ...delta, delta: 'Old round' })
    state.progress.append(next, { ...delta, delta: 'Invalidated' })
    state.invalidate()
    vi.advanceTimersByTime(50)
    expect(state.events.filter(event => event.type === 'process-text').map(event => event.delta)).toEqual(['First'])
    expect(state.progress.modelRoundIsCurrent(next)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('allows only trusted executing-tool settlement after abort, and nothing after terminal', () => {
    const { progress, controller, events } = setup(), round = progress.beginRound(messageId)
    progress.append(round, delta)
    progress.closeText(); controller.abort()
    const facts = { toolCallId: 'call_1', toolName: 'edit_workspace_document', operationId: messageId,
      paths: ['notes/a.md'], displayName: null, status: 'succeeded', cached: false } as const
    const before = events.length
    progress.tool(facts)
    progress.setStage('tool-running')
    progress.append(round, delta)
    expect(events).toHaveLength(before)
    progress.tool(facts, true)
    expect(events.at(-1)).toMatchObject({ type: 'process-tool', status: 'succeeded' })
    progress.finish()
    progress.tool(facts, true)
    expect(events).toHaveLength(before + 1)
  })
  it('bounds opaque remapping while forwarding tail and returned-item progress through the wire codec and renderer', () => {
    vi.useFakeTimers()
    const events: AiProcessEvent[] = [], accepted: boolean[] = [], controller = new AbortController()
    const record = createAiProcessRecord(requestId, 0)
    let now = 0
    const progress = new AiConversationProgress({ requestId, signal: controller.signal, isCurrent: () => true,
      emit: event => {
        const parsed = parseAiConversationEvent(event)
        if (!parsed || (parsed.type !== 'process-text' && parsed.type !== 'process-stage' && parsed.type !== 'process-tool')) {
          throw new Error('Invalid process wire event')
        }
        events.push(parsed)
        accepted.push(applyAiProcessEvent(record, parsed, now))
      } })
    // Inspect the existing private Map solely to assert its memory bound, without
    // exposing a production diagnostic API or bypassing codec/lifecycle checks.
    const mappings: unknown = Reflect.get(progress, 'itemIds')
    if (!(mappings instanceof Map)) throw new Error('Missing identity map')
    beginAiProcessRound(record, messageId, now)
    const round = progress.beginRound(messageId)
    for (let index = 0; index < 2100; index++) {
      now = index * 50
      progress.append(round, { ...delta, itemId: `provider-private-${index}`, delta: `fragment-${index}` })
      vi.advanceTimersByTime(50)
      expect(mappings.size).toBeLessThanOrEqual(2048)
    }
    expect(events.filter(event => event.type === 'process-text')).toHaveLength(2100)
    expect(record.entries.at(-1)).toMatchObject({ type: 'text', text: 'fragment-2099' })
    expect(record.omitted).toBe(true)
    expect(record.lastSemanticProgressAt).toBe(now)
    expect(record.entries).toHaveLength(2048)
    expect(mappings.has('provider-private-0')).toBe(false)
    const originalId = events.find(event => event.type === 'process-text')!.itemId
    now += 20_000
    progress.append(round, { ...delta, itemId: 'provider-private-0', delta: 'returned fragment' })
    vi.advanceTimersByTime(50)
    expect(record.entries.at(-1)).toMatchObject({ type: 'text', text: 'returned fragment' })
    expect(record.lastSemanticProgressAt).toBe(now)
    expect(events.filter(event => event.type === 'process-text')).toHaveLength(2101)
    expect(events.at(-1)).toMatchObject({ type: 'process-text', delta: 'returned fragment' })
    expect(events.at(-1)).not.toMatchObject({ itemId: originalId })
    expect(mappings.size).toBe(2048)
    expect(JSON.stringify(events)).not.toContain('provider-private-')
    beginAiProcessRound(record, nextMessageId, ++now)
    const next = progress.beginRound(nextMessageId)
    expect(mappings.size).toBe(0)
    progress.append(next, delta); progress.finish()
    expect(events.filter(event => event.type === 'process-text')).toHaveLength(2102)
    expect(accepted.every(Boolean)).toBe(true)
    expect(mappings.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
