import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStructuredRendererCloseRequester } from '../../src/main/renderer-close-requester'
import { createClosePreparationBridge, type ClosePreparationHandlerContext } from '../../src/preload/close-preparation'
import { CloseAttemptCoordinator } from '../../src/main/close/close-attempt-coordinator'
import { installWindowBoundsSaveOnClose } from '../../src/main/settings/window-bounds-close'
import { CLOSE_PREPARATION_CHANNELS, type ClosePreparationEvent, type ClosePreparationResult } from '../../src/shared/close-preparation'

const attempt = { attemptId: '550e8400-e29b-41d4-a716-446655440001', generation: 1 }
const requestId = '550e8400-e29b-41d4-a716-446655440002'
const next = { attemptId: '550e8400-e29b-41d4-a716-446655440003', generation: 2 }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function setup() {
  vi.useFakeTimers()
  const ipc = new Map<string, (event: { sender: unknown; senderFrame: unknown }, payload: unknown) => void>()
  const web = new Map<string, (details?: { isMainFrame?: boolean; isSameDocument?: boolean }) => void>()
  const mainFrame = {}
  const webContents = { mainFrame, send: vi.fn(), on: vi.fn((event: string, callback: (details?: { isMainFrame?: boolean; isSameDocument?: boolean }) => void) => { web.set(event, callback) }),
    removeListener: vi.fn((event: string) => { web.delete(event) }) }
  const ipcMain = { on: vi.fn((channel: string, callback: (event: { sender: unknown; senderFrame: unknown }, payload: unknown) => void) => { ipc.set(channel, callback) }),
    removeListener: vi.fn((channel: string) => { ipc.delete(channel) }) }
  const requester = createStructuredRendererCloseRequester({ ipcMain, window: { webContents }, createRequestId: () => requestId })
  const observer = { enter: vi.fn(), heartbeat: vi.fn(), unavailable: vi.fn() }
  const trusted = { sender: webContents, senderFrame: mainFrame }
  const receive = (value: unknown, event = trusted) => ipc.get(CLOSE_PREPARATION_CHANNELS.event)?.(event, value)
  return { requester, observer, ipc, web, webContents, trusted, receive }
}
afterEach(() => vi.useRealTimers())

