import { createHash } from 'node:crypto'
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  migrateEmbeddedArknoteSettings,
  migrateEmbeddedStickyNotes,
} from '../../src/main/arknote/arknote-data-migration'
import { DEFAULT_ARKNOTE_SETTINGS } from '../../src/main/arknote/arknote-settings-store'
import { DEFAULT_EDITOR_APPEARANCE } from '../../src/shared/editor-appearance-preferences'
import { DEFAULT_STICKY_NOTE_PREFERENCES } from '../../src/shared/sticky-note-preferences'

const roots: string[] = []
const NOTE_ID = '9b6d8d86-7a68-4cab-951c-6a25e09dd14b'
const CREATED_AT = '2026-07-31T00:00:00.000Z'
const MIGRATION_MARKER_NAME = '.embedded-migration.json'

async function temporaryRoot(prefix: string): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), prefix))
  roots.push(value)
  return value
}

async function writeLegacyData(legacyRoot: string): Promise<void> {
  const noteDirectory = path.join(legacyRoot, 'notes', 'active', NOTE_ID)
  await mkdir(path.join(noteDirectory, 'resources'), { recursive: true })
  await writeFile(path.join(noteDirectory, '旧便签.md'), '# 迁移内容', 'utf8')
  await writeFile(path.join(legacyRoot, 'notes', 'index.json'), JSON.stringify({
    schemaVersion: 1,
    notes: [{
      id: NOTE_ID,
      name: '旧便签',
      status: 'active',
      markdownRelativePath: `active/${NOTE_ID}/旧便签.md`,
      resourcesRelativePath: `active/${NOTE_ID}/resources`,
      style: { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      archivedAt: null,
      released: true,
      pinned: false,
      windowBounds: null,
      lastOpenedAt: CREATED_AT,
    }],
    openNoteIdsAtLastSession: [NOTE_ID],
    defaultHelpNoteCreated: true,
  }), 'utf8')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true })))
})

