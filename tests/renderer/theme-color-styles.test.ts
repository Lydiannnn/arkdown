import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readCss(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8')
    .replace(/\r\n/g, '\n')
}

const appCss = readCss('src/renderer/app/styles.css')
const preferencesCss = readCss('src/renderer/settings/search-preferences.css')
const preferencesSelectCss = readCss('src/renderer/settings/preferences-select.css')
const translationCss = readCss('src/renderer/editor/selection-translation.css')
const translationRailCss = readCss('src/renderer/editor/translation-history-rail.css')

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 's'))
  if (!match) throw new Error(`Missing CSS rule for ${selector}`)
  return match[1].replace(/\s+/g, ' ')
}

describe('theme color CSS variables', () => {
  it('uses the live theme color at 18% for editor text selections', () => {
    for (const selector of [
      '.visual-editor .ProseMirror ::selection',
      '.source-editor .cm-content ::selection',
      '.source-editor .cm-selectionBackground',
      '.visual-editor .milkdown-code-block .cm-selectionBackground',
    ]) {
      expect(rule(appCss, selector))
        .toContain('background: rgb(var(--theme-color-rgb, 198 40 40) / 18%)')
    }
  })

  it('keeps the Milkdown quote accent on the live theme RGB custom property', () => {
    expect(rule(appCss, '.visual-editor .ProseMirror blockquote::before'))
      .toContain('background: rgb(var(--theme-color-rgb, 198 40 40))')
    expect(rule(appCss, '.visual-editor .ProseMirror blockquote'))
      .toContain('border-left: 0')
  })

  it('derives all former purple UI states from one RGB custom property', () => {
    expect(rule(appCss, '.sidebar-title'))
      .toContain('color: rgb(var(--theme-color-rgb, 198 40 40) / 55%)')
    expect(rule(
      appCss,
      '.visual-editor .milkdown .ProseMirror .selectedCell::after',
    )).toContain('background: rgb(var(--theme-color-rgb, 198 40 40) / 10%)')
    expect(rule(appCss, '.visual-editor .ProseMirror .column-resize-handle'))
      .toContain('background: rgb(var(--theme-color-rgb, 198 40 40) / 20%)')
    expect(rule(preferencesSelectCss, '.preferences-select-check'))
      .toContain('color: rgb(var(--theme-color-rgb, 198 40 40) / 80%)')
    expect(preferencesSelectCss).toMatch(
      /\.preferences-select-menu button:hover:not\(:disabled\),\s*\.preferences-select-menu button:focus-visible\s*\{[^}]*background:\s*var\(--control-hover-layer\)/s,
    )
  })

  it('uses compact square swatches with only an internal selected checkmark', () => {
    const swatchRule = rule(preferencesCss, '.preferences-theme-swatch')
    expect(swatchRule).toContain('width: 12px')
    expect(swatchRule).toContain('height: 12px')
    expect(swatchRule).toContain('border-radius: 3px')

    const selectedRule = rule(
      preferencesCss,
      '.preferences-theme-swatch[aria-pressed="true"]',
    )
    expect(selectedRule).toContain('box-shadow: none')
  })

  it('spaces secondary settings by 40px without applying that gap to tertiary controls', () => {
    expect(rule(preferencesCss, '.preferences-section h2'))
      .toContain('font-size: 16px')
    expect(rule(preferencesCss, '.preferences-secondary-group + .preferences-secondary-group'))
      .toContain('margin-top: 40px')
    expect(rule(preferencesCss, '.preferences-theme-color'))
      .toContain('margin: 0')
    expect(rule(preferencesCss, '.preferences-tertiary-controls'))
      .toContain('gap: 16px')
    expect(rule(preferencesCss, '.preferences-section .preferences-tertiary-setting'))
      .toContain('margin: 0')
    expect(rule(preferencesCss, '.preferences-font-grid'))
      .toContain('gap: 0 33.333px')
    expect(rule(preferencesCss, '.preferences-font-grid .preferences-font-option'))
      .toContain('margin: 0 0 16px')
  })

  it('uses compact typography and the requested preference control layout', () => {
    expect(rule(preferencesCss, '.preferences-setting-label'))
      .toContain('font-size: 14px')
    expect(rule(preferencesCss, '.preferences-checkbox-label'))
      .toContain('text-align: left')
    expect(rule(preferencesCss, '.preferences-checkbox-description'))
      .toContain('display: flex')
    expect(rule(preferencesCss, '.preferences-range-value'))
      .toContain('font-size: 14px')
    expect(rule(preferencesCss, '.preferences-range-input'))
      .toContain('height: 10px')
    expect(rule(preferencesCss, '.preferences-range-input'))
      .toContain('appearance: none')
    expect(rule(preferencesCss, '.preferences-range-input'))
      .toContain('margin: 0')
    expect(rule(preferencesCss, '.preferences-range-input::-webkit-slider-runnable-track'))
      .toContain('rgb(var(--theme-color-rgb, 198 40 40))')
    expect(rule(preferencesCss, '.preferences-font-heading'))
      .toContain('font-size: 14px')
    expect(rule(preferencesCss, '.preferences-font-grid .preferences-font-option > span'))
      .toContain('font-size: 13px')
    expect(rule(preferencesCss, '.preferences-font-grid .preferences-font-option > span'))
      .toContain('color: #777')
    expect(rule(preferencesCss, '.preferences-font-grid .preferences-compact-select'))
      .toContain('height: 32px')
    expect(rule(preferencesCss, '.preferences-font-grid .preferences-compact-select'))
      .toContain('min-height: 32px')
  })

  it('places custom theme controls and reset on separate rows at 14px', () => {
    const controlsRule = rule(preferencesCss, '.preferences-theme-color-controls')
    expect(controlsRule).toContain('display: grid')
    expect(controlsRule).toContain('grid-template-columns: max-content max-content')
    expect(rule(preferencesCss, '.preferences-theme-swatches'))
      .toContain('grid-column: 1 / -1')
    expect(rule(preferencesCss, '.preferences-theme-custom'))
      .toContain('font-size: 14px')
    const resetRule = rule(
      preferencesCss,
      '.preferences-theme-color-controls > button:last-child',
    )
    expect(resetRule).toContain('grid-column: 1 / -1')
    expect(resetRule).toContain('font-size: 14px')
  })

  it('uses bold secondary headings and black regular tertiary titles', () => {
    expect(rule(preferencesCss, '.preferences-secondary-heading'))
      .toContain('font-weight: 700')
    expect(rule(preferencesCss, '.preferences-font-heading'))
      .toContain('font-weight: 700')
    expect(rule(preferencesCss, '.preferences-tertiary-title'))
      .toContain('color: #000')
    expect(rule(preferencesCss, '.preferences-tertiary-title'))
      .toContain('font-weight: var(--ui-font-weight-normal)')
    expect(rule(preferencesCss, '.preferences-font-grid'))
      .toContain('gap: 0 33.333px')
  })

  it('places the scrolling surface at the window edge', () => {
    const contentRule = rule(preferencesCss, '.preferences-page-content')
    expect(contentRule).toContain('width: 100%')
    expect(contentRule).toContain('margin: 0')
    expect(contentRule).toContain('padding: 0')
    expect(contentRule).toContain('overflow-y: auto')
  })

  it('scopes the stable preference scrollbar to the Arkdown application shell', () => {
    const contentSelector = '.app-shell.preferences-open > .preferences-page > .preferences-page-content'
    expect(rule(appCss, contentSelector)).toContain('scrollbar-gutter: stable')

    const scrollbarRule = rule(appCss, `${contentSelector}::-webkit-scrollbar`)
    expect(scrollbarRule).toContain('width: 12px')
    expect(scrollbarRule).toContain('height: 12px')

    expect(rule(appCss, `${contentSelector}::-webkit-scrollbar-track`))
      .toContain('background: transparent')

    const thumbRule = rule(appCss, `${contentSelector}::-webkit-scrollbar-thumb`)
    expect(thumbRule).toContain('border: 3px solid transparent')
    expect(thumbRule).toContain('border-radius: 999px')
    expect(thumbRule).toContain('background: rgb(0 0 0 / 10%)')
    expect(thumbRule).toContain('background-clip: padding-box')

    const hoverRule = rule(appCss, `${contentSelector}::-webkit-scrollbar-thumb:hover`)
    expect(hoverRule).toContain('background: rgb(0 0 0 / 20%)')

    const buttonRule = rule(appCss, `${contentSelector}::-webkit-scrollbar-button`)
    expect(buttonRule).toContain('display: none')
    expect(buttonRule).toContain('width: 0')
    expect(buttonRule).toContain('height: 0')

    expect(appCss).not.toMatch(/(?:^|\n)\.preferences-page-content::-webkit-scrollbar/mu)
  })

  it('styles the left preference directory with the theme color at 80%', () => {
    const directoryRule = rule(preferencesCss, '.preferences-toc')
    expect(directoryRule).toContain('font-size: 14px')
    expect(directoryRule)
      .toContain('color: rgb(var(--theme-color-rgb, 198 40 40) / 80%)')
    expect(directoryRule).toContain('position: sticky')
    expect(directoryRule).toContain('padding-top: 60px')
    expect(rule(preferencesCss, '.preferences-toc a'))
      .toContain('color: inherit')
    const currentRule = rule(preferencesCss, '.preferences-toc a[aria-current="location"]')
    expect(currentRule).toContain('background: rgb(var(--theme-color-rgb, 198 40 40) / 3%)')
    expect(currentRule).toContain('color: rgb(var(--theme-color-rgb, 198 40 40) / 100%)')
    expect(currentRule).not.toContain('border:')
  })

  it('applies the live theme color to native preference controls', () => {
    expect(preferencesCss).toMatch(
      /\.preferences-page\s+input:is\(\[type="checkbox"\],\s*\[type="radio"\],\s*\[type="range"\]\)\s*\{[^}]*accent-color:\s*rgb\(var\(--theme-color-rgb,\s*198 40 40\)\)/s,
    )
    expect(rule(preferencesCss, '.preferences-range-input::-webkit-slider-runnable-track'))
      .toContain('rgb(var(--theme-color-rgb, 198 40 40))')
    expect(rule(preferencesCss, '.preferences-range-input::-webkit-slider-thumb'))
      .toContain('background: rgb(var(--theme-color-rgb, 198 40 40))')
  })

  it('uses 32px preference action buttons with secondary-directory typography', () => {
    const actionButtonRule = rule(preferencesCss, '.preferences-page-actions button')
    expect(actionButtonRule).toContain('height: 32px')
    expect(actionButtonRule).toContain('font-size: 14px')
    expect(actionButtonRule).toContain('color: #333')
    expect(preferencesCss).toMatch(
      /\.preferences-page-actions button\s*\{[^}]*min-width:\s*126px;[^}]*\}/s,
    )
  })

  it('bolds primary directory items and indents selectable secondary items', () => {
    expect(rule(preferencesCss, '.preferences-toc-primary'))
      .toContain('font-weight: 700')
    expect(rule(preferencesCss, '.preferences-toc a.preferences-toc-secondary'))
      .toContain('padding-left: 24px')
  })

  it('keeps translation rail buttons quieter until hover without shifting layout', () => {
    const marker = rule(translationRailCss, '.translation-history-rail-button')
    expect(marker).toContain('opacity: 0.8')
    expect(marker).toContain('border: 1px solid rgb(var(--theme-color-rgb) / 24%)')
    expect(marker).toContain('background: #fff')
    expect(marker).toContain('color: rgb(var(--theme-color-rgb))')

    const hover = rule(translationRailCss, '.translation-history-rail-button:hover')
    expect(hover).toContain('opacity: 1')
    expect(hover).toContain('background: #fff')
    expect(hover).toContain('color: rgb(var(--theme-color-rgb))')
    expect(hover).toContain('border-color: rgb(var(--theme-color-rgb) / 36%)')
    expect(hover).toContain('box-shadow: 0 0 0 1px rgb(var(--theme-color-rgb) / 8%), 0 0 5px rgb(var(--theme-color-rgb) / 12%)')

    const active = rule(translationRailCss, '.translation-history-rail-button:active')
    expect(active).toContain('opacity: 1')
    expect(active).toContain('background: color-mix(in srgb, rgb(var(--theme-color-rgb)) 10%, #fff 90%)')
    expect(active).toContain('border-color: rgb(var(--theme-color-rgb))')
    expect(active).toContain('color: rgb(var(--theme-color-rgb))')
    expect(active).toContain('box-shadow: none')
    expect(rule(translationRailCss, '.translation-history-rail-button:active > .app-icon'))
      .toContain('opacity: 1')
    expect(translationRailCss).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.translation-history-rail-button\s*\{[^}]*transition:\s*none/,
    )
  })
})
