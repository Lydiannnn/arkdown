import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, open, rm } from 'node:fs/promises'
import writeFileAtomic from 'write-file-atomic'

export const SETTINGS_FILE_MAX_BYTES = 16 * 1024 * 1024
export const VAULT_FILE_MAX_BYTES = 128 * 1024 * 1024
export const JOURNAL_FILE_MAX_BYTES = 256 * 1024
// Keep ciphertext and recovery records under the same controlled file permissions.
export const SETTINGS_ATOMIC_WRITE_OPTIONS = { fsync: true, mode: 0o600 }
export type FileIdentity = string | null
export type SettingsStorageErrorCode = 'SETTINGS_STORAGE_READ_FAILED' | 'SETTINGS_STORAGE_MALFORMED'
  | 'SETTINGS_STORAGE_TOO_LARGE' | 'SETTINGS_TRANSACTION_WRITE_FAILED' | 'SETTINGS_TRANSACTION_RECOVERY_REQUIRED'
  | 'SETTINGS_TRANSACTION_CREDENTIAL_REQUIRED' | 'SETTINGS_TRANSACTION_CONNECTION_MISSING'
  | 'SETTINGS_TRANSACTION_AUTHORITY_CHANGED'
export class SettingsStorageError extends Error {
  constructor(readonly code: SettingsStorageErrorCode) { super(code); this.name = 'SettingsStorageError' }
}
export interface SettingsTransactionFileIO {
  readBounded(file: string, limit: number): Promise<Buffer | null>
  writeAtomic(file: string, bytes: Buffer): Promise<void>
  removeFile(file: string): Promise<void>
  ensureDirectory(root: string): Promise<void>
  backupExclusive(source: string, backup: string): Promise<void>
}

/** Reads at most limit + 1 bytes without trusting stat size or decoding malformed UTF-8 lossily. */
export async function readSettingsFileBounded(file: string, limit: number): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open(file, 'r') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new SettingsStorageError('SETTINGS_STORAGE_READ_FAILED')
  }
  try {
    const chunks: Buffer[] = []
    let total = 0
    while (total <= limit) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (!bytesRead) return Buffer.concat(chunks, total)
      total += bytesRead
      if (total > limit) throw new SettingsStorageError('SETTINGS_STORAGE_TOO_LARGE')
      chunks.push(chunk.subarray(0, bytesRead))
    }
    throw new SettingsStorageError('SETTINGS_STORAGE_TOO_LARGE')
  } catch (error) {
    if (error instanceof SettingsStorageError) throw error
    throw new SettingsStorageError('SETTINGS_STORAGE_READ_FAILED')
  } finally { await handle.close().catch(() => undefined) }
}

export const settingsTransactionFileIO: SettingsTransactionFileIO = {
  readBounded: readSettingsFileBounded,
  writeAtomic: (file, bytes) => writeFileAtomic(file, bytes, SETTINGS_ATOMIC_WRITE_OPTIONS),
  removeFile: file => rm(file, { force: true }),
  ensureDirectory: async root => { await mkdir(root, { recursive: true }) },
  backupExclusive: async (source, backup) => {
    try { await copyFile(source, backup, constants.COPYFILE_EXCL) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  },
}
export function settingsFileIdentity(bytes: Buffer | null): FileIdentity {
  return bytes === null ? null : createHash('sha256').update(bytes).digest('hex')
}
export function parseSettingsJson(bytes: Buffer): unknown {
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
    // JSON.parse establishes grammar first, but silently overwrites duplicate object keys.
    // Inspect string tokens separately so escaped spellings of the same key are also rejected.
    const parsed: unknown = JSON.parse(source)
    const containers: Array<Set<string> | null> = []
    for (let index = 0; index < source.length; index++) {
      const character = source[index]
      if (character === '{') containers.push(new Set<string>())
      else if (character === '[') containers.push(null)
      else if (character === '}' || character === ']') containers.pop()
      else if (character === '"') {
        const start = index++
        while (source[index] !== '"') index += source[index] === '\\' ? 2 : 1
        let next = index + 1
        while (' \t\r\n'.includes(source[next] ?? '\0')) next++
        if (source[next] === ':') {
          const key = JSON.parse(source.slice(start, index + 1)) as string
          const keys = containers[containers.length - 1]
          if (!keys || keys.has(key)) throw new Error('Duplicate JSON key')
          keys.add(key)
        }
      }
    }
    return parsed
  }
  catch { throw new SettingsStorageError('SETTINGS_STORAGE_MALFORMED') }
}
