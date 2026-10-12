import { CloseAttemptCoordinator, type CloseAttemptSnapshot } from '../close/close-attempt-coordinator'
import type { createStructuredRendererCloseRequester } from '../renderer-close-requester'

export interface ScreenshotResultCloseLifecycle { requestClose(): Promise<boolean> }
interface ResultCloseWindow {
  on(event: 'close', listener: (event: { defaultPrevented?: boolean; preventDefault(): void }) => void): unknown
  once(event: 'closed', listener: () => void): unknown
  isDestroyed(): boolean
  destroy(): void
  focus(): void
}

/** Reuses the document close coordinator for a result window's settings-only preparation.
 * A failed known draft can return to editing; an unknown outcome never grants teardown. */
export function createScreenshotResultCloseLifecycle(options: {
  window: ResultCloseWindow
  requester: ReturnType<typeof createStructuredRendererCloseRequester>
  finalize(): Promise<void>
  feedback: { bind(controller: CloseAttemptCoordinator): void; notify(snapshot: CloseAttemptSnapshot): void; dispose(): void }
}): ScreenshotResultCloseLifecycle {
  let ended = false
  let restoringRetry: string | undefined
  let pending: { promise: Promise<boolean>; resolve(value: boolean): void } | undefined
  const settle = (value: boolean) => { const current = pending; pending = undefined; current?.resolve(value) }
  const coordinator = new CloseAttemptCoordinator({
    prepare: (progress, attempt) => options.requester.prepare(attempt, progress),
    isPreparationCurrent: attempt => options.requester.isCurrent(attempt),
    quiesceOwner: async () => {}, drainIpc: async () => {}, persistWindow: async () => {},
    finalize: options.finalize,
    nativeClose: () => options.window.destroy(),
    restore: async () => { options.window.focus() },
    notify: snapshot => {
      options.feedback.notify(snapshot)
      if (snapshot.state === 'closed') settle(true)
      else if (snapshot.state === 'cancelled' && snapshot.attemptId !== restoringRetry
        || snapshot.state === 'failed' && snapshot.canReturn) settle(false)
    },
  })
  options.feedback.bind(coordinator)
  const requestClose = (): Promise<boolean> => {
    if (ended || options.window.isDestroyed()) return Promise.resolve(true)
    if (pending) { coordinator.requestClose(); return pending.promise }
    let resolve!: (value: boolean) => void
    const promise = new Promise<boolean>(yes => { resolve = yes })
    pending = { promise, resolve }
    if (coordinator.snapshot()?.canRetry) {
      // Only the previous attempt's restoration is intermediate. Keep the same
      // waiter installed so native/parent close reentry cannot start another one.
      const previousAttempt = coordinator.snapshot()!.attemptId
      restoringRetry = previousAttempt
      void coordinator.retry().then(started => {
        if (restoringRetry === previousAttempt) restoringRetry = undefined
        if (ended) settle(true)
        else if (!started) settle(false)
      }, () => { restoringRetry = undefined; settle(false) })
    } else coordinator.requestClose()
    return promise
  }
  options.window.on('close', event => {
    if (event.defaultPrevented || ended) return
    event.preventDefault()
    void requestClose()
  })
  options.window.once('closed', () => {
    ended = true
    coordinator.closed(); settle(true)
    coordinator.dispose(); options.requester.dispose(); options.feedback.dispose()
  })
  return { requestClose }
}
