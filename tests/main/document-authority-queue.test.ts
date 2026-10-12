import path from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  createIpcOperations,
  SerialOperationQueue,
} from '../../src/main/ipc/register-ipc'

const revisionA = 'a'.repeat(64)
const revisionB = 'b'.repeat(64)
const revisionC = 'c'.repeat(64)
const draftA = '123e4567-e89b-42d3-a456-426614174000'
const draftB = '223e4567-e89b-42d3-a456-426614174001'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function snapshot(relativePath: string, revision = revisionA, mtimeMs = 1) {
  return {
    relativePath,
    markdown: `# ${relativePath}`,
    revision,
    encoding: 'utf8' as const,
    newline: 'lf' as const,
    mtimeMs,
  }
}

function dependencies() {
  const workspaceSummary = { name: 'notes', absolutePath: 'C:\\notes' }
  const workspace = {
    getRoot: vi.fn(() => workspaceSummary.absolutePath),
    getValidatedActivationSnapshot: vi.fn(async () => ({
      root: workspaceSummary.absolutePath, epoch: 1, rootVolumeSerial: '1', rootFileId: '1',
    })),
    resolveExistingDocument: vi.fn(async (relativePath: string) => (
      path.join(workspaceSummary.absolutePath, relativePath)
    )),
    resolveExistingPandocDocument: vi.fn(async (relativePath: string) => (
      path.join(workspaceSummary.absolutePath, relativePath)
    )),
    validateRoot: vi.fn(async () => ({
      summary: workspaceSummary,
      commit: vi.fn(async () => workspaceSummary),
    })),
  }
  const documents = {
    read: vi.fn(async (relativePath: string) => snapshot(relativePath)),
    create: vi.fn(async (relativePath: string) => snapshot(relativePath)),
    save: vi.fn(async () => ({ revision: revisionB, mtimeMs: 2 })),
  }
  const drafts = {
    write: vi.fn(async (input: { draftId: string }) => ({
      draftId: input.draftId,
      originalAbsolutePath: null,
      workspaceAbsolutePath: null,
      originalRevision: null,
      originalMtimeMs: null,
      encoding: 'utf8' as const,
      newline: 'lf' as const,
      updatedAt: '2026-08-21T00:00:00.000Z',
      ignoredAt: null,
    })),
    read: vi.fn(async () => null),
    listRecoverable: vi.fn(async () => []),
    markIgnored: vi.fn(async () => undefined),
    discard: vi.fn(async () => undefined),
    finalizeSaved: vi.fn(async () => undefined),
  }
  return {
    chooseDirectory: vi.fn(async () => null),
    chooseSavePath: vi.fn(async () => 'C:\\notes\\saved.md'),
    workspace,
    documents,
    drafts,
    getLastWorkspace: vi.fn(() => workspaceSummary.absolutePath),
    setLastWorkspace: vi.fn(async () => undefined),
    onDocumentSourceChanged: vi.fn(),
    reportError: vi.fn(),
    workspaceEntries: {
      renameEntry: vi.fn(async (_relativePath: string, newName: string) => ({
        entry: { name: newName, relativePath: newName, kind: 'document' as const },
        absolutePath: path.join(workspaceSummary.absolutePath, newName),
        colorMarks: { marks: {} },
      })),
      trashEntry: vi.fn(async () => ({ colorMarks: { marks: {} } })),
    },
  }
}

function saveDraftInput(draftId: string, expectedOriginalRevision: string | null) {
  return {
    draftId,
    markdown: '# autosaved',
    expectedOriginalRevision,
    encoding: 'utf8' as const,
    newline: 'lf' as const,
  }
}

type SaveAsFailureStage = 'save' | 'create' | 'prepare' | 'finalize'

