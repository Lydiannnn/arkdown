import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const scope = '.visual-editor .arkdown-mermaid-block'
const stylesheetPath = path.join(
  process.cwd(),
  'src/renderer/editor/mermaid/mermaid-code-block.css',
)
const css = existsSync(stylesheetPath) ? readFileSync(stylesheetPath, 'utf8') : ''

function styleRules(rules: CSSRuleList): CSSStyleRule[] {
  return Array.from(rules).flatMap((rule) => {
    if (rule instanceof CSSStyleRule) return [rule]
    if ('cssRules' in rule) return styleRules((rule as CSSGroupingRule).cssRules)
    return []
  })
}

function parsedRules(): CSSStyleRule[] {
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)
  const rules = styleRules(style.sheet!.cssRules)
  style.remove()
  return rules
}

function ruleContaining(fragment: string): CSSStyleRule {
  const rule = parsedRules().find((candidate) => candidate.selectorText.includes(fragment))
  expect(rule, `missing CSS rule containing ${fragment}`).toBeDefined()
  return rule!
}

describe('Mermaid code block styles', () => {
  it('keeps every selector inside the visual-editor Mermaid block boundary', () => {
    const selectors = parsedRules().flatMap((rule) => rule.selectorText.split(','))

    expect(selectors.length).toBeGreaterThan(0)
    for (const selector of selectors) expect(selector.trim()).toMatch(
      /^\.visual-editor \.arkdown-mermaid-block(?:$|[\s:.[#>+~])/,
    )
    expect(css).not.toMatch(/(?:^|[,{}])\s*svg(?:[\s.{:#>+~]|$)/m)
  })

  it('contains the block and keeps preview images responsive', () => {
    const block = ruleContaining(scope)
    const preview = ruleContaining(`${scope} .arkdown-mermaid-preview`)
    const image = ruleContaining(`${scope} .arkdown-mermaid-preview img`)

    expect(block.style.borderRadius).toBe('8px')
    expect(block.style.maxInlineSize).toBe('100%')
    expect(block.style.overflow).toBe('hidden')
    expect(preview.style.overflow).toMatch(/auto|hidden/)
    expect(image.style.display).toBe('block')
    expect(image.style.maxInlineSize).toBe('100%')
    expect(image.style.height).toBe('auto')
  })

  it('uses Arkdown variables for state colors and exposes keyboard focus', () => {
    const loading = ruleContaining(`${scope} .arkdown-mermaid-preview[role="status"]`)
    const error = ruleContaining(`${scope} .arkdown-mermaid-preview[role="alert"]`)
    const focus = ruleContaining(`${scope} button:focus-visible`)

    expect(loading.style.color).toContain('var(--crepe-color-on-surface-variant')
    expect(error.style.color).toContain('var(--crepe-color-error')
    expect(focus.style.outline).toContain('var(--theme-color-rgb')
  })

  it('removes Mermaid UI transitions when reduced motion is requested', () => {
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.visual-editor \.arkdown-mermaid-block[\s\S]*?transition:\s*none/,
    )
  })
})
