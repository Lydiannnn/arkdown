import { expect, it, vi } from 'vitest'
import { createCloseRecoveryApi } from '../../src/preload/close-recovery-api'
import { CLOSE_RECOVERY_CHANNELS, parseCloseRecoveryAction, parseCloseRecoveryState } from '../../src/shared/close-recovery'

const attemptId = '00000000-0000-4000-8000-000000000001'
const state = { attemptId, generation: 1, stage: 'settle-document', error: null, feedback: 'no-progress',
  rendererUnavailable: false, elapsedMs: 11000, canReturn: false, canRetry: false, confirmAi: false, dark: false, themeColor: '#c82929' }
it('limits the recovery transport to validated data and exact actions', async () => {
  const invoke = vi.fn(async () => state as unknown), unsubscribe = vi.fn()
  let receive!: (value: unknown) => void
  const api = createCloseRecoveryApi({ invoke, subscribe: (_channel, handler) => { receive = handler; return unsubscribe } })
  expect(await api.get()).toEqual(state)
  const handler = vi.fn(); const dispose = api.subscribe(handler)
  receive({ ...state, content: 'private text' }); expect(handler).not.toHaveBeenCalled()
  receive(state); expect(handler).toHaveBeenCalledExactlyOnceWith(state)
  invoke.mockResolvedValueOnce(true)
  expect(await api.ready({ attemptId, generation: 1 })).toBe(true)
  expect(invoke).toHaveBeenLastCalledWith(CLOSE_RECOVERY_CHANNELS.ready, { attemptId, generation: 1 })
  expect(await api.ready({ attemptId, generation: 0 })).toBe(false)
  invoke.mockResolvedValueOnce(true)
  expect(await api.act({ attemptId, generation: 1, action: 'copy' })).toBe(true)
  expect(invoke).toHaveBeenLastCalledWith(CLOSE_RECOVERY_CHANNELS.action, { attemptId, generation: 1, action: 'copy' })
  expect(await api.act({ attemptId, generation: 1, action: 'force-close' as 'copy' })).toBe(false)
  dispose(); expect(unsubscribe).toHaveBeenCalledOnce()
})
it('rejects accessors, stale-shaped payloads, forged flags and malformed field values', () => {
  const getter = vi.fn(() => 'copy')
  expect(parseCloseRecoveryAction({ attemptId, generation: 1, get action() { return getter() } })).toBeUndefined()
  expect(getter).not.toHaveBeenCalled()
  for (const bad of [{ ...state, stage: 'destroy' }, { ...state, elapsedMs: NaN }, { ...state, canReturn: 'yes' },
    { ...state, generation: 0 }, { ...state, themeColor: 'url(private)' }, { ...state, extra: true }]) {
    expect(parseCloseRecoveryState(bad)).toBeUndefined()
  }
  expect(parseCloseRecoveryState(state)).toEqual(state)
})
