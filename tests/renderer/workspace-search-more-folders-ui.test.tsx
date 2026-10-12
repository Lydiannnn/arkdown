import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { ContextWorkspaceSidebar } from '../../src/renderer/workspace/ContextWorkspaceSidebar'

function readableDocument(relativePath: string) {
  return {
    ok: true as const,
    value: {
      relativePath,
      markdown: 'needle',
      revision: 'a'.repeat(64),
      encoding: 'utf8' as const,
      newline: 'lf' as const,
      mtimeMs: 1,
    },
  }
}

it('pauses after direct-folder results and offers a descendant search button', async () => {
  const user = userEvent.setup()
  const listDirectory = vi.fn(async (relativePath: string) => ({
    ok: true as const,
    value: relativePath === ''
      ? [
          { name: 'root.md', relativePath: 'root.md', kind: 'document' as const },
          { name: 'nested', relativePath: 'nested', kind: 'directory' as const },
        ]
      : [{
          name: 'child.md',
          relativePath: 'nested/child.md',
          kind: 'document' as const,
        }],
  }))

  render(
    <ContextWorkspaceSidebar
      chooseWorkspace={vi.fn(async () => undefined)}
      currentDocument={null}
      isChoosing={false}
      listDirectory={listDirectory}
      markdown=""
      onCreateDocument={vi.fn(async () => true)}
      onOpenDocument={vi.fn()}
      onReloadDocument={vi.fn()}
      onRevealDocument={vi.fn()}
      onTrashDocument={vi.fn()}
      onWorkspaceMenuCommand={vi.fn(async () => undefined)}
      readDocument={vi.fn(async (relativePath: string) => readableDocument(relativePath))}
      refreshVersion={0}
      workspace={{ name: 'notes', absolutePath: 'C:\\notes' }}
      workspaceError={null}
    />,
  )

  await user.click(screen.getByRole('button', { name: '搜索工作区' }))
  await user.type(screen.getByRole('searchbox', { name: '搜索工作区' }), 'needle{Enter}')

  expect(await screen.findByRole('button', { name: /root\.md/ })).toBeVisible()
  expect(screen.getByRole('button', { name: '搜索更多层级文件夹' })).toBeVisible()
  expect(listDirectory).not.toHaveBeenCalledWith('nested')
})
