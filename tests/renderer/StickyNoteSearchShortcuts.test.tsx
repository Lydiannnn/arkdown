import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { ArkdownApi } from '../../src/shared/contracts'
import { StickyNoteBoxPanel } from '../../src/renderer/sticky-notes/StickyNoteBoxPanel'
import { stickyNoteApiStubs } from './sticky-note-api-stubs'

it('toggles Ctrl+F search inside the box and closes it when switching views', async () => {
  window.arkdown = {
    ...stickyNoteApiStubs,
    listStickyNotes: vi.fn(async () => ({ ok: true as const, value: [] })),
    searchStickyNotes: vi.fn(async () => ({ ok: true as const, value: [] })),
  } as unknown as ArkdownApi
  render(<StickyNoteBoxPanel onClose={vi.fn()} />)
  const panel = screen.getByRole('complementary', { name: '便签盒子' })

  fireEvent.keyDown(panel, { key: 'f', ctrlKey: true })
  expect(screen.getByRole('searchbox')).toBeVisible()

  fireEvent.keyDown(panel, { key: 'f', ctrlKey: true })
  expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()

  fireEvent.keyDown(panel, { key: 'f', ctrlKey: true })
  fireEvent.click(screen.getByRole('tab', { name: '归档' }))
  expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
})
