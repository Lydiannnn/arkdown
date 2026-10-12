import { randomUUID } from 'node:crypto'
import type { ClosePreparationAttempt } from '../../shared/close-preparation'
import { CloseProgressMonitor, type CloseOperationKind, type CloseProgressSnapshot, type CloseStage } from './close-progress-monitor'

type PreparationStage = 'prepare-editor' | 'await-user' | 'settle-document' | 'settle-preferences' | 'await-preferences'
export type CloseFailureCode = 'editor-unavailable' | 'document-save-failed' | 'draft-end-failed'
  | 'document-result-unknown' | 'preferences-save-failed' | 'owner-close-failed' | 'ipc-drain-failed'
  | 'window-settings-failed' | 'cleanup-failed' | 'native-close-failed' | 'restore-failed' | 'ai-drain-failed'
type PreparationFailure = 'editor-unavailable' | 'document-save-failed' | 'draft-end-failed'
  | 'document-result-unknown' | 'preferences-save-failed' | 'ai-drain-failed'
export type ClosePreparationResult = { status: 'ready' | 'cancelled' }
  | { status: 'failed'; code: Exclude<PreparationFailure, 'document-result-unknown'> }
  | { status: 'blocked'; code: PreparationFailure }
export interface ClosePreparationProgress {
  /** Main may drain AI before asking the renderer to prepare its document. */
  enter(stage: PreparationStage | 'quiesce-owner'): void
  heartbeat(): void
  unavailable(reason: 'renderer-process-gone' | 'renderer-destroyed' | 'transport-unavailable'): void
  beginAiDrain(): () => void
}
export interface CloseAttemptSnapshot {
  readonly attemptId: string
  readonly generation: number
  /** Explicit user requests to reveal this same attempt, not heartbeat progress. */
  readonly revealRevision: number
  readonly state: 'running' | 'restoring' | 'failed' | 'cancelled' | 'awaiting-native-close' | 'closed'
  readonly error: CloseFailureCode | null
  readonly rendererUnavailable: 'renderer-process-gone' | 'renderer-destroyed' | 'transport-unavailable' | null
  readonly canReturn: boolean
  readonly canRetry: boolean
  readonly progress: CloseProgressSnapshot
}
export interface CloseAttemptOptions {
  prepare(progress: ClosePreparationProgress, attempt: Readonly<ClosePreparationAttempt>): Promise<ClosePreparationResult>
  /** A ready result belongs to one renderer lifetime through finalization. */
  isPreparationCurrent?(attempt: Readonly<ClosePreparationAttempt>): boolean
  /** Resolve/reject only after ALL work owned by this phase has actually settled.
   * A timeout race or fail-fast aggregate is not a terminal cancellation result. */
  quiesceOwner(): Promise<void>
  drainIpc(): Promise<void>
  persistWindow(): Promise<void>
  finalize(): Promise<void>
  nativeClose(): void
  /** Before finalize only: restore reversible gates, never replay a user write. */
  restore(): Promise<void>
  notify(snapshot: CloseAttemptSnapshot): void
  createAttemptId?(): string
  now?(): number
}
interface Attempt {
  id: string
  generation: number
  revealRevision: number
  state: CloseAttemptSnapshot['state']
  error: CloseFailureCode | null
  rendererUnavailable: CloseAttemptSnapshot['rendererUnavailable']
  monitor: CloseProgressMonitor
  preparing: boolean
  irreversible: boolean
  recoverable: boolean
}

/** Main-owned orchestration for the production window close interceptor.
 * Time only changes feedback. It never releases a pending operation or grants
 * retry/return authority. Renderer progress must be validated by its IPC owner. */
export class CloseAttemptCoordinator {
  private current: Attempt | null = null
  private generation = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false
  private notifying = false
  private nativeCalling = false

  constructor(private readonly options: CloseAttemptOptions) {}

  snapshot(): CloseAttemptSnapshot | null {
    const attempt = this.current
    if (!attempt) return null
    const canReturn = !this.disposed && attempt.state === 'failed' && attempt.recoverable && !attempt.irreversible
    const nativeRetry = !this.disposed && !this.nativeCalling && attempt.irreversible && (attempt.state === 'awaiting-native-close'
      || attempt.state === 'failed' && attempt.error === 'native-close-failed')
    return Object.freeze({ attemptId: attempt.id, generation: attempt.generation, revealRevision: attempt.revealRevision,
      state: attempt.state, error: attempt.error, rendererUnavailable: attempt.rendererUnavailable, canReturn, canRetry: canReturn || nativeRetry,
      progress: attempt.monitor.snapshot() })
  }

  requestClose(): void {
    if (this.disposed || this.notifying || this.current?.state === 'closed') return
    if (this.current && this.current.state !== 'cancelled') {
      this.current.revealRevision = Math.min(Number.MAX_SAFE_INTEGER, this.current.revealRevision + 1)
      this.current.monitor.reveal()
      this.notify()
      return
    }
    this.start()
  }

  async returnToEditor(): Promise<boolean> {
    const attempt = this.current
    if (this.notifying || !attempt || !this.snapshot()?.canReturn) return false
    return this.restore(attempt)
  }

  async retry(): Promise<boolean> {
    const attempt = this.current
    if (this.notifying || !attempt || !this.snapshot()?.canRetry) return false
    if (attempt.irreversible) {
      this.nativeClose(attempt)
      return true
    }
    if (!await this.restore(attempt)) return false
    if (!this.owns(attempt)) return false
    this.start()
    return true
  }

  /** Called by the owning native window's actual closed event, not a timeout. */
  closed(): void {
    if (!this.current) return
    this.current.preparing = false
    this.current.state = 'closed'
    this.current.monitor.finish()
    this.stopTimer()
    this.notify()
  }

