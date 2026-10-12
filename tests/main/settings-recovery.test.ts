import { expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, SettingsStore } from '../../src/main/settings/settings-store'

it('returns defaults and logs an unreadable settings file without attempting a backup', async () => {
  const reportError = vi.fn()
  const copyFileExclusive = vi.fn()
  const store = new SettingsStore('C:\\settings', () => 100, {
    readTextFile: async () => {
      const error = new Error('access denied') as NodeJS.ErrnoException
      error.code = 'EACCES'
      throw error
    },
    copyFileExclusive,
    reportError,
  })

  await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS)
  expect(copyFileExclusive).not.toHaveBeenCalled()
  expect(reportError).toHaveBeenCalledWith('Could not read settings', expect.any(Error))
})

it('returns defaults and logs when a malformed settings backup cannot be written', async () => {
  const reportError = vi.fn()
  const copyFileExclusive = vi.fn(async () => {
    throw new Error('backup target exists')
  })
  const store = new SettingsStore('C:\\settings', () => 100, {
    readTextFile: async () => '{broken',
    copyFileExclusive,
    createBackupSuffix: () => 'test',
    reportError,
  })

  await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS)
  expect(copyFileExclusive).toHaveBeenCalledWith(
    'C:\\settings\\settings.json',
    'C:\\settings\\settings.corrupt-100-test.json',
  )
  expect(reportError).toHaveBeenCalledWith('Could not back up malformed settings', expect.any(Error))
})
