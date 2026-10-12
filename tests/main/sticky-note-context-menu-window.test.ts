import { describe, expect, it, vi } from 'vitest'
import { buildStickyNoteContextMenuWindowOptions } from '../../src/main/create-sticky-note-context-menu-window'
import { StickyNoteContextMenuWindow } from '../../src/main/sticky-notes/sticky-note-context-menu-window'

function target(id: number) {
  const listeners = new Map<string, () => void>()
  let destroyed = false
  return {
    id,
    webContents: { id: id + 100, isDestroyed: () => destroyed, send: vi.fn() },
    isDestroyed: () => destroyed,
    on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    once: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    emit(event: string) { listeners.get(event)?.() },
    destroy() { destroyed = true },
  }
}

describe('StickyNoteContextMenuWindow', () => {
  it('creates a non-focusable overlay window', () => {
    expect(buildStickyNoteContextMenuWindowOptions('preload.js')).toMatchObject({
      focusable: false,
      show: false,
      skipTaskbar: true,
      thickFrame: false,
    })
  })

  it('covers the nearest display and forwards commands only to the active owner', async () => {
    const owner = target(1)
    const overlay = {
      webContents: { isDestroyed: () => false, send: vi.fn() },
      isDestroyed: () => false,
      setBounds: vi.fn(),
      showInactive: vi.fn(), moveTop: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      setOpacity: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      focus: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
    }
    const manager = new StickyNoteContextMenuWindow({
      createWindow: vi.fn(() => overlay),
      displayForPoint: () => ({ workArea: { x: 1920, y: 0, width: 1920, height: 1080 } }),
    })
    manager.registerOwner(owner)

    await manager.open(owner.webContents.id, {
      requestId: 'menu-1',
      screenX: 3830,
      screenY: 1060,
      widthCssPx: 200,
      submenuWidthCssPx: 300,
      rootIconGutter: 'none',
      themeColorRgb: '37 99 235',
      colorScheme: 'dark',
      items: [{ kind: 'command', id: 'copy', label: '复制' }],
    })

    expect(overlay.setBounds).toHaveBeenCalledWith({ x: 1920, y: 0, width: 1920, height: 1080 })
    expect(overlay.webContents.send).toHaveBeenCalledWith(
      'sticky-note-context-menu:show',
      expect.objectContaining({
        requestId: 'menu-1',
        x: 1910,
        y: 1060,
        widthCssPx: 200,
        submenuWidthCssPx: 300,
        rootIconGutter: 'none',
        themeColorRgb: '37 99 235',
        colorScheme: 'dark',
      }),
    )
    expect(overlay.showInactive).not.toHaveBeenCalled()
    expect(overlay.setIgnoreMouseEvents).not.toHaveBeenCalled()
    expect(overlay.setOpacity).not.toHaveBeenCalled()
    expect(overlay.show).not.toHaveBeenCalled()
    expect(overlay.focus).not.toHaveBeenCalled()
    expect(manager.execute(overlay.webContents, { requestId: 'menu-1', commandId: 'copy' })).toBe(false)
    expect(manager.ready(overlay.webContents, 'menu-1')).toBe(true)
    expect(overlay.setBounds.mock.invocationCallOrder[0]).toBeLessThan(overlay.showInactive.mock.invocationCallOrder[0])
    expect(overlay.moveTop).toHaveBeenCalledOnce()
    expect(overlay.showInactive).toHaveBeenCalledOnce()
    expect(overlay.setOpacity).toHaveBeenLastCalledWith(1)
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
    expect(manager.execute(overlay.webContents, { requestId: 'menu-1', commandId: 'copy' })).toBe(true)
    expect(owner.webContents.send).toHaveBeenCalledWith(
      'sticky-note-context-menu:command',
      { requestId: 'menu-1', commandId: 'copy' },
    )
  })

  it('shows only the newest request after its matching renderer-ready event', async () => {
    const owner = target(6)
    const overlay = {
      webContents: { isDestroyed: () => false, send: vi.fn() },
      isDestroyed: () => false,
      setBounds: vi.fn(),
      showInactive: vi.fn(), moveTop: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      setOpacity: vi.fn(),
      hide: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
    }
    const manager = new StickyNoteContextMenuWindow({
      createWindow: () => overlay,
      displayForPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
    })
    manager.registerOwner(owner)

    await manager.open(owner.webContents.id, {
      requestId: 'menu-old',
      screenX: 10,
      screenY: 10,
      items: [{ kind: 'command', id: 'copy', label: 'Copy' }],
    })
    await manager.open(owner.webContents.id, {
      requestId: 'menu-new',
      screenX: 20,
      screenY: 20,
      items: [{ kind: 'command', id: 'paste', label: 'Paste' }],
    })

    expect(overlay.webContents.send).toHaveBeenCalledWith(
      'sticky-note-context-menu:reset',
      { requestId: 'menu-old' },
    )
    expect(manager.ready(overlay.webContents, 'menu-old')).toBe(false)
    expect(overlay.showInactive).not.toHaveBeenCalled()
    expect(manager.ready(overlay.webContents, 'menu-new')).toBe(true)
    expect(overlay.moveTop).toHaveBeenCalledOnce()
    expect(overlay.showInactive).toHaveBeenCalledOnce()

    manager.dismiss()
    expect(overlay.hide).not.toHaveBeenCalled()
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true)
    expect(overlay.setOpacity).toHaveBeenLastCalledWith(0)
    expect(overlay.webContents.send).toHaveBeenCalledWith(
      'sticky-note-context-menu:reset',
      { requestId: 'menu-new' },
    )
  })


  it('dismisses when its owner moves and ignores unregistered senders', async () => {
    const owner = target(2)
    const overlay = {
      webContents: { isDestroyed: () => false, send: vi.fn() },
      isDestroyed: () => false,
      setBounds: vi.fn(), showInactive: vi.fn(), moveTop: vi.fn(), setIgnoreMouseEvents: vi.fn(), setOpacity: vi.fn(),
      show: vi.fn(), hide: vi.fn(), focus: vi.fn(), on: vi.fn(), once: vi.fn(),
    }
    const manager = new StickyNoteContextMenuWindow({
      createWindow: () => overlay,
      displayForPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
    })
    manager.registerOwner(owner)

    await expect(manager.open(999, {
      requestId: 'menu-2', screenX: 10, screenY: 10,
      items: [{ kind: 'command', id: 'copy', label: '复制' }],
    })).resolves.toBe(false)

    await manager.open(owner.webContents.id, {
      requestId: 'menu-3', screenX: 10, screenY: 10,
      items: [{ kind: 'command', id: 'copy', label: '复制' }],
    })
    expect(overlay.showInactive).not.toHaveBeenCalled()
    owner.emit('move')

    expect(overlay.hide).not.toHaveBeenCalled()
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true)
    expect(overlay.setOpacity).toHaveBeenLastCalledWith(0)
    expect(owner.webContents.send).toHaveBeenCalledWith(
      'sticky-note-context-menu:closed',
      { requestId: 'menu-3' },
    )
  })

  it('cancels an opening request before the overlay becomes ready', async () => {
    const owner = target(3)
    let resolveReady!: () => void
    const ready = new Promise<void>((resolve) => { resolveReady = resolve })
    const overlay = {
      webContents: { isDestroyed: () => false, send: vi.fn() },
      isDestroyed: () => false,
      setBounds: vi.fn(),
      showInactive: vi.fn(), moveTop: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      setOpacity: vi.fn(),
      hide: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      whenReady: () => ready,
    }
    const manager = new StickyNoteContextMenuWindow({
      createWindow: () => overlay,
      displayForPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
    })
    manager.registerOwner(owner)

    const opening = manager.open(owner.webContents.id, {
      requestId: 'menu-pending',
      screenX: 10,
      screenY: 10,
      items: [{ kind: 'command', id: 'copy', label: 'Copy' }],
    })

    expect(manager.close(owner.webContents, 'menu-pending')).toBe(true)
    resolveReady()
    await expect(opening).resolves.toBe(true)
    expect(overlay.showInactive).not.toHaveBeenCalled()
    expect(overlay.setOpacity).not.toHaveBeenCalledWith(1)
    expect(owner.webContents.send).toHaveBeenCalledWith(
      'sticky-note-context-menu:closed',
      { requestId: 'menu-pending' },
    )
  })

  it.each(['move', 'resize', 'blur'] as const)(
    'cancels a pending request when its owner emits %s',
    async (event) => {
      const owner = target(4)
      let resolveReady!: () => void
      const ready = new Promise<void>((resolve) => { resolveReady = resolve })
      const overlay = {
        webContents: { isDestroyed: () => false, send: vi.fn() },
        isDestroyed: () => false,
        setBounds: vi.fn(),
        showInactive: vi.fn(), moveTop: vi.fn(),
        setIgnoreMouseEvents: vi.fn(),
        setOpacity: vi.fn(),
        hide: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        whenReady: () => ready,
      }
      const manager = new StickyNoteContextMenuWindow({
        createWindow: () => overlay,
        displayForPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      })
      manager.registerOwner(owner)
      const opening = manager.open(owner.webContents.id, {
        requestId: 'menu-pending-lifecycle-' + event,
        screenX: 10,
        screenY: 10,
        items: [{ kind: 'command', id: 'copy', label: 'Copy' }],
      })

      owner.emit(event)
      resolveReady()

      await expect(opening).resolves.toBe(true)
      expect(overlay.showInactive).not.toHaveBeenCalled()
      expect(overlay.setOpacity).not.toHaveBeenCalledWith(1)
      expect(owner.webContents.send).toHaveBeenCalledWith(
        'sticky-note-context-menu:closed',
        { requestId: 'menu-pending-lifecycle-' + event },
      )
    },
  )

  it('dismisses an active menu when its owner loses focus', async () => {
    const owner = target(4)
    const overlay = {
      webContents: { isDestroyed: () => false, send: vi.fn() },
      isDestroyed: () => false,
      setBounds: vi.fn(),
      showInactive: vi.fn(), moveTop: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      setOpacity: vi.fn(),
      hide: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
    }
    const manager = new StickyNoteContextMenuWindow({
      createWindow: () => overlay,
      displayForPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
    })
    manager.registerOwner(owner)
    await manager.open(owner.webContents.id, {
      requestId: 'menu-blur',
      screenX: 10,
      screenY: 10,
      items: [{ kind: 'command', id: 'copy', label: 'Copy' }],
    })
    expect(manager.ready(overlay.webContents, 'menu-blur')).toBe(true)

    owner.emit('blur')

    expect(overlay.hide).not.toHaveBeenCalled()
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true)
    expect(overlay.setOpacity).toHaveBeenLastCalledWith(0)
    expect(owner.webContents.send).toHaveBeenCalledWith(
      'sticky-note-context-menu:closed',
      { requestId: 'menu-blur' },
    )
  })

  it('does not dereference BrowserWindow webContents after the owner is destroyed', () => {
    const listeners = new Map<string, () => void>()
    const webContents = { id: 205, isDestroyed: () => true, send: vi.fn() }
    let destroyed = false
    const owner = {
      get webContents() {
        if (destroyed) throw new Error('Object has been destroyed')
        return webContents
      },
      isDestroyed: () => destroyed,
      on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
      once: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    }
    const manager = new StickyNoteContextMenuWindow({
      createWindow: vi.fn(),
      displayForPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
    })
    manager.registerOwner(owner)
    destroyed = true

    expect(() => listeners.get('closed')?.()).not.toThrow()
  })

  it('waits for the shared load before positioning and showing the newest cold request', async () => {
    const owner = target(8)
    let resolveLoaded!: () => void
    const loaded = new Promise<void>((resolve) => { resolveLoaded = resolve })
    const overlay = {
      webContents: { isDestroyed: () => false, send: vi.fn() },
      isDestroyed: () => false,
      setBounds: vi.fn(), showInactive: vi.fn(), moveTop: vi.fn(),
      setIgnoreMouseEvents: vi.fn(), setOpacity: vi.fn(), hide: vi.fn(),
      on: vi.fn(), once: vi.fn(), whenReady: () => loaded,
    }
    const createWindow = vi.fn(() => overlay)
    const manager = new StickyNoteContextMenuWindow({
      createWindow,
      displayForPoint: () => ({ workArea: { x: -1280, y: 0, width: 1280, height: 720 } }),
    })
    manager.registerOwner(owner)
    const first = manager.open(owner.webContents.id, {
      requestId: 'cold-old', screenX: -100, screenY: 30,
      items: [{ kind: 'command', id: 'copy', label: 'Copy' }],
    })
    const second = manager.open(owner.webContents.id, {
      requestId: 'cold-new', screenX: -200, screenY: 40,
      items: [{ kind: 'command', id: 'paste', label: 'Paste' }],
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(overlay.setBounds).not.toHaveBeenCalled()
    expect(overlay.showInactive).not.toHaveBeenCalled()

    resolveLoaded()
    await Promise.all([first, second])

    expect(createWindow).toHaveBeenCalledOnce()
    expect(overlay.setBounds).toHaveBeenCalledOnce()
    expect(overlay.setBounds).toHaveBeenCalledWith({ x: -1280, y: 0, width: 1280, height: 720 })
    expect(overlay.showInactive).not.toHaveBeenCalled()
    expect(overlay.webContents.send).not.toHaveBeenCalledWith('sticky-note-context-menu:show', expect.objectContaining({ requestId: 'cold-old' }))
    expect(overlay.webContents.send).toHaveBeenLastCalledWith('sticky-note-context-menu:show', expect.objectContaining({ requestId: 'cold-new', x: 1080, y: 40 }))
    expect(manager.ready(overlay.webContents, 'cold-old')).toBe(false)
    expect(manager.ready(owner.webContents, 'cold-new')).toBe(false)
    expect(manager.ready(overlay.webContents, 'cold-new')).toBe(true)
    expect(overlay.showInactive).toHaveBeenCalledOnce()
    expect(overlay.setBounds.mock.invocationCallOrder[0]).toBeLessThan(overlay.showInactive.mock.invocationCallOrder[0])
  })

  it('reopens the transparent overlay at the new bounds and restores its z-order without focusing', async () => {
    const owner = target(9)
    const overlay = {
      webContents: { isDestroyed: () => false, send: vi.fn() },
      isDestroyed: () => false,
      setBounds: vi.fn(), showInactive: vi.fn(), moveTop: vi.fn(),
      setIgnoreMouseEvents: vi.fn(), setOpacity: vi.fn(), hide: vi.fn(),
      focus: vi.fn(), on: vi.fn(), once: vi.fn(),
    }
    const createWindow = vi.fn(() => overlay)
    const manager = new StickyNoteContextMenuWindow({
      createWindow,
      displayForPoint: ({ x }) => ({ workArea: { x: x < 0 ? -1280 : 0, y: 0, width: 1280, height: 720 } }),
    })
    manager.registerOwner(owner)
    await manager.open(owner.webContents.id, { requestId: 'first', screenX: 10, screenY: 10, items: [] })
    expect(manager.ready(overlay.webContents, 'first')).toBe(true)
    expect(manager.close(overlay.webContents, 'first')).toBe(true)
    expect(overlay.hide).not.toHaveBeenCalled()
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true)
    expect(manager.ready(overlay.webContents, 'first')).toBe(false)

    await manager.open(owner.webContents.id, { requestId: 'reopen', screenX: -20, screenY: 30, items: [] })
    expect(overlay.setBounds).toHaveBeenLastCalledWith({ x: -1280, y: 0, width: 1280, height: 720 })
    expect(overlay.showInactive).toHaveBeenCalledOnce()
    expect(manager.execute(overlay.webContents, { requestId: 'first', commandId: 'copy' })).toBe(false)
    expect(manager.ready(overlay.webContents, 'reopen')).toBe(true)
    expect(overlay.showInactive).toHaveBeenCalledOnce()
    expect(overlay.setBounds.mock.invocationCallOrder[1]).toBeLessThan(overlay.setOpacity.mock.invocationCallOrder[2])
    expect(overlay.moveTop).toHaveBeenCalledTimes(2)
    expect(overlay.setOpacity).toHaveBeenLastCalledWith(1)
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
    expect(overlay.focus).not.toHaveBeenCalled()
  })
})
