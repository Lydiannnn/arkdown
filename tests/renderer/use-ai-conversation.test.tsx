import { modelObservation, modelCommit } from '../helpers/model-observation'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import { act, render, renderHook, fireEvent, screen, waitFor } from '@testing-library/react'
import { AiBudgetNotice } from '../../src/renderer/editor/AiBudgetNotice'
import { describe, expect, it, vi } from 'vitest'
import type {
  AiConversationEvent,
} from '../../src/shared/ai-conversation'
import type {
  AiConversationSettings,
  AiWritePolicy,
  LargeModelSettings,
} from '../../src/shared/large-model-settings'
import type { ApiResult, ArkdownApi, AiWorkspaceState } from '../../src/shared/contracts'
import { createWorkspaceAiSessionStore } from '../../src/renderer/editor/workspace-ai-session-store'
import { useAiConversation } from '../../src/renderer/editor/use-ai-conversation'
import { startModelRulesInitialization } from '../../src/renderer/settings/model-rules-runtime'
import type { AiBudgetPausedEvent } from '../../src/shared/ai-budget-result'

const WORKSPACE: AiWorkspaceState = {
  workspaceId: 'workspace-a',
  workspaceGeneration: 'generation-1',
}

function success<T>(value: T): ApiResult<T> {
  return { ok: true, value }
}

function createIds() {
  let value = 0
  return () => `550e8400-e29b-41d4-a716-${String(++value).padStart(12, '0')}`
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

type ConversationApi = Pick<
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

function createHarness() {
  const listeners = new Set<(event: AiConversationEvent) => void>()
  const settings: AiConversationSettings = {
    connectionId: '550e8400-e29b-41d4-a716-446655440000',
    thinkingMode: 'default' as const, reasoningEffort: 'default',
    writePolicy: 'ask-every-time',
  }
  const api: ConversationApi = {
    cancelAiConversation: vi.fn(async () => success(null)),
    clearAiConversation: vi.fn(async () => success(null)),
    getLargeModelSettings: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'OPERATION_FAILED' as const, message: 'not needed' },
    })),
    onAiConversationEvent: vi.fn((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    setAiConversationCapabilities: vi.fn(async () => success(null)),
    setAiConversationSettings: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'OPERATION_FAILED' as const, message: 'not needed' },
    })),
    startAiConversation: vi.fn(async (input) => success({
      requestId: input.requestId,
      modelId: 'model-a',
      transcriptRevision: 1,
    })),
    submitAiAuthorizationResult: vi.fn(async () => success(null)),
  }
  return {
    api,
    emit(event: AiConversationEvent) {
      for (const listener of listeners) listener(event)
    },
    settings,
  }
}

describe('workspace tree notifications from committed AI mutations', () => {
  function completeToolMessage(harness: ReturnType<typeof createHarness>, input: Parameters<ConversationApi['startAiConversation']>[0]) {
    harness.emit({ requestId: input.requestId, type: 'started', transcriptRevision: 1 })
    harness.emit({ requestId: input.requestId, type: 'user-message-accepted', messageId: input.messages[0]!.id, transcriptRevision: 1 })
    harness.emit({ requestId: input.requestId, type: 'message-start', messageId: 'assistant-tool', previousTranscriptRevision: 1 })
    harness.emit({ requestId: input.requestId, type: 'message-completed', messageId: 'assistant-tool', transcriptRevision: 2 })
  }

  it('notifies once for each accepted create or rename using the current callback, without adding listeners', async () => {
    const harness = createHarness(), ids = createIds()
    const previousCallback = vi.fn(), onWorkspaceFilesChanged = vi.fn()
    const view = renderHook(({ callback }) => useAiConversation({
      api: harness.api, workspace: WORKSPACE, createId: ids, onWorkspaceFilesChanged: callback,
    }), { initialProps: { callback: previousCallback } })
    await act(async () => { await view.result.current.sendMessage('create then rename') })
    const input = vi.mocked(harness.api.startAiConversation).mock.lastCall![0]
    view.rerender({ callback: onWorkspaceFilesChanged })
    act(() => {
      harness.emit({ requestId: input.requestId, type: 'audit', action: 'created', absolutePaths: ['C:/Notes/early.md'] })
      completeToolMessage(harness, input)
      for (const action of ['authorization-allowed', 'authorization-denied', 'edited', 'deleted'] as const) {
        harness.emit({ requestId: input.requestId, type: 'audit', action, absolutePaths: ['C:/Notes/unopened.md'] })
      }
      harness.emit({ requestId: 'another-request', type: 'audit', action: 'created', absolutePaths: ['C:/Other/wrong.md'] })
    })
    expect(onWorkspaceFilesChanged).not.toHaveBeenCalled()
    act(() => harness.emit({ requestId: input.requestId, type: 'audit', action: 'created', absolutePaths: ['C:/Notes/created.md'] }))
    expect(onWorkspaceFilesChanged).toHaveBeenCalledExactlyOnceWith(WORKSPACE)
    act(() => harness.emit({ requestId: input.requestId, type: 'audit', action: 'renamed', absolutePaths: ['C:/Notes/created.md', 'C:/Notes/renamed.md'] }))
    expect(onWorkspaceFilesChanged).toHaveBeenCalledTimes(2)
    expect(onWorkspaceFilesChanged).toHaveBeenLastCalledWith(WORKSPACE)
    act(() => {
      harness.emit({ requestId: input.requestId, type: 'failed', code: 'OPERATION_FAILED', message: 'failed' })
      harness.emit({ requestId: input.requestId, type: 'audit', action: 'created', absolutePaths: ['C:/Notes/late.md'] })
    })
    expect(onWorkspaceFilesChanged).toHaveBeenCalledTimes(2)
    expect(previousCallback).not.toHaveBeenCalled()
    expect(harness.api.onAiConversationEvent).toHaveBeenCalledTimes(1)
    view.unmount()
    act(() => harness.emit({ requestId: input.requestId, type: 'audit', action: 'renamed', absolutePaths: ['C:/Notes/late.md'] }))
    expect(onWorkspaceFilesChanged).toHaveBeenCalledTimes(2)
  })

  it.each([true, false])('only notifies queued mutations after successful admission: %s', async admitted => {
    const harness = createHarness(), ids = createIds(), onWorkspaceFilesChanged = vi.fn()
    const admission = deferred<Awaited<ReturnType<ConversationApi['startAiConversation']>>>()
    vi.mocked(harness.api.startAiConversation).mockReturnValueOnce(admission.promise)
    const view = renderHook(() => useAiConversation({ api: harness.api, workspace: WORKSPACE, createId: ids, onWorkspaceFilesChanged }))
    let sending!: Promise<boolean>
    act(() => { sending = view.result.current.sendMessage('create') })
    await waitFor(() => expect(harness.api.startAiConversation).toHaveBeenCalledOnce())
    const input = vi.mocked(harness.api.startAiConversation).mock.lastCall![0]
    act(() => {
      completeToolMessage(harness, input)
      harness.emit({ requestId: input.requestId, type: 'audit', action: 'created', absolutePaths: ['C:/Notes/created.md'] })
      harness.emit({ requestId: input.requestId, type: 'audit', action: 'renamed', absolutePaths: ['C:/Notes/created.md', 'C:/Notes/renamed.md'] })
    })
    expect(onWorkspaceFilesChanged).not.toHaveBeenCalled()
    await act(async () => {
      admission.resolve(admitted ? success({ requestId: input.requestId, modelId: 'model-a', transcriptRevision: 1 })
        : { ok: false, error: { code: 'OPERATION_FAILED', message: 'not admitted' } })
      expect(await sending).toBe(admitted)
    })
    expect(onWorkspaceFilesChanged.mock.calls).toEqual(admitted ? [[WORKSPACE], [WORKSPACE]] : [])
    view.unmount()
  })

  it.each([
    { workspaceId: 'workspace-b', workspaceGeneration: 'generation-1' },
    { workspaceId: 'workspace-a', workspaceGeneration: 'generation-2' },
  ])('ignores a previous workspace request after switching to %j', async workspace => {
    const harness = createHarness(), ids = createIds(), onWorkspaceFilesChanged = vi.fn()
    const view = renderHook(({ binding }) => useAiConversation({
      api: harness.api, workspace: binding, createId: ids, onWorkspaceFilesChanged,
    }), { initialProps: { binding: WORKSPACE } })
    await act(async () => { await view.result.current.sendMessage('create') })
    const input = vi.mocked(harness.api.startAiConversation).mock.lastCall![0]
    act(() => completeToolMessage(harness, input))
    view.rerender({ binding: workspace })
    act(() => harness.emit({ requestId: input.requestId, type: 'audit', action: 'created', absolutePaths: ['C:/Notes/stale.md'] }))
    expect(onWorkspaceFilesChanged).not.toHaveBeenCalled()
    expect(harness.api.onAiConversationEvent).toHaveBeenCalledTimes(1)
    view.unmount()
  })
})

it.each(['network', 'cli-unavailable', 'cli-authentication', 'service-unavailable'] as const)(
  'shows actionable preflight %s evidence while preserving existing partial output', async reason => {
    const harness = createHarness(), ids = createIds(), store = createWorkspaceAiSessionStore(ids)
    const view = renderHook(() => useAiConversation({ api: harness.api, store, workspace: WORKSPACE, createId: ids }))
    await act(async () => { await view.result.current.sendMessage('first question') })
    const input = vi.mocked(harness.api.startAiConversation).mock.lastCall![0]
    const messageId = ids()
    act(() => {
      harness.emit({ requestId: input.requestId, type: 'started', transcriptRevision: 1 })
      harness.emit({ requestId: input.requestId, type: 'user-message-accepted', messageId: input.messages[0]!.id, transcriptRevision: 1 })
      harness.emit({ requestId: input.requestId, type: 'message-start', messageId, previousTranscriptRevision: 1 })
      harness.emit({ requestId: input.requestId, type: 'delta', messageId, delta: 'trusted partial answer' })
      harness.emit({ requestId: input.requestId, type: 'failed', code: 'MODEL_TIMEOUT', message: 'fixed timeout' })
    })
    const detail = { version: 1 as const, reason, stage: 'connect' as const, source: 'local' as const }
    vi.mocked(harness.api.startAiConversation).mockResolvedValueOnce({ ok: false, error: {
      code: 'MODEL_INCOMPATIBLE_RESPONSE', message: 'SECRET raw provider error', detail,
    } })
    await act(async () => { expect(await view.result.current.sendMessage('next question')).toBe(false) })
    const expected = { network: '检查网络连接', 'cli-unavailable': '组件安装', 'cli-authentication': '重新登录', 'service-unavailable': '暂时不可用' }
    expect(view.result.current.error).toContain(expected[reason])
    expect(view.result.current.error).not.toContain('SECRET')
    expect(view.result.current.failure).toEqual({ code: 'MODEL_INCOMPATIBLE_RESPONSE', detail })
    expect(JSON.stringify(store.sessions.get(WORKSPACE.workspaceId))).toContain('trusted partial answer')
    expect(view.result.current.messages.map(message => message.content)).not.toContain('next question')
    view.unmount()
  },
)

it('does not display raw rejected start transport exceptions', async () => {
  const harness = createHarness(), ids = createIds()
  vi.mocked(harness.api.startAiConversation).mockRejectedValueOnce(new Error('SECRET C:/private/key'))
  const view = renderHook(() => useAiConversation({ api: harness.api, workspace: WORKSPACE, createId: ids }))
  await act(async () => { expect(await view.result.current.sendMessage('question')).toBe(false) })
  expect(view.result.current.error).toBe('操作未能完成')
  expect(view.result.current.failure).toEqual({ code: 'OPERATION_FAILED' })
  view.unmount()
})

