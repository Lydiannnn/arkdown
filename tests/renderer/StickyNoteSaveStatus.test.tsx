import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { StickyNoteSaveStatus } from '../../src/renderer/sticky-notes/StickyNoteSaveStatus'

it('shows idle, saving, saved and actionable error states', () => {
  const { rerender } = render(<StickyNoteSaveStatus state={{ status: 'idle' }} />)
  expect(screen.queryByRole('status')).toBeNull()

  rerender(<StickyNoteSaveStatus state={{ status: 'saving', revision: 1 }} />)
  expect(screen.queryByRole('status')).toBeNull()

  rerender(<StickyNoteSaveStatus
    state={{ status: 'saved', revision: 1, savedAt: '2026-07-31T03:00:00.000Z' }}
  />)
  expect(screen.queryByRole('status')).toBeNull()

  const retry = vi.fn()
  const cancelClose = vi.fn()
  rerender(<StickyNoteSaveStatus
    onCancelClose={cancelClose}
    onRetry={retry}
    state={{ status: 'error', revision: 2, message: '磁盘已满' }}
  />)
  expect(screen.getByRole('alert')).toHaveTextContent('保存失败：磁盘已满')
  screen.getByRole('button', { name: '重试' }).click()
  screen.getByRole('button', { name: '取消关闭' }).click()
  expect(retry).toHaveBeenCalled()
  expect(cancelClose).toHaveBeenCalled()
})
