import { expect, it, vi } from 'vitest'
import { UpdateInstallCoordinator, type UpdateInstallWindow } from '../../src/main/updates/update-install-coordinator'
import type { UpdateArtifact } from '../../src/main/updates/update-protocol'
import { stopNotesForUpdate, restoreNotesAfterUpdateAbort } from '../../src/main/updates/update-notes'
const artifact = {} as UpdateArtifact
function fixture() {
  let exitHelper!: () => void
  const exited = new Promise<void>(resolve => { exitHelper = resolve })
  const first = { id: 1, path: () => 'one.md', requestClose: vi.fn() }, second = { id: 2, path: () => 'two.md', requestClose: vi.fn() }
  let windows: UpdateInstallWindow[] = [first, second]
  const commit = vi.fn(async () => {}), revoke = vi.fn(async () => {}), prepare = vi.fn(async () => ({ commit, revoke, exited }))
  const stopArknote = vi.fn(async () => true), restoreArknote = vi.fn(async () => {}), quit = vi.fn(), notify = vi.fn()
  const coordinator = new UpdateInstallCoordinator({ prepare, windows: () => windows, stopArknote, restoreArknote, quit, notify })
  return { first, second, commit, revoke, prepare, stopArknote, restoreArknote, quit, notify, coordinator, exitHelper,
    close(id: number) { windows = windows.filter(w => w.id !== id); coordinator.onWindowClosed(id) } }
}
it('prepares before closing, closes sequentially, then saves notes and explicitly commits', async () => {
  const f = fixture(); await f.coordinator.start(artifact, 'verified'); expect(f.prepare).toHaveBeenCalledOnce()
  expect(f.first.requestClose).toHaveBeenCalledOnce(); expect(f.second.requestClose).not.toHaveBeenCalled()
  f.close(1); expect(f.second.requestClose).toHaveBeenCalledOnce(); expect(f.stopArknote).not.toHaveBeenCalled()
  f.close(2); await vi.waitFor(() => expect(f.quit).toHaveBeenCalledOnce())
  expect(f.commit).toHaveBeenCalledWith({ documents: ['one.md', 'two.md'], restoreArknote: true })
  expect(f.revoke).not.toHaveBeenCalled()
})
it('later-window cancel aborts without stopping notes or reopening the already closed window', async () => {
  const f = fixture(); await f.coordinator.start(artifact, 'verified'); f.close(1)
  f.coordinator.onCloseState(2, { state: 'cancelled' }); await vi.waitFor(() => expect(f.coordinator.active).toBe(false))
  expect(f.revoke).toHaveBeenCalledOnce(); expect(f.commit).not.toHaveBeenCalled(); expect(f.quit).not.toHaveBeenCalled()
  expect(f.stopArknote).not.toHaveBeenCalled(); expect(f.first.requestClose).toHaveBeenCalledOnce()
})
it('brings each pending document forward before requesting its save decision', async () => {
  const f = fixture(), events: string[] = []
  Object.assign(f.first, { activate: () => events.push('activate-one') })
  Object.assign(f.second, { activate: () => events.push('activate-two') })
  f.first.requestClose.mockImplementation(() => { events.push('close-one') })
  f.second.requestClose.mockImplementation(() => { events.push('close-two') })
  await f.coordinator.start(artifact, 'verified')
  expect(events).toEqual(['activate-one', 'close-one'])
  f.close(1)
  expect(events).toEqual(['activate-one', 'close-one', 'activate-two', 'close-two'])
})
it('failed helper preflight closes nothing and preserves a retryable application', async () => {
  const f = fixture(); f.prepare.mockRejectedValueOnce(new Error('helper failed'))
  await expect(f.coordinator.start(artifact, 'verified')).rejects.toThrow('helper failed')
  expect(f.first.requestClose).not.toHaveBeenCalled(); expect(f.coordinator.active).toBe(false)
})
it('failed commit restores notes and never quits as a successful install', async () => {
  const f = fixture(); f.commit.mockRejectedValueOnce(new Error('commit failed'))
  await f.coordinator.start(artifact, 'verified'); f.close(1); f.close(2)
  await vi.waitFor(() => expect(f.restoreArknote).toHaveBeenCalledOnce())
  expect(f.revoke).toHaveBeenCalled(); expect(f.notify).toHaveBeenCalledWith('aborted', expect.any(String))
})
it.each([false, true])('restores stopped notes only after a lost commit is safely revoked (lost revoke: %s)', async lostRevoke => {
  const f = fixture()
  let gateHeld = true, notesVisible = true, exited = false
  f.stopArknote.mockImplementation(async () => { notesVisible = false; return true })
  f.commit.mockRejectedValueOnce(new Error('commit acknowledgement lost'))
  f.revoke.mockImplementation(async () => { if (lostRevoke) throw new Error('revoke acknowledgement lost'); gateHeld = false })
  f.restoreArknote.mockImplementation(async () => { if (gateHeld) throw new Error('native launch gate denied'); notesVisible = true })
  f.quit.mockImplementation(() => { exited = true })
  await f.coordinator.start(artifact, 'verified'); f.close(1); f.close(2)
  if (lostRevoke) {
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalledWith('blocked', expect.any(String)))
    expect(notesVisible).toBe(false); expect(exited).toBe(false)
    gateHeld = false; f.exitHelper()
  }
  await vi.waitFor(() => expect(f.coordinator.active).toBe(false))
  expect(notesVisible).toBe(true); expect(exited).toBe(true)
})
it('restores prepared notes after an exit acknowledgement is lost, without committing installation', async () => {
  const f = fixture(); let gateHeld = true, notesRunning = true, prepared = false
  const client = {
    connectIfRunning: async () => notesRunning,
    ensureStarted: async () => { if (gateHeld) throw new Error('gate blocked'); notesRunning = true },
    requestIfConnected: async <T>(command: string, _payload: unknown, parse: (value: unknown) => T) => {
      if (!notesRunning) return undefined
      if (command === 'service.prepare-update') { prepared = true; return parse({ prepared: true }) }
      if (command === 'service.quit') notesRunning = false
      if (command === 'service.cancel-update') prepared = false
      return parse(null)
    },
  }
  f.stopArknote.mockImplementation(() => stopNotesForUpdate(client, {
    notesRunning: async () => notesRunning, waitNotesStopped: async () => { throw new Error('lost exit response') },
  }))
  f.restoreArknote.mockImplementation(() => restoreNotesAfterUpdateAbort(client))
  f.revoke.mockImplementation(async () => { gateHeld = false })
  await f.coordinator.start(artifact, 'verified'); f.close(1); f.close(2)
  await vi.waitFor(() => expect(f.coordinator.active).toBe(false))
  expect(notesRunning).toBe(true); expect(prepared).toBe(false); expect(f.commit).not.toHaveBeenCalled()
})
it('does not start an update while a previous normal close is already pending', async () => {
  const f = fixture(); Object.assign(f.first, { isClosing: () => true })
  await expect(f.coordinator.start(artifact, 'verified')).rejects.toThrow()
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.first.requestClose).not.toHaveBeenCalled()
})
it('keeps the parent alive and blocks a new install when revocation cannot be confirmed', async () => {
  const f = fixture(); f.commit.mockRejectedValueOnce(new Error('lost commit acknowledgement'))
  f.revoke.mockRejectedValueOnce(new Error('lost revoke acknowledgement'))
  await f.coordinator.start(artifact, 'verified'); f.close(1); f.close(2)
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledWith('blocked', expect.any(String)))
  expect(f.quit).not.toHaveBeenCalled(); expect(f.coordinator.active).toBe(true)
  f.exitHelper()
  await vi.waitFor(() => expect(f.coordinator.active).toBe(false))
  expect(f.quit).toHaveBeenCalledOnce()
})
