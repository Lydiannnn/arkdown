import { describe, expect, it } from 'vitest'
import {
  activateWorkspaceAiSession,
  activeWorkspaceAiSession,
  createWorkspaceAiSessionStore,
  hasNonEmptyActiveWorkspaceAiSession,
  revokeWorkspaceAiSessionAuthority,
  retainIncompleteAssistantMessage,
  AI_INCOMPLETE_MESSAGE_LIMIT,
  type WorkspaceAiActiveRequest,
} from '../../src/renderer/editor/workspace-ai-session-store'

describe('workspace AI session store', () => {
  it('preserves default document intent and explicit denial across authority revocation', () => {
    const store = createWorkspaceAiSessionStore(() => 'conversation')
    const session = activateWorkspaceAiSession(store, { workspaceId: 'a', workspaceGeneration: '1' })
    revokeWorkspaceAiSessionAuthority(session)
    expect(session.capabilities.currentDocument).toBe(true)
    expect(session.authoritativeCapabilities).toEqual({ currentDocument: false, workspace: false })
    session.capabilities.currentDocument = false
    activateWorkspaceAiSession(store, { workspaceId: 'b', workspaceGeneration: '2' })
    expect(activateWorkspaceAiSession(store, { workspaceId: 'a', workspaceGeneration: '3' }).capabilities.currentDocument).toBe(false)
  })
  it('starts new workspace sessions with both read capabilities on and never restores revoked authority by activation', () => {
    const store = createWorkspaceAiSessionStore(() => 'conversation')
    const binding = { workspaceId: 'workspace-a', workspaceGeneration: 'generation-1' }
    const session = activateWorkspaceAiSession(store, binding)
    expect(session.capabilities).toEqual({ currentDocument: true, workspace: true })
    expect(session.authoritativeCapabilities).toEqual({ currentDocument: false, workspace: false })
    revokeWorkspaceAiSessionAuthority(session)
    expect(activateWorkspaceAiSession(store, binding).capabilities).toEqual({ currentDocument: true, workspace: true })
    expect(session.authoritativeCapabilities).toEqual({ currentDocument: false, workspace: false })
    const second = activateWorkspaceAiSession(store, { workspaceId: 'workspace-b', workspaceGeneration: 'generation-2' })
    expect(second.capabilities).toEqual({ currentDocument: true, workspace: true })
    expect(activateWorkspaceAiSession(store, binding).capabilities).toEqual({ currentDocument: true, workspace: true })
  })

  it('uses workspaceId as the stable key and generation only as an authority fence', () => {
    let sequence = 0
    const store = createWorkspaceAiSessionStore(() => `conversation-${++sequence}`)
    const first = activateWorkspaceAiSession(store, {
      workspaceId: 'workspace-a',
      workspaceGeneration: 'generation-1',
    })
    first.messages.push({ id: 'message-1', role: 'user', content: 'keep me' })
    first.messages.push({ id: 'assistant-complete', role: 'assistant', content: 'completed' })
    first.messages.push({ id: 'assistant-1', role: 'assistant', content: 'partial' })
    first.timeline.push({
      kind: 'context-compaction', id: 'local-record', record: {
        status: 'compacted', beforeTokens: 78_000, afterTokens: 46_000, contextWindowTokens: 100_000,
      },
    })
    first.transcriptRevision = 3
    first.capabilities = { currentDocument: true, workspace: true }
    first.sendGeneration = 4
    first.status = 'streaming'
    const activeRequest = {
      requestId: 'request-1',
      assistantMessageId: 'assistant-1',
      invalidated: false,
      startPending: false,
      terminal: false,
      protocol: {
        phase: 'streaming' as const,
        startMode: null,
        userMessageId: 'message-1',
        queuedEvents: [],
      },
    }
    first.activeRequest = activeRequest
    first.clearing = true

    const other = activateWorkspaceAiSession(store, {
      workspaceId: 'workspace-b',
      workspaceGeneration: 'generation-9',
    })
    expect(other.conversationId).toBe('conversation-2')
    expect(other.messages).toEqual([])

    const restored = activateWorkspaceAiSession(store, {
      workspaceId: 'workspace-a',
      workspaceGeneration: 'generation-2',
    })
    expect(restored).toBe(first)
    expect(restored.conversationId).toBe('conversation-1')
    expect(restored.messages.map(({ content }) => content)).toEqual(['keep me', 'completed'])
    expect(restored.timeline).toEqual([{
      kind: 'context-compaction', id: 'local-record', record: {
        status: 'compacted', beforeTokens: 78_000, afterTokens: 46_000, contextWindowTokens: 100_000,
      },
    }, { kind: 'incomplete-message', message: { id: 'assistant-1', role: 'assistant', content: 'partial' }, outcome: 'stopped' }])
    expect(restored.transcriptRevision).toBe(3)
    expect(restored.workspaceGeneration).toBe('generation-2')
    expect(restored.capabilities).toEqual({ currentDocument: true, workspace: true })
    expect(restored.authoritativeCapabilities).toEqual({ currentDocument: false, workspace: false })
    expect(activeRequest.invalidated).toBe(true)
    expect(restored.activeRequest).toBeNull()
    expect(restored.status).toBe('idle')
    expect(restored.clearing).toBe(false)
    expect(restored.sendGeneration).toBe(6)
    expect(activeWorkspaceAiSession(store)).toBe(restored)
  })

  it('prompts only for a nonempty active conversation', () => {
    const store = createWorkspaceAiSessionStore(() => 'conversation-a')
    const session = activateWorkspaceAiSession(store, {
      workspaceId: 'workspace-a',
      workspaceGeneration: 'generation-1',
    })

    expect(hasNonEmptyActiveWorkspaceAiSession(store)).toBe(false)
    session.messages.push({ id: 'message-1', role: 'assistant', content: 'answer' })
    expect(hasNonEmptyActiveWorkspaceAiSession(store)).toBe(true)
  })
})

