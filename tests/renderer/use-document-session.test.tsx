import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ApiResult,
  BeginSaveDocumentAsResult,
  CommitSaveDocumentAsResult,
  DocumentSnapshot,
  ArkdownApi,
  SaveDocumentResult,
} from '../../src/shared/contracts'
import type { ConvertedDocument } from '../../src/shared/document-conversion'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import { modelCommit } from '../helpers/model-observation'
import { useDocumentSession as useDocumentSessionImplementation } from '../../src/renderer/editor/use-document-session'
import {
  EMPTY_SESSION,
  persistenceKind,
} from '../../src/renderer/editor/document-session'
import type { BusinessDialogController } from '../../src/renderer/modal/BusinessDialogProvider'
import { stickyNoteApiStubs } from './sticky-note-api-stubs'
import { applicationMenuApiStubs } from './application-menu-api-stubs'

const REVISION_A = 'a'.repeat(64)
const REVISION_B = 'b'.repeat(64)
const REVISION_C = 'c'.repeat(64)
const REVISION_D = 'd'.repeat(64)

const modelApiFailure = async () => ({
  ok: false as const,
  error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
})

type BusinessConfirmController = Pick<BusinessDialogController, 'confirm'>
let defaultDialogs: BusinessConfirmController
type BusinessConfirm = BusinessDialogController['confirm']
type ApiOverrides = Partial<ArkdownApi> & {
  businessConfirm?: BusinessConfirm
}
let latestBusinessConfirm: BusinessConfirm | undefined

type SaveAsIntentGate = (intent: BeginSaveDocumentAsResult) => boolean | Promise<boolean>
type UseDocumentSessionWithSaveAsGate = (
  prepare?: Parameters<typeof useDocumentSessionImplementation>[0],
  onSavedAs?: Parameters<typeof useDocumentSessionImplementation>[1],
  onSaved?: Parameters<typeof useDocumentSessionImplementation>[2],
  dialogs?: Parameters<typeof useDocumentSessionImplementation>[3],
  confirmSaveAsIntent?: SaveAsIntentGate,
) => ReturnType<typeof useDocumentSessionImplementation>

const useDocumentSessionWithSaveAsGate = (
  useDocumentSessionImplementation as unknown as UseDocumentSessionWithSaveAsGate
)

function useDocumentSession(
  ...args: Parameters<UseDocumentSessionWithSaveAsGate>
): ReturnType<typeof useDocumentSessionImplementation> {
  return useDocumentSessionWithSaveAsGate(
    args[0], args[1], args[2], args[3] ?? defaultDialogs, args[4],
  )
}

function documentSnapshot(
  relativePath = 'note.md',
  markdown = 'one',
  revision = REVISION_A,
): DocumentSnapshot {
  return {
    relativePath,
    markdown,
    revision,
    encoding: 'utf8-bom',
    newline: 'crlf',
    mtimeMs: 1,
  }
}

function convertedDocument(
  fileName = 'quarter.final.PPTX',
  markdown = '# Converted\n\nBody',
): ConvertedDocument {
  return Object.freeze({
    source: Object.freeze({
      absolutePath: `C:\\notes\\${fileName}`,
      fileName,
      format: 'pptx' as const,
      bytes: 128,
      modifiedAtMs: 1,
    }),
    markdown,
    converterVersion: '0.1.7-py3.12.10',
    fingerprint: 'f'.repeat(64),
    warnings: Object.freeze([]),
  })
}

function saveAsIntent(
  changesWorkspace = false,
): BeginSaveDocumentAsResult {
  return {
    intentId: '123e4567-e89b-42d3-a456-426614174111',
    targetWorkspace: {
      name: changesWorkspace ? 'Other' : 'notes',
      absolutePath: changesWorkspace ? 'D:/other' : 'C:/notes',
    },
    targetFileName: 'saved.md',
    targetRelativePath: 'saved.md',
    changesWorkspace,
  }
}

function committedSaveAs(
  markdown = 'one',
  changesWorkspace = false,
): CommitSaveDocumentAsResult {
  return {
    workspace: {
      name: changesWorkspace ? 'Other' : 'notes',
      absolutePath: changesWorkspace ? 'D:/other' : 'C:/notes',
    },
    document: documentSnapshot('saved.md', markdown, REVISION_B),
    changesWorkspace,
    aiWorkspace: {
      workspaceId: changesWorkspace ? 'workspace-other' : 'workspace-notes',
      workspaceGeneration: 'generation-2',
    },
  }
}

