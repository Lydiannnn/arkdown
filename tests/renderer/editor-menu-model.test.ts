import { isValidElement } from 'react'
import { describe, expect, it } from 'vitest'
import {
  buildSourceEditorMenu,
  buildVisualEditorMenu,
  type EditorContextSnapshot,
} from '../../src/renderer/editor/context-menu/editor-menu-model'
import type { ContextMenuItem } from '../../src/renderer/context-menu/context-menu-types'
import { AppIcon } from '../../src/renderer/icons/AppIcon'

type CommandItem = Extract<ContextMenuItem, { kind: 'command' }>

function commandIds(items: readonly ContextMenuItem[]): string[] {
  return items.flatMap((item) => {
    if (item.kind === 'command') return [item.id]
    if (item.kind === 'submenu' || item.kind === 'icon-grid') return commandIds(item.items)
    return []
  })
}

function labels(items: readonly ContextMenuItem[]): string[] {
  return items.flatMap((item) => {
    if (item.kind === 'separator' || item.kind === 'icon-grid') {
      return item.kind === 'icon-grid' ? labels(item.items) : []
    }
    if (item.kind === 'submenu') return [item.label, ...labels(item.items)]
    return [item.label]
  })
}

function commandItems(items: readonly ContextMenuItem[]): CommandItem[] {
  return items.flatMap((item) => {
    if (item.kind === 'command') return [item]
    if (item.kind === 'submenu' || item.kind === 'icon-grid') return commandItems(item.items)
    return []
  })
}

const textContext: EditorContextSnapshot = {
  kind: 'text',
  selectionText: 'Arkdown',
  activeBlocks: {
    blockquote: false,
    codeBlock: false,
    bulletList: false,
    orderedList: false,
    taskList: false,
    paragraphStyle: 'paragraph',
  },
}

