import { afterEach, expect, it, vi } from 'vitest'
import { AppUpdateService } from '../../src/main/updates/update-service'
import { parseUpdateDecision } from '../../src/main/updates/update-protocol'
import { updateFixture } from '../helpers/app-update-fixture'
const identity = { version: '1.0.4', channel: 'stable', edition: 'Full', kind: 'portable' } as const
function setup(required = false, skipped: string | null = null, ready = true) {
  vi.useFakeTimers()
  const value = { ...updateFixture(), required, mode: required ? 'required' : 'optional' }
  let complete!: (value: string) => void
  const download = vi.fn(() => new Promise<string>(resolve => { complete = resolve }))
  const skip = vi.fn(async () => {}), exit = vi.fn(), install = vi.fn(async () => {}), event = vi.fn()
  const service = new AppUpdateService({ currentVersion: '1.0.4', check: async () => parseUpdateDecision(value, identity),
    sendEvent: event, openWebsite: async () => {}, requestExit: exit,
    readSkippedVersion: async () => skipped, skipVersion: skip, download, cancelDownload: async () => {},
    getVerified: async () => undefined, requestInstall: install })
  if (ready) service.onMainWindowReady(1)
  return { service, download, complete: () => complete('verified.zip'), skip, exit, install, event }
}
afterEach(() => vi.useRealTimers())
it('keeps preflight failure visible after the coordinator abort notification, and permits retry', async () => {
  const f = setup(); await vi.advanceTimersByTimeAsync(5000)
  await f.service.action(1, 'download'); f.complete(); await vi.advanceTimersByTimeAsync(0)
  await f.service.action(1, 'open')
  f.install.mockImplementationOnce(async () => { f.service.installState('aborted'); throw new Error('更新助手已退出，安装未继续。') })
  await f.service.action(1, 'install')
  expect(f.service.getSnapshot(1).transfer).toMatchObject({ phase: 'ready', dialog: 'install', error: '更新助手已退出，安装未继续。' })
  expect(f.service.isWorkBlocked()).toBe(false)
  await f.service.action(1, 'install'); expect(f.install).toHaveBeenCalledTimes(2)
  f.service.dispose()
})
it('protects work admitted after window creation but before its first show', async () => {
  const f = setup(true, null, false)
  f.service.onMainWindowCreated(1)
  await f.service.action(1, 'work-started')
  f.service.onMainWindowReady(1)
  await vi.advanceTimersByTimeAsync(5000)
  await f.service.action(1, 'claim-gate')
  expect(f.service.getSnapshot(1).requiredPrompt).toBe('protecting')
  expect(f.service.isWorkBlocked()).toBe(false)
  f.service.dispose()
})
it('keeps a visible actionable required dialog after installation is aborted', async () => {
  const f = setup(true); await vi.advanceTimersByTimeAsync(5000)
  await f.service.action(1, 'claim-gate')
  await f.service.action(1, 'download'); f.complete(); await vi.advanceTimersByTimeAsync(0)
  await f.service.action(1, 'install')
  f.service.installAborted('保存已取消')
  expect(f.service.getSnapshot(1).transfer).toMatchObject({ phase: 'ready', forced: true, dialog: 'install', error: '保存已取消' })
  f.service.dispose()
})
it('About does not consume reminder; later lasts only this process and skip persists only candidate', async () => {
  const f = setup(); await vi.advanceTimersByTimeAsync(5000)
  f.service.aboutOpened(1, 'about'); expect(f.service.getSnapshot(1).bubbleVisible).toBe(true)
  await f.service.action(1, 'open'); expect(f.service.getSnapshot(1).transfer?.dialog).toBe('offer')
  await f.service.action(1, 'later'); expect(f.service.getSnapshot(1).bubbleVisible).toBe(false)
  expect(f.skip).not.toHaveBeenCalled(); f.service.dispose()
  const next = setup(); await vi.advanceTimersByTimeAsync(5000)
  expect(next.service.getSnapshot(1).bubbleVisible).toBe(true)
  await next.service.action(1, 'skip'); expect(next.skip).toHaveBeenCalledWith('1.0.5'); next.service.dispose()
})
it('coalesces download, dismiss only hides modal, and installs only after verified download', async () => {
  const f = setup(); await vi.advanceTimersByTimeAsync(5000)
  await f.service.action(1, 'install'); expect(f.install).not.toHaveBeenCalled()
  await f.service.action(1, 'download'); await f.service.action(1, 'download'); expect(f.download).toHaveBeenCalledOnce()
  await f.service.action(1, 'dismiss'); expect(f.service.getSnapshot(1).transfer?.phase).toBe('downloading')
  f.complete(); await vi.advanceTimersByTimeAsync(0)
  expect(f.service.getSnapshot(1).transfer?.phase).toBe('ready')
  await f.service.action(1, 'open'); expect(f.service.getSnapshot(1).transfer?.dialog).toBe('install')
  await f.service.action(1, 'install'); expect(f.install).toHaveBeenCalledOnce(); f.service.dispose()
})
it('defers forced gating for the whole process once work started, even after saving or closing another window', async () => {
  const f = setup(true); await f.service.action(1, 'work-started'); await vi.advanceTimersByTimeAsync(5000)
  await f.service.action(1, 'claim-gate'); expect(f.service.isWorkBlocked()).toBe(false)
  expect(f.service.getSnapshot(1).requiredPrompt).toBe('protecting')
  f.service.aboutOpened(1, 'again'); expect(f.service.isWorkBlocked()).toBe(false); f.service.dispose()
  const multi = setup(true); multi.service.onMainWindowReady(2); multi.service.detachWindow(2)
  await vi.advanceTimersByTimeAsync(5000); await multi.service.action(1, 'claim-gate')
  expect(multi.service.isWorkBlocked()).toBe(false); multi.service.dispose()
})
it('required candidate overrides a skipped version, requires a race-free gate claim, and cancellation exits', async () => {
  const f = setup(true, '1.0.5'); await vi.advanceTimersByTimeAsync(5000)
  expect(f.service.isWorkBlocked()).toBe(false)
  await f.service.action(1, 'claim-gate'); expect(f.service.isWorkBlocked()).toBe(true)
  await f.service.action(1, 'skip'); expect(f.skip).not.toHaveBeenCalled()
  await f.service.action(1, 'download'); await f.service.action(1, 'cancel-download')
  expect(f.exit).toHaveBeenCalledOnce(); f.complete(); await vi.advanceTimersByTimeAsync(0)
  expect(f.service.getSnapshot(1).transfer?.phase).not.toBe('ready'); f.service.dispose()
})
it('suppresses only the exact ordinary skipped version and scopes modal ownership', async () => {
  const f = setup(false, '1.0.5'); await vi.advanceTimersByTimeAsync(5000)
  expect(f.service.getSnapshot(1).bubbleVisible).toBe(false); f.service.dispose()
  const newer = setup(false, '1.0.3'); newer.service.onMainWindowReady(2); await vi.advanceTimersByTimeAsync(5000)
  await newer.service.action(2, 'open')
  expect(newer.service.getSnapshot(1).transfer?.dialog).toBe('hidden')
  expect(newer.service.getSnapshot(2).transfer?.dialog).toBe('offer'); newer.service.dispose()
})
