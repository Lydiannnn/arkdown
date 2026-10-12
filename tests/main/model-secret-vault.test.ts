import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSafeStorageModelSecretCipher,
  ModelSecretVault,
  type ModelSecretCipher,
} from '../../src/main/models/model-secret-vault'

const connectionId = '550e8400-e29b-41d4-a716-446655440000'
const secondConnectionId = '550e8400-e29b-41d4-a716-446655440001'
const roots: string[] = []

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

function cipher(overrides: Partial<ModelSecretCipher> = {}): ModelSecretCipher {
  return {
    isAvailable: () => true,
    encrypt: (value) => Buffer.from(`cipher:${value}`),
    decrypt: (value) => value.toString('utf8').replace(/^cipher:/, ''),
    ...overrides,
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function createVault(testCipher = cipher()): Promise<{ root: string, vault: ModelSecretVault }> {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-model-secrets-'))
  roots.push(root)
  return { root, vault: new ModelSecretVault(root, testCipher) }
}

describe('ModelSecretVault behavior', () => {
  it('round-trips an encrypted API key and removes the vault after its last deletion', async () => {
    const { root, vault } = await createVault()
    await vault.set(connectionId, 'secret-key')

    const vaultPath = path.join(root, 'model-secrets.json')
    const persisted = await readFile(vaultPath, 'utf8')
    expect(JSON.parse(persisted)).toEqual({
      version: 1,
      secrets: { [connectionId]: Buffer.from('cipher:secret-key').toString('base64') },
    })
    expect(persisted).not.toContain('secret-key')
    expect(await vault.get(connectionId)).toBe('secret-key')

    await vault.delete(connectionId)
    await expect(vault.get(connectionId)).resolves.toBeNull()
    await expect(readFile(vaultPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('treats a missing vault file as empty', async () => {
    const { vault } = await createVault()
    await expect(vault.get(connectionId)).resolves.toBeNull()
  })

  it('rejects persistence when Windows encryption is unavailable', async () => {
    const { vault } = await createVault(cipher({ isAvailable: () => false }))
    await expect(vault.set(connectionId, 'secret-key')).rejects.toMatchObject({ code: 'ENCRYPTION_UNAVAILABLE' })
  })

  it('accepts only canonical UUID connection IDs', async () => {
    const { vault } = await createVault()
    await expect(vault.set('connection-1', 'secret-key')).rejects.toMatchObject({ code: 'INVALID_CONNECTION_ID' })
  })

  it('returns a controlled safe error for malformed vault entries', async () => {
    const { root, vault } = await createVault()
    await writeFile(path.join(root, 'model-secrets.json'), '{"version":1,"secrets":{"' + connectionId + '":"not base64!"}}', 'utf8')

    await expect(vault.get(connectionId)).rejects.toMatchObject({ code: 'VAULT_MALFORMED' })
  })

  it('does not log cipher plaintext when decryption fails', async () => {
    const { root, vault } = await createVault(cipher({
      decrypt: () => { throw new Error('cipher refused secret-key') },
    }))
    await writeFile(path.join(root, 'model-secrets.json'), JSON.stringify({
      version: 1,
      secrets: { [connectionId]: Buffer.from('cipher:secret-key').toString('base64') },
    }), 'utf8')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(vault.get(connectionId)).rejects.toMatchObject({ code: 'DECRYPTION_FAILED' })
      await vault.get(connectionId).catch((error: unknown) => {
        expect(String(error)).not.toContain('secret-key')
        expect(String(error)).not.toContain('cipher refused')
      })
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('globally serializes real-vault set mutations for unrelated connection IDs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arkdown-model-secrets-'))
    roots.push(root)
    const vaultPath = path.join(root, 'model-secrets.json')
    await writeFile(vaultPath, '{"version":1,"secrets":{}}', 'utf8')
    const firstReadEntered = deferred()
    const releaseFirstRead = deferred()
    let readCount = 0
    const vault = new ModelSecretVault(root, cipher(), {
      readTextFile: async (filePath) => {
        const source = await readFile(filePath, 'utf8')
        readCount += 1
        if (readCount === 1) {
          firstReadEntered.resolve()
          await releaseFirstRead.promise
        }
        return source
      },
    })

    const firstSet = vault.set(connectionId, 'first-secret')
    await firstReadEntered.promise
    const secondSet = vault.set(secondConnectionId, 'second-secret')
    await flushMicrotasks()
    const readsBeforeRelease = readCount
    releaseFirstRead.resolve()
    await Promise.all([firstSet, secondSet])

    expect(readsBeforeRelease).toBe(1)
    await expect(vault.get(connectionId)).resolves.toBe('first-secret')
    await expect(vault.get(secondConnectionId)).resolves.toBe('second-secret')
  })

  it('globally serializes real-vault set and delete mutations without resurrecting an entry', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arkdown-model-secrets-'))
    roots.push(root)
    const vaultPath = path.join(root, 'model-secrets.json')
    await writeFile(vaultPath, JSON.stringify({
      version: 1,
      secrets: {
        [connectionId]: Buffer.from('cipher:first-old-secret').toString('base64'),
        [secondConnectionId]: Buffer.from('cipher:second-old-secret').toString('base64'),
      },
    }), 'utf8')
    const firstReadEntered = deferred()
    const releaseFirstRead = deferred()
    let readCount = 0
    const vault = new ModelSecretVault(root, cipher(), {
      readTextFile: async (filePath) => {
        const source = await readFile(filePath, 'utf8')
        readCount += 1
        if (readCount === 1) {
          firstReadEntered.resolve()
          await releaseFirstRead.promise
        }
        return source
      },
    })

    const setFirst = vault.set(connectionId, 'first-new-secret')
    await firstReadEntered.promise
    const deleteSecond = vault.delete(secondConnectionId)
    await flushMicrotasks()
    const readsBeforeRelease = readCount
    releaseFirstRead.resolve()
    await Promise.all([setFirst, deleteSecond])

    expect(readsBeforeRelease).toBe(1)
    await expect(vault.get(connectionId)).resolves.toBe('first-new-secret')
    await expect(vault.get(secondConnectionId)).resolves.toBeNull()
  })

  it('queues reads behind an in-progress vault mutation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arkdown-model-secrets-'))
    roots.push(root)
    const vaultPath = path.join(root, 'model-secrets.json')
    await writeFile(vaultPath, JSON.stringify({
      version: 1,
      secrets: {
        [connectionId]: Buffer.from('cipher:old-secret').toString('base64'),
      },
    }), 'utf8')
    const writeEntered = deferred()
    const releaseWrite = deferred()
    const vault = new ModelSecretVault(root, cipher(), {
      writeTextFileAtomic: async (filePath, value) => {
        writeEntered.resolve()
        await releaseWrite.promise
        await writeFile(filePath, value, 'utf8')
      },
    })

    const mutation = vault.set(connectionId, 'new-secret')
    await writeEntered.promise
    let readSettled = false
    const read = vault.get(connectionId).then((value) => {
      readSettled = true
      return value
    })
    await flushMicrotasks()
    const settledBeforeMutation = readSettled
    releaseWrite.resolve()

    await expect(mutation).resolves.toBeUndefined()
    await expect(read).resolves.toBe('new-secret')
    expect(settledBeforeMutation).toBe(false)
  })

  it('snapshots and restores exact opaque ciphertext without decrypting it', async () => {
    const foreignCiphertext = Buffer.from('foreign-ciphertext-bytes').toString('base64')
    const { root, vault } = await createVault(cipher({
      decrypt: (value) => {
        if (value.toString('base64') === foreignCiphertext) {
          throw new Error('foreign ciphertext cannot be decrypted')
        }
        return value.toString('utf8').replace(/^cipher:/, '')
      },
    }))
    const vaultPath = path.join(root, 'model-secrets.json')
    await writeFile(vaultPath, JSON.stringify({
      version: 1,
      secrets: { [connectionId]: foreignCiphertext },
    }), 'utf8')

    const snapshot = await vault.snapshot(connectionId)
    expect(Reflect.ownKeys(snapshot as object)).toEqual([])
    await vault.set(connectionId, 'replacement-secret')
    await expect(vault.get(connectionId)).resolves.toBe('replacement-secret')

    await vault.restore(snapshot)

    const restored = JSON.parse(await readFile(vaultPath, 'utf8')) as {
      secrets: Record<string, string>
    }
    expect(restored.secrets[connectionId]).toBe(foreignCiphertext)
    await expect(vault.get(connectionId)).rejects.toMatchObject({ code: 'DECRYPTION_FAILED' })
  })
})

describe('createSafeStorageModelSecretCipher', () => {
  it('adapts Electron safeStorage without exposing its concrete dependency', () => {
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`safe:${value}`),
      decryptString: (value: Buffer) => value.toString('utf8').replace(/^safe:/, ''),
    }
    const adapter = createSafeStorageModelSecretCipher(safeStorage)

    expect(adapter.isAvailable()).toBe(true)
    expect(adapter.decrypt(adapter.encrypt('secret-key'))).toBe('secret-key')
  })
})
