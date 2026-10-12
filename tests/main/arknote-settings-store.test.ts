import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ArknoteSettingsStore,
  ArknoteSettingsUpdateQueue,
  DEFAULT_ARKNOTE_SETTINGS,
  applyArknotePreferences,
  arknotePreferencesFromSettings,
  parseArknoteSettings,
} from '../../src/main/arknote/arknote-settings-store'

const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), 'arknote-settings-test-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true })))
})

describe('Arknote settings store', () => {
  it('keeps the tray preference across concurrent ordinary edits and a restart', async () => {
    const directory = await root(), store = new ArknoteSettingsStore(directory)
    const queue = new ArknoteSettingsUpdateQueue(await store.load(), value => store.save(value))
    const preferences = arknotePreferencesFromSettings(queue.get())
    await Promise.all([
      queue.update(current => ({ ...current, hideTaskbarIcons: true })),
      queue.update(current => applyArknotePreferences(current, { ...preferences, launchAtLogin: true })),
    ])
    expect(await new ArknoteSettingsStore(directory).load()).toMatchObject({ hideTaskbarIcons: true, launchAtLogin: true })
  })
  it('rejects relative and non-normalized roots', async () => {
    expect(() => new ArknoteSettingsStore('relative/arknote')).toThrow('绝对路径')
    const directory = await root()
    expect(() => new ArknoteSettingsStore(`${directory}${path.sep}child${path.sep}..`))
      .toThrow('规范化')
  })

  it('uses detached defaults when no settings file exists', async () => {
    const store = new ArknoteSettingsStore(await root())
    const first = await store.load()
    first.stickyNotes.colorPresets[0].value = '#000000'

    expect(await store.load()).toEqual(DEFAULT_ARKNOTE_SETTINGS)
    expect(DEFAULT_ARKNOTE_SETTINGS.launchAtLogin).toBe(false)
    expect(first.registerDesktopContextMenu).toBe(true)
  })

  it('preserves a saved desktop menu opt-out', async () => {
    const store = new ArknoteSettingsStore(await root())
    await store.save({ ...DEFAULT_ARKNOTE_SETTINGS, registerDesktopContextMenu: false })
    expect((await store.load()).registerDesktopContextMenu).toBe(false)
  })

  it('strictly rejects extra fields and invalid box bounds', () => {
    expect(parseArknoteSettings({ ...DEFAULT_ARKNOTE_SETTINGS, servicePath: 'secret' }))
      .toBeUndefined()
    expect(parseArknoteSettings({
      ...DEFAULT_ARKNOTE_SETTINGS,
      boxWindowBounds: { x: 0, y: 0, width: 359, height: 480 },
    })).toBeUndefined()
  })

  it('round-trips validated settings as UTF-8 JSON', async () => {
    const directory = await root()
    const store = new ArknoteSettingsStore(directory)
    await store.save({
      ...DEFAULT_ARKNOTE_SETTINGS,
      launchAtLogin: true,
      registerDesktopContextMenu: true,
      boxWindowBounds: { x: -120, y: 30, width: 420, height: 720 },
    })

    await expect(store.load()).resolves.toMatchObject({
      launchAtLogin: true,
      registerDesktopContextMenu: true,
      boxWindowBounds: { x: -120, y: 30, width: 420, height: 720 },
    })
    expect(JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8')))
      .toMatchObject({ schemaVersion: 1 })
  })

  it('backs up malformed JSON and returns defaults', async () => {
    const directory = await root()
    await writeFile(path.join(directory, 'settings.json'), '{broken', 'utf8')
    const store = new ArknoteSettingsStore(directory, () => 123, () => 'backup')

    await expect(store.load()).resolves.toEqual(DEFAULT_ARKNOTE_SETTINGS)
    await expect(readFile(
      path.join(directory, 'settings.corrupt-123-backup.json'),
      'utf8',
    )).resolves.toBe('{broken')
  })

  it('maps the public preference aggregate without losing private window bounds', () => {
    const settings = {
      ...DEFAULT_ARKNOTE_SETTINGS,
      boxWindowBounds: { x: 15, y: 25, width: 500, height: 640 },
    }
    const preferences = arknotePreferencesFromSettings(settings)
    const updated = applyArknotePreferences(settings, {
      ...preferences,
      launchAtLogin: true,
      registerDesktopContextMenu: true,
    })

    expect(updated).toMatchObject({
      launchAtLogin: true,
      registerDesktopContextMenu: true,
      boxWindowBounds: settings.boxWindowBounds,
    })
    expect(updated.boxWindowBounds).not.toBe(settings.boxWindowBounds)
    expect(preferences.stickyNotes).not.toBe(settings.stickyNotes)
    expect(Object.keys(preferences).sort()).toEqual([
      'glassAppearances',
      'launchAtLogin',
      'materialEffects',
      'micaAppearance',
      'registerDesktopContextMenu',
      'startupHintDismissed',
      'stickyNotes',
      'themeColor',
    ])
    expect(preferences).not.toHaveProperty('schemaVersion')
    expect(preferences).not.toHaveProperty('boxWindowBounds')
  })

  it('overlays the in-memory effective theme for a newly opened sticky window', () => {
    const preferences = arknotePreferencesFromSettings(
      DEFAULT_ARKNOTE_SETTINGS,
      '#2563EB',
    )

    expect(preferences.themeColor).toBe('#2563EB')
  })

  it('serializes partial updates so preferences and window bounds cannot overwrite each other', async () => {
    let releaseFirst!: () => void
    const firstPersist = new Promise<void>((resolve) => { releaseFirst = resolve })
    let calls = 0
    const persist = async () => {
      calls += 1
      if (calls === 1) await firstPersist
    }
    const queue = new ArknoteSettingsUpdateQueue(DEFAULT_ARKNOTE_SETTINGS, persist)

    const preferenceUpdate = queue.update((current) => ({ ...current, launchAtLogin: true }))
    const boundsUpdate = queue.update((current) => ({
      ...current,
      boxWindowBounds: { x: 30, y: 40, width: 500, height: 640 },
    }))
    releaseFirst()
    await Promise.all([preferenceUpdate, boundsUpdate])

    expect(queue.get()).toMatchObject({
      launchAtLogin: true,
      boxWindowBounds: { x: 30, y: 40, width: 500, height: 640 },
    })
  })

  it('upgrades settings that predate the startup-hint dismissal field', async () => {
    const directory = await root()
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({
      schemaVersion: 1,
      launchAtLogin: false,
      registerDesktopContextMenu: false,
      stickyNotes: DEFAULT_ARKNOTE_SETTINGS.stickyNotes,
      boxWindowBounds: null,
    }), 'utf8')

    await expect(new ArknoteSettingsStore(directory).load()).resolves.toMatchObject({
      startupHintDismissed: false,
    })
  })
})
