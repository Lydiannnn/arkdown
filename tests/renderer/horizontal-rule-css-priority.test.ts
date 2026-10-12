import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyHorizontalRuleDomStyle } from '../../src/renderer/editor/horizontal-rule-styles'

const css = readFileSync(
  path.join(process.cwd(), 'src/renderer/app/styles.css'),
  'utf8',
)

afterEach(() => {
  document.head.querySelector('[data-test="horizontal-rule-css"]')?.remove()
  document.body.replaceChildren()
})

describe('horizontal rule CSS cascade', () => {
  it('lets controlled inline dimensions win over every matching editor rule', () => {
    const style = document.head.appendChild(document.createElement('style'))
    style.dataset.test = 'horizontal-rule-css'
    style.textContent = css
    const editor = document.body.appendChild(document.createElement('div'))
    editor.className = 'visual-editor'
    const proseMirror = editor.appendChild(document.createElement('div'))
    proseMirror.className = 'ProseMirror'
    const horizontalRule = proseMirror.appendChild(document.createElement('hr'))
    applyHorizontalRuleDomStyle(horizontalRule, {
      styleId: 'blue', heightPx: 7, opacityPercent: 60,
    })

    const matchingRules = Array.from(style.sheet?.cssRules ?? [])
      .filter((entry): entry is CSSStyleRule => (
        entry instanceof CSSStyleRule
        && entry.selectorText.split(',').some((selector) => {
          try {
            return horizontalRule.matches(selector.trim())
          } catch {
            return false
          }
        })
      ))
    expect(matchingRules.filter((entry) => (
      entry.style.getPropertyPriority('height') === 'important'
      || entry.style.getPropertyPriority('block-size') === 'important'
    ))).toEqual([])
    expect(getComputedStyle(horizontalRule).height).toBe('7px')
    expect(getComputedStyle(horizontalRule).blockSize).toBe('7px')
  })
})
