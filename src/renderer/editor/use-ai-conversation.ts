import type { PublicModelSettingsSnapshot } from '../../shared/settings-observation'
import { areModelRulesReady } from '../settings/model-rules-runtime'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AI_CONVERSATION_MESSAGE_MAX_CHARS,
  AI_CONVERSATION_VISIBLE_MESSAGE_LIMIT,
  DEFAULT_AI_CONVERSATION_CAPABILITIES,
  parseAiConversationEvent,
  type AiConversationCapabilities,
  type AiConversationEvent,
  type AiConversationUserMessage,
  type AiConversationVisibleMessage,
  type AiContextCompactionEvent,
  type StartAiConversationInput,
} from '../../shared/ai-conversation'
import type { AiWritePolicy } from '../../shared/large-model-settings'
import type { AiBudgetPausedEvent } from '../../shared/ai-budget-result'
import { describeAiConversationFailure, type AiConversationFailure } from '../../shared/ai-failure-presentation'
import { parseAiStartFailure } from '../../shared/ai-start-failure'
import type { AiWorkspaceState, ArkdownApi } from '../../shared/contracts'
import { addAiSelectionQuote, createAiComposerDraft, type AiComposerDraft, type AiSelectionQuoteInput } from './ai-composer-draft'
import { applyAiProcessEvent, beginAiProcessRound, createAiProcessRecord, enforceAiProcessSessionBudget } from './ai-process-buffer'
import {
  activateWorkspaceAiSession,
  createWorkspaceAiSessionStore,
  freezeWorkspaceAiThinking,
  freezeWorkspaceAiTiming,
  finishWorkspaceAiProcess,
  retainIncompleteAssistantMessage,
  revokeWorkspaceAiSessionAuthority,
  type WorkspaceAiActiveRequest,
  type WorkspaceAiAuthorizationRecord,
  type WorkspaceAiAuditRecord,
  type WorkspaceAiSessionState,
  type WorkspaceAiSessionStore,
  type WorkspaceAiTimelineEntry,
} from './workspace-ai-session-store'

export type AiConversationStore = WorkspaceAiSessionStore
export type AiConversationStatus = WorkspaceAiSessionState['status']

type AiConversationApi = Pick<
  ArkdownApi,
  | 'cancelAiConversation'
  | 'clearAiConversation'
  | 'getLargeModelSettings'
  | 'onAiConversationEvent'
  | 'setAiConversationCapabilities'
  | 'setAiConversationSettings'
  | 'startAiConversation'
  | 'submitAiAuthorizationResult'
>

export interface UseAiConversationOptions {
  api?: AiConversationApi
  contextWindowTokens?: number | null
  profileFingerprint?: string | null
  createId?: () => string
  store?: WorkspaceAiSessionStore
  workspace?: AiWorkspaceState | null
  onWorkspaceFilesChanged?: (workspace: AiWorkspaceState) => void
  writePolicy?: AiWritePolicy
  /** Removed document-keyed inputs accepted temporarily for source compatibility. */
  documentKey?: string
  readSnapshot?: () => unknown
}

export interface UseAiConversationResult {
  draft: AiComposerDraft | undefined
  addQuote(quote: AiSelectionQuoteInput): void
  viewport: WorkspaceAiSessionState['viewport'] | undefined
  messages: readonly AiConversationVisibleMessage[]
  activeAssistantMessageId: string | null
  timeline: readonly WorkspaceAiTimelineEntry[]
  capabilities: AiConversationCapabilities
  writePolicy: AiWritePolicy
  status: AiConversationStatus
  error: string | null
  failure: AiConversationFailure | null
  continueRequestId: string | null
  continueAnalysis(requestId: string, expectedDocumentId?: string | null): Promise<boolean>
  pendingAuthorization: WorkspaceAiAuthorizationRecord | null
  authorizationRecords: readonly WorkspaceAiAuthorizationRecord[]
  auditRecords: readonly WorkspaceAiAuditRecord[]
  contextUsage: { usedTokens: number; contextWindowTokens: number | null; estimated: boolean } | null
  sendMessage(content: string, expectedDocumentId?: string | null): Promise<boolean>
  stopConversation(): Promise<void>
  clearConversation(): Promise<void>
  setCurrentDocumentAccess(enabled: boolean): Promise<boolean>
  setWorkspaceAccess(enabled: boolean): Promise<boolean>
  setWritePolicy(policy: AiWritePolicy, observed: PublicModelSettingsSnapshot): Promise<boolean>
  answerAuthorization(allowed: boolean): Promise<boolean>
}

const FALLBACK_WORKSPACE: AiWorkspaceState = Object.freeze({
  workspaceId: '__workspace-unavailable__',
  workspaceGeneration: '__workspace-unavailable__',
})
const INACTIVE_CAPABILITIES: AiConversationCapabilities = Object.freeze({
  currentDocument: false,
  workspace: false,
})
const LEADING_DOCUMENT_COMMAND = /^(?:\/document|\/文档)(?=\s|$)\s*/iu
export const AI_CONVERSATION_MESSAGE_TOO_LONG_ERROR = '消息不能超过 48,000 个字符。'

function defaultCreateId(): string {
  return crypto.randomUUID()
}

function keepLastMessages(
  messages: readonly AiConversationVisibleMessage[],
): AiConversationVisibleMessage[] {
  return messages.length <= AI_CONVERSATION_VISIBLE_MESSAGE_LIMIT
    ? [...messages]
    : messages.slice(messages.length - AI_CONVERSATION_VISIBLE_MESSAGE_LIMIT)
}