describe('buildVisualEditorMenu', () => {
  it('checks only more-format commands whose exact state is on', () => {
    const menu = buildVisualEditorMenu({
      ...textContext,
      activeInlineFormats: {
        strike: 'on',
        underline: 'mixed',
        highlight: 'off',
        superscript: 'on',
        subscript: 'mixed',
      },
    } as EditorContextSnapshot)
    const commands = commandItems(menu)

    expect(commands.find((item) => item.id === 'toggle-strike')?.checked).toBe(true)
    expect(commands.find((item) => item.id === 'toggle-superscript')?.checked).toBe(true)
    for (const id of [
      'toggle-underline',
      'toggle-highlight',
      'toggle-subscript',
      'clear-inline-formatting',
    ]) {
      expect(commands.find((item) => item.id === id)?.checked).not.toBe(true)
    }
    expect(commands.find((item) => item.id === 'toggle-inline-formula')).toBeUndefined()
  })

  it('uses clipboard MIME availability and approved explanatory tooltips', () => {
    const menu = buildVisualEditorMenu({
      ...textContext,
      clipboardFormats: {
        plainText: '# title',
        markdown: null,
        html: null,
      },
    })
    const commands = commandItems(menu)
    expect(commands.find((item) => item.id === 'paste-plain')).toMatchObject({
      disabled: false,
      tooltip: '仅粘贴文字，不解析 Markdown 或 HTML 格式',
    })
    expect(commands.find((item) => item.id === 'paste-markdown')).toMatchObject({
      disabled: false,
      tooltip: '按 Markdown 语法解析标题、列表、链接等格式',
    })
    expect(commands.find((item) => item.id === 'paste-html')).toMatchObject({
      disabled: true,
      disabledReason: '剪贴板中没有 HTML 格式',
      tooltip: '读取并转换剪贴板中的 HTML 格式',
    })
  })

  it('offers Mermaid paste only when plain clipboard text can be inserted into the current block', () => {
    const textMenu = buildVisualEditorMenu({
      ...textContext,
      clipboardFormats: { plainText: 'flowchart TD', markdown: null, html: null },
    })
    const tableMenu = buildVisualEditorMenu({
      kind: 'table',
      selectionText: '',
      clipboardFormats: { plainText: 'flowchart TD', markdown: null, html: null },
    })
    const codeMenu = buildVisualEditorMenu({
      ...textContext,
      activeBlocks: { ...textContext.activeBlocks!, codeBlock: true },
      clipboardFormats: { plainText: 'flowchart TD', markdown: null, html: null },
    })

    expect(commandItems(textMenu).find((item) => item.id === 'paste-mermaid')).toMatchObject({
      label: '粘贴为 Mermaid 图形',
      disabled: false,
    })
    expect(commandItems(tableMenu).find((item) => item.id === 'paste-mermaid')).toMatchObject({
      disabled: true,
      disabledReason: '表格单元格中不能粘贴 Mermaid 图形',
    })
    expect(commandItems(codeMenu).find((item) => item.id === 'paste-mermaid')).toMatchObject({
      disabled: true,
      disabledReason: '代码块中不能粘贴 Mermaid 图形',
    })
  })

  it('builds the Typora-style text menu with search, icon grids and full submenus', () => {
    const menu = buildVisualEditorMenu(textContext)
    expect(labels(menu)).toEqual(expect.arrayContaining([
      '使用默认浏览器搜索',
      '剪切',
      '复制',
      '粘贴',
      '删除',
      '复制 / 粘贴为…',
      '段落',
      '插入',
      '一级标题',
      '六级标题',
      '图像',
      '表格',
      'YAML Front Matter',
      '段落（上方）',
      '段落（下方）',
    ]))
    expect(menu.filter((item) => item.kind === 'icon-grid')).toHaveLength(2)
    expect(commandIds(menu)).toContain('search-selection')
    expect(commandIds(menu)).not.toContain('insert-toc')
    expect(commandIds(menu)).not.toContain('insert-footnote')
    expect(labels(menu)).not.toEqual(expect.arrayContaining([
      '提升标题级别',
      '降低标题级别',
      '增加缩进',
      '减少缩进',
    ]))
    const format = menu.find((item) => item.kind === 'icon-grid' && item.id === 'format-grid')
    expect(format).toMatchObject({ columns: 4 })
    if (format?.kind === 'icon-grid') {
      expect(format.items).toHaveLength(8)
      expect(format.items.every((item) => Boolean(item.iconSrc))).toBe(true)
      expect(format.items.map((item) => item.id)).not.toContain('list-indent')
      expect(format.items.map((item) => item.id)).not.toContain('list-outdent')
    }
  })

  it('uses a preview-only submenu for the eleven horizontal rule styles', () => {
    const menu = buildVisualEditorMenu(textContext)
    const insert = menu.find((item) => item.kind === 'submenu' && item.id === 'insert')
    expect(insert?.kind).toBe('submenu')
    if (insert?.kind !== 'submenu') return

    const horizontalRule = insert.items.find(
      (item) => item.kind === 'submenu' && item.id === 'insert-horizontal-rule',
    )
    expect(horizontalRule?.kind).toBe('submenu')
    if (horizontalRule?.kind !== 'submenu') return

    expect(isValidElement(horizontalRule.icon)).toBe(true)
    if (isValidElement(horizontalRule.icon)) {
      expect(horizontalRule.icon.type).toBe(AppIcon)
      expect(horizontalRule.icon.props).toMatchObject({ name: 'horizontal-rule', size: 16 })
    }
    expect(horizontalRule.items).toHaveLength(11)
    expect(horizontalRule.items.every((item) => (
      item.kind === 'command'
      && item.preview?.kind === 'horizontal-rule'
      && typeof item.preview.color === 'string'
      && [2, 4, 8].includes(item.preview.height)
    ))).toBe(true)
  })

  it('disables browser search when no text is selected', () => {
    const menu = buildVisualEditorMenu({ kind: 'text', selectionText: '' })
    const search = menu.find((item) => item.kind === 'command' && item.id === 'search-selection')
    expect(search).toMatchObject({
      disabled: true,
      disabledReason: '请先选择要搜索的文字',
    })
  })

  it('disables destructive selection commands when the selection is empty', () => {
    const menu = buildVisualEditorMenu({ kind: 'text', selectionText: '' })
    const commands = menu.flatMap((item) =>
      item.kind === 'icon-grid' ? item.items : item.kind === 'command' ? [item] : [])
    for (const id of ['cut', 'copy', 'delete-selection']) {
      expect(commands.find((item) => item.id === id)).toMatchObject({
        disabled: true,
        disabledReason: '请先选择文字',
      })
    }
  })

  it('builds an isolated ready Mermaid menu with diagram actions in the visible order', () => {
    const menu = buildVisualEditorMenu({
      kind: 'mermaid',
      selectionText: '',
      mermaidMode: 'source',
      mermaidRenderState: 'ready',
      mermaidImageDataUrl: 'data:image/svg+xml;base64,QQ==',
    })

    expect(menu.map((item) => item.kind === 'command' ? [item.id, item.label] : item.kind))
      .toEqual([
        ['mermaid-toggle-source', '显示图形'],
        'separator',
        ['mermaid-copy-image', '复制图形'],
        ['mermaid-save-image', '图形另存为…'],
        'separator',
        ['mermaid-copy-source', '复制 Mermaid 源码'],
        ['mermaid-copy-markdown', '复制为 Mermaid Markdown'],
      ])
    for (const id of ['mermaid-copy-image', 'mermaid-save-image']) {
      expect(commandItems(menu).find((item) => item.id === id)).toMatchObject({
        disabled: false,
      })
    }
    expect(commandIds(menu).some((id) => id.startsWith('image-'))).toBe(false)
    expect(commandIds(menu)).not.toContain('delete-object')
  })

  it('keeps Mermaid image actions unavailable until a ready data URL exists', () => {
    const menu = buildVisualEditorMenu({
      kind: 'mermaid',
      selectionText: '',
      mermaidMode: 'preview',
      mermaidRenderState: 'ready',
      mermaidImageDataUrl: 'https://example.com/diagram.svg',
    })

    expect(menu[0]).toMatchObject({
      kind: 'command',
      id: 'mermaid-toggle-source',
      label: '编辑源码',
    })
    for (const id of ['mermaid-copy-image', 'mermaid-save-image']) {
      expect(commandItems(menu).find((item) => item.id === id)).toMatchObject({
        disabled: true,
        disabledReason: 'Mermaid 图形尚未生成完成',
      })
    }
  })

  it.each([
    ['image', ['image-reveal', 'image-copy', 'image-save-copy', 'image-copy-to', 'image-copy-address', 'image-alt', 'delete-object']],
    ['table', ['table-row-before', 'table-row-after', 'table-column-before', 'table-column-after', 'table-delete', 'table-copy-markdown', 'table-copy-html']],
    ['link', ['link-open', 'link-copy-address', 'link-edit', 'link-remove']],
  ] as const)('builds the complete %s object menu', (kind, expectedIds) => {
    const menu = buildVisualEditorMenu({
      kind,
      selectionText: '',
      href: kind === 'link' ? 'https://example.com' : undefined,
      source: kind === 'image' ? 'C:\\notes\\assets\\photo.png' : undefined,
    })
    expect(commandIds(menu)).toEqual(expect.arrayContaining([...expectedIds]))
  })

  it.each([
    'https://example.com/guide',
    'C:\\Workspace\\guide.md',
  ])('puts the exact 打开 command first for the link target %s', (href) => {
    const menu = buildVisualEditorMenu({ kind: 'link', selectionText: '', href })

    expect(menu[0]).toMatchObject({
      kind: 'command',
      id: 'link-open',
      label: '打开',
      disabled: false,
    })
    expect(menu.slice(-2)).toEqual([
      expect.objectContaining({ kind: 'separator' }),
      expect.objectContaining({
        kind: 'command',
        id: 'create-sticky-note',
        label: '建立便签',
        disabled: false,
      }),
    ])
  })

  it('combines common text actions with exactly five table-specific submenus', () => {
    const menu = buildVisualEditorMenu({
      kind: 'table',
      selectionText: '单元格文字',
    })

    expect(commandIds(menu)).toEqual(expect.arrayContaining([
      'cut',
      'copy',
      'paste',
      'toggle-strong',
      'toggle-task-list',
    ]))
    expect(menu.some((item) => item.kind === 'submenu' && item.id === 'paragraph')).toBe(false)
    const tableGroups = menu.filter(
      (item) => item.kind === 'submenu' && item.id.startsWith('table-'),
    )
    expect(tableGroups.map((item) => item.kind === 'submenu' ? item.label : '')).toEqual([
      '插入',
      '删除',
      '对齐',
      '移动',
      '复制为',
    ])

    const copyAs = tableGroups.at(-1)
    expect(copyAs?.kind).toBe('submenu')
    if (copyAs?.kind === 'submenu') {
      expect(copyAs.items.map((item) => {
        if (item.kind === 'separator') return 'separator'
        if (item.kind === 'icon-grid') return 'icon-grid'
        return item.label
      }))
        .toEqual(['Markdown', 'HTML', 'separator', '格式化表格'])
    }
  })

  it('disables table movement at each structural boundary', () => {
    const menu = buildVisualEditorMenu({
      kind: 'table',
      selectionText: '',
      table: {
        rowIndex: 0,
        rowCount: 2,
        columnIndex: 1,
        columnCount: 2,
      },
    })
    const commands = commandItems(menu)
    expect(commands.find((item) => item.id === 'table-move-row-up')).toMatchObject({
      disabled: true,
    })
    expect(commands.find((item) => item.id === 'table-move-row-down')).toMatchObject({
      disabled: false,
    })
    expect(commands.find((item) => item.id === 'table-move-column-left')).toMatchObject({
      disabled: false,
    })
    expect(commands.find((item) => item.id === 'table-move-column-right')).toMatchObject({
      disabled: true,
    })
  })

  it('uses active block state for toggle buttons and text menus for code and tasks', () => {
    const menu = buildVisualEditorMenu({
      kind: 'text',
      selectionText: '',
      activeBlocks: {
        blockquote: false,
        codeBlock: true,
        bulletList: false,
        orderedList: false,
        taskList: false,
        paragraphStyle: null,
      },
    })
    const commands = menu.flatMap((item) => item.kind === 'icon-grid' ? item.items : [])
    expect(commands.find((item) => item.id === 'toggle-code-block'))
      .toMatchObject({ checked: true })
    expect(commandIds(menu)).not.toContain('code-copy')
    expect(commandIds(menu)).not.toContain('task-toggle')
  })

  it('requests neutral checked surfaces only for ordered, unordered, and task-list buttons', () => {
    const menu = buildVisualEditorMenu({
      kind: 'text',
      selectionText: '',
      activeBlocks: {
        blockquote: true,
        codeBlock: true,
        bulletList: true,
        orderedList: true,
        taskList: true,
        paragraphStyle: 'paragraph',
      },
    })
    const commands = commandItems(menu)

    for (const id of ['toggle-ordered-list', 'toggle-bullet-list', 'toggle-task-list']) {
      expect(commands.find((item) => item.id === id)).toMatchObject({
        checked: true,
        checkedAppearance: 'neutral-surface',
      })
    }
    expect(commands.find((item) => item.id === 'toggle-code-block')?.checkedAppearance)
      .toBeUndefined()
    expect(commands.find((item) => item.id === 'toggle-blockquote')?.checkedAppearance)
      .toBeUndefined()
  })
})

