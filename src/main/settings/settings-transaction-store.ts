import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { DEFAULT_FLOATING_TRANSLATION_SETTINGS, DEFAULT_LARGE_MODEL_SETTINGS, featureModelConnections } from '../../shared/large-model-settings'
import { decryptModelSecret, encryptModelSecret, type ModelSecretCipher } from '../models/model-secret-vault'
import { decodeSettingsTransactionDocument, encodeSettingsTransactionDocument } from './settings-transaction-document'
import {
  JOURNAL_FILE_MAX_BYTES, SETTINGS_FILE_MAX_BYTES, VAULT_FILE_MAX_BYTES,
  settingsFileIdentity, settingsTransactionFileIO, SettingsStorageError, type SettingsTransactionFileIO,
} from './settings-transaction-files'
import {
  decodeSettingsCredentialJournal, decodeTransactionVault, encodeSettingsCredentialJournal,
  encodeTransactionVault, isTransactionCiphertext, replaceTransactionVaultEntry, type SettingsCredentialJournal,
} from './settings-transaction-journal'
import { reduceSettingsTransaction } from './settings-transaction-reducer'
import { hasSettingsKeys, MODEL_FEATURE_FIELDS } from './settings-transaction-schema'
import type { ModelFeature, SettingsTransactionReduction, SettingsTransactionRequest, SettingsTransactionSnapshot } from './settings-transaction-types'
import { withSettingsWriteLock } from './settings-write-lock'
import { modelExecutionGuardRequest, type ModelExecutionTarget } from './settings-command-adapter'
import type { PublicModelSettingsSnapshot } from '../../shared/settings-observation'

export interface SettingsCredentialProposal { id: string; ciphertext: string | null }
export type SettingsStorageResult = Exclude<SettingsTransactionReduction, { status: 'prepared' }>
  | { status: 'committed'; snapshot: SettingsTransactionSnapshot; cleanupPending: boolean }
interface SettingsRead { bytes: Buffer | null; snapshot: SettingsTransactionSnapshot }

/**
 * Production settings and credential transaction owner. Never mix this protocol with legacy
 * SettingsStore.save or vault set/delete/restore on the same root. Only this outer owner acquires the write lock.
 */
export class SettingsTransactionStore {
  private readonly io: SettingsTransactionFileIO
  private readonly settingsPath: string
  private readonly vaultPath: string
  private readonly journalPath: string

  constructor(private readonly root: string, private readonly cipher: ModelSecretCipher,
    dependencies: Partial<SettingsTransactionFileIO> = {}, private readonly timeoutMs = 5000) {
    this.io = { ...settingsTransactionFileIO, ...dependencies }
    this.settingsPath = path.join(root, 'settings.json')
    this.vaultPath = path.join(root, 'model-secrets.json')
    this.journalPath = path.join(root, 'model-settings.pending.json')
  }

  encryptCredential(apiKey: string): string { return encryptModelSecret(this.cipher, apiKey) }

  /** Main-owned synchronous admission only. Wrapped long work is never awaited under the settings lease. */
  admitModelExecution<T>(expected: PublicModelSettingsSnapshot, target: ModelExecutionTarget,
    start: () => { completion: Promise<T> }): Promise<{ completion: Promise<T> }> {
    const guards = modelExecutionGuardRequest(expected, target)
    return this.locked(async () => {
      await this.recoverPending(false)
      const latest = await this.readSettings()
      if (reduceSettingsTransaction(latest.snapshot, guards).status !== 'unchanged') {
        throw new SettingsStorageError('SETTINGS_TRANSACTION_AUTHORITY_CHANGED')
      }
      return start()
    })
  }

  readSnapshot(): Promise<SettingsTransactionSnapshot> {
    return this.locked(async () => { await this.recoverPending(false); return (await this.readSettings()).snapshot })
  }

  readModelExecutionSnapshot(target: { connectionId: string } | { feature: ModelFeature }) {
    return this.locked(async () => {
      await this.recoverPending(false)
      const { snapshot } = await this.readSettings()
      const models = snapshot.settings.models ?? structuredClone(DEFAULT_LARGE_MODEL_SETTINGS)
      let connectionId: string | null
      let featurePreferences: unknown
      if (hasSettingsKeys(target, ['feature']) && 'feature' in target && typeof target.feature === 'string' && Object.hasOwn(MODEL_FEATURE_FIELDS, target.feature)) {
        featurePreferences = models[target.feature as ModelFeature] ?? DEFAULT_FLOATING_TRANSLATION_SETTINGS
        connectionId = (featurePreferences as { connectionId: string | null }).connectionId
      } else if (hasSettingsKeys(target, ['connectionId']) && 'connectionId' in target && typeof target.connectionId === 'string') connectionId = target.connectionId
      else throw new SettingsStorageError('SETTINGS_TRANSACTION_CONNECTION_MISSING')
      const connection = featureModelConnections(models).find(item => item.id === connectionId)
      if (!connection) throw new SettingsStorageError('SETTINGS_TRANSACTION_CONNECTION_MISSING')
      let apiKey: string | null = null
      if (connection.accessType === 'standard-api') {
        const vault = decodeTransactionVault(await this.io.readBounded(this.vaultPath, VAULT_FILE_MAX_BYTES))
        const ciphertext = vault.secrets[connection.id]
        if (!ciphertext) throw new SettingsStorageError('SETTINGS_TRANSACTION_CREDENTIAL_REQUIRED')
        apiKey = decryptModelSecret(this.cipher, ciphertext)
      }
      return { snapshot, connection, apiKey, ...(featurePreferences === undefined ? {} : { featurePreferences: structuredClone(featurePreferences) }) }
    })
  }