function resetSessionForClear(
  session: WorkspaceAiSessionState,
  createId: () => string,
): void {
  const writePolicy = session.writePolicy
  const contextWindowTokens = session.contextWindowTokens
  session.conversationId = createId()
  session.transcriptRevision = 0
  session.messages = []
  session.draft = createAiComposerDraft()
  session.viewport = { followLatest: true, anchorMessageId: null, anchorOffset: 0, scrollTop: 0 }
  session.timeline = []
  session.processes.clear()
  session.capabilities = { ...DEFAULT_AI_CONVERSATION_CAPABILITIES, currentDocument: session.capabilities.currentDocument }
  session.authoritativeCapabilities = { currentDocument: false, workspace: false }
  session.writePolicy = writePolicy
  session.status = 'idle'
  session.error = null
  session.failure = null
  session.budgetPause = null
  session.pendingContinuationAdmission = null
  session.activeRequest = null
  session.pendingAuthorization = null
  session.authorizationRecords = []
  session.auditRecords = []
  session.usage = null
  session.contextWindowTokens = contextWindowTokens
  session.sendGeneration += 1
  session.clearing = false
}

function ownerOf(
  store: WorkspaceAiSessionStore,
  requestId: string,
): WorkspaceAiSessionState | null {
  for (const session of store.sessions.values()) {
    if (session.activeRequest?.requestId === requestId) return session
  }
  return null
}

function appendAssistantDelta(
  session: WorkspaceAiSessionState,
  messageId: string,
  delta: string,
): void {
  const index = session.messages.findIndex(({ id }) => id === messageId)
  if (index < 0) return
  const message = session.messages[index]
  if (!message || message.role !== 'assistant') return
  session.messages[index] = {
    ...message,
    content: (message.content + delta).slice(0, AI_CONVERSATION_MESSAGE_MAX_CHARS),
  }
}

function retainActiveAssistantMessage(
  session: WorkspaceAiSessionState,
  active: WorkspaceAiActiveRequest,
  outcome: 'failed' | 'stopped' | 'paused' = 'stopped',
): void {
  freezeWorkspaceAiTiming(session)
  retainIncompleteAssistantMessage(session, active, outcome)
}

