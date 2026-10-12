import { expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/main/settings/settings-store'
import { loadAuthoritativeStartupSettings, loadStartupSettings } from '../../src/main/settings/startup-settings'
import { createSettingsTransactionSnapshot } from '../../src/main/settings/settings-transaction-schema'

it('uses the fallback store and defaults when data-root resolution fails', async () => {
  const reportError = vi.fn()
  const fallbackStore = { load: vi.fn(), save: vi.fn() }
  const createStore = vi.fn(() => fallbackStore)

  const result = await loadStartupSettings(
    {
      executablePath: 'C:\\Arkdown.exe',
      fallbackUserDataPath: 'C:\\fallback',
      isPackaged: true,
    },
    async () => {
      throw new Error('portable path unavailable')
    },
    createStore,
    reportError,
  )

  expect(result).toEqual({ settingsStore: fallbackStore, settings: DEFAULT_SETTINGS })
  expect(createStore).toHaveBeenCalledWith('C:\\fallback')
  expect(reportError).toHaveBeenCalledWith('Could not initialize settings', expect.any(Error))
})

const options = { executablePath: 'C:/Arkdown.exe', fallbackUserDataPath: 'C:/fallback', isPackaged: true }

it('resolves one root, prepares it, and returns only the acknowledged authoritative migration', async () => {
  const calls: string[] = []
  const snapshot = createSettingsTransactionSnapshot({ lastWorkspace: 'kept', fontDefaultsVersion: 3 })
  const authority = { migrateStartupSettings: vi.fn(async () => { calls.push('recover-migrate'); return snapshot }) }
  const create = vi.fn((root: string) => { calls.push(root); return authority })
  const result = await loadAuthoritativeStartupSettings(options,
    async () => ({ path: 'C:/portable', portable: true }), create,
    async (root) => { calls.push(`prepare:${root}`) })
  expect(result).toEqual({ authority, dataRoot: { path: 'C:/portable', portable: true }, snapshot })
  expect(calls).toEqual(['prepare:C:/portable', 'C:/portable', 'recover-migrate'])
  expect(create).toHaveBeenCalledOnce()
})

it('does not construct a fallback writable owner after root resolution fails', async () => {
  const create = vi.fn()
  await expect(loadAuthoritativeStartupSettings(options,
    async () => { throw new Error('root unavailable') }, create)).rejects.toThrow('root unavailable')
  expect(create).not.toHaveBeenCalled()
})

it('fails closed after recovery or migration failure on the resolved root', async () => {
  const create = vi.fn(() => ({ migrateStartupSettings: async () => { throw new Error('unknown journal') } }))
  await expect(loadAuthoritativeStartupSettings(options,
    async () => ({ path: 'C:/portable', portable: true }), create)).rejects.toThrow('unknown journal')
  expect(create).toHaveBeenCalledExactlyOnceWith('C:/portable')
})

it('uses the fallback store and defaults when settings loading fails', async () => {
  const reportError = vi.fn()
  const failedStore = { load: async () => Promise.reject(new Error('unreadable')), save: vi.fn() }
  const fallbackStore = { load: vi.fn(), save: vi.fn() }
  const createStore = vi.fn((root: string) => (root === 'C:\\portable' ? failedStore : fallbackStore))

  const result = await loadStartupSettings(
    {
      executablePath: 'C:\\Arkdown.exe',
      fallbackUserDataPath: 'C:\\fallback',
      isPackaged: true,
    },
    async () => ({ path: 'C:\\portable', portable: true }),
    createStore,
    reportError,
  )

  expect(result).toEqual({ settingsStore: fallbackStore, settings: DEFAULT_SETTINGS })
  expect(reportError).toHaveBeenCalledWith('Could not initialize settings', expect.any(Error))
})
