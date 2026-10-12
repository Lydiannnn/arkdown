import { expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, SettingsStore } from '../../src/main/settings/settings-store'

it('logs malformed JSON after backing it up', async () => {
  const reportError = vi.fn()
  const store = new SettingsStore('C:\\settings', () => 100, {
    readTextFile: async () => '{broken',
    copyFileExclusive: async () => {},
    createBackupSuffix: () => 'test',
    reportError,
  })

  await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS)
  expect(reportError).toHaveBeenCalledWith('Could not parse settings', expect.any(SyntaxError))
})
