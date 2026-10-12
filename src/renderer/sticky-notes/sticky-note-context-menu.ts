import type {
  StickyNoteColorPresetId,
  StickyNotePreferences,
  StickyNoteStyleReference,
  StickyNoteTexturePresetId,
} from '../../shared/sticky-note-preferences'
import {
  horizontalRuleDomStyle,
  type HorizontalRuleAttributes,
  type HorizontalRuleStyleId,
} from '../editor/horizontal-rule-styles'
import type { ContextMenuCommandItem, ContextMenuItem } from '../context-menu/context-menu-types'
import { buildStickyNoteFontSizeItems } from './sticky-note-font-size'
import type { VisualBlockStyle } from '../editor/VisualEditor'
import type { StickyNoteLineSpacingMode } from '../../shared/sticky-notes'
import {
  STICKY_NOTE_MATERIAL_PRESETS,
  type StickyNoteMaterialPresetId,
} from '../../shared/sticky-note-materials'

const command = (id: string, label: string, options: Partial<ContextMenuCommandItem> = {}): ContextMenuItem => ({ kind: 'command', id, label, ...options })
const HORIZONTAL_RULE_CHOICES = [
  ['black', '黑色'],
  ['red', '红色'],
  ['orange', '橙色'],
  ['green', '绿色'],
  ['cyan', '青色'],
  ['blue', '蓝色'],
  ['purple', '紫色'],
  ['pink', '粉色'],
] as const satisfies readonly (readonly [HorizontalRuleStyleId, string])[]

export interface StickyNoteBlankMenuOptions {
  preferences: StickyNotePreferences
  style: StickyNoteStyleReference
  fontSizePx: number
  lineSpacingMode: StickyNoteLineSpacingMode
  selectedBlockStyle: VisualBlockStyle
}

export function stickyNoteHorizontalRuleForCommand(
  commandId: string,
): HorizontalRuleAttributes | null {
  const choice = HORIZONTAL_RULE_CHOICES.find(([styleId]) => (
    commandId === `sticky-horizontal-rule-${styleId}`
  ))
  return choice
    ? { styleId: choice[0], heightPx: 1, opacityPercent: 50 }
    : null
}

export function stickyNoteColorForCommand(
  commandId: string,
  preferences: StickyNotePreferences,
): StickyNoteColorPresetId | null {
  const preset = preferences.colorPresets.find(({ id }) => commandId === `sticky-color-${id}`)
  return preset?.id ?? null
}

export function stickyNoteTextureForCommand(
  commandId: string,
  preferences: StickyNotePreferences,
): StickyNoteTexturePresetId | null {
  const preset = preferences.texturePresets.find(({ id }) => commandId === `sticky-texture-${id}`)
  return preset?.id ?? null
}

export function stickyNoteMaterialForCommand(
  commandId: string,
): StickyNoteMaterialPresetId | null {
  const preset = STICKY_NOTE_MATERIAL_PRESETS.find(({ id }) => (
    commandId === `sticky-material-${id}`
  ))
  return preset?.id ?? null
}

function buildStickyNoteParagraphMenu(selectedBlockStyle: VisualBlockStyle): ContextMenuItem {
  return {
    kind: 'submenu',
    id: 'sticky-paragraph',
    label: '段落',
    items: [
      command('sticky-paragraph-heading-4', '标题', { checked: selectedBlockStyle === 'heading-4' }),
      command('sticky-paragraph-paragraph', '正文', { checked: selectedBlockStyle === 'paragraph' }),
      command('sticky-paragraph-blockquote', '附注', { checked: selectedBlockStyle === 'blockquote' }),
    ],
  }
}

export function buildStickyNoteTextMenu(selectedBlockStyle: VisualBlockStyle): readonly ContextMenuItem[] {
  return [
    buildStickyNoteParagraphMenu(selectedBlockStyle),
    command('sticky-copy', '复制'),
    command('sticky-paste', '粘贴'),
    command('sticky-cut', '剪切'),
    command('sticky-delete', '删除'),
  ]
}

export function buildStickyNoteBlankMenu({
  preferences,
  style,
  fontSizePx,
  lineSpacingMode,
  selectedBlockStyle,
}: StickyNoteBlankMenuOptions): readonly ContextMenuItem[] {
  const ruleItems = HORIZONTAL_RULE_CHOICES.map(([styleId, label]) => {
    const attributes: HorizontalRuleAttributes = { styleId, heightPx: 1, opacityPercent: 50 }
    const preview = horizontalRuleDomStyle(attributes)
    return command(`sticky-horizontal-rule-${styleId}`, label, {
      preview: {
        kind: 'horizontal-rule',
        color: preview?.backgroundColor ?? 'transparent',
        height: 1,
      },
    }) as ContextMenuCommandItem
  })
  const colorItems = preferences.colorPresets.map((preset) => command(
    `sticky-color-${preset.id}`,
    preset.name,
    {
      checked: style.mode === 'preset' ? style.colorPresetId === preset.id : style.mode === 'independent' && preset.id === 'custom',
      checkedAppearance: 'theme-text',
      swatchColor: style.mode === 'independent' && preset.id === 'custom' ? style.color : preset.value,
    },
  ))
  const materialItems = STICKY_NOTE_MATERIAL_PRESETS.map((preset) => command(
    `sticky-material-${preset.id}`,
    preset.name,
    {
      checked: style.mode === 'material' && style.materialPresetId === preset.id,
    },
  ))
  return [
    buildStickyNoteParagraphMenu(selectedBlockStyle),
    command('sticky-paste', '粘贴'),
    { kind: 'separator', id: 'sticky-insert-primary-separator' },
    {
      kind: 'submenu',
      id: 'sticky-horizontal-rule',
      label: '水平分割线',
      items: [{ kind: 'icon-grid', id: 'sticky-horizontal-rule-grid', columns: 4, items: ruleItems }],
    },
    command('sticky-insert-image', '插入图片'),
    { kind: 'separator', id: 'sticky-style-separator' },
    ...buildStickyNoteFontSizeItems(fontSizePx),
    {
      kind: 'submenu',
      id: 'sticky-line-spacing',
      label: '行间距',
      items: [
        command('sticky-line-spacing-compact', '使用压缩行间距', {
          checked: lineSpacingMode === 'compact',
        }),
        command('sticky-line-spacing-standard', '使用标准行间距', {
          checked: lineSpacingMode === 'standard',
        }),
      ],
    },
    { kind: 'separator', id: 'sticky-appearance-separator' },
    { kind: 'submenu', id: 'sticky-material', label: '材质', items: materialItems },
    { kind: 'submenu', id: 'sticky-color', label: '颜色', items: colorItems },
    command('sticky-background-settings', '设置背景...'),
    { kind: 'separator', id: 'sticky-manage-separator' },
    command('sticky-rename', '重命名'),
    command('sticky-archive', '归档'),
  ]
}

export function isStickyNoteWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character)
}

export function selectWordAtPoint(text: Text, offset: number): boolean {
  const value = text.data
  const cursor = Math.max(0, Math.min(offset, value.length))
  const isWord = isStickyNoteWordCharacter
  let start = cursor
  let end = cursor
  while (start > 0 && isWord(value[start - 1])) start -= 1
  while (end < value.length && isWord(value[end])) end += 1
  if (start === end) return false
  const range = document.createRange()
  range.setStart(text, start)
  range.setEnd(text, end)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  return true
}
