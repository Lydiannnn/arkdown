import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AssetService } from '../../src/main/assets/asset-service'
import { AssetAccessRegistry } from '../../src/main/assets/asset-path'
import { DraftService } from '../../src/main/drafts/draft-service'
import { DocumentService } from '../../src/main/documents/document-service'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import { StickyNoteStore } from '../../src/main/sticky-notes/sticky-note-store'
import { stickyNotePaths } from '../../src/main/sticky-notes/sticky-note-paths'

const roots: string[] = []
const draftId = '123e4567-e89b-42d3-a456-426614174000'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it('reports a committed original revision and retains image history when its terminal marker fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-clipboard-terminal-'))
  roots.push(root)
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  const documents = new DocumentService(workspace)
  const original = await documents.create('note.md', 'before')
  const tempRoot = path.join(root, 'temp')
  let failTerminal = false
  const drafts = new DraftService({ root: tempRoot, appVersion: '1.0.4', atomicWrite: async (target, contents) => {
    if (failTerminal && contents.includes('"ended"')) throw new Error('terminal denied')
    await writeFile(target, contents, 'utf8')
  } })
  const assets = new AssetService({ workspace, tempRoot, sessionId: 'terminal', access: new AssetAccessRegistry(),
    readClipboardImage: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => png }),
  })
  const operations = createIpcOperations({ workspace, documents, drafts, assets, chooseDirectory: async () => null,
    getLastWorkspace: () => root, setLastWorkspace: async () => undefined, reportError: vi.fn() })
  await operations.readDocument({ relativePath: 'note.md' })
  const backup = (markdown: string) => operations.saveDraft({ draftId, markdown, expectedOriginalRevision: original.revision, encoding: 'utf8', newline: 'lf' })
  await backup('before')
  const image = await operations.pasteClipboardImage({ draftId })
  if (!image.ok || !image.value) throw new Error('Expected image')
  await backup(image.value)
  failTerminal = true
  const saved = await operations.saveDocument({ relativePath: 'note.md', markdown: image.value,
    expectedRevision: original.revision, encoding: 'utf8', newline: 'lf' })
  if (!saved.ok) throw new Error('The body commit must remain observable')
  const actual = await documents.read('note.md')
  expect(saved.value).toMatchObject({ revision: actual.revision, markdown: actual.markdown, draftEndPending: true })
  expect((await drafts.read(draftId))?.markdown).toBe(image.value)
  expect(await readFile(/<([^>]+)>/u.exec(image.value)![1]!)).toEqual(png)
  failTerminal = false
  expect(await operations.saveDocument({ relativePath: 'note.md', markdown: actual.markdown,
    expectedRevision: saved.value.revision, encoding: 'utf8', newline: 'lf' })).toMatchObject({ ok: true, value: { clipboardAssetsRetained: true } })
  expect(await drafts.listRecoverable()).toEqual([])
})

it('binds clipboard paste to the note window and persists PNG through archive, restore and fresh-store reopen', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-clipboard-note-'))
  roots.push(root)
  const store = new StickyNoteStore({ root: path.join(root, 'notes') })
  const note = await store.create({ name: 'Clipboard', markdown: 'before' })
  const assets = new AssetService({ workspace: new WorkspaceService(), tempRoot: path.join(root, 'temp'), sessionId: 'note', access: new AssetAccessRegistry(),
    readClipboardImage: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => png }),
  })
  const operations = createIpcOperations({ workspace: new WorkspaceService(), documents: {} as never, assets,
    clipboardNoteId: note.record.id, stickyNotes: { copyImage: (id: string, source: string) => store.copyImageResource(id, source) } as never,
    chooseDirectory: async () => null, getLastWorkspace: () => null, setLastWorkspace: () => undefined, reportError: vi.fn(),
  })
  await expect(operations.pasteClipboardImage({ noteId: draftId })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  const pasted = await operations.pasteClipboardImage({ noteId: note.record.id })
  if (!pasted.ok || !pasted.value) throw new Error('Expected note image')
  const fileName = /resources\/([^\s)]+\.png)/u.exec(pasted.value)![1]!
  expect(await readFile(path.join(stickyNotePaths(path.join(root, 'notes'), note.record).resources, fileName))).toEqual(png)
  expect(await readdir(path.join(root, 'temp', 'assets'))).toEqual([])
  await store.writeMarkdown(note.record.id, pasted.value)
  const archived = await store.archive(note.record.id)
  expect(await readFile(path.join(stickyNotePaths(path.join(root, 'notes'), archived.record).resources, fileName))).toEqual(png)
  await store.restore(note.record.id)
  const reopened = await new StickyNoteStore({ root: path.join(root, 'notes') }).get(note.record.id)
  expect(reopened.markdown).toBe(pasted.value)
  expect(await readFile(path.join(stickyNotePaths(path.join(root, 'notes'), reopened.record).resources, fileName))).toEqual(png)
})

