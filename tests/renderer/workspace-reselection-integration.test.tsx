import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import { DocumentService } from '../../src/main/documents/document-service'
import { DraftService } from '../../src/main/drafts/draft-service'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'
import { useDocumentSession } from '../../src/renderer/editor/use-document-session'
import { useWorkspace } from '../../src/renderer/workspace/use-workspace'

const roots: string[] = []
afterEach(async () => {
  cleanup()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-reselect-consumer-'))
  roots.push(root)
  const workspace = new WorkspaceService()
  const summary = await workspace.setRoot(root)
  const documents = new DocumentService(workspace)
  await documents.create('note.md', '# Original')
  const drafts = new DraftService({ root: path.join(root, 'drafts'), appVersion: '1.0.4' })
  let decision: 'confirm' | 'cancel' | 'discard' = 'confirm'
  let chooseCount = 0
  const operations = createIpcOperations({ workspace, documents, drafts,
    chooseDirectory: async () => { chooseCount += 1; return root },
    getLastWorkspace: () => root, setLastWorkspace: () => undefined, reportError: () => undefined })
  window.arkdown = {
    chooseWorkspace: operations.chooseWorkspace,
    readDocument: (relativePath: string) => operations.readDocument({ relativePath }),
    saveDocument: operations.saveDocument, saveDraft: operations.saveDraft,
    cleanDraft: (draftId: string) => operations.cleanDraft({ draftId }),
    discardDraft: (draftId: string) => operations.discardDraft({ draftId }),
  } as typeof window.arkdown
  const hook = renderHook(() => ({
    workspace: useWorkspace({ restoreOnMount: false }),
    document: useDocumentSession(undefined, undefined, undefined, { confirm: async () => decision }),
  }))
  await act(async () => {
    hook.result.current.workspace.adoptWorkspace(summary)
    expect(await hook.result.current.document.open('note.md')).toEqual({ status: 'opened' })
  })
  const choose = () => hook.result.current.document.transitionAfterSave(hook.result.current.workspace.chooseWorkspace)
  return { root, drafts, documents, operations, hook, choose,
    setDecision: (value: typeof decision) => { decision = value }, chooseCount: () => chooseCount }
}

it.each(['clean', 'confirm', 'discard'] as const)('keeps renderer and main saves aligned after same-root selection from a %s document', async state => {
  const f = await fixture()
  const authorityRevision = f.hook.result.current.workspace.authorityRevision
  if (state !== 'clean') {
    act(() => f.hook.result.current.document.change('# Before choosing'))
    f.setDecision(state)
  }
  await act(async () => { expect(await f.choose()).toBe(true) })
  expect(f.chooseCount()).toBe(1)
  expect(f.hook.result.current.workspace.authorityRevision).toBe(authorityRevision)
  expect(f.hook.result.current.document.state.relativePath).toBe('note.md')
  expect(f.hook.result.current.document.state.markdown).toBe(state === 'confirm' ? '# Before choosing' : '# Original')
  act(() => f.hook.result.current.document.change('# After choosing'))
  await act(async () => { expect(await f.hook.result.current.document.backupDraft()).toBe(true) })
  expect((await f.drafts.read(f.hook.result.current.document.draftId))?.markdown).toBe('# After choosing')
  // Cancel close must keep both the live editor and its durable backup.
  f.setDecision('cancel')
  await act(async () => {
    expect(await f.hook.result.current.document.prepareForClose(() => undefined)).toEqual({ status: 'cancelled' })
  })
  expect(f.hook.result.current.document.state.markdown).toBe('# After choosing')
  f.setDecision('confirm')
  await act(async () => {
    expect(await f.hook.result.current.document.prepareForClose(() => undefined)).toEqual({ status: 'ready' })
  })
  expect(await readFile(path.join(f.root, 'note.md'), 'utf8')).toBe('# After choosing')
  expect(await f.drafts.listRecoverable()).toEqual([])
  f.hook.unmount()
  expect((await f.documents.read('note.md')).markdown).toBe('# After choosing')
})

it('cancels workspace selection before opening the picker when dirty-save confirmation is cancelled', async () => {
  const f = await fixture()
  act(() => f.hook.result.current.document.change('# Keep unsaved'))
  f.setDecision('cancel')
  await act(async () => { expect(await f.choose()).toBe(false) })
  expect(f.chooseCount()).toBe(0)
  expect(f.hook.result.current.document.state.markdown).toBe('# Keep unsaved')
  expect((await f.drafts.read(f.hook.result.current.document.draftId))?.markdown).toBe('# Keep unsaved')
  expect(await readFile(path.join(f.root, 'note.md'), 'utf8')).toBe('# Original')
  await act(async () => { expect(await f.hook.result.current.document.save()).toBe(true) })
  expect(await readFile(path.join(f.root, 'note.md'), 'utf8')).toBe('# Keep unsaved')
})
