import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import type { CanonicalFileIdentity } from '../../src/main/documents/document-identity'
import { DocumentRollbackIncompleteError } from '../../src/main/documents/document-service'
import { PUBLIC_ERROR_MESSAGES } from '../../src/shared/public-errors'

const draftId = '123e4567-e89b-42d3-a456-426614174000'
const intentId = '550e8400-e29b-41d4-a716-446655440000'
const revisionA = 'a'.repeat(64)
const revisionB = 'b'.repeat(64)
const oldRoot = 'C:\\old'
const targetRoot = 'C:\\new'

function snapshot(relativePath: string, markdown = '# note', revision = revisionA) {
  return {
    relativePath,
    markdown,
    revision,
    encoding: 'utf8' as const,
    newline: 'lf' as const,
    mtimeMs: revision === revisionA ? 1 : 2,
  }
}

function harness(options: {
  noWorkspace?: boolean
  failActivation?: boolean
  failWrite?: boolean
  failFinalize?: boolean
  sameWorkspace?: boolean
  targetExists?: boolean
  sourceOpen?: boolean
  desktopAiAbsent?: boolean
  failDestinationGuard?: boolean
  failSwitchCompletion?: boolean
  failCreatedRollback?: boolean
  inPlaceTarget?: boolean
  statefulAi?: boolean
  reuseIntentId?: boolean
  now?: number
} = {}) {
  const destinationRoot = options.sameWorkspace ? oldRoot : targetRoot
  let root = options.noWorkspace ? '' : oldRoot
  let epoch = 1
  let lastWorkspace: string | null = oldRoot
  let created = false
  let saveForMainCalls = 0
  let rollbackPublisherObserved = false
  let issuedIntentCount = 0
  const events: string[] = []
  const oldAuthority = { workspaceId: 'workspace-old', workspaceGeneration: 'generation-old' }
  const targetAuthority = { workspaceId: 'workspace-new', workspaceGeneration: 'generation-new' }
  const workspaceCommit = vi.fn(async () => {
    events.push('workspace.commit')
    root = destinationRoot
    epoch += 1
    return { name: 'new', absolutePath: targetRoot }
  })
  const workspace = {
    getRoot: vi.fn(() => { if (!root) throw new Error('No workspace is open'); return root }),
    getActivationSnapshot: vi.fn(() => ({ root, epoch })),
    getValidatedActivationSnapshot: vi.fn(async () => {
      if (!root) throw new Error('No workspace is open')
      return { root, epoch, rootVolumeSerial: root === oldRoot ? '1' : '2', rootFileId: '1' }
    }),
    getSaveAsActivationSnapshot: vi.fn(async (): Promise<{ root: string | null; epoch: number }> =>
      root ? await workspace.getValidatedActivationSnapshot() : { root: null, epoch }),
    validateRoot: vi.fn(async (candidate: string) => {
      expect(candidate).toBe(destinationRoot)
      return {
        summary: { name: options.sameWorkspace ? 'old' : 'new', absolutePath: destinationRoot },
        commit: workspaceCommit,
      }
    }),
    restoreCanonicalRoot: vi.fn(async (candidate: string | null) => {
      events.push(`workspace.restore:${candidate}`)
      root = candidate ?? ''
      epoch += 1
      return candidate ? { name: path.basename(candidate), absolutePath: candidate } : null
    }),
    resolveExistingDocument: vi.fn(async (relativePath: string) => path.join(root, relativePath)),
  }
  const documents = {
    read: vi.fn(async (relativePath: string) => snapshot(relativePath)),
    readForMain: vi.fn(async (relativePath: string) => {
      if (root === oldRoot && relativePath === 'note.md') {
        return { document: snapshot('note.md'), identity: '1.a' as CanonicalFileIdentity }
      }
      if (root === destinationRoot && relativePath === 'saved.md' && (created || options.targetExists)) {
        return { document: snapshot('saved.md', '# saved', revisionB), identity: '2.b' as CanonicalFileIdentity }
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    }),
    create: vi.fn(async (relativePath: string, markdown: string) => {
      events.push('document.create')
      if (options.failWrite) throw new Error('write failed')
      created = true
      return snapshot(relativePath, markdown, revisionB)
    }),
    createForMain: vi.fn(async (
      relativePath: string,
      markdown: string,
      _format: unknown,
      publish?: (identity: CanonicalFileIdentity) => Promise<void>,
    ) => {
      events.push('document.create')
      if (options.failWrite) throw new Error('write failed')
      created = true
      const identity = '2.b' as CanonicalFileIdentity
      const result = { document: snapshot(relativePath, markdown, revisionB), identity }
      try {
        await publish?.(result as never)
      } catch (error) {
        created = false
        throw error
      }
      return result
    }),
    saveForMain: vi.fn(async (
      _input: unknown,
      publish?: (identity: CanonicalFileIdentity) => Promise<void>,
    ) => {
      events.push('document.save')
      saveForMainCalls += 1
      if (saveForMainCalls > 1 && publish) rollbackPublisherObserved = true
      const identity = (saveForMainCalls > 1
        ? '4.d'
        : options.targetExists || options.inPlaceTarget ? '3.c' : '2.b') as CanonicalFileIdentity
      const result = {
        result: { revision: saveForMainCalls > 1 ? revisionA : revisionB, mtimeMs: 2 },
        identity,
      }
      await publish?.(result as never)
      return result
    }),
    removeCreatedForRollback: vi.fn(async () => {
      events.push('document.rollback')
      if (options.failCreatedRollback) {
        throw new DocumentRollbackIncompleteError(
          new Error('created document rollback requested'),
          new Error('created target retained'),
        )
      }
      created = false
    }),
    save: vi.fn(async () => ({ revision: revisionB, mtimeMs: 2 })),
  }
  const finalizeCommit = vi.fn(async () => { events.push('draft.commit-finalize') })
  const finalizeRollback = vi.fn(async () => { events.push('draft.rollback-finalize') })
  const drafts = {
    write: vi.fn(async () => ({
      draftId, originalAbsolutePath: path.join(oldRoot, 'note.md'), workspaceAbsolutePath: oldRoot,
      originalRevision: revisionA, originalMtimeMs: 1, encoding: 'utf8' as const,
      newline: 'lf' as const, updatedAt: '2026-09-02T00:00:00.000Z', ignoredAt: null,
    })),
    read: vi.fn(async () => null),
    listRecoverable: vi.fn(async () => []),
    markIgnored: vi.fn(async () => undefined),
    discard: vi.fn(async () => undefined),
    finalizeSaved: vi.fn(async () => undefined),
    beginFinalizeSaved: vi.fn(async () => {
      events.push('draft.begin-finalize')
      if (options.failFinalize) throw new Error('finalize failed')
      return { commit: finalizeCommit, rollback: finalizeRollback }
    }),
  }
  const transferCommit = vi.fn(async () => { events.push('registry.commit') })
  const transferRollback = vi.fn(async () => { events.push('registry.rollback') })
  const transferGuard = vi.fn(async () => { events.push('registry.guard') })
  const transferHandoff = vi.fn(async () => { events.push('registry.handoff') })
  const destinationGuardRelease = vi.fn(async () => { events.push('registry.destination-release') })
  const destinationGuardHandoff = vi.fn(async () => { events.push('registry.destination-handoff') })
  const registryGuard = vi.fn(async () => {
    events.push('registry.destination-guard')
    if (options.failDestinationGuard) throw new Error('destination guard failed')
    return { handoff: destinationGuardHandoff, release: destinationGuardRelease }
  })
  const aiRendererPorts = {
    beginOpenDocumentTransfer: vi.fn(async () => options.sourceOpen === false ? null : ({
        guardDestination: transferGuard,
        handoffDestination: transferHandoff,
        commit: transferCommit,
        rollback: transferRollback,
      })),
  }
  const ticket = { generation: 1, nonce: 'ticket' }
  let activeAiRoot = oldRoot
  let preparedAiSource: string | null = null
  const desktopAi = {
    ownerId: 17,
    getWorkspaceAuthority: vi.fn(async () => !root ? null : root === oldRoot ? oldAuthority : targetAuthority),
    prepareWorkspaceSwitch: vi.fn(async () => {
      events.push('ai.prepare')
      if (options.statefulAi) {
        if (preparedAiSource !== null) throw new Error('AI switch is still pending')
        preparedAiSource = activeAiRoot
      }
      return ticket
    }),
    activateWorkspace: vi.fn(async () => {
      events.push('ai.activate')
      if (options.failActivation) throw new Error('activation failed')
      if (options.statefulAi) {
        if (preparedAiSource === null) throw new Error('AI ticket already consumed')
        activeAiRoot = root
        preparedAiSource = null
      }
    }),
    abortWorkspaceSwitch: vi.fn(async () => {
      events.push('ai.abort')
      if (options.failSwitchCompletion) throw new Error('AI gate completion failed')
      if (options.statefulAi) {
        if (preparedAiSource !== root) throw new Error('AI source does not match restored workspace')
        preparedAiSource = null
      }
    }),
  }
  const assets = {
    allowWorkspaceRoot: vi.fn(async () => { events.push(`assets.allow:${root}`) }),
    migrateDraftAssets: vi.fn(async (_draftId: string, markdown: string) => ({
      markdown,
      rollback: vi.fn(async () => { events.push('assets.rollback') }),
    })),
  }
  const deps = {
    chooseDirectory: vi.fn(async () => null),
    chooseSavePath: vi.fn(async () => path.join(
      destinationRoot,
      options.inPlaceTarget ? 'note.md' : 'saved.md',
    )),
    workspace,
    documents,
    drafts,
    assets,
    desktopAi: options.desktopAiAbsent ? undefined : desktopAi,
    aiRendererPorts,
    openDocumentRegistry: { guardDestination: registryGuard },
    getLastWorkspace: vi.fn(() => lastWorkspace),
    setLastWorkspace: vi.fn(async (next: string | null) => {
      events.push(`settings.workspace:${next}`)
      lastWorkspace = next
    }),
    onDocumentSourceChanged: vi.fn(),
    reportError: vi.fn(),
    createSaveAsIntentId: vi.fn(() => options.reuseIntentId || issuedIntentCount++ === 0 ? intentId : randomUUID()),
    now: vi.fn(() => options.now ?? 1_000),
  }
  const operations = createIpcOperations(deps as never)
  const ownDraft = async () => {
    if (!options.noWorkspace) await operations.readDocument({ relativePath: 'note.md' })
    await operations.saveDraft({
      draftId, markdown: '# saved', expectedOriginalRevision: options.noWorkspace ? null : revisionA,
      encoding: 'utf8', newline: 'lf',
    })
  }
  const begin = () => operations.beginSaveDocumentAs({
    draftId, markdown: '# saved', encoding: 'utf8', newline: 'lf', suggestedFileName: 'saved.md',
  })
  return {
    operations, deps, documents, drafts, desktopAi, aiRendererPorts, events,
    workspaceCommit, transferGuard, transferHandoff, transferCommit, transferRollback, registryGuard,
    destinationGuardHandoff, destinationGuardRelease, finalizeCommit, finalizeRollback,
    ownDraft, begin, created: () => created, root: () => root,
    activeAiRoot: () => activeAiRoot, aiSwitchPending: () => preparedAiSource !== null,
    rollbackPublisherObserved: () => rollbackPublisherObserved,
  }
}

it('saves an owned unnamed draft without a source workspace through the validated two-phase transaction', async () => {
  const state = harness({ noWorkspace: true, sourceOpen: false })
  await state.ownDraft()
  const begun = await state.begin()
  expect(begun).toMatchObject({ ok: true, value: { changesWorkspace: true } })
  if (!begun.ok || !begun.value) throw new Error('Missing save intent')
  expect(state.deps.chooseSavePath).toHaveBeenCalledOnce()
  expect(state.workspaceCommit).not.toHaveBeenCalled()
  const saved = await state.operations.commitSaveDocumentAs({ intentId: begun.value.intentId })
  expect(saved).toMatchObject({ ok: true, value: { document: { markdown: '# saved' } } })
  expect(state.registryGuard).toHaveBeenCalledOnce()
  expect(state.finalizeCommit).toHaveBeenCalledOnce()
  expect(state.root()).toBe(targetRoot)
})

it('retains an unnamed draft and restores the empty workspace after a failed Save As', async () => {
  const state = harness({ noWorkspace: true, sourceOpen: false, failWrite: true })
  await state.ownDraft()
  const begun = await state.begin()
  expect(begun.ok).toBe(true)
  if (!begun.ok || !begun.value) throw new Error('Missing save intent')
  expect(await state.operations.commitSaveDocumentAs({ intentId: begun.value.intentId })).toMatchObject({ ok: false })
  expect(state.deps.workspace.restoreCanonicalRoot).toHaveBeenCalledWith(null)
  expect(state.root()).toBe('')
  expect(state.finalizeCommit).not.toHaveBeenCalled()
  expect(state.drafts.discard).not.toHaveBeenCalled()
  expect(state.deps.assets.allowWorkspaceRoot).toHaveBeenCalledTimes(1)
  expect(state.desktopAi.abortWorkspaceSwitch).toHaveBeenCalledOnce()
})

it('rejects a Save As intent if its empty workspace has changed and returned to empty', async () => {
  const state = harness({ noWorkspace: true, sourceOpen: false })
  await state.ownDraft()
  const begun = await state.begin()
  expect(begun.ok).toBe(true)
  if (!begun.ok || !begun.value) throw new Error('Missing save intent')
  await state.deps.workspace.restoreCanonicalRoot(null)
  expect(await state.operations.commitSaveDocumentAs({ intentId: begun.value.intentId })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(state.documents.createForMain).not.toHaveBeenCalled()
})

it('keeps literal code source untouched when committing a two-phase Save As', async () => {
  const state = harness({ sameWorkspace: true })
  await state.ownDraft()
  state.deps.chooseSavePath.mockResolvedValue(path.join(oldRoot, '.env.production'))
  state.deps.assets.migrateDraftAssets.mockImplementation(async () => ({ markdown: 'rewritten as Markdown', rollback: vi.fn(async () => {}) }))
  const source = '// ![](literal.png)\r\nTOKEN=literal\n'
  const begun = await state.operations.beginSaveDocumentAs({ draftId, markdown: source, encoding: 'utf8', newline: 'crlf', suggestedFileName: '.env.production' })
  if (!begun.ok || !begun.value) throw new Error('Expected save intent')
  expect(begun.value.targetFileName).toBe('.env.production')
  const result = await state.operations.commitSaveDocumentAs({ intentId: begun.value.intentId })
  expect(result).toMatchObject({ ok: true, value: { document: { relativePath: '.env.production', markdown: source } } })
  expect(state.deps.assets.migrateDraftAssets).not.toHaveBeenCalled()
  expect(state.operations.getCurrentDocumentAbsolutePath()).toBe(path.join(oldRoot, '.env.production'))
})

it('begins and aborts Save As without changing workspace, document, draft, registry, or AI state', async () => {
  const state = harness({ reuseIntentId: true })
  await state.ownDraft()

  await expect(state.begin()).resolves.toEqual({
    ok: true,
    value: {
      intentId,
      targetWorkspace: { name: 'new', absolutePath: targetRoot },
      targetFileName: 'saved.md',
      targetRelativePath: 'saved.md',
      changesWorkspace: true,
    },
  })
  expect(state.workspaceCommit).not.toHaveBeenCalled()
  expect(state.documents.create).not.toHaveBeenCalled()
  expect(state.drafts.beginFinalizeSaved).not.toHaveBeenCalled()
  expect(state.desktopAi.prepareWorkspaceSwitch).not.toHaveBeenCalled()
  expect(state.aiRendererPorts.beginOpenDocumentTransfer).not.toHaveBeenCalled()

  await expect(state.operations.abortSaveDocumentAs({ intentId })).resolves.toEqual({ ok: true, value: null })
  await expect(state.operations.abortSaveDocumentAs({ intentId })).resolves.toMatchObject({
    ok: false, error: { code: 'INVALID_INPUT' },
  })
  await expect(state.begin()).resolves.toMatchObject({
    ok: false, error: { code: 'OPERATION_FAILED' },
  })
  expect(state.events).toEqual([])
})

it('does not let the legacy one-shot API bypass cross-workspace confirmation', async () => {
  const state = harness()
  await state.ownDraft()

  await expect(state.operations.saveDocumentAs({
    draftId, markdown: '# saved', encoding: 'utf8', newline: 'lf', suggestedFileName: 'saved.md',
  })).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } })

  expect(state.workspaceCommit).not.toHaveBeenCalled()
  expect(state.documents.create).not.toHaveBeenCalled()
  expect(state.desktopAi.prepareWorkspaceSwitch).not.toHaveBeenCalled()
  expect(state.events).toEqual([])
})

