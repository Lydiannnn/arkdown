import { isUpdateUuid } from '../../shared/app-update'
import { isDeepStrictEqual } from 'node:util'
import type { SettingsCredentialProposal, SettingsStorageResult, SettingsTransactionStore } from './settings-transaction-store'
import type { SettingsTransactionOperation, SettingsTransactionRequest, SettingsTransactionSnapshot } from './settings-transaction-types'
import { observeModelSettings, type ModelExecutionTarget } from './settings-command-adapter'
import type { PublicModelSettingsSnapshot } from '../../shared/settings-observation'
import type { FloatingTranslationSettings } from '../../shared/large-model-settings'
import { normalizeDefaultApplicationsPrompt } from '../../shared/default-applications'
import type { WindowBounds } from './settings-store'

type SettingsAuthorityStore = Pick<SettingsTransactionStore, 'readSnapshot' | 'apply' | 'readModelExecutionSnapshot' | 'encryptCredential' | 'admitModelExecution'>
export type AuthoritativeModelExecution = Awaited<ReturnType<SettingsTransactionStore['readModelExecutionSnapshot']>> & { observed: PublicModelSettingsSnapshot }
type SnapshotListener = (snapshot: SettingsTransactionSnapshot) => void

/** Main-only cache owner. Display copies never authorize a write or a model request. */
export class SettingsAuthority {
  private current: SettingsTransactionSnapshot | undefined
  private tail: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<SnapshotListener>()
  private disposed = false

  constructor(private readonly store: SettingsAuthorityStore) {}

  getDisplaySnapshot(): SettingsTransactionSnapshot {
    if (!this.current) throw new Error('SETTINGS_AUTHORITY_NOT_READY')
    return structuredClone(this.current)
  }

  readFresh(): Promise<SettingsTransactionSnapshot> {
    return this.enqueue(async () => this.adopt(await this.store.readSnapshot()))
  }

  /** The only credential-bearing read; listeners and display snapshots receive settings alone. */
  readExecution(target: ModelExecutionTarget): Promise<AuthoritativeModelExecution> {
    const submitted = structuredClone(target)
    return this.enqueue(async () => {
      const execution = await this.store.readModelExecutionSnapshot(submitted)
      const snapshot = this.adopt(execution.snapshot)
      return { ...structuredClone(execution), snapshot, observed: observeModelSettings(snapshot) }
    })
  }

  encryptCredential(apiKey: string): string {
    if (this.disposed) throw new Error('SETTINGS_AUTHORITY_DISPOSED')
    return this.store.encryptCredential(apiKey)
  }

  admitExecution<T>(expected: PublicModelSettingsSnapshot, target: ModelExecutionTarget,
    start: () => { completion: Promise<T> }): Promise<{ completion: Promise<T> }> {
    const observed = structuredClone(expected)
    const submitted = structuredClone(target)
    return this.enqueue(() => this.store.admitModelExecution(observed, submitted, start))
  }

  apply(request: SettingsTransactionRequest, credential?: SettingsCredentialProposal): Promise<SettingsStorageResult> {
    // Preserve the submitted observation even if its UI or service owner later mutates a draft.
    const submitted = structuredClone(request)
    const proposedCredential = credential === undefined ? undefined : { ...credential }
    return this.enqueue(async () => {
      const result = await this.store.apply(submitted, proposedCredential)
      if ('snapshot' in result) this.adopt(result.snapshot)
      return structuredClone(result)
    })
  }

  /** These main-owned values deliberately use last-writer-wins, never a renderer form observation. */
  async saveWindowBounds(value: WindowBounds | undefined): Promise<void> {
    this.requireCommitted(await this.apply({ baseRevision: 0, operations: [value === undefined
      ? { kind: 'window-bounds.clear', mode: 'last-writer-wins' }
      : { kind: 'window-bounds.set', value, mode: 'last-writer-wins' }] }))
  }

  async saveWorkspace(value: string | null): Promise<void> {
    this.requireCommitted(await this.apply({ baseRevision: 0,
      operations: [{ kind: 'workspace.set', value, mode: 'last-writer-wins' }] }))
  }

  async saveFolderPickerDirectory(value: string | undefined): Promise<void> {
    this.requireCommitted(await this.apply({ baseRevision: 0, operations: [value === undefined
      ? { kind: 'folder-picker.clear', mode: 'last-writer-wins' }
      : { kind: 'folder-picker.set', value, mode: 'last-writer-wins' }] }))
  }

