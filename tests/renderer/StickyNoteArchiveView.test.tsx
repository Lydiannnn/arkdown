import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { ArkdownApi, StickyNoteDocument, StickyNoteSummary } from '../../src/shared/contracts'
import { StickyNoteBoxPanel } from '../../src/renderer/sticky-notes/StickyNoteBoxPanel'
import { stickyNoteApiStubs } from './sticky-note-api-stubs'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

function archived(index: number, archivedAt: string): StickyNoteSummary {
  const id = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  return {
    record: {
      id,
      name: `归档便签${index}`,
      status: 'archived',
      markdownRelativePath: `archive/${id}/归档便签${index}.md`,
      resourcesRelativePath: `archive/${id}/resources`,
      style: { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
      background: { ...DEFAULT_BACKGROUND_SETTINGS },
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: archivedAt,
      archivedAt,
      released: false,
      pinned: false,
      windowBounds: null,
      lastOpenedAt: null,
      fontSizePx: 13,
      lineSpacingMode: 'compact',
    },
    excerpt: `内容 ${index}`,
  }
}

function installArchivedApi(notes: readonly StickyNoteSummary[]) {
  const openStickyNote = vi.fn()
  window.arkdown = {
    ...stickyNoteApiStubs,
    listStickyNotes: vi.fn(async (status) => ({
      ok: true as const,
      value: status === 'archived' ? [...notes] : [],
    })),
    readStickyNote: vi.fn(async (noteId) => {
      const note = notes.find(({ record }) => record.id === noteId) ?? notes[0]
      return {
        ok: true as const,
        value: {
          record: note.record,
          markdown: '# 只读归档',
        } satisfies StickyNoteDocument,
      }
    }),
    openStickyNote,
  } as unknown as ArkdownApi
  return { openStickyNote }
}

it('sorts archives newest first, selects on click, and opens preview only on double-click', async () => {
  const old = archived(1, '2026-07-30T00:00:00.000Z')
  const recent = archived(2, '2026-07-31T00:00:00.000Z')
  const { openStickyNote } = installArchivedApi([old, recent])

  render(<StickyNoteBoxPanel onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('tab', { name: '归档' }))

  const grid = await screen.findByRole('grid', { name: '归档便签' })
  expect(grid).toHaveAttribute('data-interaction-mode', 'archive')
  expect(within(grid).queryByRole('button', { name: '创建新便签' })).not.toBeInTheDocument()
  expect(within(grid).getAllByRole('button').map((button) => button.getAttribute('aria-label')))
    .toEqual(['归档便签2', '归档便签1'])

  const recentCard = within(grid).getByRole('button', { name: '归档便签2' })
  fireEvent.click(recentCard)
  expect(screen.queryByLabelText('归档便签预览')).not.toBeInTheDocument()
  expect(recentCard).toHaveAttribute('aria-selected', 'true')

  fireEvent.doubleClick(recentCard)
  expect(await screen.findByLabelText('归档便签预览')).toBeInTheDocument()
  expect(openStickyNote).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: '返回归档列表' }))
  await waitFor(() => expect(screen.getByRole('grid', { name: '归档便签' })).toBeVisible())
})

