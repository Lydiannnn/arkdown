import { isCanonicalModelConnectionId, MODEL_CONNECTION_LIMIT } from '../../shared/large-model-settings'
import { MODEL_SECRET_CIPHERTEXT_MAX_BYTES } from '../models/model-secret-vault'
import { hasSettingsKeys, isSettingsRecord, isSettingsRevision } from './settings-transaction-schema'
import { JOURNAL_FILE_MAX_BYTES, parseSettingsJson, SettingsStorageError, type FileIdentity } from './settings-transaction-files'

export interface SettingsCredentialJournal {
  version: 1
  transactionId: string
  connectionId: string
  kind: 'add' | 'replace' | 'remove'
  settingsBefore: { identity: FileIdentity; revision: number }
  settingsAfter: { identity: string; revision: number }
  vault: { before: FileIdentity; rollback: FileIdentity; after: FileIdentity }
  entry: { before: string | null; after: string | null }
}
export interface TransactionVault { version: 1; secrets: Record<string, string> }
export function isTransactionCiphertext(value: unknown): value is string {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(MODEL_SECRET_CIPHERTEXT_MAX_BYTES / 3) * 4) return false
  const bytes = Buffer.from(value, 'base64')
  return bytes.length > 0 && bytes.length <= MODEL_SECRET_CIPHERTEXT_MAX_BYTES && bytes.toString('base64') === value
}
export function decodeTransactionVault(bytes: Buffer | null): TransactionVault {
  if (bytes === null) return { version: 1, secrets: {} }
  const raw = parseSettingsJson(bytes)
  if (!hasSettingsKeys(raw, ['version', 'secrets']) || raw.version !== 1 || !isSettingsRecord(raw.secrets)
    || Object.keys(raw.secrets).length > MODEL_CONNECTION_LIMIT) throw new SettingsStorageError('SETTINGS_STORAGE_MALFORMED')
  for (const [id, ciphertext] of Object.entries(raw.secrets)) {
    if (!isCanonicalModelConnectionId(id) || !isTransactionCiphertext(ciphertext)) throw new SettingsStorageError('SETTINGS_STORAGE_MALFORMED')
  }
  return raw as unknown as TransactionVault
}
export function encodeTransactionVault(vault: TransactionVault): Buffer | null {
  // Match the existing vault's missing-file representation after deleting its last entry.
  if (!Object.keys(vault.secrets).length) return null
  const sorted = { version: 1, secrets: Object.fromEntries(Object.entries(vault.secrets).sort(([left], [right]) => left.localeCompare(right))) }
  const bytes = Buffer.from(`${JSON.stringify(sorted, null, 2)}\n`, 'utf8')
  decodeTransactionVault(bytes)
  return bytes
}
export function replaceTransactionVaultEntry(vault: TransactionVault, id: string, ciphertext: string | null): TransactionVault {
  const secrets = { ...vault.secrets }
  if (ciphertext === null) delete secrets[id]
  else secrets[id] = ciphertext
  return { version: 1, secrets }
}
export function decodeSettingsCredentialJournal(bytes: Buffer): SettingsCredentialJournal {
  const fail = (): never => { throw new SettingsStorageError('SETTINGS_TRANSACTION_RECOVERY_REQUIRED') }
  if (bytes.length > JOURNAL_FILE_MAX_BYTES) return fail()
  let raw: unknown
  try { raw = parseSettingsJson(bytes) } catch { return fail() }
  const identity = (value: unknown): value is FileIdentity => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  if (!hasSettingsKeys(raw, ['version', 'transactionId', 'connectionId', 'kind', 'settingsBefore', 'settingsAfter', 'vault', 'entry'])
    || raw.version !== 1 || typeof raw.transactionId !== 'string' || !isCanonicalModelConnectionId(raw.transactionId)
    || typeof raw.connectionId !== 'string' || !isCanonicalModelConnectionId(raw.connectionId)
    || !['add', 'replace', 'remove'].includes(raw.kind as string)
    || !hasSettingsKeys(raw.settingsBefore, ['identity', 'revision']) || !hasSettingsKeys(raw.settingsAfter, ['identity', 'revision'])
    || !identity(raw.settingsBefore.identity) || !identity(raw.settingsAfter.identity) || raw.settingsAfter.identity === null
    || !isSettingsRevision(raw.settingsBefore.revision) || !isSettingsRevision(raw.settingsAfter.revision)
    || raw.settingsBefore.revision === Number.MAX_SAFE_INTEGER || raw.settingsAfter.revision !== raw.settingsBefore.revision + 1
    || raw.settingsBefore.identity === null && raw.settingsBefore.revision !== 0
    || raw.settingsBefore.identity === raw.settingsAfter.identity
    || !hasSettingsKeys(raw.vault, ['before', 'rollback', 'after']) || !Object.values(raw.vault).every(identity)
    || !hasSettingsKeys(raw.entry, ['before', 'after'])
    || ![raw.entry.before, raw.entry.after].every(value => value === null || isTransactionCiphertext(value))
    || raw.kind === 'add' && raw.entry.before !== null
    || raw.kind === 'remove' && raw.entry.after !== null
    || raw.kind !== 'remove' && raw.entry.after === null
    || raw.entry.before !== null && (raw.vault.before === null || raw.vault.rollback === null)
    || raw.entry.after !== null && raw.vault.after === null) return fail()
  return raw as unknown as SettingsCredentialJournal
}
export function encodeSettingsCredentialJournal(journal: SettingsCredentialJournal): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, 'utf8')
  decodeSettingsCredentialJournal(bytes)
  return bytes
}