function crossDirectorySaveAsDependencies(options: {
  failureStage?: SaveAsFailureStage
  initialRoot?: string | null
  failRestoredAssetScope?: boolean
  failPreviousRootRestore?: boolean
} = {}) {
  const oldRoot = options.initialRoot === undefined ? 'C:\\old' : options.initialRoot
  const targetRoot = 'C:\\new'
  const oldFolderPickerPath = oldRoot ? path.join(oldRoot, 'picked') : null
  let currentRoot = oldRoot
  let lastWorkspace = oldRoot
  let folderPickerPath = oldFolderPickerPath
  const events: string[] = []
  const stageError = new Error(`${options.failureStage ?? 'none'} failed`)
  const finalizeCleanupError = Object.assign(
    new Error('EACCES deleting C:\\private\\draft-assets'),
    { code: 'EACCES' },
  )
  const previousRootRestoreError = Object.assign(
    new Error('EACCES restoring C:\\private\\old-workspace'),
    { code: 'EACCES' },
  )
  const restoredAssetScopeError = new Error('restored asset scope failed')
  let draftDirectoryPresent = true
  let draftAssetDirectoryPresent = true
  const migrationRollback = vi.fn(async () => {
    events.push('migration.rollback')
  })
  const workspace = {
    getRoot: vi.fn(() => {
      if (!currentRoot) throw new Error('No workspace is open')
      return currentRoot
    }),
    getValidatedActivationSnapshot: vi.fn(async () => {
      if (!currentRoot) throw new Error('No workspace is open')
      return { root: currentRoot, epoch: 1, rootVolumeSerial: '1', rootFileId: '1' }
    }),
    resolveExistingDocument: vi.fn(async (relativePath: string) => {
      if (!currentRoot) throw new Error('No workspace is open')
      if (options.failureStage === 'prepare' && relativePath === 'saved.md') {
        throw stageError
      }
      return path.join(currentRoot, relativePath)
    }),
    validateRoot: vi.fn(async (root: string) => {
      expect(root).toBe(targetRoot)
      return {
        summary: { name: 'new', absolutePath: targetRoot },
        commit: vi.fn(async () => {
          events.push('workspace.activate')
          currentRoot = targetRoot
          return { name: 'new', absolutePath: targetRoot }
        }),
      }
    }),
    restoreCanonicalRoot: vi.fn(async (root: string | null) => {
      events.push(`workspace.restore:${root ?? 'null'}`)
      if (options.failPreviousRootRestore && root === oldRoot) {
        throw previousRootRestoreError
      }
      currentRoot = root
      return root ? { name: path.basename(root), absolutePath: root } : null
    }),
  }
  const documents = {
    read: vi.fn(async (relativePath: string) => {
      if (relativePath === 'saved.md') {
        if (options.failureStage === 'save') return snapshot(relativePath, revisionB, 2)
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }
      return snapshot(relativePath, revisionA, 1)
    }),
    create: vi.fn(async (relativePath: string, markdown: string) => {
      if (options.failureStage === 'create') throw stageError
      return { ...snapshot(relativePath, revisionB, 2), markdown }
    }),
    save: vi.fn(async () => {
      if (options.failureStage === 'save') throw stageError
      return { revision: revisionC, mtimeMs: 3 }
    }),
  }
  const base = dependencies()
  const drafts = base.drafts
  drafts.finalizeSaved.mockImplementation(async () => {
    draftDirectoryPresent = false
    if (options.failureStage === 'finalize') throw finalizeCleanupError
    draftAssetDirectoryPresent = false
  })
  const assets = {
    allowWorkspaceRoot: vi.fn(async () => {
      events.push(`assets.allow:${currentRoot ?? 'null'}`)
      if (options.failRestoredAssetScope && currentRoot === oldRoot) {
        throw restoredAssetScopeError
      }
    }),
    migrateDraftAssets: vi.fn(async (_draftId: string, markdown: string) => ({
      markdown,
      rollback: migrationRollback,
    })),
  }
  const deps = {
    ...base,
    chooseSavePath: vi.fn(async () => path.join(targetRoot, 'saved.md')),
    workspace,
    documents,
    drafts,
    assets,
    getLastWorkspace: vi.fn(() => lastWorkspace),
    setLastWorkspace: vi.fn(async (root: string | null) => {
      events.push(`settings.workspace:${root ?? 'null'}`)
      lastWorkspace = root
    }),
    getLastFolderPickerPath: vi.fn(() => folderPickerPath),
    setLastFolderPickerPath: vi.fn(async (root: string | null) => {
      events.push(`settings.folder:${root ?? 'null'}`)
      folderPickerPath = root
    }),
  }
  return {
    deps,
    workspace,
    drafts,
    assets,
    migrationRollback,
    stageError,
    finalizeCleanupError,
    previousRootRestoreError,
    restoredAssetScopeError,
    events,
    oldRoot,
    targetRoot,
    oldFolderPickerPath,
    currentRoot: () => currentRoot,
    lastWorkspace: () => lastWorkspace,
    folderPickerPath: () => folderPickerPath,
    draftDirectoryPresent: () => draftDirectoryPresent,
    draftAssetDirectoryPresent: () => draftAssetDirectoryPresent,
  }
}

