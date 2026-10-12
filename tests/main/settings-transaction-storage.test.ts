import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_LARGE_MODEL_SETTINGS, type ModelConnectionSummary } from '../../src/shared/large-model-settings'
import type { SettingsTransactionRequest } from '../../src/main/settings/settings-transaction-types'
import type { ExpectedModelTestInputs } from '../../src/main/settings/settings-transaction-types'
import { CONNECTION_TEST_FIELDS } from '../../src/main/settings/settings-transaction-schema'
import { SettingsTransactionStore } from '../../src/main/settings/settings-transaction-store'
import { SettingsAuthority } from '../../src/main/settings/settings-authority'
import { parseSettingsJson, readSettingsFileBounded } from '../../src/main/settings/settings-transaction-files'
import { encryptModelSecret } from '../../src/main/models/model-secret-vault'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const id = '550e8400-e29b-41d4-a716-446655440000'
const otherId = '550e8400-e29b-41d4-a716-446655440001'
const cipher = { isAvailable: () => true, encrypt: (value: string) => Buffer.from(`synthetic:${value}`), decrypt: (value: Buffer) => value.toString().replace(/^synthetic:/, '') }
const connection: ModelConnectionSummary = { id, name: 'Synthetic', provider: 'other', accessType: 'standard-api', protocol: 'openai', baseUrl: 'https://example.com/v1', modelId: 'synthetic', apiKeyHint: '••••test', status: 'untested', lastTestedAt: null, capabilityOverride: null }
const add: SettingsTransactionRequest = { baseRevision: 0, operations: [{ kind: 'model-connection.add', connection, expectedAbsentRevision: 0 }] }
const ciphertext = cipher.encrypt('new-test-key').toString('base64')
const credential = { id, ciphertext }
type Hooks = { writeAtomic?: (file: string, bytes: Buffer) => Promise<void>; removeFile?: (file: string) => Promise<void> }
async function fixture(hooks: Hooks = {}, existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(path.join(tmpdir(), 'arkdown-transaction-'))
  if (!existingRoot) roots.push(root)
  return { root, store: new SettingsTransactionStore(root, cipher, hooks) }
}
const atomicOptions = { fsync: true, mode: 0o600 }
const atomic = (file: string, bytes: Buffer) => writeFileAtomic(file, bytes, atomicOptions)

