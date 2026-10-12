import { createElement } from 'react'
import type {
  ContextMenuCommandItem,
  ContextMenuItem,
  ContextMenuSubmenuItem,
} from '../../context-menu/context-menu-types'
import boldIcon from '../../assets/context-menu/bold.png'
import italicIcon from '../../assets/context-menu/italic.png'
import codeIcon from '../../assets/context-menu/code.png'
import linkIcon from '../../assets/context-menu/link.png'
import quoteIcon from '../../assets/context-menu/quote.png'
import orderedListIcon from '../../assets/context-menu/ordered-list.png'
import bulletListIcon from '../../assets/context-menu/bullet-list.png'
import taskListIcon from '../../assets/context-menu/task-list.png'
import imageAlignLeftIcon from '../../assets/context-menu/image-align-left.png'
import imageAlignCenterIcon from '../../assets/context-menu/image-align-center.png'
import imageAlignRightIcon from '../../assets/context-menu/image-align-right.png'
import {
  HORIZONTAL_RULE_STYLES,
  type HorizontalRuleAttributes,
} from '../horizontal-rule-styles'
import { AppIcon, type AppIconName } from '../../icons/AppIcon'
import type { ClipboardFormatsSnapshot } from '../../../shared/contracts'
import {
  CLIPBOARD_FORMAT_TOOLTIPS,
  clipboardFormatAvailability,
} from './clipboard-formats'
import type { InlineFormatStates } from './inline-format-state'
import { parseLocalFileLink } from '../../../shared/document-view-link'

export type EditorContextKind =
  | 'text'
  | 'image'
  | 'mermaid'
  | 'table'
  | 'code'
  | 'link'
  | 'task'
  | 'horizontal-rule'

export type EditorParagraphStyle =
  | 'paragraph'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'heading-4'
  | 'heading-5'
  | 'heading-6'

export interface EditorActiveBlocks {
  blockquote: boolean
  codeBlock: boolean
  bulletList: boolean
  orderedList: boolean
  taskList: boolean
  paragraphStyle: EditorParagraphStyle | null
}

export interface EditorContextSnapshot {
  kind: EditorContextKind
  selectionText: string
  hasSelection?: boolean
  cellSelection?: boolean
  crossCellSelection?: boolean
  activeBlocks?: EditorActiveBlocks
  activeInlineFormats?: InlineFormatStates
  href?: string
  source?: string
  imageAlignment?: 'left' | 'center' | 'right'
  mermaidMode?: 'preview' | 'source'
  mermaidRenderState?: 'pending' | 'ready' | 'error'
  mermaidImageDataUrl?: string
  checked?: boolean
  codeWrap?: boolean
  horizontalRule?: {
    attributes: HorizontalRuleAttributes
    element: HTMLHRElement
  }
  clipboardFormats?: ClipboardFormatsSnapshot
  table?: {
    rowIndex: number
    rowCount: number
    columnIndex: number
    columnCount: number
  }
}

const command = (
  id: string,
  label: string,
  options: Omit<ContextMenuCommandItem, 'kind' | 'id' | 'label'> = {},
): ContextMenuCommandItem => ({ kind: 'command', id, label, ...options })

const separator = (id: string): ContextMenuItem => ({ kind: 'separator', id })

const submenu = (
  id: string,
  label: string,
  items: readonly ContextMenuItem[],
  options: Pick<ContextMenuSubmenuItem, 'icon' | 'iconSrc' | 'iconPixelSize'> = {},
): ContextMenuSubmenuItem => ({ kind: 'submenu', id, label, items, ...options })

const grid = (
  id: string,
  items: readonly ContextMenuCommandItem[],
  columns = 4,
): ContextMenuItem => ({ kind: 'icon-grid', id, columns, items })

function searchCommand(selectionText: string): ContextMenuCommandItem {
  const disabled = selectionText.trim() === ''
  return command('search-selection', '使用默认浏览器搜索', {
    disabled,
    disabledReason: disabled ? '请先选择要搜索的文字' : undefined,
  })
}

const icon = (
  iconSrc: string,
  width: number,
  height: number,
): Pick<ContextMenuCommandItem, 'iconSrc' | 'iconPixelSize'> => ({
  iconSrc,
  iconPixelSize: { width, height },
})

const vectorIcon = (
  name: AppIconName,
  size = 16,
): Pick<ContextMenuCommandItem, 'icon'> => ({
  icon: createElement(AppIcon, { name, size }),
})