function createApi(overrides: ApiOverrides = {}): ArkdownApi {
  const businessConfirm = overrides.businessConfirm
  latestBusinessConfirm = businessConfirm
  const {
    businessConfirm: _businessConfirm,
    ...apiOverrides
  } = overrides
  defaultDialogs = {
    confirm: businessConfirm ?? vi.fn(async (): Promise<'confirm'> => 'confirm'),
  }
  return {
    chooseWorkspace: vi.fn(async () => ({ ok: true as const, value: null })),
    restoreWorkspace: vi.fn(async () => ({ ok: true as const, value: null })),
    listDirectory: vi.fn(async () => ({ ok: true as const, value: [] })),
    readDocument: vi.fn(async (relativePath) => ({
      ok: true as const,
      value: documentSnapshot(relativePath),
    })),
    peekDocument: vi.fn(async (relativePath) => ({
      ok: true as const,
      value: documentSnapshot(relativePath),
    })),
    saveDocument: vi.fn(async () => ({
      ok: true as const,
      value: { revision: REVISION_B, mtimeMs: 2 },
    })),
    saveDraft: vi.fn(async (input) => ({
      ok: true as const,
      value: {
        draftId: input.draftId,
        originalAbsolutePath: 'C:/notes/note.md',
        workspaceAbsolutePath: 'C:/notes',
        originalRevision: input.expectedOriginalRevision,
        originalMtimeMs: 1,
        encoding: input.encoding,
        newline: input.newline,
        updatedAt: '2026-07-24T00:00:00.000Z',
        ignoredAt: null,
      },
    })),
    discardDraft: vi.fn(async () => ({ ok: true as const, value: null })),
    openDroppedPath: vi.fn(async () => ({
      ok: true as const,
      value: { workspace: { name: 'notes', absolutePath: 'C:/notes' }, document: null },
    })),
    pathForDroppedFile: vi.fn(() => ''),
    createDocument: vi.fn(async (relativePath) => ({
      ok: true as const, value: documentSnapshot(relativePath, ''),
    })),
    revealDocument: vi.fn(async () => ({ ok: true as const, value: null })),
    trashDocument: vi.fn(async () => ({ ok: true as const, value: null })),
    getLargeModelSettings: vi.fn(modelApiFailure),
    getModelSettingsSnapshot: vi.fn(modelApiFailure),
    connectModel: vi.fn(modelApiFailure),
    listModels: vi.fn(modelApiFailure),
    testModel: vi.fn(modelApiFailure),
    deleteModel: vi.fn(modelApiFailure),
    setAiConversationSettings: vi.fn(modelApiFailure),
    testCodexCliConnection: vi.fn(async () => ({ ok: true as const, value: { status: 'not-found' as const, mutation: modelCommit(DEFAULT_LARGE_MODEL_SETTINGS) } })),
    removeCodexCliConnection: vi.fn(async () => ({ ok: true as const, value: modelCommit(DEFAULT_LARGE_MODEL_SETTINGS) })),
    setSelectionTranslationSettings: vi.fn(modelApiFailure),
    setScreenshotTranslationSettings: vi.fn(modelApiFailure),
    setFloatingTranslationSettings: vi.fn(modelApiFailure),
    acceptTranslationPrivacyNotice: vi.fn(modelApiFailure),
    startAiConversation: vi.fn(modelApiFailure),
    cancelAiConversation: vi.fn((_input: Parameters<ArkdownApi['cancelAiConversation']>[0]) => modelApiFailure()),
    getAiWorkspaceState: vi.fn(modelApiFailure),
    setAiConversationCapabilities: vi.fn(modelApiFailure),
    submitAiAuthorizationResult: vi.fn(modelApiFailure),
    clearAiConversation: vi.fn(modelApiFailure),
    notifyAiCurrentDocumentChanged: vi.fn(modelApiFailure),
    registerAiCurrentDocumentPort: vi.fn(modelApiFailure),
    unregisterAiCurrentDocumentPort: vi.fn(modelApiFailure),
    registerAiOpenDocumentPort: vi.fn(modelApiFailure),
    unregisterAiOpenDocumentPort: vi.fn(modelApiFailure),
    openAiMessageLink: vi.fn(modelApiFailure),
    onAiConversationEvent: vi.fn(() => () => undefined),
    startTranslation: vi.fn(modelApiFailure),
    cancelTranslation: vi.fn(modelApiFailure),
    onTranslationEvent: vi.fn(() => () => undefined),
    ...stickyNoteApiStubs,
    ...applicationMenuApiStubs,
    onPrepareClose: vi.fn(() => () => {}),
    ...apiOverrides,
    onWindowStateChanged: apiOverrides.onWindowStateChanged
      ?? applicationMenuApiStubs.onWindowStateChanged,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function businessDialog(
  result: Awaited<ReturnType<BusinessDialogController['confirm']>> = 'confirm',
): BusinessConfirmController {
  return { confirm: vi.fn(async () => result) }
}

async function openAndChange(
  result: ReturnType<typeof renderHook<ReturnType<typeof useDocumentSession>, unknown>>['result'],
  markdown = 'two',
) {
  await act(async () => {
    await result.current.open('note.md')
  })
  act(() => result.current.change(markdown))
}

beforeEach(() => {
  vi.useFakeTimers()
  window.arkdown = createApi()
})

describe('document-kind-first persistence', () => {
  it.each([false, true])('update installation never offers or accepts discard (conflict=%s)', async conflict => {
    const confirm = vi.fn<BusinessConfirm>(async () => 'discard' as const)
    window.arkdown = createApi({ businessConfirm: confirm })
    const { result } = renderHook(() => useDocumentSession())
    if (conflict) act(() => result.current.recover('123e4567-e89b-42d3-a456-426614174000', 'keep draft', documentSnapshot(), true))
    else await openAndChange(result, 'keep edit')
    const text = result.current.state.markdown
    await act(async () => { expect(await result.current.prepareForClose(vi.fn(), { requireSaved: true })).toEqual({ status: 'cancelled' }) })
    expect(confirm.mock.calls[0][0]).not.toHaveProperty('discardLabel')
    expect(window.arkdown.discardDraft).not.toHaveBeenCalled()
    expect(result.current.state.markdown).toBe(text)
  })
  it.each(['edit', 'adopt', 'clear'] as const)('ignores a late conflict discard after %s changes the document', async (change) => {
    const decision = deferred<'discard'>()
    window.arkdown = createApi({ businessConfirm: vi.fn(() => decision.promise) })
    const { result } = renderHook(() => useDocumentSession())
    act(() => result.current.recover('123e4567-e89b-42d3-a456-426614174000', 'recovered', documentSnapshot(), true))
    let closing!: Promise<unknown>
    act(() => { closing = result.current.prepareForClose(vi.fn()) })
    act(() => {
      if (change === 'edit') result.current.change('new edit')
      else if (change === 'adopt') result.current.adopt(documentSnapshot('other.md', 'other document', REVISION_D))
      else result.current.clear()
    })
    const kept = result.current.state.markdown
    await act(async () => { decision.resolve('discard'); expect(await closing).toEqual({ status: 'cancelled' }) })
    expect(result.current.state.markdown).toBe(kept)
    expect(window.arkdown.discardDraft).not.toHaveBeenCalled()
    expect(window.arkdown.saveDocument).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'discard'] as const)('offers a safe %s when closing a recovered draft whose original has changed', async (decision) => {
    const confirm = vi.fn(async () => decision)
    window.arkdown = createApi({ businessConfirm: confirm })
    const { result } = renderHook(() => useDocumentSession())
    act(() => result.current.recover('123e4567-e89b-42d3-a456-426614174000', 'recovered text', documentSnapshot('note.md', 'newer disk text', REVISION_C), true))
    await act(async () => {
      expect(await result.current.prepareForClose(vi.fn())).toEqual({ status: decision === 'discard' ? 'ready' : 'cancelled' })
    })
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: '另存为', discardLabel: '不保存', cancelLabel: '取消' }))
    expect(window.arkdown.saveDocument).not.toHaveBeenCalled()
    if (decision === 'cancel') {
      expect(result.current.state).toMatchObject({ status: 'conflict', markdown: 'recovered text' })
      expect(window.arkdown.discardDraft).not.toHaveBeenCalled()
    } else {
      expect(window.arkdown.discardDraft).toHaveBeenCalledOnce()
      expect(result.current.state.markdown).toBe('newer disk text')
    }
  })

  it.each(['cancel', 'failure', 'success'] as const)('routes conflict close to Save As and preserves the original on %s', async (outcome) => {
    window.arkdown = createApi({
      beginSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: outcome === 'cancel' ? null : saveAsIntent() })),
      commitSaveDocumentAs: vi.fn(async () => outcome === 'failure'
        ? { ok: false as const, error: { code: 'OPERATION_FAILED', message: 'target denied' } }
        : { ok: true as const, value: committedSaveAs('recovered text') }),
      abortSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: null })),
    })
    const { result } = renderHook(() => useDocumentSession())
    act(() => result.current.recover('123e4567-e89b-42d3-a456-426614174000', 'recovered text', documentSnapshot('note.md', 'newer disk text', REVISION_C), true))
    await act(async () => {
      expect(await result.current.prepareForClose(vi.fn())).toEqual(outcome === 'success'
        ? { status: 'ready' } : outcome === 'cancel' ? { status: 'cancelled' } : { status: 'failed', code: 'document-save-failed' })
    })
    expect(window.arkdown.saveDocument).not.toHaveBeenCalled()
    expect(result.current.state.markdown).toBe('recovered text')
    expect(window.arkdown.beginSaveDocumentAs).toHaveBeenCalledOnce()
    if (outcome === 'success') expect(result.current.state.relativePath).toBe('saved.md')
    else {
      expect(result.current.state.status).toBe('conflict')
      await act(async () => { expect(await result.current.save()).toBe(false) })
      expect(window.arkdown.saveDocument).not.toHaveBeenCalled()
    }
  })

  it('reports the real Save As workspace confirmation as user waiting during close', async () => {
    const decision = deferred<boolean>()
    const confirm = vi.fn(() => decision.promise)
    window.arkdown = createApi({
      beginSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: saveAsIntent(true) })),
      commitSaveDocumentAs: vi.fn(), abortSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: null })),
    })
    const { result } = renderHook(() => useDocumentSession(undefined, undefined, undefined, undefined, confirm))
    act(() => result.current.change('one'))
    const stages = vi.fn()
    let closing!: ReturnType<typeof result.current.prepareForClose>
    act(() => { closing = result.current.prepareForClose(stages) })
    await act(async () => { await vi.advanceTimersByTimeAsync(100_000) })
    expect(confirm).toHaveBeenCalledOnce()
    expect(stages.mock.lastCall).toEqual(['await-user'])
    expect(window.arkdown.commitSaveDocumentAs).not.toHaveBeenCalled()
    await act(async () => { decision.resolve(false); expect(await closing).toEqual({ status: 'cancelled' }) })
  })
  it('classifies the first committed Save As pending-draft failure during structured close', async () => {
    const committed = { ...committedSaveAs('one'), draftEndPending: true as const }
    window.arkdown = createApi({
      beginSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: saveAsIntent() })),
      commitSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: committed })),
      abortSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: null })),
    })
    const { result } = renderHook(() => useDocumentSession())
    act(() => result.current.change('one'))
    await act(async () => {
      expect(await result.current.prepareForClose(vi.fn())).toEqual({ status: 'failed', code: 'draft-end-failed' })
    })
    expect(result.current.state.relativePath).toBe('saved.md')
    expect(result.current.state.savedMarkdown).toBe('one')
    expect(window.arkdown.commitSaveDocumentAs).toHaveBeenCalledOnce()
  })
  it('prepares clean close with a structured result and fences edits until restored', async () => {
    const stages = vi.fn()
    const { result } = renderHook(() => useDocumentSession())
    await act(async () => { expect(await result.current.prepareForClose(stages)).toEqual({ status: 'ready' }) })
    expect(stages).toHaveBeenCalledWith('prepare-editor')
    act(() => result.current.change('blocked after preparation'))
    expect(result.current.state.markdown).toBe('')
    act(() => { result.current.setInteractionLocked(false); result.current.change('after return') })
    expect(result.current.state.markdown).toBe('after return')
  })

  it('reports actual user waiting without a timeout and keeps cancellation distinct from failure', async () => {
    const decision = deferred<'cancel'>()
    window.arkdown = createApi({ businessConfirm: vi.fn(() => decision.promise) })
    const stages = vi.fn()
    const { result } = renderHook(() => useDocumentSession())
    await openAndChange(result)
    let closing!: ReturnType<typeof result.current.prepareForClose>
    act(() => { closing = result.current.prepareForClose(stages) })
    await act(async () => { await vi.advanceTimersByTimeAsync(100_000) })
    expect(stages.mock.lastCall).toEqual(['await-user'])
    expect(window.arkdown.saveDocument).not.toHaveBeenCalled()
    await act(async () => { decision.resolve('cancel'); expect(await closing).toEqual({ status: 'cancelled' }) })
    act(() => result.current.change('still editable'))
    expect(result.current.state.markdown).toBe('still editable')
  })

  it('retains one pending save during close and reports its late failure with a stable code', async () => {
    const saved = deferred<ApiResult<SaveDocumentResult>>()
    window.arkdown = createApi({ saveDocument: vi.fn(() => saved.promise) })
    const stages = vi.fn()
    const { result } = renderHook(() => useDocumentSession())
    await openAndChange(result)
    let closing!: ReturnType<typeof result.current.prepareForClose>
    act(() => { closing = result.current.prepareForClose(stages) })
    await act(async () => { await vi.advanceTimersByTimeAsync(100_000) })
    expect(stages.mock.lastCall).toEqual(['settle-document'])
    expect(window.arkdown.saveDocument).toHaveBeenCalledOnce()
    let second!: ReturnType<typeof result.current.prepareForClose>
    act(() => { second = result.current.prepareForClose(stages) })
    await act(async () => {
      saved.resolve({ ok: false, error: { code: 'OPERATION_FAILED', message: 'private failure detail' } })
      expect(await closing).toEqual({ status: 'failed', code: 'document-save-failed' })
      expect(await second).toEqual({ status: 'failed', code: 'document-save-failed' })
    })
    expect(result.current.dirty).toBe(true)
    expect(window.arkdown.saveDocument).toHaveBeenCalledOnce()
  })

  it('reports failed explicit discard as draft-end failure and retains the document', async () => {
    window.arkdown = createApi({ businessConfirm: vi.fn(async () => 'discard' as const),
      discardDraft: vi.fn(async () => ({ ok: false as const, error: { code: 'OPERATION_FAILED', message: 'draft error' } })) })
    const { result } = renderHook(() => useDocumentSession())
    await openAndChange(result)
    await act(async () => {
      expect(await result.current.prepareForClose(vi.fn())).toEqual({ status: 'failed', code: 'draft-end-failed' })
    })
    expect(result.current.state.markdown).toBe('two')
    expect(result.current.dirty).toBe(true)
  })

  it('establishes empty draft ownership before first clipboard paste and cancels a switched target', async () => {
    const calls: string[] = []
    let resolve!: (value: ApiResult<string | null>) => void
    const api = createApi()
    const saveDraft = api.saveDraft!
    api.saveDraft = vi.fn(async (input) => { calls.push('draft'); return await saveDraft(input) })
    api.pasteClipboardImage = vi.fn(() => { calls.push('image'); return new Promise<ApiResult<string | null>>((done) => { resolve = done }) })
    window.arkdown = api
    const { result } = renderHook(() => useDocumentSession())
    let pending!: Promise<string | null>
    await act(async () => { pending = result.current.readClipboardImage(); await Promise.resolve(); await Promise.resolve() })
    expect(calls).toEqual(['draft', 'image'])
    expect(api.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ markdown: '', expectedOriginalRevision: null }))
    await act(async () => { await result.current.open('other.md') })
    await act(async () => { resolve({ ok: true, value: '![](staged.png)' }); expect(await pending).toBeNull() })
  })

  it('adopts rewritten clipboard Markdown on ordinary save', async () => {
    window.arkdown = createApi({
      pasteClipboardImage: async () => ({ ok: true, value: '![](staged.png)' }),
      saveDocument: async () => ({ ok: true, value: { revision: REVISION_B, mtimeMs: 2, markdown: '![](assets/clip.png)', clipboardAssetsRetained: true } }),
    })
    const { result } = renderHook(() => useDocumentSession())
    await act(async () => { await result.current.open('note.md') })
    await act(async () => { const image = await result.current.readClipboardImage(); result.current.change(image!) })
    const draftId = result.current.draftId
    await act(async () => { await result.current.save() })
    expect(result.current.state.markdown).toBe('![](assets/clip.png)')
    expect(result.current.dirty).toBe(false)
    expect(result.current.draftId).toBe(draftId)
    expect(window.arkdown.discardDraft).not.toHaveBeenCalled()
  })
  it('classifies persistence from explicit provenance instead of the mutable display name', () => {
    expect(persistenceKind({
      ...EMPTY_SESSION,
      persistenceKind: 'imported-docx',
      displayName: 'renamed.md',
      sourceRelativePath: 'report.docx',
      relativePath: null,
      revision: null,
    })).toBe('imported-docx')
    expect(persistenceKind({
      ...EMPTY_SESSION,
      persistenceKind: 'saved-document',
      relativePath: 'note.md',
      revision: REVISION_A,
    })).toBe('saved-document')
    expect(persistenceKind({
      ...EMPTY_SESSION,
      displayName: 'misleading.docx',
    })).toBe('unsaved-document')
    expect(persistenceKind(EMPTY_SESSION)).toBe('unsaved-document')
  })

  it('exports an edited imported DOCX before a file transition instead of opening Markdown Save As', async () => {
    const dialogs = businessDialog('confirm')
    const exportDocx = vi.fn(async () => ({
      ok: true as const,
      value: { fileName: 'report-export.docx', reusedTarget: false },
    }))
    window.arkdown = createApi({ exportDocx })
    const hook = renderHook(() => useDocumentSession(undefined, undefined, undefined, dialogs))
    act(() => hook.result.current.adoptImportedDocx({
      sourceAbsolutePath: 'C:/notes/report.docx',
      sourceFileName: 'report.docx',
      markdown: '# Imported',
    }))
    act(() => hook.result.current.change('# Edited'))
    const transition = vi.fn()

    await act(async () => {
      await expect(hook.result.current.transitionAfterSave(transition)).resolves.toBe(true)
    })

    expect(dialogs.confirm).toHaveBeenCalledWith({
      title: '是否导出为新的docx文档？',
      description: 'Arkdown无法修改原docx文档。',
      confirmLabel: '导出',
      discardLabel: '不保存',
      cancelLabel: '取消',
    })
    expect(exportDocx).toHaveBeenCalledWith(expect.objectContaining({
      markdown: '# Edited',
      mode: 'choose',
      suggestedBaseName: 'report',
    }))
    expect(transition).toHaveBeenCalledOnce()
    expect(hook.result.current.dirty).toBe(false)
  })

  it.each([
    ['declines export', 'cancel' as const, { ok: true as const, value: null }],
    ['fails export', 'confirm' as const, {
      ok: false as const,
      error: { code: 'OPERATION_FAILED' as const, message: 'export failed' },
    }],
  ])('blocks a pending transition when the user %s and preserves the dirty DOCX', async (
    _label,
    dialogResult,
    exportResult,
  ) => {
    const dialogs = businessDialog(dialogResult)
    const exportDocx = vi.fn(async () => exportResult)
    window.arkdown = createApi({ exportDocx })
    const hook = renderHook(() => useDocumentSession(undefined, undefined, undefined, dialogs))
    act(() => hook.result.current.adoptImportedDocx({
      sourceAbsolutePath: 'C:/notes/report.docx',
      sourceFileName: 'report.docx',
      markdown: '# Imported',
    }))
    act(() => hook.result.current.change('# Edited'))
    const transition = vi.fn()

    await act(async () => {
      await expect(hook.result.current.transitionAfterSave(transition)).resolves.toBe(false)
    })

    expect(transition).not.toHaveBeenCalled()
    expect(hook.result.current.state.markdown).toBe('# Edited')
    expect(hook.result.current.dirty).toBe(true)
    if (dialogResult === 'cancel') expect(exportDocx).not.toHaveBeenCalled()
  })

  it('discards an edited imported DOCX back to its imported baseline and continues a close transition', async () => {
    const dialogs: BusinessConfirmController = {
      confirm: vi.fn()
        .mockResolvedValueOnce('confirm')
        .mockResolvedValueOnce('discard'),
    }
    const exportDocx = vi.fn(async () => ({
      ok: true as const,
      value: { fileName: 'report-export.docx', reusedTarget: false },
    }))
    const discardDraft = vi.fn(async () => ({ ok: true as const, value: null }))
    window.arkdown = createApi({ discardDraft, exportDocx })
    const hook = renderHook(() => useDocumentSession(undefined, undefined, undefined, dialogs))
    act(() => hook.result.current.adoptImportedDocx({
      sourceAbsolutePath: 'C:/notes/report.docx',
      sourceFileName: 'report.docx',
      markdown: '# Imported baseline',
    }))
    act(() => hook.result.current.change('# Exported edit'))
    await act(async () => {
      await expect(hook.result.current.save()).resolves.toBe(true)
    })
    act(() => hook.result.current.change('# Unsaved edit'))
    const closeTransition = vi.fn()

    await act(async () => {
      await expect(hook.result.current.transitionAfterSave(closeTransition)).resolves.toBe(true)
    })

    expect(dialogs.confirm).toHaveBeenLastCalledWith({
      title: '是否导出为新的docx文档？',
      description: 'Arkdown无法修改原docx文档。\n新的修改内容将保存到刚刚导出的文档。',
      confirmLabel: '导出',
      discardLabel: '不保存',
      cancelLabel: '取消',
    })
    expect(exportDocx).toHaveBeenCalledOnce()
    expect(discardDraft).toHaveBeenCalledTimes(2)
    expect(hook.result.current.state.markdown).toBe('# Imported baseline')
    expect(hook.result.current.dirty).toBe(false)
    expect(closeTransition).toHaveBeenCalledOnce()
  })

  it('keeps explicit imported-DOCX save confirmation two-state', async () => {
    const dialogs = businessDialog('cancel')
    const exportDocx = vi.fn()
    window.arkdown = createApi({ exportDocx })
    const hook = renderHook(() => useDocumentSession(undefined, undefined, undefined, dialogs))
    act(() => hook.result.current.adoptImportedDocx({
      sourceAbsolutePath: 'C:/notes/report.docx',
      sourceFileName: 'report.docx',
      markdown: '# Imported',
    }))
    act(() => hook.result.current.change('# Edited'))

    await act(async () => {
      await expect(hook.result.current.save()).resolves.toBe(false)
    })

    expect(dialogs.confirm).toHaveBeenCalledWith({
      title: '是否导出为新的docx文档？',
      description: 'Arkdown无法修改原docx文档。',
      confirmLabel: '导出',
      cancelLabel: '取消',
      actionOrder: 'confirm-cancel',
    })
    expect(exportDocx).not.toHaveBeenCalled()
    expect(hook.result.current.state.markdown).toBe('# Edited')
    expect(hook.result.current.dirty).toBe(true)
  })

  it('chooses the first DOCX export target and reuses it for the next confirmed save', async () => {
    const dialogs = businessDialog('confirm')
    const exportDocx = vi.fn()
      .mockResolvedValueOnce({
        ok: true as const,
        value: { fileName: 'report-export.docx', reusedTarget: false },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: { fileName: 'report-export.docx', reusedTarget: true },
      })
    window.arkdown = createApi({ exportDocx })
    const hook = renderHook(() => useDocumentSession(undefined, undefined, undefined, dialogs))
    act(() => hook.result.current.adoptImportedDocx({
      sourceAbsolutePath: 'C:/notes/report.docx',
      sourceFileName: 'report.docx',
      markdown: '# Imported',
    }))

    act(() => hook.result.current.change('# First edit'))
    await act(async () => { await expect(hook.result.current.persistCurrentDocument()).resolves.toMatchObject({ status: 'saved' }) })
    act(() => hook.result.current.change('# Second edit'))
    await act(async () => { await expect(hook.result.current.persistCurrentDocument()).resolves.toMatchObject({ status: 'saved' }) })

    expect(dialogs.confirm).toHaveBeenCalledTimes(2)
    expect(exportDocx.mock.calls.map(([input]) => input.mode)).toEqual(['choose', 'reuse'])
  })

  it('shares one delayed imported-DOCX persistence core across concurrent close and switch requests', async () => {
    const dialogs: BusinessConfirmController = {
      confirm: vi.fn(async (): Promise<'confirm'> => {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 40))
        return 'confirm'
      }),
    }
    const exportDocx = vi.fn(async () => ({
      ok: true as const,
      value: { fileName: 'report-export.docx', reusedTarget: false },
    }))
    window.arkdown = createApi({ exportDocx })
    const hook = renderHook(() => useDocumentSession(undefined, undefined, undefined, dialogs))
    act(() => hook.result.current.adoptImportedDocx({
      sourceAbsolutePath: 'C:/notes/report.docx',
      sourceFileName: 'report.docx',
      markdown: '# Imported',
    }))
    act(() => hook.result.current.change('# Edited'))
    const closeTransition = vi.fn()
    const switchTransition = vi.fn()

    let close!: Promise<boolean>
    let switchDocument!: Promise<boolean>
    act(() => {
      close = hook.result.current.transitionAfterSave(closeTransition)
      switchDocument = hook.result.current.transitionAfterSave(switchTransition)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(dialogs.confirm).toHaveBeenCalledOnce()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40)
      await expect(Promise.all([close, switchDocument])).resolves.toEqual([true, true])
    })

    expect(dialogs.confirm).toHaveBeenCalledOnce()
    expect(exportDocx).toHaveBeenCalledOnce()
    expect(closeTransition).toHaveBeenCalledOnce()
    expect(switchTransition).toHaveBeenCalledOnce()
  })

  it('shares one delayed confirmation and save across concurrent saved-document transitions', async () => {
    const dialogs: BusinessConfirmController = {
      confirm: vi.fn(async (): Promise<'confirm'> => {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 40))
        return 'confirm'
      }),
    }
    const saveDocument = vi.fn(async () => ({
      ok: true as const,
      value: { revision: REVISION_B, mtimeMs: 2 },
    }))
    window.arkdown = createApi({ saveDocument })
    const hook = renderHook(() => useDocumentSession(undefined, undefined, undefined, dialogs))
    await act(async () => { await hook.result.current.open('note.md') })
    act(() => hook.result.current.change('# Edited'))
    const closeTransition = vi.fn()
    const switchTransition = vi.fn()

    let close!: Promise<boolean>
    let switchDocument!: Promise<boolean>
    act(() => {
      close = hook.result.current.transitionAfterSave(closeTransition)
      switchDocument = hook.result.current.transitionAfterSave(switchTransition)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    expect(dialogs.confirm).toHaveBeenCalledOnce()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40)
      await expect(Promise.all([close, switchDocument])).resolves.toEqual([true, true])
    })

    expect(dialogs.confirm).toHaveBeenCalledOnce()
    expect(saveDocument).toHaveBeenCalledOnce()
    expect(closeTransition).toHaveBeenCalledOnce()
    expect(switchTransition).toHaveBeenCalledOnce()
  })

  it('keeps a current open request isolated from a superseded caller sharing delayed persistence', async () => {
    const dialogs: BusinessConfirmController = {
      confirm: vi.fn(async (): Promise<'confirm'> => {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 40))
        return 'confirm'
      }),
    }
    const saveDocument = vi.fn(async () => ({
      ok: true as const,
      value: { revision: REVISION_B, mtimeMs: 2 },
    }))
    const readDocument = vi.fn(async (relativePath: string) => ({
      ok: true as const,
      value: documentSnapshot(
        relativePath,
        relativePath === 'note.md' ? '# Original' : relativePath === 'b.md' ? 'B' : 'A',
      ),
    }))
    window.arkdown = createApi({ readDocument, saveDocument })
    const hook = renderHook(() => useDocumentSession(undefined, undefined, undefined, dialogs))
    await act(async () => { await hook.result.current.open('note.md') })
    act(() => hook.result.current.change('# Edited'))

    let superseded!: ReturnType<typeof hook.result.current.open>
    let current!: ReturnType<typeof hook.result.current.open>
    act(() => { superseded = hook.result.current.open('a.md') })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    act(() => { current = hook.result.current.open('b.md') })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    expect(dialogs.confirm).toHaveBeenCalledOnce()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40)
      await expect(Promise.all([superseded, current])).resolves.toEqual([
        { status: 'cancelled' },
        { status: 'opened' },
      ])
    })

    expect(saveDocument).toHaveBeenCalledOnce()
    expect(readDocument).toHaveBeenCalledTimes(2)
    expect(readDocument).toHaveBeenCalledWith('b.md')
    expect(hook.result.current.state).toMatchObject({
      relativePath: 'b.md',
      markdown: 'B',
    })
  })

  it('lets a transition complete when its unsaved Save As legitimately rebinds the lifecycle', async () => {
    const beginSaveDocumentAs = vi.fn(async () => ({
      ok: true as const,
      value: saveAsIntent(),
    }))
    window.arkdown = createApi({
      beginSaveDocumentAs,
      commitSaveDocumentAs: vi.fn(async () => ({
        ok: true as const,
        value: committedSaveAs('# Draft'),
      })),
      abortSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: null })),
    })
    const hook = renderHook(() => useDocumentSession(
      undefined,
      undefined,
      undefined,
      businessDialog('confirm'),
    ))
    act(() => hook.result.current.change('# Draft'))
    const transition = vi.fn()

    await act(async () => {
      await expect(hook.result.current.transitionAfterSave(transition)).resolves.toBe(true)
    })

    expect(beginSaveDocumentAs).toHaveBeenCalledOnce()
    expect(transition).toHaveBeenCalledOnce()
    expect(hook.result.current.state).toMatchObject({
      relativePath: 'saved.md',
      persistenceKind: 'saved-document',
      markdown: '# Draft',
    })
  })

  it('cancels a transition when an external replacement supersedes its pending Save As', async () => {
    const pendingCommit = deferred<Awaited<ReturnType<NonNullable<ArkdownApi['commitSaveDocumentAs']>>>>()
    const commitSaveDocumentAs = vi.fn(() => pendingCommit.promise)
    window.arkdown = createApi({
      beginSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: saveAsIntent() })),
      commitSaveDocumentAs,
      abortSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: null })),
    })
    const hook = renderHook(() => useDocumentSession(
      undefined,
      undefined,
      undefined,
      businessDialog('confirm'),
    ))
    act(() => hook.result.current.change('A draft'))
    const transition = vi.fn()
    let transitioning!: Promise<boolean>
    act(() => { transitioning = hook.result.current.transitionAfterSave(transition) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(commitSaveDocumentAs).toHaveBeenCalledOnce()

    act(() => hook.result.current.adopt(documentSnapshot('b.md', 'B', REVISION_C)))
    await act(async () => {
      pendingCommit.resolve({
        ok: true,
        value: {
          ...committedSaveAs('A draft'),
          document: documentSnapshot('saved-a.md', 'A draft', REVISION_B),
        },
      })
      await expect(transitioning).resolves.toBe(false)
    })

    expect(transition).not.toHaveBeenCalled()
    expect(hook.result.current.state).toMatchObject({
      relativePath: 'b.md',
      persistenceKind: 'saved-document',
      markdown: 'B',
    })
  })

  it('lets a transition join an explicit save without adding a business confirmation', async () => {
    const pendingSave = deferred<ApiResult<SaveDocumentResult>>()
    const saveDocument = vi.fn(() => pendingSave.promise)
    const dialogs = businessDialog('confirm')
    window.arkdown = createApi({ saveDocument })
    const hook = renderHook(() => useDocumentSession(undefined, undefined, undefined, dialogs))
    await act(async () => { await hook.result.current.open('note.md') })
    act(() => hook.result.current.change('# Edited'))
    const transition = vi.fn()
    let saving!: Promise<boolean>
    let transitioning!: Promise<boolean>
    act(() => {
      saving = hook.result.current.save()
      transitioning = hook.result.current.transitionAfterSave(transition)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    expect(saveDocument).toHaveBeenCalledOnce()
    expect(dialogs.confirm).not.toHaveBeenCalled()
    await act(async () => {
      pendingSave.resolve({ ok: true, value: { revision: REVISION_B, mtimeMs: 2 } })
      await expect(Promise.all([saving, transitioning])).resolves.toEqual([true, true])
    })
    expect(transition).toHaveBeenCalledOnce()
  })

  it('shares a transition-first cancellation with a concurrent explicit save', async () => {
    const confirmation = deferred<Awaited<ReturnType<BusinessDialogController['confirm']>>>()
    const dialogs: BusinessConfirmController = { confirm: vi.fn(() => confirmation.promise) }
    const saveDocument = vi.fn(async () => ({
      ok: true as const,
      value: { revision: REVISION_B, mtimeMs: 2 },
    }))
    window.arkdown = createApi({ saveDocument })
    const hook = renderHook(() => useDocumentSession(undefined, undefined, undefined, dialogs))
    await act(async () => { await hook.result.current.open('note.md') })
    act(() => hook.result.current.change('# Edited'))
    const transition = vi.fn()
    let transitioning!: Promise<boolean>
    act(() => { transitioning = hook.result.current.transitionAfterSave(transition) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(dialogs.confirm).toHaveBeenCalledOnce()

    let saving!: Promise<boolean>
    act(() => { saving = hook.result.current.save() })
    await act(async () => {
      confirmation.resolve('cancel')
      await expect(Promise.all([transitioning, saving])).resolves.toEqual([false, false])
    })

    expect(dialogs.confirm).toHaveBeenCalledOnce()
    expect(saveDocument).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
    expect(hook.result.current.dirty).toBe(true)
  })

  it('warns when a transient draft backup fails and reports success on a later leave attempt', async () => {
    const api = createApi()
    const successfulSaveDraft = api.saveDraft!
    const saveDraft = vi.fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: 'OPERATION_FAILED' as const, message: '临时目录不可用' },
      })
      .mockImplementation(successfulSaveDraft)
    const dialogs: BusinessConfirmController = {
      confirm: vi.fn(async (): Promise<'cancel'> => 'cancel'),
    }
    window.arkdown = createApi({ saveDraft })
    const hook = renderHook(() => useDocumentSession(undefined, undefined, undefined, dialogs))
    await openAndChange(hook.result, '# Edited')
    const transition = vi.fn()

    await act(async () => {
      await expect(hook.result.current.transitionAfterSave(transition)).resolves.toBe(false)
    })

    expect(dialogs.confirm).toHaveBeenNthCalledWith(1, expect.objectContaining({
      description: expect.stringContaining('临时草稿备份失败'),
    }))
    expect(vi.mocked(dialogs.confirm).mock.calls[0]![0].description).not.toContain('已备份')
    expect(hook.result.current.state.markdown).toBe('# Edited')
    expect(hook.result.current.dirty).toBe(true)

    await act(async () => {
      await expect(hook.result.current.transitionAfterSave(transition)).resolves.toBe(false)
    })

    expect(saveDraft).toHaveBeenCalledTimes(2)
    expect(dialogs.confirm).toHaveBeenNthCalledWith(2, expect.objectContaining({
      description: '未保存的内容已备份到临时草稿。',
    }))
    expect(transition).not.toHaveBeenCalled()
  })

  it('does not promise a retry for an unchanged draft rejected as invalid input', async () => {
    const saveDraft = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'INVALID_INPUT' as const, message: '请求参数无效' },
    }))
    const dialogs: BusinessConfirmController = {
      confirm: vi.fn(async (): Promise<'cancel'> => 'cancel'),
    }
    window.arkdown = createApi({ saveDraft })
    const hook = renderHook(() => useDocumentSession(undefined, undefined, undefined, dialogs))
    await openAndChange(hook.result, '# Invalid draft')

    await act(async () => {
      await expect(hook.result.current.transitionAfterSave(vi.fn())).resolves.toBe(false)
      await expect(hook.result.current.transitionAfterSave(vi.fn())).resolves.toBe(false)
    })

    expect(saveDraft).toHaveBeenCalledOnce()
    for (const [options] of vi.mocked(dialogs.confirm).mock.calls) {
      expect(options.description).toContain('临时草稿备份失败')
      expect(options.description).not.toContain('取消后重试')
      expect(options.description).not.toContain('已备份')
    }
  })

  it('saves normally after a thrown draft backup failure without claiming backup success', async () => {
    const saveDocument = vi.fn(async () => ({
      ok: true as const,
      value: { revision: REVISION_B, mtimeMs: 2 },
    }))
    const dialogs = businessDialog('confirm')
    window.arkdown = createApi({
      saveDraft: vi.fn(async () => { throw new Error('草稿磁盘不可写') }),
      saveDocument,
    })
    const hook = renderHook(() => useDocumentSession(undefined, undefined, undefined, dialogs))
    await openAndChange(hook.result, '# Edited')
    const transition = vi.fn()

    await act(async () => {
      await expect(hook.result.current.transitionAfterSave(transition)).resolves.toBe(true)
    })

    const description = vi.mocked(dialogs.confirm).mock.calls[0]![0].description
    expect(description).toContain('临时草稿备份失败')
    expect(description).toContain('建议先保存')
    expect(description).not.toContain('已备份')
    expect(saveDocument).toHaveBeenCalledWith(expect.objectContaining({ markdown: '# Edited' }))
    expect(transition).toHaveBeenCalledOnce()
    expect(hook.result.current.dirty).toBe(false)
  })

  it('keeps the discard path after an API draft backup failure', async () => {
    const dialogs = businessDialog('discard')
    const saveDocument = vi.fn()
    const discardDraft = vi.fn(async () => ({ ok: true as const, value: null }))
    window.arkdown = createApi({
      saveDraft: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'OPERATION_FAILED' as const, message: '草稿备份失败' },
      })),
      saveDocument,
      discardDraft,
    })
    const hook = renderHook(() => useDocumentSession(undefined, undefined, undefined, dialogs))
    await openAndChange(hook.result, '# Discard me')
    const transition = vi.fn()

    await act(async () => {
      await expect(hook.result.current.transitionAfterSave(transition)).resolves.toBe(true)
    })

    expect(vi.mocked(dialogs.confirm).mock.calls[0]![0].description).not.toContain('已备份')
    expect(saveDocument).not.toHaveBeenCalled()
    expect(discardDraft).toHaveBeenCalledOnce()
    expect(transition).toHaveBeenCalledOnce()
    expect(hook.result.current.dirty).toBe(false)
  })

  it('preserves DOCX export guidance while warning about a failed draft backup', async () => {
    const dialogs = businessDialog('cancel')
    window.arkdown = createApi({
      saveDraft: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'OPERATION_FAILED' as const, message: '草稿服务不可用' },
      })),
    })
    const hook = renderHook(() => useDocumentSession(undefined, undefined, undefined, dialogs))
    act(() => hook.result.current.adoptImportedDocx({
      sourceAbsolutePath: 'C:/notes/report.docx',
      sourceFileName: 'report.docx',
      markdown: '# Imported',
    }))
    act(() => hook.result.current.change('# Edited'))

    await act(async () => {
      await expect(hook.result.current.transitionAfterSave(vi.fn())).resolves.toBe(false)
    })

    const description = vi.mocked(dialogs.confirm).mock.calls[0]![0].description
    expect(description).toContain('Arkdown无法修改原docx文档。')
    expect(description).toContain('临时草稿备份失败')
    expect(description).not.toContain('已备份')
  })
})

