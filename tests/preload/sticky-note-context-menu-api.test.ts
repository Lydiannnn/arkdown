import { describe, expect, it, vi } from 'vitest'
import { createArkdownApi, type StickyNoteContextMenuTransport } from '../../src/preload/arkdown-api'
import { STICKY_NOTE_CONTEXT_MENU_CHANNELS } from '../../src/shared/sticky-note-context-menu'

function transport() {
  let listener: ((payload: unknown) => void) | undefined
  return {
    value: { subscribe(next: (payload: unknown) => void) { listener = next; return () => { listener = undefined } } } satisfies StickyNoteContextMenuTransport,
    emit(payload: unknown) { listener?.(payload) },
  }
}

describe('sticky note context menu preload API', () => {
  it('uses fixed channels and filters malformed incoming events', async () => {
    const invoke = vi.fn(async () => ({ ok: true, value: null }))
    const show = transport(); const command = transport(); const closed = transport(); const reset = transport()
    const api = createArkdownApi(
      invoke, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, show.value, command.value, closed.value, reset.value,
    )
    const onCommand = vi.fn(); const onClosed = vi.fn(); const onShow = vi.fn(); const onReset = vi.fn()
    api.onStickyNoteContextMenuShow?.(onShow)
    api.onStickyNoteContextMenuCommand?.(onCommand)
    api.onStickyNoteContextMenuClosed?.(onClosed)
    api.onStickyNoteContextMenuReset?.(onReset)

    const open = { requestId: 'menu-1', screenX: 10, screenY: 20, items: [{ kind: 'command' as const, id: 'copy', label: '复制' }] }
    await api.openStickyNoteContextMenu?.(open)
    await api.executeStickyNoteContextMenuCommand?.({ requestId: 'menu-1', commandId: 'copy' })
    await api.readyStickyNoteContextMenu?.('menu-1')
    await api.closeStickyNoteContextMenu?.('menu-1')
    expect(invoke.mock.calls).toEqual([
      [STICKY_NOTE_CONTEXT_MENU_CHANNELS.open, open],
      [STICKY_NOTE_CONTEXT_MENU_CHANNELS.execute, { requestId: 'menu-1', commandId: 'copy' }],
      [STICKY_NOTE_CONTEXT_MENU_CHANNELS.ready, { requestId: 'menu-1' }],
      [STICKY_NOTE_CONTEXT_MENU_CHANNELS.close, { requestId: 'menu-1' }],
    ])

    show.emit({ requestId: 'menu-1', x: 10, y: 20, items: open.items })
    command.emit({ requestId: 'menu-1', commandId: 'copy' })
    command.emit({ requestId: 'menu-1', commandId: 'copy', extra: true })
    closed.emit({ requestId: 'menu-1' })
    reset.emit({ requestId: 'menu-1' })
    reset.emit({ requestId: 'menu-1', extra: true })
    expect(onShow).toHaveBeenCalledOnce()
    expect(onCommand).toHaveBeenCalledOnce()
    expect(onClosed).toHaveBeenCalledOnce()
    expect(onReset).toHaveBeenCalledOnce()
  })
})
