import { createModelReasoningTimer } from './model-reasoning-timer'
import { AiConversationProgress, type AiConversationToolFacts } from './ai-conversation-progress'
import { parseModelErrorDetail } from '../../shared/model-error-detail'
import type { AiBudgetFinalization } from '../../shared/ai-budget-result'
import { AI_READ_TOOL_LIMIT } from '../../shared/ai-tool-limits'
import { admitAiToolBatch, beginAiToolRound, claimAiFinalization, createAiToolBudget, finishAiToolBudget, type AiToolBudget } from './ai-tool-budget'
import { budgetCounts, budgetLocalClosure, budgetOutcomes, budgetSoftNotice, CONTINUATION_FRESH_READ_NOTICE,
  frozenSegmentDiagnostic, type AiSegmentDiagnostic, type ContinuationResetReason } from './ai-conversation-segment'
import { createHash, randomUUID } from 'node:crypto'
import {
  AI_CONVERSATION_DELTA_CHUNK_MAX_BYTES,
  AI_STALE_TARGET_GUIDANCE,
  AI_RECYCLE_UNAVAILABLE_GUIDANCE,
  AI_WORKSPACE_TOOL_NAMES,
  isCanonicalAiConversationRequestId,
  isCanonicalAiToolCallId,
  isCanonicalWorkspaceRelativePath,
  parseAiConversationEvent,
  parseAiFileVersion,
  parseWorkspaceToolArguments,
  parseWorkspaceToolResult,
  type AiAuthorizationScope,
  type AiConversationCapabilities,
  type AiConversationEvent,
  type AiConversationVisibleMessage,
  type AiConversationUserMessage,
  type AiContextCompactionRecord,
  type AiCurrentDocumentToolArguments,
  type AiCurrentDocumentToolResult,
  type AiFileVersion,
  type AiMutationToolName,
  type AiOperationManifest,
  type AiWorkspaceToolArguments,
  type AiWorkspaceDirectoryVersion,
  type AiWorkspaceToolName,
  type AiWorkspaceToolResult,
  type ModelUsage,
  type StartAiConversationInput,
} from '../../shared/ai-conversation'
import type { AiWritePolicy, ModelConnectionSummary, ReasoningEffort, ThinkingMode } from '../../shared/large-model-settings'
import type { ModelCapabilityProfile } from '../../shared/model-capability-profiles'
import { PUBLIC_ERROR_MESSAGES, PublicError, type PublicErrorCode } from '../../shared/public-errors'
import type {
  AiConversationModelSelectionSnapshot,
  AiConversationModelSelectionSource,
  AiConversationWritePolicySnapshot,
  AiConversationWritePolicySource,
  SettingsUpdater,
} from '../settings/settings-coordinator'
import { AiOperationOutcomeUnknownError } from '../workspace/ai-operation-journal'
import {
  WorkspaceAiFileError,
  type WorkspaceAiFileService,
  type WorkspaceAiMutationExecution,
  type WorkspaceRootCapability,
} from '../workspace/workspace-ai-file-service'
import {
  normalRequestedOutputTokens,
  resolveAiConversationProfile,
  contextUsageSnapshot,
  createAiWireLineage,
  estimateTextTokens,
  estimateWireTokens,
  type AiContextUsageBaseline,
} from './ai-context-budget'
import {
  compactWireContext,
  segmentCompleteTransactions,
  wireContextMessages,
  type AiWireContext,
  type AiCompactionResult,
} from './ai-context-compactor'
import {
  AI_CONVERSATION_SYSTEM_PROMPT,
  AI_WORKSPACE_TOOLS,
} from './ai-conversation-prompts'
import { ModelProtocolError } from './model-errors'
import type {
  ModelChatInput,
  ModelChatMessage,
  ModelProtocolClient,
  ModelToolCall,
  ModelToolDefinition,
} from './model-protocol-client'
import { MODEL_REQUEST_INITIAL_INACTIVITY_TIMEOUT_MS } from './model-protocol-client'
import type { ModelConnectionCredentialSnapshot, ModelConnectionService } from './model-connection-service'
import { ModelSecretVaultError } from './model-secret-vault'
import type { SettingsAuthority } from '../settings/settings-authority'
import type { SettingsTransactionSnapshot } from '../settings/settings-transaction-types'
import { CONNECTION_TEST_FIELDS } from '../settings/settings-transaction-schema'
import { observeModelSettings } from '../settings/settings-command-adapter'
import { SettingsStorageError } from '../settings/settings-transaction-files'
import { DEFAULT_LARGE_MODEL_SETTINGS, isCodexCliConnection, type LargeModelSettings } from '../../shared/large-model-settings'

function authoritativeAiSnapshots(snapshot: SettingsTransactionSnapshot): {
  model: AiConversationModelSelectionSnapshot; policy: AiConversationWritePolicySnapshot
} {
  const models = snapshot.settings.models ?? DEFAULT_LARGE_MODEL_SETTINGS
  const selected = models.aiConversation
  const fields = snapshot.fieldRevisions.fields
  const revisions = snapshot.fieldRevisions.connections[selected.connectionId ?? '']
  const standardConnection = models.connections.some(connection => connection.id === selected.connectionId)
  const connectionRevisions = standardConnection
    ? [...CONNECTION_TEST_FIELDS.map(field => revisions?.[field] ?? 0), revisions?.credential ?? 0]
    : selected.connectionId === null ? [] : [fields['models.codexCli'] ?? 0]
  return {
    model: { connectionId: selected.connectionId, thinkingMode: selected.thinkingMode, reasoningEffort: selected.reasoningEffort,
      revision: Math.max(0, ...['connectionId', 'thinkingMode', 'reasoningEffort'].map(field => fields[`models.aiConversation.${field}`] ?? 0), ...connectionRevisions) },
    policy: { policy: selected.writePolicy, revision: fields['models.aiConversation.writePolicy'] ?? 0 },
  }
}

const AUTHORIZATION_TIMEOUT_MS = 60_000
const PROVIDER_ENVELOPE_ESTIMATE_TOKENS = 64
const LOCAL_RECOVERY_MESSAGE_PREFIX = 'ARKDOWN_LOCAL_RECOVERY_V1\n'
const LOCAL_RECOVERY_MESSAGE_MAX_BYTES = 16_384
const LOCAL_RECOVERY_OPERATION_LIMIT = 8
const LOCAL_RECOVERY_INSTRUCTION = '上一工具事务已在本地结束，勿重放。再次依赖相关文件或修改前，重新读取受影响的相对路径。未知结果及 completedOperationIds 不代表操作成功。'
const LOCAL_RECOVERY_AUTHORITY_REQUEST = 'ARKDOWN_LOCAL_RECOVERY_AUTHORITY_V1: report the trusted local terminal state of the discarded provider tool transaction.'
const LOCAL_TRANSCRIPT_CONTINUATION = 'ARKDOWN_LOCAL_TRANSCRIPT_CONTINUATION_V1: continue the preserved visible transcript.'
const DOCUMENT_CHANGED_NOTICE: ModelChatMessage = { role: 'system', content: '当前文档已改变，本次任务如依赖其内容，请重新读取。' }

export const AI_WORKSPACE_WRITE_AUTHORIZATION_PROMPT = '允许当前会话内AI对工作区文档进行编辑与操作。'

export interface AiConversationEventSink {
  emit(event: AiConversationEvent): void
}

function localCompactionRecord(
  result: AiCompactionResult,
  profile: ModelCapabilityProfile | undefined,
): AiContextCompactionRecord | undefined {
  if (result.status === 'error') return { status: 'failed' }
  if (result.status !== 'compacted' || profile === undefined) return undefined
  return {
    status: 'compacted', beforeTokens: result.before, afterTokens: result.after,
    contextWindowTokens: profile.contextWindowTokens,
  }
}

export type WorkspaceAiFileBoundary = Pick<
  WorkspaceAiFileService,
  'getRootCapability' | 'listEntries' | 'readDocument'
  | 'planEdit' | 'planCreate' | 'planRename' | 'planDelete'
  | 'authorize' | 'abandon' | 'executeAuthorized'
> & Partial<Pick<WorkspaceAiFileService, 'isPlannedEditorEdit' | 'getWorkspaceSwitchSourceCapability'>>

/** Main-owned document selection, never supplied by model or renderer request data. */
export interface AiCurrentDocumentWriteAuthority {
  readonly path: string
  readonly session: number
}

export interface AiCurrentDocumentSnapshot {
  readPage(input: AiCurrentDocumentToolArguments, signal: AbortSignal): Promise<AiCurrentDocumentToolResult>
  release(): void | Promise<void>
}

export interface AiCurrentDocumentSource {
  openSnapshot(input: {
    expectedDocumentId?: string
    requestId: string
    conversationId: string
    workspaceId: string
    workspaceGeneration: string
    toolCallId: string
    signal: AbortSignal
  }): Promise<AiCurrentDocumentSnapshot | null>
}

export interface SubmitAiAuthorizationResultInput {
  requestId: string
  operationId: string
  allowed: boolean
}

export interface SetAiConversationCapabilitiesInput {
  ownerId: number
  workspaceId: string
  workspaceGeneration: string
  conversationId: string
  capabilities: AiConversationCapabilities
}

/** Opaque, main-process authority for exactly one prepared workspace transition. */
export interface AiWorkspaceSwitchTicket {
  readonly generation: number
  readonly nonce: string
}

/** Main-only close reservation. Stopping never means an executing write rolled back. */
export interface AiConversationCloseTicket {
  readonly hasRunningWork: boolean
  stopAndDrain(): Promise<void>
  resume(): Promise<void>
}

interface RequestBinding {
  ownerId: number
  conversationId: string
  workspaceId: string
  workspaceGeneration: string
}

/** Process-lifetime collision registry. Request IDs correlate events; they grant no authority. */
export class AiConversationRequestRegistry {
  private readonly bindings = new Map<string, RequestBinding>()

  reserve(requestId: string, binding: RequestBinding): boolean {
    if (!isCanonicalAiConversationRequestId(requestId) || this.bindings.has(requestId)) return false
    this.bindings.set(requestId, Object.freeze({ ...binding }))
    return true
  }

  owns(requestId: string, binding: RequestBinding): boolean {
    const current = this.bindings.get(requestId)
    return current !== undefined
      && current.ownerId === binding.ownerId
      && current.conversationId === binding.conversationId
      && current.workspaceId === binding.workspaceId
      && current.workspaceGeneration === binding.workspaceGeneration
  }
}

const DEFAULT_AI_CONVERSATION_REQUEST_REGISTRY = new AiConversationRequestRegistry()

interface PendingAuthorization {
  manifest: AiOperationManifest
  scope: AiAuthorizationScope
  toolCallId: string
  timer: ReturnType<typeof setTimeout>
  settled: boolean
  policySnapshot: AiConversationWritePolicySnapshot
  resolve(allowed: boolean): void
}

interface CachedToolResult {
  signature: string
  message: Extract<ModelChatMessage, { role: 'tool' }>
  process?: AiConversationToolFacts
}

type ContinuationReadObservation =
  | { kind: 'directory'; path: string; version: AiWorkspaceDirectoryVersion }
  | { kind: 'document'; path: string; version: AiFileVersion }
  | { kind: 'current'; expectedDocumentId: string | undefined; documentEpoch: number; version: AiFileVersion }
interface PausedBudgetSegment {
  id: string
  binding: RequestBinding
  rootCapability: WorkspaceRootCapability
  transcriptRevision: number
  profileFingerprint: string
  reads: ReadonlyMap<string, ContinuationReadObservation>
  untrackedHistoricalReads: boolean
  writeReceipts: ReadonlyMap<string, CachedToolResult>
}

interface WorkspaceSession {
  pausedBudgetSegment: PausedBudgetSegment | null
  workspaceId: string
  workspaceGeneration: string
  conversationId: string
  capabilities: AiConversationCapabilities
  capabilityRevision: number
  context: AiWireContext
  usageBaseline: AiContextUsageBaseline | null
  visibleMessages: AiConversationVisibleMessage[]
  transcriptRevision: number
  committedDocumentEpoch: number
  documentGrants: Map<string, number>
  workspaceGrant: { workspaceGeneration: string; policyRevision: number } | null
  observedWritePolicy: AiWritePolicy
  observedWritePolicyRevision: number
  modelFingerprint: string | null
  unknownPathBarriers: Map<string, { operationId: string; reconciled: boolean }>
  unknownIdentityBarriers: Map<string, { operationId: string; reconciled: boolean }>
  terminalMutationIds: Set<string>
  recoveryPending: boolean
  recoveryModelFingerprint: string | null
  mutationRecoveries: Map<string, {
    requestId: string
    assistant: Extract<ModelChatMessage, { role: 'assistant' }>
    contextBeforeTools: AiWireContext
    tools: Map<string, {
      operationId: string
      message: Extract<ModelChatMessage, { role: 'tool' }>
    }>
  }>
}

interface ActiveConversation {
  segmentStartedAt: number
  segmentErrorCode: PublicErrorCode | null
  continuationResetReasons: readonly ContinuationResetReason[]
  budgetProfileFingerprint: string
  continuationReads: Map<string, ContinuationReadObservation>
  untrackedHistoricalReads: boolean
  continuationReadReset: boolean
  revalidationReads: number
  budget: AiToolBudget
  budgetAdmittedIds: Set<string>
  budgetSoftNoticePending: boolean
  budgetFallbackContext: AiWireContext | null
  budgetPaused: boolean
  progress: AiConversationProgress
  processTools: Map<string, { facts: AiConversationToolFacts; terminal: boolean }>
  requestId: string
  startGeneration: number
  binding: RequestBinding
  rootCapability: WorkspaceRootCapability
  modelSelection: AiConversationModelSelectionSnapshot
  session: WorkspaceSession
  capabilities: AiConversationCapabilities
  controller: AbortController
  pendingAuthorizations: Map<string, PendingAuthorization>
  authorizedNotExecuting: Map<string, AiOperationManifest>
  planning: Set<Promise<unknown>>
  executing: Set<Promise<unknown>>
  currentDocumentSnapshot: AiCurrentDocumentSnapshot | null
  currentDocumentEpoch: number | null
  submittedDocumentEpoch: number
  expectedDocumentId: string | null | undefined
  currentDocumentWriteAuthority: AiCurrentDocumentWriteAuthority | null
  currentDocumentSeriesStarted: boolean
  currentDocumentVersion: AiFileVersion | null
  workspaceReadVersions: Map<string, AiFileVersion>
  workspaceReadSeriesStarted: Set<string>
  toolResults: Map<string, CachedToolResult>
  seenToolCallIds: Set<string>
  stopped: boolean
  completed: boolean
  rollbackContext: AiWireContext
  rollbackDocumentEpoch: number
  mutationTerminalCommitted: boolean
  currentAssistant: Extract<ModelChatMessage, { role: 'assistant' }> | null
  currentAssistantMessageId: string | null
  currentAssistantToolBaseline: AiWireContext | null
  recoveryRestored: boolean
  recoveryUsesLocalClosure: boolean
  pendingUser: AiConversationUserMessage | null
  documentChanged: boolean
}

interface PendingStart {
  requestId: string
  generation: number | null
  controller: AbortController
  completion: Promise<void>
  complete(): void
}

interface WorkspaceSwitchState {
  readonly ticket: AiWorkspaceSwitchTicket
  source: WorkspaceRootCapability | undefined
  phase: 'preparing' | 'prepared' | 'activating'
}

const MODEL_PROTOCOL_PUBLIC_CODES = {
  'authentication-failed': 'MODEL_AUTHENTICATION_FAILED',
  'model-not-found': 'MODEL_NOT_FOUND',
  'invalid-endpoint': 'MODEL_INVALID_ENDPOINT',
  timeout: 'MODEL_TIMEOUT',
  'rate-limited': 'MODEL_RATE_LIMITED',
  'quota-exceeded': 'MODEL_QUOTA_EXCEEDED',
  'incompatible-response': 'MODEL_INCOMPATIBLE_RESPONSE',
} as const satisfies Record<ModelProtocolError['status'], PublicErrorCode>

