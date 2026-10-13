import type { MenuCommand } from './menu-commands'
import type { EditorTheme } from './editor-appearance-preferences'
import type { AppMenuSectionId } from './app-menu-definition'
import { SCREENSHOT_TRANSLATION_ACCELERATOR } from './screenshot-translation'
import { SHORTCUT_DEFINITIONS, shortcutFor, type ShortcutBindings } from './keyboard-shortcuts'

export type ApplicationMenuRole =
  | 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'
  | 'resetZoom' | 'zoomIn' | 'zoomOut' | 'togglefullscreen'

export type ApplicationMenuAction =
  | 'reviewDrafts'
  | 'createNewWindow' | 'openDocument' | 'closeWindow' | 'openGuide' | 'openAbout'
  | 'beginScreenshotTranslation' | 'openBackgroundSettings' | 'openScreenTranslation'

interface ApplicationMenuItemState {
  disabled?: boolean
}

export interface ApplicationMenuCommandItem extends ApplicationMenuItemState {
  kind: 'command'
  id: string
  label: string
  command: MenuCommand
  accelerator?: string
}

export interface ApplicationMenuRoleItem extends ApplicationMenuItemState {
  kind: 'role'
  id: string
  label: string
  role: ApplicationMenuRole
  accelerator?: string
  checked?: boolean
}

export interface ApplicationMenuActionItem extends ApplicationMenuItemState {
  kind: 'action'
  id: string
  label: string
  action: ApplicationMenuAction
  accelerator?: string
}

export interface ApplicationMenuRadioItem extends ApplicationMenuItemState {
  kind: 'radio'
  id: string
  label: string
  checked: boolean
  command: MenuCommand
}

export interface ApplicationMenuSeparatorItem {
  kind: 'separator'
  id: string
}

export interface ApplicationMenuCheckItem extends ApplicationMenuItemState {
  kind: 'checkbox'
  id: string
  label: string
  checked: boolean
  command: MenuCommand
}

export interface ApplicationMenuSubmenuItem extends ApplicationMenuItemState {
  kind: 'submenu'
  id: string
  label: string
  items: readonly ApplicationMenuItem[]
}

export interface ApplicationMenuRecentDocumentItem extends ApplicationMenuItemState {
  kind: 'recent-document'
  id: string
  label: string
  absolutePath: string
}

export type ApplicationMenuItem =
  | ApplicationMenuCommandItem
  | ApplicationMenuRoleItem
  | ApplicationMenuActionItem
  | ApplicationMenuRadioItem
  | ApplicationMenuSeparatorItem
  | ApplicationMenuCheckItem
  | ApplicationMenuSubmenuItem
  | ApplicationMenuRecentDocumentItem

export interface ApplicationMenuSection {
  id: AppMenuSectionId
  label: string
  items: readonly ApplicationMenuItem[]
}

export interface ApplicationMenuWindowState {
  editorTheme?: EditorTheme
  hasPrintableDocument: boolean
  spellCheckEnabled: boolean
  showEditIndicators: boolean
  editorZoomPercent: number
  fullscreen: boolean
}

export interface ApplicationMenuRuntimeState extends ApplicationMenuWindowState {
  shortcutBindings?: ShortcutBindings
  recentDocuments: readonly ApplicationMenuRecentDocumentSource[]
}

export interface ApplicationMenuRecentDocumentSource {
  id: string
  absolutePath: string
}

export const DEFAULT_APPLICATION_MENU_RUNTIME_STATE: ApplicationMenuRuntimeState = Object.freeze({
  recentDocuments: Object.freeze([]),
  hasPrintableDocument: false,
  spellCheckEnabled: false,
  showEditIndicators: true,
  editorZoomPercent: 100,
  fullscreen: false,
})

const command = (
  id: string,
  label: string,
  menuCommand: MenuCommand,
  accelerator?: string,
  disabled?: boolean,
): ApplicationMenuCommandItem => ({
  kind: 'command', id, label, command: menuCommand, accelerator, disabled,
})

function recentDocumentItems(
  documents: readonly ApplicationMenuRecentDocumentSource[],
): readonly ApplicationMenuRecentDocumentItem[] {
  if (documents.length === 0) {
    return [{
      kind: 'recent-document',
      id: 'file.recent.empty',
      label: '暂无最近编辑的文档',
      absolutePath: '',
      disabled: true,
    }]
  }
  return documents.map(({ id, absolutePath }) => ({
    kind: 'recent-document',
    id,
    label: absolutePath,
    absolutePath,
  }))
}

