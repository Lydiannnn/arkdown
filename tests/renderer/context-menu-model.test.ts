import { describe, expect, it } from 'vitest'
import {
  collectEnabledCommandIds,
  type ContextMenuItem,
} from '../../src/renderer/context-menu/context-menu-types'

describe('collectEnabledCommandIds', () => {
  it('returns enabled commands in visual order across grids and submenus', () => {
    const items: ContextMenuItem[] = [
      { kind: 'command', id: 'search', label: '使用默认浏览器搜索' },
      { kind: 'separator', id: 's1' },
      {
        kind: 'icon-grid',
        id: 'edit',
        columns: 4,
        items: [
          { kind: 'command', id: 'cut', label: '剪切' },
          { kind: 'command', id: 'copy', label: '复制', disabled: true },
        ],
      },
      {
        kind: 'submenu',
        id: 'paragraph',
        label: '段落',
        items: [
          { kind: 'command', id: 'body', label: '正文' },
          { kind: 'command', id: 'heading-1', label: '一级标题' },
        ],
      },
    ]

    expect(collectEnabledCommandIds(items)).toEqual([
      'search',
      'cut',
      'body',
      'heading-1',
    ])
  })
})