function formatGrid(context: EditorContextSnapshot): ContextMenuItem {
  const active = context.activeBlocks
  return grid('format-grid', [
    command('toggle-strong', '加粗', { ...icon(boldIcon, 14, 16), shortcut: 'Ctrl+B' }),
    command('toggle-emphasis', '斜体', { ...icon(italicIcon, 12, 17), shortcut: 'Ctrl+I' }),
    command('toggle-code-block', '代码块', {
      ...icon(codeIcon, 22, 20),
      shortcut: 'Ctrl+Shift+K',
      checked: active?.codeBlock,
    }),
    command('toggle-link', '链接', { ...icon(linkIcon, 22, 20), shortcut: 'Ctrl+K' }),
    command('toggle-blockquote', '引用', { ...icon(quoteIcon, 20, 15), checked: active?.blockquote }),
    command('toggle-ordered-list', '有序列表', {
      ...icon(orderedListIcon, 22, 21),
      checked: active?.orderedList,
      checkedAppearance: 'neutral-surface',
    }),
    command('toggle-bullet-list', '无序列表', {
      ...icon(bulletListIcon, 22, 18),
      checked: active?.bulletList,
      checkedAppearance: 'neutral-surface',
    }),
    command('toggle-task-list', '任务列表', {
      ...icon(taskListIcon, 22, 22),
      checked: active?.taskList,
      checkedAppearance: 'neutral-surface',
    }),
  ])
}

function paragraphStyleIcon(
  style: EditorParagraphStyle,
  normalIcon: AppIconName,
  active?: EditorActiveBlocks,
): Pick<ContextMenuCommandItem, 'icon' | 'accentIcon'> {
  if (active?.paragraphStyle === style) return { ...vectorIcon('check'), accentIcon: true }
  return vectorIcon(normalIcon)
}

function paragraphMenu(context: EditorContextSnapshot): ContextMenuItem {
  const active = context.activeBlocks
  return submenu('paragraph', '段落', [
    command('paragraph-body', '正文', {
      ...paragraphStyleIcon('paragraph', 'paragraph', active),
      shortcut: 'Ctrl+·',
    }),
    command('heading-1', '一级标题', { ...paragraphStyleIcon('heading-1', 'heading-1', active), shortcut: 'Ctrl+1' }),
    command('heading-2', '二级标题', { ...paragraphStyleIcon('heading-2', 'heading-2', active), shortcut: 'Ctrl+2' }),
    command('heading-3', '三级标题', { ...paragraphStyleIcon('heading-3', 'heading-3', active), shortcut: 'Ctrl+3' }),
    command('heading-4', '四级标题', { ...paragraphStyleIcon('heading-4', 'heading-4', active), shortcut: 'Ctrl+4' }),
    command('heading-5', '五级标题', { ...paragraphStyleIcon('heading-5', 'heading-5', active), shortcut: 'Ctrl+5' }),
    command('heading-6', '六级标题', { ...paragraphStyleIcon('heading-6', 'heading-6', active), shortcut: 'Ctrl+6' }),
    separator('paragraph-heading-separator'),
    command('clear-formatting', '清除样式', vectorIcon('clear-format')),
  ])
}

function moreFormatMenu(active?: InlineFormatStates): ContextMenuItem {
  return submenu('more-format', '更多格式', [
    command('toggle-strike', '删除线', { checked: active?.strike === 'on' }),
    command('toggle-underline', '下划线', { checked: active?.underline === 'on' }),
    command('toggle-highlight', '高亮', { checked: active?.highlight === 'on' }),
    command('toggle-superscript', '上标', { checked: active?.superscript === 'on' }),
    command('toggle-subscript', '下标', { checked: active?.subscript === 'on' }),
    command('clear-inline-formatting', '清除格式', vectorIcon('clear-format')),
  ])
}

const horizontalRuleMenu = submenu(
  'insert-horizontal-rule',
  '水平分割线',
  HORIZONTAL_RULE_STYLES.map((style) => command(style.commandId, style.label, {
    preview: {
      kind: 'horizontal-rule',
      color: style.color,
      height: style.height,
    },
  })),
  vectorIcon('horizontal-rule'),
)