  apply(request: SettingsTransactionRequest, credential?: SettingsCredentialProposal): Promise<SettingsStorageResult> {
    return this.locked(async () => {
      await this.recoverPending(false)
      const before = await this.readSettings()
      const result = reduceSettingsTransaction(before.snapshot, request)
      if (result.status !== 'prepared') {
        if (credential && result.status === 'unchanged') throw new SettingsStorageError('SETTINGS_TRANSACTION_CREDENTIAL_REQUIRED')
        return result
      }
      const after = encodeSettingsTransactionDocument(result.snapshot)
      if (!result.credentialChange) {
        if (credential !== undefined) throw new SettingsStorageError('SETTINGS_TRANSACTION_CREDENTIAL_REQUIRED')
        try { await this.io.writeAtomic(this.settingsPath, after) } catch {
          const current = await this.io.readBounded(this.settingsPath, SETTINGS_FILE_MAX_BYTES)
          if (settingsFileIdentity(current) !== settingsFileIdentity(after)) {
            throw new SettingsStorageError(settingsFileIdentity(current) === settingsFileIdentity(before.bytes)
              ? 'SETTINGS_TRANSACTION_WRITE_FAILED' : 'SETTINGS_TRANSACTION_RECOVERY_REQUIRED')
          }
        }
        return { status: 'committed', snapshot: decodeSettingsTransactionDocument(after), cleanupPending: false }
      }
      const change = result.credentialChange
      if (!hasSettingsKeys(credential, ['id', 'ciphertext']) || credential.id !== change.id
        || (change.kind === 'remove' ? credential.ciphertext !== null : !isTransactionCiphertext(credential.ciphertext))) {
        throw new SettingsStorageError('SETTINGS_TRANSACTION_CREDENTIAL_REQUIRED')
      }
      const vaultBytes = await this.io.readBounded(this.vaultPath, VAULT_FILE_MAX_BYTES)
      const vault = decodeTransactionVault(vaultBytes)
      const entryBefore = vault.secrets[change.id] ?? null
      if (change.kind === 'add' && entryBefore !== null) throw new SettingsStorageError('SETTINGS_TRANSACTION_CREDENTIAL_REQUIRED')
      const afterVault = encodeTransactionVault(replaceTransactionVaultEntry(vault, change.id, credential.ciphertext))
      const journal: SettingsCredentialJournal = {
        version: 1, transactionId: randomUUID(), connectionId: change.id, kind: change.kind,
        settingsBefore: { identity: settingsFileIdentity(before.bytes), revision: before.snapshot.revision },
        settingsAfter: { identity: settingsFileIdentity(after)!, revision: result.snapshot.revision },
        vault: { before: settingsFileIdentity(vaultBytes), rollback: settingsFileIdentity(encodeTransactionVault(vault)), after: settingsFileIdentity(afterVault) },
        entry: { before: entryBefore, after: credential.ciphertext },
      }
      const record = encodeSettingsCredentialJournal(journal)
      try {
        await this.io.writeAtomic(this.journalPath, record)
        await this.writeVault(afterVault)
        await this.io.writeAtomic(this.settingsPath, after)
      } catch {
        // Atomic writers can throw after replacement. Classify disk facts under the original lease.
        const pending = await this.io.readBounded(this.journalPath, JOURNAL_FILE_MAX_BYTES)
        if (pending === null) {
          const currentSettings = await this.io.readBounded(this.settingsPath, SETTINGS_FILE_MAX_BYTES)
          const currentVault = await this.io.readBounded(this.vaultPath, VAULT_FILE_MAX_BYTES)
          if (settingsFileIdentity(currentSettings) !== journal.settingsBefore.identity || settingsFileIdentity(currentVault) !== journal.vault.before) {
            throw new SettingsStorageError('SETTINGS_TRANSACTION_RECOVERY_REQUIRED')
          }
          throw new SettingsStorageError('SETTINGS_TRANSACTION_WRITE_FAILED')
        }
        if (!pending.equals(record)) throw new SettingsStorageError('SETTINGS_TRANSACTION_RECOVERY_REQUIRED')
      }
      const recovered = await this.recoverPending(true, record)
      if (!recovered?.committed) throw new SettingsStorageError('SETTINGS_TRANSACTION_WRITE_FAILED')
      return { status: 'committed', snapshot: recovered.snapshot, cleanupPending: recovered.cleanupPending }
    })
  }

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    try { await this.io.ensureDirectory(this.root) } catch { throw new SettingsStorageError('SETTINGS_STORAGE_READ_FAILED') }
    return withSettingsWriteLock(this.root, operation, this.timeoutMs)
  }

  private async readSettings(backup = true): Promise<SettingsRead> {
    const bytes = await this.io.readBounded(this.settingsPath, SETTINGS_FILE_MAX_BYTES)
    try { return { bytes, snapshot: decodeSettingsTransactionDocument(bytes) } } catch (error) {
      if (backup && bytes !== null) {
        const backupPath = path.join(this.root, `settings.transaction-corrupt-${settingsFileIdentity(bytes)}.json`)
        await this.io.backupExclusive(this.settingsPath, backupPath).catch(() => undefined)
      }
      throw error
    }
  }

  private async writeVault(bytes: Buffer | null): Promise<void> {
    if (bytes === null) await this.io.removeFile(this.vaultPath)
    else await this.io.writeAtomic(this.vaultPath, bytes)
  }

  /** No nested lock or vault queue. Every invocation finishes/classifies compensation before releasing the lease. */
  private async recoverPending(allowCommittedCleanupFailure: boolean, expectedRecord?: Buffer) {
    try {
      const record = await this.io.readBounded(this.journalPath, JOURNAL_FILE_MAX_BYTES)
      if (record === null) {
        if (expectedRecord) throw new Error('Lost journal')
        return undefined
      }
      if (expectedRecord && !record.equals(expectedRecord)) throw new Error('Journal changed')
      const journal = decodeSettingsCredentialJournal(record)
      const current = await this.readSettings(false)
      const identity = settingsFileIdentity(current.bytes)
      const committed = identity === journal.settingsAfter.identity && current.snapshot.revision === journal.settingsAfter.revision
      if (!committed && !(identity === journal.settingsBefore.identity && current.snapshot.revision === journal.settingsBefore.revision)) throw new Error('Unknown settings state')
      const vaultBytes = await this.io.readBounded(this.vaultPath, VAULT_FILE_MAX_BYTES)
      const vaultIdentity = settingsFileIdentity(vaultBytes)
      if (![journal.vault.before, journal.vault.rollback, journal.vault.after].includes(vaultIdentity)) throw new Error('Unknown vault state')
      const vault = decodeTransactionVault(vaultBytes)
      const targetEntry = committed ? journal.entry.after : journal.entry.before
      const desiredIdentity = committed ? journal.vault.after : journal.vault.rollback
      const alreadyDesired = committed ? vaultIdentity === journal.vault.after
        : vaultIdentity === journal.vault.before || vaultIdentity === journal.vault.rollback
      if (alreadyDesired) {
        if ((vault.secrets[journal.connectionId] ?? null) !== targetEntry) throw new Error('Entry mismatch')
      } else {
        const repaired = encodeTransactionVault(replaceTransactionVaultEntry(vault, journal.connectionId, targetEntry))
        if (settingsFileIdentity(repaired) !== desiredIdentity) throw new Error('Unexpected other entries')
        // On a throw-after-replace, successful byte verification still establishes the repair.
        try { await this.writeVault(repaired) } catch { /* Verify actual bytes before classifying. */ }
        if (settingsFileIdentity(await this.io.readBounded(this.vaultPath, VAULT_FILE_MAX_BYTES)) !== desiredIdentity) throw new Error('Repair failed')
      }
      const finalSettings = await this.readSettings(false)
      const finalVault = settingsFileIdentity(await this.io.readBounded(this.vaultPath, VAULT_FILE_MAX_BYTES))
      if (settingsFileIdentity(finalSettings.bytes) !== identity || finalSettings.snapshot.revision !== current.snapshot.revision
        || !(committed ? finalVault === journal.vault.after : finalVault === journal.vault.before || finalVault === journal.vault.rollback)) throw new Error('State changed before cleanup')
      const finalRecord = await this.io.readBounded(this.journalPath, JOURNAL_FILE_MAX_BYTES)
      if (!finalRecord?.equals(record)) throw new Error('Record changed before cleanup')
      try { await this.io.removeFile(this.journalPath) } catch {
        if (await this.io.readBounded(this.journalPath, JOURNAL_FILE_MAX_BYTES) !== null) {
          if (committed && allowCommittedCleanupFailure) return { committed, snapshot: finalSettings.snapshot, cleanupPending: true }
          throw new Error('Cleanup failed')
        }
      }
      return { committed, snapshot: finalSettings.snapshot, cleanupPending: false }
    } catch { throw new SettingsStorageError('SETTINGS_TRANSACTION_RECOVERY_REQUIRED') }
  }
}