function applyConversationEvent(
  owner: WorkspaceAiSessionState,
  event: AiConversationEvent,
  createId: () => string,
): boolean {
  const active = owner.activeRequest
  if (!active || active.requestId !== event.requestId || active.invalidated || active.terminal) {
    return false
  }
  const protocol = active.protocol
  switch (event.type) {
    case 'process-text':
    case 'process-stage':
    case 'process-tool': {
      if (event.type === 'process-text' ? protocol.phase !== 'streaming'
        : event.type === 'process-tool' ? protocol.phase !== 'between-messages'
          : ['tool-running', 'awaiting-approval'].includes(event.stage)
            ? protocol.phase !== 'between-messages' : protocol.phase !== 'streaming') return false
      const record = owner.processes.get(event.requestId)
      if (!record || !applyAiProcessEvent(record, event, performance.now())) return false
      if (!owner.timeline.some(entry => entry.kind === 'process' && entry.record.requestId === event.requestId)) {
        const elapsed = owner.timeline.findIndex(entry => entry.kind === 'elapsed' && entry.requestId === event.requestId)
        const index = elapsed < 0 ? owner.timeline.length : elapsed + 1
        owner.timeline.splice(index, 0, { kind: 'process', record })
      }
      enforceAiProcessSessionBudget([...owner.processes.values()])
      owner.timeline = [...owner.timeline]
      return true
    }
    case 'context-compaction':
      if (event.transcriptRevision !== owner.transcriptRevision
        || (protocol.phase !== 'ready' && protocol.phase !== 'between-messages')) return false
      appendCompactionRecord(owner, event, createId)
      return true
    case 'started':
      if (
        protocol.phase !== 'awaiting-started'
        || event.transcriptRevision !== owner.transcriptRevision
      ) return false
      protocol.phase = protocol.startMode === 'normal' ? 'awaiting-user-accepted' : 'ready'
      owner.status = 'streaming'
      return true
    case 'user-message-accepted':
      if (event.messageId !== protocol.userMessageId) return false
      if (
        protocol.startMode === 'normal'
        && protocol.phase === 'awaiting-user-accepted'
        && event.transcriptRevision === owner.transcriptRevision
      ) {
        protocol.startMode = null
        protocol.phase = 'ready'
        return true
      }
      if (
        protocol.startMode === 'recovery'
        && protocol.phase === 'awaiting-recovery-user'
        && event.transcriptRevision === owner.transcriptRevision + 1
      ) {
        owner.transcriptRevision = event.transcriptRevision
        protocol.startMode = null
        protocol.phase = 'ready'
        return true
      }
      return false
    case 'message-start':
      if (
        (protocol.phase !== 'ready' && protocol.phase !== 'between-messages')
        || active.assistantMessageId !== null
        || event.previousTranscriptRevision !== owner.transcriptRevision
      ) return false
      active.assistantMessageId = event.messageId
      {
        const now = performance.now()
        const elapsed = owner.timeline.find(entry => entry.kind === 'elapsed' && entry.requestId === event.requestId)
        const process = owner.processes.get(event.requestId) ?? createAiProcessRecord(event.requestId,
          elapsed?.kind === 'elapsed' ? elapsed.observedAt - elapsed.elapsedMs : now)
        owner.processes.set(event.requestId, process)
        beginAiProcessRound(process, event.messageId, now)
      }
      owner.timeline = owner.timeline.map(entry => entry.kind === 'elapsed' && entry.requestId === event.requestId
        ? { ...entry, messageIds: [...entry.messageIds, event.messageId] } : entry)
      protocol.phase = 'streaming'
      if (!owner.messages.some(({ id }) => id === event.messageId)) {
        owner.messages = keepLastMessages([
          ...owner.messages,
          { id: event.messageId, role: 'assistant', content: '' },
        ])
        owner.timeline = [
          ...owner.timeline,
          { kind: 'message', messageId: event.messageId },
        ]
      }
      owner.status = 'streaming'
      return true
    case 'thinking': {
      if (protocol.phase !== 'streaming' || active.assistantMessageId !== event.messageId) return false
      const existing = owner.timeline.find(entry => entry.kind === 'thinking' && entry.messageId === event.messageId)
      if (existing?.kind === 'thinking' && event.elapsedMs < existing.elapsedMs) return false
      const record: WorkspaceAiTimelineEntry = {
        kind: 'thinking', messageId: event.messageId, active: event.active,
        elapsedMs: event.elapsedMs, observedAt: performance.now(),
      }
      if (existing) owner.timeline = owner.timeline.map(entry => entry === existing ? record : entry)
      else {
        if (!event.active) return false
        const index = owner.timeline.findIndex(entry => entry.kind === 'message' && entry.messageId === event.messageId)
        owner.timeline = [...owner.timeline.slice(0, index), record, ...owner.timeline.slice(index)]
      }
      return true
    }
    case 'delta':
      if (
        protocol.phase !== 'streaming'
        || active.assistantMessageId !== event.messageId
      ) return false
      appendAssistantDelta(owner, event.messageId, event.delta)
      return true
    case 'message-completed':
      if (
        protocol.phase !== 'streaming'
        || active.assistantMessageId !== event.messageId
        || event.transcriptRevision !== owner.transcriptRevision + 1
      ) return false
      freezeWorkspaceAiThinking(owner)
      owner.transcriptRevision = event.transcriptRevision
      active.assistantMessageId = null
      protocol.phase = protocol.startMode === 'recovery'
        ? 'awaiting-recovery-user'
        : 'between-messages'
      return true
    case 'authorization-requested': {
      if (
        protocol.phase !== 'between-messages'
        || owner.pendingAuthorization !== null
        || owner.authorizationRecords.some(({ operationId }) => operationId === event.operationId)
      ) return false
      const record: WorkspaceAiAuthorizationRecord = {
        requestId: event.requestId,
        operationId: event.operationId,
        toolName: event.toolName,
        scope: event.scope,
        paths: [...event.paths],
        allowed: null,
        decisionPending: false,
      }
      owner.authorizationRecords = [
        ...owner.authorizationRecords.filter(({ operationId }) => operationId !== event.operationId),
        record,
      ]
      owner.pendingAuthorization = record
      owner.timeline = [
        ...owner.timeline,
        { kind: 'authorization', operationId: event.operationId },
      ]
      return true
    }
    case 'authorization-result': {
      const pending = owner.pendingAuthorization
      if (
        protocol.phase !== 'between-messages'
        || !pending
        || pending.operationId !== event.operationId
        || pending.toolName !== event.toolName
        || pending.scope !== event.scope
      ) return false
      owner.authorizationRecords = owner.authorizationRecords.map((record) => (
        record.operationId === event.operationId
          ? { ...record, allowed: event.allowed, decisionPending: false }
          : record
      ))
      owner.pendingAuthorization = null
      return true
    }
    case 'audit':
      if (protocol.phase !== 'between-messages') return false
      if (event.action === 'authorization-allowed' || event.action === 'authorization-denied') {
        return true
      }
      {
        const auditRecord = {
          id: createId(), action: event.action, absolutePaths: [...event.absolutePaths],
        }
      owner.auditRecords = [
        ...owner.auditRecords,
          auditRecord,
      ]
        owner.timeline = [...owner.timeline, { kind: 'audit', auditId: auditRecord.id }]
      }
      return true
    case 'usage':
      if (protocol.phase !== 'streaming') return false
      owner.usage = { ...event.usage }
      return true
    case 'operation-status':
      return protocol.phase === 'between-messages'
    case 'budget-paused':
      if (!['streaming', 'between-messages'].includes(protocol.phase)
        || event.transcriptRevision !== owner.transcriptRevision || owner.pendingAuthorization !== null
        || event.finalization.status === 'completed' && protocol.phase !== 'between-messages') return false
      finishWorkspaceAiProcess(owner, 'paused')
      retainActiveAssistantMessage(owner, active, 'paused')
      active.terminal = true
      protocol.phase = 'terminal'
      owner.activeRequest = null
      owner.status = 'idle'
      owner.error = null
      owner.failure = null
      owner.budgetPause = event
      owner.timeline = [...owner.timeline, { kind: 'budget-pause', record: event }]
      return true
    case 'completed':
      if (protocol.phase !== 'between-messages' || owner.pendingAuthorization !== null) return false
      finishWorkspaceAiProcess(owner, 'completed')
      freezeWorkspaceAiTiming(owner)
      active.terminal = true
      protocol.phase = 'terminal'
      owner.activeRequest = null
      owner.status = 'idle'
      owner.error = null
      owner.failure = null
      return true
    case 'stopped':
    case 'failed':
      if (
        protocol.phase === 'awaiting-start-response'
        || protocol.phase === 'awaiting-started'
        || protocol.phase === 'awaiting-user-accepted'
      ) return false
      active.terminal = true
      protocol.phase = 'terminal'
      finishWorkspaceAiProcess(owner, event.type === 'failed' ? 'failed' : 'stopped')
      retainActiveAssistantMessage(owner, active, event.type)
      owner.activeRequest = null
      owner.pendingAuthorization = null
      if (event.type === 'failed') {
        owner.status = 'error'
        owner.failure = { code: event.code, ...(event.detail ? { detail: event.detail } : {}) }
        owner.error = event.detail ? describeAiConversationFailure(owner.failure) : event.message
      } else {
        owner.status = 'idle'
        owner.error = null
        owner.failure = null
      }
      return true
  }
}

