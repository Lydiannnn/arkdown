import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ContextWorkspaceSidebar } from '../../src/renderer/workspace/ContextWorkspaceSidebar'

const seenKey = 'arkdown.workspace-intro-seen.v1'
beforeEach(() => {
  localStorage.removeItem(seenKey)
  let seen = false
  Object.defineProperty(window, 'arkdown', { configurable: true, value: {
    claimWorkspaceIntroduction: vi.fn(async () => {
      const showIntroduction = !seen
      seen = true
      return { ok: true, value: { showIntroduction } }
    }),
  } })
})
function mountSidebar(chooseWorkspace = vi.fn(async () => undefined)) {
  return { chooseWorkspace, ...render(<ContextWorkspaceSidebar
    workspace={null} chooseWorkspace={chooseWorkspace} workspaceError={null} isChoosing={false}
    listDirectory={vi.fn(async () => ({ ok: true as const, value: [] }))} readDocument={vi.fn()}
    markdown="" currentDocument={null} refreshVersion={0} onOpenDocument={vi.fn()}
    onCreateDocument={vi.fn()} onReloadDocument={vi.fn()} onRevealDocument={vi.fn()}
    onTrashDocument={vi.fn()} onWorkspaceMenuCommand={vi.fn()}
  />) }
}

it('explains the first picker click and opens the picker only after confirmation', async () => {
  const { chooseWorkspace, unmount } = mountSidebar()
  fireEvent.click(screen.getByRole('button', { name: '选择工作区' }))
  expect(await screen.findByRole('dialog', { name: '让文档出现在这里' })).toBeVisible()
  expect(screen.getByText('选一个文档文件夹，里面的文档就会显示在左侧文件树中。')).toBeVisible()
  expect(chooseWorkspace).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '好的' }))
  await waitFor(() => expect(chooseWorkspace).toHaveBeenCalledOnce())
  unmount()
  mountSidebar(chooseWorkspace)
  fireEvent.click(screen.getByRole('button', { name: '选择工作区' }))
  await waitFor(() => expect(chooseWorkspace).toHaveBeenCalledTimes(2))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('dismisses with Escape, restores focus and does not repeat the introduction', async () => {
  const { chooseWorkspace } = mountSidebar()
  const trigger = screen.getByRole('button', { name: '选择工作区' })
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = await screen.findByRole('dialog')
  fireEvent.keyDown(dialog, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(trigger).toHaveFocus()
  expect(chooseWorkspace).not.toHaveBeenCalled()
  fireEvent.click(trigger)
  expect(chooseWorkspace).toHaveBeenCalledOnce()
})
