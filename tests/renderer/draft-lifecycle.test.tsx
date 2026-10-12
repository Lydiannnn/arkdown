// Cross-layer regressions for the fifteen LEGACY-018 diagnostic scenarios.
// Uses the real renderer hook, IPC ownership checks and draft files in a disposable directory.
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDocumentSession } from '../../src/renderer/editor/use-document-session'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import { DraftService } from '../../src/main/drafts/draft-service'
import { RecoveryCoordinator } from '../../src/main/drafts/recovery-coordinator'
import { AssetService } from '../../src/main/assets/asset-service'
import { AssetAccessRegistry } from '../../src/main/assets/asset-path'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'
import { DocumentService } from '../../src/main/documents/document-service'
import { draftPaths } from '../../src/main/drafts/draft-paths'
import type { ArkdownApi, DocumentSnapshot } from '../../src/shared/contracts'

const oldId = '123e4567-e89b-42d3-a456-426614174000'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const imagePath = (markdown: string) => /<([^>]+)>/u.exec(markdown)![1]!
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
let root: string
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-draft-audit-')); vi.useFakeTimers() })
afterEach(async () => {
  cleanup(); vi.useRealTimers(); vi.restoreAllMocks()
  if (!path.basename(root).startsWith('arkdown-draft-audit-') || path.dirname(root) !== os.tmpdir()) throw new Error('Unexpected temp root')
  await rm(root, { recursive: true, force: true })
})

function harness(decision: 'discard' | 'confirm' | 'cancel' = 'discard', withImages = false) {
  const drafts = new DraftService({ root, appVersion: '1.0.3' })
  let disk: DocumentSnapshot = { relativePath: 'note.md', markdown: 'original', revision: hash('original'), mtimeMs: 1, encoding: 'utf8', newline: 'lf' }
  const workspace = {
    getRoot: () => root,
    resolveExistingDocument: async (relativePath: string) => path.join(root, relativePath),
  }
  const assets = withImages ? new AssetService({ workspace: workspace as never, tempRoot: root, sessionId: 'lifecycle',
    access: new AssetAccessRegistry(),
    readClipboardImage: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => png }),
  }) : undefined
  const operations = createIpcOperations({
    workspace, drafts, assets,
    documents: {
      read: async (relativePath: string) => ({ ...disk, relativePath }),
      save: async (input: { markdown: string }) => {
        await writeFile(path.join(root, 'note.md'), input.markdown, 'utf8')
        disk = { ...disk, markdown: input.markdown, revision: hash(input.markdown), mtimeMs: disk.mtimeMs + 1 }
        return { revision: disk.revision, mtimeMs: disk.mtimeMs }
      },
    },
    getLastWorkspace: () => root,
    setLastWorkspace: async () => undefined,
  } as never)
  const api = {
    readDocument: (relativePath: string) => operations.readDocument({ relativePath }),
    saveDocument: (input: unknown) => operations.saveDocument(input),
    saveDraft: vi.fn((input: unknown) => operations.saveDraft(input)),
    discardDraft: vi.fn((draftId: string) => operations.discardDraft({ draftId })),
    cleanDraft: vi.fn((draftId: string) => operations.cleanDraft({ draftId })),
    pasteClipboardImage: (input: unknown) => withImages ? operations.pasteClipboardImage(input) : Promise.resolve({ ok: true, value: null }),
  }
  window.arkdown = api as unknown as ArkdownApi
  const confirm = vi.fn(async () => decision)
  const hook = renderHook(() => useDocumentSession(undefined, undefined, undefined, { confirm }))
  return { drafts, api, operations, confirm, hook, disk: () => disk }
}
async function open(h: ReturnType<typeof harness>) {
  await act(async () => { expect((await h.hook.result.current.open('note.md')).status).toBe('opened') })
}
async function backup(h: ReturnType<typeof harness>, text = 'edited') {
  act(() => h.hook.result.current.change(text))
  await act(async () => { expect(await h.hook.result.current.backupDraft()).toBe(true) })
}
async function close(h: ReturnType<typeof harness>) {
  let result = false
  await act(async () => { result = await h.hook.result.current.transitionAfterSave(async () => {}) })
  return result
}
async function recover(h: ReturnType<typeof harness>, text = 'recovered') {
  const disk = h.disk()
  await h.drafts.write({ draftId: oldId, markdown: text, originalAbsolutePath: path.join(root, 'note.md'), workspaceAbsolutePath: root,
    originalRevision: disk.revision, originalMtimeMs: disk.mtimeMs, encoding: 'utf8', newline: 'lf' })
  await h.operations.authorizeDraftRecovery(oldId)
  await h.operations.readDocument({ relativePath: 'note.md' })
  expect(await h.operations.claimRecoveredDraft({ draftId: oldId })).toMatchObject({ ok: true })
  act(() => h.hook.result.current.recover(oldId, text, disk, false))
}

