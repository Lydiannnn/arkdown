import { describe, expect, it, vi } from 'vitest'
import {
  buildSourceEditorMenu,
  buildVisualEditorMenu,
  type EditorContextSnapshot,
} from '../../src/renderer/editor/context-menu/editor-menu-model'
import type { ContextMenuItem } from '../../src/renderer/context-menu/context-menu-types'
import { createStickyNoteFromSelection } from '../../src/renderer/sticky-notes/sticky-note-selection-command'

function command(
  items: readonly ContextMenuItem[],
  id: string,
): Extract<ContextMenuItem, { kind: 'command' }> | undefined {
  for (const item of items) {
    if (item.kind === 'command' && item.id === id) return item
    if (item.kind === 'submenu' || item.kind === 'icon-grid') {
      const nested = command(item.items, id)
      if (nested) return nested
    }
  }
  return undefined
}

const activeBlocks = {
  blockquote: false,
  codeBlock: false,
  bulletList: false,
  orderedList: false,
  taskList: false,
  paragraphStyle: 'paragraph' as const,
}

describe('create sticky note context command', () => {
  it.each(['text', 'code', 'table'] as const)(
    'offers the command for a non-empty %s selection',
    (kind) => {
      const context: EditorContextSnapshot = {
        kind,
        selectionText: 'selected',
        activeBlocks,
        ...(kind === 'table' ? {
          table: { rowIndex: 0, rowCount: 1, columnIndex: 0, columnCount: 1 },
        } : {}),
      }
      expect(command(buildVisualEditorMenu(context), 'create-sticky-note')).toMatchObject({
        label: '建立便签',
        disabled: false,
      })
    },
  )

  it('disables the command for empty visual and source selections', () => {
    expect(command(buildVisualEditorMenu({
      kind: 'text',
      selectionText: '',
      activeBlocks,
    }), 'create-sticky-note')?.disabled).toBe(true)
    expect(command(buildSourceEditorMenu(''), 'create-sticky-note')?.disabled).toBe(true)
    expect(command(buildSourceEditorMenu('source'), 'create-sticky-note')?.disabled).toBe(false)
  })

  it('imports the frozen snapshot before releasing the created note', async () => {
    const snapshot = {
      markdown: '**selected**',
      localResources: [],
      warnings: [],
    }
    const calls: string[] = []
    const importStickyNoteSelection = vi.fn(async () => {
      calls.push('import')
      return {
        ok: true as const,
        value: {
          note: { record: { id: 'note-id' } },
          warnings: [],
        },
      }
    })
    const releaseStickyNote = vi.fn(async () => {
      calls.push('release')
      return { ok: true as const, value: null }
    })

    const result = await createStickyNoteFromSelection({
      api: { importStickyNoteSelection, releaseStickyNote },
      snapshot,
    })

    expect(result.ok).toBe(true)
    expect(importStickyNoteSelection).toHaveBeenCalledWith({
      markdown: '**selected**',
      localResources: [],
    })
    expect(releaseStickyNote).toHaveBeenCalledWith('note-id')
    expect(calls).toEqual(['import', 'release'])
  })
})
