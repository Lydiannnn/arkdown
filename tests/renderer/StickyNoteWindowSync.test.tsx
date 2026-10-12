import { readFileSync } from 'node:fs'
import path from 'node:path'
import { render, screen, waitFor } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { StickyNoteWindowRoot } from '../../src/renderer/sticky-notes/StickyNoteWindowRoot'
import { stickyNoteApiStubs } from './sticky-note-api-stubs'

vi.mock('../../src/renderer/sticky-notes/StickyNoteEditor', () => ({
  StickyNoteEditor: forwardRef(function Editor({ markdown }: { markdown: string }, ref) {
    useImperativeHandle(ref, () => ({ flush: () => markdown }))
    return <div className="sticky-note-editor"><textarea aria-label="便签内容" className="ProseMirror" defaultValue={markdown} /></div>
  }),
}))

const stickyNoteStyle = globalThis.document.createElement('style')
stickyNoteStyle.textContent = readFileSync(
  path.join(process.cwd(), 'src/renderer/sticky-notes/sticky-note-window.css'),
  'utf8',
)

beforeAll(() => globalThis.document.head.append(stickyNoteStyle))
afterAll(() => stickyNoteStyle.remove())

const NOTE_ID = '00000000-0000-4000-8000-000000000001'
const document = {
  record: {
    id: NOTE_ID, name: '旧名称', status: 'active' as const,
    markdownRelativePath: `active/${NOTE_ID}/旧名称.md`, resourcesRelativePath: `active/${NOTE_ID}/resources`,
    style: { mode: 'preset' as const, colorPresetId: 'yellow', texturePresetId: 'plain' },
    createdAt: '2026-08-02T03:00:00.000Z', updatedAt: '2026-08-02T03:00:00.000Z', archivedAt: null,
    released: true, pinned: false, windowBounds: null, lastOpenedAt: null, fontSizePx: 13, lineSpacingMode: 'compact',
  }, markdown: '编辑器内容',
}

it('applies newer window synchronization events without reloading the editor or moving its value backwards', async () => {
  const handlers: Array<(event: import('../../src/shared/sticky-notes').StickyNoteEvent) => void> = []
  const readStickyNote = vi.fn(async () => ({ ok: true as const, value: document }))
  window.arkdown = {
    ...stickyNoteApiStubs, readStickyNote,
    onStickyNoteEvent: vi.fn((handler) => { handlers.push(handler); return () => undefined }),
  } as unknown as typeof window.arkdown

  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)
  await screen.findByRole('heading', { name: '旧名称' })
  await waitFor(() => expect(globalThis.document.title).toBe('旧名称 — Arknote'))
  handlers[0]?.({ type: 'note-name-changed', noteId: NOTE_ID, revision: 2, name: '新名称' } as never)
  await screen.findByRole('heading', { name: '新名称' })
  await waitFor(() => expect(globalThis.document.title).toBe('新名称 — Arknote'))
  handlers[0]?.({ type: 'note-name-changed', noteId: NOTE_ID, revision: 1, name: '过期名称' } as never)

  await waitFor(() => expect(screen.getByRole('heading')).toHaveTextContent('新名称'))
  expect(screen.getByRole('textbox', { name: '便签内容' })).toHaveValue('编辑器内容')
  expect(readStickyNote).toHaveBeenCalledTimes(1)
})


function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

it('replays a newer event received before the initial note snapshot resolves', async () => {
  const read = deferred<{ ok: true; value: typeof document }>()
  const handlers: Array<(event: import('../../src/shared/sticky-notes').StickyNoteEvent) => void> = []
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(() => read.promise),
    onStickyNoteEvent: vi.fn((handler) => { handlers.push(handler); return () => undefined }),
  } as unknown as typeof window.arkdown

  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)
  handlers[0]?.({ type: 'note-name-changed', noteId: NOTE_ID, revision: 4, name: '事件新名称' } as never)
  read.resolve({ ok: true, value: document })

  expect(await screen.findByRole('heading', { name: '事件新名称' })).toBeVisible()
})

it('ignores legacy window-state updates after revisioned display state exists', async () => {
  const handlers: Array<(event: import('../../src/shared/sticky-notes').StickyNoteEvent) => void> = []
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: document })),
    onStickyNoteEvent: vi.fn((handler) => { handlers.push(handler); return () => undefined }),
  } as unknown as typeof window.arkdown

  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)
  await screen.findByRole('heading', { name: '旧名称' })
  handlers[0]?.({ type: 'note-display-state-changed', noteId: NOTE_ID, revision: 3, displayed: true, pinned: false } as never)
  handlers[0]?.({ type: 'window-state', noteId: NOTE_ID, open: true, pinned: true })

  await waitFor(() => expect(screen.getByRole('button', { name: '置顶便签' })).toHaveAttribute('aria-pressed', 'false'))
})

it('updates the note font CSS variable in place from a newer font event', async () => {
  const handlers: Array<(event: import('../../src/shared/sticky-notes').StickyNoteEvent) => void> = []
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: document })),
    onStickyNoteEvent: vi.fn((handler) => { handlers.push(handler); return () => undefined }),
  } as unknown as typeof window.arkdown

  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)
  await screen.findByRole('heading', { name: '旧名称' })
  handlers[0]?.({ type: 'note-font-size-changed', noteId: NOTE_ID, revision: 5, fontSizePx: 16 } as never)

  await waitFor(() => expect(globalThis.document.querySelector('[data-surface="sticky-note"]')).toHaveStyle('--sticky-note-font-size: 16px'))
})


it('applies a font revision to the rendered editor content without remounting it', async () => {
  const handlers: Array<(event: import('../../src/shared/sticky-notes').StickyNoteEvent) => void> = []
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: document })),
    onStickyNoteEvent: vi.fn((handler) => { handlers.push(handler); return () => undefined }),
  } as unknown as typeof window.arkdown

  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)
  const editor = await screen.findByRole('textbox', { name: '便签内容' })
  handlers[0]?.({ type: 'note-font-size-changed', noteId: NOTE_ID, revision: 6, fontSizePx: 16 } as never)

  await waitFor(() => expect(globalThis.getComputedStyle(editor).fontSize).toBe('var(--sticky-note-font-size, 14px)'))
  expect(globalThis.document.querySelector('[data-surface="sticky-note"]')).toHaveStyle('--sticky-note-font-size: 16px')
  expect(screen.getByRole('textbox', { name: '便签内容' })).toBe(editor)
})

it('applies a newer line-spacing revision in place without reloading the editor', async () => {
  const handlers: Array<(event: import('../../src/shared/sticky-notes').StickyNoteEvent) => void> = []
  const readStickyNote = vi.fn(async () => ({ ok: true as const, value: document }))
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote,
    onStickyNoteEvent: vi.fn((handler) => { handlers.push(handler); return () => undefined }),
  } as unknown as typeof window.arkdown

  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)
  const editor = await screen.findByRole('textbox', { name: '便签内容' })
  expect(screen.getByRole('main')).toHaveAttribute('data-line-spacing-mode', 'compact')

  handlers[0]?.({
    type: 'note-line-spacing-changed', noteId: NOTE_ID, revision: 7,
    lineSpacingMode: 'standard',
  })

  await waitFor(() => expect(screen.getByRole('main')).toHaveAttribute(
    'data-line-spacing-mode', 'standard',
  ))
  expect(screen.getByRole('textbox', { name: '便签内容' })).toBe(editor)
  expect(readStickyNote).toHaveBeenCalledTimes(1)
})