it('ordinary edit -> do not save clears the recoverable draft', async () => {
  const h = harness(); await open(h); await backup(h)
  expect(await close(h)).toBe(true)
  expect(await h.drafts.listRecoverable()).toHaveLength(0)
  expect(h.disk().markdown).toBe('original')
})
it('ordinary edit -> save clears draft and updates original', async () => {
  const h = harness('confirm'); await open(h); await backup(h)
  expect(await close(h)).toBe(true)
  expect(await h.drafts.listRecoverable()).toHaveLength(0)
  expect(h.disk().markdown).toBe('edited')
})
it('edit -> backup -> undo to original -> normal close ends the stale edited draft', async () => {
  const h = harness(); await open(h); await backup(h)
  act(() => h.hook.result.current.change('original'))
  expect(h.hook.result.current.dirty).toBe(false)
  expect(await close(h)).toBe(true)
  const list = await h.drafts.listRecoverable()
  expect(list).toHaveLength(0)
  expect(h.confirm).not.toHaveBeenCalled()
})
it('undo to original -> switch document ends the old draft without prompting', async () => {
  const h = harness(); await open(h); await backup(h)
  act(() => h.hook.result.current.change('original'))
  await act(async () => { expect((await h.hook.result.current.open('other.md')).status).toBe('opened') })
  expect(await h.drafts.listRecoverable()).toHaveLength(0)
})
it('undo to original ends the backup while the editor remains open', async () => {
  const h = harness(); await open(h); await backup(h)
  const draftId = h.hook.result.current.draftId
  await act(async () => { h.hook.result.current.change('original') })
  await h.api.cleanDraft.mock.results[0]?.value
  expect(await new DraftService({ root, appVersion: '1.0.4' }).read(draftId)).toBeNull()
  await backup(h, 'edited again')
  expect((await h.drafts.read(h.hook.result.current.draftId))?.markdown).toBe('edited again')
})

it('waits for a late backup before clean close and never recreates the ended record', async () => {
  const h = harness(); await open(h)
  let unblock!: () => void
  let started!: () => void
  const entered = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { unblock = resolve })
  const write = h.drafts.write.bind(h.drafts)
  vi.spyOn(h.drafts, 'write').mockImplementationOnce(async (input) => {
    started(); await gate; return await write(input)
  })
  act(() => h.hook.result.current.change('late draft'))
  let backupPromise!: Promise<boolean>
  act(() => { backupPromise = h.hook.result.current.backupDraft() })
  await entered
  act(() => h.hook.result.current.change('original'))
  const transitioned = vi.fn()
  let closing!: Promise<boolean>
  act(() => { closing = h.hook.result.current.transitionAfterSave(transitioned) })
  expect(transitioned).not.toHaveBeenCalled()
  await act(async () => { unblock(); await backupPromise; expect(await closing).toBe(true) })
  expect(await new DraftService({ root, appVersion: '1.0.4' }).listRecoverable()).toEqual([])
})
it('attempted image paste with no image leaves no recoverable draft on close', async () => {
  const h = harness(); await open(h)
  await act(async () => { expect(await h.hook.result.current.readClipboardImage()).toBe(null) })
  expect(h.hook.result.current.dirty).toBe(false)
  expect(await close(h)).toBe(true)
  const list = await h.drafts.listRecoverable()
  expect(list).toHaveLength(0)
})

