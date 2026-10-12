import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import { DraftService } from '../../src/main/drafts/draft-service'

const revision = 'a'.repeat(64)
const draftId = '123e4567-e89b-42d3-a456-426614174000'

async function withStoredRecovery(run: (context: {
  drafts: DraftService
  first: ReturnType<typeof createIpcOperations>
  second: ReturnType<typeof createIpcOperations>
}) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-draft-ownership-'))
  try {
    const drafts = new DraftService({ root, appVersion: '1.0.4' })
    await drafts.write({ draftId, markdown: '# recovered', originalAbsolutePath: path.join(root, 'note.md'),
      workspaceAbsolutePath: root, originalRevision: revision, originalMtimeMs: 2, encoding: 'utf8', newline: 'lf' })
    const deps = dependencies()
    deps.workspace.getRoot.mockReturnValue(root)
    deps.workspace.resolveExistingDocument.mockImplementation(async (relative) => path.join(root, relative))
    deps.documents.read.mockImplementation(async (relativePath) => ({ relativePath, markdown: '# original', revision,
      encoding: 'utf8', newline: 'lf', mtimeMs: 2 }))
    const make = () => createIpcOperations({ ...deps, drafts } as never)
    await run({ drafts, first: make(), second: make() })
  } finally { await rm(root, { recursive: true, force: true }) }
}

it('requires a trusted recovery grant and prevents a second window from adopting an owned draft', async () => {
  await withStoredRecovery(async ({ drafts, first, second }) => {
    expect(await second.claimRecoveredDraft({ draftId })).toMatchObject({ ok: false })
    await first.authorizeDraftRecovery(draftId)
    await first.readDocument({ relativePath: 'note.md' })
    expect(await first.claimRecoveredDraft({ draftId })).toMatchObject({ ok: true })
    await expect(second.authorizeDraftRecovery(draftId)).rejects.toThrow('another window')
    expect(await second.saveDraft({ draftId, markdown: 'hijack', expectedOriginalRevision: null, encoding: 'utf8', newline: 'lf' }))
      .toMatchObject({ ok: false })
    expect((await drafts.read(draftId))?.markdown).toBe('# recovered')
    expect(await first.discardDraft({ draftId })).toMatchObject({ ok: true })
    expect(await drafts.read(draftId)).toBeNull()
  })
})

it('rejects recovery onto a different document and releases a cancelled grant for a later window', async () => {
  await withStoredRecovery(async ({ drafts, first, second }) => {
    await first.authorizeDraftRecovery(draftId)
    await first.readDocument({ relativePath: 'other.md' })
    expect(await first.claimRecoveredDraft({ draftId })).toMatchObject({ ok: false })
    expect(await first.releaseDraftRecovery({ draftId })).toMatchObject({ ok: true })
    await second.authorizeDraftRecovery(draftId)
    await second.readDocument({ relativePath: 'note.md' })
    expect(await second.claimRecoveredDraft({ draftId })).toMatchObject({ ok: true })
    expect((await drafts.read(draftId))?.markdown).toBe('# recovered')
  })
})

it('rejects a backup queued before clean termination but permits a later fresh edit', async () => {
  await withStoredRecovery(async ({ drafts, first }) => {
    await first.authorizeDraftRecovery(draftId)
    await first.readDocument({ relativePath: 'note.md' })
    await first.claimRecoveredDraft({ draftId })
    let unblock!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { unblock = resolve })
    const began = new Promise<void>((resolve) => { entered = resolve })
    const markClean = drafts.markClean.bind(drafts)
    vi.spyOn(drafts, 'markClean').mockImplementationOnce(async (id) => { entered(); await gate; await markClean(id) })
    const cleaning = first.cleanDraft({ draftId })
    await began
    const input = { draftId, markdown: '# late', expectedOriginalRevision: revision, encoding: 'utf8', newline: 'lf' }
    const late = first.saveDraft(input)
    unblock()
    expect(await cleaning).toMatchObject({ ok: true })
    expect(await late).toMatchObject({ ok: false })
    expect(await drafts.read(draftId)).toBeNull()
    expect(await first.saveDraft({ ...input, markdown: '# new edit' })).toMatchObject({ ok: true })
    expect((await drafts.read(draftId))?.markdown).toBe('# new edit')
  })
})

it('allows the same window to end a failed write whose durable outcome was uncertain', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-draft-attempt-'))
  try {
    const drafts = new DraftService({ root, appVersion: '1.0.4' })
    const write = drafts.write.bind(drafts)
    vi.spyOn(drafts, 'write').mockImplementationOnce(async (input) => {
      await write(input)
      throw new Error('acknowledgment failed after commit')
    })
    const owner = createIpcOperations({ ...dependencies(), drafts } as never)
    expect(await owner.saveDraft({ draftId, markdown: 'uncertain body', expectedOriginalRevision: null, encoding: 'utf8', newline: 'lf' }))
      .toMatchObject({ ok: false })
    expect((await drafts.read(draftId))?.markdown).toBe('uncertain body')
    expect(await owner.discardDraft({ draftId })).toMatchObject({ ok: true })
    expect(await drafts.read(draftId)).toBeNull()
  } finally { await rm(root, { recursive: true, force: true }) }
})

