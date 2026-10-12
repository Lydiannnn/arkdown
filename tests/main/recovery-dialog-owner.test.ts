import { expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { promptDraftRecovery } from '../../src/main/arkdown-main'

const owner = (destroyed = false) => ({ isDestroyed: () => destroyed }) as BrowserWindow

it('keeps the initial recovery prompt ownerless before any document has been created', async () => {
  const showMessageBox = vi.fn(async () => ({ response: 0 }))
  await expect(promptDraftRecovery({ count: 2, windows: [], showMessageBox })).resolves.toBe('recover')
  expect(showMessageBox).toHaveBeenCalledWith(undefined, expect.objectContaining({
    buttons: ['恢复', '暂不恢复'], defaultId: 0, cancelId: 1,
  }))
})

it('parents a later recovery review to the most recently active document window', async () => {
  const first = owner(), active = owner()
  const showMessageBox = vi.fn(async () => ({ response: 1 }))
  await expect(promptDraftRecovery({ count: 1, windows: [first, active], preferred: active, showMessageBox })).resolves.toBe('ignore')
  expect(showMessageBox).toHaveBeenCalledWith(active, expect.anything())
})

it('uses a surviving document if the preferred owner closed while drafts were being read', async () => {
  const live = owner(), closed = owner(true)
  const showMessageBox = vi.fn(async () => ({ response: 0 }))
  await promptDraftRecovery({ count: 1, windows: [closed, live], preferred: closed, showMessageBox })
  expect(showMessageBox).toHaveBeenCalledWith(live, expect.anything())
})

it('propagates an owner-close failure instead of turning it into either recovery or ignored drafts', async () => {
  const live = owner()
  const showMessageBox = vi.fn(async () => { throw new Error('owner closed') })
  await expect(promptDraftRecovery({ count: 1, windows: [live], showMessageBox })).rejects.toThrow('owner closed')
  expect(showMessageBox).toHaveBeenCalledWith(live, expect.anything())
})
