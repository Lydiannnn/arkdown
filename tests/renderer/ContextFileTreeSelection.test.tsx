import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ContextFileTree } from '../../src/renderer/workspace/ContextFileTree'

const appCss = readFileSync(
  path.join(process.cwd(), 'src/renderer/app/styles.css'),
  'utf8',
)
const workspaceTreeCss = readFileSync(
  path.join(process.cwd(), 'src/renderer/workspace/workspace-context-menu.css'),
  'utf8',
)
const workspaceTreeStyle = document.createElement('style')
workspaceTreeStyle.textContent = workspaceTreeCss

beforeAll(() => document.head.append(workspaceTreeStyle))
afterAll(() => workspaceTreeStyle.remove())

function styleRule(selector: string): CSSStyleRule {
  const rule = Array.from(workspaceTreeStyle.sheet?.cssRules ?? []).find((candidate) => (
    candidate instanceof CSSStyleRule && candidate.selectorText.replaceAll("'", '"') === selector
  ))
  if (!(rule instanceof CSSStyleRule)) throw new Error(`Missing CSS rule: ${selector}`)
  return rule
}

function interactiveTreeCss(): string {
  return `${appCss}\n${workspaceTreeCss}`
    .replaceAll('rgb(var(--theme-color-rgb) / 5%)', 'rgba(198, 40, 40, 0.05)')
    .replaceAll('var(--control-hover-layer)', 'rgba(0, 0, 0, 0.05)')
    .replaceAll('var(--control-pressed-layer)', 'rgba(0, 0, 0, 0.11)')
    // JSDOM does not expose interactive pseudo-class state. Attribute selectors
    // have equivalent specificity and exercise the browser's real cascade.
    .replaceAll(':hover', '[data-test-state~="hover"]')
    .replaceAll(':active', '[data-test-state~="active"]')
    .replaceAll(':focus-visible', '[data-test-state~="focus-visible"]')
}

const listDirectory = vi.fn(async (path: string) => ({
  ok: true as const,
  value: path === ''
    ? [{ name: 'notes', relativePath: 'notes', kind: 'directory' as const }]
    : [{ name: 'child', relativePath: 'notes/child', kind: 'directory' as const }],
}))

function Harness() {
  const [selected, setSelected] = useState('')
  return (
    <ContextFileTree
      activePath={null}
      contextPath={null}
      colorMarks={{ notes: '#2563EB' }}
      listDirectory={listDirectory}
      onDirectoryToggle={(path, open) => {
        if (open) setSelected(path)
        else setSelected((current) => current === path || current.startsWith(`${path}/`) ? '' : current)
      }}
      onEntryContextMenu={vi.fn()}
      onOpenDocument={vi.fn()}
      selectedDirectory={selected}
    />
  )
}

describe('ContextFileTree directory selection', () => {
  it('uses theme tint only for the current page while context and directory states stay neutral', () => {
    const current = styleRule('.tree-row[aria-current="page"]')
    const contextTarget = styleRule('.tree-row[data-context-selected="true"]')
    const directoryScope = styleRule('.tree-row[data-directory-selected="true"] .tree-row-label')

    expect(current.style.background).toBe('rgb(var(--theme-color-rgb) / 5%)')
    expect(contextTarget.style.background).toBe('rgb(233, 236, 239)')
    expect(contextTarget.style.background).not.toContain('--theme-color')
    expect(directoryScope.style.fontWeight).toBe('var(--ui-font-weight-semibold)')
    expect(directoryScope.style.background).toBe('')
  })

  it('keeps current-page identity through hover and active while a context target stays neutral', () => {
    const interactiveStyle = document.head.appendChild(document.createElement('style'))
    interactiveStyle.textContent = interactiveTreeCss()
    const current = document.body.appendChild(document.createElement('button'))
    current.className = 'tree-row'
    current.setAttribute('aria-current', 'page')

    try {
      current.dataset.testState = 'hover'
      expect(getComputedStyle(current).backgroundColor).toBe('rgba(198, 40, 40, 0.05)')
      expect(getComputedStyle(current).boxShadow).toContain('rgba(0, 0, 0, 0.05)')

      current.dataset.testState = 'active'
      expect(getComputedStyle(current).backgroundColor).toBe('rgba(198, 40, 40, 0.05)')
      expect(getComputedStyle(current).boxShadow).toContain('rgba(0, 0, 0, 0.11)')

      current.dataset.contextSelected = 'true'
      current.dataset.testState = 'hover'
      expect(getComputedStyle(current).backgroundColor).toBe('rgb(233, 236, 239)')
      expect(getComputedStyle(current).boxShadow).toContain('rgba(0, 0, 0, 0.05)')
    } finally {
      current.remove()
      interactiveStyle.remove()
    }
  })

  it('moves selection to an opened child and clears it when its ancestor collapses', async () => {
    render(<Harness />)
    const notes = await screen.findByRole('button', { name: 'notes' })
    fireEvent.click(notes)
    expect(notes).toHaveAttribute('data-directory-selected', 'true')
    expect(notes).toHaveAttribute('data-color-mark', '#2563EB')

    const child = await screen.findByRole('button', { name: 'child' })
    expect(child).not.toHaveAttribute('data-color-mark')
    fireEvent.click(child)
    await waitFor(() => expect(child).toHaveAttribute('data-directory-selected', 'true'))
    expect(notes).not.toHaveAttribute('data-directory-selected')

    fireEvent.click(notes)
    expect(notes).not.toHaveAttribute('data-directory-selected')
    fireEvent.click(notes)
    const reopenedChild = await screen.findByRole('button', { name: 'child' })
    expect(reopenedChild).not.toHaveAttribute('data-directory-selected')
  })
})
