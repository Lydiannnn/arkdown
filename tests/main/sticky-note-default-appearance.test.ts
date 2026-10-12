import { ArknoteSettingsStore, DEFAULT_ARKNOTE_SETTINGS } from '../../src/main/arknote/arknote-settings-store'
import { StickyNoteImporter } from '../../src/main/sticky-notes/sticky-note-importer'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { StickyNoteStore } from '../../src/main/sticky-notes/sticky-note-store'
import { SettingsStore } from '../../src/main/settings/settings-store'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'
import { stickyNotePaths } from '../../src/main/sticky-notes/sticky-note-paths'
import { resolveStickyNoteStyle } from '../../src/renderer/sticky-notes/sticky-note-style'
import { copyStickyNotePreferences, defaultStickyNoteStyle, DEFAULT_STICKY_NOTE_PREFERENCES, parseStickyNotePreferences, type StickyNoteStyleReference } from '../../src/shared/sticky-note-preferences'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function makeRoot() { const root = await mkdtemp(path.join(tmpdir(), 'arknote-default-')); roots.push(root); return root }

it('strictly migrates legacy preferences and copies new creation defaults without changing legacy arrays', () => {
  const original = copyStickyNotePreferences(DEFAULT_STICKY_NOTE_PREFERENCES)
  original.colorPresets[7]!.value = '#123456'
  original.texturePresets[2]!.opacityPercent = 42
  const legacy = { colorPresets: original.colorPresets, texturePresets: original.texturePresets }
  const migrated = parseStickyNotePreferences(legacy)!
  expect(migrated).toEqual({ ...legacy, defaultAppearance: 'mica-light', defaultColor: '#123456' })
  expect(copyStickyNotePreferences(migrated)).toEqual(migrated)
  expect(copyStickyNotePreferences(migrated).texturePresets).not.toBe(migrated.texturePresets)
  expect(defaultStickyNoteStyle({ ...migrated, defaultAppearance: 'color' })).toEqual({ mode: 'independent', color: '#123456', texture: { pattern: 'none', foregroundColor: '#000000', opacityPercent: 0, scalePx: 16 } })
  expect(defaultStickyNoteStyle(migrated)).toEqual({ mode: 'material', materialPresetId: 'mica-light' })
  expect(defaultStickyNoteStyle({ ...migrated, defaultAppearance: 'flowing-glass' })).toEqual({ mode: 'material', materialPresetId: 'flowing-glass' })
  expect(parseStickyNotePreferences({ ...migrated, defaultColor: '#aabbcc' })?.defaultColor).toBe('#AABBCC')
  for (const invalid of [{ ...migrated, defaultAppearance: 'unknown' }, { ...migrated, defaultColor: 'red' }, { ...migrated, extra: true }, { ...legacy, defaultColor: '#FFFFFF' }]) expect(parseStickyNotePreferences(invalid)).toBeUndefined()
})

it('loads valid legacy persisted settings without a corrupt reset and preserves defaults through coordinator writes', async () => {
  const root = await makeRoot()
  const legacy = copyStickyNotePreferences(DEFAULT_STICKY_NOTE_PREFERENCES)
  legacy.colorPresets[7]!.value = '#ABCDEF'
  const stickyNotes = { colorPresets: legacy.colorPresets, texturePresets: legacy.texturePresets }
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({ lastWorkspace: 'preserved-workspace', stickyNotes }), 'utf8')
  const writer = new SettingsStore(root)
  const loaded = await writer.load()
  expect(loaded.lastWorkspace).toBe('preserved-workspace')
  expect(loaded.stickyNotes).toEqual({ ...stickyNotes, defaultAppearance: 'mica-light', defaultColor: '#ABCDEF' })
  expect((await readdir(root)).filter((name) => name.includes('corrupt'))).toEqual([])
  const coordinator = new SettingsCoordinator(writer, loaded)
  await coordinator.update((current) => ({ ...current, stickyNotes: { ...current.stickyNotes!, defaultAppearance: 'color', defaultColor: '#123456' } }))
  expect((await writer.load()).stickyNotes).toEqual(coordinator.get().stickyNotes)
  expect(coordinator.get().stickyNotes).toMatchObject({ defaultAppearance: 'color', defaultColor: '#123456' })
})