function droppedReadFailureDependencies(options: {
  initialRoot?: string | null
  failSettingsRollback?: boolean
  failPreviousRootRestore?: boolean
} = {}) {
  const previousRoot = options.initialRoot === undefined ? 'C:\\old' : options.initialRoot
  const droppedRoot = 'C:\\dropped'
  let currentRoot = previousRoot
  let lastWorkspace = previousRoot
  const events: string[] = []
  const readError = new Error('dropped document read failed')
  const settingsRollbackError = Object.assign(
    new Error('EACCES writing C:\\private\\settings.json'),
    { code: 'EACCES' },
  )
  const rootRestoreError = Object.assign(
    new Error('EACCES restoring C:\\private\\old-workspace'),
    { code: 'EACCES' },
  )
  const workspace = {
    getRoot: vi.fn(() => {
      if (!currentRoot) throw new Error('No workspace is open')
      return currentRoot
    }),
    resolveExistingDocument: vi.fn(async (relativePath: string) => {
      if (!currentRoot) throw new Error('No workspace is open')
      return path.join(currentRoot, relativePath)
    }),
    validateDroppedPath: vi.fn(async () => ({
      activation: {
        summary: { name: 'dropped', absolutePath: droppedRoot },
        commit: vi.fn(async () => {
          events.push('workspace.activate')
          currentRoot = droppedRoot
          return { name: 'dropped', absolutePath: droppedRoot }
        }),
      },
      documentPath: 'dropped.md',
    })),
    restoreCanonicalRoot: vi.fn(async (root: string | null) => {
      events.push(`workspace.restore:${root ?? 'null'}`)
      if (options.failPreviousRootRestore && root === previousRoot) throw rootRestoreError
      currentRoot = root
      return root ? { name: path.basename(root), absolutePath: root } : null
    }),
  }
  const documents = {
    read: vi.fn(async (relativePath: string) => {
      if (relativePath === 'dropped.md') throw readError
      return snapshot(relativePath)
    }),
    save: vi.fn(async () => ({ revision: revisionB, mtimeMs: 2 })),
  }
  const base = dependencies()
  const assets = {
    allowWorkspaceRoot: vi.fn(async () => {
      events.push(`assets.allow:${currentRoot ?? 'null'}`)
    }),
  }
  const deps = {
    ...base,
    workspace,
    documents,
    assets,
    getLastWorkspace: vi.fn(() => lastWorkspace),
    setLastWorkspace: vi.fn(async (root: string | null) => {
      events.push(`settings.workspace:${root ?? 'null'}`)
      if (options.failSettingsRollback && root === previousRoot) throw settingsRollbackError
      lastWorkspace = root
    }),
  }
  return {
    deps,
    workspace,
    documents,
    assets,
    events,
    previousRoot,
    droppedRoot,
    readError,
    settingsRollbackError,
    rootRestoreError,
    currentRoot: () => currentRoot,
    lastWorkspace: () => lastWorkspace,
  }
}

it('does not let an ordinary autosave cancel a deferred document read', async () => {
  const deps = dependencies()
  const nextRead = deferred<ReturnType<typeof snapshot>>()
  deps.documents.read.mockImplementation((relativePath: string) => (
    relativePath === 'next.md'
      ? nextRead.promise
      : Promise.resolve(snapshot(relativePath))
  ))
  const operations = createIpcOperations(deps as never)
  await operations.readDocument({ relativePath: 'note.md' })
  await operations.saveDraft(saveDraftInput(draftA, revisionA))
  deps.drafts.write.mockClear()

  const pendingRead = operations.readDocument({ relativePath: 'next.md' })
  await vi.waitFor(() => expect(deps.documents.read).toHaveBeenCalledWith('next.md'))
  const pendingAutosave = operations.saveDraft(saveDraftInput(draftA, revisionA))

  await Promise.resolve()
  expect(deps.drafts.write).not.toHaveBeenCalled()
  nextRead.resolve(snapshot('next.md'))

  await expect(pendingRead).resolves.toMatchObject({
    ok: true,
    value: { relativePath: 'next.md' },
  })
  await expect(pendingAutosave).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  expect(deps.drafts.write).not.toHaveBeenCalled()
})

