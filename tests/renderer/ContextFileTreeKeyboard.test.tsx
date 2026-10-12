import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { expect, it, vi } from 'vitest'
import type { TreeEntry } from '../../src/shared/contracts'
import { ContextFileTree } from '../../src/renderer/workspace/ContextFileTree'

const entries: Record<string, TreeEntry[]> = {
  '': [
    { name: 'first.md', relativePath: 'first.md', kind: 'document' },
    { name: 'notes', relativePath: 'notes', kind: 'directory' },
    { name: 'last.txt', relativePath: 'last.txt', kind: 'document' },
  ],
  notes: [
    { name: 'child.md', relativePath: 'notes/child.md', kind: 'document' },
    { name: 'nested', relativePath: 'notes/nested', kind: 'directory' },
  ],
  'notes/nested': [{ name: 'deep.md', relativePath: 'notes/nested/deep.md', kind: 'document' }],
}
const listDirectory = async (path: string) => ({ ok: true as const, value: entries[path] ?? [] })

function Harness({ open }: { open: (path: string) => boolean }) {
  const [activePath, setActivePath] = useState<string | null>(null)
  return <>
    <input aria-label="Outside input" />
    <ContextFileTree activePath={activePath} contextPath={null} selectedDirectory=""
      listDirectory={listDirectory} onEntryContextMenu={() => {}}
      onOpenDocument={(path) => { if (open(path)) setActivePath(path) }} />
    <output aria-label="Opened document">{activePath}</output>
  </>
}

it('opens visible documents in display order across expanded folders and stops at either end', async () => {
  const user = userEvent.setup()
  const open = vi.fn(() => true)
  render(<Harness open={open} />)
  await user.click(await screen.findByRole('button', { name: 'notes' }))
  await user.click(await screen.findByRole('button', { name: 'nested' }))
  await screen.findByRole('button', { name: 'deep.md' })
  await user.click(screen.getByRole('button', { name: 'first.md' }))
  await user.keyboard('{ArrowUp}')
  expect(open).toHaveBeenCalledTimes(1)

  for (const [key, name, path] of [
    ['ArrowDown', 'child.md', 'notes/child.md'],
    ['ArrowDown', 'deep.md', 'notes/nested/deep.md'],
    ['ArrowDown', 'last.txt', 'last.txt'],
    ['ArrowUp', 'deep.md', 'notes/nested/deep.md'],
  ]) {
    await user.keyboard(`{${key}}`)
    expect(screen.getByRole('status', { name: 'Opened document' })).toHaveTextContent(path)
    expect(screen.getByRole('button', { name })).toHaveFocus()
    expect(screen.getByRole('button', { name })).toHaveAttribute('aria-current', 'page')
  }
  await user.keyboard('{ArrowDown}{ArrowDown}')
  expect(open.mock.calls).toEqual([
    ['first.md'], ['notes/child.md'], ['notes/nested/deep.md'], ['last.txt'],
    ['notes/nested/deep.md'], ['last.txt'],
  ])
})

it('skips collapsed contents and does not hijack modified keys, folder buttons or outside input', async () => {
  const user = userEvent.setup()
  const open = vi.fn(() => true)
  render(<Harness open={open} />)
  await user.click(await screen.findByRole('button', { name: 'notes' }))
  await screen.findByRole('button', { name: 'child.md' })
  await user.click(screen.getByRole('button', { name: 'notes' }))
  expect(fireEvent.keyDown(screen.getByRole('button', { name: 'notes' }), { key: 'ArrowDown' })).toBe(true)
  await user.click(screen.getByRole('button', { name: 'first.md' }))
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) {
    expect(fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown', ...modifiers })).toBe(true)
  }
  expect(open).toHaveBeenCalledTimes(1)
  await user.keyboard('{ArrowDown}')
  expect(screen.getByRole('status', { name: 'Opened document' })).toHaveTextContent('last.txt')
  await user.click(screen.getByRole('textbox', { name: 'Outside input' }))
  await user.keyboard('{ArrowUp}')
  expect(open.mock.calls).toEqual([['first.md'], ['last.txt']])
})

it('uses the existing open callback and leaves the active document unchanged when it rejects a transition', async () => {
  const user = userEvent.setup()
  const open = vi.fn((path: string) => path === 'first.md')
  render(<Harness open={open} />)
  await user.click(await screen.findByRole('button', { name: 'first.md' }))
  await user.keyboard('{ArrowDown}')
  expect(open.mock.calls).toEqual([['first.md'], ['last.txt']])
  expect(screen.getByRole('button', { name: 'first.md' })).toHaveAttribute('aria-current', 'page')
  expect(screen.getByRole('button', { name: 'last.txt' })).not.toHaveAttribute('aria-current')
})
