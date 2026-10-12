import { copyStickyNoteMaterialEffects, parseStickyNoteMaterialEffects, type StickyNoteMaterialEffects } from '../shared/sticky-note-material-effects'

/** Retain the latest valid map across subscribers without sharing nested mutable recipes. */
export function createStickyNoteMaterialEffectsTransport(
  register: (listener: (payload: unknown) => void) => () => void,
) {
  let latest: StickyNoteMaterialEffects | null = null
  let disposed = false
  const listeners = new Set<(effects: StickyNoteMaterialEffects) => void>()
  const unregister = register(payload => {
    if (disposed) return
    const effects = parseStickyNoteMaterialEffects(payload)
    if (!effects) return
    latest = effects
    for (const listener of listeners) listener(copyStickyNoteMaterialEffects(effects))
  })
  return {
    subscribe(listener: (effects: StickyNoteMaterialEffects) => void): () => void {
      if (disposed) return () => {}
      listeners.add(listener)
      if (latest) listener(copyStickyNoteMaterialEffects(latest))
      return () => { listeners.delete(listener) }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      unregister()
      listeners.clear()
      latest = null
    },
  }
}
