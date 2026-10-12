import { isDeepStrictEqual } from 'node:util'
import { normalizeEditorAppearancePreferences } from '../../shared/editor-appearance-preferences'
import { normalizeLayoutPreferences } from '../../shared/layout-preferences'
import type { SettingsAuthority } from './settings-authority'
import type { SettingsTransactionSnapshot } from './settings-transaction-types'

/** Read-only compatibility projections. This view owns neither a cache nor a persistence route. */
export class SettingsPresentation {
  private readonly appearanceListeners = new Set<() => void>()
  private readonly layoutListeners = new Set<() => void>()
  private readonly unsubscribe: () => void

  constructor(private readonly authority: Pick<SettingsAuthority, 'getDisplaySnapshot' | 'subscribe'>) {
    let previousAppearance = this.getEditorAppearanceSnapshot()
    let previousLayout = this.getLayoutSnapshot()
    this.unsubscribe = authority.subscribe(() => {
      const appearance = this.getEditorAppearanceSnapshot()
      const layout = this.getLayoutSnapshot()
      const appearanceChanged = !isDeepStrictEqual(appearance, previousAppearance)
      const layoutChanged = !isDeepStrictEqual(layout, previousLayout)
      previousAppearance = appearance; previousLayout = layout
      if (appearanceChanged) this.notify(this.appearanceListeners)
      if (layoutChanged) this.notify(this.layoutListeners)
    })
  }

  get() { return this.authority.getDisplaySnapshot().settings }

  getEditorAppearanceSnapshot() {
    const snapshot = this.authority.getDisplaySnapshot()
    return { appearance: normalizeEditorAppearancePreferences(snapshot.settings.appearance),
      revision: this.groupRevision(snapshot, 'appearance') }
  }

  getLayoutSnapshot() {
    const snapshot = this.authority.getDisplaySnapshot()
    return { layout: normalizeLayoutPreferences(snapshot.settings.layout), revision: this.groupRevision(snapshot, 'layout') }
  }

  subscribeEditorAppearance(listener: () => void): () => void {
    this.appearanceListeners.add(listener)
    return () => { this.appearanceListeners.delete(listener) }
  }

  subscribeLayout(listener: () => void): () => void {
    this.layoutListeners.add(listener)
    return () => { this.layoutListeners.delete(listener) }
  }

  dispose(): void {
    this.unsubscribe(); this.appearanceListeners.clear(); this.layoutListeners.clear()
  }

  private groupRevision(snapshot: SettingsTransactionSnapshot, group: string): number {
    return Object.entries(snapshot.fieldRevisions.fields).reduce((revision, [key, value]) =>
      key.startsWith(`${group}.`) ? Math.max(revision, value ?? 0) : revision, 0)
  }

  private notify(listeners: ReadonlySet<() => void>): void {
    for (const listener of listeners) { try { listener() } catch { /* Display observers cannot undo a commit. */ } }
  }
}