it('bounds display-only partial replies without discarding completed messages or claiming replay authority', () => {
  const store = createWorkspaceAiSessionStore(() => 'conversation')
  const session = activateWorkspaceAiSession(store, { workspaceId: 'w', workspaceGeneration: 'g' })
  session.messages = [{ id: 'final', role: 'assistant', content: 'confirmed answer' }]
  session.timeline = [{ kind: 'message', messageId: 'final' }]
  session.transcriptRevision = 7
  for (let index = 0; index < AI_INCOMPLETE_MESSAGE_LIMIT + 2; index++) {
    const id = `partial-${index}`
    session.messages.push({ id, role: 'assistant', content: `useful-${index}` })
    session.timeline.push({ kind: 'message', messageId: id })
    const active: WorkspaceAiActiveRequest = { requestId: id, assistantMessageId: id, invalidated: false, startPending: false,
      terminal: false, protocol: { phase: 'streaming', startMode: 'normal', userMessageId: 'u', queuedEvents: [] } }
    session.activeRequest = active
    retainIncompleteAssistantMessage(session, active, 'failed')
    retainIncompleteAssistantMessage(session, active, 'stopped')
  }
  const partials = session.timeline.filter(entry => entry.kind === 'incomplete-message')
  expect(partials).toHaveLength(AI_INCOMPLETE_MESSAGE_LIMIT)
  expect(partials[0]).toMatchObject({ message: { content: 'useful-2' }, outcome: 'failed' })
  expect(partials.at(-1)).toMatchObject({ message: { content: 'useful-21' } })
  expect(session.timeline.filter(entry => entry.kind === 'incomplete-omission')).toHaveLength(1)
  expect(session.messages).toEqual([{ id: 'final', role: 'assistant', content: 'confirmed answer' }])
  expect(session.timeline).toContainEqual({ kind: 'message', messageId: 'final' })
  expect(session.transcriptRevision).toBe(7)
})

it('omits empty partial placeholders and ignores a foreign active request', () => {
  const store = createWorkspaceAiSessionStore(() => 'conversation')
  const session = activateWorkspaceAiSession(store, { workspaceId: 'w', workspaceGeneration: 'g' })
  const active: WorkspaceAiActiveRequest = { requestId: 'r', assistantMessageId: 'a', invalidated: false, startPending: false,
    terminal: false, protocol: { phase: 'streaming', startMode: 'normal', userMessageId: 'u', queuedEvents: [] } }
  session.activeRequest = active
  session.messages = [{ id: 'a', role: 'assistant', content: '  ' }]
  session.timeline = [{ kind: 'message', messageId: 'a' }]
  retainIncompleteAssistantMessage(session, { ...active }, 'failed')
  expect(session.messages).toHaveLength(1)
  retainIncompleteAssistantMessage(session, active, 'stopped')
  expect(session.messages).toEqual([])
  expect(session.timeline).toEqual([])
  expect(active.assistantMessageId).toBeNull()
})
