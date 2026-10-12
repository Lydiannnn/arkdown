import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createStickyNoteMaterialEffectsController } from '../../src/main/sticky-notes/sticky-note-material-effects'
import { copyStickyNoteMaterialEffects, DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS, STICKY_NOTE_MATERIAL_EFFECTS_CHANNEL } from '../../src/shared/sticky-note-material-effects'

function note() {
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() }),
  })
}
function changed() {
  const result = copyStickyNoteMaterialEffects(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS)
  result['warm-frosted-glass'] = { transparency: 0.5, innerGlowIntensity: 0.8, innerGlowRangePx: 30 }
  return result
}

describe('effective material effects publisher', () => {
  it('binds before load and sends current draft to new and reloaded notes without focus changes', () => {
    const controller = createStickyNoteMaterialEffectsController()
    const first = note(); controller.bind(first)
    const draft = changed()
    expect(controller.setEffects(draft)).toBe(true)
    draft['warm-frosted-glass'].innerGlowIntensity = 0
    expect(first.webContents.send).not.toHaveBeenCalled()
    first.webContents.emit('did-finish-load')
    expect(first.webContents.send).toHaveBeenLastCalledWith(STICKY_NOTE_MATERIAL_EFFECTS_CHANNEL, changed())
    const second = note(); controller.bind(second); second.webContents.emit('did-finish-load')
    expect(second.webContents.send).toHaveBeenLastCalledWith(STICKY_NOTE_MATERIAL_EFFECTS_CHANNEL, changed())
    first.webContents.emit('did-start-loading')
    controller.setEffects(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS)
    expect(first.webContents.send).toHaveBeenCalledOnce()
    first.webContents.emit('did-finish-load')
    expect(first.webContents.send).toHaveBeenLastCalledWith(STICKY_NOTE_MATERIAL_EFFECTS_CHANNEL, DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS)
    expect(first.eventNames()).not.toContain('focus')
  })

  it('continues healthy peers after send failure and retries the same map without losing its latest value', () => {
    const report = vi.fn(); const controller = createStickyNoteMaterialEffectsController({ onError: report })
    const first = note(); const second = note()
    controller.bind(first); controller.bind(second)
    first.webContents.emit('did-finish-load'); second.webContents.emit('did-finish-load')
    first.webContents.send.mockImplementationOnce(() => { throw new Error('renderer unavailable') })
    expect(controller.setEffects(changed())).toBe(false)
    expect(second.webContents.send).toHaveBeenLastCalledWith(STICKY_NOTE_MATERIAL_EFFECTS_CHANNEL, changed())
    expect(report).toHaveBeenCalledOnce()
    expect(controller.setEffects(changed())).toBe(true)
    expect(first.webContents.send).toHaveBeenLastCalledWith(STICKY_NOTE_MATERIAL_EFFECTS_CHANNEL, changed())
    first.webContents.send.mockImplementationOnce((_channel, effects) => { effects['warm-frosted-glass'].transparency = 1 })
    controller.setEffects(changed())
    const third = note(); controller.bind(third); third.webContents.emit('did-finish-load')
    expect(third.webContents.send).toHaveBeenLastCalledWith(STICKY_NOTE_MATERIAL_EFFECTS_CHANNEL, changed())
  })

  it.each(['closed', 'destroyed'] as const)('disposes bindings on %s and does not send to dead renderers', event => {
    const controller = createStickyNoteMaterialEffectsController(); const window = note()
    controller.bind(window); window.webContents.emit('did-finish-load')
    if (event === 'closed') window.emit('closed')
    else window.webContents.emit('destroyed')
    controller.setEffects(changed()); window.webContents.emit('did-finish-load')
    expect(window.webContents.send).toHaveBeenCalledOnce()
    expect(window.listenerCount('closed')).toBe(0)
    expect(window.webContents.listenerCount('did-finish-load')).toBe(0)
  })

  it('rejects invalid effective maps atomically without corrupting future-note inheritance', () => {
    const controller = createStickyNoteMaterialEffectsController()
    controller.setEffects(changed())
    expect(() => controller.setEffects({ ...changed(), unexpected: true } as never)).toThrow()
    const window = note(); controller.bind(window); window.webContents.emit('did-finish-load')
    expect(window.webContents.send).toHaveBeenLastCalledWith(STICKY_NOTE_MATERIAL_EFFECTS_CHANNEL, changed())
  })

})