it.each(['save-as', 'ordinary'] as const)('persists clipboard PNG across %s, draft cleanup and reopen', async (mode) => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-clipboard-save-'))
  roots.push(root)
  const tempRoot = path.join(root, 'temp')
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  const documents = new DocumentService(workspace)
  const drafts = new DraftService({ root: tempRoot, appVersion: '0.1.0' })
  const assets = new AssetService({ workspace, tempRoot, sessionId: 'test', access: new AssetAccessRegistry(),
    readClipboardImage: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => png }),
  })
  const operations = createIpcOperations({ workspace, documents, drafts, assets, chooseDirectory: async () => null,
    chooseSavePath: async () => path.join(root, 'saved.md'), getLastWorkspace: () => root, setLastWorkspace: () => undefined, reportError: vi.fn(),
  })
  const opened = mode === 'ordinary' ? await operations.createDocument({ relativePath: 'saved.md' }) : null
  const revision = opened?.ok ? opened.value.revision : null
  const backup = (markdown: string) => operations.saveDraft({ draftId, markdown, encoding: 'utf8', newline: 'lf', expectedOriginalRevision: revision })
  expect((await backup('')).ok).toBe(true)
  const pasted = await operations.pasteClipboardImage({ draftId })
  expect(pasted.ok).toBe(true)
  if (!pasted.ok || !pasted.value) throw new Error('Image missing')
  const staging = /<([^>]+)>/u.exec(pasted.value)![1]!
  expect((await backup(pasted.value)).ok).toBe(true)
  // A completely fresh service validates the durable asset hashes and body.
  const recovered = await new DraftService({ root: tempRoot, appVersion: '0.1.0' }).read(draftId)
  expect(recovered?.markdown).toBe(pasted.value)
  const result = mode === 'ordinary'
    ? await operations.saveDocument({ relativePath: 'saved.md', markdown: pasted.value, expectedRevision: revision!, encoding: 'utf8', newline: 'lf' })
    : await operations.saveDocumentAs({ draftId, markdown: pasted.value, encoding: 'utf8', newline: 'lf', suggestedFileName: 'saved.md' })
  expect(result.ok).toBe(true)
  if (mode === 'ordinary') {
    if (result.ok) expect(result.value).toMatchObject({ clipboardAssetsRetained: true })
    expect(await readFile(staging)).toEqual(png) // Existing undo/redo still uses this path.
    expect(await drafts.listRecoverable()).toEqual([])
    expect((await operations.readDocument({ relativePath: 'saved.md' })).ok).toBe(true)
    await operations.releaseClipboardResources()
  }
  await expect(stat(staging)).rejects.toMatchObject({ code: 'ENOENT' })
  const reopened = await new DocumentService(workspace).read('saved.md')
  expect(reopened.markdown).not.toContain(staging)
  const relative = /<([^>]+)>/u.exec(reopened.markdown)![1]!
  expect(relative).toMatch(/^assets\/clipboard-/u)
  expect(await readFile(path.join(root, relative))).toEqual(png)
  expect(await readdir(path.join(root, 'assets'))).toHaveLength(1)
  if (mode === 'ordinary' && result.ok) expect(result.value).toMatchObject({ markdown: reopened.markdown })
})

it.each(['before-write', 'after-write'] as const)('keeps retained targets and draft PNG safe on ordinary save failure %s', async (failure) => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-clipboard-failure-'))
  roots.push(root)
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  const documents = new DocumentService(workspace)
  const initial = await documents.create('note.md', 'before')
  const tempRoot = path.join(root, 'temp')
  const drafts = new DraftService({ root: tempRoot, appVersion: '0.1.0' })
  const assets = new AssetService({ workspace, tempRoot, sessionId: 'failure', access: new AssetAccessRegistry(),
    readClipboardImage: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => png }),
  })
  const operations = createIpcOperations({ workspace, documents, drafts, assets, chooseDirectory: async () => null,
    getLastWorkspace: () => root, setLastWorkspace: () => undefined, reportError: vi.fn(),
  })
  await operations.readDocument({ relativePath: 'note.md' })
  const backup = (markdown: string) => operations.saveDraft({ draftId, markdown, expectedOriginalRevision: initial.revision, encoding: 'utf8', newline: 'lf' })
  await backup('before')
  const staged = await operations.pasteClipboardImage({ draftId })
  if (!staged.ok || !staged.value) throw new Error('Expected image')
  await backup(staged.value)
  const save = documents.save.bind(documents)
  vi.spyOn(documents, 'save').mockImplementation(async (input) => {
    if (failure === 'after-write') await save(input)
    throw new Error('simulated disk/publication failure')
  })
  expect((await operations.saveDocument({ relativePath: 'note.md', markdown: staged.value, expectedRevision: initial.revision, encoding: 'utf8', newline: 'lf' })).ok).toBe(false)
  const actual = await documents.read('note.md')
  if (failure === 'after-write') {
    const relative = /assets\/clipboard-[0-9a-f-]+\.png/u.exec(actual.markdown)![0]
    expect(await readFile(path.join(root, relative))).toEqual(png)
  } else {
    expect(actual.markdown).toBe('before')
    expect(await readdir(path.join(root, 'assets'))).toEqual([])
  }
  const recovered = await new DraftService({ root: tempRoot, appVersion: '0.1.0' }).read(draftId)
  expect(recovered?.markdown).toBe(staged.value)
  expect(await readFile(/<([^>]+)>/u.exec(staged.value)![1]!)).toEqual(png)
})