it('does not let an ordinary autosave cancel a Save As that is finalizing', async () => {
  const deps = dependencies()
  const finalize = deferred<undefined>()
  deps.documents.read.mockImplementation(async (relativePath: string) => {
    if (relativePath === 'saved.md') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return snapshot(relativePath)
  })
  deps.documents.create.mockResolvedValue(snapshot('saved.md', revisionB, 2))
  deps.drafts.finalizeSaved.mockImplementationOnce(() => finalize.promise)
  const operations = createIpcOperations(deps as never)
  await operations.saveDraft(saveDraftInput(draftA, null))
  deps.drafts.write.mockClear()

  const pendingSaveAs = operations.saveDocumentAs({
    draftId: draftA,
    markdown: '# saved',
    encoding: 'utf8',
    newline: 'lf',
    suggestedFileName: 'saved.md',
  })
  await vi.waitFor(() => expect(deps.drafts.finalizeSaved).toHaveBeenCalledWith(draftA))
  const pendingAutosave = operations.saveDraft(saveDraftInput(draftA, null))

  await Promise.resolve()
  expect(deps.drafts.write).not.toHaveBeenCalled()
  finalize.resolve(undefined)

  await expect(pendingSaveAs).resolves.toMatchObject({
    ok: true,
    value: { document: { relativePath: 'saved.md' } },
  })
  await expect(pendingAutosave).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  expect(deps.drafts.write).not.toHaveBeenCalled()
})

it('finishes Save As before a later failing read and keeps the saved document authoritative', async () => {
  const deps = dependencies()
  const finalize = deferred<undefined>()
  deps.documents.read.mockImplementation(async (relativePath: string) => {
    if (relativePath === 'saved.md') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    if (relativePath === 'broken.md') throw new Error('read failed')
    return snapshot(relativePath)
  })
  deps.documents.create.mockResolvedValue(snapshot('saved.md', revisionB, 2))
  deps.drafts.finalizeSaved.mockImplementationOnce(() => finalize.promise)
  const operations = createIpcOperations(deps as never)
  await operations.saveDraft(saveDraftInput(draftA, null))

  const pendingSaveAs = operations.saveDocumentAs({
    draftId: draftA,
    markdown: '# saved',
    encoding: 'utf8',
    newline: 'lf',
    suggestedFileName: 'saved.md',
  })
  await vi.waitFor(() => expect(deps.drafts.finalizeSaved).toHaveBeenCalledWith(draftA))
  const laterRead = operations.readDocument({ relativePath: 'broken.md' })

  await Promise.resolve()
  expect(deps.documents.read).not.toHaveBeenCalledWith('broken.md')
  finalize.resolve(undefined)

  await expect(pendingSaveAs).resolves.toMatchObject({ ok: true })
  await expect(laterRead).resolves.toMatchObject({ ok: false })
  await expect(operations.saveDraft(saveDraftInput(draftB, revisionB))).resolves.toMatchObject({
    ok: true,
  })
  expect(deps.drafts.write).toHaveBeenLastCalledWith(expect.objectContaining({
    draftId: draftB,
    originalAbsolutePath: 'C:\\notes\\saved.md',
    originalRevision: revisionB,
  }))
})

it.each(['save', 'create', 'prepare'] as const)(
  'rejects legacy cross-directory Save As before the %s stage can mutate state',
  async (failureStage) => {
    const context = crossDirectorySaveAsDependencies({ failureStage })
    const operations = createIpcOperations(context.deps as never)
    await operations.readDocument({ relativePath: 'note.md' })
    await operations.saveDraft(saveDraftInput(draftA, revisionA))
    context.drafts.write.mockClear()

    await expect(operations.saveDocumentAs({
      draftId: draftA,
      markdown: '# save as transaction',
      encoding: 'utf8',
      newline: 'lf',
      suggestedFileName: 'saved.md',
    })).resolves.toMatchObject({ ok: false })

    expect(context.currentRoot()).toBe(context.oldRoot)
    expect(context.lastWorkspace()).toBe(context.oldRoot)
    expect(context.folderPickerPath()).toBe(context.oldFolderPickerPath)
    expect(context.workspace.restoreCanonicalRoot).not.toHaveBeenCalled()
    expect(context.migrationRollback).not.toHaveBeenCalled()
    expect(context.assets.allowWorkspaceRoot).not.toHaveBeenCalled()
    expect(context.deps.setLastFolderPickerPath).not.toHaveBeenCalled()
    expect(context.deps.documents.create).not.toHaveBeenCalled()
    expect(context.deps.documents.save).not.toHaveBeenCalled()

    await expect(operations.saveDraft(saveDraftInput(draftA, revisionA))).resolves.toMatchObject({
      ok: true,
    })
    expect(context.drafts.write).toHaveBeenLastCalledWith(expect.objectContaining({
      draftId: draftA,
      originalAbsolutePath: path.join(context.oldRoot!, 'note.md'),
      workspaceAbsolutePath: context.oldRoot,
      originalRevision: revisionA,
    }))
  },
)