it.each([
  ['save-as', 'success'], ['save-as', 'failure'], ['save', 'success'], ['save', 'failure'],
] as const)('lets %s after a clean-document image paste wait for idle clean %s', async (command, ending) => {
  const h = harness('discard', true); await open(h)
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { started = resolve })
  const markClean = h.drafts.markClean.bind(h.drafts)
  vi.spyOn(h.drafts, 'markClean').mockImplementationOnce(async (id) => {
    started(); await gate
    if (ending === 'failure') throw new Error('cleanup denied')
    await markClean(id)
  })
  const saveDocument = vi.spyOn(h.api, 'saveDocument')
  const beginSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown.beginSaveDocumentAs = beginSaveDocumentAs
  window.arkdown.abortSaveDocumentAs = async () => ({ ok: true, value: null })
  window.arkdown.commitSaveDocumentAs = async () => { throw new Error('Cancelled picker must not commit') }
  let image!: string
  await act(async () => { image = (await h.hook.result.current.readClipboardImage())! })
  await entered
  act(() => h.hook.result.current.change(image))
  const draftId = h.hook.result.current.draftId
  let saving!: Promise<unknown>
  act(() => { saving = command === 'save-as' ? h.hook.result.current.saveAs() : h.hook.result.current.save() })
  expect(beginSaveDocumentAs).not.toHaveBeenCalled()
  expect(saveDocument).not.toHaveBeenCalled()
  await act(async () => { release(); await saving })
  expect(await readFile(imagePath(image))).toEqual(png)
  if (ending === 'failure') {
    expect(beginSaveDocumentAs).not.toHaveBeenCalled()
    expect(saveDocument).not.toHaveBeenCalled()
    expect(h.hook.result.current.state.markdown).toBe(image)
    expect(h.hook.result.current.state.error).toBe('草稿结束失败：操作未能完成。请重试。')
    expect(h.hook.result.current.draftId).toBe(draftId)
  } else if (command === 'save-as') {
    expect(beginSaveDocumentAs).toHaveBeenCalledOnce()
    expect(h.hook.result.current.state.markdown).toBe(image)
    expect((await h.drafts.read(draftId))?.markdown).toBe(image) // The same live clean/redo lease, not a retired ID.
  } else {
    expect(saveDocument).toHaveBeenCalledOnce()
    expect(h.hook.result.current.dirty).toBe(false)
    expect(await readFile(path.join(root, imagePath(h.disk().markdown)))).toEqual(png)
  }
})
it('recovered draft -> immediate do not save has real IPC ownership and ends the draft', async () => {
  const h = harness(); await recover(h)
  expect(await close(h)).toBe(true)
  expect(h.api.saveDraft).not.toHaveBeenCalled()
  expect(await h.api.discardDraft.mock.results[0].value).toMatchObject({ ok: true })
  expect(await h.drafts.listRecoverable()).toHaveLength(0)
  expect(h.hook.result.current.dirty).toBe(false)
})
it('recovered draft -> immediate save updates disk and ends the recovered draft', async () => {
  const h = harness('confirm'); await recover(h)
  expect(await close(h)).toBe(true)
  expect(h.disk().markdown).toBe('recovered')
  const list = await h.drafts.listRecoverable()
  expect(list).toHaveLength(0)
})
it('editing a recovered draft first reestablishes IPC ownership and discard works', async () => {
  const h = harness(); await recover(h); await backup(h, 'recovered with new edit')
  expect(await close(h)).toBe(true)
  expect(await h.drafts.listRecoverable()).toHaveLength(0)
})
it('terminal commit failure prevents discard and preserves the editor', async () => {
  const h = harness(); await open(h); await backup(h)
  vi.spyOn(h.drafts, 'discard').mockRejectedValue(Object.assign(new Error('fixture cleanup denied'), { code: 'EACCES' }))
  expect(await close(h)).toBe(false)
  expect(await h.drafts.listRecoverable()).toHaveLength(1)
  expect(h.hook.result.current.dirty).toBe(true)
  expect(h.hook.result.current.state.error).not.toBe(null)
})
it.each(['committed', 'rejected', 'thrown'] as const)('reconciles a %s discard after an open intent supersedes it without replacing the document', async (outcome) => {
  const h = harness(); await open(h); await backup(h)
  const endedId = h.hook.result.current.draftId
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { started = resolve })
  h.api.discardDraft.mockImplementationOnce(async (draftId) => {
    started(); await gate
    if (outcome === 'thrown') throw new Error('terminal IPC unavailable')
    return outcome === 'committed'
      ? h.operations.discardDraft({ draftId })
      : { ok: false as const, error: { code: 'OPERATION_FAILED', message: 'terminal denied' } }
  })
  let opening!: ReturnType<typeof h.hook.result.current.open>
  act(() => { opening = h.hook.result.current.open('other.md') })
  await entered
  await act(async () => { expect(await h.hook.result.current.open('note.md')).toEqual({ status: 'opened' }) })
  await act(async () => { release(); expect(await opening).toEqual({ status: 'cancelled' }) })
  expect(h.hook.result.current.state.markdown).toBe('edited')
  expect(h.hook.result.current.state.relativePath).toBe('note.md')
  if (outcome === 'committed') expect(h.hook.result.current.draftId).not.toBe(endedId)
  else expect(h.hook.result.current.draftId).toBe(endedId)
  // No edit is needed to make the same unsaved body eligible for a fresh backup.
  await act(async () => { expect(await h.hook.result.current.backupDraft()).toBe(true) })
  expect((await h.drafts.read(h.hook.result.current.draftId))?.markdown).toBe('edited')
  await act(async () => { expect(await h.hook.result.current.save()).toBe(true) })
  expect(h.disk().markdown).toBe('edited')
  expect(await close(h)).toBe(true)
})

