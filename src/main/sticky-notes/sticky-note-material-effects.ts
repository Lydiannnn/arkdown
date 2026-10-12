import type { EventEmitter } from 'node:events'
import {
  copyStickyNoteMaterialEffects,
  DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS,
  parseStickyNoteMaterialEffects,
  STICKY_NOTE_MATERIAL_EFFECTS_CHANNEL,
  type StickyNoteMaterialEffects,
} from '../../shared/sticky-note-material-effects'

interface EffectsWindow extends EventEmitter {
  isDestroyed(): boolean
  webContents: EventEmitter & {
    isDestroyed(): boolean
    send(channel: string, effects: StickyNoteMaterialEffects): void
  }
}

/** Effective preview state, shared by owned note windows rather than read from saved preferences. */
export function createStickyNoteMaterialEffectsController(options: { onError?(error: unknown): void } = {}) {
  let latest = copyStickyNoteMaterialEffects(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS)
  const publishers = new Set<() => boolean>()
  const report = options.onError ?? (() => undefined)

  function setEffects(input: StickyNoteMaterialEffects): boolean {
    const parsed = parseStickyNoteMaterialEffects(input)
    if (!parsed) throw new Error('Invalid sticky-note material effects')
    latest = parsed
    let complete = true
    // Repeated values intentionally retry failed send operations. A failed
    // peer must not stop another note from seeing the current effective draft.
    for (const publish of publishers) if (!publish()) complete = false
    return complete
  }

  function bind(window: EffectsWindow): void {
    const webContents = window.webContents
    let loaded = false
    let disposed = false
    const publish = (): boolean => {
      if (disposed || !loaded || window.isDestroyed() || webContents.isDestroyed()) return true
      try {
        webContents.send(STICKY_NOTE_MATERIAL_EFFECTS_CHANNEL, copyStickyNoteMaterialEffects(latest))
        return true
      } catch (error) {
        report(error)
        return false
      }
    }
    const onLoading = (): void => { loaded = false }
    const onLoaded = (): void => { loaded = true; publish() }
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      publishers.delete(publish)
      window.removeListener('closed', dispose)
      webContents.removeListener('did-start-loading', onLoading)
      webContents.removeListener('render-process-gone', onLoading)
      webContents.removeListener('did-finish-load', onLoaded)
      webContents.removeListener('destroyed', dispose)
    }
    publishers.add(publish)
    window.on('closed', dispose)
    webContents.on('did-start-loading', onLoading)
    webContents.on('render-process-gone', onLoading)
    webContents.on('did-finish-load', onLoaded)
    webContents.on('destroyed', dispose)
  }

  return { bind, setEffects }
}
