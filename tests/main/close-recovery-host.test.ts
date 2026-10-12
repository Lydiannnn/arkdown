import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCloseRecoveryHost, type CloseRecoveryView } from '../../src/main/close/close-recovery-host'
import type { CloseAttemptSnapshot } from '../../src/main/close/close-attempt-coordinator'
import { CLOSE_RECOVERY_CHANNELS } from '../../src/shared/close-recovery'

const attemptId = '00000000-0000-4000-8000-000000000001'
afterEach(() => vi.useRealTimers())
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function snapshot(extra: Partial<CloseAttemptSnapshot> = {}): CloseAttemptSnapshot {
  return { attemptId, generation: 1, revealRevision: 0, state: 'running', error: null, rendererUnavailable: null,
    canReturn: false, canRetry: false, progress: { stage: 'settle-document', elapsedMs: 600,
      stageElapsedMs: 600, idleMs: 600, rendererAliveAt: null, pending: { editor: 1 }, feedback: 'progress' }, ...extra }
}
function setup() {
  const handlers = new Map<string, (event: { sender: object; senderFrame: object }, input?: unknown) => unknown>()
  const ready = deferred()
  const sender = {}, mainFrame = {}
  const view = { sender, mainFrame, ready: ready.promise, send: vi.fn(), show: vi.fn(), hide: vi.fn(), destroy: vi.fn() }
  let callbacks!: { close(): void; unavailable(): void }
  const createView = vi.fn((_owner: object, events: typeof callbacks): CloseRecoveryView => { callbacks = events; return view })
  const copy = vi.fn(), record = vi.fn(), fallbackResult = deferred<'copy' | undefined>()
  const fallback = vi.fn(() => fallbackResult.promise)
  const host = createCloseRecoveryHost({
    handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: channel => { handlers.delete(channel) },
    createView, copy, record, fallback, version: '1.0.3', platform: 'win32',
  })
  const release = vi.fn()
  const controller = { snapshot: vi.fn(() => current), returnToEditor: vi.fn(async () => true), retry: vi.fn(async () => true) }
  let current: CloseAttemptSnapshot | null = null
  const owner = {}, binding = host.attach(owner, { release, theme: () => ({ dark: false, themeColor: '#c82929' }) })
  binding.bind(controller)
  const notify = (value: CloseAttemptSnapshot) => { current = value; binding.notify(value) }
  const invoke = (action: string, identity = { attemptId, generation: 1 }) => handlers.get(CLOSE_RECOVERY_CHANNELS.action)!({ sender, senderFrame: mainFrame }, { ...identity, action })
  const acknowledge = (value = { attemptId, generation: 1 }) => handlers.get(CLOSE_RECOVERY_CHANNELS.ready)!({ sender, senderFrame: mainFrame }, value)
  return { host, binding, notify, invoke, acknowledge, handlers, view, ready, createView, controller, release, record, copy, fallback, fallbackResult,
    callbacks: () => callbacks, event: { sender, senderFrame: mainFrame } }
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

describe('main-owned close recovery surface', () => {
  it('keeps a healthy ready surface during a long business user wait', async () => {
    vi.useFakeTimers()
    const s = setup(), first = snapshot()
    s.notify(first)
    s.notify({ ...first, progress: { ...first.progress, stage: 'await-user', feedback: 'await-user' } })
    s.ready.resolve(); await tick(); expect(s.acknowledge()).toBe(true)
    await vi.advanceTimersByTimeAsync(9000)
    expect(s.view.destroy).not.toHaveBeenCalled()
    expect(s.view.show).not.toHaveBeenCalled()
    s.notify(first)
    expect(s.createView).toHaveBeenCalledOnce()
    expect(s.view.show).toHaveBeenCalledOnce()
    expect(s.fallback).not.toHaveBeenCalled()
    s.host.dispose()
  })
  it('does not consume fallback deduplication for a prompt skipped during user wait', async () => {
    const s = setup(), first = snapshot()
    s.createView.mockImplementationOnce(() => { throw new Error('load failed') })
    s.notify(first)
    s.notify({ ...first, progress: { ...first.progress, stage: 'await-user', feedback: 'await-user' } })
    await tick(); await tick()
    expect(s.fallback).not.toHaveBeenCalled()
    s.notify(first); await tick()
    expect(s.fallback).toHaveBeenCalledOnce()
    s.host.dispose()
  })
  it('does not show a blank child on HTML load alone and falls back without touching close authority', async () => {
    vi.useFakeTimers()
    const s = setup(); s.notify(snapshot()); s.ready.resolve(); await tick()
    expect(s.view.show).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(8000)
    expect(s.fallback).toHaveBeenCalledOnce()
    expect(s.controller.returnToEditor).not.toHaveBeenCalled()
    expect(s.controller.retry).not.toHaveBeenCalled()
    expect(s.view.destroy).toHaveBeenCalledOnce()
    s.host.dispose()
  })
  it('requires both HTML load and a current owner-mainframe surface acknowledgment', async () => {
    const s = setup(); s.notify(snapshot())
    const ack = s.handlers.get(CLOSE_RECOVERY_CHANNELS.ready)!
    expect(ack({ ...s.event, senderFrame: {} }, { attemptId, generation: 1 })).toBe(false)
    expect(s.acknowledge({ attemptId, generation: 2 })).toBe(false)
    expect(ack(s.event, { attemptId, generation: 1, extra: true })).toBe(false)
    expect(s.acknowledge()).toBe(true)
    expect(s.view.show).not.toHaveBeenCalled()
    s.ready.resolve(); await tick()
    expect(s.view.show).toHaveBeenCalledExactlyOnceWith(false)
    s.host.dispose()
  })
  it('does not show on a quick close and does not mistake business user wait for a hung operation', () => {
    const s = setup()
    const first = snapshot()
    s.notify({ ...first, progress: { ...first.progress, feedback: 'hidden', elapsedMs: 100 } })
    expect(s.createView).not.toHaveBeenCalled()
    s.notify({ ...first, progress: { ...first.progress, stage: 'await-user', feedback: 'await-user' } })
    expect(s.createView).not.toHaveBeenCalled()
    s.notify({ ...first, state: 'cancelled' })
    expect(s.release).toHaveBeenCalledExactlyOnceWith({ attemptId, generation: 1 })
    s.host.dispose()
  })
  it('publishes current state before surface acknowledgment so a mount between attempts can become ready', async () => {
    const s = setup(); s.notify(snapshot()); s.notify(snapshot({ state: 'cancelled' }))
    s.ready.resolve(); await tick()
    expect(s.view.send).not.toHaveBeenCalled()
    s.notify(snapshot({ generation: 2 }))
    expect(s.view.send).toHaveBeenCalledWith(expect.objectContaining({ generation: 2 }))
    expect(s.view.show).not.toHaveBeenCalled()
    expect(s.acknowledge({ attemptId, generation: 2 })).toBe(true)
    expect(s.view.show).toHaveBeenCalledOnce()
    s.host.dispose()
  })
  it('does not display a queued fallback after the attempt has been cancelled', async () => {
    const s = setup(); s.createView.mockImplementationOnce(() => { throw new Error('load failed') })
    s.notify(snapshot()); s.notify(snapshot({ state: 'cancelled' })); await tick()
    expect(s.fallback).not.toHaveBeenCalled()
    s.host.dispose()
  })
  it('allows an explicit close reveal to reopen fallback without looping on heartbeat updates', async () => {
    const s = setup(), failed = snapshot({ state: 'failed', error: 'window-settings-failed', canReturn: true, canRetry: true })
    s.notify(failed); s.ready.reject(); await tick()
    expect(s.fallback).toHaveBeenCalledOnce()
    s.fallbackResult.resolve(undefined); await tick()
    for (let n = 0; n < 10; n++) s.notify(failed)
    await tick(); expect(s.fallback).toHaveBeenCalledOnce()
    s.notify({ ...failed, revealRevision: 1 }); await tick()
    expect(s.fallback).toHaveBeenCalledTimes(2)
    s.host.dispose()
  })
  it('reveals one surface, updates without stealing focus, and never unlocks pending work', async () => {
    const s = setup()
    s.notify(snapshot()); s.acknowledge(); s.ready.resolve(); await tick()
    expect(s.createView).toHaveBeenCalledOnce()
    expect(s.view.show).toHaveBeenCalledExactlyOnceWith(false)
    for (let n = 0; n < 10; n++) s.notify(snapshot())
    expect(s.view.show).toHaveBeenCalledOnce()
    expect(await s.invoke('retry')).toBe(false)
    expect(await s.invoke('return')).toBe(false)
    expect(s.controller.retry).not.toHaveBeenCalled()
    expect(s.controller.returnToEditor).not.toHaveBeenCalled()
    expect(s.record).toHaveBeenCalledOnce()
    s.host.dispose()
  })
  it('rejects foreign renderers, subframes, extra fields and stale attempt identities', async () => {
    const s = setup(); s.notify(snapshot()); s.acknowledge(); s.ready.resolve(); await tick()
    const handler = s.handlers.get(CLOSE_RECOVERY_CHANNELS.action)!
    const input = { attemptId, generation: 1, action: 'copy' }
    expect(await handler({ ...s.event, sender: {} }, input)).toBe(false)
    expect(await handler({ ...s.event, senderFrame: {} }, input)).toBe(false)
    expect(await handler(s.event, { ...input, canRetry: true })).toBe(false)
    expect(await s.invoke('copy', { attemptId, generation: 2 })).toBe(false)
    expect(s.copy).not.toHaveBeenCalled()
    expect(s.handlers.get(CLOSE_RECOVERY_CHANNELS.get)!({ ...s.event, sender: {} })).toBeNull()
    expect(await s.invoke('copy')).toBe(true)
    expect(s.copy.mock.calls[0]![0]).toContain('Arkdown close diagnostic')
    s.host.dispose()
  })
  it('requires an explicit current AI decision and resolves cancellation without stopping work', async () => {
    const s = setup(); s.notify(snapshot())
    const decision = s.binding.confirmStopAi({ attemptId, generation: 1 })
    s.acknowledge(); s.ready.resolve(); await tick()
    expect(s.view.show).toHaveBeenCalledWith(true)
    expect(await s.invoke('stop-ai-and-close', { attemptId, generation: 9 })).toBe(false)
    expect(await s.invoke('continue-using')).toBe(true)
    expect(await decision).toBe(false)
    expect(await s.invoke('stop-ai-and-close')).toBe(false)
    s.host.dispose()
  })
  it('rechecks coordinator authority and releases only when restore actually cancels the attempt', async () => {
    const s = setup(); s.notify(snapshot({ state: 'failed', error: 'document-save-failed', canReturn: true, canRetry: true }))
    s.acknowledge(); s.ready.resolve(); await tick()
    const restore = deferred<boolean>(); s.controller.returnToEditor.mockImplementation(() => restore.promise)
    const action = s.invoke('return')
    expect(await s.invoke('retry')).toBe(false)
    expect(s.release).not.toHaveBeenCalled()
    restore.resolve(true); expect(await action).toBe(true)
    expect(s.release).not.toHaveBeenCalled()
    s.notify(snapshot({ state: 'cancelled' })); s.notify(snapshot({ state: 'cancelled' }))
    expect(s.release).toHaveBeenCalledOnce()
    s.host.dispose()
  })
  it('uses a bounded native fallback after view failure and rejects late fallback actions', async () => {
    const s = setup(); s.notify(snapshot()); s.ready.reject(new Error('private/path must not leak'))
    await tick(); expect(s.fallback).toHaveBeenCalledOnce()
    for (let n = 0; n < 10; n++) s.notify(snapshot())
    expect(s.fallback).toHaveBeenCalledOnce()
    s.notify(snapshot({ state: 'cancelled' }))
    s.fallbackResult.resolve('copy'); await tick()
    expect(s.copy).not.toHaveBeenCalled()
    expect(JSON.stringify(s.fallback.mock.calls)).not.toContain('private/path')
    s.host.dispose()
  })
  it('actual owner disposal settles an AI prompt and detaches only its child', async () => {
    const s = setup(); s.notify(snapshot())
    const decision = s.binding.confirmStopAi({ attemptId, generation: 1 })
    s.binding.dispose(); expect(await decision).toBe(false)
    s.ready.resolve(); await tick()
    expect(s.view.show).not.toHaveBeenCalled()
    expect(s.view.destroy).toHaveBeenCalledOnce()
    expect(await s.invoke('copy')).toBe(false)
    s.host.dispose()
    expect(s.handlers.size).toBe(0)
  })
})
