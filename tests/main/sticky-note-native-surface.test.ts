import { EventEmitter } from 'node:events'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createStickyNoteNativeSurfaceController,
  loadStickyNoteNativeSurface,
  stickyNoteNativeSurfaceAddonPath,
  stickyNoteStyleHasShadow,
} from '../../src/main/sticky-notes/sticky-note-native-surface'
import type { StickyNoteMicaAppearance } from '../../src/shared/sticky-note-mica-appearance'
import type { StickyNoteStyleReference } from '../../src/shared/sticky-note-preferences'
import { copyStickyNoteMaterialEffects, DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS } from '../../src/shared/sticky-note-material-effects'
import { DEFAULT_STICKY_NOTE_GLASS_APPEARANCES } from '../../src/shared/sticky-note-glass-appearance'

const MICA = { mode: 'material', materialPresetId: 'mica-light' } satisfies StickyNoteStyleReference
const WARM = { mode: 'material', materialPresetId: 'warm-frosted-glass' } satisfies StickyNoteStyleReference
const CLEAR = { mode: 'material', materialPresetId: 'clear-glass' } satisfies StickyNoteStyleReference
const ACRYLIC = { mode: 'material', materialPresetId: 'flowing-glass' } satisfies StickyNoteStyleReference
const CLASSIC = { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' } satisfies StickyNoteStyleReference
const WARM_APPEARANCE = { tintColor: '#ECE5CB', tintOpacity: 0, luminosityOpacity: 1 * (1 - 0.19), saturation: 1 }
const CLEAR_APPEARANCE = { tintColor: '#000000', tintOpacity: 0, luminosityOpacity: 0.5 * (1 - 0.63), saturation: 1 }
const MICA_APPEARANCE = { tintColor: '#F3F3F3', tintOpacity: 0, luminosityOpacity: 1, saturation: 1 }
const customWallpaper = () => ({
  materialEffects: {
    ...copyStickyNoteMaterialEffects(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS),
    'warm-frosted-glass': { ...DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS['warm-frosted-glass'], transparency: 0, shadowEnabled: false },
    'clear-glass': { ...DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS['clear-glass'], transparency: 0, shadowEnabled: false },
  },
  micaAppearance: { tintColor: '#AABBCC', tintOpacity: 0.2, luminosityOpacity: 0.3, saturation: 0.4 },
  glassAppearances: {
    'warm-frosted-glass': { tintColor: '#F0D0A0', tintOpacity: 0.11, luminosityOpacity: 0.22, saturation: 0.33 },
    'clear-glass': { tintColor: '#334455', tintOpacity: 0.44, luminosityOpacity: 0.55, saturation: 0.66 },
  },
})

function harness(platform: NodeJS.Platform = 'win32', useNewDefaults = false) {
  const calls: string[] = []
  const decorations = new Map<bigint, boolean>()
  const addon = {
    attach: vi.fn((hwnd: bigint, _source?: 'wallpaper' | 'host') => { calls.push(`attach:${hwnd}`); return true }),
    resize: vi.fn((hwnd: bigint): boolean | void => { calls.push(`resize:${hwnd}`) }),
    detach: vi.fn((hwnd: bigint) => { calls.push(`detach:${hwnd}`) }),
    clear: vi.fn(),
    configure: vi.fn((_hwnd: bigint, _appearance: StickyNoteMicaAppearance) => true),
    setGlassDecoration: vi.fn((hwnd: bigint, enabled: boolean, _shadowEnabled?: boolean) => { decorations.set(hwnd, enabled); return true }),
    setAcrylicBorderHidden: vi.fn((_hwnd: bigint, _hidden: boolean) => true),
  }
  const load = vi.fn(() => addon)
  const onError = vi.fn()
  const controller = createStickyNoteNativeSurfaceController({ platform, load, onError })
  // Keep legacy no-shadow transition/fallback coverage independent of the new defaults.
  if (!useNewDefaults) {
    const materialEffects = copyStickyNoteMaterialEffects(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS)
    materialEffects['warm-frosted-glass'].shadowEnabled = false
    materialEffects['clear-glass'].shadowEnabled = false
    controller.setWallpaperAppearances({ materialEffects, micaAppearance: MICA_APPEARANCE, glassAppearances: DEFAULT_STICKY_NOTE_GLASS_APPEARANCES })
  }
  function window(hwnd = 101n) {
    const events = new EventEmitter()
    const handle = Buffer.alloc(8)
    handle.writeBigUInt64LE(hwnd)
    let destroyed = false
    return Object.assign(events, {
      getNativeWindowHandle: vi.fn(() => handle),
      isDestroyed: () => destroyed,
      setBackgroundMaterial: vi.fn((material: string) => { calls.push(`${hwnd}:${material}`) }),
      setHasShadow: vi.fn(),
      closePermanently() { destroyed = true; events.emit('closed') },
    })
  }
  return { calls, decorations, addon, load, onError, controller, window }
}

describe('material decoration preferences', () => {
  it.each([WARM, CLEAR])('updates %j shadow in place and rolls back in native policy order', style => {
    const h = harness(); const window = h.window(); const peer = h.window(202n)
    const apply = h.controller.bind(window, style)
    h.controller.bind(peer, style === WARM ? CLEAR : WARM)
    const map = customWallpaper(); h.controller.setWallpaperAppearances(map)
    const order: string[] = []
    h.addon.setGlassDecoration.mockImplementation((_hwnd, enabled, shadowEnabled = false) => { order.push(`decoration:${enabled}:${shadowEnabled}`); window.emit('resize'); return true })
    window.setHasShadow.mockImplementation((enabled: boolean) => { order.push(`shadow:${enabled}`); window.emit('resize') })
    h.addon.configure.mockClear()
    map.materialEffects[style.materialPresetId].shadowEnabled = true
    expect(h.controller.setWallpaperAppearances(map)).toBe(true)
    expect(order).toEqual(['decoration:true:true', 'shadow:true'])
    expect(peer.setHasShadow.mock.calls).toEqual([[false]])
    expect(h.addon.configure).not.toHaveBeenCalled()
    apply({ ...style })
    expect(order).toEqual(['decoration:true:true', 'shadow:true'])
    map.materialEffects[style.materialPresetId].shadowEnabled = false
    order.length = 0
    expect(h.controller.setWallpaperAppearances(map)).toBe(true)
    expect(order).toEqual(['shadow:false', 'decoration:true:false'])
    expect(h.addon.attach).toHaveBeenCalledTimes(2)
    expect(h.addon.detach).not.toHaveBeenCalled()
    expect(h.onError).not.toHaveBeenCalled()
  })

  it('inherits each preset decoration in new windows and supplies legacy defaults', () => {
    const h = harness(); const map = customWallpaper()
    map.materialEffects['warm-frosted-glass'].shadowEnabled = true
    map.materialEffects['flowing-glass'].borderHidden = false
    expect(h.controller.setWallpaperAppearances(map)).toBe(true)
    const warm = h.window(); const clear = h.window(202n); const acrylic = h.window(303n)
    h.controller.bind(warm, WARM); h.controller.bind(clear, CLEAR); h.controller.bind(acrylic, ACRYLIC)
    expect(warm.setHasShadow).toHaveBeenLastCalledWith(true)
    expect(clear.setHasShadow).toHaveBeenLastCalledWith(false)
    expect(acrylic.setHasShadow).toHaveBeenLastCalledWith(true)
    expect(h.addon.setGlassDecoration.mock.calls).toEqual([[101n, true, true], [202n, true], [303n, true, true]])
    expect(h.addon.setAcrylicBorderHidden.mock.calls).toEqual([[101n, true]])
    const legacy = copyStickyNoteMaterialEffects(map.materialEffects)
    delete legacy['warm-frosted-glass'].shadowEnabled
    delete legacy['flowing-glass'].borderHidden
    expect(stickyNoteStyleHasShadow(WARM, legacy)).toBe(true)
    expect(h.controller.setWallpaperAppearances({ ...map, materialEffects: legacy })).toBe(true)
    expect(warm.setHasShadow).toHaveBeenLastCalledWith(true)
    expect(h.addon.setAcrylicBorderHidden).toHaveBeenLastCalledWith(303n, true)
  })

  it('toggles Acrylic border and restores the draft without changing shadow or the host graph', () => {
    const h = harness(); const window = h.window(); const apply = h.controller.bind(window, ACRYLIC)
    const map = customWallpaper(); h.controller.setWallpaperAppearances(map)
    h.addon.setAcrylicBorderHidden.mockClear(); h.addon.configure.mockClear()
    map.materialEffects['flowing-glass'].borderHidden = false
    expect(h.controller.setWallpaperAppearances(map)).toBe(true)
    apply({ ...ACRYLIC }); window.emit('resize')
    expect(h.addon.setAcrylicBorderHidden.mock.calls).toEqual([[101n, false]])
    map.materialEffects['flowing-glass'].borderHidden = true
    expect(h.controller.setWallpaperAppearances(map)).toBe(true)
    expect(h.addon.setAcrylicBorderHidden.mock.calls).toEqual([[101n, false], [101n, true]])
    expect(window.setHasShadow.mock.calls).toEqual([[true]])
    // Initial scope and the explicit resize refresh use the same policy.
    expect(h.addon.setGlassDecoration.mock.calls).toEqual([[101n, true, true], [101n, true, true]])
    expect(h.addon.attach).toHaveBeenCalledOnce()
    expect(h.addon.configure).not.toHaveBeenCalled()
    expect(h.addon.detach).not.toHaveBeenCalled()
  })

  it.each(['glass', 'shadow', 'border'] as const)('retries failed %s toggles on identical drafts while updating healthy peers', failure => {
    const h = harness(); const window = h.window()
    h.controller.bind(window, failure === 'border' ? ACRYLIC : WARM)
    h.controller.bind(h.window(202n), CLEAR)
    const map = customWallpaper(); h.controller.setWallpaperAppearances(map)
    map.materialEffects['warm-frosted-glass'].shadowEnabled = true
    map.materialEffects['flowing-glass'].borderHidden = false
    map.materialEffects['clear-glass'].transparency = .5
    if (failure === 'glass') h.addon.setGlassDecoration.mockReturnValueOnce(false)
    if (failure === 'border') h.addon.setAcrylicBorderHidden.mockReturnValueOnce(false)
    if (failure === 'shadow') window.setHasShadow.mockImplementationOnce(() => { throw Error('shadow unavailable') })
    expect(h.controller.setWallpaperAppearances(map)).toBe(false)
    expect(h.addon.configure).toHaveBeenLastCalledWith(202n, { ...map.glassAppearances['clear-glass'], tintOpacity: .22, luminosityOpacity: .275 })
    if (failure === 'glass') expect(window.setHasShadow.mock.calls).toEqual([[false]])
    expect(h.controller.setWallpaperAppearances(map)).toBe(true)
    expect(window.setHasShadow).toHaveBeenLastCalledWith(true)
    expect(h.addon.attach).toHaveBeenCalledTimes(2)
    expect(h.addon.detach).not.toHaveBeenCalled()
  })

  it.each([WARM, ACRYLIC])('cancels a failed decoration restore for %j and retries a later toggle on the same style', style => {
    const h = harness(); const window = h.window(); const apply = h.controller.bind(window, style)
    const map = customWallpaper(); h.controller.setWallpaperAppearances(map)
    const policy = style === WARM ? h.addon.setGlassDecoration : h.addon.setAcrylicBorderHidden
    const change = (enabled: boolean) => {
      if (style === WARM) map.materialEffects['warm-frosted-glass'].shadowEnabled = enabled
      else map.materialEffects['flowing-glass'].borderHidden = !enabled
    }
    change(true)
    policy.mockImplementationOnce(() => { throw Error('restore unavailable') })
    expect(h.controller.setWallpaperAppearances(map)).toBe(false)
    change(false)
    expect(h.controller.setWallpaperAppearances(map)).toBe(true)
    expect(policy).toHaveBeenLastCalledWith(101n, true)
    change(true)
    policy.mockReturnValueOnce(false)
    expect(h.controller.setWallpaperAppearances(map)).toBe(false)
    apply({ ...style })
    if (style === WARM) expect(policy).toHaveBeenLastCalledWith(101n, true, true)
    else expect(policy).toHaveBeenLastCalledWith(101n, false)
    expect(window.setHasShadow).toHaveBeenLastCalledWith(true)
    expect(h.addon.attach).toHaveBeenCalledOnce()
    expect(h.addon.detach).not.toHaveBeenCalled()
  })

  it.each([WARM, ACRYLIC])('retains %j decoration choices through surface fallback and recovery', style => {
    const h = harness(); const window = h.window(); const apply = h.controller.bind(window, style)
    const map = customWallpaper()
    map.materialEffects['warm-frosted-glass'].shadowEnabled = true
    map.materialEffects['flowing-glass'].borderHidden = false
    expect(h.controller.setWallpaperAppearances(map)).toBe(true)
    h.addon.resize.mockReturnValueOnce(false)
    window.emit('resize')
    h.addon.setGlassDecoration.mockClear(); h.addon.setAcrylicBorderHidden.mockClear()
    window.emit('resize'); apply({ ...style })
    expect(h.addon.attach).toHaveBeenCalledTimes(2)
    expect(window.setHasShadow).toHaveBeenLastCalledWith(true)
    expect(h.addon.setGlassDecoration.mock.calls).toEqual([[101n, true, true]])
    if (style === WARM) expect(h.addon.setAcrylicBorderHidden.mock.calls).toEqual([[101n, true]])
    else expect(h.addon.setAcrylicBorderHidden).not.toHaveBeenCalled()
  })

  it.each([WARM, CLEAR])('establishes %j full-client glass policy after material attachment before enabling its initial shadow', style => {
    const h = harness(); const window = h.window(); const map = customWallpaper()
    map.materialEffects[style.materialPresetId].shadowEnabled = true
    h.controller.setWallpaperAppearances(map)
    const order: string[] = []
    window.setBackgroundMaterial.mockImplementation(() => { order.push('material'); window.emit('resize') })
    h.addon.attach.mockImplementation(() => { order.push('attach'); window.emit('resize'); return true })
    h.addon.setGlassDecoration.mockImplementation((_hwnd, enabled, shadowEnabled) => {
      order.push(`decoration:${enabled}:${shadowEnabled}`); window.emit('resize'); return true
    })
    window.setHasShadow.mockImplementation((enabled: boolean) => { order.push(`shadow:${enabled}`); window.emit('resize') })
    const apply = h.controller.bind(window, style)
    expect(order).toEqual(['material', 'attach', 'decoration:true:true', 'shadow:true'])
    expect(h.addon.resize).toHaveBeenCalledTimes(2)
    apply({ ...style })
    expect(h.addon.setGlassDecoration).toHaveBeenCalledOnce()
    apply(MICA)
    expect(h.addon.setGlassDecoration.mock.calls).toEqual([[101n, true, true], [101n, false]])
    expect(h.addon.attach).toHaveBeenCalledOnce()
    expect(h.addon.detach).not.toHaveBeenCalled()
    expect(h.onError).not.toHaveBeenCalled()
  })
})

describe('persistent host Acrylic and final material coverage', () => {
  const acrylicBase = { tintColor: '#E9EEF2', tintOpacity: 0.30, luminosityOpacity: 0.65, saturation: 0.90 }

  it.each([true, false])('keeps Acrylic full-client scope independent of initial border removal %s', borderHidden => {
    const h = harness(); const window = h.window(); const map = customWallpaper()
    map.materialEffects['flowing-glass'].borderHidden = borderHidden
    h.controller.setWallpaperAppearances(map)
    const order: string[] = []
    h.addon.attach.mockImplementation((_hwnd, source) => { order.push(`attach:${source}`); window.emit('resize'); return true })
    h.addon.setGlassDecoration.mockImplementation((_hwnd, enabled, shadow) => { order.push(`scope:${enabled}:${shadow}`); window.emit('resize'); return true })
    h.controller.bind(window, ACRYLIC)
    expect(order).toEqual(['attach:host', 'scope:true:true'])
    expect(h.addon.resize).toHaveBeenCalledOnce()
    h.addon.setGlassDecoration.mockClear(); h.addon.setAcrylicBorderHidden.mockClear()
    map.materialEffects['flowing-glass'].borderHidden = !borderHidden
    expect(h.controller.setWallpaperAppearances(map)).toBe(true)
    expect(h.addon.setGlassDecoration).not.toHaveBeenCalled()
    expect(h.addon.setAcrylicBorderHidden).toHaveBeenLastCalledWith(101n, !borderHidden)
    expect(h.addon.attach).toHaveBeenCalledOnce()
    expect(h.addon.detach).not.toHaveBeenCalled()
    expect(window.setHasShadow.mock.calls).toEqual([[true]])
  })

  it.each([WARM, CLEAR])('hides the system border only while %j retains its shadow', style => {
    const h = harness(); const map = customWallpaper()
    const apply = h.controller.bind(h.window(), style)
    expect(h.addon.setAcrylicBorderHidden).not.toHaveBeenCalled()
    map.materialEffects[style.materialPresetId].shadowEnabled = true
    h.controller.setWallpaperAppearances(map)
    expect(h.addon.setAcrylicBorderHidden).toHaveBeenLastCalledWith(101n, true)
    map.materialEffects[style.materialPresetId].shadowEnabled = false
    h.controller.setWallpaperAppearances(map)
    expect(h.addon.setAcrylicBorderHidden).toHaveBeenLastCalledWith(101n, false)
    map.materialEffects[style.materialPresetId].shadowEnabled = true
    h.controller.setWallpaperAppearances(map); apply(MICA)
    expect(h.addon.setGlassDecoration).toHaveBeenLastCalledWith(101n, false)
    expect(h.addon.setAcrylicBorderHidden).toHaveBeenLastCalledWith(101n, false)
  })

  it.each([MICA, CLASSIC])('retains client-area ownership across Acrylic/glass and releases both policies before %j', target => {
    const h = harness(); const window = h.window(); const apply = h.controller.bind(window, ACRYLIC)
    apply(WARM); apply(ACRYLIC)
    expect(h.addon.setGlassDecoration.mock.calls).toEqual([[101n, true, true], [101n, true], [101n, true, true]])
    expect(h.addon.attach.mock.calls).toEqual([[101n, 'host'], [101n], [101n, 'host']])
    const order: string[] = []
    h.addon.setGlassDecoration.mockImplementation((_hwnd, enabled) => { order.push(`scope:${enabled}`); return true })
    h.addon.setAcrylicBorderHidden.mockImplementation((_hwnd, hidden) => { order.push(`border:${hidden}`); return true })
    h.addon.detach.mockImplementation(() => { order.push('detach') })
    apply(target)
    expect(order).toEqual(['scope:false', 'border:false', 'detach'])
  })

  it.each(['false', 'throw'] as const)('retries Acrylic client-area failure %s without rebuilding its healthy host', failure => {
    const h = harness(); let ready = false
    h.addon.setGlassDecoration.mockImplementation((hwnd) => {
      if (hwnd === 101n && !ready) { if (failure === 'throw') throw Error('client area unavailable'); return false }
      return true
    })
    h.controller.bind(h.window(), ACRYLIC); h.controller.bind(h.window(202n), CLEAR)
    const map = customWallpaper()
    expect(h.controller.setWallpaperAppearances(map)).toBe(false)
    expect(h.addon.configure).toHaveBeenCalledWith(202n, map.glassAppearances['clear-glass'])
    ready = true; h.addon.configure.mockClear()
    expect(h.controller.setWallpaperAppearances(map)).toBe(true)
    expect(h.addon.setGlassDecoration).toHaveBeenLastCalledWith(101n, true, true)
    expect(h.addon.attach).toHaveBeenCalledTimes(2)
    expect(h.addon.detach).not.toHaveBeenCalled()
    expect(h.addon.configure).not.toHaveBeenCalled()
  })

  it.each(['false', 'throw'] as const)('retries shadow-enabled glass border failure %s without rebuilding either material source', failure => {
    const h = harness(); const map = customWallpaper()
    h.controller.bind(h.window(), WARM); h.controller.bind(h.window(202n), ACRYLIC)
    h.controller.setWallpaperAppearances(map)
    map.materialEffects['warm-frosted-glass'].shadowEnabled = true
    h.addon.setAcrylicBorderHidden.mockImplementationOnce(() => {
      if (failure === 'throw') throw Error('border unavailable')
      return false
    })
    expect(h.controller.setWallpaperAppearances(map)).toBe(false)
    h.addon.setGlassDecoration.mockClear(); h.addon.setAcrylicBorderHidden.mockClear()
    expect(h.controller.setWallpaperAppearances(map)).toBe(true)
    expect(h.addon.setAcrylicBorderHidden.mock.calls).toEqual([[101n, true]])
    expect(h.addon.setGlassDecoration).not.toHaveBeenCalled()
    expect(h.addon.attach).toHaveBeenCalledTimes(2)
    expect(h.addon.detach).not.toHaveBeenCalled()
  })

  it('defers attach-time resize but measures the client after decoration emits its frame resize', () => {
    const h = harness(); const window = h.window()
    h.addon.attach.mockImplementation(() => { window.emit('resize'); return true })
    h.addon.setGlassDecoration.mockImplementation(() => { window.emit('resize'); return true })
    h.controller.bind(window, WARM)
    expect(h.addon.attach).toHaveBeenCalledOnce()
    expect(h.addon.setGlassDecoration).toHaveBeenCalledOnce()
    expect(h.addon.resize).toHaveBeenCalledOnce()
    expect(h.addon.detach).not.toHaveBeenCalled()
  })

  it('keeps a material-setter failure retryable without skipping healthy peer updates', () => {
    const h = harness(); const window = h.window()
    h.addon.attach.mockReturnValueOnce(false)
    h.controller.bind(window, ACRYLIC); h.controller.bind(h.window(202n), CLEAR)
    window.setBackgroundMaterial.mockImplementationOnce(() => { throw Error('translucency repair failed') })
    const map = customWallpaper()
    expect(h.controller.setWallpaperAppearances(map)).toBe(false)
    expect(h.addon.configure).toHaveBeenCalledWith(202n, map.glassAppearances['clear-glass'])
    expect(h.controller.setWallpaperAppearances(map)).toBe(true)
    expect(h.addon.configure).toHaveBeenLastCalledWith(101n, acrylicBase)
  })

  it('uses a host source and independent border ownership while retaining native shadow', () => {
    const h = harness(); const window = h.window()
    const apply = h.controller.bind(window, ACRYLIC)
    expect(h.calls).toEqual(['101:acrylic', 'attach:101'])
    expect(h.addon.attach.mock.calls).toEqual([[101n, 'host']])
    expect(h.addon.configure.mock.calls).toEqual([[101n, acrylicBase]])
    expect(h.addon.setAcrylicBorderHidden.mock.calls).toEqual([[101n, true]])
    expect(h.addon.setGlassDecoration.mock.calls).toEqual([[101n, true, true]])
    expect(window.setHasShadow.mock.calls).toEqual([[true]])
    apply(ACRYLIC)
    expect(h.addon.attach).toHaveBeenCalledOnce()
    expect(h.addon.configure).toHaveBeenCalledOnce()
    window.closePermanently()
    expect(h.addon.setAcrylicBorderHidden.mock.calls).toEqual([[101n, true]])
  })

  it('only rebuilds at source boundaries and restores Acrylic border before selecting wallpaper/classic', () => {
    const h = harness(); const apply = h.controller.bind(h.window(), ACRYLIC)
    apply(WARM); apply(CLEAR); apply(MICA); apply(ACRYLIC); apply(CLASSIC)
    expect(h.addon.attach.mock.calls).toEqual([[101n, 'host'], [101n], [101n, 'host']])
    expect(h.addon.detach).toHaveBeenCalledTimes(3)
    expect(h.addon.setAcrylicBorderHidden.mock.calls).toEqual([[101n, true], [101n, false], [101n, true], [101n, false]])
  })

  it('scales only each selected material coverage, ignores glow for native recipes, and preserves Mica', () => {
    const h = harness(); const map = customWallpaper()
    h.controller.bind(h.window(101n), ACRYLIC); h.controller.bind(h.window(202n), WARM)
    h.controller.bind(h.window(303n), CLEAR); h.controller.bind(h.window(404n), MICA)
    h.controller.setWallpaperAppearances(map); h.addon.configure.mockClear()
    map.materialEffects['flowing-glass'].transparency = .5
    map.materialEffects['warm-frosted-glass'].transparency = 1
    map.materialEffects['clear-glass'].innerGlowIntensity = 1
    expect(h.controller.setWallpaperAppearances(map)).toBe(true)
    expect(h.addon.configure.mock.calls).toEqual([
      [101n, { ...acrylicBase, tintOpacity: .15, luminosityOpacity: .325 }],
      [202n, { ...map.glassAppearances['warm-frosted-glass'], tintOpacity: 0, luminosityOpacity: 0 }],
    ])
    h.addon.configure.mockClear()
    h.controller.setAppearance(MICA_APPEARANCE)
    expect(h.addon.configure.mock.calls).toEqual([[404n, MICA_APPEARANCE]])
    h.controller.bind(h.window(505n), ACRYLIC)
    expect(h.addon.configure).toHaveBeenLastCalledWith(505n, { ...acrylicBase, tintOpacity: .15, luminosityOpacity: .325 })
    expect(map.glassAppearances['warm-frosted-glass'].tintOpacity).toBe(.11)
  })

  it.each(['false', 'throw'] as const)('retries %s host attach failure on identical draft while updating a healthy peer', failure => {
    const h = harness(); let available = false
    h.addon.attach.mockImplementation((hwnd) => {
      if (hwnd === 101n && !available) {
        if (failure === 'throw') throw Error('host policy unavailable')
        return false
      }
      return true
    })
    h.controller.bind(h.window(101n), ACRYLIC); h.controller.bind(h.window(202n), CLEAR)
    const map = customWallpaper()
    expect(h.controller.setWallpaperAppearances(map)).toBe(false)
    expect(h.addon.configure).toHaveBeenCalledWith(202n, map.glassAppearances['clear-glass'])
    available = true; h.addon.configure.mockClear()
    expect(h.controller.setWallpaperAppearances(map)).toBe(true)
    expect(h.addon.configure.mock.calls).toEqual([[101n, acrylicBase]])
  })

  it('retains detach restoration failure for retry and never attaches a replacement before successful restore', () => {
    const h = harness(); const window = h.window(); const apply = h.controller.bind(window, ACRYLIC)
    h.addon.detach.mockImplementationOnce(() => { throw Error('host restore failed') })
    apply(WARM)
    expect(h.addon.attach).toHaveBeenCalledOnce()
    expect(h.onError).toHaveBeenCalled()
    apply(WARM)
    expect(h.addon.detach).toHaveBeenCalledTimes(2)
    expect(h.addon.attach.mock.calls).toEqual([[101n, 'host'], [101n]])
  })

  it.each(['false', 'throw'] as const)('retries %s border restoration after leaving Acrylic and does not skip peer recipes', failure => {
    const h = harness(); let restore = false
    h.addon.setAcrylicBorderHidden.mockImplementation((_hwnd, hidden) => {
      if (!hidden && !restore) { if (failure === 'throw') throw Error('border restore failed'); return false }
      return true
    })
    const apply = h.controller.bind(h.window(), ACRYLIC)
    h.controller.bind(h.window(202n), CLEAR); apply(CLASSIC)
    const map = customWallpaper()
    expect(h.controller.setWallpaperAppearances(map)).toBe(false)
    expect(h.addon.configure).toHaveBeenCalledWith(202n, map.glassAppearances['clear-glass'])
    restore = true
    expect(h.controller.setWallpaperAppearances(map)).toBe(true)
    expect(h.addon.setAcrylicBorderHidden).toHaveBeenLastCalledWith(101n, false)
  })
})

describe('independent native material client area', () => {
  it.each([WARM, CLEAR, ACRYLIC])('preserves application resizability when Mica switches to %j after native frame removal', style => {
    const h = harness('win32', true)
    const window = Object.assign(h.window(), { isResizable: () => true })
    const apply = h.controller.bind(window, MICA)
    apply(style)
    // Chromium can clear WS_THICKFRAME on a translucent window after creation.
    // The addon must receive the application's capability, independently of that
    // late native frame snapshot, for both hit testing and resize cursors.
    expect(h.addon.setGlassDecoration).toHaveBeenLastCalledWith(101n, true, true, true)
    expect(h.onError).not.toHaveBeenCalled()
  })

  it('does not enable native resize supplements for an explicitly non-resizable window', () => {
    const h = harness('win32', true)
    const window = Object.assign(h.window(), { isResizable: () => false })
    const apply = h.controller.bind(window, MICA)
    apply(WARM)
    expect(h.addon.setGlassDecoration).toHaveBeenLastCalledWith(101n, true, true, false)
  })

  it.each([[MICA, false], [WARM, true], [CLEAR, true], [ACRYLIC, true], [CLASSIC, false]] as const)(
    'owns the initial custom-material client area for %j', (style, enabled) => {
      const h = harness()
      h.controller.bind(h.window(), style)
      expect(h.decorations.get(101n) ?? false).toBe(enabled)
      if (!enabled) expect(h.addon.setGlassDecoration).not.toHaveBeenCalled()
    },
  )

  it('switches glass and Mica decoration on one HWND without recreating the wallpaper target', () => {
    const h = harness(); const window = h.window()
    const apply = h.controller.bind(window, MICA)
    apply(WARM)
    expect(h.decorations.get(101n)).toBe(true)
    apply(CLEAR); apply({ ...CLEAR })
    expect(h.addon.setGlassDecoration.mock.calls).toEqual([[101n, true]])
    apply(MICA)
    expect(h.decorations.get(101n)).toBe(false)
    expect(h.addon.setGlassDecoration.mock.calls).toEqual([[101n, true], [101n, false]])
    expect(h.addon.attach).toHaveBeenCalledOnce()
    expect(h.addon.detach).not.toHaveBeenCalled()
    expect(window.getNativeWindowHandle).toHaveBeenCalledOnce()
    expect(h.addon.configure.mock.calls.map(call => call[1])).toEqual([
      MICA_APPEARANCE, WARM_APPEARANCE, CLEAR_APPEARANCE, MICA_APPEARANCE,
    ])
  })

  it.each(['false', 'throw'] as const)('keeps %s decoration failures retryable with the same map while configuring every peer', failure => {
    const h = harness(); let available = false
    h.addon.setGlassDecoration.mockImplementation((hwnd, enabled) => {
      if (hwnd === 101n && !available) {
        if (failure === 'throw') throw new Error('decoration failed')
        return false
      }
      h.decorations.set(hwnd, enabled); return true
    })
    h.controller.bind(h.window(101n), WARM)
    h.controller.bind(h.window(202n), CLEAR)
    h.addon.configure.mockClear()
    const map = customWallpaper()
    expect(h.controller.setWallpaperAppearances(map)).toBe(false)
    expect(h.addon.configure.mock.calls.map(call => call[0])).toEqual([101n, 202n])
    expect(h.decorations.get(202n)).toBe(true)
    expect(h.addon.detach).not.toHaveBeenCalled()
    available = true
    h.addon.configure.mockClear(); h.addon.setGlassDecoration.mockClear()
    expect(h.controller.setWallpaperAppearances(map)).toBe(true)
    expect(h.decorations.get(101n)).toBe(true)
    expect(h.addon.setGlassDecoration.mock.calls).toEqual([[101n, true]])
    expect(h.addon.configure).not.toHaveBeenCalled()
    h.addon.setGlassDecoration.mockClear()
    expect(h.controller.setWallpaperAppearances(map)).toBe(true)
    expect(h.addon.setGlassDecoration).not.toHaveBeenCalled()
  })

  it.each([WARM, ACRYLIC])('retains a failed %j client-area restore after selecting classic', style => {
    const h = harness(); let canRestore = false
    h.addon.setGlassDecoration.mockImplementation((hwnd, enabled) => {
      if (!enabled && !canRestore) return false
      h.decorations.set(hwnd, enabled); return true
    })
    const apply = h.controller.bind(h.window(), style)
    apply(CLASSIC)
    expect(h.decorations.get(101n)).toBe(true)
    expect(h.addon.detach).toHaveBeenCalledOnce()
    expect(h.controller.setWallpaperAppearances(customWallpaper())).toBe(false)
    canRestore = true
    expect(h.controller.setWallpaperAppearances(customWallpaper())).toBe(true)
    expect(h.decorations.get(101n)).toBe(false)
    expect(h.addon.attach).toHaveBeenCalledOnce()
    apply(style); canRestore = false; apply(CLASSIC)
    canRestore = true; apply(CLASSIC)
    expect(h.decorations.get(101n)).toBe(false)
  })

  it('restores owned decoration before detaching for classic', () => {
    const h = harness()
    h.addon.setGlassDecoration.mockImplementation((hwnd, enabled) => {
      h.calls.push(`decoration:${enabled}`); h.decorations.set(hwnd, enabled); return true
    })
    const apply = h.controller.bind(h.window(), WARM)
    h.calls.length = 0
    apply(CLASSIC)
    expect(h.calls).toEqual(['decoration:false', 'detach:101', '101:none'])
  })

  it.each(['attach', 'resize'] as const)('keeps glass decoration after %s fallback and refreshes it on later unattached resize', failure => {
    const h = harness(); const window = h.window()
    if (failure === 'attach') h.addon.attach.mockReturnValue(false)
    const apply = h.controller.bind(window, WARM)
    if (failure === 'resize') { h.addon.resize.mockReturnValue(false); window.emit('resize') }
    expect(h.decorations.get(101n)).toBe(true)
    expect(h.calls.slice(-2)).toEqual(['detach:101', '101:mica'])
    h.addon.resize.mockClear(); h.addon.setGlassDecoration.mockClear()
    window.emit('resize')
    expect(h.addon.setGlassDecoration.mock.calls).toEqual([[101n, true]])
    expect(h.addon.resize).not.toHaveBeenCalled()
    apply(MICA)
    expect(h.decorations.get(101n)).toBe(false)
  })

  it.each(['false', 'throw'] as const)('does not detach a healthy target when decoration resize returns %s', failure => {
    const h = harness(); const window = h.window()
    h.controller.bind(window, WARM)
    h.addon.setGlassDecoration.mockImplementationOnce(() => {
      if (failure === 'throw') throw new Error('refresh failed')
      return false
    })
    window.emit('resize')
    expect(h.onError).toHaveBeenCalledOnce()
    expect(h.addon.resize).toHaveBeenCalledOnce()
    expect(h.addon.detach).not.toHaveBeenCalled()
    h.addon.setGlassDecoration.mockClear()
    expect(h.controller.setWallpaperAppearances(customWallpaper())).toBe(true)
    expect(h.addon.setGlassDecoration.mock.calls).toEqual([[101n, true]])
  })

  it('suppresses recursive decoration writes when the native frame change synchronously emits resize', () => {
    const h = harness(); const window = h.window()
    h.addon.setGlassDecoration.mockImplementation((hwnd, enabled) => {
      if (h.addon.setGlassDecoration.mock.calls.length > 1) throw new Error('recursive decoration write')
      window.emit('resize')
      h.decorations.set(hwnd, enabled); return true
    })
    h.controller.bind(window, WARM)
    expect(h.decorations.get(101n)).toBe(true)
    expect(h.addon.setGlassDecoration).toHaveBeenCalledOnce()
    expect(h.addon.attach).toHaveBeenCalledOnce()
    expect(h.onError).not.toHaveBeenCalled()
  })

  it('never writes decoration to a closed HWND or clears another note during close', () => {
    const h = harness(); const first = h.window(101n); const second = h.window(202n)
    const apply = h.controller.bind(first, WARM)
    h.controller.bind(second, CLEAR)
    first.emit('close', { preventDefault() {} })
    expect(h.addon.detach).not.toHaveBeenCalled()
    first.closePermanently()
    h.addon.setGlassDecoration.mockClear()
    first.emit('resize'); apply(MICA)
    h.controller.setWallpaperAppearances(customWallpaper())
    expect(h.addon.setGlassDecoration).not.toHaveBeenCalled()
    second.emit('resize')
    expect(h.addon.setGlassDecoration.mock.calls).toEqual([[202n, true]])
    expect(h.addon.clear).not.toHaveBeenCalled()
    expect(h.addon.detach.mock.calls).toEqual([[101n]])
  })

  it('avoids native loading for decoration outside Windows', () => {
    const h = harness('linux'); const window = h.window()
    const apply = h.controller.bind(window, WARM)
    window.emit('resize'); h.controller.setWallpaperAppearances(customWallpaper()); apply(MICA)
    expect(h.load).not.toHaveBeenCalled()
    expect(h.addon.setGlassDecoration).not.toHaveBeenCalled()
  })
})

describe('sticky-note native wallpaper surface', () => {
  it('updates all changed wallpaper recipes in place while leaving classic alone', () => {
    const h = harness()
    const windows = [h.window(101n), h.window(202n), h.window(303n), h.window(404n)]
    for (const [index, style] of [MICA, WARM, CLEAR, CLASSIC].entries()) h.controller.bind(windows[index]!, style)
    h.addon.configure.mockClear()
    const map = customWallpaper()
    expect(h.controller.setWallpaperAppearances(map)).toBe(true)
    expect(h.addon.configure.mock.calls).toEqual([
      [101n, map.micaAppearance], [202n, map.glassAppearances['warm-frosted-glass']],
      [303n, map.glassAppearances['clear-glass']],
    ])
    expect(h.addon.attach).toHaveBeenCalledTimes(3)
    expect(h.addon.detach).not.toHaveBeenCalled()
    for (const window of windows) {
      expect(window.setBackgroundMaterial).toHaveBeenCalledOnce()
      expect(window.setHasShadow).toHaveBeenCalledOnce()
    }
    h.addon.configure.mockClear()
    expect(h.controller.setWallpaperAppearances(customWallpaper())).toBe(true)
    expect(h.addon.configure).not.toHaveBeenCalled()
  })

  it('changing warm also retries a pending clear attachment without configuring unchanged healthy Mica', () => {
    const h = harness()
    h.controller.setWallpaperAppearances(customWallpaper())
    h.controller.bind(h.window(101n), WARM)
    h.controller.bind(h.window(202n), MICA)
    h.addon.attach.mockReturnValueOnce(false)
    h.controller.bind(h.window(303n), CLEAR)
    h.addon.configure.mockClear()
    const changed = customWallpaper()
    changed.glassAppearances['warm-frosted-glass'].tintOpacity = 0
    expect(h.controller.setWallpaperAppearances(changed)).toBe(true)
    expect(h.addon.configure.mock.calls).toEqual([
      [101n, changed.glassAppearances['warm-frosted-glass']], [303n, changed.glassAppearances['clear-glass']],
    ])
  })

  it('keeps defensive snapshots for future notes, style changes and the Mica-only setter', () => {
    const h = harness()
    const map = customWallpaper()
    const expected = customWallpaper()
    h.controller.setWallpaperAppearances(map)
    map.micaAppearance.tintOpacity = 1
    map.glassAppearances['warm-frosted-glass'].tintColor = '#000000'
    map.glassAppearances['clear-glass'].saturation = 0
    h.controller.setAppearance(MICA_APPEARANCE)
    const calls: Array<[bigint, StickyNoteMicaAppearance]> = []
    h.addon.configure.mockImplementation((hwnd, appearance) => {
      calls.push([hwnd, { ...appearance }])
      appearance.tintColor = '#000000'
      return true
    })
    const apply = h.controller.bind(h.window(101n), WARM)
    h.controller.bind(h.window(202n), WARM)
    apply(CLEAR)
    h.controller.bind(h.window(303n), MICA)
    expect(calls).toEqual([
      [101n, expected.glassAppearances['warm-frosted-glass']],
      [202n, expected.glassAppearances['warm-frosted-glass']],
      [101n, expected.glassAppearances['clear-glass']],
      [303n, MICA_APPEARANCE],
    ])
    expect(h.addon.attach).toHaveBeenCalledTimes(3)
    expect(h.addon.detach).not.toHaveBeenCalled()
  })

  it.each(['false', 'throw'] as const)('continues peer updates after %s and retries only the pending recipe with the same map', (failure) => {
    const h = harness()
    h.controller.bind(h.window(101n), WARM)
    h.controller.bind(h.window(202n), CLEAR)
    h.addon.configure.mockClear()
    h.addon.configure.mockImplementationOnce(() => {
      if (failure === 'throw') throw Error('warm update failed')
      return false
    })
    expect(h.controller.setWallpaperAppearances(customWallpaper())).toBe(false)
    expect(h.addon.configure.mock.calls.map(call => call[0])).toEqual([101n, 202n])
    expect(h.onError).toHaveBeenCalledOnce()
    h.addon.configure.mockClear()
    expect(h.controller.setWallpaperAppearances(customWallpaper())).toBe(true)
    expect(h.addon.configure.mock.calls).toEqual([[101n, customWallpaper().glassAppearances['warm-frosted-glass']]])
    expect(h.addon.detach).not.toHaveBeenCalled()
    h.addon.configure.mockClear()
    h.controller.setWallpaperAppearances(customWallpaper())
    expect(h.addon.configure).not.toHaveBeenCalled()
  })

  it('rejects an invalid full map atomically without replacing the snapshot or touching windows', () => {
    const h = harness()
    h.controller.setWallpaperAppearances(customWallpaper())
    h.controller.bind(h.window(101n), WARM)
    h.addon.configure.mockClear()
    const invalid = customWallpaper()
    invalid.micaAppearance.tintOpacity = 0.9
    invalid.glassAppearances['clear-glass'].luminosityOpacity = Number.NaN
    expect(() => h.controller.setWallpaperAppearances(invalid)).toThrow()
    expect(h.addon.configure).not.toHaveBeenCalled()
    h.controller.bind(h.window(202n), MICA)
    h.controller.bind(h.window(303n), CLEAR)
    expect(h.addon.configure.mock.calls).toEqual([
      [202n, customWallpaper().micaAppearance], [303n, customWallpaper().glassAppearances['clear-glass']],
    ])
  })

  it('removes disposed glass bindings from full-map updates and succeeds without native loading outside Windows', () => {
    const h = harness()
    const closed = h.window(101n)
    h.controller.bind(closed, WARM)
    h.controller.bind(h.window(202n), CLEAR)
    closed.closePermanently()
    h.addon.configure.mockClear()
    expect(h.controller.setWallpaperAppearances(customWallpaper())).toBe(true)
    expect(h.addon.configure.mock.calls).toEqual([[202n, customWallpaper().glassAppearances['clear-glass']]])
    expect(h.addon.clear).not.toHaveBeenCalled()
    const linux = harness('linux')
    linux.controller.bind(linux.window(), WARM)
    expect(linux.controller.setWallpaperAppearances(customWallpaper())).toBe(true)
    expect(linux.load).not.toHaveBeenCalled()
  })

  it.each([[MICA, true], [WARM, true], [CLEAR, true], [ACRYLIC, true], [CLASSIC, true]] as const)(
    'applies the initial shadow policy for %j', (style, shadow) => {
      const h = harness('win32', true)
      const window = h.window()
      h.controller.bind(window, style)
      expect(window.setHasShadow.mock.calls).toEqual([[shadow]])
    },
  )

  it('changes shadow before wallpaper early returns and restores it for old styles without redundant calls', () => {
    const h = harness()
    const window = h.window()
    const apply = h.controller.bind(window, MICA)
    apply(WARM)
    apply(CLEAR)
    apply({ ...CLEAR })
    apply(MICA)
    apply(ACRYLIC)
    apply(CLASSIC)
    apply(WARM)
    h.controller.setAppearance(MICA_APPEARANCE)
    h.controller.setWallpaperAppearances(customWallpaper())
    window.closePermanently()
    apply(MICA)
    expect(window.setHasShadow.mock.calls).toEqual([[true], [false], [true], [false]])
  })

  it.each(['attach', 'resize'] as const)('retains glass shadow policy through a native %s fallback and restores it on Mica selection', (failure) => {
    const h = harness()
    if (failure === 'attach') h.addon.attach.mockReturnValue(false)
    else h.addon.resize.mockReturnValue(false)
    const window = h.window()
    const apply = h.controller.bind(window, WARM)
    if (failure === 'resize') window.emit('resize')
    expect(window.setHasShadow.mock.calls).toEqual([[false]])
    expect(window.setBackgroundMaterial).toHaveBeenLastCalledWith('mica')
    apply(MICA)
    expect(window.setHasShadow.mock.calls).toEqual([[false], [true]])
  })

  it.each([
    [WARM, WARM_APPEARANCE],
    [CLEAR, CLEAR_APPEARANCE],
  ] as const)('attaches an independent wallpaper recipe for initial %j', (style, expected) => {
    const h = harness()
    h.controller.setAppearance({ tintColor: '#ABCDEF', tintOpacity: 0.6, luminosityOpacity: 0.7, saturation: 0.2 })
    h.controller.bind(h.window(), style)
    expect(h.calls).toEqual(['101:mica', 'attach:101'])
    expect(h.addon.configure.mock.calls).toEqual([[101n, expected]])
  })

  it('configures each wallpaper preset change without resetting Electron or reattaching the target', () => {
    const h = harness()
    const apply = h.controller.bind(h.window(), MICA)
    h.addon.configure.mockClear()
    apply(WARM)
    apply(CLEAR)
    apply({ ...CLEAR })
    apply(MICA)
    expect(h.addon.configure.mock.calls).toEqual([
      [101n, WARM_APPEARANCE],
      [101n, CLEAR_APPEARANCE],
      [101n, MICA_APPEARANCE],
    ])
    expect(h.calls).toEqual(['101:mica', 'attach:101'])
  })

  it('limits Mica preview updates to Mica notes and uses the latest snapshot when glass returns to Mica', () => {
    const h = harness()
    const warm = h.window(202n)
    const clear = h.window(303n)
    h.controller.bind(h.window(101n), MICA)
    const applyWarm = h.controller.bind(warm, WARM)
    h.controller.bind(clear, CLEAR)
    h.addon.configure.mockClear()
    h.addon.configure.mockImplementation((hwnd) => {
      if (hwnd !== 101n) throw Error('glass should not receive Mica preview')
      return true
    })
    const latest = { tintColor: '#abcdef', tintOpacity: 0.32, luminosityOpacity: 0.44, saturation: 0.56 }
    expect(h.controller.setAppearance(latest)).toBe(true)
    latest.tintOpacity = 0.99
    const expected = { tintColor: '#ABCDEF', tintOpacity: 0.32, luminosityOpacity: 0.44, saturation: 0.56 }
    expect(h.addon.configure.mock.calls).toEqual([[101n, expected]])
    expect(h.onError).not.toHaveBeenCalled()
    h.addon.configure.mockImplementation(() => true)
    applyWarm(MICA)
    h.controller.bind(h.window(404n), MICA)
    h.controller.bind(h.window(505n), WARM)
    expect(h.addon.configure.mock.calls.slice(-3)).toEqual([
      [202n, expected], [404n, expected], [505n, WARM_APPEARANCE],
    ])
    expect(h.addon.detach).not.toHaveBeenCalled()
    expect(warm.setBackgroundMaterial).toHaveBeenCalledOnce()
    expect(clear.setBackgroundMaterial).toHaveBeenCalledOnce()
  })

  it('does not report Mica preview failure for an unattached independent glass note', () => {
    const h = harness()
    h.addon.attach.mockReturnValue(false)
    h.controller.bind(h.window(), WARM)
    h.controller.bind(h.window(202n), CLEAR)
    h.addon.configure.mockClear()
    expect(h.controller.setAppearance({ tintColor: '#FFFFFF', tintOpacity: 0.2, luminosityOpacity: 0.3, saturation: 0.4 })).toBe(true)
    expect(h.addon.configure).not.toHaveBeenCalled()
    expect(h.onError).not.toHaveBeenCalled()
  })

  it('releases wallpaper targets only when leaving for Acrylic or classic and reattaches on return to glass', () => {
    const h = harness()
    const apply = h.controller.bind(h.window(), WARM)
    apply(CLEAR)
    apply(MICA)
    apply(ACRYLIC)
    apply(CLASSIC)
    apply(CLEAR)
    expect(h.calls).toEqual([
      '101:mica', 'attach:101', 'detach:101', '101:acrylic',
      'attach:101', 'detach:101', '101:none', '101:mica', 'attach:101',
    ])
    expect(h.addon.configure.mock.calls).toEqual([
      [101n, WARM_APPEARANCE], [101n, CLEAR_APPEARANCE],
      [101n, MICA_APPEARANCE],
      [101n, { tintColor: '#E9EEF2', tintOpacity: .30, luminosityOpacity: .65, saturation: .90 }],
      [101n, CLEAR_APPEARANCE],
    ])
    expect(h.load).toHaveBeenCalledOnce()
  })

  it.each(['false', 'throw'] as const)('retains the attached target on a %s recipe update failure and permits retry', (failure) => {
    const h = harness()
    const apply = h.controller.bind(h.window(), WARM)
    h.addon.configure.mockImplementationOnce(() => {
      if (failure === 'throw') throw Error('recipe failed')
      return false
    })
    apply(CLEAR)
    expect(h.calls).toEqual(['101:mica', 'attach:101'])
    expect(h.onError).toHaveBeenCalledOnce()
    h.addon.configure.mockClear()
    apply(CLEAR)
    expect(h.addon.configure.mock.calls).toEqual([[101n, CLEAR_APPEARANCE]])
    apply(CLEAR)
    expect(h.addon.configure).toHaveBeenCalledOnce()
    expect(h.calls).toEqual(['101:mica', 'attach:101'])
  })

  it('keeps glass notes independent through resize and disposal without focus hooks', () => {
    const h = harness()
    const first = h.window(101n)
    const second = h.window(202n)
    const applyFirst = h.controller.bind(first, WARM)
    h.controller.bind(second, CLEAR)
    first.emit('resize')
    first.emit('close', { preventDefault: vi.fn() })
    expect(h.addon.detach).not.toHaveBeenCalled()
    first.closePermanently()
    applyFirst(MICA)
    first.emit('resize')
    second.emit('resize')
    expect(h.addon.resize.mock.calls).toEqual([[101n], [202n]])
    expect(h.addon.detach.mock.calls).toEqual([[101n]])
    h.addon.configure.mockClear()
    expect(h.controller.setAppearance({ tintColor: '#FFFFFF', tintOpacity: 0.2, luminosityOpacity: 0.3, saturation: 0.4 })).toBe(true)
    expect(h.addon.configure).not.toHaveBeenCalled()
    expect(second.eventNames()).not.toContain('focus')
    expect(second.eventNames()).not.toContain('blur')
    second.closePermanently()
    expect(h.addon.detach.mock.calls).toEqual([[101n], [202n]])
    expect(h.addon.clear).not.toHaveBeenCalled()
  })

  it.each([WARM, CLEAR] as const)('does not load a wallpaper addon for %j outside Windows', (style) => {
    const h = harness('linux')
    h.controller.bind(h.window(), style)
    expect(h.load).not.toHaveBeenCalled()
    expect(h.calls).toEqual(['101:mica'])
  })

  it('applies the latest appearance to current and future Mica notes without focus or reattachment', () => {
    const h = harness()
    const first = h.window(101n)
    const classic = h.window(202n)
    h.controller.bind(first, MICA)
    const applyClassic = h.controller.bind(classic, CLASSIC)
    h.addon.configure.mockClear()
    const appearance = { tintColor: '#abcdef', tintOpacity: 0.3, luminosityOpacity: 0.7, saturation: 0.8 }
    expect(h.controller.setAppearance(appearance)).toBe(true)
    appearance.tintOpacity = 0.9
    const expected = { tintColor: '#ABCDEF', tintOpacity: 0.3, luminosityOpacity: 0.7, saturation: 0.8 }
    expect(h.addon.configure.mock.calls).toEqual([[101n, expected]])
    h.controller.bind(h.window(303n), MICA)
    applyClassic(MICA)
    expect(h.addon.configure.mock.calls.slice(-2)).toEqual([[303n, expected], [202n, expected]])
    expect(h.addon.attach).toHaveBeenCalledTimes(3)
    expect(h.addon.detach).not.toHaveBeenCalled()
    first.closePermanently()
    h.addon.configure.mockClear()
    h.controller.setAppearance({ ...expected, tintOpacity: 0.4 })
    expect(h.addon.configure.mock.calls.map(call => call[0])).toEqual([202n, 303n])
    expect(first.eventNames()).not.toContain('focus')
    expect(first.eventNames()).not.toContain('blur')
  })

  it('preserves a failed window material and continues updating peer notes', () => {
    const h = harness()
    h.controller.bind(h.window(101n), MICA)
    h.controller.bind(h.window(202n), MICA)
    h.addon.configure.mockImplementation((hwnd) => { if (hwnd === 101n) throw Error('effect unavailable'); return true })
    h.addon.configure.mockClear()
    expect(h.controller.setAppearance({ tintColor: '#ffffff', tintOpacity: 0.4, luminosityOpacity: 1, saturation: 1 })).toBe(false)
    expect(h.addon.configure.mock.calls.map(call => call[0])).toEqual([101n, 202n])
    expect(h.addon.detach).not.toHaveBeenCalled()
    expect(h.onError).toHaveBeenCalledOnce()
  })

  it('rejects invalid appearance before updating any native window', () => {
    const h = harness()
    h.controller.bind(h.window(), MICA)
    h.addon.configure.mockClear()
    expect(() => h.controller.setAppearance({ tintColor: '#fff', tintOpacity: 2, luminosityOpacity: 0, saturation: 1 })).toThrow()
    expect(h.addon.configure).not.toHaveBeenCalled()
  })

  it('loads lazily when classic changes to either native source and only on Windows', () => {
    const h = harness()
    const apply = h.controller.bind(h.window(), CLASSIC)
    expect(h.load).not.toHaveBeenCalled()
    apply(ACRYLIC)
    expect(h.load).toHaveBeenCalledOnce()
    expect(h.addon.attach).toHaveBeenLastCalledWith(101n, 'host')
    apply(MICA)
    expect(h.load).toHaveBeenCalledTimes(1)
    expect(h.addon.attach).toHaveBeenCalledWith(101n)
    const otherPlatform = harness('linux')
    otherPlatform.controller.bind(otherPlatform.window(), MICA)
    expect(otherPlatform.load).not.toHaveBeenCalled()
    expect(otherPlatform.calls).toEqual(['101:mica'])
  })

  it('preserves Electron translucency before attach and leaves a repeated preset untouched', () => {
    const h = harness()
    const apply = h.controller.bind(h.window(), CLASSIC)
    h.calls.length = 0
    apply(MICA)
    apply({ ...MICA })
    expect(h.calls).toEqual(['101:mica', 'attach:101'])
  })

  it('releases native resources before Acrylic/classic and can return to Mica', () => {
    const h = harness()
    const apply = h.controller.bind(h.window(), MICA)
    apply(ACRYLIC)
    apply(CLASSIC)
    apply(MICA)
    expect(h.calls).toEqual([
      '101:mica', 'attach:101', 'detach:101', '101:acrylic',
      'attach:101', 'detach:101', '101:none', '101:mica', 'attach:101',
    ])
    expect(h.load).toHaveBeenCalledTimes(1)
    expect(h.addon.clear).not.toHaveBeenCalled()
  })

  it('keeps two notes independent during resize, a prevented close, and destruction', () => {
    const h = harness()
    const first = h.window(101n)
    const second = h.window(202n)
    const applyFirst = h.controller.bind(first, MICA)
    h.controller.bind(second, MICA)
    first.emit('resize')
    first.emit('close', { preventDefault: vi.fn() })
    expect(h.addon.detach).not.toHaveBeenCalled()
    expect(first.eventNames()).not.toContain('focus')
    expect(first.eventNames()).not.toContain('blur')
    first.closePermanently()
    first.emit('resize')
    applyFirst(MICA)
    second.emit('resize')
    expect(h.addon.detach.mock.calls).toEqual([[101n]])
    expect(h.addon.resize.mock.calls).toEqual([[101n], [202n]])
    expect(h.addon.attach).toHaveBeenCalledTimes(2)
    second.closePermanently()
    expect(h.addon.detach.mock.calls).toEqual([[101n], [202n]])
    expect(h.addon.clear).not.toHaveBeenCalled()
  })

  it('falls back to DWM when loading fails, without repeatedly loading on each note', () => {
    const h = harness()
    h.load.mockImplementation(() => { throw new Error('missing addon') })
    h.controller.bind(h.window(), MICA)
    h.controller.bind(h.window(202n), MICA)
    expect(h.calls).toEqual(['101:mica', '202:mica'])
    expect(h.load).toHaveBeenCalledTimes(1)
    expect(h.addon.attach).not.toHaveBeenCalled()
    expect(h.onError).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['unsupported', MICA, 'mica'], ['throw', MICA, 'mica'],
    ['unsupported', ACRYLIC, 'acrylic'], ['throw', ACRYLIC, 'acrylic'],
  ] as const)('cleans a partial %s attach for %j before restoring its known %s bootstrap', (failure, style, material) => {
    const h = harness()
    h.addon.attach.mockImplementation((hwnd) => {
      h.calls.push(`attach:${hwnd}`)
      if (failure === 'throw') throw new Error('partial initialization')
      return false
    })
    const window = h.window()
    h.controller.bind(window, style)
    expect(h.calls).toEqual([`101:${material}`, 'attach:101', 'detach:101', `101:${material}`])
    window.emit('resize')
    window.closePermanently()
    expect(h.addon.detach).toHaveBeenCalledTimes(1)
    expect(h.addon.resize).not.toHaveBeenCalled()
  })

  it('restores DWM after a resize error without disabling the other note', () => {
    const h = harness()
    h.addon.resize.mockImplementation((hwnd) => {
      if (hwnd === 101n) throw new Error('resize failed')
    })
    const first = h.window()
    const second = h.window(202n)
    h.controller.bind(first, MICA)
    h.controller.bind(second, MICA)
    first.emit('resize')
    first.emit('resize')
    second.emit('resize')
    expect(h.addon.detach.mock.calls).toEqual([[101n]])
    expect(h.addon.resize.mock.calls).toEqual([[101n], [202n]])
    expect(h.calls.slice(-2)).toEqual(['detach:101', '101:mica'])
  })

  it('defers material replacement when detach throws and retains cleanup through closed', () => {
    const h = harness()
    h.addon.detach.mockImplementation(() => { throw new Error('detach failed') })
    const window = h.window()
    const apply = h.controller.bind(window, MICA)
    expect(() => apply(ACRYLIC)).not.toThrow()
    expect(window.setBackgroundMaterial).toHaveBeenLastCalledWith('mica')
    expect(() => window.closePermanently()).not.toThrow()
    expect(h.addon.detach).toHaveBeenCalledTimes(2)
  })

  it('restores DWM when native resize reports that its surface no longer exists', () => {
    const h = harness()
    h.addon.resize.mockReturnValue(false)
    const window = h.window()
    h.controller.bind(window, MICA)
    window.emit('resize')
    expect(h.addon.detach).toHaveBeenCalledWith(101n)
    expect(h.calls.slice(-2)).toEqual(['detach:101', '101:mica'])
    window.emit('resize')
    expect(h.addon.resize).toHaveBeenCalledTimes(1)
  })
})

describe('native surface fixed-path loader', () => {
  const options = {
    isPackaged: false,
    resourcesPath: path.resolve('packaged-resources'),
    buildDirectory: path.resolve('project/.vite/build'),
    arch: 'x64',
  }
  it('resolves development artifacts from the build directory and packaged artifacts outside asar', () => {
    expect(stickyNoteNativeSurfaceAddonPath(options))
      .toBe(path.resolve('project/native/sticky-note-surface/dist/x64/surface.node'))
    expect(stickyNoteNativeSurfaceAddonPath({ ...options, isPackaged: true }))
      .toBe(path.join(options.resourcesPath, 'sticky-note-native-surface/x64/surface.node'))
  })

  it('loads only that fixed path and rejects malformed native exports', () => {
    const addon = harness().addon
    const requireAddon = vi.fn(() => addon)
    expect(loadStickyNoteNativeSurface(options, requireAddon)).toBe(addon)
    expect(requireAddon.mock.calls).toEqual([[stickyNoteNativeSurfaceAddonPath(options)]])
    expect(() => loadStickyNoteNativeSurface(options, () => ({ attach: () => true })))
      .toThrow('Invalid sticky-note native surface addon')
    const { setGlassDecoration: _missing, ...outdated } = addon
    expect(() => loadStickyNoteNativeSurface(options, () => outdated)).toThrow('Invalid sticky-note native surface addon')
    expect(() => loadStickyNoteNativeSurface(options, () => ({ ...addon, setGlassDecoration: true })))
      .toThrow('Invalid sticky-note native surface addon')
    const { setAcrylicBorderHidden: _borderMissing, ...noBorder } = addon
    expect(() => loadStickyNoteNativeSurface(options, () => noBorder)).toThrow('Invalid sticky-note native surface addon')
  })
})
