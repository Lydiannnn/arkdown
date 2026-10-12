import { describe, expect, test } from 'vitest'
import {
  DEFAULT_HORIZONTAL_RULE_ATTRIBUTES,
  adjustHorizontalRule,
  applyHorizontalRuleDomStyle,
  horizontalRuleDomStyle,
  normalizeHorizontalRuleAttributes,
  parseHorizontalRuleHtml,
  serializeHorizontalRule,
} from '../../src/renderer/editor/horizontal-rule-styles'

describe('horizontal rule controlled attributes and HTML round trip', () => {
  test('normalizes the approved bounds and adjusts height/opacity in fixed steps', () => {
    expect(normalizeHorizontalRuleAttributes({
      styleId: 'red', heightPx: 12, opacityPercent: 10,
    })).toEqual({ styleId: 'red', heightPx: 12, opacityPercent: 10 })
    expect(normalizeHorizontalRuleAttributes({
      styleId: 'pink', heightPx: 1, opacityPercent: 100,
    })).toEqual({ styleId: 'pink', heightPx: 1, opacityPercent: 100 })
    expect(adjustHorizontalRule(
      { styleId: 'orange', heightPx: 6, opacityPercent: 50 },
      'height-increase',
    )).toEqual({ styleId: 'orange', heightPx: 7, opacityPercent: 50 })
    expect(adjustHorizontalRule(
      { styleId: 'orange', heightPx: 6, opacityPercent: 50 },
      'opacity-decrease',
    )).toEqual({ styleId: 'orange', heightPx: 6, opacityPercent: 40 })
    expect(adjustHorizontalRule(
      { styleId: 'orange', heightPx: 12, opacityPercent: 100 },
      'height-increase',
    )).toEqual({ styleId: 'orange', heightPx: 12, opacityPercent: 100 })
    expect(adjustHorizontalRule(
      { styleId: 'orange', heightPx: 1, opacityPercent: 10 },
      'opacity-decrease',
    )).toEqual({ styleId: 'orange', heightPx: 1, opacityPercent: 10 })
  })

  test('falls invalid fields back independently to safe defaults', () => {
    expect(normalizeHorizontalRuleAttributes({
      styleId: 'chartreuse', heightPx: 1.5, opacityPercent: 55,
    })).toEqual(DEFAULT_HORIZONTAL_RULE_ATTRIBUTES)
    expect(normalizeHorizontalRuleAttributes({
      styleId: 'blue', heightPx: 13, opacityPercent: 0,
    })).toEqual({ ...DEFAULT_HORIZONTAL_RULE_ATTRIBUTES, styleId: 'blue' })
  })

  test('preserves all three attributes in canonical source and rejects arbitrary CSS', () => {
    const attributes = { styleId: 'red' as const, heightPx: 3, opacityPercent: 50 }
    const markdown = serializeHorizontalRule(attributes)
    expect(markdown).toBe(
      '<hr data-arkdown-style="red" data-arkdown-height="3" data-arkdown-opacity="50" />',
    )
    expect(parseHorizontalRuleHtml(markdown)).toEqual(attributes)
    expect(parseHorizontalRuleHtml(
      '<hr data-arkdown-style="red" data-arkdown-height="3" data-arkdown-opacity="50" style="height:999px" />',
    )).toBeNull()
    expect(parseHorizontalRuleHtml(
      '<hr onclick="alert(1)" data-arkdown-style="red" data-arkdown-height="3" data-arkdown-opacity="50" />',
    )).toBeNull()
  })

  test('falls invalid controlled values back and accepts legacy snippets', () => {
    expect(parseHorizontalRuleHtml(
      '<hr data-arkdown-style="unknown" data-arkdown-height="13" data-arkdown-opacity="55" />',
    )).toEqual(DEFAULT_HORIZONTAL_RULE_ATTRIBUTES)
    expect(parseHorizontalRuleHtml('<hr data-arkdown-style="purple-40" />')).toEqual({
      styleId: 'purple', heightPx: 2, opacityPercent: 40,
    })
  })

  test('keeps every legacy preset visually unchanged', () => {
    expect(horizontalRuleDomStyle('black-40')).toEqual({
      backgroundColor: 'rgb(0 0 0 / 40%)', blockSize: '2px', height: '2px',
    })
    expect(horizontalRuleDomStyle('black-80')).toMatchObject({
      backgroundColor: 'rgb(0 0 0 / 80%)', height: '2px',
    })
    expect(horizontalRuleDomStyle('black-40-double')).toMatchObject({ height: '4px' })
    expect(horizontalRuleDomStyle('black-40-quadruple')).toMatchObject({ height: '8px' })
    expect(horizontalRuleDomStyle('red-40')).toMatchObject({
      backgroundColor: 'rgb(198 40 40 / 40%)', height: '2px',
    })
  })

  test('renders controlled attributes without retaining arbitrary inline CSS', () => {
    const rule = document.createElement('hr')
    rule.style.border = '9px solid lime'
    expect(applyHorizontalRuleDomStyle(rule, {
      styleId: 'blue', heightPx: 7, opacityPercent: 30,
    })).toBe(true)
    expect(rule.dataset).toMatchObject({
      arkdownStyle: 'blue', arkdownHeight: '7', arkdownOpacity: '30',
    })
    expect(rule.style.backgroundColor).toBe('rgba(37, 99, 235, 0.3)')
    expect(rule.style.height).toBe('7px')
    expect(rule.style.border).toBe('')
  })
})