describe('buildSourceEditorMenu', () => {
  it('maps source inline states to the same exact checks', () => {
    const menu = buildSourceEditorMenu('selected', undefined, {
      strike: 'off',
      underline: 'on',
      highlight: 'mixed',
      superscript: 'off',
      subscript: 'on',
    })
    const commands = commandItems(menu)

    expect(commands.find((item) => item.id === 'toggle-underline')?.checked).toBe(true)
    expect(commands.find((item) => item.id === 'toggle-subscript')?.checked).toBe(true)
    expect(commands.find((item) => item.id === 'toggle-highlight')?.checked).not.toBe(true)
    expect(commands.find((item) => item.id === 'clear-inline-formatting')?.checked).toBeUndefined()
    expect(commands.find((item) => item.id === 'toggle-inline-formula')).toBeUndefined()
  })

  it('uses source-only editing commands without object parsing', () => {
    const menu = buildSourceEditorMenu('selected')
    expect(commandIds(menu)).toEqual(expect.arrayContaining([
      'search-selection',
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'delete-selection',
      'select-all',
      'paste-plain',
      'toggle-strong',
      'toggle-emphasis',
      'toggle-strike',
      'toggle-inline-code',
      'toggle-link',
      'move-line-up',
      'move-line-down',
    ]))
    expect(commandIds(menu).some((id) => id.startsWith('image-'))).toBe(false)
  })

  it('places the complete more-format submenu immediately above paragraph in text menus', () => {
    const menu = buildVisualEditorMenu({ kind: 'text', selectionText: 'selected' })
    const more = menu.find((item) => item.id === 'more-format')
    expect(menu.findIndex((item) => item.id === 'more-format'))
      .toBe(menu.findIndex((item) => item.id === 'paragraph') - 1)
    expect(more?.kind === 'submenu' ? more.items.map((item) => item.id) : []).toEqual([
      'toggle-strike',
      'toggle-underline',
      'toggle-highlight',
      'toggle-superscript',
      'toggle-subscript',
      'clear-inline-formatting',
    ])
  })

  it('labels the body shortcut as Ctrl+· and does not retain Ctrl+0', () => {
    const menu = buildVisualEditorMenu({ kind: 'text', selectionText: '' })
    const paragraph = menu.find((item) => item.id === 'paragraph')
    const body = paragraph?.kind === 'submenu'
      ? paragraph.items.find((item) => item.id === 'paragraph-body')
      : undefined
    expect(body).toMatchObject({ shortcut: 'Ctrl+·' })
    expect(JSON.stringify(menu)).not.toContain('Ctrl+0')
  })

  it('offers the same more-format commands in source mode', () => {
    const menu = buildSourceEditorMenu('selected')
    const more = menu.find((item) => item.id === 'more-format')
    expect(more?.kind === 'submenu' ? more.items.map((item) => item.id) : []).toEqual([
      'toggle-strike',
      'toggle-underline',
      'toggle-highlight',
      'toggle-superscript',
      'toggle-subscript',
      'clear-inline-formatting',
    ])
  })

  it('disables source selection commands without a selection', () => {
    const menu = buildSourceEditorMenu('')
    for (const id of ['cut', 'copy', 'delete-selection']) {
      expect(menu.find((item) => item.kind === 'command' && item.id === id))
        .toMatchObject({ disabled: true })
    }
  })
})
