import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, SettingsStore } from '../../src/main/settings/settings-store'

const roots: string[] = []

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

it('does not overwrite an existing corrupt-settings backup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)
  const settingsPath = path.join(root, 'settings.json')
  const backupPath = path.join(root, 'settings.corrupt-100-test.json')
  await writeFile(settingsPath, '{broken', 'utf8')
  await writeFile(backupPath, 'existing backup', 'utf8')
  const reportError = vi.fn()
  const store = new SettingsStore(root, () => 100, {
    createBackupSuffix: () => 'test',
    reportError,
  })

  await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS)
  await expect(readFile(backupPath, 'utf8')).resolves.toBe('existing backup')
  await expect(readFile(settingsPath, 'utf8')).resolves.toBe('{broken')
  expect(reportError).toHaveBeenCalledWith('Could not back up malformed settings', expect.any(Error))
})

it('keeps the original corrupt file when deleting it after backup fails', async () => {
  const reportError = vi.fn()
  const removeFile = vi.fn(async () => {
    throw new Error('access denied')
  })
  const store = new SettingsStore('C:\\settings', () => 100, {
    readTextFile: async () => '{broken',
    copyFileExclusive: async () => {},
    removeFile,
    createBackupSuffix: () => 'test',
    reportError,
  })

  await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS)
  expect(removeFile).toHaveBeenCalledWith('C:\\settings\\settings.json')
  expect(reportError).toHaveBeenCalledWith('Could not remove malformed settings after backup', expect.any(Error))
})
