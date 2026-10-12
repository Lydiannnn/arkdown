import { useSyncExternalStore } from 'react'
import { getModelCapabilityRulesRevision, setModelCapabilityRules, subscribeModelCapabilityRules } from '../../shared/model-capability-rules'
import type { ArkdownApi } from '../../shared/contracts'

export function useModelRulesRevision(): number {
  return useSyncExternalStore(subscribeModelCapabilityRules, getModelCapabilityRulesRevision)
}
const pendingSessions = new Set<symbol>()
const readinessListeners = new Set<() => void>()
export function areModelRulesReady(): boolean { return pendingSessions.size === 0 }
function notifyReadiness() { for (const listener of readinessListeners) listener() }
function subscribeReadiness(listener: () => void) {
  readinessListeners.add(listener)
  return () => { readinessListeners.delete(listener) }
}
export function useModelRulesReady(): boolean {
  return useSyncExternalStore(subscribeReadiness, areModelRulesReady)
}
/** Subscribe before reading, so an import concurrent with initial loading cannot be overwritten. */
export function startModelRulesInitialization(api: Pick<ArkdownApi, 'getModelCapabilityRules' | 'onModelCapabilityRulesChanged'>): { ready: Promise<void>; dispose(): void } {
  if (!api.getModelCapabilityRules) return { ready: Promise.resolve(), dispose: () => undefined }
  const readRules = api.getModelCapabilityRules.bind(api)
  const token = Symbol('model-rules-initialization')
  pendingSessions.add(token)
  notifyReadiness()
  let changed = false
  let disposed = false
  let unsubscribe: (() => void) | undefined
  const settle = () => { if (pendingSessions.delete(token)) notifyReadiness() }
  const ready = (async () => {
    try {
      unsubscribe = api.onModelCapabilityRulesChanged?.(state => {
        if (disposed) return
        changed = true
        setModelCapabilityRules(state.rules)
        settle()
      })
      const result = await readRules()
      if (!disposed && !changed && result.ok) setModelCapabilityRules(result.value.rules)
    } catch { /* IPC failure keeps bundled rules available. */ }
    finally { settle() }
  })()
  return { ready, dispose() {
    if (disposed) return
    disposed = true
    unsubscribe?.()
    settle()
  } }
}

export async function initializeModelRules(api: Pick<ArkdownApi, 'getModelCapabilityRules' | 'onModelCapabilityRulesChanged'>): Promise<() => void> {
  const session = startModelRulesInitialization(api)
  await session.ready
  return session.dispose
}