it('fails closed on cross-workspace legacy Save As when desktop AI is unavailable', async () => {
  const state = harness({ desktopAiAbsent: true })
  await state.ownDraft()

  await expect(state.operations.saveDocumentAs({
    draftId, markdown: '# saved', encoding: 'utf8', newline: 'lf', suggestedFileName: 'saved.md',
  })).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } })

  expect(state.workspaceCommit).not.toHaveBeenCalled()
  expect(state.documents.create).not.toHaveBeenCalled()
})

it('commits one opaque Save As intent once and returns the activated AI workspace authority', async () => {
  const state = harness()
  await state.ownDraft()
  await state.begin()

  await expect(state.operations.commitSaveDocumentAs({ intentId })).resolves.toEqual({
    ok: true,
    value: {
      workspace: { name: 'new', absolutePath: targetRoot },
      document: snapshot('saved.md', '# saved', revisionB),
      changesWorkspace: true,
      aiWorkspace: { workspaceId: 'workspace-new', workspaceGeneration: 'generation-new' },
    },
  })
  expect(state.events).toEqual([
    'ai.prepare', 'workspace.commit', `assets.allow:${targetRoot}`,
    `settings.workspace:${targetRoot}`, 'document.create', 'registry.guard', 'draft.begin-finalize',
    'registry.commit', 'ai.activate', 'draft.commit-finalize',
  ])
  await expect(state.operations.commitSaveDocumentAs({ intentId })).resolves.toMatchObject({
    ok: false, error: { code: 'INVALID_INPUT' },
  })
})

