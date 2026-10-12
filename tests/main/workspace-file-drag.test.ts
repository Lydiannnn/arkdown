import { EventEmitter } from 'node:events'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'
import { WorkspaceFileDrag } from '../../src/main/workspace/workspace-file-drag'
import { resolveExistingInside } from '../../src/main/workspace/workspace-path'
import { createIpcOperations, registerIpcHandlers } from '../../src/main/ipc/register-ipc'
import { DocumentService } from '../../src/main/documents/document-service'
import { IPC_CHANNELS } from '../../src/shared/contracts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
class Owner extends EventEmitter {
  mainFrame: unknown = {}
  destroyed = false
  isDestroyed() { return this.destroyed }
}
async function setup(file = '子目录/已保存 note.md') {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-file-drag-'))
  roots.push(root)
  const workspace = new WorkspaceService({ realpath, stat: target => stat(target, { bigint: true }), resolveExistingInside, lstat, queryWindowsReparsePoint: async () => false })
  await workspace.setRoot(root)
  const absolute = path.join(root, file)
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, 'saved bytes\r\n', 'utf8')
  const owner = new Owner()
  const calls: string[] = []
  const prepareNativeDrag = vi.fn(async (target: string) => () => { calls.push(target) })
  const service = new WorkspaceFileDrag({ workspace, owner, prepareNativeDrag, queryReparsePoint: async () => false })
  return { root, workspace, absolute, owner, calls, prepareNativeDrag, service,
    input: { workspace: workspace.getRoot(), relativePath: file } }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

it.each(['子目录/已保存 note.md', `${'长'.repeat(80)}.txt`, 'data.json', 'original.docx', 'original.pdf', 'original.xlsx'])('drags the existing saved file unchanged, including original conversion formats: %s', async file => {
  const fixture = await setup(file)
  await fixture.service.start(fixture.input, () => true)
  expect(fixture.calls).toEqual([fixture.absolute])
  expect(await readFile(fixture.absolute, 'utf8')).toBe('saved bytes\r\n')
  fixture.service.dispose()
})

it('accepts read-only sources without attempting a save', async () => {
  const fixture = await setup()
  await chmod(fixture.absolute, 0o444)
  try {
    await fixture.service.start(fixture.input, () => true)
    expect(fixture.calls).toEqual([fixture.absolute])
    expect(await readFile(fixture.absolute, 'utf8')).toBe('saved bytes\r\n')
  } finally { await chmod(fixture.absolute, 0o666); fixture.service.dispose() }
})

it('keeps a real path longer than 260 characters inside the workspace without creating a short-path copy', async () => {
  const relative = `${Array.from({ length: 7 }, (_, i) => `${i}-${'路径'.repeat(18)}`).join('/')}/saved.md`
  const fixture = await setup(relative)
  expect(fixture.absolute.length).toBeGreaterThan(260)
  await fixture.service.start(fixture.input, () => true)
  expect(fixture.calls).toEqual([fixture.absolute])
  expect(await readFile(fixture.absolute, 'utf8')).toBe('saved bytes\r\n')
  fixture.service.dispose()
})

it.each(['', '../outside.md', 'C:/elsewhere.md', '/elsewhere.md', 'note.md:stream', 'saved.lnk', 'saved.url', 'saved.exe'])('rejects unsupported or nonrelative file identity: %s', async relativePath => {
  const fixture = await setup()
  await expect(fixture.service.start({ ...fixture.input, relativePath }, () => true)).rejects.toBeDefined()
  expect(fixture.calls).toEqual([])
  expect(fixture.prepareNativeDrag).not.toHaveBeenCalled()
  fixture.service.dispose()
})

it('rejects a directory with a supported extension, a missing source and a redirected parent', async () => {
  const fixture = await setup()
  await mkdir(path.join(fixture.root, 'folder.md'))
  for (const relativePath of ['folder.md', 'missing.md']) {
    await expect(fixture.service.start({ ...fixture.input, relativePath }, () => true)).rejects.toBeDefined()
  }
  const outside = await mkdtemp(path.join(tmpdir(), 'arkdown-drag-outside-')); roots.push(outside)
  await writeFile(path.join(outside, 'note.md'), 'outside')
  await symlink(outside, path.join(fixture.root, 'redirect'), 'junction')
  await expect(fixture.service.start({ ...fixture.input, relativePath: 'redirect/note.md' }, () => true)).rejects.toBeDefined()
  expect(fixture.calls).toEqual([])
  fixture.service.dispose()
})

