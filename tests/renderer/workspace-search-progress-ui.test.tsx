import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { ContextWorkspaceSidebar } from '../../src/renderer/workspace/ContextWorkspaceSidebar'

it.each([false, true])('retains searched descendant hits after retrying current failures (nested failure: %s)', async (nestedFailure) => {
  const user = userEvent.setup()
  let recovered = false
  const entries = (paths: string[]) => paths.map((relativePath) => ({
    name: relativePath.split('/').at(-1)!, relativePath, kind: 'document' as const,
  }))
  render(<ContextWorkspaceSidebar
    chooseWorkspace={vi.fn(async () => undefined)} currentDocument={null} isChoosing={false}
    listDirectory={vi.fn(async (path: string) => ({
      ok: true as const,
      value: path === ''
        ? [...entries(['root.md']), { name: 'nested', relativePath: 'nested', kind: 'directory' as const }]
        : entries(['nested/child.md', 'nested/recover.md']),
    }))}
    markdown="" onCreateDocument={vi.fn(async () => true)} onOpenDocument={vi.fn()}
    onReloadDocument={vi.fn()} onRevealDocument={vi.fn()} onTrashDocument={vi.fn()}
    onWorkspaceMenuCommand={vi.fn(async () => undefined)}
    readDocument={vi.fn(async (relativePath: string) => {
      if (!recovered && (relativePath === 'root.md' || (nestedFailure && relativePath.endsWith('recover.md')))) {
        throw new Error('temporary read failure')
      }
      return { ok: true as const, value: {
        relativePath, markdown: 'needle', revision: 'a'.repeat(64),
        encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 1,
      } }
    })}
    refreshVersion={0} workspace={{ name: 'notes', absolutePath: 'C:\\notes' }} workspaceError={null}
  />)
  await user.click(screen.getByRole('button', { name: '搜索工作区' }))
  await user.type(screen.getByRole('searchbox', { name: '搜索工作区' }), 'needle{Enter}')
  await user.click(await screen.findByRole('button', { name: '搜索更多层级文件夹' }))
  expect(await screen.findByRole('button', { name: /nested\/child\.md/ })).toBeVisible()
  await screen.findByRole('alert')
  recovered = true
  await user.click(screen.getByRole('button', { name: '搜索' }))
  expect(await screen.findByRole('button', { name: /root\.md/ })).toBeVisible()
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(screen.getByRole('button', { name: /nested\/child\.md/ })).toBeVisible()
  expect(screen.getByRole('button', { name: /nested\/recover\.md/ })).toBeVisible()
  expect(screen.queryByRole('button', { name: '搜索更多层级文件夹' })).toBeNull()
})

