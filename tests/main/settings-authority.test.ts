import { describe, expect, it, vi } from 'vitest'
import { createSettingsTransactionSnapshot } from '../../src/main/settings/settings-transaction-schema'
import type { SettingsTransactionSnapshot } from '../../src/main/settings/settings-transaction-types'
import type { SettingsStorageResult } from '../../src/main/settings/settings-transaction-store'
import { SettingsAuthority } from '../../src/main/settings/settings-authority'
import { reduceSettingsTransaction } from '../../src/main/settings/settings-transaction-reducer'
import type { AppSettings } from '../../src/main/settings/settings-store'
import type { SettingsTransactionRequest } from '../../src/main/settings/settings-transaction-types'

const snapshot = (revision: number, workspace: string | null = null): SettingsTransactionSnapshot => ({
  ...createSettingsTransactionSnapshot({ lastWorkspace: workspace }), revision,
})

function reducerAuthority(settings: Partial<AppSettings> = {}) {
  let current = createSettingsTransactionSnapshot({ lastWorkspace: null, ...settings })
  const apply = vi.fn(async (input: SettingsTransactionRequest): Promise<SettingsStorageResult> => {
    const result = reduceSettingsTransaction(current, input)
    if (result.status !== 'prepared') return result
    current = result.snapshot
    return { status: 'committed', snapshot: current, cleanupPending: false }
  })
  const port = {
    readSnapshot: vi.fn(async () => structuredClone(current)), apply,
    readModelExecutionSnapshot: async () => { throw new Error('unused') },
    encryptCredential: () => { throw new Error('unused') },
    admitModelExecution: async <T>(_expected: unknown, _target: unknown, start: () => { completion: Promise<T> }) => start(),
  }
  return { authority: new SettingsAuthority(port), port, current: () => current,
    remote: (next: SettingsTransactionSnapshot) => { current = structuredClone(next) } }
}