export function buildApplicationMenuModel(
  state: ApplicationMenuRuntimeState,
): readonly ApplicationMenuSection[] {
  const sections: ApplicationMenuSection[] = [
    {
      id: 'file',
      label: '文件',
      items: [
        command('file.new-document', '新建文档', 'new-document', 'CmdOrCtrl+N'),
        { kind: 'action', id: 'file.new-window', label: '新建窗口', action: 'createNewWindow', accelerator: 'CmdOrCtrl+Shift+N' },
        { kind: 'action', id: 'file.open-document', label: '打开文档…', action: 'openDocument', accelerator: 'CmdOrCtrl+O' },
        command('file.open-workspace', '打开文件夹…', 'open-workspace', 'CmdOrCtrl+Shift+O'),
        { kind: 'action', id: 'file.review-drafts', label: '查看保留的草稿', action: 'reviewDrafts' },
        {
          kind: 'submenu',
          id: 'file.recent',
          label: '最近编辑的文档…',
          items: recentDocumentItems(state.recentDocuments),
        },
        command('file.save', '保存', 'save', 'CmdOrCtrl+S'),
        command('file.save-as', '另存为…', 'save-as', 'CmdOrCtrl+Shift+S'),
        {
          kind: 'submenu',
          id: 'file.export',
          label: '导出...',
          items: [
            command('file.export-docx', 'DOCX...', 'export-docx'),
            command('file.export-xlsx', 'XLSX...', 'export-xlsx'),
          ],
        },
        command('file.print', '打印…', 'print-document', 'CmdOrCtrl+P', !state.hasPrintableDocument),
        { kind: 'separator', id: 'file.separator.preferences' },
        command('file.preferences', '偏好设置…', 'preferences'),
        { kind: 'separator', id: 'file.separator.close' },
        { kind: 'action', id: 'file.close-window', label: '关闭窗口', action: 'closeWindow', accelerator: 'CmdOrCtrl+W' },
      ],
    },
    {
      id: 'edit',
      label: '编辑',
      items: [
        { kind: 'role', id: 'edit.undo', label: '撤销', role: 'undo' },
        { kind: 'role', id: 'edit.redo', label: '重做', role: 'redo' },
        { kind: 'separator', id: 'edit.separator.clipboard' },
        { kind: 'role', id: 'edit.cut', label: '剪切', role: 'cut' },
        { kind: 'role', id: 'edit.copy', label: '复制', role: 'copy' },
        { kind: 'role', id: 'edit.paste', label: '粘贴', role: 'paste' },
        { kind: 'role', id: 'edit.select-all', label: '全选', role: 'selectAll' },
        { kind: 'separator', id: 'edit.separator.find' },
        command('edit.find', '在文档中搜索', 'find-in-document', 'CmdOrCtrl+F'),
        { kind: 'separator', id: 'edit.separator.spell-check' },
        {
          kind: 'checkbox',
          id: 'edit.spell-check',
          label: '拼写检查',
          checked: state.spellCheckEnabled,
          command: 'toggle-spell-check',
        },
        { kind: 'separator', id: 'edit.separator.shortcuts' },
        command('edit.shortcuts', '快捷键', 'shortcut-settings'),
      ],
    },
    {
      id: 'paragraph',
      label: '段落',
      items: [
        command('paragraph.body', '正文', 'paragraph', 'CmdOrCtrl+`'),
        ...([1, 2, 3, 4, 5, 6] as const).map((level) =>
          command(`paragraph.heading-${level}`, `${'一二三四五六'[level - 1]}级标题`, `heading-${level}`, `Ctrl+${level}`)),
        command('paragraph.promote', '提升标题级别', 'heading-promote'),
        command('paragraph.demote', '降低标题级别', 'heading-demote'),
        { kind: 'separator', id: 'paragraph.separator.lists' },
        command('paragraph.unordered-list', '无序列表', 'unordered-list'),
        command('paragraph.ordered-list', '有序列表', 'ordered-list'),
        command('paragraph.task-list', '任务列表', 'task-list'),
        command('paragraph.indent', '增加列表缩进', 'list-indent'),
        command('paragraph.outdent', '减少列表缩进', 'list-outdent'),
        command('paragraph.blockquote', '引用', 'blockquote'),
        command('paragraph.code-fence', '代码块', 'code-fence'),
      ],
    },
    {
      id: 'format',
      label: '格式',
      items: [
        command('format.strong', '加粗', 'strong', 'CmdOrCtrl+B'),
        command('format.emphasis', '斜体', 'emphasis', 'CmdOrCtrl+I'),
        command('format.strike', '删除线', 'strike'),
        command('format.inline-code', '行内代码', 'inline-code'),
        command('format.link', '链接…', 'link', 'CmdOrCtrl+K'),
        { kind: 'separator', id: 'format.separator.clear' },
        command('format.clear', '清除格式', 'clear-formatting'),
      ],
    },
    {
      id: 'view',
      label: '视图',
      items: [
        command('view.sidebar', '显示或隐藏侧边栏', 'toggle-sidebar', 'CmdOrCtrl+Shift+L'),
        command('view.source', '切换源码模式', 'toggle-source-mode', 'CmdOrCtrl+/'),
        {
          kind: 'checkbox',
          id: 'view.edit-indicators',
          label: '源码编辑提示',
          checked: state.showEditIndicators,
          command: 'toggle-edit-indicators',
        },
        { kind: 'separator', id: 'view.separator.editor-zoom' },
        command('view.editor-zoom-in', '仅放大编辑区', 'editor-zoom-in', undefined, state.editorZoomPercent >= 200),
        command('view.editor-zoom-out', '仅缩小编辑区', 'editor-zoom-out', undefined, state.editorZoomPercent <= 70),
        command('view.editor-zoom-reset', '恢复编辑区大小', 'editor-zoom-reset', undefined, state.editorZoomPercent === 100),
        { kind: 'separator', id: 'view.separator.zoom' },
        { kind: 'role', id: 'view.actual-size', label: '实际大小', role: 'resetZoom' },
        { kind: 'role', id: 'view.zoom-in', label: '放大', role: 'zoomIn' },
        { kind: 'role', id: 'view.zoom-out', label: '缩小', role: 'zoomOut' },
        {
          kind: 'role',
          id: 'view.fullscreen',
          label: state.fullscreen ? '退出全屏' : '全屏',
          role: 'togglefullscreen',
          checked: state.fullscreen,
        },
      ],
    },
    {
      id: 'theme',
      label: '主题',
      items: [
        {
          kind: 'radio',
          id: 'theme.system',
          label: '跟随系统',
          checked: (state.editorTheme ?? 'system') === 'system',
          command: 'select-editor-theme-system',
        },
        {
          kind: 'radio',
          id: 'theme.minimal',
          label: '浅色模式',
          checked: state.editorTheme === 'minimal',
          command: 'select-editor-theme-minimal',
        },
        {
          kind: 'radio',
          id: 'theme.dark',
          label: '深色模式',
          checked: state.editorTheme === 'dark',
          command: 'select-editor-theme-dark',
        },
        { kind: 'separator', id: 'theme.separator.background' },
        {
          kind: 'action',
          id: 'theme.background',
          label: '设置背景...',
          action: 'openBackgroundSettings',
        },
      ],
    },
    {
      id: 'tools',
      label: '工具',
      items: [{
        kind: 'action',
        id: 'tools.screenshot-translation',
        label: '截图翻译',
        action: 'beginScreenshotTranslation',
        accelerator: SCREENSHOT_TRANSLATION_ACCELERATOR,
      }, { kind: 'action', id: 'tools.screen-translation', label: '悬浮翻译窗（实验功能）', action: 'openScreenTranslation' }],
    },
    {
      id: 'help',
      label: '帮助',
      items: [
        { kind: 'action', id: 'help.guide', label: '使用说明书', action: 'openGuide' },
        { kind: 'action', id: 'help.about', label: '关于 Arkdown', action: 'openAbout' },
      ],
    },
  ]
  const aliases: Record<string, string> = {
    'format.strong': 'editor.strong', 'format.emphasis': 'editor.emphasis',
    'format.link': 'editor.link', 'format.strike': 'editor.strike', 'format.inline-code': 'editor.inline-code',
    'paragraph.body': 'editor.paragraph', 'paragraph.unordered-list': 'editor.bullet-list',
    'paragraph.ordered-list': 'editor.ordered-list', 'paragraph.indent': 'editor.indent',
    'paragraph.outdent': 'editor.outdent', 'paragraph.blockquote': 'editor.blockquote',
    'paragraph.code-fence': 'editor.code-block',
    ...Object.fromEntries([1, 2, 3, 4, 5, 6].map(level => [`paragraph.heading-${level}`, `editor.heading-${level}`])),
  }
  const ids = new Set(SHORTCUT_DEFINITIONS.filter(item => item.owner !== 'renderer').map(item => item.id))
  const apply = (items: readonly ApplicationMenuItem[]): ApplicationMenuItem[] => items.map(item => {
    if (item.kind === 'submenu') return { ...item, items: apply(item.items) }
    const shortcutId = aliases[item.id] ?? item.id
    if (ids.has(shortcutId) && (item.kind === 'command' || item.kind === 'role' || item.kind === 'action')) {
      if (!Object.hasOwn(state.shortcutBindings ?? {}, shortcutId) && item.accelerator) return item
      // Empty string explicitly removes Electron role defaults; undefined would restore them.
      return { ...item, accelerator: shortcutFor(shortcutId, state.shortcutBindings) ?? '' }
    }
    return item
  })
  return sections.map(section => ({ ...section, items: apply(section.items) }))
}

export function formatWindowsAccelerator(value: string): string {
  return value.replaceAll('CmdOrCtrl', 'Ctrl').replaceAll('CmdOr', 'Ctrl')
}

export function applicationMenuItemById(
  id: string,
  model: readonly ApplicationMenuSection[] = buildApplicationMenuModel(
    DEFAULT_APPLICATION_MENU_RUNTIME_STATE,
  ),
): ApplicationMenuItem | null {
  const visit = (items: readonly ApplicationMenuItem[]): ApplicationMenuItem | null => {
    for (const item of items) {
      if (item.id === id) return item
      if (item.kind === 'submenu') {
        const nested = visit(item.items)
        if (nested) return nested
      }
    }
    return null
  }
  for (const section of model) {
    const item = visit(section.items)
    if (item) return item
  }
  return null
}
