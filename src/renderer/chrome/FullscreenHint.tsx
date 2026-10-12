import { useEffect, useState, type CSSProperties } from 'react'
import './fullscreen-hint.css'

export interface FullscreenHintProps {
  visible: boolean
  activationKey?: number
}

type HintPhase = 'hidden' | 'visible' | 'fading'

export function FullscreenHint({ visible, activationKey = 0 }: FullscreenHintProps) {
  const [phase, setPhase] = useState<HintPhase>(visible ? 'visible' : 'hidden')
  const reducedMotion = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  useEffect(() => {
    if (!visible) {
      setPhase('hidden')
      return
    }

    setPhase('visible')
    const fadeTimer = window.setTimeout(() => setPhase('fading'), 3_000)
    const unmountTimer = window.setTimeout(() => setPhase('hidden'), 4_000)
    return () => {
      window.clearTimeout(fadeTimer)
      window.clearTimeout(unmountTimer)
    }
  }, [activationKey, visible])

  if (!visible || phase === 'hidden') return null
  return (
    <div
      aria-atomic="true"
      aria-live="polite"
      className={`fullscreen-hint${phase === 'fading' ? ' is-fading' : ''}`}
      role="status"
      style={{
        pointerEvents: 'none',
        ...(reducedMotion ? { transition: 'none' } : {}),
      } as CSSProperties}
    >
      按下 Esc 以退出全屏
    </div>
  )
}
