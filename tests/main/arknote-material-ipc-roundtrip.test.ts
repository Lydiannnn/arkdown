import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { registerArknoteSettingsWindowIpc } from '../../src/main/ipc/register-ipc'
import { createArknotePreferencesClient } from '../../src/main/arknote/arknote-preferences-client'
import { ArknoteCommandRouter } from '../../src/main/arknote/arknote-command-router'
import { ArknoteFrameDecoder, encodeArknoteFrame, type ArknoteCommand } from '../../src/shared/arknote-protocol'
import { ArknoteSettingsUpdateQueue, DEFAULT_ARKNOTE_SETTINGS, saveArknoteSettingsUpdate } from '../../src/main/arknote/arknote-settings-store'
import { DEFAULT_ARKNOTE_PREFERENCES, arknotePreferencesForUpdate } from '../../src/shared/arknote-preferences'
import { copyStickyNoteWallpaperAppearances } from '../../src/shared/sticky-note-glass-appearance'
import { IPC_CHANNELS } from '../../src/shared/contracts'

function setup() {
  const queue = new ArknoteSettingsUpdateQueue(DEFAULT_ARKNOTE_SETTINGS, async () => {})
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const webContents = { id: 22, mainFrame: {} }
  const ipcMain = { handle: (channel: string, handler: never) => handlers.set(channel, handler), removeHandler: (channel: string) => { handlers.delete(channel) } }
  const router = new ArknoteCommandRouter({ executeLaunchCommand: async () => {}, quit: async () => {},
    settings: { get: () => queue.get(), set: input => saveArknoteSettingsUpdate(queue, input) } })
  const payloads: unknown[] = []
  let beforeSet: (() => Promise<void>) | undefined
  const client = createArknotePreferencesClient({
    async request<T>(command: ArknoteCommand, payload: unknown, parser: (value: unknown) => T | undefined): Promise<T> {
      if (command === 'settings.set') { payloads.push(payload); await beforeSet?.() }
      const decoded = new ArknoteFrameDecoder().push(encodeArknoteFrame(payload))[0]
      const value = parser(await router.handle(command, decoded))
      if (value === undefined) throw new Error('Invalid service response')
      return value
    },
  })
  const preview = vi.fn(async input => input ?? copyStickyNoteWallpaperAppearances(queue.get()))
  registerArknoteSettingsWindowIpc({ ipcMain, window: { webContents },
    getArknotePreferences: client.get, setArknotePreferences: client.set,
    previewStickyNoteWallpaperAppearances: preview })
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: webContents, senderFrame: webContents.mainFrame }, ...args)
  const api = createArkdownApi(invoke)
  return { queue, api, payloads, handlers, webContents, preview, beforeSet: (hook: () => Promise<void>) => { beforeSet = hook } }
}

it('keeps a newer service material save through a legacy preload → IPC → pipe write', async () => {
  const fixture = setup()
  fixture.beforeSet(async () => {
    await fixture.queue.update(current => ({ ...current,
      micaAppearance: { ...current.micaAppearance, tintOpacity: 0.8765 },
      materialEffects: { ...current.materialEffects,
        'clear-glass': { ...current.materialEffects['clear-glass'], transparency: 0.2345 } },
    }))
  })
  const result = await fixture.api.setArknotePreferences!(arknotePreferencesForUpdate(DEFAULT_ARKNOTE_PREFERENCES, { launchAtLogin: true }))
  expect(result).toMatchObject({ ok: true, value: {
    launchAtLogin: true, micaAppearance: { tintOpacity: 0.8765 },
    materialEffects: { 'clear-glass': { transparency: 0.2345 } },
  } })
  for (const key of ['micaAppearance', 'glassAppearances', 'materialEffects']) expect(fixture.payloads[0]).not.toHaveProperty(key)
})

it('accepts an explicit complete material snapshot from the main preference path', async () => {
  const fixture = setup()
  const next = copyStickyNoteWallpaperAppearances(DEFAULT_ARKNOTE_PREFERENCES)
  next.glassAppearances['clear-glass'].luminosityOpacity = 0.7654
  next.materialEffects['flowing-glass'].borderHidden = false
  const result = await fixture.api.setArknotePreferences!({ ...DEFAULT_ARKNOTE_PREFERENCES, ...next })
  expect(result).toMatchObject({ ok: true, value: {
    glassAppearances: { 'clear-glass': { luminosityOpacity: 0.7654 } },
    materialEffects: { 'flowing-glass': { borderHidden: false } },
  } })
  expect(fixture.payloads[0]).toMatchObject(next)
})

it('validates full previews and authorizes only the owning main frame without writing settings', async () => {
  const fixture = setup()
  const before = fixture.queue.get()
  const draft = copyStickyNoteWallpaperAppearances(before)
  draft.materialEffects['clear-glass'].transparency = 0.91
  await expect(fixture.api.previewStickyNoteWallpaperAppearances!(draft)).resolves.toEqual({ ok: true, value: draft })
  await expect(fixture.api.previewStickyNoteWallpaperAppearances!(null)).resolves.toEqual({ ok: true, value: copyStickyNoteWallpaperAppearances(before) })
  expect(fixture.queue.get()).toEqual(before)
  const handler = fixture.handlers.get(IPC_CHANNELS.previewStickyNoteWallpaperAppearances)!
  for (const event of [{ sender: {}, senderFrame: {} }, { sender: fixture.webContents, senderFrame: {} }]) {
    await expect(handler(event, draft)).resolves.toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })
  }
  const owner = { sender: fixture.webContents, senderFrame: fixture.webContents.mainFrame }
  for (const invalid of [undefined, {}, { ...draft, materialEffects: undefined }]) {
    await expect(handler(owner, invalid)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  }
  expect(fixture.preview).toHaveBeenCalledTimes(2)
})
