import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'
import { DocumentService } from '../../src/main/documents/document-service'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'

it('activates a dropped workspace and returns its optional document', async () => {
  const summary = { name: 'notes', absolutePath: 'C:\\notes' }
  const commit = vi.fn(async () => summary)
  const workspace = {
    getRoot: vi.fn(() => 'C:\\notes'),
    resolveExistingDocument: vi.fn(async () => 'C:\\notes\\guide.md'),
    validateDroppedPath: vi.fn(async () => ({
      activation: { summary, commit },
      documentPath: 'guide.md',
    })),
  }
  const documents = {
    read: vi.fn(async () => ({
      relativePath: 'guide.md',
      markdown: '# Guide',
      revision: 'a'.repeat(64),
      encoding: 'utf8' as const,
      newline: 'lf' as const,
      mtimeMs: 1,
    })),
  }
  const setLastWorkspace = vi.fn()
  const assets = { allowWorkspaceRoot: vi.fn() }
  const operations = createIpcOperations({
    chooseDirectory: vi.fn(),
    workspace,
    documents,
    assets: assets as never,
    getLastWorkspace: () => null,
    setLastWorkspace,
    reportError: vi.fn(),
  } as never)

  await expect(operations.openDroppedPath({
    absolutePath: 'C:\\notes\\guide.md',
  })).resolves.toEqual({
    ok: true,
    value: {
      workspace: summary,
      document: expect.objectContaining({ relativePath: 'guide.md' }),
    },
  })
  expect(setLastWorkspace).toHaveBeenCalledWith('C:\\notes')
  expect(commit).toHaveBeenCalledTimes(1)
  expect(assets.allowWorkspaceRoot).toHaveBeenCalledTimes(1)
  expect(documents.read).toHaveBeenCalledWith('guide.md')
})

it('rejects non-absolute dropped paths before activation', async () => {
  const validateDroppedPath = vi.fn()
  const operations = createIpcOperations({
    chooseDirectory: vi.fn(),
    workspace: { validateDroppedPath },
    documents: {},
    getLastWorkspace: () => null,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
  } as never)

  await expect(operations.openDroppedPath({ absolutePath: '../guide.md' })).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  expect(validateDroppedPath).not.toHaveBeenCalled()
})

it('classifies an absolute dropped item without activating a workspace', async () => {
  const inspectDroppedPath = vi.fn(async (absolutePath: string) => ({
    kind: 'directory' as const,
    absolutePath,
  }))
  const validateDroppedPath = vi.fn()
  const operations = createIpcOperations({
    chooseDirectory: vi.fn(),
    workspace: { validateDroppedPath },
    documents: {},
    inspectDroppedPath,
    getLastWorkspace: () => null,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
  } as never)

  await expect(operations.inspectDroppedPath({
    absolutePath: 'C:\\notes',
  })).resolves.toEqual({
    ok: true,
    value: { kind: 'directory', absolutePath: 'C:\\notes' },
  })
  expect(inspectDroppedPath).toHaveBeenCalledWith('C:\\notes')
  expect(validateDroppedPath).not.toHaveBeenCalled()
})

it('rejects a relative path before dropped-item classification', async () => {
  const inspectDroppedPath = vi.fn()
  const operations = createIpcOperations({
    chooseDirectory: vi.fn(),
    workspace: {},
    documents: {},
    inspectDroppedPath,
    getLastWorkspace: () => null,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
  } as never)

  await expect(operations.inspectDroppedPath({ absolutePath: '..\\notes' }))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(inspectDroppedPath).not.toHaveBeenCalled()
})

