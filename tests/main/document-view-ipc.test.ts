import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { createIpcOperations, registerIpc, ipcFailure } from '../../src/main/ipc/register-ipc'
import { IPC_CHANNELS } from '../../src/shared/contracts'
import { PUBLIC_ERROR_MESSAGES } from '../../src/shared/public-errors'
import { DocumentService } from '../../src/main/documents/document-service'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.join(tmpdir(), 'arkdown-view-ipc-'))) throw new Error('Unsafe test cleanup')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-view-ipc-'))
  roots.push(root)
  const reports = path.join(root, 'reports')
  await mkdir(reports)
  await writeFile(path.join(reports, 'report.md'), '# Report\n[Evidence](../evidence.md)\n', 'utf8')
  await writeFile(path.join(reports, 'other.md'), '# Other\n', 'utf8')
  await writeFile(path.join(root, 'evidence.md'), '# Evidence\n', 'utf8')
  const workspace = new WorkspaceService()
  await workspace.setRoot(reports)
  const documents = new DocumentService(workspace)
  const openDocumentWindow = vi.fn(async () => undefined)
  const openExternal = vi.fn(async () => undefined)
  const showItemInFolder = vi.fn()
  const operations = createIpcOperations({
    chooseDirectory: async () => null, workspace, documents,
    getLastWorkspace: () => null, setLastWorkspace: async () => undefined,
    reportError: vi.fn(), openDocumentWindow, openExternal, showItemInFolder,
  })
  return { root, reports, workspace, documents, operations, openDocumentWindow, openExternal, showItemInFolder }
}

it('reveals absolute and relative local links without opening a file or changing save ownership', async () => {
  const f = await fixture()
  const target = path.join(f.root, '有 空格.bin')
  await writeFile(target, Buffer.from([0, 1, 2]))
  // An absolute link also works in an unsaved draft, with no source document.
  for (const href of [target, pathToFileURL(target).href]) {
    await expect(f.operations.revealLocalFileLink({ href })).resolves.toEqual({ ok: true, value: null })
    expect(f.showItemInFolder).toHaveBeenLastCalledWith(await realpath(target))
  }
  await f.operations.readDocument({ relativePath: 'report.md' })
  await expect(f.operations.revealLocalFileLink({ href: '../有%20空格.bin#L12' })).resolves.toEqual({ ok: true, value: null })
  expect(f.showItemInFolder).toHaveBeenLastCalledWith(await realpath(target))
  expect(f.operations.getCurrentDocumentAbsolutePath()).toBe(path.join(f.reports, 'report.md'))
  expect(f.workspace.getRoot()).toBe(f.reports)
  expect(f.openExternal).not.toHaveBeenCalled()
  expect(f.openDocumentWindow).not.toHaveBeenCalled()
})

it('reveals a preview link relative to its token-owned document and rejects a stale preview', async () => {
  const f = await fixture()
  await f.operations.readDocument({ relativePath: 'report.md' })
  const viewed = await f.operations.navigateDocumentView({ href: '../evidence.md' })
  if (!viewed.ok || viewed.value.kind !== 'document') throw new Error('Fixture failed')
  const request = { href: 'reports/other.md:3', sourceId: viewed.value.document.id }
  await expect(f.operations.revealLocalFileLink(request)).resolves.toEqual({ ok: true, value: null })
  expect(f.showItemInFolder).toHaveBeenCalledExactlyOnceWith(path.join(f.reports, 'other.md'))
  await f.operations.readDocument({ relativePath: 'other.md' })
  await expect(f.operations.revealLocalFileLink(request)).resolves.toMatchObject({ ok: false })
  expect(f.showItemInFolder).toHaveBeenCalledTimes(1)
})

it('reports the requested missing-file text for missing targets and unresolved relative links', async () => {
  const f = await fixture()
  const missing = { ok: false, error: { code: 'LOCAL_FILE_NOT_FOUND', message: '无法找到文件。目标文件已不在原位置，或当前文档已被移动到新位置。' } }
  await expect(f.operations.revealLocalFileLink({ href: './evidence.md' })).resolves.toEqual(missing)
  await f.operations.readDocument({ relativePath: 'report.md' })
  await expect(f.operations.revealLocalFileLink({ href: path.join(f.root, 'missing.md') })).resolves.toEqual(missing)
  await expect(f.operations.revealLocalFileLink({ href: '../missing.md' })).resolves.toEqual(missing)
  expect(f.showItemInFolder).not.toHaveBeenCalled()
})

