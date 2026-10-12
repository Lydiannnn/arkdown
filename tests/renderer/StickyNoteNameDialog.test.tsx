import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { StickyNoteNameDialog } from '../../src/renderer/sticky-notes/StickyNoteNameDialog'

describe('StickyNoteNameDialog', () => {
  function EscapeHarness() {
    const [open, setOpen] = useState(false)
    return <>
      <button onClick={() => setOpen(true)} type="button">Open rename</button>
      {open && <StickyNoteNameDialog
        existingNames={[]}
        initialValue="Note"
        onCancel={() => setOpen(false)}
        onSubmit={async () => null}
        title="Rename note"
      />}
    </>
  }

  it('uses the proposed name and submits with Enter', async () => {
    const onSubmit = vi.fn(async () => null)
    render(
      <StickyNoteNameDialog
        existingNames={[]}
        initialValue="便签260731-壹"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
        title="创建新便签"
      />,
    )
    const input = screen.getByRole('textbox', { name: '便签名' })
    expect(input).toHaveValue('便签260731-壹')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('便签260731-壹'))
  })

  it('keeps a successful Enter submission locked throughout the close animation', async () => {
    vi.useFakeTimers()
    try {
      const onSubmit = vi.fn(async () => null)
      const onCancel = vi.fn()
      render(
        <StickyNoteNameDialog
          existingNames={[]}
          initialValue="便签"
          onCancel={onCancel}
          onSubmit={onSubmit}
          title="重命名便签"
        />,
      )
      const input = screen.getByRole('textbox', { name: '便签名' })

      fireEvent.keyDown(input, { key: 'Enter' })
      await act(async () => { await Promise.resolve() })
      expect(screen.getByRole('dialog').parentElement).toHaveAttribute('data-state', 'closing')

      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onSubmit).toHaveBeenCalledOnce()

      act(() => { vi.advanceTimersByTime(120) })
      expect(onCancel).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('disables cancellation while submission is pending and restores it after an error', async () => {
    let resolveSubmit!: (error: string | null) => void
    const onSubmit = vi.fn(() => new Promise<string | null>((resolve) => { resolveSubmit = resolve }))
    render(
      <StickyNoteNameDialog
        existingNames={[]}
        initialValue="新便签"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
        title="创建新便签"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    expect(onSubmit).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()

    await act(async () => { resolveSubmit('创建失败'); await Promise.resolve() })

    expect(await screen.findByText('创建失败')).toBeVisible()
    expect(screen.getByRole('button', { name: '取消' })).toBeEnabled()
  })

  it('ignores cancellation in the same tick that submission starts', async () => {
    vi.useFakeTimers()
    try {
      let resolveSubmit!: (error: string | null) => void
      const onSubmit = vi.fn(() => new Promise<string | null>((resolve) => { resolveSubmit = resolve }))
      const onCancel = vi.fn()
      render(
        <StickyNoteNameDialog
          existingNames={[]}
          initialValue="新便签"
          onCancel={onCancel}
          onSubmit={onSubmit}
          title="创建新便签"
        />,
      )
      const submit = screen.getByRole('button', { name: '创建' })
      const cancel = screen.getByRole('button', { name: '取消' })

      act(() => {
        submit.click()
        cancel.click()
        submit.click()
      })

      expect(onSubmit).toHaveBeenCalledOnce()
      expect(screen.getByRole('dialog').parentElement).toHaveAttribute('data-state', 'open')

      await act(async () => { resolveSubmit('创建失败'); await Promise.resolve() })
      act(() => { vi.advanceTimersByTime(120) })

      expect(onCancel).not.toHaveBeenCalled()
      expect(screen.getByRole('dialog')).toBeVisible()
      expect(screen.getByText('创建失败')).toBeVisible()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores Enter after cancellation starts and completes cancellation once', async () => {
    vi.useFakeTimers()
    try {
      const onSubmit = vi.fn(async () => null)
      const onCancel = vi.fn()
      render(
        <StickyNoteNameDialog
          existingNames={[]}
          initialValue="新便签"
          onCancel={onCancel}
          onSubmit={onSubmit}
          title="创建新便签"
        />,
      )
      const input = screen.getByRole('textbox', { name: '便签名' })

      fireEvent.click(screen.getByRole('button', { name: '取消' }))
      expect(screen.getByRole('dialog').parentElement).toHaveAttribute('data-state', 'closing')
      fireEvent.keyDown(input, { key: 'Enter' })
      await act(async () => { await Promise.resolve() })

      expect(onSubmit).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(120) })
      expect(onCancel).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels with Escape after the shared exit phase', async () => {
    const onCancel = vi.fn()
    render(
      <StickyNoteNameDialog
        existingNames={[]}
        initialValue="便签"
        onCancel={onCancel}
        onSubmit={vi.fn()}
        title="创建新便签"
      />,
    )
    fireEvent.keyDown(screen.getByRole('textbox', { name: '便签名' }), { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
  })

  it('owns window Escape after focus leaves the input and restores the opener', async () => {
    render(<EscapeHarness />)
    const opener = screen.getByRole('button', { name: 'Open rename' })
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'Rename note' })
    const confirm = screen.getByRole('button', { name: '创建' })
    confirm.focus()
    expect(confirm).toHaveFocus()

    const dispatched = fireEvent.keyDown(window, { key: 'Escape' })

    expect(dispatched).toBe(false)
    expect(dialog.parentElement).toHaveAttribute('data-state', 'closing')
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('removes its window Escape listener on unmount', () => {
    const onCancel = vi.fn()
    const view = render(
      <StickyNoteNameDialog
        existingNames={[]}
        initialValue="Note"
        onCancel={onCancel}
        onSubmit={async () => null}
        title="Rename note"
      />,
    )
    view.unmount()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onCancel).not.toHaveBeenCalled()
  })

  it('lets only the topmost production modal consume one Escape', async () => {
    const cancelFirst = vi.fn()
    const cancelSecond = vi.fn()
    render(<>
      <StickyNoteNameDialog
        existingNames={[]}
        initialValue="First"
        onCancel={cancelFirst}
        onSubmit={async () => null}
        title="First modal"
      />
      <StickyNoteNameDialog
        existingNames={[]}
        initialValue="Second"
        onCancel={cancelSecond}
        onSubmit={async () => null}
        title="Second modal"
      />
    </>)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(cancelFirst).not.toHaveBeenCalled()
    await waitFor(() => expect(cancelSecond).toHaveBeenCalledOnce())
  })

  it.each([
    ['', '便签名不能为空'],
    ['A/B', '便签名不能包含 Windows 文件名非法字符'],
    ['重复', '便签名已存在'],
  ])('rejects invalid name %s', async (value, message) => {
    const onSubmit = vi.fn(async () => null)
    render(
      <StickyNoteNameDialog
        existingNames={['重复']}
        initialValue={value}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
        title="创建新便签"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    expect(await screen.findByText(message)).toBeVisible()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('shows a server duplicate error and keeps the dialog open', async () => {
    render(
      <StickyNoteNameDialog
        existingNames={[]}
        initialValue="新便签"
        onCancel={vi.fn()}
        onSubmit={async () => '便签名已存在'}
        title="创建新便签"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    expect(await screen.findByText('便签名已存在')).toBeVisible()
    expect(screen.getByRole('dialog')).toBeVisible()
  })

  it('does not cancel when the naming dialog backdrop is pressed', () => {
    const onCancel = vi.fn()
    render(
      <StickyNoteNameDialog
        existingNames={[]}
        initialValue="便签"
        onCancel={onCancel}
        onSubmit={async () => null}
        title="创建新便签"
      />,
    )

    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)

    expect(onCancel).not.toHaveBeenCalled()
  })
})