function modelPublicErrorCode(error: unknown): PublicErrorCode | undefined {
  if (error instanceof SettingsStorageError) {
    if (error.code === 'SETTINGS_TRANSACTION_CONNECTION_MISSING') return 'AI_MODEL_NOT_CONFIGURED'
    if (error.code === 'SETTINGS_TRANSACTION_CREDENTIAL_REQUIRED') return 'MODEL_SECRET_UNAVAILABLE'
    if (error.code === 'SETTINGS_TRANSACTION_AUTHORITY_CHANGED') return 'OPERATION_FAILED'
    return 'MODEL_SECRET_STORAGE_FAILED'
  }
  if (error instanceof ModelProtocolError) return MODEL_PROTOCOL_PUBLIC_CODES[error.status]
  if (!(error instanceof ModelSecretVaultError)) return undefined
  switch (error.code) {
    case 'INVALID_CONNECTION_ID': return 'INVALID_INPUT'
    case 'ENCRYPTION_UNAVAILABLE': return 'MODEL_ENCRYPTION_UNAVAILABLE'
    case 'DECRYPTION_FAILED': return 'MODEL_SECRET_UNAVAILABLE'
    case 'VAULT_MALFORMED':
    case 'VAULT_READ_FAILED':
    case 'VAULT_WRITE_FAILED': return 'MODEL_SECRET_STORAGE_FAILED'
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

class CurrentDocumentReleaseAuthorityError extends Error {
  constructor() {
    super('The current-document snapshot authority changed during release')
    this.name = 'AbortError'
  }
}

function incompatibleResponse(): ModelProtocolError {
  return new ModelProtocolError('incompatible-response')
}

function invalidToolResponse(reason: 'tool-invalid-name' | 'tool-invalid-identity' | 'tool-invalid-arguments'): ModelProtocolError {
  return new ModelProtocolError('incompatible-response', undefined, { version: 1, reason, stage: 'tool-validation', source: 'local' })
}

function deltaChunks(delta: string): string[] {
  if (new TextEncoder().encode(delta).byteLength <= AI_CONVERSATION_DELTA_CHUNK_MAX_BYTES) return [delta]
  const chunks: string[] = []
  let chunk = ''
  let size = 0
  for (const character of delta) {
    const length = new TextEncoder().encode(character).byteLength
    if (size + length > AI_CONVERSATION_DELTA_CHUNK_MAX_BYTES) {
      chunks.push(chunk)
      chunk = ''
      size = 0
    }
    chunk += character
    size += length
  }
  if (chunk !== '') chunks.push(chunk)
  return chunks
}

function modelFingerprint(
  connection: ModelConnectionSummary,
  reasoningEffort: ReasoningEffort,
  thinkingMode: ThinkingMode,
): string {
  return JSON.stringify([
    connection.id, connection.provider, connection.protocol, connection.baseUrl,
    connection.modelId, connection.capabilityOverride, reasoningEffort, thinkingMode,
  ])
}

function emptyContext(): AiWireContext {
  return {
    lineage: createAiWireLineage(),
    checkpoint: null,
    transactions: [],
    openTransaction: [],
  }
}

function appendMessages(context: AiWireContext, messages: readonly ModelChatMessage[]): AiWireContext {
  if (messages.length === 0) return context
  const current = [
    ...context.transactions.flatMap((transaction) => transaction.messages),
    ...context.openTransaction,
    ...messages,
  ]
  const segmented = segmentCompleteTransactions(current)
  return {
    lineage: context.lineage,
    checkpoint: context.checkpoint,
    transactions: segmented.transactions,
    openTransaction: segmented.openTransaction,
  }
}

function cloneSession(session: WorkspaceSession): WorkspaceSession {
  return {
    ...session,
    capabilities: { ...session.capabilities },
    context: {
      ...session.context,
      transactions: [...session.context.transactions],
      openTransaction: [...session.context.openTransaction],
    },
    visibleMessages: session.visibleMessages.map((message) => ({ ...message })),
    documentGrants: new Map(session.documentGrants),
    workspaceGrant: session.workspaceGrant === null ? null : { ...session.workspaceGrant },
    unknownPathBarriers: new Map([...session.unknownPathBarriers].map(([key, value]) => [key, { ...value }])),
    unknownIdentityBarriers: new Map([...session.unknownIdentityBarriers].map(([key, value]) => [key, { ...value }])),
    terminalMutationIds: new Set(session.terminalMutationIds),
    mutationRecoveries: new Map(session.mutationRecoveries),
  }
}

type LocalRecoveryState = 'succeeded' | 'failed' | 'unknown'

interface LocalRecoveryOperation {
  operationId: string
  state: LocalRecoveryState
  paths: string[]
  pathsComplete: boolean
}

function localRecoveryOperations(session: WorkspaceSession, includeCompleted = false): LocalRecoveryOperation[] {
  const operations = new Map<string, LocalRecoveryOperation>()
  const messages = includeCompleted
    ? [...session.context.transactions.flatMap((transaction) => transaction.messages), ...session.context.openTransaction]
    : session.context.openTransaction
  for (const message of messages) {
    if (message.role !== 'tool'
      || !AI_WORKSPACE_TOOL_NAMES.includes(message.name as AiWorkspaceToolName)) continue
    let raw: unknown
    try { raw = JSON.parse(message.content) } catch { continue }
    const parsed = parseWorkspaceToolResult(message.name as AiWorkspaceToolName, raw)
    if (parsed?.kind !== 'mutation'
      || (parsed.state !== 'succeeded' && parsed.state !== 'failed' && parsed.state !== 'unknown')) continue
    operations.set(parsed.operationId, {
      operationId: parsed.operationId,
      state: parsed.state,
      paths: parsed.paths.filter(isCanonicalWorkspaceRelativePath),
      pathsComplete: parsed.paths.every(isCanonicalWorkspaceRelativePath),
    })
  }

  const barrierPaths = new Map<string, string[]>()
  for (const [path, barrier] of session.unknownPathBarriers) {
    if (!isCanonicalWorkspaceRelativePath(path)) continue
    const paths = barrierPaths.get(barrier.operationId) ?? []
    if (!paths.includes(path)) paths.push(path)
    barrierPaths.set(barrier.operationId, paths)
  }
  for (const [operationId, paths] of barrierPaths) {
    const prior = operations.get(operationId)
    operations.set(operationId, {
      operationId,
      state: 'unknown',
      paths: [...new Set([...(prior?.paths ?? []), ...paths])],
      pathsComplete: prior?.pathsComplete ?? true,
    })
  }
  for (const operationId of session.terminalMutationIds) {
    if (!operations.has(operationId)) {
      operations.set(operationId, {
        operationId, state: 'unknown', paths: [], pathsComplete: false,
      })
    }
  }
  return [...operations.values()]
}

function completedRecoveryOperationIds(
  session: WorkspaceSession,
  operations: readonly LocalRecoveryOperation[],
): string[] {
  const completed = new Set(session.context.checkpoint?.completedOperationIds ?? [])
  for (const transaction of session.context.transactions) {
    for (const operationId of transaction.completedOperationIds) completed.add(operationId)
  }
  for (const operation of operations) {
    if (operation.state === 'succeeded' || operation.state === 'unknown') {
      completed.add(operation.operationId)
    }
  }
  for (const operationId of session.terminalMutationIds) completed.add(operationId)
  return [...completed]
}

function providerNeutralVisibleMessages(
  visibleMessages: readonly AiConversationVisibleMessage[],
): ModelChatMessage[] {
  const messages: ModelChatMessage[] = []
  let hasUnansweredUser = false
  for (const message of visibleMessages) {
    if (message.role === 'user') {
      if (hasUnansweredUser) messages.push({ role: 'assistant', content: '' })
      messages.push({ role: 'user', content: message.content })
      hasUnansweredUser = true
      continue
    }
    if (!hasUnansweredUser) {
      messages.push({ role: 'user', content: LOCAL_TRANSCRIPT_CONTINUATION })
    }
    messages.push({ role: 'assistant', content: message.content })
    hasUnansweredUser = false
  }
  if (hasUnansweredUser) messages.push({ role: 'assistant', content: '' })
  return messages
}

function localRecoveryMessage(
  operations: readonly LocalRecoveryOperation[],
  maxBytes = LOCAL_RECOVERY_MESSAGE_MAX_BYTES,
): string {
  const selected = operations.slice(0, LOCAL_RECOVERY_OPERATION_LIMIT).map((operation) => ({
    operationId: operation.operationId,
    state: operation.state,
    paths: [] as string[],
    pathsOmitted: !operation.pathsComplete,
  }))
  const payload = {
    version: 1,
    instruction: LOCAL_RECOVERY_INSTRUCTION,
    operationsOmitted: operations.length > selected.length,
    operations: selected,
  }
  for (let index = 0; index < selected.length; index += 1) {
    const source = operations[index]!
    const target = selected[index]!
    for (const path of source.paths) {
      target.paths.push(path)
      const content = LOCAL_RECOVERY_MESSAGE_PREFIX + JSON.stringify(payload)
      if (new TextEncoder().encode(content).byteLength <= maxBytes) continue
      target.paths.pop()
      target.pathsOmitted = true
    }
  }
  return LOCAL_RECOVERY_MESSAGE_PREFIX + JSON.stringify(payload)
}

function sameVersion(left: AiFileVersion, right: AiFileVersion): boolean {
  return left.fileId === right.fileId && left.revision === right.revision
    && left.size === right.size && left.mtimeMs === right.mtimeMs
}

function sameDirectoryVersion(left: AiWorkspaceDirectoryVersion, right: AiWorkspaceDirectoryVersion): boolean {
  return left.workspaceGeneration === right.workspaceGeneration
    && left.directoryId === right.directoryId && left.revision === right.revision
}

function validDocumentPageEcho(
  request: AiCurrentDocumentToolArguments,
  page: Pick<Extract<AiCurrentDocumentToolResult, { kind: 'document' }>,
    'cursor' | 'content' | 'nextCursor' | 'hasMore' | 'totalChars'>,
): boolean {
  const expectedNext = request.cursor + page.content.length
  return hasValidSurrogatePairs(page.content)
    && page.cursor === request.cursor && page.content.length <= request.maxChars
    && page.totalChars >= expectedNext
    && page.hasMore === (page.nextCursor !== null)
    && (page.nextCursor === null ? expectedNext === page.totalChars : page.nextCursor === expectedNext)
}

function hasValidSurrogatePairs(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const trailing = value.charCodeAt(index + 1)
      if (!(trailing >= 0xDC00 && trailing <= 0xDFFF)) return false
      index += 1
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) return false
  }
  return true
}

function windowsPathKey(relativePath: string): string {
  return relativePath.normalize('NFC').toLocaleLowerCase('en-US')
}

function lowestReasoningEffort(profile: ModelCapabilityProfile): ReasoningEffort {
  const order: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
  return order.find((value) => profile.supportedReasoningEfforts.includes(value))
    ?? profile.defaultReasoningEffort
}

function toolsFor(capabilities: AiConversationCapabilities): readonly ModelToolDefinition[] {
  return AI_WORKSPACE_TOOLS.filter((tool) => (
    tool.name === 'read_current_document' ? capabilities.currentDocument : capabilities.workspace
  ))
}

function fixedInputTokens(tools: readonly ModelToolDefinition[]): number {
  return estimateWireTokens([{ role: 'system', content: AI_CONVERSATION_SYSTEM_PROMPT }])
    + estimateTextTokens(JSON.stringify(tools))
    + PROVIDER_ENVELOPE_ESTIMATE_TOKENS
}

function toolMessage(call: ModelToolCall, value: unknown, isError = false): Extract<ModelChatMessage, { role: 'tool' }> {
  return {
    role: 'tool',
    toolCallId: call.id,
    name: call.name,
    content: JSON.stringify(value),
    isError,
  }
}

function toolSignature(call: ModelToolCall): string {
  return `${call.name}\0${call.argumentsJson}`
}

function idempotencyKey(active: ActiveConversation, call: ModelToolCall): string {
  return createHash('sha256')
    .update(active.requestId).update('\0').update(call.id).update('\0')
    .update(call.name).update('\0').update(call.argumentsJson)
    .digest('hex')
}

function sameRootCapability(first: WorkspaceRootCapability, second: WorkspaceRootCapability): boolean {
  return first.windowId === second.windowId
    && first.workspaceId === second.workspaceId
    && first.rootGeneration === second.rootGeneration
    && first.workspaceGeneration === second.workspaceGeneration
    && first.rootFinalPath === second.rootFinalPath
    && first.rootVolumeSerial === second.rootVolumeSerial
    && first.rootFileId === second.rootFileId
}

function copyRootCapability(capability: WorkspaceRootCapability): WorkspaceRootCapability {
  return Object.freeze({ ...capability })
}

export class AiConversationSessionService {
  private closeAdmission: AiConversationCloseTicket | undefined

  beginCloseAdmission(): AiConversationCloseTicket {
    this.assertUsable()
    if (this.closeAdmission) return this.closeAdmission
    let drain: Promise<void> | undefined
    let restoration: Promise<void> | undefined
    const ticket: AiConversationCloseTicket = Object.freeze({
      hasRunningWork: this.pendingStartCompletions.size > 0 || this.activeCompletions.size > 0
        || this.documentReleaseCompletions.size > 0 || this.workspaceSwitchCompletions.size > 0,
      stopAndDrain: () => {
        if (drain) return drain
        if (this.closeAdmission !== ticket || this.disposed) return Promise.reject(new PublicError('OPERATION_FAILED'))
        this.invalidatePendingStarts()
        drain = (async () => {
          const stopped = await Promise.allSettled([this.stopActiveAndDrain()])
          // Cancellation is only a signal: wait for all provider/preflight,
          // execution, and snapshot-release continuations to actually settle.
          await this.drainDisposeCompletions()
          if (stopped[0]?.status === 'rejected') throw stopped[0].reason
        })()
        return drain
      },
      resume: () => {
        if (restoration) return restoration
        restoration = (async () => {
          if (drain) await drain
          if (this.closeAdmission === ticket) this.closeAdmission = undefined
        })()
        return restoration
      },
    })
    this.closeAdmission = ticket
    return ticket
  }

  private readonly segmentDiagnostics: Readonly<AiSegmentDiagnostic>[] = []

  /** Main-only bounded metadata; callers never receive the retained objects. */
  getSegmentDiagnostics(): readonly Readonly<AiSegmentDiagnostic>[] {
    return Object.freeze(this.segmentDiagnostics.map(frozenSegmentDiagnostic))
  }
  private readonly sessions = new Map<string, WorkspaceSession>()
  private readonly requestRegistry: AiConversationRequestRegistry
  private active: ActiveConversation | undefined
  private activeWorkspace: WorkspaceRootCapability | undefined
  private pendingStart: PendingStart | undefined
  private readonly pendingStarts = new Set<PendingStart>()
  private readonly pendingStartCompletions = new Set<Promise<void>>()
  private readonly activeCompletions = new Set<Promise<void>>()
  private startGeneration = 0
  private documentEpoch = 0
  private workspaceSwitchGeneration = 0
  private workspaceSwitch: WorkspaceSwitchState | undefined
  private readonly workspaceSwitchCompletions = new Set<Promise<void>>()
  private workspaceAvailable = true
  private readonly documentSnapshotReleases = new WeakMap<AiCurrentDocumentSnapshot, Promise<void>>()
  private readonly documentReleaseCompletions = new Set<Promise<void>>()
  private disposed = false
  private disposePromise: Promise<void> | undefined
  private readonly unsubscribeWritePolicy: () => void
  private readonly unsubscribeModelSelection: () => void

  constructor(private readonly options: {
    ownerId: number
    requestRegistry?: AiConversationRequestRegistry
    client: ModelProtocolClient
    events: AiConversationEventSink
    files: WorkspaceAiFileBoundary
    currentDocument: AiCurrentDocumentSource
    getCurrentDocumentWriteAuthority?(): AiCurrentDocumentWriteAuthority | null
  } & ({ authority: SettingsAuthority; settings?: never; connections?: never }
    | { authority?: never; settings: Pick<SettingsUpdater, 'get'> & AiConversationWritePolicySource & AiConversationModelSelectionSource
      connections: Pick<ModelConnectionService, 'getCredentialSnapshot'> })) {
    if (!Number.isSafeInteger(options.ownerId) || options.ownerId <= 0) {
      throw new Error('Invalid AI conversation owner')
    }
    this.requestRegistry = options.requestRegistry ?? DEFAULT_AI_CONVERSATION_REQUEST_REGISTRY
    if (options.authority) {
      let previous = authoritativeAiSnapshots(options.authority.getDisplaySnapshot())
      this.unsubscribeWritePolicy = options.authority.subscribe(snapshot => {
        const next = authoritativeAiSnapshots(snapshot)
        if (next.policy.revision !== previous.policy.revision || next.policy.policy !== previous.policy.policy) this.handleWritePolicyChanged(next.policy)
        if (next.model.revision !== previous.model.revision || next.model.connectionId !== previous.model.connectionId
          || next.model.thinkingMode !== previous.model.thinkingMode || next.model.reasoningEffort !== previous.model.reasoningEffort) this.handleModelSelectionChanged(next.model)
        previous = next
      })
      this.unsubscribeModelSelection = () => undefined
    } else {
      this.unsubscribeWritePolicy = options.settings.subscribeAiConversationWritePolicy(snapshot => this.handleWritePolicyChanged(snapshot))
      this.unsubscribeModelSelection = options.settings.subscribeAiConversationModelSelection(snapshot => this.handleModelSelectionChanged(snapshot))
    }
  }

