import { describe, expect, it, vi } from 'vitest'
import {
  registerArknoteBoxWindowIpc,
  registerArknoteSettingsWindowIpc,
  registerStickyNoteWindowIpc,
} from '../../src/main/ipc/register-ipc'
import { DEFAULT_ARKNOTE_PREFERENCES } from '../../src/shared/arknote-preferences'
import { IPC_CHANNELS } from '../../src/shared/contracts'
import { createArknoteStickyNoteLinkOpener } from '../../src/main/arknote/arknote-link-opener'

function registrar() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  }
}

describe('standalone Arknote window IPC', () => {
  it('allows only the box main frame to flush and close a note without granting content writes', async () => {
    const ipcMain = registrar()
    const mainFrame = {}
    const webContents = { id: 31, mainFrame }
    const close = vi.fn(async () => undefined)
    const flushSave = vi.fn(async () => true)
    registerArknoteBoxWindowIpc({ ipcMain, window: { webContents },
      stickyNotes: { close, flushSave } as never,
      getStickyNotePreferences: () => DEFAULT_ARKNOTE_PREFERENCES.stickyNotes })
    const noteId = '00000000-0000-4000-8000-000000000001'
    const event = { sender: webContents, senderFrame: mainFrame }
    for (const channel of [IPC_CHANNELS.flushStickyNoteSave, IPC_CHANNELS.closeStickyNote]) {
      const handler = ipcMain.handlers.get(channel)!
      await expect(handler(event, { noteId })).resolves.toMatchObject({ ok: true })
      await expect(handler({ ...event, sender: { id: 99 } }, { noteId })).resolves.toMatchObject({ ok: false })
      await expect(handler({ ...event, senderFrame: {} }, { noteId })).resolves.toMatchObject({ ok: false })
    }
    expect(close).toHaveBeenCalledExactlyOnceWith(noteId)
    expect(flushSave).toHaveBeenCalledExactlyOnceWith(noteId)
    await expect(ipcMain.handlers.get(IPC_CHANNELS.stageStickyNoteSave)!(event, { noteId, markdown: 'synthetic' }))
      .resolves.toMatchObject({ ok: false })
  })
  it('allows the box window to search notes through its restricted IPC surface', async () => {
    const ipcMain = registrar()
    const mainFrame = {}
    const webContents = { id: 9, mainFrame }
    const search = vi.fn(async () => [{
      noteId: '00000000-0000-4000-8000-000000000001',
      name: '计划',
      excerpt: '命中内容',
      archivedAt: null,
    }])
    registerArknoteBoxWindowIpc({
      ipcMain,
      window: { webContents },
      stickyNotes: { search } as never,
      getStickyNotePreferences: () => DEFAULT_ARKNOTE_PREFERENCES.stickyNotes,
    })

    const result = await ipcMain.handlers.get(IPC_CHANNELS.searchStickyNotes)?.(
      { sender: webContents, senderFrame: mainFrame },
      { status: 'active', query: '内容' },
    )

    expect(result).toEqual({ ok: true, value: [{
      noteId: '00000000-0000-4000-8000-000000000001',
      name: '计划',
      excerpt: '命中内容',
      archivedAt: null,
    }] })
    expect(search).toHaveBeenCalledWith({ status: 'active', query: '内容' })
    await expect(ipcMain.handlers.get(IPC_CHANNELS.stageStickyNoteSave)?.(
      { sender: webContents, senderFrame: mainFrame },
      { noteId: '00000000-0000-4000-8000-000000000001', markdown: 'forbidden' },
    )).resolves.toMatchObject({ ok: false })
    await expect(ipcMain.handlers.get(IPC_CHANNELS.setArknotePreferences)?.(
      { sender: webContents, senderFrame: mainFrame }, DEFAULT_ARKNOTE_PREFERENCES,
    )).resolves.toMatchObject({ ok: false })
  })

  it('reads and writes the standalone Arknote preference aggregate', async () => {
    const ipcMain = registrar()
    const mainFrame = {}
    const webContents = { id: 10, mainFrame }
    const setArknotePreferences = vi.fn(async (value) => value)
    registerArknoteSettingsWindowIpc({
      ipcMain,
      window: { webContents },
      getArknotePreferences: () => DEFAULT_ARKNOTE_PREFERENCES,
      setArknotePreferences,
    })
    const event = { sender: webContents, senderFrame: mainFrame }

    await expect(ipcMain.handlers.get(IPC_CHANNELS.getArknotePreferences)?.(event))
      .resolves.toEqual({ ok: true, value: DEFAULT_ARKNOTE_PREFERENCES })
    await expect(ipcMain.handlers.get(IPC_CHANNELS.setArknotePreferences)?.(
      event, DEFAULT_ARKNOTE_PREFERENCES,
    )).resolves.toEqual({ ok: true, value: DEFAULT_ARKNOTE_PREFERENCES })
    expect(setArknotePreferences).toHaveBeenCalledWith(DEFAULT_ARKNOTE_PREFERENCES)
    await expect(ipcMain.handlers.get(IPC_CHANNELS.searchStickyNotes)?.(
      event, { status: 'active', query: 'forbidden' },
    )).resolves.toMatchObject({ ok: false })
  })
})


