import type { ArkdownApi } from '../../shared/contracts'
import { normalizeAccelerator, parseObservedShortcutSnapshot, parseObservedShortcutUpdate,
  type ObservedShortcutSnapshot, type ObservedShortcutUpdate, type ShortcutBindings, type ShortcutSnapshot, type ShortcutUpdate } from '../../shared/keyboard-shortcuts'
import type { PreferencePersistence } from './preference-update-queue'

type ShortcutApi = Pick<ArkdownApi, 'getKeyboardShortcuts' | 'updateKeyboardShortcuts'>
export interface ShortcutPreferenceView {
  observed?: ObservedShortcutSnapshot
  bindings: ShortcutBindings
  pending: boolean
  loading: boolean
  hasDirty: boolean
  resetAllBlocked: boolean
  singleChangesBlocked: boolean
  error: string | null
}

/** App-owned UI intent; the shared persistence owner alone decides whether close may proceed. */
export class ShortcutPreferenceDraft {
  private confirmed?: ObservedShortcutSnapshot
  private readonly dirty = new Map<string, { command: ObservedShortcutUpdate; error?: string }>()
  private pending = false
  private loading = false
  private notice: string | null = null
  private readonly listeners = new Set<() => void>()
  private view: ShortcutPreferenceView = { bindings: {}, pending: false, loading: false, hasDirty: false,
    resetAllBlocked: false, singleChangesBlocked: false, error: null }
  constructor(private readonly persistence: PreferencePersistence) {}
  getSnapshot = (): ShortcutPreferenceView => this.view
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  accept(snapshot: ShortcutSnapshot): void {
    const observed = parseObservedShortcutSnapshot(snapshot)
    if (observed) { this.adopt(observed); this.publish() }
  }
  async refresh(api: ShortcutApi): Promise<void> {
    if (this.loading) return
    this.loading = true; this.publish()
    try { this.adopt(await this.read(api)); this.notice = null }
    catch (error) { this.notice = this.message(error) }
    finally { this.loading = false; this.publish() }
  }
  async change(change: ShortcutUpdate, observed: ObservedShortcutSnapshot, api: ShortcutApi): Promise<ObservedShortcutSnapshot | undefined> {
    if (this.pending || this.loading) return
    const id = 'resetAll' in change ? 'resetAll' : change.id
    if (id === 'resetAll' ? [...this.dirty.keys()].some(key => key !== 'resetAll') : this.dirty.has('resetAll')) {
      this.notice = '请先重新加载或保存尚未完成的快捷键修改。'; this.publish(); return
    }
    const command = parseObservedShortcutUpdate({ change, observed: this.dirty.get(id)?.command.observed ?? observed })
    if (!command) { this.notice = '快捷键设置尚未读取，请重新加载。'; this.publish(); return }
    const entry = { command, error: undefined as string | undefined }
    this.dirty.set(id, entry); this.pending = true; this.notice = null; this.publish()
    try {
      const snapshot = await this.persistence.runExternal(`shortcut.${id}`, async () => {
        const result = await api.updateKeyboardShortcuts?.(command)
        if (!result) throw new Error('快捷键设置暂不可用。')
        if (!result.ok) throw new Error(result.error.message)
        this.adopt(result.value.snapshot)
        if (result.value.error) throw new Error(result.value.error)
        return result.value.snapshot
      })
      this.adopt(snapshot); this.dirty.delete(id)
    } catch (error) { entry.error = this.message(error) }
    finally { this.pending = false; this.publish() }
    return this.confirmed
  }
  async reload(api: ShortcutApi): Promise<ObservedShortcutSnapshot | undefined> {
    if (this.loading || this.pending) return
    this.loading = true; this.publish()
    try {
      const reading = Promise.resolve().then(() => this.read(api)).then(snapshot => {
        if (this.confirmed && snapshot.revision < this.confirmed.revision) throw new Error('快捷键设置读取已过期，请重试。')
        return snapshot
      })
      const acknowledgements = [...this.dirty.keys()].map(id => this.persistence.runExternal(`shortcut.${id}`, () => reading))
      const [snapshot] = await Promise.all([reading, ...acknowledgements])
      this.adopt(snapshot); this.dirty.clear(); this.notice = null
    } catch (error) { this.notice = this.message(error) }
    finally { this.loading = false; this.publish() }
    return this.confirmed
  }
  private async read(api: ShortcutApi): Promise<ObservedShortcutSnapshot> {
    const result = await api.getKeyboardShortcuts?.()
    if (!result) throw new Error('快捷键设置暂不可用。')
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  private adopt(snapshot: ObservedShortcutSnapshot): void {
    if (!this.confirmed || snapshot.revision >= this.confirmed.revision) this.confirmed = structuredClone(snapshot)
  }
  private message(error: unknown): string { return error instanceof Error ? error.message : '快捷键保存失败，请重试。' }
  private publish(): void {
    let bindings = { ...this.confirmed?.bindings }
    for (const { command: { change } } of this.dirty.values()) {
      if ('resetAll' in change) bindings = {}
      else if ('reset' in change) delete bindings[change.id]
      else bindings[change.id] = change.accelerator === null ? null : normalizeAccelerator(change.accelerator)
    }
    this.view = { observed: this.confirmed, bindings, pending: this.pending, loading: this.loading,
      hasDirty: this.dirty.size > 0, resetAllBlocked: [...this.dirty.keys()].some(id => id !== 'resetAll'),
      singleChangesBlocked: this.dirty.has('resetAll'),
      error: [...new Set([this.notice, ...[...this.dirty.values()].map(entry => entry.error)].filter(Boolean))].join(' ') || null }
    for (const listener of this.listeners) { try { listener() } catch { /* A UI observer cannot change the saved result. */ } }
  }
}