it('rejects legacy cross-directory Save As even when its old stages would succeed', async () => {
  const context = crossDirectorySaveAsDependencies()
  const operations = createIpcOperations(context.deps as never)
  await operations.readDocument({ relativePath: 'note.md' })
  await operations.saveDraft(saveDraftInput(draftA, revisionA))

  await expect(operations.saveDocumentAs({
    draftId: draftA,
    markdown: '# successful save as',
    encoding: 'utf8',
    newline: 'lf',
    suggestedFileName: 'saved.md',
  })).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } })

  expect(context.currentRoot()).toBe(context.oldRoot)
  expect(context.lastWorkspace()).toBe(context.oldRoot)
  expect(context.folderPickerPath()).toBe(context.oldFolderPickerPath)
  expect(context.workspace.restoreCanonicalRoot).not.toHaveBeenCalled()
  expect(context.migrationRollback).not.toHaveBeenCalled()
  expect(context.deps.setLastFolderPickerPath).not.toHaveBeenCalled()
  expect(context.deps.documents.create).not.toHaveBeenCalled()
  expect(context.deps.documents.save).not.toHaveBeenCalled()
})

it('keeps the no-workspace state when legacy Save As from an untitled draft is rejected', async () => {
  const context = crossDirectorySaveAsDependencies({
    failureStage: 'prepare',
    initialRoot: null,
  })
  const operations = createIpcOperations(context.deps as never)
  await operations.saveDraft(saveDraftInput(draftA, null))
  context.drafts.write.mockClear()

  await expect(operations.saveDocumentAs({
    draftId: draftA,
    markdown: '# untitled save as',
    encoding: 'utf8',
    newline: 'lf',
    suggestedFileName: 'saved.md',
  })).resolves.toMatchObject({ ok: false })

  expect(context.currentRoot()).toBeNull()
  expect(context.lastWorkspace()).toBeNull()
  expect(context.folderPickerPath()).toBeNull()
  expect(context.workspace.restoreCanonicalRoot).not.toHaveBeenCalled()
  await expect(operations.saveDraft(saveDraftInput(draftA, null))).resolves.toMatchObject({
    ok: true,
  })
  expect(context.drafts.write).toHaveBeenLastCalledWith(expect.objectContaining({
    originalAbsolutePath: null,
    workspaceAbsolutePath: null,
    originalRevision: null,
  }))
})

it('does not reach asset-scope rollback for rejected legacy cross-directory Save As', async () => {
  const context = crossDirectorySaveAsDependencies({
    failureStage: 'prepare',
    failRestoredAssetScope: true,
  })
  const operations = createIpcOperations(context.deps as never)
  await operations.readDocument({ relativePath: 'note.md' })
  await operations.saveDraft(saveDraftInput(draftA, revisionA))

  await expect(operations.saveDocumentAs({
    draftId: draftA,
    markdown: '# failed scope restore',
    encoding: 'utf8',
    newline: 'lf',
    suggestedFileName: 'saved.md',
  })).resolves.toMatchObject({ ok: false })

  expect(context.currentRoot()).toBe(context.oldRoot)
  expect(context.lastWorkspace()).toBe(context.oldRoot)
  expect(context.deps.reportError).not.toHaveBeenCalled()
  expect(context.assets.allowWorkspaceRoot).not.toHaveBeenCalled()
  expect(context.workspace.restoreCanonicalRoot).not.toHaveBeenCalled()
})

