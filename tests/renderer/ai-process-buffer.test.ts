import { describe, expect, it } from 'vitest'
import type { AiProcessEvent, AiProcessTextEvent } from '../../src/shared/ai-process-events'
import * as buffer from '../../src/renderer/editor/ai-process-buffer'

const requestId = '550e8400-e29b-41d4-a716-000000000001'
const messageId = '550e8400-e29b-41d4-a716-000000000002'
const itemId = '550e8400-e29b-41d4-a716-000000000003'
const text = (sequence: number, delta: string, extra: Partial<AiProcessTextEvent> = {}): AiProcessTextEvent => ({
  requestId, messageId, itemId, type: 'process-text', round: 1, sequence, kind: 'reasoning-summary', segmentIndex: 0, delta, delivery: 'stream', ...extra,
})
function record() {
  const value = buffer.createAiProcessRecord(requestId, 0)
  buffer.beginAiProcessRound(value, messageId, 1)
  return value
}
const joined = (value: buffer.AiProcessRecord) => value.entries.filter(entry => entry.type === 'text').map(entry => entry.text).join('')

describe('workspace-local visible AI process buffer', () => {
  it('keeps process text separate, coalescing only adjacent identical segments', () => {
    const value = record()
    buffer.applyAiProcessEvent(value, text(1, 'first'), 10)
    buffer.applyAiProcessEvent(value, text(2, ' second'), 20)
    buffer.applyAiProcessEvent(value, text(3, 'comment', { kind: 'commentary' }), 30)
    expect(value.entries.map(entry => entry.type === 'text' ? [entry.channel, entry.text] : [])).toEqual([
      ['reasoning-summary', 'first second'], ['commentary', 'comment'],
    ])
    expect(value.lastSemanticProgressAt).toBe(30)
  })
  it('rejects foreign, duplicate, old-round and terminal text without changing semantic time', () => {
    const value = record()
    expect(buffer.applyAiProcessEvent(value, text(1, 'first'), 10)).toBe(true)
    expect(buffer.applyAiProcessEvent(value, text(1, 'duplicate'), 20)).toBe(false)
    expect(buffer.applyAiProcessEvent(value, text(2, 'foreign', { requestId: itemId }), 20)).toBe(false)
    buffer.beginAiProcessRound(value, itemId, 30)
    expect(buffer.applyAiProcessEvent(value, text(3, 'old'), 40)).toBe(false)
    expect(buffer.applyAiProcessEvent(value, text(4, 'new', { round: 2, messageId: itemId }), 50)).toBe(true)
    buffer.finishAiProcess(value, 'failed', 60)
    expect(buffer.applyAiProcessEvent(value, text(5, 'late', { round: 2, messageId: itemId }), 70)).toBe(false)
    expect(joined(value)).toBe('firstnew')
    expect(value.lastSemanticProgressAt).toBe(50)
    expect(value.outcome).toBe('failed')
  })
  it('retains the first 32KiB and last 224KiB of text with explicit omission and intact Unicode', () => {
    const value = record()
    const source = `${'头'.repeat(12_000)}${'😀中'.repeat(45_000)}TAIL`
    let sequence = 0
    // Feed valid Unicode units just as the main batcher does.
    const chars = [...source]
    for (let index = 0; index < chars.length; index += 1000) buffer.applyAiProcessEvent(value, text(++sequence, chars.slice(index, index + 1000).join('')), sequence)
    const retained = joined(value)
    expect(value.textBytes).toBeLessThanOrEqual(256 * 1024)
    expect(value.omitted).toBe(true)
    expect(retained.startsWith('头'.repeat(Math.floor(32 * 1024 / 3)))).toBe(true)
    expect(retained.endsWith('TAIL')).toBe(true)
    expect(retained).not.toContain('\ufffd')
    expect(value.entries.some(entry => entry.type === 'text' && entry.omittedBefore)).toBe(true)
  })
  it('does not keep alive a quiet stage using repeated identical stage events', () => {
    const value = record()
    const stage = (sequence: number): AiProcessEvent => ({ requestId, messageId, type: 'process-stage', round: 1, sequence, stage: 'thinking' })
    buffer.applyAiProcessEvent(value, stage(1), 10)
    buffer.applyAiProcessEvent(value, stage(2), 20_000)
    expect(value.lastSemanticProgressAt).toBe(10)
    expect(value.sequence).toBe(2)
  })
  it('updates genuine tool results once and refuses a regressive or renamed tool identity', () => {
    const value = record()
    const tool = (sequence: number, status: 'running' | 'succeeded'): AiProcessEvent => ({
      requestId, messageId, type: 'process-tool', round: 1, sequence, toolCallId: 'call_read', toolName: 'read_workspace_document', status,
      operationId: null, paths: ['docs/report.md'], displayName: null, cached: false,
    })
    buffer.applyAiProcessEvent(value, tool(1, 'running'), 10)
    buffer.applyAiProcessEvent(value, tool(2, 'succeeded'), 20)
    expect(buffer.applyAiProcessEvent(value, tool(3, 'running'), 30)).toBe(false)
    expect(value.entries).toHaveLength(1)
    expect(value.entries[0]).toMatchObject({ type: 'tool', status: 'succeeded' })
    expect(value.lastSemanticProgressAt).toBe(20)
  })
  it('preserves manual folding and unfinished facts when a request stops', () => {
    const value = record()
    value.userExpanded = true
    buffer.applyAiProcessEvent(value, text(1, 'available'), 10)
    buffer.finishAiProcess(value, 'stopped', 20)
    buffer.finishAiProcess(value, 'completed', 30)
    expect(value.outcome).toBe('stopped')
    expect(value.userExpanded).toBe(true)
    expect(joined(value)).toBe('available')
  })
  it('bounds metadata for tiny alternating segments and marks the structural omission', () => {
    const value = record()
    for (let sequence = 1; sequence <= 2500; sequence++) buffer.applyAiProcessEvent(value,
      text(sequence, String(sequence % 10), { segmentIndex: sequence }), sequence)
    expect(value.entries.length).toBeLessThanOrEqual(2048)
    expect(value.omitted).toBe(true)
    expect(joined(value).startsWith('1234567890')).toBe(true)
    expect(joined(value).endsWith('1234567890')).toBe(true)
  })
  it('evicts text from the oldest completed request before touching current or audit data', () => {
    const records: buffer.AiProcessRecord[] = []
    for (let index = 0; index < 10; index++) {
      const value = record()
      buffer.applyAiProcessEvent(value, { requestId, messageId, type: 'process-tool', round: 1, sequence: 1,
        toolCallId: 'read_complete', toolName: 'read_workspace_document', status: 'succeeded', operationId: null,
        paths: ['report.md'], displayName: null, cached: false }, 1)
      for (let n = 1; n <= 16; n++) buffer.applyAiProcessEvent(value, text(n + 1, String(index).repeat(16 * 1024)), n)
      if (index < 9) buffer.finishAiProcess(value, 'completed', 100)
      records.push(value)
    }
    buffer.enforceAiProcessSessionBudget(records)
    expect(records.reduce((sum, value) => sum + value.textBytes, 0)).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(records[0].textBytes).toBe(0)
    expect(records[0].omitted).toBe(true)
    expect(records[0].entries).toEqual([expect.objectContaining({ type: 'tool', status: 'succeeded', paths: ['report.md'] })])
    expect(records[9].textBytes).toBe(256 * 1024)
  })
})

it('retains the accepted safe recycle fact when a running delete settles failed', () => {
  const value = record()
  const running = { type: 'process-tool', requestId, messageId, round: 1, sequence: 1, toolCallId: 'call_delete', toolName: 'delete_workspace_document', operationId: itemId, paths: ['notes/a.md'], displayName: null, cached: false, status: 'running' } as const
  expect(buffer.applyAiProcessEvent(value, running, 10)).toBe(true)
  const failed = { ...running, sequence: 2, status: 'failed', reason: 'recycle-unavailable' } as const
  expect(buffer.applyAiProcessEvent(value, failed, 20)).toBe(true)
  expect(value.entries[0]).toMatchObject({ status: 'failed', reason: 'recycle-unavailable' })
  expect(buffer.applyAiProcessEvent(value, { ...running, sequence: 3 }, 30)).toBe(false)
})