afterEach(() => {
  vi.useRealTimers()
})

it('rotates draft identity when creating, adopting, or clearing a document', async () => {
  const { result } = renderHook(() => useDocumentSession())
  const initialDraftId = result.current.draftId

  await act(async () => {
    await result.current.create('created.md')
  })
  const createdDraftId = result.current.draftId
  expect(createdDraftId).not.toBe(initialDraftId)

  act(() => result.current.adopt(documentSnapshot('adopted.md')))
  const adoptedDraftId = result.current.draftId
  expect(adoptedDraftId).not.toBe(createdDraftId)

  act(() => result.current.clear())
  expect(result.current.draftId).not.toBe(adoptedDraftId)
})

it('rotates the main-owned export session identity for every document lifecycle', async () => {
  const { result } = renderHook(() => useDocumentSession())
  const exportSessionId = () => (
    result.current as typeof result.current & { documentExportSessionId?: string }
  ).documentExportSessionId
  const initial = exportSessionId()

  expect(initial).toMatch(/^[0-9a-f-]{36}$/)

  await act(async () => {
    await result.current.open('note.md')
  })
  const opened = exportSessionId()
  expect(opened).toMatch(/^[0-9a-f-]{36}$/)
  expect(opened).not.toBe(initial)

  act(() => result.current.adopt(documentSnapshot('adopted.md')))
  const adopted = exportSessionId()
  expect(adopted).not.toBe(opened)

  act(() => result.current.clear())
  expect(exportSessionId()).not.toBe(adopted)
})

it('adopts a converted result as a dirty untitled Markdown lifecycle and backs it up without another edit', async () => {
  const saveDraft = vi.mocked(window.arkdown.saveDraft!)
  const { result } = renderHook(() => useDocumentSession())
  const initialDraftId = result.current.draftId
  const initialExportSessionId = result.current.documentExportSessionId

  await act(async () => {
    await expect(result.current.adoptConverted(convertedDocument())).resolves.toBe(true)
  })

  expect(result.current.state).toMatchObject({
    status: 'ready',
    relativePath: null,
    sourceRelativePath: null,
    displayName: 'quarter.final.md',
    openingMarkdown: '',
    markdown: '# Converted\n\nBody',
    savedMarkdown: '',
    draftMarkdown: '',
    revision: null,
    encoding: 'utf8',
    newline: 'lf',
    mtimeMs: null,
    recovered: false,
    hasSavedThisOpen: false,
  })
  expect(result.current.dirty).toBe(true)
  expect(result.current.draftId).not.toBe(initialDraftId)
  expect(result.current.documentExportSessionId).not.toBe(initialExportSessionId)

  await act(async () => {
    await vi.advanceTimersByTimeAsync(800)
  })
  expect(saveDraft).toHaveBeenCalledOnce()
  expect(saveDraft).toHaveBeenCalledWith(expect.objectContaining({
    draftId: result.current.draftId,
    markdown: '# Converted\n\nBody',
    expectedOriginalRevision: null,
    encoding: 'utf8',
    newline: 'lf',
  }))
})

it('keeps the current dirty session and identities when converted adoption is cancelled', async () => {
  const businessConfirm = vi.fn(async (): Promise<'cancel'> => 'cancel')
  window.arkdown = createApi({ businessConfirm })
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result, 'current dirty')
  const before = result.current.state
  const draftId = result.current.draftId
  const exportSessionId = result.current.documentExportSessionId

  await act(async () => {
    await expect(result.current.adoptConverted(convertedDocument())).resolves.toBe(false)
  })

  expect(businessConfirm).toHaveBeenCalledOnce()
  expect(result.current.state).toMatchObject({
    relativePath: before.relativePath,
    markdown: before.markdown,
    savedMarkdown: before.savedMarkdown,
    revision: before.revision,
  })
  expect(result.current.draftId).toBe(draftId)
  expect(result.current.documentExportSessionId).toBe(exportSessionId)
})

it('saves an edited document before successfully adopting the converted draft', async () => {
  const businessConfirm = vi.fn(async (): Promise<'confirm'> => 'confirm')
  const saveDocument = vi.fn(async () => ({
    ok: true as const,
    value: { revision: REVISION_B, mtimeMs: 2 },
  }))
  window.arkdown = createApi({ businessConfirm, saveDocument })
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result, 'saved before conversion')

  await act(async () => {
    await expect(result.current.adoptConverted(convertedDocument())).resolves.toBe(true)
  })

  expect(businessConfirm).toHaveBeenCalledOnce()
  expect(saveDocument).toHaveBeenCalledOnce()
  expect(result.current.state).toMatchObject({
    relativePath: null,
    displayName: 'quarter.final.md',
    markdown: '# Converted\n\nBody',
    savedMarkdown: '',
  })
})

it('keeps a dirty untitled document when Save As is cancelled during converted adoption', async () => {
  const businessConfirm = vi.fn(async (): Promise<'confirm'> => 'confirm')
  const beginSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = createApi({
    businessConfirm,
    beginSaveDocumentAs,
    commitSaveDocumentAs: vi.fn(),
    abortSaveDocumentAs: vi.fn(),
  })
  const { result } = renderHook(() => useDocumentSession())
  act(() => result.current.change('untitled dirty'))
  const draftId = result.current.draftId
  const exportSessionId = result.current.documentExportSessionId

  await act(async () => {
    await expect(result.current.adoptConverted(convertedDocument())).resolves.toBe(false)
  })

  expect(beginSaveDocumentAs).toHaveBeenCalledOnce()
  expect(result.current.state).toMatchObject({
    relativePath: null,
    displayName: null,
    markdown: 'untitled dirty',
  })
  expect(result.current.draftId).toBe(draftId)
  expect(result.current.documentExportSessionId).toBe(exportSessionId)
})

it('returns false without adopting when the current dirty document cannot be saved', async () => {
  const saveDocument = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'WRITE_FAILED', message: 'save failed' },
  }))
  window.arkdown = createApi({
    businessConfirm: vi.fn(async (): Promise<'confirm'> => 'confirm'),
    saveDocument,
  })
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result, 'current dirty')

  await act(async () => {
    await expect(result.current.adoptConverted(convertedDocument())).resolves.toBe(false)
  })

  expect(saveDocument).toHaveBeenCalledOnce()
  expect(result.current.state).toMatchObject({
    relativePath: 'note.md',
    markdown: 'current dirty',
    error: 'save failed',
  })
})

it('uses ordinary Save As rather than imported-DOCX export for a converted draft', async () => {
  const beginSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: null }))
  const exportDocx = vi.fn()
  window.arkdown = createApi({
    beginSaveDocumentAs,
    commitSaveDocumentAs: vi.fn(),
    abortSaveDocumentAs: vi.fn(),
    exportDocx,
  })
  const { result } = renderHook(() => useDocumentSession())
  await act(async () => {
    await result.current.adoptConverted(convertedDocument('report.docx.PDF'))
  })

  await act(async () => {
    await expect(result.current.save()).resolves.toBe(false)
  })

  expect(beginSaveDocumentAs).toHaveBeenCalledWith(expect.objectContaining({
    suggestedFileName: 'report.docx.md',
    markdown: '# Converted\n\nBody',
  }))
  expect(exportDocx).not.toHaveBeenCalled()
})

it('supersedes a pending read without changing its current document or lifecycle identities', async () => {
  const pending = deferred<ApiResult<DocumentSnapshot>>()
  window.arkdown = createApi({
    readDocument: vi.fn((relativePath) => relativePath === 'slow.md'
      ? pending.promise
      : Promise.resolve({ ok: true as const, value: documentSnapshot(relativePath, 'current') })),
  })
  const { result } = renderHook(() => useDocumentSession())
  await act(async () => { await result.current.open('current.md') })
  const draftId = result.current.draftId
  const exportSessionId = result.current.documentExportSessionId
  let opening!: ReturnType<typeof result.current.open>
  act(() => { opening = result.current.open('slow.md') })
  await act(async () => { await Promise.resolve() })
  expect(result.current.state.status).toBe('loading')

  act(() => result.current.supersedePendingOpen())
  expect(result.current.state).toMatchObject({
    status: 'ready',
    relativePath: 'current.md',
    markdown: 'current',
  })
  expect(result.current.draftId).toBe(draftId)
  expect(result.current.documentExportSessionId).toBe(exportSessionId)

  pending.resolve({ ok: true, value: documentSnapshot('slow.md', 'stale') })
  await act(async () => {
    await expect(opening).resolves.toEqual({ status: 'cancelled' })
  })
  expect(result.current.state).toMatchObject({ relativePath: 'current.md', markdown: 'current' })
})

it('supersedes a pending Pandoc import and ignores its late converted result', async () => {
  const pending = deferred<Awaited<ReturnType<NonNullable<ArkdownApi['importDocx']>>>>()
  window.arkdown = createApi({ importDocx: vi.fn(() => pending.promise) })
  const { result } = renderHook(() => useDocumentSession())
  act(() => result.current.adopt(documentSnapshot('current.md', 'current')))
  const draftId = result.current.draftId
  const exportSessionId = result.current.documentExportSessionId
  let importing!: ReturnType<typeof result.current.importDocx>
  act(() => { importing = result.current.importDocx('slow.docx') })
  await act(async () => { await Promise.resolve() })
  expect(result.current.state.status).toBe('loading')

  act(() => result.current.supersedePendingOpen())
  expect(result.current.state).toMatchObject({
    status: 'ready',
    relativePath: 'current.md',
    markdown: 'current',
  })
  pending.resolve({
    ok: true,
    value: {
      sourceAbsolutePath: 'C:/notes/slow.docx',
      sourceFileName: 'slow.docx',
      markdown: 'stale import',
    },
  })
  await act(async () => { await importing })

  expect(result.current.state).toMatchObject({ relativePath: 'current.md', markdown: 'current' })
  expect(result.current.draftId).toBe(draftId)
  expect(result.current.documentExportSessionId).toBe(exportSessionId)
})

it('supersedes a pending dirty-open guard before its stale discard can run', async () => {
  const confirmation = deferred<Awaited<ReturnType<BusinessConfirm>>>()
  const discardDraft = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = createApi({
    businessConfirm: vi.fn(() => confirmation.promise),
    discardDraft,
  })
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result, 'current dirty')
  const draftId = result.current.draftId
  const exportSessionId = result.current.documentExportSessionId
  let opening!: ReturnType<typeof result.current.open>
  act(() => { opening = result.current.open('stale.md') })
  await act(async () => { await Promise.resolve() })
  expect(latestBusinessConfirm).toHaveBeenCalledOnce()

  act(() => result.current.supersedePendingOpen())
  confirmation.resolve('discard')
  await act(async () => {
    await expect(opening).resolves.toEqual({ status: 'cancelled' })
  })

  expect(discardDraft).not.toHaveBeenCalled()
  expect(result.current.state).toMatchObject({
    relativePath: 'note.md',
    markdown: 'current dirty',
    savedMarkdown: 'one',
  })
  expect(result.current.draftId).toBe(draftId)
  expect(result.current.documentExportSessionId).toBe(exportSessionId)
})

it('fences a converted adoption before stale discard effects when a later open takes ownership', async () => {
  const firstConfirmation = deferred<Awaited<ReturnType<BusinessConfirm>>>()
  const businessConfirm = vi.fn()
    .mockImplementationOnce(() => firstConfirmation.promise)
    .mockResolvedValue('discard' as const)
  window.arkdown = createApi({ businessConfirm })
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result, 'current dirty')
  let adoption!: ReturnType<typeof result.current.adoptConverted>
  act(() => { adoption = result.current.adoptConverted(convertedDocument()) })
  await act(async () => { await Promise.resolve() })
  expect(businessConfirm).toHaveBeenCalledOnce()

  let opening!: ReturnType<typeof result.current.open>
  act(() => { opening = result.current.open('later.md') })
  firstConfirmation.resolve('discard')
  await act(async () => {
    await expect(adoption).resolves.toBe(false)
    await expect(opening).resolves.toEqual({ status: 'opened' })
  })

  expect(result.current.state).toMatchObject({
    relativePath: 'later.md',
    markdown: 'one',
  })
})

it('discards a dirty reload draft before adopting the disk snapshot', async () => {
  const discardDraft = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = createApi({ discardDraft })
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result, 'dirty')

  await act(async () => {
    await result.current.backupDraft(false, true)
    await result.current.reload()
  })

  expect(discardDraft).toHaveBeenCalledTimes(1)
  expect(result.current.state.markdown).toBe('one')
  expect(result.current.dirty).toBe(false)
})

it('reloads an imported DOCX through its source path and preserves imported provenance', async () => {
  const importDocx = vi.fn()
    .mockResolvedValueOnce({
      ok: true as const,
      value: {
        sourceAbsolutePath: 'C:/notes/report.docx',
        sourceFileName: 'report.docx',
        markdown: '# First import',
      },
    })
    .mockResolvedValueOnce({
      ok: true as const,
      value: {
        sourceAbsolutePath: 'C:/notes/report.docx',
        sourceFileName: 'report.docx',
        markdown: '# Reloaded import',
      },
    })
  window.arkdown = createApi({ importDocx })
  const hook = renderHook(() => useDocumentSession())
  await act(async () => { await hook.result.current.importDocx('report.docx') })

  await act(async () => {
    await expect(hook.result.current.reload()).resolves.toBe(true)
  })

  expect(importDocx).toHaveBeenCalledTimes(2)
  expect(importDocx).toHaveBeenLastCalledWith('report.docx')
  expect(window.arkdown.readDocument).not.toHaveBeenCalled()
  expect(hook.result.current.state).toMatchObject({
    persistenceKind: 'imported-docx',
    relativePath: null,
    sourceRelativePath: 'report.docx',
    openingMarkdown: '# Reloaded import',
    savedMarkdown: '# Reloaded import',
    markdown: '# Reloaded import',
  })
})

it('does not let a late imported DOCX reload replace a newer document lifecycle', async () => {
  const pendingReload = deferred<ApiResult<{
    sourceAbsolutePath: string
    sourceFileName: string
    markdown: string
  }>>()
  const importDocx = vi.fn()
    .mockResolvedValueOnce({
      ok: true as const,
      value: {
        sourceAbsolutePath: 'C:/notes/report.docx',
        sourceFileName: 'report.docx',
        markdown: '# Imported',
      },
    })
    .mockImplementationOnce(() => pendingReload.promise)
  window.arkdown = createApi({ importDocx })
  const hook = renderHook(() => useDocumentSession())
  await act(async () => { await hook.result.current.importDocx('report.docx') })

  let reload!: Promise<boolean>
  act(() => { reload = hook.result.current.reload() })
  await vi.waitFor(() => expect(importDocx).toHaveBeenCalledTimes(2))
  act(() => hook.result.current.adopt(documentSnapshot('current.md', '# Current', REVISION_C)))

  await act(async () => {
    pendingReload.resolve({
      ok: true,
      value: {
        sourceAbsolutePath: 'C:/notes/report.docx',
        sourceFileName: 'report.docx',
        markdown: '# Stale import',
      },
    })
    await expect(reload).resolves.toBe(false)
  })

  expect(hook.result.current.state).toMatchObject({
    persistenceKind: 'saved-document',
    relativePath: 'current.md',
    sourceRelativePath: null,
    markdown: '# Current',
  })
})

it('reports an imported DOCX reload rejection without adopting partial state', async () => {
  const importDocx = vi.fn()
    .mockResolvedValueOnce({
      ok: true as const,
      value: {
        sourceAbsolutePath: 'C:/notes/report.docx',
        sourceFileName: 'report.docx',
        markdown: '# Imported',
      },
    })
    .mockRejectedValueOnce(new Error('DOCX reload rejected'))
  window.arkdown = createApi({ importDocx })
  const hook = renderHook(() => useDocumentSession())
  await act(async () => { await hook.result.current.importDocx('report.docx') })

  await act(async () => {
    await expect(hook.result.current.reload()).resolves.toBe(false)
  })

  expect(hook.result.current.state).toMatchObject({
    persistenceKind: 'imported-docx',
    sourceRelativePath: 'report.docx',
    markdown: '# Imported',
    status: 'error',
    error: 'DOCX reload rejected',
  })
})

it('does not save a document that was opened but never edited', async () => {
  const { result } = renderHook(() => useDocumentSession())
  await act(async () => {
    await result.current.open('note.md')
    await vi.advanceTimersByTimeAsync(2_000)
  })

  expect(window.arkdown.saveDocument).not.toHaveBeenCalled()
  expect(result.current.dirty).toBe(false)
})

it('presents pristine, dirty, and saved states only within the current open lifecycle', async () => {
  const { result } = renderHook(() => useDocumentSession())
  const presentation = () => (
    result.current as typeof result.current & { savePresentation?: string }
  ).savePresentation

  expect(presentation()).toBe('pristine')

  await act(async () => {
    await result.current.open('note.md')
  })
  expect(presentation()).toBe('pristine')

  act(() => result.current.change('two'))
  expect(presentation()).toBe('dirty')

  act(() => result.current.change('one'))
  expect(presentation()).toBe('pristine')

  act(() => result.current.change('saved text'))
  await act(async () => {
    expect(await result.current.save()).toBe(true)
  })
  expect(presentation()).toBe('saved')

  act(() => result.current.change('edited after save'))
  expect(presentation()).toBe('dirty')

  act(() => result.current.change('saved text'))
  expect(presentation()).toBe('saved')

  await act(async () => {
    await result.current.open('other.md')
  })
  expect(presentation()).toBe('pristine')
})

it('backs up at 800ms without writing the original document', async () => {
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result)

  await act(async () => {
    await vi.advanceTimersByTimeAsync(799)
  })
  expect(window.arkdown.saveDraft).not.toHaveBeenCalled()
  expect(window.arkdown.saveDocument).not.toHaveBeenCalled()

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(window.arkdown.saveDraft).toHaveBeenCalledWith({
    draftId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    markdown: 'two',
    expectedOriginalRevision: REVISION_A,
    encoding: 'utf8-bom',
    newline: 'crlf',
  })
  expect(window.arkdown.saveDocument).not.toHaveBeenCalled()
  expect(result.current.state.draftMarkdown).toBe('two')
  expect(result.current.state.savedMarkdown).toBe('one')
  expect(result.current.dirty).toBe(true)
})

