import type { UpdateSnapshot } from '../../shared/app-update'
import type { UpdateAction } from '../../shared/update-transfer'
export interface UpdateWindowPort {
  isAlive(): boolean
  getState(): UpdateSnapshot
  about(input: { interactionId: string; open: boolean }): void
  openWebsite(): Promise<boolean>
  requestExit(): void
  protect(): void
  action?(action: UpdateAction): Promise<void>
  isWorkBlocked?(): boolean
  noteWorkStarted?(): void
}
