import { expect, it, vi } from 'vitest'
import { createIpcOperations, registerIpcHandlers } from '../../src/main/ipc/register-ipc'
import { IPC_CHANNELS } from '../../src/shared/contracts'

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    chooseDirectory: vi.fn(async () => null),
    workspace: {},
    documents: {},
    getLastWorkspace: () => null,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
    ...overrides,
  } as never
}

const menuState = {
  hasPrintableDocument: true,
  spellCheckEnabled: false,
  showEditIndicators: true,
  editorZoomPercent: 100,
  fullscreen: false,
}

it('validates and delegates recent records and exact application-menu window state', async () => {
  const recordRecentDocument = vi.fn(async () => ['C:\\Docs\\one.md'])
  const updateApplicationMenuWindowState = vi.fn()
  const operations = createIpcOperations(dependencies({
    recordRecentDocument,
    updateApplicationMenuWindowState,
  }))

  await expect(operations.recordRecentDocument({ absolutePath: 'C:\\Docs\\one.md' }))
    .resolves.toEqual({ ok: true, value: ['C:\\Docs\\one.md'] })
  await expect(operations.updateApplicationMenuWindowState(menuState))
    .resolves.toEqual({ ok: true, value: undefined })
  await expect(operations.recordRecentDocument({ absolutePath: 'relative.md' }))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  await expect(operations.updateApplicationMenuWindowState({ ...menuState, secret: true }))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(recordRecentDocument).toHaveBeenCalledOnce()
  expect(updateApplicationMenuWindowState).toHaveBeenCalledOnce()
})

it('routes menu-state updates only through the registered sender session', async () => {
  const handlers = new Map<string, (event: unknown, input?: unknown) => Promise<unknown>>()
  const ipcMain = {
    handle: vi.fn((channel: string, handler: typeof handlers extends Map<string, infer T> ? T : never) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn(),
  }
  const firstContents = { mainFrame: {} }
  const secondContents = { mainFrame: {} }
  const firstUpdate = vi.fn()
  const secondUpdate = vi.fn()
  const firstOperations = createIpcOperations(dependencies({
    updateApplicationMenuWindowState: firstUpdate,
  }))
  const secondOperations = createIpcOperations(dependencies({
    updateApplicationMenuWindowState: secondUpdate,
  }))
  const first = registerIpcHandlers({
    ipcMain,
    window: { webContents: firstContents },
    operations: firstOperations,
  })
  const second = registerIpcHandlers({
    ipcMain,
    window: { webContents: secondContents },
    operations: secondOperations,
  })
  const handler = handlers.get(IPC_CHANNELS.updateApplicationMenuWindowState)!

  await handler({ sender: firstContents, senderFrame: firstContents.mainFrame }, menuState)
  await handler({ sender: secondContents, senderFrame: secondContents.mainFrame }, {
    ...menuState,
    fullscreen: true,
  })
  const untrusted = await handler({ sender: {}, senderFrame: firstContents.mainFrame }, menuState)

  expect(firstUpdate).toHaveBeenCalledWith(menuState)
  expect(secondUpdate).toHaveBeenCalledWith({ ...menuState, fullscreen: true })
  expect(untrusted).toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })
  first.dispose()
  second.dispose()
})
