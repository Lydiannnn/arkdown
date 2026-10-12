import {
  AI_WORKSPACE_TOOL_NAMES, isCanonicalAiConversationMessageId, isCanonicalAiConversationRequestId,
  isCanonicalAiToolCallId, isCanonicalWorkspaceRelativePath, isExactOwnRecord, type AiWorkspaceToolName,
} from './ai-conversation'

export const AI_PROCESS_TEXT_MAX_BYTES = 16 * 1024
export const AI_PROCESS_KINDS = ['reasoning-text', 'reasoning-summary', 'commentary'] as const
export type AiProcessKind = typeof AI_PROCESS_KINDS[number]
export const AI_PROCESS_STAGES = ['waiting-model', 'thinking', 'answering', 'awaiting-approval', 'tool-running'] as const
export type AiProcessStage = typeof AI_PROCESS_STAGES[number]
export const AI_PROCESS_TOOL_STATUSES = ['running', 'awaiting-approval', 'succeeded', 'denied', 'unavailable', 'failed', 'unknown', 'not-executed'] as const
export type AiProcessToolStatus = typeof AI_PROCESS_TOOL_STATUSES[number]
interface AiProcessEnvelope {
  requestId: string
  messageId: string
  round: number
  sequence: number
}
export interface AiProcessTextEvent extends AiProcessEnvelope {
  type: 'process-text'
  kind: AiProcessKind
  /** Main-issued opaque segment owner; provider item IDs stay in the adapter. */
  itemId: string
  segmentIndex: number
  delta: string
  delivery: 'stream' | 'complete'
}
export interface AiProcessStageEvent extends AiProcessEnvelope { type: 'process-stage'; stage: AiProcessStage }
export interface AiProcessToolEvent extends AiProcessEnvelope {
  type: 'process-tool'
  toolCallId: string
  toolName: AiWorkspaceToolName
  status: AiProcessToolStatus
  operationId: string | null
  paths: readonly string[]
  displayName: string | null
  cached: boolean
  /** Fixed application fact, admitted only for a failed delete with a known operation. */
  reason?: 'recycle-unavailable'
}
export type AiProcessEvent = AiProcessTextEvent | AiProcessStageEvent | AiProcessToolEvent

const commonKeys = ['type', 'requestId', 'messageId', 'round', 'sequence']
function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function relativePaths(value: unknown): value is string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 2
    || Reflect.ownKeys(value).length !== value.length + 1) return false
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !isCanonicalWorkspaceRelativePath(descriptor.value)) return false
  }
  return true
}

/** Dedicated strict codec, composed by the outer conversation IPC boundary. */
export function parseAiProcessEvent(value: unknown): AiProcessEvent | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const discriminant = Object.getOwnPropertyDescriptor(value, 'type')
  if (!discriminant || !Object.hasOwn(discriminant, 'value')) return undefined
  const type: unknown = discriminant.value
  const hasReason = type === 'process-tool' && Object.hasOwn(value, 'reason')
  const extra = type === 'process-text' ? ['kind', 'itemId', 'segmentIndex', 'delta', 'delivery']
    : type === 'process-stage' ? ['stage']
      : type === 'process-tool' ? ['toolCallId', 'toolName', 'status', 'operationId', 'paths', 'displayName', 'cached', ...(hasReason ? ['reason'] : [])] : null
  if (!extra || !isExactOwnRecord(value, [...commonKeys, ...extra])
    || !isCanonicalAiConversationRequestId(value.requestId) || !isCanonicalAiConversationMessageId(value.messageId)
    || !nonNegativeInteger(value.round) || value.round === 0 || !nonNegativeInteger(value.sequence) || value.sequence === 0) return undefined
  const envelope = { requestId: value.requestId, messageId: value.messageId, round: value.round, sequence: value.sequence }
  if (type === 'process-text') {
    if (!AI_PROCESS_KINDS.includes(value.kind as AiProcessKind) || !isCanonicalAiConversationMessageId(value.itemId)
      || !nonNegativeInteger(value.segmentIndex) || typeof value.delta !== 'string' || !value.delta
      || new TextEncoder().encode(value.delta).byteLength > AI_PROCESS_TEXT_MAX_BYTES
      || (value.delivery !== 'stream' && value.delivery !== 'complete')) return undefined
    return Object.freeze({ ...envelope, type, kind: value.kind as AiProcessKind, itemId: value.itemId,
      segmentIndex: value.segmentIndex, delta: value.delta, delivery: value.delivery })
  }
  if (type === 'process-stage') {
    return AI_PROCESS_STAGES.includes(value.stage as AiProcessStage)
      ? Object.freeze({ ...envelope, type, stage: value.stage as AiProcessStage }) : undefined
  }
  if (type !== 'process-tool' || !isCanonicalAiToolCallId(value.toolCallId)
    || !AI_WORKSPACE_TOOL_NAMES.includes(value.toolName as AiWorkspaceToolName)
    || !AI_PROCESS_TOOL_STATUSES.includes(value.status as AiProcessToolStatus)
    || !relativePaths(value.paths) || typeof value.cached !== 'boolean') return undefined
  const toolName = value.toolName as AiWorkspaceToolName
  if (hasReason && (value.reason !== 'recycle-unavailable' || toolName !== 'delete_workspace_document'
    || value.status !== 'failed' || !isCanonicalAiConversationRequestId(value.operationId))) return undefined
  const mutation = !['read_current_document', 'read_workspace_document', 'list_workspace_entries'].includes(toolName)
  if (mutation) {
    const requiresOperation = ['running', 'awaiting-approval', 'succeeded', 'unknown'].includes(value.status as string)
    if (!(value.operationId === null && !requiresOperation) && !isCanonicalAiConversationRequestId(value.operationId)) return undefined
  } else if (value.operationId !== null) return undefined
  if (value.cached && (value.status === 'running' || value.status === 'awaiting-approval')) return undefined
  if (!mutation && (value.status === 'awaiting-approval' || value.status === 'unknown')) return undefined
  if (toolName === 'read_current_document') {
    if (value.paths.length !== 0 || !(value.displayName === null || typeof value.displayName === 'string'
      && !value.displayName.includes('/') && isCanonicalWorkspaceRelativePath(value.displayName))) return undefined
  } else {
    if (value.displayName !== null) return undefined
    if (toolName === 'list_workspace_entries' ? value.paths.length > 1
      : toolName === 'rename_workspace_document' ? value.paths.length !== 2 : value.paths.length !== 1) return undefined
  }
  return Object.freeze({ ...envelope, type, toolCallId: value.toolCallId, toolName,
    status: value.status as AiProcessToolStatus, operationId: value.operationId as string | null,
    paths: Object.freeze([...value.paths]), displayName: value.displayName as string | null, cached: value.cached,
    ...(hasReason ? { reason: 'recycle-unavailable' as const } : {}) })
}
