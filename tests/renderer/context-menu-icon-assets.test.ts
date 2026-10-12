import { isValidElement } from 'react'
import { describe, expect, it } from 'vitest'
import { AppIcon } from '../../src/renderer/icons/AppIcon'
import type { ContextMenuItem } from '../../src/renderer/context-menu/context-menu-types'
import {
  buildVisualEditorMenu,
  type EditorContextSnapshot,
  type EditorParagraphStyle,
} from '../../src/renderer/editor/context-menu/editor-menu-model'

type CommandItem = Extract<ContextMenuItem, { kind: 'command' }>

const baseContext: EditorContextSnapshot = {
  kind: 'text',
  selectionText: '图标',
  activeBlocks: {
    blockquote: false,
    codeBlock: false,
    bulletList: false,
    orderedList: false,
    taskList: false,
    paragraphStyle: null,
  },
}

function commands(items: readonly ContextMenuItem[]): CommandItem[] {
  return items.flatMap((item) => {
    if (item.kind === 'command') return [item]
    if (item.kind === 'submenu' || item.kind === 'icon-grid') return commands(item.items)
    return []
  })
}

function command(items: readonly ContextMenuItem[], id: string): CommandItem {
  const result = commands(items).find((item) => item.id === id)
  if (!result) throw new Error(`Missing context-menu command: ${id}`)
  return result
}

describe('text context-menu icon assets', () => {
  it('maps edit, paragraph and insert commands to unified semantic icons', () => {
    const menu = buildVisualEditorMenu(baseContext)
    const expected = {
      cut: 'cut', copy: 'copy', paste: 'paste', 'delete-selection': 'delete',
      'heading-1': 'heading-1', 'heading-2': 'heading-2', 'heading-3': 'heading-3',
      'heading-4': 'heading-4', 'heading-5': 'heading-5', 'heading-6': 'heading-6',
      'paragraph-body': 'paragraph', 'clear-formatting': 'clear-format',
      'insert-image': 'image', 'insert-link-reference': 'link-reference',
      'insert-table': 'table', 'insert-code-block': 'code-block',
      'insert-math-block': 'formula', 'insert-yaml': 'yaml',
      'insert-paragraph-before': 'paragraph-before',
      'insert-paragraph-after': 'paragraph-after',
    } as const

    for (const [id, iconName] of Object.entries(expected)) {
      const item = command(menu, id)
      expect(isValidElement(item.icon)).toBe(true)
      if (!isValidElement(item.icon)) continue
      expect(item.icon.type).toBe(AppIcon)
      expect(item.icon.props).toMatchObject({ name: iconName, size: 16 })
      expect(item.iconSrc).toBeUndefined()
    }

    const insertMenu = menu.find((item) => item.kind === 'submenu' && item.id === 'insert')
    expect(insertMenu?.kind).toBe('submenu')
    if (insertMenu?.kind === 'submenu') {
      const horizontalRuleMenu = insertMenu.items.find(
        (item) => item.kind === 'submenu' && item.id === 'insert-horizontal-rule',
      )
      expect(horizontalRuleMenu?.kind).toBe('submenu')
      if (horizontalRuleMenu?.kind === 'submenu') {
        expect(isValidElement(horizontalRuleMenu.icon)).toBe(true)
        if (isValidElement(horizontalRuleMenu.icon)) {
          expect(horizontalRuleMenu.icon.props).toMatchObject({ name: 'horizontal-rule', size: 16 })
        }
      }
    }
  })

  it.each([
    ['paragraph', 'paragraph-body'],
    ['heading-3', 'heading-3'],
  ] as const)('uses a theme-colored check for the active %s style', (style, commandId) => {
    const menu = buildVisualEditorMenu({
      ...baseContext,
      activeBlocks: {
        ...baseContext.activeBlocks!,
        paragraphStyle: style satisfies EditorParagraphStyle,
      },
    })

    const item = command(menu, commandId)
    expect(item.accentIcon).toBe(true)
    expect(isValidElement(item.icon)).toBe(true)
    if (isValidElement(item.icon)) expect(item.icon.props).toMatchObject({ name: 'check' })
    expect(item.iconSrc).toBeUndefined()
  })

  it('keeps normal paragraph icons for inactive styles', () => {
    const menu = buildVisualEditorMenu({
      ...baseContext,
      activeBlocks: {
        ...baseContext.activeBlocks!,
        paragraphStyle: 'heading-3',
      },
    })

    for (const id of ['paragraph-body', 'heading-2', 'heading-4', 'clear-formatting']) {
      expect(isValidElement(command(menu, id).icon)).toBe(true)
    }
  })
})