function dependencies() {
  const workspaceSummary = { name: 'notes', absolutePath: 'C:\\notes' }
  const workspace = {
    getRoot: vi.fn(() => 'C:\\notes'),
    getValidatedActivationSnapshot: vi.fn(async () => ({
      root: 'C:\\notes', epoch: 1, rootVolumeSerial: '1', rootFileId: '1',
    })),
    resolveExistingDocument: vi.fn(async (relativePath: string) => path.join('C:\\notes', relativePath)),
    resolveExistingPandocDocument: vi.fn(async (relativePath: string) => path.join('C:\\notes', relativePath)),
    validateRoot: vi.fn(async () => ({
      summary: workspaceSummary,
      commit: vi.fn(async () => workspaceSummary),
    })),
    restoreCanonicalRoot: vi.fn(async (root: string | null) => (
      root ? { name: path.basename(root), absolutePath: root } : null
    )),
  }
  const document = {
    relativePath: 'note.md',
    markdown: '# saved as',
    revision,
    encoding: 'utf8' as const,
    newline: 'lf' as const,
    mtimeMs: 2,
  }
  const documents = {
    read: vi.fn(async (relativePath: string) => {
      if (relativePath === 'saved.md') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return document
    }),
    create: vi.fn(async () => document),
    save: vi.fn(async (_input?: { relativePath: string }) => ({ revision, mtimeMs: 2 })),
  }
  const drafts = {
    write: vi.fn(async () => ({
      draftId,
      originalAbsolutePath: 'C:\\notes\\note.md',
      workspaceAbsolutePath: 'C:\\notes',
      originalRevision: revision,
      originalMtimeMs: 1,
      encoding: 'utf8' as const,
      newline: 'lf' as const,
      updatedAt: '2026-07-24T00:00:00.000Z',
      ignoredAt: null,
    })),
    read: vi.fn(async () => null),
    listRecoverable: vi.fn(async () => []),
    markIgnored: vi.fn(async () => undefined),
    discard: vi.fn(async () => undefined),
    finalizeSaved: vi.fn(async () => undefined),
  }
  const docx = {
    import: vi.fn(async () => ({
      sourceAbsolutePath: 'C:\\notes\\report.docx',
      sourceFileName: 'report.docx',
      markdown: '# Imported report',
    })),
  }
  return {
    chooseDirectory: vi.fn(async () => null),
    chooseSavePath: vi.fn(async () => 'C:\\notes\\saved.md'),
    workspace,
    documents,
    drafts,
    docx,
    getLastWorkspace: vi.fn(() => 'C:\\notes'),
    setLastWorkspace: vi.fn(async () => undefined),
    onDocumentSourceChanged: vi.fn(),
    reportError: vi.fn(),
    workspaceEntries: {
      renameEntry: vi.fn(async (_relativePath: string, newName: string) => ({
        entry: {
          name: newName,
          relativePath: newName,
          kind: 'document' as const,
        },
        absolutePath: path.join('C:\\notes', newName),
        colorMarks: { marks: {} },
      })),
      trashEntry: vi.fn(async () => ({ colorMarks: { marks: {} } })),
    },
  }
}

