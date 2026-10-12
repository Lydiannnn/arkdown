import { describe, expect, it } from 'vitest'
import { DEFAULT_STICKY_NOTE_PREFERENCES } from '../../src/shared/sticky-note-preferences'
import {
  buildStickyNoteBlankMenu,
  buildStickyNoteTextMenu,
  selectWordAtPoint,
  stickyNoteMaterialForCommand,
} from '../../src/renderer/sticky-notes/sticky-note-context-menu'
import type { ContextMenuItem } from '../../src/renderer/context-menu/context-menu-types'

function commandIds(items: readonly ContextMenuItem[]): string[] {
  return items.flatMap((item) => {
    if (item.kind === 'command') return [item.id]
    if (item.kind === 'submenu' || item.kind === 'icon-grid') return commandIds(item.items)
    return []
  })
}

describe('sticky note context menus', () => {
  it('offers exactly the text editing commands and selects an unselected word', () => {
    expect(commandIds(buildStickyNoteTextMenu('heading-4'))).toEqual([
      'sticky-paragraph-heading-4',
      'sticky-paragraph-paragraph',
      'sticky-paragraph-blockquote',
      'sticky-copy',
      'sticky-paste',
      'sticky-cut',
      'sticky-delete',
    ])

    const host = document.createElement('p')
    host.textContent = 'alpha beta'
    document.body.append(host)
    expect(selectWordAtPoint(host.firstChild! as Text, 7)).toBe(true)
    expect(window.getSelection()?.toString()).toBe('beta')
    host.remove()
  })

  it('models the editor actions, removes the texture submenu, and opens background settings', () => {
    const menu = buildStickyNoteBlankMenu({
      preferences: DEFAULT_STICKY_NOTE_PREFERENCES,
      style: { mode: 'preset', colorPresetId: 'blue', texturePresetId: 'grid' },
      fontSizePx: 13,
      lineSpacingMode: 'compact',
      selectedBlockStyle: 'paragraph',
    })
    expect(menu.map((item) => item.id)).toEqual([
      'sticky-paragraph',
      'sticky-paste',
      'sticky-insert-primary-separator',
      'sticky-horizontal-rule',
      'sticky-insert-image',
      'sticky-style-separator',
      'sticky-font-size-increase',
      'sticky-font-size-decrease',
      'sticky-line-spacing',
      'sticky-appearance-separator',
      'sticky-material',
      'sticky-color',
      'sticky-background-settings',
      'sticky-manage-separator',
      'sticky-rename',
      'sticky-archive',
    ])

    const paragraphMenu = menu.find((item) => item.id === 'sticky-paragraph')
    expect(paragraphMenu?.kind === 'submenu' ? paragraphMenu.items.map((item) => (
      item.kind === 'command' ? [item.label, item.checked] : null
    )) : []).toEqual([
      ['标题', false],
      ['正文', true],
      ['附注', false],
    ])

    const mixedMenu = buildStickyNoteTextMenu('mixed')[0]
    expect(mixedMenu.kind === 'submenu' ? mixedMenu.items.map((item) => (
      item.kind === 'command' ? item.checked : null
    )) : []).toEqual([false, false, false])

    const ruleMenu = menu.find((item) => item.id === 'sticky-horizontal-rule')
    expect(ruleMenu?.kind).toBe('submenu')
    const ruleGrid = ruleMenu?.kind === 'submenu' ? ruleMenu.items[0] : undefined
    expect(ruleGrid?.kind).toBe('icon-grid')
    expect(ruleGrid?.kind === 'icon-grid' ? ruleGrid.items.map((item) => ({
      id: item.id,
      label: item.label,
      preview: item.preview,
    })) : []).toEqual([
      { id: 'sticky-horizontal-rule-black', label: '黑色', preview: { kind: 'horizontal-rule', color: 'rgb(0 0 0 / 50%)', height: 1 } },
      { id: 'sticky-horizontal-rule-red', label: '红色', preview: { kind: 'horizontal-rule', color: 'rgb(198 40 40 / 50%)', height: 1 } },
      { id: 'sticky-horizontal-rule-orange', label: '橙色', preview: { kind: 'horizontal-rule', color: 'rgb(198 106 0 / 50%)', height: 1 } },
      { id: 'sticky-horizontal-rule-green', label: '绿色', preview: { kind: 'horizontal-rule', color: 'rgb(24 134 75 / 50%)', height: 1 } },
      { id: 'sticky-horizontal-rule-cyan', label: '青色', preview: { kind: 'horizontal-rule', color: 'rgb(0 124 145 / 50%)', height: 1 } },
      { id: 'sticky-horizontal-rule-blue', label: '蓝色', preview: { kind: 'horizontal-rule', color: 'rgb(37 99 235 / 50%)', height: 1 } },
      { id: 'sticky-horizontal-rule-purple', label: '紫色', preview: { kind: 'horizontal-rule', color: 'rgb(128 0 128 / 50%)', height: 1 } },
      { id: 'sticky-horizontal-rule-pink', label: '粉色', preview: { kind: 'horizontal-rule', color: 'rgb(184 50 128 / 50%)', height: 1 } },
    ])

    const spacingMenu = menu.find((item) => item.id === 'sticky-line-spacing')
    expect(menu[menu.indexOf(spacingMenu!) + 1]).toEqual({ kind: 'separator', id: 'sticky-appearance-separator' })
    expect(spacingMenu?.kind === 'submenu' ? spacingMenu.items.map((item) => (
      item.kind === 'command' ? [item.id, item.label, item.checked] : null
    )) : []).toEqual([
      ['sticky-line-spacing-compact', '使用压缩行间距', true],
      ['sticky-line-spacing-standard', '使用标准行间距', false],
    ])

    const colorMenu = menu.find((item) => item.id === 'sticky-color')
    expect(colorMenu?.kind === 'submenu' ? colorMenu.items.map((item) => (
      item.kind === 'command' ? [item.id, item.checked] : null
    )) : []).toEqual([
      ['sticky-color-yellow', false],
      ['sticky-color-red', false],
      ['sticky-color-green', false],
      ['sticky-color-blue', true],
      ['sticky-color-purple', false],
      ['sticky-color-orange', false],
      ['sticky-color-gray', false],
      ['sticky-color-custom', false],
    ])

    expect(menu.find((item) => item.id === 'sticky-texture')).toBeUndefined()
    expect(menu.find((item) => item.id === 'sticky-background-settings')).toEqual({
      kind: 'command',
      id: 'sticky-background-settings',
      label: '设置背景...',
    })
    expect(commandIds(menu)).toHaveLength(32)
  })

  it('shows material presets in catalog order, checks the active material, and parses commands strictly', () => {
    const menu = buildStickyNoteBlankMenu({
      preferences: DEFAULT_STICKY_NOTE_PREFERENCES,
      style: { mode: 'material', materialPresetId: 'flowing-glass' },
      fontSizePx: 13,
      lineSpacingMode: 'compact',
      selectedBlockStyle: 'paragraph',
    })
    const materialMenu = menu.find((item) => item.id === 'sticky-material')

    expect(materialMenu).toMatchObject({ kind: 'submenu', label: '材质' })
    expect(materialMenu?.kind === 'submenu' ? materialMenu.items.map((item) => (
      item.kind === 'command'
        ? [item.id, item.label, item.checked, item.checkedAppearance, item.swatchColor]
        : null
    )) : []).toEqual([
      ['sticky-material-mica-light', 'Mica', false, undefined, undefined],
      ['sticky-material-flowing-glass', 'Acrylic', true, undefined, undefined],
      ['sticky-material-warm-frosted-glass', '暖雾玻璃', false, undefined, undefined],
      ['sticky-material-clear-glass', '深色玻璃', false, undefined, undefined],
    ])
    expect(stickyNoteMaterialForCommand('sticky-material-mica-light')).toBe('mica-light')
    expect(stickyNoteMaterialForCommand('sticky-material-flowing-glass')).toBe('flowing-glass')
    expect(stickyNoteMaterialForCommand('sticky-material-mica-dark')).toBeNull()
    expect(stickyNoteMaterialForCommand('sticky-material-invalid')).toBeNull()
    expect(stickyNoteMaterialForCommand('sticky-material-mica-dark-extra')).toBeNull()
    expect(stickyNoteMaterialForCommand('sticky-material-')).toBeNull()
    expect(stickyNoteMaterialForCommand('mica-dark')).toBeNull()
  })

  it('reverses the checked line-spacing command for standard mode', () => {
    const menu = buildStickyNoteBlankMenu({
      preferences: DEFAULT_STICKY_NOTE_PREFERENCES,
      style: { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
      fontSizePx: 14,
      lineSpacingMode: 'standard',
      selectedBlockStyle: 'paragraph',
    })
    const spacingMenu = menu.find((item) => item.id === 'sticky-line-spacing')

    expect(spacingMenu?.kind === 'submenu' ? spacingMenu.items.map((item) => (
      item.kind === 'command' ? [item.id, item.checked] : null
    )) : []).toEqual([
      ['sticky-line-spacing-compact', false],
      ['sticky-line-spacing-standard', true],
    ])
  })
})

it('selects Custom with the independent snapshot swatch in the blank menu', () => {
  const menu = buildStickyNoteBlankMenu({ preferences: DEFAULT_STICKY_NOTE_PREFERENCES, style: { mode: 'independent', color: '#123456', texture: { pattern: 'none', foregroundColor: '#000000', opacityPercent: 0, scalePx: 16 } }, fontSizePx: 13, lineSpacingMode: 'compact', selectedBlockStyle: 'paragraph' })
  const colors = menu.find(item => item.id === 'sticky-color')
  expect(colors?.kind === 'submenu' ? colors.items.filter(item => item.kind === 'command' && item.checked) : []).toEqual([expect.objectContaining({ id: 'sticky-color-custom', checked: true, swatchColor: '#123456' })])
})
