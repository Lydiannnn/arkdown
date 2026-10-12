import { freezeThinkingTime, type AiThinkingTime } from './ai-thinking-time'
import { freezeRequestTime, type AiRequestTime } from './ai-request-time'
import type {
  AiAuthorizationScope,
  AiConversationCapabilities,
  AiConversationEvent,
  AiConversationVisibleMessage,
  AiContextCompactionRecord,
  AiMutationToolName,
  ModelUsage,
} from '../../shared/ai-conversation'
import type { AiWritePolicy } from '../../shared/large-model-settings'
import type { AiConversationFailure } from '../../shared/ai-failure-presentation'
import type { AiBudgetPausedEvent } from '../../shared/ai-budget-result'
import type { AiWorkspaceState } from '../../shared/contracts'
import { AI_CONVERSATION_MESSAGE_MAX_CHARS, DEFAULT_AI_CONVERSATION_CAPABILITIES } from '../../shared/ai-conversation'
import { createAiComposerDraft, type AiComposerDraft } from './ai-composer-draft'
import { finishAiProcess, type AiProcessRecord } from './ai-process-buffer'

export interface WorkspaceAiAuthorizationRecord {
  requestId: string
  operationId: string
  toolName: AiMutationToolName
  scope: AiAuthorizationScope
  paths: readonly string[]
  allowed: boolean | null
  decisionPending?: boolean
}

export interface WorkspaceAiAuditRecord {
  id: string
  action:
    | 'authorization-allowed'
    | 'authorization-denied'
    | 'edited'
    | 'created'
    | 'renamed'
    | 'deleted'
  absolutePaths: readonly string[]
}

export type WorkspaceAiTimelineEntry =
  | AiThinkingTime
  | AiRequestTime
  | { kind: 'process'; record: AiProcessRecord }
  | { kind: 'message'; messageId: string }
  | { kind: 'incomplete-message'; message: AiConversationVisibleMessage; outcome: 'failed' | 'stopped' | 'paused' }
  | { kind: 'incomplete-omission' }
  | { kind: 'budget-pause'; record: AiBudgetPausedEvent }
  | { kind: 'authorization'; operationId: string }
  | { kind: 'audit'; auditId: string }
  | { kind: 'context-compaction'; id: string; record: AiContextCompactionRecord }

export interface WorkspaceAiActiveRequest {
  requestId: string
  assistantMessageId: string | null
  invalidated: boolean
  startPending: boolean
  terminal: boolean
  protocol: {
    phase:
      | 'awaiting-start-response'
      | 'awaiting-started'
      | 'awaiting-user-accepted'
      | 'ready'
      | 'streaming'
      | 'between-messages'
      | 'awaiting-recovery-user'
      | 'terminal'
    startMode: 'normal' | 'recovery' | null
    userMessageId: string
    queuedEvents: AiConversationEvent[]
  }
}

export interface WorkspaceAiViewport {
  followLatest: boolean
  anchorMessageId: string | null
  anchorOffset: number
  scrollTop: number
}

export interface WorkspaceAiSessionState extends AiWorkspaceState {
  draft: AiComposerDraft
  documentSourceIds: Map<string, string>
  viewport: WorkspaceAiViewport
  modelProfileFingerprint: string | null | undefined
  workspaceGeneration: string
  conversationId: string
  transcriptRevision: number
  messages: AiConversationVisibleMessage[]
  timeline: WorkspaceAiTimelineEntry[]
  processes: Map<string, AiProcessRecord>
  capabilities: AiConversationCapabilities
  authoritativeCapabilities: AiConversationCapabilities
  writePolicy: AiWritePolicy
  status: 'idle' | 'starting' | 'streaming' | 'error'
  error: string | null
  /** Last request's terminal evidence; unrelated local form errors do not rewrite it. */
  failure?: AiConversationFailure | null
  /** Current main-issued continuation receipt. Historical facts stay in timeline. */
  budgetPause?: AiBudgetPausedEvent | null
  /** Local Stop cannot settle a pending main admission or permit an obsolete ACK. */
  pendingContinuationAdmission?: string | null
  activeRequest: WorkspaceAiActiveRequest | null
  pendingAuthorization: WorkspaceAiAuthorizationRecord | null
  authorizationRecords: WorkspaceAiAuthorizationRecord[]
  auditRecords: WorkspaceAiAuditRecord[]
  usage: ModelUsage | null
  contextWindowTokens: number | null
  sendGeneration: number
  clearing: boolean
}

export interface WorkspaceAiSessionStore {
  readonly sessions: Map<string, WorkspaceAiSessionState>
  /** Transitional alias for renderer callers migrating from document-keyed storage. */
  readonly states: Map<string, WorkspaceAiSessionState>
  activeWorkspaceId: string | null
  readonly createId: () => string
}

const REVOKED_CAPABILITIES: AiConversationCapabilities = Object.freeze({
  currentDocument: false,
  workspace: false,
})

function defaultCreateId(): string {
  return crypto.randomUUID()
}

function createSession(
  binding: AiWorkspaceState,
  createId: () => string,
): WorkspaceAiSessionState {
  return {
    ...binding,
    draft: createAiComposerDraft(),
    documentSourceIds: new Map(),
    modelProfileFingerprint: undefined,
    conversationId: createId(),
    transcriptRevision: 0,
    messages: [],
    viewport: { followLatest: true, anchorMessageId: null, anchorOffset: 0, scrollTop: 0 },
    timeline: [],
    processes: new Map(),
    capabilities: { ...DEFAULT_AI_CONVERSATION_CAPABILITIES },
    authoritativeCapabilities: { ...REVOKED_CAPABILITIES },
    writePolicy: 'ask-every-time',
    status: 'idle',
    error: null,
    failure: null,
    activeRequest: null,
    pendingAuthorization: null,
    authorizationRecords: [],
    auditRecords: [],
    usage: null,
    contextWindowTokens: null,
    sendGeneration: 0,
    clearing: false,
  }
}

