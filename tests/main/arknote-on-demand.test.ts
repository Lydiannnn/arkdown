import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ArknoteClientRuntime } from '../../src/main/arknote/arknote-client-runtime'
import { createArknotePreferencesClient } from '../../src/main/arknote/arknote-preferences-client'
import { DEFAULT_ARKNOTE_SETTINGS } from '../../src/main/arknote/arknote-settings-store'
import { DEFAULT_ARKNOTE_PREFERENCES } from '../../src/shared/arknote-preferences'
import { DEFAULT_EDITOR_APPEARANCE } from '../../src/shared/editor-appearance-preferences'
import { DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES } from '../../src/shared/desktop-lifecycle-preferences'
import { initializeArknoteOnDemand, readArknoteSettingsSnapshot } from '../../src/main/arknote/arknote-on-demand'

const roots: string[] = []
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), 'arknote-on-demand-')); roots.push(root); return root }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('ordinary startup with an enabled desktop menu does not launch the note service', async () => {
  const start = vi.fn(async () => {})
  await initializeArknoteOnDemand(async () => ({ ...DEFAULT_ARKNOTE_SETTINGS, launchAtLogin: false }), start)
  expect(start).not.toHaveBeenCalled()
})

it('honors an existing autostart opt-in', async () => {
  const start = vi.fn(async () => {})
  await initializeArknoteOnDemand(async () => ({ ...DEFAULT_ARKNOTE_SETTINGS, launchAtLogin: true }), start)
  expect(start).toHaveBeenCalledOnce()
})

it('does not restore a desktop menu that the user disabled', async () => {
  const start = vi.fn(async () => {})
  await initializeArknoteOnDemand(async () => ({ ...DEFAULT_ARKNOTE_SETTINGS, launchAtLogin: false, registerDesktopContextMenu: false }), start)
  expect(start).not.toHaveBeenCalled()
})

it('viewing preferences and previewing a theme do not start a disconnected runtime', async () => {
  const root = await fixture()
  const launch = vi.fn()
  const runtime = new ArknoteClientRuntime({ executablePath: path.join(root, 'Arkdown.exe'), launch })
  try {
    const bridge = createArknotePreferencesClient(runtime, async () => ({ ...DEFAULT_ARKNOTE_SETTINGS, themeColor: '#123456' }))
    expect((await bridge.get()).themeColor).toBe('#123456')
    await runtime.requestIfConnected('settings.preview-theme', { themeColor: '#ABCDEF' }, value => value === null ? null : undefined)
    expect(launch).not.toHaveBeenCalled()
    expect(runtime.isConnected).toBe(false)
  } finally { runtime.dispose() }
})

it('a user settings edit uses the live service and preserves the omitted current material fields', async () => {
  const current = { ...DEFAULT_ARKNOTE_SETTINGS, micaAppearance: { ...DEFAULT_ARKNOTE_SETTINGS.micaAppearance, tintOpacity: 0.47 } }
  const request = vi.fn(async (_command, payload, parser) => parser(_command === 'settings.get' ? current : payload))
  const readOffline = vi.fn(async () => DEFAULT_ARKNOTE_SETTINGS)
  const bridge = createArknotePreferencesClient({ request }, readOffline)
  const saved = await bridge.set({ ...DEFAULT_ARKNOTE_PREFERENCES, launchAtLogin: true, micaAppearance: current.micaAppearance })
  expect(saved.launchAtLogin).toBe(true)
  expect(saved.micaAppearance.tintOpacity).toBe(0.47)
  expect(request.mock.calls.map(call => call[0])).toEqual(['settings.get', 'settings.set'])
  expect(readOffline).not.toHaveBeenCalled()
})

it('reads defaults without creating a service profile', async () => {
  const root = await fixture()
  expect(await readArknoteSettingsSnapshot(root)).toEqual(DEFAULT_ARKNOTE_SETTINGS)
  expect(await readdir(root)).toEqual([])
})

it('previews legacy settings without performing migrations or changing the source file', async () => {
  const root = await fixture()
  await mkdir(path.join(root, 'portable-data'))
  const file = path.join(root, 'portable-data/settings.json')
  const legacy = JSON.stringify({ appearance: { ...DEFAULT_EDITOR_APPEARANCE, themeColor: '#123456' }, desktopLifecycle: { ...DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES, launchAtLogin: true } })
  await writeFile(file, legacy)
  const snapshot = await readArknoteSettingsSnapshot(root)
  expect(snapshot.themeColor).toBe('#123456')
  expect(snapshot.launchAtLogin).toBe(true)
  expect(await readFile(file, 'utf8')).toBe(legacy)
  expect(await readdir(path.join(root, 'portable-data'))).toEqual(['settings.json'])
})

it('prefers the current saved profile and leaves corrupt profiles untouched', async () => {
  const root = await fixture()
  const folder = path.join(root, 'portable-data/arknote')
  await mkdir(folder, { recursive: true })
  const file = path.join(folder, 'settings.json')
  await writeFile(file, '\uFEFF' + JSON.stringify({ ...DEFAULT_ARKNOTE_SETTINGS, launchAtLogin: true }))
  expect((await readArknoteSettingsSnapshot(root)).launchAtLogin).toBe(true)
  await writeFile(file, '{broken')
  expect(await readArknoteSettingsSnapshot(root)).toEqual(DEFAULT_ARKNOTE_SETTINGS)
  expect(await readFile(file, 'utf8')).toBe('{broken')
  expect(await readdir(folder)).toEqual(['settings.json'])
})

it('keeps a valid pre-theme profile readable when legacy settings are corrupt', async () => {
  const root = await fixture()
  const folder = path.join(root, 'portable-data/arknote')
  await mkdir(folder, { recursive: true })
  const { themeColor: _unused, ...preTheme } = { ...DEFAULT_ARKNOTE_SETTINGS, launchAtLogin: true }
  await writeFile(path.join(folder, 'settings.json'), JSON.stringify(preTheme))
  await writeFile(path.join(root, 'portable-data/settings.json'), '{broken')
  expect(await readArknoteSettingsSnapshot(root)).toMatchObject({ launchAtLogin: true, themeColor: DEFAULT_ARKNOTE_SETTINGS.themeColor })
})