it('does not reconcile an obsolete discard into an actual replacement document', async () => {
  const h = harness(); await open(h); await backup(h)
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { started = resolve })
  h.api.discardDraft.mockImplementationOnce(async (draftId) => {
    started(); await gate; return h.operations.discardDraft({ draftId })
  })
  let opening!: ReturnType<typeof h.hook.result.current.open>
  act(() => { opening = h.hook.result.current.open('other.md') })
  await entered
  act(() => h.hook.result.current.adopt({ ...h.disk(), relativePath: 'replacement.md', markdown: 'replacement' }))
  const replacementId = h.hook.result.current.draftId
  await act(async () => { release(); await opening })
  expect(h.hook.result.current.draftId).toBe(replacementId)
  expect(h.hook.result.current.state).toMatchObject({ relativePath: 'replacement.md', markdown: 'replacement' })
})

it('preserves clipboard bytes after superseded discard and binds a self-contained successor backup', async () => {
  const h = harness('discard', true); await open(h)
  await backup(h, 'before image')
  let image!: string
  await act(async () => { image = (await h.hook.result.current.readClipboardImage())! })
  await backup(h, `${image}\ntext to retain`)
  const retiredId = h.hook.result.current.draftId
  const originalImage = imagePath(image)
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { started = resolve })
  h.api.discardDraft.mockImplementationOnce(async (draftId) => {
    started(); await gate; return h.operations.discardDraft({ draftId })
  })
  let opening!: ReturnType<typeof h.hook.result.current.open>
  act(() => { opening = h.hook.result.current.open('other.md') })
  await entered
  await act(async () => { await h.hook.result.current.open('note.md'); release(); await opening })
  expect(await readFile(originalImage)).toEqual(png)
  expect(await h.drafts.read(retiredId)).toBeNull()
  expect(await h.drafts.listRecoverable()).toEqual([])
  expect(await readFile(originalImage)).toEqual(png)
  await expect(h.drafts.write({ draftId: retiredId, markdown: image, originalAbsolutePath: path.join(root, 'note.md'),
    workspaceAbsolutePath: root, originalRevision: h.disk().revision, originalMtimeMs: 1, encoding: 'utf8', newline: 'lf' })).rejects.toThrow('ended')
  await act(async () => { expect(await h.hook.result.current.backupDraft()).toBe(true) })
  const successorId = h.hook.result.current.draftId
  const successor = await new DraftService({ root, appVersion: '1.0.4' }).read(successorId)
  expect(successor?.markdown).toContain('text to retain')
  expect(imagePath(successor!.markdown)).not.toBe(originalImage)
  expect(await readFile(imagePath(successor!.markdown))).toEqual(png)
  await backup(h, `${image}\ntext to retain again`)
  expect(await readdir(draftPaths(root, successorId).assetDirectory)).toHaveLength(1)
  await act(async () => { expect(await h.hook.result.current.save()).toBe(true) })
  const persistedImage = path.join(root, imagePath(h.disk().markdown))
  expect(await readFile(persistedImage)).toEqual(png)
  expect(await readFile(originalImage)).toEqual(png) // Still needed by live undo/history.
  await act(async () => { expect(await h.hook.result.current.open('other.md')).toEqual({ status: 'opened' }) })
  await h.operations.releaseClipboardResources()
  await expect(readFile(originalImage)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(persistedImage)).toEqual(png)
})

