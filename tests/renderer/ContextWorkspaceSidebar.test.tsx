import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { ContextMenuProvider } from '../../src/renderer/context-menu/ContextMenuProvider'
import { ContextWorkspaceSidebar } from '../../src/renderer/workspace/ContextWorkspaceSidebar'

it('opens search from a native command without consuming replayed builtin keys', () => {
  let command: (value: string) => void = () => {}
  const originalApi = window.arkdown
  const detach = vi.fn()
  window.arkdown = { onMenuCommand: (listener: (value: string) => void) => { command = listener; return detach } } as never
  const view = render(<ContextWorkspaceSidebar chooseWorkspace={vi.fn()} currentDocument={null} isChoosing={false}
    listDirectory={vi.fn(async () => ({ ok: true as const, value: [] }))} markdown="" onCreateDocument={vi.fn()}
    onOpenDocument={vi.fn()} onReloadDocument={vi.fn()} onRevealDocument={vi.fn()} onTrashDocument={vi.fn()}
    onWorkspaceMenuCommand={vi.fn()} readDocument={vi.fn()} refreshVersion={0} workspace={null} workspaceError={null} />)
  try {
    fireEvent.keyDown(window, { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true })
    expect(screen.queryByRole('searchbox', { name: '搜索工作区' })).toBeNull()
    act(() => command('search-workspace'))
    expect(screen.getByRole('searchbox', { name: '搜索工作区' })).toBeVisible()
  } finally { view.unmount(); window.arkdown = originalApi }
  expect(detach).toHaveBeenCalled()
})

it('opens the custom document menu without triggering normal document open', async () => {
  const onOpenDocument = vi.fn()
  const onWorkspaceMenuCommand = vi.fn(async () => undefined)
  render(
    <ContextMenuProvider>
      <ContextWorkspaceSidebar
        chooseWorkspace={vi.fn(async () => undefined)}
        currentDocument={null}
        isChoosing={false}
        listDirectory={vi.fn(async () => ({
          ok: true as const,
          value: [{
            name: 'note.md',
            relativePath: 'note.md',
            kind: 'document' as const,
          }],
        }))}
        markdown=""
        onCreateDocument={vi.fn(async () => true)}
        onOpenDocument={onOpenDocument}
        onReloadDocument={vi.fn()}
        onRevealDocument={vi.fn()}
        onTrashDocument={vi.fn()}
        onWorkspaceMenuCommand={onWorkspaceMenuCommand}
        readDocument={vi.fn()}
        refreshVersion={0}
        workspace={{ name: 'notes', absolutePath: 'C:\\notes' }}
        workspaceError={null}
      />
    </ContextMenuProvider>,
  )

  const row = await screen.findByRole('button', { name: 'note.md' })
  fireEvent.contextMenu(row, { clientX: 80, clientY: 90 })

  expect(onOpenDocument).not.toHaveBeenCalled()
  expect(await screen.findByText('在新窗口中打开')).toBeInTheDocument()
  fireEvent.click(screen.getByText('创建副本'))
  await waitFor(() => expect(onWorkspaceMenuCommand).toHaveBeenCalledWith(
    'workspace-duplicate',
    expect.objectContaining({ relativePath: 'note.md', kind: 'document' }),
  ))
})


