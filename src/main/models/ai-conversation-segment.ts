import type { AiBudgetCounts, AiBudgetOutcomes, AiBudgetStopReason } from '../../shared/ai-budget-result'
import type { AiConversationToolFacts } from './ai-conversation-progress'
import type { AiToolBudget } from './ai-tool-budget'
import type { ModelChatMessage } from './model-protocol-client'
import type { PublicErrorCode } from '../../shared/public-errors'
import { AI_READ_TOOL_LIMIT, AI_WRITE_TOOL_LIMIT } from '../../shared/ai-tool-limits'

export type ContinuationResetReason = 'untracked-history' | 'permission-or-document-changed' | 'version-changed-or-invalid' | 'read-unavailable'
export interface AiSegmentDiagnostic {
  version: 1
  id: string
  modelFingerprint: string
  terminal: 'completed' | 'budget-paused' | 'stopped' | 'failed'
  stage: 'tools' | 'finalization'
  reason: AiBudgetStopReason | null
  code: PublicErrorCode | null
  counts: AiBudgetCounts
  outcomes: AiBudgetOutcomes
  revalidationReads: number
  resetReasons: readonly ContinuationResetReason[]
  elapsedMs: number
}
export function frozenSegmentDiagnostic(value: AiSegmentDiagnostic): Readonly<AiSegmentDiagnostic> {
  return Object.freeze({ ...value, counts: Object.freeze({ ...value.counts }), outcomes: Object.freeze({ ...value.outcomes }),
    resetReasons: Object.freeze([...value.resetReasons]) })
}
export const CONTINUATION_FRESH_READ_NOTICE: ModelChatMessage = { role: 'system', content:
  'ARKDOWN_CONTINUATION_FRESH_READ_REQUIRED_V1\n历史读取快照已失效或未能重验。旧摘要仅作历史记录；形成当前文档或目录结论前须重新读取或列目录。保留已完成及待确认的写入事实，不得自动重放写入。' }

export function budgetCounts(budget: AiToolBudget): AiBudgetCounts {
  return { readAdmitted: budget.readUsed, writeAdmitted: budget.writeUsed,
    rejectedNewCalls: budget.rejectedNewCalls, toolRounds: budget.toolRounds }
}
export function budgetOutcomes(budget: AiToolBudget, admittedIds: ReadonlySet<string>, facts: Iterable<AiConversationToolFacts>): AiBudgetOutcomes {
  const outcome: AiBudgetOutcomes = { readSucceeded: 0, readFailed: 0, readDenied: 0, readUnavailable: 0,
    writeSucceeded: 0, writeFailed: 0, writeDenied: 0, writeUnavailable: 0, writeUnknown: 0, notExecuted: budget.rejectedNewCalls }
  for (const fact of facts) {
    if (!admittedIds.has(fact.toolCallId)) continue
    const read = ['read_current_document', 'read_workspace_document', 'list_workspace_entries'].includes(fact.toolName)
    if (fact.status === 'succeeded') { if (read) outcome.readSucceeded++; else outcome.writeSucceeded++ }
    if (fact.status === 'failed') { if (read) outcome.readFailed++; else outcome.writeFailed++ }
    if (fact.status === 'denied') { if (read) outcome.readDenied++; else outcome.writeDenied++ }
    if (fact.status === 'unavailable') { if (read) outcome.readUnavailable++; else outcome.writeUnavailable++ }
    if (!read && fact.status === 'unknown') outcome.writeUnknown++
  }
  return outcome
}
export function budgetLocalClosure(reason: AiBudgetStopReason, counts: AiBudgetCounts, outcomes: AiBudgetOutcomes): Extract<ModelChatMessage, { role: 'assistant' }> {
  return { role: 'assistant',
    content: 'ARKDOWN_LOCAL_BUDGET_CLOSURE_V1\n' + JSON.stringify({ source: 'arkdown-local', reason, counts, outcomes,
      notice: '这是应用记录的预算阶段事实，不是模型生成的结论。仅已配对的工具结果可证明实际操作；未执行的调用没有执行。未读取内容尚未核查。继续必须由用户主动发起并重新检查版本与许可。' }) }
}
export function budgetSoftNotice(budget: AiToolBudget): ModelChatMessage {
  return { role: 'system', content: 'ARKDOWN_TOOL_BUDGET_NOTICE_V1\n' + JSON.stringify({
    remainingReads: AI_READ_TOOL_LIMIT - budget.readUsed, remainingWrites: AI_WRITE_TOOL_LIMIT - budget.writeUsed,
    notice: '查阅已接近本段限额。请优先汇总已有依据和尚未核查范围；读写额度分别计算，不猜测未读取内容。' }) }
}
