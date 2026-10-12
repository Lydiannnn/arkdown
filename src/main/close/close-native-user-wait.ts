import type { ClosePreparationStage } from '../../shared/close-preparation'

/** Observes actual OS picker lifetime without masking document I/O as a human wait. */
export function createCloseNativeUserWait() {
  let pending = 0
  let observer: { enter(stage: ClosePreparationStage): void; stage: ClosePreparationStage } | null = null
  const publish = () => {
    try { observer?.enter(pending > 0 ? 'await-user' : observer.stage) }
    catch { /* Reporting cannot cancel a user's picker or change its result. */ }
  }
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      pending++; publish()
      try { return await operation() }
      finally { pending--; publish() }
    },
    observe(enter: (stage: ClosePreparationStage) => void) {
      const owned = { enter, stage: 'prepare-editor' as ClosePreparationStage }
      observer = owned; publish()
      return {
        enter(stage: ClosePreparationStage) { if (observer === owned) { owned.stage = stage; publish() } },
        dispose() { if (observer === owned) observer = null },
      }
    },
  }
}