it.each(['workspace ABA', 'frame', 'main navigation', 'renderer gone', 'destroyed', 'close gate', 'disposed'] as const)('does not start after %s while the native icon is being prepared', async change => {
  const fixture = await setup(), wait = deferred()
  fixture.prepareNativeDrag.mockImplementation(async target => { await wait.promise; return () => { fixture.calls.push(target) } })
  let accepting = true
  const pending = fixture.service.start(fixture.input, () => accepting)
  const rejection = expect(pending).rejects.toBeDefined()
  await vi.waitFor(() => expect(fixture.prepareNativeDrag).toHaveBeenCalledOnce())
  if (change === 'workspace ABA') await fixture.workspace.setRoot(fixture.root)
  if (change === 'frame') fixture.owner.mainFrame = {}
  if (change === 'main navigation') fixture.owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  if (change === 'renderer gone') fixture.owner.emit('render-process-gone')
  if (change === 'destroyed') fixture.owner.destroyed = true
  if (change === 'close gate') accepting = false
  if (change === 'disposed') fixture.service.dispose()
  wait.resolve(); await rejection
  expect(fixture.calls).toEqual([])
  fixture.service.dispose()
})

it('rejects a replaced source after icon preparation and never substitutes new bytes', async () => {
  const fixture = await setup()
  fixture.prepareNativeDrag.mockImplementation(async target => {
    await rename(target, `${target}.old`); await writeFile(target, 'replacement')
    return () => { fixture.calls.push(target) }
  })
  await expect(fixture.service.start(fixture.input, () => true)).rejects.toBeDefined()
  expect(fixture.calls).toEqual([])
  expect(await readFile(`${fixture.absolute}.old`, 'utf8')).toBe('saved bytes\r\n')
  fixture.service.dispose()
})

it('allows same-document/subframe navigation, fences concurrent requests, and releases failure state and listeners', async () => {
  const fixture = await setup(), wait = deferred()
  fixture.prepareNativeDrag.mockImplementationOnce(async target => { await wait.promise; return () => { fixture.calls.push(target) } })
  const pending = fixture.service.start(fixture.input, () => true)
  await vi.waitFor(() => expect(fixture.prepareNativeDrag).toHaveBeenCalledOnce())
  await expect(fixture.service.start(fixture.input, () => true)).rejects.toBeDefined()
  fixture.owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  fixture.owner.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
  wait.resolve(); await pending
  fixture.prepareNativeDrag.mockRejectedValueOnce(new Error('icon unavailable'))
  await expect(fixture.service.start(fixture.input, () => true)).rejects.toThrow('icon unavailable')
  await fixture.service.start(fixture.input, () => true)
  expect(fixture.calls).toEqual([fixture.absolute, fixture.absolute])
  fixture.service.dispose()
  expect(fixture.owner.eventNames()).toEqual([])
})

it('uses the real owned IPC dispatch to reject other frames and a close admitted during icon lookup', async () => {
  const fixture = await setup(), wait = deferred()
  const operations = createIpcOperations({ workspace: fixture.workspace, documents: new DocumentService(fixture.workspace),
    workspaceFileDrag: fixture.service, chooseDirectory: async () => null, getLastWorkspace: () => null,
    setLastWorkspace: () => undefined, reportError: () => undefined })
  const handlers = new Map<string, (event: { sender: unknown; senderFrame: unknown }, ...args: unknown[]) => unknown>()
  const ipcMain = { handle: (name: string, handler: (event: { sender: unknown; senderFrame: unknown }, ...args: unknown[]) => unknown) => { handlers.set(name, handler) },
    removeHandler: (name: string) => { handlers.delete(name) } }
  const registration = registerIpcHandlers({ ipcMain, window: { webContents: fixture.owner }, operations })
  const invoke = (sender = fixture.owner, senderFrame = fixture.owner.mainFrame) => handlers.get(IPC_CHANNELS.startWorkspaceFileDrag)!({ sender, senderFrame }, fixture.input)
  try {
    expect(await invoke(fixture.owner, {})).toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })
    expect(fixture.prepareNativeDrag).not.toHaveBeenCalled()
    fixture.prepareNativeDrag.mockImplementationOnce(async target => { await wait.promise; return () => { fixture.calls.push(target) } })
    const pending = invoke()
    await vi.waitFor(() => expect(fixture.prepareNativeDrag).toHaveBeenCalledOnce())
    const drain = registration.pauseAndDrain()
    wait.resolve()
    expect(await pending).toMatchObject({ ok: false })
    await drain
    expect(fixture.calls).toEqual([])
    registration.resume()
    expect(await invoke()).toEqual({ ok: true, value: undefined })
    expect(fixture.calls).toEqual([fixture.absolute])
  } finally { registration.dispose(); fixture.service.dispose() }
})