it('does not invoke workspace restoration for rejected legacy cross-directory Save As', async () => {
  const context = crossDirectorySaveAsDependencies({
    failureStage: 'prepare',
    failPreviousRootRestore: true,
  })
  const operations = createIpcOperations(context.deps as never)
  await operations.readDocument({ relativePath: 'note.md' })
  await operations.saveDraft(saveDraftInput(draftA, revisionA))

  await expect(operations.saveDocumentAs({
    draftId: draftA,
    markdown: '# failed ownership preparation',
    encoding: 'utf8',
    newline: 'lf',
    suggestedFileName: 'saved.md',
  })).resolves.toMatchObject({
    ok: false,
    error: { code: 'OPERATION_FAILED' },
  })

  expect(context.workspace.restoreCanonicalRoot).not.toHaveBeenCalled()
  expect(context.currentRoot()).toBe(context.oldRoot)
  expect(context.lastWorkspace()).toBe(context.oldRoot)
  expect(context.assets.allowWorkspaceRoot).not.toHaveBeenCalled()
  expect(context.migrationRollback).not.toHaveBeenCalled()
  expect(context.deps.reportError).not.toHaveBeenCalled()
})

it('does not reach draft cleanup for rejected legacy cross-directory Save As', async () => {
  const context = crossDirectorySaveAsDependencies({ failureStage: 'finalize' })
  const operations = createIpcOperations(context.deps as never)
  await operations.readDocument({ relativePath: 'note.md' })
  await operations.saveDraft(saveDraftInput(draftA, revisionA))

  await expect(operations.saveDocumentAs({
    draftId: draftA,
    markdown: '# saved despite cleanup failure',
    encoding: 'utf8',
    newline: 'lf',
    suggestedFileName: 'saved.md',
  })).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } })

  expect(context.draftDirectoryPresent()).toBe(true)
  expect(context.draftAssetDirectoryPresent()).toBe(true)
  expect(context.currentRoot()).toBe(context.oldRoot)
  expect(context.lastWorkspace()).toBe(context.oldRoot)
  expect(context.workspace.restoreCanonicalRoot).not.toHaveBeenCalled()
  expect(context.migrationRollback).not.toHaveBeenCalled()
  expect(context.deps.reportError).not.toHaveBeenCalled()
})

it('restores the no-workspace state after a dropped document read fails', async () => {
  const context = droppedReadFailureDependencies({ initialRoot: null })
  const operations = createIpcOperations(context.deps as never)
  await operations.saveDraft(saveDraftInput(draftA, null))
  context.deps.drafts.write.mockClear()

  await expect(operations.openDroppedPath({
    absolutePath: 'C:\\dropped\\dropped.md',
  })).resolves.toMatchObject({
    ok: false,
    error: { code: 'OPERATION_FAILED' },
  })

  expect(context.workspace.restoreCanonicalRoot).toHaveBeenCalledWith(null)
  expect(context.currentRoot()).toBeNull()
  expect(context.lastWorkspace()).toBeNull()
  expect(context.assets.allowWorkspaceRoot).toHaveBeenCalledTimes(2)
  expect(context.events).toContain('assets.allow:null')
  await expect(operations.saveDraft(saveDraftInput(draftA, null))).resolves.toMatchObject({
    ok: true,
  })
  expect(context.deps.drafts.write).toHaveBeenLastCalledWith(expect.objectContaining({
    draftId: draftA,
    originalAbsolutePath: null,
    workspaceAbsolutePath: null,
    originalRevision: null,
  }))
})

it('restores dropped-path root and assets even when settings rollback fails', async () => {
  const context = droppedReadFailureDependencies({ failSettingsRollback: true })
  const operations = createIpcOperations(context.deps as never)
  await operations.readDocument({ relativePath: 'note.md' })
  await operations.saveDraft(saveDraftInput(draftA, revisionA))
  context.deps.drafts.write.mockClear()

  await expect(operations.openDroppedPath({
    absolutePath: 'C:\\dropped\\dropped.md',
  })).resolves.toMatchObject({
    ok: false,
    error: { code: 'OPERATION_FAILED' },
  })

  expect(context.workspace.restoreCanonicalRoot).toHaveBeenCalledWith(context.previousRoot)
  expect(context.currentRoot()).toBe(context.previousRoot)
  expect(context.lastWorkspace()).toBe(context.droppedRoot)
  expect(context.assets.allowWorkspaceRoot).toHaveBeenCalledTimes(2)
  expect(context.events).toContain(`assets.allow:${context.previousRoot}`)
  expect(context.deps.reportError).toHaveBeenCalledOnce()
  const aggregate = context.deps.reportError.mock.calls[0]?.[0]
  expect(aggregate).toBeInstanceOf(AggregateError)
  expect((aggregate as AggregateError).errors).toEqual(expect.arrayContaining([
    context.readError,
    context.settingsRollbackError,
  ]))
  await expect(operations.saveDraft(saveDraftInput(draftA, revisionA))).resolves.toMatchObject({
    ok: true,
  })
  expect(context.deps.drafts.write).toHaveBeenLastCalledWith(expect.objectContaining({
    originalAbsolutePath: path.join(context.previousRoot!, 'note.md'),
    workspaceAbsolutePath: context.previousRoot,
    originalRevision: revisionA,
  }))
})

