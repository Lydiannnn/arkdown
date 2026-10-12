import { describe, expect, it } from 'vitest'
import {
  parseStickyNoteContextMenuOpenInput,
  parseStickyNoteContextMenuShowPayload,
  serializeStickyNoteContextMenuItems,
} from '../../src/shared/sticky-note-context-menu'

describe('sticky note external context-menu presentation metadata', () => {
  it('round-trips submenu sizing, owner theme and theme-text selection', () => {
    const items = serializeStickyNoteContextMenuItems([{
      kind: 'command', id: 'yellow', label: '黄色', checked: true,
      checkedAppearance: 'theme-text',
    }])
    expect(items).toEqual([{
      kind: 'command', id: 'yellow', label: '黄色', checked: true,
      checkedAppearance: 'theme-text',
    }])
    const open = {
      requestId: 'menu-theme', screenX: 300, screenY: 200,
      widthCssPx: 200, submenuWidthCssPx: 300,
      rootIconGutter: 'none' as const, themeColorRgb: '37 99 235',
      colorScheme: 'dark' as const, items,
    }
    expect(parseStickyNoteContextMenuOpenInput(open)).toEqual(open)
    const show = {
      requestId: 'menu-theme', x: 12, y: 18,
      widthCssPx: 200, submenuWidthCssPx: 300,
      rootIconGutter: 'none' as const, themeColorRgb: '37 99 235',
      colorScheme: 'dark' as const, items,
    }
    expect(parseStickyNoteContextMenuShowPayload(show)).toEqual(show)
  })

  it('rejects malformed theme channels instead of injecting arbitrary CSS', () => {
    const base = {
      requestId: 'menu-theme', screenX: 300, screenY: 200,
      items: [{ kind: 'command' as const, id: 'copy', label: '复制' }],
    }
    expect(parseStickyNoteContextMenuOpenInput({
      ...base, themeColorRgb: '255 0 0; color: red',
    })).toBeNull()
    expect(parseStickyNoteContextMenuOpenInput({
      ...base, colorScheme: 'sepia',
    })).toBeNull()
  })
})
