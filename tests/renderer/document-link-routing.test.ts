import { fireEvent } from '@testing-library/dom'
import { afterEach, expect, it, vi } from 'vitest'
import { applyLinkAttributes } from '../../src/renderer/editor/local-asset-link-view'
import { installLinkInteraction, openLinkTarget } from '../../src/renderer/editor/local-link-handler'

afterEach(() => document.body.replaceChildren())

it('retains a relative href verbatim and routes only Ctrl-click to document preview', async () => {
  const root = document.createElement('div')
  const anchor = document.createElement('a')
  const href = '../evidence/browser%20result.json#L3'
  applyLinkAttributes(anchor, href, null)
  root.append(anchor)
  document.body.append(root)
  const external = vi.fn(async () => ({ ok: true as const, value: null }))
  const preview = vi.fn(async () => undefined)
  const cleanup = installLinkInteraction(root, external, vi.fn(), preview)
  expect(anchor.getAttribute('href')).toBe(href)
  expect(anchor).toHaveClass('arkdown-relative-link')
  fireEvent.click(anchor)
  expect(preview).not.toHaveBeenCalled()
  fireEvent.click(anchor, { ctrlKey: true })
  await Promise.resolve()
  expect(preview).toHaveBeenCalledExactlyOnceWith(href)
  expect(external).not.toHaveBeenCalled()
  expect(anchor.getAttribute('href')).toBe(href)
  cleanup()
})

it('keeps absolute links on the old opener even when they name a previewable file', async () => {
  const external = vi.fn(async () => ({ ok: true as const, value: null }))
  const preview = vi.fn()
  await openLinkTarget('file:///C:/notes/result.json', external, vi.fn(), preview)
  expect(external).toHaveBeenCalledExactlyOnceWith('C:\\notes\\result.json')
  expect(preview).not.toHaveBeenCalled()
})

it('uses the same relative href route for the context-menu open action', async () => {
  const external = vi.fn()
  const preview = vi.fn(async () => undefined)
  expect(await openLinkTarget('./清单.md', external, vi.fn(), preview)).toBe(true)
  expect(preview).toHaveBeenCalledExactlyOnceWith('./清单.md')
  expect(external).not.toHaveBeenCalled()
})

it('does not navigate a relative link after a Ctrl-drag text selection', () => {
  const root = document.createElement('div')
  const anchor = document.createElement('a')
  applyLinkAttributes(anchor, 'note.md', null)
  root.append(anchor)
  document.body.append(root)
  const preview = vi.fn()
  const cleanup = installLinkInteraction(root, vi.fn(), vi.fn(), preview)
  fireEvent.pointerDown(anchor, { clientX: 10, clientY: 10, ctrlKey: true })
  fireEvent.pointerMove(anchor, { clientX: 60, clientY: 10, ctrlKey: true })
  fireEvent.pointerUp(anchor)
  fireEvent.click(anchor, { ctrlKey: true })
  expect(preview).not.toHaveBeenCalled()
  cleanup()
})

it('removes relative-link styling when an anchor changes to an absolute target', () => {
  const anchor = document.createElement('a')
  applyLinkAttributes(anchor, 'note.md', null)
  expect(anchor).toHaveClass('arkdown-relative-link')
  applyLinkAttributes(anchor, 'C:/notes/note.md', null)
  expect(anchor).not.toHaveClass('arkdown-relative-link')
  expect(anchor).toHaveClass('arkdown-local-link')
})