describe('draft IPC operations', () => {
  it('keeps committed ownership when the source notification callback throws', async () => {
    const deps = dependencies()
    deps.onDocumentSourceChanged.mockImplementation(() => {
      throw new Error('source callback exposed C:\\private\\note.md')
    })
    deps.reportError.mockImplementation(() => {
      throw new Error('reporting callback failed')
    })
    const operations = createIpcOperations(deps as never)

    await expect(operations.readDocument({ relativePath: 'note.md' })).resolves.toMatchObject({
      ok: true,
      value: { relativePath: 'note.md' },
    })
    const report = deps.reportError.mock.calls[0]?.[0] as Error & { code?: string }
    expect(report).toMatchObject({
      code: 'DOCUMENT_SOURCE_NOTIFICATION_FAILED',
      message: 'Document source notification did not complete',
    })
    expect(report.message).not.toContain('C:\\private')
    await expect(operations.saveDraft({
      draftId,
      markdown: '# still owned',
      expectedOriginalRevision: revision,
      encoding: 'utf8',
      newline: 'lf',
    })).resolves.toMatchObject({ ok: true })
    expect(deps.drafts.write).toHaveBeenLastCalledWith(expect.objectContaining({
      originalAbsolutePath: 'C:\\notes\\note.md',
      originalRevision: revision,
    }))
  })

  it('derives original paths from the owned document instead of accepting renderer paths', async () => {
    const deps = dependencies()
    const operations = createIpcOperations(deps as never)
    await operations.readDocument({ relativePath: 'note.md' })

    const result = await operations.saveDraft({
      draftId,
      markdown: '# changed',
      expectedOriginalRevision: revision,
      encoding: 'utf8',
      newline: 'lf',
    })

    expect(result).toMatchObject({ ok: true, value: { draftId } })
    expect(deps.drafts.write).toHaveBeenCalledWith({
      draftId,
      markdown: '# changed',
      originalAbsolutePath: 'C:\\notes\\note.md',
      workspaceAbsolutePath: 'C:\\notes',
      originalRevision: revision,
      originalMtimeMs: 2,
      encoding: 'utf8',
      newline: 'lf',
    })
  })

  it('accepts a fresh draft identity after another document becomes current', async () => {
    const deps = dependencies()
    const operations = createIpcOperations(deps as never)
    await operations.readDocument({ relativePath: 'note.md' })
    await operations.saveDraft({
      draftId,
      markdown: '# first edit',
      expectedOriginalRevision: revision,
      encoding: 'utf8',
      newline: 'lf',
    })

    const nextDraftId = '223e4567-e89b-42d3-a456-426614174001'
    await operations.readDocument({ relativePath: 'other.md' })
    await expect(operations.saveDraft({
      draftId: nextDraftId,
      markdown: '# second edit',
      expectedOriginalRevision: revision,
      encoding: 'utf8',
      newline: 'lf',
    })).resolves.toMatchObject({ ok: true })
  })

  it('keeps the active draft owner when another document is read for preview', async () => {
    const deps = dependencies()
    const activeRevision = 'a'.repeat(64)
    const previewRevision = 'b'.repeat(64)
    deps.documents.read.mockImplementation(async (relativePath: string) => ({
      relativePath,
      markdown: relativePath === 'active.md' ? '# active' : '# preview',
      revision: relativePath === 'active.md' ? activeRevision : previewRevision,
      encoding: 'utf8' as const,
      newline: 'lf' as const,
      mtimeMs: 2,
    }))
    const operations = createIpcOperations(deps as never)

    await operations.readDocument({ relativePath: 'active.md' })
    await operations.peekDocument({ relativePath: 'preview.md' })

    await expect(operations.saveDraft({
      draftId,
      markdown: '# edited active document',
      expectedOriginalRevision: activeRevision,
      encoding: 'utf8',
      newline: 'lf',
    })).resolves.toMatchObject({
      ok: true,
    })
    expect(deps.drafts.write).toHaveBeenLastCalledWith(expect.objectContaining({
      originalAbsolutePath: 'C:\\notes\\active.md',
      originalRevision: activeRevision,
    }))
  })

  it('allows an untitled draft after the previous document draft was discarded', async () => {
    const deps = dependencies()
    const operations = createIpcOperations(deps as never)
    await operations.readDocument({ relativePath: 'note.md' })
    await operations.saveDraft({
      draftId,
      markdown: '# changed',
      expectedOriginalRevision: revision,
      encoding: 'utf8',
      newline: 'lf',
    })
    await operations.discardDraft({ draftId })

    const untitledDraftId = '323e4567-e89b-42d3-a456-426614174002'
    await expect(operations.saveDraft({
      draftId: untitledDraftId,
      markdown: '# untitled',
      expectedOriginalRevision: null,
      encoding: 'utf8',
      newline: 'lf',
    })).resolves.toMatchObject({ ok: true })
    expect(deps.drafts.write).toHaveBeenLastCalledWith(expect.objectContaining({
      draftId: untitledDraftId,
      originalAbsolutePath: null,
      originalRevision: null,
    }))
  })

  it('rejects malformed draft identifiers and does not call the service', async () => {
    const deps = dependencies()
    const operations = createIpcOperations(deps as never)

    await expect(operations.saveDraft({
      draftId: '../escape',
      markdown: '# changed',
      expectedOriginalRevision: null,
      encoding: 'utf8',
      newline: 'lf',
    })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(deps.drafts.write).not.toHaveBeenCalled()
  })

  it('does not let a second renderer session read another session draft', async () => {
    const deps = dependencies()
    const first = createIpcOperations(deps as never)
    const second = createIpcOperations(deps as never)
    await first.saveDraft({
      draftId,
      markdown: '# changed',
      expectedOriginalRevision: null,
      encoding: 'utf8',
      newline: 'lf',
    })
    deps.drafts.read.mockClear()

    await expect(second.readDraft({ draftId })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
    expect(deps.drafts.read).not.toHaveBeenCalled()
  })

  it('uses a main-owned save dialog and finalizes the draft only after writing succeeds', async () => {
    const deps = dependencies()
    const operations = createIpcOperations(deps as never)
    await operations.saveDraft({
      draftId,
      markdown: '# saved as',
      expectedOriginalRevision: null,
      encoding: 'utf8',
      newline: 'lf',
    })

    const result = await operations.saveDocumentAs({
      draftId,
      markdown: '# saved as',
      encoding: 'utf8',
      newline: 'lf',
      suggestedFileName: '计划.md',
    })

    expect(deps.chooseSavePath).toHaveBeenCalledWith('计划.md')
    expect(deps.documents.create).toHaveBeenCalledWith('saved.md', '# saved as', {
      encoding: 'utf8',
      newline: 'lf',
    })
    expect(deps.drafts.finalizeSaved).toHaveBeenCalledWith(draftId)
    expect(result).toMatchObject({
      ok: true,
      value: { workspace: { absolutePath: 'C:\\notes' }, document: { relativePath: 'note.md' } },
    })
  })
})


it('rebinds draft ownership after the current document is renamed', async () => {
  const deps = dependencies()
  const operations = createIpcOperations(deps as never)
  await operations.readDocument({ relativePath: 'note.md' })
  await operations.renameWorkspaceEntry({
    relativePath: 'note.md',
    newName: 'renamed.md',
  })

  await operations.saveDraft({
    draftId,
    markdown: '# renamed draft',
    expectedOriginalRevision: revision,
    encoding: 'utf8',
    newline: 'lf',
  })

  expect(deps.workspace.resolveExistingDocument).toHaveBeenCalledTimes(1)
  expect(deps.workspace.resolveExistingDocument).toHaveBeenLastCalledWith('note.md')
  expect(deps.drafts.write).toHaveBeenCalledWith(expect.objectContaining({
    originalAbsolutePath: 'C:\\notes\\renamed.md',
  }))
})

it('clears document and draft ownership after trashing the current workspace file', async () => {
  const deps = dependencies()
  const nextDraftId = '623e4567-e89b-42d3-a456-426614174005'
  const operations = createIpcOperations(deps as never)
  await operations.readDocument({ relativePath: 'note.md' })
  await operations.saveDraft({
    draftId,
    markdown: '# owned draft',
    expectedOriginalRevision: revision,
    encoding: 'utf8',
    newline: 'lf',
  })

  await expect(operations.trashWorkspaceEntry({ relativePath: 'note.md' })).resolves.toMatchObject({
    ok: true,
  })
  expect(deps.onDocumentSourceChanged).toHaveBeenCalledTimes(2)
  expect(deps.onDocumentSourceChanged).toHaveBeenLastCalledWith(null)
  await expect(operations.readDraft({ draftId })).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  await expect(operations.saveDraft({
    draftId: nextDraftId,
    markdown: '# untitled after trash',
    expectedOriginalRevision: null,
    encoding: 'utf8',
    newline: 'lf',
  })).resolves.toMatchObject({ ok: true })
  expect(deps.drafts.discard).not.toHaveBeenCalled()
  expect(deps.drafts.write).toHaveBeenLastCalledWith(expect.objectContaining({
    draftId: nextDraftId,
    originalAbsolutePath: null,
    originalRevision: null,
  }))
})

it('clears document and draft ownership after trashing its containing directory', async () => {
  const deps = dependencies()
  const nextDraftId = '723e4567-e89b-42d3-a456-426614174006'
  deps.documents.read.mockResolvedValueOnce({
    relativePath: 'folder/note.md',
    markdown: '# nested',
    revision,
    encoding: 'utf8',
    newline: 'lf',
    mtimeMs: 2,
  })
  const operations = createIpcOperations(deps as never)
  await operations.readDocument({ relativePath: 'folder/note.md' })
  await operations.saveDraft({
    draftId,
    markdown: '# nested draft',
    expectedOriginalRevision: revision,
    encoding: 'utf8',
    newline: 'lf',
  })

  await expect(operations.trashWorkspaceEntry({ relativePath: 'FOLDER\\' })).resolves.toMatchObject({
    ok: true,
  })
  expect(deps.onDocumentSourceChanged).toHaveBeenCalledTimes(2)
  expect(deps.onDocumentSourceChanged).toHaveBeenLastCalledWith(null)
  await expect(operations.saveDraft({
    draftId: nextDraftId,
    markdown: '# untitled after parent trash',
    expectedOriginalRevision: null,
    encoding: 'utf8',
    newline: 'lf',
  })).resolves.toMatchObject({ ok: true })
  expect(deps.drafts.discard).not.toHaveBeenCalled()
  expect(deps.drafts.write).toHaveBeenLastCalledWith(expect.objectContaining({
    originalAbsolutePath: null,
    originalRevision: null,
  }))
})

it('keeps ownership when trashing an unrelated path with the same prefix', async () => {
  const deps = dependencies()
  deps.documents.read.mockResolvedValueOnce({
    relativePath: 'foldered/note.md',
    markdown: '# sibling prefix',
    revision,
    encoding: 'utf8',
    newline: 'lf',
    mtimeMs: 2,
  })
  const operations = createIpcOperations(deps as never)
  await operations.readDocument({ relativePath: 'foldered/note.md' })
  await operations.saveDraft({
    draftId,
    markdown: '# before unrelated trash',
    expectedOriginalRevision: revision,
    encoding: 'utf8',
    newline: 'lf',
  })
  deps.drafts.write.mockClear()

  await expect(operations.trashWorkspaceEntry({ relativePath: 'folder' })).resolves.toMatchObject({
    ok: true,
  })
  expect(deps.onDocumentSourceChanged).toHaveBeenCalledTimes(1)
  await expect(operations.saveDraft({
    draftId,
    markdown: '# still owned',
    expectedOriginalRevision: revision,
    encoding: 'utf8',
    newline: 'lf',
  })).resolves.toMatchObject({ ok: true })
  expect(deps.drafts.write).toHaveBeenCalledWith(expect.objectContaining({
    originalAbsolutePath: 'C:\\notes\\foldered\\note.md',
    originalRevision: revision,
  }))
})

it('clears document and draft ownership after trashing the exact current document', async () => {
  const deps = dependencies()
  const trashItem = vi.fn(async () => undefined)
  const nextDraftId = '823e4567-e89b-42d3-a456-426614174007'
  const operations = createIpcOperations({ ...deps, trashItem } as never)
  await operations.readDocument({ relativePath: 'note.md' })
  await operations.saveDraft({
    draftId,
    markdown: '# before trash',
    expectedOriginalRevision: revision,
    encoding: 'utf8',
    newline: 'lf',
  })

  await expect(operations.trashDocument({ relativePath: 'note.md' })).resolves.toMatchObject({
    ok: true,
  })
  expect(trashItem).toHaveBeenCalledWith('C:\\notes\\note.md')
  expect(deps.onDocumentSourceChanged).toHaveBeenCalledTimes(2)
  expect(deps.onDocumentSourceChanged).toHaveBeenLastCalledWith(null)
  await expect(operations.saveDraft({
    draftId: nextDraftId,
    markdown: '# untitled after exact trash',
    expectedOriginalRevision: null,
    encoding: 'utf8',
    newline: 'lf',
  })).resolves.toMatchObject({ ok: true })
  expect(deps.drafts.discard).not.toHaveBeenCalled()
  expect(deps.drafts.write).toHaveBeenLastCalledWith(expect.objectContaining({
    originalAbsolutePath: null,
    originalRevision: null,
  }))
})

it('runs a save requested during rename only after the renamed owner is committed', async () => {
  const deps = dependencies()
  const savedRevision = 'b'.repeat(64)
  let resolveRename!: (value: Awaited<ReturnType<typeof deps.workspaceEntries.renameEntry>>) => void
  deps.workspaceEntries.renameEntry.mockImplementationOnce(() => new Promise((resolve) => {
    resolveRename = resolve
  }))
  deps.documents.save.mockImplementationOnce(async (input) => {
    if (input?.relativePath !== 'renamed.md') {
      throw Object.assign(new Error(`missing ${input?.relativePath ?? 'unknown'}`), { code: 'ENOENT' })
    }
    return { revision: savedRevision, mtimeMs: 3 }
  })
  const operations = createIpcOperations(deps as never)
  await operations.readDocument({ relativePath: 'note.md' })

  const pendingRename = operations.renameWorkspaceEntry({
    relativePath: 'note.md',
    newName: 'renamed.md',
  })
  await vi.waitFor(() => expect(deps.workspaceEntries.renameEntry).toHaveBeenCalledOnce())
  const pendingSave = operations.saveDocument({
    relativePath: 'note.md',
    markdown: '# saved while renaming',
    expectedRevision: revision,
    encoding: 'utf8',
    newline: 'lf',
  })
  await Promise.resolve()
  expect(deps.documents.save).not.toHaveBeenCalled()
  resolveRename({
    entry: {
      name: 'renamed.md',
      relativePath: 'renamed.md',
      kind: 'document',
    },
    absolutePath: 'C:\\notes\\renamed.md',
    colorMarks: { marks: {} },
  })
  await expect(pendingRename).resolves.toMatchObject({ ok: true })
  await expect(pendingSave).resolves.toMatchObject({ ok: true })
  expect(deps.documents.save).toHaveBeenCalledWith({
    relativePath: 'renamed.md',
    markdown: '# saved while renaming',
    expectedRevision: revision,
    encoding: 'utf8',
    newline: 'lf',
  })

  await operations.saveDraft({
    draftId,
    markdown: '# renamed draft',
    expectedOriginalRevision: savedRevision,
    encoding: 'utf8',
    newline: 'lf',
  })
  expect(deps.drafts.write).toHaveBeenCalledWith(expect.objectContaining({
    originalAbsolutePath: 'C:\\notes\\renamed.md',
    originalRevision: savedRevision,
    originalMtimeMs: 3,
  }))
})

it('rejects a queued save before writing when another owner took over first', async () => {
  const deps = dependencies()
  const nextRevision = 'c'.repeat(64)
  const ownedSnapshot = {
    relativePath: 'note.md',
    markdown: '# owned',
    revision,
    encoding: 'utf8' as const,
    newline: 'lf' as const,
    mtimeMs: 2,
  }
  let resolveNextRead!: (value: typeof ownedSnapshot) => void
  deps.documents.read
    .mockResolvedValueOnce(ownedSnapshot)
    .mockImplementationOnce(() => new Promise((resolve) => {
      resolveNextRead = resolve
    }))
  const operations = createIpcOperations(deps as never)
  await operations.readDocument({ relativePath: 'note.md' })

  const pendingRead = operations.readDocument({ relativePath: 'next.md' })
  await vi.waitFor(() => expect(deps.documents.read).toHaveBeenCalledWith('next.md'))
  const pendingSave = operations.saveDocument({
    relativePath: 'note.md',
    markdown: '# stale owner save',
    expectedRevision: revision,
    encoding: 'utf8',
    newline: 'lf',
  })
  resolveNextRead({
    ...ownedSnapshot,
    relativePath: 'next.md',
    markdown: '# next',
    revision: nextRevision,
    mtimeMs: 4,
  })

  await expect(pendingRead).resolves.toMatchObject({
    ok: true,
    value: { relativePath: 'next.md' },
  })
  await expect(pendingSave).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  expect(deps.documents.save).not.toHaveBeenCalled()
})

it('merges a deferred save into the same owner after that owner is renamed', async () => {
  const deps = dependencies()
  const savedRevision = 'b'.repeat(64)
  let resolveSave!: (value: { revision: string; mtimeMs: number }) => void
  deps.documents.save.mockImplementationOnce(() => new Promise((resolve) => {
    resolveSave = resolve
  }))
  const operations = createIpcOperations(deps as never)
  await operations.readDocument({ relativePath: 'note.md' })

  const pendingSave = operations.saveDocument({
    relativePath: 'note.md',
    markdown: '# saved before rename completed',
    expectedRevision: revision,
    encoding: 'utf8',
    newline: 'lf',
  })
  await vi.waitFor(() => expect(deps.documents.save).toHaveBeenCalledOnce())
  const pendingRename = operations.renameWorkspaceEntry({
    relativePath: 'note.md',
    newName: 'renamed.md',
  })
  await Promise.resolve()
  expect(deps.workspaceEntries.renameEntry).not.toHaveBeenCalled()
  resolveSave({ revision: savedRevision, mtimeMs: 7 })
  await expect(pendingSave).resolves.toMatchObject({ ok: true })
  await expect(pendingRename).resolves.toMatchObject({ ok: true })

  await expect(operations.saveDraft({
    draftId,
    markdown: '# draft after save and rename',
    expectedOriginalRevision: savedRevision,
    encoding: 'utf8',
    newline: 'lf',
  })).resolves.toMatchObject({ ok: true })
  expect(deps.drafts.write).toHaveBeenLastCalledWith(expect.objectContaining({
    originalAbsolutePath: 'C:\\notes\\renamed.md',
    originalRevision: savedRevision,
    originalMtimeMs: 7,
  }))
})

it('lets a later same-path reopen become authoritative after an earlier save', async () => {
  const deps = dependencies()
  const savedRevision = 'b'.repeat(64)
  const reopenedRevision = 'c'.repeat(64)
  deps.documents.read
    .mockResolvedValueOnce({
      relativePath: 'note.md',
      markdown: '# original owner',
      revision,
      encoding: 'utf8',
      newline: 'lf',
      mtimeMs: 2,
    })
    .mockResolvedValueOnce({
      relativePath: 'note.md',
      markdown: '# reopened owner',
      revision: reopenedRevision,
      encoding: 'utf8',
      newline: 'lf',
      mtimeMs: 11,
    })
  let resolveSave!: (value: { revision: string; mtimeMs: number }) => void
  deps.documents.save.mockImplementationOnce(() => new Promise((resolve) => {
    resolveSave = resolve
  }))
  const operations = createIpcOperations(deps as never)
  await operations.readDocument({ relativePath: 'note.md' })

  const pendingSave = operations.saveDocument({
    relativePath: 'note.md',
    markdown: '# stale deferred save',
    expectedRevision: revision,
    encoding: 'utf8',
    newline: 'lf',
  })
  await vi.waitFor(() => expect(deps.documents.save).toHaveBeenCalledOnce())
  const pendingReopen = operations.readDocument({ relativePath: 'note.md' })
  await Promise.resolve()
  expect(deps.documents.read).toHaveBeenCalledTimes(1)
  resolveSave({ revision: savedRevision, mtimeMs: 7 })
  await expect(pendingSave).resolves.toMatchObject({ ok: true })
  await expect(pendingReopen).resolves.toMatchObject({
    ok: true,
    value: { revision: reopenedRevision },
  })

  await expect(operations.saveDraft({
    draftId,
    markdown: '# draft from reopened owner',
    expectedOriginalRevision: reopenedRevision,
    encoding: 'utf8',
    newline: 'lf',
  })).resolves.toMatchObject({ ok: true })
  expect(deps.drafts.write).toHaveBeenLastCalledWith(expect.objectContaining({
    originalAbsolutePath: 'C:\\notes\\note.md',
    originalRevision: reopenedRevision,
    originalMtimeMs: 11,
  }))
})

it('keeps a committed rename authoritative when the next ownership preparation fails', async () => {
  const deps = dependencies()
  const brokenRevision = 'c'.repeat(64)
  deps.documents.read.mockImplementation(async (relativePath: string) => ({
    relativePath,
    markdown: relativePath === 'note.md' ? '# owned' : '# broken candidate',
    revision: relativePath === 'note.md' ? revision : brokenRevision,
    encoding: 'utf8' as const,
    newline: 'lf' as const,
    mtimeMs: relativePath === 'note.md' ? 2 : 13,
  }))
  deps.workspace.resolveExistingDocument.mockImplementation(async (relativePath: string) => {
    if (relativePath === 'broken.md') throw new Error('absolute path unavailable')
    return path.join('C:\\notes', relativePath)
  })
  let resolveRename!: (value: Awaited<ReturnType<typeof deps.workspaceEntries.renameEntry>>) => void
  deps.workspaceEntries.renameEntry.mockImplementationOnce(() => new Promise((resolve) => {
    resolveRename = resolve
  }))
  const operations = createIpcOperations(deps as never)
  await operations.readDocument({ relativePath: 'note.md' })
  await operations.saveDraft({
    draftId,
    markdown: '# first draft',
    expectedOriginalRevision: revision,
    encoding: 'utf8',
    newline: 'lf',
  })
  deps.drafts.write.mockClear()

  const pendingRename = operations.renameWorkspaceEntry({
    relativePath: 'note.md',
    newName: 'renamed.md',
  })
  await vi.waitFor(() => expect(deps.workspaceEntries.renameEntry).toHaveBeenCalledOnce())
  const pendingBrokenRead = operations.readDocument({ relativePath: 'broken.md' })
  await Promise.resolve()
  expect(deps.workspace.resolveExistingDocument).not.toHaveBeenCalledWith('broken.md')
  resolveRename({
    entry: { name: 'renamed.md', relativePath: 'renamed.md', kind: 'document' },
    absolutePath: 'C:\\notes\\renamed.md',
    colorMarks: { marks: {} },
  })
  await expect(pendingRename).resolves.toMatchObject({ ok: true })
  await expect(pendingBrokenRead).resolves.toMatchObject({ ok: false })
  const afterRename = await operations.saveDraft({
    draftId,
    markdown: '# preserved after rename',
    expectedOriginalRevision: revision,
    encoding: 'utf8',
    newline: 'lf',
  })

  expect(afterRename).toMatchObject({ ok: true })
  expect(deps.onDocumentSourceChanged).toHaveBeenCalledTimes(1)
  expect(deps.onDocumentSourceChanged).toHaveBeenLastCalledWith(null)
  expect(deps.drafts.write).toHaveBeenCalledOnce()
  expect(deps.drafts.write).toHaveBeenCalledWith(expect.objectContaining({
    draftId,
    originalAbsolutePath: 'C:\\notes\\renamed.md',
    originalRevision: revision,
  }))
})

it('prepares saved-as ownership before finalizing its draft', async () => {
  const deps = dependencies()
  const otherDraftId = '423e4567-e89b-42d3-a456-426614174003'
  deps.documents.create.mockResolvedValueOnce({
    relativePath: 'saved.md',
    markdown: '# saved as',
    revision,
    encoding: 'utf8',
    newline: 'lf',
    mtimeMs: 2,
  })
  deps.workspace.resolveExistingDocument.mockImplementation(async (relativePath: string) => {
    if (relativePath === 'saved.md') throw new Error('absolute path unavailable')
    return path.join('C:\\notes', relativePath)
  })
  const operations = createIpcOperations(deps as never)
  await operations.saveDraft({
    draftId,
    markdown: '# saved as',
    expectedOriginalRevision: null,
    encoding: 'utf8',
    newline: 'lf',
  })

  await expect(operations.saveDocumentAs({
    draftId,
    markdown: '# saved as',
    encoding: 'utf8',
    newline: 'lf',
    suggestedFileName: 'saved.md',
  })).resolves.toMatchObject({ ok: false })
  const otherDraft = await operations.saveDraft({
    draftId: otherDraftId,
    markdown: '# must not replace the finalized owner',
    expectedOriginalRevision: null,
    encoding: 'utf8',
    newline: 'lf',
  })
  const originalDraft = await operations.saveDraft({
    draftId,
    markdown: '# retry original draft',
    expectedOriginalRevision: null,
    encoding: 'utf8',
    newline: 'lf',
  })

  expect(deps.drafts.finalizeSaved).not.toHaveBeenCalled()
  expect(otherDraft).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(originalDraft).toMatchObject({ ok: true })
})

it('commits queued reads in call order so the later document is authoritative', async () => {
  const deps = dependencies()
  const oldRevision = 'b'.repeat(64)
  const currentRevision = 'c'.repeat(64)
  deps.documents.read.mockImplementation(async (relativePath: string) => ({
    relativePath,
    markdown: relativePath === 'old.md' ? '# Old' : '# Current',
    revision: relativePath === 'old.md' ? oldRevision : currentRevision,
    encoding: 'utf8' as const,
    newline: 'lf' as const,
    mtimeMs: relativePath === 'old.md' ? 3 : 4,
  }))
  let resolveOldAbsolutePath!: (absolutePath: string) => void
  deps.workspace.resolveExistingDocument.mockImplementation((relativePath: string) => (
    relativePath === 'old.md'
      ? new Promise((resolve) => { resolveOldAbsolutePath = resolve })
      : Promise.resolve(path.join('C:\\notes', relativePath))
  ))
  const operations = createIpcOperations(deps as never)

  const oldRead = operations.readDocument({ relativePath: 'old.md' })
  await vi.waitFor(() => expect(deps.workspace.resolveExistingDocument).toHaveBeenCalledWith('old.md'))
  const currentRead = operations.readDocument({ relativePath: 'current.md' })
  await Promise.resolve()
  expect(deps.documents.read).not.toHaveBeenCalledWith('current.md')
  resolveOldAbsolutePath('C:\\notes\\old.md')
  const oldResult = await oldRead
  const currentResult = await currentRead
  const currentDraft = await operations.saveDraft({
    draftId,
    markdown: '# Current draft',
    expectedOriginalRevision: currentRevision,
    encoding: 'utf8',
    newline: 'lf',
  })

  expect(oldResult).toMatchObject({ ok: true, value: { relativePath: 'old.md' } })
  expect(currentResult).toMatchObject({ ok: true, value: { relativePath: 'current.md' } })
  expect(currentDraft).toMatchObject({ ok: true })
  expect(deps.drafts.write).toHaveBeenLastCalledWith(expect.objectContaining({
    originalAbsolutePath: 'C:\\notes\\current.md',
    originalRevision: currentRevision,
  }))
})

it('finishes Save As before a later read becomes authoritative', async () => {
  const deps = dependencies()
  const currentRevision = 'c'.repeat(64)
  const savedRevision = 'd'.repeat(64)
  deps.documents.read.mockImplementation(async (relativePath: string) => {
    if (relativePath === 'saved.md') {
      return {
        relativePath,
        markdown: '# Existing save target',
        revision: savedRevision,
        encoding: 'utf8' as const,
        newline: 'lf' as const,
        mtimeMs: 5,
      }
    }
    return {
      relativePath,
      markdown: relativePath === 'current.md' ? '# Current' : '# Note',
      revision: relativePath === 'current.md' ? currentRevision : revision,
      encoding: 'utf8' as const,
      newline: 'lf' as const,
      mtimeMs: relativePath === 'current.md' ? 4 : 2,
    }
  })
  deps.documents.save.mockResolvedValueOnce({ revision: 'e'.repeat(64), mtimeMs: 6 })
  let resolveFinalize!: () => void
  deps.drafts.finalizeSaved.mockImplementationOnce(() => new Promise((resolve) => {
    resolveFinalize = () => resolve(undefined)
  }))
  const operations = createIpcOperations(deps as never)
  await operations.readDocument({ relativePath: 'note.md' })
  await operations.saveDraft({
    draftId,
    markdown: '# Draft before Save As',
    expectedOriginalRevision: revision,
    encoding: 'utf8',
    newline: 'lf',
  })

  const savedAs = operations.saveDocumentAs({
    draftId,
    markdown: '# Saved As',
    encoding: 'utf8',
    newline: 'lf',
    suggestedFileName: 'saved.md',
  })
  await vi.waitFor(() => expect(deps.drafts.finalizeSaved).toHaveBeenCalledWith(draftId))
  const currentRead = operations.readDocument({ relativePath: 'current.md' })
  await Promise.resolve()
  expect(deps.documents.read).not.toHaveBeenCalledWith('current.md')
  resolveFinalize()
  const savedAsResult = await savedAs
  const currentReadResult = await currentRead
  const currentDraftId = '523e4567-e89b-42d3-a456-426614174004'
  const currentDraft = await operations.saveDraft({
    draftId: currentDraftId,
    markdown: '# Current draft',
    expectedOriginalRevision: currentRevision,
    encoding: 'utf8',
    newline: 'lf',
  })

  expect(savedAsResult).toMatchObject({ ok: true })
  expect(currentReadResult).toMatchObject({
    ok: true,
    value: { relativePath: 'current.md' },
  })
  expect(currentDraft).toMatchObject({ ok: true })
  expect(deps.drafts.write).toHaveBeenLastCalledWith(expect.objectContaining({
    draftId: currentDraftId,
    originalAbsolutePath: 'C:\\notes\\current.md',
    originalRevision: currentRevision,
  }))
})

it('lets a queued import source supersede the earlier prepared read', async () => {
  const deps = dependencies()
  deps.documents.read.mockResolvedValueOnce({
    relativePath: 'old.md',
    markdown: '# Old',
    revision: 'b'.repeat(64),
    encoding: 'utf8',
    newline: 'lf',
    mtimeMs: 3,
  })
  let resolveOldAbsolutePath!: (absolutePath: string) => void
  deps.workspace.resolveExistingDocument.mockImplementationOnce(() => new Promise((resolve) => {
    resolveOldAbsolutePath = resolve
  }))
  const operations = createIpcOperations(deps as never)

  const oldRead = operations.readDocument({ relativePath: 'old.md' })
  await vi.waitFor(() => expect(deps.workspace.resolveExistingDocument).toHaveBeenCalledOnce())
  const imported = operations.importDocx({ relativePath: 'report.docx' })
  await Promise.resolve()
  expect(deps.docx.import).not.toHaveBeenCalled()
  resolveOldAbsolutePath('C:\\notes\\old.md')
  const oldResult = await oldRead
  const importResult = await imported

  expect(oldResult).toMatchObject({ ok: true, value: { relativePath: 'old.md' } })
  expect(importResult).toMatchObject({
    ok: true,
    value: { sourceAbsolutePath: 'C:\\notes\\report.docx' },
  })
  expect(deps.onDocumentSourceChanged.mock.calls).toEqual([
    [null],
    ['C:\\notes\\report.docx'],
  ])
})

it('lets a queued recovered draft supersede the earlier prepared read', async () => {
  const deps = dependencies()
  deps.documents.read.mockResolvedValueOnce({
    relativePath: 'old.md',
    markdown: '# Old',
    revision: 'b'.repeat(64),
    encoding: 'utf8',
    newline: 'lf',
    mtimeMs: 3,
  })
  let resolveOldAbsolutePath!: (absolutePath: string) => void
  deps.workspace.resolveExistingDocument.mockImplementationOnce(() => new Promise((resolve) => {
    resolveOldAbsolutePath = resolve
  }))
  const operations = createIpcOperations(deps as never)

  const oldRead = operations.readDocument({ relativePath: 'old.md' })
  await vi.waitFor(() => expect(deps.workspace.resolveExistingDocument).toHaveBeenCalledOnce())
  const recoveredSave = operations.saveDraft({
    draftId,
    markdown: '# Recovered draft',
    expectedOriginalRevision: null,
    encoding: 'utf8',
    newline: 'lf',
  })
  await Promise.resolve()
  expect(deps.drafts.write).not.toHaveBeenCalled()
  resolveOldAbsolutePath('C:\\notes\\old.md')
  const oldResult = await oldRead
  const recoveredSaveResult = await recoveredSave
  const recoveredDraft = await operations.readDraft({ draftId })

  expect(oldResult).toMatchObject({ ok: true, value: { relativePath: 'old.md' } })
  expect(recoveredSaveResult).toMatchObject({ ok: true })
  expect(recoveredDraft).toMatchObject({ ok: true })
})