describe('finite main settings writes', () => {
  it('merges explicit LWW fields into the locked latest state even after metadata pruning', async () => {
    const test = reducerAuthority({ lastWorkspace: 'old', fontDefaultsVersion: 3 })
    test.remote({ ...test.current(), revision: 4000, minimumBaseRevision: 3990 })
    await test.authority.saveWindowBounds({ width: 900, height: 700 })
    await test.authority.saveWorkspace('new')
    await test.authority.saveFolderPickerDirectory('C:/picked')
    expect(test.current().settings).toMatchObject({ lastWorkspace: 'new', fontDefaultsVersion: 3,
      windowBounds: { width: 900, height: 700 }, lastFolderPickerPath: 'C:/picked' })
    expect(test.port.readSnapshot).not.toHaveBeenCalled()
    expect(test.port.apply.mock.calls.every(([input]) => input.baseRevision === 0)).toBe(true)
    await test.authority.saveWindowBounds(undefined)
    await test.authority.saveFolderPickerDirectory(undefined)
    expect(test.current().settings.windowBounds).toBeUndefined()
    expect(test.current().settings.lastFolderPickerPath).toBeUndefined()
    expect(test.current().settings.lastWorkspace).toBe('new')
  })

  it('acknowledges cleanup-pending commits but rejects invalid or conflicted writes', async () => {
    const { authority, port } = fixture([snapshot(1)])
    port.apply.mockResolvedValueOnce({ status: 'committed', snapshot: snapshot(1), cleanupPending: true })
    await expect(authority.saveWorkspace('saved')).resolves.toBeUndefined()
    port.apply.mockResolvedValueOnce({ status: 'invalid', reason: 'invalid-value' })
    await expect(authority.saveWindowBounds({ width: 1, height: 1 })).rejects.toThrow('SETTINGS_COMMAND_INVALID')
    port.apply.mockResolvedValueOnce({ status: 'conflict', reason: 'snapshot-too-old', fields: [], snapshot: snapshot(2) })
    await expect(authority.recordApplicationStart('1.0.4')).rejects.toThrow('SETTINGS_COMMAND_CONFLICT')
    expect(port.apply).toHaveBeenCalledTimes(3)
  })

  it('migrates under finite commands once while preserving workspace', async () => {
    const test = reducerAuthority({ lastWorkspace: 'preserved' })
    const first = await test.authority.migrateStartupSettings()
    const second = await test.authority.migrateStartupSettings()
    expect(first.settings).toMatchObject({ lastWorkspace: 'preserved', fontDefaultsVersion: 3 })
    expect(second).toEqual(first)
    expect(test.port.apply.mock.calls[0]?.[0].operations.map(operation => operation.kind))
      .toEqual(['migration.font-defaults', 'migration.floating-translation'])
  })

  it('guards completion of a startup offer with its original persisted revision across ABA', async () => {
    const test = reducerAuthority({ defaultApplicationsPrompt: { starts: 2, handled: false, version: '1.0.4' } })
    const offer = await test.authority.recordApplicationStart('1.0.4')
    await test.authority.recordApplicationStart('1.0.5')
    await test.authority.recordApplicationStart('1.0.4')
    await expect(test.authority.markApplicationOfferHandled(offer)).rejects.toThrow('SETTINGS_COMMAND_CONFLICT')
    expect(test.current().settings.defaultApplicationsPrompt?.handled).toBe(false)
  })

  it('persists the independent close offer without consuming the second-start reminder', async () => {
    const test = reducerAuthority()
    const first = await test.authority.recordApplicationStart('1.0.4')
    await test.authority.markApplicationCloseOfferHandled(first)
    expect(test.current().settings.defaultApplicationsPrompt).toMatchObject({ starts: 1, handled: false, closeHandled: true })
    const second = await test.authority.recordApplicationStart('1.0.4')
    expect(second.settings.defaultApplicationsPrompt).toMatchObject({ starts: 2, handled: false, closeHandled: true })
    await test.authority.markApplicationOfferHandled(second)
    expect(test.current().settings.defaultApplicationsPrompt).toMatchObject({ handled: true, closeHandled: true })
    const upgraded = await test.authority.recordApplicationStart('1.0.5')
    expect(upgraded.settings.defaultApplicationsPrompt?.handled).toBe(false)
    expect(upgraded.settings.defaultApplicationsPrompt?.closeHandled).not.toBe(true)
    await expect(test.authority.markApplicationCloseOfferHandled(second)).rejects.toThrow('SETTINGS_COMMAND_CONFLICT')
  })

  it('does not replay an automatic command after an unknown storage failure', async () => {
    const { authority, port } = fixture()
    port.apply.mockRejectedValueOnce(new Error('unknown commit'))
    await expect(authority.recordApplicationStart('1.0.4')).rejects.toThrow('unknown commit')
    expect(port.apply).toHaveBeenCalledOnce()
  })
})
const request = { baseRevision: 0, operations: [{ kind: 'workspace.set' as const, value: 'requested', mode: 'last-writer-wins' as const }] }
function fixture(reads: SettingsTransactionSnapshot[] = [snapshot(0)]) {
  const port = {
    readModelExecutionSnapshot: vi.fn(async () => { throw new Error('unused') }),
    encryptCredential: vi.fn(() => { throw new Error('unused') }),
    admitModelExecution: async <T>(_expected: unknown, _target: unknown, start: () => { completion: Promise<T> }) => start(),
    readSnapshot: vi.fn(async () => reads.shift()!),
    apply: vi.fn(async (): Promise<SettingsStorageResult> => ({ status: 'committed', snapshot: snapshot(1, 'requested'), cleanupPending: false })),
  }
  return { authority: new SettingsAuthority(port), port }
}