it('keeps current-folder results visible while requested descendant folders are scanning', async () => {
  const user = userEvent.setup()
  let releaseNested = () => {}
  let markNestedStarted = () => {}
  const nestedGate = new Promise<void>((resolve) => { releaseNested = resolve })
  const nestedStarted = new Promise<void>((resolve) => { markNestedStarted = resolve })

  render(
    <ContextWorkspaceSidebar
      chooseWorkspace={vi.fn(async () => undefined)}
      currentDocument={null}
      isChoosing={false}
      listDirectory={vi.fn(async (relativePath: string) => {
        if (relativePath === '') {
          return {
            ok: true as const,
            value: [
              { name: 'root.md', relativePath: 'root.md', kind: 'document' as const },
              { name: 'nested', relativePath: 'nested', kind: 'directory' as const },
            ],
          }
        }
        markNestedStarted()
        await nestedGate
        return {
          ok: true as const,
          value: [{
            name: 'child.md',
            relativePath: 'nested/child.md',
            kind: 'document' as const,
          }],
        }
      })}
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
          markdown: 'needle',
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
  expect(await screen.findByRole('button', { name: /root\.md/ })).toBeVisible()
  await user.click(screen.getByRole('button', { name: '搜索更多层级文件夹' }))
  await nestedStarted
  await Promise.resolve()
  const rootVisibleBeforeNestedFinished = screen.queryByRole('button', { name: /root\.md/ }) !== null
  releaseNested()

  expect(await screen.findByRole('button', { name: /nested\/child\.md/ })).toBeVisible()
  expect(rootVisibleBeforeNestedFinished).toBe(true)
})

it('shows a full current-folder failure and retries the identical query successfully', async () => {
  const user = userEvent.setup()
  const listDirectory = vi.fn()
    .mockResolvedValueOnce({ ok: true as const, value: [] })
    .mockRejectedValueOnce(new Error('listing failed'))
    .mockResolvedValueOnce({
      ok: true as const,
      value: [{ name: 'hit.md', relativePath: 'hit.md', kind: 'document' as const }],
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
      readDocument={vi.fn(async (relativePath: string) => ({
        ok: true as const,
        value: {
          relativePath,
          markdown: 'needle',
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

  expect(await screen.findByRole('alert')).toHaveTextContent('当前文件夹搜索失败')
  expect(screen.queryByText('没有匹配结果')).toBeNull()
  expect(screen.queryByRole('button', { name: '重试搜索' })).toBeNull()

  await user.click(screen.getByRole('button', { name: '搜索' }))

  expect(await screen.findByRole('button', { name: /hit\.md/ })).toBeVisible()
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(listDirectory).toHaveBeenCalledTimes(3)
})

it('keeps current-folder matches visible when another document cannot be read', async () => {
  const user = userEvent.setup()

  render(
    <ContextWorkspaceSidebar
      chooseWorkspace={vi.fn(async () => undefined)}
      currentDocument={null}
      isChoosing={false}
      listDirectory={vi.fn(async () => ({
        ok: true as const,
        value: [
          { name: 'hit.md', relativePath: 'hit.md', kind: 'document' as const },
          { name: 'broken.md', relativePath: 'broken.md', kind: 'document' as const },
        ],
      }))}
      markdown=""
      onCreateDocument={vi.fn(async () => true)}
      onOpenDocument={vi.fn()}
      onReloadDocument={vi.fn()}
      onRevealDocument={vi.fn()}
      onTrashDocument={vi.fn()}
      onWorkspaceMenuCommand={vi.fn(async () => undefined)}
      readDocument={vi.fn(async (relativePath: string) => {
        if (relativePath === 'broken.md') throw new Error('read failed')
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
      })}
      refreshVersion={0}
      workspace={{ name: 'notes', absolutePath: 'C:\\notes' }}
      workspaceError={null}
    />,
  )

  await user.click(screen.getByRole('button', { name: '搜索工作区' }))
  await user.type(screen.getByRole('searchbox', { name: '搜索工作区' }), 'needle{Enter}')

  expect(await screen.findByRole('button', { name: /hit\.md/ })).toBeVisible()
  expect(screen.getByRole('alert')).toHaveTextContent('1 个文档无法读取，结果可能不完整')
  expect(screen.queryByText('没有匹配结果')).toBeNull()
})

it('does not let a stale same-query retry replace a newly submitted query', async () => {
  const user = userEvent.setup()
  let releaseRetry = () => {}
  const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve })
  const listDirectory = vi.fn(async () => {
    const attempt = listDirectory.mock.calls.length
    if (attempt === 1) return { ok: true as const, value: [] }
    if (attempt === 2) throw new Error('listing failed')
    if (attempt === 3) {
      await retryGate
      return {
        ok: true as const,
        value: [{ name: 'old.md', relativePath: 'old.md', kind: 'document' as const }],
      }
    }
    return {
      ok: true as const,
      value: [{ name: 'fresh.md', relativePath: 'fresh.md', kind: 'document' as const }],
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
      readDocument={vi.fn(async (relativePath: string) => ({
        ok: true as const,
        value: {
          relativePath,
          markdown: relativePath === 'fresh.md' ? 'fresh' : 'needle',
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
  const input = screen.getByRole('searchbox', { name: '搜索工作区' })
  await user.type(input, 'needle{Enter}')
  await screen.findByRole('alert')
  await user.keyboard('{Enter}')
  await user.clear(input)
  await user.type(input, 'fresh{Enter}')

  expect(await screen.findByRole('button', { name: /fresh\.md/ })).toBeVisible()
  await act(async () => { releaseRetry(); await retryGate })
  await waitFor(() => expect(screen.queryByRole('button', { name: /old\.md/ })).toBeNull())
  expect(screen.getByRole('button', { name: /fresh\.md/ })).toBeVisible()
})

it('does not let a stale retry from the previous workspace replace the new root results', async () => {
  const user = userEvent.setup()
  let releaseRetry = () => {}
  const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve })
  const firstListDirectory = vi.fn(async () => {
    const attempt = firstListDirectory.mock.calls.length
    if (attempt === 1) return { ok: true as const, value: [] }
    if (attempt === 2) throw new Error('listing failed')
    await retryGate
    return {
      ok: true as const,
      value: [{ name: 'old.md', relativePath: 'old.md', kind: 'document' as const }],
    }
  })
  const secondListDirectory = vi.fn(async () => ({
    ok: true as const,
    value: [{ name: 'new.md', relativePath: 'new.md', kind: 'document' as const }],
  }))
  const sharedProps = {
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
    readDocument: vi.fn(async (relativePath: string) => ({
      ok: true as const,
      value: {
        relativePath,
        markdown: 'needle',
        revision: 'a'.repeat(64),
        encoding: 'utf8' as const,
        newline: 'lf' as const,
        mtimeMs: 1,
      },
    })),
    refreshVersion: 0,
    workspaceError: null,
  }
  const { rerender } = render(
    <ContextWorkspaceSidebar
      {...sharedProps}
      listDirectory={firstListDirectory}
      workspace={{ name: 'first', absolutePath: 'C:\\first' }}
    />,
  )

  await user.click(screen.getByRole('button', { name: '搜索工作区' }))
  await user.type(screen.getByRole('searchbox', { name: '搜索工作区' }), 'needle{Enter}')
  await screen.findByRole('alert')
  await user.click(screen.getByRole('button', { name: '搜索' }))

  rerender(
    <ContextWorkspaceSidebar
      {...sharedProps}
      listDirectory={secondListDirectory}
      workspace={{ name: 'second', absolutePath: 'C:\\second' }}
    />,
  )

  expect(await screen.findByRole('button', { name: /new\.md/ })).toBeVisible()
  await act(async () => { releaseRetry(); await retryGate })
  await waitFor(() => expect(screen.queryByRole('button', { name: /old\.md/ })).toBeNull())
  expect(screen.getByRole('button', { name: /new\.md/ })).toBeVisible()
})