it('shows search before reload and restores the active tab when search closes', async () => {
  render(
    <ContextWorkspaceSidebar
      chooseWorkspace={vi.fn(async () => undefined)}
      currentDocument="note.md"
      isChoosing={false}
      listDirectory={vi.fn(async () => ({ ok: true as const, value: [] }))}
      markdown="# Note"
      onCreateDocument={vi.fn(async () => true)}
      onOpenDocument={vi.fn()}
      onReloadDocument={vi.fn()}
      onRevealDocument={vi.fn()}
      onTrashDocument={vi.fn()}
      onWorkspaceMenuCommand={vi.fn(async () => undefined)}
      readDocument={vi.fn()}
      refreshVersion={0}
      workspace={{ name: 'notes', absolutePath: 'C:\\notes' }}
      workspaceError={null}
    />,
  )
  const actions = screen.getByLabelText('文件操作')
  const search = screen.getByRole('button', { name: '搜索工作区' })
  const reload = screen.getByRole('button', { name: '从磁盘重新加载' })
  expect(Array.from(actions.querySelectorAll('button'))).toEqual([search, reload])
  expect(search.querySelector('.app-icon')).toBeInTheDocument()
  expect(reload.querySelector('.app-icon')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '搜索' })).not.toBeInTheDocument()

  fireEvent.keyDown(window, { key: 'p', ctrlKey: true })
  expect(screen.queryByRole('searchbox', { name: '搜索工作区' })).not.toBeInTheDocument()
  fireEvent.keyDown(window, { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true, altKey: true })
  expect(screen.queryByRole('searchbox', { name: '搜索工作区' })).not.toBeInTheDocument()
  fireEvent.keyDown(window, { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true })
  expect(screen.getByRole('searchbox', { name: '搜索工作区' })).toBeVisible()
  fireEvent.click(search)
  fireEvent.click(search)
  expect(screen.getByRole('searchbox', { name: '搜索工作区' })).toBeVisible()
  expect(search).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(search)
  expect(screen.queryByRole('searchbox', { name: '搜索工作区' })).not.toBeInTheDocument()
  expect(screen.queryByRole('navigation', { name: '侧边栏视图' })).toBeNull()
  expect(reload).toBeVisible()
  fireEvent.click(search)
  const emptyInput = screen.getByRole('searchbox', { name: '搜索工作区' })
  fireEvent.blur(emptyInput, { relatedTarget: screen.getByRole('button', { name: '搜索' }) })
  expect(emptyInput).toBeInTheDocument()
  fireEvent.change(emptyInput, { target: { value: 'kept query' } })
  fireEvent.blur(emptyInput, { relatedTarget: reload })
  expect(emptyInput).toBeInTheDocument()
  fireEvent.change(emptyInput, { target: { value: '  ' } })
  fireEvent.blur(emptyInput, { relatedTarget: reload })
  expect(screen.queryByRole('searchbox', { name: '搜索工作区' })).not.toBeInTheDocument()
  const user = userEvent.setup()
  await user.click(search)
  await waitFor(() => expect(screen.getByRole('searchbox', { name: '搜索工作区' })).toHaveFocus())
  await user.click(search)
  expect(screen.queryByRole('searchbox', { name: '搜索工作区' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '新建文档' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '打开文件位置' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '删除当前文档' })).not.toBeInTheDocument()
})

it('disables workspace navigation and file actions until a folder is selected', () => {
  render(
    <ContextWorkspaceSidebar
      chooseWorkspace={vi.fn(async () => undefined)}
      currentDocument={null}
      isChoosing={false}
      listDirectory={vi.fn(async () => ({ ok: true as const, value: [] }))}
      markdown=""
      onCreateDocument={vi.fn(async () => true)}
      onOpenDocument={vi.fn()}
      onReloadDocument={vi.fn()}
      onRevealDocument={vi.fn()}
      onTrashDocument={vi.fn()}
      onWorkspaceMenuCommand={vi.fn(async () => undefined)}
      readDocument={vi.fn()}
      refreshVersion={0}
      workspace={null}
      workspaceError={null}
    />,
  )

  expect(screen.getByRole('button', { name: '选择工作区' })).toBeEnabled()
  expect(screen.queryByText('点击上方选择工作区')).not.toBeInTheDocument()
  expect(document.querySelector('[data-workspace-empty-arrow]')).toBeNull()
  expect(screen.getByRole('button', { name: '搜索工作区' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '从磁盘重新加载' })).toBeDisabled()
  expect(screen.queryByRole('navigation', { name: '侧边栏视图' })).toBeNull()
  expect(screen.queryByRole('navigation', { name: '侧边栏视图' })).toBeNull()
  expect(screen.queryByRole('navigation', { name: '侧边栏视图' })).toBeNull()
})

