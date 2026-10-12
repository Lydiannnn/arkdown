import {
  DEFAULT_STICKY_NOTE_PREFERENCES,
  type StickyNotePreferences,
} from '../../shared/sticky-note-preferences'
import type { StickyNoteSummary } from '../../shared/sticky-notes'
import type { ContextMenuItem } from '../context-menu/context-menu-types'
import { STICKY_NOTE_MATERIAL_PRESETS } from '../../shared/sticky-note-materials'

const command = (id: string, label: string, options: Partial<Extract<ContextMenuItem, { kind: 'command' }>> = {}): ContextMenuItem => ({ kind: 'command', id, label, ...options })
const separator = (id: string): ContextMenuItem => ({ kind: 'separator', id })

export function buildActiveStickyNoteMenu(
  note: StickyNoteSummary,
  preferences: StickyNotePreferences = DEFAULT_STICKY_NOTE_PREFERENCES,
): readonly ContextMenuItem[] {
  const style = note.record.style
  const colors: ContextMenuItem[] = preferences.colorPresets.map((preset) => command(
    `sticky-color-${preset.id}`, preset.name, {
      checked: style.mode === 'preset' ? style.colorPresetId === preset.id : style.mode === 'independent' && preset.id === 'custom',
      checkedAppearance: 'theme-text',
      swatchColor: style.mode === 'independent' && preset.id === 'custom' ? style.color : preset.value,
    },
  ))
  const materials: ContextMenuItem[] = STICKY_NOTE_MATERIAL_PRESETS.map((preset) => command(
    `sticky-material-${preset.id}`, preset.name, {
      checked: style.mode === 'material' && style.materialPresetId === preset.id,
    },
  ))
  return [
    { kind: 'submenu', id: 'sticky-material', label: '材质', items: materials },
    { kind: 'submenu', id: 'sticky-color', label: '改变颜色', items: colors },
    command('sticky-background-settings', '设置背景...'),
    separator('sticky-manage-separator'),
    command('sticky-rename', '重命名'),
    command('sticky-archive', '归档'),
    command('sticky-delete', '删除', { danger: true }),
  ]
}
