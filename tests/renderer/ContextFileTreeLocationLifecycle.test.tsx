import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ContextFileTree } from '../../src/renderer/workspace/ContextFileTree'

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView

afterEach(() => {
  if (originalScrollIntoView) {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView
  } else {
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
  }
})

it('centers a located entry and acknowledges the matching request', async () => {
  const scrollIntoView = vi.fn()
  HTMLElement.prototype.scrollIntoView = scrollIntoView
  const onLocateComplete = vi.fn()

  render(
    <ContextFileTree
      activePath={null}
      contextPath={null}
      listDirectory={vi.fn(async (relativePath: string) => ({
        ok: true as const,
        value: relativePath === ''
          ? [{ name: 'notes', relativePath: 'notes', kind: 'directory' as const }]
          : [{ name: 'new.md', relativePath: 'notes/new.md', kind: 'document' as const }],
      }))}
      locateRequest={{ relativePath: 'notes/new.md', version: 7 }}
      onEntryContextMenu={vi.fn()}
      onLocateComplete={onLocateComplete}
      onOpenDocument={vi.fn()}
      selectedDirectory=""
      onDirectoryToggle={vi.fn()}
    />,
  )

  const located = await screen.findByRole('button', { name: 'new.md' })
  await waitFor(() => expect(located).toHaveFocus())

  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
  expect(onLocateComplete).toHaveBeenCalledWith(7)
})
