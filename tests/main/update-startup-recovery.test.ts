import { beforeEach, expect, it, vi } from 'vitest'
const runtime = vi.hoisted(() => ({
  client: {} as Record<string, unknown>, helper: {} as Record<string, unknown>,
  quit: vi.fn(), show: vi.fn(), disposeDialog: vi.fn(), prepare: vi.fn(),
}))
vi.mock('electron', () => ({ app: { whenReady: async () => {}, getVersion: () => '1.0.4', getPath: () => 'test-user-data', quit: runtime.quit }, ipcMain: {}, nativeTheme: {} }))
vi.mock('../../src/main/create-main-window', () => ({ preloadPathForBuild: () => 'preload.js' }))
vi.mock('../../src/main/dialogs/business-message-dialog', () => ({ createBusinessMessageDialog: () => ({ showMessageBox: runtime.show, dispose: runtime.disposeDialog }) }))
vi.mock('../../src/main/arknote/arknote-client-runtime', () => ({ ArknoteClientRuntime: class { constructor() { return runtime.client } } }))
vi.mock('../../src/main/updates/update-helper', () => ({ prepareRecoveryHelper: runtime.prepare }))
import { recoverInterruptedUpdate } from '../../src/main/updates/update-startup-recovery'

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window') })
function fixture(failure: 'prepare' | 'exit' | 'commit' | 'none', lostRevoke = false) {
  let running = true, prepared = false, gateHeld = true, disposed = false
  let exitHelper!: () => void
  const exited = new Promise<void>(resolve => { exitHelper = resolve })
  const client = {
    connectIfRunning: vi.fn(async () => running),
    ensureStarted: vi.fn(async () => { throw new Error('persistent recovery must not launch a mixed-version program') }),
    requestIfConnected: vi.fn(async (command: string, _input: unknown, parse: (value: unknown) => unknown) => {
      if (disposed) throw new Error('disposed client')
      if (!running) return undefined
      if (command === 'service.prepare-update') {
        prepared = true
        if (failure === 'prepare') throw new Error('lost prepare acknowledgement')
        return parse({ prepared: true })
      }
      if (command === 'service.quit') running = false
      if (command === 'service.cancel-update') {
        if (gateHeld) throw new Error('update gate still held')
        prepared = false
      }
      return parse(null)
    }),
    dispose: vi.fn(() => { disposed = true }),
  }
  const helper = {
    exited,
    notesRunning: async () => running,
    waitNotesStopped: async () => { if (failure === 'exit') throw new Error('lost exit acknowledgement') },
    commit: vi.fn(async () => { if (failure === 'commit') throw new Error('lost commit acknowledgement') }),
    revoke: vi.fn(async () => { if (lostRevoke) throw new Error('lost revoke acknowledgement'); gateHeld = false }),
  }
  runtime.client = client; runtime.helper = helper
  runtime.prepare.mockResolvedValue({ helper, documents: ['document.md'], restoreArknote: true })
  runtime.show.mockResolvedValue({ response: 0 })
  return { client, helper, state: () => ({ running, prepared, disposed }), release: () => { gateHeld = false; exitHelper() } }
}
it.each([false, true])('cancels a prepared live service after lost prepare ACK, only after recovery revocation (lost revoke: %s)', async lostRevoke => {
  const f = fixture('prepare', lostRevoke)
  const recovery = recoverInterruptedUpdate('session', 'build', 'arkdown')
  if (lostRevoke) {
    await vi.waitFor(() => expect(runtime.show).toHaveBeenCalledTimes(2))
    expect(f.state()).toEqual({ running: true, prepared: true, disposed: false })
    expect(runtime.quit).not.toHaveBeenCalled(); expect(runtime.disposeDialog).not.toHaveBeenCalled()
    f.release()
  }
  await recovery
  expect(f.state()).toEqual({ running: true, prepared: false, disposed: true })
  expect(f.client.ensureStarted).not.toHaveBeenCalled()
  expect(f.helper.commit).not.toHaveBeenCalled(); expect(runtime.quit).toHaveBeenCalledOnce()
})
it.each(['exit', 'commit'] as const)('does not relaunch exited notes across persistent pending after %s ACK loss', async failure => {
  const f = fixture(failure)
  await recoverInterruptedUpdate('session', 'build', 'arkdown')
  expect(f.state().running).toBe(false); expect(f.client.ensureStarted).not.toHaveBeenCalled()
  expect(runtime.show.mock.calls.some(([, options]) => options.detail?.includes('修复程序后重新打开 Arknote'))).toBe(true)
  expect(runtime.quit).toHaveBeenCalledOnce(); expect(f.client.dispose).toHaveBeenCalledOnce()
})
it('hands restoration to the committed helper and does not cancel prepared notes on success', async () => {
  const f = fixture('none')
  await recoverInterruptedUpdate('session', 'build', 'arkdown')
  expect(f.helper.commit).toHaveBeenCalledWith({ documents: ['document.md'], restoreArknote: true })
  expect(f.helper.revoke).not.toHaveBeenCalled(); expect(f.client.ensureStarted).not.toHaveBeenCalled()
  expect(f.client.requestIfConnected.mock.calls.map(([command]) => command)).toEqual(['service.prepare-update', 'service.quit'])
  expect(runtime.quit).toHaveBeenCalledOnce(); expect(f.client.dispose).toHaveBeenCalledOnce()
})