it('reconciles a late Save As edit with real image history, destination backup, remount and terminal retry', async () => {
  const sourceRoot = path.join(root, 'source')
  const destinationRoot = path.join(root, 'destination')
  const tempRoot = path.join(root, 'temp')
  await mkdir(sourceRoot); await mkdir(destinationRoot)
  const workspace = new WorkspaceService()
  await workspace.setRoot(sourceRoot)
  const documents = new DocumentService(workspace)
  await documents.create('note.md', 'original')
  let failTerminal = false
  const drafts = new DraftService({ root: tempRoot, appVersion: '1.0.4', atomicWrite: async (target, contents) => {
    if (failTerminal && contents.includes('"ended"')) throw new Error('terminal denied')
    await writeFile(target, contents, 'utf8')
  } })
  const assets = new AssetService({ workspace, tempRoot, sessionId: 'late-save-as', access: new AssetAccessRegistry(),
    readClipboardImage: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => png }),
  })
  let aiRoot = sourceRoot
  let preparedSource: string | null = null
  const operations = createIpcOperations({ workspace, documents, drafts, assets,
    chooseDirectory: async () => null, chooseSavePath: async () => path.join(destinationRoot, 'saved.md'),
    getLastWorkspace: () => sourceRoot, setLastWorkspace: async () => undefined, reportError: vi.fn(),
    desktopAi: { ownerId: 17,
      getWorkspaceAuthority: async () => ({ workspaceId: workspace.getRoot(), workspaceGeneration: 'generation' }),
      prepareWorkspaceSwitch: async () => { preparedSource = aiRoot; return { generation: 1, nonce: 'ticket' } },
      activateWorkspace: async () => { aiRoot = workspace.getRoot(); preparedSource = null },
      abortWorkspaceSwitch: async () => { if (preparedSource !== workspace.getRoot()) throw new Error('source mismatch'); preparedSource = null },
    },
    aiRendererPorts: { beginOpenDocumentTransfer: async () => ({ guardDestination: async () => {}, handoffDestination: async () => {}, commit: async () => {}, rollback: async () => {} }) },
    openDocumentRegistry: { guardDestination: async () => ({ handoff: async () => {}, release: async () => {} }) },
  } as never)
  let release!: () => void
  let published!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { published = resolve })
  let releaseSuccessor!: () => void
  let successorStarted!: () => void
  const successorGate = new Promise<void>((resolve) => { releaseSuccessor = resolve })
  const successorEntered = new Promise<void>((resolve) => { successorStarted = resolve })
  const api = {
    readDocument: (relativePath: string) => operations.readDocument({ relativePath }),
    saveDraft: vi.fn(async (input: { markdown: string }) => {
      const result = await operations.saveDraft(input)
      if (input.markdown.endsWith('\nlate edit')) { successorStarted(); await successorGate }
      return result
    }),
    saveDocument: vi.fn((input: unknown) => operations.saveDocument(input)),
    discardDraft: (draftId: string) => operations.discardDraft({ draftId }),
    cleanDraft: (draftId: string) => operations.cleanDraft({ draftId }),
    pasteClipboardImage: (input: unknown) => operations.pasteClipboardImage(input),
    beginSaveDocumentAs: (input: unknown) => operations.beginSaveDocumentAs(input),
    abortSaveDocumentAs: (intentId: string) => operations.abortSaveDocumentAs({ intentId }),
    commitSaveDocumentAs: vi.fn(async (intentId: string) => {
      const result = await operations.commitSaveDocumentAs({ intentId }); published(); await gate; return result
    }),
    retryDraftFinalization: () => operations.retryDraftFinalization(),
  }
  window.arkdown = api as unknown as ArkdownApi
  const onSavedAs = vi.fn()
  const dialogs = { confirm: vi.fn(async () => 'confirm' as const) }
  let bufferedEdit: string | null = null
  const flush = () => {
    if (bufferedEdit !== null) {
      hook.result.current.change(bufferedEdit)
      bufferedEdit = null
    }
  }
  let hook = renderHook(() => useDocumentSession(flush, onSavedAs, undefined, dialogs))
  await act(async () => { await hook.result.current.open('note.md') })
  act(() => hook.result.current.change('before image'))
  let image!: string
  await act(async () => { image = (await hook.result.current.readClipboardImage())! })
  act(() => hook.result.current.change(`${image}\ncommitted baseline`))
  const retiredId = hook.result.current.draftId
  failTerminal = true
  let saving!: ReturnType<typeof hook.result.current.saveAs>
  act(() => { saving = hook.result.current.saveAs() })
  await entered
  expect(aiRoot).toBe(destinationRoot)
  expect(await readFile(imagePath(image))).toEqual(png) // Staging has not moved history bytes.
  bufferedEdit = `${image}\nlate edit` // Visual editor has not emitted its final change yet.
  await act(async () => { release(); await successorEntered })
  bufferedEdit = `${image}\nnewest buffered edit`
  await act(async () => { releaseSuccessor(); expect(await saving).toMatchObject({ draftEndPending: true }) })
  const committed = await documents.read('saved.md')
  expect(hook.result.current.state).toMatchObject({ relativePath: 'saved.md', revision: committed.revision,
    savedMarkdown: committed.markdown, draftMarkdown: `${image}\nlate edit`, markdown: `${image}\nnewest buffered edit` })
  const successorId = hook.result.current.draftId
  expect(successorId).not.toBe(retiredId)
  const successor = await drafts.read(successorId)
  expect(successor?.manifest.originalAbsolutePath).toBe(path.join(destinationRoot, 'saved.md'))
  expect(await readFile(imagePath(successor!.markdown))).toEqual(png)
  expect(successor?.markdown).toContain('late edit')
  // Same transition payload the real App passes through its keyed shell.
  hook.unmount()
  hook = renderHook(() => useDocumentSession(undefined, onSavedAs, undefined, dialogs))
  act(() => hook.result.current.adoptSavedAs(onSavedAs.mock.calls[0][0]))
  expect(hook.result.current.draftId).toBe(successorId)
  expect(hook.result.current.state.markdown).toBe(`${image}\nnewest buffered edit`)
  expect(hook.result.current.state.draftMarkdown).toBe(`${image}\nlate edit`)
  const close = vi.fn()
  await act(async () => { expect(await hook.result.current.transitionAfterSave(close)).toBe(false) })
  expect(close).not.toHaveBeenCalled()
  expect(api.saveDocument).not.toHaveBeenCalled()
  failTerminal = false
  expect(await operations.retryDraftFinalization()).toMatchObject({ ok: true })
  const restartedBackup = await new DraftService({ root: tempRoot, appVersion: '1.0.4' }).read(successorId)
  expect(restartedBackup?.markdown).toBe(successor?.markdown)
  expect(await readFile(imagePath(restartedBackup!.markdown))).toEqual(png)
  await act(async () => { expect(await hook.result.current.save()).toBe(true) })
  expect(api.commitSaveDocumentAs).toHaveBeenCalledOnce()
  expect(api.saveDocument).toHaveBeenCalledOnce()
  const saved = await documents.read('saved.md')
  expect(saved.markdown).toContain('newest buffered edit')
  const savedImage = path.join(destinationRoot, imagePath(saved.markdown))
  expect(await readFile(savedImage)).toEqual(png)
  expect(await drafts.read(retiredId)).toBeNull()
  await documents.create('other.md', 'other')
  await act(async () => { expect(await hook.result.current.open('other.md')).toEqual({ status: 'opened' }) })
  await operations.releaseClipboardResources()
  await expect(readFile(imagePath(image))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(savedImage)).toEqual(png)
  await act(async () => { expect(await hook.result.current.transitionAfterSave(close)).toBe(true) })
})