describe('settings transaction storage with real synthetic files', () => {
  it('claims the workspace introduction once across owners and preserves it after restart', async () => {
    const { root, store } = await fixture()
    const first = new SettingsAuthority(store), second = new SettingsAuthority(new SettingsTransactionStore(root, cipher))
    const claims = await Promise.all([first.claimWorkspaceIntroduction(false), second.claimWorkspaceIntroduction(false)])
    expect(claims.filter(value => value.showIntroduction)).toHaveLength(1)
    await second.saveWorkspace('C:/synthetic/workspace')
    const restarted = new SettingsAuthority(new SettingsTransactionStore(root, cipher))
    expect(await restarted.claimWorkspaceIntroduction(false)).toEqual({ showIntroduction: false })
    expect((await restarted.readFresh()).settings).toMatchObject({ workspaceIntroSeen: true, lastWorkspace: 'C:/synthetic/workspace' })
  })
  it('migrates a legacy intro marker without showing and keeps failed marking retryable', async () => {
    const migrated = new SettingsAuthority((await fixture()).store)
    expect(await migrated.claimWorkspaceIntroduction(true)).toEqual({ showIntroduction: false })
    expect(await migrated.claimWorkspaceIntroduction(false)).toEqual({ showIntroduction: false })
    let denied = true
    const { store } = await fixture({ writeAtomic: async (file, bytes) => { if (denied) throw new Error('denied'); await atomic(file, bytes) } })
    const first = new SettingsAuthority(store)
    await expect(first.claimWorkspaceIntroduction(false)).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_WRITE_FAILED' })
    expect((await store.readSnapshot()).settings.workspaceIntroSeen).not.toBe(true)
    denied = false
    expect(await first.claimWorkspaceIntroduction(false)).toEqual({ showIntroduction: true })
  })
  it('commits settings and ciphertext together and returns a paired authoritative snapshot', async () => {
    const { root, store } = await fixture()
    expect(await store.apply(add, credential)).toMatchObject({ status: 'committed', cleanupPending: false, snapshot: { revision: 1 } })
    const paired = await store.readModelExecutionSnapshot({ connectionId: id })
    expect(paired.connection).toEqual(connection)
    expect(paired.apiKey).toBe('new-test-key')
    expect(paired.snapshot.fieldRevisions.connections[id]?.credential).toBe(1)
    const text = await readFile(path.join(root, 'settings.json'), 'utf8')
    expect(JSON.parse(text)._settingsTransaction.revision).toBe(1)
    expect(text).not.toContain(ciphertext)
    expect(text).not.toContain('new-test-key')
    expect(await readdir(root)).not.toContain('model-settings.pending.json')
  })

  it('merges independently loaded owners using latest disk settings and one existing lock', async () => {
    const { root, store } = await fixture()
    const { store: second } = await fixture({}, root)
    await second.apply(add, credential)
    await store.apply({ baseRevision: 0, operations: [{ kind: 'window-bounds.set', value: { width: 900, height: 700 }, mode: 'last-writer-wins' }] })
    expect(await second.readSnapshot()).toMatchObject({ revision: 2, settings: { models: { connections: [connection] }, windowBounds: { width: 900, height: 700 } } })
  })

  it.each(['model-secrets.json', 'settings.json'])('rolls back an uncommitted %s write failure and retains other IDs', async failedName => {
    const { root, store } = await fixture({ writeAtomic: async (file, bytes) => {
      if (path.basename(file) === failedName) throw new Error('synthetic disk failure')
      await atomic(file, bytes)
    } })
    const other = cipher.encrypt('other-key').toString('base64')
    await writeFile(path.join(root, 'model-secrets.json'), JSON.stringify({ version: 1, secrets: { [otherId]: other } }))
    await expect(store.apply(add, credential)).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_WRITE_FAILED' })
    expect(JSON.parse(await readFile(path.join(root, 'model-secrets.json'), 'utf8')).secrets).toEqual({ [otherId]: other })
    await expect(readFile(path.join(root, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(root)).not.toContain('model-settings.pending.json')
  })

  it('classifies settings throw-after-replace as committed without rolling credentials back', async () => {
    const { root, store } = await fixture({ writeAtomic: async (file, bytes) => { await atomic(file, bytes); if (path.basename(file) === 'settings.json') throw new Error('after replace') } })
    expect(await store.apply(add, credential)).toMatchObject({ status: 'committed', cleanupPending: false })
    const { store: restart } = await fixture({}, root)
    expect((await restart.readModelExecutionSnapshot({ connectionId: id })).apiKey).toBe('new-test-key')
  })

  it.each([false, true])('classifies a journal write failure after replacement=%s without changing the pair', async replaced => {
    const { root, store } = await fixture({ writeAtomic: async (file, bytes) => {
      if (path.basename(file) === 'model-settings.pending.json') {
        if (replaced) await atomic(file, bytes)
        throw new Error('journal failure')
      }
      await atomic(file, bytes)
    } })
    await expect(store.apply(add, credential)).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_WRITE_FAILED' })
    expect(await readdir(root)).toEqual([])
  })

  it('returns committed cleanup-pending and refuses another commit while cleanup remains denied', async () => {
    const { root, store } = await fixture({ removeFile: async file => { if (path.basename(file) === 'model-settings.pending.json') throw new Error('denied'); await rm(file, { force: true }) } })
    expect(await store.apply(add, credential)).toMatchObject({ status: 'committed', cleanupPending: true })
    await expect(store.apply({ baseRevision: 1, operations: [{ kind: 'workspace.set', value: 'next', mode: 'last-writer-wins' }] })).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_RECOVERY_REQUIRED' })
    const { store: restart } = await fixture({}, root)
    expect((await restart.readSnapshot()).revision).toBe(1)
    expect(await readdir(root)).not.toContain('model-settings.pending.json')
  })

  it('recovers interrupted rollback with a BOM legacy vault without storing the full vault in the journal', async () => {
    let denyRollback = true
    const { root, store } = await fixture({ writeAtomic: async (file, bytes) => {
      if (path.basename(file) === 'settings.json') throw new Error('settings denied')
      if (path.basename(file) === 'model-secrets.json' && !bytes.toString().includes(ciphertext) && denyRollback) { await atomic(file, bytes); throw new Error('interrupted rollback after replace') }
      await atomic(file, bytes)
    }, removeFile: async file => { if (path.basename(file) === 'model-settings.pending.json' && denyRollback) throw new Error('cleanup denied'); await rm(file, { force: true }) } })
    const other = cipher.encrypt('other-key').toString('base64')
    await writeFile(path.join(root, 'model-secrets.json'), '\uFEFF' + JSON.stringify({ version: 1, secrets: { [otherId]: other } }, null, 3))
    await expect(store.apply(add, credential)).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_RECOVERY_REQUIRED' })
    const pending = await readFile(path.join(root, 'model-settings.pending.json'), 'utf8')
    expect(pending).not.toContain(other)
    expect(pending).not.toContain('other-key')
    denyRollback = false
    const { store: restart } = await fixture({}, root)
    expect((await restart.readSnapshot()).revision).toBe(0)
    expect(JSON.parse(await readFile(path.join(root, 'model-secrets.json'), 'utf8')).secrets).toEqual({ [otherId]: other })
  })

  it('fails closed and preserves pending evidence for an unknown vault state', async () => {
    const { root, store } = await fixture({ removeFile: async file => { if (path.basename(file) === 'model-settings.pending.json') throw new Error('cleanup denied'); await rm(file, { force: true }) } })
    await store.apply(add, credential)
    await writeFile(path.join(root, 'model-secrets.json'), JSON.stringify({ version: 1, secrets: { [otherId]: ciphertext } }))
    const bytes = await readFile(path.join(root, 'model-secrets.json'))
    const { store: restart } = await fixture({}, root)
    await expect(restart.readSnapshot()).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_RECOVERY_REQUIRED' })
    expect(await readFile(path.join(root, 'model-secrets.json'))).toEqual(bytes)
    expect(await readdir(root)).toContain('model-settings.pending.json')
  })

  it('preserves the pending pair when settings no longer match either recorded byte identity', async () => {
    const unexpected = Buffer.from(JSON.stringify({ lastWorkspace: 'external-update' }))
    const { root, store } = await fixture({ writeAtomic: async (file, bytes) => {
      if (path.basename(file) === 'settings.json') { await atomic(file, unexpected); throw new Error('external state') }
      await atomic(file, bytes)
    } })
    await expect(store.apply(add, credential)).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_RECOVERY_REQUIRED' })
    const vault = await readFile(path.join(root, 'model-secrets.json'))
    const pending = await readFile(path.join(root, 'model-settings.pending.json'))
    const { store: restart } = await fixture({}, root)
    await expect(restart.readModelExecutionSnapshot({ connectionId: id })).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_RECOVERY_REQUIRED' })
    expect(await readFile(path.join(root, 'settings.json'))).toEqual(unexpected)
    expect(await readFile(path.join(root, 'model-secrets.json'))).toEqual(vault)
    expect(await readFile(path.join(root, 'model-settings.pending.json'))).toEqual(pending)
  })

  it('preserves malformed settings with a bounded deterministic backup and never overwrites them', async () => {
    const { root, store } = await fixture()
    const bytes = Buffer.from('{malformed')
    await writeFile(path.join(root, 'settings.json'), bytes)
    await expect(store.apply(add, credential)).rejects.toMatchObject({ code: 'SETTINGS_STORAGE_MALFORMED' })
    await expect(store.readSnapshot()).rejects.toMatchObject({ code: 'SETTINGS_STORAGE_MALFORMED' })
    expect(await readFile(path.join(root, 'settings.json'))).toEqual(bytes)
    expect((await readdir(root)).filter(name => name.startsWith('settings.transaction-corrupt-'))).toHaveLength(1)
  })

  it('rejects missing/mismatched ciphertext proposals and orphan-key overwrites before mutation', async () => {
    const { root, store } = await fixture()
    await expect(store.apply(add)).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_CREDENTIAL_REQUIRED' })
    await expect(store.apply(add, { id: otherId, ciphertext })).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_CREDENTIAL_REQUIRED' })
    await writeFile(path.join(root, 'model-secrets.json'), JSON.stringify({ version: 1, secrets: { [id]: ciphertext } }))
    await expect(store.apply(add, credential)).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_CREDENTIAL_REQUIRED' })
    expect(await readdir(root)).not.toContain('model-settings.pending.json')
  })

  it('reads BOM legacy model settings without changing files until an explicit write', async () => {
    const { root, store } = await fixture()
    const source = '\uFEFF' + JSON.stringify({ lastWorkspace: 'legacy', models: { ...structuredClone(DEFAULT_LARGE_MODEL_SETTINGS), connections: [connection] } })
    await writeFile(path.join(root, 'settings.json'), source)
    expect(await store.readSnapshot()).toMatchObject({ revision: 0, settings: { lastWorkspace: 'legacy' } })
    expect(await readFile(path.join(root, 'settings.json'), 'utf8')).toBe(source)
  })

  it('rolls forward a committed record when the vault is still at its exact old state', async () => {
    const { root, store } = await fixture({ removeFile: async file => { if (path.basename(file) === 'model-settings.pending.json') throw new Error('cleanup denied'); await rm(file, { force: true }) } })
    const before = Buffer.from('\uFEFF' + JSON.stringify({ version: 1, secrets: { [otherId]: cipher.encrypt('other').toString('base64') } }, null, 3))
    await writeFile(path.join(root, 'model-secrets.json'), before)
    await store.apply(add, credential)
    await writeFile(path.join(root, 'model-secrets.json'), before)
    const { store: restart } = await fixture({}, root)
    expect((await restart.readModelExecutionSnapshot({ connectionId: id })).apiKey).toBe('new-test-key')
    expect(JSON.parse(await readFile(path.join(root, 'model-secrets.json'), 'utf8')).secrets[otherId]).toBe(cipher.encrypt('other').toString('base64'))
  })

  it('restores an undecryptable old key after an interrupted last-entry delete, then deletes successfully', async () => {
    let denySettings = true
    const { root, store } = await fixture({ writeAtomic: async (file, bytes) => { if (path.basename(file) === 'settings.json' && denySettings) throw new Error('denied'); await atomic(file, bytes) } })
    const old = Buffer.from('opaque-unavailable-cipher').toString('base64')
    await writeFile(path.join(root, 'settings.json'), JSON.stringify({ lastWorkspace: null, models: { ...structuredClone(DEFAULT_LARGE_MODEL_SETTINGS), connections: [connection] } }))
    await writeFile(path.join(root, 'model-secrets.json'), '\uFEFF' + JSON.stringify({ version: 1, secrets: { [id]: old } }, null, 3))
    const request: SettingsTransactionRequest = { baseRevision: 0, operations: [{ kind: 'model-connection.remove', id, expected: { value: connection, revision: 0 }, expectedCredentialRevision: 0 }] }
    await expect(store.apply(request, { id, ciphertext: null })).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_WRITE_FAILED' })
    expect(JSON.parse(await readFile(path.join(root, 'model-secrets.json'), 'utf8')).secrets[id]).toBe(old)
    denySettings = false
    expect(await store.apply(request, { id, ciphertext: null })).toMatchObject({ status: 'committed', snapshot: { revision: 1 } })
    await expect(readFile(path.join(root, 'model-secrets.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await store.readSnapshot()).fieldRevisions.tombstones[id]).toBe(1)
  })

  it('uses the current feature binding and matching key in one authoritative read', async () => {
    const { root, store } = await fixture()
    await store.apply(add, credential)
    const { store: second } = await fixture({}, root)
    await second.apply({ baseRevision: 1, operations: [{ kind: 'model-feature.patch', feature: 'aiConversation', changes: { connectionId: { value: id, expected: { value: null, revision: 0 } } } }] })
    const paired = await store.readModelExecutionSnapshot({ feature: 'aiConversation' })
    expect(paired.connection.id).toBe(id)
    expect(paired.apiKey).toBe('new-test-key')
    expect(paired.featurePreferences).toMatchObject({ connectionId: id })
    expect(paired.snapshot.revision).toBe(2)
  })

  it.each([Buffer.from('{broken'), Buffer.alloc(256 * 1024 + 1, 32)])('preserves malformed or oversized pending files and refuses both reads and writes', async record => {
    const { root, store } = await fixture()
    await writeFile(path.join(root, 'model-settings.pending.json'), record)
    await expect(store.readSnapshot()).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_RECOVERY_REQUIRED' })
    await expect(store.apply(add, credential)).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_RECOVERY_REQUIRED' })
    expect(await readFile(path.join(root, 'model-settings.pending.json'))).toEqual(record)
    await expect(readFile(path.join(root, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('bounds file reads and rejects invalid UTF-8 without overwriting it', async () => {
    const { root, store } = await fixture()
    const file = path.join(root, 'settings.json')
    await writeFile(file, Buffer.alloc(65))
    await expect(readSettingsFileBounded(file, 64)).rejects.toMatchObject({ code: 'SETTINGS_STORAGE_TOO_LARGE' })
    expect((await readSettingsFileBounded(file, 65))?.length).toBe(65)
    const invalid = Buffer.from([0xff, 0x7b, 0x7d])
    await writeFile(file, invalid)
    await expect(store.readSnapshot()).rejects.toMatchObject({ code: 'SETTINGS_STORAGE_MALFORMED' })
    expect(await readFile(file)).toEqual(invalid)
  })

  it('rejects corrupt provided model settings rather than defaulting the model catalog', async () => {
    const { root, store } = await fixture()
    const source = JSON.stringify({ lastWorkspace: 'preserve', models: { version: 6, connections: 'invalid' } })
    await writeFile(path.join(root, 'settings.json'), source)
    await expect(store.apply({ baseRevision: 0, operations: [{ kind: 'workspace.set', value: 'overwrite', mode: 'last-writer-wins' }] })).rejects.toMatchObject({ code: 'SETTINGS_STORAGE_MALFORMED' })
    expect(await readFile(path.join(root, 'settings.json'), 'utf8')).toBe(source)
  })

  it('prepares bounded ciphertext and suppresses all cipher availability/encryption error details', () => {
    expect(() => encryptModelSecret(cipher, '界'.repeat(6000))).toThrowError('VAULT_WRITE_FAILED')
    expect(() => encryptModelSecret({ ...cipher, encrypt: () => Buffer.alloc(65537) }, 'small')).toThrowError('VAULT_WRITE_FAILED')
    expect(() => encryptModelSecret({ ...cipher, isAvailable: () => { throw new Error('private-availability-detail') } }, 'small')).toThrowError('ENCRYPTION_UNAVAILABLE')
    expect(() => encryptModelSecret({ ...cipher, encrypt: () => { throw new Error('private-key-detail') } }, 'small')).toThrowError('VAULT_WRITE_FAILED')
  })

  it('rejects duplicate semantic journal fields and preserves the ambiguous record', async () => {
    const { root, store } = await fixture({ removeFile: async file => { if (path.basename(file) === 'model-settings.pending.json') throw new Error('denied'); await rm(file, { force: true }) } })
    await store.apply(add, credential)
    const journalPath = path.join(root, 'model-settings.pending.json')
    const duplicate = (await readFile(journalPath, 'utf8')).replace('"version": 1', '"version": 1, "\\u0076ersion": 1')
    await writeFile(journalPath, duplicate)
    const { store: restart } = await fixture({}, root)
    await expect(restart.readSnapshot()).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_RECOVERY_REQUIRED' })
    expect(await readFile(journalPath, 'utf8')).toBe(duplicate)
  })

  it('distinguishes repeated nested keys from duplicates and ignores punctuation inside strings', () => {
    const valid = { a: { key: 'braces {} [] \\" : , \\u0061' }, b: [{ key: 'other' }], 'escaped"key': '\\\\' }
    expect(parseSettingsJson(Buffer.from('\uFEFF' + JSON.stringify(valid)))).toEqual(valid)
    expect(() => parseSettingsJson(Buffer.from('{"a":{"key":1,"\\u006bey":2}}'))).toThrowError('SETTINGS_STORAGE_MALFORMED')
  })

  it('conditionally restores a replaced key without decrypting/replaying a probe', async () => {
    let denySettings = false
    const { root, store } = await fixture({ writeAtomic: async (file, bytes) => { if (path.basename(file) === 'settings.json' && denySettings) throw new Error('denied'); await atomic(file, bytes) } })
    await store.apply(add, credential)
    const observed = await store.readSnapshot()
    const beforeConnection = observed.settings.models!.connections[0]!
    const revisions = observed.fieldRevisions.connections[id]!
    const testedInputs = { ...Object.fromEntries(CONNECTION_TEST_FIELDS.map(field => [field, { value: beforeConnection[field], revision: revisions[field] ?? 0 }])), credentialRevision: revisions.credential ?? 0 } as ExpectedModelTestInputs
    const request: SettingsTransactionRequest = { baseRevision: observed.revision, operations: [{ kind: 'model-connection.patch', id, changes: {}, testedInputs, credential: { kind: 'replace', expectedRevision: 1 } }] }
    denySettings = true
    await expect(store.apply(request, { id, ciphertext: cipher.encrypt('replacement').toString('base64') })).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_WRITE_FAILED' })
    expect((await store.readModelExecutionSnapshot({ connectionId: id })).apiKey).toBe('new-test-key')
    expect((await store.readSnapshot()).revision).toBe(1)
    denySettings = false
    await store.apply(request, { id, ciphertext: cipher.encrypt('replacement').toString('base64') })
    const { store: restart } = await fixture({}, root)
    expect((await restart.readModelExecutionSnapshot({ connectionId: id })).apiKey).toBe('replacement')
    expect((await restart.readSnapshot()).fieldRevisions.connections[id]?.credential).toBe(2)
  })

  it('serializes simultaneous owners changing different IDs without losing either key', async () => {
    const { root, store } = await fixture()
    const { store: second } = await fixture({}, root)
    await Promise.all([store.apply(add, credential), second.apply({ baseRevision: 0, operations: [{ kind: 'model-connection.add', connection: { ...connection, id: otherId }, expectedAbsentRevision: 0 }] }, { id: otherId, ciphertext: cipher.encrypt('second').toString('base64') })])
    expect((await store.readSnapshot()).settings.models!.connections.map(item => item.id).sort()).toEqual([id, otherId].sort())
    expect((await second.readModelExecutionSnapshot({ connectionId: id })).apiKey).toBe('new-test-key')
    expect((await store.readModelExecutionSnapshot({ connectionId: otherId })).apiKey).toBe('second')
  })
})
