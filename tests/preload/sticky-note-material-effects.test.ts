import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArkdownApi } from '../../src/shared/contracts'
import { copyStickyNoteMaterialEffects, DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS, STICKY_NOTE_MATERIAL_EFFECTS_CHANNEL, type StickyNoteMaterialEffects } from '../../src/shared/sticky-note-material-effects'

const electron = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return { ipcRenderer: Object.assign(new EventEmitter(), { invoke: vi.fn(), send: vi.fn() }),
    contextBridge: { exposeInMainWorld: vi.fn() }, webUtils: { getPathForFile: vi.fn() } }
})
vi.mock('electron', () => electron)
let api: ArkdownApi
const emit = (value: unknown) => electron.ipcRenderer.emit(STICKY_NOTE_MATERIAL_EFFECTS_CHANNEL, {}, value)
function subscribe(listener: (value: StickyNoteMaterialEffects) => void) {
  expect(api.onStickyNoteMaterialEffectsChanged).toBeTypeOf('function')
  return api.onStickyNoteMaterialEffectsChanged!(listener)
}

describe('material effects across the actual preload boundary', () => {
  beforeEach(async () => {
    vi.resetModules(); electron.ipcRenderer.removeAllListeners()
    await import('../../src/preload/index')
    const arkdownExports = electron.contextBridge.exposeInMainWorld.mock.calls.filter(([name]) => name === 'arkdown')
    expect(arkdownExports).toHaveLength(1)
    api = arkdownExports[0]![1] as ArkdownApi
  })
  afterEach(() => window.dispatchEvent(new Event('unload')))

  it('retains only the latest complete effects until subscription and replays it to later mounts', () => {
    emit(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS)
    const draft = copyStickyNoteMaterialEffects(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS)
    draft['flowing-glass'].innerGlowIntensity = 0.8
    emit(draft)
    const first: unknown[] = []; const stop = subscribe(value => first.push(value)); stop()
    const second: unknown[] = []; subscribe(value => second.push(value))
    expect(first).toEqual([draft]); expect(second).toEqual([draft])
  })

  it('isolates nested maps from the original payload, other listeners and later subscriptions', () => {
    const draft = copyStickyNoteMaterialEffects(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS)
    emit(draft)
    draft['warm-frosted-glass'].innerGlowIntensity = 1
    const stop = subscribe(value => { value['clear-glass'].transparency = 1 })
    const received: StickyNoteMaterialEffects[] = []; subscribe(value => received.push(value))
    expect(received).toEqual([DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS])
    emit(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS)
    expect(received.at(-1)).toEqual(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS)
    stop(); received[0]!['flowing-glass'].innerGlowRangePx = 0
    const late: unknown[] = []; subscribe(value => late.push(value))
    expect(late).toEqual([DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS])
  })

  it('transports optional decorations and isolates listener mutations from retained values', () => {
    const draft = copyStickyNoteMaterialEffects(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS)
    draft['warm-frosted-glass'].shadowEnabled = true
    draft['clear-glass'].shadowEnabled = true
    draft['flowing-glass'].borderHidden = false
    emit(draft)
    subscribe(value => { value['warm-frosted-glass'].shadowEnabled = false; value['flowing-glass'].borderHidden = true })
    const received: StickyNoteMaterialEffects[] = []; subscribe(value => received.push(value))
    expect(received).toEqual([draft])
    for (const key of ['shadowEnabled', 'borderHidden']) {
      emit({ ...draft, 'clear-glass': { ...draft['clear-glass'], [key]: 'true' } })
    }
    const late: StickyNoteMaterialEffects[] = []; subscribe(value => late.push(value))
    expect(late).toEqual([draft])
  })

  it('rejects malformed events before replacing the retained latest effects', () => {
    emit(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS)
    for (const invalid of [null, [], {}, Object.create(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS),
      { ...DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS, other: true },
      { ...DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS, 'flowing-glass': { transparency: 0, innerGlowIntensity: 1.1, innerGlowRangePx: 18 } },
      { ...DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS, 'clear-glass': { transparency: 0, innerGlowIntensity: 1, innerGlowRangePx: 61 } },
    ]) emit(invalid)
    const received: unknown[] = []; subscribe(value => received.push(value))
    expect(received).toEqual([DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS])
  })

  it('unsubscribes separately and releases the channel and retained state on preload unload', () => {
    const first: unknown[] = []; const second: unknown[] = []
    const stop = subscribe(value => first.push(value)); subscribe(value => second.push(value)); stop()
    emit(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS)
    expect(first).toEqual([]); expect(second).toHaveLength(1)
    window.dispatchEvent(new Event('unload'))
    expect(electron.ipcRenderer.listenerCount(STICKY_NOTE_MATERIAL_EFFECTS_CHANNEL)).toBe(0)
    emit(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS)
    const late: unknown[] = []; subscribe(value => late.push(value))
    expect(late).toEqual([]); expect(second).toHaveLength(1)
    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled()
  })
})