  async start(input: StartAiConversationInput): Promise<{
    requestId: string
    modelId: string
    transcriptRevision: number
  }> {
    this.assertUsable()
    this.assertStartAllowed()
    const submittedDocumentEpoch = this.documentEpoch
    const currentDocumentWriteAuthority = this.currentDocumentWriteAuthority()
    // Capture before any preflight awaits: a later user denial must win over
    // this request's older intent, including while credentials are loading.
    const submittedSession = this.sessions.get(input.workspaceKey)
    const submittedCapabilityRevision = submittedSession?.capabilityRevision
    if (!Number.isSafeInteger(input.acknowledgedTranscriptRevision)
      || input.acknowledgedTranscriptRevision < 0
      || input.messages.length !== 1 || input.messages[0]?.role !== 'user') {
      throw new PublicError('INVALID_INPUT')
    }
    const controller = new AbortController()
    let completePendingStart!: () => void
    const completion = new Promise<void>((resolve) => { completePendingStart = resolve })
    const pendingStart: PendingStart = {
      requestId: input.requestId,
      generation: null,
      controller,
      completion,
      complete: completePendingStart,
    }
    this.pendingStartCompletions.add(completion)
    this.pendingStarts.add(pendingStart)

    try {
      const workspace = await this.options.files.getRootCapability()
      this.assertStartCandidate(pendingStart)
      if (input.workspaceKey !== workspace.workspaceId) throw new PublicError('INVALID_INPUT')
      const binding: RequestBinding = {
        ownerId: this.options.ownerId,
        conversationId: input.conversationId,
        workspaceId: workspace.workspaceId,
        workspaceGeneration: workspace.workspaceGeneration,
      }
      let session = this.sessions.get(workspace.workspaceId)
      if (session !== undefined && session.conversationId !== input.conversationId) {
        throw new PublicError('INVALID_INPUT')
      }
      this.assertTranscriptDelta(session, input)
      const continuation = this.continuationForStart(session, input, binding, workspace)
      if (!this.requestRegistry.reserve(input.requestId, binding)) throw new PublicError('INVALID_INPUT')
      const generation = ++this.startGeneration
      pendingStart.generation = generation
      for (const other of this.pendingStarts) {
        if (other !== pendingStart) other.controller.abort()
      }
      this.pendingStart = pendingStart

      let modelSelection: AiConversationModelSelectionSnapshot
      let settings: LargeModelSettings
      let credential: ModelConnectionCredentialSnapshot
      try {
        if (this.options.authority) {
          const paired = await this.options.authority.readExecution({ feature: 'aiConversation' })
          modelSelection = authoritativeAiSnapshots(paired.snapshot).model
          settings = paired.observed.settings
          credential = { connection: paired.connection, apiKey: isCodexCliConnection(paired.connection) ? '' : paired.apiKey }
        } else {
          // Transitional composition only; removed at the complete main-root switch.
          modelSelection = this.options.settings.getAiConversationModelSelectionSnapshot()
          const models = this.options.settings.get().models
          if (!models || models.aiConversation.connectionId === null
            || models.aiConversation.connectionId !== modelSelection.connectionId
            || models.aiConversation.thinkingMode !== modelSelection.thinkingMode
            || models.aiConversation.reasoningEffort !== modelSelection.reasoningEffort) throw new PublicError('AI_MODEL_NOT_CONFIGURED')
          settings = models
          credential = await this.options.connections.getCredentialSnapshot(models.aiConversation.connectionId)
        }
      } catch (error) {
        this.assertCurrentStart(pendingStart)
        if (error instanceof PublicError || error instanceof ModelProtocolError) throw error
        throw new PublicError(modelPublicErrorCode(error) ?? 'OPERATION_FAILED')
      }
      this.assertCurrentStart(pendingStart)
      this.assertModelSelection(modelSelection)
      await this.assertRootCapability(workspace)
      this.assertCurrentStart(pendingStart)
      if (credential.apiKey === null) throw new PublicError('MODEL_SECRET_UNAVAILABLE')

      const writePolicySnapshot = this.writePolicySnapshot()
      session = this.sessions.get(workspace.workspaceId)
      if (session !== undefined && session.conversationId !== input.conversationId) {
        throw new PublicError('INVALID_INPUT')
      }
      this.assertTranscriptDelta(session, input)
      await this.stopActive()
      this.assertCurrentStart(pendingStart)
      this.assertModelSelection(modelSelection)
      await this.assertRootCapability(workspace)
      this.assertCurrentStart(pendingStart)
      const originalSession = this.sessions.get(workspace.workspaceId)
      if (originalSession !== submittedSession
        || originalSession?.capabilityRevision !== submittedCapabilityRevision) {
        throw new PublicError('OPERATION_FAILED')
      }
      if (originalSession !== undefined && originalSession.conversationId !== input.conversationId) {
        throw new PublicError('INVALID_INPUT')
      }
      const originalCapabilityRevision = originalSession?.capabilityRevision ?? null
      const isNewSession = originalSession === undefined
      if (originalSession === undefined) {
        session = {
          pausedBudgetSegment: null,
          workspaceId: workspace.workspaceId,
          workspaceGeneration: workspace.workspaceGeneration,
          conversationId: input.conversationId,
          capabilities: { ...input.capabilities },
          capabilityRevision: 0,
          context: emptyContext(),
          usageBaseline: null,
          visibleMessages: [],
          transcriptRevision: 0,
          committedDocumentEpoch: this.documentEpoch,
          documentGrants: new Map(),
          workspaceGrant: null,
          observedWritePolicy: writePolicySnapshot.policy,
          observedWritePolicyRevision: writePolicySnapshot.revision,
          modelFingerprint: null,
          unknownPathBarriers: new Map(),
          unknownIdentityBarriers: new Map(),
          terminalMutationIds: new Set(),
          recoveryPending: false,
          recoveryModelFingerprint: null,
          mutationRecoveries: new Map(),
        }
      } else session = cloneSession(originalSession)
      if (session.workspaceGeneration !== workspace.workspaceGeneration) {
        this.revokeSessionGrants(session)
        session.workspaceGeneration = workspace.workspaceGeneration
        this.updateSessionCapabilities(session, { currentDocument: false, workspace: false })
      }
      if (isNewSession) this.updateSessionCapabilities(session, input.capabilities)
      const { thinkingMode, reasoningEffort } = settings.aiConversation
      const fingerprint = modelFingerprint(credential.connection, reasoningEffort, thinkingMode)
      this.assertTranscriptDelta(session, input)
      const wireMessages: ModelChatMessage[] = [{ role: 'user', content: input.messages[0]!.content }]
      let documentChanged = session.committedDocumentEpoch !== this.documentEpoch
      const visibleRecords: AiConversationVisibleMessage[] = [{ ...input.messages[0]! }]
      if (session.modelFingerprint !== null && session.modelFingerprint !== fingerprint) {
        if (!session.recoveryPending) this.rebuildVisibleOnly(session)
        this.revokeSessionGrants(session)
        this.updateSessionCapabilities(session, { currentDocument: false, workspace: false })
      }
      session.modelFingerprint = fingerprint
      // Fresh, validated request intent can authorize reads for this turn.
      // Model/workspace changes above still discard caches and write grants;
      // the candidate is committed only if all revision/generation fences hold.
      this.updateSessionCapabilities(session, input.capabilities)
      const profile = resolveAiConversationProfile(credential.connection, {
        thinkingMode,
        reasoningEffort,
      })
      const budgetProfileFingerprint = createHash('sha256').update(JSON.stringify({ fingerprint, profile })).digest('hex')
      if (continuation && continuation.profileFingerprint !== budgetProfileFingerprint) throw new PublicError('OPERATION_FAILED')
      const providerBase = {
        provider: credential.connection.provider,
        protocol: credential.connection.protocol,
        baseUrl: credential.connection.baseUrl,
        modelId: credential.connection.modelId,
        apiKey: credential.apiKey,
        thinkingMode,
        reasoningEffort,
        capabilityOverride: credential.connection.capabilityOverride,
        initialInactivityTimeoutMs: MODEL_REQUEST_INITIAL_INACTIVITY_TIMEOUT_MS,
        signal: controller.signal,
      } satisfies Omit<ModelChatInput, 'messages' | 'tools' | 'onDelta'>

      const hasPendingRecovery = session.recoveryPending
      const recoveryUsesLocalClosure = hasPendingRecovery
        && session.recoveryModelFingerprint !== fingerprint
      const turnCapabilities: AiConversationCapabilities = input.currentDocumentOnce
        ? { ...session.capabilities, currentDocument: true }
        : { ...session.capabilities }
      let revalidationReads = 0
      let continuationChanged = false
      let continuationResetReasons: readonly ContinuationResetReason[] = []
      if (continuation) {
        const checked = await this.revalidatePausedSegment(continuation, input, controller.signal, submittedDocumentEpoch, async () => {
          this.assertCurrentStart(pendingStart)
          this.assertModelSelection(modelSelection)
          await this.assertRootCapability(workspace)
          this.assertCurrentStart(pendingStart)
          if (this.sessions.get(workspace.workspaceId) !== originalSession
            || originalSession?.pausedBudgetSegment !== continuation
            || originalSession.capabilityRevision !== originalCapabilityRevision
            || this.documentEpoch !== submittedDocumentEpoch
            || !this.requestRegistry.owns(input.requestId, binding)) throw new PublicError('OPERATION_FAILED')
        })
        revalidationReads = checked.reads
        continuationChanged = checked.changed
        continuationResetReasons = checked.reasons
        if (continuationChanged) this.rebuildVisibleOnly(session, true, continuation.writeReceipts.values())
      }
      // The candidate consumes the receipt only if all original start guards
      // succeed and this candidate is committed below.
      session.pausedBudgetSegment = null
      const preflightCompactions: AiContextCompactionRecord[] = []
      if (!hasPendingRecovery) {
        const prospective = [...(continuationChanged ? [CONTINUATION_FRESH_READ_NOTICE] : []),
          ...(documentChanged ? [DOCUMENT_CHANGED_NOTICE] : []), ...wireMessages]
        await this.compactBeforeAppend(session, prospective, profile, providerBase, async () => {
          await this.assertRootCapability(workspace)
          this.assertCurrentStart(pendingStart)
          this.assertModelSelection(modelSelection)
        }, undefined, turnCapabilities, (record) => {
          if (record.status === 'compacted') {
            preflightCompactions.push(record)
            return
          }
          this.assertCurrentStart(pendingStart)
          this.assertModelSelection(modelSelection)
          if (this.sessions.get(workspace.workspaceId) !== originalSession
            || originalSession?.capabilityRevision !== originalCapabilityRevision
            || originalSession?.transcriptRevision !== input.acknowledgedTranscriptRevision
            || originalSession?.workspaceGeneration !== workspace.workspaceGeneration
            || !this.requestRegistry.owns(input.requestId, binding)) return
          const event = parseAiConversationEvent({
            requestId: input.requestId, type: 'context-compaction',
            transcriptRevision: input.acknowledgedTranscriptRevision, ...record,
          })
          if (event) this.options.events.emit(event)
        }, modelSelection)
      }
      this.assertCurrentStart(pendingStart)
      this.assertModelSelection(modelSelection)
      await this.assertRootCapability(workspace)
      this.assertCurrentStart(pendingStart)
      if (this.options.authority) await this.options.authority.readFresh()
      this.assertCurrentStart(pendingStart)
      this.assertModelSelection(modelSelection)
      if (this.sessions.get(workspace.workspaceId) !== originalSession) {
        throw new PublicError('OPERATION_FAILED')
      }
      if (originalSession !== undefined
        && originalSession.capabilityRevision !== originalCapabilityRevision) {
        throw new PublicError('OPERATION_FAILED')
      }
      const finalWritePolicy = this.writePolicySnapshot()
      if (finalWritePolicy.revision !== writePolicySnapshot.revision
        || finalWritePolicy.policy !== writePolicySnapshot.policy) {
        throw new PublicError('OPERATION_FAILED')
      }
      const rollbackContext = session.context
      const rollbackDocumentEpoch = session.committedDocumentEpoch
      if (!hasPendingRecovery) {
        documentChanged = session.committedDocumentEpoch !== this.documentEpoch
        session.context = appendMessages(session.context, wireMessages)
        session.visibleMessages.push(...visibleRecords)
        session.transcriptRevision += 1
        session.committedDocumentEpoch = this.documentEpoch
      }
      this.sessions.set(workspace.workspaceId, session)
      this.activeWorkspace = workspace

      this.pendingStart = undefined
      const active: ActiveConversation = {
        segmentStartedAt: Date.now(), segmentErrorCode: null, continuationResetReasons,
        budgetProfileFingerprint,
        continuationReads: new Map(continuation && !continuationChanged ? continuation.reads : []),
        untrackedHistoricalReads: false, continuationReadReset: continuationChanged, revalidationReads,
        budget: createAiToolBudget(), budgetAdmittedIds: new Set(), budgetSoftNoticePending: false,
        budgetFallbackContext: null, budgetPaused: false,
        progress: new AiConversationProgress({ requestId: input.requestId, signal: controller.signal,
          isCurrent: () => !this.disposed && this.active === active && !active.completed && !active.stopped
            && active.startGeneration === this.startGeneration
            && active.binding.workspaceGeneration === active.session.workspaceGeneration
            && this.requestRegistry.owns(active.requestId, active.binding),
          emit: event => this.emitIfOwned(active, event),
        }),
        processTools: new Map(),
        requestId: input.requestId,
        startGeneration: generation,
        binding,
        rootCapability: workspace,
        modelSelection,
        session,
        capabilities: turnCapabilities,
        controller,
        pendingAuthorizations: new Map(),
        authorizedNotExecuting: new Map(),
        planning: new Set(),
        executing: new Set(),
        currentDocumentSnapshot: null,
        currentDocumentEpoch: null,
        submittedDocumentEpoch,
        expectedDocumentId: input.expectedDocumentId,
        currentDocumentWriteAuthority,
        currentDocumentSeriesStarted: false,
        currentDocumentVersion: null,
        workspaceReadVersions: new Map(),
        workspaceReadSeriesStarted: new Set(),
        toolResults: new Map(continuation?.writeReceipts),
        seenToolCallIds: new Set(),
        stopped: false,
        completed: false,
        rollbackContext,
        rollbackDocumentEpoch,
        mutationTerminalCommitted: false,
        currentAssistant: null,
        currentAssistantMessageId: null,
        currentAssistantToolBaseline: null,
        recoveryRestored: false,
        recoveryUsesLocalClosure,
        pendingUser: hasPendingRecovery ? { ...input.messages[0]! } : null,
        documentChanged: !hasPendingRecovery && documentChanged,
      }
      this.active = active
      this.emitIfOwned(active, {
        requestId: active.requestId,
        type: 'started',
        transcriptRevision: session.transcriptRevision,
      })
      if (!hasPendingRecovery) {
        this.emitIfOwned(active, {
          requestId: active.requestId,
          type: 'user-message-accepted',
          messageId: input.messages[0]!.id,
          transcriptRevision: session.transcriptRevision,
        })
      }
      for (const record of preflightCompactions) this.emitCompactionRecord(active, record)
      const completion = this.runConversation(active, providerBase, profile)
      this.activeCompletions.add(completion)
      void completion.then(
        () => { this.activeCompletions.delete(completion) },
        () => { this.activeCompletions.delete(completion) },
      )
      return {
        requestId: active.requestId,
        modelId: credential.connection.modelId,
        transcriptRevision: session.transcriptRevision,
      }
    } finally {
      if (this.pendingStart === pendingStart) this.pendingStart = undefined
      this.pendingStarts.delete(pendingStart)
      pendingStart.complete()
      this.pendingStartCompletions.delete(pendingStart.completion)
    }
  }

  async cancel(requestId: string): Promise<void> {
    let canceledStart = false
    for (const pending of [...this.pendingStarts]) {
      if (pending.requestId !== requestId) continue
      canceledStart = true
      pending.controller.abort()
      this.pendingStarts.delete(pending)
      if (this.pendingStart === pending) {
        this.pendingStart = undefined
        this.startGeneration += 1
      }
    }
    if (canceledStart) return
    if (this.active?.requestId === requestId) await this.stopActive()
  }

  async submitAuthorizationResult(input: SubmitAiAuthorizationResultInput): Promise<void> {
    this.assertUsable()
    const active = this.active
    const pending = active?.pendingAuthorizations.get(input.operationId)
    if (active === undefined || pending === undefined || input.requestId !== active.requestId
      || !this.requestRegistry.owns(input.requestId, active.binding)) {
      throw new PublicError('INVALID_INPUT')
    }
    let allowed = input.allowed
    if (allowed) {
      if (this.options.authority) await this.options.authority.readFresh()
      if (pending.settled) return
      this.assertActiveOwner(active)
      const snapshot = this.trustedWritePolicy(active.session)
      const requiredScope: AiAuthorizationScope = snapshot.policy === 'workspace-grant'
        ? 'workspace' : snapshot.policy === 'document-grant' ? 'document' : 'action'
      if (requiredScope !== pending.scope
        || snapshot.revision !== pending.policySnapshot.revision
        || snapshot.policy !== pending.policySnapshot.policy
        || (pending.manifest.toolName !== 'edit_workspace_document'
          && requiredScope === 'document')) allowed = false
    }
    this.settleAuthorization(active, pending, allowed, allowed ? 'allowed' : 'authorization-denied')
  }

  async notifyCurrentDocumentChanged(): Promise<void> {
    this.documentEpoch += 1
  }

  setCapabilities(input: SetAiConversationCapabilitiesInput): void {
    const current = this.activeWorkspace
    const session = this.sessions.get(input.workspaceId)
    if (input.ownerId !== this.options.ownerId || current === undefined
      || current.workspaceId !== input.workspaceId
      || current.workspaceGeneration !== input.workspaceGeneration
      || session === undefined || session.conversationId !== input.conversationId
      || session.workspaceGeneration !== input.workspaceGeneration) {
      throw new PublicError('INVALID_INPUT')
    }
    const changed = this.updateSessionCapabilities(session, input.capabilities)
    // Even an explicit denial matching already-revoked authority supersedes
    // older fresh-start intent captured during preflight.
    if (!changed) session.capabilityRevision += 1
    if (!changed || this.active?.session !== session) return
    this.active.capabilities = { ...input.capabilities }
    if (!input.capabilities.currentDocument) void this.releaseCurrentDocumentSnapshot(this.active)
    if (!input.capabilities.workspace) {
      this.revokeSessionGrants(session)
      for (const pending of [...this.active.pendingAuthorizations.values()]) {
        this.settleAuthorization(this.active, pending, false, 'workspace-capability-revoked')
      }
      for (const manifest of this.active.authorizedNotExecuting.values()) {
        try { this.options.files.abandon(manifest, 'workspace-capability-revoked') } catch { /* terminal elsewhere */ }
      }
      this.active.authorizedNotExecuting.clear()
    }
  }

  /**
   * Establishes the no-new-turn gate before awaiting any AI or workspace work.
   * Callers must invoke this before acquiring the workspace mutation lease.
   */
  prepareWorkspaceSwitch(): Promise<AiWorkspaceSwitchTicket> {
    return this.runWorkspaceSwitchOperation(() => this.prepareWorkspaceSwitchOperation())
  }