const insertMenu = submenu('insert', '插入', [
  command('insert-image', '图像', { ...vectorIcon('image'), shortcut: 'Ctrl+Shift+I' }),
  command('insert-link-reference', '链接引用', vectorIcon('link-reference')),
  horizontalRuleMenu,
  command('insert-table', '表格', { ...vectorIcon('table'), shortcut: 'Ctrl+T' }),
  command('insert-code-block', '代码块', { ...vectorIcon('code-block'), shortcut: 'Ctrl+Shift+K' }),
  command('insert-math-block', '公式块', { ...vectorIcon('formula'), shortcut: 'Ctrl+Shift+M' }),
  command('insert-yaml', 'YAML Front Matter', vectorIcon('yaml')),
  separator('insert-paragraph-separator'),
  command('insert-paragraph-before', '段落（上方）', vectorIcon('paragraph-before')),
  command('insert-paragraph-after', '段落（下方）', vectorIcon('paragraph-after')),
])

function commonTextItems(context: EditorContextSnapshot): readonly ContextMenuItem[] {
  const selectionDisabled = !(context.hasSelection ?? context.selectionText.length > 0)
  const selectionOptions = {
    disabled: selectionDisabled,
    disabledReason: selectionDisabled ? '请先选择文字' : undefined,
  }
  const clipboard = context.clipboardFormats
    ? clipboardFormatAvailability(context.clipboardFormats)
    : { plain: true, markdown: true, html: true }
  const mermaidPasteDisabledReason = context.kind === 'table'
    ? '表格单元格中不能粘贴 Mermaid 图形'
    : context.activeBlocks?.codeBlock
      ? '代码块中不能粘贴 Mermaid 图形'
      : context.clipboardFormats?.plainText.length
        ? undefined
        : '剪贴板中没有可用文本'
  return [
    searchCommand(context.selectionText),
    command('create-sticky-note', '建立便签', selectionOptions),
    separator('text-search-separator'),
    grid('edit-grid', [
      command('cut', '剪切', { ...vectorIcon('cut'), shortcut: 'Ctrl+X', ...selectionOptions }),
      command('copy', '复制', { ...vectorIcon('copy'), shortcut: 'Ctrl+C', ...selectionOptions }),
      command('paste', '粘贴', { ...vectorIcon('paste'), shortcut: 'Ctrl+V' }),
      command('delete-selection', '删除', { ...vectorIcon('delete'), ...selectionOptions }),
    ]),
    submenu('clipboard-formats', '复制 / 粘贴为…', [
      command('copy-plain', '复制为纯文本', selectionOptions),
      command('copy-markdown', '复制为 Markdown', selectionOptions),
      command('copy-html', '复制为 HTML', selectionOptions),
      separator('clipboard-formats-separator'),
      command('paste-plain', '粘贴为纯文本', {
        disabled: !clipboard.plain,
        tooltip: CLIPBOARD_FORMAT_TOOLTIPS.plain,
      }),
      command('paste-markdown', '粘贴为 Markdown', {
        disabled: !clipboard.markdown,
        tooltip: CLIPBOARD_FORMAT_TOOLTIPS.markdown,
      }),
      command('paste-html', '粘贴为 HTML', {
        disabled: !clipboard.html,
        disabledReason: !clipboard.html ? CLIPBOARD_FORMAT_TOOLTIPS.htmlUnavailable : undefined,
        tooltip: CLIPBOARD_FORMAT_TOOLTIPS.html,
      }),
      command('paste-mermaid', '粘贴为 Mermaid 图形', {
        disabled: Boolean(mermaidPasteDisabledReason),
        disabledReason: mermaidPasteDisabledReason,
      }),
    ]),
    separator('text-format-separator'),
    formatGrid(context),
  ]
}

function textMenu(context: EditorContextSnapshot): readonly ContextMenuItem[] {
  return [
    ...commonTextItems(context),
    separator('text-structure-separator'),
    moreFormatMenu(context.activeInlineFormats),
    paragraphMenu(context),
    insertMenu,
  ]
}

function imageMenu(context: EditorContextSnapshot): readonly ContextMenuItem[] {
  return [
    command('image-reveal', '在资源管理器中显示'),
    command('image-copy', '复制图片'),
    command('image-save-copy', '图片另存为…'),
    command('image-copy-to', '复制图片到…'),
    separator('image-location-separator'),
    command('image-copy-address', '复制图片地址'),
    submenu('image-syntax', '图片语法', [
      command('image-to-markdown', '转换为 Markdown 图片'),
      command('image-to-html', '转换为 HTML 图片'),
    ]),
    submenu('image-zoom', '图片缩放', [
      command('image-zoom-25', '25%'),
      command('image-zoom-50', '50%'),
      command('image-zoom-75', '75%'),
      command('image-zoom-100', '100%'),
      command('image-zoom-adaptive', '自适应宽度'),
    ]),
    submenu('image-alignment', '对齐方式', [
      command('image-align-left', '左对齐', {
        ...icon(imageAlignLeftIcon, 22, 22),
        iconChoice: true,
        checked: context.imageAlignment === 'left',
      }),
      command('image-align-center', '居中对齐', {
        ...icon(imageAlignCenterIcon, 22, 22),
        iconChoice: true,
        checked: (context.imageAlignment ?? 'center') === 'center',
      }),
      command('image-align-right', '右对齐', {
        ...icon(imageAlignRightIcon, 22, 22),
        iconChoice: true,
        checked: context.imageAlignment === 'right',
      }),
    ]),
    command('image-alt', '编辑替代文本…'),
    separator('image-delete-separator'),
    command('delete-object', '删除图片引用', { danger: true }),
  ]
}

