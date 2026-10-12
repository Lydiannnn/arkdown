import { expect, it, vi } from 'vitest'
import { createIpcOperations, registerIpcHandlers } from '../../src/main/ipc/register-ipc'
import { IPC_CHANNELS } from '../../src/shared/contracts'
it('uses existing owner/frame admission and rejects arbitrary URL/payloads or unavailable owners', async () => {
  const handlers = new Map<string, (...args: any[]) => any>()
  const ipcMain = { handle: (key: string, handler: (...args: any[]) => any) => handlers.set(key, handler), removeHandler: (key: string) => handlers.delete(key) }
  const window = { webContents: { mainFrame: {} } }; const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const updates = { isAlive: vi.fn(() => true), getState: vi.fn(() => null), about: vi.fn(), openWebsite: vi.fn(async () => true), requestExit: vi.fn(), protect: vi.fn() }
  const operations = createIpcOperations({ updates, workspace: {}, documents: {}, chooseDirectory: vi.fn(), getLastWorkspace: () => null, setLastWorkspace: vi.fn(), reportError: vi.fn() } as never)
  const registration = registerIpcHandlers({ ipcMain, window, operations })
  const invoke = (channel: string, input?: unknown, source = event) => handlers.get(channel)!(source, input)
  expect(await invoke(IPC_CHANNELS.requestRequiredUpdateExit)).toMatchObject({ ok: true })
  expect(updates.requestExit).toHaveBeenCalledOnce()
  expect(await invoke(IPC_CHANNELS.openUpdateWebsite, { url: 'https://evil.test' })).toMatchObject({ ok: false })
  expect(await invoke(IPC_CHANNELS.openUpdateWebsite, undefined, { ...event, senderFrame: {} })).toMatchObject({ ok: false })
  expect(await invoke(IPC_CHANNELS.openUpdateWebsite, undefined, { ...event, sender: { mainFrame: {} } })).toMatchObject({ ok: false })
  updates.isAlive.mockReturnValue(false); expect(await invoke(IPC_CHANNELS.openUpdateWebsite)).toMatchObject({ ok: false }); expect(updates.openWebsite).not.toHaveBeenCalled()
  updates.isAlive.mockReturnValue(true); await registration.pauseAndDrain()
  expect(await invoke(IPC_CHANNELS.requestRequiredUpdateExit)).toMatchObject({ ok: false }); expect(updates.requestExit).toHaveBeenCalledOnce()
  registration.dispose()
})
it('admits only finite actions and gates new work in main while permitting save protection', async () => {
  const action = vi.fn(async () => {}), noteWorkStarted = vi.fn(), isWorkBlocked = vi.fn(() => false)
  const updates = { isAlive: () => true, action, isWorkBlocked, noteWorkStarted }
  const operations = createIpcOperations({ updates, workspace: {}, documents: {} } as never)
  expect(await operations.performUpdateAction('download')).toMatchObject({ ok: true })
  expect(await operations.performUpdateAction({ action: 'install', path: 'evil' })).toMatchObject({ ok: false })
  expect(operations.admitUpdateOperation('startAiConversation')).toBe(true); expect(noteWorkStarted).toHaveBeenCalledOnce()
  isWorkBlocked.mockReturnValue(true)
  expect(operations.admitUpdateOperation('startAiConversation')).toBe(false)
  expect(operations.admitUpdateOperation('createDocument')).toBe(false)
  expect(operations.admitUpdateOperation('saveDocument')).toBe(true)
  expect(operations.admitUpdateOperation('performUpdateAction')).toBe(true)
})
