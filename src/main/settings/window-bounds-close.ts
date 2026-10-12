import { CloseAttemptCoordinator, type CloseAttemptOptions, type CloseAttemptSnapshot } from '../close/close-attempt-coordinator'
import type { WindowBounds } from './settings-store'

interface CloseEvent {
  readonly defaultPrevented?: boolean
  preventDefault(): void
}
interface WindowWithBounds {
  on(event: 'close', listener: (event: CloseEvent) => void): unknown
  getSize(): number[]
  getPosition(): number[]
  focus?(): void
  close(): void
}
export interface CloseDrainGate {
  pauseAndDrain(): Promise<void>
  resume(beforeAdmission?: () => void | Promise<void>): void | Promise<void>
}
export interface WindowCloseOptions {
  /** This must use the owning settings authority, never a cached whole-file save. */
  saveWindowBounds(bounds: WindowBounds): Promise<void>
  prepareRendererClose: CloseAttemptOptions['prepare']
  isPreparationCurrent?: CloseAttemptOptions['isPreparationCurrent']
  normalizeBounds?(bounds: WindowBounds): WindowBounds | undefined
  closeGate?: CloseDrainGate
  closeOwnedResources?(): Promise<void>
  abortOwnedResourcesClose?(): void | Promise<void>
  finalizeClose?(): Promise<void>
  restorePreparation?(): void | Promise<void>
  reportError(error: unknown): void
  notify?(snapshot: CloseAttemptSnapshot): void
}

/** One coordinator owns every native/menu/title-bar close attempt for this window.
 * The window's actual closed listener must call closed()/dispose() on the result. */
export function installWindowBoundsSaveOnClose(window: WindowWithBounds, options: WindowCloseOptions): CloseAttemptCoordinator {
  let nativeCalling = false
  let gatePaused = false
  let ownerStarted = false
  let reported: string | undefined
  const coordinator = new CloseAttemptCoordinator({
    prepare: options.prepareRendererClose,
    isPreparationCurrent: options.isPreparationCurrent,
    quiesceOwner: async () => {
      ownerStarted = true
      await options.closeOwnedResources?.()
    },
    drainIpc: async () => {
      gatePaused = true
      await options.closeGate?.pauseAndDrain()
    },
    persistWindow: async () => {
      const [width, height] = window.getSize()
      const [x, y] = window.getPosition()
      const raw = { width, height, x, y }
      const bounds = options.normalizeBounds ? options.normalizeBounds(raw) : raw
      if (!bounds) throw new Error('window-settings-failed')
      await options.saveWindowBounds(bounds)
    },
    finalize: async () => { await options.finalizeClose?.() },
    nativeClose: () => {
      nativeCalling = true
      try { window.close() } finally { nativeCalling = false }
    },
    restore: async () => {
      // Restore admission last. A failed restoration must not reopen IPC while
      // an owner or AI gate is still broken, nor claim editor recovery succeeded.
      if (ownerStarted) { await options.abortOwnedResourcesClose?.(); ownerStarted = false }
      if (gatePaused && options.closeGate) {
        await options.closeGate.resume(options.restorePreparation)
        gatePaused = false
      } else await options.restorePreparation?.()
      window.focus?.()
    },
    notify: snapshot => {
      if (snapshot.error) {
        const key = `${snapshot.attemptId}:${snapshot.error}`
        if (reported !== key) {
          reported = key
          try { options.reportError(new Error(snapshot.error)) } catch { /* diagnostics have no close authority */ }
        }
      }
      options.notify?.(snapshot)
    },
  })
  window.on('close', event => {
    if (event.defaultPrevented || nativeCalling) return
    event.preventDefault()
    coordinator.requestClose()
  })
  return coordinator
}
