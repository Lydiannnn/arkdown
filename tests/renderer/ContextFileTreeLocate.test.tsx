import { render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ContextFileTree } from '../../src/renderer/workspace/ContextFileTree'

it('expands parent directories and focuses a requested nested entry', async () => {
  const listDirectory = vi.fn(async (relativePath: string) => ({
    ok: true as const,
    value: relativePath === ''
      ? [{
          name: 'notes',
          relativePath: 'notes',
          kind: 'directory' as const,
        }]
      : [{
          name: 'new.md',
          relativePath: 'notes/new.md',
          kind: 'document' as const,
        }],
  }))

  render(
    <ContextFileTree
      activePath={null}
      contextPath={null}
      listDirectory={listDirectory}
      locateRequest={{ relativePath: 'notes/new.md', version: 1 }}
      onEntryContextMenu={vi.fn()}
      onOpenDocument={vi.fn()}
      selectedDirectory=""
      onDirectoryToggle={vi.fn()}
    />,
  )

  const directory = await screen.findByRole('button', { name: 'notes' })
  await waitFor(() => expect(directory).toHaveAttribute('aria-expanded', 'true'))
  const located = await screen.findByRole('button', { name: 'new.md' })
  await waitFor(() => expect(located).toHaveFocus())
  expect(located).toHaveAttribute('data-located', 'true')
  expect(listDirectory).toHaveBeenCalledWith('notes')
})