function appendCompactionRecord(
  owner: WorkspaceAiSessionState,
  event: AiContextCompactionEvent,
  createId: () => string,
): void {
  const record = event.status === 'failed' ? { status: 'failed' as const } : {
    status: 'compacted' as const,
    beforeTokens: event.beforeTokens,
    afterTokens: event.afterTokens,
    contextWindowTokens: event.contextWindowTokens,
  }
  owner.timeline = [...owner.timeline, { kind: 'context-compaction', id: createId(), record }]
}

function sameWorkspaceBinding(
  session: WorkspaceAiSessionState,
  workspaceId: string,
  workspaceGeneration: string,
): boolean {
  return session.workspaceId === workspaceId
    && session.workspaceGeneration === workspaceGeneration
}

export function createAiConversationStore(): AiConversationStore {
  return createWorkspaceAiSessionStore()
}

/** Document Save As no longer changes a workspace-scoped AI identity. */
export function rekeyAiConversationStore(): void {}

export function useAiConversation({
  api = window.arkdown,
  contextWindowTokens,
  createId = defaultCreateId,
  profileFingerprint,
  store,
  workspace,
  onWorkspaceFilesChanged,
  writePolicy,
}: UseAiConversationOptions): UseAiConversationResult {
  const localStoreRef = useRef<WorkspaceAiSessionStore | null>(null)
  localStoreRef.current ??= createWorkspaceAiSessionStore(createId)
  const activeStore = store ?? localStoreRef.current
  const binding = workspace === undefined ? FALLBACK_WORKSPACE : workspace
  let session: WorkspaceAiSessionState | null
  if (binding === null) {
    if (activeStore.activeWorkspaceId !== null) {
      for (const candidate of activeStore.sessions.values()) {
        revokeWorkspaceAiSessionAuthority(candidate)
      }
      activeStore.activeWorkspaceId = null
    }
    session = null
  } else {
    session = activateWorkspaceAiSession(activeStore, binding)
  }
  const sessionRef = useRef<WorkspaceAiSessionState | null>(session)
  const createIdRef = useRef(createId)
  const onWorkspaceFilesChangedRef = useRef(onWorkspaceFilesChanged)
  const mountedRef = useRef(true)
  const initializedRef = useRef(false)
  const capabilityIntentRevisionRef = useRef(0)
  const capabilityAuthorityEpochRef = useRef(0)
  const capabilityMutationQueueRef = useRef<Promise<void>>(Promise.resolve())
  const capabilityMutationsPendingRef = useRef(0)
  const authorizationDecisionsInFlightRef = useRef(new Set<string>())
  const profileRevocationsRef = useRef<Array<{
    requestId: string | null
    workspaceId: string
    workspaceGeneration: string
    conversationId: string
  }>>([])
  const [, setRevision] = useState(0)
  if (session && profileFingerprint !== undefined) {
    if (session.modelProfileFingerprint === undefined) {
      session.modelProfileFingerprint = profileFingerprint
    } else if (session.modelProfileFingerprint !== profileFingerprint) {
      capabilityAuthorityEpochRef.current += 1
      profileRevocationsRef.current.push({
        requestId: session.activeRequest?.requestId ?? null,
        workspaceId: session.workspaceId,
        workspaceGeneration: session.workspaceGeneration,
        conversationId: session.conversationId,
      })
      revokeWorkspaceAiSessionAuthority(session)
      session.usage = null
      session.contextWindowTokens = null
      session.modelProfileFingerprint = profileFingerprint
    }
  }
  if (session && !initializedRef.current) {
    initializedRef.current = true
    if (session.status === 'error' && session.activeRequest === null) {
      session.status = 'idle'
      session.error = null
    }
  }
  sessionRef.current = session
  createIdRef.current = createId
  onWorkspaceFilesChangedRef.current = onWorkspaceFilesChanged

  const notify = useCallback(() => {
    if (mountedRef.current) setRevision((revision) => revision + 1)
  }, [])

  const applyEvent = useCallback((owner: WorkspaceAiSessionState, event: AiConversationEvent): boolean => {
    if (!applyConversationEvent(owner, event, createIdRef.current)) return false
    if (mountedRef.current && owner === sessionRef.current && event.type === 'audit'
      && (event.action === 'created' || event.action === 'renamed')) {
      onWorkspaceFilesChangedRef.current?.({
        workspaceId: owner.workspaceId,
        workspaceGeneration: owner.workspaceGeneration,
      })
    }
    return true
  }, [])

  useEffect(() => {
    if (session && writePolicy !== undefined && session.writePolicy !== writePolicy) {
      session.writePolicy = writePolicy
      notify()
    }
  }, [notify, session, writePolicy])

  useEffect(() => {
    if (session && contextWindowTokens !== undefined && session.contextWindowTokens !== contextWindowTokens) {
      session.contextWindowTokens = contextWindowTokens
      notify()
    }
  }, [contextWindowTokens, notify, profileFingerprint, session])

  useEffect(() => {
    mountedRef.current = true
    const unsubscribe = api.onAiConversationEvent((event: AiConversationEvent) => {
      const owner = ownerOf(activeStore, event.requestId)
      const active = owner?.activeRequest
      if (!owner || !active || active.invalidated || active.terminal) return
      if (active.startPending) {
        active.protocol.queuedEvents.push(event)
        return
      }
      if (applyEvent(owner, event)) notify()
    })
    return () => {
      mountedRef.current = false
      unsubscribe()
      // No more phase transitions can be observed after this listener detaches.
      for (const candidate of activeStore.sessions.values()) freezeWorkspaceAiTiming(candidate)
    }
  }, [activeStore, api, applyEvent, notify])

  useEffect(() => {
    const revocations = profileRevocationsRef.current.splice(0)
    for (const revocation of revocations) {
      if (revocation.requestId) {
        void api.cancelAiConversation({ requestId: revocation.requestId }).catch(() => undefined)
      }
      capabilityMutationsPendingRef.current += 1
      const syncRevocation = capabilityMutationQueueRef.current.then(async () => {
        await api.setAiConversationCapabilities({
          workspaceId: revocation.workspaceId,
          workspaceGeneration: revocation.workspaceGeneration,
          conversationId: revocation.conversationId,
          capabilities: { currentDocument: false, workspace: false },
        }).catch(() => undefined)
      })
      void syncRevocation.then(() => { capabilityMutationsPendingRef.current -= 1 }, () => { capabilityMutationsPendingRef.current -= 1 })
      capabilityMutationQueueRef.current = syncRevocation.then(
        () => undefined,
        () => undefined,
      )
    }
  }, [api, profileFingerprint])

  const updateCapabilities = useCallback(async (
    next: AiConversationCapabilities,
  ): Promise<boolean> => {
    const target = sessionRef.current
    if (!target) return false
    const workspaceId = target.workspaceId
    const workspaceGeneration = target.workspaceGeneration
    const conversationId = target.conversationId
    const intentRevision = ++capabilityIntentRevisionRef.current
    const authorityEpoch = capabilityAuthorityEpochRef.current
    target.capabilities = { ...next }
    notify()
    if (target.transcriptRevision === 0) {
      // A first start has no committed main session to update yet. Stop its
      // preflight on denial; retain receipt reconciliation if it already won.
      if (target.activeRequest?.startPending && (!next.currentDocument || !next.workspace)) {
        void api.cancelAiConversation({ requestId: target.activeRequest.requestId }).catch(() => undefined)
      }
      return true
    }
    const reportFailure = (message: string) => {
      if (capabilityIntentRevisionRef.current !== intentRevision
        || capabilityAuthorityEpochRef.current !== authorityEpoch
        || sessionRef.current !== target
        || !sameWorkspaceBinding(target, workspaceId, workspaceGeneration)
        || target.conversationId !== conversationId) return
      const denied = (!next.currentDocument && target.authoritativeCapabilities.currentDocument)
        || (!next.workspace && target.authoritativeCapabilities.workspace)
      target.capabilities = {
        currentDocument: next.currentDocument && target.authoritativeCapabilities.currentDocument,
        workspace: next.workspace && target.authoritativeCapabilities.workspace,
      }
      if (denied) {
        const requestId = target.activeRequest?.requestId
        capabilityAuthorityEpochRef.current += 1
        revokeWorkspaceAiSessionAuthority(target)
        if (requestId) void api.cancelAiConversation({ requestId }).catch(() => undefined)
      }
      target.error = message
      notify()
    }
    capabilityMutationsPendingRef.current += 1
    const operation = capabilityMutationQueueRef.current.then(async (): Promise<boolean> => {
      try {
        const response = await api.setAiConversationCapabilities({
          workspaceId,
          workspaceGeneration,
          conversationId,
          capabilities: { ...next },
        })
        if (response.ok) {
          const authoritative = capabilityAuthorityEpochRef.current === authorityEpoch
            && sessionRef.current === target
            && sameWorkspaceBinding(target, workspaceId, workspaceGeneration)
            && target.conversationId === conversationId
          if (authoritative) target.authoritativeCapabilities = { ...next }
          return authoritative
        }
        reportFailure(response.error.message)
        return false
      } catch (error) {
        reportFailure(error instanceof Error ? error.message : '操作未能完成。')
        return false
      }
    })
    void operation.then(() => { capabilityMutationsPendingRef.current -= 1 }, () => { capabilityMutationsPendingRef.current -= 1 })
    capabilityMutationQueueRef.current = operation.then(() => undefined, () => undefined)
    return operation
  }, [api, notify])

  const setCurrentDocumentAccess = useCallback((enabled: boolean) => {
    const target = sessionRef.current
    return target
      ? updateCapabilities({ ...target.capabilities, currentDocument: enabled })
      : Promise.resolve(false)
  }, [updateCapabilities])

  const setWorkspaceAccess = useCallback((enabled: boolean) => {
    const target = sessionRef.current
    return target
      ? updateCapabilities({ ...target.capabilities, workspace: enabled })
      : Promise.resolve(false)
  }, [updateCapabilities])

  const addQuote = useCallback((quote: AiSelectionQuoteInput) => {
    const target = sessionRef.current
    if (!target) return
    addAiSelectionQuote(target.draft, quote)
    notify()
  }, [notify])

  const startMessage = useCallback(async (input: string, expectedDocumentId?: string | null,
    continuation?: AiBudgetPausedEvent): Promise<boolean> => {
    if (!areModelRulesReady()) return false
    const target = sessionRef.current
    if (!target) return false
    if (target.clearing) return false
    if (target.pendingContinuationAdmission) {
      target.error = '上一条请求仍在确认是否开始，请稍后再试。'
      notify()
      return false
    }
    const ownsContinuation = () => !continuation || (target.budgetPause === continuation
      && continuation.continuationId !== null && continuation.transcriptRevision === target.transcriptRevision
      && !target.activeRequest && !target.pendingAuthorization && !target.clearing)
    if (!ownsContinuation()) return false
    const explicitDocument = LEADING_DOCUMENT_COMMAND.test(input)
    const content = (explicitDocument ? input.replace(LEADING_DOCUMENT_COMMAND, '') : input).trim()
    if (!content) return false
    if (content.length > AI_CONVERSATION_MESSAGE_MAX_CHARS) {
      target.status = 'error'
      target.error = AI_CONVERSATION_MESSAGE_TOO_LONG_ERROR
      notify()
      return false
    }
    const requestStartedAt = performance.now()
    const sendGeneration = ++target.sendGeneration
    // Profile revocations and older capability mutations must finish before
    // the main service consumes this fresh request's intent.
    if (capabilityMutationsPendingRef.current > 0) await capabilityMutationQueueRef.current
    if (target.sendGeneration !== sendGeneration || sessionRef.current !== target || !ownsContinuation()) return false
    const capabilityIntentRevisionAtStart = capabilityIntentRevisionRef.current
    const workspaceId = target.workspaceId
    const workspaceGeneration = target.workspaceGeneration
    const previous = target.activeRequest
    if (previous) {
      freezeWorkspaceAiTiming(target)
      previous.invalidated = true
      try { await api.cancelAiConversation({ requestId: previous.requestId }) } catch { /* next start reports */ }
      if (target.sendGeneration !== sendGeneration || sessionRef.current !== target) return false
      if (target.activeRequest === previous) target.activeRequest = null
    }

    const requestId = createIdRef.current()
    const userMessage: AiConversationUserMessage = {
      id: createIdRef.current(),
      role: 'user',
      content,
    }
    const acknowledgedTranscriptRevision = target.transcriptRevision
    const removeUnacceptedMessage = () => {
      if (target.transcriptRevision !== acknowledgedTranscriptRevision) return
      target.messages = target.messages.filter(({ id }) => id !== userMessage.id)
      target.timeline = target.timeline.filter((entry) => entry.kind !== 'message' || entry.messageId !== userMessage.id)
      notify()
    }
    target.messages = keepLastMessages([...target.messages, userMessage])
    target.timeline = [...target.timeline, { kind: 'message', messageId: userMessage.id },
      { kind: 'elapsed', requestId, messageIds: [], elapsedMs: 0, active: true, observedAt: requestStartedAt }]
    const active: WorkspaceAiActiveRequest = {
      requestId,
      assistantMessageId: null,
      invalidated: false,
      startPending: true,
      terminal: false,
      protocol: {
        phase: 'awaiting-start-response',
        startMode: null,
        userMessageId: userMessage.id,
        queuedEvents: [],
      },
    }
    target.activeRequest = active
    target.pendingAuthorization = null
    target.status = 'starting'
    target.error = null
    target.failure = null
    // Reserve the continuation until admission is known, even if local Stop
    // releases the active request before its main receipt arrives.
    if (continuation) {
      target.budgetPause = null
      target.pendingContinuationAdmission = requestId
    }
    notify()

    const startInput: StartAiConversationInput = {
      requestId,
      conversationId: target.conversationId,
      workspaceKey: target.workspaceId,
      acknowledgedTranscriptRevision,
      messages: [userMessage],
      capabilities: { ...target.capabilities },
      ...(expectedDocumentId !== undefined ? { expectedDocumentId } : {}),
      ...(explicitDocument && !target.capabilities.currentDocument
        ? { currentDocumentOnce: true as const }
        : {}),
      writePolicy: target.writePolicy,
      ...(continuation?.continuationId ? { continuationOfSegmentId: continuation.continuationId } : {}),
    }
    let response: Awaited<ReturnType<AiConversationApi['startAiConversation']>>
    try {
      response = await api.startAiConversation(startInput)
    } catch (error) {
      if (target.pendingContinuationAdmission === requestId) target.pendingContinuationAdmission = null
      removeUnacceptedMessage()
      if (
        target.activeRequest === active
        && !active.invalidated
        && sameWorkspaceBinding(target, workspaceId, workspaceGeneration)
      ) {
        freezeWorkspaceAiTiming(target)
        target.activeRequest = null
        target.status = 'error'
        target.failure = { code: 'OPERATION_FAILED' }
        target.error = describeAiConversationFailure(target.failure)
        notify()
      }
      return false
    }
    const ownsContinuationAdmission = continuation && target.pendingContinuationAdmission === requestId
    if (ownsContinuationAdmission) {
      target.pendingContinuationAdmission = null
      if (target.error === '上一条请求仍在确认是否开始，请稍后再试。') target.error = null
    }
    if (!response.ok) {
      removeUnacceptedMessage()
      if (continuation && target.sendGeneration === sendGeneration && sessionRef.current === target
        && sameWorkspaceBinding(target, workspaceId, workspaceGeneration)
        && target.conversationId === startInput.conversationId
        && target.transcriptRevision === acknowledgedTranscriptRevision
        && target.budgetPause === null && (!target.activeRequest || target.activeRequest === active)) {
        target.budgetPause = continuation
        notify()
      }
    } else if (ownsContinuationAdmission && sessionRef.current === target
      && sameWorkspaceBinding(target, workspaceId, workspaceGeneration)
      && target.conversationId === startInput.conversationId && active.invalidated
      && target.transcriptRevision === acknowledgedTranscriptRevision
      && response.value.requestId === requestId
      && (response.value.transcriptRevision === acknowledgedTranscriptRevision
        || response.value.transcriptRevision === acknowledgedTranscriptRevision + 1)) {
      // A local Stop cannot undo a user message already admitted by main.
      // Record that fact without reviving its stream or its consumed token.
      target.transcriptRevision = response.value.transcriptRevision
      notify()
    }
    if (
      target.sendGeneration !== sendGeneration
      || sessionRef.current !== target
      || !sameWorkspaceBinding(target, workspaceId, workspaceGeneration)
      || active.invalidated
    ) {
      if (response.ok) await api.cancelAiConversation({ requestId }).catch(() => undefined)
      return false
    }
    if (!response.ok) {
      freezeWorkspaceAiTiming(target)
      // A failed preflight has no started receipt. Accept only its local failure notice;
      // all message, success, and other queued events retain the normal protocol gate.
      if (target.activeRequest === active && target.transcriptRevision === acknowledgedTranscriptRevision) {
        for (const queued of active.protocol.queuedEvents.splice(0)) {
          const event = parseAiConversationEvent(queued)
          if (event?.type === 'context-compaction' && event.status === 'failed'
            && event.requestId === active.requestId
            && event.transcriptRevision === acknowledgedTranscriptRevision) {
            appendCompactionRecord(target, event, createIdRef.current)
          }
        }
      }
      active.startPending = false
      if (target.activeRequest === active) target.activeRequest = null
      target.status = 'error'
      const failure = parseAiStartFailure(response)?.error
      target.failure = failure ? { code: failure.code, ...(failure.detail ? { detail: failure.detail } : {}) }
        : { code: 'OPERATION_FAILED' }
      target.error = describeAiConversationFailure(target.failure)
      notify()
      return false
    }
    const startTranscriptRevision = response.value.transcriptRevision
    // Successful admission consumes any former segment receipt. A rejected
    // preflight may be retried; ordinary sends never silently reuse the token.
    target.budgetPause = null
    if (
      startTranscriptRevision !== acknowledgedTranscriptRevision
      && startTranscriptRevision !== acknowledgedTranscriptRevision + 1
    ) {
      freezeWorkspaceAiTiming(target)
      active.invalidated = true
      if (target.activeRequest === active) target.activeRequest = null
      target.status = 'error'
      target.error = '大模型服务返回的响应格式不兼容。'
      await api.cancelAiConversation({ requestId }).catch(() => undefined)
      notify()
      return false
    }
    target.transcriptRevision = startTranscriptRevision
    if (capabilityIntentRevisionRef.current === capabilityIntentRevisionAtStart) {
      target.authoritativeCapabilities = { ...startInput.capabilities }
    }
    if (capabilityIntentRevisionRef.current !== capabilityIntentRevisionAtStart) {
      await updateCapabilities({ ...target.capabilities })
      if (
        target.sendGeneration !== sendGeneration
        || sessionRef.current !== target
        || !sameWorkspaceBinding(target, workspaceId, workspaceGeneration)
        || active.invalidated
      ) return false
    }
    active.startPending = false
    active.protocol.startMode = startTranscriptRevision === acknowledgedTranscriptRevision
      ? 'recovery'
      : 'normal'
    active.protocol.phase = 'awaiting-started'
    const queuedEvents = active.protocol.queuedEvents.splice(0)
    for (const event of queuedEvents) {
      applyEvent(target, event)
    }
    if (target.activeRequest === active && !active.terminal) target.status = 'streaming'
    notify()
    return true
  }, [api, applyEvent, notify, updateCapabilities])

  const sendMessage = useCallback((input: string, expectedDocumentId?: string | null) => (
    startMessage(input, expectedDocumentId)
  ), [startMessage])

  const continueAnalysis = useCallback((requestId: string, expectedDocumentId?: string | null): Promise<boolean> => {
    const pause = sessionRef.current?.budgetPause
    if (!pause || pause.requestId !== requestId || !pause.continuationId) return Promise.resolve(false)
    return startMessage('继续分析', expectedDocumentId, pause)
  }, [startMessage])

  const stopConversation = useCallback(async (): Promise<void> => {
    const target = sessionRef.current
    if (!target) return
    const workspaceId = target.workspaceId
    const workspaceGeneration = target.workspaceGeneration
    const active = target.activeRequest
    if (!active) return
    freezeWorkspaceAiTiming(target)
    notify()
    active.invalidated = true
    try { await api.cancelAiConversation({ requestId: active.requestId }) } catch { /* local stop wins */ }
    if (
      target.activeRequest === active
      && sameWorkspaceBinding(target, workspaceId, workspaceGeneration)
    ) {
      retainActiveAssistantMessage(target, active)
      target.activeRequest = null
      target.pendingAuthorization = null
      target.status = 'idle'
      target.error = null
      notify()
    }
  }, [api, notify])

  const clearConversation = useCallback(async (): Promise<void> => {
    const target = sessionRef.current
    if (!target) return
    const workspaceId = target.workspaceId
    const workspaceGeneration = target.workspaceGeneration
    if (target.clearing) return
    target.clearing = true
    const operationToken = ++target.sendGeneration
    freezeWorkspaceAiTiming(target)
    target.activeRequest && (target.activeRequest.invalidated = true)
    notify()
    try {
      const response = await api.clearAiConversation({
        workspaceId,
        workspaceGeneration,
        conversationId: target.conversationId,
      })
      if (
        target.sendGeneration !== operationToken
        || !sameWorkspaceBinding(target, workspaceId, workspaceGeneration)
      ) return
      if (!response.ok) {
        target.clearing = false
        target.status = 'error'
        target.error = response.error.message
        notify()
        return
      }
      capabilityAuthorityEpochRef.current += 1
      resetSessionForClear(target, createIdRef.current)
      notify()
    } catch (error) {
      if (
        target.sendGeneration !== operationToken
        || !sameWorkspaceBinding(target, workspaceId, workspaceGeneration)
      ) return
      target.clearing = false
      target.status = 'error'
      target.error = error instanceof Error ? error.message : '操作未能完成。'
      notify()
    }
  }, [api, notify])

  const setWritePolicy = useCallback(async (policy: AiWritePolicy, observed: PublicModelSettingsSnapshot): Promise<boolean> => {
    const target = sessionRef.current
    if (!target) return false
    const workspaceId = target.workspaceId
    const workspaceGeneration = target.workspaceGeneration
    const mayReportToTarget = () => sessionRef.current === target
      && sameWorkspaceBinding(target, workspaceId, workspaceGeneration)
    try {
      const response = await api.setAiConversationSettings({ writePolicy: policy }, observed)
      if (!response.ok) {
        if (mayReportToTarget()) {
          target.error = response.error.message
          notify()
        }
        return false
      }
      if (response.value.status === 'conflict') {
        if (mayReportToTarget()) { target.error = '写入策略已在其他窗口更改，请重新加载设置。'; notify() }
        return false
      }
      for (const candidate of activeStore.sessions.values()) candidate.writePolicy = response.value.snapshot.settings.aiConversation.writePolicy
      notify()
      return true
    } catch (error) {
      if (mayReportToTarget()) {
        target.error = error instanceof Error ? error.message : '操作未能完成。'
        notify()
      }
      return false
    }
  }, [activeStore.sessions, api, notify])

  const answerAuthorization = useCallback(async (allowed: boolean): Promise<boolean> => {
    const target = sessionRef.current
    if (!target) return false
    const workspaceId = target.workspaceId
    const workspaceGeneration = target.workspaceGeneration
    const pending = target.pendingAuthorization
    if (!pending) return false
    const decisionKey = JSON.stringify([
      workspaceId, workspaceGeneration, pending.requestId, pending.operationId,
    ])
    if (pending.decisionPending || authorizationDecisionsInFlightRef.current.has(decisionKey)) {
      return false
    }
    pending.decisionPending = true
    authorizationDecisionsInFlightRef.current.add(decisionKey)
    notify()
    try {
      const response = await api.submitAiAuthorizationResult({
        requestId: pending.requestId,
        operationId: pending.operationId,
        allowed,
      })
      if (
        !sameWorkspaceBinding(target, workspaceId, workspaceGeneration)
        || target.pendingAuthorization !== pending
      ) return false
      if (!response.ok) {
        pending.decisionPending = false
        target.error = response.error.message
        notify()
        return false
      }
      return true
    } catch (error) {
      if (
        !sameWorkspaceBinding(target, workspaceId, workspaceGeneration)
        || target.pendingAuthorization !== pending
      ) return false
      target.error = error instanceof Error ? error.message : '操作未能完成。'
      pending.decisionPending = false
      notify()
      return false
    } finally {
      authorizationDecisionsInFlightRef.current.delete(decisionKey)
    }
  }, [api, notify])

  const contextUsage = session?.usage
    ? {
        usedTokens: session.usage.totalTokens,
        contextWindowTokens: session.contextWindowTokens,
        estimated: session.usage.estimated,
      }
    : null

  return {
    draft: session?.draft,
    addQuote,
    viewport: session?.viewport,
    messages: session?.messages ?? [],
    activeAssistantMessageId: session?.activeRequest?.assistantMessageId ?? null,
    timeline: session?.timeline ?? [],
    capabilities: session?.capabilities ?? INACTIVE_CAPABILITIES,
    writePolicy: session?.writePolicy ?? writePolicy ?? 'ask-every-time',
    status: session?.status ?? 'idle',
    error: session?.error ?? null,
    failure: session?.failure ?? null,
    continueRequestId: session?.budgetPause?.continuationId && !session.activeRequest && !session.clearing
      && session.budgetPause.transcriptRevision === session.transcriptRevision
      ? session.budgetPause.requestId : null,
    continueAnalysis,
    pendingAuthorization: session?.pendingAuthorization ?? null,
    authorizationRecords: session?.authorizationRecords ?? [],
    auditRecords: session?.auditRecords ?? [],
    contextUsage,
    sendMessage,
    stopConversation,
    clearConversation,
    setCurrentDocumentAccess,
    setWorkspaceAccess,
    setWritePolicy,
    answerAuthorization,
  }
}
