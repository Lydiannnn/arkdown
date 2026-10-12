import type { TreeEntry } from '../../shared/contracts'
import type { ContextMenuItem } from '../context-menu/context-menu-types'
import { THEME_COLOR_PRESETS } from '../../shared/theme-color'
import {
  WORKSPACE_COLOR_IDS,
  type WorkspaceColorId,
} from '../../shared/workspace-color-marks'

export type WorkspaceMenuTarget =
  | { kind: 'root'; name: string; relativePath: '' }
  | TreeEntry

const command = (
  id: string,
  label: string,
  options: Partial<Extract<ContextMenuItem, { kind: 'command' }>> = {},
): ContextMenuItem => ({ kind: 'command', id, label, ...options })

const separator = (id: string): ContextMenuItem => ({ kind: 'separator', id })

const themeColorNameByValue = new Map(
  THEME_COLOR_PRESETS.map((preset) => [preset.value, preset.name]),
)

const colorItems = (
  activeColor: WorkspaceColorId | undefined,
): readonly ContextMenuItem[] => [
  ...WORKSPACE_COLOR_IDS.map((color, index) => command(
    `workspace-color-mark-${index}`,
    themeColorNameByValue.get(color) ?? color,
    {
      checked: activeColor === color,
      iconChoice: true,
      swatchColor: color,
    },
  )),
  separator('workspace-color-clear-separator'),
  command('workspace-color-clear', '清除标记', { disabled: activeColor === undefined }),
]

const colorSubmenu = (activeColor: WorkspaceColorId | undefined): ContextMenuItem => ({
  kind: 'submenu',
  id: 'workspace-color-mark',
  label: '标记颜色',
  items: colorItems(activeColor),
})

export function workspaceColorFromMenuCommand(
  commandId: string,
): WorkspaceColorId | null | undefined {
  if (commandId === 'workspace-color-clear') return null
  const match = /^workspace-color-mark-([0-6])$/u.exec(commandId)
  return match ? WORKSPACE_COLOR_IDS[Number(match[1])] : undefined
}

export function buildWorkspaceMenu(
  target: WorkspaceMenuTarget,
  activeColor?: WorkspaceColorId,
): readonly ContextMenuItem[] {
  if (target.kind === 'root') {
    return [
      command('workspace-new-document', '新建文档'),
      command('workspace-new-folder', '新建文件夹'),
      separator('workspace-root-create-separator'),
      command('workspace-open-file', '打开文件…'),
      command('workspace-open-folder', '打开文件夹…'),
      command('workspace-refresh', '刷新'),
      separator('workspace-root-location-separator'),
      command('workspace-reveal', '在资源管理器中显示'),
      command('workspace-properties', '属性'),
    ]
  }
  if (target.kind === 'directory') {
    return [
      command('workspace-open-new-window', '在新窗口中打开'),
      command('workspace-reveal', '打开所在的文件夹'),
      command('workspace-copy-path', '复制绝对路径'),
      separator('workspace-folder-primary-separator'),
      colorSubmenu(activeColor),
      command('workspace-rename', '重命名…'),
      separator('workspace-folder-danger-separator'),
      command('workspace-trash', '移到回收站', { danger: true }),
      command('workspace-properties', '属性'),
    ]
  }
  return [
    command('workspace-open-new-window', '在新窗口中打开'),
    command('workspace-reveal', '打开所在的文件夹'),
    command('workspace-copy-path', '复制绝对路径'),
    separator('workspace-document-primary-separator'),
    colorSubmenu(activeColor),
    command('workspace-rename', '重命名…'),
    command('workspace-duplicate', '创建副本'),
    separator('workspace-document-danger-separator'),
    command('workspace-trash', '移到回收站', { danger: true }),
    command('workspace-properties', '属性'),
  ]
}
