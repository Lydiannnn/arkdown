import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  isValidWorkspaceEntryName,
  WorkspaceEntryService,
} from '../../src/main/workspace/workspace-entry-service'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'
import { WorkspaceColorStore } from '../../src/main/workspace/workspace-color-store'

const roots: string[] = []

async function fixture(options: {
  createColorStore?(dataRoot: string): WorkspaceColorStore
  renameItem?(source: string, target: string): Promise<void>
  trashItem?(absolutePath: string): Promise<void>
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-workspace-entry-'))
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'arkdown-workspace-entry-data-'))
  roots.push(root, dataRoot)
  await mkdir(path.join(root, 'notes'))
  await writeFile(path.join(root, 'notes', 'first.md'), '# First')
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  const workspaceColors = options.createColorStore?.(dataRoot) ?? new WorkspaceColorStore(dataRoot)
  const trashItem = vi.fn(options.trashItem ?? (async () => undefined))
  const revealItem = vi.fn()
  const openWindow = vi.fn(async () => undefined)
  const service = new WorkspaceEntryService({
    workspace,
    trashItem,
    revealItem,
    openWindow,
    renameItem: options.renameItem,
    workspaceColors,
  })
  return {
    root,
    dataRoot,
    service,
    trashItem,
    revealItem,
    openWindow,
    workspace,
    workspaceColors,
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('validates Windows names before any filesystem operation', () => {
  expect(isValidWorkspaceEntryName('正常名称')).toBe(true)
  for (const name of ['', '.', '..', 'CON', 'LPT1.txt', '尾随点.', '尾随空格 ', 'a/b', 'a:b']) {
    expect(isValidWorkspaceEntryName(name)).toBe(false)
  }
})

it('creates folders, renames entries, and reports properties inside the workspace', async () => {
  const { root, service } = await fixture()
  await expect(service.createFolder('notes', '资料')).resolves.toMatchObject({
    relativePath: 'notes/资料',
    kind: 'directory',
  })
  const renamed = await service.renameEntry('notes/first.md', 'renamed.md')
  expect(renamed.entry.relativePath).toBe('notes/renamed.md')
  expect(await readFile(path.join(root, 'notes', 'renamed.md'), 'utf8')).toBe('# First')
  await expect(service.properties('notes/renamed.md')).resolves.toMatchObject({
    name: 'renamed.md',
    kind: 'document',
    relativePath: 'notes/renamed.md',
    size: 7,
  })
})

it('keeps rename metadata bound to the root captured before a workspace switch', async () => {
  let workspace!: WorkspaceService
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), 'arkdown-workspace-entry-second-'))
  roots.push(secondRoot)
  await mkdir(path.join(secondRoot, 'notes'))
  await writeFile(path.join(secondRoot, 'notes', 'first.md'), '# Second')
  const renameItem = vi.fn(async (source: string, target: string) => {
    await rename(source, target)
    await workspace.setRoot(secondRoot)
  })
  const state = await fixture({ renameItem })
  workspace = state.workspace
  await state.workspaceColors.set(state.root, 'notes/first.md', '#2563EB')
  await state.workspaceColors.set(secondRoot, 'notes/first.md', '#18864B')

  const result = await state.service.renameEntry('notes/first.md', 'renamed.md')

  expect(result.colorMarks.marks).toEqual({ 'notes/renamed.md': '#2563EB' })
  expect((await state.workspaceColors.get(state.root)).marks).toEqual({
    'notes/renamed.md': '#2563EB',
  })
  expect((await state.workspaceColors.get(secondRoot)).marks).toEqual({
    'notes/first.md': '#18864B',
  })
})

it('keeps trash metadata bound to the root captured before a workspace switch', async () => {
  let workspace!: WorkspaceService
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), 'arkdown-workspace-entry-second-'))
  roots.push(secondRoot)
  await mkdir(path.join(secondRoot, 'notes'))
  await writeFile(path.join(secondRoot, 'notes', 'first.md'), '# Second')
  const state = await fixture({
    trashItem: async () => { await workspace.setRoot(secondRoot) },
  })
  workspace = state.workspace
  await state.workspaceColors.set(state.root, 'notes/first.md', '#2563EB')
  await state.workspaceColors.set(secondRoot, 'notes/first.md', '#18864B')

  const result = await state.service.trashEntry('notes/first.md')

  expect(result.colorMarks.marks).toEqual({})
  expect((await state.workspaceColors.get(state.root)).marks).toEqual({})
  expect((await state.workspaceColors.get(secondRoot)).marks).toEqual({
    'notes/first.md': '#18864B',
  })
})

