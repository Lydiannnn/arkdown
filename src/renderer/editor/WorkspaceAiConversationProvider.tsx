import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react'
import type {
  AiCurrentDocumentRendererPort, AiWorkspaceState, ApiResult, ArkdownApi,
} from '../../shared/contracts'
import type { AiWritePolicy } from '../../shared/large-model-settings'
import { AI_DOCUMENT_PAGE_MAX_CHARS } from '../../shared/ai-conversation'
import {
  activateWorkspaceAiSession, activeWorkspaceAiSession, createWorkspaceAiSessionStore,
  hasNonEmptyActiveWorkspaceAiSession, revokeWorkspaceAiSessionAuthority,
  type WorkspaceAiSessionState,
  type WorkspaceAiSessionStore,
} from './workspace-ai-session-store'

type WorkspaceStateApi = Pick<ArkdownApi, 'getAiWorkspaceState'> & Partial<Pick<
  ArkdownApi,
  'notifyAiCurrentDocumentChanged' | 'registerAiCurrentDocumentPort'
  | 'unregisterAiCurrentDocumentPort'
>>

export interface WorkspaceAiCurrentDocumentSnapshot {
  sourceId?: string
  markdown: string
  displayName: string
  sourceFormat: string
  dirty: boolean
}

export interface WorkspaceAiConversationController {
  readonly store: WorkspaceAiSessionStore
  readonly activeWorkspace: AiWorkspaceState | null
  readonly activeSession: WorkspaceAiSessionState | null
  readonly globalWritePolicy: AiWritePolicy | undefined
  activateCurrentWorkspace(): Promise<ApiResult<AiWorkspaceState>>
  acceptWorkspaceAuthority(binding: AiWorkspaceState): void
  deactivateWorkspace(): void
  hasNonEmptyActiveConversation(): boolean
  bindCurrentDocumentSource(
    source: () => WorkspaceAiCurrentDocumentSnapshot,
    binding: AiWorkspaceState,
    sourceId?: string,
  ): () => void
  setGlobalWritePolicy(policy: AiWritePolicy): void
}

const WorkspaceAiConversationContext = createContext<WorkspaceAiConversationController | null>(null)

async function retryTransition<T>(operation: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  let result = await operation()
  for (let attempt = 1; !result.ok && attempt < 3; attempt += 1) {
    await Promise.resolve()
    result = await operation()
  }
  return result
}