it('does not report successful preservation when successor image rebinding fails', async () => {
  const h = harness('discard', true); await open(h)
  await backup(h, 'before image')
  let image!: string
  await act(async () => { image = (await h.hook.result.current.readClipboardImage())! })
  await backup(h, image)
  let activeIntent = true
  const originalDiscard = h.api.discardDraft.getMockImplementation()!
  h.api.discardDraft.mockImplementationOnce(async (id) => {
    const result = await originalDiscard(id)
    activeIntent = false
    return result
  })
  await act(async () => { expect(await h.hook.result.current.discard(() => activeIntent)).toBe(false) })
  await rm(imagePath(image)) // Synthetic external loss between end and rebind.
  await act(async () => { expect(await h.hook.result.current.backupDraft()).toBe(false) })
  expect(h.hook.result.current.state.markdown).toBe(image)
  expect(h.hook.result.current.state.error).not.toBeNull()
  expect(await h.drafts.read(h.hook.result.current.draftId)).toBeNull()
  await act(async () => { expect(await h.hook.result.current.save()).toBe(false) })
  expect(h.disk().markdown).toBe('original')
})
it('cancel close leaves edits and backup available', async () => {
  const h = harness('cancel'); await open(h); await backup(h)
  expect(await close(h)).toBe(false)
  expect(h.hook.result.current.dirty).toBe(true)
  expect(await h.drafts.listRecoverable()).toHaveLength(1)
})
it('ignore hides the prompt but retains readable backup', async () => {
  const h = harness(); await recover(h)
  h.operations.releaseDraftOwnership()
  const coordinator = new RecoveryCoordinator({ drafts: h.drafts, prompt: async () => 'ignore', open: async () => {} })
  expect((await coordinator.promptAndOpen()).ignored).toBe(1)
  expect(await h.drafts.listRecoverable()).toHaveLength(0)
  expect((await h.drafts.read(oldId))?.markdown).toBe('recovered')
})
it('cancelling Save As on a clean document ends its clean temporary draft on close', async () => {
  const h = harness(); await open(h)
  window.arkdown.beginSaveDocumentAs = async () => ({ ok: true, value: null })
  window.arkdown.abortSaveDocumentAs = async () => ({ ok: true, value: null })
  window.arkdown.commitSaveDocumentAs = async () => { throw new Error('should not commit a cancelled dialog') }
  await act(async () => { expect(await h.hook.result.current.saveAs()).toBe(null) })
  expect(await close(h)).toBe(true)
  const list = await h.drafts.listRecoverable()
  expect(list).toHaveLength(0)
})
it('recovered content identical to disk is clean and does not prompt on close', async () => {
  const h = harness(); await recover(h, 'original')
  expect(h.hook.result.current.dirty).toBe(false)
  expect(await close(h)).toBe(true)
  expect(h.confirm).not.toHaveBeenCalled()
  expect(await h.drafts.listRecoverable()).toHaveLength(0)
})

