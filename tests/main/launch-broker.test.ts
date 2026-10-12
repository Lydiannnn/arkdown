// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { ArkdownLaunchBroker } from '../../src/main/updates/launch-broker'
it('routes a second process to its installation owner and retains launches while work is gated', async () => {
  const pipe = '\\\\.\\pipe\\arkdown-update-test-' + randomUUID()
  const owner = new ArkdownLaunchBroker('same-install', pipe), second = new ArkdownLaunchBroker('same-install', pipe)
  try {
    expect(await owner.claim([])).toBe(true)
    let blocked = true
    const opened: string[][] = []; owner.setHandler(async paths => { if (blocked) return false; opened.push(paths); return true })
    expect(await second.claim(['C:\\test\\document.md'])).toBe(false)
    await vi.waitFor(() => expect(owner.pendingDocuments).toEqual(['C:\\test\\document.md']))
    expect(opened).toEqual([]); blocked = false; owner.resume()
    await vi.waitFor(() => expect(opened).toEqual([['C:\\test\\document.md']]))
    expect(owner.pendingDocuments).toEqual([])
  } finally { await second.close(); await owner.close() }
})
it('keeps different installation identities independent and rejects invalid launch data', async () => {
  const a = new ArkdownLaunchBroker(randomUUID()), b = new ArkdownLaunchBroker(randomUUID())
  try { expect(await a.claim([])).toBe(true); expect(await b.claim([])).toBe(true); await expect(new ArkdownLaunchBroker('x').claim(['not-absolute.md'])).rejects.toThrow() }
  finally { await a.close(); await b.close() }
})
it('seals the handoff snapshot before commit and rejects late requests instead of losing acknowledged paths', async () => {
  const pipe = '\\\\.\\pipe\\arkdown-update-test-' + randomUUID()
  const owner = new ArkdownLaunchBroker('same', pipe), caller = new ArkdownLaunchBroker('same', pipe)
  try {
    await owner.claim([]); owner.setHandler(async () => false)
    await caller.claim(['C:\\first.md'])
    expect(owner.sealForUpdate()).toEqual(['C:\\first.md'])
    await expect(caller.claim(['C:\\late.md'])).rejects.toThrow()
    expect(owner.pendingDocuments).toEqual(['C:\\first.md'])
    owner.cancelUpdateHandoff(); await caller.claim(['C:\\retry.md'])
    expect(owner.pendingDocuments).toEqual(['C:\\first.md', 'C:\\retry.md'])
  } finally { await caller.close(); await owner.close() }
})
