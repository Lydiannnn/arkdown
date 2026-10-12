import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { ArkdownApi, StickyNoteDocument } from '../../src/shared/contracts'
import { ArchivedStickyNotePreview } from '../../src/renderer/sticky-notes/ArchivedStickyNotePreview'
import { stickyNoteApiStubs } from './sticky-note-api-stubs'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const NOTE_ID = '10000000-0000-4000-8000-000000000001'
const document: StickyNoteDocument = {
  record: {
    id: NOTE_ID,
    name: '已归档计划',
    status: 'archived',
    markdownRelativePath: `archive/${NOTE_ID}/已归档计划.md`,
    resourcesRelativePath: `archive/${NOTE_ID}/resources`,
    style: { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
    background: { ...DEFAULT_BACKGROUND_SETTINGS },
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    archivedAt: '2026-07-31T00:00:00.000Z',
    released: false,
    pinned: false,
    windowBounds: null,
    lastOpenedAt: null,
    fontSizePx: 13,
    lineSpacingMode: 'compact',
  },
  markdown: '# 归档标题\n\n只读内容',
}

vi.mock('../../src/renderer/editor/VisualEditor', async () => {
  const React = await import('react')
  return {
    VisualEditor: React.forwardRef(function MockVisualEditor(
      props: { markdown: string; readOnly?: boolean; onChange(markdown: string): void },
      _ref,
    ) {
      return <article data-read-only={String(props.readOnly)}>{props.markdown}</article>
    }),
  }
})

it('loads an archived note into a read-only preview without save controls or writes', async () => {
  const close = vi.fn()
  const stageStickyNoteSave = vi.fn()
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: document })),
    stageStickyNoteSave,
  } as unknown as ArkdownApi

  render(<ArchivedStickyNotePreview noteId={NOTE_ID} onClose={close} />)

  expect(await screen.findByRole('heading', { name: '已归档计划' })).toBeVisible()
  expect(screen.getByText(/只读内容/)).toHaveAttribute('data-read-only', 'true')
  expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
  expect(screen.queryByText(/保存/)).not.toBeInTheDocument()
  expect(stageStickyNoteSave).not.toHaveBeenCalled()
  const surface = globalThis.document.querySelector('.archived-sticky-note-preview-surface')
  expect(surface).toHaveAttribute('data-line-spacing-mode', 'compact')
  expect(surface?.parentElement).not.toHaveAttribute('data-line-spacing-mode')

  fireEvent.click(screen.getByRole('button', { name: '返回归档列表' }))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
})

it('puts a persisted standard mode on the archived preview surface itself', async () => {
  const standardDocument: StickyNoteDocument = {
    ...document,
    record: { ...document.record, lineSpacingMode: 'standard' },
  }
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: standardDocument })),
  } as unknown as ArkdownApi

  render(<ArchivedStickyNotePreview noteId={NOTE_ID} onClose={vi.fn()} />)

  await waitFor(() => expect(
    globalThis.document.querySelector('.archived-sticky-note-preview-surface'),
  ).toHaveAttribute('data-line-spacing-mode', 'standard'))
  const surface = globalThis.document.querySelector('.archived-sticky-note-preview-surface')
  expect(surface).toHaveAttribute('data-line-spacing-mode', 'standard')
  expect(surface?.parentElement).not.toHaveAttribute('data-line-spacing-mode')
})

it('renders a material preview with an opaque fallback and no live pointer tracking', async () => {
  const materialDocument: StickyNoteDocument = {
    ...document,
    record: {
    ...document.record,
      style: { mode: 'material', materialPresetId: 'flowing-glass' },
    },
  }
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: materialDocument })),
  } as unknown as ArkdownApi

  render(<ArchivedStickyNotePreview noteId={NOTE_ID} onClose={vi.fn()} />)

  await screen.findByRole('heading', { name: '已归档计划' })
  const surface = globalThis.document.querySelector<HTMLElement>(
    '.archived-sticky-note-preview-surface',
  )!
  expect(surface).toHaveAttribute('data-material-preset', 'flowing-glass')
  expect(surface.style.getPropertyValue('--sticky-note-background-color')).toBe('#E9EEF2')
  expect(surface.style.getPropertyValue('--sticky-note-preview-background-color')).toBe('#E9EEF2')

  fireEvent.pointerMove(surface, { clientX: 80, clientY: 120 })
  expect(surface.style.getPropertyValue('--flowing-glass-pointer-x')).toBe('')
  expect(surface.style.getPropertyValue('--flowing-glass-pointer-y')).toBe('')
})