describe('budget pause and explicit continuation', () => {
  function pause(requestId: string, continuationId: string | null, revision = 1): AiBudgetPausedEvent {
    return { requestId, type: 'budget-paused', transcriptRevision: revision, continuationId, reason: 'read-budget',
      counts: { readAdmitted: 64, writeAdmitted: 1, rejectedNewCalls: 1, toolRounds: 20 },
      outcomes: { readSucceeded: 62, readFailed: 1, readDenied: 1, readUnavailable: 0,
        writeSucceeded: 1, writeFailed: 0, writeDenied: 0, writeUnavailable: 0, writeUnknown: 0, notExecuted: 1 },
      finalization: { status: 'failed', code: 'MODEL_RATE_LIMITED' } }
  }
  async function started() {
    const harness = createHarness(), ids = createIds(), store = createWorkspaceAiSessionStore(ids)
    const view = renderHook(({ workspace, profile }) => useAiConversation({ api: harness.api, createId: ids, store,
      workspace, profileFingerprint: profile }), { initialProps: { workspace: WORKSPACE, profile: 'profile-a' } })
    await act(async () => { await view.result.current.sendMessage('review workspace') })
    const input = vi.mocked(harness.api.startAiConversation).mock.lastCall![0]
    const messageId = ids()
    act(() => {
      harness.emit({ requestId: input.requestId, type: 'started', transcriptRevision: 1 })
      harness.emit({ requestId: input.requestId, type: 'user-message-accepted', messageId: input.messages[0]!.id, transcriptRevision: 1 })
      harness.emit({ requestId: input.requestId, type: 'message-start', messageId, previousTranscriptRevision: 1 })
      harness.emit({ requestId: input.requestId, type: 'delta', messageId, delta: 'unfinished findings' })
    })
    return { harness, ids, store, view, input, messageId }
  }
  it('keeps failed finalization as display-only evidence and terminates as paused, not failed or completed', async () => {
    const { harness, ids, store, view, input } = await started()
    const event = pause(input.requestId, ids())
    act(() => harness.emit(event))
    const session = store.sessions.get(WORKSPACE.workspaceId)!
    expect(session.activeRequest).toBeNull()
    expect(session.transcriptRevision).toBe(1)
    expect(session.processes.get(input.requestId)?.outcome).toBe('paused')
    expect(view.result.current.status).toBe('idle')
    expect(view.result.current.error).toBeNull()
    expect(view.result.current.messages.map(message => message.content)).toEqual(['review workspace'])
    expect(view.result.current.timeline).toContainEqual(expect.objectContaining({ kind: 'incomplete-message', outcome: 'paused' }))
    expect(view.result.current.timeline).toContainEqual({ kind: 'budget-pause', record: event })
    expect(view.result.current.continueRequestId).toBe(input.requestId)
    act(() => { harness.emit(event); harness.emit({ requestId: input.requestId, type: 'completed' }) })
    expect(view.result.current.timeline.filter(entry => entry.kind === 'budget-pause')).toHaveLength(1)
    expect(session.processes.get(input.requestId)?.outcome).toBe('paused')
    view.unmount()
  })
  it('retains a completed summary as acknowledged content without declaring the whole task complete', async () => {
    const { harness, ids, view, input, messageId } = await started()
    act(() => {
      harness.emit({ requestId: input.requestId, type: 'message-completed', messageId, transcriptRevision: 2 })
      harness.emit({ ...pause(input.requestId, ids(), 2), finalization: { status: 'completed' } })
    })
    expect(view.result.current.messages.at(-1)?.content).toBe('unfinished findings')
    expect(view.result.current.timeline.some(entry => entry.kind === 'incomplete-message')).toBe(false)
    expect(view.result.current.continueRequestId).toBe(input.requestId)
    view.unmount()
  })
  it('continues once with only a fresh user delta and the main-issued receipt, preserving the composer draft', async () => {
    const { harness, ids, view, input } = await started()
    const token = ids()
    act(() => harness.emit(pause(input.requestId, token)))
    view.result.current.draft!.text = 'keep this draft'
    const gate = deferred<Awaited<ReturnType<ConversationApi['startAiConversation']>>>()
    vi.mocked(harness.api.startAiConversation).mockReturnValueOnce(gate.promise)
    let continuing!: Promise<boolean>
    act(() => { continuing = view.result.current.continueAnalysis(input.requestId, 'current-document-source') })
    await act(async () => { expect(await view.result.current.continueAnalysis(input.requestId)).toBe(false) })
    const continuation = vi.mocked(harness.api.startAiConversation).mock.lastCall![0]
    expect(harness.api.startAiConversation).toHaveBeenCalledTimes(2)
    expect(continuation).toMatchObject({ conversationId: input.conversationId, acknowledgedTranscriptRevision: 1,
      continuationOfSegmentId: token, expectedDocumentId: 'current-document-source',
      messages: [{ id: expect.any(String), role: 'user', content: '继续分析' }] })
    expect(continuation.messages).toHaveLength(1)
    expect(continuation.requestId).not.toBe(input.requestId)
    await act(async () => { gate.resolve(success({ requestId: continuation.requestId, modelId: 'model-a', transcriptRevision: 2 })); expect(await continuing).toBe(true) })
    expect(view.result.current.continueRequestId).toBeNull()
    expect(view.result.current.draft!.text).toBe('keep this draft')
    view.unmount()
  })
  it.each(['workspace', 'profile', 'clear', 'new-message'] as const)('revokes continuation on %s but retains historical evidence unless cleared', async boundary => {
    const { harness, ids, view, input, store } = await started()
    act(() => harness.emit(pause(input.requestId, ids())))
    if (boundary === 'workspace') view.rerender({ workspace: { ...WORKSPACE, workspaceGeneration: 'new-generation' }, profile: 'profile-a' })
    else if (boundary === 'profile') view.rerender({ workspace: WORKSPACE, profile: 'profile-b' })
    else if (boundary === 'clear') await act(async () => { await view.result.current.clearConversation() })
    else {
      vi.mocked(harness.api.startAiConversation).mockImplementation(async next => success({ requestId: next.requestId, modelId: 'model-a', transcriptRevision: next.acknowledgedTranscriptRevision + 1 }))
      await act(async () => { await view.result.current.sendMessage('different instruction') })
    }
    const before = vi.mocked(harness.api.startAiConversation).mock.calls.length
    await act(async () => { expect(await view.result.current.continueAnalysis(input.requestId)).toBe(false) })
    expect(harness.api.startAiConversation).toHaveBeenCalledTimes(before)
    expect(store.sessions.get(WORKSPACE.workspaceId)!.timeline.some(entry => entry.kind === 'budget-pause')).toBe(boundary !== 'clear')
    view.unmount()
  })
  it('rejects a wrong transcript revision and a premature pause without poisoning the live stream', async () => {
    const { harness, ids, view, input } = await started()
    act(() => harness.emit(pause(input.requestId, ids(), 99)))
    expect(view.result.current.status).toBe('streaming')
    expect(view.result.current.timeline.some(entry => entry.kind === 'budget-pause')).toBe(false)
    view.unmount()
  })
  it('keeps the receipt after a rejected continuation preflight, but never continues without a receipt', async () => {
    const { harness, ids, view, input } = await started()
    act(() => harness.emit(pause(input.requestId, ids())))
    vi.mocked(harness.api.startAiConversation).mockResolvedValueOnce({ ok: false, error: { code: 'OPERATION_FAILED', message: 'preflight failed' } })
    await act(async () => { expect(await view.result.current.continueAnalysis(input.requestId)).toBe(false) })
    expect(view.result.current.continueRequestId).toBe(input.requestId)
    expect(view.result.current.messages.map(message => message.content)).toEqual(['review workspace'])
    await act(async () => { expect(await view.result.current.continueAnalysis('unknown-request')).toBe(false) })
    expect(harness.api.startAiConversation).toHaveBeenCalledTimes(2)
    view.unmount()
  })
  it.each(['cancel', 'permission-change'] as const)('explains a real hook continuation ended after %s without denying possible backend admission or implying write replay', async boundary => {
    const { harness, ids, view, input, store } = await started()
    const record = pause(input.requestId, ids())
    act(() => harness.emit(record))
    const gate = deferred<Awaited<ReturnType<ConversationApi['startAiConversation']>>>()
    vi.mocked(harness.api.startAiConversation).mockReturnValueOnce(gate.promise)
    render(<AiBudgetNotice record={record} onContinue={requestId => view.result.current.continueAnalysis(requestId)} />)
    fireEvent.click(screen.getByRole('button', { name: '继续分析' }))
    const continuation = vi.mocked(harness.api.startAiConversation).mock.lastCall![0]
    if (boundary === 'cancel') await act(async () => { await view.result.current.stopConversation() })
    else await act(async () => { await view.result.current.setWorkspaceAccess(false) })
    await act(async () => { gate.resolve(boundary === 'cancel'
      ? success({ requestId: continuation.requestId, modelId: 'model-a', transcriptRevision: 2 })
      : { ok: false, error: { code: 'PERMISSION_DENIED', message: '没有权限访问该文件' } }) })
    expect(screen.getByRole('alert')).toHaveTextContent(/本次继续未能保持运行.*核对已有结果.*访问许可.*剩余任务/)
    expect(screen.getByRole('alert')).not.toHaveTextContent(/未开始|未执行|已失效|已过期|自动|重发|重试/)
    expect(store.sessions.get(WORKSPACE.workspaceId)!.transcriptRevision).toBe(boundary === 'cancel' ? 2 : 1)
    expect(harness.api.startAiConversation).toHaveBeenCalledTimes(2)
    expect(view.result.current.timeline).toContainEqual({ kind: 'budget-pause', record })
    view.unmount()
  })
  it('reserves a receipt through local stop and acknowledges late successful admission without resurrecting it', async () => {
    const { harness, ids, view, input, store } = await started()
    act(() => harness.emit(pause(input.requestId, ids())))
    const gate = deferred<Awaited<ReturnType<ConversationApi['startAiConversation']>>>()
    vi.mocked(harness.api.startAiConversation).mockReturnValueOnce(gate.promise)
    let continuing!: Promise<boolean>
    act(() => { continuing = view.result.current.continueAnalysis(input.requestId) })
    const continuation = vi.mocked(harness.api.startAiConversation).mock.lastCall![0]
    await act(async () => { await view.result.current.stopConversation() })
    expect(view.result.current.continueRequestId).toBeNull()
    await act(async () => { expect(await view.result.current.continueAnalysis(input.requestId)).toBe(false) })
    expect(harness.api.startAiConversation).toHaveBeenCalledTimes(2)
    const generation = store.sessions.get(WORKSPACE.workspaceId)!.sendGeneration
    await act(async () => { expect(await view.result.current.sendMessage('new instruction before receipt')).toBe(false) })
    expect(harness.api.startAiConversation).toHaveBeenCalledTimes(2)
    expect(store.sessions.get(WORKSPACE.workspaceId)!.sendGeneration).toBe(generation)
    expect(view.result.current.messages.map(message => message.content)).toEqual(['review workspace', '继续分析'])
    await act(async () => { gate.resolve(success({ requestId: continuation.requestId, modelId: 'model-a', transcriptRevision: 2 })); expect(await continuing).toBe(false) })
    expect(store.sessions.get(WORKSPACE.workspaceId)!.transcriptRevision).toBe(2)
    expect(view.result.current.continueRequestId).toBeNull()
    expect(view.result.current.messages.map(message => message.content)).toEqual(['review workspace', '继续分析'])
    vi.mocked(harness.api.startAiConversation).mockImplementation(async next => success({ requestId: next.requestId, modelId: 'model-a', transcriptRevision: next.acknowledgedTranscriptRevision + 1 }))
    await act(async () => { await view.result.current.sendMessage('new instruction') })
    expect(vi.mocked(harness.api.startAiConversation).mock.lastCall![0].acknowledgedTranscriptRevision).toBe(2)
    view.unmount()
  })
})