it('does not expose sticky-note line spacing to the Arknote settings window', async () => {
  const ipcMain = registrar()
  const mainFrame = {}
  const webContents = { id: 11, mainFrame }
  registerArknoteSettingsWindowIpc({
    ipcMain,
    window: { webContents },
    getArknotePreferences: () => DEFAULT_ARKNOTE_PREFERENCES,
    setArknotePreferences: async (value) => ({ ...DEFAULT_ARKNOTE_PREFERENCES, ...value }),
  })

  const handler = ipcMain.handlers.get(IPC_CHANNELS.setStickyNoteLineSpacingMode)
  expect(handler).toBeDefined()
  await expect(handler?.(
    { sender: webContents, senderFrame: mainFrame },
    { noteId: '00000000-0000-4000-8000-000000000001', lineSpacingMode: 'compact' },
  )).resolves.toMatchObject({ ok: false })
})


it('exposes sticky-note line spacing to the sticky-note window', async () => {
  const ipcMain = registrar()
  const mainFrame = {}
  const webContents = { id: 12, mainFrame }
  const setLineSpacingMode = vi.fn(async () => undefined)
  registerStickyNoteWindowIpc({
    ipcMain,
    window: { webContents },
    stickyNotes: { setLineSpacingMode } as never,
  })

  const handler = ipcMain.handlers.get(IPC_CHANNELS.setStickyNoteLineSpacingMode)
  expect(handler).toBeDefined()
  await expect(handler?.(
    { sender: webContents, senderFrame: mainFrame },
    { noteId: '00000000-0000-4000-8000-000000000001', lineSpacingMode: 'standard' },
  )).resolves.toEqual({ ok: true, value: null })
  expect(setLineSpacingMode).toHaveBeenCalledWith(
    '00000000-0000-4000-8000-000000000001',
    'standard',
  )
})

it('opens a validated link only from its owning sticky-note window', async () => {
  const ipcMain = registrar()
  const mainFrame = {}
  const webContents = { id: 16, mainFrame }
  const openExternal = vi.fn(async () => undefined)
  registerStickyNoteWindowIpc({
    ipcMain,
    window: { webContents },
    stickyNotes: {} as never,
    openExternal,
  })

  const handler = ipcMain.handlers.get(IPC_CHANNELS.openExternal)
  expect(handler).toBeDefined()
  await expect(handler?.(
    { sender: webContents, senderFrame: mainFrame },
    { target: 'C:\\Notes\\linked file.txt' },
  )).resolves.toEqual({ ok: true, value: null })
  expect(openExternal).toHaveBeenCalledWith('C:\\Notes\\linked file.txt')

  await expect(handler?.(
    { sender: { id: 999 }, senderFrame: mainFrame },
    { target: 'https://example.com' },
  )).resolves.toMatchObject({ ok: false })
  expect(openExternal).toHaveBeenCalledTimes(1)
})