it('does not repeatedly submit an unchanged draft after invalid input', async () => {
  const saveDraft = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'INVALID_INPUT', message: '请求参数无效' },
  }))
  window.arkdown = createApi({ saveDraft })
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result, 'invalid draft')

  await act(async () => {
    await vi.advanceTimersByTimeAsync(800)
  })
  expect(saveDraft).toHaveBeenCalledTimes(1)
  expect(result.current.state.status).toBe('error')

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000)
  })

  expect(saveDraft).toHaveBeenCalledTimes(1)
  expect(result.current.state.error).toBe('请求参数无效')
})

it('retries an invalid draft after its Markdown changes', async () => {
  const saveDraft = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'INVALID_INPUT', message: '请求参数无效' },
  }))
  window.arkdown = createApi({ saveDraft })
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result, 'first invalid draft')

  await act(async () => {
    await vi.advanceTimersByTimeAsync(800)
  })
  expect(saveDraft).toHaveBeenCalledTimes(1)

  act(() => result.current.change('changed invalid draft'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800)
  })

  expect(saveDraft).toHaveBeenCalledTimes(2)
  expect(saveDraft).toHaveBeenLastCalledWith(expect.objectContaining({
    markdown: 'changed invalid draft',
  }))
})

it('backs up within five seconds during continuous editing', async () => {
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result, 'edit-0')

  for (let index = 1; index <= 7; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
      result.current.change('edit-' + index)
    })
  }
  expect(window.arkdown.saveDraft).not.toHaveBeenCalled()

  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(window.arkdown.saveDraft).toHaveBeenCalledWith(expect.objectContaining({
    markdown: 'edit-7',
  }))
  expect(window.arkdown.saveDocument).not.toHaveBeenCalled()
})

it('prevents the browser shortcut and saves on Ctrl+S', async () => {
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result)
  const event = new KeyboardEvent('keydown', {
    key: 's',
    ctrlKey: true,
    cancelable: true,
  })

  await act(async () => {
    window.dispatchEvent(event)
    await Promise.resolve()
  })

  expect(event.defaultPrevented).toBe(true)
  expect(window.arkdown.saveDocument).toHaveBeenCalledTimes(1)
  expect(result.current.dirty).toBe(false)
})

it('leaves Ctrl+S to the native menu owner without issuing a duplicate renderer save', async () => {
  window.arkdown.onMenuCommand = vi.fn(() => () => {})
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result)
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true })) })
  expect(window.arkdown.saveDocument).not.toHaveBeenCalled()
  expect(result.current.dirty).toBe(true)
})

it('commits Save As through the two-phase API and never calls the legacy endpoint', async () => {
  const beginSaveDocumentAs = vi.fn(async () => ({
    ok: true as const,
    value: saveAsIntent(),
  }))
  const committed = committedSaveAs('# Draft')
  const commitSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: committed }))
  const abortSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = createApi({
    beginSaveDocumentAs, commitSaveDocumentAs, abortSaveDocumentAs,
  })
  const { result } = renderHook(() => useDocumentSession())
  act(() => result.current.change('# Draft'))

  let savedAs!: Awaited<ReturnType<typeof result.current.saveAs>>
  await act(async () => { savedAs = await result.current.saveAs() })

  expect(savedAs).toBe(committed)
  expect(result.current.state).toMatchObject({
    relativePath: 'saved.md', markdown: '# Draft', revision: REVISION_B,
  })
  expect(beginSaveDocumentAs).toHaveBeenCalledWith(expect.objectContaining({
    markdown: '# Draft',
  }))
  expect(commitSaveDocumentAs).toHaveBeenCalledWith(saveAsIntent().intentId)
  expect(abortSaveDocumentAs).not.toHaveBeenCalled()
})

it.each([false, true])('retains pending Save As finalization across close/save and remount=%s without replaying the document write', async (remount) => {
  const committed = { ...committedSaveAs('# Draft', true), draftEndPending: true as const }
  const commitSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: committed }))
  const retryDraftFinalization = vi.fn<NonNullable<ArkdownApi['retryDraftFinalization']>>()
    .mockResolvedValue({ ok: false, error: { code: 'OPERATION_FAILED', message: 'end denied' } })
  const saveDocument = vi.fn(async () => ({ ok: true as const, value: { revision: REVISION_C, mtimeMs: 3 } }))
  const onSavedAs = vi.fn()
  const api = createApi({
    beginSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: saveAsIntent(true) })),
    abortSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: null })),
    commitSaveDocumentAs, retryDraftFinalization, saveDocument,
  })
  window.arkdown = api
  let hook = renderHook(() => useDocumentSession(undefined, onSavedAs))
  act(() => hook.result.current.change('# Draft'))
  await act(async () => { expect(await hook.result.current.saveAs()).toEqual(committed) })
  expect(onSavedAs).toHaveBeenCalledWith(expect.objectContaining({ result: committed }))
  if (remount) {
    hook.unmount()
    hook = renderHook(() => useDocumentSession(undefined, onSavedAs))
    act(() => hook.result.current.adoptSavedAs(onSavedAs.mock.calls[0][0]))
  }
  expect(hook.result.current.state).toMatchObject({ relativePath: 'saved.md', revision: REVISION_B, markdown: '# Draft' })
  const transition = vi.fn()
  await act(async () => { expect(await hook.result.current.transitionAfterSave(transition)).toBe(false) })
  expect(transition).not.toHaveBeenCalled()
  expect(saveDocument).not.toHaveBeenCalled()
  await act(async () => { expect(await hook.result.current.save()).toBe(false) })
  expect(saveDocument).not.toHaveBeenCalled()
  // Editing does not clear the pending gate, but its fresh destination draft
  // remains available even while the old terminal record cannot be committed.
  act(() => hook.result.current.change('# Additional edit'))
  await act(async () => { expect(await hook.result.current.backupDraft()).toBe(true) })
  expect(api.saveDraft).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: '# Additional edit', expectedOriginalRevision: REVISION_B }))
  await act(async () => { expect(await hook.result.current.transitionAfterSave(transition)).toBe(false) })
  expect(hook.result.current.state.markdown).toBe('# Additional edit')
  retryDraftFinalization.mockResolvedValue({ ok: true, value: null })
  await act(async () => { expect(await hook.result.current.save()).toBe(true) })
  expect(saveDocument).toHaveBeenCalledOnce()
  expect(saveDocument).toHaveBeenLastCalledWith(expect.objectContaining({ relativePath: 'saved.md', markdown: '# Additional edit', expectedRevision: REVISION_B }))
  expect(commitSaveDocumentAs).toHaveBeenCalledOnce()
  await act(async () => { expect(await hook.result.current.transitionAfterSave(transition)).toBe(true) })
  expect(transition).toHaveBeenCalledOnce()
})

it('coalesces finalization retries and closes a clean committed destination without replaying its body save', async () => {
  const retry = deferred<ApiResult<null>>()
  const retryDraftFinalization = vi.fn(() => retry.promise)
  const saveDocument = vi.fn(async () => ({ ok: true as const, value: { revision: REVISION_C, mtimeMs: 3 } }))
  window.arkdown = createApi({ retryDraftFinalization, saveDocument })
  const hook = renderHook(() => useDocumentSession())
  act(() => hook.result.current.adoptSavedAs({
    result: { ...committedSaveAs('# Draft', true), draftEndPending: true }, openingMarkdown: '',
  }))
  const transition = vi.fn()
  let save!: Promise<boolean>
  let close!: Promise<boolean>
  act(() => {
    save = hook.result.current.save()
    close = hook.result.current.transitionAfterSave(transition)
  })
  expect(transition).not.toHaveBeenCalled()
  await act(async () => {
    retry.resolve({ ok: true, value: null })
    expect(await save).toBe(true)
    expect(await close).toBe(true)
  })
  expect(retryDraftFinalization).toHaveBeenCalledOnce()
  expect(saveDocument).not.toHaveBeenCalled()
  expect(transition).toHaveBeenCalledOnce()
})

it.each([
  {
    label: 'native cancellation',
    beginResult: { ok: true as const, value: null },
    expectedError: null,
  },
  {
    label: 'begin failure',
    beginResult: {
      ok: false as const,
      error: { code: 'OPERATION_FAILED' as const, message: 'begin failed' },
    },
    expectedError: 'begin failed',
  },
])('settles Save As $label without commit or abort', async ({ beginResult, expectedError }) => {
  const beginSaveDocumentAs = vi.fn(async () => beginResult)
  const commitSaveDocumentAs = vi.fn()
  const abortSaveDocumentAs = vi.fn()
  window.arkdown = createApi({
    beginSaveDocumentAs, commitSaveDocumentAs, abortSaveDocumentAs,
  })
  const { result } = renderHook(() => useDocumentSession())
  act(() => result.current.change('# Draft'))

  await act(async () => {
    await expect(result.current.saveAs()).resolves.toBeNull()
  })

  expect(beginSaveDocumentAs).toHaveBeenCalledOnce()
  expect(commitSaveDocumentAs).not.toHaveBeenCalled()
  expect(abortSaveDocumentAs).not.toHaveBeenCalled()
  expect(result.current.state.relativePath).toBeNull()
  expect(result.current.state.error).toBe(expectedError)
})

it('aborts a begun Save As when the application gate cancels it', async () => {
  const intent = saveAsIntent(true)
  const beginSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: intent }))
  const commitSaveDocumentAs = vi.fn()
  const abortSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = createApi({
    beginSaveDocumentAs, commitSaveDocumentAs, abortSaveDocumentAs,
  })
  const confirmIntent = vi.fn(async () => false)
  const { result } = renderHook(() => useDocumentSession(
    undefined, undefined, undefined, undefined, confirmIntent,
  ))
  act(() => result.current.change('# Draft'))

  await act(async () => {
    await expect(result.current.saveAs()).resolves.toBeNull()
  })

  expect(confirmIntent).toHaveBeenCalledWith(intent)
  expect(abortSaveDocumentAs).toHaveBeenCalledWith(intent.intentId)
  expect(commitSaveDocumentAs).not.toHaveBeenCalled()
  expect(result.current.state.relativePath).toBeNull()
  expect(result.current.state.error).toBeNull()
})

it('aborts a begun Save As when its document lifetime changes before confirmation', async () => {
  const confirmation = deferred<boolean>()
  const intent = saveAsIntent(true)
  const commitSaveDocumentAs = vi.fn()
  const abortSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = createApi({
    beginSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: intent })),
    commitSaveDocumentAs,
    abortSaveDocumentAs,
  })
  const hook = renderHook(() => useDocumentSession(
    undefined, undefined, undefined, undefined, () => confirmation.promise,
  ))
  act(() => hook.result.current.change('A'))
  let saveAs!: ReturnType<typeof hook.result.current.saveAs>
  act(() => { saveAs = hook.result.current.saveAs() })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })

  act(() => hook.result.current.adopt(documentSnapshot('b.md', 'B', REVISION_C)))
  await act(async () => {
    confirmation.resolve(true)
    await expect(saveAs).resolves.toBeNull()
  })

  expect(abortSaveDocumentAs).toHaveBeenCalledWith(intent.intentId)
  expect(commitSaveDocumentAs).not.toHaveBeenCalled()
  expect(hook.result.current.state).toMatchObject({ relativePath: 'b.md', markdown: 'B' })
})

it('aborts a begun Save As when its markdown changes before confirmation', async () => {
  const confirmation = deferred<boolean>()
  const intent = saveAsIntent(true)
  const commitSaveDocumentAs = vi.fn()
  const abortSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = createApi({
    beginSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: intent })),
    commitSaveDocumentAs,
    abortSaveDocumentAs,
  })
  const hook = renderHook(() => useDocumentSession(
    undefined, undefined, undefined, undefined, () => confirmation.promise,
  ))
  act(() => hook.result.current.change('before'))
  let saveAs!: ReturnType<typeof hook.result.current.saveAs>
  act(() => { saveAs = hook.result.current.saveAs() })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })

  act(() => hook.result.current.change('after'))
  await act(async () => {
    confirmation.resolve(true)
    await expect(saveAs).resolves.toBeNull()
  })

  expect(abortSaveDocumentAs).toHaveBeenCalledWith(intent.intentId)
  expect(commitSaveDocumentAs).not.toHaveBeenCalled()
  expect(hook.result.current.state).toMatchObject({ markdown: 'after', relativePath: null })
})

it('best-effort aborts a begun Save As when the hook unmounts during confirmation', async () => {
  const confirmation = deferred<boolean>()
  const intent = saveAsIntent(true)
  const abortSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = createApi({
    beginSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: intent })),
    commitSaveDocumentAs: vi.fn(),
    abortSaveDocumentAs,
  })
  const hook = renderHook(() => useDocumentSession(
    undefined, undefined, undefined, undefined, () => confirmation.promise,
  ))
  act(() => hook.result.current.change('# Draft'))
  act(() => { void hook.result.current.saveAs() })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })

  hook.unmount()
  await act(async () => { await Promise.resolve() })

  expect(abortSaveDocumentAs).toHaveBeenCalledWith(intent.intentId)
})

it('coalesces concurrent Save As requests into one begin and one commit flight', async () => {
  const pendingBegin = deferred<ApiResult<BeginSaveDocumentAsResult | null>>()
  const beginSaveDocumentAs = vi.fn(() => pendingBegin.promise)
  const commitSaveDocumentAs = vi.fn(async () => ({
    ok: true as const,
    value: committedSaveAs('# Draft'),
  }))
  window.arkdown = createApi({
    beginSaveDocumentAs,
    commitSaveDocumentAs,
    abortSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: null })),
  })
  const { result } = renderHook(() => useDocumentSession())
  act(() => result.current.change('# Draft'))
  let first!: ReturnType<typeof result.current.saveAs>
  let second!: ReturnType<typeof result.current.saveAs>
  act(() => {
    first = result.current.saveAs()
    second = result.current.saveAs()
  })

  await act(async () => {
    pendingBegin.resolve({ ok: true, value: saveAsIntent() })
    await expect(Promise.all([first, second])).resolves.toEqual([
      committedSaveAs('# Draft'), committedSaveAs('# Draft'),
    ])
  })

  expect(beginSaveDocumentAs).toHaveBeenCalledOnce()
  expect(commitSaveDocumentAs).toHaveBeenCalledOnce()
})

it.each(['error-result', 'reject'] as const)(
  'aborts after commit %s without applying saved-as state or callbacks',
  async (failure) => {
    const intent = saveAsIntent()
    const commitSaveDocumentAs = failure === 'error-result'
      ? vi.fn(async () => ({
        ok: false as const,
        error: { code: 'OPERATION_FAILED' as const, message: 'commit failed' },
      }))
      : vi.fn().mockRejectedValue(new Error('commit rejected'))
    const abortSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: null }))
    const onSavedAs = vi.fn()
    const onSaved = vi.fn()
    window.arkdown = createApi({
      beginSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: intent })),
      commitSaveDocumentAs,
      abortSaveDocumentAs,
    })
    const { result } = renderHook(() => useDocumentSession(undefined, onSavedAs, onSaved))
    act(() => result.current.change('# Draft'))

    await act(async () => {
      await expect(result.current.saveAs()).resolves.toBeNull()
    })

    expect(abortSaveDocumentAs).toHaveBeenCalledWith(intent.intentId)
    expect(result.current.state.relativePath).toBeNull()
    expect(result.current.state.markdown).toBe('# Draft')
    expect(result.current.state.error).toBe(failure === 'error-result'
      ? 'commit failed'
      : 'commit rejected')
    expect(onSavedAs).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
  },
)

it('opens Save As instead of saving the original on Ctrl+Shift+S', async () => {
  const saveDocument = vi.fn(async () => ({
    ok: true as const,
    value: { revision: REVISION_B, mtimeMs: 2 },
  }))
  const beginSaveDocumentAs = vi.fn(async () => ({
    ok: true as const,
    value: null,
  }))
  window.arkdown = createApi({
    saveDocument,
    beginSaveDocumentAs,
    commitSaveDocumentAs: vi.fn(),
    abortSaveDocumentAs: vi.fn(),
  })
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result)
  const event = new KeyboardEvent('keydown', {
    key: 's',
    ctrlKey: true,
    shiftKey: true,
    cancelable: true,
  })

  await act(async () => {
    window.dispatchEvent(event)
    await Promise.resolve()
    await Promise.resolve()
  })

  expect(event.defaultPrevented).toBe(true)
  expect(beginSaveDocumentAs).toHaveBeenCalledTimes(1)
  expect(saveDocument).not.toHaveBeenCalled()
})

it('passes an edited unsaved name to the native save dialog', async () => {
  const beginSaveDocumentAs = vi.fn(async () => ({
    ok: true as const,
    value: null,
  }))
  window.arkdown = createApi({
    beginSaveDocumentAs,
    commitSaveDocumentAs: vi.fn(),
    abortSaveDocumentAs: vi.fn(),
  })
  const { result } = renderHook(() => useDocumentSession())

  act(() => {
    result.current.setDisplayName('计划.md')
    result.current.change('# Unsaved Markdown')
  })

  await act(async () => {
    await result.current.save()
  })

  expect(beginSaveDocumentAs).toHaveBeenCalledWith(expect.objectContaining({
    suggestedFileName: '计划.md',
  }))
})

it('keeps imported-DOCX persistence after its display name changes to Markdown', async () => {
  const businessConfirm = vi.fn(async (): Promise<'confirm'> => 'confirm')
  const exportDocx = vi.fn(async () => ({
    ok: true as const,
    value: { fileName: '计划.docx', reusedTarget: false },
  }))
  window.arkdown = createApi({ businessConfirm, exportDocx })
  const { result } = renderHook(() => useDocumentSession())

  act(() => {
    result.current.adoptImportedDocx({
      sourceAbsolutePath: 'C:/notes/report.docx',
      sourceFileName: 'report.docx',
      markdown: '# Imported',
    })
  })
  act(() => {
    result.current.setDisplayName('计划.md')
    result.current.change('# Edited')
  })

  await act(async () => {
    await expect(result.current.save()).resolves.toBe(true)
  })

  expect(businessConfirm).toHaveBeenCalledOnce()
  expect(exportDocx).toHaveBeenCalledWith(expect.objectContaining({
    markdown: '# Edited',
    mode: 'choose',
    suggestedBaseName: '计划.md',
  }))
})

it('drains an in-flight draft flush before saving the original document', async () => {
  const firstDraft = deferred<Awaited<ReturnType<NonNullable<ArkdownApi['saveDraft']>>>>()
  const draftResult = (draftId: string) => ({
    ok: true as const,
    value: {
      draftId,
      originalAbsolutePath: 'C:/notes/note.md',
      workspaceAbsolutePath: 'C:/notes',
      originalRevision: REVISION_A,
      originalMtimeMs: 1,
      encoding: 'utf8-bom' as const,
      newline: 'crlf' as const,
      updatedAt: '2026-07-26T00:00:00.000Z',
      ignoredAt: null,
    },
  })
  const saveDraft = vi.fn()
    .mockImplementationOnce(() => firstDraft.promise)
    .mockImplementation(async (input) => draftResult(input.draftId))
  const saveDocument = vi.fn(async () => ({
    ok: true as const,
    value: { revision: REVISION_B, mtimeMs: 2 },
  }))
  window.arkdown = createApi({ saveDraft, saveDocument })
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result)

  let autosaving!: Promise<boolean>
  act(() => {
    autosaving = result.current.backupDraft()
  })
  expect(saveDraft).toHaveBeenCalledTimes(1)
  act(() => result.current.change('three'))

  let saving!: Promise<boolean>
  act(() => {
    saving = result.current.save()
  })

  expect(saveDocument).not.toHaveBeenCalled()
  firstDraft.resolve(draftResult(saveDraft.mock.calls[0]![0].draftId))
  await act(async () => {
    await expect(autosaving).resolves.toBe(true)
    await expect(saving).resolves.toBe(true)
  })

  expect(saveDraft).toHaveBeenCalledTimes(2)
  expect(saveDocument).toHaveBeenCalledTimes(1)
  expect(saveDocument).toHaveBeenCalledWith(expect.objectContaining({
    markdown: 'three',
  }))
  expect(result.current.state.status).toBe('ready')
  expect(result.current.dirty).toBe(false)
})

