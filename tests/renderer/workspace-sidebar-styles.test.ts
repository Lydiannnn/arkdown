import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

function readCss(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8')
    .replace(/\r\n/g, '\n')
}

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 's'))
  if (!match) throw new Error(`Missing CSS rule for ${selector}`)
  return match[1].replace(/\s+/g, ' ')
}

const appCss = readCss('src/renderer/app/styles.css')
const sidebarCss = readCss('src/renderer/workspace/workspace-sidebar.css')
const fileActionsCss = readCss('src/renderer/workspace/workspace-file-actions.css')

describe('workspace sidebar typography', () => {
  test('preserves workspace name casing while increasing only its visual typography', () => {
    const title = rule(appCss, '.sidebar-title')
    expect(title).toContain('font-size: 13px')
    expect(title).toContain('font-weight: var(--ui-font-weight-medium)')
    expect(title).toContain('color: rgb(var(--theme-color-rgb, 198 40 40) / 55%)')
    expect(title).not.toContain('text-transform: uppercase')

    const headingTitle = rule(fileActionsCss, '.sidebar-heading .sidebar-title')
    expect(headingTitle).toContain('font-size: 15px')
    expect(headingTitle).toContain('padding: 0 6px 0 9px')
    expect(rule(fileActionsCss, '.sidebar-heading')).toContain('height: 46px')
  })

  test('renders complete workspace icon canvases at 22 measured pixels under 150% scaling', () => {
    const actionButton = rule(fileActionsCss, '.workspace-actions button')
    expect(actionButton).toContain('display: grid')
    expect(actionButton).toContain('place-items: center')

    const actionIcon = rule(fileActionsCss, '.workspace-actions .app-icon')
    expect(actionIcon).toContain('display: block')
    expect(actionIcon).toContain('width: 14.667px')
    expect(actionIcon).toContain('height: 14.667px')
  })

  test('increases file and tab text by one pixel without changing row heights', () => {
    const treeRow = rule(appCss, '.tree-row')
    expect(treeRow).toContain('font-size: 14px')
    expect(treeRow).toContain('min-height: 27px')
    expect(treeRow).toContain('line-height: 27px')
    expect(rule(appCss, '.tree-loading, .tree-error')).toContain('font-size: 14px')

    const tabs = rule(sidebarCss, '.sidebar-tabs button')
    expect(tabs).toContain('font-size: 14px')
    expect(rule(sidebarCss, '.sidebar-tabs')).toContain('grid-template-columns: repeat(3, 1fr)')
    expect(tabs).toContain('min-height: 27px')
  })

  test('increases document and outline text by one pixel', () => {
    const outline = rule(sidebarCss, '.outline-row')
    expect(outline).toContain('font-size: 14px')
    expect(outline).toContain('min-height: 27px')
    expect(outline).toContain('line-height: 27px')
    expect(rule(sidebarCss, '.sidebar-empty')).toContain('font-size: 14px')

    expect(rule(fileActionsCss, '.document-list strong')).toContain('font-size: 14px')
    expect(rule(fileActionsCss, '.document-list small')).toContain('font-size: 12px')
    expect(rule(fileActionsCss, '.document-preview')).toContain('font-size: 13px')
  })

  test('increases search controls and result text by one pixel', () => {
    expect(rule(sidebarCss, '.workspace-search-field input')).toContain('font-size: 13px')
    expect(rule(sidebarCss, '.search-scope')).toContain('font-size: 12px')
    expect(rule(sidebarCss, '.search-results strong')).toContain('font-size: 14px')
    expect(rule(sidebarCss, '.search-results small')).toContain('font-size: 12px')
    expect(rule(sidebarCss, '.search-results span')).toContain('font-size: 13px')
  })

  test('hides the Chromium-native search clear control', () => {
    expect(rule(sidebarCss, '.workspace-search-field input::-webkit-search-cancel-button'))
      .toContain('display: none')
  })

  test('renders an individual rounded ten-percent color layer without descendant inheritance', () => {
    const marked = rule(appCss, ".tree-row[data-color-mark]")
    expect(marked).toContain('position: relative')
    const layer = rule(appCss, ".tree-row[data-color-mark]::before")
    expect(layer).toContain('border-radius: 6px')
    expect(layer).toContain('color-mix(in srgb, var(--tree-color-mark) 10%, transparent)')
    expect(rule(appCss, '.tree-color-indicator')).toContain('background: var(--tree-color-mark)')
    expect(appCss).not.toContain('.tree-row[data-color-mark] .tree-row')
  })
})