it('establishes and drains the AI gate before revalidating or reading workspace state', async () => {
  const state = harness()
  await state.ownDraft()
  await state.begin()
  state.desktopAi.prepareWorkspaceSwitch.mockClear()
  state.deps.workspace.getValidatedActivationSnapshot.mockClear()
  state.documents.readForMain.mockClear()

  await expect(state.operations.commitSaveDocumentAs({ intentId })).resolves.toMatchObject({ ok: true })

  const preparedAt = state.desktopAi.prepareWorkspaceSwitch.mock.invocationCallOrder[0]!
  expect(preparedAt).toBeLessThan(
    state.deps.workspace.getValidatedActivationSnapshot.mock.invocationCallOrder[0]!,
  )
  expect(preparedAt).toBeLessThan(state.documents.readForMain.mock.invocationCallOrder[0]!)
})

it('guards an existing destination before Save As overwrites it', async () => {
  const state = harness({ targetExists: true })
  await state.ownDraft()
  await state.begin()

  await expect(state.operations.commitSaveDocumentAs({ intentId })).resolves.toMatchObject({ ok: true })

  expect(state.transferGuard).toHaveBeenCalledWith('2.b')
  expect(state.transferHandoff).toHaveBeenCalledWith('3.c')
  expect(state.events.indexOf('registry.guard')).toBeLessThan(state.events.indexOf('document.save'))
  expect(state.events.indexOf('registry.handoff')).toBeGreaterThan(state.events.indexOf('document.save'))
})