it('supports Ctrl toggle, Shift range, and blank clearing in displayed archive order', async () => {
  const notes = [
    archived(1, '2026-07-30T00:00:00.000Z'),
    archived(2, '2026-07-31T00:00:00.000Z'),
    archived(3, '2026-08-01T00:00:00.000Z'),
  ]
  installArchivedApi(notes)
  render(<StickyNoteBoxPanel onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('tab', { name: '归档' }))
  const grid = await screen.findByRole('grid', { name: '归档便签' })
  const content = grid.parentElement
  expect(content).toHaveClass('sticky-note-box-content')
  expect(content).toHaveAttribute('data-view', 'archived')
  const archiveHitArea = content?.querySelector<HTMLElement>(
    ':scope > .sticky-note-grid[data-interaction-mode="archive"]',
  )
  expect(archiveHitArea).toBe(grid)
  const cards = within(grid).getAllByRole('button')

  fireEvent.click(cards[0])
  fireEvent.click(cards[1], { ctrlKey: true })
  expect(cards[0]).toHaveAttribute('aria-selected', 'true')
  expect(cards[1]).toHaveAttribute('aria-selected', 'true')

  fireEvent.click(cards[0], { ctrlKey: true })
  expect(cards[0]).toHaveAttribute('aria-selected', 'false')
  expect(cards[1]).toHaveAttribute('aria-selected', 'true')

  fireEvent.click(cards[2], { shiftKey: true })
  expect(cards.map((card) => card.getAttribute('aria-selected'))).toEqual(['true', 'true', 'true'])

  fireEvent.pointerDown(archiveHitArea!, { pointerId: 4, clientX: 350, clientY: 250 })
  fireEvent.pointerUp(archiveHitArea!, { pointerId: 4, clientX: 350, clientY: 250 })
  expect(cards.map((card) => card.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false'])
})

it('applies Ctrl marquee against the pointerdown selection baseline using card DOMRects', async () => {
  const notes = [
    archived(1, '2026-07-30T00:00:00.000Z'),
    archived(2, '2026-07-31T00:00:00.000Z'),
    archived(3, '2026-08-01T00:00:00.000Z'),
  ]
  installArchivedApi(notes)
  render(<StickyNoteBoxPanel onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('tab', { name: '归档' }))
  const grid = await screen.findByRole('grid', { name: '归档便签' })
  const cards = within(grid).getAllByRole('button')
  Object.defineProperty(grid, 'setPointerCapture', { configurable: true, value: vi.fn() })
  Object.defineProperty(grid, 'releasePointerCapture', { configurable: true, value: vi.fn() })
  vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 300))
  vi.spyOn(cards[0], 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 20, 80, 80))
  vi.spyOn(cards[1], 'getBoundingClientRect').mockReturnValue(new DOMRect(120, 20, 80, 80))
  vi.spyOn(cards[2], 'getBoundingClientRect').mockReturnValue(new DOMRect(220, 20, 80, 80))

  fireEvent.click(cards[1])
  fireEvent.pointerDown(grid, { pointerId: 8, clientX: 110, clientY: 10, ctrlKey: true })
  fireEvent.pointerMove(grid, { pointerId: 8, clientX: 310, clientY: 110 })
  fireEvent.pointerUp(grid, { pointerId: 8, clientX: 310, clientY: 110 })

  expect(cards.map((card) => card.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true'])
})

it('clears archive selection on preview, search, and view transitions', async () => {
  const note = archived(1, '2026-07-30T00:00:00.000Z')
  installArchivedApi([note])
  render(<StickyNoteBoxPanel onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('tab', { name: '归档' }))
  let card = await screen.findByRole('button', { name: note.record.name })

  fireEvent.click(card)
  fireEvent.doubleClick(card)
  fireEvent.click(await screen.findByRole('button', { name: '返回归档列表' }))
  card = await screen.findByRole('button', { name: note.record.name })
  expect(card).toHaveAttribute('aria-selected', 'false')

  fireEvent.click(card)
  fireEvent.keyDown(screen.getByRole('complementary', { name: '便签盒子' }), { ctrlKey: true, key: 'f' })
  fireEvent.click(await screen.findByRole('button', { name: '关闭便签搜索' }))
  card = await screen.findByRole('button', { name: note.record.name })
  expect(card).toHaveAttribute('aria-selected', 'false')

  fireEvent.click(card)
  fireEvent.click(screen.getByRole('tab', { name: '便签' }))
  fireEvent.click(screen.getByRole('tab', { name: '归档' }))
  card = await screen.findByRole('button', { name: note.record.name })
  expect(card).toHaveAttribute('aria-selected', 'false')
})
