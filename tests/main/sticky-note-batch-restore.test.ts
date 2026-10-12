import { mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StickyNoteStore } from '../../src/main/sticky-notes/sticky-note-store'
import { stickyNotePaths } from '../../src/main/sticky-notes/sticky-note-paths'

let root = ''
let sequence = 0

function nextId(): string {
  sequence += 1
  return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'arkdown-batch-restore-'))
  sequence = 0
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('StickyNoteStore.restoreArchived', () => {
  it('rolls all moved directories back when a later move fails', async () => {
    let moveCount = 0
    const store = new StickyNoteStore({
      root,
      createId: nextId,
      statusRename: async (source, destination) => {
        moveCount += 1
        if (moveCount === 2) throw new Error('second move failed')
        await rename(source, destination)
      },
    })
    await store.initialize()
    const first = await store.create({ name: '归档一', markdown: 'A' })
    const second = await store.create({ name: '归档二', markdown: 'B' })
    const archivedFirst = await store.archive(first.record.id)
    const archivedSecond = await store.archive(second.record.id)
    await expect(store.restoreArchived([first.record.id, second.record.id]))
      .rejects.toThrow('second move failed')
    expect((await store.get(first.record.id)).record.status).toBe('archived')
    expect((await store.get(second.record.id)).record.status).toBe('archived')
    await expect(stat(stickyNotePaths(root, archivedFirst.record).directory)).resolves.toBeDefined()
    await expect(stat(stickyNotePaths(root, archivedSecond.record).directory)).resolves.toBeDefined()
  })
})