  private async prepareWorkspaceSwitchOperation(): Promise<AiWorkspaceSwitchTicket> {
    this.assertUsable()
    if (this.workspaceSwitch !== undefined) throw new PublicError('OPERATION_FAILED')
    if (this.workspaceSwitchGeneration >= Number.MAX_SAFE_INTEGER) {
      this.workspaceAvailable = false
      throw new PublicError('OPERATION_FAILED')
    }
    const ticket = Object.freeze({
      generation: ++this.workspaceSwitchGeneration,
      nonce: randomUUID(),
    })
    const state: WorkspaceSwitchState = {
      ticket,
      source: this.activeWorkspace === undefined ? undefined : copyRootCapability(this.activeWorkspace),
      phase: 'preparing',
    }
    this.workspaceSwitch = state
    const pendingStarts = this.invalidatePendingStarts()
    try {
      if (state.source === undefined && this.workspaceAvailable) {
        // Save As can begin with an owned unnamed draft and no source root.
        // Only the file boundary may attest to that explicitly empty state;
        // invalid or changed active roots still reject the transition.
        const source = this.options.files.getWorkspaceSwitchSourceCapability
          ? await this.options.files.getWorkspaceSwitchSourceCapability()
          : await this.options.files.getRootCapability()
        if (source !== null) state.source = copyRootCapability(source)
        this.assertWorkspaceSwitch(ticket, 'preparing')
      }
      await Promise.allSettled(pendingStarts.map((pending) => pending.completion))
      this.assertWorkspaceSwitch(ticket, 'preparing')
      await this.stopActiveAndDrain()
      this.assertWorkspaceSwitch(ticket, 'preparing')
      state.phase = 'prepared'
      return ticket
    } catch (error) {
      if (error instanceof PublicError) throw error
      throw new PublicError('OPERATION_FAILED')
    }
  }

  activateWorkspace(
    ticket: AiWorkspaceSwitchTicket,
    rootCapability?: WorkspaceRootCapability,
  ): Promise<void> {
    return this.runWorkspaceSwitchOperation(async () => {
      await this.activatePreparedWorkspace(ticket, rootCapability)
    })
  }

  private async activatePreparedWorkspace(
    ticket: AiWorkspaceSwitchTicket,
    rootCapability?: WorkspaceRootCapability,
  ): Promise<void> {
    this.assertUsable()
    const state = this.assertWorkspaceSwitch(ticket, 'prepared')
    state.phase = 'activating'
    const supplied = rootCapability === undefined ? undefined : copyRootCapability(rootCapability)
    try {
      const current = copyRootCapability(await this.options.files.getRootCapability())
      this.assertWorkspaceSwitch(ticket, 'activating')
      if (supplied !== undefined && !sameRootCapability(supplied, current)) {
        throw new PublicError('OPERATION_FAILED')
      }
      const next = supplied ?? current
      this.commitWorkspaceActivation(next)
      this.assertWorkspaceSwitch(ticket, 'activating')
      this.workspaceAvailable = true
      this.workspaceSwitch = undefined
    } catch (error) {
      if (this.workspaceSwitch === state && !this.disposed) state.phase = 'prepared'
      if (error instanceof PublicError) throw error
      throw new PublicError('OPERATION_FAILED')
    }
  }

  deactivateWorkspace(ticket: AiWorkspaceSwitchTicket): Promise<void> {
    return this.runWorkspaceSwitchOperation(async () => {
      await this.deactivatePreparedWorkspace(ticket)
    })
  }

  private async deactivatePreparedWorkspace(ticket: AiWorkspaceSwitchTicket): Promise<void> {
    this.assertUsable()
    const state = this.assertWorkspaceSwitch(ticket, 'prepared')
    state.phase = 'activating'
    for (const session of this.sessions.values()) {
      this.revokeSessionGrants(session)
      this.updateSessionCapabilities(session, { currentDocument: false, workspace: false })
    }
    this.activeWorkspace = undefined
    this.workspaceAvailable = false
    this.assertWorkspaceSwitch(ticket, 'activating')
    this.workspaceSwitch = undefined
  }

  abortWorkspaceSwitch(ticket: AiWorkspaceSwitchTicket): Promise<void> {
    return this.runWorkspaceSwitchOperation(async () => {
      await this.abortPreparedWorkspaceSwitch(ticket)
    })
  }

  private async abortPreparedWorkspaceSwitch(ticket: AiWorkspaceSwitchTicket): Promise<void> {
    this.assertUsable()
    const state = this.assertWorkspaceSwitch(ticket, 'prepared')
    if (state.source !== undefined) {
      const current = copyRootCapability(await this.options.files.getRootCapability())
      this.assertWorkspaceSwitch(ticket, 'prepared')
      if (!sameRootCapability(state.source, current)) throw new PublicError('OPERATION_FAILED')
    }
    this.workspaceSwitch = undefined
  }