it('reverts discarded edits and does not prompt again when close preparation retries', async () => {
  const businessConfirm = vi.fn(async (): Promise<'discard'> => 'discard')
  window.arkdown = createApi({ businessConfirm })
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result, 'discard me')
  const transition = vi.fn(async () => undefined)

  await act(async () => {
    await expect(result.current.transitionAfterSave(transition)).resolves.toBe(true)
  })

  expect(result.current.state.markdown).toBe('one')
  expect(result.current.dirty).toBe(false)
  expect(businessConfirm).toHaveBeenCalledTimes(1)

  await act(async () => {
    await expect(result.current.transitionAfterSave(transition)).resolves.toBe(true)
  })

  expect(businessConfirm).toHaveBeenCalledTimes(1)
  expect(transition).toHaveBeenCalledTimes(2)
})

it('preserves content and prevents closing when the draft terminal commit fails', async () => {
  const businessConfirm = vi.fn(async (): Promise<'discard'> => 'discard')
  const discardDraft = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'INVALID_INPUT', message: '请求参数无效' },
  }))
  window.arkdown = createApi({ businessConfirm, discardDraft })
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result, 'discard me')

  await act(async () => {
    await expect(result.current.transitionAfterSave(async () => undefined))
      .resolves.toBe(false)
  })

  expect(discardDraft).toHaveBeenCalledTimes(1)
  expect(result.current.state.markdown).toBe('discard me')
  expect(result.current.dirty).toBe(true)
})

it('keeps the owned draft identity when cleanup fails after saving the original', async () => {
  const saveDraft = vi.fn(async (input) => ({
    ok: true as const,
    value: {
      draftId: input.draftId,
      originalAbsolutePath: 'C:/notes/note.md',
      workspaceAbsolutePath: 'C:/notes',
      originalRevision: input.expectedOriginalRevision,
      originalMtimeMs: 1,
      encoding: input.encoding,
      newline: input.newline,
      updatedAt: '2026-07-26T00:00:00.000Z',
      ignoredAt: null,
    },
  }))
  const discardDraft = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'INVALID_INPUT', message: '请求参数无效' },
  }))
  window.arkdown = createApi({ saveDraft, discardDraft })
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result, 'two')

  await act(async () => {
    await expect(result.current.save()).resolves.toBe(false)
  })
  const ownedDraftId = saveDraft.mock.calls[0]![0].draftId

  act(() => result.current.change('three'))
  await act(async () => {
    await expect(result.current.backupDraft(false, true)).resolves.toBe(true)
  })

  expect(saveDraft).toHaveBeenCalledTimes(2)
  expect(saveDraft).toHaveBeenNthCalledWith(2, expect.objectContaining({
    draftId: ownedDraftId,
    markdown: 'three',
    expectedOriginalRevision: REVISION_B,
  }))
})

it('keeps the committed revision and retries a failed image terminal commit before closing', async () => {
  const saveDocument = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: { revision: REVISION_B, mtimeMs: 2, draftEndPending: true } })
    .mockResolvedValueOnce({ ok: true, value: { revision: REVISION_C, mtimeMs: 3, clipboardAssetsRetained: true } })
  window.arkdown = createApi({ saveDocument })
  const hook = renderHook(() => useDocumentSession())
  await openAndChange(hook.result, 'body committed')
  await act(async () => { expect(await hook.result.current.save()).toBe(false) })
  expect(hook.result.current.state).toMatchObject({ markdown: 'body committed', savedMarkdown: 'body committed', revision: REVISION_B, status: 'error' })
  await act(async () => { expect(await hook.result.current.save()).toBe(true) })
  expect(saveDocument.mock.calls[1]?.[0]).toMatchObject({ expectedRevision: REVISION_B })
  expect(hook.result.current.state.revision).toBe(REVISION_C)
})

it('prepares again before each explicit-save stability check', async () => {
  const firstSave = deferred<ApiResult<SaveDocumentResult>>()
  let pendingMarkdown: string | null = null
  const saveDocument = vi.fn()
    .mockImplementationOnce(() => firstSave.promise.then((result) => {
      pendingMarkdown = 'three'
      return result
    }))
    .mockResolvedValueOnce({
      ok: true,
      value: { revision: REVISION_C, mtimeMs: 3 },
    })
  window.arkdown = createApi({ saveDocument })
  let hookResult!: ReturnType<
    typeof renderHook<ReturnType<typeof useDocumentSession>, unknown>
  >['result']
  const prepare = vi.fn(() => {
    if (pendingMarkdown === null) return
    const markdown = pendingMarkdown
    pendingMarkdown = null
    hookResult.current.change(markdown)
  })
  const hook = renderHook(() => useDocumentSession(prepare))
  hookResult = hook.result
  await act(async () => {
    await hookResult.current.open('note.md')
  })
  pendingMarkdown = 'two'

  let saving!: Promise<boolean>
  act(() => {
    saving = hookResult.current.save()
  })
  expect(saveDocument).toHaveBeenCalledTimes(1)

  firstSave.resolve({
    ok: true,
    value: { revision: REVISION_B, mtimeMs: 2 },
  })
  await act(async () => {
    await expect(saving).resolves.toBe(true)
  })

  expect(prepare.mock.calls.length).toBeGreaterThanOrEqual(3)
  expect(saveDocument).toHaveBeenCalledTimes(2)
  expect(saveDocument).toHaveBeenNthCalledWith(2, expect.objectContaining({
    markdown: 'three',
    expectedRevision: REVISION_B,
  }))
  expect(hookResult.current.dirty).toBe(false)
})

it('serializes a manual flush behind an in-flight save and uses the new revision', async () => {
  const firstSave = deferred<ApiResult<SaveDocumentResult>>()
  const saveDocument = vi.fn()
    .mockImplementationOnce(() => firstSave.promise)
    .mockResolvedValueOnce({ ok: true, value: { revision: REVISION_C, mtimeMs: 3 } })
  window.arkdown = createApi({ saveDocument })
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result, 'two')

  let firstPromise!: Promise<boolean>
  act(() => {
    firstPromise = result.current.save()
  })
  act(() => result.current.change('three'))
  let flushPromise!: Promise<boolean>
  act(() => {
    flushPromise = result.current.save()
  })

  expect(saveDocument).toHaveBeenCalledTimes(1)
  firstSave.resolve({ ok: true, value: { revision: REVISION_B, mtimeMs: 2 } })
  await act(async () => {
    await expect(firstPromise).resolves.toBe(true)
    await expect(flushPromise).resolves.toBe(true)
  })

  expect(saveDocument).toHaveBeenCalledTimes(2)
  expect(saveDocument).toHaveBeenNthCalledWith(2, expect.objectContaining({
    markdown: 'three',
    expectedRevision: REVISION_B,
  }))
  expect(result.current.state.savedMarkdown).toBe('three')
  expect(result.current.state.revision).toBe(REVISION_C)
  expect(result.current.dirty).toBe(false)
})

it('rechecks live edits from an earlier save reaction before a stable transition', async () => {
  const firstSave = deferred<ApiResult<SaveDocumentResult>>()
  const saveDocument = vi.fn()
    .mockImplementationOnce(() => firstSave.promise)
    .mockResolvedValueOnce({
      ok: true,
      value: { revision: REVISION_C, mtimeMs: 3 },
    })
  window.arkdown = createApi({ saveDocument })
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result, 'two')
  const action = vi.fn(async () => undefined)

  let saving!: Promise<boolean>
  act(() => {
    saving = result.current.save()
  })
  const earlierReaction = saving.then(() => result.current.change('three'))
  let transitioning!: Promise<boolean>
  act(() => {
    transitioning = result.current.transitionAfterSave(action)
  })

  firstSave.resolve({
    ok: true,
    value: { revision: REVISION_B, mtimeMs: 2 },
  })
  await act(async () => {
    await earlierReaction
    await expect(transitioning).resolves.toBe(true)
  })

  expect(saveDocument).toHaveBeenCalledTimes(2)
  expect(saveDocument).toHaveBeenNthCalledWith(2, expect.objectContaining({
    markdown: 'three',
    expectedRevision: REVISION_B,
  }))
  expect(action).toHaveBeenCalledTimes(1)
  expect(result.current.dirty).toBe(false)
})

it('flushes edits made during a save before opening another document', async () => {
  const firstSave = deferred<ApiResult<SaveDocumentResult>>()
  const saveDocument = vi.fn()
    .mockImplementationOnce(() => firstSave.promise)
    .mockResolvedValueOnce({ ok: true, value: { revision: REVISION_C, mtimeMs: 3 } })
  const readDocument = vi.fn(async (relativePath: string) => ({
    ok: true as const,
    value: documentSnapshot(relativePath, relativePath === 'other.md' ? 'other' : 'one'),
  }))
  window.arkdown = createApi({ saveDocument, readDocument })
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result, 'two')
  act(() => {
    void result.current.save()
  })
  act(() => result.current.change('three'))

  let openPromise!: Promise<unknown>
  act(() => {
    openPromise = result.current.open('other.md')
  })
  firstSave.resolve({ ok: true, value: { revision: REVISION_B, mtimeMs: 2 } })
  await act(async () => {
    await openPromise
  })

  expect(saveDocument).toHaveBeenCalledTimes(2)
  expect(saveDocument).toHaveBeenNthCalledWith(2, expect.objectContaining({
    markdown: 'three',
    expectedRevision: REVISION_B,
  }))
  expect(readDocument).toHaveBeenLastCalledWith('other.md')
  expect(result.current.state.relativePath).toBe('other.md')
  expect(result.current.state.markdown).toBe('other')
})

it('coalesces concurrent saves of the same snapshot into one request', async () => {
  const pending = deferred<ApiResult<SaveDocumentResult>>()
  const saveDocument = vi.fn(() => pending.promise)
  window.arkdown = createApi({ saveDocument })
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result)

  let one!: Promise<boolean>
  let two!: Promise<boolean>
  act(() => {
    one = result.current.save()
    two = result.current.save()
  })
  expect(saveDocument).toHaveBeenCalledTimes(1)
  pending.resolve({ ok: true, value: { revision: REVISION_B, mtimeMs: 2 } })
  await act(async () => {
    await Promise.all([one, two])
  })
  expect(saveDocument).toHaveBeenCalledTimes(1)
})

describe.each([
  {
    name: 'a generic API failure',
    failure: () => Promise.resolve({
      ok: false as const,
      error: { code: 'WRITE_FAILED', message: 'disk full' },
    }),
    expectedStatus: 'error',
    expectedMessage: 'disk full',
  },
  {
    name: 'a rejected save promise',
    failure: () => Promise.reject(new Error('bridge rejected')),
    expectedStatus: 'error',
    expectedMessage: 'bridge rejected',
  },
])('$name', ({ failure, expectedStatus, expectedMessage }) => {
  it('keeps content and blocks opening another document', async () => {
    const saveDocument = vi.fn(failure)
    window.arkdown = createApi({ saveDocument })
    const { result } = renderHook(() => useDocumentSession())
    await openAndChange(result, 'mine')

    let opened!: Promise<unknown>
    await act(async () => {
      opened = result.current.open('other.md')
      await opened
    })

    expect(window.arkdown.readDocument).toHaveBeenCalledTimes(1)
    expect(result.current.state.relativePath).toBe('note.md')
    expect(result.current.state.markdown).toBe('mine')
    expect(result.current.state.status).toBe(expectedStatus)
    expect(result.current.state.error).toBe(expectedMessage)
    expect(result.current.dirty).toBe(true)
  })
})

it('keeps a conflict dirty, blocks open, and does not automatically retry it', async () => {
  const saveDocument = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'DOCUMENT_CONFLICT', message: 'changed on disk' },
  }))
  window.arkdown = createApi({ saveDocument })
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result, 'mine')

  await act(async () => {
    await result.current.open('other.md')
  })
  act(() => result.current.change('mine again'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000)
  })

  expect(window.arkdown.readDocument).toHaveBeenCalledTimes(1)
  expect(saveDocument).toHaveBeenCalledTimes(1)
  expect(result.current.state.relativePath).toBe('note.md')
  expect(result.current.state.markdown).toBe('mine again')
  expect(result.current.state.status).toBe('conflict')
  expect(result.current.dirty).toBe(true)
})

it('lets the latest read win when two opens resolve in reverse order', async () => {
  const readA = deferred<ApiResult<DocumentSnapshot>>()
  const readB = deferred<ApiResult<DocumentSnapshot>>()
  const readDocument = vi.fn((relativePath: string) => (
    relativePath === 'a.md' ? readA.promise : readB.promise
  ))
  window.arkdown = createApi({ readDocument })
  const { result } = renderHook(() => useDocumentSession())

  let openA!: Promise<unknown>
  let openB!: Promise<unknown>
  act(() => {
    openA = result.current.open('a.md')
    openB = result.current.open('b.md')
  })
  readB.resolve({ ok: true, value: documentSnapshot('b.md', 'B') })
  await act(async () => {
    await openB
  })
  readA.resolve({ ok: true, value: documentSnapshot('a.md', 'A') })
  await act(async () => {
    await openA
  })

  expect(result.current.state.relativePath).toBe('b.md')
  expect(result.current.state.markdown).toBe('B')
  expect(result.current.state.error).toBeNull()
})

it('ignores an old read error after a newer document loads', async () => {
  const readA = deferred<ApiResult<DocumentSnapshot>>()
  const readB = deferred<ApiResult<DocumentSnapshot>>()
  window.arkdown = createApi({
    readDocument: vi.fn((relativePath: string) => (
      relativePath === 'a.md' ? readA.promise : readB.promise
    )),
  })
  const { result } = renderHook(() => useDocumentSession())

  let openA!: Promise<unknown>
  let openB!: Promise<unknown>
  act(() => {
    openA = result.current.open('a.md')
    openB = result.current.open('b.md')
  })
  readB.resolve({ ok: true, value: documentSnapshot('b.md', 'B') })
  await act(async () => {
    await openB
  })
  readA.resolve({ ok: false, error: { code: 'READ_FAILED', message: 'old failure' } })
  await act(async () => {
    await openA
  })

  expect(result.current.state.relativePath).toBe('b.md')
  expect(result.current.state.markdown).toBe('B')
  expect(result.current.state.error).toBeNull()
})

it('preserves the current session when reading a target fails', async () => {
  const readDocument = vi.fn(async (relativePath: string) => relativePath === 'note.md'
    ? { ok: true as const, value: documentSnapshot('note.md', 'current') }
    : { ok: false as const, error: { code: 'READ_FAILED', message: 'cannot read target' } })
  window.arkdown = createApi({ readDocument })
  const { result } = renderHook(() => useDocumentSession())
  await act(async () => {
    await result.current.open('note.md')
    await result.current.open('missing.md')
  })

  expect(result.current.state.relativePath).toBe('note.md')
  expect(result.current.state.markdown).toBe('current')
  expect(result.current.state.error).toBe('cannot read target')
})

it('does not update after unmount when a pending read settles', async () => {
  const pendingRead = deferred<ApiResult<DocumentSnapshot>>()
  window.arkdown = createApi({ readDocument: vi.fn(() => pendingRead.promise) })
  const { result, unmount } = renderHook(() => useDocumentSession())
  let opening!: ReturnType<typeof result.current.open>
  act(() => {
    opening = result.current.open('note.md')
  })
  const stateAtUnmount = result.current.state
  unmount()
  pendingRead.resolve({ ok: true, value: documentSnapshot() })
  await opening

  expect(result.current.state).toBe(stateAtUnmount)
})

it('returns reasoned document-open outcomes without rereading the active document', async () => {
  const readDocument = vi.fn(async (relativePath: string) => relativePath === 'missing.md'
    ? { ok: false as const, error: { code: 'FILE_NOT_FOUND', message: 'gone' } }
    : relativePath === 'failed.md'
      ? { ok: false as const, error: { code: 'READ_FAILED', message: 'cannot read' } }
      : { ok: true as const, value: documentSnapshot(relativePath) })
  window.arkdown = createApi({ readDocument })
  const { result } = renderHook(() => useDocumentSession())

  let opened
  let repeated
  let missing
  let failed
  await act(async () => {
    opened = await result.current.open('note.md')
    repeated = await result.current.open('note.md')
    missing = await result.current.open('missing.md')
    failed = await result.current.open('failed.md')
  })

  expect(opened).toEqual({ status: 'opened' })
  expect(repeated).toEqual({ status: 'opened' })
  expect(missing).toEqual({ status: 'missing' })
  expect(failed).toEqual({ status: 'failed', message: 'cannot read' })
  expect(readDocument).toHaveBeenCalledTimes(3)
})

it('settles every guarded cancellation and save failure with a distinct open result', async () => {
  const businessConfirm = vi.fn()
    .mockResolvedValueOnce('cancel')
    .mockResolvedValueOnce('confirm')
    .mockResolvedValueOnce('confirm')
  const beginSaveDocumentAs = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: null })
    .mockResolvedValueOnce({ ok: false, error: { code: 'WRITE_FAILED', message: 'save failed' } })
  window.arkdown = createApi({
    businessConfirm,
    beginSaveDocumentAs,
    commitSaveDocumentAs: vi.fn(),
    abortSaveDocumentAs: vi.fn(),
  })
  const { result } = renderHook(() => useDocumentSession())
  act(() => result.current.change('draft'))

  let cancelled
  let saveAsCancelled
  let saveFailed
  await act(async () => {
    cancelled = await result.current.open('a.md')
    saveAsCancelled = await result.current.open('b.md')
    saveFailed = await result.current.open('c.md')
  })

  expect(cancelled).toEqual({ status: 'cancelled' })
  expect(saveAsCancelled).toEqual({ status: 'cancelled' })
  expect(saveFailed).toEqual({ status: 'failed', message: 'save failed' })
  expect(window.arkdown.readDocument).not.toHaveBeenCalled()
})

it('turns a rejected dirty guard into a failed open result without reading', async () => {
  window.arkdown = createApi({
    businessConfirm: vi.fn().mockRejectedValue(new Error('guard unavailable')),
  })
  const { result } = renderHook(() => useDocumentSession())
  act(() => result.current.change('dirty'))

  await act(async () => {
    await expect(result.current.open('target.md')).resolves.toEqual({
      status: 'failed',
      message: 'guard unavailable',
    })
  })
  expect(window.arkdown.readDocument).not.toHaveBeenCalled()
})

it('returns opened only to the latest reverse-settling request and cancelled after unmount', async () => {
  const readA = deferred<ApiResult<DocumentSnapshot>>()
  const readB = deferred<ApiResult<DocumentSnapshot>>()
  window.arkdown = createApi({
    readDocument: vi.fn((path: string) => path === 'a.md' ? readA.promise : readB.promise),
  })
  const hook = renderHook(() => useDocumentSession())
  let openA!: ReturnType<typeof hook.result.current.open>
  let openB!: ReturnType<typeof hook.result.current.open>
  act(() => {
    openA = hook.result.current.open('a.md')
    openB = hook.result.current.open('b.md')
  })
  readB.resolve({ ok: true, value: documentSnapshot('b.md') })
  await act(async () => expect(openB).resolves.toEqual({ status: 'opened' }))
  readA.resolve({ ok: true, value: documentSnapshot('a.md') })
  await act(async () => expect(openA).resolves.toEqual({ status: 'cancelled' }))

  const pending = deferred<ApiResult<DocumentSnapshot>>()
  window.arkdown = createApi({ readDocument: vi.fn(() => pending.promise) })
  const unmounted = renderHook(() => useDocumentSession())
  let opening!: ReturnType<typeof unmounted.result.current.open>
  act(() => { opening = unmounted.result.current.open('late.md') })
  unmounted.unmount()
  pending.resolve({ ok: true, value: documentSnapshot('late.md') })
  await expect(opening).resolves.toEqual({ status: 'cancelled' })
})

it('invalidates an older pending read when the active document is opened again', async () => {
  const pending = deferred<ApiResult<DocumentSnapshot>>()
  const readDocument = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: documentSnapshot('note.md', 'current') })
    .mockImplementationOnce(() => pending.promise)
  window.arkdown = createApi({ readDocument })
  const { result } = renderHook(() => useDocumentSession())
  await act(async () => { await result.current.open('note.md') })
  let oldOpen!: ReturnType<typeof result.current.open>
  act(() => { oldOpen = result.current.open('old.md') })

  await act(async () => {
    await expect(result.current.open('note.md')).resolves.toEqual({ status: 'opened' })
  })
  pending.resolve({ ok: true, value: documentSnapshot('old.md', 'stale') })
  await act(async () => expect(oldOpen).resolves.toEqual({ status: 'cancelled' }))
  expect(result.current.state.relativePath).toBe('note.md')
  expect(result.current.state.markdown).toBe('current')
})

