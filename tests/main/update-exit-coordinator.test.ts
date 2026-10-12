import { afterEach, expect, it, vi } from 'vitest'
import { UpdateExitCoordinator } from '../../src/main/updates/update-exit-coordinator'
import { CloseAttemptCoordinator, type ClosePreparationResult } from '../../src/main/close/close-attempt-coordinator'
afterEach(() => vi.useRealTimers())
function fixture() {
  const windows = [1, 2].map(id => ({ id, requestClose: vi.fn() })); const quit = vi.fn(), notify = vi.fn()
  const coordinator = new UpdateExitCoordinator({ getWindows: () => windows, quitApp: quit, notify })
  const closed = (id: number) => { windows.splice(windows.findIndex(w => w.id === id), 1); coordinator.onWindowClosed(id) }
  return { windows, quit, notify, coordinator, closed }
}
it('requests windows sequentially, includes new windows, and quits only after actual closed', () => {
  const f = fixture(); f.coordinator.requestExit(); f.coordinator.requestExit()
  expect(f.windows[0].requestClose).toHaveBeenCalledOnce(); expect(f.windows[1].requestClose).not.toHaveBeenCalled()
  f.coordinator.onCloseState(1, { state: 'awaiting-native-close' }); expect(f.quit).not.toHaveBeenCalled()
  f.windows.push({ id: 3, requestClose: vi.fn() }); f.closed(1)
  expect(f.windows[0].requestClose).toHaveBeenCalledOnce(); expect(f.windows[1].requestClose).not.toHaveBeenCalled()
  f.closed(2); expect(f.windows[0].requestClose).toHaveBeenCalledOnce(); f.closed(3); expect(f.quit).toHaveBeenCalledOnce()
})
it.each(['cancelled', 'failed'] as const)('stops batch after %s, never closes the next window or quits', state => {
  const f = fixture(); f.coordinator.requestExit(); f.coordinator.onCloseState(1, { state })
  expect(f.notify).toHaveBeenLastCalledWith('protecting'); expect(f.quit).not.toHaveBeenCalled()
  f.closed(1); expect(f.windows[0].requestClose).not.toHaveBeenCalled()
})
it.each(['cancelled', 'document-save-failed', 'preferences-save-failed', 'ai-drain-failed'] as const)(
  'uses the real close state machine for %s and preserves editor data', async outcome => {
    vi.useFakeTimers(); const original = { text: 'unsaved recovered draft', preferences: 'retained', arknoteAlive: true }
    const data = structuredClone(original); const quit = vi.fn(), nativeClose = vi.fn(), notify = vi.fn()
    const coordinator = new UpdateExitCoordinator({ getWindows: () => [{ id: 1, requestClose: () => close.requestClose() }], quitApp: quit, notify })
    const result: ClosePreparationResult = outcome === 'cancelled' ? { status: 'cancelled' } : { status: 'blocked', code: outcome }
    const close = new CloseAttemptCoordinator({ prepare: async () => result, quiesceOwner: async () => {}, drainIpc: async () => {},
      persistWindow: async () => {}, finalize: async () => {}, nativeClose, restore: async () => {},
      notify: snapshot => coordinator.onCloseState(1, snapshot) })
    coordinator.requestExit(); await vi.advanceTimersByTimeAsync(1000)
    expect(nativeClose).not.toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled(); expect(data).toEqual(original)
    expect(notify).toHaveBeenLastCalledWith('protecting'); close.dispose()
  })
it('waits for unresolved writes without inferring safety from a timeout', async () => {
  vi.useFakeTimers(); const f = fixture(); f.coordinator.requestExit(); f.coordinator.onCloseState(1, { state: 'running' })
  await vi.advanceTimersByTimeAsync(120000); expect(f.quit).not.toHaveBeenCalled(); expect(f.windows[1].requestClose).not.toHaveBeenCalled()
})