it('guards an existing destination even when the source has no open editor registration', async () => {
  const state = harness({ targetExists: true, sourceOpen: false })
  await state.ownDraft()
  await state.begin()

  await expect(state.operations.commitSaveDocumentAs({ intentId })).resolves.toMatchObject({ ok: true })

  expect(state.registryGuard).toHaveBeenCalledWith(expect.objectContaining({ fileIdentity: '2.b' }))
  expect(state.events.indexOf('registry.destination-guard')).toBeLessThan(
    state.events.indexOf('document.save'),
  )
  expect(state.destinationGuardHandoff).toHaveBeenCalledWith(expect.objectContaining({ fileIdentity: '3.c' }))
  expect(state.destinationGuardRelease).toHaveBeenCalledOnce()
})

it.each([
  ['open source', true],
  ['closed source', false],
] as const)('guards the newly-created target identity before publishing it for %s', async (_name, sourceOpen) => {
  const state = harness({ sourceOpen })
  await state.ownDraft()
  await state.begin()

  await expect(state.operations.commitSaveDocumentAs({ intentId })).resolves.toMatchObject({ ok: true })

  expect(state.documents.createForMain).toHaveBeenCalledOnce()
  if (sourceOpen) {
    expect(state.transferGuard).toHaveBeenCalledWith('2.b')
  } else {
    expect(state.registryGuard).toHaveBeenCalledWith(expect.objectContaining({ fileIdentity: '2.b' }))
    expect(state.destinationGuardRelease).toHaveBeenCalledOnce()
  }
})