it('does not leak a prior save failure into a later explicit cancellation', async () => {
  const businessConfirm = vi.fn()
    .mockResolvedValueOnce('confirm')
    .mockResolvedValueOnce('cancel')
  window.arkdown = createApi({
    businessConfirm,
    beginSaveDocumentAs: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'WRITE_FAILED', message: 'old save failure' },
    })),
    commitSaveDocumentAs: vi.fn(),
    abortSaveDocumentAs: vi.fn(),
  })
  const { result } = renderHook(() => useDocumentSession())
  act(() => result.current.change('dirty'))
  await act(async () => expect(result.current.open('first.md')).resolves.toEqual({
    status: 'failed', message: 'old save failure',
  }))
  await act(async () => expect(result.current.open('second.md')).resolves.toEqual({
    status: 'cancelled',
  }))
})

it('keeps failed confirm bridges and cancelled conflict resolution from opening another document', async () => {
  const businessConfirm = vi.fn().mockRejectedValue(new Error('confirm unavailable'))
  window.arkdown = createApi({ businessConfirm })
  const hook = renderHook(() => useDocumentSession())
  act(() => hook.result.current.change('dirty'))
  await act(async () => expect(hook.result.current.open('target.md')).resolves.toEqual({
    status: 'failed', message: 'confirm unavailable',
  }))
  expect(window.arkdown.readDocument).not.toHaveBeenCalled()

  window.arkdown = createApi({
    saveDocument: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'DOCUMENT_CONFLICT', message: 'conflict first' },
    })),
  })
  const conflicted = renderHook(() => useDocumentSession())
  await openAndChange(conflicted.result)
  await act(async () => { await conflicted.result.current.save() })
  await act(async () => expect(conflicted.result.current.open('other.md')).resolves.toEqual({
    status: 'cancelled',
  }))
  expect(conflicted.result.current.state.status).toBe('conflict')
  expect(window.arkdown.readDocument).toHaveBeenCalledTimes(1)
})

it('publishes a successful save revision synchronously before loading the target', async () => {
  const events: string[] = []
  const onSaved = vi.fn((snapshot: { relativePath: string | null; revision: string | null }) => {
    events.push(`saved:${snapshot.relativePath}:${snapshot.revision}`)
  })
  const readDocument = vi.fn(async (path: string) => {
    events.push(`read:${path}`)
    return { ok: true as const, value: documentSnapshot(path, 'target', REVISION_C) }
  })
  window.arkdown = createApi({ readDocument })
  const { result } = renderHook(() => useDocumentSession(undefined, undefined, onSaved))
  await act(async () => { await result.current.open('note.md') })
  events.length = 0
  act(() => result.current.change('changed'))
  await act(async () => {
    await expect(result.current.open('other.md')).resolves.toEqual({ status: 'opened' })
  })
  expect(events[0]).toBe(`saved:note.md:${REVISION_B}`)
  expect(events[1]).toBe('read:other.md')
})

it('cleans up autosave timers and the Ctrl+S listener on unmount', async () => {
  const saveDocument = vi.fn(async () => ({
    ok: true as const,
    value: { revision: REVISION_B, mtimeMs: 2 },
  }))
  window.arkdown = createApi({ saveDocument })
  const { result, unmount } = renderHook(() => useDocumentSession())
  await openAndChange(result)
  unmount()

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
  await vi.advanceTimersByTimeAsync(1_000)

  expect(saveDocument).not.toHaveBeenCalled()
})

it('settles a rejected pending save after unmount without updating state', async () => {
  const pendingSave = deferred<ApiResult<SaveDocumentResult>>()
  window.arkdown = createApi({ saveDocument: vi.fn(() => pendingSave.promise) })
  const { result, unmount } = renderHook(() => useDocumentSession())
  await openAndChange(result)
  let saving!: Promise<boolean>
  act(() => {
    saving = result.current.save()
  })
  const stateAtUnmount = result.current.state
  unmount()
  pendingSave.reject(new Error('late rejection'))

  await expect(saving).resolves.toBe(false)
  expect(result.current.state).toBe(stateAtUnmount)
})

it('does not let a clean no-op save flight swallow a same-stack edited save', async () => {
  const saveDocument = vi.fn(async () => ({
    ok: true as const,
    value: { revision: REVISION_B, mtimeMs: 2 },
  }))
  window.arkdown = createApi({ saveDocument })
  const { result } = renderHook(() => useDocumentSession())
  await act(async () => {
    await result.current.open('note.md')
  })

  let first!: Promise<boolean>
  let second!: Promise<boolean>
  act(() => {
    first = result.current.save()
    result.current.change('two')
    second = result.current.save()
  })
  await act(async () => {
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
  })

  expect(saveDocument).toHaveBeenCalledTimes(1)
  expect(saveDocument).toHaveBeenCalledWith({
    relativePath: 'note.md',
    markdown: 'two',
    expectedRevision: REVISION_A,
    encoding: 'utf8-bom',
    newline: 'crlf',
  })
  expect(result.current.dirty).toBe(false)
})

it('blocks open when a conflict is edited back to the saved Markdown', async () => {
  const saveDocument = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'DOCUMENT_CONFLICT', message: 'changed on disk' },
  }))
  window.arkdown = createApi({ saveDocument })
  const { result } = renderHook(() => useDocumentSession())
  await openAndChange(result, 'mine')
  await act(async () => {
    await result.current.save()
  })
  act(() => result.current.change('one'))

  await act(async () => {
    await result.current.open('other.md')
  })

  expect(window.arkdown.readDocument).toHaveBeenCalledTimes(1)
  expect(result.current.state.relativePath).toBe('note.md')
  expect(result.current.state.markdown).toBe('one')
  expect(result.current.state.status).toBe('conflict')
  expect(result.current.dirty).toBe(false)
})

it('turns a save-worker processing exception into an error and permits retry', async () => {
  const malformedResult = Object.defineProperty({}, 'ok', {
    get() {
      throw new Error('malformed save result')
    },
  }) as ApiResult<SaveDocumentResult>
  const saveDocument = vi.fn()
    .mockResolvedValueOnce(malformedResult)
    .mockResolvedValueOnce({
      ok: true,
      value: { revision: REVISION_B, mtimeMs: 2 },
    })
  window.arkdown = createApi({ saveDocument })
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)

  try {
    const { result } = renderHook(() => useDocumentSession())
    await openAndChange(result, 'two')

    await act(async () => {
      await expect(result.current.save()).resolves.toBe(false)
    })
    expect(result.current.state.status).toBe('error')
    expect(result.current.state.error).toBe('malformed save result')
    expect(result.current.state.markdown).toBe('two')
    expect(result.current.dirty).toBe(true)

    await act(async () => {
      await expect(result.current.save()).resolves.toBe(true)
      await Promise.resolve()
    })
    expect(saveDocument).toHaveBeenCalledTimes(2)
    expect(result.current.state.revision).toBe(REVISION_B)
    expect(result.current.dirty).toBe(false)
    expect(unhandled).not.toHaveBeenCalled()
  } finally {
    process.off('unhandledRejection', unhandled)
  }
})

it('preserves the current session when readDocument rejects', async () => {
  const readDocument = vi.fn()
    .mockResolvedValueOnce({
      ok: true,
      value: documentSnapshot('note.md', 'current'),
    })
    .mockRejectedValueOnce(new Error('read bridge rejected'))
  window.arkdown = createApi({ readDocument })
  const { result } = renderHook(() => useDocumentSession())
  await act(async () => {
    await result.current.open('note.md')
    await result.current.open('other.md')
  })

  expect(result.current.state.relativePath).toBe('note.md')
  expect(result.current.state.markdown).toBe('current')
  expect(result.current.state.status).toBe('error')
  expect(result.current.state.error).toBe('read bridge rejected')
})

it('does not load a read result when the current session enters conflict while its read is pending', async () => {
  const pendingRead = deferred<ApiResult<DocumentSnapshot>>()
  const readDocument = vi.fn()
    .mockResolvedValueOnce({
      ok: true,
      value: documentSnapshot('note.md', 'one'),
    })
    .mockImplementationOnce(() => pendingRead.promise)
  const saveDocument = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'DOCUMENT_CONFLICT', message: 'changed on disk' },
  }))
  window.arkdown = createApi({ readDocument, saveDocument })
  const { result } = renderHook(() => useDocumentSession())
  await act(async () => {
    await result.current.open('note.md')
  })

  let opening!: ReturnType<typeof result.current.open>
  act(() => {
    opening = result.current.open('other.md')
  })
  act(() => result.current.change('mine'))
  await act(async () => {
    await result.current.save()
  })
  act(() => result.current.change('one'))
  pendingRead.resolve({
    ok: true,
    value: documentSnapshot('other.md', 'other'),
  })
  let openOutcome!: Awaited<typeof opening>
  await act(async () => {
    openOutcome = await opening
  })

  expect(readDocument).toHaveBeenCalledTimes(2)
  expect(openOutcome).toEqual({ status: 'failed', message: 'changed on disk' })
  expect(result.current.state.relativePath).toBe('note.md')
  expect(result.current.state.markdown).toBe('one')
  expect(result.current.state.status).toBe('conflict')
})

it('classifies cancel, failed confirm, and Save As cancel in the second dirty guard', async () => {
  for (const scenario of [
    {
      name: 'cancel',
      confirm: 'cancel' as const,
      expected: { status: 'cancelled' as const },
      savedFirst: true,
    },
    {
      name: 'failed confirm',
      confirm: null,
      expected: { status: 'failed' as const, message: 'second guard failed' },
      savedFirst: true,
    },
    {
      name: 'Save As cancel',
      confirm: 'confirm' as const,
      expected: { status: 'cancelled' as const },
      savedFirst: false,
    },
  ]) {
    const pendingRead = deferred<ApiResult<DocumentSnapshot>>()
    const readDocument = vi.fn()
    if (scenario.savedFirst) {
      readDocument
        .mockResolvedValueOnce({ ok: true, value: documentSnapshot('note.md', 'one') })
        .mockImplementationOnce(() => pendingRead.promise)
    } else {
      readDocument.mockImplementationOnce(() => pendingRead.promise)
    }
    window.arkdown = createApi({
      readDocument,
      businessConfirm: scenario.confirm === null
        ? vi.fn().mockRejectedValue(new Error('second guard failed'))
        : vi.fn(async () => scenario.confirm),
      beginSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: null })),
    })
    const hook = renderHook(() => useDocumentSession())
    if (scenario.savedFirst) {
      await act(async () => { await hook.result.current.open('note.md') })
    }
    let opening!: ReturnType<typeof hook.result.current.open>
    act(() => { opening = hook.result.current.open('other.md') })
    act(() => hook.result.current.change(`dirty-${scenario.name}`))
    pendingRead.resolve({ ok: true, value: documentSnapshot('other.md', 'other') })
    await act(async () => expect(opening).resolves.toEqual(scenario.expected))
    expect(hook.result.current.state.markdown).toBe(`dirty-${scenario.name}`)
    expect(hook.result.current.state.relativePath).toBe(scenario.savedFirst ? 'note.md' : null)
    hook.unmount()
  }
})

it.each([
  ['discard', 'discard' as const],
  ['save', 'confirm' as const],
  ['failed confirm', new Error('late failure')],
])('cancels a superseded first guard before %s effects', async (_name, decision) => {
    const confirmation = deferred<Awaited<ReturnType<BusinessConfirm>>>()
    const discardDraft = vi.fn(async () => ({ ok: true as const, value: null }))
    const saveDocument = vi.fn(async () => ({ ok: true as const, value: { revision: REVISION_B, mtimeMs: 2 } }))
    window.arkdown = createApi({ businessConfirm: vi.fn(() => confirmation.promise), discardDraft, saveDocument })
    const hook = renderHook(() => useDocumentSession())
    await act(async () => { await hook.result.current.open('note.md') })
    act(() => hook.result.current.change('dirty'))
    let stale!: ReturnType<typeof hook.result.current.open>
    act(() => { stale = hook.result.current.open('other.md') })
    await vi.advanceTimersByTimeAsync(0)
    expect(latestBusinessConfirm).toHaveBeenCalledOnce()
    expect(hook.result.current.state.relativePath).toBe('note.md')
    await expect(hook.result.current.open('note.md')).resolves.toEqual({ status: 'opened' })
    if (decision instanceof Error) confirmation.reject(decision)
    else confirmation.resolve(decision)
    await expect(stale).resolves.toEqual({ status: 'cancelled' })
    expect(discardDraft).not.toHaveBeenCalled()
    expect(saveDocument).not.toHaveBeenCalled()
    expect(hook.result.current.state.markdown).toBe('dirty')
  hook.unmount()
})

it.each(['ok', 'error', 'reject'] as const)(
  'lets a same-lifetime shared first-guard saveDraft %s settlement land once',
  async (settlement) => {
    const pendingDraft = deferred<Awaited<ReturnType<NonNullable<ArkdownApi['saveDraft']>>>>()
    window.arkdown = createApi({ saveDraft: vi.fn(() => pendingDraft.promise) })
    const hook = renderHook(() => useDocumentSession())
    await act(async () => { await hook.result.current.open('note.md') })
    act(() => hook.result.current.change('dirty'))
    let stale!: ReturnType<typeof hook.result.current.open>
    act(() => { stale = hook.result.current.open('other.md') })
    await vi.advanceTimersByTimeAsync(0)
    await expect(hook.result.current.open('note.md')).resolves.toEqual({ status: 'opened' })
    await act(async () => {
      if (settlement === 'reject') pendingDraft.reject(new Error('late draft rejection'))
      else pendingDraft.resolve(settlement === 'ok'
        ? { ok: true, value: {
          draftId: 'draft-id', originalAbsolutePath: 'C:/notes/note.md',
          workspaceAbsolutePath: 'C:/notes', originalRevision: REVISION_A,
          originalMtimeMs: 1, encoding: 'utf8-bom', newline: 'crlf',
          updatedAt: '2026-07-24T00:00:00.000Z', ignoredAt: null,
          } }
        : { ok: false, error: { code: 'OPERATION_FAILED', message: 'late draft error' } })
      await expect(stale).resolves.toEqual({ status: 'cancelled' })
    })
    expect(hook.result.current.state).toMatchObject(settlement === 'ok' ? {
      status: 'draft-saved', error: null, markdown: 'dirty', savedMarkdown: 'one',
      draftMarkdown: 'dirty', revision: REVISION_A,
    } : {
      status: 'error', error: settlement === 'error' ? 'late draft error' : 'late draft rejection',
      markdown: 'dirty', savedMarkdown: 'one', draftMarkdown: 'one', revision: REVISION_A,
    })
    expect(hook.result.current.dirty).toBe(true)
  },
)

it('shares one same-lifetime save across superseded and succeeding open guards', async () => {
  const pendingSave = deferred<ApiResult<SaveDocumentResult>>()
  const saveDocument = vi.fn(() => pendingSave.promise)
  const saveDraft = vi.fn(createApi().saveDraft!)
  const discardDraft = vi.fn(async () => ({ ok: true as const, value: null }))
  const onSaved = vi.fn()
  window.arkdown = createApi({
    saveDocument,
    saveDraft,
    discardDraft,
    businessConfirm: vi.fn(async (): Promise<'confirm'> => 'confirm'),
  })
  const hook = renderHook(() => useDocumentSession(undefined, undefined, onSaved))
  await act(async () => { await hook.result.current.open('note.md') })
  act(() => hook.result.current.change('dirty'))
  let openA!: ReturnType<typeof hook.result.current.open>
  let openB!: ReturnType<typeof hook.result.current.open>
  act(() => { openA = hook.result.current.open('a.md') })
  await vi.advanceTimersByTimeAsync(0)
  expect(saveDocument).toHaveBeenCalledOnce()
  act(() => { openB = hook.result.current.open('b.md') })
  await act(async () => {
    pendingSave.resolve({ ok: true, value: { revision: REVISION_B, mtimeMs: 2 } })
    await expect(openA).resolves.toEqual({ status: 'cancelled' })
    await expect(openB).resolves.toEqual({ status: 'opened' })
  })
  expect(saveDocument).toHaveBeenCalledOnce()
  expect(saveDraft).toHaveBeenCalledOnce()
  expect(discardDraft).toHaveBeenCalledOnce()
  expect(onSaved).toHaveBeenCalledOnce()
  expect(hook.result.current.state.relativePath).toBe('b.md')
})

it('detaches pending draft and save flights when a new document lifetime starts', async () => {
  const draftA = deferred<Awaited<ReturnType<NonNullable<ArkdownApi['saveDraft']>>>>()
  const draftB = deferred<Awaited<ReturnType<NonNullable<ArkdownApi['saveDraft']>>>>()
  const saveA = deferred<ApiResult<SaveDocumentResult>>()
  const saveB = deferred<ApiResult<SaveDocumentResult>>()
  const saveDraft = vi.fn()
    .mockImplementationOnce(() => draftA.promise)
    .mockImplementationOnce(() => draftB.promise)
  const saveDocument = vi.fn()
    .mockImplementationOnce(() => saveA.promise)
    .mockImplementationOnce(() => saveB.promise)
  window.arkdown = createApi({ saveDraft, saveDocument })
  const hook = renderHook(() => useDocumentSession())
  await act(async () => { await hook.result.current.open('a.md') })
  act(() => hook.result.current.change('A dirty'))
  let savingA!: ReturnType<typeof hook.result.current.save>
  act(() => { savingA = hook.result.current.save() })
  await vi.advanceTimersByTimeAsync(0)
  act(() => hook.result.current.adopt(documentSnapshot('b.md', 'B', REVISION_C)))
  act(() => hook.result.current.change('B dirty'))
  let savingB!: ReturnType<typeof hook.result.current.save>
  act(() => { savingB = hook.result.current.save() })
  await vi.advanceTimersByTimeAsync(0)
  expect(saveDraft).toHaveBeenCalledTimes(2)
  expect(saveDocument).toHaveBeenCalledTimes(2)
  await act(async () => {
    draftB.resolve({ ok: true, value: {
      draftId: 'b-draft', originalAbsolutePath: 'C:/notes/b.md', workspaceAbsolutePath: 'C:/notes',
      originalRevision: REVISION_C, originalMtimeMs: 1, encoding: 'utf8-bom', newline: 'crlf',
      updatedAt: '2026-07-24T00:00:00.000Z', ignoredAt: null,
    } })
    saveB.resolve({ ok: true, value: { revision: REVISION_B, mtimeMs: 2 } })
    await expect(savingB).resolves.toBe(true)
  })
  draftA.reject(new Error('late A draft'))
  saveA.resolve({ ok: false, error: { code: 'WRITE_FAILED', message: 'late A save' } })
  await expect(savingA).resolves.toBe(false)
  expect(hook.result.current.state).toMatchObject({
    relativePath: 'b.md', markdown: 'B dirty', revision: REVISION_B, status: 'ready', error: null,
  })
})

it('starts a new full save transaction while the previous draft cleanup is pending', async () => {
  const firstCleanup = deferred<ApiResult<null>>()
  const saveDocument = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: { revision: REVISION_B, mtimeMs: 2 } })
    .mockResolvedValueOnce({ ok: true, value: { revision: REVISION_C, mtimeMs: 3 } })
  const discardDraft = vi.fn()
    .mockImplementationOnce(() => firstCleanup.promise)
    .mockResolvedValueOnce({ ok: true, value: null })
  const onSaved = vi.fn()
  window.arkdown = createApi({ saveDocument, discardDraft })
  const hook = renderHook(() => useDocumentSession(undefined, undefined, onSaved))
  await act(async () => { await hook.result.current.open('note.md') })
  act(() => hook.result.current.change('old markdown'))
  let oldSave!: ReturnType<typeof hook.result.current.save>
  act(() => { oldSave = hook.result.current.save() })
  await vi.advanceTimersByTimeAsync(0)
  expect(discardDraft).toHaveBeenCalledOnce()

  act(() => hook.result.current.change('new markdown'))
  let newSave!: ReturnType<typeof hook.result.current.save>
  act(() => { newSave = hook.result.current.save() })
  await vi.advanceTimersByTimeAsync(0)

  expect(saveDocument).toHaveBeenCalledTimes(2)
  expect(saveDocument).toHaveBeenNthCalledWith(2, expect.objectContaining({
    markdown: 'new markdown', expectedRevision: REVISION_B,
  }))
  await act(async () => {
    await expect(newSave).resolves.toBe(true)
    firstCleanup.resolve({ ok: true, value: null })
    await expect(oldSave).resolves.toBe(true)
  })
  expect(discardDraft).toHaveBeenCalledTimes(2)
  expect(discardDraft.mock.calls[0]?.[0]).not.toBe(discardDraft.mock.calls[1]?.[0])
  expect(onSaved).toHaveBeenCalledTimes(2)
  expect(hook.result.current.state).toMatchObject({
    status: 'ready', markdown: 'new markdown', savedMarkdown: 'new markdown', revision: REVISION_C,
  })
  expect(hook.result.current.dirty).toBe(false)
})

