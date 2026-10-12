import { describe, expect, it } from 'vitest'
import {
  parseStickyNoteContextMenuReady,
  parseStickyNoteContextMenuReset,
  parseStickyNoteContextMenuOpenInput,
  parseStickyNoteContextMenuShowPayload,
  serializeStickyNoteContextMenuItems,
  STICKY_NOTE_CONTEXT_MENU_CHANNELS,
} from '../../src/shared/sticky-note-context-menu'

describe('sticky note external context menu protocol', () => {
  it('uses request-scoped ready and reset channels with exact payloads', () => {
    expect(STICKY_NOTE_CONTEXT_MENU_CHANNELS.ready).toBe('sticky-note-context-menu:ready')
    expect(STICKY_NOTE_CONTEXT_MENU_CHANNELS.reset).toBe('sticky-note-context-menu:reset')

    expect(parseStickyNoteContextMenuReady({ requestId: 'menu-ready' })).toEqual({ requestId: 'menu-ready' })
    expect(parseStickyNoteContextMenuReset({ requestId: 'menu-reset' })).toEqual({ requestId: 'menu-reset' })
    expect(parseStickyNoteContextMenuReady({ requestId: '' })).toBeNull()
    expect(parseStickyNoteContextMenuReady({ requestId: 'menu-ready', extra: true })).toBeNull()
    expect(parseStickyNoteContextMenuReset({ requestId: 1 })).toBeNull()
    expect(parseStickyNoteContextMenuReset({ requestId: 'menu-reset', extra: true })).toBeNull()
  })

  it('serializes every supported visual item while removing renderer callbacks', () => {
    expect(serializeStickyNoteContextMenuItems([
      {
        kind: 'command',
        id: 'copy',
        label: '复制',
        icon: 'C',
        checked: true,
        swatchColor: '#FFF3B3',
        onSelect: () => undefined,
      },
      { kind: 'separator', id: 'separator' },
      {
        kind: 'submenu',
        id: 'style',
        label: '样式',
        items: [{
          kind: 'command',
          id: 'rule',
          label: '分割线',
          preview: { kind: 'horizontal-rule', color: 'rgba(0,0,0,.4)', height: 2 },
        }],
      },
    ])).toEqual([
      { kind: 'command', id: 'copy', label: '复制', icon: 'C', checked: true, swatchColor: '#FFF3B3' },
      { kind: 'separator', id: 'separator' },
      {
        kind: 'submenu',
        id: 'style',
        label: '样式',
        items: [{
          kind: 'command',
          id: 'rule',
          label: '分割线',
          preview: { kind: 'horizontal-rule', color: 'rgba(0,0,0,.4)', height: 2 },
        }],
      },
    ])
  })

  it('accepts exact bounded open requests and rejects functions or unknown fields', () => {
    const valid = {
      requestId: 'menu-1',
      screenX: 1910,
      screenY: 1070,
      widthCssPx: 200,
      rootIconGutter: 'none' as const,
      items: [{ kind: 'command', id: 'copy', label: '复制' }],
    }

    expect(parseStickyNoteContextMenuOpenInput(valid)).toEqual(valid)
    expect(parseStickyNoteContextMenuOpenInput({ ...valid, extra: true })).toBeNull()
    expect(parseStickyNoteContextMenuOpenInput({
      ...valid,
      items: [{ ...valid.items[0], onSelect: () => undefined }],
    })).toBeNull()
    expect(parseStickyNoteContextMenuOpenInput({ ...valid, rootIconGutter: 'automatic' })).toBeNull()
  })

  it('accepts and preserves only the explicit root gutter enum in show payloads', () => {
    const valid = {
      requestId: 'menu-2',
      x: 40,
      y: 50,
      widthCssPx: 200,
      rootIconGutter: 'reserved' as const,
      items: [{ kind: 'command' as const, id: 'copy', label: 'Copy' }],
    }

    expect(parseStickyNoteContextMenuShowPayload(valid)).toEqual(valid)
    expect(parseStickyNoteContextMenuShowPayload({ ...valid, extra: true })).toBeNull()
    expect(parseStickyNoteContextMenuShowPayload({ ...valid, rootIconGutter: 'none-at-all-levels' })).toBeNull()
  })
})