describe('useAiConversation workspace protocol', () => {
  it('retains semantic failure evidence and shows the classified cause instead of the legacy protocol label', async () => {
    const harness = createHarness(), ids = createIds(), store = createWorkspaceAiSessionStore(ids)
    const view = renderHook(() => useAiConversation({ api: harness.api, store, workspace: WORKSPACE, createId: ids }))
    await act(async () => { await view.result.current.sendMessage('question') })
    const { requestId } = vi.mocked(harness.api.startAiConversation).mock.lastCall![0]
    const userMessageId = view.result.current.messages[0]!.id
    const detail = { version: 1 as const, reason: 'service-unavailable' as const, stage: 'provider' as const, source: 'http' as const, httpStatus: 503 }
    act(() => {
      harness.emit({ requestId, type: 'started', transcriptRevision: 1 })
      harness.emit({ requestId, type: 'user-message-accepted', messageId: userMessageId, transcriptRevision: 1 })
      harness.emit({ requestId, type: 'failed', code: 'MODEL_INCOMPATIBLE_RESPONSE', message: '大模型服务返回的响应格式不兼容', detail })
    })
    expect(view.result.current.status).toBe('error')
    expect(view.result.current.error).toContain('暂时不可用')
    expect(view.result.current.error).not.toContain('格式不兼容')
    expect(view.result.current.failure).toEqual({ code: 'MODEL_INCOMPATIBLE_RESPONSE', detail })
    await act(async () => { await view.result.current.clearConversation() })
    expect(view.result.current.failure).toBeNull()
    view.unmount()
  })
  it.each(['failed', 'completed', 'switch'] as const)('retains bounded process evidence after %s and rejects stale rounds', async ending => {
    const harness = createHarness(), ids = createIds(), store = createWorkspaceAiSessionStore(ids)
    const view = renderHook(({ workspace }) => useAiConversation({ api: harness.api, store, workspace, createId: ids }), { initialProps: { workspace: WORKSPACE } })
    await act(async () => { await view.result.current.sendMessage('question') })
    const { requestId } = vi.mocked(harness.api.startAiConversation).mock.lastCall![0]
    const userMessageId = view.result.current.messages[0]!.id
    const messageId = ids(), secondId = ids(), itemId = ids()
    const process = (sequence: number, delta: string, round = 1, ownerMessage = messageId) => ({ requestId,
      messageId: ownerMessage, type: 'process-text' as const, round, sequence, kind: 'reasoning-summary' as const,
      itemId, segmentIndex: 0, delta, delivery: 'stream' as const })
    act(() => {
      harness.emit({ requestId, type: 'started', transcriptRevision: 1 })
      harness.emit({ requestId, type: 'user-message-accepted', messageId: userMessageId, transcriptRevision: 1 })
      harness.emit({ requestId, type: 'message-start', messageId, previousTranscriptRevision: 1 })
      harness.emit(process(1, 'first'))
      harness.emit(process(1, 'duplicate'))
      harness.emit({ requestId, type: 'message-completed', messageId, transcriptRevision: 2 })
      harness.emit(process(2, 'too late'))
      harness.emit({ requestId, type: 'message-start', messageId: secondId, previousTranscriptRevision: 2 })
      harness.emit(process(3, 'old round'))
      harness.emit(process(4, 'second', 2, secondId))
    })
    const original = store.sessions.get(WORKSPACE.workspaceId)!
    const record = original.processes.get(requestId)!
    expect(record.entries.filter(entry => entry.type === 'text').map(entry => entry.text)).toEqual(['first', 'second'])
    expect(original.timeline.filter(entry => entry.kind === 'process')).toHaveLength(1)
    record.userExpanded = true
    if (ending === 'switch') view.rerender({ workspace: { workspaceId: 'other', workspaceGeneration: 'other' } })
    else act(() => {
      if (ending === 'completed') {
        harness.emit({ requestId, type: 'message-completed', messageId: secondId, transcriptRevision: 3 })
        harness.emit({ requestId, type: 'completed' })
      } else harness.emit({ requestId, type: 'failed', code: 'OPERATION_FAILED', message: '操作未能完成。' })
    })
    act(() => harness.emit(process(5, 'late', 2, secondId)))
    expect(record.outcome).toBe(ending === 'switch' ? 'stopped' : ending)
    expect(record.userExpanded).toBe(true)
    expect(record.entries.filter(entry => entry.type === 'text').map(entry => entry.text)).toEqual(['first', 'second'])
    view.unmount()
  })
  it('rejects a programmatic send before rules are ready without changing the transcript or queuing it', async () => {
    let resolve!: (value: { ok: true; value: { rules: null; bundledRevision: string; warning: null } }) => void
    const session = startModelRulesInitialization({ getModelCapabilityRules: () => new Promise(done => { resolve = done }) })
    const harness = createHarness()
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const view = renderHook(() => useAiConversation({ api: harness.api, workspace: WORKSPACE, store, createId: ids }))
    try {
      await act(async () => { expect(await view.result.current.sendMessage('pending action')).toBe(false) })
      expect(view.result.current.messages).toEqual([])
      expect(harness.api.startAiConversation).not.toHaveBeenCalled()
      await act(async () => { resolve({ ok: true, value: { rules: null, bundledRevision: '2026-09-12', warning: null } }); await session.ready })
      expect(harness.api.startAiConversation).not.toHaveBeenCalled()
      await act(async () => { expect(await view.result.current.sendMessage('fresh action')).toBe(true) })
      expect(view.result.current.messages.map(message => message.content)).toEqual(['fresh action'])
    } finally { session.dispose() }
  })
  it.each(['revision', 'request', 'generation', 'payload', 'success'] as const)(
    'rejects a %s mismatch in the failed-start compaction queue without relaxing the message protocol',
    async (mismatch) => {
      const harness = createHarness()
      const gate = deferred<Awaited<ReturnType<ConversationApi['startAiConversation']>>>()
      vi.mocked(harness.api.startAiConversation).mockImplementation(() => gate.promise)
      const ids = createIds()
      const store = createWorkspaceAiSessionStore(ids)
      const view = renderHook(({ workspace }) => useAiConversation({
        api: harness.api, workspace, store, createId: ids,
      }), { initialProps: { workspace: WORKSPACE } })
      let sending!: Promise<boolean>
      act(() => { sending = view.result.current.sendMessage('pending') })
      const input = vi.mocked(harness.api.startAiConversation).mock.lastCall![0]
      const record = {
        requestId: mismatch === 'request' ? ids() : input.requestId,
        type: 'context-compaction',
        transcriptRevision: mismatch === 'revision' ? 1 : 0,
        status: mismatch === 'success' ? 'compacted' : 'failed',
        ...(mismatch === 'success'
          ? { beforeTokens: 78_000, afterTokens: 46_000, contextWindowTokens: 100_000 } : {}),
        ...(mismatch === 'payload' ? { message: 'forged' } : {}),
      }
      act(() => { harness.emit(record as AiConversationEvent) })
      if (mismatch === 'generation') view.rerender({ workspace: { ...WORKSPACE, workspaceGeneration: 'new-generation' } })
      await act(async () => {
        gate.resolve({ ok: false, error: { code: 'OPERATION_FAILED', message: 'failed' } })
        expect(await sending).toBe(false)
      })
      expect(view.result.current.timeline.filter((entry) => entry.kind === 'context-compaction')).toEqual([])
      expect(view.result.current.messages).toEqual([]) // Rejected starts remain in the editable draft, not the transcript.
    },
  )

  it('submits one natural user message against the stable workspace session', async () => {
    const harness = createHarness()
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace: WORKSPACE,
      writePolicy: 'document-grant',
    }))

    await act(async () => { await result.current.sendMessage('自然对话') })

    expect(harness.api.startAiConversation).toHaveBeenCalledWith({
      requestId: expect.any(String),
      conversationId: expect.any(String),
      workspaceKey: 'workspace-a',
      acknowledgedTranscriptRevision: 0,
      messages: [{ id: expect.any(String), role: 'user', content: '自然对话' }],
      capabilities: { currentDocument: true, workspace: true },
      writePolicy: 'document-grant',
    })
    expect(result.current.messages.map(({ content }) => content)).toEqual(['自然对话'])
    expect(result.current.capabilities).toEqual({ currentDocument: true, workspace: true })
  })

  it('keeps the conversation across remounts and a new workspace generation', async () => {
    const harness = createHarness()
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const first = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace: WORKSPACE,
    }))
    await act(async () => { await first.result.current.sendMessage('first') })
    const conversationId = vi.mocked(harness.api.startAiConversation).mock.lastCall?.[0].conversationId
    first.unmount()

    const second = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace: { ...WORKSPACE, workspaceGeneration: 'generation-2' },
    }))
    expect(second.result.current.messages.map(({ content }) => content)).toEqual(['first'])
    expect(second.result.current.capabilities).toEqual({ currentDocument: true, workspace: true })
    expect(store.sessions.get(WORKSPACE.workspaceId)!.authoritativeCapabilities).toEqual({ currentDocument: false, workspace: false })

    await act(async () => { await second.result.current.sendMessage('second') })
    expect(vi.mocked(harness.api.startAiConversation).mock.lastCall?.[0]).toMatchObject({
      conversationId,
      workspaceKey: 'workspace-a',
      acknowledgedTranscriptRevision: 1,
      messages: [{ role: 'user', content: 'second' }],
    })
  })

  it('keeps the explicit document command one-shot and leaves the next ordinary turn disabled', async () => {
    const harness = createHarness()
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace: WORKSPACE,
    }))

    await act(async () => { await result.current.setCurrentDocumentAccess(false) })
    await act(async () => { await result.current.setWorkspaceAccess(true) })
    expect(result.current.capabilities).toEqual({ currentDocument: false, workspace: true })
    expect(harness.api.startAiConversation).not.toHaveBeenCalled()

    await act(async () => { await result.current.sendMessage('/document 总结') })
    expect(vi.mocked(harness.api.startAiConversation).mock.lastCall?.[0]).toMatchObject({
      capabilities: { currentDocument: false, workspace: true },
      currentDocumentOnce: true,
      messages: [{ role: 'user', content: '总结' }],
    })
    expect(result.current.capabilities).toEqual({ currentDocument: false, workspace: true })

    await act(async () => { await result.current.stopConversation() })
    await act(async () => { await result.current.sendMessage('下一轮') })
    expect(vi.mocked(harness.api.startAiConversation).mock.lastCall?.[0]).toMatchObject({
      capabilities: { currentDocument: false, workspace: true },
      messages: [{ role: 'user', content: '下一轮' }],
    })
    expect(vi.mocked(harness.api.startAiConversation).mock.lastCall?.[0])
      .not.toHaveProperty('currentDocumentOnce')
  })

  it('retains an explicit document denial when IPC fails and cancels the active request instead of restoring the on preference', async () => {
    const harness = createHarness()
    const store = createWorkspaceAiSessionStore(createIds())
    const view = renderHook(() => useAiConversation({ api: harness.api, store, workspace: WORKSPACE }))
    await act(async () => { await view.result.current.sendMessage('active read') })
    const requestId = vi.mocked(harness.api.startAiConversation).mock.lastCall![0].requestId
    vi.mocked(harness.api.setAiConversationCapabilities).mockResolvedValueOnce({ ok: false,
      error: { code: 'OPERATION_FAILED', message: 'permission update failed' } })
    await act(async () => { expect(await view.result.current.setCurrentDocumentAccess(false)).toBe(false) })
    view.rerender()
    expect(view.result.current.capabilities.currentDocument).toBe(false)
    expect(view.result.current.error).toBe('permission update failed')
    expect(harness.api.cancelAiConversation).toHaveBeenCalledWith({ requestId })
  })

  it('reconciles a capability disabled while the first start is pending', async () => {
    const harness = createHarness()
    const pendingStart = deferred<Awaited<ReturnType<ConversationApi['startAiConversation']>>>()
    vi.mocked(harness.api.startAiConversation).mockReturnValue(pendingStart.promise)
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace: WORKSPACE,
    }))
    await act(async () => { expect(await result.current.setWorkspaceAccess(false)).toBe(true) })
    await act(async () => { expect(await result.current.setCurrentDocumentAccess(true)).toBe(true) })

    let sending!: Promise<boolean>
    act(() => { sending = result.current.sendMessage('pending first turn') })
    await waitFor(() => expect(harness.api.startAiConversation).toHaveBeenCalledOnce())
    const start = vi.mocked(harness.api.startAiConversation).mock.lastCall![0]
    await act(async () => { expect(await result.current.setCurrentDocumentAccess(false)).toBe(true) })
    expect(harness.api.setAiConversationCapabilities).not.toHaveBeenCalled()
    expect(harness.api.cancelAiConversation).toHaveBeenCalledWith({ requestId: start.requestId })

    pendingStart.resolve(success({
      requestId: start.requestId, modelId: 'model-a', transcriptRevision: 1,
    }))
    await act(async () => { expect(await sending).toBe(true) })

    expect(harness.api.setAiConversationCapabilities).toHaveBeenCalledWith({
      workspaceId: WORKSPACE.workspaceId,
      workspaceGeneration: WORKSPACE.workspaceGeneration,
      conversationId: start.conversationId,
      capabilities: { currentDocument: false, workspace: false },
    })
  })

  it('serializes read-capability changes so an older IPC reply cannot overwrite the latest intent', async () => {
    const harness = createHarness()
    const first = deferred<Awaited<ReturnType<ConversationApi['setAiConversationCapabilities']>>>()
    const second = deferred<Awaited<ReturnType<ConversationApi['setAiConversationCapabilities']>>>()
    vi.mocked(harness.api.setAiConversationCapabilities)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace: WORKSPACE,
    }))
    await act(async () => {
      await result.current.setCurrentDocumentAccess(false)
      await result.current.setWorkspaceAccess(false)
    })
    store.sessions.get(WORKSPACE.workspaceId)!.transcriptRevision = 1

    let documentChange!: Promise<boolean>
    let workspaceChange!: Promise<boolean>
    act(() => {
      documentChange = result.current.setCurrentDocumentAccess(true)
      workspaceChange = result.current.setWorkspaceAccess(true)
    })

    expect(result.current.capabilities).toEqual({ currentDocument: true, workspace: true })
    await waitFor(() => expect(harness.api.setAiConversationCapabilities).toHaveBeenCalledOnce())
    expect(vi.mocked(harness.api.setAiConversationCapabilities).mock.calls[0]![0].capabilities)
      .toEqual({ currentDocument: true, workspace: false })

    first.resolve({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: 'older intent failed' },
    })
    await waitFor(() => expect(harness.api.setAiConversationCapabilities).toHaveBeenCalledTimes(2))
    expect(result.current.capabilities).toEqual({ currentDocument: true, workspace: true })
    expect(vi.mocked(harness.api.setAiConversationCapabilities).mock.calls[1]![0].capabilities)
      .toEqual({ currentDocument: true, workspace: true })

    second.resolve(success(null))
    await act(async () => {
      expect(await documentChange).toBe(false)
      expect(await workspaceChange).toBe(true)
    })
    expect(result.current.capabilities).toEqual({ currentDocument: true, workspace: true })
  })

  it('includes queued permission synchronization in the total request time', async () => {
    const harness = createHarness()
    const gate = deferred<Awaited<ReturnType<ConversationApi['setAiConversationCapabilities']>>>()
    vi.mocked(harness.api.setAiConversationCapabilities).mockReturnValueOnce(gate.promise)
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    const view = renderHook(() => useAiConversation({ api: harness.api, store, createId: ids, workspace: WORKSPACE }))
    try {
      store.sessions.get(WORKSPACE.workspaceId)!.transcriptRevision = 1
      let permission!: Promise<boolean>
      let sending!: Promise<boolean>
      act(() => { permission = view.result.current.setWorkspaceAccess(false) })
      await waitFor(() => expect(harness.api.setAiConversationCapabilities).toHaveBeenCalledOnce())
      act(() => { sending = view.result.current.sendMessage('wait for permission synchronization') })
      expect(harness.api.startAiConversation).not.toHaveBeenCalled()
      clock.mockReturnValue(6000)
      await act(async () => { gate.resolve(success(null)); await permission; await sending })
      expect(view.result.current.timeline.find(entry => entry.kind === 'elapsed')).toMatchObject({
        observedAt: 1000, active: true,
      })
      await act(async () => { await view.result.current.stopConversation() })
      expect(view.result.current.timeline.find(entry => entry.kind === 'elapsed')).toMatchObject({
        elapsedMs: 5000, active: false,
      })
    } finally { view.unmount(); clock.mockRestore() }
  })

  it('reconciles consecutive failed capability intents to the last confirmed authority', async () => {
    const harness = createHarness()
    const first = deferred<Awaited<ReturnType<ConversationApi['setAiConversationCapabilities']>>>()
    const second = deferred<Awaited<ReturnType<ConversationApi['setAiConversationCapabilities']>>>()
    vi.mocked(harness.api.setAiConversationCapabilities)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace: WORKSPACE,
    }))
    await act(async () => {
      await result.current.setCurrentDocumentAccess(false)
      await result.current.setWorkspaceAccess(false)
    })
    store.sessions.get(WORKSPACE.workspaceId)!.transcriptRevision = 1

    let documentChange!: Promise<boolean>
    let workspaceChange!: Promise<boolean>
    act(() => {
      documentChange = result.current.setCurrentDocumentAccess(true)
      workspaceChange = result.current.setWorkspaceAccess(true)
    })

    first.resolve({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: 'document intent failed' },
    })
    await waitFor(() => expect(harness.api.setAiConversationCapabilities).toHaveBeenCalledTimes(2))
    second.resolve({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: 'workspace intent failed' },
    })
    await act(async () => {
      expect(await documentChange).toBe(false)
      expect(await workspaceChange).toBe(false)
    })

    expect(result.current.capabilities).toEqual({ currentDocument: false, workspace: false })
  })

  it('keeps an earlier confirmed capability when the following intent fails', async () => {
    const harness = createHarness()
    const first = deferred<Awaited<ReturnType<ConversationApi['setAiConversationCapabilities']>>>()
    const second = deferred<Awaited<ReturnType<ConversationApi['setAiConversationCapabilities']>>>()
    vi.mocked(harness.api.setAiConversationCapabilities)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace: WORKSPACE,
    }))
    await act(async () => {
      await result.current.setCurrentDocumentAccess(false)
      await result.current.setWorkspaceAccess(false)
    })
    store.sessions.get(WORKSPACE.workspaceId)!.transcriptRevision = 1

    let documentChange!: Promise<boolean>
    let workspaceChange!: Promise<boolean>
    act(() => {
      documentChange = result.current.setCurrentDocumentAccess(true)
      workspaceChange = result.current.setWorkspaceAccess(true)
    })

    first.resolve(success(null))
    await waitFor(() => expect(harness.api.setAiConversationCapabilities).toHaveBeenCalledTimes(2))
    second.resolve({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: 'workspace intent failed' },
    })
    await act(async () => {
      expect(await documentChange).toBe(true)
      expect(await workspaceChange).toBe(false)
    })

    expect(result.current.capabilities).toEqual({ currentDocument: true, workspace: false })
  })

  it('revokes model-bound authority and usage when the configured AI profile changes', async () => {
    const harness = createHarness()
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const view = renderHook(({ profileFingerprint }) => useAiConversation({
      api: harness.api,
      contextWindowTokens: 128_000,
      createId: ids,
      profileFingerprint,
      store,
      workspace: WORKSPACE,
    }), { initialProps: { profileFingerprint: 'connection-a|deepseek|https://a.example|model-a' } })
    const session = store.sessions.get(WORKSPACE.workspaceId)!
    session.messages = [
      { id: 'user-complete', role: 'user', content: 'keep this transcript' },
      { id: 'assistant-complete', role: 'assistant', content: 'kept answer' },
      { id: 'assistant-pending', role: 'assistant', content: 'partial answer' },
    ]
    session.capabilities = { currentDocument: true, workspace: true }
    session.usage = {
      inputTokens: 20, outputTokens: 5, totalTokens: 25,
      cachedInputTokens: null, estimated: false,
    }
    session.pendingAuthorization = {
      requestId: 'request-pending', operationId: 'operation-pending',
      toolName: 'edit_workspace_document', scope: 'workspace', paths: ['note.md'],
      allowed: null,
    }
    session.authorizationRecords = [session.pendingAuthorization]
    session.timeline = [
      { kind: 'message', messageId: 'user-complete' },
      { kind: 'message', messageId: 'assistant-complete' },
      { kind: 'message', messageId: 'assistant-pending' },
      { kind: 'authorization', operationId: 'operation-pending' },
    ]
    session.activeRequest = {
      requestId: 'request-pending', assistantMessageId: 'assistant-pending',
      invalidated: false, startPending: false, terminal: false,
      protocol: {
        phase: 'streaming', startMode: null, userMessageId: 'user-complete', queuedEvents: [],
      },
    }

    view.rerender({
      profileFingerprint: 'connection-b|qwen|https://b.example|model-b',
    })

    expect(view.result.current.messages.map(({ id }) => id))
      .toEqual(['user-complete', 'assistant-complete'])
    expect(view.result.current.capabilities).toEqual({ currentDocument: true, workspace: true })
    expect(store.sessions.get(WORKSPACE.workspaceId)!.authoritativeCapabilities).toEqual({ currentDocument: false, workspace: false })
    expect(view.result.current.pendingAuthorization).toBeNull()
    expect(view.result.current.authorizationRecords).toEqual([])
    expect(view.result.current.timeline).toEqual([
      { kind: 'message', messageId: 'user-complete' },
      { kind: 'message', messageId: 'assistant-complete' },
      { kind: 'incomplete-message', message: { id: 'assistant-pending', role: 'assistant', content: 'partial answer' }, outcome: 'stopped' },
    ])
    expect(view.result.current.contextUsage).toBeNull()
    expect(session.activeRequest).toBeNull()
    await waitFor(() => expect(harness.api.cancelAiConversation)
      .toHaveBeenCalledWith({ requestId: 'request-pending' }))
  })

  it('queues a profile revocation behind an older capability request so the revocation wins', async () => {
    const harness = createHarness()
    const olderCapability = deferred<Awaited<ReturnType<ConversationApi['setAiConversationCapabilities']>>>()
    vi.mocked(harness.api.setAiConversationCapabilities)
      .mockReturnValueOnce(olderCapability.promise)
      .mockResolvedValue(success(null))
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const view = renderHook(({ profileFingerprint }) => useAiConversation({
      api: harness.api,
      createId: ids,
      profileFingerprint,
      store,
      workspace: WORKSPACE,
    }), { initialProps: { profileFingerprint: 'profile-a' } })
    store.sessions.get(WORKSPACE.workspaceId)!.transcriptRevision = 1

    let olderIntent!: Promise<boolean>
    act(() => { olderIntent = view.result.current.setCurrentDocumentAccess(true) })
    await waitFor(() => expect(harness.api.setAiConversationCapabilities).toHaveBeenCalledOnce())
    view.rerender({ profileFingerprint: 'profile-b' })
    await Promise.resolve()

    expect(harness.api.setAiConversationCapabilities).toHaveBeenCalledOnce()
    expect(view.result.current.capabilities).toEqual({ currentDocument: true, workspace: true })
    expect(store.sessions.get(WORKSPACE.workspaceId)!.authoritativeCapabilities).toEqual({ currentDocument: false, workspace: false })

    olderCapability.resolve(success(null))
    await act(async () => { expect(await olderIntent).toBe(false) })
    await waitFor(() => expect(harness.api.setAiConversationCapabilities).toHaveBeenCalledTimes(2))
    expect(vi.mocked(harness.api.setAiConversationCapabilities).mock.calls[1]![0].capabilities)
      .toEqual({ currentDocument: false, workspace: false })
  })

  it('syncs revoked capabilities while the first start handshake still has revision zero', async () => {
    const harness = createHarness()
    const pendingStart = deferred<Awaited<ReturnType<ConversationApi['startAiConversation']>>>()
    vi.mocked(harness.api.startAiConversation).mockReturnValueOnce(pendingStart.promise)
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const view = renderHook(({ profileFingerprint }) => useAiConversation({
      api: harness.api,
      createId: ids,
      profileFingerprint,
      store,
      workspace: WORKSPACE,
    }), { initialProps: { profileFingerprint: 'profile-a|reasoning-off' } })
    await act(async () => {
      expect(await view.result.current.setCurrentDocumentAccess(true)).toBe(true)
      expect(await view.result.current.setWorkspaceAccess(true)).toBe(true)
    })

    let sending!: Promise<boolean>
    act(() => { sending = view.result.current.sendMessage('first request') })
    await waitFor(() => expect(harness.api.startAiConversation).toHaveBeenCalledOnce())
    const startInput = vi.mocked(harness.api.startAiConversation).mock.lastCall![0]
    expect(startInput.capabilities).toEqual({ currentDocument: true, workspace: true })
    expect(store.sessions.get(WORKSPACE.workspaceId)!.transcriptRevision).toBe(0)

    view.rerender({ profileFingerprint: 'profile-a|reasoning-high' })

    await waitFor(() => expect(harness.api.setAiConversationCapabilities).toHaveBeenCalledWith({
      workspaceId: WORKSPACE.workspaceId,
      workspaceGeneration: WORKSPACE.workspaceGeneration,
      conversationId: startInput.conversationId,
      capabilities: { currentDocument: false, workspace: false },
    }))
    expect(view.result.current.capabilities).toEqual({ currentDocument: true, workspace: true })
    expect(store.sessions.get(WORKSPACE.workspaceId)!.authoritativeCapabilities).toEqual({ currentDocument: false, workspace: false })
    pendingStart.resolve(success({
      requestId: startInput.requestId, modelId: 'model-a', transcriptRevision: 0,
    }))
    await act(async () => { expect(await sending).toBe(false) })
  })

  it('tracks assistant messages, authorization decisions, audit paths, and context usage', async () => {
    const harness = createHarness()
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      contextWindowTokens: 128_000,
      createId: ids,
      store,
      workspace: WORKSPACE,
    }))
    await act(async () => { await result.current.sendMessage('edit') })
    const requestId = vi.mocked(harness.api.startAiConversation).mock.lastCall?.[0].requestId!
    const userMessageId = store.sessions.get(WORKSPACE.workspaceId)!.messages[0]!.id

    act(() => {
      harness.emit({ requestId, type: 'started', transcriptRevision: 1 })
      harness.emit({
        requestId, type: 'user-message-accepted',
        messageId: userMessageId, transcriptRevision: 1,
      })
      harness.emit({
        requestId,
        type: 'message-start',
        messageId: 'assistant-1',
        previousTranscriptRevision: 1,
      })
      harness.emit({ requestId, type: 'delta', messageId: 'assistant-1', delta: 'done' })
      harness.emit({
        requestId,
        type: 'usage',
        usage: {
          inputTokens: 23_000,
          outputTokens: 410,
          totalTokens: 23_410,
          cachedInputTokens: null,
          estimated: false,
        },
      })
      harness.emit({
        requestId,
        type: 'message-completed',
        messageId: 'assistant-1',
        transcriptRevision: 2,
      })
      harness.emit({
        requestId,
        type: 'authorization-requested',
        toolCallId: 'tool-1',
        toolName: 'edit_workspace_document',
        operationId: 'operation-1',
        scope: 'workspace',
        paths: ['note.md'],
      })
    })
    expect(result.current.pendingAuthorization?.operationId).toBe('operation-1')

    await act(async () => { await result.current.answerAuthorization(true) })
    expect(harness.api.submitAiAuthorizationResult).toHaveBeenCalledWith({
      requestId,
      operationId: 'operation-1',
      allowed: true,
    })

    act(() => {
      harness.emit({
        requestId,
        type: 'authorization-result',
        toolName: 'edit_workspace_document',
        operationId: 'operation-1',
        scope: 'workspace',
        allowed: true,
      })
      harness.emit({
        requestId,
        type: 'audit',
        action: 'authorization-allowed',
        absolutePaths: [],
      })
      harness.emit({
        requestId,
        type: 'audit',
        action: 'edited',
        absolutePaths: ['C:\\workspace\\note.md'],
      })
      harness.emit({ requestId, type: 'completed' })
    })

    expect(result.current.messages.map(({ content }) => content)).toEqual(['edit', 'done'])
    expect(result.current.authorizationRecords).toEqual([
      expect.objectContaining({ operationId: 'operation-1', allowed: true }),
    ])
    expect(result.current.auditRecords).toEqual([
      expect.objectContaining({ action: 'edited', absolutePaths: ['C:\\workspace\\note.md'] }),
    ])
    expect(result.current.timeline).toEqual([
      { kind: 'message', messageId: userMessageId },
      expect.objectContaining({ kind: 'elapsed', requestId, active: false, messageIds: ['assistant-1'] }),
      { kind: 'message', messageId: 'assistant-1' },
      { kind: 'authorization', operationId: 'operation-1' },
      { kind: 'audit', auditId: result.current.auditRecords[0]!.id },
    ])
    expect(result.current.contextUsage).toEqual({
      usedTokens: 23_410,
      contextWindowTokens: 128_000,
      estimated: false,
    })
  })

  it.each(['unknown capacity', 'same-capacity model switch'] as const)('restores truthful usage after %s', async (scenario) => {
    const harness = createHarness()
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const { result, rerender } = renderHook(({ capacity, profile }: { capacity: number | null; profile: string }) => useAiConversation({
      api: harness.api, createId: ids, store, workspace: WORKSPACE, contextWindowTokens: capacity, profileFingerprint: profile,
    }), { initialProps: { capacity: scenario === 'unknown capacity' ? null : 128_000, profile: 'model-a' } })
    if (scenario === 'same-capacity model switch') {
      rerender({ capacity: 128_000, profile: 'model-b' })
      await act(async () => {})
    }
    await act(async () => { await result.current.sendMessage('hello') })
    const requestId = vi.mocked(harness.api.startAiConversation).mock.lastCall![0].requestId
    const userMessageId = store.sessions.get(WORKSPACE.workspaceId)!.messages[0]!.id
    act(() => {
      harness.emit({ requestId, type: 'started', transcriptRevision: 1 })
      harness.emit({ requestId, type: 'user-message-accepted', messageId: userMessageId, transcriptRevision: 1 })
      harness.emit({ requestId, type: 'message-start', messageId: 'assistant-usage', previousTranscriptRevision: 1 })
      harness.emit({ requestId, type: 'usage', usage: {
        inputTokens: 200, outputTokens: 30, totalTokens: 230, cachedInputTokens: null, estimated: true,
      } })
    })
    expect(result.current.contextUsage).toEqual({
      usedTokens: 230, contextWindowTokens: scenario === 'unknown capacity' ? null : 128_000, estimated: true,
    })
    rerender({ capacity: 128_000, profile: scenario === 'unknown capacity' ? 'model-a' : 'model-b' })
    expect(result.current.contextUsage).toEqual({ usedTokens: 230, contextWindowTokens: 128_000, estimated: true })
  })

  it('projects the active assistant id without discarding completed tool-only messages', async () => {
    const harness = createHarness()
    const ids = createIds()
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      workspace: WORKSPACE,
    }))
    expect(result.current.activeAssistantMessageId).toBeNull()
    await act(async () => { await result.current.sendMessage('read current document') })
    const requestId = vi.mocked(harness.api.startAiConversation).mock.lastCall![0].requestId
    const userMessageId = result.current.messages[0]!.id
    act(() => {
      harness.emit({ requestId, type: 'started', transcriptRevision: 1 })
      harness.emit({
        requestId, type: 'user-message-accepted', messageId: userMessageId, transcriptRevision: 1,
      })
      harness.emit({
        requestId, type: 'message-start', messageId: 'assistant-tool', previousTranscriptRevision: 1,
      })
    })
    expect(result.current.activeAssistantMessageId).toBe('assistant-tool')

    act(() => {
      harness.emit({
        requestId, type: 'message-completed', messageId: 'assistant-tool', transcriptRevision: 2,
      })
    })
    expect(result.current.activeAssistantMessageId).toBeNull()
    expect(result.current.status).toBe('streaming')
    expect(result.current.messages.at(-1)).toEqual({
      id: 'assistant-tool', role: 'assistant', content: '',
    })

    act(() => {
      harness.emit({
        requestId, type: 'message-start', messageId: 'assistant-answer', previousTranscriptRevision: 2,
      })
    })
    expect(result.current.activeAssistantMessageId).toBe('assistant-answer')
    act(() => {
      harness.emit({ requestId, type: 'delta', messageId: 'assistant-answer', delta: 'read complete' })
      harness.emit({
        requestId, type: 'message-completed', messageId: 'assistant-answer', transcriptRevision: 3,
      })
      harness.emit({ requestId, type: 'completed' })
    })
    expect(result.current.activeAssistantMessageId).toBeNull()
    expect(result.current.status).toBe('idle')
    expect(result.current.messages.map(({ content }) => content))
      .toEqual(['read current document', '', 'read complete'])
  })

  it.each(['stopped', 'failed'] as const)(
    'retains incomplete output outside the acknowledged transcript when the request is %s',
    async (terminal) => {
      const harness = createHarness()
      const ids = createIds()
      const { result } = renderHook(() => useAiConversation({
        api: harness.api,
        createId: ids,
        workspace: WORKSPACE,
      }))
      await act(async () => { await result.current.sendMessage('two assistant messages') })
      const requestId = vi.mocked(harness.api.startAiConversation).mock.lastCall![0].requestId
      const userMessageId = result.current.messages[0]!.id
      act(() => {
        harness.emit({ requestId, type: 'started', transcriptRevision: 1 })
        harness.emit({
          requestId, type: 'user-message-accepted',
          messageId: userMessageId, transcriptRevision: 1,
        })
        harness.emit({
          requestId, type: 'message-start',
          messageId: 'assistant-completed', previousTranscriptRevision: 1,
        })
        harness.emit({
          requestId, type: 'delta', messageId: 'assistant-completed', delta: 'keep complete',
        })
        harness.emit({
          requestId, type: 'message-completed',
          messageId: 'assistant-completed', transcriptRevision: 2,
        })
        harness.emit({
          requestId, type: 'message-start',
          messageId: 'assistant-partial', previousTranscriptRevision: 2,
        })
        harness.emit({
          requestId, type: 'delta', messageId: 'assistant-partial', delta: 'useful partial',
        })
        harness.emit(terminal === 'failed'
          ? { requestId, type: 'failed', code: 'OPERATION_FAILED', message: 'failed turn' }
          : { requestId, type: 'stopped' })
      })

      expect(result.current.messages.map(({ content }) => content))
        .toEqual(['two assistant messages', 'keep complete'])
      expect(result.current.timeline).toEqual([
        { kind: 'message', messageId: userMessageId },
        expect.objectContaining({ kind: 'elapsed', requestId, active: false }),
        { kind: 'message', messageId: 'assistant-completed' },
        { kind: 'incomplete-message', message: { id: 'assistant-partial', role: 'assistant', content: 'useful partial' }, outcome: terminal },
      ])
      await act(async () => { await result.current.sendMessage('follow up') })
      expect(harness.api.startAiConversation).toHaveBeenLastCalledWith(expect.objectContaining({
        acknowledgedTranscriptRevision: 2, messages: [expect.objectContaining({ role: 'user', content: 'follow up' })],
      }))
      await act(async () => { await result.current.clearConversation() })
      expect(result.current.timeline).toEqual([])
      expect(result.current.messages).toEqual([])
    },
  )

  it('retains incomplete output separately when locally stopped', async () => {
    const harness = createHarness()
    const ids = createIds()
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      workspace: WORKSPACE,
    }))
    await act(async () => { await result.current.sendMessage('local stop') })
    const requestId = vi.mocked(harness.api.startAiConversation).mock.lastCall![0].requestId
    const userMessageId = result.current.messages[0]!.id
    act(() => {
      harness.emit({ requestId, type: 'started', transcriptRevision: 1 })
      harness.emit({
        requestId, type: 'user-message-accepted',
        messageId: userMessageId, transcriptRevision: 1,
      })
      harness.emit({
        requestId, type: 'message-start',
        messageId: 'assistant-partial', previousTranscriptRevision: 1,
      })
      harness.emit({ requestId, type: 'delta', messageId: 'assistant-partial', delta: 'partial' })
    })

    await act(async () => { await result.current.stopConversation() })

    expect(result.current.messages.map(({ content }) => content)).toEqual(['local stop'])
    expect(result.current.timeline).toEqual([
      { kind: 'message', messageId: userMessageId },
      expect.objectContaining({ kind: 'elapsed', requestId, active: false }),
      { kind: 'incomplete-message', message: { id: 'assistant-partial', role: 'assistant', content: 'partial' }, outcome: 'stopped' },
    ])
  })

  it('ignores a duplicate authorization request for an operation already in the timeline', async () => {
    const harness = createHarness()
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace: WORKSPACE,
    }))
    await act(async () => { await result.current.sendMessage('authorize once') })
    const requestId = vi.mocked(harness.api.startAiConversation).mock.lastCall![0].requestId
    const userMessageId = result.current.messages[0]!.id
    const request = {
      requestId,
      type: 'authorization-requested' as const,
      toolCallId: 'tool-once',
      toolName: 'edit_workspace_document' as const,
      operationId: 'operation-once',
      scope: 'workspace' as const,
      paths: ['note.md'],
    }

    act(() => {
      harness.emit({ requestId, type: 'started', transcriptRevision: 1 })
      harness.emit({
        requestId, type: 'user-message-accepted',
        messageId: userMessageId, transcriptRevision: 1,
      })
      harness.emit({
        requestId, type: 'message-start',
        messageId: 'assistant-once', previousTranscriptRevision: 1,
      })
      harness.emit({
        requestId, type: 'message-completed',
        messageId: 'assistant-once', transcriptRevision: 2,
      })
      harness.emit(request)
      harness.emit({
        requestId,
        type: 'authorization-result',
        toolName: request.toolName,
        operationId: request.operationId,
        scope: request.scope,
        allowed: true,
      })
      harness.emit(request)
    })

    expect(result.current.pendingAuthorization).toBeNull()
    expect(result.current.authorizationRecords).toHaveLength(1)
    expect(result.current.authorizationRecords[0]).toMatchObject({
      operationId: 'operation-once', allowed: true,
    })
    expect(result.current.timeline.filter((entry) => (
      entry.kind === 'authorization' && entry.operationId === 'operation-once'
    ))).toHaveLength(1)
  })

  it('submits at most one in-flight authorization decision per operation', async () => {
    const harness = createHarness()
    const decision = deferred<Awaited<ReturnType<ConversationApi['submitAiAuthorizationResult']>>>()
    vi.mocked(harness.api.submitAiAuthorizationResult).mockReturnValue(decision.promise)
    const ids = createIds()
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      workspace: WORKSPACE,
    }))
    await act(async () => { await result.current.sendMessage('authorize once') })
    const requestId = vi.mocked(harness.api.startAiConversation).mock.lastCall![0].requestId
    const userMessageId = result.current.messages[0]!.id
    act(() => {
      harness.emit({ requestId, type: 'started', transcriptRevision: 1 })
      harness.emit({
        requestId, type: 'user-message-accepted',
        messageId: userMessageId, transcriptRevision: 1,
      })
      harness.emit({
        requestId, type: 'message-start',
        messageId: 'assistant-once', previousTranscriptRevision: 1,
      })
      harness.emit({
        requestId, type: 'message-completed',
        messageId: 'assistant-once', transcriptRevision: 2,
      })
      harness.emit({
        requestId,
        type: 'authorization-requested',
        toolCallId: 'tool-once',
        toolName: 'edit_workspace_document',
        operationId: 'operation-once',
        scope: 'workspace',
        paths: ['note.md'],
      })
    })

    let first!: Promise<boolean>
    let duplicate!: Promise<boolean>
    act(() => {
      first = result.current.answerAuthorization(true)
      duplicate = result.current.answerAuthorization(false)
    })
    expect(harness.api.submitAiAuthorizationResult).toHaveBeenCalledOnce()

    decision.resolve(success(null))
    await act(async () => {
      expect(await first).toBe(true)
      expect(await duplicate).toBe(false)
    })
    expect(result.current.pendingAuthorization).toMatchObject({
      operationId: 'operation-once', decisionPending: true,
    })
    await act(async () => {
      expect(await result.current.answerAuthorization(false)).toBe(false)
    })
    expect(harness.api.submitAiAuthorizationResult).toHaveBeenCalledOnce()

    act(() => harness.emit({
      requestId,
      type: 'authorization-result',
      toolName: 'edit_workspace_document',
      operationId: 'operation-once',
      scope: 'workspace',
      allowed: true,
    }))
    expect(result.current.pendingAuthorization).toBeNull()
  })

  it('re-enables a pending authorization and reports the real IPC error after submission fails', async () => {
    const harness = createHarness()
    vi.mocked(harness.api.submitAiAuthorizationResult).mockResolvedValue({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: '许可提交被主进程拒绝' },
    })
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace: WORKSPACE,
    }))
    const session = store.sessions.get(WORKSPACE.workspaceId)!
    session.pendingAuthorization = {
      requestId: 'request-error',
      operationId: 'operation-error',
      toolName: 'edit_workspace_document',
      scope: 'action',
      paths: ['note.md'],
      allowed: null,
      decisionPending: false,
    }

    await act(async () => {
      expect(await result.current.answerAuthorization(true)).toBe(false)
    })

    expect(result.current.pendingAuthorization).toMatchObject({
      operationId: 'operation-error', decisionPending: false,
    })
    expect(result.current.error).toBe('许可提交被主进程拒绝')
  })

  it.each([
    ['ask-every-time', 'ask-every-time'],
    ['document-grant', 'document-grant'],
    ['workspace-grant', 'workspace-grant'],
  ] as const)('retains the selected %s write policy', async (_label, policy: AiWritePolicy) => {
    const harness = createHarness()
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const original = modelObservation({ ...structuredClone(DEFAULT_LARGE_MODEL_SETTINGS), aiConversation: { ...harness.settings, connectionId: null } }, 4)
    harness.api.setAiConversationSettings = vi.fn(async (input) => success(modelCommit({ ...original.settings,
      aiConversation: { ...original.settings.aiConversation, ...input } }, 5)))
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace: WORKSPACE,
    }))

    await act(async () => { await result.current.setWritePolicy(policy, original) })

    expect(result.current.writePolicy).toBe(policy)
    expect(harness.api.setAiConversationSettings).toHaveBeenCalledWith({ writePolicy: policy }, original)
    expect(harness.api.getLargeModelSettings).not.toHaveBeenCalled()
  })

  it('clears only the active workspace session and rotates its conversation id', async () => {
    const harness = createHarness()
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace: WORKSPACE,
    }))
    await act(async () => { await result.current.sendMessage('clear me') })
    const firstConversationId = vi.mocked(harness.api.startAiConversation).mock.lastCall?.[0].conversationId!
    Object.assign(result.current.viewport!, { followLatest: false, anchorMessageId: 'old', anchorOffset: -25, scrollTop: 450 })
    const capabilitiesBeforeQuote = { ...result.current.capabilities }
    act(() => result.current.addQuote({ sourceId: 'source-A', documentName: 'A.md', revision: 1,
      range: { mode: 'source', from: 0, to: 3 }, content: 'text', plainText: 'text' }))
    expect(result.current.capabilities).toEqual(capabilitiesBeforeQuote)
    expect(result.current.draft?.quotes).toHaveLength(1)

    await act(async () => { await result.current.clearConversation() })

    expect(harness.api.clearAiConversation).toHaveBeenCalledWith({
      ...WORKSPACE,
      conversationId: firstConversationId,
    })
    expect(result.current.messages).toEqual([])
    expect(result.current.draft?.quotes).toEqual([])
    expect(result.current.draft?.text).toBe('')
    expect(result.current.viewport).toEqual({ followLatest: true, anchorMessageId: null, anchorOffset: 0, scrollTop: 0 })
    expect(result.current.capabilities).toEqual({ currentDocument: true, workspace: true })
    await act(async () => { await result.current.sendMessage('new') })
    expect(vi.mocked(harness.api.startAiConversation).mock.lastCall?.[0].conversationId)
      .not.toBe(firstConversationId)
    expect(vi.mocked(harness.api.startAiConversation).mock.lastCall?.[0].capabilities)
      .toEqual({ currentDocument: true, workspace: true })
  })

  it('does not keep an unaccepted optimistic message when a retained draft is retried', async () => {
    const harness = createHarness()
    vi.mocked(harness.api.startAiConversation).mockResolvedValue({ ok: false,
      error: { code: 'OPERATION_FAILED', message: 'not accepted' } })
    const { result } = renderHook(() => useAiConversation({ api: harness.api, createId: createIds(), workspace: WORKSPACE }))
    await act(async () => { expect(await result.current.sendMessage('retryable quote envelope')).toBe(false) })
    expect(result.current.messages).toEqual([])
    await act(async () => { expect(await result.current.sendMessage('retryable quote envelope')).toBe(false) })
    expect(result.current.messages).toEqual([])
    expect(result.current.error).toBe('操作未能完成')
    expect(result.current.failure).toEqual({ code: 'OPERATION_FAILED' })
  })

  it('invalidates a pending clear on generation change so the new generation can send and clear', async () => {
    const harness = createHarness()
    const firstClear = deferred<Awaited<ReturnType<ConversationApi['clearAiConversation']>>>()
    const secondClear = deferred<Awaited<ReturnType<ConversationApi['clearAiConversation']>>>()
    vi.mocked(harness.api.clearAiConversation)
      .mockReturnValueOnce(firstClear.promise)
      .mockReturnValueOnce(secondClear.promise)
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const view = renderHook(({ generation }) => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace: { ...WORKSPACE, workspaceGeneration: generation },
    }), { initialProps: { generation: 'generation-1' } })

    let staleClear!: Promise<void>
    act(() => { staleClear = view.result.current.clearConversation() })
    await waitFor(() => expect(harness.api.clearAiConversation).toHaveBeenCalledOnce())
    view.rerender({ generation: 'generation-2' })
    await act(async () => { expect(await view.result.current.sendMessage('new generation')).toBe(true) })
    let currentClear!: Promise<void>
    act(() => { currentClear = view.result.current.clearConversation() })
    await waitFor(() => expect(harness.api.clearAiConversation).toHaveBeenCalledTimes(2))

    firstClear.resolve(success(null))
    await act(async () => { await staleClear })
    expect(view.result.current.messages.map(({ content }) => content)).toEqual(['new generation'])

    secondClear.resolve(success(null))
    await act(async () => { await currentClear })
    expect(view.result.current.messages).toEqual([])
  })

  it.each(['success', 'failure'] as const)(
    'keeps a cleared conversation isolated from an older capability %s reply',
    async (outcome) => {
      const harness = createHarness()
      const capability = deferred<Awaited<ReturnType<ConversationApi['setAiConversationCapabilities']>>>()
      vi.mocked(harness.api.setAiConversationCapabilities).mockReturnValueOnce(capability.promise)
      const ids = createIds()
      const store = createWorkspaceAiSessionStore(ids)
      const { result } = renderHook(() => useAiConversation({
        api: harness.api,
        createId: ids,
        store,
        workspace: WORKSPACE,
      }))
      const session = store.sessions.get(WORKSPACE.workspaceId)!
      session.transcriptRevision = 1
      const oldConversationId = session.conversationId

      let capabilityChange!: Promise<boolean>
      act(() => { capabilityChange = result.current.setCurrentDocumentAccess(false) })
      await waitFor(() => expect(harness.api.setAiConversationCapabilities).toHaveBeenCalledOnce())
      await act(async () => { await result.current.clearConversation() })

      expect(session.conversationId).not.toBe(oldConversationId)
      expect(session.capabilities).toEqual({ currentDocument: false, workspace: true })
      expect(session.authoritativeCapabilities).toEqual({ currentDocument: false, workspace: false })
      if (outcome === 'success') capability.resolve(success(null))
      else capability.resolve({
        ok: false,
        error: { code: 'OPERATION_FAILED', message: 'stale capability failure' },
      })
      await act(async () => { expect(await capabilityChange).toBe(false) })

      expect(result.current.capabilities).toEqual({ currentDocument: false, workspace: true })
      expect(session.authoritativeCapabilities).toEqual({ currentDocument: false, workspace: false })
      expect(result.current.error).toBeNull()
    },
  )

  it('keeps an explicit null workspace inactive without creating a fallback conversation', async () => {
    const harness = createHarness()
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace: null,
    }))

    await act(async () => { expect(await result.current.sendMessage('must stay inactive')).toBe(false) })
    expect(store.sessions.size).toBe(0)
    expect(store.activeWorkspaceId).toBeNull()
    expect(result.current.messages).toEqual([])
    expect(harness.api.startAiConversation).not.toHaveBeenCalled()
  })

  it('revokes the active request when an existing hook transitions to a null workspace', async () => {
    const harness = createHarness()
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const view = renderHook(({ workspace }) => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace,
    }), { initialProps: { workspace: WORKSPACE as AiWorkspaceState | null } })
    await act(async () => { await view.result.current.sendMessage('before close') })
    const retained = store.sessions.get(WORKSPACE.workspaceId)!

    view.rerender({ workspace: null })
    harness.emit({
      requestId: vi.mocked(harness.api.startAiConversation).mock.lastCall![0].requestId,
      type: 'failed', code: 'OPERATION_FAILED', message: 'late failure',
    })

    expect(store.activeWorkspaceId).toBeNull()
    expect(retained.activeRequest).toBeNull()
    expect(retained.error).toBeNull()
    expect(view.result.current.messages).toEqual([])
  })

  it('ignores stale events from an earlier request', async () => {
    const harness = createHarness()
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace: WORKSPACE,
    }))
    await act(async () => { await result.current.sendMessage('current') })

    act(() => harness.emit({
      requestId: '550e8400-e29b-41d4-a716-999999999999',
      type: 'delta',
      messageId: 'stale',
      delta: 'secret stale output',
    }))

    await waitFor(() => expect(result.current.messages.map(({ content }) => content))
      .toEqual(['current']))
  })

  it('cancels a late start response after the workspace generation changes without mutating the session', async () => {
    const harness = createHarness()
    const pending = deferred<Awaited<ReturnType<ConversationApi['startAiConversation']>>>()
    vi.mocked(harness.api.startAiConversation).mockReturnValueOnce(pending.promise)
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const view = renderHook(({ generation }) => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace: { ...WORKSPACE, workspaceGeneration: generation },
    }), { initialProps: { generation: 'generation-1' } })

    let sending!: Promise<boolean>
    act(() => { sending = view.result.current.sendMessage('old generation') })
    await waitFor(() => expect(harness.api.startAiConversation).toHaveBeenCalledOnce())
    const requestId = vi.mocked(harness.api.startAiConversation).mock.lastCall![0].requestId
    view.rerender({ generation: 'generation-2' })
    pending.resolve(success({ requestId, modelId: 'model-a', transcriptRevision: 1 }))

    await act(async () => { expect(await sending).toBe(false) })
    expect(harness.api.cancelAiConversation).toHaveBeenCalledWith({ requestId })
    expect(view.result.current.status).toBe('idle')
    expect(view.result.current.error).toBeNull()
    expect(view.result.current.capabilities).toEqual({ currentDocument: true, workspace: true })
    expect(store.sessions.get(WORKSPACE.workspaceId)!.authoritativeCapabilities).toEqual({ currentDocument: false, workspace: false })
  })

  it('replays queued recovery events using the main-process revision sequence', async () => {
    const harness = createHarness()
    const pending = deferred<Awaited<ReturnType<ConversationApi['startAiConversation']>>>()
    vi.mocked(harness.api.startAiConversation).mockReturnValueOnce(pending.promise)
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace: WORKSPACE,
    }))

    let sending!: Promise<boolean>
    act(() => { sending = result.current.sendMessage('resume') })
    await waitFor(() => expect(harness.api.startAiConversation).toHaveBeenCalledOnce())
    const requestId = vi.mocked(harness.api.startAiConversation).mock.lastCall![0].requestId
    const userMessageId = store.sessions.get(WORKSPACE.workspaceId)!.messages[0]!.id
    act(() => {
      harness.emit({ requestId, type: 'started', transcriptRevision: 0 })
      harness.emit({
        requestId, type: 'message-start',
        messageId: 'assistant-recovery', previousTranscriptRevision: 0,
      })
      harness.emit({ requestId, type: 'delta', messageId: 'assistant-recovery', delta: 'recovered' })
      harness.emit({
        requestId, type: 'message-completed',
        messageId: 'assistant-recovery', transcriptRevision: 1,
      })
      harness.emit({
        requestId, type: 'user-message-accepted',
        messageId: userMessageId, transcriptRevision: 2,
      })
      harness.emit({
        requestId, type: 'message-start',
        messageId: 'assistant-final', previousTranscriptRevision: 2,
      })
      harness.emit({ requestId, type: 'delta', messageId: 'assistant-final', delta: 'final' })
      harness.emit({
        requestId, type: 'message-completed',
        messageId: 'assistant-final', transcriptRevision: 3,
      })
      harness.emit({ requestId, type: 'completed' })
    })
    pending.resolve(success({ requestId, modelId: 'model-a', transcriptRevision: 0 }))

    await act(async () => { expect(await sending).toBe(true) })
    expect(store.sessions.get(WORKSPACE.workspaceId)!.transcriptRevision).toBe(3)
    expect(result.current.messages.map(({ content }) => content))
      .toEqual(['resume', 'recovered', 'final'])
    expect(result.current.status).toBe('idle')
  })

  it('invalidates a one-shot document send when its start response crosses workspaces', async () => {
    const harness = createHarness()
    const pending = deferred<Awaited<ReturnType<ConversationApi['startAiConversation']>>>()
    vi.mocked(harness.api.startAiConversation).mockReturnValueOnce(pending.promise)
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const view = renderHook(({ workspaceId }) => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace: { workspaceId, workspaceGeneration: 'generation-1' },
    }), { initialProps: { workspaceId: 'workspace-a' } })
    await act(async () => {
      await view.result.current.setCurrentDocumentAccess(false)
      await view.result.current.setWorkspaceAccess(false)
    })
    store.sessions.get('workspace-a')!.transcriptRevision = 1

    let sending!: Promise<boolean>
    act(() => { sending = view.result.current.sendMessage('/document summarize') })
    await waitFor(() => expect(harness.api.startAiConversation).toHaveBeenCalledOnce())
    const startInput = vi.mocked(harness.api.startAiConversation).mock.lastCall![0]
    expect(startInput).toMatchObject({
      workspaceKey: 'workspace-a',
      currentDocumentOnce: true,
      capabilities: { currentDocument: false, workspace: false },
      messages: [{ role: 'user', content: 'summarize' }],
    })
    expect(harness.api.setAiConversationCapabilities).not.toHaveBeenCalled()
    view.rerender({ workspaceId: 'workspace-b' })
    pending.resolve(success({ requestId: startInput.requestId, modelId: 'model-a', transcriptRevision: 2 }))

    await act(async () => { expect(await sending).toBe(false) })
    expect(harness.api.cancelAiConversation).toHaveBeenCalledWith({ requestId: startInput.requestId })
    expect(harness.api.startAiConversation).toHaveBeenCalledOnce()
    expect(view.result.current.messages).toEqual([])
    expect(view.result.current.status).toBe('idle')
    expect(store.sessions.get('workspace-a')!.capabilities)
      .toEqual({ currentDocument: false, workspace: false })
    expect(view.result.current.capabilities).toEqual({ currentDocument: true, workspace: true })
  })

  it('rejects out-of-order assistant phases and ignores deltas after completion', async () => {
    const harness = createHarness()
    const ids = createIds()
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      workspace: WORKSPACE,
    }))
    await act(async () => { await result.current.sendMessage('phase test') })
    const requestId = vi.mocked(harness.api.startAiConversation).mock.lastCall![0].requestId
    const userMessageId = result.current.messages[0]!.id

    act(() => {
      harness.emit({ requestId, type: 'started', transcriptRevision: 1 })
      harness.emit({
        requestId, type: 'user-message-accepted',
        messageId: userMessageId, transcriptRevision: 1,
      })
      harness.emit({
        requestId,
        type: 'message-start',
        messageId: 'stale-assistant',
        previousTranscriptRevision: 0,
      })
      harness.emit({ requestId, type: 'delta', messageId: 'stale-assistant', delta: 'stale' })
      harness.emit({
        requestId,
        type: 'message-start',
        messageId: 'assistant-1',
        previousTranscriptRevision: 1,
      })
      harness.emit({ requestId, type: 'delta', messageId: 'assistant-1', delta: 'valid' })
      harness.emit({
        requestId,
        type: 'message-completed',
        messageId: 'assistant-1',
        transcriptRevision: 2,
      })
      harness.emit({ requestId, type: 'completed' })
      harness.emit({ requestId, type: 'delta', messageId: 'assistant-1', delta: 'late' })
    })

    expect(result.current.messages.map(({ content }) => content)).toEqual(['phase test', 'valid'])
    expect(result.current.status).toBe('idle')
  })

  it('rejects duplicate and jumped message completions while preserving the next exact revision', async () => {
    const harness = createHarness()
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace: WORKSPACE,
    }))
    await act(async () => { await result.current.sendMessage('revision sequence') })
    const requestId = vi.mocked(harness.api.startAiConversation).mock.lastCall![0].requestId
    const session = store.sessions.get(WORKSPACE.workspaceId)!
    const userMessageId = session.messages[0]!.id

    act(() => {
      harness.emit({ requestId, type: 'started', transcriptRevision: 1 })
      harness.emit({
        requestId, type: 'user-message-accepted',
        messageId: userMessageId, transcriptRevision: 1,
      })
      harness.emit({
        requestId, type: 'message-start',
        messageId: 'assistant-one', previousTranscriptRevision: 1,
      })
      harness.emit({
        requestId, type: 'message-completed',
        messageId: 'assistant-one', transcriptRevision: 2,
      })
      harness.emit({
        requestId, type: 'message-completed',
        messageId: 'assistant-one', transcriptRevision: 2,
      })
      harness.emit({
        requestId, type: 'message-completed',
        messageId: 'assistant-one', transcriptRevision: 4,
      })
      harness.emit({
        requestId, type: 'message-start',
        messageId: 'assistant-two', previousTranscriptRevision: 2,
      })
      harness.emit({ requestId, type: 'delta', messageId: 'assistant-two', delta: 'next' })
      harness.emit({
        requestId, type: 'message-completed',
        messageId: 'assistant-two', transcriptRevision: 3,
      })
      harness.emit({ requestId, type: 'completed' })
    })

    expect(session.transcriptRevision).toBe(3)
    expect(result.current.messages.at(-1)).toMatchObject({ content: 'next' })
    expect(result.current.status).toBe('idle')
  })

  it.each([
    {
      label: 'started revision jump',
      prefix: [],
      invalid: { type: 'started', transcriptRevision: 3 },
    },
    {
      label: 'duplicate started',
      prefix: [{ type: 'started', transcriptRevision: 1 }],
      invalid: { type: 'started', transcriptRevision: 2 },
    },
    {
      label: 'user acceptance jump',
      prefix: [{ type: 'started', transcriptRevision: 1 }],
      invalid: {
        type: 'user-message-accepted', messageId: 'user-invalid', transcriptRevision: 3,
      },
    },
    {
      label: 'message start before user acceptance',
      prefix: [{ type: 'started', transcriptRevision: 1 }],
      invalid: {
        type: 'message-start', messageId: 'assistant-invalid', previousTranscriptRevision: 1,
      },
    },
    {
      label: 'message completion revision jump',
      prefix: [
        { type: 'started', transcriptRevision: 1 },
        { type: 'user-message-accepted', messageId: 'user-valid', transcriptRevision: 1 },
        { type: 'message-start', messageId: 'assistant-valid', previousTranscriptRevision: 1 },
      ],
      invalid: {
        type: 'message-completed', messageId: 'assistant-valid', transcriptRevision: 3,
      },
    },
    {
      label: 'authorization during assistant streaming',
      prefix: [
        { type: 'started', transcriptRevision: 1 },
        { type: 'user-message-accepted', messageId: 'user-valid', transcriptRevision: 1 },
        { type: 'message-start', messageId: 'assistant-valid', previousTranscriptRevision: 1 },
      ],
      invalid: {
        type: 'authorization-requested', toolCallId: 'tool-invalid',
        toolName: 'edit_workspace_document', operationId: 'operation-invalid',
        scope: 'action', paths: ['note.md'],
      },
    },
    {
      label: 'audit before an assistant message completes',
      prefix: [
        { type: 'started', transcriptRevision: 1 },
        { type: 'user-message-accepted', messageId: 'user-valid', transcriptRevision: 1 },
      ],
      invalid: { type: 'audit', action: 'edited', absolutePaths: ['C:\\workspace\\note.md'] },
    },
    {
      label: 'terminal completion before an assistant message',
      prefix: [
        { type: 'started', transcriptRevision: 1 },
        { type: 'user-message-accepted', messageId: 'user-valid', transcriptRevision: 1 },
      ],
      invalid: { type: 'completed' },
    },
  ] as const)('rejects $label without poisoning the valid lifecycle', async ({ prefix, invalid }) => {
    const harness = createHarness()
    const ids = createIds()
    const store = createWorkspaceAiSessionStore(ids)
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      createId: ids,
      store,
      workspace: WORKSPACE,
    }))
    await act(async () => { await result.current.sendMessage('phase table') })
    const requestId = vi.mocked(harness.api.startAiConversation).mock.lastCall![0].requestId
    const session = store.sessions.get(WORKSPACE.workspaceId)!
    const userMessageId = session.messages[0]!.id

    act(() => {
      for (const event of prefix) harness.emit({
        requestId,
        ...event,
        ...(event.type === 'user-message-accepted' ? { messageId: userMessageId } : {}),
      } as AiConversationEvent)
      harness.emit({ requestId, ...invalid } as AiConversationEvent)
    })

    if (invalid.type === 'authorization-requested') {
      expect(result.current.pendingAuthorization).toBeNull()
    }
    if (invalid.type === 'audit') expect(result.current.auditRecords).toEqual([])
    expect(session.transcriptRevision).toBe(1)

    act(() => {
      if (prefix.some((event) => event.type === 'message-start')) {
        harness.emit({ requestId, type: 'delta', messageId: 'assistant-valid', delta: 'valid' })
        harness.emit({
          requestId, type: 'message-completed',
          messageId: 'assistant-valid', transcriptRevision: 2,
        })
      } else {
        harness.emit({ requestId, type: 'started', transcriptRevision: 1 })
        harness.emit({
          requestId, type: 'user-message-accepted',
          messageId: userMessageId, transcriptRevision: 1,
        })
        harness.emit({
          requestId, type: 'message-start',
          messageId: 'assistant-final', previousTranscriptRevision: 1,
        })
        harness.emit({ requestId, type: 'delta', messageId: 'assistant-final', delta: 'valid' })
        harness.emit({
          requestId, type: 'message-completed',
          messageId: 'assistant-final', transcriptRevision: 2,
        })
      }
      harness.emit({ requestId, type: 'completed' })
    })
    expect(session.transcriptRevision).toBe(2)
    expect(result.current.messages.at(-1)).toMatchObject({ content: 'valid' })
    expect(result.current.status).toBe('idle')
  })
})


