import { useEffect, useState, type CSSProperties } from 'react'
import { copyStickyNoteMaterialEffects, DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS } from '../../shared/sticky-note-material-effects'
import type { StickyNoteStyleReference } from '../../shared/sticky-note-preferences'

function deviceScale(): number {
  return Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
}

export function useStickyNoteMaterialEffects(style: StickyNoteStyleReference | undefined): CSSProperties {
  const [effects, setEffects] = useState(() => copyStickyNoteMaterialEffects(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS))
  const [dpr, setDpr] = useState(deviceScale)
  useEffect(() => window.arkdown.onStickyNoteMaterialEffectsChanged?.(setEffects), [])
  useEffect(() => {
    let media: MediaQueryList | undefined
    let current = deviceScale()
    const update = () => {
      const next = deviceScale()
      if (next === current && media) return
      current = next
      setDpr(next)
      media?.removeEventListener('change', update)
      media = window.matchMedia?.(`(resolution: ${next}dppx)`)
      media?.addEventListener('change', update)
    }
    update()
    window.addEventListener('resize', update)
    return () => { window.removeEventListener('resize', update); media?.removeEventListener('change', update) }
  }, [])
  const preset = style?.mode === 'material' ? style.materialPresetId : undefined
  const effect = preset && preset !== 'mica-light' ? effects[preset] : undefined
  const glow = effect && effect.innerGlowIntensity > 0 && effect.innerGlowRangePx > 0
    ? `inset 0 0 ${effect.innerGlowRangePx / dpr}px rgb(255 255 255 / ${effect.innerGlowIntensity})`
    : 'none'
  return { '--sticky-note-inner-glow': glow } as CSSProperties
}
