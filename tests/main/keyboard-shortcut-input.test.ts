import { describe, expect, it, vi } from 'vitest'
import { createKeyboardShortcutInputHandler } from '../../src/main/settings/keyboard-shortcut-input'
import { SHORTCUT_DEFINITIONS, type ShortcutBindings } from '../../src/shared/keyboard-shortcuts'

function setup(bindings: ShortcutBindings = {}) {
  let recording = false
  const native = vi.fn(), renderer = vi.fn(), send = vi.fn(), menus = vi.fn()
  const handler = createKeyboardShortcutInputHandler({ getBindings: () => bindings, isRecording: () => recording, executeNative: native, executeRenderer: renderer, sendInputEvent: send, setIgnoreMenuShortcuts: menus })
  const key = (key: string, extra: Record<string, unknown> = {}) => {
    const event = { preventDefault: vi.fn() }
    handler(event, { type: 'keyDown', key, code: '', control: true, alt: false, shift: false, meta: false, isComposing: false, isAutoRepeat: false, ...extra } as never)
    return event
  }
  return { native, renderer, send, menus, key, handler, bindings, record: (active: boolean) => { recording = active } }
}

describe('native shortcut input dispatch', () => {
  for (const definition of SHORTCUT_DEFINITIONS.filter(item => item.owner === 'fixed')) {
    it(`dispatches new ${definition.id} binding and consumes its keyUp`, () => {
      const t = setup({ [definition.id]: 'Ctrl+Alt+Shift+F12' })
      expect(t.key('F12', { alt: true, shift: true }).preventDefault).toHaveBeenCalledOnce()
      expect(t.native.mock.calls.length + t.send.mock.calls.length / 2).toBe(1)
      const count = t.native.mock.calls.length + t.send.mock.calls.length
      expect(t.key('F12', { type: 'keyUp', alt: true, shift: true }).preventDefault).toHaveBeenCalledOnce()
      expect(t.native.mock.calls.length + t.send.mock.calls.length).toBe(count)
    })
  }
  it('preserves menu-backed format commands in both editor modes', () => {
    const t = setup({ 'editor.strong': 'Ctrl+R' })
    t.key('r')
    expect(t.native).toHaveBeenCalledWith('format.strong')
    expect(t.send).not.toHaveBeenCalled()
    expect(t.key('b').preventDefault).toHaveBeenCalledOnce()
  })
  it('replays original navigation with repeat and shift, and always releases the key', () => {
    const t = setup({ 'navigation.select-left': 'Ctrl+R' })
    t.key('r', { isAutoRepeat: true })
    expect(t.send.mock.calls.map(call => call[0])).toEqual([
      { type: 'keyDown', keyCode: 'Left', modifiers: ['control', 'shift', 'isautorepeat'] },
      { type: 'keyUp', keyCode: 'Left', modifiers: ['control', 'shift'] },
    ])
  })
  it('never re-routes synchronous replay to an action that reused the old combination', () => {
    const t = setup({ 'navigation.left': 'Ctrl+R', 'file.save': 'Ctrl+Left' })
    t.send.mockImplementation(input => { expect(t.key('ArrowLeft', { type: input.type }).preventDefault).not.toHaveBeenCalled() })
    t.key('r')
    expect(t.native).not.toHaveBeenCalled()
    t.key('ArrowLeft')
    expect(t.native).toHaveBeenCalledExactlyOnceWith('file.save')
    expect(t.send).toHaveBeenCalledTimes(2)
    expect(t.menus.mock.calls.every(([ignore]) => ignore)).toBe(true)
  })
  it('permits old combinations to be reused by renderer, global and other builtin actions', () => {
    const t = setup({ 'editor.strong': 'Ctrl+R', 'workspace.search': 'Ctrl+B' })
    t.key('b')
    expect(t.renderer).toHaveBeenCalledExactlyOnceWith('search-workspace')
    expect(t.native).not.toHaveBeenCalled()
    t.bindings['workspace.search'] = null
    t.bindings['navigation.left'] = 'Ctrl+B'
    t.key('b')
    expect(t.send).toHaveBeenCalledTimes(2)
    delete t.bindings['navigation.left']
    t.bindings['tools.screen-translation-once'] = 'Ctrl+B'
    expect(t.key('b').preventDefault).toHaveBeenCalledOnce()
    expect(t.native).not.toHaveBeenCalled()
  })
  it('does not disrupt composing, recording, modifiers, unlisted typing or normal builtin navigation', () => {
    const t = setup({ 'navigation.left': 'Ctrl+R' })
    expect(t.key('r', { isComposing: true }).preventDefault).not.toHaveBeenCalled()
    t.record(true)
    expect(t.key('r').preventDefault).not.toHaveBeenCalled()
    expect(t.key('ArrowLeft').preventDefault).not.toHaveBeenCalled()
    t.record(false)
    expect(t.key('Enter', { control: false }).preventDefault).not.toHaveBeenCalled()
    expect(t.key('Tab', { control: false }).preventDefault).not.toHaveBeenCalled()
    expect(t.key('Control', { code: 'ControlLeft' }).preventDefault).not.toHaveBeenCalled()
    expect(t.key('ArrowRight').preventDefault).not.toHaveBeenCalled()
    expect(t.send).not.toHaveBeenCalled()
  })
  it('restores the reentry guard after a failed injection', () => {
    const t = setup({ 'navigation.left': 'Ctrl+R' })
    t.send.mockImplementationOnce(() => { throw new Error('closed') })
    expect(() => t.key('r')).toThrow('closed')
    expect(t.key('ArrowLeft').preventDefault).toHaveBeenCalledOnce()
  })
  it('uses current settings immediately and resumes default behavior after reset', () => {
    const t = setup({ 'navigation.left': 'Ctrl+R' })
    expect(t.key('ArrowLeft').preventDefault).toHaveBeenCalledOnce()
    delete t.bindings['navigation.left']
    expect(t.key('ArrowLeft').preventDefault).not.toHaveBeenCalled()
    expect(t.key('r').preventDefault).not.toHaveBeenCalled()
  })
})
