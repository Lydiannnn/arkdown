import { describe, expect, test, vi } from 'vitest'
import { resolveEditorDomContext } from '../../src/renderer/editor/context-menu/editor-context'
import { buildVisualEditorMenu } from '../../src/renderer/editor/context-menu/editor-menu-model'
import {
  executeHorizontalRuleCommand,
  horizontalRuleMarkdownForElement,
} from '../../src/renderer/editor/context-menu/visual-editor-commands'
import type { ContextMenuItem } from '../../src/renderer/context-menu/context-menu-types'

type CommandItem = Extract<ContextMenuItem, { kind: 'command' }>

function commands(items: readonly ContextMenuItem[]): CommandItem[] {
  return items.filter((item): item is CommandItem => item.kind === 'command')
}

describe('horizontal rule context menu', () => {
  test('recognizes a controlled rule and shows only the five dedicated actions', () => {
    const rule = document.createElement('hr')
    Object.assign(rule.dataset, {
      arkdownStyle: 'cyan', arkdownHeight: '6', arkdownOpacity: '70',
    })
    const context = resolveEditorDomContext(rule, 'ignored selection')
    expect(context).toMatchObject({
      kind: 'horizontal-rule',
      horizontalRule: {
        attributes: { styleId: 'cyan', heightPx: 6, opacityPercent: 70 },
      },
    })
    const menu = buildVisualEditorMenu(context)
    expect(menu.map((item) => {
      if (item.kind === 'separator') return 'separator'
      if (item.kind === 'icon-grid') return 'icon-grid'
      return item.label
    })).toEqual([
      '增加 1px', '减少 1px', '加深 10%', '减淡 10%', 'separator', '复制分割线',
    ])
  })

  test('disables matching actions at height and opacity boundaries', () => {
    const rule = document.createElement('hr')
    Object.assign(rule.dataset, {
      arkdownStyle: 'black', arkdownHeight: '12', arkdownOpacity: '10',
    })
    const items = commands(buildVisualEditorMenu(resolveEditorDomContext(rule, '')))
    expect(items.find((item) => item.id === 'horizontal-rule-height-increase'))
      .toMatchObject({ disabled: true })
    expect(items.find((item) => item.id === 'horizontal-rule-height-decrease'))
      .toMatchObject({ disabled: false })
    expect(items.find((item) => item.id === 'horizontal-rule-opacity-increase'))
      .toMatchObject({ disabled: false })
    expect(items.find((item) => item.id === 'horizontal-rule-opacity-decrease'))
      .toMatchObject({ disabled: true })
  })

  test('updates in place and emits canonical replacement without moving selection', async () => {
    const host = document.createElement('div')
    const before = document.createTextNode('before')
    const rule = document.createElement('hr')
    host.append(before, rule, document.createTextNode('after'))
    document.body.append(host)
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(before, 2)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    const replacements: string[] = []
    rule.addEventListener('arkdown:horizontal-rule-change', (event) => {
      replacements.push((event as CustomEvent<{ markdown: string }>).detail.markdown)
    })

    await executeHorizontalRuleCommand(rule, 'horizontal-rule-height-increase')

    expect(rule.dataset.arkdownHeight).toBe('3')
    expect(rule.style.height).toBe('3px')
    expect(replacements).toEqual([
      '<hr data-arkdown-style="black" data-arkdown-height="3" data-arkdown-opacity="40" />',
    ])
    expect(selection.anchorNode).toBe(before)
    expect(selection.anchorOffset).toBe(2)
    host.remove()
  })

  test('copies the complete controlled fragment and never inline styles', async () => {
    const rule = document.createElement('hr')
    Object.assign(rule.dataset, {
      arkdownStyle: 'pink', arkdownHeight: '4', arkdownOpacity: '80',
    })
    rule.style.border = '999px solid red'
    const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined)
    const expected = '<hr data-arkdown-style="pink" data-arkdown-height="4" data-arkdown-opacity="80" />'

    expect(horizontalRuleMarkdownForElement(rule)).toBe(expected)
    await executeHorizontalRuleCommand(rule, 'horizontal-rule-copy', writeText)
    expect(writeText).toHaveBeenCalledWith(expected)
  })
})
