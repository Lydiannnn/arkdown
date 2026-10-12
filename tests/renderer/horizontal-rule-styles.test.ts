import { describe, expect, test } from 'vitest'
import {
  DEFAULT_HORIZONTAL_RULE_STYLE_ID,
  HORIZONTAL_RULE_STYLES,
  applyHorizontalRuleDomStyle,
  horizontalRuleDomStyle,
  parseHorizontalRuleHtml,
  serializeHorizontalRule,
} from '../../src/renderer/editor/horizontal-rule-styles'

describe('controlled horizontal rule styles', () => {
  test('keeps the eleven legacy insertion presets in menu order', () => {
    expect(HORIZONTAL_RULE_STYLES).toHaveLength(11)
    expect(HORIZONTAL_RULE_STYLES.map(({ id, height }) => ({ id, height }))).toEqual([
      { id: 'black-40', height: 2 },
      { id: 'black-80', height: 2 },
      { id: 'purple-40', height: 2 },
      { id: 'blue-40', height: 2 },
      { id: 'cyan-40', height: 2 },
      { id: 'green-40', height: 2 },
      { id: 'orange-40', height: 2 },
      { id: 'red-40', height: 2 },
      { id: 'pink-40', height: 2 },
      { id: 'black-40-double', height: 4 },
      { id: 'black-40-quadruple', height: 8 },
    ])
  })

  test('applies the legacy default to ordinary Markdown rules', () => {
    const rule = document.createElement('hr')
    expect(DEFAULT_HORIZONTAL_RULE_STYLE_ID).toBe('black-40')
    expect(applyHorizontalRuleDomStyle(rule, DEFAULT_HORIZONTAL_RULE_STYLE_ID)).toBe(true)
    expect(rule.style.backgroundColor).toBe('rgba(0, 0, 0, 0.4)')
    expect(rule.style.blockSize).toBe('2px')
    expect(rule.style.height).toBe('2px')
  })

  test('serializes legacy insertion presets into canonical three-attribute HTML', () => {
    for (const style of HORIZONTAL_RULE_STYLES) {
      const parsed = parseHorizontalRuleHtml(serializeHorizontalRule(style))
      expect(parsed).toMatchObject({
        heightPx: style.height,
      })
      expect(parsed?.opacityPercent).toBe(style.id === 'black-80' ? 80 : 40)
    }
  })

  test('rejects unregistered legacy and extended HTML', () => {
    expect(parseHorizontalRuleHtml('<hr data-arkdown-style="unknown" />')).toBeNull()
    expect(parseHorizontalRuleHtml(
      '<hr data-arkdown-style="red" data-arkdown-height="2" data-arkdown-opacity="40" style="height:999px" />',
    )).toBeNull()
    expect(parseHorizontalRuleHtml(
      '<hr onclick="alert(1)" data-arkdown-style="red-40" />',
    )).toBeNull()
    expect(horizontalRuleDomStyle('red-20-quadruple')).toBeNull()
  })
})
