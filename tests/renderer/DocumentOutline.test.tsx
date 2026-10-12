import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { DocumentOutline } from '../../src/renderer/editor/DocumentOutline'
import type { ObservedShortcutSnapshot } from '../../src/shared/keyboard-shortcuts'

it('uses main-process commands in Electron and ignores replayed renderer bindings', async () => {
  let command: (value: string) => void = () => {}
  const originalApi = window.arkdown
  const detach = vi.fn()
  window.arkdown = { onMenuCommand: (listener: (value: string) => void) => { command = listener; return detach } } as never
  const view = render(<DocumentOutline markdown="# Heading" documentKey="native" />)
  const trigger = screen.getByRole('button', { name: '大纲' })
  fireEvent.keyDown(window, { key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true })
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  act(() => command('toggle-document-outline'))
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  view.unmount()
  expect(detach).toHaveBeenCalled()
  window.arkdown = originalApi
})

it('switches the live outline binding and ignores the previous binding after a broadcast', async () => {
  let receive: ((snapshot: ObservedShortcutSnapshot) => void) | undefined
  const originalApi = window.arkdown
  window.arkdown = {
    getKeyboardShortcuts: async () => ({ ok: true, value: { bindings: { 'document.outline': 'Ctrl+Alt+R' }, revision: 0,
      observation: { version: 1, minimumBaseRevision: 0, fields: {} } } }),
    onKeyboardShortcutsChanged: (listener: (snapshot: ObservedShortcutSnapshot) => void) => { receive = listener; return () => {} },
  } as unknown as typeof window.arkdown
  const view = render(<DocumentOutline markdown="# 标题" documentKey="a" />)
  await waitFor(() => expect(receive).toBeTypeOf('function'))
  await act(async () => {})
  const trigger = screen.getByRole('button', { name: '大纲' })
  expect(trigger).toHaveAttribute('data-tooltip', '大纲 · Ctrl+Alt+R')
  fireEvent.keyDown(window, { ctrlKey: true, shiftKey: true, key: 'E', code: 'KeyE' })
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  fireEvent.keyDown(window, { ctrlKey: true, altKey: true, key: 'R', code: 'KeyR' })
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  act(() => receive!({ bindings: { 'document.outline': null }, revision: 1,
    observation: { version: 1, minimumBaseRevision: 0, fields: { 'document.outline': 1 } } }))
  expect(trigger).toHaveAttribute('data-tooltip', '大纲')
  fireEvent.keyDown(window, { ctrlKey: true, altKey: true, key: 'R', code: 'KeyR' })
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  view.unmount()
  window.arkdown = originalApi
})

it('toggles with Ctrl+Shift+E and ignores IME, repeated or extra-modifier keys', () => {
  render(<DocumentOutline markdown="# 标题" documentKey="a" />)
  const trigger = screen.getByRole('button', { name: '大纲' })
  fireEvent.keyDown(window, { ctrlKey: true, shiftKey: true, key: 'E', code: 'KeyE' })
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  for (const extra of [{ altKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }]) {
    fireEvent.keyDown(window, { ctrlKey: true, shiftKey: true, key: 'E', code: 'KeyE', ...extra })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  }
  fireEvent.keyDown(window, { ctrlKey: true, shiftKey: true, key: 'e', code: 'KeyE' })
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

it('only offers an outline for headings and navigates to the selected heading', () => {
  const navigate = vi.fn()
  window.addEventListener('arkdown:navigate-heading', navigate)
  const { rerender } = render(<DocumentOutline markdown="普通正文" documentKey="a" />)
  expect(screen.queryByRole('button', { name: '大纲' })).toBeNull()
  rerender(<DocumentOutline markdown={'# 开始\n\n## 写作'} documentKey="a" />)
  fireEvent.click(screen.getByRole('button', { name: '大纲' }))
  fireEvent.click(screen.getByRole('button', { name: '写作' }))
  expect(navigate.mock.calls[0][0].detail).toEqual({ index: 1 })
  fireEvent.click(screen.getByRole('button', { name: '折叠 开始' }))
  expect(screen.queryByRole('button', { name: '写作' })).toBeNull()
  rerender(<DocumentOutline markdown="# 新文档" documentKey="b" />)
  expect(screen.getByRole('button', { name: '大纲' })).toHaveAttribute('aria-expanded', 'false')
  window.removeEventListener('arkdown:navigate-heading', navigate)
})