it('uses the sticky-note window as the focus owner and compensates a failed launch', async () => {
  const ipcMain = registrar()
  const mainFrame = {}
  const webContents = { id: 17, mainFrame }
  const owner = {
    webContents,
    blur: vi.fn(),
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
  }
  const openExternal = vi.fn(async () => undefined)
  registerStickyNoteWindowIpc({
    ipcMain,
    window: owner,
    stickyNotes: {} as never,
    openExternal: createArknoteStickyNoteLinkOpener(owner, {
      realpath: vi.fn(async (value: string) => value),
      openExternal,
      openPath: vi.fn(async () => ''),
    }),
  })
  const handler = ipcMain.handlers.get(IPC_CHANNELS.openExternal)!
  const event = { sender: webContents, senderFrame: mainFrame }

  await expect(handler(event, { target: 'https://example.com/success' }))
    .resolves.toEqual({ ok: true, value: null })
  expect(owner.blur).toHaveBeenCalledOnce()
  expect(owner.focus).not.toHaveBeenCalled()

  openExternal.mockRejectedValueOnce(new Error('launch failed'))
  await expect(handler(event, { target: 'https://example.com/failure' }))
    .resolves.toMatchObject({ ok: false })
  expect(owner.blur).toHaveBeenCalledTimes(2)
  expect(owner.focus).toHaveBeenCalledOnce()
})

it('allows archived batch deletion only from the Arknote box window', async () => {
  const noteIds = ['00000000-0000-4000-8000-000000000001']
  const deleteArchived = vi.fn(async () => undefined)

  const boxIpc = registrar()
  const boxFrame = {}
  const boxSender = { id: 13, mainFrame: boxFrame }
  registerArknoteBoxWindowIpc({
    ipcMain: boxIpc,
    window: { webContents: boxSender },
    stickyNotes: { deleteArchived } as never,
    getStickyNotePreferences: () => DEFAULT_ARKNOTE_PREFERENCES.stickyNotes,
  })
  const boxHandler = boxIpc.handlers.get(
    IPC_CHANNELS.deleteArchivedStickyNotes,
  )
  expect(boxHandler).toBeDefined()
  await expect(boxHandler?.(
    { sender: boxSender, senderFrame: boxFrame },
    { noteIds },
  )).resolves.toEqual({ ok: true, value: null })
  expect(deleteArchived).toHaveBeenCalledWith(noteIds)

  const stickyIpc = registrar()
  const stickyFrame = {}
  const stickySender = { id: 14, mainFrame: stickyFrame }
  registerStickyNoteWindowIpc({
    ipcMain: stickyIpc,
    window: { webContents: stickySender },
    stickyNotes: { deleteArchived } as never,
  })
  const stickyHandler = stickyIpc.handlers.get(
    IPC_CHANNELS.deleteArchivedStickyNotes,
  )
  expect(stickyHandler).toBeDefined()
  await expect(stickyHandler?.(
    { sender: stickySender, senderFrame: stickyFrame },
    { noteIds },
  )).resolves.toMatchObject({ ok: false })

  const settingsIpc = registrar()
  const settingsFrame = {}
  const settingsSender = { id: 15, mainFrame: settingsFrame }
  registerArknoteSettingsWindowIpc({
    ipcMain: settingsIpc,
    window: { webContents: settingsSender },
    getArknotePreferences: () => DEFAULT_ARKNOTE_PREFERENCES,
    setArknotePreferences: async (value) => ({ ...DEFAULT_ARKNOTE_PREFERENCES, ...value }),
  })
  const settingsHandler = settingsIpc.handlers.get(
    IPC_CHANNELS.deleteArchivedStickyNotes,
  )
  expect(settingsHandler).toBeDefined()
  await expect(settingsHandler?.(
    { sender: settingsSender, senderFrame: settingsFrame },
    { noteIds },
  )).resolves.toMatchObject({ ok: false })

  expect(deleteArchived).toHaveBeenCalledTimes(1)
})