it('removes a newly-created target when publishing its destination guard fails', async () => {
  const state = harness({ sourceOpen: false, failDestinationGuard: true })
  await state.ownDraft()
  await state.begin()

  await expect(state.operations.commitSaveDocumentAs({ intentId })).resolves.toMatchObject({
    ok: false, error: { code: 'OPERATION_FAILED' },
  })

  expect(state.documents.createForMain).toHaveBeenCalledOnce()
  expect(state.created()).toBe(false)
})

it('drains AI writes for same-workspace Save As without changing workspace identity', async () => {
  const state = harness({ sameWorkspace: true })
  await state.ownDraft()
  await expect(state.begin()).resolves.toMatchObject({
    ok: true,
    value: {
      targetWorkspace: { name: 'old', absolutePath: oldRoot },
      changesWorkspace: false,
    },
  })

  await expect(state.operations.commitSaveDocumentAs({ intentId })).resolves.toMatchObject({
    ok: true,
    value: {
      workspace: { absolutePath: oldRoot },
      changesWorkspace: false,
      aiWorkspace: { workspaceId: 'workspace-old', workspaceGeneration: 'generation-old' },
    },
  })
  expect(state.desktopAi.prepareWorkspaceSwitch).toHaveBeenCalledOnce()
  expect(state.desktopAi.activateWorkspace).not.toHaveBeenCalled()
  expect(state.desktopAi.abortWorkspaceSwitch).toHaveBeenCalledOnce()
  expect(state.workspaceCommit).not.toHaveBeenCalled()
})

