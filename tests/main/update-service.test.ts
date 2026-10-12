import { afterEach, expect, it, vi } from 'vitest'
import { AppUpdateService } from '../../src/main/updates/update-service'
import type { UpdateCandidate } from '../../src/shared/app-update'
const candidate: UpdateCandidate = { version: '1.0.5', mode: 'optional', required: false, message: 'new' }
function fixture(required = false) {
  const check = vi.fn(async () => ({ candidate: { ...candidate, required, mode: required ? 'required' as const : 'optional' as const } }))
  const send = vi.fn(), exit = vi.fn(), open = vi.fn(async () => {})
  const service = new AppUpdateService({ currentVersion: '1.0.4', check, sendEvent: send, openWebsite: open, requestExit: exit })
  return { service, check, send, exit, open }
}
afterEach(() => { vi.useRealTimers() })
it('invalidates stale About when a renderer reloads before the decision arrives', async () => {
  vi.useFakeTimers(); const f = fixture(); f.service.onMainWindowReady(1); f.service.aboutOpened(1, 'old-renderer')
  f.service.invalidateRenderer(1); await vi.advanceTimersByTimeAsync(5000)
  expect(f.service.getSnapshot(1).bubbleVisible).toBe(true); expect(f.send.mock.calls).toEqual([['update_check']]); f.service.dispose()
})
it('coalesces concurrent website actions but allows a later genuine click', async () => {
  vi.useFakeTimers(); const f = fixture(); f.service.onMainWindowReady(1); await vi.advanceTimersByTimeAsync(5000)
  let done!: () => void; f.open.mockImplementationOnce(() => new Promise<void>(resolve => { done = resolve }))
  const a = f.service.openWebsite(1), b = f.service.openWebsite(1); expect(f.open).toHaveBeenCalledOnce(); done(); await Promise.all([a, b])
  expect(f.send.mock.calls.filter(([s]) => s === 'website_opened')).toHaveLength(1)
  await f.service.openWebsite(1); expect(f.open).toHaveBeenCalledTimes(2); f.service.dispose()
})
it('does not re-block editing when About opens after force was deferred', async () => {
  vi.useFakeTimers(); const f = fixture(true); f.service.onMainWindowReady(1); await vi.advanceTimersByTimeAsync(5000)
  f.service.protectWork(1); await vi.advanceTimersByTimeAsync(20000); expect(f.service.getSnapshot(1).requiredPrompt).toBe('protecting')
  f.service.aboutOpened(1, 'reopen'); expect(f.service.getSnapshot(1).requiredPrompt).toBe('protecting'); expect(f.check).toHaveBeenCalledOnce(); expect(f.exit).not.toHaveBeenCalled(); f.service.dispose()
})
it('checks once 5000ms after first ready, shares state, and reminds again after cold start', async () => {
  vi.useFakeTimers(); const f = fixture(); f.service.onMainWindowReady(1); f.service.onMainWindowReady(2)
  await vi.advanceTimersByTimeAsync(4999); expect(f.check).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1); expect(f.check).toHaveBeenCalledOnce()
  expect(f.service.getSnapshot(2)).toMatchObject({ status: 'available', bubbleVisible: true, requiredPrompt: 'hidden' })
  f.service.aboutOpened(2, 'interaction-1'); f.service.aboutOpened(2, 'interaction-1')
  expect(f.service.getSnapshot(1).bubbleVisible).toBe(true)
  expect(f.send.mock.calls).toEqual([['update_check']])
  f.service.onMainWindowReady(2); await vi.advanceTimersByTimeAsync(6000); expect(f.check).toHaveBeenCalledOnce()
  const cold = fixture(); cold.service.onMainWindowReady(3); await vi.advanceTimersByTimeAsync(5000)
  expect(cold.service.getSnapshot(3).bubbleVisible).toBe(true)
  f.service.dispose(); cold.service.dispose()
})
it('does not count About visits as update-dialog interactions', async () => {
  vi.useFakeTimers(); const f = fixture(); f.service.onMainWindowReady(1); f.service.aboutOpened(1, 'one')
  await vi.advanceTimersByTimeAsync(5000)
  f.service.aboutOpened(1, 'one'); f.service.aboutClosed(1, 'one'); f.service.aboutOpened(1, 'two')
  expect(f.send.mock.calls.filter(([s]) => s === 'update_opened')).toHaveLength(0); f.service.dispose()
})
it('owns a cold-start force gate and permanently protects work after cancelled exit', async () => {
  vi.useFakeTimers(); const f = fixture(true); f.service.onMainWindowReady(1)
  await vi.advanceTimersByTimeAsync(5000)
  expect(f.service.getSnapshot(1).requiredPrompt).toBe('visible'); expect(f.service.getSnapshot(2).requiredPrompt).toBe('hidden')
  expect(f.send.mock.calls).toEqual([['update_check']])
  await f.service.action(1, 'claim-gate')
  f.service.requestRequiredExit(1); f.service.requestRequiredExit(1); expect(f.exit).toHaveBeenCalledOnce()
  f.service.setExitState('protecting'); expect(f.service.getSnapshot(1).requiredPrompt).toBe('protecting')
  expect(f.service.getSnapshot(1).candidate?.required).toBe(true); expect(f.exit).toHaveBeenCalledOnce()
  f.service.dispose()
})
it('opens only the fixed site and records only successful handoff; ignores late completion after disposal', async () => {
  vi.useFakeTimers(); const f = fixture(); f.service.onMainWindowReady(1)
  expect(await f.service.openWebsite(1)).toBe(false)
  await vi.advanceTimersByTimeAsync(5000); f.open.mockRejectedValueOnce(new Error('fail'))
  expect(await f.service.openWebsite(1)).toBe(false); expect(await f.service.openWebsite(1)).toBe(true)
  expect(f.open).toHaveBeenLastCalledWith('https://arkdown.cotax.tech/')
  expect(f.send.mock.calls.filter(([s]) => s === 'website_opened')).toHaveLength(1)
  f.service.dispose(); expect(await f.service.openWebsite(1)).toBe(false)
})
