import type { AiWorkspaceToolName } from '../../shared/ai-conversation'

import { AI_READ_TOOL_LIMIT, AI_READ_TOOL_SOFT_LIMIT, AI_WRITE_TOOL_LIMIT, AI_TOOL_ROUND_LIMIT } from '../../shared/ai-tool-limits'
export { AI_READ_TOOL_LIMIT, AI_READ_TOOL_SOFT_LIMIT, AI_WRITE_TOOL_LIMIT, AI_TOOL_ROUND_LIMIT } from '../../shared/ai-tool-limits'
import type { AiBudgetStopReason } from '../../shared/ai-budget-result'
export type { AiBudgetStopReason } from '../../shared/ai-budget-result'
export interface AiToolBudget {
  readonly readUsed: number
  readonly writeUsed: number
  readonly toolRounds: number
  readonly rejectedNewCalls: number
  readonly softNoticeSent: boolean
  readonly finalizationAttempted: boolean
  readonly phase: 'tools' | 'finalizing' | 'terminal'
  readonly stopReason: AiBudgetStopReason | null
}
export interface ValidatedBudgetCall {
  readonly name: AiWorkspaceToolName
  readonly replay: boolean
}

const TOOL_CATEGORY = {
  read_current_document: 'read',
  list_workspace_entries: 'read',
  read_workspace_document: 'read',
  edit_workspace_document: 'write',
  create_workspace_document: 'write',
  rename_workspace_document: 'write',
  delete_workspace_document: 'write',
} as const satisfies Record<AiWorkspaceToolName, 'read' | 'write'>

export function createAiToolBudget(): AiToolBudget {
  return Object.freeze({ readUsed: 0, writeUsed: 0, toolRounds: 0, rejectedNewCalls: 0, softNoticeSent: false, finalizationAttempted: false, phase: 'tools', stopReason: null })
}
export function beginAiToolRound(budget: AiToolBudget): { started: boolean; budget: AiToolBudget } {
  if (budget.phase !== 'tools') return { started: false, budget }
  if (budget.toolRounds >= AI_TOOL_ROUND_LIMIT) {
    return { started: false, budget: Object.freeze({ ...budget, phase: 'finalizing', stopReason: 'tool-rounds' }) }
  }
  return { started: true, budget: Object.freeze({ ...budget, toolRounds: budget.toolRounds + 1 }) }
}

/** Pure reservation only. The caller must validate the WHOLE batch and exact cache
 * signatures first, then publish this result once before any authorization/file work.
 * Replays retain their original results; a denied new batch never relabels old writes. */
export function admitAiToolBatch(budget: AiToolBudget, calls: readonly ValidatedBudgetCall[]): { admitted: boolean; budget: AiToolBudget; requested: { read: number; write: number }; softNotice: boolean } {
  const requested = { read: 0, write: 0 }
  for (const call of calls) {
    if (!Object.hasOwn(TOOL_CATEGORY, call.name)) throw new TypeError('Unknown tool category')
    if (!call.replay) requested[TOOL_CATEGORY[call.name]] += 1
  }
  if (budget.phase !== 'tools') return { admitted: false, budget, requested, softNotice: false }
  const readExceeded = budget.readUsed + requested.read > AI_READ_TOOL_LIMIT
  const writeExceeded = budget.writeUsed + requested.write > AI_WRITE_TOOL_LIMIT
  if (readExceeded || writeExceeded) {
    const stopReason = readExceeded && writeExceeded ? 'combined-budget' : readExceeded ? 'read-budget' : 'write-budget'
    return {
      admitted: false, requested, softNotice: false,
      budget: Object.freeze({ ...budget, phase: 'finalizing', stopReason, rejectedNewCalls: budget.rejectedNewCalls + requested.read + requested.write }),
    }
  }
  const readUsed = budget.readUsed + requested.read
  const writeUsed = budget.writeUsed + requested.write
  const stopReason = readUsed === AI_READ_TOOL_LIMIT && writeUsed === AI_WRITE_TOOL_LIMIT
    ? 'budgets-exhausted' : budget.toolRounds >= AI_TOOL_ROUND_LIMIT ? 'tool-rounds' : null
  const softNotice = !stopReason && !budget.softNoticeSent && readUsed >= AI_READ_TOOL_SOFT_LIMIT
  return {
    admitted: true, requested, softNotice,
    budget: Object.freeze({ ...budget, readUsed, writeUsed, stopReason, phase: stopReason ? 'finalizing' : 'tools', softNoticeSent: budget.softNoticeSent || softNotice }),
  }
}
export function claimAiFinalization(budget: AiToolBudget): { started: boolean; budget: AiToolBudget } {
  if (budget.phase !== 'finalizing' || budget.finalizationAttempted) return { started: false, budget }
  return { started: true, budget: Object.freeze({ ...budget, finalizationAttempted: true }) }
}
export function finishAiToolBudget(budget: AiToolBudget): AiToolBudget {
  return budget.phase === 'terminal' ? budget : Object.freeze({ ...budget, phase: 'terminal' })
}
