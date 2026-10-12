import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ArknoteBoxWindowRoot } from '../../src/renderer/sticky-notes/ArknoteBoxWindowRoot'
import { DEFAULT_STICKY_NOTE_PREFERENCES } from '../../src/shared/sticky-note-preferences'
import type { ArkdownApi } from '../../src/shared/contracts'
import { stickyNoteApiStubs } from './sticky-note-api-stubs'

it('renders the standalone box without mounting the Arkdown editor', async () => {
  const close = vi.fn()
  window.arkdown = {
    listStickyNotes: vi.fn(async () => ({ ok: true, value: [] })),
    getStickyNotePreferences: vi.fn(async () => ({
      ok: true,
      value: DEFAULT_STICKY_NOTE_PREFERENCES,
    })),
    onStickyNoteEvent: vi.fn(() => () => undefined),
  } as unknown as ArkdownApi

  document.title = 'Arkdown'
  render(<ArknoteBoxWindowRoot onClose={close} />)

  expect(await screen.findByRole('complementary', { name: '便签盒子' })).toBeVisible()
  expect(document.title).toBe('便签盒子 — Arknote')
  expect(screen.queryByRole('main', { name: 'Markdown 编辑器' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '关闭便签盒子' }))
  expect(close).toHaveBeenCalledOnce()
})

it('provides a draggable standalone header without a duplicate active close control', () => {
  const css = readFileSync(path.join(process.cwd(), 'src/renderer/sticky-notes/sticky-note-box.css'), 'utf8')
  expect(css).toMatch(/arknote-box-window-root[^}]+sticky-note-box-header[^}]+-webkit-app-region:\s*drag/u)
  expect(css).toContain('.arknote-box-window-root .sticky-note-box-panel[data-view="active"] .sticky-note-box-header button')
  expect(css).not.toMatch(/arknote-box-window-root\s+\.sticky-note-box-header button\s*\{[^}]+display:\s*none/u)
})

it('shows a real standalone archive X that returns to active without closing the window', async () => {
  const close = vi.fn()
  const style = document.createElement('style')
  style.textContent = readFileSync(path.join(process.cwd(), 'src/renderer/sticky-notes/sticky-note-box.css'), 'utf8')
  document.head.append(style)
  window.arkdown = {
    ...stickyNoteApiStubs,
    listStickyNotes: vi.fn(async () => ({ ok: true as const, value: [] })),
  } as unknown as ArkdownApi
  render(<ArknoteBoxWindowRoot onClose={close} />)

  fireEvent.click(screen.getByRole('tab', { name: '归档' }))
  expect(await screen.findByRole('heading', { name: '归档' })).toBeVisible()
  const returnControl = document.querySelector<HTMLButtonElement>('[aria-label="返回便签盒子"]')
  expect(returnControl).not.toBeNull()
  expect(getComputedStyle(returnControl!).display).not.toBe('none')
  expect(returnControl!).toBeVisible()
  fireEvent.click(returnControl!)

  expect(await screen.findByRole('heading', { name: '便签盒子 — Arknote' })).toBeVisible()
  expect(close).not.toHaveBeenCalled()
  style.remove()
})
