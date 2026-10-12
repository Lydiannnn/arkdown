import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const cssFiles = {
  root: readFileSync(resolve(process.cwd(), 'src/renderer/app/styles.css'), 'utf8'),
  contextMenu: readFileSync(resolve(process.cwd(), 'src/renderer/context-menu/context-menu.css'), 'utf8'),
  applicationMenu: readFileSync(resolve(process.cwd(), 'src/renderer/chrome/application-menu-popover.css'), 'utf8'),
  workspaceMenu: readFileSync(resolve(process.cwd(), 'src/renderer/workspace/workspace-context-menu.css'), 'utf8'),
}

const separatorSelectors = [
  '.context-menu-separator',
  '.application-menu-separator',
]

const sharedWrapperSelector = '.menu-hairline'
const sharedStrokeSelector = '.menu-hairline-stroke'

const separatorRule = (css: string, selector: string) => {
  const match = css.match(new RegExp(`${selector.replace('.', '\\.')}` + String.raw`\s*\{([^}]*)\}`, 'u'))

  expect(match, `Expected ${selector} to have a CSS rule`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('context-menu divider styles', () => {
  it('defines the shared one-pixel divider tokens at the renderer root', () => {
    expect(cssFiles.root).toMatch(/:root\s*\{[^}]*--menu-divider-size:\s*1px;[^}]*--menu-divider-color:\s*#ececec;/su)
  })

  it('keeps every menu family wrapper as a one-CSS-pixel layout slot with its existing inset', () => {
    const rules = [
      separatorRule(cssFiles.contextMenu, separatorSelectors[0]),
      separatorRule(cssFiles.applicationMenu, separatorSelectors[1]),
    ]

    for (const declarations of rules) {
      expect(declarations).not.toMatch(/\b(?:background|border|box-shadow)\s*:/u)
      expect(declarations).not.toMatch(/\btransform\s*:/u)
    }

    expect(rules[0]).toMatch(/margin:\s*4px 0;/u)
    expect(rules[1]).toMatch(/margin:\s*4px -5px;/u)
  })

  it('assigns layout to the wrapper and all visible paint to one inner stroke', () => {
    const wrapper = separatorRule(cssFiles.root, sharedWrapperSelector)
    const stroke = separatorRule(cssFiles.root, sharedStrokeSelector)

    expect(wrapper).toMatch(/position:\s*relative;/u)
    expect(wrapper).toMatch(/height:\s*var\(--menu-divider-size\);/u)
    expect(wrapper).toMatch(/background:\s*transparent;/u)
    expect(wrapper).toMatch(/border:\s*0;/u)
    expect(wrapper).not.toMatch(/\b(?:box-shadow|transform)\s*:/u)

    expect(stroke).toMatch(/position:\s*absolute;/u)
    expect(stroke).toMatch(/background:\s*linear-gradient\(/u)
    expect(stroke.match(/var\(--menu-divider-color\)/gu)).toHaveLength(1)
    expect(stroke).toMatch(/pointer-events:\s*none;/u)
    expect(stroke).toMatch(/transform-origin:\s*center;/u)
    expect(stroke).toMatch(/transform:\s*translateY\([^;]+\)\s+scaleY\(/u)
    expect(stroke).not.toMatch(/\b(?:border|box-shadow)\s*:/u)

    for (const selector of separatorSelectors) {
      const pseudoElement = new RegExp(`${selector.replace('.', '\\.')}` + String.raw`::(?:before|after)\s*\{[^}]*\b(?:background|border|height)\s*:`, 'u')
      expect(Object.values(cssFiles).some((css) => pseudoElement.test(css))).toBe(false)
    }
    const sharedPseudoElement = /\.menu-hairline(?:::(?:before|after))\s*\{[^}]*\b(?:background|border|box-shadow|height)\s*:/u
    expect(Object.values(cssFiles).some((css) => sharedPseudoElement.test(css))).toBe(false)
  })

  it('keeps the workspace context-menu stylesheet free of competing separator strokes', () => {
    expect(cssFiles.workspaceMenu).not.toMatch(/context-menu-separator|application-menu-separator/u)
  })
})
