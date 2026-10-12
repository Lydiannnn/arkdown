import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  StickyNoteStore,
  type ArchivedDeleteFileSystem,
} from '../../src/main/sticky-notes/sticky-note-store'
import {
  stickyNoteIndexPath,
  stickyNotePaths,
} from '../../src/main/sticky-notes/sticky-note-paths'

let root = ''
let sequence = 0
const NOW = new Date('2026-07-31T04:00:00.000Z')

function nextId(): string {
  sequence += 1
  return `10000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`
}

function createArchivedDeleteFileSystem(
  overrides: Partial<ArchivedDeleteFileSystem> = {},
): ArchivedDeleteFileSystem {
  return {
    realpath: (candidate) => realpath(candidate),
    rename: (source, destination) => rename(source, destination),
    removeTree: (candidate) => rm(candidate, { recursive: true, force: true }),
    ...overrides,
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'arkdown-sticky-recovery-'))
  sequence = 0
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function pathExists(candidate: string): Promise<boolean> {
  return stat(candidate).then(
    () => true,
    (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    },
  )
}

describe('StickyNoteStore recovery', () => {
  it('backs up corrupt JSON and rebuilds records without deleting markdown', async () => {
    const first = new StickyNoteStore({
      root,
      now: () => new Date(NOW),
      createId: nextId,
      createBackupSuffix: () => 'backup',
    })
    await first.initialize()
    const created = await first.create({ name: '需要恢复', markdown: '# 仍然存在' })
    await writeFile(stickyNoteIndexPath(root), '{broken', 'utf8')

    const recovered = new StickyNoteStore({
      root,
      now: () => new Date(NOW),
      createId: nextId,
      createBackupSuffix: () => 'backup',
    })
    const index = await recovered.initialize()

    expect(index.notes.some(({ id }) => id === created.record.id)).toBe(true)
    expect(index.notes.every(({ lineSpacingMode }) => lineSpacingMode === 'compact')).toBe(true)
    await expect(recovered.get(created.record.id)).resolves.toMatchObject({
      markdown: '# 仍然存在',
    })
    await expect(readFile(
      path.join(root, 'notes', `index.corrupt-${NOW.getTime()}-backup.json`),
      'utf8',
    )).resolves.toBe('{broken')
  })

  it('preserves the original schema v2 index when the v5 atomic write-back fails', async () => {
    const original = new StickyNoteStore({
      root,
      now: () => new Date(NOW),
      createId: nextId,
    })
    const v3Index = await original.initialize()
    const v2Index = {
      ...v3Index,
      schemaVersion: 2,
      notes: v3Index.notes.map(({
        lineSpacingMode: _lineSpacingMode,
        background: _background,
        ...note
      }) => note),
    }
    const originalSource = `${JSON.stringify(v2Index, null, 2)}\n`
    await writeFile(stickyNoteIndexPath(root), originalSource, 'utf8')

    const reloaded = new StickyNoteStore({
      root,
      now: () => new Date(NOW),
      createId: nextId,
      createBackupSuffix: () => 'upgrade-failure',
      atomicWrite: async (filePath, contents) => {
        if (filePath === stickyNoteIndexPath(root)) throw new Error('disk full')
        await writeFile(filePath, contents, 'utf8')
      },
    })

    await expect(reloaded.initialize()).rejects.toThrow('disk full')
    await expect(readFile(stickyNoteIndexPath(root), 'utf8')).resolves.toBe(originalSource)
    await expect(stat(path.join(
      root,
      'notes',
      `index.corrupt-${NOW.getTime()}-upgrade-failure.json`,
    ))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls an archive move back when the index write fails', async () => {
    let failIndexWrite = false
    const atomicWrite = vi.fn(async (filePath: string, contents: string) => {
      if (failIndexWrite && filePath === stickyNoteIndexPath(root)) {
        throw new Error('disk full')
      }
      await writeFile(filePath, contents, 'utf8')
    })
    const store = new StickyNoteStore({
      root,
      now: () => new Date(NOW),
      createId: nextId,
      atomicWrite,
    })
    await store.initialize()
    const created = await store.create({ name: '事务便签', markdown: '# 内容' })
    const activePaths = stickyNotePaths(root, created.record)
    failIndexWrite = true

    await expect(store.archive(created.record.id)).rejects.toThrow('disk full')

    await expect(readFile(activePaths.markdown, 'utf8')).resolves.toBe('# 内容')
    expect((await store.get(created.record.id)).record.status).toBe('active')
    const archiveRoot = path.join(root, 'notes', 'archive')
    const entries = await readdir(archiveRoot).catch(() => [])
    expect(entries).toEqual([])
  })

  it('rolls a delete back when the index write fails', async () => {
    let failIndexWrite = false
    const atomicWrite = vi.fn(async (filePath: string, contents: string) => {
      if (failIndexWrite && filePath === stickyNoteIndexPath(root)) {
        throw new Error('disk full')
      }
      await writeFile(filePath, contents, 'utf8')
    })
    const store = new StickyNoteStore({
      root,
      now: () => new Date(NOW),
      createId: nextId,
      atomicWrite,
    })
    await store.initialize()
    const created = await store.create({ name: '不能丢失', markdown: '# 内容' })
    const paths = stickyNotePaths(root, created.record)
    failIndexWrite = true

    await expect(store.delete(created.record.id)).rejects.toThrow('disk full')

    await expect(stat(paths.directory)).resolves.toBeTruthy()
    await expect(store.get(created.record.id)).resolves.toMatchObject({ markdown: '# 内容' })
  })

  it('validates every archived batch member before the first rename', async () => {
    const renameDirectory = vi.fn((source: string, destination: string) => (
      rename(source, destination)
    ))
    const store = new StickyNoteStore({
      root,
      now: () => new Date(NOW),
      createId: nextId,
      archivedDeleteFileSystem: createArchivedDeleteFileSystem({ rename: renameDirectory }),
    })
    await store.initialize()
    const archived = await store.create({ name: 'Archived validation target' })
    const active = await store.create({ name: 'Active validation target' })
    const archivedNote = await store.archive(archived.record.id)
    const archivedPath = stickyNotePaths(root, archivedNote.record).directory
    const activePath = stickyNotePaths(root, active.record).directory

    await expect(store.deleteArchived([])).rejects.toThrow()
    await expect(store.deleteArchived([
      archived.record.id,
      '10000000-0000-4000-8000-ffffffffffff',
    ])).rejects.toThrow()
    await expect(store.deleteArchived([archived.record.id, active.record.id])).rejects.toThrow()

    expect(renameDirectory).not.toHaveBeenCalled()
    expect(await pathExists(archivedPath)).toBe(true)
    expect(await pathExists(activePath)).toBe(true)
    await expect(store.list('archived')).resolves.toMatchObject([
      { record: { id: archived.record.id } },
    ])
  })

  it('rejects a missing archived source before the first rename', async () => {
    const renameDirectory = vi.fn((source: string, destination: string) => (
      rename(source, destination)
    ))
    const store = new StickyNoteStore({
      root,
      now: () => new Date(NOW),
      createId: nextId,
      archivedDeleteFileSystem: createArchivedDeleteFileSystem({ rename: renameDirectory }),
    })
    await store.initialize()
    const created = await store.create({ name: 'Missing archived source' })
    const archived = await store.archive(created.record.id)
    await rm(stickyNotePaths(root, archived.record).directory, { recursive: true })

    await expect(store.deleteArchived([created.record.id])).rejects.toThrow()

    expect(renameDirectory).not.toHaveBeenCalled()
    const current = await store.initialize()
    expect(current.notes).toContainEqual(expect.objectContaining({
      id: created.record.id,
      status: 'archived',
    }))
  })

  it('rejects a non-directory archived source before the first rename', async () => {
    const renameDirectory = vi.fn((source: string, destination: string) => (
      rename(source, destination)
    ))
    const store = new StickyNoteStore({
      root,
      now: () => new Date(NOW),
      createId: nextId,
      archivedDeleteFileSystem: createArchivedDeleteFileSystem({ rename: renameDirectory }),
    })
    await store.initialize()
    const created = await store.create({ name: 'Non-directory archived source' })
    const archived = await store.archive(created.record.id)
    const archivedPath = stickyNotePaths(root, archived.record).directory
    await rm(archivedPath, { recursive: true })
    await writeFile(archivedPath, 'not a directory', 'utf8')

    await expect(store.deleteArchived([created.record.id])).rejects.toThrow()

    expect(renameDirectory).not.toHaveBeenCalled()
    expect((await stat(archivedPath)).isFile()).toBe(true)
    const current = await store.initialize()
    expect(current.notes).toContainEqual(expect.objectContaining({
      id: created.record.id,
      status: 'archived',
    }))
    const persisted = JSON.parse(await readFile(stickyNoteIndexPath(root), 'utf8')) as {
      notes: Array<{ id: string; status: string }>
    }
    expect(persisted.notes).toContainEqual(expect.objectContaining({
      id: created.record.id,
      status: 'archived',
    }))
  })

  it('rejects a canonical archived source that resolves outside the archive root', async () => {
    let escapingPath = ''
    const renameDirectory = vi.fn((source: string, destination: string) => (
      rename(source, destination)
    ))
    const store = new StickyNoteStore({
      root,
      now: () => new Date(NOW),
      createId: nextId,
      archivedDeleteFileSystem: createArchivedDeleteFileSystem({
        realpath: async (candidate) => (
          path.resolve(candidate) === path.resolve(escapingPath)
            ? path.join(root, 'outside', path.basename(candidate))
            : realpath(candidate)
        ),
        rename: renameDirectory,
      }),
    })
    await store.initialize()
    const created = await store.create({ name: 'Escaping archived source' })
    const archived = await store.archive(created.record.id)
    const archivedPath = stickyNotePaths(root, archived.record).directory
    escapingPath = archivedPath

    await expect(store.deleteArchived([created.record.id])).rejects.toThrow()

    expect(renameDirectory).not.toHaveBeenCalled()
    expect(await pathExists(archivedPath)).toBe(true)
  })

  it('rolls back prior staged directories when a later staging rename fails', async () => {
    let renameCalls = 0
    const renameDirectory = vi.fn(async (source: string, destination: string) => {
      renameCalls += 1
      if (renameCalls === 2) throw new Error('second staging rename failed')
      await rename(source, destination)
    })
    const store = new StickyNoteStore({
      root,
      now: () => new Date(NOW),
      createId: nextId,
      createBackupSuffix: () => 'staging-failure',
      archivedDeleteFileSystem: createArchivedDeleteFileSystem({ rename: renameDirectory }),
    })
    await store.initialize()
    const first = await store.create({ name: 'Stage first' })
    const second = await store.create({ name: 'Stage second' })
    const archivedFirst = await store.archive(first.record.id)
    const archivedSecond = await store.archive(second.record.id)
    const firstPath = stickyNotePaths(root, archivedFirst.record).directory
    const secondPath = stickyNotePaths(root, archivedSecond.record).directory
    await expect(store.deleteArchived([first.record.id, second.record.id]))
      .rejects.toThrow('second staging rename failed')

    expect(renameDirectory).toHaveBeenCalledTimes(3)
    expect(await pathExists(firstPath)).toBe(true)
    expect(await pathExists(secondPath)).toBe(true)
    await expect(store.list('archived')).resolves.toMatchObject([
      { record: { id: first.record.id } },
      { record: { id: second.record.id } },
    ])
  })

  it('rolls back every staged archived directory when the batch index write fails', async () => {
    let failIndexWrite = false
    const atomicWrite = vi.fn(async (filePath: string, contents: string) => {
      if (failIndexWrite && filePath === stickyNoteIndexPath(root)) throw new Error('disk full')
      await writeFile(filePath, contents, 'utf8')
    })
    const store = new StickyNoteStore({ root, now: () => new Date(NOW), createId: nextId, atomicWrite })
    await store.initialize()
    const first = await store.create({ name: 'Rollback batch first' })
    const second = await store.create({ name: 'Rollback batch second' })
    const archivedFirst = await store.archive(first.record.id)
    const archivedSecond = await store.archive(second.record.id)
    const firstPath = stickyNotePaths(root, archivedFirst.record).directory
    const secondPath = stickyNotePaths(root, archivedSecond.record).directory
    failIndexWrite = true

    await expect(store.deleteArchived([first.record.id, second.record.id]))
      .rejects.toThrow('disk full')

    expect(await pathExists(firstPath)).toBe(true)
    expect(await pathExists(secondPath)).toBe(true)
    await expect(store.list('archived')).resolves.toMatchObject([
      { record: { id: first.record.id } },
      { record: { id: second.record.id } },
    ])
  })

  it('deduplicates archived IDs so each directory is staged and removed once', async () => {
    const renameDirectory = vi.fn((source: string, destination: string) => (
      rename(source, destination)
    ))
    const removeTree = vi.fn((candidate: string) => (
      rm(candidate, { recursive: true, force: true })
    ))
    const store = new StickyNoteStore({
      root,
      now: () => new Date(NOW),
      createId: nextId,
      createBackupSuffix: () => 'duplicate-id',
      archivedDeleteFileSystem: createArchivedDeleteFileSystem({
        rename: renameDirectory,
        removeTree,
      }),
    })
    await store.initialize()
    const created = await store.create({ name: 'Duplicate batch target' })
    await store.archive(created.record.id)

    await store.deleteArchived([created.record.id, created.record.id])

    expect(renameDirectory).toHaveBeenCalledTimes(1)
    expect(removeTree).toHaveBeenCalledTimes(1)
    await expect(store.list('archived')).resolves.toEqual([])
  })

  it('reports transaction cleanup failure after commit without rejecting deletion', async () => {
    const reportError = vi.fn()
    const removeTree = vi.fn(async () => {
      throw new Error('cleanup failed')
    })
    const store = new StickyNoteStore({
      root,
      now: () => new Date(NOW),
      createId: nextId,
      createBackupSuffix: () => 'cleanup-failure',
      reportError,
      archivedDeleteFileSystem: createArchivedDeleteFileSystem({ removeTree }),
    })
    await store.initialize()
    const created = await store.create({ name: 'Cleanup failure target' })
    await store.archive(created.record.id)

    await expect(store.deleteArchived([created.record.id])).resolves.toBeUndefined()

    await expect(store.list('archived')).resolves.toEqual([])
    expect(reportError).toHaveBeenCalledWith(
      'Could not remove archived note deletion transaction',
      expect.objectContaining({ message: 'cleanup failed' }),
    )
  })

})