it('rejects stale, expired, and cross-window intents before any commit side effect', async () => {
  const stale = harness()
  await stale.ownDraft()
  await stale.begin()
  await stale.operations.saveDraft({
    draftId, markdown: '# newer', expectedOriginalRevision: revisionA,
    encoding: 'utf8', newline: 'lf',
  })
  await expect(stale.operations.commitSaveDocumentAs({ intentId })).resolves.toMatchObject({
    ok: false, error: { code: 'INVALID_INPUT' },
  })
  expect(stale.events).toEqual([])

  const expired = harness({ now: 1_000 })
  await expired.ownDraft()
  await expired.begin()
  expired.deps.now.mockReturnValue(1_000 + 5 * 60_000)
  await expect(expired.operations.commitSaveDocumentAs({ intentId })).resolves.toMatchObject({
    ok: false, error: { code: 'INVALID_INPUT' },
  })

  const owner = harness()
  const otherWindow = harness()
  await owner.ownDraft()
  await owner.begin()
  await expect(otherWindow.operations.commitSaveDocumentAs({ intentId })).resolves.toMatchObject({
    ok: false, error: { code: 'INVALID_INPUT' },
  })
  expect(otherWindow.events).toEqual([])
})

it('rolls back registry, staged draft, created target, workspace, settings, and AI gate on activation failure', async () => {
  const state = harness({ failActivation: true })
  await state.ownDraft()
  await state.begin()

  await expect(state.operations.commitSaveDocumentAs({ intentId })).resolves.toMatchObject({
    ok: false, error: { code: 'OPERATION_FAILED' },
  })
  expect(state.transferRollback).toHaveBeenCalledOnce()
  expect(state.finalizeRollback).toHaveBeenCalledOnce()
  expect(state.documents.removeCreatedForRollback).toHaveBeenCalledWith(
    'saved.md', '2.b', revisionB,
  )
  expect(state.root()).toBe(oldRoot)
  expect(state.created()).toBe(false)
  expect(state.desktopAi.abortWorkspaceSwitch).toHaveBeenCalledOnce()
  expect(state.deps.onDocumentSourceChanged).toHaveBeenCalledTimes(1)
})