describe('thinking time lifecycle', () => {
  it('keeps total request time running through tool and authorization waits then freezes at completion', async () => {
    let now = 100
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      const harness = createHarness()
      const view = renderHook(() => useAiConversation({ api: harness.api, createId: createIds(), workspace: WORKSPACE }))
      await act(async () => { await view.result.current.sendMessage('edit a sentence') })
      const { requestId } = vi.mocked(harness.api.startAiConversation).mock.lastCall![0]
      const userMessageId = view.result.current.messages[0]!.id
      const timing = () => view.result.current.timeline.find(entry => entry.kind === 'elapsed')
      expect(timing()).toMatchObject({ requestId, active: true, elapsedMs: 0, observedAt: 100 })
      act(() => {
        harness.emit({ requestId, type: 'started', transcriptRevision: 1 })
        harness.emit({ requestId, type: 'user-message-accepted', messageId: userMessageId, transcriptRevision: 1 })
        harness.emit({ requestId, type: 'message-start', messageId: 'tool-round', previousTranscriptRevision: 1 })
        harness.emit({ requestId, type: 'thinking', messageId: 'tool-round', active: true, elapsedMs: 0 })
      })
      now = 1100
      act(() => {
        harness.emit({ requestId, type: 'thinking', messageId: 'tool-round', active: false, elapsedMs: 700 })
        harness.emit({ requestId, type: 'message-completed', messageId: 'tool-round', transcriptRevision: 2 })
        harness.emit({ requestId, type: 'authorization-requested', toolCallId: 'call_1', toolName: 'edit_workspace_document', operationId: 'operation-1', scope: 'workspace', paths: ['note.md'] })
      })
      now = 4100
      expect(timing()).toMatchObject({ active: true, observedAt: 100 })
      act(() => {
        harness.emit({ requestId, type: 'authorization-result', toolName: 'edit_workspace_document', operationId: 'operation-1', scope: 'workspace', allowed: true })
        harness.emit({ requestId, type: 'message-start', messageId: 'answer', previousTranscriptRevision: 2 })
      })
      now = 6100
      act(() => {
        harness.emit({ requestId, type: 'message-completed', messageId: 'answer', transcriptRevision: 3 })
        harness.emit({ requestId, type: 'completed' })
      })
      expect(timing()).toMatchObject({ active: false, elapsedMs: 6000, messageIds: ['tool-round', 'answer'] })
      expect(view.result.current.timeline.find(entry => entry.kind === 'thinking')).toMatchObject({ active: false, elapsedMs: 700 })
      now = 100_000
      act(() => harness.emit({ requestId, type: 'started', transcriptRevision: 3 }))
      expect(timing()).toMatchObject({ active: false, elapsedMs: 6000 })
      view.unmount()
    } finally { clock.mockRestore() }
  })
  it.each(['stop', 'failed', 'switch', 'unmount'] as const)('freezes observed thinking immediately on %s and ignores late events', async ending => {
    let now = 100
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      const harness = createHarness(), store = createWorkspaceAiSessionStore(createIds())
      const view = renderHook(({ workspace }) => useAiConversation({ api: harness.api, store, workspace }), { initialProps: { workspace: WORKSPACE } })
      await act(async () => { await view.result.current.sendMessage('question') })
      const { requestId } = vi.mocked(harness.api.startAiConversation).mock.lastCall![0]
      const userMessageId = view.result.current.messages[0]!.id
      act(() => {
        harness.emit({ requestId, type: 'started', transcriptRevision: 1 })
        harness.emit({ requestId, type: 'user-message-accepted', messageId: userMessageId, transcriptRevision: 1 })
        harness.emit({ requestId, type: 'message-start', messageId: 'assistant', previousTranscriptRevision: 1 })
        harness.emit({ requestId, type: 'thinking', messageId: 'assistant', active: true, elapsedMs: 0 })
      })
      now = 2100
      if (ending === 'stop') {
        const gate = deferred<Awaited<ReturnType<ConversationApi['cancelAiConversation']>>>()
        vi.mocked(harness.api.cancelAiConversation).mockReturnValueOnce(gate.promise)
        let stopping!: Promise<void>
        act(() => { stopping = view.result.current.stopConversation() })
        expect(view.result.current.timeline.find(entry => entry.kind === 'thinking')).toMatchObject({ active: false, elapsedMs: 2000 })
        now = 90_000
        await act(async () => { gate.resolve(success(null)); await stopping })
      } else if (ending === 'failed') act(() => harness.emit({ requestId, type: 'failed', code: 'OPERATION_FAILED', message: '操作未能完成。' }))
      else if (ending === 'unmount') view.unmount()
      else view.rerender({ workspace: { workspaceId: 'workspace-b', workspaceGeneration: 'generation-b' } })
      const original = store.sessions.get(WORKSPACE.workspaceId)!
      expect(original.timeline.find(entry => entry.kind === 'thinking')).toMatchObject({ active: false, elapsedMs: 2000 })
      expect(original.timeline.find(entry => entry.kind === 'elapsed')).toMatchObject({ active: false, elapsedMs: 2000 })
      now = 100_000
      act(() => harness.emit({ requestId, type: 'thinking', messageId: 'assistant', active: true, elapsedMs: 5000 }))
      expect(original.timeline.find(entry => entry.kind === 'thinking')).toMatchObject({ active: false, elapsedMs: 2000 })
      expect(original.timeline.find(entry => entry.kind === 'elapsed')).toMatchObject({ active: false, elapsedMs: 2000 })
      view.unmount()
    } finally { clock.mockRestore() }
  })
  it('keeps distinct tool rounds, rejects wrong ownership and excludes authorization wait', async () => {
    const harness = createHarness()
    const { result } = renderHook(() => useAiConversation({ api: harness.api, createId: createIds(), workspace: WORKSPACE }))
    await act(async () => { await result.current.sendMessage('question') })
    const { requestId } = vi.mocked(harness.api.startAiConversation).mock.lastCall![0]
    const userMessageId = result.current.messages[0]!.id
    act(() => {
      harness.emit({ requestId, type: 'started', transcriptRevision: 1 })
      harness.emit({ requestId, type: 'user-message-accepted', messageId: userMessageId, transcriptRevision: 1 })
      harness.emit({ requestId, type: 'message-start', messageId: 'tool-round', previousTranscriptRevision: 1 })
      harness.emit({ requestId: 'foreign', type: 'thinking', messageId: 'tool-round', active: true, elapsedMs: 0 })
      harness.emit({ requestId, type: 'thinking', messageId: 'wrong-message', active: true, elapsedMs: 0 })
    })
    expect(result.current.timeline.some(entry => entry.kind === 'thinking')).toBe(false)
    act(() => {
      harness.emit({ requestId, type: 'thinking', messageId: 'tool-round', active: true, elapsedMs: 0 })
      harness.emit({ requestId, type: 'thinking', messageId: 'tool-round', active: false, elapsedMs: 1200 })
      harness.emit({ requestId, type: 'message-completed', messageId: 'tool-round', transcriptRevision: 2 })
      harness.emit({ requestId, type: 'thinking', messageId: 'tool-round', active: true, elapsedMs: 2000 })
      harness.emit({ requestId, type: 'authorization-requested', toolCallId: 'call_1', toolName: 'edit_workspace_document', operationId: 'operation-1', scope: 'workspace', paths: ['note.md'] })
    })
    expect(result.current.timeline.find(entry => entry.kind === 'thinking')).toMatchObject({ active: false, elapsedMs: 1200 })
    act(() => {
      harness.emit({ requestId, type: 'authorization-result', toolName: 'edit_workspace_document', operationId: 'operation-1', scope: 'workspace', allowed: true })
      harness.emit({ requestId, type: 'message-start', messageId: 'answer-round', previousTranscriptRevision: 2 })
      harness.emit({ requestId, type: 'thinking', messageId: 'answer-round', active: true, elapsedMs: 0 })
      harness.emit({ requestId, type: 'thinking', messageId: 'answer-round', active: false, elapsedMs: 350 })
      harness.emit({ requestId, type: 'delta', messageId: 'answer-round', delta: 'Answer' })
      harness.emit({ requestId, type: 'message-completed', messageId: 'answer-round', transcriptRevision: 3 })
      harness.emit({ requestId, type: 'completed' })
    })
    expect(result.current.timeline.filter(entry => entry.kind === 'thinking')).toEqual([
      expect.objectContaining({ messageId: 'tool-round', active: false, elapsedMs: 1200 }),
      expect.objectContaining({ messageId: 'answer-round', active: false, elapsedMs: 350 }),
    ])
  })
})