function mermaidMenu(context: EditorContextSnapshot): readonly ContextMenuItem[] {
  const diagramReady = context.mermaidRenderState === 'ready'
    && Boolean(context.mermaidImageDataUrl?.startsWith('data:'))
  const diagramOptions = {
    disabled: !diagramReady,
    disabledReason: diagramReady ? undefined : 'Mermaid 图形尚未生成完成',
  }
  return [
    command(
      'mermaid-toggle-source',
      context.mermaidMode === 'source' ? '显示图形' : '编辑源码',
    ),
    separator('mermaid-diagram-separator'),
    command('mermaid-copy-image', '复制图形', diagramOptions),
    command('mermaid-save-image', '图形另存为…', diagramOptions),
    separator('mermaid-source-separator'),
    command('mermaid-copy-source', '复制 Mermaid 源码'),
    command('mermaid-copy-markdown', '复制为 Mermaid Markdown'),
  ]
}

function tableMenu(context: EditorContextSnapshot): readonly ContextMenuItem[] {
  const table = context.table
  const boundary = (disabled: boolean, reason: string) => ({
    disabled,
    disabledReason: disabled ? reason : undefined,
  })

  const items: readonly ContextMenuItem[] = [
    ...commonTextItems(context),
    separator('table-structure-separator'),
    submenu('table-insert', '插入', [
      command('table-row-before', '在上方插入行'),
      command('table-row-after', '在下方插入行'),
      command('table-column-before', '在左侧插入列'),
      command('table-column-after', '在右侧插入列'),
    ]),
    submenu('table-delete', '删除', [
      command('table-delete-row', '删除行'),
      command('table-delete-column', '删除列'),
      command('table-delete', '删除表格', { danger: true }),
    ]),
    submenu('table-align', '对齐', [
      command('table-align-left', '左对齐'),
      command('table-align-center', '居中对齐'),
      command('table-align-right', '右对齐'),
    ]),
    submenu('table-move', '移动', [
      command('table-move-row-up', '上移一行', boundary(
        Boolean(table && table.rowIndex <= 0),
        '已经是第一行',
      )),
      command('table-move-row-down', '下移一行', boundary(
        Boolean(table && table.rowIndex >= table.rowCount - 1),
        '已经是最后一行',
      )),
      command('table-move-column-left', '左移一列', boundary(
        Boolean(table && table.columnIndex <= 0),
        '已经是第一列',
      )),
      command('table-move-column-right', '右移一列', boundary(
        Boolean(table && table.columnIndex >= table.columnCount - 1),
        '已经是最后一列',
      )),
    ]),
    submenu('table-copy-as', '复制为', [
      command('table-copy-markdown', 'Markdown'),
      command('table-copy-html', 'HTML'),
      separator('table-copy-separator'),
      command('table-format', '格式化表格'),
    ]),
  ]
  if (!context.crossCellSelection) return items
  const unsupported = new Set([
    'paste', 'paste-plain', 'paste-markdown', 'paste-html',
    'table-row-before', 'table-row-after', 'table-column-before', 'table-column-after',
    'table-align-left', 'table-align-center', 'table-align-right',
    'table-move-row-up', 'table-move-row-down', 'table-move-column-left', 'table-move-column-right',
  ])
  const restrict = (item: ContextMenuItem): ContextMenuItem => {
    if (item.kind === 'command' && unsupported.has(item.id)) return {
      ...item, disabled: true, disabledReason: '请先在单个单元格内放置文字光标',
    }
    if (item.kind === 'submenu' || item.kind === 'icon-grid') return { ...item, items: item.items.map(restrict) } as ContextMenuItem
    return item
  }
  return items.map(restrict)
}

