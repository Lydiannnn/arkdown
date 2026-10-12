import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { WorkspaceSidebar } from '../../src/renderer/workspace/WorkspaceSidebar'

function renderSidebar() {
  render(<WorkspaceSidebar
    chooseWorkspace={vi.fn()}
    currentDocument="docs/guide.md"
    isChoosing={false}
    listDirectory={vi.fn(async (relativePath: string) => ({
      ok: true as const,
      value: relativePath === ''
        ? [
            { name: 'docs', relativePath: 'docs', kind: 'directory' as const },
            { name: 'root.md', relativePath: 'root.md', kind: 'document' as const },
          ]
        : [{ name: 'guide.md', relativePath: 'docs/guide.md', kind: 'document' as const }],
    }))}
    markdown={'# Title\n\n## Section'}
    onCreateDocument={vi.fn(async () => true)}
    onOpenDocument={vi.fn()}
    onReloadDocument={vi.fn()}
    onRevealDocument={vi.fn()}
    onTrashDocument={vi.fn()}
    readDocument={vi.fn()}
    refreshVersion={0}
    workspace={{ name: 'Notes', absolutePath: 'C:/Notes' }}
    workspaceError={null}
  />)
}

it('switches among outline, document list, file tree, and quick open by Typora shortcuts', async () => {
  const user = userEvent.setup()
  renderSidebar()

  await user.keyboard('{Control>}{Shift>}2{/Shift}{/Control}')
  expect(await screen.findByRole('button', { name: /guide\.md.*docs\/guide\.md/ })).toBeVisible()

  await user.keyboard('{Control>}{Shift>}1{/Shift}{/Control}')
  expect(screen.getByRole('button', { name: 'Title' })).toBeVisible()

  await user.keyboard('{Control>}{Shift>}3{/Shift}{/Control}')
  expect(await screen.findByRole('button', { name: 'root.md' })).toBeVisible()

  await user.keyboard('{Control>}p{/Control}')
  expect(screen.getByRole('searchbox', { name: '搜索工作区' })).toHaveFocus()
})
