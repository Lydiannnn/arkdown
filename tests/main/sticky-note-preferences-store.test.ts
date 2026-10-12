import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsStore } from '../../src/main/settings/settings-store'
import {
  DEFAULT_STICKY_NOTE_PREFERENCES,
  copyStickyNotePreferences,
} from '../../src/shared/sticky-note-preferences'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) =>
  rm(root, { recursive: true, force: true }))))

describe('sticky note preferences store', () => {
  it('round-trips all seven colors and textures', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arkdown-sticky-prefs-'))
    roots.push(root)
    const store = new SettingsStore(root)
    const stickyNotes = copyStickyNotePreferences(DEFAULT_STICKY_NOTE_PREFERENCES)
    stickyNotes.colorPresets[0]!.value = '#123456'
    stickyNotes.texturePresets[1]!.opacityPercent = 27

    await store.save({ lastWorkspace: null, stickyNotes })

    expect((await store.load()).stickyNotes).toEqual(stickyNotes)
    expect(JSON.parse(await readFile(store.filePath, 'utf8')).stickyNotes)
      .toEqual(stickyNotes)
  })

  it('falls back to every default when settings contain extra or damaged entries', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arkdown-sticky-prefs-'))
    roots.push(root)
    await writeFile(path.join(root, 'settings.json'), JSON.stringify({
      lastWorkspace: null,
      stickyNotes: {
        ...copyStickyNotePreferences(DEFAULT_STICKY_NOTE_PREFERENCES),
        unexpected: true,
      },
    }), 'utf8')

    expect((await new SettingsStore(root).load()).stickyNotes)
      .toEqual(DEFAULT_STICKY_NOTE_PREFERENCES)
  })
})
