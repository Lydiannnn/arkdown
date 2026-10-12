import type { UpdateArtifact } from './update-protocol'
import { UpdateNotesStopError } from './update-notes'
export interface UpdateHandoff {
  readonly exited?: Promise<void>
  commit(input: { documents: string[]; restoreArknote: boolean }): Promise<void>
  revoke(reason?: string): Promise<void>
}
export interface UpdateInstallWindow { id: number; path(): string | null; activate?(): void; requestClose(): void; isClosing?(): boolean }
export interface UpdateInstallDependencies {
  prepare(artifact: UpdateArtifact, file: string): Promise<UpdateHandoff>
  windows(): UpdateInstallWindow[]
  stopArknote(): Promise<boolean>
  restoreArknote(): Promise<void>
  notify(state: 'preparing' | 'closing' | 'committed' | 'aborted' | 'blocked', error?: string): void
  quit(): void
}
export class UpdateInstallCoordinator {
  private phase: 'idle' | 'preparing' | 'closing' | 'finishing' | 'committed' | 'aborting' = 'idle'
  private handoff?: UpdateHandoff
  private pending?: UpdateInstallWindow
  private pendingPath: string | null = null
  private readonly documents: string[] = []
  private restoreNotesOnAbort = false
  constructor(private readonly deps: UpdateInstallDependencies) {}
  get active(): boolean { return this.phase !== 'idle' }
  async start(artifact: UpdateArtifact, file: string): Promise<void> {
    if (this.active) return
    if (this.deps.windows().some(window => window.isClosing?.())) throw new Error('已有文档正在关闭，请完成或取消该操作后再安装更新。')
    this.phase = 'preparing'; this.deps.notify('preparing')
    try { this.handoff = await this.deps.prepare(artifact, file) }
    catch (error) { this.phase = 'idle'; this.deps.notify('aborted'); throw error }
    this.documents.length = 0
    this.phase = 'closing'; this.deps.notify('closing'); this.next()
  }
  onWindowClosed(id: number): void {
    if (this.phase !== 'closing' || this.pending?.id !== id) return
    const file = this.pending.path() ?? this.pendingPath
    if (file && !this.documents.includes(file)) this.documents.push(file)
    this.pending = undefined; this.pendingPath = null; this.next()
  }
  onCloseState(id: number, state: { state: string }): void {
    if (this.phase !== 'closing' || this.pending?.id !== id) return
    if (state.state === 'failed' || state.state === 'cancelled') { void this.abort('安装已取消。尚未关闭的文档和已下载的更新包均已保留。'); return }
    this.pendingPath = this.pending.path() ?? this.pendingPath
  }
  private next(): void {
    if (this.phase !== 'closing' || this.pending) return
    const next = this.deps.windows()[0]
    if (!next) { this.phase = 'finishing'; void this.finish(); return }
    this.pending = next; this.pendingPath = next.path()
    try { next.activate?.(); next.requestClose() } catch { void this.abort('无法关闭当前文档，已取消安装。请处理该窗口后重试。') }
  }
  private async finish(): Promise<void> {
    try {
      this.restoreNotesOnAbort = await this.deps.stopArknote()
      await this.handoff!.commit({ documents: [...this.documents], restoreArknote: this.restoreNotesOnAbort })
      this.phase = 'committed'; this.deps.notify('committed'); this.deps.quit()
    } catch (error) {
      if (error instanceof UpdateNotesStopError) this.restoreNotesOnAbort = true
      await this.abort('安装交接未能完成。程序文件尚未替换，请检查便签保存状态及安全软件后重试。若此前运行的便签没有恢复，请手动打开 Arknote。')
    }
  }
  private async abort(message: string): Promise<void> {
    if (this.phase === 'aborting' || this.phase === 'idle' || this.phase === 'committed') return
    this.phase = 'aborting'
    try { await this.handoff?.revoke(this.deps.windows().length ? undefined : message) }
    catch {
      // Never exit after a lost commit acknowledgement until the helper confirms revocation.
      this.deps.notify('blocked', '无法确认更新助手已取消。Arkdown 将保持运行，避免触发文件替换；请等待更新助手显示结果。')
      const blocked = this.handoff
      void blocked?.exited?.then(() => {
        if (this.phase === 'aborting' && this.handoff === blocked) void this.finishAbort(message)
      })
      return
    }
    await this.finishAbort(message)
  }
  private async finishAbort(message: string): Promise<void> {
    if (this.restoreNotesOnAbort) {
      this.restoreNotesOnAbort = false
      try { await this.deps.restoreArknote() }
      catch { message += ' 便签自动恢复未能完成，请手动打开 Arknote。' }
    }
    this.pending = undefined; this.pendingPath = null; this.handoff = undefined; this.phase = 'idle'
    this.deps.notify('aborted', message)
    if (!this.deps.windows().length) this.deps.quit()
  }
}
