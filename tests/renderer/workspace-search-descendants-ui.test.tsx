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

it('searches all descendant folders only after the continuation button is clicked', async () => {
  const user = userEvent.setup()
  let releaseNested = () => {}
  const nestedGate = new Promise<void>((resolve) => { releaseNested = resolve })
  const listDirectory = vi.fn(async (relativePath: string) => {
    if (relativePath === '') {
      return {
        ok: true as const,
        value: [
          { name: 'root.md', relativePath: 'root.md', kind: 'document' as const },
          { name: 'nested', relativePath: 'nested', kind: 'directory' as const },
        ],
      }
    }
    if (relativePath === 'nested') {
      await nestedGate
      return {
        ok: true as const,
        value: [
          {
            name: 'child.md',
            relativePath: 'nested/child.md',
            kind: 'document' as const,
          },
          {
            name: 'deep',
            relativePath: 'nested/deep',
            kind: 'directory' as const,
          },
        ],
      }
    }
    return {
      ok: true as const,
      value: [{
        name: 'grandchild.md',
        relativePath: 'nested/deep/grandchild.md',
        kind: 'document' as const,
      }],
    }
  })

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
  await user.click(await screen.findByRole('button', { name: '搜索更多层级文件夹' }))

  expect(screen.getByRole('button', { name: '正在搜索更多层级文件夹…' })).toBeDisabled()
  expect(listDirectory).not.toHaveBeenCalledWith('nested/deep')
  releaseNested()

  expect(await screen.findByRole('button', { name: /nested\/child\.md/ })).toBeVisible()
  expect(await screen.findByRole('button', { name: /nested\/deep\/grandchild\.md/ })).toBeVisible()
  expect(screen.queryByRole('button', { name: '搜索更多层级文件夹' })).toBeNull()
})

it('keeps available matches while a failed descendant scope is retried', async () => {
  const user = userEvent.setup()
  let blockedAttempts = 0
  let releaseRetry = () => {}
  const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve })
  const listDirectory = vi.fn(async (relativePath: string) => {
    if (relativePath === '') {
      return {
        ok: true as const,
        value: [
          { name: 'root.md', relativePath: 'root.md', kind: 'document' as const },
          { name: 'available', relativePath: 'available', kind: 'directory' as const },
          { name: 'blocked', relativePath: 'blocked', kind: 'directory' as const },
        ],
      }
    }
    if (relativePath === 'available') {
      return {
        ok: true as const,
        value: [{
          name: 'existing.md',
          relativePath: 'available/existing.md',
          kind: 'document' as const,
        }],
      }
    }
    blockedAttempts += 1
    if (blockedAttempts === 1) {
      return {
        ok: false as const,
        error: { code: 'READ_FAILED', message: 'Unable to list directory' },
      }
    }
    await retryGate
    return {
      ok: true as const,
      value: [{
        name: 'child.md',
        relativePath: 'blocked/child.md',
        kind: 'document' as const,
      }],
    }
  })

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
  const rootMatch = await screen.findByRole('button', { name: /root\.md/ })
  await user.click(screen.getByRole('button', { name: '搜索更多层级文件夹' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('1 个文件夹无法搜索，结果可能不完整')
  expect(rootMatch).toBeVisible()
  const existingDescendant = screen.getByRole('button', { name: /available\/existing\.md/ })

  await user.click(screen.getByRole('button', { name: '搜索' }))

  expect(rootMatch).toBeVisible()
  expect(existingDescendant).toBeVisible()
  releaseRetry()
  expect(await screen.findByRole('button', { name: /blocked\/child\.md/ })).toBeVisible()
  expect(screen.queryByRole('alert')).toBeNull()
})
