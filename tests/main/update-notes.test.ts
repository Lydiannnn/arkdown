import { expect, it, vi } from 'vitest'
import { stopNotesForUpdate } from '../../src/main/updates/update-notes'
function fixture() {
  const request = vi.fn(async (command: string, _payload: unknown, parser: (v: unknown) => unknown) => parser(command === 'service.prepare-update' ? { prepared: true } : null))
  const client = { connectIfRunning: vi.fn(async () => true), requestIfConnected: request, ensureStarted: vi.fn(async () => {}) }
  const helper = { notesRunning: vi.fn(async () => true), waitNotesStopped: vi.fn(async () => {}) }
  const run = () => stopNotesForUpdate(client as Parameters<typeof stopNotesForUpdate>[0], helper)
  return { client, helper, run }
}
it('does not start Arknote when it was not running', async () => {
  const f = fixture(); f.helper.notesRunning.mockResolvedValue(false)
  expect(await f.run()).toBe(false); expect(f.client.connectIfRunning).not.toHaveBeenCalled(); expect(f.client.ensureStarted).not.toHaveBeenCalled()
})
it('requires save acknowledgement and independently confirms process exit', async () => {
  const f = fixture()
  expect(await f.run()).toBe(true)
  expect(f.client.requestIfConnected.mock.calls.map(c => c[0])).toEqual(['service.prepare-update', 'service.quit'])
  expect(f.helper.waitNotesStopped).toHaveBeenCalledOnce()
})
it('defers restoring prepared notes until the coordinator has released the update gate', async () => {
  const f = fixture(); f.client.requestIfConnected.mockRejectedValueOnce(new Error('response lost'))
  await expect(f.run()).rejects.toThrow('response lost')
  expect(f.client.requestIfConnected.mock.calls.map(c => c[0])).toEqual(['service.prepare-update'])
  expect(f.client.ensureStarted).not.toHaveBeenCalled(); expect(f.helper.waitNotesStopped).not.toHaveBeenCalled()
})