it('reports typed rollback-incomplete and retains a created target when cleanup is uncertain', async () => {
  const state = harness({ failActivation: true, failCreatedRollback: true })
  await state.ownDraft()
  await state.begin()

  await expect(state.operations.commitSaveDocumentAs({ intentId })).resolves.toEqual({
    ok: false,
    error: {
      code: 'DOCUMENT_ROLLBACK_INCOMPLETE',
      message: PUBLIC_ERROR_MESSAGES.DOCUMENT_ROLLBACK_INCOMPLETE,
    },
  })
  expect(state.created()).toBe(true)
  expect(state.events).not.toContain('assets.rollback')
  expect(state.documents.removeCreatedForRollback).toHaveBeenCalledWith(
    'saved.md', '2.b', revisionB,
  )
  expect(state.deps.reportError).toHaveBeenCalledWith(expect.objectContaining({
    name: 'DocumentRollbackIncompleteError',
    code: 'DOCUMENT_ROLLBACK_INCOMPLETE',
    errors: expect.arrayContaining([
      expect.objectContaining({ message: 'activation failed' }),
      expect.objectContaining({ name: 'DocumentRollbackIncompleteError' }),
    ]),
  }))
})

it('adopts committed Save As with pending finalization and retries only that step with consistent AI state', async () => {
  const state = harness({ statefulAi: true })
  await state.ownDraft()
  await state.begin()
  state.finalizeCommit.mockRejectedValueOnce(new Error('terminal commit denied'))
  expect(await state.operations.commitSaveDocumentAs({ intentId })).toMatchObject({
    ok: true, value: { draftEndPending: true, document: { relativePath: 'saved.md', revision: revisionB },
      aiWorkspace: { workspaceId: 'workspace-new', workspaceGeneration: 'generation-new' } },
  })
  expect(state.finalizeRollback).not.toHaveBeenCalled()
  expect(state.transferRollback).not.toHaveBeenCalled()
  expect(state.created()).toBe(true)
  expect(state.root()).toBe(targetRoot)
  expect(state.activeAiRoot()).toBe(targetRoot)
  expect(state.aiSwitchPending()).toBe(false)
  expect(state.operations.getCurrentDocumentAbsolutePath()).toBe(path.join(targetRoot, 'saved.md'))
  expect(await state.operations.retryDraftFinalization({ draftId })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(await harness().operations.retryDraftFinalization()).toEqual({ ok: true, value: null })
  expect(state.finalizeCommit).toHaveBeenCalledOnce()
  expect(await state.operations.readDocument({ relativePath: 'note.md' })).toMatchObject({ ok: false })
  expect(await state.operations.saveDocument({ relativePath: 'saved.md', markdown: '# saved', expectedRevision: revisionB,
    encoding: 'utf8', newline: 'lf' })).toMatchObject({ ok: false })

  // New edits can be backed up against the committed destination while the
  // previous draft's finalization remains pending.
  const nextDraftId = '223e4567-e89b-42d3-a456-426614174000'
  expect(await state.operations.saveDraft({ draftId: nextDraftId, markdown: '# later', expectedOriginalRevision: revisionB,
    encoding: 'utf8', newline: 'lf' })).toMatchObject({ ok: true })
  expect(state.drafts.write).toHaveBeenLastCalledWith(expect.objectContaining({
    draftId: nextDraftId, originalAbsolutePath: path.join(targetRoot, 'saved.md'), originalRevision: revisionB,
  }))
  state.finalizeCommit.mockRejectedValueOnce(new Error('retry denied'))
  expect(await state.operations.retryDraftFinalization()).toMatchObject({ ok: false })
  expect(await state.begin()).toMatchObject({ ok: false })
  expect(state.documents.createForMain).toHaveBeenCalledOnce()
  expect(state.documents.saveForMain).not.toHaveBeenCalled()
  expect(state.desktopAi.activateWorkspace).toHaveBeenCalledOnce()

  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { started = resolve })
  state.finalizeCommit.mockImplementationOnce(async () => { started(); await gate })
  const firstRetry = state.operations.retryDraftFinalization()
  const joinedRetry = state.operations.retryDraftFinalization()
  await entered
  expect(state.finalizeCommit).toHaveBeenCalledTimes(3)
  release()
  expect(await firstRetry).toEqual({ ok: true, value: null })
  expect(await joinedRetry).toEqual({ ok: true, value: null })
  expect(state.finalizeCommit).toHaveBeenCalledTimes(3)
  expect(state.documents.createForMain).toHaveBeenCalledOnce()
  expect(state.documents.saveForMain).not.toHaveBeenCalled()

  // This same-workspace operation would fail abort's source check if the
  // previous committed activation had been followed by filesystem rollback.
  const next = await state.operations.beginSaveDocumentAs({ draftId: nextDraftId, markdown: '# later', encoding: 'utf8', newline: 'lf' })
  expect(next).toMatchObject({ ok: true, value: { changesWorkspace: false } })
  if (!next.ok || !next.value) throw new Error('Expected next Save As intent')
  expect(next.value.intentId).not.toBe(intentId)
  expect(await state.operations.commitSaveDocumentAs({ intentId: next.value.intentId })).toMatchObject({ ok: true })
  expect(await state.operations.commitSaveDocumentAs({ intentId: next.value.intentId })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(state.activeAiRoot()).toBe(state.root())
  expect(state.aiSwitchPending()).toBe(false)
  expect(state.documents.saveForMain).toHaveBeenCalledOnce()
})

it('publishes the restored in-place identity from the rollback write boundary', async () => {
  const state = harness({
    sameWorkspace: true,
    inPlaceTarget: true,
    failSwitchCompletion: true,
  })
  await state.ownDraft()
  await state.begin()

  await expect(state.operations.commitSaveDocumentAs({ intentId })).resolves.toMatchObject({
    ok: false, error: { code: 'DOCUMENT_ROLLBACK_INCOMPLETE' },
  })

  expect(state.documents.saveForMain).toHaveBeenCalledTimes(2)
  expect(state.rollbackPublisherObserved()).toBe(true)
  expect(state.transferRollback).toHaveBeenCalledWith('4.d', undefined)
})

it.each([
  ['document write', { failWrite: true }, false],
  ['draft finalize staging', { failFinalize: true }, true],
] as const)('rolls back workspace and AI state when %s fails', async (_name, options, wroteTarget) => {
  const state = harness(options)
  await state.ownDraft()
  await state.begin()

  await expect(state.operations.commitSaveDocumentAs({ intentId })).resolves.toMatchObject({
    ok: false, error: { code: 'OPERATION_FAILED' },
  })
  expect(state.root()).toBe(oldRoot)
  expect(state.created()).toBe(false)
  expect(state.desktopAi.abortWorkspaceSwitch).toHaveBeenCalledOnce()
  expect(state.documents.removeCreatedForRollback).toHaveBeenCalledTimes(wroteTarget ? 1 : 0)
  expect(state.transferRollback).toHaveBeenCalledOnce()
})