function linkMenu(context: EditorContextSnapshot): readonly ContextMenuItem[] {
  return [
    command('link-open', '打开', { disabled: !context.href }),
    ...(parseLocalFileLink(context.href) ? [command('link-reveal', '打开文件位置')] : []),
    command('link-copy-address', '复制链接地址', { disabled: !context.href }),
    command('link-edit', '编辑链接…'),
    command('link-remove', '移除链接'),
    separator('link-sticky-note-separator'),
    command('create-sticky-note', '建立便签', { disabled: false }),
  ]
}

function horizontalRuleObjectMenu(
  context: EditorContextSnapshot,
): readonly ContextMenuItem[] {
  const target = context.horizontalRule
  if (!target) return []
  const { attributes } = target
  const action = (
    id: string,
    label: string,
    disabled = false,
  ) => command(id, label, { disabled })
  return [
    action('horizontal-rule-height-increase', '增加 1px', attributes.heightPx >= 12),
    action('horizontal-rule-height-decrease', '减少 1px', attributes.heightPx <= 1),
    action('horizontal-rule-opacity-increase', '加深 10%', attributes.opacityPercent >= 100),
    action('horizontal-rule-opacity-decrease', '减淡 10%', attributes.opacityPercent <= 10),
    separator('horizontal-rule-adjust-separator'),
    action('horizontal-rule-copy', '复制分割线'),
  ]
}

export function buildVisualEditorMenu(
  context: EditorContextSnapshot,
): readonly ContextMenuItem[] {
  switch (context.kind) {
    case 'horizontal-rule':
      return horizontalRuleObjectMenu(context)
    case 'image':
      return imageMenu(context)
    case 'mermaid':
      return mermaidMenu(context)
    case 'table':
      return tableMenu(context)
    case 'code':
      return [
        ...textMenu(context),
        separator('code-language-separator'),
        command('code-language', '代码语言…'),
      ]
    case 'link':
      return linkMenu(context)
    case 'task':
      return textMenu(context)
    default:
      return textMenu(context)
  }
}

export function buildSourceEditorMenu(
  selectionText: string,
  formats?: ClipboardFormatsSnapshot,
  activeInlineFormats?: InlineFormatStates,
): readonly ContextMenuItem[] {
  const selectionDisabled = selectionText.length === 0
  const selectionOptions = {
    disabled: selectionDisabled,
    disabledReason: selectionDisabled ? '请先选择文字' : undefined,
  }
  const clipboard = formats
    ? clipboardFormatAvailability(formats)
    : { plain: true, markdown: true, html: true }
  return [
    searchCommand(selectionText),
    command('create-sticky-note', '建立便签', selectionOptions),
    separator('source-search-separator'),
    command('undo', '撤销', { shortcut: 'Ctrl+Z' }),
    command('redo', '重做', { shortcut: 'Ctrl+Y' }),
    separator('source-edit-separator'),
    command('cut', '剪切', { shortcut: 'Ctrl+X', ...selectionOptions }),
    command('copy', '复制', { shortcut: 'Ctrl+C', ...selectionOptions }),
    command('paste', '粘贴', { shortcut: 'Ctrl+V' }),
    command('delete-selection', '删除', selectionOptions),
    command('select-all', '全选', { shortcut: 'Ctrl+A' }),
    command('paste-plain', '粘贴为纯文本', {
      disabled: !clipboard.plain,
      tooltip: CLIPBOARD_FORMAT_TOOLTIPS.plain,
    }),
    command('paste-markdown', '粘贴为 Markdown', {
      disabled: !clipboard.markdown,
      tooltip: CLIPBOARD_FORMAT_TOOLTIPS.markdown,
    }),
    command('paste-html', '粘贴为 HTML', {
      disabled: !clipboard.html,
      disabledReason: !clipboard.html ? CLIPBOARD_FORMAT_TOOLTIPS.htmlUnavailable : undefined,
      tooltip: CLIPBOARD_FORMAT_TOOLTIPS.html,
    }),
    separator('source-format-separator'),
    command('toggle-strong', '加粗', { shortcut: 'Ctrl+B' }),
    command('toggle-emphasis', '斜体', { shortcut: 'Ctrl+I' }),
    command('toggle-inline-code', '行内代码'),
    command('toggle-link', '链接', { shortcut: 'Ctrl+K' }),
    moreFormatMenu(activeInlineFormats),
    separator('source-line-separator'),
    command('move-line-up', '上移一行'),
    command('move-line-down', '下移一行'),
  ]
}
