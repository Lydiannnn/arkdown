import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceNameDialog } from '../../src/renderer/workspace/WorkspaceNameDialog'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

describe('WorkspaceNameDialog', () => {
  it('keeps one submission locked through a successful close animation', async () => {
    vi.useFakeTimers()
    try {
      const pending = deferred<string | null>()
      const onSubmit = vi.fn(() => pending.promise)
      const onCancel = vi.fn()
      render(
        <WorkspaceNameDialog
          confirmLabel="创建"
          initialValue="新建文件夹"
          onCancel={onCancel}
          onSubmit={onSubmit}
          title="新建文件夹"
        />,
      )
      const dialog = screen.getByRole('dialog', { name: '新建文件夹' })

      fireEvent.submit(dialog)
      fireEvent.submit(dialog)
      expect(onSubmit).toHaveBeenCalledOnce()

      await act(async () => {
        pending.resolve(null)
        await pending.promise
      })
      expect(dialog.parentElement).toHaveAttribute('data-state', 'closing')

      fireEvent.keyDown(screen.getByRole('textbox', { name: '名称' }), { key: 'Enter' })
      fireEvent.submit(dialog)
      expect(onSubmit).toHaveBeenCalledOnce()

      act(() => { vi.advanceTimersByTime(120) })
      expect(onCancel).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