it('rejects remote links and renderer-supplied base paths before revealing anything', async () => {
  const f = await fixture()
  await f.operations.readDocument({ relativePath: 'report.md' })
  for (const request of [{ href: 'https://example.com/a.md' }, { href: '#heading' }, { href: '../evidence.md', sourcePath: f.root }]) {
    await expect(f.operations.revealLocalFileLink(request)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  }
  expect(f.showItemInFolder).not.toHaveBeenCalled()
})

it('uses current main-owned document for relative reads without changing workspace or save ownership', async () => {
  const { root, reports, workspace, operations, openDocumentWindow } = await fixture()
  const source = await operations.readDocument({ relativePath: 'report.md' })
  expect(source.ok).toBe(true)
  const viewed = await operations.navigateDocumentView({ href: '../evidence.md' })
  expect(viewed).toMatchObject({ ok: true, value: { kind: 'document', document: { text: '# Evidence\n' } } })
  expect(workspace.getRoot()).toBe(reports)
  if (!source.ok || !viewed.ok || viewed.value.kind !== 'document') throw new Error('Fixture failed')
  await expect(operations.saveDocument({ relativePath: 'report.md', markdown: '# Edited report\n', expectedRevision: source.value.revision, encoding: source.value.encoding, newline: source.value.newline })).resolves.toMatchObject({ ok: true })
  expect(await readFile(path.join(reports, 'report.md'), 'utf8')).toBe('# Edited report\n')
  expect(await readFile(path.join(root, 'evidence.md'), 'utf8')).toBe('# Evidence\n')
  await expect(operations.openDocumentView({ id: viewed.value.document.id })).resolves.toEqual({ ok: true, value: null })
  expect(openDocumentWindow).toHaveBeenCalledExactlyOnceWith(path.join(root, 'evidence.md'))
})

it('rejects caller-supplied base paths, absolute navigation and tokens from an earlier source document', async () => {
  const { operations, root, openDocumentWindow, openExternal } = await fixture()
  await operations.readDocument({ relativePath: 'report.md' })
  await expect(operations.navigateDocumentView({ href: '../evidence.md', sourcePath: root })).resolves.toMatchObject({ ok: false })
  await expect(operations.navigateDocumentView({ href: path.join(root, 'evidence.md') })).resolves.toMatchObject({ ok: false })
  const viewed = await operations.navigateDocumentView({ href: '../evidence.md' })
  if (!viewed.ok || viewed.value.kind !== 'document') throw new Error('Fixture failed')
  await operations.readDocument({ relativePath: 'other.md' })
  await expect(operations.openDocumentView({ id: viewed.value.document.id })).resolves.toMatchObject({ ok: false })
  await expect(operations.refreshDocumentView({ id: viewed.value.document.id })).resolves.toMatchObject({ ok: false })
  expect(openDocumentWindow).not.toHaveBeenCalled()
  expect(openExternal).not.toHaveBeenCalled()
})

it('does not guess a relative-link base before a document is open', async () => {
  const { operations } = await fixture()
  await expect(operations.navigateDocumentView({ href: 'report.md' })).resolves.toMatchObject({ ok: false })
})

it('matches the canonical main-owned source when the workspace was opened through a junction', async () => {
  const f = await fixture()
  const alias = path.join(f.root, 'alias')
  await symlink(f.reports, alias, 'junction')
  await f.workspace.setRoot(alias)
  expect(f.workspace.getRoot()).toBe(await realpath(f.reports))
  expect(await f.operations.readDocument({ relativePath: 'report.md' })).toMatchObject({ ok: true })
  const mainPath = f.operations.getCurrentDocumentAbsolutePath()
  expect(mainPath).toBe(await realpath(path.join(f.reports, 'report.md')))
  const backToRoot = await f.operations.navigateDocumentView({ href: '../alias/report.md' })
  expect(backToRoot).toMatchObject({ ok: true, value: { kind: 'document', document: { absolutePath: mainPath } } })
})

it('gives the renderer a canonical relative source path when reading through an internal junction', async () => {
  const f = await fixture()
  const actual = path.join(f.reports, 'actual')
  await mkdir(actual)
  await writeFile(path.join(actual, 'A.md'), 'source')
  await symlink(actual, path.join(f.reports, 'alias'), 'junction')
  const result = await f.operations.readDocument({ relativePath: 'alias/A.md' })
  if (!result.ok) throw new Error('Expected owned source')
  expect(result.value.relativePath).toBe('actual/A.md')
  const rendererSourcePath = path.join(f.workspace.getRoot(), result.value.relativePath)
  expect(rendererSourcePath).toBe(await realpath(path.join(actual, 'A.md')))
  const backToRoot = await f.operations.navigateDocumentView({ href: '../alias/A.md' })
  expect(backToRoot).toMatchObject({ ok: true, value: { kind: 'document', document: { absolutePath: rendererSourcePath } } })
})

it.each([
  ['bad.json', Buffer.from([0xff, 0xfe]), 'DOCUMENT_ENCODING_UNSUPPORTED'],
  ['binary.ts', Buffer.from([0, 1, 2]), 'DOCUMENT_BINARY'],
  ['large.json', Buffer.alloc(8 * 1024 * 1024 + 1, 65), 'DOCUMENT_TEXT_TOO_LARGE'],
] as const)('returns the controlled code document failure when reading %s', async (name, contents, code) => {
  const f = await fixture()
  await writeFile(path.join(f.reports, name), contents)
  expect(await f.operations.readDocument({ relativePath: name })).toEqual({ ok: false, error: { code, message: PUBLIC_ERROR_MESSAGES[code] } })
  expect(ipcFailure(Object.assign(new Error('C:\\sensitive\\private user path'), { code }))).toEqual({ ok: false, error: { code, message: PUBLIC_ERROR_MESSAGES[code] } })
})

it('binds registered preview channels to the owning main frame and clears pending reads on disposal', async () => {
  const f = await fixture()
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipcMain = { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) }
  const webContents = { id: 61, mainFrame: {}, send: vi.fn(), isDestroyed: () => false }
  const registration = registerIpc({ ipcMain, window: { webContents, isDestroyed: () => false },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }), workspace: f.workspace, documents: f.documents,
    getLastWorkspace: () => f.reports, setLastWorkspace: async () => undefined, reportError: vi.fn(),
    openDocumentWindow: f.openDocumentWindow, openExternal: f.openExternal, controlWindow: vi.fn(), getWindowState: vi.fn(),
  } as never)
  const event = { sender: webContents, senderFrame: webContents.mainFrame }
  const navigate = handlers.get(IPC_CHANNELS.navigateDocumentView)!
  expect(registration.getCurrentDocumentAbsolutePath()).toBeNull()
  await handlers.get(IPC_CHANNELS.readDocument)!(event, { relativePath: 'report.md' })
  expect(registration.getCurrentDocumentAbsolutePath()).toBe(path.join(f.reports, 'report.md'))
  for (const channel of [IPC_CHANNELS.navigateDocumentView, IPC_CHANNELS.refreshDocumentView, IPC_CHANNELS.inspectDocumentView, IPC_CHANNELS.openDocumentView, IPC_CHANNELS.revealLocalFileLink]) {
    await expect(handlers.get(channel)!({ sender: {}, senderFrame: webContents.mainFrame }, {})).resolves.toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })
    await expect(handlers.get(channel)!({ sender: webContents, senderFrame: {} }, {})).resolves.toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })
  }
  const pending = navigate(event, { href: '../evidence.md' })
  const disposed = registration.dispose()
  await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'DOCUMENT_VIEW_STALE' } })
  await disposed
  expect(handlers.size).toBe(0)
  await expect(navigate(event, { href: '../evidence.md' })).resolves.toMatchObject({ ok: false })
})
