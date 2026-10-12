import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  path.join(process.cwd(), 'src/renderer/app/styles.css'),
  'utf8',
)
const titlebarCss = readFileSync(
  path.join(process.cwd(), 'src/renderer/chrome/app-title-bar.css'),
  'utf8',
)
const documentHeaderCss = readFileSync(
  path.join(process.cwd(), 'src/renderer/chrome/document-header.css'),
  'utf8',
)

describe('Codex-style application shell', () => {
  it('places the fused titlebar above the workspace and editor', () => {
    expect(css).toMatch(/grid-template-rows:\s*40px\s+minmax\(0,\s*1fr\)/)
    expect(css).toMatch(/\.sidebar\s*\{[\s\S]*grid-row:\s*2/)
    expect(css).toMatch(/\.editor-host\s*\{[\s\S]*grid-row:\s*2/)
    expect(titlebarCss).toMatch(/\.app-titlebar\s*\{[^}]*height:\s*40px/)
    expect(titlebarCss).toMatch(/\.app-menu-button\s*\{[^}]*height:\s*26px/)
    expect(documentHeaderCss).toMatch(/\.document-header\s*\{[^}]*height:\s*46px/)
    expect(documentHeaderCss).toMatch(
      /\.document-toolbar button\s*\{[^}]*width:\s*30px[^}]*height:\s*30px/,
    )
  })

  it('overlays a transparent resize hit target without reserving a visible gutter', () => {
    expect(css).toMatch(
      /grid-template-columns:\s*var\(--sidebar-width,\s*300px\)\s+0\s+minmax\(0,\s*1fr\)/,
    )
    expect(css).toMatch(
      /\.sidebar-resizer\s*\{[^}]*position:\s*relative[^}]*width:\s*5px[^}]*justify-self:\s*center[^}]*background:\s*transparent/,
    )
    expect(css).toMatch(
      /\.sidebar-resizer::after\s*\{[^}]*width:\s*1px[^}]*background:\s*transparent/,
    )
    expect(css).toMatch(
      /\.sidebar-resizer:hover::after,[\s\S]*\.sidebar-resizer:focus-visible::after\s*\{[^}]*background:\s*linear-gradient\(\s*to bottom,\s*rgb\(var\(--theme-color-rgb,\s*198 40 40\)\s*\/\s*0%\)\s*0%,\s*rgb\(var\(--theme-color-rgb,\s*198 40 40\)\s*\/\s*40%\)\s*35%,\s*rgb\(var\(--theme-color-rgb,\s*198 40 40\)\s*\/\s*40%\)\s*65%,\s*rgb\(var\(--theme-color-rgb,\s*198 40 40\)\s*\/\s*0%\)\s*100%\s*\)/,
    )
  })

  it('does not clip descenders in the editor filename', () => {
    expect(documentHeaderCss).toMatch(
      /\.document-identity h1\s*\{[^}]*line-height:\s*1\.4/,
    )
  })

  it('exposes Mica through one permanently transparent shared chrome tint', () => {
    expect(css).not.toMatch(/:root\s*\{[^}]*--mica-shell-tint:/)
    expect(css).toMatch(
      /\.app-shell\s*\{[^}]*--mica-shell-tint:\s*rgb\(255 255 255\s*\/\s*0%\)/,
    )
    expect(css).not.toContain('--mica-shell-opacity')
    expect(css).toMatch(/\.app-shell\s*\{[^}]*background:\s*transparent/)
    expect(css).toMatch(/\.sidebar\s*\{[^}]*background:\s*var\(--mica-shell-tint\)/)
    expect(titlebarCss).toMatch(/\.app-titlebar\s*\{[^}]*background:\s*var\(--mica-shell-tint\)/)
  })

  it('renders the editor as a floating white surface on the Mica shell', () => {
    expect(css).toMatch(/\.editor-host\s*\{[^}]*grid-template-rows:\s*46px\s+minmax\(0,\s*1fr\)/)
    expect(css).toMatch(/\.editor-host\s*\{[^}]*border-radius:\s*12px\s+0\s+0\s+0/)
    expect(css).toMatch(
      /\.editor-host\s*\{[^}]*box-shadow:\s*0\s+0\s+18px\s+rgb\(48 54 65\s*\/\s*12%\)/,
    )
  })
})
