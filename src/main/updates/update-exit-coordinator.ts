import type { CloseAttemptSnapshot } from '../close/close-attempt-coordinator'

interface UpdateExitDependencies {
  getWindows(): readonly { id: number; requestClose(): void }[]
  quitApp(): void
  notify(state: 'idle' | 'closing' | 'protecting'): void
}
/** No write, destroy, timer-based bypass, or Arknote process capability. */
export class UpdateExitCoordinator {
  private active = false
  private pending?: number
  constructor(private readonly deps: UpdateExitDependencies) {}
  requestExit(): void {
    if (this.active) return
    this.active = true; this.deps.notify('closing'); this.next()
  }
  onCloseState(ownerId: number, snapshot: Pick<CloseAttemptSnapshot, 'state'>): void {
    if (!this.active || ownerId !== this.pending) return
    if (snapshot.state === 'failed' || snapshot.state === 'cancelled') this.protect()
  }
  onWindowClosed(ownerId: number): void {
    if (!this.active || ownerId !== this.pending) return
    this.pending = undefined; this.next()
  }
  private next(): void {
    if (!this.active || this.pending !== undefined) return
    const next = this.deps.getWindows()[0]
    if (!next) { this.active = false; this.deps.quitApp(); return }
    this.pending = next.id
    try { next.requestClose() } catch { this.protect() }
  }
  private protect(): void { this.active = false; this.pending = undefined; this.deps.notify('protecting') }
}
