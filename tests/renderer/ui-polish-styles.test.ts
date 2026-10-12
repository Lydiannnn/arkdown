import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

describe('theme-aware UI polish', () => {
  const appCss = read('src/renderer/app/styles.css')
  const appSource = read('src/renderer/app/App.tsx')
  const sidebarCss = read('src/renderer/workspace/workspace-sidebar.css')
  const tooltipCss = read('src/renderer/tooltip/tooltip.css')

  it('colors search scope and result paths with 70% theme color', () => {
    expect(sidebarCss).toMatch(
      /\.search-scope\s*\{[^}]*color:\s*rgb\(var\(--theme-color-rgb,\s*198 40 40\)\s*\/\s*70%\)/,
    )
    expect(sidebarCss).toMatch(
      /\.search-results small\s*\{[^}]*color:\s*rgb\(var\(--theme-color-rgb,\s*198 40 40\)\s*\/\s*70%\)/,
    )
  })

  it('uses opaque white tooltips with the existing gray border', () => {
    expect(tooltipCss).toMatch(
      /:where\(\.global-tooltip,\s*\.ai-quote-tooltip,\s*\.document-file-name-tooltip\)\s*\{[^}]*border:\s*1px solid #e6e6e6[^}]*background:\s*#fff/,
    )
  })

  it('raises scrollbar opacity only while the thumb itself is hovered', () => {
    expect(appCss).toContain('::-webkit-scrollbar-thumb:hover')
    expect(appCss).not.toContain('.editor-surface:hover::-webkit-scrollbar-thumb')
    expect(appCss).not.toContain('.workspace-tree-context:hover::-webkit-scrollbar-thumb')
  })

  it('defines a DPI-aware 25px visual size for task checkboxes', () => {
    expect(appSource).toContain(
      "'--task-checkbox-size': `${25 / (window.devicePixelRatio || 1)}px`,",
    )
  })

  it('defines a 30px image alignment toolbar shown on image hover', () => {
    expect(appCss).toMatch(
      /\.arkdown-image-alignment-toolbar button\s*\{[^}]*width:\s*30px[^}]*height:\s*30px/,
    )
    expect(appCss).toMatch(
      /\.arkdown-local-image:hover \.arkdown-image-alignment-toolbar/,
    )
    expect(appCss).toMatch(
      /\.visual-editor \.ProseMirror \.arkdown-image-alignment-toolbar button img\s*\{[^}]*width:\s*auto[^}]*height:\s*auto[^}]*margin:\s*0/,
    )
    expect(appCss).toMatch(
      /\.arkdown-image-alignment-toolbar button:hover:not\(:disabled\)\s*\{[^}]*background:\s*var\(--control-hover-layer\)/,
    )
    expect(appCss).toMatch(
      /\.arkdown-image-alignment-toolbar button\[aria-pressed="true"\]\s*\{[^}]*background:\s*var\(--control-selected-layer\)/,
    )
  })
})
