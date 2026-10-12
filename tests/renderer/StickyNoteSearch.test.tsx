import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { ArkdownApi, StickyNoteSearchResult } from '../../src/shared/contracts'
import { StickyNoteSearch } from '../../src/renderer/sticky-notes/StickyNoteSearch'
import { stickyNoteApiStubs } from './sticky-note-api-stubs'

const activeResult: StickyNoteSearchResult = {
  noteId: '10000000-0000-4000-8000-000000000001',
  name: '开发计划',
  excerpt: '这里命中了搜索词',
  archivedAt: null,
}

it('searches only the selected status and opens the chosen result', async () => {
  const select = vi.fn()
  const searchStickyNotes = vi.fn(async () => ({
    ok: true as const,
    value: [activeResult],
  }))
  window.arkdown = {
    ...stickyNoteApiStubs,
    searchStickyNotes,
  } as unknown as ArkdownApi

  render(<StickyNoteSearch onClose={vi.fn()} onSelect={select} status="active" />)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '搜索词' } })

  expect(await screen.findByRole('button', { name: /开发计划/ })).toBeVisible()
  expect(searchStickyNotes).toHaveBeenCalledWith('active', '搜索词')
  fireEvent.click(screen.getByRole('button', { name: /开发计划/ }))
  expect(select).toHaveBeenCalledWith(activeResult, '搜索词')
})

it('ignores stale results after the status changes and shows archive dates', async () => {
  let resolveActive!: (value: { ok: true; value: StickyNoteSearchResult[] }) => void
  const activeRequest = new Promise<{ ok: true; value: StickyNoteSearchResult[] }>((resolve) => {
    resolveActive = resolve
  })
  const archivedResult = {
    ...activeResult,
    noteId: '10000000-0000-4000-8000-000000000002',
    name: '归档计划',
    archivedAt: '2026-07-30T00:00:00.000Z',
  }
  window.arkdown = {
    ...stickyNoteApiStubs,
    searchStickyNotes: vi.fn((status) => status === 'active'
      ? activeRequest
      : Promise.resolve({ ok: true as const, value: [archivedResult] })),
  } as unknown as ArkdownApi

  const { rerender } = render(
    <StickyNoteSearch onClose={vi.fn()} onSelect={vi.fn()} status="active" />,
  )
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '计划' } })
  rerender(<StickyNoteSearch onClose={vi.fn()} onSelect={vi.fn()} status="archived" />)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '归档' } })
  resolveActive({ ok: true, value: [activeResult] })

  expect(await screen.findByRole('button', { name: /归档计划/ })).toBeVisible()
  expect(screen.getByText(/2026/)).toBeVisible()
  await waitFor(() => expect(screen.queryByRole('button', { name: /开发计划/ }))
    .not.toBeInTheDocument())
})