it.each([
  ['adopt', 'error-result'],
  ['adopt', 'reject'],
  ['clear', 'error-result'],
  ['clear', 'reject'],
  ['recover', 'error-result'],
  ['recover', 'reject'],
] as const)(
  'keeps a %s replacement isolated from an old cleanup %s',
  async (replacement, settlement) => {
    const oldCleanup = deferred<ApiResult<null>>()
    const saveDraft = vi.fn(createApi().saveDraft!)
    window.arkdown = createApi({
      saveDraft,
      saveDocument: vi.fn(async () => ({
        ok: true as const, value: { revision: REVISION_B, mtimeMs: 2 },
      })),
      discardDraft: vi.fn(() => oldCleanup.promise),
    })
    const hook = renderHook(() => useDocumentSession())
    await act(async () => { await hook.result.current.open('a.md') })
    act(() => hook.result.current.change('A dirty'))
    let oldSave!: ReturnType<typeof hook.result.current.save>
    act(() => { oldSave = hook.result.current.save() })
    await vi.advanceTimersByTimeAsync(0)
    const oldDraftId = vi.mocked(window.arkdown.discardDraft!).mock.calls[0]?.[0]

    act(() => {
      if (replacement === 'adopt') hook.result.current.adopt(documentSnapshot('b.md', 'B', REVISION_C))
      else if (replacement === 'clear') hook.result.current.clear()
      else hook.result.current.recover('recovery-draft', 'Recovered', documentSnapshot('b.md', 'B', REVISION_C), false)
    })
    await act(async () => {
      if (settlement === 'reject') oldCleanup.reject(new Error('old cleanup rejected'))
      else oldCleanup.resolve({
        ok: false, error: { code: 'OPERATION_FAILED', message: 'old cleanup failed' },
      })
      await expect(oldSave).resolves.toBe(false)
    })

    expect(hook.result.current.state).toMatchObject(replacement === 'clear' ? {
      status: 'ready', error: null, relativePath: null, markdown: '',
      savedMarkdown: '', draftMarkdown: '', revision: null,
    } : replacement === 'recover' ? {
      status: 'draft-saved', error: null, relativePath: 'b.md', markdown: 'Recovered',
      savedMarkdown: 'B', draftMarkdown: 'Recovered', revision: REVISION_C,
    } : {
      status: 'ready', error: null, relativePath: 'b.md', markdown: 'B',
      savedMarkdown: 'B', draftMarkdown: 'B', revision: REVISION_C,
    })

    act(() => hook.result.current.change(`${replacement} dirty`))
    await act(async () => { await expect(hook.result.current.backupDraft()).resolves.toBe(true) })
    const replacementDraftId = saveDraft.mock.calls.at(-1)?.[0].draftId
    expect(replacementDraftId).not.toBe(oldDraftId)
    if (replacement === 'recover') expect(replacementDraftId).toBe('recovery-draft')
    expect(hook.result.current.state).toMatchObject({
      status: 'draft-saved', error: null, markdown: `${replacement} dirty`,
      relativePath: replacement === 'clear' ? null : 'b.md',
    })
  },
)

it('serializes three late saves and ignores older cleanups settled in reverse order', async () => {
  const cleanupOne = deferred<ApiResult<null>>()
  const cleanupTwo = deferred<ApiResult<null>>()
  const saveDocument = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: { revision: REVISION_B, mtimeMs: 2 } })
    .mockResolvedValueOnce({ ok: true, value: { revision: REVISION_C, mtimeMs: 3 } })
    .mockResolvedValueOnce({ ok: true, value: { revision: REVISION_D, mtimeMs: 4 } })
  const discardDraft = vi.fn()
    .mockImplementationOnce(() => cleanupOne.promise)
    .mockImplementationOnce(() => cleanupTwo.promise)
    .mockResolvedValueOnce({ ok: true, value: null })
  const onSaved = vi.fn()
  window.arkdown = createApi({ saveDocument, discardDraft })
  const hook = renderHook(() => useDocumentSession(undefined, undefined, onSaved))
  await act(async () => { await hook.result.current.open('note.md') })

  const startSave = async (markdown: string) => {
    act(() => hook.result.current.change(markdown))
    let saving!: ReturnType<typeof hook.result.current.save>
    act(() => { saving = hook.result.current.save() })
    await vi.advanceTimersByTimeAsync(0)
    return { saving }
  }
  const { saving: first } = await startSave('first late')
  const { saving: second } = await startSave('second late')
  const { saving: third } = await startSave('third late')
  await act(async () => { await expect(third).resolves.toBe(true) })
  await act(async () => {
    cleanupTwo.resolve({ ok: false, error: { code: 'OPERATION_FAILED', message: 'old two failed' } })
    cleanupOne.reject(new Error('old one rejected'))
    await expect(second).resolves.toBe(true)
    await expect(first).resolves.toBe(true)
  })

  expect(saveDocument.mock.calls.map(([input]) => input.markdown)).toEqual([
    'first late', 'second late', 'third late',
  ])
  expect(saveDocument.mock.calls.map(([input]) => input.expectedRevision)).toEqual([
    REVISION_A, REVISION_B, REVISION_C,
  ])
  expect(discardDraft).toHaveBeenCalledTimes(3)
  const cleanupDraftIds = discardDraft.mock.calls.map(([draftId]) => draftId)
  expect(cleanupDraftIds).toEqual(vi.mocked(window.arkdown.saveDraft!).mock.calls.map(([input]) => input.draftId))
  expect(new Set(cleanupDraftIds).size).toBe(3)
  expect(onSaved.mock.calls.map(([snapshot]) => ({
    relativePath: snapshot.relativePath,
    revision: snapshot.revision,
    markdown: snapshot.markdown,
  }))).toEqual([
    { relativePath: 'note.md', revision: REVISION_B, markdown: 'first late' },
    { relativePath: 'note.md', revision: REVISION_C, markdown: 'second late' },
    { relativePath: 'note.md', revision: REVISION_D, markdown: 'third late' },
  ])
  expect(hook.result.current.state).toMatchObject({
    status: 'ready', error: null, markdown: 'third late',
    savedMarkdown: 'third late', revision: REVISION_D,
  })
  expect(hook.result.current.dirty).toBe(false)
})

it('lets only the authoritative newest cleanup rejection affect the current transaction', async () => {
  const latestCleanup = deferred<ApiResult<null>>()
  window.arkdown = createApi({
    discardDraft: vi.fn(() => latestCleanup.promise),
  })
  const hook = renderHook(() => useDocumentSession())
  await act(async () => { await hook.result.current.open('note.md') })
  act(() => hook.result.current.change('persisted despite cleanup'))
  let saving!: ReturnType<typeof hook.result.current.save>
  act(() => { saving = hook.result.current.save() })
  await vi.advanceTimersByTimeAsync(0)
  await act(async () => {
    latestCleanup.reject(new Error('authoritative cleanup rejected'))
    await expect(saving).resolves.toBe(false)
  })
  expect(hook.result.current.state).toMatchObject({
    status: 'error', error: 'authoritative cleanup rejected',
    markdown: 'persisted despite cleanup', savedMarkdown: 'persisted despite cleanup',
    revision: REVISION_B,
  })
  expect(hook.result.current.dirty).toBe(false)
})

it('ignores an async Save As callback rejection after a new lifetime is adopted', async () => {
  const pendingCallback = deferred<void>()
  window.arkdown = createApi({
    beginSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: saveAsIntent() })),
    commitSaveDocumentAs: vi.fn(async () => ({
      ok: true as const,
      value: committedSaveAs('A draft'),
    })),
    abortSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: null })),
  })
  const hook = renderHook(() => useDocumentSession(undefined, async () => pendingCallback.promise))
  act(() => hook.result.current.change('A draft'))
  let saving!: ReturnType<typeof hook.result.current.saveAs>
  act(() => { saving = hook.result.current.saveAs() })
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
  act(() => hook.result.current.adopt(documentSnapshot('b.md', 'B', REVISION_C)))
  await act(async () => {
    pendingCallback.reject(new Error('late callback rejection'))
    await expect(saving).resolves.toBeNull()
  })
  expect(hook.result.current.state).toMatchObject({
    status: 'ready', error: null, relativePath: 'b.md', markdown: 'B', revision: REVISION_C,
  })
})

it('cancels a superseded second guard after its same-lifetime save lands once', async () => {
  const pendingRead = deferred<ApiResult<DocumentSnapshot>>()
  const confirmation = deferred<Awaited<ReturnType<BusinessConfirm>>>()
  const pendingSave = deferred<ApiResult<SaveDocumentResult>>()
  const onSaved = vi.fn()
  const readDocument = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: documentSnapshot('note.md', 'one') })
    .mockImplementationOnce(() => pendingRead.promise)
  window.arkdown = createApi({
    readDocument,
    businessConfirm: vi.fn(() => confirmation.promise),
    saveDocument: vi.fn(() => pendingSave.promise),
  })
  const hook = renderHook(() => useDocumentSession(undefined, undefined, onSaved))
  await act(async () => { await hook.result.current.open('note.md') })
  let stale!: ReturnType<typeof hook.result.current.open>
  act(() => { stale = hook.result.current.open('other.md') })
  act(() => hook.result.current.change('dirty'))
  pendingRead.resolve({ ok: true, value: documentSnapshot('other.md', 'other') })
  await vi.advanceTimersByTimeAsync(0)
  expect(latestBusinessConfirm).toHaveBeenCalledOnce()
  confirmation.resolve('confirm')
  await vi.advanceTimersByTimeAsync(0)
  expect(window.arkdown.saveDocument).toHaveBeenCalledOnce()
  await expect(hook.result.current.open('note.md')).resolves.toEqual({ status: 'opened' })
  await act(async () => {
    pendingSave.resolve({ ok: true, value: { revision: REVISION_B, mtimeMs: 2 } })
    await expect(stale).resolves.toEqual({ status: 'cancelled' })
  })
  expect(onSaved).toHaveBeenCalledOnce()
  expect(hook.result.current.state.revision).toBe(REVISION_B)
  expect(hook.result.current.state.markdown).toBe('dirty')
  expect(hook.result.current.state.status).toBe('ready')
  expect(hook.result.current.dirty).toBe(false)
}, 10_000)

it.each(['ok', 'error', 'reject'] as const)(
  'ignores an old document save %s settlement after adopting a new lifetime',
  async (settlement) => {
    const pendingSave = deferred<ApiResult<SaveDocumentResult>>()
    const onSaved = vi.fn()
    window.arkdown = createApi({ saveDocument: vi.fn(() => pendingSave.promise) })
    const hook = renderHook(() => useDocumentSession(undefined, undefined, onSaved))
    await act(async () => { await hook.result.current.open('a.md') })
    act(() => hook.result.current.change('A dirty'))
    let saving!: ReturnType<typeof hook.result.current.save>
    act(() => { saving = hook.result.current.save() })
    await vi.advanceTimersByTimeAsync(0)
    act(() => hook.result.current.adopt(documentSnapshot('b.md', 'B', REVISION_C)))
    await act(async () => {
      if (settlement === 'reject') pendingSave.reject(new Error('late A rejection'))
      else pendingSave.resolve(settlement === 'ok'
        ? { ok: true, value: { revision: REVISION_B, mtimeMs: 2 } }
        : { ok: false, error: { code: 'WRITE_FAILED', message: 'late A error' } })
      await expect(saving).resolves.toBe(false)
    })
    expect(onSaved).not.toHaveBeenCalled()
    expect(hook.result.current.state).toMatchObject({
      status: 'ready', error: null, relativePath: 'b.md', markdown: 'B',
      savedMarkdown: 'B', draftMarkdown: 'B', revision: REVISION_C,
    })
    expect(hook.result.current.dirty).toBe(false)
  },
)

it('settles rejected Save As, discard, and saved callbacks as failed guarded opens', async () => {
  window.arkdown = createApi({
    businessConfirm: vi.fn(async (): Promise<'confirm'> => 'confirm'),
    beginSaveDocumentAs: vi.fn().mockRejectedValue(new Error('save as rejected')),
    commitSaveDocumentAs: vi.fn(),
    abortSaveDocumentAs: vi.fn(),
  })
  const saveAsHook = renderHook(() => useDocumentSession())
  act(() => saveAsHook.result.current.change('draft'))
  await act(async () => expect(saveAsHook.result.current.open('target.md')).resolves.toEqual({
    status: 'failed', message: 'save as rejected',
  }))
  saveAsHook.unmount()

  window.arkdown = createApi({
    businessConfirm: vi.fn(async (): Promise<'discard'> => 'discard'),
    discardDraft: vi.fn().mockRejectedValue(new Error('discard rejected')),
  })
  const discardHook = renderHook(() => useDocumentSession())
  act(() => discardHook.result.current.change('draft'))
  await act(async () => expect(discardHook.result.current.open('target.md')).resolves.toEqual({
    status: 'failed', message: 'discard rejected',
  }))
  discardHook.unmount()

  window.arkdown = createApi({
    businessConfirm: vi.fn(async (): Promise<'confirm'> => 'confirm'),
    discardDraft: vi.fn().mockRejectedValue(new Error('post-save cleanup rejected')),
  })
  const cleanupHook = renderHook(() => useDocumentSession())
  await act(async () => { await cleanupHook.result.current.open('note.md') })
  act(() => cleanupHook.result.current.change('dirty'))
  await act(async () => expect(cleanupHook.result.current.open('target.md')).resolves.toEqual({
    status: 'failed', message: 'post-save cleanup rejected',
  }))
  cleanupHook.unmount()

  window.arkdown = createApi({
    businessConfirm: vi.fn(async (): Promise<'confirm'> => 'confirm'),
    beginSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: saveAsIntent() })),
    commitSaveDocumentAs: vi.fn(async () => ({
      ok: true as const,
      value: committedSaveAs('one'),
    })),
    abortSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: null })),
  })
  const savedAsCallbackHook = renderHook(() => useDocumentSession(undefined, async () => {
    throw new Error('saved-as callback rejected')
  }))
  act(() => savedAsCallbackHook.result.current.change('draft'))
  await act(async () => expect(savedAsCallbackHook.result.current.open('target.md')).resolves.toEqual({
    status: 'failed', message: 'saved-as callback rejected',
  }))
  savedAsCallbackHook.unmount()

  window.arkdown = createApi({
    businessConfirm: vi.fn(async (): Promise<'confirm'> => 'confirm'),
  })
  const callbackHook = renderHook(() => useDocumentSession(undefined, undefined, async () => {
    throw new Error('saved callback rejected')
  }))
  await act(async () => { await callbackHook.result.current.open('note.md') })
  act(() => callbackHook.result.current.change('dirty'))
  await act(async () => expect(callbackHook.result.current.open('target.md')).resolves.toEqual({
    status: 'failed', message: 'saved callback rejected',
  }))
})


it('flushes an edit from an earlier save reaction before loading a pending read', async () => {
  const pendingRead = deferred<ApiResult<DocumentSnapshot>>()
  const firstSave = deferred<ApiResult<SaveDocumentResult>>()
  const secondSave = deferred<ApiResult<SaveDocumentResult>>()
  const readDocument = vi.fn()
    .mockResolvedValueOnce({
      ok: true,
      value: documentSnapshot('note.md', 'one'),
    })
    .mockImplementationOnce(() => pendingRead.promise)
  const saveDocument = vi.fn()
    .mockImplementationOnce(() => firstSave.promise)
    .mockImplementationOnce(() => secondSave.promise)
  window.arkdown = createApi({ readDocument, saveDocument })
  const { result } = renderHook(() => useDocumentSession())
  await act(async () => {
    await result.current.open('note.md')
  })

  let opening!: Promise<unknown>
  act(() => {
    opening = result.current.open('other.md')
  })
  act(() => result.current.change('two'))
  let saving!: Promise<boolean>
  act(() => {
    saving = result.current.save()
  })
  const earlierReaction = saving.then(() => result.current.change('three'))

  pendingRead.resolve({
    ok: true,
    value: documentSnapshot('other.md', 'other'),
  })
  await act(async () => {
    await Promise.resolve()
  })
  firstSave.resolve({
    ok: true,
    value: { revision: REVISION_B, mtimeMs: 2 },
  })
  await act(async () => {
    await earlierReaction
    await Promise.resolve()
  })

  expect(result.current.state.relativePath).toBe('note.md')
  expect(result.current.state.markdown).toBe('three')
  expect(saveDocument).toHaveBeenCalledTimes(2)
  expect(saveDocument).toHaveBeenNthCalledWith(2, expect.objectContaining({
    markdown: 'three',
    expectedRevision: REVISION_B,
  }))

  secondSave.resolve({
    ok: true,
    value: { revision: REVISION_C, mtimeMs: 3 },
  })
  await act(async () => {
    await opening
  })

  expect(result.current.state.relativePath).toBe('other.md')
  expect(result.current.state.markdown).toBe('other')
  expect(result.current.state.status).toBe('ready')
  expect(result.current.dirty).toBe(false)
})


it('returns false for an unsourced dirty draft and blocks open without losing it', async () => {
  const { result } = renderHook(() => useDocumentSession())
  act(() => result.current.change('draft'))

  let saved!: boolean
  await act(async () => {
    saved = await result.current.save()
  })

  // Guard the legacy live-lock while still exercising open after the contract is fixed.
  let opening: Promise<unknown> | null = null
  if (!saved) {
    await act(async () => {
      opening = result.current.open('note.md')
      await opening
    })
  }

  expect(saved).toBe(false)
  expect(opening).not.toBeNull()
  expect(window.arkdown.readDocument).not.toHaveBeenCalled()
  expect(result.current.state.relativePath).toBeNull()
  expect(result.current.state.markdown).toBe('draft')
  expect(result.current.dirty).toBe(true)
})

it('opens Save As for a clean untitled document and still allows a later open', async () => {
  const beginSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = createApi({
    beginSaveDocumentAs,
    commitSaveDocumentAs: vi.fn(),
    abortSaveDocumentAs: vi.fn(),
  })
  const { result } = renderHook(() => useDocumentSession())

  await act(async () => {
    await expect(result.current.save()).resolves.toBe(false)
    expect(beginSaveDocumentAs).toHaveBeenCalledTimes(1)
    await result.current.open('note.md')
  })

  expect(window.arkdown.saveDocument).not.toHaveBeenCalled()
  expect(window.arkdown.readDocument).toHaveBeenCalledTimes(1)
  expect(window.arkdown.readDocument).toHaveBeenCalledWith('note.md')
  expect(result.current.state.relativePath).toBe('note.md')
  expect(result.current.state.markdown).toBe('one')
  expect(result.current.dirty).toBe(false)
})

it('closes an untouched DOCX import without prompting or creating a draft', async () => {
  const businessConfirm = vi.fn(async (): Promise<'discard'> => 'discard')
  const importDocx = vi.fn(async () => ({
    ok: true as const,
    value: {
      sourceAbsolutePath: 'C:/notes/report.docx',
      sourceFileName: 'report.docx',
      markdown: '# Imported',
    },
  }))
  window.arkdown = createApi({ businessConfirm, importDocx })
  const { result } = renderHook(() => useDocumentSession())

  await act(async () => {
    await result.current.importDocx('report.docx')
  })
  expect(result.current.dirty).toBe(false)

  await act(async () => {
    await vi.advanceTimersByTimeAsync(6_000)
  })
  const transition = vi.fn(async () => undefined)
  await act(async () => {
    await expect(result.current.transitionAfterSave(transition)).resolves.toBe(true)
  })

  expect(window.arkdown.saveDraft).not.toHaveBeenCalled()
  expect(businessConfirm).not.toHaveBeenCalled()
  expect(transition).toHaveBeenCalledTimes(1)
})

it('keeps an edited imported DOCX dirty when its export prompt is declined', async () => {
  const dialogs = businessDialog('cancel')
  const importDocx = vi.fn(async () => ({
    ok: true as const,
    value: {
      sourceAbsolutePath: 'C:/notes/report.docx',
      sourceFileName: 'report.docx',
      markdown: '# Imported',
    },
  }))
  window.arkdown = createApi({ importDocx, exportDocx: vi.fn() })
  const { result } = renderHook(() => useDocumentSession(undefined, undefined, undefined, dialogs))
  await act(async () => {
    await result.current.importDocx('report.docx')
  })
  act(() => result.current.change('# Edited'))
  const transition = vi.fn(async () => undefined)

  await act(async () => {
    await expect(result.current.transitionAfterSave(transition)).resolves.toBe(false)
  })

  expect(dialogs.confirm).toHaveBeenCalledWith({
    title: '是否导出为新的docx文档？',
    description: 'Arkdown无法修改原docx文档。',
    confirmLabel: '导出',
    discardLabel: '不保存',
    cancelLabel: '取消',
  })
  expect(result.current.state.markdown).toBe('# Edited')
  expect(result.current.dirty).toBe(true)
  expect(transition).not.toHaveBeenCalled()
})

