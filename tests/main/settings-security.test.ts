import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { buildWindowOptions } from '../../src/main/create-main-window'
import { SettingsStore } from '../../src/main/settings/settings-store'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const roots: string[] = []

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

it('copies only known window-bound fields from disk settings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)
  await writeFile(
    path.join(root, 'settings.json'),
    JSON.stringify({
      lastWorkspace: 'C:\\文档',
      windowBounds: {
        width: 900,
        height: 700,
        x: 30,
        y: 40,
        webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: true },
      },
    }),
    'utf8',
  )

  await expect(new SettingsStore(root).load()).resolves.toEqual({
    lastWorkspace: 'C:\\文档',
    windowBounds: { width: 900, height: 700, x: 30, y: 40 },
    layout: { leftSidebarWidth: 300, rightSidebarWidth: 530 },
    screenshotOcr: { preferredTier: 'small' },
    mainBackground: DEFAULT_BACKGROUND_SETTINGS,
    shellIntegration: { documentOpenMenu: true, markdownShellNew: true },
  })
})

it('does not let restored bounds override secure window preferences', () => {
  const options = buildWindowOptions('C:\\app\\preload.js', {
    width: 900,
    height: 700,
    x: 30,
    y: 40,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: true },
  } as never)

  expect(options).toMatchObject({ width: 900, height: 700, x: 30, y: 40 })
  expect(options.webPreferences).toMatchObject({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  })
})

it('does not persist unexpected API key fields from runtime settings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)
  const apiKey = 'secret-key'
  const runtimeSettings = Object.assign({
    fontDefaultsVersion: 3,
    lastWorkspace: 'C:\\workspace',
    lastFolderPickerPath: 'C:\\workspace',
    windowBounds: Object.assign({ width: 900, height: 700 }, { apiKey }),
  }, {
    apiKey,
    modelConnection: { apiKey },
  })

  await new SettingsStore(root).save(runtimeSettings as never)

  const persisted = await readFile(path.join(root, 'settings.json'), 'utf8')
  expect(JSON.parse(persisted)).toMatchObject({
    fontDefaultsVersion: 3,
    lastWorkspace: 'C:\\workspace',
    lastFolderPickerPath: 'C:\\workspace',
    windowBounds: { width: 900, height: 700 },
  })
  expect(persisted).not.toContain('apiKey')
  expect(persisted).not.toContain(apiKey)
})
