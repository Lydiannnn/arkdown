export type CloseStage = 'prepare-editor' | 'await-user' | 'await-preferences' | 'settle-document' | 'settle-preferences' | 'quiesce-owner' | 'drain-ipc' | 'persist-window' | 'finalize' | 'native-close' | 'restore-editor'
export type CloseOperationKind = 'editor' | 'document' | 'draft' | 'preferences' | 'owner' | 'ai' | 'ipc' | 'window-settings' | 'cleanup' | 'restore'
export interface CloseProgressSnapshot {
  readonly stage: CloseStage
  readonly elapsedMs: number
  readonly stageElapsedMs: number
  readonly idleMs: number
  readonly rendererAliveAt: number | null
  readonly pending: Readonly<Partial<Record<CloseOperationKind, number>>>
  readonly feedback: 'hidden' | 'progress' | 'await-user' | 'no-progress' | 'long-wait'
}
export class CloseProgressMonitor {
  private readonly startedAt: number
  private stageStartedAt: number
  private lastProgressAt: number
  private observedAt: number
  private endedAt: number | null = null
  private rendererAliveAt: number | null = null
  private stage: CloseStage = 'prepare-editor'
  private revealed = false
  private feedbackAfter: number
  private readonly pending: Partial<Record<CloseOperationKind, number>> = {}

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAt = this.stageStartedAt = this.lastProgressAt = this.observedAt = now()
    this.feedbackAfter = this.startedAt + 500
  }

  private time(): number {
    if (this.endedAt !== null) return this.endedAt
    this.observedAt = Math.max(this.observedAt, this.now())
    return this.observedAt
  }

  // Only an owning main-process coordinator may call these methods. This monitor
  // observes progress; it never grants close/cancel/retry authority or times out work.
  enter(stage: CloseStage): void {
    if (this.endedAt !== null || stage === this.stage) return
    // Time spent choosing Save/Cancel is not machine work. Give the subsequent
    // operation a short presentation grace period, including cancel restoration.
    if (this.stage === 'await-user' || this.stage === 'await-preferences') this.feedbackAfter = this.time() + 500
    this.stage = stage
    this.stageStartedAt = this.lastProgressAt = this.time()
  }

  heartbeat(): void {
    if (this.endedAt === null) this.rendererAliveAt = this.time()
  }

  /** The returned callback belongs to one real operation's terminal promise.
   * Starting work, ticks and repeated terminal notifications are not progress. */
  beginOperation(kind: CloseOperationKind): () => void {
    if (this.endedAt !== null) return () => undefined
    this.pending[kind] = (this.pending[kind] ?? 0) + 1
    let completed = false
    return () => {
      if (completed || this.endedAt !== null) return
      completed = true
      const remaining = this.pending[kind]! - 1
      if (remaining > 0) this.pending[kind] = remaining
      else delete this.pending[kind]
      this.lastProgressAt = this.time()
    }
  }

  reveal(): void { if (this.endedAt === null) this.revealed = true }
  finish(): void { if (this.endedAt === null) this.endedAt = this.time() }

  snapshot(): CloseProgressSnapshot {
    const now = this.time()
    const elapsedMs = now - this.startedAt
    const stageElapsedMs = now - this.stageStartedAt
    const idleMs = now - this.lastProgressAt
    const feedback = this.endedAt !== null || (!this.revealed && now < this.feedbackAfter) ? 'hidden'
      : this.stage === 'await-user' || this.stage === 'await-preferences' ? 'await-user'
        : stageElapsedMs >= 30_000 ? 'long-wait' : idleMs >= 10_000 ? 'no-progress' : 'progress'
    return Object.freeze({ stage: this.stage, elapsedMs, stageElapsedMs, idleMs,
      rendererAliveAt: this.rendererAliveAt, pending: Object.freeze({ ...this.pending }), feedback })
  }
}