it('cancels DOCX save when export confirmation is declined and keeps the edit dirty', async () => {
  const businessConfirm = vi.fn(async (): Promise<'cancel'> => 'cancel')
  const exportDocx = vi.fn()
  window.arkdown = createApi({ businessConfirm, exportDocx })
  const hook = renderHook(() => useDocumentSession())
  act(() => hook.result.current.adoptImportedDocx({
    sourceAbsolutePath: 'C:/notes/report.docx',
    sourceFileName: 'report.docx',
    markdown: '# Imported',
  }))
  act(() => hook.result.current.change('# Edited'))

  await act(async () => {
    await expect(hook.result.current.save()).resolves.toBe(false)
  })

  expect(businessConfirm).toHaveBeenCalledWith({
    title: '是否导出为新的docx文档？',
    description: 'Arkdown无法修改原docx文档。',
    confirmLabel: '导出',
    cancelLabel: '取消',
    actionOrder: 'confirm-cancel',
  })
  expect(exportDocx).not.toHaveBeenCalled()
  expect(hook.result.current.dirty).toBe(true)
  expect(hook.result.current.savePresentation).toBe('dirty')
})

it('confirms every DOCX save, chooses once, then reuses only the current document lifecycle target', async () => {
  const businessConfirm = vi.fn(async (): Promise<'confirm'> => 'confirm')
  const exportDocx = vi.fn()
    .mockResolvedValueOnce({
      ok: true as const,
      value: { fileName: 'report-export.docx', reusedTarget: false },
    })
    .mockResolvedValueOnce({
      ok: true as const,
      value: { fileName: 'report-export.docx', reusedTarget: true },
    })
    .mockResolvedValueOnce({
      ok: true as const,
      value: { fileName: 'second-export.docx', reusedTarget: false },
    })
  window.arkdown = createApi({ businessConfirm, exportDocx })
  const hook = renderHook(() => useDocumentSession())
  act(() => hook.result.current.adoptImportedDocx({
    sourceAbsolutePath: 'C:/notes/report.docx',
    sourceFileName: 'report.docx',
    markdown: '# Imported',
  }))
  const firstSessionId = hook.result.current.documentExportSessionId
  act(() => hook.result.current.change('# First edit'))
  await act(async () => { await expect(hook.result.current.save()).resolves.toBe(true) })
  expect(hook.result.current.savePresentation).toBe('saved')

  act(() => hook.result.current.change('# Second edit'))
  await act(async () => { await expect(hook.result.current.saveAs()).resolves.toBeNull() })
  expect(hook.result.current.savePresentation).toBe('saved')

  expect(businessConfirm).toHaveBeenCalledTimes(2)
  expect(businessConfirm).toHaveBeenNthCalledWith(1, expect.objectContaining({
    description: 'Arkdown无法修改原docx文档。',
  }))
  expect(businessConfirm).toHaveBeenNthCalledWith(2, expect.objectContaining({
    description: 'Arkdown无法修改原docx文档。\n新的修改内容将保存到刚刚导出的文档。',
  }))
  expect(exportDocx.mock.calls.slice(0, 2).map(([input]) => input)).toEqual([
    expect.objectContaining({ documentSessionId: firstSessionId, mode: 'choose' }),
    expect.objectContaining({ documentSessionId: firstSessionId, mode: 'reuse' }),
  ])

  act(() => hook.result.current.adoptImportedDocx({
    sourceAbsolutePath: 'C:/notes/second.docx',
    sourceFileName: 'second.docx',
    markdown: '# Second',
  }))
  const secondSessionId = hook.result.current.documentExportSessionId
  expect(secondSessionId).not.toBe(firstSessionId)
  act(() => hook.result.current.change('# Second edited'))
  await act(async () => { await expect(hook.result.current.save()).resolves.toBe(true) })

  expect(exportDocx).toHaveBeenLastCalledWith(expect.objectContaining({
    documentSessionId: secondSessionId,
    mode: 'choose',
    suggestedBaseName: 'second',
  }))
})

it('does not discard a newer DOCX edit that arrives while an export is finishing', async () => {
  const pendingExport = deferred<Awaited<ReturnType<NonNullable<ArkdownApi['exportDocx']>>>>()
  const discardDraft = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = createApi({
    businessConfirm: vi.fn(async (): Promise<'confirm'> => 'confirm'),
    exportDocx: vi.fn(() => pendingExport.promise),
    discardDraft,
  })
  const hook = renderHook(() => useDocumentSession())
  act(() => hook.result.current.adoptImportedDocx({
    sourceAbsolutePath: 'C:/notes/report.docx',
    sourceFileName: 'report.docx',
    markdown: '# Imported',
  }))
  act(() => hook.result.current.change('# Exported snapshot'))
  let saving!: Promise<boolean>
  act(() => { saving = hook.result.current.save() })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(window.arkdown.exportDocx).toHaveBeenCalledOnce()
  act(() => hook.result.current.change('# Newer unsaved edit'))
  pendingExport.resolve({
    ok: true,
    value: { fileName: 'report-export.docx', reusedTarget: false },
  })

  await act(async () => { await expect(saving).resolves.toBe(true) })
  expect(hook.result.current.state).toMatchObject({
    markdown: '# Newer unsaved edit',
    savedMarkdown: '# Exported snapshot',
  })
  expect(hook.result.current.dirty).toBe(true)
  expect(discardDraft).not.toHaveBeenCalled()
})

it('keeps a newer DOCX save caller pending until its generation is exported', async () => {
  const firstExport = deferred<Awaited<ReturnType<NonNullable<ArkdownApi['exportDocx']>>>>()
  const secondExport = deferred<Awaited<ReturnType<NonNullable<ArkdownApi['exportDocx']>>>>()
  const businessConfirm = vi.fn(async (): Promise<'confirm'> => 'confirm')
  const exportDocx = vi.fn()
    .mockImplementationOnce(() => firstExport.promise)
    .mockImplementationOnce(() => secondExport.promise)
  window.arkdown = createApi({ businessConfirm, exportDocx })
  const hook = renderHook(() => useDocumentSession())
  act(() => hook.result.current.adoptImportedDocx({
    sourceAbsolutePath: 'C:/notes/report.docx',
    sourceFileName: 'report.docx',
    markdown: '# Imported',
  }))
  act(() => hook.result.current.change('# Export A'))

  let saveA!: Promise<boolean>
  act(() => { saveA = hook.result.current.save() })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(businessConfirm).toHaveBeenCalledOnce()
  expect(exportDocx).toHaveBeenCalledWith(expect.objectContaining({
    markdown: '# Export A',
    mode: 'choose',
  }))

  act(() => hook.result.current.change('# Export B'))
  let saveB!: Promise<boolean>
  let saveBOutcome: boolean | undefined
  act(() => {
    saveB = hook.result.current.save()
    void saveB.then((outcome) => { saveBOutcome = outcome })
  })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(businessConfirm).toHaveBeenCalledOnce()
  expect(exportDocx).toHaveBeenCalledOnce()
  expect(saveBOutcome).toBeUndefined()

  await act(async () => {
    firstExport.resolve({
      ok: true,
      value: { fileName: 'report-export.docx', reusedTarget: false },
    })
    await expect(saveA).resolves.toBe(true)
    await vi.advanceTimersByTimeAsync(0)
  })

  expect(saveBOutcome).toBeUndefined()
  expect(businessConfirm).toHaveBeenCalledTimes(2)
  expect(exportDocx).toHaveBeenCalledTimes(2)
  expect(exportDocx).toHaveBeenLastCalledWith(expect.objectContaining({
    markdown: '# Export B',
    mode: 'reuse',
  }))

  await act(async () => {
    secondExport.resolve({
      ok: true,
      value: { fileName: 'report-export.docx', reusedTarget: true },
    })
    await expect(saveB).resolves.toBe(true)
  })
  expect(hook.result.current.state).toMatchObject({
    markdown: '# Export B',
    savedMarkdown: '# Export B',
  })
  expect(hook.result.current.dirty).toBe(false)
})

it('keeps opening Markdown through ordinary Save and replaces it only on reload', async () => {
  const readDocument = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: documentSnapshot('note.md', 'opening') })
    .mockResolvedValueOnce({ ok: true, value: documentSnapshot('note.md', 'reloaded', REVISION_C) })
  window.arkdown = createApi({ readDocument })
  const hook = renderHook(() => useDocumentSession())

  await act(async () => { await hook.result.current.open('note.md') })
  expect(hook.result.current.state.openingMarkdown).toBe('opening')
  act(() => hook.result.current.change('saved later'))
  await act(async () => { await expect(hook.result.current.save()).resolves.toBe(true) })
  expect(hook.result.current.state).toMatchObject({
    openingMarkdown: 'opening',
    savedMarkdown: 'saved later',
    markdown: 'saved later',
  })

  await act(async () => { await expect(hook.result.current.reload()).resolves.toBe(true) })
  expect(hook.result.current.state).toMatchObject({
    openingMarkdown: 'reloaded',
    savedMarkdown: 'reloaded',
    markdown: 'reloaded',
  })
})

it('settles same-workspace Save As before publishing a preserved-opening transition', async () => {
  const savedAsDocument = documentSnapshot('saved-as.md', 'edited', REVISION_C)
  const committed = {
    ...committedSaveAs('edited'),
    document: savedAsDocument,
  }
  window.arkdown = createApi({
    beginSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: saveAsIntent() })),
    commitSaveDocumentAs: vi.fn(async () => ({
      ok: true as const,
      value: committed,
    })),
    abortSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: null })),
  })
  const events: string[] = []
  const observedTransitions: unknown[] = []
  const observedSavedStates: Array<{
    openingMarkdown: string
    savedMarkdown: string
    markdown: string
  }> = []
  const onSavedAs = vi.fn((transition: unknown) => {
    events.push('handoff')
    observedTransitions.push(transition)
  })
  const onSaved = vi.fn((saved: {
    openingMarkdown: string
    savedMarkdown: string
    markdown: string
  }) => {
    events.push('saved')
    observedSavedStates.push({
      openingMarkdown: saved.openingMarkdown,
      savedMarkdown: saved.savedMarkdown,
      markdown: saved.markdown,
    })
  })
  const hook = renderHook(() => useDocumentSession(undefined, onSavedAs, onSaved))
  await act(async () => { await hook.result.current.open('note.md') })
  act(() => hook.result.current.change('edited'))
  const draftIdBeforeSaveAs = hook.result.current.draftId

  await act(async () => { await expect(hook.result.current.saveAs()).resolves.toBeTruthy() })

  expect(events).toEqual(['saved', 'handoff'])
  expect(observedSavedStates).toEqual([{
    openingMarkdown: 'one',
    savedMarkdown: 'edited',
    markdown: 'edited',
  }])
  expect(observedTransitions).toEqual([{
      result: committed,
      openingMarkdown: 'one',
  }])
  expect(hook.result.current.state).toMatchObject({
    openingMarkdown: 'one',
    savedMarkdown: 'edited',
    markdown: 'edited',
  })
  expect(hook.result.current.dirty).toBe(false)
  expect(hook.result.current.draftId).not.toBe(draftIdBeforeSaveAs)
})

it('does not let captured changes or a pending discard from A mutate adopted B', async () => {
  const pendingDiscard = deferred<ApiResult<null>>()
  window.arkdown = createApi({ discardDraft: vi.fn(() => pendingDiscard.promise) })
  const hook = renderHook(() => useDocumentSession())
  await act(async () => { await hook.result.current.open('a.md') })
  const changeA = hook.result.current.change
  act(() => hook.result.current.change('A dirty'))
  let discardA!: ReturnType<typeof hook.result.current.discard>
  act(() => { discardA = hook.result.current.discard() })

  act(() => hook.result.current.adopt(documentSnapshot('b.md', 'B', REVISION_C)))
  act(() => hook.result.current.change('B dirty'))
  act(() => changeA('late A editor change'))
  expect(hook.result.current.state.markdown).toBe('B dirty')

  await act(async () => {
    pendingDiscard.resolve({ ok: true, value: null })
    await expect(discardA).resolves.toBe(false)
  })
  expect(hook.result.current.state).toMatchObject({
    relativePath: 'b.md',
    openingMarkdown: 'B',
    savedMarkdown: 'B',
    markdown: 'B dirty',
  })
})

it('does not publish a late Save As transition from an obsolete lifetime', async () => {
  const pendingBegin = deferred<ApiResult<BeginSaveDocumentAsResult | null>>()
  const onSavedAs = vi.fn()
  const onSaved = vi.fn()
  const abortSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = createApi({
    beginSaveDocumentAs: vi.fn(() => pendingBegin.promise),
    commitSaveDocumentAs: vi.fn(async () => ({
      ok: true as const,
      value: committedSaveAs('A dirty', true),
    })),
    abortSaveDocumentAs,
  })
  const hook = renderHook(() => useDocumentSession(undefined, onSavedAs, onSaved))
  await act(async () => { await hook.result.current.open('a.md') })
  act(() => hook.result.current.change('A dirty'))
  let saveAsA!: ReturnType<typeof hook.result.current.saveAs>
  act(() => { saveAsA = hook.result.current.saveAs() })
  await vi.advanceTimersByTimeAsync(0)
  act(() => hook.result.current.adopt(documentSnapshot('b.md', 'B', REVISION_C)))

  await act(async () => {
    pendingBegin.resolve({ ok: true, value: saveAsIntent(true) })
    await expect(saveAsA).resolves.toBeNull()
  })

  expect(abortSaveDocumentAs).toHaveBeenCalledWith(saveAsIntent(true).intentId)
  expect(onSavedAs).not.toHaveBeenCalled()
  expect(onSaved).not.toHaveBeenCalled()
  expect(hook.result.current.state).toMatchObject({
    relativePath: 'b.md',
    openingMarkdown: 'B',
    savedMarkdown: 'B',
    markdown: 'B',
  })
})

it('starts explicit create, adopt, import, and remounted Save As baselines atomically', async () => {
  window.arkdown = createApi({
    createDocument: vi.fn(async (relativePath: string) => ({
      ok: true as const,
      value: documentSnapshot(relativePath, 'created', REVISION_B),
    })),
    importDocx: vi.fn(async () => ({
      ok: true as const,
      value: {
        sourceAbsolutePath: 'C:/notes/import.docx',
        sourceFileName: 'import.docx',
        markdown: 'imported',
      },
    })),
  })
  const hook = renderHook(() => useDocumentSession())

  await act(async () => { await hook.result.current.create('created.md') })
  expect(hook.result.current.state).toMatchObject({
    openingMarkdown: 'created', savedMarkdown: 'created', markdown: 'created',
  })

  act(() => hook.result.current.adopt(documentSnapshot('adopted.md', 'adopted', REVISION_C)))
  expect(hook.result.current.state).toMatchObject({
    openingMarkdown: 'adopted', savedMarkdown: 'adopted', markdown: 'adopted',
  })

  await act(async () => { await hook.result.current.importDocx('import.docx') })
  expect(hook.result.current.state).toMatchObject({
    openingMarkdown: 'imported', savedMarkdown: 'imported', markdown: 'imported',
  })

  const savedAsDocument = documentSnapshot('saved-as.md', 'persisted', REVISION_D)
  act(() => {
    hook.result.current.adoptSavedAs({
      result: {
        workspace: { name: 'Other', absolutePath: 'D:/Other' },
        document: savedAsDocument,
        changesWorkspace: true,
        aiWorkspace: {
          workspaceId: 'workspace-other',
          workspaceGeneration: 'generation-1',
        },
      },
      openingMarkdown: 'opening before remount',
    })
  })
  expect(hook.result.current.state).toMatchObject({
    relativePath: 'saved-as.md',
    openingMarkdown: 'opening before remount',
    savedMarkdown: 'persisted',
    markdown: 'persisted',
  })
})

it('cancels an A open guard whose shared backup and confirmation settle after Save As', async () => {
  const pendingDraft = deferred<Awaited<ReturnType<NonNullable<ArkdownApi['saveDraft']>>>>()
  const pendingConfirmation = deferred<Awaited<ReturnType<BusinessConfirm>>>()
  const discardDraft = vi.fn(async () => ({ ok: true as const, value: null }))
  const readDocument = vi.fn(async (relativePath: string) => ({
    ok: true as const,
    value: documentSnapshot(relativePath, relativePath === 'a.md' ? 'A' : 'target'),
  }))
  const saveDraft = vi.fn((
    _input: Parameters<NonNullable<ArkdownApi['saveDraft']>>[0],
  ) => pendingDraft.promise)
  window.arkdown = createApi({
    readDocument,
    saveDraft,
    discardDraft,
    businessConfirm: vi.fn(() => pendingConfirmation.promise),
    beginSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: saveAsIntent() })),
    commitSaveDocumentAs: vi.fn(async () => ({
      ok: true as const,
      value: {
        ...committedSaveAs('A dirty'),
        document: documentSnapshot('saved.md', 'A dirty', REVISION_C),
      },
    })),
    abortSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: null })),
  })
  const hook = renderHook(() => useDocumentSession())
  await act(async () => { await hook.result.current.open('a.md') })
  act(() => hook.result.current.change('A dirty'))
  let opening!: ReturnType<typeof hook.result.current.open>
  act(() => { opening = hook.result.current.open('target.md') })
  await vi.advanceTimersByTimeAsync(0)
  expect(saveDraft).toHaveBeenCalledOnce()

  let savingAs!: ReturnType<typeof hook.result.current.saveAs>
  act(() => { savingAs = hook.result.current.saveAs() })
  const draftInput = saveDraft.mock.calls[0]![0]
  await act(async () => {
    pendingDraft.resolve({ ok: true, value: {
      draftId: draftInput.draftId,
      originalAbsolutePath: 'C:/notes/a.md',
      workspaceAbsolutePath: 'C:/notes',
      originalRevision: draftInput.expectedOriginalRevision,
      originalMtimeMs: 1,
      encoding: draftInput.encoding,
      newline: draftInput.newline,
      updatedAt: '2026-08-10T00:00:00.000Z',
      ignoredAt: null,
    } })
    await expect(savingAs).resolves.toBeTruthy()
  })
  expect(latestBusinessConfirm).toHaveBeenCalledOnce()
  act(() => hook.result.current.change('saved document dirty'))

  await act(async () => {
    pendingConfirmation.resolve('discard')
    await expect(opening).resolves.toEqual({ status: 'cancelled' })
  })

  expect(discardDraft).not.toHaveBeenCalled()
  expect(readDocument).toHaveBeenCalledTimes(1)
  expect(hook.result.current.state).toMatchObject({
    relativePath: 'saved.md',
    openingMarkdown: 'A',
    savedMarkdown: 'A dirty',
    markdown: 'saved document dirty',
  })
})

it('defers Save As while a draft terminal commit is pending', async () => {
  const pendingDiscard = deferred<ApiResult<null>>()
  const discardDraft = vi.fn(() => pendingDiscard.promise)
  const readDocument = vi.fn(async (relativePath: string) => ({
    ok: true as const,
    value: documentSnapshot(relativePath, relativePath === 'a.md' ? 'A' : 'target'),
  }))
  window.arkdown = createApi({
    readDocument,
    discardDraft,
    businessConfirm: vi.fn(async (): Promise<'discard'> => 'discard'),
    beginSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: saveAsIntent() })),
    commitSaveDocumentAs: vi.fn(async () => ({
      ok: true as const,
      value: {
        ...committedSaveAs('A dirty'),
        document: documentSnapshot('saved.md', 'A dirty', REVISION_C),
      },
    })),
    abortSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: null })),
  })
  const hook = renderHook(() => useDocumentSession())
  await act(async () => { await hook.result.current.open('a.md') })
  act(() => hook.result.current.change('A dirty'))
  const draftA = hook.result.current.draftId
  let opening!: ReturnType<typeof hook.result.current.open>
  act(() => { opening = hook.result.current.open('target.md') })
  await vi.advanceTimersByTimeAsync(0)
  expect(discardDraft).toHaveBeenCalledWith(draftA)

  await act(async () => { await expect(hook.result.current.saveAs()).resolves.toBeNull() })
  expect(window.arkdown.beginSaveDocumentAs).not.toHaveBeenCalled()
  await act(async () => {
    pendingDiscard.resolve({ ok: true, value: null })
    await expect(opening).resolves.toEqual({ status: 'opened' })
  })
  expect(discardDraft).toHaveBeenCalledOnce()
  expect(hook.result.current.state.markdown).toBe('target')
})
