import { expect, it, vi } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'

function dependencies() {
  return {
    chooseDirectory: vi.fn(),
    workspace: {} as never,
    documents: {} as never,
    getLastWorkspace: () => null,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
    workspaceEntries: {
      createFolder: vi.fn(async () => ({
        name: '资料',
        relativePath: 'notes/资料',
        kind: 'directory' as const,
      })),
      renameEntry: vi.fn(async () => ({
        entry: {
          name: 'renamed.md',
          relativePath: 'notes/renamed.md',
          kind: 'document' as const,
        },
        absolutePath: 'C:\\workspace\\notes\\renamed.md',
        colorMarks: { marks: { 'notes/renamed.md': '#18864B' as const } },
      })),
      duplicateDocument: vi.fn(async () => ({
        name: 'first - 副本.md',
        relativePath: 'notes/first - 副本.md',
        kind: 'document' as const,
      })),
      trashEntry: vi.fn(async () => ({ colorMarks: { marks: {} } })),
      revealEntry: vi.fn(async () => undefined),
      openEntryWindow: vi.fn(async () => undefined),
      properties: vi.fn(async () => ({
        name: 'first.md',
        relativePath: 'notes/first.md',
        absolutePath: 'C:\\workspace\\notes\\first.md',
        kind: 'document' as const,
        size: 10,
        createdAt: '2026-07-25T00:00:00.000Z',
        modifiedAt: '2026-07-25T00:00:00.000Z',
        itemCount: null,
      })),
      rootProperties: vi.fn(async () => ({
        name: 'workspace',
        relativePath: '',
        absolutePath: 'C:\\workspace',
        kind: 'directory' as const,
        size: 0,
        createdAt: '2026-07-25T00:00:00.000Z',
        modifiedAt: '2026-07-25T00:00:00.000Z',
        itemCount: 2,
      })),
    },
    workspaceColors: {
      get: vi.fn(async () => ({ marks: { 'notes/first.md': '#2563EB' as const } })),
      set: vi.fn(async () => ({ marks: { 'notes/first.md': '#18864B' as const } })),
      move: vi.fn(async () => ({ marks: { 'archive/first.md': '#18864B' as const } })),
      delete: vi.fn(async () => ({ marks: {} })),
    },
  }
}

it('dispatches validated workspace entry operations', async () => {
  const deps = dependencies()
  const operations = createIpcOperations(deps)

  await expect(operations.createWorkspaceFolder({
    parentRelativePath: 'notes',
    name: '资料',
  })).resolves.toMatchObject({ ok: true, value: { kind: 'directory' } })
  await expect(operations.renameWorkspaceEntry({
    relativePath: 'notes/first.md',
    newName: 'renamed.md',
  })).resolves.toEqual({
    ok: true,
    value: {
      entry: {
        name: 'renamed.md',
        relativePath: 'notes/renamed.md',
        kind: 'document',
      },
      colorMarks: { marks: { 'notes/renamed.md': '#18864B' } },
    },
  })
  await operations.duplicateWorkspaceDocument({ relativePath: 'notes/first.md' })
  await operations.revealWorkspaceEntry({ relativePath: 'notes/first.md' })
  await operations.openWorkspaceEntryWindow({ relativePath: 'notes/first.md' })
  await expect(operations.trashWorkspaceEntry({ relativePath: 'notes/first.md' }))
    .resolves.toEqual({ ok: true, value: { colorMarks: { marks: {} } } })
  await operations.getWorkspaceEntryProperties({ relativePath: 'notes/first.md' })
  await operations.getWorkspaceRootProperties()
  await operations.getWorkspaceColorMarks()
  await operations.setWorkspaceColorMark({ relativePath: 'notes/first.md', color: '#18864B' })
  await operations.moveWorkspaceColorMark({
    fromRelativePath: 'notes',
    toRelativePath: 'archive',
  })
  await operations.deleteWorkspaceColorMarks({ relativePath: 'archive' })

  expect(deps.workspaceEntries.createFolder).toHaveBeenCalledWith('notes', '资料')
  expect(deps.workspaceEntries.renameEntry).toHaveBeenCalledWith(
    'notes/first.md',
    'renamed.md',
  )
  expect(deps.workspaceEntries.duplicateDocument).toHaveBeenCalledWith('notes/first.md')
  expect(deps.workspaceEntries.rootProperties).toHaveBeenCalledTimes(1)
  expect(deps.workspaceColors.set).toHaveBeenCalledWith('notes/first.md', '#18864B')
  expect(deps.workspaceColors.move).toHaveBeenCalledWith('notes', 'archive')
  expect(deps.workspaceColors.delete).toHaveBeenCalledWith('archive')
})

it('rejects unknown fields, absolute relative paths, and invalid names', async () => {
  const deps = dependencies()
  const operations = createIpcOperations(deps)
  for (const input of [
    { parentRelativePath: '', name: 'CON' },
    { parentRelativePath: 'C:\\outside', name: 'notes' },
    { parentRelativePath: '', name: 'notes', extra: true },
  ]) {
    await expect(operations.createWorkspaceFolder(input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
  }
  expect(deps.workspaceEntries.createFolder).not.toHaveBeenCalled()
})

it('rejects malformed workspace color inputs before dispatch', async () => {
  const deps = dependencies()
  const operations = createIpcOperations(deps)
  for (const [operation, input] of [
    [operations.setWorkspaceColorMark, { relativePath: '../outside', color: '#2563EB' }],
    [operations.setWorkspaceColorMark, { relativePath: 'notes/a.md', color: '#5F6368' }],
    [operations.moveWorkspaceColorMark, { fromRelativePath: 'notes', toRelativePath: 'C:\\outside' }],
    [operations.deleteWorkspaceColorMarks, { relativePath: '', extra: true }],
  ] as const) {
    await expect(operation(input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
  }
  expect(deps.workspaceColors.set).not.toHaveBeenCalled()
  expect(deps.workspaceColors.move).not.toHaveBeenCalled()
  expect(deps.workspaceColors.delete).not.toHaveBeenCalled()
})