describe('embedded sticky note migration', () => {
  it('keeps legacy notes on the first migrated call and cleans the same source on the next call', async () => {
    const container = await temporaryRoot('arknote-portable-layout-')
    const legacyRoot = path.join(container, 'portable-data')
    const arknoteRoot = path.join(legacyRoot, 'arknote')
    await mkdir(legacyRoot)
    await writeLegacyData(legacyRoot)
    const legacyIndex = await readFile(path.join(legacyRoot, 'notes', 'index.json'))
    const legacyIndexSha256 = createHash('sha256').update(legacyIndex).digest('hex')

    await expect(migrateEmbeddedStickyNotes({ legacyRoot, arknoteRoot }))
      .resolves.toBe('migrated')

    const index = JSON.parse(await readFile(path.join(arknoteRoot, 'notes', 'index.json'), 'utf8'))
    expect(index).toMatchObject({
      schemaVersion: 5,
      notes: [{ id: NOTE_ID, fontSizePx: 14, lineSpacingMode: 'compact' }],
    })
    expect(JSON.parse(await readFile(
      path.join(arknoteRoot, 'notes', MIGRATION_MARKER_NAME),
      'utf8',
    ))).toEqual({ schemaVersion: 1, legacyIndexSha256 })
    await expect(readFile(
      path.join(arknoteRoot, 'notes', 'active', NOTE_ID, '旧便签.md'),
      'utf8',
    )).resolves.toBe('# 迁移内容')
    await expect(access(path.join(legacyRoot, 'notes', 'index.json'))).resolves.toBeUndefined()
    await expect(access(path.join(legacyRoot, 'notes.migrated-backup')))
      .rejects.toMatchObject({ code: 'ENOENT' })

    await expect(migrateEmbeddedStickyNotes({ legacyRoot, arknoteRoot }))
      .resolves.toBe('already-migrated')
    await expect(access(path.join(legacyRoot, 'notes')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves legacy data untouched when copying fails', async () => {
    const legacyRoot = await temporaryRoot('arknote-legacy-failure-')
    const arknoteRoot = await temporaryRoot('arknote-target-failure-')
    await writeLegacyData(legacyRoot)

    await expect(migrateEmbeddedStickyNotes({
      legacyRoot,
      arknoteRoot,
      copyDirectory: async () => { throw new Error('disk full') },
    })).rejects.toThrow('disk full')

    await expect(access(path.join(legacyRoot, 'notes', 'index.json'))).resolves.toBeUndefined()
    await expect(access(path.join(arknoteRoot, 'notes'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not delete independent legacy notes for a valid target without provenance', async () => {
    const legacyRoot = await temporaryRoot('arknote-legacy-existing-')
    const arknoteRoot = await temporaryRoot('arknote-target-existing-')
    await writeLegacyData(legacyRoot)
    await writeLegacyData(arknoteRoot)

    await expect(migrateEmbeddedStickyNotes({ legacyRoot, arknoteRoot }))
      .resolves.toBe('already-migrated')
    await expect(access(path.join(legacyRoot, 'notes', 'index.json'))).resolves.toBeUndefined()
  })

  it('rejects a copied Markdown directory and keeps the only complete source', async () => {
    const legacyRoot = await temporaryRoot('arknote-legacy-markdown-directory-')
    const arknoteRoot = await temporaryRoot('arknote-target-markdown-directory-')
    await writeLegacyData(legacyRoot)

    await expect(migrateEmbeddedStickyNotes({
      legacyRoot,
      arknoteRoot,
      copyDirectory: async (source, target) => {
        await cp(source, target, { recursive: true })
        const markdown = path.join(target, 'active', NOTE_ID, '旧便签.md')
        await rm(markdown)
        await mkdir(markdown)
      },
    })).rejects.toThrow()

    await expect(readFile(path.join(legacyRoot, 'notes', 'index.json'), 'utf8')).resolves.toBeTruthy()
    await expect(access(path.join(arknoteRoot, 'notes'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a copied resources file and keeps the only complete source', async () => {
    const legacyRoot = await temporaryRoot('arknote-legacy-resources-file-')
    const arknoteRoot = await temporaryRoot('arknote-target-resources-file-')
    await writeLegacyData(legacyRoot)

    await expect(migrateEmbeddedStickyNotes({
      legacyRoot,
      arknoteRoot,
      copyDirectory: async (source, target) => {
        await cp(source, target, { recursive: true })
        const resources = path.join(target, 'active', NOTE_ID, 'resources')
        await rm(resources, { recursive: true })
        await writeFile(resources, 'not a directory', 'utf8')
      },
    })).rejects.toThrow()

    await expect(readFile(path.join(legacyRoot, 'notes', 'index.json'), 'utf8')).resolves.toBeTruthy()
    await expect(access(path.join(arknoteRoot, 'notes'))).rejects.toMatchObject({ code: 'ENOENT' })
  })


  it('keeps legacy complete when interruption happens before the target rename', async () => {
    const legacyRoot = await temporaryRoot('arknote-legacy-target-rename-before-')
    const arknoteRoot = await temporaryRoot('arknote-target-target-rename-before-')
    const targetNotes = path.join(arknoteRoot, 'notes')
    await writeLegacyData(legacyRoot)

    await expect(migrateEmbeddedStickyNotes({
      legacyRoot,
      arknoteRoot,
      renamePath: async (source, target) => {
        if (target === targetNotes) throw new Error('interrupted before target rename')
        await rename(source, target)
      },
    })).rejects.toThrow('interrupted before target rename')
    await expect(access(path.join(legacyRoot, 'notes', 'index.json'))).resolves.toBeUndefined()
    await expect(access(targetNotes)).rejects.toMatchObject({ code: 'ENOENT' })

    await expect(migrateEmbeddedStickyNotes({ legacyRoot, arknoteRoot }))
      .resolves.toBe('migrated')
  })

  it('recovers after interruption following the target rename while legacy remains complete', async () => {
    const legacyRoot = await temporaryRoot('arknote-legacy-target-rename-')
    const arknoteRoot = await temporaryRoot('arknote-target-target-rename-')
    const targetNotes = path.join(arknoteRoot, 'notes')
    await writeLegacyData(legacyRoot)

    await expect(migrateEmbeddedStickyNotes({
      legacyRoot,
      arknoteRoot,
      renamePath: async (source, target) => {
        await rename(source, target)
        if (target === targetNotes) throw new Error('interrupted after target rename')
      },
    })).rejects.toThrow('interrupted after target rename')
    await expect(access(path.join(targetNotes, 'index.json'))).resolves.toBeUndefined()
    await expect(access(path.join(legacyRoot, 'notes', 'index.json'))).resolves.toBeUndefined()

    await expect(migrateEmbeddedStickyNotes({ legacyRoot, arknoteRoot }))
      .resolves.toBe('already-migrated')
    await expect(access(path.join(legacyRoot, 'notes')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retries legacy cleanup after an interruption following removal', async () => {
    const legacyRoot = await temporaryRoot('arknote-legacy-cleanup-')
    const arknoteRoot = await temporaryRoot('arknote-target-cleanup-')
    const legacyNotes = path.join(legacyRoot, 'notes')
    await writeLegacyData(legacyRoot)
    await expect(migrateEmbeddedStickyNotes({ legacyRoot, arknoteRoot })).resolves.toBe('migrated')

    await expect(migrateEmbeddedStickyNotes({
      legacyRoot,
      arknoteRoot,
      removePath: async (target, options) => {
        await rm(target, options)
        if (target === legacyNotes) throw new Error('interrupted after legacy cleanup')
      },
    })).rejects.toThrow('interrupted after legacy cleanup')
    await expect(access(path.join(arknoteRoot, 'notes', 'index.json'))).resolves.toBeUndefined()

    await expect(migrateEmbeddedStickyNotes({ legacyRoot, arknoteRoot }))
      .resolves.toBe('already-migrated')
  })

  it('leaves a valid target and legacy source intact when cleanup is interrupted before removal', async () => {
    const legacyRoot = await temporaryRoot('arknote-legacy-cleanup-before-')
    const arknoteRoot = await temporaryRoot('arknote-target-cleanup-before-')
    const legacyNotes = path.join(legacyRoot, 'notes')
    await writeLegacyData(legacyRoot)
    await expect(migrateEmbeddedStickyNotes({ legacyRoot, arknoteRoot })).resolves.toBe('migrated')

    await expect(migrateEmbeddedStickyNotes({
      legacyRoot,
      arknoteRoot,
      removePath: async (target, options) => {
        if (target === legacyNotes) throw new Error('interrupted before legacy cleanup')
        await rm(target, options)
      },
    })).rejects.toThrow('interrupted before legacy cleanup')
    await expect(access(path.join(arknoteRoot, 'notes', 'index.json'))).resolves.toBeUndefined()
    await expect(access(path.join(legacyNotes, 'index.json'))).resolves.toBeUndefined()

    await expect(migrateEmbeddedStickyNotes({ legacyRoot, arknoteRoot }))
      .resolves.toBe('already-migrated')
  })

  it('keeps legacy notes when their index hash changes after migration', async () => {
    const legacyRoot = await temporaryRoot('arknote-legacy-hash-change-')
    const arknoteRoot = await temporaryRoot('arknote-target-hash-change-')
    await writeLegacyData(legacyRoot)
    await expect(migrateEmbeddedStickyNotes({ legacyRoot, arknoteRoot })).resolves.toBe('migrated')
    const legacyIndexPath = path.join(legacyRoot, 'notes', 'index.json')
    const source = await readFile(legacyIndexPath, 'utf8')
    await writeFile(legacyIndexPath, `${source}\n`, 'utf8')

    await expect(migrateEmbeddedStickyNotes({ legacyRoot, arknoteRoot }))
      .resolves.toBe('already-migrated')
    await expect(access(legacyIndexPath)).resolves.toBeUndefined()
  })

  it('keeps legacy notes when the target provenance marker is damaged', async () => {
    const legacyRoot = await temporaryRoot('arknote-legacy-marker-damaged-')
    const arknoteRoot = await temporaryRoot('arknote-target-marker-damaged-')
    await writeLegacyData(legacyRoot)
    await expect(migrateEmbeddedStickyNotes({ legacyRoot, arknoteRoot })).resolves.toBe('migrated')
    await writeFile(
      path.join(arknoteRoot, 'notes', MIGRATION_MARKER_NAME),
      '{"schemaVersion":1,"legacyIndexSha256":"not-a-hash","extra":true}',
      'utf8',
    )

    await expect(migrateEmbeddedStickyNotes({ legacyRoot, arknoteRoot }))
      .resolves.toBe('already-migrated')
    await expect(access(path.join(legacyRoot, 'notes', 'index.json'))).resolves.toBeUndefined()
  })

  it('rejects non-canonical and overlapping migration roots before touching data', async () => {
    const legacyRoot = await temporaryRoot('arknote-legacy-invalid-roots-')
    const arknoteRoot = await temporaryRoot('arknote-target-invalid-roots-')
    await writeLegacyData(legacyRoot)
    const nonCanonicalLegacy = `${legacyRoot}${path.sep}child${path.sep}..`

    await expect(migrateEmbeddedStickyNotes({
      legacyRoot: nonCanonicalLegacy,
      arknoteRoot,
    })).rejects.toThrow('规范化')
    await expect(migrateEmbeddedArknoteSettings({
      legacyRoot,
      arknoteRoot: legacyRoot,
    })).rejects.toThrow('重叠')
    await expect(migrateEmbeddedStickyNotes({
      legacyRoot,
      arknoteRoot: path.join(legacyRoot, 'notes'),
    })).rejects.toThrow('重叠')
    await expect(access(path.join(legacyRoot, 'notes', 'index.json'))).resolves.toBeUndefined()
  })

})

describe('embedded Arknote settings migration', () => {
  it('extracts sticky-note preferences and launch-at-login without deleting editor settings', async () => {
    const legacyRoot = await temporaryRoot('arknote-settings-legacy-')
    const arknoteRoot = await temporaryRoot('arknote-settings-target-')
    const stickyNotes = structuredClone(DEFAULT_STICKY_NOTE_PREFERENCES)
    stickyNotes.colorPresets[0].value = '#123456'
    const legacySettings = {
      lastWorkspace: 'C:/Documents',
      stickyNotes,
      desktopLifecycle: {
        launchAtLogin: true,
        closeBehavior: 'tray',
        stickyNoteAutostartPrompted: true,
      },
    }
    await writeFile(
      path.join(legacyRoot, 'settings.json'),
      JSON.stringify(legacySettings),
      'utf8',
    )

    await expect(migrateEmbeddedArknoteSettings({ legacyRoot, arknoteRoot }))
      .resolves.toBe('migrated')

    const migrated = JSON.parse(await readFile(path.join(arknoteRoot, 'settings.json'), 'utf8'))
    expect(migrated).toMatchObject({ schemaVersion: 1, launchAtLogin: true })
    expect(migrated.stickyNotes.colorPresets[0].value).toBe('#123456')
    expect(JSON.parse(await readFile(path.join(legacyRoot, 'settings.json'), 'utf8')))
      .toEqual(legacySettings)
  })

  it('upgrades an existing pre-theme target from the saved Arkdown appearance', async () => {
    const legacyRoot = await temporaryRoot('arknote-settings-theme-legacy-')
    const arknoteRoot = await temporaryRoot('arknote-settings-theme-target-')
    const { themeColor: _missingThemeColor, ...preThemeTarget } = {
      ...DEFAULT_ARKNOTE_SETTINGS,
      launchAtLogin: true,
    }
    await writeFile(path.join(legacyRoot, 'settings.json'), JSON.stringify({
      appearance: {
        ...DEFAULT_EDITOR_APPEARANCE,
        themeColor: '#2563EB',
      },
    }), 'utf8')
    await writeFile(
      path.join(arknoteRoot, 'settings.json'),
      JSON.stringify(preThemeTarget),
      'utf8',
    )

    await expect(migrateEmbeddedArknoteSettings({ legacyRoot, arknoteRoot }))
      .resolves.toBe('migrated')

    const upgraded = JSON.parse(
      await readFile(path.join(arknoteRoot, 'settings.json'), 'utf8'),
    )
    expect(upgraded).toMatchObject({
      schemaVersion: 1,
      launchAtLogin: true,
      themeColor: '#2563EB',
    })
  })

  it('does not overwrite initialized Arknote settings', async () => {
    const legacyRoot = await temporaryRoot('arknote-settings-existing-legacy-')
    const arknoteRoot = await temporaryRoot('arknote-settings-existing-target-')
    await writeFile(path.join(legacyRoot, 'settings.json'), '{}', 'utf8')
    await writeFile(path.join(arknoteRoot, 'settings.json'), '{"existing":true}', 'utf8')

    await expect(migrateEmbeddedArknoteSettings({ legacyRoot, arknoteRoot }))
      .resolves.toBe('already-migrated')
    await expect(readFile(path.join(arknoteRoot, 'settings.json'), 'utf8'))
      .resolves.toBe('{"existing":true}')
  })
})
