import { expect, it, vi } from 'vitest'
import { SettingsAuthority } from '../../src/main/settings/settings-authority'
import { ShortcutSettingsService } from '../../src/main/settings/shortcut-settings-service'
import { createSettingsTransactionSnapshot } from '../../src/main/settings/settings-transaction-schema'
import { reduceSettingsTransaction } from '../../src/main/settings/settings-transaction-reducer'
import { registerScreenshotTranslationShortcut } from '../../src/main/screenshot-translation/screenshot-shortcut'
import { SCREENSHOT_TRANSLATION_ACCELERATOR } from '../../src/shared/screenshot-translation'
import type { SettingsStorageResult } from '../../src/main/settings/settings-transaction-store'
import type { SettingsTransactionRequest } from '../../src/main/settings/settings-transaction-types'

function fixture() {
  let current = createSettingsTransactionSnapshot({ lastWorkspace: 'preserved' })
  const remote = (request: SettingsTransactionRequest): SettingsStorageResult => {
    const result = reduceSettingsTransaction(current, request)
    if (result.status !== 'prepared') return result
    current = result.snapshot
    return { status: 'committed', snapshot: current, cleanupPending: true }
  }
  const apply = vi.fn(async (request: SettingsTransactionRequest) => remote(request))
  const authority = new SettingsAuthority({ apply, readSnapshot: async () => structuredClone(current),
    readModelExecutionSnapshot: async () => { throw new Error('unused') }, encryptCredential: () => { throw new Error('unused') },
    admitModelExecution: async <T>(_expected: unknown, _target: unknown, start: () => { completion: Promise<T> }) => start() })
  const keys = new Set<string>()
  const register = vi.fn((key: string) => { if (keys.has(key)) return false; keys.add(key); return true })
  const screenshot = registerScreenshotTranslationShortcut({ globalShortcut: { register, isRegistered: key => keys.has(key),
    unregister: key => { keys.delete(key) } }, getOwner: () => undefined, beginCapture: () => {} })
  const broadcast = vi.fn(), refreshMenus = vi.fn()
  const service = new ShortcutSettingsService({ settings: { authority }, screenshot, broadcast, refreshMenus })
  return { service, authority, apply, remote, keys, register, broadcast, refreshMenus, current: () => current }
}

it('merges named stable-action updates from the same observation and preserves other settings', async () => {
  const test = fixture(), observed = await test.service.readObserved()
  await test.service.updateObserved({ observed, change: { id: 'file.save', accelerator: 'Ctrl+Alt+S' } })
  const second = await test.service.updateObserved({ observed, change: { id: 'edit.find', accelerator: 'Ctrl+Alt+F' } })
  expect(second.error).toBeNull()
  expect(second.snapshot.bindings).toEqual({ 'file.save': 'Ctrl+Alt+S', 'edit.find': 'Ctrl+Alt+F' })
  expect(test.current().settings.lastWorkspace).toBe('preserved')
})

it('rejects same-action ABA using the opening observation despite a refreshed service cache', async () => {
  const test = fixture(), observed = await test.service.readObserved()
  await test.service.updateObserved({ observed, change: { id: 'file.save', accelerator: 'Ctrl+Alt+S' } })
  await test.service.updateObserved({ observed: await test.service.readObserved(), change: { id: 'file.save', reset: true } })
  await test.service.readObserved()
  const result = await test.service.updateObserved({ observed, change: { id: 'file.save', accelerator: 'Ctrl+Alt+S' } })
  expect(result.error).toContain('其他窗口')
  expect(result.snapshot.bindings).toEqual({})
})

it('guards all stable actions in reset-all rather than clearing a newly changed remote action', async () => {
  const test = fixture(), observed = await test.service.readObserved()
  await test.service.updateObserved({ observed, change: { id: 'edit.find', accelerator: 'Ctrl+Alt+F' } })
  const result = await test.service.updateObserved({ observed, change: { resetAll: true } })
  expect(result.error).toContain('其他窗口')
  expect(result.snapshot.bindings['edit.find']).toBe('Ctrl+Alt+F')
})

it('rolls back only the reserved native key when the final settings CAS conflicts', async () => {
  const test = fixture(), observed = await test.service.readObserved()
  test.apply.mockImplementationOnce(async request => test.remote(request))
    .mockImplementationOnce(async request => {
      test.remote({ baseRevision: 0, operations: [{ kind: 'shortcuts.patch', changes: {
        'tools.screenshot-translation': { kind: 'set', value: null, expected: { value: undefined, revision: 0 } },
      } }] })
      return test.remote(request)
    })
  const result = await test.service.updateObserved({ observed, change: { id: 'tools.screenshot-translation', accelerator: 'Ctrl+Alt+Q' } })
  expect(result.error).toContain('其他窗口')
  expect([...test.keys]).toEqual([SCREENSHOT_TRANSLATION_ACCELERATOR])
  expect(test.current().settings.shortcuts?.['tools.screenshot-translation']).toBeNull()
  expect(test.broadcast).not.toHaveBeenCalled()
})

it('acknowledges a commit even if menu notification fails and disables the legacy writer', async () => {
  const test = fixture(), observed = await test.service.readObserved()
  test.refreshMenus.mockImplementationOnce(() => { throw new Error('presentation failed') })
  const result = await test.service.updateObserved({ observed, change: { id: 'file.save', accelerator: 'Ctrl+Alt+S' } })
  expect(result.error).toBeNull()
  expect(test.broadcast).toHaveBeenCalledOnce()
  await expect(test.service.update({ id: 'file.save', reset: true })).rejects.toThrow('SHORTCUT_LEGACY_WRITER_DISABLED')
})
