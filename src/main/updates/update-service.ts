import { APP_UPDATE_WEBSITE, type UpdateEventType, type UpdateSnapshot } from '../../shared/app-update'
import type { UpdateDecision } from './update-protocol'
import type { UpdateArtifact } from './update-protocol'
import type { DownloadProgress } from './update-download'
import type { UpdateAction, UpdateTransferSnapshot } from '../../shared/update-transfer'
import { UpdatePackageInvalidError } from './update-errors'

interface UpdateServiceDependencies {
  currentVersion: string
  check(signal: AbortSignal): Promise<UpdateDecision | undefined>
  sendEvent(type: UpdateEventType): void
  openWebsite(url: string): Promise<void>
  requestExit(): void
  readSkippedVersion?(): Promise<string | null>
  skipVersion?(version: string): Promise<void>
  getVerified?(artifact: UpdateArtifact): Promise<string | undefined>
  download?(artifact: UpdateArtifact, progress: (value: DownloadProgress) => void): Promise<string>
  cancelDownload?(): Promise<void>
  requestInstall?(artifact: UpdateArtifact, verifiedFile: string): Promise<void>
}
type Listener = (snapshot: UpdateSnapshot) => void
export class AppUpdateService {
  private state: UpdateSnapshot
  private readonly abort = new AbortController()
  private timer?: ReturnType<typeof setTimeout>
  private scheduled = false
  private websiteOpening?: Promise<boolean>
  private owner?: number
  private readonly windows = new Set<number>()
  private readonly listeners = new Map<number, Set<Listener>>()
  private artifact?: UpdateArtifact
  private verifiedFile?: string
  private workStarted = false
  private downloadGeneration = 0
  private dialogOwner?: number
  private readonly transfer: UpdateTransferSnapshot = { phase: 'idle', received: 0, total: 0, error: null, dialog: 'hidden', forced: false }
  constructor(private readonly deps: UpdateServiceDependencies) {
    this.state = { revision: 0, status: 'idle', currentVersion: deps.currentVersion, candidate: null, bubbleVisible: false, requiredPrompt: 'hidden' }
  }
  onMainWindowCreated(ownerId: number): void {
    if (this.abort.signal.aborted) return
    this.windows.add(ownerId)
    if (this.windows.size > 1) this.noteWorkStarted(ownerId)
    if (this.owner === undefined && !this.scheduled) this.owner = ownerId
  }
  onMainWindowReady(ownerId: number): void {
    if (this.abort.signal.aborted) return
    this.onMainWindowCreated(ownerId)
    if (this.scheduled) return
    this.scheduled = true
    this.timer = setTimeout(() => { this.timer = undefined; void this.check() }, 5000); this.timer.unref?.()
  }
  getSnapshot(ownerId: number): UpdateSnapshot {
    return structuredClone({ ...this.state, requiredPrompt: this.owner === ownerId ? this.state.requiredPrompt : 'hidden',
      transfer: { ...this.transfer, dialog: this.dialogOwner === ownerId ? this.transfer.dialog : 'hidden' } })
  }
  subscribe(ownerId: number, listener: Listener): () => void {
    if (this.abort.signal.aborted) return () => {}
    let set = this.listeners.get(ownerId); if (!set) this.listeners.set(ownerId, set = new Set())
    set.add(listener); return () => { set.delete(listener); if (!set.size) this.listeners.delete(ownerId) }
  }
  private async check(): Promise<void> {
    this.state.status = 'checking'; this.publish()
    let decision: UpdateDecision | undefined
    try { decision = await this.deps.check(this.abort.signal) } catch { /* Offline/corrupt identity never blocks startup. */ }
    let skipped: string | null = null
    try { skipped = await this.deps.readSkippedVersion?.() ?? null } catch { /* A damaged preference must not block editing. */ }
    if (this.abort.signal.aborted) return
    this.state.status = !decision ? 'unavailable' : decision.candidate ? 'available' : 'upToDate'
    this.state.candidate = decision?.candidate ?? null
    this.artifact = decision?.artifact
    if (decision) this.deps.sendEvent('update_check')
    if (decision?.candidate) {
      this.state.bubbleVisible = decision.candidate.required || skipped !== decision.candidate.version
      if (decision.candidate.required) this.state.requiredPrompt = this.workStarted || this.windows.size !== 1 ? 'protecting' : 'visible'
      this.transfer.total = this.artifact?.bytes ?? 0
    }
    this.publish()
    if (this.artifact && this.deps.getVerified) {
      const artifact = this.artifact
      try {
        const cached = await this.deps.getVerified(artifact)
        if (!this.abort.signal.aborted && cached && this.artifact === artifact && this.transfer.phase === 'idle') {
          this.verifiedFile = cached; this.transfer.phase = 'ready'; this.transfer.received = artifact.bytes; this.publish()
        }
      } catch { /* Cached bytes are never trusted on failure; offer a new download. */ }
    }
  }
  // Retained IPC for the unchanged About window; it no longer acknowledges an update.
  aboutOpened(_ownerId: number, _interactionId: string): void {}
  aboutClosed(_ownerId: number, _interactionId: string): void {}
  invalidateRenderer(ownerId: number): void { if (!this.transfer.forced) this.noteWorkStarted(ownerId) }
  isWorkBlocked(): boolean { return this.transfer.forced || this.transfer.phase === 'preparing' || this.transfer.phase === 'closing' }
  noteWorkStarted(ownerId: number): void {
    if (!this.windows.has(ownerId) || this.abort.signal.aborted) return
    if (this.transfer.forced) { this.protectWork(ownerId); return }
    if (this.workStarted) return
    this.workStarted = true
    if (this.state.candidate?.required && !this.transfer.forced) { this.state.requiredPrompt = 'protecting'; this.publish() }
  }
  async action(ownerId: number, action: UpdateAction): Promise<void> {
    if (!this.windows.has(ownerId) || this.abort.signal.aborted) return
    if (action === 'work-started') { this.noteWorkStarted(ownerId); return }
    if (!this.state.candidate) return
    if (action === 'claim-gate') {
      if (ownerId === this.owner && !this.transfer.forced && !this.workStarted && this.windows.size === 1 && this.state.requiredPrompt === 'visible') {
        this.transfer.forced = true; this.dialogOwner = ownerId; this.transfer.dialog = this.transfer.phase === 'ready' ? 'install' : 'offer'
        this.state.bubbleVisible = false; this.deps.sendEvent('update_opened'); this.publish()
      }
      return
    }
    if (this.transfer.phase === 'preparing' || this.transfer.phase === 'closing') return
    if (action === 'open') {
      this.dialogOwner = ownerId; this.transfer.error = null
      this.transfer.dialog = this.transfer.phase === 'ready' ? 'install' : ['downloading', 'verifying'].includes(this.transfer.phase) ? 'progress' : 'offer'
      this.deps.sendEvent('update_opened')
    } else if (action === 'later' || action === 'skip') {
      if (this.transfer.forced || action === 'skip' && this.state.candidate.required) return
      if (action === 'skip') {
        try { await this.deps.skipVersion?.(this.state.candidate.version) }
        catch { this.transfer.error = '跳过版本的设置未能保存，请重试。'; this.publish(); return }
      }
      this.transfer.dialog = 'hidden'; this.state.bubbleVisible = false
    } else if (action === 'dismiss') {
      if (this.transfer.forced) { this.requestRequiredExit(ownerId); return }
      this.transfer.dialog = 'hidden'
    } else if (action === 'cancel-download') {
      ++this.downloadGeneration
      if (this.transfer.forced) { void this.deps.cancelDownload?.(); this.requestRequiredExit(ownerId); return }
      await this.deps.cancelDownload?.(); this.transfer.phase = 'idle'; this.transfer.received = 0
      this.transfer.dialog = 'hidden'; this.transfer.error = null; this.state.bubbleVisible = true
    } else if (action === 'download') {
      if (!this.artifact || !this.deps.download || ['downloading', 'verifying', 'ready'].includes(this.transfer.phase)) return
      const generation = ++this.downloadGeneration, artifact = this.artifact
      this.transfer.phase = 'downloading'; this.transfer.received = 0; this.transfer.error = null; this.transfer.dialog = this.transfer.forced ? 'progress' : 'hidden'
      this.state.bubbleVisible = !this.transfer.forced
      const current = () => generation === this.downloadGeneration && !this.abort.signal.aborted
      void this.deps.download(artifact, progress => {
        if (current()) { this.transfer.phase = progress.phase; this.transfer.received = progress.received; this.transfer.total = progress.total; this.publish() }
      }).then(file => {
        if (current()) { this.verifiedFile = file; this.transfer.phase = 'ready'; this.transfer.received = artifact.bytes
          if (this.transfer.forced) this.transfer.dialog = 'install'; this.publish() }
      }, error => {
        if (current()) { this.transfer.phase = 'failed'; this.transfer.error = safeUpdateError(error); this.publish() }
      })
    } else if (action === 'install') {
      if (!this.artifact || !this.verifiedFile || this.transfer.phase !== 'ready' || !this.deps.requestInstall) return
      this.transfer.phase = 'preparing'; this.transfer.error = null; this.publish()
      try { await this.deps.requestInstall(this.artifact, this.verifiedFile) }
      catch (error) {
        if (error instanceof UpdatePackageInvalidError) this.verifiedFile = undefined
        this.transfer.phase = this.verifiedFile ? 'ready' : 'failed'; this.transfer.error = safeUpdateError(error)
        // Preflight can report "aborted" before its rejection reaches this action.
        // Keep that failure visible rather than silently returning to the indicator.
        if (this.windows.has(ownerId)) { this.dialogOwner = ownerId; this.transfer.dialog = this.verifiedFile ? 'install' : 'offer' }
        this.publish()
      }
      return
    }
    this.publish()
  }
  installAborted(error?: string): void {
    this.transfer.phase = this.verifiedFile ? 'ready' : 'idle'; this.transfer.error = error ?? null
    this.transfer.dialog = this.transfer.forced ? this.verifiedFile ? 'install' : 'offer' : 'hidden'
    if (this.transfer.forced && !this.windows.has(this.dialogOwner!)) this.dialogOwner = this.windows.values().next().value
    this.publish()
  }
  installState(state: 'preparing' | 'closing' | 'committed' | 'aborted' | 'blocked', error?: string): void {
    if (state === 'aborted') { this.installAborted(error); return }
    this.transfer.phase = state === 'preparing' ? 'preparing' : 'closing'
    this.transfer.error = error ?? null
    this.publish()
  }
  async openWebsite(ownerId: number): Promise<boolean> {
    if (!this.windows.has(ownerId) || !this.state.candidate || this.abort.signal.aborted) return false
    if (this.websiteOpening) return this.websiteOpening
    const pending = (async () => {
      try { await this.deps.openWebsite(APP_UPDATE_WEBSITE) } catch { return false }
      if (!this.abort.signal.aborted) this.deps.sendEvent('website_opened')
      return true
    })()
    this.websiteOpening = pending
    void pending.finally(() => { if (this.websiteOpening === pending) this.websiteOpening = undefined })
    return pending
  }
  requestRequiredExit(ownerId: number): void {
    if (!this.windows.has(ownerId) || !this.transfer.forced || this.state.requiredPrompt === 'closing' || this.abort.signal.aborted) return
    this.owner = ownerId; this.state.requiredPrompt = 'closing'; this.publish()
    // Do not await window close inside an IPC lease: normal close must drain that lease.
    this.deps.requestExit()
  }
  protectWork(ownerId: number): void {
    if (!this.windows.has(ownerId) || !this.state.candidate?.required) return
    this.workStarted = true; this.transfer.forced = false; this.transfer.dialog = 'hidden'
    this.state.bubbleVisible = true; this.state.requiredPrompt = 'protecting'; this.publish()
  }
  setExitState(state: 'idle' | 'closing' | 'protecting'): void {
    if (!this.state.candidate?.required || this.abort.signal.aborted) return
    this.state.requiredPrompt = state === 'idle' ? 'protecting' : state; this.publish()
    if (state !== 'closing') { this.transfer.forced = false; this.transfer.dialog = 'hidden'; this.workStarted = true; this.publish() }
  }
  detachWindow(ownerId: number): void {
    this.windows.delete(ownerId); this.listeners.delete(ownerId)
    if (this.owner === ownerId) { this.owner = undefined; this.workStarted = true; this.state.requiredPrompt = 'protecting' }
    if (this.dialogOwner === ownerId) { this.dialogOwner = undefined; this.transfer.dialog = 'hidden' }
    this.publish()
  }
  dispose(): void { this.abort.abort(); void this.deps.cancelDownload?.(); if (this.timer) clearTimeout(this.timer); this.listeners.clear(); this.windows.clear() }
  private publish(): void {
    this.state.revision++
    for (const [ownerId, listeners] of this.listeners) for (const listener of listeners) {
      try { listener(this.getSnapshot(ownerId)) } catch { /* Display observers do not own application lifetime. */ }
    }
  }
}
function safeUpdateError(error: unknown): string {
  // Only our fixed, human-readable errors are displayed; transport errors may contain signed URLs or paths.
  return error instanceof Error && /^[\u3400-\u9fff]/.test(error.message) && error.message.length <= 2048 ? error.message : '更新操作未能完成，请检查网络和磁盘权限后重试。'
}