export function WorkspaceAiConversationProvider({
  api = window.arkdown, children, createId,
}: {
  api?: WorkspaceStateApi
  children: ReactNode
  createId?: () => string
}) {
  const storeRef = useRef<WorkspaceAiSessionStore | null>(null)
  storeRef.current ??= createWorkspaceAiSessionStore(createId)
  const requestGenerationRef = useRef(0)
  const sourceRef = useRef<{
    token: symbol
    sourceId?: string
    read: () => WorkspaceAiCurrentDocumentSnapshot
  } | null>(null)
  const stagedSourceRef = useRef<{
    token: symbol
    sourceId?: string
    read: () => WorkspaceAiCurrentDocumentSnapshot
  } | null>(null)
  const snapshotsRef = useRef(new Map<string, WorkspaceAiCurrentDocumentSnapshot>())
  const transitionQueueRef = useRef<Promise<void>>(Promise.resolve())
  const registeredBindingRef = useRef<string | null>(null)
  const desiredBindingRef = useRef<string | null>(null)
  const writePolicyRef = useRef<AiWritePolicy | undefined>(undefined)
  const [globalWritePolicy, setGlobalWritePolicyState] = useState<AiWritePolicy | undefined>()
  const [revision, setRevision] = useState(0)
  const store = storeRef.current

  const portRef = useRef<AiCurrentDocumentRendererPort | null>(null)
  portRef.current ??= {
    async openSnapshot({ cursor, maxChars, expectedDocumentId }) {
      const source = sourceRef.current
      if (!source || cursor !== 0) return { status: 'unavailable' }
      if (expectedDocumentId !== undefined && source.sourceId !== expectedDocumentId) return { status: 'unavailable' }
      const snapshot = source.read()
      if (expectedDocumentId !== undefined && snapshot.sourceId !== expectedDocumentId) {
        return { status: 'unavailable' }
      }
      const snapshotId = crypto.randomUUID()
      const snapshots = snapshotsRef.current
      snapshots.set(snapshotId, snapshot)
      while (snapshots.size > 8) {
        const oldest = snapshots.keys().next().value as string | undefined
        if (!oldest) break
        snapshots.delete(oldest)
      }
      const content = snapshot.markdown.slice(0, Math.min(maxChars, AI_DOCUMENT_PAGE_MAX_CHARS))
      const nextCursor = content.length < snapshot.markdown.length ? content.length : null
      return {
        status: 'captured', snapshotId, displayName: snapshot.displayName,
        sourceFormat: snapshot.sourceFormat, dirty: snapshot.dirty, content, nextCursor,
        hasMore: nextCursor !== null, totalChars: snapshot.markdown.length,
      }
    },
    async readPage({ snapshotId, cursor, maxChars }) {
      const snapshot = snapshotsRef.current.get(snapshotId)
      if (!snapshot || cursor < 0 || cursor > snapshot.markdown.length) {
        return { status: 'unavailable' }
      }
      const content = snapshot.markdown.slice(
        cursor, cursor + Math.min(maxChars, AI_DOCUMENT_PAGE_MAX_CHARS),
      )
      const consumed = cursor + content.length
      const nextCursor = consumed < snapshot.markdown.length ? consumed : null
      return {
        status: 'captured', displayName: snapshot.displayName, sourceFormat: snapshot.sourceFormat,
        dirty: snapshot.dirty, content, nextCursor, hasMore: nextCursor !== null,
        totalChars: snapshot.markdown.length,
      }
    },
    release({ snapshotId }) { snapshotsRef.current.delete(snapshotId) },
  }

  const reconcileCurrentDocumentPort = useCallback(() => {
    transitionQueueRef.current = transitionQueueRef.current.then(async () => {
      const unregister = api.unregisterAiCurrentDocumentPort
      const register = api.registerAiCurrentDocumentPort
      while (registeredBindingRef.current !== desiredBindingRef.current) {
        if (registeredBindingRef.current !== null) {
          if (!unregister) registeredBindingRef.current = null
          else {
            const result = await retryTransition(unregister)
            if (!result.ok) return
            registeredBindingRef.current = null
          }
          snapshotsRef.current.clear()
          continue
        }
        const desired = desiredBindingRef.current
        if (desired === null || !register) return
        const result = await retryTransition(() => register(portRef.current!))
        if (!result.ok) return
        registeredBindingRef.current = desired
      }
    }).catch(() => undefined)
  }, [api])

  const setGlobalWritePolicy = useCallback((policy: AiWritePolicy) => {
    writePolicyRef.current = policy
    for (const session of store.sessions.values()) session.writePolicy = policy
    setGlobalWritePolicyState(policy)
    setRevision((current) => current + 1)
  }, [store])

  const activateCurrentWorkspace = useCallback(async (): Promise<ApiResult<AiWorkspaceState>> => {
    const requestGeneration = ++requestGenerationRef.current
    for (const session of store.sessions.values()) revokeWorkspaceAiSessionAuthority(session)
    store.activeWorkspaceId = null
    desiredBindingRef.current = null
    sourceRef.current = null
    stagedSourceRef.current = null
    snapshotsRef.current.clear()
    reconcileCurrentDocumentPort()
    setRevision((current) => current + 1)
    const result = await api.getAiWorkspaceState()
    if (requestGenerationRef.current !== requestGeneration) return result
    if (result.ok) {
      const session = activateWorkspaceAiSession(store, result.value)
      if (writePolicyRef.current !== undefined) session.writePolicy = writePolicyRef.current
      desiredBindingRef.current = `${result.value.workspaceId}\u0000${result.value.workspaceGeneration}`
      reconcileCurrentDocumentPort()
      setRevision((current) => current + 1)
    }
    return result
  }, [api, reconcileCurrentDocumentPort, store])

  const deactivateWorkspace = useCallback(() => {
    requestGenerationRef.current += 1
    for (const session of store.sessions.values()) revokeWorkspaceAiSessionAuthority(session)
    store.activeWorkspaceId = null
    desiredBindingRef.current = null
    sourceRef.current = null
    stagedSourceRef.current = null
    snapshotsRef.current.clear()
    reconcileCurrentDocumentPort()
    setRevision((current) => current + 1)
  }, [reconcileCurrentDocumentPort, store])

  const acceptWorkspaceAuthority = useCallback((binding: AiWorkspaceState) => {
    requestGenerationRef.current += 1
    const session = activateWorkspaceAiSession(store, binding)
    if (writePolicyRef.current !== undefined) session.writePolicy = writePolicyRef.current
    desiredBindingRef.current = `${binding.workspaceId}\u0000${binding.workspaceGeneration}`
    sourceRef.current = null
    stagedSourceRef.current = null
    snapshotsRef.current.clear()
    reconcileCurrentDocumentPort()
    setRevision((current) => current + 1)
  }, [reconcileCurrentDocumentPort, store])

  useEffect(() => () => {
    desiredBindingRef.current = null
    sourceRef.current = null
    stagedSourceRef.current = null
    snapshotsRef.current.clear()
    reconcileCurrentDocumentPort()
  }, [reconcileCurrentDocumentPort])

  const hasNonEmptyActiveConversation = useCallback(() => (
    hasNonEmptyActiveWorkspaceAiSession(store)
  ), [store])

  const bindCurrentDocumentSource = useCallback((
    read: () => WorkspaceAiCurrentDocumentSnapshot,
    binding: AiWorkspaceState,
    sourceId?: string,
  ) => {
    const token = Symbol('current-document-source')
    sourceRef.current = null
    stagedSourceRef.current = { token, read, sourceId }
    const notifyCurrentDocumentChanged = api.notifyAiCurrentDocumentChanged
    if (notifyCurrentDocumentChanged) {
      void notifyCurrentDocumentChanged(binding).then((result) => {
        const staged = stagedSourceRef.current
        if (!result.ok || staged?.token !== token) return
        sourceRef.current = staged
      }).catch(() => undefined)
    }
    return () => {
      if (sourceRef.current?.token === token) sourceRef.current = null
      if (stagedSourceRef.current?.token === token) stagedSourceRef.current = null
    }
  }, [api, store])

  const activeSession = activeWorkspaceAiSession(store)
  const controller = useMemo<WorkspaceAiConversationController>(() => ({
    store,
    activeWorkspace: activeSession ? {
      workspaceId: activeSession.workspaceId,
      workspaceGeneration: activeSession.workspaceGeneration,
    } : null,
    activeSession,
    globalWritePolicy,
    activateCurrentWorkspace,
    acceptWorkspaceAuthority,
    deactivateWorkspace,
    hasNonEmptyActiveConversation,
    bindCurrentDocumentSource,
    setGlobalWritePolicy,
  }), [
    acceptWorkspaceAuthority, activateCurrentWorkspace, activeSession, bindCurrentDocumentSource,
    deactivateWorkspace, globalWritePolicy, hasNonEmptyActiveConversation, revision,
    setGlobalWritePolicy, store,
  ])

  return (
    <WorkspaceAiConversationContext.Provider value={controller}>
      {children}
    </WorkspaceAiConversationContext.Provider>
  )
}

export function useWorkspaceAiConversationController(): WorkspaceAiConversationController {
  const value = useContext(WorkspaceAiConversationContext)
  if (!value) throw new Error('useWorkspaceAiConversationController must be used inside its provider')
  return value
}

export function useOptionalWorkspaceAiConversationController(): WorkspaceAiConversationController | null {
  return useContext(WorkspaceAiConversationContext)
}