it('keeps an empty selected root blank and still loads its documents normally', async () => {
  let finishRootLoad!: (result: {
    ok: true
    value: Array<{ name: string; relativePath: string; kind: 'document' }>
  }) => void
  const pendingRoot = new Promise<{
    ok: true
    value: Array<{ name: string; relativePath: string; kind: 'document' }>
  }>((resolve) => { finishRootLoad = resolve })
  const commonProps = {
    chooseWorkspace: vi.fn(async () => undefined),
    currentDocument: null,
    isChoosing: false,
    markdown: '',
    onCreateDocument: vi.fn(async () => true),
    onOpenDocument: vi.fn(),
    onReloadDocument: vi.fn(),
    onRevealDocument: vi.fn(),
    onTrashDocument: vi.fn(),
    onWorkspaceMenuCommand: vi.fn(async () => undefined),
    readDocument: vi.fn(),
    refreshVersion: 0,
    workspace: { name: 'notes', absolutePath: 'C:\\notes' },
    workspaceError: null,
  }
  const { rerender } = render(
    <ContextWorkspaceSidebar {...commonProps} listDirectory={() => pendingRoot} />,
  )

  expect(screen.queryByText('点击上方选择工作区')).not.toBeInTheDocument()
  finishRootLoad({ ok: true, value: [] })
  await waitFor(() => expect(screen.queryByText('正在加载…')).not.toBeInTheDocument())
  expect(screen.queryByText('点击上方选择工作区')).not.toBeInTheDocument()

  rerender(<ContextWorkspaceSidebar
    {...commonProps}
    listDirectory={vi.fn(async () => ({
      ok: true as const,
      value: [{ name: 'note.md', relativePath: 'note.md', kind: 'document' as const }],
    }))}
  />)
  expect(await screen.findByRole('button', { name: 'note.md' })).toBeVisible()
  expect(screen.queryByText('点击上方选择工作区')).not.toBeInTheDocument()
})

it('exits search from the gray cancel button and restores the previous tab', async () => {
  const user = userEvent.setup()
  render(
    <ContextWorkspaceSidebar
      chooseWorkspace={vi.fn(async () => undefined)}
      currentDocument={null}
      isChoosing={false}
      listDirectory={vi.fn(async () => ({ ok: true as const, value: [] }))}
      markdown=""
      onCreateDocument={vi.fn(async () => true)}
      onOpenDocument={vi.fn()}
      onReloadDocument={vi.fn()}
      onRevealDocument={vi.fn()}
      onTrashDocument={vi.fn()}
      onWorkspaceMenuCommand={vi.fn(async () => undefined)}
      readDocument={vi.fn()}
      refreshVersion={0}
      workspace={{ name: 'notes', absolutePath: 'C:\\notes' }}
      workspaceError={null}
    />,
  )

  await user.click(screen.getByRole('button', { name: '搜索工作区' }))
  const input = screen.getByRole('searchbox', { name: '搜索工作区' })
  await user.type(input, 'needle')
  await user.click(screen.getByRole('button', { name: '搜索' }))
  await user.click(await screen.findByRole('button', { name: '取消搜索' }))

  expect(screen.queryByRole('searchbox', { name: '搜索工作区' })).not.toBeInTheDocument()
  expect(screen.queryByRole('navigation', { name: '侧边栏视图' })).toBeNull()
})

