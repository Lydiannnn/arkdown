import type { StickyNoteSummary } from '../../shared/sticky-notes'
import type { ContextMenuItem } from '../context-menu/context-menu-types'

export function buildArchivedStickyNoteMenu(
  _note: StickyNoteSummary,
  remainingSlots: number,
  selectedCount = 1,
): readonly ContextMenuItem[] {
  const restoreDisabled = remainingSlots < selectedCount
  return [
    {
      kind: 'command',
      id: 'sticky-restore',
      label: '恢复到便签盒子',
      disabled: restoreDisabled,
      ...(restoreDisabled
        ? { disabledReason: `剩余 ${remainingSlots} 个位置，已选 ${selectedCount} 个便签` }
        : {}),
    },
    {
      kind: 'command',
      id: 'sticky-rename',
      label: '重命名',
      ...(selectedCount > 1
        ? { disabled: true, disabledReason: '多选时不可重命名' }
        : {}),
    },
    {
      kind: 'command',
      id: 'sticky-delete',
      label: '删除',
      danger: true,
    },
  ]
}
