import type { ArkdownApi } from '../../shared/contracts'
import type { ModelPreferenceDraft } from './model-preference-draft'

/** Separate application processes share a settings store, not a renderer event bus.
 * Observe confirmed values periodically and on activation. Never rebase a dirty form,
 * acknowledge failed writes, replay mutations, or block inputs during a display read. */
export function startModelPreferenceSync(draft: ModelPreferenceDraft,
  api: Pick<ArkdownApi, 'getModelSettingsSnapshot'>,
  events: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>): () => void {
  let active = true, reading = false
  const refresh = () => {
    if (!active || reading) return
    reading = true
    void Promise.resolve().then(() => api.getModelSettingsSnapshot()).then(result => {
      if (active && result.ok) draft.accept(result.value)
    }).catch(() => { /* Retain the last observation; a read is never a save acknowledgement. */ })
      .finally(() => { reading = false })
  }
  events.addEventListener('focus', refresh)
  const timer = setInterval(refresh, 2000)
  refresh()
  return () => { active = false; clearInterval(timer); events.removeEventListener('focus', refresh) }
}
