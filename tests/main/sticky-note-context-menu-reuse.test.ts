import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { StickyNoteContextMenuWindow } from '../../src/main/sticky-notes/sticky-note-context-menu-window'

function owner(id: number) {
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: { id, isDestroyed: () => false, send: vi.fn() },
  })
}

function nativeWindow() {
  const state = { visible: false, opacity: 0, ignoresMouse: true, forwardsMoves: false, shows: 0, raises: 0, destroyed: false }
  return Object.assign(new EventEmitter(), {
    state,
    webContents: { isDestroyed: () => state.destroyed, send: vi.fn() },
    isDestroyed: () => state.destroyed,
    setBounds: vi.fn(),
    showInactive() { state.visible = true; state.shows++ },
    hide() { state.visible = false },
    moveTop() { state.raises++ },
    setOpacity(value: number) { state.opacity = value },
    setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }) {
      state.ignoresMouse = ignore
      state.forwardsMoves = ignore && options?.forward === true
    },
  })
}

describe('sticky menu reuse without native visibility transitions', () => {
  it('reuses the shown surface without forwarding mouse movement to the invisible menu', async () => {
    const surface = nativeWindow(), firstOwner = owner(101), otherOwner = owner(102)
    const manager = new StickyNoteContextMenuWindow({ createWindow: () => surface, displayForPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }) })
    manager.registerOwner(firstOwner); manager.registerOwner(otherOwner)
    for (let i = 0; i < 4; i++) {
      const source = i % 2 ? otherOwner : firstOwner
      await manager.open(source.webContents.id, { requestId: `open-${i}`, screenX: 200+i, screenY: 100, items: [] })
      expect(surface.state.opacity).toBe(0)
      expect(surface.state.ignoresMouse).toBe(true)
      expect(manager.ready(surface.webContents, `open-${i}`)).toBe(true)
      expect(surface.state).toMatchObject({ visible: true, opacity: 1, ignoresMouse: false, forwardsMoves: false, shows: 1, raises: i+1 })
      manager.close(surface.webContents, `open-${i}`)
      expect(surface.state).toMatchObject({ visible: true, opacity: 0, ignoresMouse: true, forwardsMoves: false, shows: 1 })
      expect(manager.ready(surface.webContents, `open-${i}`)).toBe(false)
    }
  })

  it('performs the first native show again only after the cached window is destroyed', async () => {
    const first = nativeWindow(), next = nativeWindow(), source = owner(103)
    const manager = new StickyNoteContextMenuWindow({ createWindow: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(next), displayForPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }) })
    manager.registerOwner(source)
    await manager.open(103, { requestId: 'first', screenX: 20, screenY: 20, items: [] })
    manager.ready(first.webContents, 'first')
    first.state.destroyed = true; first.emit('closed')
    await manager.open(103, { requestId: 'second', screenX: 30, screenY: 30, items: [] })
    expect(manager.ready(first.webContents, 'first')).toBe(false)
    expect(manager.ready(next.webContents, 'second')).toBe(true)
    expect(next.state).toMatchObject({ visible: true, opacity: 1, ignoresMouse: false, shows: 1 })
  })
})