  /** Detach observers on real window disposal. Does not cancel or bless writes. */
  dispose(): void {
    this.disposed = true
    this.stopTimer()
  }

  private owns(attempt: Attempt): boolean {
    return !this.disposed && this.current === attempt && attempt.state !== 'closed'
  }

  private notify(): void {
    if (this.disposed || this.notifying) return
    const snapshot = this.snapshot()
    if (snapshot) {
      this.notifying = true
      try { this.options.notify(snapshot) } catch { /* Diagnostics cannot alter close authority. */ }
      finally { this.notifying = false }
    }
  }

  private stopTimer(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  private startTimer(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => this.notify(), 250)
    this.timer.unref?.()
  }

  private start(): void {
    this.stopTimer()
    const attempt: Attempt = {
      id: (this.options.createAttemptId ?? randomUUID)(), generation: ++this.generation,
      revealRevision: 0,
      state: 'running', error: null, monitor: new CloseProgressMonitor(this.options.now),
      preparing: true, irreversible: false, recoverable: false, rendererUnavailable: null,
    }
    this.current = attempt
    this.startTimer()
    this.notify()
    void this.run(attempt)
  }

  private async run(attempt: Attempt): Promise<void> {
    if (!this.owns(attempt)) return
    let failure: CloseFailureCode = 'editor-unavailable'
    const finishEditor = attempt.monitor.beginOperation('editor')
    try {
      let preparation: ClosePreparationResult
      try {
        preparation = await this.options.prepare({
          enter: stage => {
            if (this.owns(attempt) && attempt.preparing) {
              attempt.monitor.enter(stage)
              this.notify()
            }
          },
          heartbeat: () => {
            if (this.owns(attempt) && attempt.preparing) attempt.monitor.heartbeat()
          },
          unavailable: reason => {
            if (this.owns(attempt) && attempt.preparing) {
              attempt.rendererUnavailable = reason
              attempt.monitor.reveal()
              this.notify()
            }
          },
          beginAiDrain: () => this.owns(attempt) && attempt.preparing
            ? attempt.monitor.beginOperation('ai') : () => undefined,
        }, Object.freeze({ attemptId: attempt.id, generation: attempt.generation }))
      } finally { finishEditor(); attempt.preparing = false }
      if (!this.owns(attempt)) return
      if (preparation.status === 'cancelled') { await this.restore(attempt); return }
      if (preparation.status === 'failed' || preparation.status === 'blocked') {
        const unknown = preparation.code === 'document-result-unknown'
        this.fail(attempt, preparation.code, !unknown && preparation.status === 'failed')
        return
      }
      for (const [stage, kind, operation, code] of [
        ['quiesce-owner', 'owner', this.options.quiesceOwner, 'owner-close-failed'],
        ['drain-ipc', 'ipc', this.options.drainIpc, 'ipc-drain-failed'],
        ['persist-window', 'window-settings', this.options.persistWindow, 'window-settings-failed'],
        ['finalize', 'cleanup', this.options.finalize, 'cleanup-failed'],
      ] as const satisfies readonly [CloseStage, CloseOperationKind, () => Promise<void>, CloseFailureCode][]) {
        if (!this.owns(attempt)) return
        if (!this.checkPreparation(attempt)) return
        failure = code
        if (stage === 'finalize') attempt.irreversible = true
        attempt.monitor.enter(stage)
        const finish = attempt.monitor.beginOperation(kind)
        this.notify()
        if (!this.owns(attempt)) { finish(); return }
        if (!this.checkPreparation(attempt)) { finish(); return }
        try { await operation() } finally { finish() }
      }
      if (this.owns(attempt)) this.nativeClose(attempt)
    } catch {
      if (this.owns(attempt)) this.fail(attempt, failure, !attempt.irreversible)
    }
  }

  private fail(attempt: Attempt, error: CloseFailureCode, recoverable: boolean): void {
    attempt.state = 'failed'
    attempt.error = error
    attempt.recoverable = recoverable
    this.stopTimer()
    this.notify()
  }

  private checkPreparation(attempt: Attempt): boolean {
    try {
      if (!this.options.isPreparationCurrent || this.options.isPreparationCurrent({ attemptId: attempt.id, generation: attempt.generation })) return true
    } catch { /* An unreadable lifetime cannot authorize further cleanup. */ }
    this.fail(attempt, 'document-result-unknown', false)
    return false
  }

  private nativeClose(attempt: Attempt): void {
    if (!this.owns(attempt) || this.nativeCalling) return
    if (!this.checkPreparation(attempt)) return
    this.nativeCalling = true
    attempt.state = 'awaiting-native-close'
    attempt.error = null
    attempt.monitor.enter('native-close')
    this.startTimer()
    this.notify()
    try { if (this.owns(attempt)) this.options.nativeClose() } catch {
      if (this.owns(attempt)) this.fail(attempt, 'native-close-failed', false)
    } finally {
      this.nativeCalling = false
      if (this.owns(attempt)) this.notify()
    }
  }

  private async restore(attempt: Attempt): Promise<boolean> {
    if (!this.owns(attempt)) return false
    attempt.state = 'restoring'
    attempt.recoverable = false
    attempt.monitor.enter('restore-editor')
    const finish = attempt.monitor.beginOperation('restore')
    this.startTimer()
    this.notify()
    try {
      if (!this.owns(attempt)) return false
      try { await this.options.restore() } finally { finish() }
      if (!this.owns(attempt)) return false
      attempt.state = 'cancelled'
      attempt.error = null
      attempt.monitor.finish()
      this.stopTimer()
      this.notify()
      return true
    } catch {
      if (this.owns(attempt)) this.fail(attempt, 'restore-failed', false)
      return false
    } finally { finish() }
  }
}
