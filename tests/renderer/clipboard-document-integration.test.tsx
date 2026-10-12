import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { redo, undo } from '@codemirror/commands'
import { expect, it } from 'vitest'
import { AssetService } from '../../src/main/assets/asset-service'
import { AssetAccessRegistry } from '../../src/main/assets/asset-path'
import { DocumentService } from '../../src/main/documents/document-service'
import { DraftService } from '../../src/main/drafts/draft-service'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import { SourceEditor } from '../../src/renderer/editor/SourceEditor'
import { useDocumentSession } from '../../src/renderer/editor/use-document-session'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
Object.assign(Range.prototype, {
  getClientRects: () => [new DOMRect(0, 0, 1, 1)],
  getBoundingClientRect: () => new DOMRect(0, 0, 1, 1),
})

it.each([false, true])('keeps PNG readable through ordinary save and real undo/redo (undo before save=%s)', async (undoFirst) => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-clipboard-consumer-'))
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  const documents = new DocumentService(workspace)
  await documents.create('note.md', 'before')
  const tempRoot = path.join(root, 'temp')
  const drafts = new DraftService({ root: tempRoot, appVersion: '0.1.0' })
  const assets = new AssetService({ workspace, tempRoot, sessionId: 'consumer', access: new AssetAccessRegistry(),
    readClipboardImage: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => png }),
  })
  const operations = createIpcOperations({ workspace, documents, drafts, assets, chooseDirectory: async () => null,
    getLastWorkspace: () => root, setLastWorkspace: () => undefined, reportError: () => undefined,
  })
  window.arkdown = {
    readDocument: (relativePath: string) => operations.readDocument({ relativePath }),
    saveDocument: operations.saveDocument, saveDraft: operations.saveDraft,
    pasteClipboardImage: operations.pasteClipboardImage,
    discardDraft: (draftId: string) => operations.discardDraft({ draftId }),
  } as typeof window.arkdown
  let session!: ReturnType<typeof useDocumentSession>
  function Editor() {
    session = useDocumentSession()
    return <SourceEditor markdown={session.state.markdown} documentKey="note" onChange={session.change} readClipboardImage={session.readClipboardImage} />
  }
  const rendered = render(<Editor />)
  try {
    await act(async () => { await session.open('note.md') })
    const content = rendered.container.querySelector('.cm-content') as HTMLElement
    const view = EditorView.findFromDOM(content)!
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }))
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { types: ['image/png'], items: [{ kind: 'file', type: 'image/png' }] } })
    fireEvent(content, event)
    await waitFor(() => expect(view.state.doc.toString()).toContain('clipboard-'))
    const stagedPath = /<([^>]+)>/u.exec(view.state.doc.toString())![1]!
    if (undoFirst) act(() => { undo(view) })
    await act(async () => { expect(await session.save()).toBe(true) })
    expect(await drafts.listRecoverable()).toEqual([])
    if (!undoFirst) act(() => { undo(view) })
    expect(view.state.doc.toString()).not.toContain('clipboard-')
    act(() => { redo(view) })
    const reference = /<([^>]+)>/u.exec(view.state.doc.toString())![1]!
    expect(await readFile(path.isAbsolute(reference) ? reference : path.join(root, reference))).toEqual(png)
    expect(await readFile(stagedPath)).toEqual(png)
    if (undoFirst) {
      // Ownership release must not erase a later dirty backup containing redo.
      await act(async () => { await session.backupDraft(false, true) })
      const id = session.draftId
      rendered.unmount()
      await operations.releaseClipboardResources()
      const recovered = await new DraftService({ root: tempRoot, appVersion: '0.1.0' }).read(id)
      expect(recovered?.markdown).toContain('clipboard-')
      expect(await readFile(stagedPath)).toEqual(png)
    } else {
      // Saving the restored image again clears the recoverable backup only.
      await act(async () => { await session.save() })
      rendered.unmount()
      await operations.releaseClipboardResources()
      await expect(stat(stagedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  } finally {
    rendered.unmount()
    await rm(root, { recursive: true, force: true })
  }
})
