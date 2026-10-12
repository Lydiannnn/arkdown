import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { isCanonicalModelConnectionId } from '../../shared/large-model-settings'

export interface ModelSecretCipher {
  isAvailable(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

export const MODEL_SECRET_KEY_MAX_BYTES = 16 * 1024
export const MODEL_SECRET_CIPHERTEXT_MAX_BYTES = 64 * 1024

/** Main-only preparation for the transaction owner. It does not read or change a vault. */
export function encryptModelSecret(cipher: ModelSecretCipher, apiKey: string): string {
  if (typeof apiKey !== 'string' || Buffer.byteLength(apiKey, 'utf8') > MODEL_SECRET_KEY_MAX_BYTES) {
    throw new ModelSecretVaultError('VAULT_WRITE_FAILED')
  }
  try { if (!cipher.isAvailable()) throw new Error('Unavailable') }
  catch { throw new ModelSecretVaultError('ENCRYPTION_UNAVAILABLE') }
  try {
    const bytes = cipher.encrypt(apiKey)
    if (!bytes.length || bytes.length > MODEL_SECRET_CIPHERTEXT_MAX_BYTES) throw new Error('Invalid encrypted size')
    return bytes.toString('base64')
  } catch { throw new ModelSecretVaultError('VAULT_WRITE_FAILED') }
}

/** Main-only paired read helper. Errors never expose the cipher's error text or material. */
export function decryptModelSecret(cipher: ModelSecretCipher, ciphertext: string): string {
  try { return cipher.decrypt(Buffer.from(ciphertext, 'base64')) }
  catch { throw new ModelSecretVaultError('DECRYPTION_FAILED') }
}

export interface ModelSecretVaultDependencies {
  readTextFile(path: string): Promise<string>
  writeTextFileAtomic(path: string, value: string): Promise<void>
  ensureDirectory(path: string): Promise<void>
  removeFile(path: string): Promise<void>
}

export interface SafeStorageModelSecretCipherSource {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

interface VaultFile {
  version: 1
  secrets: Record<string, string>
}

declare const modelSecretSnapshotBrand: unique symbol

export interface ModelSecretSnapshot {
  readonly [modelSecretSnapshotBrand]: typeof modelSecretSnapshotBrand
}

type ModelSecretVaultErrorCode =
  | 'ENCRYPTION_UNAVAILABLE'
  | 'INVALID_CONNECTION_ID'
  | 'VAULT_MALFORMED'
  | 'VAULT_READ_FAILED'
  | 'VAULT_WRITE_FAILED'
  | 'DECRYPTION_FAILED'

export class ModelSecretVaultError extends Error {
  constructor(readonly code: ModelSecretVaultErrorCode) {
    super(code)
    this.name = 'ModelSecretVaultError'
  }
}

export function createSafeStorageModelSecretCipher(
  safeStorage: SafeStorageModelSecretCipherSource,
): ModelSecretCipher {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  }
}

function defaultDependencies(): ModelSecretVaultDependencies {
  return {
    readTextFile: (filePath) => readFile(filePath, 'utf8'),
    writeTextFileAtomic: (filePath, value) =>
      writeFileAtomic(filePath, value, { encoding: 'utf8', fsync: true }),
    ensureDirectory: async (directory) => { await mkdir(directory, { recursive: true }) },
    removeFile: (filePath) => rm(filePath, { force: true }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBase64(value: string): boolean {
  if (!value) return false
  const decoded = Buffer.from(value, 'base64')
  return decoded.length > 0 && decoded.toString('base64') === value
}

function parseVaultFile(value: unknown): VaultFile | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.secrets)) return null
  if (Reflect.ownKeys(value).some((key) => key !== 'version' && key !== 'secrets')) return null

  const secrets: Record<string, string> = {}
  for (const [connectionId, ciphertext] of Object.entries(value.secrets)) {
    if (
      !isCanonicalModelConnectionId(connectionId) || typeof ciphertext !== 'string' || !isBase64(ciphertext)
    ) return null
    secrets[connectionId] = ciphertext
  }
  return { version: 1, secrets }
}

export class ModelSecretVault {
  readonly filePath: string
  private readonly dependencies: ModelSecretVaultDependencies

  private operationTail = Promise.resolve()
  private readonly snapshotStates = new WeakMap<
    ModelSecretSnapshot, { connectionId: string; ciphertext: string | undefined }
  >()

  constructor(
    private readonly root: string,
    private readonly cipher: ModelSecretCipher,
    dependencies: Partial<ModelSecretVaultDependencies> = {},
  ) {
    this.filePath = path.join(root, 'model-secrets.json')
    this.dependencies = { ...defaultDependencies(), ...dependencies }
  }

  async get(connectionId: string): Promise<string | null> {
    return this.runExclusive(async () => {
      this.assertConnectionId(connectionId)
      const vault = await this.readVault()
      const ciphertext = vault.secrets[connectionId]
      if (ciphertext === undefined) return null

      try {
        return this.cipher.decrypt(Buffer.from(ciphertext, 'base64'))
      } catch {
        throw new ModelSecretVaultError('DECRYPTION_FAILED')
      }
    })
  }

  async set(connectionId: string, apiKey: string): Promise<void> {
    return this.runExclusive(async () => {
      this.assertConnectionId(connectionId)
      if (!this.cipher.isAvailable()) {
        throw new ModelSecretVaultError('ENCRYPTION_UNAVAILABLE')
      }

      let ciphertext: string
      try {
        ciphertext = this.cipher.encrypt(apiKey).toString('base64')
      } catch {
        throw new ModelSecretVaultError('VAULT_WRITE_FAILED')
      }
      if (!isBase64(ciphertext)) throw new ModelSecretVaultError('VAULT_WRITE_FAILED')

      const vault = await this.readVault()
      vault.secrets[connectionId] = ciphertext
      await this.writeVault(vault)
    })
  }

  async delete(connectionId: string): Promise<void> {
    return this.runExclusive(async () => {
      this.assertConnectionId(connectionId)
      const vault = await this.readVault()
      if (!(connectionId in vault.secrets)) return

      delete vault.secrets[connectionId]
      await this.persistVault(vault)
    })
  }

  async snapshot(connectionId: string): Promise<ModelSecretSnapshot> {
    return this.runExclusive(async () => {
      this.assertConnectionId(connectionId)
      const vault = await this.readVault()
      const snapshot = Object.freeze({}) as ModelSecretSnapshot
      this.snapshotStates.set(snapshot, {
        connectionId,
        ciphertext: vault.secrets[connectionId],
      })
      return snapshot
    })
  }

  async restore(snapshot: ModelSecretSnapshot): Promise<void> {
    return this.runExclusive(async () => {
      const state = this.snapshotStates.get(snapshot)
      if (state === undefined) throw new ModelSecretVaultError('VAULT_WRITE_FAILED')
      const vault = await this.readVault()
      if (state.ciphertext === undefined) {
        delete vault.secrets[state.connectionId]
      } else {
        vault.secrets[state.connectionId] = state.ciphertext
      }
      await this.persistVault(vault)
      this.snapshotStates.delete(snapshot)
    })
  }

  private async persistVault(vault: VaultFile): Promise<void> {
    if (Object.keys(vault.secrets).length === 0) {
      try {
        await this.dependencies.removeFile(this.filePath)
      } catch {
        throw new ModelSecretVaultError('VAULT_WRITE_FAILED')
      }
      return
    }
    return this.writeVault(vault)
  }

  private assertConnectionId(connectionId: string): void {
    if (!isCanonicalModelConnectionId(connectionId)) throw new ModelSecretVaultError('INVALID_CONNECTION_ID')
  }

  private async readVault(): Promise<VaultFile> {
    let source: string
    try {
      source = await this.dependencies.readTextFile(this.filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, secrets: {} }
      throw new ModelSecretVaultError('VAULT_READ_FAILED')
    }

    try {
      const vault = parseVaultFile(JSON.parse(source) as unknown)
      if (!vault) throw new Error('Malformed vault')
      return vault
    } catch {
      throw new ModelSecretVaultError('VAULT_MALFORMED')
    }
  }

  private async writeVault(vault: VaultFile): Promise<void> {
    try {
      await this.dependencies.ensureDirectory(this.root)
      await this.dependencies.writeTextFileAtomic(this.filePath, `${JSON.stringify(vault, null, 2)}\n`)
    } catch {
      throw new ModelSecretVaultError('VAULT_WRITE_FAILED')
    }
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.operationTail = tail
    return result
  }
}
