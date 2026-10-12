import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const stylesPath = resolve(process.cwd(), 'src/renderer/app/styles.css')
const styles = readFileSync(stylesPath, 'utf8')
const stickyNoteWindowStyles = readFileSync(
  resolve(process.cwd(), 'src/renderer/sticky-notes/sticky-note-window.css'),
  'utf8',
)
const workspaceSidebarStyles = readFileSync(
  resolve(process.cwd(), 'src/renderer/workspace/workspace-sidebar.css'),
  'utf8',
)

function ruleDeclarations(css: string, selector: string): string {
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, selectors]) => (
    selectors.split(',').map((candidate) => candidate.trim()).includes(selector)
  ))

  expect(rule, `missing CSS rule for ${selector}`).toBeDefined()
  return rule?.[2] ?? ''
}

describe('global control states', () => {
  it('provides the shared control state tokens', () => {
    expect(styles).toContain('--control-hover-layer: rgb(0 0 0 / 5%);')
    expect(styles).toContain('--control-pressed-layer: rgb(0 0 0 / 11%);')
    expect(styles).toContain('--control-selected-layer: rgb(var(--theme-color-rgb, 198 40 40) / 9%);')
    expect(styles).toContain('--control-disabled-opacity: .4;')
    expect(styles).toContain('--control-state-duration: 90ms;')
  })

  it('gives every audited control an enabled pressed state without moving it', () => {
    for (const selector of [
      '.sidebar-title:active:not(:disabled)',
      '.tree-row:active:not(:disabled)',
      '.arkdown-image-alignment-toolbar button:active:not(:disabled)',
      '.arkdown-image-resize-handle:active:not(:disabled)',
      '.arkdown-image-size-menu button:active:not(:disabled)',
    ]) {
      const declarations = ruleDeclarations(styles, selector)
      expect(declarations).toContain('background: var(--control-pressed-layer)')
      expect(declarations).not.toMatch(/\btransform\s*:/)
    }
  })

  it('gives every audited control a shared disabled state', () => {
    for (const selector of [
      '.sidebar-title:disabled',
      '.tree-row:disabled',
      '.arkdown-image-alignment-toolbar button:disabled',
      '.arkdown-image-resize-handle:disabled',
      '.arkdown-image-size-menu button:disabled',
    ]) {
      expect(ruleDeclarations(styles, selector))
        .toContain('opacity: var(--control-disabled-opacity)')
    }
  })

  it('keeps disabled controls out of every audited hover and pressed selector', () => {
    for (const selector of [
      '.sidebar-title:hover:not(:disabled)',
      '.tree-row:hover:not(:disabled)',
      '.arkdown-image-alignment-toolbar button:hover:not(:disabled)',
      '.arkdown-image-resize-handle:hover:not(:disabled)',
      '.arkdown-image-size-menu button:hover:not(:disabled)',
    ]) {
      expect(ruleDeclarations(styles, selector))
        .toContain('background: var(--control-hover-layer)')
    }
  })

  it('keeps selected tabs persistent and gives save-status buttons shared states', () => {
    expect(workspaceSidebarStyles).toContain(
      '.sidebar-tabs button[aria-pressed="true"]:hover:not(:disabled) { background: var(--control-selected-layer); }',
    )
    expect(stickyNoteWindowStyles).toContain('.sticky-note-save-status button:active:not(:disabled)')
    expect(stickyNoteWindowStyles).toContain('.sticky-note-save-status button:disabled')
  })

  it('keeps the selected image alignment persistent across hover', () => {
    expect(ruleDeclarations(
      styles,
      '.arkdown-image-alignment-toolbar button[aria-pressed="true"]',
    )).toContain('background: var(--control-selected-layer)')
    expect(ruleDeclarations(
      styles,
      '.arkdown-image-alignment-toolbar button[aria-pressed="true"]:hover:not(:disabled)',
    )).toContain('background: var(--control-selected-layer)')
    expect(ruleDeclarations(
      styles,
      '.arkdown-image-alignment-toolbar button[aria-pressed="true"]:active:not(:disabled)',
    )).toContain('background: var(--control-pressed-layer)')
  })
})