describe('authoritative settings cache adoption', () => {
  it('requires a verified first read and gives callers independent display copies', async () => {
    const { authority } = fixture([snapshot(3, 'remote')])
    expect(() => authority.getDisplaySnapshot()).toThrow('SETTINGS_AUTHORITY_NOT_READY')
    const read = await authority.readFresh()
    read.settings.lastWorkspace = 'caller-mutated'
    authority.getDisplaySnapshot().fieldRevisions.fields.lastWorkspace = 99
    expect(authority.getDisplaySnapshot()).toMatchObject({ revision: 3, settings: { lastWorkspace: 'remote' } })
    expect(authority.getDisplaySnapshot().fieldRevisions.fields.lastWorkspace).toBeUndefined()
  })

  it('adopts a conflict snapshot with unrelated remote changes and does not publish the rejected proposal', async () => {
    const { authority, port } = fixture()
    await authority.readFresh()
    port.apply.mockResolvedValueOnce({ status: 'conflict', reason: 'field-changed', fields: [], snapshot: snapshot(8, 'remote') })
    const listener = vi.fn()
    authority.subscribe(listener)
    expect(await authority.apply(request)).toMatchObject({ status: 'conflict' })
    expect(authority.getDisplaySnapshot().settings.lastWorkspace).toBe('remote')
    expect(listener).toHaveBeenCalledOnce()
  })

  it('keeps acknowledged commits when a notification throws, including cleanup-pending', async () => {
    const { authority, port } = fixture()
    await authority.readFresh()
    authority.subscribe(() => { throw new Error('listener') })
    const notified = vi.fn()
    authority.subscribe(notified)
    port.apply.mockResolvedValueOnce({ status: 'committed', snapshot: snapshot(2, 'saved'), cleanupPending: true })
    expect(await authority.apply(request)).toMatchObject({ status: 'committed', cleanupPending: true })
    expect(authority.getDisplaySnapshot().settings.lastWorkspace).toBe('saved')
    expect(notified).toHaveBeenCalledOnce()
    expect(port.apply).toHaveBeenCalledOnce()
  })

  it('rejects a regressed disk revision and does not duplicate a published revision on repeated reads', async () => {
    const { authority } = fixture([snapshot(5, 'latest'), snapshot(4, 'older'), snapshot(5, 'latest'), snapshot(6, 'newest')])
    const revisions: number[] = []
    authority.subscribe((value: SettingsTransactionSnapshot) => revisions.push(value.revision))
    await authority.readFresh()
    await expect(authority.readFresh()).rejects.toThrow('SETTINGS_AUTHORITY_REVISION_REGRESSED')
    await authority.readFresh()
    await authority.readFresh()
    expect(revisions).toEqual([5, 6])
    expect(authority.getDisplaySnapshot().settings.lastWorkspace).toBe('newest')
  })

  it('fails closed when the same persisted revision is reused for different values', async () => {
    const { authority } = fixture([snapshot(3, 'original'), snapshot(3, 'unversioned')])
    await authority.readFresh()
    await expect(authority.readFresh()).rejects.toThrow('SETTINGS_AUTHORITY_REVISION_REUSED')
    expect(authority.getDisplaySnapshot().settings.lastWorkspace).toBe('original')
  })

  it('never adopts a failed proposal and continues scheduling subsequent healthy work', async () => {
    const { authority, port } = fixture()
    await authority.readFresh()
    port.apply.mockRejectedValueOnce(new Error('storage failed'))
    await expect(authority.apply(request)).rejects.toThrow('storage failed')
    expect(authority.getDisplaySnapshot().revision).toBe(0)
    expect(await authority.apply(request)).toMatchObject({ status: 'committed' })
    expect(authority.getDisplaySnapshot().revision).toBe(1)
  })

  it('serializes a read and write without exposing the proposal early', async () => {
    const { authority, port } = fixture()
    let release!: (value: SettingsTransactionSnapshot) => void
    port.readSnapshot.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const reading = authority.readFresh()
    const applying = authority.apply(request)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(port.apply).not.toHaveBeenCalled()
    release(snapshot(0))
    await reading
    await applying
    expect(authority.getDisplaySnapshot().revision).toBe(1)
  })

  it('captures the submitted intent before queued work waits for a prior read', async () => {
    const { authority, port } = fixture()
    let release!: (value: SettingsTransactionSnapshot) => void
    port.readSnapshot.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const reading = authority.readFresh()
    const submitted = { ...request, operations: [{ ...request.operations[0]!, value: 'intended' }] }
    const applying = authority.apply(submitted)
    submitted.operations[0]!.value = 'later draft'
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release(snapshot(0))
    await reading
    await applying
    expect(port.apply).toHaveBeenCalledWith({ ...request, operations: [{ ...request.operations[0]!, value: 'intended' }] }, undefined)
  })

  it('rejects queued work that has not begun when the authority is disposed', async () => {
    const { authority, port } = fixture()
    let release!: (value: SettingsTransactionSnapshot) => void
    port.readSnapshot.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const reading = authority.readFresh()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const applying = authority.apply(request)
    const rejected = expect(applying).rejects.toThrow('SETTINGS_AUTHORITY_DISPOSED')
    authority.dispose()
    release(snapshot(0)); await reading; await rejected
    expect(port.apply).not.toHaveBeenCalled()
  })
})
