import { describe, expect, it } from 'vitest'
import { buildActiveStickyNoteMenu } from '../../src/renderer/sticky-notes/sticky-note-menu-model'
import {
  DEFAULT_STICKY_NOTE_PREFERENCES,
  copyStickyNotePreferences,
} from '../../src/shared/sticky-note-preferences'
import type { StickyNoteSummary } from '../../src/shared/sticky-notes'
import type { StickyNoteStyleReference } from '../../src/shared/sticky-note-preferences'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

function note(
  style: StickyNoteStyleReference = {
    mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain',
  },
  released = false,
): StickyNoteSummary {
  return {
    record: {
      id: '10000000-0000-4000-8000-000000000001',
      name: '计划',
      status: 'active',
      markdownRelativePath: 'active/id/计划.md',
      resourcesRelativePath: 'active/id/assets',
      style,
      background: { ...DEFAULT_BACKGROUND_SETTINGS },
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z',
      archivedAt: null,
      released,
      pinned: false,
      windowBounds: null,
      lastOpenedAt: null,
      fontSizePx: 13,
      lineSpacingMode: 'compact',
    },
    excerpt: '内容',
  }
}

describe('active sticky note context menu', () => {
  it('replaces the texture submenu with per-note background settings', () => {
    const preferences = copyStickyNotePreferences(DEFAULT_STICKY_NOTE_PREFERENCES)
    preferences.colorPresets.find(({ id }) => id === 'custom')!.value = '#123456'
    const menu = buildActiveStickyNoteMenu(note(), preferences)
    expect(menu.map((item) => item.id)).toEqual([
      'sticky-material',
      'sticky-color',
      'sticky-background-settings',
      'sticky-manage-separator',
      'sticky-rename',
      'sticky-archive',
      'sticky-delete',
    ])
    expect(menu[0]).toMatchObject({ kind: 'submenu', label: '材质' })
    expect(menu[1]).toMatchObject({ kind: 'submenu', label: '改变颜色' })
    expect(menu[2]).toEqual({
      kind: 'command',
      id: 'sticky-background-settings',
      label: '设置背景...',
    })
    expect(menu[1].kind === 'submenu' && menu[1].items).toHaveLength(8)
    expect(menu.at(-1)).toMatchObject({ label: '删除', danger: true })
    expect(menu[1].kind === 'submenu' ? menu[1].items.at(-1) : null).toMatchObject({
      id: 'sticky-color-custom',
      label: '自定义',
      swatchColor: '#123456',
      checkedAppearance: 'theme-text',
    })
  })

  it('shows the four materials in approved order with a standard check and no swatch', () => {
    const menu = buildActiveStickyNoteMenu(note({
      mode: 'material', materialPresetId: 'flowing-glass',
    }))
    const materialMenu = menu.find((item) => item.id === 'sticky-material')

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
  })


  it('shows real color swatches instead of glyph placeholders', () => {
    const colorMenu = buildActiveStickyNoteMenu(note(), DEFAULT_STICKY_NOTE_PREFERENCES)[1]
    expect(colorMenu.kind).toBe('submenu')
    if (colorMenu.kind !== 'submenu') return
    expect(colorMenu.items[0]).toMatchObject({
      id: 'sticky-color-yellow',
      swatchColor: '#FFF3B3',
      checked: true,
      checkedAppearance: 'theme-text',
    })
    expect(colorMenu.items[0]).not.toHaveProperty('icon')
  })
})

it('selects Custom with the independent snapshot swatch', () => {
  const menu = buildActiveStickyNoteMenu(note({ mode: 'independent', color: '#123456', texture: { pattern: 'none', foregroundColor: '#000000', opacityPercent: 0, scalePx: 16 } }))
  const colors = menu.find(item => item.id === 'sticky-color')
  expect(colors?.kind === 'submenu' ? colors.items.filter(item => item.kind === 'command' && item.checked) : []).toEqual([expect.objectContaining({ id: 'sticky-color-custom', checked: true, swatchColor: '#123456' })])
})