it('explicitly discards a conflicting restored legacy draft on close without changing its newer original', async () => {
  const h = harness('discard')
  const paths = draftPaths(root, oldId)
  await mkdir(paths.draftDirectory, { recursive: true })
  await writeFile(paths.bodyPath, 'recovered', 'utf8')
  await writeFile(paths.manifestPath, JSON.stringify({ version: 1, draftId: oldId,
    originalAbsolutePath: path.join(root, 'note.md'), workspaceAbsolutePath: root,
    originalRevision: h.disk().revision, originalMtimeMs: 1, encoding: 'utf8', newline: 'lf',
    updatedAt: '2026-10-01T00:00:00.000Z', appVersion: '1.0.3', ignoredAt: null, bodySha256: hash('recovered'), assets: [] }), 'utf8')
  await h.operations.authorizeDraftRecovery(oldId)
  await h.operations.readDocument({ relativePath: 'note.md' })
  expect(await h.operations.claimRecoveredDraft({ draftId: oldId })).toMatchObject({ ok: true })
  const newer = { ...h.disk(), markdown: 'newer original', revision: hash('newer original') }
  await writeFile(path.join(root, 'note.md'), newer.markdown, 'utf8')
  act(() => h.hook.result.current.recover(oldId, 'recovered', newer, true))
  await act(async () => {
    expect(await h.hook.result.current.prepareForClose(vi.fn())).toEqual({ status: 'ready' })
  })
  expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('newer original')
  expect(await new DraftService({ root, appVersion: '1.0.4' }).read(oldId)).toBeNull()
})
it('successful body save followed by terminal commit failure prevents close', async () => {
  const h = harness('confirm'); await open(h); await backup(h)
  vi.spyOn(h.drafts, 'discard').mockRejectedValue(Object.assign(new Error('fixture cleanup denied'), { code: 'EACCES' }))
  expect(await close(h)).toBe(false)
  expect(h.disk().markdown).toBe('edited')
  expect(h.hook.result.current.state.error).not.toBe(null)
})
it('recover then discard does not prompt across two simulated launches', async () => {
  const h = harness(); await recover(h)
  expect(await close(h)).toBe(true)
  const prompt = vi.fn(async () => 'recover' as const)
  const coordinator = new RecoveryCoordinator({
    drafts: new DraftService({ root, appVersion: '1.0.3' }), prompt,
    open: async draft => {
      await h.operations.readDocument({ relativePath: 'note.md' })
      act(() => h.hook.result.current.recover(draft.manifest.draftId, draft.markdown, h.disk(), false))
    },
  })
  for (let i = 0; i < 2; i++) {
    expect((await coordinator.promptAndOpen()).found).toBe(0)
    expect(await close(h)).toBe(true)
  }
  expect(prompt).not.toHaveBeenCalled()
  expect(await h.drafts.listRecoverable()).toHaveLength(0)
})
