import { expect, it, vi } from 'vitest'
import { createIpcOperations, registerMermaidViewerWindowIpc } from '../../src/main/ipc/register-ipc'
import { IPC_CHANNELS } from '../../src/shared/contracts'

const snapshot = { svgDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', colorScheme: 'light' as const, themeColor: '#336699' }
function dependencies() {
  return { chooseDirectory: vi.fn(), workspace: {} as never, documents: {} as never, getLastWorkspace: () => null, setLastWorkspace: vi.fn(), reportError: vi.fn(), openMermaidViewer: vi.fn(async () => undefined), getMermaidViewerSnapshot: () => snapshot }
}
it('opens bounded snapshots and rejects extra file path arguments before any window side effect', async () => {
  const deps = dependencies()
  const ops = createIpcOperations(deps)
  await expect(ops.openMermaidViewer?.(snapshot)).resolves.toEqual({ ok: true, value: null })
  expect(deps.openMermaidViewer).toHaveBeenCalledExactlyOnceWith(snapshot)
  await expect(ops.openMermaidViewer?.({ ...snapshot, path: 'C:/private' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(deps.openMermaidViewer).toHaveBeenCalledTimes(1)
})
it('reads only a main-owned snapshot without accepting renderer supplied paths', async () => {
  const ops = createIpcOperations(dependencies())
  await expect(ops.getMermaidViewerSnapshot?.()).resolves.toEqual({ ok: true, value: snapshot })
  await expect(ops.getMermaidViewerSnapshot?.({ path: 'C:/private' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
})

it('limits the viewer main frame to its own snapshot and window controls, excluding editor operations', async () => {
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>()
  const ipcMain = { handle: (channel: string, handler: (...args: any[]) => Promise<unknown>) => { handlers.set(channel, handler) }, removeHandler: (channel: string) => { handlers.delete(channel) } }
  const webContents = { mainFrame: {} }
  const state = { maximized: false, fullscreen: false, revision: 0 }
  const registration = registerMermaidViewerWindowIpc({ ipcMain, window: { webContents }, getMermaidViewerSnapshot: () => snapshot, controlWindow: () => state, getWindowState: () => state })
  try {
    const event = { sender: webContents, senderFrame: webContents.mainFrame }
    await expect(handlers.get(IPC_CHANNELS.getMermaidViewerSnapshot)!(event)).resolves.toEqual({ ok: true, value: snapshot })
    for (const foreign of [{ sender: {}, senderFrame: webContents.mainFrame }, { sender: webContents, senderFrame: {} }]) {
      await expect(handlers.get(IPC_CHANNELS.getMermaidViewerSnapshot)!(foreign)).resolves.toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })
    }
    for (const channel of [IPC_CHANNELS.openMermaidViewer, IPC_CHANNELS.saveDraft, IPC_CHANNELS.chooseWorkspace]) {
      await expect(handlers.get(channel)!(event, snapshot)).resolves.toMatchObject({ ok: false })
    }
  } finally { registration.dispose() }
})