it('allows shortcut resolution only on inspection and leaves workspace activation guarded', async () => {
  const inspectDroppedPath = vi.fn(async (_path: string, resolveShortcut?: boolean) => ({
    kind: 'file' as const, absolutePath: resolveShortcut ? 'C:\\notes\\target.md' : 'C:\\Desktop\\target.lnk',
  }))
  const validateDroppedPath = vi.fn()
  const operations = createIpcOperations({
    chooseDirectory: vi.fn(), workspace: { validateDroppedPath }, documents: {}, inspectDroppedPath,
    getLastWorkspace: () => null, setLastWorkspace: vi.fn(), reportError: vi.fn(),
  } as never)
  await expect(operations.inspectDroppedPath({
    absolutePath: 'C:\\Desktop\\target.lnk', resolveDocumentShortcut: true,
  })).resolves.toEqual({ ok: true, value: { kind: 'file', absolutePath: 'C:\\notes\\target.md' } })
  await expect(operations.inspectDroppedPath({
    absolutePath: 'C:\\Desktop\\target.lnk', resolveDocumentShortcut: 'true',
  })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  await expect(operations.prepareDroppedPath({
    absolutePath: 'C:\\Desktop\\target.lnk', resolveDocumentShortcut: true,
  })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(validateDroppedPath).not.toHaveBeenCalled()
})

const temporaryRoots: string[] = []
afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function guardedFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-guarded-drop-'))
  temporaryRoots.push(root)
  const oldRoot = path.join(root, 'old')
  const newRoot = path.join(root, 'new')
  await mkdir(oldRoot)
  await mkdir(newRoot)
  await writeFile(path.join(oldRoot, 'note.md'), '# OLD')
  await writeFile(path.join(newRoot, 'note.md'), '# TARGET')
  const workspace = new WorkspaceService()
  await workspace.setRoot(oldRoot)
  const documents = new DocumentService(workspace)
  let lastWorkspace: string | null = oldRoot
  const sourceChanged = vi.fn()
  const assets = { allowWorkspaceRoot: vi.fn(async (): Promise<void> => undefined) }
  const operations = createIpcOperations({
    chooseDirectory: async () => null, workspace, documents,
    assets: assets as never,
    getLastWorkspace: () => lastWorkspace,
    setLastWorkspace: (next) => { lastWorkspace = next },
    reportError: vi.fn(), onDocumentSourceChanged: sourceChanged,
  })
  const opened = await operations.readDocument({ relativePath: 'note.md' })
  if (!opened.ok) throw new Error('fixture failed to open')
  const snapshot = opened.value
  sourceChanged.mockClear()
  return { operations, workspace, documents, assets, oldRoot, newRoot, snapshot, sourceChanged,
    lastWorkspace: () => lastWorkspace,
    prepare: async () => {
      const result = await operations.prepareDroppedPath({ absolutePath: path.join(newRoot, 'note.md') })
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    save: (markdown = '# LATEST') => operations.saveDocument({
      relativePath: 'note.md', markdown, expectedRevision: snapshot.revision,
      encoding: snapshot.encoding, newline: snapshot.newline,
    }),
  }
}

it('prepares without changing workspace epoch or ownership, and cancellation preserves the real save target', async () => {
  const f = await guardedFixture()
  const activation = f.workspace.getActivationSnapshot()
  const prepared = await f.prepare()
  expect(prepared.document?.markdown).toBe('# TARGET')
  expect(f.workspace.getActivationSnapshot()).toEqual(activation)
  expect(await f.workspace.withMutationLease(activation, async root => root)).toBe(f.oldRoot)
  expect(f.lastWorkspace()).toBe(f.oldRoot)
  expect(f.sourceChanged).not.toHaveBeenCalled()
  expect(f.assets.allowWorkspaceRoot).not.toHaveBeenCalled()
  expect(await f.operations.settleDroppedPath({ token: prepared.token, accept: false })).toEqual({ ok: true, value: null })
  expect((await f.save()).ok).toBe(true)
  expect(await readFile(path.join(f.oldRoot, 'note.md'), 'utf8')).toBe('# LATEST')
  expect(await readFile(path.join(f.newRoot, 'note.md'), 'utf8')).toBe('# TARGET')
})

it('a real save while preparation is pending stays on the old file and invalidates acceptance', async () => {
  const f = await guardedFixture()
  const prepared = await f.prepare()
  expect((await f.save()).ok).toBe(true)
  expect(await f.operations.settleDroppedPath({ token: prepared.token, accept: true })).toMatchObject({ ok: false })
  expect(f.workspace.getRoot()).toBe(f.oldRoot)
  expect(await readFile(path.join(f.oldRoot, 'note.md'), 'utf8')).toBe('# LATEST')
  expect(await readFile(path.join(f.newRoot, 'note.md'), 'utf8')).toBe('# TARGET')
})

it('an old cancellation cannot clear a newer token, and acceptance publishes the real new save target once', async () => {
  const f = await guardedFixture()
  const old = await f.prepare()
  const latest = await f.prepare()
  expect(await f.operations.settleDroppedPath({ token: old.token, accept: false })).toMatchObject({ ok: false })
  const accepted = await f.operations.settleDroppedPath({ token: latest.token, accept: true })
  expect(accepted.ok).toBe(true)
  expect(f.sourceChanged).toHaveBeenCalledOnce()
  expect(f.workspace.getRoot()).toBe(f.newRoot)
  expect(f.lastWorkspace()).toBe(f.newRoot)
  expect(await f.operations.settleDroppedPath({ token: latest.token, accept: true })).toMatchObject({ ok: false })
  const saved = await f.operations.saveDocument({ relativePath: 'note.md', markdown: '# NEW EDIT',
    expectedRevision: latest.document!.revision, encoding: 'utf8', newline: 'lf' })
  expect(saved.ok).toBe(true)
  expect(await readFile(path.join(f.oldRoot, 'note.md'), 'utf8')).toBe('# OLD')
  expect(await readFile(path.join(f.newRoot, 'note.md'), 'utf8')).toBe('# NEW EDIT')
})

it.each(['owner', 'workspace'] as const)('rejects a pending token after a newer %s without rollback', async (newer) => {
  const f = await guardedFixture()
  const pending = await f.prepare()
  if (newer === 'owner') await f.operations.readDocument({ relativePath: 'note.md' })
  else await f.operations.openDroppedPath({ absolutePath: f.newRoot })
  const root = f.workspace.getRoot()
  expect(await f.operations.settleDroppedPath({ token: pending.token, accept: true })).toMatchObject({ ok: false })
  expect(f.workspace.getRoot()).toBe(root)
})

it('a failed final activation restores the old workspace and real save ownership', async () => {
  const f = await guardedFixture()
  const pending = await f.prepare()
  f.assets.allowWorkspaceRoot.mockRejectedValueOnce(new Error('asset activation failed'))
  expect(await f.operations.settleDroppedPath({ token: pending.token, accept: true })).toMatchObject({ ok: false })
  expect(f.sourceChanged).not.toHaveBeenCalled()
  expect(f.workspace.getRoot()).toBe(f.oldRoot)
  expect(f.lastWorkspace()).toBe(f.oldRoot)
  expect((await f.save()).ok).toBe(true)
  expect(await readFile(path.join(f.newRoot, 'note.md'), 'utf8')).toBe('# TARGET')
})

it('failed restoration clears ownership instead of allowing a normal save into the wrong workspace', async () => {
  const f = await guardedFixture()
  const pending = await f.prepare()
  f.assets.allowWorkspaceRoot.mockRejectedValueOnce(new Error('asset activation failed'))
  vi.spyOn(f.workspace, 'restoreCanonicalRoot').mockRejectedValueOnce(new Error('old directory unavailable'))
  expect(await f.operations.settleDroppedPath({ token: pending.token, accept: true })).toMatchObject({ ok: false })
  expect(() => f.workspace.getRoot()).toThrow()
  expect((await f.save()).ok).toBe(false)
  expect(await readFile(path.join(f.oldRoot, 'note.md'), 'utf8')).toBe('# OLD')
  expect(await readFile(path.join(f.newRoot, 'note.md'), 'utf8')).toBe('# TARGET')
})

it('rejects an old-owner save queued during final acceptance', async () => {
  const f = await guardedFixture()
  const pending = await f.prepare()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  f.assets.allowWorkspaceRoot.mockImplementationOnce(() => gate)
  const accepting = f.operations.settleDroppedPath({ token: pending.token, accept: true })
  await vi.waitFor(() => expect(f.assets.allowWorkspaceRoot).toHaveBeenCalledOnce())
  const saving = f.save()
  release()
  expect((await accepting).ok).toBe(true)
  expect((await saving).ok).toBe(false)
  expect(await readFile(path.join(f.newRoot, 'note.md'), 'utf8')).toBe('# TARGET')
})
