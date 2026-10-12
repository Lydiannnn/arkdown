import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RequiredUpdateDialog, RequiredUpdateGate } from '../../src/renderer/updates/RequiredUpdateDialog'
const candidate = { version: '1.0.5', mode: 'required' as const, required: true, message: '<script>not executable</script>' }
afterEach(() => vi.restoreAllMocks())
it.each(['escape', 'button', 'x'])('requests protected exit via %s without backdrop dismissal', async method => {
  const exit = vi.fn(), open = vi.fn(); render(<RequiredUpdateDialog candidate={candidate} onExit={exit} onOpenWebsite={open} onProtectWork={() => {}} />)
  const dialog = screen.getByRole('alertdialog'); expect(dialog).toHaveTextContent('<script>not executable</script>'); expect(dialog.querySelector('script')).toBeNull()
  expect(screen.getByRole('button', { name: '前往官网' })).toHaveClass('arkdown-dialog__primary')
  fireEvent.mouseDown(dialog.parentElement!); expect(exit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '前往官网' })); expect(open).toHaveBeenCalledOnce(); expect(exit).not.toHaveBeenCalled()
  if (method === 'escape') fireEvent.keyDown(window, { key: 'Escape' })
  else fireEvent.click(screen.getByRole('button', { name: method === 'x' ? '关闭更新提醒并退出 Arkdown' : '关闭 Arkdown' }))
  await waitFor(() => expect(exit).toHaveBeenCalledOnce())
})
it('offers explicit work protection and defers behind another dialog or IME composition', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const existing = document.createElement('div'); existing.setAttribute('aria-modal', 'true'); document.body.append(existing)
  const protect = vi.fn(); const props = { candidate, onExit: vi.fn(), onOpenWebsite: vi.fn(), onProtectWork: protect, canProtect: true }
  const result = render(<RequiredUpdateGate active={false} {...props} />)
  fireEvent.compositionStart(document); result.rerender(<RequiredUpdateGate active {...props} />)
  existing.remove(); await act(async () => { await new Promise(r => setTimeout(r, 300)) }); expect(screen.queryByRole('alertdialog')).toBeNull()
  fireEvent.compositionEnd(document); await waitFor(() => expect(screen.getByRole('alertdialog')).toBeVisible())
  fireEvent.click(screen.getByRole('button', { name: '处理未保存内容' })); expect(protect).toHaveBeenCalledOnce()
})