export function createWorkspaceAiSessionStore(
  createId: () => string = defaultCreateId,
): WorkspaceAiSessionStore {
  const sessions = new Map<string, WorkspaceAiSessionState>()
  return { sessions, states: sessions, activeWorkspaceId: null, createId }
}

export function freezeWorkspaceAiThinking(session: WorkspaceAiSessionState): void {
  const now = performance.now()
  session.timeline = session.timeline.map(entry => entry.kind === 'thinking' ? freezeThinkingTime(entry, now) : entry)
}

export function freezeWorkspaceAiTiming(session: WorkspaceAiSessionState): void {
  const now = performance.now()
  finishWorkspaceAiProcess(session, 'stopped', now)
  session.timeline = session.timeline.map(entry => entry.kind === 'elapsed'
    ? freezeRequestTime(entry, now)
    : entry.kind === 'thinking' ? freezeThinkingTime(entry, now) : entry)
}

export function finishWorkspaceAiProcess(session: WorkspaceAiSessionState, outcome: 'completed' | 'failed' | 'stopped' | 'paused', now = performance.now()): void {
  const requestId = session.activeRequest?.requestId
  const process = requestId ? session.processes.get(requestId) : undefined
  if (process) finishAiProcess(process, outcome, now)
}

export const AI_INCOMPLETE_MESSAGE_LIMIT = 20

/** Display-only evidence. Never enters the acknowledged messages or model replay. */
export function retainIncompleteAssistantMessage(
  session: WorkspaceAiSessionState, active: WorkspaceAiActiveRequest, outcome: 'failed' | 'stopped' | 'paused',
): void {
  if (session.activeRequest !== active || !active.assistantMessageId) return
  const id = active.assistantMessageId
  const message = session.messages.find(message => message.id === id && message.role === 'assistant')
  session.messages = session.messages.filter(message => message.id !== id)
  const index = session.timeline.findIndex(entry => entry.kind === 'message' && entry.messageId === id)
  session.timeline = session.timeline.filter(entry => entry.kind !== 'message' || entry.messageId !== id)
  active.assistantMessageId = null
  if (!message?.content.trim()) return
  const entry: WorkspaceAiTimelineEntry = { kind: 'incomplete-message',
    message: { ...message, content: message.content.slice(0, AI_CONVERSATION_MESSAGE_MAX_CHARS) }, outcome }
  session.timeline.splice(index < 0 ? session.timeline.length : index, 0, entry)
  const partials = session.timeline.filter(entry => entry.kind === 'incomplete-message')
  if (partials.length > AI_INCOMPLETE_MESSAGE_LIMIT) {
    const oldest = new Set<WorkspaceAiTimelineEntry>(partials.slice(0, -AI_INCOMPLETE_MESSAGE_LIMIT))
    session.timeline = session.timeline.filter(entry => entry.kind !== 'incomplete-omission' && !oldest.has(entry))
    session.timeline.unshift({ kind: 'incomplete-omission' })
  }
}

export function revokeWorkspaceAiSessionAuthority(session: WorkspaceAiSessionState): void {
  session.budgetPause = null
  session.pendingContinuationAdmission = null
  freezeWorkspaceAiTiming(session)
  if (session.activeRequest) retainIncompleteAssistantMessage(session, session.activeRequest, 'stopped')
  const pendingAuthorizationOperationId = session.pendingAuthorization?.operationId ?? null
  if (pendingAuthorizationOperationId) {
    session.authorizationRecords = session.authorizationRecords.filter(({ operationId }) => (
      operationId !== pendingAuthorizationOperationId
    ))
    session.timeline = session.timeline.filter((entry) => (
      entry.kind !== 'authorization' || entry.operationId !== pendingAuthorizationOperationId
    ))
  }
  // Preserve user read intent; lifecycle invalidation only revokes authority.
  session.authoritativeCapabilities = { ...REVOKED_CAPABILITIES }
  session.pendingAuthorization = null
  session.sendGeneration += 1
  if (session.activeRequest) session.activeRequest.invalidated = true
  session.activeRequest = null
  session.clearing = false
  if (session.status === 'starting' || session.status === 'streaming') session.status = 'idle'
}

export function activateWorkspaceAiSession(
  store: WorkspaceAiSessionStore,
  binding: AiWorkspaceState,
): WorkspaceAiSessionState {
  const previousActiveId = store.activeWorkspaceId
  let session = store.sessions.get(binding.workspaceId)
  if (
    previousActiveId !== binding.workspaceId
    || (session !== undefined && session.workspaceGeneration !== binding.workspaceGeneration)
  ) {
    for (const candidate of store.sessions.values()) revokeWorkspaceAiSessionAuthority(candidate)
  }
  if (!session) {
    session = createSession(binding, store.createId)
    store.sessions.set(binding.workspaceId, session)
  }
  session.workspaceGeneration = binding.workspaceGeneration
  store.activeWorkspaceId = binding.workspaceId
  return session
}

export function activeWorkspaceAiSession(
  store: WorkspaceAiSessionStore,
): WorkspaceAiSessionState | null {
  return store.activeWorkspaceId === null
    ? null
    : store.sessions.get(store.activeWorkspaceId) ?? null
}

export function hasNonEmptyActiveWorkspaceAiSession(store: WorkspaceAiSessionStore): boolean {
  const session = activeWorkspaceAiSession(store)
  return Boolean(session && (session.messages.length > 0 || session.activeRequest
    || session.timeline.some(entry => entry.kind === 'incomplete-message')))
}
