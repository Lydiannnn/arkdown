import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { act, render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { registerStickyNoteWindowIpc } from '../../src/main/ipc/register-ipc'
import { StickyNoteStore } from '../../src/main/sticky-notes/sticky-note-store'
import { AssetAccessRegistry } from '../../src/main/assets/asset-path'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { IPC_CHANNELS } from '../../src/shared/contracts'
import { StickyNoteWindowRoot } from '../../src/renderer/sticky-notes/StickyNoteWindowRoot'
import { stickyNoteApiStubs } from './sticky-note-api-stubs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const roots: string[] = []
const restorations: (() => void)[] = []
beforeAll(() => {
  const replace = (target: object, key: PropertyKey, value: unknown) => {
    const previous = Object.getOwnPropertyDescriptor(target, key)
    Object.defineProperty(target, key, { configurable: true, value })
    restorations.push(() => { if (previous) Object.defineProperty(target, key, previous); else Reflect.deleteProperty(target, key) })
  }
  replace(Range.prototype, 'getClientRects', () => [new DOMRect(0, 0, 80, 20)])
  replace(Range.prototype, 'getBoundingClientRect', () => new DOMRect(0, 0, 80, 20))
  replace(Element.prototype, 'getClientRects', () => [new DOMRect(0, 0, 80, 20)])
  replace(Element.prototype, 'scrollIntoView', () => undefined)
  replace(document, 'elementFromPoint', () => null)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterAll(() => { restorations.forEach((restore) => restore()); vi.unstubAllGlobals() })
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function noteWindow() {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-note-preview-'))
  roots.push(root)
  const store = new StickyNoteStore({ root })
  const note = await store.create({ name: 'Image note' })
  const source = path.join(root, 'source.png')
  await writeFile(source, png)
  const markdown = await store.copyImageResource(note.record.id, source)
  await store.writeMarkdown(note.record.id, markdown)
  type Handler = Parameters<Parameters<typeof registerStickyNoteWindowIpc>[0]['ipcMain']['handle']>[1]
  const handlers = new Map<string, Handler>()
  const mainFrame = {}
  const webContents = { id: 91, mainFrame }
  const registration = registerStickyNoteWindowIpc({
    ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
    window: { webContents },
    clipboardNoteId: note.record.id,
    stickyNoteDataRoot: root,
    stickyNotes: { read: (noteId: string) => store.get(noteId) } as never,
  })
  const invoke = async (channel: string, ...args: unknown[]) => await handlers.get(channel)?.({ sender: webContents, senderFrame: mainFrame }, ...args)
  const api = createArkdownApi(invoke)
  return { root, store, noteId: note.record.id, markdown, api, invoke, handlers, mainFrame, registration }
}

it('renders relative note images through the real root, editor and managed asset view', async () => {
  const fixture = await noteWindow()
  window.arkdown = { ...stickyNoteApiStubs, readStickyNote: fixture.api.readStickyNote } as unknown as typeof window.arkdown
  const mounted = render(<StickyNoteWindowRoot noteId={fixture.noteId} />)
  try {
    const image = await waitFor(() => {
      const candidate = mounted.container.querySelector<HTMLImageElement>('.sticky-note-editor .arkdown-local-image > img')
      expect(candidate).not.toBeNull()
      return candidate!
    }, { timeout: 10_000 })
    expect(image.src).toMatch(/^arkdown-asset:\/\/external\//u)
    const source = await new AssetAccessRegistry().resolve(image.src)
    expect(source).toContain(path.join('notes', 'active', fixture.noteId, 'resources'))
    expect(await readFile(source)).toEqual(png)
    expect((await fixture.store.get(fixture.noteId)).markdown).toBe(fixture.markdown)
    expect(fixture.markdown).toMatch(/^!\[\]\(resources\//u)
  } finally {
    mounted.unmount()
    await act(async () => { await Promise.resolve() })
    fixture.registration.dispose()
  }
}, 15_000)

it('derives the owning note base from its current persisted identity after rename and archive/restore', async () => {
  const fixture = await noteWindow()
  try {
    const readBase = async () => {
      const result = await fixture.api.readStickyNote(fixture.noteId)
      if (!result.ok) throw new Error(result.error.code)
      return result.value.documentAbsolutePath
    }
    expect(await readBase()).toBe(path.join(fixture.root, 'notes', 'active', fixture.noteId, 'Image note.md'))
    await fixture.store.rename(fixture.noteId, 'Renamed')
    expect(await readBase()).toBe(path.join(fixture.root, 'notes', 'active', fixture.noteId, 'Renamed.md'))
    await fixture.store.archive(fixture.noteId)
    expect(await readBase()).toBe(path.join(fixture.root, 'notes', 'archive', fixture.noteId, 'Renamed.md'))
    await fixture.store.restore(fixture.noteId)
    expect(await readBase()).toBe(path.join(fixture.root, 'notes', 'active', fixture.noteId, 'Renamed.md'))
    const other = await fixture.store.create({ name: 'Other' })
    await expect(fixture.api.readStickyNote(other.record.id)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    await expect(fixture.invoke(IPC_CHANNELS.readStickyNote, { noteId: fixture.noteId, documentAbsolutePath: 'C:\\outside\\note.md' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    await expect(fixture.handlers.get(IPC_CHANNELS.readStickyNote)?.({ sender: { id: 999 }, senderFrame: fixture.mainFrame }, { noteId: fixture.noteId }))
      .resolves.toMatchObject({ ok: false })
    expect(Object.keys(await fixture.store.get(fixture.noteId)).sort()).toEqual(['markdown', 'record'])
  } finally { fixture.registration.dispose() }
})
