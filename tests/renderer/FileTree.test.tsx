import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { expect, it, vi } from 'vitest'
import { FileTree } from '../../src/renderer/workspace/FileTree'

it('loads a directory only on its first expansion and opens Markdown files', async () => {
  const listDirectory = vi.fn(async (path: string) => ({
    ok: true as const,
    value: path === ''
      ? [{ name: 'docs', relativePath: 'docs', kind: 'directory' as const }]
      : [{ name: 'guide.md', relativePath: 'docs/guide.md', kind: 'document' as const }],
  }))
  const onOpenDocument = vi.fn()
  const user = userEvent.setup()

  render(<FileTree
    colorMarks={{ docs: '#2563EB', 'docs/guide.md': '#18864B' }}
    listDirectory={listDirectory}
    onOpenDocument={onOpenDocument}
  />)

  const directory = await screen.findByRole('button', { name: 'docs' })
  expect(directory).toHaveAttribute('data-color-mark', '#2563EB')
  await user.click(directory)
  await user.click(directory)
  await user.click(directory)
  const guide = await screen.findByRole('button', { name: 'guide.md' })
  expect(guide).toHaveAttribute('data-color-mark', '#18864B')
  await user.click(guide)

  expect(listDirectory).toHaveBeenCalledTimes(2)
  expect(listDirectory).toHaveBeenNthCalledWith(1, '')
  expect(listDirectory).toHaveBeenNthCalledWith(2, 'docs')
  expect(onOpenDocument).toHaveBeenCalledWith('docs/guide.md')
})

it('does not inherit prototype properties as color marks but accepts prototype-named own entries', async () => {
  const listDirectory = vi.fn(async () => ({
    ok: true as const,
    value: [
      { name: '__proto__', relativePath: '__proto__', kind: 'document' as const },
      { name: 'constructor', relativePath: 'constructor', kind: 'document' as const },
      { name: 'prototype', relativePath: 'prototype', kind: 'document' as const },
    ],
  }))
  const first = render(<FileTree
    colorMarks={{}}
    listDirectory={listDirectory}
    onOpenDocument={vi.fn()}
  />)

  for (const name of ['__proto__', 'constructor', 'prototype']) {
    expect(await screen.findByRole('button', { name })).not.toHaveAttribute('data-color-mark')
  }

  first.unmount()
  const ownMarks = JSON.parse(`{
    "__proto__": "#2563EB",
    "constructor": "#18864B",
    "prototype": "#C62828"
  }`) as { [path: string]: '#2563EB' | '#18864B' | '#C62828' }
  render(<FileTree
    colorMarks={ownMarks}
    listDirectory={listDirectory}
    onOpenDocument={vi.fn()}
  />)
  expect(await screen.findByRole('button', { name: '__proto__' }))
    .toHaveAttribute('data-color-mark', '#2563EB')
  expect(screen.getByRole('button', { name: 'constructor' }))
    .toHaveAttribute('data-color-mark', '#18864B')
  expect(screen.getByRole('button', { name: 'prototype' }))
    .toHaveAttribute('data-color-mark', '#C62828')
})

it('shows a retry action when loading a directory fails', async () => {
  const listDirectory = vi.fn(async (path: string) => path === ''
    ? { ok: true as const, value: [{ name: 'docs', relativePath: 'docs', kind: 'directory' as const }] }
    : { ok: false as const, error: { code: 'READ_FAILED', message: 'Cannot read docs' } })
  const user = userEvent.setup()

  render(<FileTree listDirectory={listDirectory} onOpenDocument={vi.fn()} />)

  await user.click(await screen.findByRole('button', { name: 'docs' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Cannot read docs')
  expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
})

it('does not duplicate a pending directory request when it is collapsed and reopened', async () => {
  let resolveDocs!: (result: { ok: true; value: { name: string; relativePath: string; kind: 'document' }[] }) => void
  const listDirectory = vi.fn((path: string) => path === ''
    ? Promise.resolve({ ok: true as const, value: [{ name: 'docs', relativePath: 'docs', kind: 'directory' as const }] })
    : new Promise<typeof resolveDocs extends (result: infer T) => void ? T : never>((resolve) => { resolveDocs = resolve }))
  const user = userEvent.setup()

  render(<FileTree listDirectory={listDirectory} onOpenDocument={vi.fn()} />)

  const directory = await screen.findByRole('button', { name: 'docs' })
  await user.click(directory)
  await user.click(directory)
  await user.click(directory)
  expect(listDirectory).toHaveBeenCalledTimes(2)

  resolveDocs({ ok: true, value: [{ name: 'guide.md', relativePath: 'docs/guide.md', kind: 'document' }] })
  expect(await screen.findByRole('button', { name: 'guide.md' })).toBeVisible()
})
it('clears the directory loading message after a successful response', async () => {
  const listDirectory = vi.fn(async (path: string) => ({
    ok: true as const,
    value: path === ''
      ? [{ name: 'docs', relativePath: 'docs', kind: 'directory' as const }]
      : [{ name: 'guide.md', relativePath: 'docs/guide.md', kind: 'document' as const }],
  }))
  const user = userEvent.setup()

  render(<FileTree listDirectory={listDirectory} onOpenDocument={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: 'docs' }))
  await screen.findByRole('button', { name: 'guide.md' })

  expect(screen.queryByText(/Loading/)).not.toBeInTheDocument()
})
it('does not repeat the root directory IPC in StrictMode', async () => {
  const listDirectory = vi.fn(async () => ({ ok: true as const, value: [] }))

  render(<StrictMode><FileTree listDirectory={listDirectory} onOpenDocument={vi.fn()} /></StrictMode>)

  await screen.findByRole('list')
  expect(listDirectory).toHaveBeenCalledTimes(1)
  expect(listDirectory).toHaveBeenCalledWith('')
})
it('reloads a settled root request after a real remount', async () => {
  const listDirectory = vi.fn(async () => ({ ok: true as const, value: [] }))
  const first = render(<FileTree listDirectory={listDirectory} onOpenDocument={vi.fn()} />)
  await screen.findByRole('list')
  first.unmount()
  render(<FileTree listDirectory={listDirectory} onOpenDocument={vi.fn()} />)
  await screen.findByRole('list')
  expect(listDirectory).toHaveBeenCalledTimes(2)
})

it('reloads a failed root request after a real remount', async () => {
  const listDirectory = vi.fn(async () => ({ ok: false as const, error: { code: 'READ_FAILED', message: 'No root' } }))
  const first = render(<FileTree listDirectory={listDirectory} onOpenDocument={vi.fn()} />)
  await screen.findByRole('alert')
  first.unmount()
  render(<FileTree listDirectory={listDirectory} onOpenDocument={vi.fn()} />)
  await screen.findByRole('alert')
  expect(listDirectory).toHaveBeenCalledTimes(2)
})
it('retries a failed root request and renders the successful result', async () => {
  let attempt = 0
  const listDirectory = vi.fn(async () => {
    attempt += 1
    return attempt === 1
      ? { ok: false as const, error: { code: 'READ_FAILED', message: 'Retry me' } }
      : { ok: true as const, value: [{ name: 'guide.md', relativePath: 'guide.md', kind: 'document' as const }] }
  })
  const user = userEvent.setup()
  render(<FileTree listDirectory={listDirectory} onOpenDocument={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: 'Retry' }))
  expect(await screen.findByRole('button', { name: 'guide.md' })).toBeVisible()
  expect(listDirectory).toHaveBeenCalledTimes(2)
})
