import type { WindowStateSnapshot } from '../../shared/contracts'

export type WindowStateSnapshotTransition =
  | 'initial'
  | 'entered-fullscreen'
  | 'exited-fullscreen'
  | 'updated'

export interface AcceptedWindowStateSnapshot {
  snapshot: WindowStateSnapshot
  transition: WindowStateSnapshotTransition
}

export class WindowStateSnapshotController {
  private disposed = false
  private latest: WindowStateSnapshot | null = null

  constructor(
    private readonly onAccepted: (acceptance: AcceptedWindowStateSnapshot) => void,
  ) {}

  accept(snapshot: WindowStateSnapshot): boolean {
    if (this.disposed || snapshot.revision <= (this.latest?.revision ?? -1)) return false

    const previous = this.latest
    this.latest = snapshot
    const transition: WindowStateSnapshotTransition = previous === null
      ? 'initial'
      : previous.fullscreen === snapshot.fullscreen
        ? 'updated'
        : snapshot.fullscreen
          ? 'entered-fullscreen'
          : 'exited-fullscreen'
    this.onAccepted({ snapshot, transition })
    return true
  }

  dispose(): void {
    this.disposed = true
  }
}
