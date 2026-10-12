import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FolderDropDialog } from '../../src/renderer/workspace/FolderDropDialog'

describe('FolderDropDialog', () => {
  it('requires an explicit choice instead of cancelling on the backdrop', () => {
    const onChoose = vi.fn()
    render(<FolderDropDialog onChoose={onChoose} />)

    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)

    expect(onChoose).not.toHaveBeenCalled()
  })

  it('settles an explicit choice after the shared exit phase', async () => {
    const onChoose = vi.fn()
    render(<FolderDropDialog onChoose={onChoose} />)

    fireEvent.click(screen.getByRole('button', { name: '路径' }))
    expect(screen.getByRole('dialog').parentElement).toHaveAttribute('data-state', 'closing')
    expect(onChoose).not.toHaveBeenCalled()
    await waitFor(() => expect(onChoose).toHaveBeenCalledWith('path'))
  })

  it('focuses the dialog surface before the user chooses an action', () => {
    render(<FolderDropDialog onChoose={vi.fn()} />)

    const dialog = screen.getByRole('dialog', { name: '添加文件夹' })
    const workspace = screen.getByRole('button', { name: '工作区' })

    expect(dialog).toHaveFocus()
    expect(workspace).not.toHaveFocus()
  })

  it('uses the fixed internal focus indicator when keyboard focus reaches an action', () => {
    const style = document.createElement('style')
    const dialogCss = readFileSync(
      path.join(process.cwd(), 'src/renderer/modal/arkdown-dialog.css'),
      'utf8',
    )
    style.textContent = dialogCss
      // JSDOM does not resolve inherited custom properties in computed styles.
      // Literal test values retain the real selector/cascade while making the
      // fixed primary and focus palettes observable.
      .replaceAll('var(--arkdown-dialog-action-border)', '#c9c9c9')
      .replaceAll('var(--arkdown-dialog-action-surface)', '#f8f8f8')
      .replaceAll('var(--arkdown-dialog-action-text)', '#333')
      .replaceAll('var(--arkdown-dialog-focus)', '#4183c4')
      .replaceAll('var(--arkdown-dialog-primary-surface)', '#4183c4')
      .replaceAll('var(--arkdown-dialog-primary-text)', '#fff')
      .replaceAll(':focus-visible', '[data-test-focus-visible]')
    document.head.append(style)

    try {
      render(<FolderDropDialog onChoose={vi.fn()} />)
      const dialog = screen.getByRole('dialog', { name: '添加文件夹' })
      const backdrop = dialog.parentElement!
      backdrop.style.setProperty('--theme-color-rgb', '255 128 0')
      const workspace = screen.getByRole('button', { name: '工作区' })
      workspace.setAttribute('data-test-focus-visible', '')
      const focusedStyle = getComputedStyle(workspace)
      const focusRule = Array.from(style.sheet?.cssRules ?? []).find((rule) => (
        rule instanceof CSSStyleRule
        && rule.selectorText === '.arkdown-dialog__actions button[data-test-focus-visible]'
      ))
      const backdropRule = Array.from(style.sheet?.cssRules ?? []).find((rule) => (
        rule instanceof CSSStyleRule
        && rule.selectorText === '.arkdown-dialog-backdrop'
      ))

      expect(backdropRule).toBeInstanceOf(CSSStyleRule)
      expect((backdropRule as CSSStyleRule).style.getPropertyValue('--arkdown-dialog-focus'))
        .toBe('#4183c4')
      expect(focusRule).toBeInstanceOf(CSSStyleRule)
      expect((focusRule as CSSStyleRule).style.outline).toBe('none')
      expect((focusRule as CSSStyleRule).style.outlineOffset).toBe('')
      expect(focusedStyle.borderColor).toBe('rgb(65, 131, 196)')
      expect(focusedStyle.boxShadow).toContain('inset')
      expect(focusedStyle.boxShadow).not.toContain('255 128 0')
    } finally {
      style.remove()
    }
  })
})