  migrateStartupSettings(legacy?: FloatingTranslationSettings): Promise<SettingsTransactionSnapshot> {
    return this.applyAutomatic([{ kind: 'migration.font-defaults' },
      { kind: 'migration.floating-translation', ...(legacy === undefined ? {} : { legacy: structuredClone(legacy) }) }])
  }

  /** The store's locked commit outcome chooses the winner, not an earlier cached read. */
  async claimWorkspaceIntroduction(legacySeen: boolean): Promise<{ showIntroduction: boolean }> {
    if (typeof legacySeen !== 'boolean') throw new Error('SETTINGS_COMMAND_INVALID')
    const observed = await this.readFresh()
    const result = await this.apply({ baseRevision: observed.revision, operations: [{ kind: 'workspace-intro.mark-seen' }] })
    this.requireCommitted(result)
    return { showIntroduction: result.status === 'committed' && !legacySeen }
  }

  async ensureUpdateInstallationId(candidateId: string): Promise<string> {
    if (!isUpdateUuid(candidateId)) throw new Error('SETTINGS_COMMAND_INVALID')
    const snapshot = await this.applyAutomatic([{ kind: 'application-update.ensure-identity', candidateId }])
    const id = snapshot.settings.applicationUpdate?.installationId
    if (!isUpdateUuid(id)) throw new Error('SETTINGS_COMMAND_INVALID')
    return id
  }

  recordApplicationStart(version: string, installationId?: string): Promise<SettingsTransactionSnapshot> {
    return this.applyAutomatic([{ kind: 'default-applications.record-start', version, installationId: installationId ?? null }])
  }

  async markApplicationOfferHandled(observed: SettingsTransactionSnapshot): Promise<void> {
    this.requireCommitted(await this.apply({ baseRevision: observed.revision,
      operations: [{ kind: 'default-applications.mark-handled', expected: {
        value: normalizeDefaultApplicationsPrompt(observed.settings.defaultApplicationsPrompt),
        revision: observed.fieldRevisions.fields.defaultApplicationsPrompt ?? 0,
      } }] }))
  }

  async markApplicationCloseOfferHandled(observed: SettingsTransactionSnapshot): Promise<void> {
    this.requireCommitted(await this.apply({ baseRevision: observed.revision,
      operations: [{ kind: 'default-applications.mark-close-handled', expected: {
        value: normalizeDefaultApplicationsPrompt(observed.settings.defaultApplicationsPrompt),
        revision: observed.fieldRevisions.fields.defaultApplicationsPrompt ?? 0,
      } }] }))
  }

  // Only automatic finite derivations may choose a fresh baseline. A user/native result must
  // retain its original observation. No command is replayed after conflict or unknown commit.
  private async applyAutomatic(operations: readonly Extract<SettingsTransactionOperation,
    { kind: 'application-update.ensure-identity' | 'default-applications.record-start' | 'migration.font-defaults' | 'migration.floating-translation' }>[]): Promise<SettingsTransactionSnapshot> {
    const observed = await this.readFresh()
    return this.requireCommitted(await this.apply({ baseRevision: observed.revision, operations }))
  }

  private requireCommitted(result: SettingsStorageResult): SettingsTransactionSnapshot {
    if (result.status === 'invalid') throw new Error('SETTINGS_COMMAND_INVALID')
    if (result.status === 'conflict') throw new Error('SETTINGS_COMMAND_CONFLICT')
    // A ciphertext journal cleanup failure cannot turn an acknowledged settings commit into failure.
    return result.snapshot
  }

  subscribe(listener: SnapshotListener): () => void {
    if (this.disposed) throw new Error('SETTINGS_AUTHORITY_DISPOSED')
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('SETTINGS_AUTHORITY_DISPOSED'))
    const pending = this.tail.then(() => {
      if (this.disposed) throw new Error('SETTINGS_AUTHORITY_DISPOSED')
      return operation()
    })
    this.tail = pending.then(() => undefined, () => undefined)
    return pending
  }

  private adopt(snapshot: SettingsTransactionSnapshot): SettingsTransactionSnapshot {
    if (this.current) {
      if (snapshot.revision < this.current.revision) throw new Error('SETTINGS_AUTHORITY_REVISION_REGRESSED')
      if (snapshot.revision === this.current.revision) {
        if (!isDeepStrictEqual(snapshot, this.current)) throw new Error('SETTINGS_AUTHORITY_REVISION_REUSED')
        return this.getDisplaySnapshot()
      }
    }
    this.current = structuredClone(snapshot)
    for (const listener of this.listeners) {
      try { listener(this.getDisplaySnapshot()) } catch { /* Observer failures never undo an acknowledged commit. */ }
    }
    return this.getDisplaySnapshot()
  }
}
