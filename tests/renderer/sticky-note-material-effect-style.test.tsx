import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useStickyNoteMaterialEffects } from '../../src/renderer/sticky-notes/use-sticky-note-material-effects'
import { copyStickyNoteMaterialEffects, DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS, type StickyNoteMaterialEffects } from '../../src/shared/sticky-note-material-effects'

afterEach(() => vi.restoreAllMocks())

it('replays the current effects without focus and recalculates physical glow on DPI changes', () => {
  let update!: (effects: StickyNoteMaterialEffects) => void
  let resolutionChange!: () => void
  const removed = vi.fn()
  const unsubscribe = vi.fn()
  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(1.5)
  vi.stubGlobal('matchMedia', vi.fn(() => ({ addEventListener: (_: string, listener: () => void) => { resolutionChange = listener }, removeEventListener: removed })))
  const effects = copyStickyNoteMaterialEffects(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS)
  window.arkdown = { onStickyNoteMaterialEffectsChanged: (listener: typeof update) => { update = listener; listener(effects); return unsubscribe } } as unknown as typeof window.arkdown
  const hook = renderHook(() => useStickyNoteMaterialEffects({ mode: 'material', materialPresetId: 'flowing-glass' }))
  expect(hook.result.current).toEqual({ '--sticky-note-inner-glow': 'inset 0 0 20px rgb(255 255 255 / 0.7)' })
  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2)
  act(() => resolutionChange())
  expect(hook.result.current).toEqual({ '--sticky-note-inner-glow': 'inset 0 0 15px rgb(255 255 255 / 0.7)' })
  effects['flowing-glass'].innerGlowIntensity = 0
  act(() => update(copyStickyNoteMaterialEffects(effects)))
  expect(hook.result.current).toEqual({ '--sticky-note-inner-glow': 'none' })
  hook.unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(removed).toHaveBeenCalled()
  vi.unstubAllGlobals()
})

it('removes glow for Mica and ordinary colors when switching materials', () => {
  window.arkdown = {} as typeof window.arkdown
  const hook = renderHook(({ mica }) => useStickyNoteMaterialEffects(mica ? { mode: 'material', materialPresetId: 'mica-light' } : undefined), { initialProps: { mica: true } })
  expect(hook.result.current).toEqual({ '--sticky-note-inner-glow': 'none' })
  hook.rerender({ mica: false })
  expect(hook.result.current).toEqual({ '--sticky-note-inner-glow': 'none' })
})