it('fails closed when a dropped path cannot restore the previous root', async () => {
  const context = droppedReadFailureDependencies({ failPreviousRootRestore: true })
  const operations = createIpcOperations(context.deps as never)
  await operations.readDocument({ relativePath: 'note.md' })
  await operations.saveDraft(saveDraftInput(draftA, revisionA))

  await expect(operations.openDroppedPath({
    absolutePath: 'C:\\dropped\\dropped.md',
  })).resolves.toMatchObject({
    ok: false,
    error: { code: 'OPERATION_FAILED' },
  })

  expect(context.workspace.restoreCanonicalRoot.mock.calls).toEqual([
    [context.previousRoot],
    [null],
  ])
  expect(context.currentRoot()).toBeNull()
  expect(context.lastWorkspace()).toBe(context.previousRoot)
  expect(context.assets.allowWorkspaceRoot).toHaveBeenCalledTimes(2)
  expect(context.events).toContain('assets.allow:null')
  expect(context.deps.onDocumentSourceChanged).toHaveBeenCalledTimes(2)
  expect(context.deps.onDocumentSourceChanged).toHaveBeenLastCalledWith(null)
  expect(context.deps.reportError).toHaveBeenCalledOnce()
  const aggregate = context.deps.reportError.mock.calls[0]?.[0]
  expect(aggregate).toBeInstanceOf(AggregateError)
  expect((aggregate as AggregateError).errors).toEqual(expect.arrayContaining([
    context.readError,
    context.rootRestoreError,
  ]))

  await expect(operations.readDraft({ draftId: draftA })).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  context.documents.save.mockClear()
  await expect(operations.saveDocument({
    relativePath: 'note.md',
    markdown: '# stale old owner',
    expectedRevision: revisionA,
    encoding: 'utf8',
    newline: 'lf',
  })).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  expect(context.documents.save).not.toHaveBeenCalled()
  await expect(operations.saveDraft(saveDraftInput(draftB, null))).resolves.toMatchObject({
    ok: true,
  })
})

it('serializes a failed dropped activation before a later workspace choice', async () => {
  const oldRoot = 'C:\\old'
  const droppedRoot = 'C:\\dropped'
  const chosenRoot = 'C:\\chosen'
  let currentRoot = oldRoot
  let lastWorkspace: string | null = oldRoot
  const droppedCommit = deferred<{ name: string; absolutePath: string }>()
  const chooseDirectory = vi.fn(async () => chosenRoot)
  const workspace = {
    getRoot: vi.fn(() => currentRoot),
    resolveExistingDocument: vi.fn(async (relativePath: string) => path.join(currentRoot, relativePath)),
    validateDroppedPath: vi.fn(async () => ({
      activation: {
        summary: { name: 'dropped', absolutePath: droppedRoot },
        commit: vi.fn(() => droppedCommit.promise),
      },
      documentPath: null,
    })),
    validateRoot: vi.fn(async () => ({
      summary: { name: 'chosen', absolutePath: chosenRoot },
      commit: vi.fn(async () => {
        currentRoot = chosenRoot
        return { name: 'chosen', absolutePath: chosenRoot }
      }),
    })),
    restoreCanonicalRoot: vi.fn(async (root: string) => {
      currentRoot = root
      return { name: 'old', absolutePath: root }
    }),
  }
  const drafts = dependencies().drafts
  const operations = createIpcOperations({
    chooseDirectory,
    workspace,
    documents: { read: vi.fn(async (relativePath: string) => snapshot(relativePath)) },
    drafts,
    getLastWorkspace: () => lastWorkspace,
    setLastWorkspace: async (root: string | null) => { lastWorkspace = root },
    reportError: vi.fn(),
  } as never)
  await operations.readDocument({ relativePath: 'old.md' })
  await operations.saveDraft(saveDraftInput(draftA, revisionA))
  drafts.write.mockClear()

  const earlierDrop = operations.openDroppedPath({ absolutePath: 'C:\\dropped\\note.md' })
  await vi.waitFor(() => expect(workspace.validateDroppedPath).toHaveBeenCalledOnce())
  const laterChoice = operations.chooseWorkspace()

  await Promise.resolve()
  expect(chooseDirectory).not.toHaveBeenCalled()
  droppedCommit.reject(new Error('dropped activation failed'))

  await expect(earlierDrop).resolves.toMatchObject({ ok: false })
  await expect(laterChoice).resolves.toMatchObject({
    ok: true,
    value: { absolutePath: chosenRoot },
  })
  expect(currentRoot).toBe(chosenRoot)
  expect(lastWorkspace).toBe(chosenRoot)
  await expect(operations.saveDraft(saveDraftInput(draftB, null))).resolves.toMatchObject({
    ok: true,
  })
  expect(drafts.write).toHaveBeenCalledWith(expect.objectContaining({
    draftId: draftB,
    originalAbsolutePath: null,
    originalRevision: null,
  }))
})

