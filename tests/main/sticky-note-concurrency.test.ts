import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stickyNoteIndexPath, stickyNotePaths } from '../../src/main/sticky-notes/sticky-note-paths'
import { StickyNoteStore } from '../../src/main/sticky-notes/sticky-note-store'
import { parseStickyNoteIndex } from '../../src/shared/sticky-notes'

let root = ''
let sequence = 0

function createStore(): StickyNoteStore {
  return new StickyNoteStore({
    root,
    now: () => new Date('2026-08-01T00:00:00.000Z'),
    createId: () => {
      sequence += 1
      return `20000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`
    },
  })
}

async function readPersistedIndex() {
  const source = await readFile(stickyNoteIndexPath(root), 'utf8')
  const index = parseStickyNoteIndex(JSON.parse(source) as unknown)
  expect(index).toBeDefined()
  return index!
}

async function expectIndexMatchesDisk(store: StickyNoteStore): Promise<void> {
  const index = await readPersistedIndex()
  for (const record of index.notes) {
    const inMemory = await store.get(record.id)
    expect(inMemory.record).toEqual(record)
    await expect(stat(stickyNotePaths(root, record).markdown)).resolves.toBeTruthy()
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'arkdown-sticky-concurrency-'))
  sequence = 0
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('StickyNoteStore concurrent operations', () => {
  it('serializes save with rename and preserves both results', async () => {
    const store = createStore()
    await store.initialize()
    const created = await store.create({ name: 'Before rename', markdown: 'before save' })

    await Promise.all([
      store.writeMarkdown(created.record.id, 'after save'),
      store.rename(created.record.id, 'After rename'),
    ])

    await expect(store.get(created.record.id)).resolves.toMatchObject({
      record: { name: 'After rename', status: 'active' },
      markdown: 'after save',
    })
    await expectIndexMatchesDisk(store)
  })

  it('serializes save with archive and moves the final markdown intact', async () => {
    const store = createStore()
    await store.initialize()
    const created = await store.create({ name: 'Archive target', markdown: 'before save' })

    await Promise.all([
      store.writeMarkdown(created.record.id, 'saved before archive'),
      store.archive(created.record.id),
    ])

    const archived = await store.get(created.record.id)
    expect(archived).toMatchObject({
      record: { status: 'archived' },
      markdown: 'saved before archive',
    })
    await expect(readFile(stickyNotePaths(root, archived.record).markdown, 'utf8'))
      .resolves.toBe('saved before archive')
    await expectIndexMatchesDisk(store)
  })

  it('serializes restore with archived batch deletion without partial state', async () => {
    const store = createStore()
    await store.initialize()
    const created = await store.create({ name: 'Delete target', markdown: 'delete me' })
    const archived = await store.archive(created.record.id)

    const [restoreResult, deleteResult] = await Promise.allSettled([
      store.restore(created.record.id),
      store.deleteArchived([created.record.id]),
    ])

    expect(restoreResult.status).toBe('fulfilled')
    expect(deleteResult.status).toBe('rejected')
    await expect(store.get(created.record.id)).resolves.toMatchObject({
      record: { status: 'active' },
      markdown: 'delete me',
    })
    await expect(stat(stickyNotePaths(root, archived.record).directory))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expectIndexMatchesDisk(store)
  })
})