  private runWorkspaceSwitchOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new PublicError('OPERATION_FAILED'))
    let complete!: () => void
    const completion = new Promise<void>((resolve) => { complete = resolve })
    this.workspaceSwitchCompletions.add(completion)
    return (async () => {
      try {
        return await operation()
      } finally {
        complete()
        this.workspaceSwitchCompletions.delete(completion)
      }
    })()
  }

  async clearConversation(workspaceId: string, conversationId: string): Promise<void> {
    const session = this.sessions.get(workspaceId)
    if (session === undefined || session.conversationId !== conversationId) {
      throw new PublicError('INVALID_INPUT')
    }
    if (this.active?.session === session) await this.stopActive()
    this.revokeSessionGrants(session)
    this.sessions.delete(workspaceId)
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    const session = this.sessions.get(workspaceId)
    if (session === undefined) return
    if (this.active?.session === session) await this.stopActive()
    this.revokeSessionGrants(session)
    this.sessions.delete(workspaceId)
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.disposed = true
    this.workspaceSwitchGeneration += 1
    this.workspaceSwitch = undefined
    this.workspaceAvailable = false
    this.invalidatePendingStarts()
    this.disposePromise = this.finishDispose()
    return this.disposePromise
  }

  private async finishDispose(): Promise<void> {
    const initialActiveDrain = this.stopActiveAndDrain()
    try {
      await Promise.allSettled([initialActiveDrain])
      await this.drainDisposeCompletions()
    } finally {
      this.unsubscribeWritePolicy()
      this.unsubscribeModelSelection()
      for (const session of this.sessions.values()) this.revokeSessionGrants(session)
      this.sessions.clear()
    }
  }

  private async drainDisposeCompletions(): Promise<void> {
    while (true) {
      const completions = [
        ...this.pendingStartCompletions,
        ...this.workspaceSwitchCompletions,
        ...this.activeCompletions,
        ...this.documentReleaseCompletions,
      ]
      if (completions.length === 0) return
      await Promise.allSettled(completions)
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new PublicError('OPERATION_FAILED')
  }

  private assertStartAllowed(): void {
    if (this.closeAdmission !== undefined || this.workspaceSwitch !== undefined || !this.workspaceAvailable) {
      throw new PublicError('OPERATION_FAILED')
    }
  }

  private continuationForStart(session: WorkspaceSession | undefined, input: StartAiConversationInput,
    binding: RequestBinding, root: WorkspaceRootCapability): PausedBudgetSegment | undefined {
    if (input.continuationOfSegmentId === undefined) return undefined
    const receipt = session?.pausedBudgetSegment
    if (!receipt || receipt.id !== input.continuationOfSegmentId
      || receipt.transcriptRevision !== input.acknowledgedTranscriptRevision
      || receipt.binding.ownerId !== binding.ownerId || receipt.binding.conversationId !== binding.conversationId
      || receipt.binding.workspaceId !== binding.workspaceId || receipt.binding.workspaceGeneration !== binding.workspaceGeneration
      || receipt.rootCapability.rootGeneration !== root.rootGeneration
      || receipt.rootCapability.rootFinalPath !== root.rootFinalPath
      || receipt.rootCapability.rootVolumeSerial !== root.rootVolumeSerial
      || receipt.rootCapability.rootFileId !== root.rootFileId) throw new PublicError('INVALID_INPUT')
    return receipt
  }

  private async revalidatePausedSegment(receipt: PausedBudgetSegment, input: StartAiConversationInput,
    signal: AbortSignal, documentEpoch: number, verify: () => Promise<void>): Promise<{ changed: boolean; reads: number; reasons: ContinuationResetReason[] }> {
    let changed = receipt.untrackedHistoricalReads, reads = 0
    const reasons = new Set<ContinuationResetReason>(changed ? ['untracked-history'] : [])
    if (receipt.reads.size > AI_READ_TOOL_LIMIT) throw new PublicError('INVALID_INPUT')
    for (const observation of receipt.reads.values()) {
      await verify()
      signal.throwIfAborted()
      if (observation.kind === 'current'
        ? (!input.capabilities.currentDocument && !input.currentDocumentOnce)
          || observation.documentEpoch !== documentEpoch || observation.expectedDocumentId !== input.expectedDocumentId
        : !input.capabilities.workspace) { changed = true; reasons.add('permission-or-document-changed'); continue }
      try {
        reads += 1
        if (observation.kind === 'directory') {
          const page = parseWorkspaceToolResult('list_workspace_entries', await this.options.files.listEntries({
            path: observation.path, cursor: 0, maxEntries: 1, directoryVersion: null,
          }, signal))
          await verify()
          if (page?.kind !== 'entries' || page.directoryPath !== observation.path || page.cursor !== 0 || page.entries.length > 1
            || !sameDirectoryVersion(page.directoryVersion, observation.version)) { changed = true; reasons.add('version-changed-or-invalid') }
        } else if (observation.kind === 'document') {
          const args = { path: observation.path, cursor: 0, maxChars: 1 } as const
          const page = parseWorkspaceToolResult('read_workspace_document', await this.options.files.readDocument(args, signal))
          await verify()
          if (page?.kind !== 'document' || page.path !== observation.path || !validDocumentPageEcho(args, page)
            || !sameVersion(page.version, observation.version)) { changed = true; reasons.add('version-changed-or-invalid') }
        } else {
          const opened = await this.options.currentDocument.openSnapshot({ requestId: input.requestId,
            conversationId: input.conversationId, workspaceId: receipt.binding.workspaceId,
            workspaceGeneration: receipt.binding.workspaceGeneration, toolCallId: 'continuation_revalidation', signal,
            ...(observation.expectedDocumentId === undefined ? {} : { expectedDocumentId: observation.expectedDocumentId }) })
          try {
            await verify()
            if (!opened) { changed = true; reasons.add('read-unavailable'); continue }
            const args = { cursor: 0, maxChars: 1 }
            const page = parseWorkspaceToolResult('read_current_document', await opened.readPage(args, signal))
            await verify()
            if (page?.kind !== 'document' || !validDocumentPageEcho(args, page)
              || !sameVersion(page.version, observation.version)) { changed = true; reasons.add('version-changed-or-invalid') }
          } finally {
            if (opened) await this.releaseDocumentSnapshot(opened)
            await verify()
          }
        }
      } catch {
        // An unavailable read becomes historical, but lost request/settings/root
        // ownership must still abort the candidate instead of continuing.
        await verify()
        signal.throwIfAborted()
        changed = true
        reasons.add('read-unavailable')
      }
    }
    await verify()
    return { changed, reads, reasons: [...reasons] }
  }

  private rememberContinuationRead(active: ActiveConversation, key: string, observation: ContinuationReadObservation): void {
    if (!active.continuationReads.has(key) && active.continuationReads.size >= AI_READ_TOOL_LIMIT) {
      const oldest = active.continuationReads.keys().next().value
      if (oldest !== undefined) active.continuationReads.delete(oldest)
      active.untrackedHistoricalReads = true
    }
    active.continuationReads.set(key, observation)
  }

  private assertTranscriptDelta(
    session: WorkspaceSession | undefined,
    input: StartAiConversationInput,
  ): void {
    const expectedRevision = session?.transcriptRevision ?? 0
    if (input.acknowledgedTranscriptRevision !== expectedRevision
      || session?.visibleMessages.some((message) => message.id === input.messages[0]!.id)) {
      throw new PublicError('INVALID_INPUT')
    }
  }

  private assertStartCandidate(pending: PendingStart): void {
    if (this.disposed || this.workspaceSwitch !== undefined || !this.workspaceAvailable
      || pending.controller.signal.aborted || !this.pendingStarts.has(pending)) {
      throw new PublicError('OPERATION_FAILED')
    }
  }

  private assertWorkspaceSwitch(
    ticket: AiWorkspaceSwitchTicket,
    phase: WorkspaceSwitchState['phase'],
  ): WorkspaceSwitchState {
    const state = this.workspaceSwitch
    if (this.disposed || state === undefined || state.ticket !== ticket
      || state.ticket.generation !== this.workspaceSwitchGeneration || state.phase !== phase) {
      throw new PublicError('OPERATION_FAILED')
    }
    return state
  }

  private commitWorkspaceActivation(next: WorkspaceRootCapability): void {
    for (const session of this.sessions.values()) {
      this.revokeSessionGrants(session)
      this.updateSessionCapabilities(session, { currentDocument: false, workspace: false })
    }
    this.activeWorkspace = copyRootCapability(next)
    const restored = this.sessions.get(next.workspaceId)
    if (restored !== undefined) restored.workspaceGeneration = next.workspaceGeneration
  }

  private assertCurrentStart(pending: PendingStart): void {
    this.assertStartCandidate(pending)
    if (pending.generation === null || pending.generation !== this.startGeneration
      || this.pendingStart !== pending) throw new PublicError('OPERATION_FAILED')
  }

  private invalidatePendingStarts(): PendingStart[] {
    const pendingStarts = [...this.pendingStarts]
    this.startGeneration += 1
    for (const pending of pendingStarts) pending.controller.abort()
    this.pendingStarts.clear()
    this.pendingStart = undefined
    return pendingStarts
  }

  private assertModelSelection(expected: AiConversationModelSelectionSnapshot): void {
    const current = this.options.authority ? authoritativeAiSnapshots(this.options.authority.getDisplaySnapshot()).model
      : this.options.settings.getAiConversationModelSelectionSnapshot()
    if (current.revision !== expected.revision || current.connectionId !== expected.connectionId
      || current.thinkingMode !== expected.thinkingMode
      || current.reasoningEffort !== expected.reasoningEffort) {
      throw new PublicError('OPERATION_FAILED')
    }
  }

  private async assertRootCapability(expected: WorkspaceRootCapability): Promise<void> {
    const current = await this.options.files.getRootCapability()
    if (current.windowId !== expected.windowId || current.workspaceId !== expected.workspaceId
      || current.rootGeneration !== expected.rootGeneration
      || current.workspaceGeneration !== expected.workspaceGeneration
      || current.rootFinalPath !== expected.rootFinalPath
      || current.rootVolumeSerial !== expected.rootVolumeSerial
      || current.rootFileId !== expected.rootFileId) {
      throw new PublicError('OPERATION_FAILED')
    }
  }

  private rebuildVisibleOnly(session: WorkspaceSession, discardReadCheckpoint = false,
    writeReceipts: Iterable<CachedToolResult> = []): void {
    const operationMap = new Map(localRecoveryOperations(session, true).map(operation => [operation.operationId, operation]))
    for (const receipt of writeReceipts) {
      // Compaction may have replaced original wire results; the exact cached
      // receipt still provides the confirmed outcome when read evidence expires.
      const message = receipt.message
      let raw: unknown
      try { raw = JSON.parse(message.content) } catch { continue }
      const parsed = parseWorkspaceToolResult(message.name as AiWorkspaceToolName, raw)
      if (parsed?.kind === 'mutation' && (parsed.state === 'succeeded' || parsed.state === 'unknown')) {
        operationMap.set(parsed.operationId, { operationId: parsed.operationId, state: parsed.state,
          paths: [...parsed.paths], pathsComplete: true })
      }
    }
    const operations = [...operationMap.values()]
    const completedOperationIds = completedRecoveryOperationIds(session, operations)
    const priorCheckpoint = discardReadCheckpoint ? null : session.context.checkpoint
    const retainedToolFacts = [...new Set([
      ...(priorCheckpoint?.retainedToolFacts ?? []),
      ...operations.map((operation) => localRecoveryMessage([operation], 4_096)),
    ])]
    const segmented = segmentCompleteTransactions(providerNeutralVisibleMessages(session.visibleMessages))
    session.context = {
      lineage: createAiWireLineage(),
      checkpoint: priorCheckpoint === null && completedOperationIds.length === 0 && retainedToolFacts.length === 0
        ? null : {
          version: 1, userGoals: [], decisions: [], workspaceFacts: [],
          unresolvedQuestions: [], nextSteps: [],
          ...priorCheckpoint,
          retainedToolFacts, completedOperationIds,
        },
      transactions: segmented.transactions,
      openTransaction: segmented.openTransaction,
    }
    session.usageBaseline = null
  }

  private closeRecoveryForModelSwitch(
    session: WorkspaceSession,
    assistant: Extract<ModelChatMessage, { role: 'assistant' }>,
  ): void {
    this.rebuildVisibleOnly(session)
    session.context = appendMessages(session.context, [
      { role: 'user', content: LOCAL_RECOVERY_AUTHORITY_REQUEST },
      assistant,
    ])
    if (session.context.openTransaction.length > 0) throw new PublicError('OPERATION_FAILED')
    session.usageBaseline = null
  }

  private revokeSessionGrants(session: WorkspaceSession): void {
    session.documentGrants.clear()
    session.workspaceGrant = null
  }

  private updateSessionCapabilities(
    session: WorkspaceSession,
    capabilities: AiConversationCapabilities,
  ): boolean {
    if (session.capabilities.currentDocument === capabilities.currentDocument
      && session.capabilities.workspace === capabilities.workspace) return false
    session.capabilities = { ...capabilities }
    session.capabilityRevision += 1
    return true
  }

  private assertToolCapability(
    active: ActiveConversation,
    revision: number,
    capability: keyof AiConversationCapabilities,
  ): void {
    this.assertActiveOwner(active)
    if (active.session.capabilityRevision !== revision || !active.capabilities[capability]) {
      throw new DOMException('The AI conversation capability changed', 'AbortError')
    }
  }

  private trustedWritePolicy(session: WorkspaceSession): AiConversationWritePolicySnapshot {
    const snapshot = this.writePolicySnapshot()
    if (session.observedWritePolicy !== snapshot.policy
      || session.observedWritePolicyRevision !== snapshot.revision) {
      this.revokeSessionGrants(session)
      session.observedWritePolicy = snapshot.policy
      session.observedWritePolicyRevision = snapshot.revision
    }
    return snapshot
  }

  private writePolicySnapshot(): AiConversationWritePolicySnapshot {
    return this.options.authority ? authoritativeAiSnapshots(this.options.authority.getDisplaySnapshot()).policy
      : this.options.settings.getAiConversationWritePolicySnapshot()
  }

  private async streamModel(input: ModelChatInput, expected: AiConversationModelSelectionSnapshot | undefined,
    assertCurrent: () => void): ReturnType<ModelProtocolClient['streamChat']> {
    if (!this.options.authority) return this.options.client.streamChat(input)
    if (!expected) throw new PublicError('OPERATION_FAILED')
    const snapshot = await this.options.authority.readFresh()
    this.assertModelSelection(expected)
    assertCurrent()
    const admitted = await this.options.authority.admitExecution(observeModelSettings(snapshot), { feature: 'aiConversation' }, () => {
      this.assertModelSelection(expected)
      assertCurrent()
      input.signal.throwIfAborted()
      return { completion: this.options.client.streamChat(input) }
    })
    return admitted.completion
  }

  private handleWritePolicyChanged(snapshot: AiConversationWritePolicySnapshot): void {
    if (this.disposed) return
    for (const session of this.sessions.values()) {
      this.revokeSessionGrants(session)
      session.observedWritePolicy = snapshot.policy
      session.observedWritePolicyRevision = snapshot.revision
    }
    const active = this.active
    if (active === undefined) return
    for (const pending of [...active.pendingAuthorizations.values()]) {
      this.settleAuthorization(active, pending, false, 'write-policy-changed')
    }
    for (const manifest of active.authorizedNotExecuting.values()) {
      try { this.options.files.abandon(manifest, 'write-policy-changed') } catch { /* already terminal */ }
    }
    active.authorizedNotExecuting.clear()
  }

  private handleModelSelectionChanged(_snapshot: AiConversationModelSelectionSnapshot): void {
    if (this.disposed) return
    this.invalidatePendingStarts()
    for (const session of this.sessions.values()) {
      this.revokeSessionGrants(session)
      this.updateSessionCapabilities(session, { currentDocument: false, workspace: false })
    }
    const active = this.active
    if (active === undefined) return
    active.progress.closeText()
    active.controller.abort()
    for (const pending of [...active.pendingAuthorizations.values()]) {
      this.settleAuthorization(active, pending, false, 'model-selection-changed')
    }
    for (const manifest of active.authorizedNotExecuting.values()) {
      try { this.options.files.abandon(manifest, 'model-selection-changed') } catch { /* already terminal */ }
    }
    active.authorizedNotExecuting.clear()
    void this.stopActive()
  }

  private async stopActive(): Promise<void> {
    const active = this.active
    if (active === undefined) return
    active.progress.closeText()
    active.controller.abort()
    for (const pending of [...active.pendingAuthorizations.values()]) {
      this.settleAuthorization(active, pending, false, 'authorization-canceled')
    }
    for (const manifest of active.authorizedNotExecuting.values()) {
      try { this.options.files.abandon(manifest, 'authorization-canceled') } catch { /* already terminal */ }
    }
    active.authorizedNotExecuting.clear()
    await this.releaseCurrentDocumentSnapshot(active)
    if (active.planning.size > 0) await Promise.allSettled([...active.planning])
    if (active.executing.size > 0) await Promise.allSettled([...active.executing])
    this.restoreMutationRecoveries(active)
    const supersededRecovery = active.pendingUser !== null
      && active.startGeneration !== this.startGeneration
    if (!active.stopped && !this.disposed) {
      active.progress.finish()
      active.stopped = true
      if (!supersededRecovery) {
        this.emitIfOwned(active, { requestId: active.requestId, type: 'stopped' })
      }
    }
    if (this.active === active) this.active = undefined
  }

  private async stopActiveAndDrain(): Promise<void> {
    const completions = [...this.activeCompletions]
    const documentReleases = [...this.documentReleaseCompletions]
    await this.stopActive()
    await Promise.allSettled(completions)
    await Promise.allSettled(documentReleases)
  }

  private async releaseDocumentSnapshot(snapshot: AiCurrentDocumentSnapshot): Promise<void> {
    const existing = this.documentSnapshotReleases.get(snapshot)
    if (existing !== undefined) {
      await existing
      return
    }
    const completion = (async () => {
      try { await snapshot.release() } catch { /* release is best-effort and idempotent */ }
    })()
    this.documentSnapshotReleases.set(snapshot, completion)
    this.documentReleaseCompletions.add(completion)
    try {
      await completion
    } finally {
      this.documentReleaseCompletions.delete(completion)
    }
  }

  private async releaseCurrentDocumentSnapshot(active: ActiveConversation): Promise<void> {
    const snapshot = active.currentDocumentSnapshot
    active.currentDocumentSnapshot = null
    active.currentDocumentEpoch = null
    active.currentDocumentSeriesStarted = false
    active.currentDocumentVersion = null
    if (snapshot !== null) await this.releaseDocumentSnapshot(snapshot)
  }

  private emitIfOwned(active: ActiveConversation, event: AiConversationEvent): void {
    if (this.disposed || this.active !== active || !this.requestRegistry.owns(active.requestId, active.binding)) return
    const parsed = parseAiConversationEvent(event)
    if (parsed !== undefined) this.options.events.emit(parsed)
  }

  private emitCompactionRecord(active: ActiveConversation, record: AiContextCompactionRecord): void {
    if (active.startGeneration !== this.startGeneration || active.controller.signal.aborted
      || active.binding.workspaceGeneration !== active.session.workspaceGeneration) return
    this.emitIfOwned(active, {
      requestId: active.requestId, type: 'context-compaction',
      transcriptRevision: active.session.transcriptRevision, ...record,
    })
  }

  private assertActiveOwner(active: ActiveConversation): void {
    if (this.disposed || this.active !== active || active.controller.signal.aborted
      || active.binding.workspaceGeneration !== active.session.workspaceGeneration
      || !this.requestRegistry.owns(active.requestId, active.binding)) {
      throw new DOMException('The AI conversation request was canceled', 'AbortError')
    }
  }

  private assertActiveGeneration(active: ActiveConversation): void {
    if (active.startGeneration !== this.startGeneration) {
      throw new DOMException('The AI conversation request was superseded', 'AbortError')
    }
  }

  private assertRecoveryAuthority(active: ActiveConversation): void {
    this.assertActiveOwner(active)
    this.assertActiveGeneration(active)
  }

  private assertCurrentDocumentReleaseAuthority(
    active: ActiveConversation,
    capabilityRevision: number,
  ): void {
    try {
      this.assertToolCapability(active, capabilityRevision, 'currentDocument')
      this.assertActiveOwner(active)
      this.assertActiveGeneration(active)
    } catch {
      throw new CurrentDocumentReleaseAuthorityError()
    }
  }

  private async compactBeforeAppend(
    session: WorkspaceSession,
    prospective: readonly ModelChatMessage[],
    profile: ModelCapabilityProfile | undefined,
    providerBase: Omit<ModelChatInput, 'messages' | 'tools' | 'onDelta'>,
    verifyAuthority?: () => Promise<void>,
    verifyGeneration?: () => void,
    capabilities: AiConversationCapabilities = session.capabilities,
    onCompaction?: (record: AiContextCompactionRecord) => void,
    modelSelection?: AiConversationModelSelectionSnapshot,
  ): Promise<void> {
    if (prospective.length === 0 || session.context.openTransaction.length > 0
      || (session.context.checkpoint === null && session.context.transactions.length === 0)) return
    const tools = toolsFor(capabilities)
    let modelFailure: ModelProtocolError | undefined
    const result = await compactWireContext({
      context: session.context,
      profile,
      capabilities,
      usageBaseline: session.usageBaseline,
      fixedInputTokens: fixedInputTokens(tools) + estimateWireTokens(prospective),
      summarize: async (request) => {
        verifyGeneration?.()
        await verifyAuthority?.()
        let text = ''
        const response = await this.streamModel({
          ...providerBase,
          messages: request.messages,
          tools: request.tools,
          requestedOutputTokens: request.requestedOutputTokens,
          thinkingMode: request.thinkingMode,
          reasoningEffort: request.reasoningEffort,
          onDelta: (delta) => { text += delta },
        }, modelSelection, () => { verifyGeneration?.(); providerBase.signal.throwIfAborted() }).catch(error => {
          // The compactor deliberately returns a finite local summary failure.
          // Preserve already-classified provider evidence for the admission UI.
          if (error instanceof ModelProtocolError) modelFailure = error
          throw error
        })
        verifyGeneration?.()
        if (response.toolCalls.length > 0) throw incompatibleResponse()
        return text
      },
    })
    verifyGeneration?.()
    providerBase.signal.throwIfAborted()
    if (result.status === 'compacted') {
      session.context = result.context
      session.usageBaseline = null
      const record = localCompactionRecord(result, profile)
      if (record) onCompaction?.(record)
    } else if (result.status === 'error') {
      onCompaction?.({ status: 'failed' })
      throw modelFailure ?? new PublicError('OPERATION_FAILED')
    }
  }

  private async runConversation(
    active: ActiveConversation,
    providerBase: Omit<ModelChatInput, 'messages' | 'tools' | 'onDelta'>,
    profile: ModelCapabilityProfile | undefined,
  ): Promise<void> {
    try {
      if (active.pendingUser !== null) {
        await this.completePendingRecovery(active, providerBase, profile)
      }
      while (true) {
        this.assertActiveOwner(active)
        if (active.budget.phase === 'finalizing') {
          await this.finalizeBudget(active, providerBase, profile)
          return
        }
        await this.ensureContextWithinHardLimit(active, profile, providerBase)
        await this.assertRootCapability(active.rootCapability)
        this.assertActiveOwner(active)
        this.assertModelSelection(active.modelSelection)
        const tools = toolsFor(active.capabilities)
        const messages = [
          { role: 'system' as const, content: AI_CONVERSATION_SYSTEM_PROMPT },
          ...wireContextMessages(active.session.context),
        ]
        if (active.documentChanged) {
          let userIndex = messages.length - 1
          while (userIndex > 0 && messages[userIndex]!.role !== 'user') userIndex -= 1
          // This notice belongs to the current turn, not the durable transcript.
          messages.splice(userIndex, 0, DOCUMENT_CHANGED_NOTICE)
        }
        if (active.budgetSoftNoticePending) messages.unshift(budgetSoftNotice(active.budget))
        if (active.continuationReadReset) messages.unshift(CONTINUATION_FRESH_READ_NOTICE)
        const estimatedInput = fixedInputTokens(tools)
          + estimateWireTokens(wireContextMessages(active.session.context))
          + (active.documentChanged ? estimateWireTokens([DOCUMENT_CHANGED_NOTICE]) : 0)
          + (active.budgetSoftNoticePending ? estimateWireTokens([budgetSoftNotice(active.budget)]) : 0)
          + (active.continuationReadReset ? estimateWireTokens([CONTINUATION_FRESH_READ_NOTICE]) : 0)
        const assistantMessageId = randomUUID()
        const round = beginAiToolRound(active.budget)
        active.budget = round.budget
        if (!round.started) continue
        active.budgetSoftNoticePending = false
        this.emitIfOwned(active, {
          requestId: active.requestId,
          type: 'message-start',
          messageId: assistantMessageId,
          previousTranscriptRevision: active.session.transcriptRevision,
        })
        const processRound = active.progress.beginRound(assistantMessageId)
        let assistantContent = ''
        const thinking = createModelReasoningTimer(active.controller.signal, (state) => {
          this.emitIfOwned(active, { requestId: active.requestId, type: 'thinking', messageId: assistantMessageId, ...state })
        })
        const result = await this.streamModel({
          ...providerBase,
          messages,
          tools,
          recognizedToolNames: AI_WORKSPACE_TOOL_NAMES,
          requestedOutputTokens: normalRequestedOutputTokens(profile),
          onProcess: delta => active.progress.append(processRound, delta),
          onReasoning: value => {
            if (!active.progress.modelRoundIsCurrent(processRound)) return
            active.progress.reasoning(processRound, value)
            thinking.update(value)
          },
          onDelta: (delta) => {
            if (!active.progress.modelRoundIsCurrent(processRound)) return
            active.progress.answering(processRound)
            if (!active.progress.modelRoundIsCurrent(processRound)) return
            assistantContent += delta
            for (const chunk of deltaChunks(delta)) {
              this.emitIfOwned(active, {
                requestId: active.requestId,
                type: 'delta',
                messageId: assistantMessageId,
                delta: chunk,
              })
            }
          },
        }, active.modelSelection, () => { this.assertActiveOwner(active); this.assertActiveGeneration(active) }).finally(thinking.dispose)
        this.assertActiveOwner(active)
        const validated = this.validateToolCalls(active, result.toolCalls)
        const admission = validated.length ? admitAiToolBatch(active.budget, validated.map(item => ({
          name: item.parsed.toolName, replay: active.toolResults.has(item.call.id),
        }))) : null
        if (admission) {
          active.budget = admission.budget
          active.budgetSoftNoticePending = admission.softNotice
          for (const item of validated) {
            active.seenToolCallIds.add(item.call.id)
            if (admission.admitted && !active.toolResults.has(item.call.id)) active.budgetAdmittedIds.add(item.call.id)
          }
        }
        active.progress.closeText()
        const assistant: Extract<ModelChatMessage, { role: 'assistant' }> = {
          role: 'assistant',
          content: assistantContent,
          reasoningContent: result.reasoningContent,
          ...(result.providerReplay === null ? {} : { providerReplay: result.providerReplay }),
          ...(result.toolCalls.length === 0 ? {} : { toolCalls: result.toolCalls }),
        }
        active.currentAssistant = assistant
        active.currentAssistantMessageId = assistantMessageId
        this.recordUsage(active, result.usage, estimatedInput, assistant)
        active.session.context = appendMessages(active.session.context, [assistant])
        active.currentAssistantToolBaseline = active.session.context
        active.session.visibleMessages.push({
          id: assistantMessageId,
          role: 'assistant',
          content: assistantContent,
        })
        active.session.transcriptRevision += 1
        this.emitIfOwned(active, {
          requestId: active.requestId,
          type: 'message-completed',
          messageId: assistantMessageId,
          transcriptRevision: active.session.transcriptRevision,
        })
        if (validated.length === 0) {
          this.clearMutationRecoveries(active)
          active.progress.finish()
          active.budget = finishAiToolBudget(active.budget)
          active.completed = true
          this.emitIfOwned(active, { requestId: active.requestId, type: 'completed' })
          return
        }
        for (const item of validated) {
          active.controller.signal.throwIfAborted()
          const cached = active.toolResults.get(item.call.id)
          this.prepareProcessTool(active, item.call, item.parsed, cached)
          const message = cached !== undefined
            ? cached.message
            : admission?.admitted === false
              ? toolMessage(item.call, { kind: 'not-executed', reason: active.budget.stopReason }, true)
              : await this.executeTool(active, item.call, item.parsed)
          this.assertActiveOwner(active)
          this.finishProcessTool(active, item.call, item.parsed, message)
          active.session.context = appendMessages(active.session.context, [message])
          if (cached === undefined) {
            active.toolResults.set(item.call.id, {
              signature: toolSignature(item.call),
              message,
              process: active.processTools.get(item.call.id)?.facts,
            })
          }
        }
      }
    } catch (error) {
      active.progress.finish()
      if (this.active !== active || this.disposed) return
      this.restoreMutationRecoveries(active)
      const supersededRecovery = active.pendingUser !== null
        && active.startGeneration !== this.startGeneration
      if (supersededRecovery) {
        active.stopped = true
      } else if (active.controller.signal.aborted || isAbortError(error)) {
        if (!active.stopped) {
          active.stopped = true
          this.emitIfOwned(active, { requestId: active.requestId, type: 'stopped' })
        }
      } else {
        const code = error instanceof PublicError
          ? error.code : modelPublicErrorCode(error) ?? 'OPERATION_FAILED'
        active.segmentErrorCode = code
        const detail = error instanceof ModelProtocolError
          ? parseModelErrorDetail(Object.getOwnPropertyDescriptor(error, 'detail')?.value) : null
        this.emitIfOwned(active, {
          requestId: active.requestId,
          type: 'failed',
          code,
          message: PUBLIC_ERROR_MESSAGES[code],
          ...(detail ? { detail } : {}),
        })
      }
    } finally {
      try {
        this.segmentDiagnostics.push(frozenSegmentDiagnostic({ version: 1, id: randomUUID(),
          modelFingerprint: active.budgetProfileFingerprint,
          terminal: active.budgetPaused ? 'budget-paused' : active.completed ? 'completed'
            : active.stopped || active.controller.signal.aborted ? 'stopped' : 'failed',
          stage: active.budget.finalizationAttempted ? 'finalization' : 'tools', reason: active.budget.stopReason, code: active.segmentErrorCode,
          counts: budgetCounts(active.budget), outcomes: budgetOutcomes(active.budget, active.budgetAdmittedIds,
            [...active.processTools.values()].map(tool => tool.facts)),
          revalidationReads: active.revalidationReads, resetReasons: active.continuationResetReasons,
          elapsedMs: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Date.now() - active.segmentStartedAt)) }))
        if (this.segmentDiagnostics.length > 64) this.segmentDiagnostics.shift()
      } catch { /* Diagnostic failure cannot change the conversation outcome. */ }
      active.progress.dispose()
      for (const pending of [...active.pendingAuthorizations.values()]) {
        this.settleAuthorization(active, pending, false, 'authorization-abandoned')
      }
      if (active.executing.size > 0) await Promise.allSettled([...active.executing])
      await this.releaseCurrentDocumentSnapshot(active)
      if (this.active === active) this.active = undefined
    }
  }

  private async finalizeBudget(active: ActiveConversation,
    providerBase: Omit<ModelChatInput, 'messages' | 'tools' | 'onDelta'>,
    profile: ModelCapabilityProfile | undefined): Promise<void> {
    const reason = active.budget.stopReason
    if (reason === null) throw new PublicError('OPERATION_FAILED')
    const counts = budgetCounts(active.budget)
    const outcomes = budgetOutcomes(active.budget, active.budgetAdmittedIds,
      [...active.processTools.values()].map(tool => tool.facts))
    // A paired tool batch still needs an assistant closure to form a complete
    // wire transaction. Prepare a truthful local fallback before any await.
    const fallback = appendMessages(active.session.context, [budgetLocalClosure(reason, counts, outcomes)])
    if (fallback.openTransaction.length > 0) throw new PublicError('OPERATION_FAILED')
    active.budgetFallbackContext = fallback
    const claim = claimAiFinalization(active.budget)
    active.budget = claim.budget
    if (!claim.started) throw new PublicError('OPERATION_FAILED')
    const instruction: ModelChatMessage = { role: 'system', content:
      '本段工具预算已到边界，禁止再请求工具。只总结已配对工具结果能证明的结论、成功或待确认操作和尚未核查范围；不得声称读取过未读取内容。用户可主动继续下一段。' }
    const messages: ModelChatMessage[] = [{ role: 'system', content: AI_CONVERSATION_SYSTEM_PROMPT }, instruction,
      ...wireContextMessages(active.session.context)]
    if (active.documentChanged) {
      let userIndex = messages.length - 1
      while (userIndex > 0 && messages[userIndex]!.role !== 'user') userIndex -= 1
      messages.splice(userIndex, 0, DOCUMENT_CHANGED_NOTICE)
    }
    if (active.continuationReadReset) messages.unshift(CONTINUATION_FRESH_READ_NOTICE)
    const estimatedInput = estimateWireTokens(messages) + estimateTextTokens('[]') + PROVIDER_ENVELOPE_ESTIMATE_TOKENS
    const capacity = contextUsageSnapshot({ profile, capabilities: active.capabilities,
      estimatedNextRequestTokens: estimatedInput, wireLineage: active.session.context.lineage,
      usageBaseline: active.session.usageBaseline })
    let finalization: AiBudgetFinalization = { status: 'context-limit' }
    if (!capacity.visible || capacity.inputTokens <= capacity.hardLimitTokens) {
      try {
        this.assertActiveOwner(active)
        this.assertActiveGeneration(active)
        await this.assertRootCapability(active.rootCapability)
        this.assertActiveOwner(active)
        this.assertModelSelection(active.modelSelection)
        const messageId = randomUUID()
        this.emitIfOwned(active, { requestId: active.requestId, type: 'message-start', messageId,
          previousTranscriptRevision: active.session.transcriptRevision })
        const round = active.progress.beginRound(messageId)
        let content = ''
        const thinking = createModelReasoningTimer(active.controller.signal, state => {
          this.emitIfOwned(active, { requestId: active.requestId, type: 'thinking', messageId, ...state })
        })
        const result = await this.streamModel({ ...providerBase,
          messages,
          tools: [], recognizedToolNames: AI_WORKSPACE_TOOL_NAMES,
          requestedOutputTokens: normalRequestedOutputTokens(profile),
          onProcess: delta => active.progress.append(round, delta),
          onReasoning: value => {
            if (!active.progress.modelRoundIsCurrent(round)) return
            active.progress.reasoning(round, value)
            thinking.update(value)
          },
          onDelta: delta => {
            if (!active.progress.modelRoundIsCurrent(round)) return
            active.progress.answering(round)
            if (!active.progress.modelRoundIsCurrent(round)) return
            content += delta
            for (const chunk of deltaChunks(delta)) this.emitIfOwned(active, {
              requestId: active.requestId, type: 'delta', messageId, delta: chunk,
            })
          },
        }, active.modelSelection, () => { this.assertActiveOwner(active); this.assertActiveGeneration(active) }).finally(thinking.dispose)
        this.assertActiveOwner(active)
        this.assertActiveGeneration(active)
        active.progress.closeText()
        if (result.toolCalls.length > 0) finalization = { status: 'tools-returned' }
        else {
          const assistant: Extract<ModelChatMessage, { role: 'assistant' }> = {
            role: 'assistant', content, reasoningContent: result.reasoningContent,
            ...(result.providerReplay === null ? {} : { providerReplay: result.providerReplay }),
          }
          this.recordUsage(active, result.usage, estimatedInput, assistant)
          active.session.context = appendMessages(active.session.context, [assistant])
          active.session.visibleMessages.push({ id: messageId, role: 'assistant', content })
          active.session.transcriptRevision += 1
          this.emitIfOwned(active, { requestId: active.requestId, type: 'message-completed', messageId,
            transcriptRevision: active.session.transcriptRevision })
          finalization = { status: 'completed' }
        }
      } catch (error) {
        if (active.controller.signal.aborted || isAbortError(error)) throw error
        this.assertActiveOwner(active)
        const code = error instanceof PublicError ? error.code : modelPublicErrorCode(error) ?? 'OPERATION_FAILED'
        active.segmentErrorCode = code
        const detail = error instanceof ModelProtocolError
          ? parseModelErrorDetail(Object.getOwnPropertyDescriptor(error, 'detail')?.value) : null
        finalization = { status: 'failed', code, ...(detail ? { detail } : {}) }
      }
    }
    this.assertActiveOwner(active)
    if (finalization.status !== 'completed') {
      active.session.context = fallback
      active.session.usageBaseline = null
    }
    this.clearMutationRecoveries(active)
    active.progress.finish()
    active.budget = finishAiToolBudget(active.budget)
    active.budgetPaused = true
    const writeReceipts = new Map([...active.toolResults].filter(([, cached]) =>
      cached.process && !['read_current_document', 'read_workspace_document', 'list_workspace_entries'].includes(cached.process.toolName)
      && (cached.process.status === 'succeeded' || cached.process.status === 'unknown')))
    const continuationId = randomUUID()
    active.session.pausedBudgetSegment = { id: continuationId, binding: { ...active.binding },
      rootCapability: { ...active.rootCapability }, transcriptRevision: active.session.transcriptRevision,
      profileFingerprint: active.budgetProfileFingerprint, reads: new Map(active.continuationReads),
      untrackedHistoricalReads: active.untrackedHistoricalReads, writeReceipts }
    this.emitIfOwned(active, { requestId: active.requestId, type: 'budget-paused',
      transcriptRevision: active.session.transcriptRevision, continuationId,
      reason, counts, outcomes, finalization })
  }

  private async completePendingRecovery(
    active: ActiveConversation,
    providerBase: Omit<ModelChatInput, 'messages' | 'tools' | 'onDelta'>,
    profile: ModelCapabilityProfile | undefined,
  ): Promise<void> {
    const pendingUser = active.pendingUser
    if (pendingUser === null || !active.session.recoveryPending) return
    if (this.options.authority) await this.options.authority.readFresh()
    this.assertRecoveryAuthority(active)
    const sourceSession = active.session
    const sourceTranscriptRevision = sourceSession.transcriptRevision
    const sourceCapabilityRevision = sourceSession.capabilityRevision
    const sourceModelFingerprint = sourceSession.modelFingerprint
    const sourceRecoveryModelFingerprint = sourceSession.recoveryModelFingerprint
    const sourceWritePolicy = this.writePolicySnapshot()
    if (sourceSession.observedWritePolicy !== sourceWritePolicy.policy
      || sourceSession.observedWritePolicyRevision !== sourceWritePolicy.revision) {
      throw new PublicError('OPERATION_FAILED')
    }
    const candidate = cloneSession(sourceSession)
    const committedCompactions: AiContextCompactionRecord[] = []
    const observeCompaction = (record: AiContextCompactionRecord) => {
      if (record.status === 'compacted') committedCompactions.push(record)
      else this.emitCompactionRecord(active, record)
    }
    const assistantMessageId = randomUUID()
    let assistantContent = ''
    let assistantDeltas: string[] = []
    let recoveryThinkingElapsedMs: number | null = null
    let normalizedUsage: ModelUsage | null = null
    let assistant: Extract<ModelChatMessage, { role: 'assistant' }>
    if (active.recoveryUsesLocalClosure) {
      assistantContent = localRecoveryMessage(localRecoveryOperations(candidate))
      assistantDeltas = deltaChunks(assistantContent)
      assistant = { role: 'assistant', content: assistantContent }
      this.closeRecoveryForModelSwitch(candidate, assistant)
      await this.ensureContextWithinHardLimit(active, profile, providerBase, candidate, observeCompaction)
      this.assertRecoveryAuthority(active)
    } else {
      await this.ensureContextWithinHardLimit(active, profile, providerBase, candidate, observeCompaction)
      this.assertRecoveryAuthority(active)
      await this.assertRootCapability(active.rootCapability)
      this.assertRecoveryAuthority(active)
      this.assertModelSelection(active.modelSelection)
      const messages = [
        { role: 'system' as const, content: AI_CONVERSATION_SYSTEM_PROMPT },
        ...wireContextMessages(candidate.context),
      ]
      // Recovery output is published atomically after authority checks. Keep only
      // its observed duration here; no draft text or live phase escapes early.
      const thinking = createModelReasoningTimer(active.controller.signal, (state) => {
        if (!state.active) recoveryThinkingElapsedMs = state.elapsedMs
      })
      const result = await this.streamModel({
        ...providerBase,
        messages,
        tools: [],
        requestedOutputTokens: normalRequestedOutputTokens(profile),
        onReasoning: thinking.update,
        onDelta: (delta) => {
          assistantContent += delta
          assistantDeltas.push(...deltaChunks(delta))
        },
      }, active.modelSelection, () => this.assertRecoveryAuthority(active)).finally(thinking.dispose)
      this.assertRecoveryAuthority(active)
      await this.assertRootCapability(active.rootCapability)
      this.assertRecoveryAuthority(active)
      this.assertModelSelection(active.modelSelection)
      if (result.toolCalls.length > 0) throw incompatibleResponse()
      assistant = {
        role: 'assistant',
        content: assistantContent,
        reasoningContent: result.reasoningContent,
        ...(result.providerReplay === null ? {} : { providerReplay: result.providerReplay }),
      }
      normalizedUsage = this.applyUsage(
        candidate,
        result.usage,
        fixedInputTokens([]) + estimateWireTokens(wireContextMessages(candidate.context)),
        assistant,
      )
      candidate.context = appendMessages(candidate.context, [assistant])
    }
    candidate.visibleMessages.push({
      id: assistantMessageId,
      role: 'assistant',
      content: assistantContent,
    })
    candidate.transcriptRevision += 1
    const recoveryTranscriptRevision = candidate.transcriptRevision
    candidate.recoveryPending = false
    candidate.recoveryModelFingerprint = null

    const userWire: ModelChatMessage[] = [{ role: 'user', content: pendingUser.content }]
    let documentChanged = candidate.committedDocumentEpoch !== this.documentEpoch
    await this.compactBeforeAppend(candidate, documentChanged ? [DOCUMENT_CHANGED_NOTICE, ...userWire] : userWire, profile, providerBase, async () => {
      this.assertActiveGeneration(active)
      await this.assertRootCapability(active.rootCapability)
      this.assertRecoveryAuthority(active)
      this.assertModelSelection(active.modelSelection)
    }, () => this.assertActiveGeneration(active), candidate.capabilities, observeCompaction, active.modelSelection)
    this.assertRecoveryAuthority(active)
    await this.assertRootCapability(active.rootCapability)
    this.assertRecoveryAuthority(active)
    this.assertModelSelection(active.modelSelection)
    if (this.options.authority) await this.options.authority.readFresh()
    this.assertRecoveryAuthority(active)
    this.assertModelSelection(active.modelSelection)
    const finalWritePolicy = this.writePolicySnapshot()
    if (active.session !== sourceSession
      || this.sessions.get(sourceSession.workspaceId) !== sourceSession
      || sourceSession.transcriptRevision !== sourceTranscriptRevision
      || sourceSession.capabilityRevision !== sourceCapabilityRevision
      || !sourceSession.recoveryPending
      || sourceSession.modelFingerprint !== sourceModelFingerprint
      || sourceSession.recoveryModelFingerprint !== sourceRecoveryModelFingerprint
      || sourceSession.observedWritePolicy !== sourceWritePolicy.policy
      || sourceSession.observedWritePolicyRevision !== sourceWritePolicy.revision
      || finalWritePolicy.policy !== sourceWritePolicy.policy
      || finalWritePolicy.revision !== sourceWritePolicy.revision) {
      throw new PublicError('OPERATION_FAILED')
    }
    this.assertActiveGeneration(active)
    const rollbackContext = candidate.context
    const rollbackDocumentEpoch = candidate.committedDocumentEpoch
    documentChanged = candidate.committedDocumentEpoch !== this.documentEpoch
    candidate.context = appendMessages(candidate.context, userWire)
    candidate.visibleMessages.push({ ...pendingUser })
    candidate.transcriptRevision += 1
    candidate.committedDocumentEpoch = this.documentEpoch
    const userTranscriptRevision = candidate.transcriptRevision
    active.session = candidate
    this.sessions.set(candidate.workspaceId, candidate)
    active.rollbackContext = rollbackContext
    active.rollbackDocumentEpoch = rollbackDocumentEpoch
    active.pendingUser = null
    active.documentChanged = documentChanged
    active.currentAssistant = assistant
    active.currentAssistantMessageId = assistantMessageId
    active.currentAssistantToolBaseline = null
    this.assertActiveGeneration(active)
    this.emitIfOwned(active, {
      requestId: active.requestId,
      type: 'message-start',
      messageId: assistantMessageId,
      previousTranscriptRevision: sourceTranscriptRevision,
    })
    active.progress.beginRound(assistantMessageId, false)
    if (recoveryThinkingElapsedMs !== null) {
      // Replay a closed phase only when the matching recovery message commits.
      this.emitIfOwned(active, { requestId: active.requestId, type: 'thinking', messageId: assistantMessageId, active: true, elapsedMs: 0 })
      this.emitIfOwned(active, { requestId: active.requestId, type: 'thinking', messageId: assistantMessageId, active: false, elapsedMs: recoveryThinkingElapsedMs })
    }
    for (const chunk of assistantDeltas) {
      this.emitIfOwned(active, {
        requestId: active.requestId,
        type: 'delta',
        messageId: assistantMessageId,
        delta: chunk,
      })
    }
    if (normalizedUsage !== null) {
      this.emitIfOwned(active, {
        requestId: active.requestId,
        type: 'usage',
        usage: normalizedUsage,
      })
    }
    active.progress.closeText()
    this.emitIfOwned(active, {
      requestId: active.requestId,
      type: 'message-completed',
      messageId: assistantMessageId,
      transcriptRevision: recoveryTranscriptRevision,
    })
    this.emitIfOwned(active, {
      requestId: active.requestId,
      type: 'user-message-accepted',
      messageId: pendingUser.id,
      transcriptRevision: userTranscriptRevision,
    })
    for (const record of committedCompactions) this.emitCompactionRecord(active, record)
  }

  private recordUsage(
    active: ActiveConversation,
    usage: ModelUsage | null,
    estimatedInput: number,
    assistant: Extract<ModelChatMessage, { role: 'assistant' }>,
  ): void {
    const normalized = this.applyUsage(active.session, usage, estimatedInput, assistant)
    this.emitIfOwned(active, { requestId: active.requestId, type: 'usage', usage: normalized })
  }

  private applyUsage(
    session: WorkspaceSession,
    usage: ModelUsage | null,
    estimatedInput: number,
    assistant: Extract<ModelChatMessage, { role: 'assistant' }>,
  ): ModelUsage {
    const estimatedOutput = estimateWireTokens([assistant])
    const normalized = usage ?? {
      inputTokens: estimatedInput,
      outputTokens: estimatedOutput,
      totalTokens: estimatedInput + estimatedOutput,
      cachedInputTokens: null,
      estimated: true,
    }
    if (usage !== null) {
      session.usageBaseline = {
        usage,
        wireLineage: session.context.lineage,
        estimatedNextRequestTokensAtRequest: estimatedInput,
      }
    }
    return normalized
  }

  private async ensureContextWithinHardLimit(
    active: ActiveConversation,
    profile: ModelCapabilityProfile | undefined,
    providerBase: Omit<ModelChatInput, 'messages' | 'tools' | 'onDelta'>,
    session: WorkspaceSession = active.session,
    onCompaction: (record: AiContextCompactionRecord) => void = (record) => this.emitCompactionRecord(active, record),
  ): Promise<void> {
    this.assertActiveGeneration(active)
    if (profile === undefined) return
    const capabilities = session === active.session ? active.capabilities : session.capabilities
    const tools = toolsFor(capabilities)
    const fixed = fixedInputTokens(tools) + (active.documentChanged ? estimateWireTokens([DOCUMENT_CHANGED_NOTICE]) : 0)
      + (active.continuationReadReset ? estimateWireTokens([CONTINUATION_FRESH_READ_NOTICE]) : 0)
      + (active.budgetSoftNoticePending ? estimateWireTokens([budgetSoftNotice(active.budget)]) : 0)
    const snapshot = () => contextUsageSnapshot({
      profile,
      capabilities,
      estimatedNextRequestTokens: fixed + estimateWireTokens(wireContextMessages(session.context)),
      wireLineage: session.context.lineage,
      usageBaseline: session.usageBaseline,
    })
    const before = snapshot()
    if (!before.visible || before.inputTokens <= before.hardLimitTokens) return

    const openTransaction = session.context.openTransaction
    if (estimateWireTokens(openTransaction) > before.hardLimitTokens) {
      throw new PublicError('TOOL_RESULT_TOO_LARGE')
    }
    if (session.context.checkpoint !== null || session.context.transactions.length > 0) {
      const compactable: AiWireContext = openTransaction.length === 0 ? session.context : {
        ...session.context,
        openTransaction: [],
      }
      const result = await compactWireContext({
        context: compactable,
        profile,
        capabilities,
        usageBaseline: session.usageBaseline,
        fixedInputTokens: fixed + estimateWireTokens(openTransaction),
        summarize: async (request) => {
          this.assertActiveGeneration(active)
          await this.assertRootCapability(active.rootCapability)
          this.assertActiveOwner(active)
          this.assertActiveGeneration(active)
          this.assertModelSelection(active.modelSelection)
          let text = ''
          const response = await this.streamModel({
            ...providerBase,
            messages: request.messages,
            tools: request.tools,
            requestedOutputTokens: request.requestedOutputTokens,
            thinkingMode: request.thinkingMode,
            reasoningEffort: request.reasoningEffort,
            onDelta: (delta) => { text += delta },
          }, active.modelSelection, () => { this.assertActiveOwner(active); this.assertActiveGeneration(active) })
          this.assertActiveGeneration(active)
          if (response.toolCalls.length > 0) throw incompatibleResponse()
          return text
        },
      })
      this.assertActiveGeneration(active)
      this.assertActiveOwner(active)
      if (result.status === 'compacted') {
        session.context = openTransaction.length === 0 ? result.context : {
          ...result.context,
          openTransaction,
        }
        session.usageBaseline = null
      }
      const record = localCompactionRecord(result, profile)
      if (record) onCompaction(record)
    }
    const after = snapshot()
    if (after.visible && after.inputTokens > after.hardLimitTokens) {
      throw new PublicError('AI_CONTEXT_LIMIT_REACHED')
    }
  }

  private validateToolCalls(active: ActiveConversation, calls: readonly ModelToolCall[]): Array<{
    call: ModelToolCall
    parsed: AiWorkspaceToolArguments
  }> {
    const batchIds = new Set<string>()
    const validated = calls.map((call) => {
      if (!isCanonicalAiToolCallId(call.id) || batchIds.has(call.id)) throw invalidToolResponse('tool-invalid-identity')
      if (!AI_WORKSPACE_TOOL_NAMES.includes(call.name as AiWorkspaceToolName)) throw invalidToolResponse('tool-invalid-name')
      batchIds.add(call.id)
      const cached = active.toolResults.get(call.id)
      if (cached !== undefined) {
        if (cached.signature !== toolSignature(call)) throw invalidToolResponse('tool-invalid-identity')
      } else {
        if (active.seenToolCallIds.has(call.id)) throw invalidToolResponse('tool-invalid-identity')
      }
      let raw: unknown
      try { raw = JSON.parse(call.argumentsJson) } catch { throw invalidToolResponse('tool-invalid-arguments') }
      const parsed = parseWorkspaceToolArguments(call.name as AiWorkspaceToolName, raw)
      if (parsed === undefined) throw invalidToolResponse('tool-invalid-arguments')
      return { call, parsed }
    })
    return validated
  }

  private prepareProcessTool(active: ActiveConversation, call: ModelToolCall,
    parsed: AiWorkspaceToolArguments, cached: CachedToolResult | undefined): void {
    const paths = parsed.toolName === 'read_current_document' ? []
      : parsed.toolName === 'rename_workspace_document' ? [parsed.arguments.path, parsed.arguments.newPath]
        : parsed.arguments.path ? [parsed.arguments.path] : []
    active.processTools.set(call.id, {
      facts: cached?.process ? { ...cached.process, cached: true } : {
        toolCallId: call.id, toolName: parsed.toolName, operationId: null, paths,
        displayName: null, cached: cached !== undefined, status: 'not-executed',
      },
      terminal: false,
    })
  }

  private processToolStatus(active: ActiveConversation, toolCallId: string,
    status: AiConversationToolFacts['status'], trustedSettlement = false, reason?: AiConversationToolFacts['reason']): void {
    const tool = active.processTools.get(toolCallId)
    if (!tool || tool.terminal || (status === 'running' && tool.facts.status === 'running')) return
    if (status === 'running') active.progress.setStage('tool-running')
    if (status === 'awaiting-approval') active.progress.setStage('awaiting-approval')
    tool.facts = { ...tool.facts, status, ...(reason ? { reason } : {}) }
    tool.terminal = status !== 'running' && status !== 'awaiting-approval'
    active.progress.tool(tool.facts, trustedSettlement)
  }

  private finishProcessTool(active: ActiveConversation, call: ModelToolCall,
    parsed: AiWorkspaceToolArguments, message: Extract<ModelChatMessage, { role: 'tool' }>): void {
    const tool = active.processTools.get(call.id)
    if (!tool || tool.terminal) return
    if (tool.facts.cached) { this.processToolStatus(active, call.id, tool.facts.status); return }
    let verified: AiWorkspaceToolResult | AiCurrentDocumentToolResult | undefined
    try { verified = parseWorkspaceToolResult(parsed.toolName, JSON.parse(message.content)) } catch { /* No untrusted prose reaches display. */ }
    const status = verified?.kind === 'mutation'
      ? verified.state === 'succeeded' || verified.state === 'failed' || verified.state === 'unknown'
        ? verified.state : 'unavailable'
      : verified?.kind === 'document' || verified?.kind === 'entries' ? 'succeeded'
        : verified?.kind === 'denied' ? 'denied' : verified?.kind === 'not-executed' ? 'not-executed' : 'unavailable'
    this.processToolStatus(active, call.id, status)
  }

  private async observeProcessRead<T>(active: ActiveConversation, toolCallId: string,
    read: () => Promise<T>): Promise<T> {
    try { return await read() } catch (error) {
      // Only the display status distinguishes an actual read exception. The
      // existing unavailable tool response and provider replay remain unchanged.
      this.processToolStatus(active, toolCallId, 'failed')
      throw error
    }
  }

  private async executeTool(
    active: ActiveConversation,
    call: ModelToolCall,
    parsed: AiWorkspaceToolArguments,
  ): Promise<Extract<ModelChatMessage, { role: 'tool' }>> {
    if (parsed.toolName === 'read_current_document') {
      if (!active.capabilities.currentDocument) {
        return toolMessage(call, { kind: 'denied', guidance: '请开启“AI 可查看文档”。' }, true)
      }
      const revision = active.session.capabilityRevision
      try {
        return toolMessage(call, await this.readCurrentDocument(active, call.id, parsed.arguments, revision))
      } catch (error) {
        if (error instanceof CurrentDocumentReleaseAuthorityError) throw error
        return toolMessage(call, { kind: 'unavailable' }, true)
      }
    }
    if (!active.session.capabilities.workspace) {
      return toolMessage(call, { kind: 'denied', guidance: '请开启“AI 可查看工作区”。' }, true)
    }
    const capabilityRevision = active.session.capabilityRevision
    try {
      if (parsed.toolName === 'list_workspace_entries') {
        this.processToolStatus(active, call.id, 'running')
        this.assertToolCapability(active, capabilityRevision, 'workspace')
        const raw = await this.observeProcessRead(active, call.id,
          () => this.options.files.listEntries(parsed.arguments, active.controller.signal))
        this.assertToolCapability(active, capabilityRevision, 'workspace')
        const page = parseWorkspaceToolResult('list_workspace_entries', raw)
        if (page === undefined || page.kind !== 'entries'
          || page.directoryPath !== parsed.arguments.path
          || page.cursor !== parsed.arguments.cursor
          || page.entries.length > parsed.arguments.maxEntries
          || page.directoryVersion.workspaceGeneration !== active.session.workspaceGeneration
          || (parsed.arguments.directoryVersion !== null
            && !sameDirectoryVersion(page.directoryVersion, parsed.arguments.directoryVersion))) {
          return toolMessage(call, { kind: 'unavailable' }, true)
        }
        this.reconcileUnknownBarriersFromList(active.session, page)
        this.rememberContinuationRead(active, `directory\0${windowsPathKey(page.directoryPath)}`,
          { kind: 'directory', path: page.directoryPath, version: { ...page.directoryVersion } })
        return toolMessage(call, page)
      }
      if (parsed.toolName === 'read_workspace_document') {
        const seriesKey = windowsPathKey(parsed.arguments.path)
        if (parsed.arguments.cursor === 0 && active.workspaceReadSeriesStarted.has(seriesKey)) {
          return toolMessage(call, { kind: 'unavailable' }, true)
        }
        this.processToolStatus(active, call.id, 'running')
        this.assertToolCapability(active, capabilityRevision, 'workspace')
        const raw = await this.observeProcessRead(active, call.id,
          () => this.options.files.readDocument(parsed.arguments, active.controller.signal))
        this.assertToolCapability(active, capabilityRevision, 'workspace')
        const page = parseWorkspaceToolResult('read_workspace_document', raw)
        if (page === undefined || page.kind !== 'document'
          || page.path !== parsed.arguments.path
          || !validDocumentPageEcho(parsed.arguments, page)) {
          return toolMessage(call, { kind: 'unavailable' }, true)
        }
        const opened = active.workspaceReadVersions.get(seriesKey)
        if (parsed.arguments.cursor > 0 && (opened === undefined || !sameVersion(opened, page.version))) {
          return toolMessage(call, { kind: 'unavailable' }, true)
        }
        if (parsed.arguments.cursor === 0) {
          active.workspaceReadSeriesStarted.add(seriesKey)
          active.workspaceReadVersions.set(seriesKey, page.version)
          this.reconcileUnknownBarrier(active.session, page.path, page.version.fileId)
        }
        this.rememberContinuationRead(active, `document\0${seriesKey}`,
          { kind: 'document', path: page.path, version: { ...page.version } })
        return toolMessage(call, page)
      }
      return await this.executeMutation(active, call, parsed, capabilityRevision)
    } catch {
      return toolMessage(call, { kind: 'unavailable' }, true)
    }
  }

  private async readCurrentDocument(
    active: ActiveConversation,
    toolCallId: string,
    argumentsValue: AiCurrentDocumentToolArguments,
    capabilityRevision: number,
  ): Promise<AiCurrentDocumentToolResult> {
    if (!active.session.capabilities.currentDocument || active.expectedDocumentId === null) return { kind: 'unavailable' }
    const expectedDocumentId = active.expectedDocumentId
    let opened = active.currentDocumentSnapshot
    if (argumentsValue.cursor === 0) {
      if (active.submittedDocumentEpoch !== this.documentEpoch) return { kind: 'unavailable' }
      if (active.currentDocumentSeriesStarted) return { kind: 'unavailable' }
      const epoch = this.documentEpoch
      this.processToolStatus(active, toolCallId, 'running')
      this.assertToolCapability(active, capabilityRevision, 'currentDocument')
      const candidate = await this.observeProcessRead(active, toolCallId, () => this.options.currentDocument.openSnapshot({
        ...(expectedDocumentId !== undefined ? { expectedDocumentId } : {}),
        requestId: active.requestId,
        conversationId: active.session.conversationId,
        workspaceId: active.session.workspaceId,
        workspaceGeneration: active.session.workspaceGeneration,
        toolCallId,
        signal: active.controller.signal,
      }))
      try {
        this.assertToolCapability(active, capabilityRevision, 'currentDocument')
      } catch (error) {
        if (candidate !== null) await this.releaseDocumentSnapshot(candidate)
        throw error
      }
      if (epoch !== this.documentEpoch || candidate === null) {
        if (candidate !== null) await this.releaseDocumentSnapshot(candidate)
        return { kind: 'unavailable' }
      }
      opened = candidate
      active.currentDocumentSnapshot = candidate
      active.currentDocumentEpoch = epoch
    } else if (opened === null) return { kind: 'unavailable' }
    let raw: AiCurrentDocumentToolResult
    try {
      this.processToolStatus(active, toolCallId, 'running')
      this.assertToolCapability(active, capabilityRevision, 'currentDocument')
      raw = await this.observeProcessRead(active, toolCallId,
        () => opened.readPage(argumentsValue, active.controller.signal))
    } catch (error) {
      if (argumentsValue.cursor === 0) {
        await this.releaseCurrentDocumentSnapshot(active)
        this.assertCurrentDocumentReleaseAuthority(active, capabilityRevision)
      }
      throw error
    }
    this.assertToolCapability(active, capabilityRevision, 'currentDocument')
    const page = parseWorkspaceToolResult('read_current_document', raw)
    const stableVersion = page?.kind === 'document'
      && (argumentsValue.cursor === 0 || active.currentDocumentVersion === null
        || sameVersion(active.currentDocumentVersion, page.version))
    if (page === undefined || page.kind !== 'document' || !stableVersion
      || !validDocumentPageEcho(argumentsValue, page)) {
      if (argumentsValue.cursor === 0) {
        await this.releaseCurrentDocumentSnapshot(active)
        this.assertCurrentDocumentReleaseAuthority(active, capabilityRevision)
      }
      return { kind: 'unavailable' }
    }
    if (argumentsValue.cursor === 0) {
      active.currentDocumentSeriesStarted = true
      active.currentDocumentVersion = { ...page.version }
    }
    if (!page.hasMore) {
      await this.releaseCurrentDocumentSnapshot(active)
      this.assertCurrentDocumentReleaseAuthority(active, capabilityRevision)
    }
    this.rememberContinuationRead(active, 'current', { kind: 'current', expectedDocumentId,
      documentEpoch: active.submittedDocumentEpoch, version: { ...page.version } })
    return page
  }

  private async executeMutation(
    active: ActiveConversation,
    call: ModelToolCall,
    parsed: Extract<AiWorkspaceToolArguments, { toolName: AiMutationToolName }>,
    capabilityRevision: number,
  ): Promise<Extract<ModelChatMessage, { role: 'tool' }>> {
    const mutationPaths = parsed.toolName === 'rename_workspace_document'
      ? [parsed.arguments.path, parsed.arguments.newPath] : [parsed.arguments.path]
    const mutationIdentities = parsed.toolName === 'create_workspace_document'
      ? [] : [parsed.arguments.expectedVersion.fileId]
    const barriers = [
      ...mutationPaths.map((path) => active.session.unknownPathBarriers.get(windowsPathKey(path))),
      ...mutationIdentities.map((identity) => active.session.unknownIdentityBarriers.get(identity)),
    ]
      .filter((barrier): barrier is { operationId: string; reconciled: boolean } => barrier !== undefined)
    if (barriers.some((barrier) => !barrier.reconciled)) {
      return toolMessage(call, { kind: 'denied' }, true)
    }
    const forceApproval = barriers.length > 0
    const authoritySnapshot = this.options.authority ? await this.options.authority.readFresh() : undefined
    this.assertToolCapability(active, capabilityRevision, 'workspace')
    this.assertModelSelection(active.modelSelection)
    const plannedPolicy = this.trustedWritePolicy(active.session)
    const policy = plannedPolicy.policy
    if (parsed.toolName !== 'edit_workspace_document' && policy === 'document-grant') {
      return toolMessage(call, { kind: 'denied', guidance: '创建、重命名或删除文档需要选择“每次询问”或“按工作区许可”。' }, true)
    }
    let manifest: AiOperationManifest
    const planning = (async () => {
      const planned = await this.planMutation(active, call, parsed, capabilityRevision)
      try {
        if (this.options.authority) await this.options.authority.readFresh()
        this.assertToolCapability(active, capabilityRevision, 'workspace')
        this.assertModelSelection(active.modelSelection)
        return planned
      } catch (error) {
        try { this.options.files.abandon(planned, 'authority-changed') } catch { /* terminal elsewhere */ }
        throw error
      }
    })()
    active.planning.add(planning)
    try {
      manifest = await planning
    } catch (error) {
      const stale = await this.invalidateStaleDocumentReads(active, error, mutationPaths)
      return toolMessage(call, { kind: 'unavailable',
        ...(stale ? { reason: 'target-changed', guidance: AI_STALE_TARGET_GUIDANCE } : {}),
      }, true)
    } finally {
      active.planning.delete(planning)
    }
    this.assertToolCapability(active, capabilityRevision, 'workspace')
    const processTool = active.processTools.get(call.id)
    if (processTool) processTool.facts = { ...processTool.facts,
      operationId: manifest.operationId, paths: [...manifest.relativePaths] }
    if (active.session.terminalMutationIds.has(manifest.operationId)) {
      return toolMessage(call, {
        kind: 'mutation', operationId: manifest.operationId,
        state: 'unknown', paths: [...manifest.relativePaths],
      }, true)
    }
    const afterPlanPolicy = this.trustedWritePolicy(active.session)
    if (afterPlanPolicy.revision !== plannedPolicy.revision
      || afterPlanPolicy.policy !== plannedPolicy.policy) {
      try { this.options.files.abandon(manifest, 'write-policy-changed') } catch { /* terminal elsewhere */ }
      return toolMessage(call, { kind: 'denied' }, true)
    }
    if (manifest.workspaceGeneration !== active.session.workspaceGeneration) {
      try { this.options.files.abandon(manifest, 'workspace-changed') } catch { /* terminal elsewhere */ }
      return toolMessage(call, { kind: 'unavailable' }, true)
    }

    const scope: AiAuthorizationScope = policy === 'workspace-grant'
      ? 'workspace' : policy === 'document-grant' ? 'document' : 'action'
    const documentIdentity = parsed.toolName === 'edit_workspace_document'
      ? parsed.arguments.expectedVersion.fileId : null
    const existingGrant = scope === 'workspace'
      // Selecting this trusted policy authorizes only the active workspace.
      // Manifest planning and the generation/policy fences still precede execution.
      ? true
      : scope === 'document' && documentIdentity !== null
        ? active.session.documentGrants.get(`${manifest.workspaceGeneration}\0${documentIdentity}`)
          === plannedPolicy.revision
        : false
    const currentDocumentGranted = !forceApproval && !existingGrant && scope === 'document'
      && this.matchesCurrentDocumentWriteAuthority(active, manifest.relativePaths[0]!)
      && this.options.files.isPlannedEditorEdit?.(manifest) === true
    const granted = !forceApproval && (existingGrant || currentDocumentGranted)
    let allowed = granted
    if (!granted) {
      this.processToolStatus(active, call.id, 'awaiting-approval')
      allowed = await this.waitForAuthorization(active, call.id, manifest, scope, plannedPolicy)
    }
    active.controller.signal.throwIfAborted()
    if (!allowed) return toolMessage(call, { kind: 'denied' }, true)

    try {
      this.assertToolCapability(active, capabilityRevision, 'workspace')
    } catch {
      try { this.options.files.abandon(manifest, 'workspace-capability-changed') } catch { /* terminal elsewhere */ }
      return toolMessage(call, { kind: 'denied' }, true)
    }
    const beforeExecutePolicy = this.trustedWritePolicy(active.session)
    if (beforeExecutePolicy.revision !== plannedPolicy.revision
      || beforeExecutePolicy.policy !== plannedPolicy.policy
      || (currentDocumentGranted && !this.matchesCurrentDocumentWriteAuthority(active, manifest.relativePaths[0]!))) {
      if (!granted) active.authorizedNotExecuting.delete(manifest.operationId)
      try { this.options.files.abandon(manifest, 'write-policy-changed') } catch { /* terminal elsewhere */ }
      return toolMessage(call, { kind: 'denied' }, true)
    }

    let finishExecution!: () => void
    const terminalization = new Promise<void>((resolve) => { finishExecution = resolve })
    let execution: Promise<WorkspaceAiMutationExecution>
    const startExecution = () => {
      this.assertToolCapability(active, capabilityRevision, 'workspace')
      this.assertActiveGeneration(active)
      const policy = this.trustedWritePolicy(active.session)
      if (policy.revision !== plannedPolicy.revision || policy.policy !== plannedPolicy.policy
        || (currentDocumentGranted && !this.matchesCurrentDocumentWriteAuthority(active, manifest.relativePaths[0]!))) throw new PublicError('OPERATION_FAILED')
      if (granted) this.options.files.authorize(manifest, manifest.nonce)
      else active.authorizedNotExecuting.delete(manifest.operationId)
      // executeAuthorized enters AiOperationJournal.executing synchronously before its first await.
      const completion = this.options.files.executeAuthorized(manifest)
      active.executing.add(terminalization)
      this.processToolStatus(active, call.id, 'running')
      if (!granted) {
        if (scope === 'workspace') active.session.workspaceGrant = { workspaceGeneration: manifest.workspaceGeneration, policyRevision: plannedPolicy.revision }
        if (scope === 'document' && documentIdentity !== null) active.session.documentGrants.set(`${manifest.workspaceGeneration}\0${documentIdentity}`, plannedPolicy.revision)
      }
      return { completion }
    }
    try {
      const admitted = this.options.authority && authoritySnapshot
        ? await this.options.authority.admitExecution(observeModelSettings(authoritySnapshot), { feature: 'aiConversation' }, startExecution)
        : startExecution()
      execution = admitted.completion
    } catch {
      active.authorizedNotExecuting.delete(manifest.operationId)
      try { this.options.files.abandon(manifest, 'authority-changed') } catch { /* terminal elsewhere */ }
      finishExecution()
      return toolMessage(call, { kind: 'denied' }, true)
    }
    try {
      const completed = await execution
      const verified = parseWorkspaceToolResult(parsed.toolName, completed.result)
      if (verified === undefined || verified.kind !== 'mutation' || verified.state !== 'succeeded') {
        return toolMessage(call, { kind: 'unavailable' }, true)
      }
      if (verified.operationId !== manifest.operationId
        || verified.paths.length !== manifest.relativePaths.length
        || verified.paths.some((path, index) => path !== manifest.relativePaths[index])) {
        active.mutationTerminalCommitted = true
        active.session.terminalMutationIds.add(manifest.operationId)
        active.session.workspaceGrant = null
        for (const version of manifest.expectedVersions) {
          active.session.documentGrants.delete(`${manifest.workspaceGeneration}\0${version.fileId}`)
          active.session.unknownIdentityBarriers.set(
            version.fileId,
            { operationId: manifest.operationId, reconciled: false },
          )
        }
        for (const path of manifest.relativePaths) {
          active.session.unknownPathBarriers.set(
            windowsPathKey(path),
            { operationId: manifest.operationId, reconciled: false },
          )
        }
        this.emitIfOwned(active, {
          requestId: active.requestId,
          type: 'operation-status',
          toolName: manifest.toolName,
          operationId: manifest.operationId,
          status: 'unknown',
          paths: [...manifest.relativePaths],
        })
        const message = toolMessage(call, { kind: 'unavailable' }, true)
        this.recordMutationRecovery(active, call, manifest.operationId, message)
        this.processToolStatus(active, call.id, 'unknown', true)
        return message
      }
      active.mutationTerminalCommitted = true
      for (const path of manifest.relativePaths) {
        active.session.unknownPathBarriers.delete(windowsPathKey(path))
      }
      for (const version of manifest.expectedVersions) {
        active.session.unknownIdentityBarriers.delete(version.fileId)
      }
      if (scope === 'document' && documentIdentity !== null && !currentDocumentGranted) {
        active.session.documentGrants.delete(`${manifest.workspaceGeneration}\0${documentIdentity}`)
        const successor = parseAiFileVersion(completed.successorVersion)
        if (successor !== undefined) {
          active.session.documentGrants.set(
            `${manifest.workspaceGeneration}\0${successor.fileId}`,
            plannedPolicy.revision,
          )
        }
      }
      // Only verified success opens a fresh read series. Old continuation pages
      // must not be combined with the new document version.
      for (const path of manifest.relativePaths) {
        active.workspaceReadSeriesStarted.delete(windowsPathKey(path))
        active.workspaceReadVersions.delete(windowsPathKey(path))
      }
      // Invalidate the snapshot's submitted document even if the user has since
      // selected another document. Selection liveness is an authorization fence,
      // not permission to keep returning pre-mutation pages of the old snapshot.
      const snapshotPath = active.currentDocumentWriteAuthority?.path
      if (snapshotPath !== undefined && manifest.relativePaths.some(path => (
        windowsPathKey(path) === windowsPathKey(snapshotPath)
      ))) {
        await this.releaseCurrentDocumentSnapshot(active)
      }
      this.emitMutationAudit(active, completed)
      const message = toolMessage(call, verified)
      this.recordMutationRecovery(active, call, manifest.operationId, message)
      this.processToolStatus(active, call.id, 'succeeded', true)
      return message
    } catch (error) {
      if (error instanceof AiOperationOutcomeUnknownError) {
        active.mutationTerminalCommitted = true
        active.session.terminalMutationIds.add(manifest.operationId)
        active.session.workspaceGrant = null
        for (const version of manifest.expectedVersions) {
          active.session.documentGrants.delete(`${manifest.workspaceGeneration}\0${version.fileId}`)
        }
        for (const path of manifest.relativePaths) {
          active.session.unknownPathBarriers.set(
            windowsPathKey(path),
            { operationId: manifest.operationId, reconciled: false },
          )
        }
        for (const version of manifest.expectedVersions) {
          active.session.unknownIdentityBarriers.set(
            version.fileId,
            { operationId: manifest.operationId, reconciled: false },
          )
        }
        this.emitIfOwned(active, {
          requestId: active.requestId,
          type: 'operation-status',
          toolName: manifest.toolName,
          operationId: manifest.operationId,
          status: 'unknown',
          paths: [...manifest.relativePaths],
        })
        const unknown: AiWorkspaceToolResult = {
          kind: 'mutation',
          operationId: manifest.operationId,
          state: 'unknown',
          paths: [...manifest.relativePaths],
        }
        const message = toolMessage(call, unknown, true)
        this.recordMutationRecovery(active, call, manifest.operationId, message)
        this.processToolStatus(active, call.id, 'unknown', true)
        return message
      }
      const recycleUnavailable = manifest.toolName === 'delete_workspace_document'
        && error instanceof WorkspaceAiFileError && error.code === 'AI_RECYCLE_UNAVAILABLE'
      const stale = await this.invalidateStaleDocumentReads(active, error, manifest.relativePaths)
      const message = toolMessage(call, {
        kind: 'mutation', operationId: manifest.operationId,
        state: 'failed', paths: [...manifest.relativePaths],
        ...(recycleUnavailable ? { reason: 'recycle-unavailable', guidance: AI_RECYCLE_UNAVAILABLE_GUIDANCE }
          : stale ? { reason: 'target-changed', guidance: AI_STALE_TARGET_GUIDANCE } : {}),
      }, true)
      this.recordMutationRecovery(active, call, manifest.operationId, message)
      this.processToolStatus(active, call.id, 'failed', true, recycleUnavailable ? 'recycle-unavailable' : undefined)
      return message
    } finally {
      finishExecution()
      active.executing.delete(terminalization)
    }
  }

  private async invalidateStaleDocumentReads(
    active: ActiveConversation,
    error: unknown,
    paths: readonly string[],
  ): Promise<boolean> {
    if (!(error instanceof WorkspaceAiFileError)
      || (error.code !== 'STALE_TARGET' && error.code !== 'AI_FILE_CHANGED')) return false
    // A stale write proves the read version is obsolete. Permit a fresh first
    // page while refusing continuations that belonged to the previous version.
    for (const path of paths) {
      active.workspaceReadSeriesStarted.delete(windowsPathKey(path))
      active.workspaceReadVersions.delete(windowsPathKey(path))
    }
    const snapshotPath = active.currentDocumentWriteAuthority?.path
    if (snapshotPath !== undefined && paths.some(path => (
      windowsPathKey(path) === windowsPathKey(snapshotPath)
    ))) await this.releaseCurrentDocumentSnapshot(active)
    return true
  }

  private currentDocumentWriteAuthority(): AiCurrentDocumentWriteAuthority | null {
    try {
      const authority = this.options.getCurrentDocumentWriteAuthority?.()
      return authority && isCanonicalWorkspaceRelativePath(authority.path)
        && Number.isSafeInteger(authority.session) && authority.session >= 0
        ? { path: authority.path, session: authority.session } : null
    } catch { return null }
  }

  private matchesCurrentDocumentWriteAuthority(active: ActiveConversation, path: string): boolean {
    const submitted = active.currentDocumentWriteAuthority
    const current = this.currentDocumentWriteAuthority()
    return submitted !== null && current !== null
      && active.submittedDocumentEpoch === this.documentEpoch
      && submitted.session === current.session
      && windowsPathKey(submitted.path) === windowsPathKey(current.path)
      && windowsPathKey(path) === windowsPathKey(current.path)
  }

  private async planMutation(
    active: ActiveConversation,
    call: ModelToolCall,
    parsed: Extract<AiWorkspaceToolArguments, { toolName: AiMutationToolName }>,
    capabilityRevision: number,
  ): Promise<AiOperationManifest> {
    let manifest: AiOperationManifest | undefined
    try {
      active.controller.signal.throwIfAborted()
      const key = idempotencyKey(active, call)
      switch (parsed.toolName) {
        case 'edit_workspace_document':
          manifest = await this.options.files.planEdit(parsed.arguments, key, active.controller.signal)
          break
        case 'create_workspace_document': manifest = await this.options.files.planCreate(parsed.arguments, key); break
        case 'rename_workspace_document':
          manifest = await this.options.files.planRename(parsed.arguments, key, active.controller.signal)
          break
        case 'delete_workspace_document':
          manifest = await this.options.files.planDelete(parsed.arguments, key, active.controller.signal)
          break
      }
      active.controller.signal.throwIfAborted()
      this.assertToolCapability(active, capabilityRevision, 'workspace')
      return manifest
    } catch (error) {
      if (manifest !== undefined) {
        try { this.options.files.abandon(manifest, 'planning-canceled') } catch { /* terminal elsewhere */ }
      }
      throw error
    }
  }

  private recordMutationRecovery(
    active: ActiveConversation,
    call: ModelToolCall,
    operationId: string,
    message: Extract<ModelChatMessage, { role: 'tool' }>,
  ): void {
    const assistant = active.currentAssistant
    const assistantMessageId = active.currentAssistantMessageId
    const contextBeforeTools = active.currentAssistantToolBaseline
    if (assistant === null || assistantMessageId === null || contextBeforeTools === null) return
    const key = `${active.requestId}\0${assistantMessageId}`
    let recovery = active.session.mutationRecoveries.get(key)
    if (recovery === undefined) {
      recovery = {
        requestId: active.requestId,
        assistant: structuredClone(assistant),
        contextBeforeTools,
        tools: new Map(),
      }
      active.session.mutationRecoveries.set(key, recovery)
    }
    recovery.tools.set(call.id, {
      operationId,
      message: { ...message },
    })
  }

  private clearMutationRecoveries(active: ActiveConversation): void {
    for (const [key, recovery] of active.session.mutationRecoveries) {
      if (recovery.requestId === active.requestId) active.session.mutationRecoveries.delete(key)
    }
  }

  private restoreMutationRecoveries(active: ActiveConversation): void {
    // Completed turns stay committed while their asynchronous snapshot cleanup drains.
    if (active.completed || active.budgetPaused || active.recoveryRestored) return
    active.recoveryRestored = true
    if (active.budgetFallbackContext !== null) {
      active.session.context = active.budgetFallbackContext
      active.session.usageBaseline = null
      this.clearMutationRecoveries(active)
      return
    }
    active.session.committedDocumentEpoch = active.rollbackDocumentEpoch
    const recoveries = [...active.session.mutationRecoveries]
      .filter(([, recovery]) => recovery.requestId === active.requestId)
    const latest = recoveries.at(-1)?.[1]
    if (latest === undefined) {
      active.session.context = active.rollbackContext
      active.session.usageBaseline = null
      return
    }
    const terminalTools = (latest.assistant.toolCalls ?? []).map((call) => (
      latest.tools.get(call.id)?.message
      ?? active.toolResults.get(call.id)?.message
      ?? toolMessage(call, { kind: 'unavailable' }, true)
    ))
    active.session.context = appendMessages(latest.contextBeforeTools, terminalTools)
    active.session.recoveryPending = true
    active.session.recoveryModelFingerprint = active.session.modelFingerprint
    for (const [key] of recoveries) active.session.mutationRecoveries.delete(key)
    active.session.usageBaseline = null
  }

  private waitForAuthorization(
    active: ActiveConversation,
    toolCallId: string,
    manifest: AiOperationManifest,
    scope: AiAuthorizationScope,
    policySnapshot: AiConversationWritePolicySnapshot,
  ): Promise<boolean> {
    active.controller.signal.throwIfAborted()
    return new Promise((resolve) => {
      const pending: PendingAuthorization = {
        manifest, scope, toolCallId, policySnapshot, settled: false, resolve,
        timer: setTimeout(() => {
          this.settleAuthorization(active, pending, false, 'authorization-timeout')
        }, AUTHORIZATION_TIMEOUT_MS),
      }
      active.pendingAuthorizations.set(manifest.operationId, pending)
      this.emitIfOwned(active, {
        requestId: active.requestId,
        type: 'authorization-requested',
        toolCallId,
        toolName: manifest.toolName,
        operationId: manifest.operationId,
        scope,
        paths: [...manifest.relativePaths],
      })
    })
  }

  private settleAuthorization(
    active: ActiveConversation,
    pending: PendingAuthorization,
    allowed: boolean,
    reason: string,
  ): void {
    if (pending.settled) return
    pending.settled = true
    clearTimeout(pending.timer)
    active.pendingAuthorizations.delete(pending.manifest.operationId)
    if (allowed) {
      try {
        this.options.files.authorize(pending.manifest, pending.manifest.nonce)
        active.authorizedNotExecuting.set(pending.manifest.operationId, pending.manifest)
      } catch {
        allowed = false
      }
    }
    if (!allowed) {
      try { this.options.files.abandon(pending.manifest, reason) } catch { /* already terminal */ }
    }
    this.emitIfOwned(active, {
      requestId: active.requestId,
      type: 'authorization-result',
      toolName: pending.manifest.toolName,
      operationId: pending.manifest.operationId,
      scope: pending.scope,
      allowed,
    })
    this.emitIfOwned(active, {
      requestId: active.requestId,
      type: 'audit',
      action: allowed ? 'authorization-allowed' : 'authorization-denied',
      absolutePaths: [],
    })
    pending.resolve(allowed)
  }

  private emitMutationAudit(active: ActiveConversation, execution: WorkspaceAiMutationExecution): void {
    const action = execution.localAudit.kind === 'edited' ? 'edited'
      : execution.localAudit.kind === 'created' ? 'created'
        : execution.localAudit.kind === 'renamed' ? 'renamed' : 'deleted'
    this.emitIfOwned(active, {
      requestId: active.requestId,
      type: 'audit',
      action,
      absolutePaths: [...execution.localAudit.absolutePaths],
    })
  }

  private reconcileUnknownBarrier(
    session: WorkspaceSession,
    relativePath: string,
    fileId?: string,
  ): void {
    const pathBarrier = session.unknownPathBarriers.get(windowsPathKey(relativePath))
    if (pathBarrier !== undefined) pathBarrier.reconciled = true
    if (fileId !== undefined) {
      const identityBarrier = session.unknownIdentityBarriers.get(fileId)
      if (identityBarrier !== undefined) identityBarrier.reconciled = true
    }
  }

  private reconcileUnknownBarriersFromList(
    session: WorkspaceSession,
    page: Extract<AiWorkspaceToolResult, { kind: 'entries' }>,
  ): void {
    for (const entry of page.entries) this.reconcileUnknownBarrier(session, entry.path)
    if (page.nextCursor !== null) return
    for (const [relativePath, barrier] of session.unknownPathBarriers) {
      const separator = relativePath.lastIndexOf('/')
      const parent = separator < 0 ? '' : relativePath.slice(0, separator)
      if (parent === windowsPathKey(page.directoryPath)) barrier.reconciled = true
    }
  }
}
