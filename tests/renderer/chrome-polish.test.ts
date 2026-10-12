import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8')

describe('workspace chrome polish', () => {
  const app = readCss('src/renderer/app/styles.css')
  const titlebar = readCss('src/renderer/chrome/app-title-bar.css')
  const sidebar = readCss('src/renderer/workspace/workspace-sidebar.css')
  const actions = readCss('src/renderer/workspace/workspace-file-actions.css')
  const find = readCss('src/renderer/editor/document-find-bar.css')

  it('uses one icon-opacity contract', () => {
    expect(app).toContain('--chrome-icon-opacity: .72')
    expect(app).toContain('--chrome-icon-hover-opacity: .95')
    expect(titlebar).not.toContain('.sidebar-toggle-glyph')
    expect(actions).toMatch(/\.workspace-actions \.app-icon\s*\{[^}]*opacity:\s*var\(--chrome-icon-opacity\)/s)
  })

  it('removes the tab underline and uses low-emphasis overlay scrollbars', () => {
    expect(sidebar).not.toMatch(/button\[aria-pressed="true"\]\s*\{[^}]*border-bottom-color/s)
    expect(app).toContain('rgb(0 0 0 / 20%)')
    expect(app).toContain('::-webkit-scrollbar-track')
    expect(app).toContain('background: transparent')
  })

  it('compacts current-document search without changing its width', () => {
    expect(find).toMatch(/\.document-find-bar\s*\{[^}]*min-height:\s*36px/s)
    expect(find).toMatch(/\.document-find-bar input\s*\{[^}]*height:\s*28px/s)
    expect(find).toMatch(/\.document-find-close\s*\{[^}]*width:\s*24px[^}]*height:\s*24px/s)
  })
})