it('lets workspace search consume Escape and restores focus to its trigger', async () => {
  const user = userEvent.setup()
  render(
    <ContextWorkspaceSidebar
      chooseWorkspace={vi.fn(async () => undefined)}
      currentDocument="note.md"
      isChoosing={false}
      listDirectory={vi.fn(async () => ({ ok: true as const, value: [] }))}
      markdown="# Note"
      onCreateDocument={vi.fn(async () => true)}
      onOpenDocument={vi.fn()}
      onReloadDocument={vi.fn()}
      onRevealDocument={vi.fn()}
      onTrashDocument={vi.fn()}
      onWorkspaceMenuCommand={vi.fn(async () => undefined)}
      readDocument={vi.fn()}
      refreshVersion={0}
      workspace={{ name: 'notes', absolutePath: 'C:\\notes' }}
      workspaceError={null}
    />,
  )

  const trigger = screen.getByRole('button', { name: '搜索工作区' })
  await user.click(trigger)
  const input = screen.getByRole('searchbox', { name: '搜索工作区' })
  expect(input).toHaveFocus()

  const dispatched = fireEvent.keyDown(window, { key: 'Escape' })

  expect(dispatched).toBe(false)
  expect(screen.queryByRole('searchbox', { name: '搜索工作区' })).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
})

it('keeps bounded search results while showing and dismissing the limit overlay', async () => {
  const user = userEvent.setup()
  const entries = [
    { name: 'hit.md', relativePath: 'hit.md', kind: 'document' as const },
    ...Array.from({ length: 500 }, (_, index) => ({
      name: `other-${index}.md`,
      relativePath: `other-${index}.md`,
      kind: 'document' as const,
    })),
  ]
  render(
    <ContextWorkspaceSidebar
      chooseWorkspace={vi.fn(async () => undefined)}
      currentDocument={null}
      isChoosing={false}
      listDirectory={vi.fn(async () => ({ ok: true as const, value: entries }))}
      markdown=""
      onCreateDocument={vi.fn(async () => true)}
      onOpenDocument={vi.fn()}
      onReloadDocument={vi.fn()}
      onRevealDocument={vi.fn()}
      onTrashDocument={vi.fn()}
      onWorkspaceMenuCommand={vi.fn(async () => undefined)}
      readDocument={vi.fn(async (relativePath: string) => ({
        ok: true as const,
        value: {
          relativePath,
          markdown: relativePath === 'hit.md' ? 'needle' : '',
          revision: 'a'.repeat(64),
          encoding: 'utf8' as const,
          newline: 'lf' as const,
          mtimeMs: 1,
        },
      }))}
      refreshVersion={0}
      workspace={{ name: 'notes', absolutePath: 'C:\\notes' }}
      workspaceError={null}
    />,
  )

  await user.click(screen.getByRole('button', { name: '搜索工作区' }))
  await user.type(screen.getByRole('searchbox', { name: '搜索工作区' }), 'needle{Enter}')

  const warning = await screen.findByRole('alertdialog', { name: '搜索范围过大' })
  expect(within(warning).getByText('文件超过500个，请缩小搜索范围')).toBeVisible()
  expect(screen.queryByRole('button', { name: /hit\.md/ })).toBeNull()

  const fullscreenExit = vi.fn()
  const lowerFullscreenOwner = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !event.defaultPrevented) fullscreenExit()
  }
  window.addEventListener('keydown', lowerFullscreenOwner)
  const dispatched = fireEvent.keyDown(window, { key: 'Escape' })
  window.removeEventListener('keydown', lowerFullscreenOwner)

  expect(dispatched).toBe(false)
  expect(fullscreenExit).not.toHaveBeenCalled()
  expect(warning.parentElement).toHaveAttribute('data-state', 'closing')
  await waitFor(() => {
    expect(screen.queryByRole('alertdialog', { name: '搜索范围过大' })).not.toBeInTheDocument()
  })
  const match = screen.getByRole('button', { name: /hit\.md/ })
  expect(match).toBeVisible()
  await waitFor(() => {
    expect(screen.getByRole('searchbox', { name: '搜索工作区' })).toHaveFocus()
  })
})
