import type { MenuCommand } from '../../shared/menu-commands'

export type StickyNoteToolbarCommand = Extract<
  MenuCommand,
  'strong' | 'emphasis' | 'link' | 'ordered-list' | 'unordered-list' | 'task-list'
>

export const STICKY_NOTE_TOOLBAR_ITEMS: readonly {
  command: StickyNoteToolbarCommand
  label: string
}[] = [
  { command: 'strong', label: '加粗' },
  { command: 'emphasis', label: '斜体' },
  { command: 'link', label: '链接' },
  { command: 'ordered-list', label: '有序列表' },
  { command: 'unordered-list', label: '无序列表' },
  { command: 'task-list', label: '任务列表' },
] as const

export function dispatchStickyNoteEditorCommand(
  command: StickyNoteToolbarCommand,
  target: Pick<Window, 'dispatchEvent'> = window,
): void {
  target.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: command }))
}
