import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ContextWorkspaceSidebar } from '../../src/renderer/workspace/ContextWorkspaceSidebar'
import { WORKSPACE_ENTRY_MIME } from '../../src/renderer/workspace/workspace-drag'
import { TooltipProvider } from '../../src/renderer/tooltip/TooltipProvider'

const originalApi = window.arkdown
afterEach(() => { window.arkdown = originalApi })
function setup() {
  const start = vi.fn(async (_input: unknown) => ({ ok: true as const, value: undefined }))
  window.arkdown = { ...originalApi, startWorkspaceFileDrag: start } as typeof window.arkdown
  const open = vi.fn()
  render(<TooltipProvider><ContextWorkspaceSidebar workspace={{ name: 'notes', absolutePath: 'C:\\notes' }} chooseWorkspace={vi.fn()}
    currentDocument="saved.md" isChoosing={false} workspaceError={null} refreshVersion={0} markdown="unsaved editor text"
    listDirectory={async relativePath => ({ ok: true, value: relativePath ? [{ name: 'original.pdf', relativePath: 'folder/original.pdf', kind: 'document' }] : [
      { name: 'saved.md', relativePath: 'saved.md', kind: 'document' }, { name: 'folder', relativePath: 'folder', kind: 'directory' },
    ] })} readDocument={vi.fn()} onOpenDocument={open} onCreateDocument={vi.fn()} onReloadDocument={vi.fn()}
    onRevealDocument={vi.fn()} onTrashDocument={vi.fn()} onWorkspaceMenuCommand={vi.fn()} /></TooltipProvider>)
  return { start, open }
}
it('offers a separate accessible native handle without changing the row HTML drag or ordinary open', async () => {
  const { start, open } = setup()
  const row = await screen.findByRole('button', { name: 'saved.md' })
  const handle = screen.getByRole('button', { name: '拖出文件：saved.md' })
  expect(handle.closest('.tree-row')).toBeNull()
  expect(handle).toHaveAttribute('draggable', 'true')
  expect(handle).toHaveAttribute('data-tooltip', expect.stringContaining('已保存'))
  act(() => handle.focus())
  expect(handle).toHaveFocus()
  expect(await screen.findByRole('tooltip')).toHaveTextContent('未保存的修改不包含在内')
  expect(screen.queryByRole('button', { name: '拖出文件：folder' })).toBeNull()
  fireEvent.click(handle); fireEvent.keyDown(handle, { key: 'Enter' })
  expect(open).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled()
  const html = { setData: vi.fn(), effectAllowed: 'none' }
  fireEvent.dragStart(row, { dataTransfer: html })
  expect(html.setData).toHaveBeenCalledWith(WORKSPACE_ENTRY_MIME, expect.stringContaining('saved.md'))
  expect(html.effectAllowed).toBe('link')
  const native = { setData: vi.fn(), effectAllowed: 'none' }
  expect(fireEvent.dragStart(handle, { dataTransfer: native })).toBe(false)
  await waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith({ workspace: 'C:\\notes', relativePath: 'saved.md' }))
  expect(native.setData).not.toHaveBeenCalled()
  fireEvent.click(row); expect(open).toHaveBeenCalledExactlyOnceWith('saved.md')
  expect(screen.queryByRole('alert')).toBeNull()
})

it('keeps the original file path in nested conversion rows and explains a failed native start', async () => {
  const { start } = setup()
  fireEvent.click(await screen.findByRole('button', { name: 'folder' }))
  const handle = await screen.findByRole('button', { name: '拖出文件：original.pdf' })
  start.mockResolvedValueOnce({ ok: false, error: { code: 'FILE_NOT_FOUND', message: '文件已被移动或删除' } } as never)
  fireEvent.dragStart(handle, { dataTransfer: { setData: vi.fn() } })
  expect(await screen.findByRole('alert')).toHaveTextContent('文件已被移动或删除')
  expect(start).toHaveBeenCalledWith({ workspace: 'C:\\notes', relativePath: 'folder/original.pdf' })
})
