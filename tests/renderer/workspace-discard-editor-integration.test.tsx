import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import { DocumentService } from '../../src/main/documents/document-service'
import { DraftService } from '../../src/main/drafts/draft-service'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'
import { EditorPane, type EditorPaneHandle } from '../../src/renderer/editor/EditorPane'
import { useDocumentSession } from '../../src/renderer/editor/use-document-session'
import { useWorkspace } from '../../src/renderer/workspace/use-workspace'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'

// Milkdown consumes its initial markdown when mounted, not on each prop update.
// Keep this boundary stateful; a controlled textarea would hide the stale surface.
vi.mock('../../src/renderer/editor/VisualEditor', async () => {
  const { forwardRef, useImperativeHandle, useRef, useState } = await import('react')
  return { VisualEditor: forwardRef(function Surface(
    { markdown, onChange }: { markdown: string; onChange(value: string): void }, ref,
  ) {
    const [value, setValue] = useState(markdown)
    const committed = useRef(markdown)
    useImperativeHandle(ref, () => ({
      flush: () => { if (value !== committed.current) { committed.current = value; onChange(value); return value } return null },
    }), [value, onChange])
    return <textarea aria-label="document surface" value={value} onChange={event => {
      const next = event.target.value
      committed.current = next
      setValue(next)
      onChange(next)
    }} />
  }) }
})

const roots: string[] = []
afterEach(async () => {
  cleanup()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(options: { cancelPicker?: boolean; rejectDiscard?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-discard-surface-'))
  roots.push(root)
  const workspace = new WorkspaceService()
  const summary = await workspace.setRoot(root)
  const documents = new DocumentService(workspace)
  await documents.create('note.md', '# Original')
  const drafts = new DraftService({ root: path.join(root, 'drafts'), appVersion: '1.0.4' })
  const operations = createIpcOperations({ workspace, documents, drafts,
    chooseDirectory: async () => options.cancelPicker ? null : root,
    getLastWorkspace: () => root, setLastWorkspace: () => undefined, reportError: () => undefined })
  window.arkdown = {
    chooseWorkspace: operations.chooseWorkspace,
    readDocument: (relativePath: string) => operations.readDocument({ relativePath }),
    saveDocument: operations.saveDocument, saveDraft: operations.saveDraft,
    cleanDraft: (draftId: string) => operations.cleanDraft({ draftId }),
    discardDraft: (draftId: string) => options.rejectDiscard
      ? Promise.resolve({ ok: false, error: { code: 'OPERATION_FAILED', message: 'Synthetic draft failure' } })
      : operations.discardDraft({ draftId }),
    onTranslationEvent: () => () => undefined,
    onAiConversationEvent: () => () => undefined,
    getLargeModelSettings: async () => ({ ok: true, value: DEFAULT_LARGE_MODEL_SETTINGS }),
  } as unknown as typeof window.arkdown
  const editor = createRef<EditorPaneHandle>()
  let session!: ReturnType<typeof useDocumentSession>
  let workspaceHook!: ReturnType<typeof useWorkspace>
  let decision: 'discard' | 'confirm' | 'cancel' = 'discard'
  function Harness() {
    workspaceHook = useWorkspace({ restoreOnMount: false })
    session = useDocumentSession(() => { editor.current?.flush() }, undefined, undefined,
      { confirm: async () => decision })
    return session.state.relativePath ? <EditorPane ref={editor} documentKey="note.md"
      markdown={session.state.markdown} documentDirty={session.dirty}
      onChange={session.change} onOpenLargeModelSettings={() => undefined} /> : null
  }
  render(<Harness />)
  await act(async () => {
    workspaceHook.adoptWorkspace(summary)
    await session.open('note.md')
  })
  await screen.findByRole('textbox', { name: 'document surface' })
  return { root, drafts, session: () => session, editor,
    choose: () => session.transitionAfterSave(workspaceHook.chooseWorkspace),
    decision: (value: typeof decision) => { decision = value } }
}

it.each([false, true])('reconciles the visible document after discard when selection keeps the workspace (picker cancelled: %s)', async cancelPicker => {
  const f = await fixture({ cancelPicker })
  fireEvent.change(screen.getByRole('textbox', { name: 'document surface' }), { target: { value: '# Discard me' } })
  await act(async () => { expect(await f.choose()).toBe(true) })
  expect(f.session().state.markdown).toBe('# Original')
  expect(screen.getByRole('textbox', { name: 'document surface' })).toHaveValue('# Original')
  await act(async () => { expect(await f.session().save()).toBe(true) })
  expect(await readFile(path.join(f.root, 'note.md'), 'utf8')).toBe('# Original')
  expect(await f.drafts.listRecoverable()).toEqual([])
  fireEvent.change(screen.getByRole('textbox', { name: 'document surface' }), { target: { value: '# New edit after discard' } })
  await act(async () => { expect(await f.session().backupDraft()).toBe(true) })
  expect((await f.drafts.read(f.session().draftId))?.markdown).toBe('# New edit after discard')
  f.decision('cancel')
  await act(async () => { expect(await f.session().prepareForClose(() => undefined)).toEqual({ status: 'cancelled' }) })
  expect(screen.getByRole('textbox', { name: 'document surface' })).toHaveValue('# New edit after discard')
  await act(async () => { expect(await f.session().save()).toBe(true) })
  expect(await readFile(path.join(f.root, 'note.md'), 'utf8')).toBe('# New edit after discard')
})

it('preserves the live editor instance when accepting its own edits and saving before same-root selection', async () => {
  const f = await fixture()
  const surface = screen.getByRole('textbox', { name: 'document surface' })
  fireEvent.change(surface, { target: { value: '# Keep me' } })
  await waitFor(() => expect(f.session().state.markdown).toBe('# Keep me'))
  expect(screen.getByRole('textbox', { name: 'document surface' })).toBe(surface)
  f.decision('confirm')
  await act(async () => { expect(await f.choose()).toBe(true) })
  expect(screen.getByRole('textbox', { name: 'document surface' })).toBe(surface)
  expect(surface).toHaveValue('# Keep me')
  expect(await readFile(path.join(f.root, 'note.md'), 'utf8')).toBe('# Keep me')
})

it('keeps visible edits when ending the draft fails instead of resetting the editor early', async () => {
  const f = await fixture({ rejectDiscard: true })
  const surface = screen.getByRole('textbox', { name: 'document surface' })
  fireEvent.change(surface, { target: { value: '# Must survive failure' } })
  await act(async () => { expect(await f.choose()).toBe(false) })
  expect(screen.getByRole('textbox', { name: 'document surface' })).toBe(surface)
  expect(surface).toHaveValue('# Must survive failure')
  expect(f.session().state.markdown).toBe('# Must survive failure')
  expect(f.session().dirty).toBe(true)
  expect(await readFile(path.join(f.root, 'note.md'), 'utf8')).toBe('# Original')
})