it('compensates a renamed file when color metadata persistence fails', async () => {
  let rejectWrites = false
  const state = await fixture({
    createColorStore: (dataRoot) => new WorkspaceColorStore(dataRoot, {
      writeTextFileAtomic: async (filePath, contents) => {
        if (rejectWrites) throw new Error('metadata unavailable')
        await writeFile(filePath, contents, 'utf8')
      },
    }),
  })
  await state.workspaceColors.set(state.root, 'notes/first.md', '#2563EB')
  rejectWrites = true

  await expect(state.service.renameEntry('notes/first.md', 'renamed.md'))
    .rejects.toThrow('metadata unavailable')
  expect((await stat(path.join(state.root, 'notes', 'first.md'))).isFile()).toBe(true)
  await expect(stat(path.join(state.root, 'notes', 'renamed.md'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

it('does not trash a file when color metadata persistence fails', async () => {
  let rejectWrites = false
  const state = await fixture({
    createColorStore: (dataRoot) => new WorkspaceColorStore(dataRoot, {
      writeTextFileAtomic: async (filePath, contents) => {
        if (rejectWrites) throw new Error('metadata unavailable')
        await writeFile(filePath, contents, 'utf8')
      },
    }),
  })
  await state.workspaceColors.set(state.root, 'notes/first.md', '#2563EB')
  rejectWrites = true

  await expect(state.service.trashEntry('notes/first.md')).rejects.toThrow('metadata unavailable')
  expect(state.trashItem).not.toHaveBeenCalled()
  expect((await stat(path.join(state.root, 'notes', 'first.md'))).isFile()).toBe(true)
})

it('leaves rename metadata unchanged when the filesystem operation fails', async () => {
  const state = await fixture({
    renameItem: async () => { throw new Error('rename unavailable') },
  })
  await state.workspaceColors.set(state.root, 'notes/first.md', '#2563EB')

  await expect(state.service.renameEntry('notes/first.md', 'renamed.md'))
    .rejects.toThrow('rename unavailable')
  expect((await state.workspaceColors.get(state.root)).marks).toEqual({
    'notes/first.md': '#2563EB',
  })
})

it('restores trash metadata when the filesystem operation fails', async () => {
  const state = await fixture({
    trashItem: async () => { throw new Error('trash unavailable') },
  })
  await state.workspaceColors.set(state.root, 'notes/first.md', '#2563EB')

  await expect(state.service.trashEntry('notes/first.md')).rejects.toThrow('trash unavailable')
  expect((await state.workspaceColors.get(state.root)).marks).toEqual({
    'notes/first.md': '#2563EB',
  })
})

it('duplicates documents with incrementing non-overwriting names', async () => {
  const { root, service } = await fixture()
  const first = await service.duplicateDocument('notes/first.md')
  const second = await service.duplicateDocument('notes/first.md')
  expect(first.name).toBe('first - 副本.md')
  expect(second.name).toBe('first - 副本 (2).md')
  expect(await readFile(path.join(root, 'notes', first.name), 'utf8')).toBe('# First')
  expect(await readFile(path.join(root, 'notes', second.name), 'utf8')).toBe('# First')
})

it('validates entries again before reveal, new-window, and trash side effects', async () => {
  const { service, trashItem, revealItem, openWindow } = await fixture()
  await service.revealEntry('notes/first.md')
  await service.openEntryWindow('notes')
  await service.trashEntry('notes/first.md')
  expect(revealItem).toHaveBeenCalledTimes(1)
  expect(openWindow).toHaveBeenCalledTimes(1)
  expect(trashItem).toHaveBeenCalledTimes(1)

  await expect(service.trashEntry('../outside.md')).rejects.toMatchObject({
    code: 'PATH_OUTSIDE_WORKSPACE',
  })
  expect(trashItem).toHaveBeenCalledTimes(1)
})

it('never overwrites an existing rename target', async () => {
  const { root, service } = await fixture()
  await writeFile(path.join(root, 'notes', 'existing.md'), 'keep')
  await expect(service.renameEntry('notes/first.md', 'existing.md')).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  })
  expect(await readFile(path.join(root, 'notes', 'existing.md'), 'utf8')).toBe('keep')
  expect((await stat(path.join(root, 'notes', 'first.md'))).isFile()).toBe(true)
})