it('finishes draft discard before creating the later document owner', async () => {
  const deps = dependencies()
  const discard = deferred<undefined>()
  deps.drafts.discard.mockImplementationOnce(() => discard.promise)
  deps.documents.create.mockImplementation(async (relativePath: string) => (
    snapshot(relativePath, revisionC, 3)
  ))
  const operations = createIpcOperations(deps as never)
  await operations.readDocument({ relativePath: 'note.md' })
  await operations.saveDraft(saveDraftInput(draftA, revisionA))
  deps.documents.create.mockClear()

  const pendingDiscard = operations.discardDraft({ draftId: draftA })
  await vi.waitFor(() => expect(deps.drafts.discard).toHaveBeenCalledWith(draftA, 'discarded', true))
  const pendingCreate = operations.createDocument({ relativePath: 'created.md' })

  await Promise.resolve()
  expect(deps.documents.create).not.toHaveBeenCalled()
  discard.resolve(undefined)

  await expect(pendingDiscard).resolves.toMatchObject({ ok: true })
  await expect(pendingCreate).resolves.toMatchObject({
    ok: true,
    value: { relativePath: 'created.md' },
  })
  await expect(operations.saveDraft(saveDraftInput(draftB, revisionC))).resolves.toMatchObject({
    ok: true,
  })
  expect(deps.drafts.write).toHaveBeenLastCalledWith(expect.objectContaining({
    draftId: draftB,
    originalAbsolutePath: 'C:\\notes\\created.md',
    originalRevision: revisionC,
  }))
})

it('continues with the next ownership operation after a queued rejection', async () => {
  const deps = dependencies()
  const brokenRead = deferred<ReturnType<typeof snapshot>>()
  deps.documents.read.mockImplementation((relativePath: string) => (
    relativePath === 'broken.md'
      ? brokenRead.promise
      : Promise.resolve(snapshot(relativePath, revisionC, 3))
  ))
  const operations = createIpcOperations(deps as never)

  const rejectedRead = operations.readDocument({ relativePath: 'broken.md' })
  await vi.waitFor(() => expect(deps.documents.read).toHaveBeenCalledWith('broken.md'))
  const laterCreate = operations.createDocument({ relativePath: 'created.md' })

  await Promise.resolve()
  expect(deps.documents.create).not.toHaveBeenCalled()
  brokenRead.reject(new Error('read failed'))

  await expect(rejectedRead).resolves.toMatchObject({ ok: false })
  await expect(laterCreate).resolves.toMatchObject({
    ok: true,
    value: { relativePath: 'created.md' },
  })
})

it('releases the serial queue after a task promise rejects', async () => {
  const queue = new SerialOperationQueue()
  const order: string[] = []

  const rejected = queue.run(async () => {
    order.push('first')
    throw new Error('first failed')
  })
  const continued = queue.run(async () => {
    order.push('second')
    return 'continued'
  })

  await expect(rejected).rejects.toThrow('first failed')
  await expect(continued).resolves.toBe('continued')
  expect(order).toEqual(['first', 'second'])
})
