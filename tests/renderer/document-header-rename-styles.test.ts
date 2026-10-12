import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

function styleFrom(relativePath: string): HTMLStyleElement {
  const style = document.createElement('style')
  style.textContent = readFileSync(path.join(process.cwd(), relativePath), 'utf8')
  return style
}

const tooltipStyle = styleFrom('src/renderer/tooltip/tooltip.css')
const headerStyle = styleFrom('src/renderer/chrome/document-header.css')
const editIndicatorStyle = styleFrom(
  'src/renderer/editor/edit-indicators/edit-indicators.css',
)

beforeAll(() => document.head.append(tooltipStyle, headerStyle, editIndicatorStyle))
afterEach(() => document.body.replaceChildren())
afterAll(() => {
  tooltipStyle.remove()
  headerStyle.remove()
  editIndicatorStyle.remove()
})

function latestApplicableValue(
  style: HTMLStyleElement,
  element: Element,
  properties: readonly string[],
): string | undefined {
  const rules = [...(style.sheet?.cssRules ?? [])]
  for (const cssRule of rules.reverse()) {
    if (!(cssRule instanceof CSSStyleRule) || !element.matches(cssRule.selectorText)) continue
    for (const property of properties) {
      const value = cssRule.style.getPropertyValue(property)
      if (value) return value
    }
  }
  return undefined
}

function appendHeaderFixture(editorWidth = '160px'): HTMLElement {
  const host = document.createElement('main')
  host.className = 'editor-host'
  host.style.cssText = `overflow: hidden; width: ${editorWidth}`
  host.innerHTML = `
    <header class="document-header">
      <div class="document-identity">
        <h1>notes.md</h1>
        <div class="document-file-name-editor" style="width: ${editorWidth}">
          <input class="document-file-name-input" value="notes.md">
          <div class="document-file-name-tooltip" role="tooltip">
            Windows system filenames cannot contain invalid characters
          </div>
        </div>
      </div>
    </header>
  `
  document.body.append(host)
  return host
}

function appendEditIndicatorFixture(): {
  sourceSaved: HTMLElement
  sourceUnsaved: HTMLElement
} {
  const fixture = document.createElement('div')
  fixture.style.setProperty('--theme-color-rgb', '198 40 40')
  fixture.innerHTML = `
    <div class="source-editor">
      <span class="arkdown-source-edit-indicator arkdown-source-edit-indicator--saved"></span>
      <span class="arkdown-source-edit-indicator arkdown-source-edit-indicator--unsaved"></span>
    </div>
  `
  document.body.append(fixture)

  return {
    sourceSaved: fixture.querySelector('.arkdown-source-edit-indicator--saved')!,
    sourceUnsaved: fixture.querySelector('.arkdown-source-edit-indicator--unsaved')!,
  }
}

describe('document header rename styling', () => {
  it('renders the filename label and input text at ninety-percent black', () => {
    const header = appendHeaderFixture()
    const heading = header.querySelector('h1')!
    const input = header.querySelector<HTMLInputElement>('.document-file-name-input')!
    const expectedColor = 'rgba(0, 0, 0, 0.9)'

    expect(getComputedStyle(heading).color).toBe(expectedColor)
    const inputStyle = getComputedStyle(input)
    expect(inputStyle.color).toBe(expectedColor)
  })

  it('removes only the input outer glow while retaining a visible editable border and surface', () => {
    const header = appendHeaderFixture()
    const input = header.querySelector<HTMLInputElement>('.document-file-name-input')!
    input.focus()

    const inputStyle = getComputedStyle(input)
    expect(inputStyle.boxShadow).toBe('none')
    expect(latestApplicableValue(headerStyle, input, ['border-style', 'border']))
      .toMatch(/\bsolid\b/)
    expect(latestApplicableValue(headerStyle, input, ['border-width', 'border']))
      .not.toMatch(/^(?:0(?:px)?|none)$/)
    expect(inputStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  })

  it('positions a white warning tooltip immediately below the filename input', () => {
    const header = appendHeaderFixture()
    const editor = header.querySelector('.document-file-name-editor')!
    const tooltip = header.querySelector('.document-file-name-tooltip')!

    expect(getComputedStyle(editor).position).toBe('relative')
    const tooltipStyle = getComputedStyle(tooltip)
    expect(tooltipStyle.position).toBe('absolute')
    expect(tooltipStyle.top).toBe('calc(100% + 4px)')
    expect(tooltipStyle.left).toBe('0px')
    expect(tooltipStyle.borderStyle).toBe('solid')
    expect(tooltipStyle.borderColor).toBe('rgb(230, 230, 230)')
    expect(tooltipStyle.borderRadius).toBe('8px')
    expect(tooltipStyle.backgroundColor).toBe('rgb(255, 255, 255)')
    expect(tooltipStyle.boxShadow).toBe('0 4px 12px rgb(0 0 0 / 10%)')
    expect(tooltipStyle.color).toBe('rgb(198, 40, 40)')
  })

  it('keeps a long tooltip within a narrow filename editor and allows it to wrap', () => {
    const header = appendHeaderFixture('120px')
    const tooltip = header.querySelector('.document-file-name-tooltip')!
    const tooltipStyle = getComputedStyle(tooltip)

    expect(tooltipStyle.maxWidth).toBe('100%')
    expect(tooltipStyle.whiteSpace).toBe('normal')
    expect(tooltipStyle.overflowWrap).toBe('anywhere')
  })
})

describe('edit indicator saved-state styling', () => {
  it('uses solid green fill for source saved indicators', () => {
    const { sourceSaved } = appendEditIndicatorFixture()
    expect(getComputedStyle(sourceSaved).backgroundColor).toBe('rgb(24, 134, 75)')
  })

  it('keeps source unsaved indicators hollow, theme-colored, and pulsing', () => {
    const { sourceUnsaved } = appendEditIndicatorFixture()
    const style = getComputedStyle(sourceUnsaved)
    expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(style.boxShadow).toContain('var(--theme-color-rgb)')
    expect(style.animation).toContain('arkdown-unsaved-edit-indicator-pulse')
  })
})