it('uses live defaults for future creations and retains records, resolved appearance, content and background images across changes, reset and restart', async () => {
  const root = await makeRoot()
  let preferences = copyStickyNotePreferences(DEFAULT_STICKY_NOTE_PREFERENCES)
  preferences.colorPresets[7]!.value = '#654321'
  preferences.texturePresets[2]!.opacityPercent = 42
  const createStore = () => new StickyNoteStore({ root, getDefaultStyle: () => defaultStickyNoteStyle(preferences) })
  let store = createStore()
  await store.initialize()
  const styles: StickyNoteStyleReference[] = [
    { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
    { mode: 'preset', colorPresetId: 'custom', texturePresetId: 'plain' },
    { mode: 'preset', colorPresetId: 'blue', texturePresetId: 'grid' },
    { mode: 'independent', color: '#FEDCBA', texture: { pattern: 'dots', foregroundColor: '#112233', opacityPercent: 27, scalePx: 20 } },
    { mode: 'material', materialPresetId: 'mica-light' },
    { mode: 'material', materialPresetId: 'flowing-glass' },
  ]
  const notes = []
  for (const [index, style] of styles.entries()) {
    const note = await store.create({ name: `Existing ${index}`, markdown: `Keep body ${index} ![image](resources/keep.svg)`, style })
    const source = path.join(root, `background-${index}.svg`)
    await writeFile(source, '<svg>background unchanged</svg>', 'utf8')
    await store.replaceBackgroundImage(note.record.id, source)
    if (index === 2) await store.archive(note.record.id)
    const preserved = await store.get(note.record.id)
    const paths = stickyNotePaths(root, preserved.record)
    await writeFile(path.join(paths.resources, 'keep.svg'), '<svg>unchanged</svg>', 'utf8')
    notes.push(preserved)
  }
  const appearances = notes.map((note) => resolveStickyNoteStyle(note.record.style, preferences))
  preferences = { ...preferences, defaultAppearance: 'color', defaultColor: '#123456' }
  const colorNote = await store.create({ name: 'Snapshot' })
  expect(colorNote.record.style).toEqual({ mode: 'independent', color: '#123456', texture: { pattern: 'none', foregroundColor: '#000000', opacityPercent: 0, scalePx: 16 } })
  notes.push(colorNote)
  appearances.push(resolveStickyNoteStyle(colorNote.record.style, preferences))
  for (const defaults of [{ defaultAppearance: 'color' as const, defaultColor: '#ABCDEF' }, { defaultAppearance: 'flowing-glass' as const, defaultColor: '#ABCDEF' }, { defaultAppearance: 'mica-light' as const, defaultColor: '#FFFFFF' }]) {
    preferences = { ...preferences, ...defaults }
    const created = await store.create({ name: `Next ${defaults.defaultAppearance}` })
    expect(created.record.style).toEqual(defaultStickyNoteStyle(preferences))
    store = createStore()
    await store.initialize()
    for (const [index, note] of notes.entries()) {
      const reloaded = await store.get(note.record.id)
      expect(reloaded).toEqual(note)
      expect(resolveStickyNoteStyle(reloaded.record.style, preferences)).toEqual(appearances[index])
      if (index < styles.length) expect(await readFile((await store.resolveBackgroundImagePath(note.record.id))!, 'utf8')).toBe('<svg>background unchanged</svg>')
      if (index < styles.length) expect(await readFile(path.join(stickyNotePaths(root, note.record).resources, 'keep.svg'), 'utf8')).toBe('<svg>unchanged</svg>')
    }
  }
  const explicit = await store.create({ name: 'Explicit wins', style: styles[3]! })
  expect(explicit.record.style).toEqual(styles[3])
})

it('migrates valid standalone persisted preferences without corrupt recovery and imports with live defaults', async () => {
  const root = await makeRoot()
  const original = copyStickyNotePreferences(DEFAULT_STICKY_NOTE_PREFERENCES)
  original.colorPresets[7]!.value = '#ABCDEF'
  const settingsStore = new ArknoteSettingsStore(root)
  await settingsStore.save({ ...DEFAULT_ARKNOTE_SETTINGS, launchAtLogin: true, stickyNotes: original })
  const file = settingsStore.filePath
  const persisted = JSON.parse(await readFile(file, 'utf8'))
  delete persisted.stickyNotes.defaultAppearance
  delete persisted.stickyNotes.defaultColor
  await writeFile(file, JSON.stringify(persisted), 'utf8')
  const loaded = await settingsStore.load()
  expect(loaded.launchAtLogin).toBe(true)
  expect(loaded.stickyNotes).toEqual({ ...original, defaultColor: '#ABCDEF' })
  expect((await readdir(root)).filter(name => name.includes('corrupt'))).toEqual([])
  let preferences = loaded.stickyNotes
  const store = new StickyNoteStore({ root, getDefaultStyle: () => defaultStickyNoteStyle(preferences) })
  await store.initialize()
  const importer = new StickyNoteImporter({ root, store })
  for (const mode of ['color', 'flowing-glass'] as const) {
    preferences = { ...preferences, defaultAppearance: mode }
    await importer.importMarkdown({ suggestedName: mode, markdown: 'Imported body', sourceDirectory: null })
    const summary = (await store.list('active')).find(note => note.record.name === mode)!
    expect(summary.record.style).toEqual(defaultStickyNoteStyle(preferences))
    expect((await store.get(summary.record.id)).markdown).toBe('Imported body')
  }
})
