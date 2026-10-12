import { isCanonicalAiConversationRequestId, isExactOwnRecord } from './ai-conversation'
import { isPublicErrorCode, type PublicErrorCode } from './public-errors'
import { parseModelErrorDetail, type ModelErrorDetail } from './model-error-detail'
import { AI_READ_TOOL_LIMIT, AI_WRITE_TOOL_LIMIT, AI_TOOL_ROUND_LIMIT } from './ai-tool-limits'

export const AI_BUDGET_STOP_REASONS = ['read-budget', 'write-budget', 'combined-budget', 'budgets-exhausted', 'tool-rounds'] as const
export type AiBudgetStopReason = typeof AI_BUDGET_STOP_REASONS[number]
export interface AiBudgetNotExecuted { kind: 'not-executed'; reason: AiBudgetStopReason }
export interface AiBudgetCounts { readAdmitted: number; writeAdmitted: number; rejectedNewCalls: number; toolRounds: number }
export interface AiBudgetOutcomes {
  readSucceeded: number; readFailed: number; readDenied: number; readUnavailable: number
  writeSucceeded: number; writeFailed: number; writeDenied: number; writeUnavailable: number
  writeUnknown: number; notExecuted: number
}
export type AiBudgetFinalization = { status: 'completed' | 'context-limit' | 'tools-returned' }
  | { status: 'failed'; code: PublicErrorCode; detail?: ModelErrorDetail }
export interface AiBudgetPausedEvent {
  requestId: string
  type: 'budget-paused'
  transcriptRevision: number
  continuationId: string | null
  reason: AiBudgetStopReason
  counts: AiBudgetCounts
  outcomes: AiBudgetOutcomes
  finalization: AiBudgetFinalization
}

const countKeys = ['readAdmitted', 'writeAdmitted', 'rejectedNewCalls', 'toolRounds'] as const
const outcomeKeys = ['readSucceeded', 'readFailed', 'readDenied', 'readUnavailable',
  'writeSucceeded', 'writeFailed', 'writeDenied', 'writeUnavailable', 'writeUnknown', 'notExecuted'] as const
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}
function numericRecord<Key extends string>(value: unknown, keys: readonly Key[]): Readonly<Record<Key, number>> | undefined {
  if (!isExactOwnRecord(value, [...keys]) || keys.some(key => !integer(value[key]))) return undefined
  return Object.freeze(Object.fromEntries(keys.map(key => [key, value[key]]))) as Readonly<Record<Key, number>>
}
export function parseAiBudgetNotExecuted(value: unknown): AiBudgetNotExecuted | undefined {
  if (!isExactOwnRecord(value, ['kind', 'reason']) || value.kind !== 'not-executed'
    || !AI_BUDGET_STOP_REASONS.includes(value.reason as AiBudgetStopReason)) return undefined
  return Object.freeze({ kind: 'not-executed', reason: value.reason as AiBudgetStopReason })
}
function parseFinalization(value: unknown): AiBudgetFinalization | undefined {
  if (isExactOwnRecord(value, ['status']) && ['completed', 'context-limit', 'tools-returned'].includes(value.status as string)) {
    return Object.freeze({ status: value.status as 'completed' | 'context-limit' | 'tools-returned' })
  }
  if (!value || typeof value !== 'object') return undefined
  const hasDetail = Object.hasOwn(value, 'detail')
  if (!isExactOwnRecord(value, ['status', 'code', ...(hasDetail ? ['detail'] : [])])
    || value.status !== 'failed' || !isPublicErrorCode(value.code)) return undefined
  const detail = hasDetail ? parseModelErrorDetail(value.detail) : undefined
  if (detail === null) return undefined
  return Object.freeze({ status: 'failed', code: value.code, ...(detail ? { detail } : {}) })
}
export function parseAiBudgetPausedEvent(value: unknown): AiBudgetPausedEvent | undefined {
  if (!isExactOwnRecord(value, ['requestId', 'type', 'transcriptRevision', 'continuationId', 'reason', 'counts', 'outcomes', 'finalization'])
    || value.type !== 'budget-paused' || !isCanonicalAiConversationRequestId(value.requestId)
    || !integer(value.transcriptRevision) || !(value.continuationId === null || isCanonicalAiConversationRequestId(value.continuationId))
    || !AI_BUDGET_STOP_REASONS.includes(value.reason as AiBudgetStopReason)) return undefined
  const counts = numericRecord(value.counts, countKeys), outcomes = numericRecord(value.outcomes, outcomeKeys)
  const finalization = parseFinalization(value.finalization)
  if (!counts || !outcomes || !finalization || counts.readAdmitted > AI_READ_TOOL_LIMIT || counts.writeAdmitted > AI_WRITE_TOOL_LIMIT || counts.toolRounds > AI_TOOL_ROUND_LIMIT
    || outcomes.readSucceeded + outcomes.readFailed + outcomes.readDenied + outcomes.readUnavailable > counts.readAdmitted
    || outcomes.writeSucceeded + outcomes.writeFailed + outcomes.writeDenied + outcomes.writeUnavailable + outcomes.writeUnknown > counts.writeAdmitted
    || outcomes.notExecuted !== counts.rejectedNewCalls) return undefined
  return Object.freeze({ requestId: value.requestId, type: 'budget-paused', transcriptRevision: value.transcriptRevision,
    continuationId: value.continuationId, reason: value.reason as AiBudgetStopReason, counts, outcomes, finalization })
}
