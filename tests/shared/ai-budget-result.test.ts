import { describe, expect, it } from 'vitest'
import { parseAiBudgetPausedEvent } from '../../src/shared/ai-budget-result'
import { AI_WORKSPACE_TOOL_NAMES, parseAiConversationEvent, parseCurrentDocumentToolResult,
  parseStartAiConversationInput, parseWorkspaceToolResult } from '../../src/shared/ai-conversation'

const requestId = '550e8400-e29b-41d4-a716-446655440004'
const continuationId = '550e8400-e29b-41d4-a716-446655440005'
function event() {
  return { requestId, type: 'budget-paused', transcriptRevision: 3, continuationId, reason: 'read-budget',
    counts: { readAdmitted: 63, writeAdmitted: 1, rejectedNewCalls: 2, toolRounds: 12 },
    outcomes: { readSucceeded: 60, readFailed: 1, readDenied: 1, readUnavailable: 1,
      writeSucceeded: 1, writeFailed: 0, writeDenied: 0, writeUnavailable: 0, writeUnknown: 0, notExecuted: 2 },
    finalization: { status: 'completed' } }
}
describe('finite budget segment wire contract', () => {
  it('carries truthful admitted and confirmed outcomes through the outer event codec', () => {
    expect(parseAiBudgetPausedEvent(event())).toEqual(event())
    expect(parseAiConversationEvent(event())).toEqual(event())
    expect(Object.isFrozen(parseAiBudgetPausedEvent(event())!.counts)).toBe(true)
  })
  it('accepts the new maximum counters through both event codecs', () => {
    const value = { ...event(), reason: 'budgets-exhausted', counts: { readAdmitted: 256, writeAdmitted: 16, rejectedNewCalls: 0, toolRounds: 80 },
      outcomes: { ...event().outcomes, readSucceeded: 253, writeSucceeded: 15, writeUnknown: 1, notExecuted: 0 } }
    expect(parseAiBudgetPausedEvent(value)).toEqual(value)
    expect(parseAiConversationEvent(value)).toEqual(value)
    expect(parseAiBudgetPausedEvent({ ...value, outcomes: { ...value.outcomes, writeSucceeded: 16 } })).toBeUndefined()
  })
  it.each(['context-limit', 'tools-returned'] as const)('preserves local fallback reason %s without pretending provider success', status => {
    expect(parseAiBudgetPausedEvent({ ...event(), continuationId: null, finalization: { status } }))
      .toMatchObject({ continuationId: null, finalization: { status } })
  })
  it('accepts only finite failure detail and no prose on a failed finalizer', () => {
    const failure = { status: 'failed', code: 'MODEL_TIMEOUT', detail: { version: 1, reason: 'timeout', source: 'local', stage: 'receive' } }
    expect(parseAiBudgetPausedEvent({ ...event(), finalization: failure })?.finalization).toEqual(failure)
    expect(parseAiBudgetPausedEvent({ ...event(), finalization: { ...failure, message: 'private provider output' } })).toBeUndefined()
    expect(parseAiBudgetPausedEvent({ ...event(), finalization: { ...failure, detail: 'secret' } })).toBeUndefined()
    expect(parseAiBudgetPausedEvent({ ...event(), finalization: { status: 'completed', code: 'MODEL_TIMEOUT' } })).toBeUndefined()
  })
  it('rejects unsafe counts, impossible outcome totals and hidden/executable data', () => {
    for (const counts of [{ ...event().counts, readAdmitted: 257 }, { ...event().counts, writeAdmitted: 17 },
      { ...event().counts, toolRounds: 81 }, { ...event().counts, rejectedNewCalls: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(parseAiBudgetPausedEvent({ ...event(), counts })).toBeUndefined()
    }
    expect(parseAiBudgetPausedEvent({ ...event(), outcomes: { ...event().outcomes, readSucceeded: 64 } })).toBeUndefined()
    expect(parseAiBudgetPausedEvent({ ...event(), outcomes: { ...event().outcomes, notExecuted: 1 } })).toBeUndefined()
    expect(parseAiBudgetPausedEvent({ ...event(), path: 'private.md' })).toBeUndefined()
    const getter = { ...event() }; Object.defineProperty(getter, 'counts', { get() { throw new Error('must not run') } })
    expect(parseAiBudgetPausedEvent(getter)).toBeUndefined()
  })
  it('pairs every supported tool without allowing a current-document port to fabricate a budget decision', () => {
    for (const tool of AI_WORKSPACE_TOOL_NAMES) {
      expect(parseWorkspaceToolResult(tool, { kind: 'not-executed', reason: 'combined-budget' }))
        .toEqual({ kind: 'not-executed', reason: 'combined-budget' })
      expect(parseWorkspaceToolResult(tool, { kind: 'not-executed', reason: 'unknown', path: 'private' })).toBeUndefined()
    }
    expect(parseCurrentDocumentToolResult({ kind: 'not-executed', reason: 'read-budget' })).toBeUndefined()
  })
  it('accepts only an opaque continuation identity in the existing start delta', () => {
    const input = { requestId, conversationId: continuationId, workspaceKey: 'workspace-a', acknowledgedTranscriptRevision: 3,
      messages: [{ id: '550e8400-e29b-41d4-a716-446655440006', role: 'user', content: '继续分析' }],
      capabilities: { currentDocument: false, workspace: true }, writePolicy: 'ask-every-time', continuationOfSegmentId: continuationId }
    expect(parseStartAiConversationInput(input)).toEqual(input)
    expect(parseStartAiConversationInput({ ...input, continuationOfSegmentId: '../private' })).toBeUndefined()
    expect(parseStartAiConversationInput({ ...input, retainedContext: [] })).toBeUndefined()
  })
})