describe('main structured renderer preparation', () => {
  it('does not settle on elapsed time, accepts the same live renderer late result, and cleans observers', async () => {
    const state = setup(), pending = state.requester.prepare(attempt, state.observer), settled = vi.fn()
    void pending.then(settled)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(settled).not.toHaveBeenCalled()
    expect(state.requester.prepare(attempt, state.observer)).toBe(pending)
    expect(state.webContents.send).toHaveBeenCalledOnce()
    state.receive({ ...attempt, requestId, sequence: 1, type: 'stage', stage: 'settle-preferences' })
    state.receive({ ...attempt, requestId, sequence: 2, type: 'result', result: { status: 'ready' } })
    await expect(pending).resolves.toEqual({ status: 'ready' })
    expect(state.ipc.size).toBe(0); expect(state.web.size).toBe(3)
    expect(state.requester.prepare(attempt, state.observer)).toBe(pending)
    state.requester.dispose()
    expect(state.web.size).toBe(0)
  })

  it.each(['replacement', 'navigation', 'renderer-process-gone'] as const)('rejects stale ready after %s without inventing cancellation', async loss => {
    const state = setup(), pending = state.requester.prepare(attempt, state.observer), settled = vi.fn()
    void pending.then(settled)
    if (loss === 'replacement') state.webContents.mainFrame = {}
    else if (loss === 'navigation') state.web.get('did-start-navigation')?.({ isMainFrame: true, isSameDocument: false })
    else state.web.get('render-process-gone')?.()
    state.receive({ ...attempt, requestId, sequence: 1, type: 'stage', stage: 'settle-preferences' })
    state.receive({ ...attempt, requestId, sequence: 2, type: 'result', result: { status: 'ready' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).not.toHaveBeenCalled(); expect(state.requester.isCurrent(attempt)).toBe(false)
    state.requester.dispose()
  })

  it('preserves readiness through same-document/subframe navigation but invalidates later reloads', async () => {
    const state = setup(), pending = state.requester.prepare(attempt, state.observer)
    state.web.get('did-start-navigation')?.({ isMainFrame: true, isSameDocument: true })
    state.web.get('did-start-navigation')?.({ isMainFrame: false, isSameDocument: false })
    state.receive({ ...attempt, requestId, sequence: 1, type: 'stage', stage: 'settle-preferences' })
    state.receive({ ...attempt, requestId, sequence: 2, type: 'result', result: { status: 'ready' } })
    await pending
    expect(state.requester.isCurrent(attempt)).toBe(true)
    state.web.get('did-start-navigation')?.({ isMainFrame: true, isSameDocument: false })
    expect(state.requester.isCurrent(attempt)).toBe(false)
    state.requester.dispose()
  })

  it.each(['owner', 'ipc', 'persist', 'finalize'] as const)('retains one preparation through the real close pipeline after %s awaits', async phase => {
    const state = setup(), wait = deferred<void>(), entered = vi.fn(), nativeClose = vi.fn()
    const operation = (name: string) => async () => { if (phase === name) { entered(); await wait.promise } }
    const ownerWindow = { on() {}, getSize: () => [1000, 700], getPosition: () => [0, 0], close: nativeClose }
    const close = installWindowBoundsSaveOnClose(ownerWindow, {
      prepareRendererClose: (progress, identity) => state.requester.prepare(identity, progress),
      isPreparationCurrent: identity => state.requester.isCurrent(identity),
      closeOwnedResources: operation('owner'),
      closeGate: { pauseAndDrain: operation('ipc'), resume() {} },
      saveWindowBounds: operation('persist'), finalizeClose: operation('finalize'), reportError() {},
    })
    close.requestClose()
    const identity = state.webContents.send.mock.calls[0]![1]
    state.receive({ ...identity, sequence: 1, type: 'stage', stage: 'settle-preferences' })
    state.receive({ ...identity, sequence: 2, type: 'result', result: { status: 'ready' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(entered).toHaveBeenCalledOnce()
    state.webContents.mainFrame = {}
    wait.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(nativeClose).not.toHaveBeenCalled()
    expect(close.snapshot()).toMatchObject({ state: 'failed', error: 'document-result-unknown', canReturn: false, canRetry: false })
    close.dispose(); state.requester.dispose()
  })

  it('validates window/frame, identity, monotonic sequence and phase before granting readiness', async () => {
    const state = setup(), pending = state.requester.prepare(attempt, state.observer), settled = vi.fn()
    void pending.then(settled)
    const stage = { ...attempt, requestId, sequence: 1, type: 'stage', stage: 'settle-preferences' }
    state.receive(stage, { ...state.trusted, sender: {} as typeof state.trusted.sender })
    state.receive(stage, { ...state.trusted, senderFrame: {} })
    state.receive({ ...stage, generation: 2 }); state.receive({ ...stage, extra: true })
    state.receive({ ...attempt, requestId, sequence: 1, type: 'result', result: { status: 'ready' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).not.toHaveBeenCalled(); expect(state.observer.enter).not.toHaveBeenCalled()
    state.receive(stage)
    state.receive({ ...stage, sequence: 2, stage: 'settle-document' })
    state.receive({ ...stage, sequence: 2 })
    expect(state.observer.enter).toHaveBeenCalledExactlyOnceWith('settle-preferences')
    state.receive({ ...attempt, requestId, sequence: 3, type: 'result', result: { status: 'ready' } })
    await expect(pending).resolves.toEqual({ status: 'ready' })
    state.requester.dispose()
  })

  it('never rebinds a live flight to a different attempt or accepts a stale generation after completion', async () => {
    const state = setup(), pending = state.requester.prepare(attempt, state.observer)
    await expect(state.requester.prepare(next, state.observer)).resolves.toMatchObject({ status: 'blocked' })
    expect(state.webContents.send).toHaveBeenCalledOnce()
    state.receive({ ...attempt, requestId, sequence: 1, type: 'result', result: { status: 'cancelled' } })
    await pending
    const second = state.requester.prepare(next, state.observer), settled = vi.fn()
    void second.then(settled)
    state.receive({ ...attempt, requestId, sequence: 2, type: 'result', result: { status: 'ready' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).not.toHaveBeenCalled()
    state.receive({ ...next, requestId, sequence: 1, type: 'result', result: { status: 'failed', code: 'preferences-save-failed' } })
    await expect(second).resolves.toMatchObject({ status: 'failed', code: 'preferences-save-failed' })
    await expect(state.requester.prepare(attempt, state.observer)).resolves.toMatchObject({ status: 'blocked' })
    expect(state.webContents.send).toHaveBeenCalledTimes(2)
    state.requester.dispose()
  })

  it('keeps send errors and dispose separate from successful cancellation of pending writes', async () => {
    const state = setup()
    state.webContents.send.mockImplementation(() => { throw new Error('private') })
    const pending = state.requester.prepare(attempt, state.observer), settled = vi.fn()
    void pending.then(settled)
    expect(state.observer.unavailable).toHaveBeenCalledWith('transport-unavailable')
    state.requester.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(settled).not.toHaveBeenCalled()
    expect(state.ipc.size).toBe(0); expect(state.web.size).toBe(0)
    await expect(state.requester.prepare(next, state.observer)).resolves.toMatchObject({ status: 'blocked' })
  })

  it.each(['ready', 'failed'] as const)('connects real coordinator, requester and bridge while a late %s owns the only save', async outcome => {
    const state = setup(), operation = deferred<ClosePreparationResult>()
    let subscriber: ((payload: unknown) => void) | undefined, context!: ClosePreparationHandlerContext
    const bridge = createClosePreparationBridge({ transport: {
      subscribe(callback) { subscriber = callback; return () => { subscriber = undefined } },
      send(event: ClosePreparationEvent) { state.receive(event) },
    } })
    const handler = vi.fn((value: ClosePreparationHandlerContext) => { context = value; value.enter('settle-document'); return operation.promise })
    bridge.setHandler(handler)
    state.webContents.send.mockImplementation((_channel, value) => { subscriber?.(value) })
    const nativeClose = vi.fn(), restore = vi.fn(async () => undefined)
    const coordinator: CloseAttemptCoordinator = new CloseAttemptCoordinator({
      prepare: progress => {
        const snapshot = coordinator.snapshot()!
        return state.requester.prepare({ attemptId: snapshot.attemptId, generation: snapshot.generation }, progress)
      },
      quiesceOwner: async () => undefined, drainIpc: async () => undefined, persistWindow: async () => undefined,
      finalize: async () => undefined, nativeClose, restore, notify: () => undefined,
      createAttemptId: () => attempt.attemptId, now: () => Date.now(),
    })
    coordinator.requestClose(); await vi.advanceTimersByTimeAsync(31_000)
    coordinator.requestClose()
    expect(handler).toHaveBeenCalledOnce()
    expect(coordinator.snapshot()).toMatchObject({ state: 'running', canRetry: false, canReturn: false,
      progress: { stage: 'settle-document', feedback: 'long-wait' } })
    expect(await coordinator.retry()).toBe(false)
    expect(nativeClose).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled()
    if (outcome === 'ready') context.enter('settle-preferences')
    operation.resolve(outcome === 'ready' ? { status: 'ready' } : { status: 'failed', code: 'document-save-failed' })
    await vi.advanceTimersByTimeAsync(0)
    if (outcome === 'ready') { expect(nativeClose).toHaveBeenCalledOnce(); coordinator.closed() }
    else expect(coordinator.snapshot()).toMatchObject({ state: 'failed', error: 'document-save-failed', canReturn: true })
    bridge.dispose(); state.requester.dispose(); coordinator.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
