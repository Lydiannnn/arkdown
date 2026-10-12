import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, SettingsStore } from '../../src/main/settings/settings-store'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const roots: string[] = []

it('persists customized and cleared shortcuts across a settings-store restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-shortcuts-'))
  roots.push(root)
  const shortcuts = { 'file.save': 'Ctrl+Alt+S', 'document.outline': null }
  await new SettingsStore(root).save({ lastWorkspace: 'C:/Notes', shortcuts })
  const loaded = await new SettingsStore(root).load()
  expect(loaded.shortcuts).toEqual(shortcuts)
  expect(loaded.lastWorkspace).toBe('C:/Notes')
})

it('persists the capped default-app prompt state through the atomic settings store', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-default-apps-'))
  roots.push(root)
  const store = new SettingsStore(root)
  await store.save({ lastWorkspace: null, defaultApplicationsPrompt: { starts: 2, handled: true } })
  expect((await new SettingsStore(root).load()).defaultApplicationsPrompt).toEqual({ starts: 2, handled: true })
  await writeFile(store.filePath, JSON.stringify({ lastWorkspace: null, defaultApplicationsPrompt: { starts: 99, handled: 'true' } }), 'utf8')
  expect((await store.load()).defaultApplicationsPrompt).toEqual({ starts: 2, handled: false })
})

it('round-trips the two shell flags and defaults legacy settings without sharing mutable settings copies', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-shell-settings-'))
  roots.push(root)
  const store = new SettingsStore(root)
  await writeFile(store.filePath, JSON.stringify({ lastWorkspace: null }), 'utf8')
  expect((await store.load()).shellIntegration).toEqual({ documentOpenMenu: true, markdownShellNew: true })
  await store.save({ lastWorkspace: null, shellIntegration: { documentOpenMenu: false, markdownShellNew: false } })
  expect((await store.load()).shellIntegration).toEqual({ documentOpenMenu: false, markdownShellNew: false })
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

it('round-trips settings as UTF-8 JSON', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)
  const store = new SettingsStore(root, () => 100)

  await store.save({
    ...DEFAULT_SETTINGS,
    lastWorkspace: 'C:\\文档',
    appearance: { ...{
  minimumContentMarginPx: 30,
  maximumContentWidthPx: 1200,
  preserveSingleLineBreaks: true,
  spellCheckEnabled: false,
  showEditIndicators: false,
  editorTheme: 'minimal' as const,
  headingLatinFont: 'Arial',
  headingCjkFont: 'SimHei',
  bodyLatinFont: 'Arial',
  bodyCjkFont: 'SimHei',
  themeColor: '#800080',
  micaOpacityPercent: 0,
}, maximumContentWidthPx: 960 },
    mainBackground: {
      ...DEFAULT_BACKGROUND_SETTINGS,
      imageRelativePath: 'backgrounds/main/wallpaper.webp',
      imageOpacityPercent: 46,
      maskType: 'column-horizontal',
    },
  })

  expect(await store.load()).toMatchObject({
    lastWorkspace: 'C:\\文档',
    fontDefaultsVersion: 3,
    appearance: { ...{
  minimumContentMarginPx: 30,
  maximumContentWidthPx: 1200,
  preserveSingleLineBreaks: true,
  spellCheckEnabled: false,
  showEditIndicators: false,
  headingLatinFont: 'Arial',
  headingCjkFont: 'SimHei',
  bodyLatinFont: 'Arial',
  bodyCjkFont: 'SimHei',
  themeColor: '#800080',
  micaOpacityPercent: 0,
}, maximumContentWidthPx: 960 },
    mainBackground: {
      ...DEFAULT_BACKGROUND_SETTINGS,
      imageRelativePath: 'backgrounds/main/wallpaper.webp',
      imageOpacityPercent: 46,
      maskType: 'column-horizontal',
    },
  })
  expect(JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'))).toBeTruthy()
})

it('defaults a missing or malformed main background independently from other settings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)
  const filePath = path.join(root, 'settings.json')
  const store = new SettingsStore(root)

  await writeFile(filePath, JSON.stringify({ lastWorkspace: 'C:\\workspace' }), 'utf8')
  expect((await store.load()).mainBackground).toEqual(DEFAULT_BACKGROUND_SETTINGS)

  await writeFile(filePath, JSON.stringify({
    lastWorkspace: 'C:\\workspace',
    mainBackground: {
      ...DEFAULT_BACKGROUND_SETTINGS,
      imageOpacityPercent: 101,
    },
  }), 'utf8')
  expect(await store.load()).toMatchObject({
    lastWorkspace: 'C:\\workspace',
    mainBackground: DEFAULT_BACKGROUND_SETTINGS,
    shellIntegration: { documentOpenMenu: true, markdownShellNew: true },
  })
})

it('canonicalizes missing fields and explicit historical Mica opacity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)
  const filePath = path.join(root, 'settings.json')
  const storedAppearance = {
    minimumContentMarginPx: 42,
    maximumContentWidthPx: 1110,
    preserveSingleLineBreaks: false,
    spellCheckEnabled: true,
    showEditIndicators: false,
    headingLatinFont: 'Georgia',
    headingCjkFont: 'SimHei',
    bodyLatinFont: 'Arial',
    bodyCjkFont: 'SimSun',
    themeColor: '#2563EB',
  }
  await writeFile(filePath, JSON.stringify({ lastWorkspace: null, appearance: storedAppearance }), 'utf8')
  const store = new SettingsStore(root)

  const migrated = await store.load()
  expect(migrated.appearance).toEqual({
    ...storedAppearance,
    editorTheme: 'system',
    micaOpacityPercent: 0,
  })
  await store.save(migrated)
  expect(JSON.parse(await readFile(filePath, 'utf8')).appearance).toEqual({
    ...storedAppearance,
    editorTheme: 'system',
    micaOpacityPercent: 0,
  })

  await writeFile(filePath, JSON.stringify({
    lastWorkspace: null,
    appearance: { ...storedAppearance, micaOpacityPercent: 30 },
  }), 'utf8')
  expect((await store.load()).appearance).toEqual({
    ...storedAppearance,
    editorTheme: 'system',
    micaOpacityPercent: 0,
  })
})

it('migrates screenshot OCR preferences independently and discards corrupt state fields', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({
    lastWorkspace: 'C:\\workspace',
    screenshotOcr: { preferredTier: 'medium' },
    appearance: { invalid: true },
  }), 'utf8')

  expect(await new SettingsStore(root).load()).toMatchObject({
    lastWorkspace: 'C:\\workspace',
    screenshotOcr: { preferredTier: 'medium' },
    appearance: undefined,
  })

  await writeFile(path.join(root, 'settings.json'), JSON.stringify({
    lastWorkspace: 'C:\\workspace',
    screenshotOcr: { preferredTier: 'medium', installedPath: 'C:\\private\\models' },
  }), 'utf8')
  expect(await new SettingsStore(root).load()).toMatchObject({
    lastWorkspace: 'C:\\workspace',
    screenshotOcr: { preferredTier: 'small' },
  })
})

it('defaults screenshot OCR preferences when loading pre-schema settings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({ lastWorkspace: null }), 'utf8')

  expect((await new SettingsStore(root).load()).screenshotOcr).toEqual({ preferredTier: 'small' })
})

it('defaults only a missing edit-indicator preference while loading current settings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)
  const { showEditIndicators: _missing, ...storedAppearance } = {
    minimumContentMarginPx: 42,
    maximumContentWidthPx: 1110,
    preserveSingleLineBreaks: false,
    spellCheckEnabled: true,
    showEditIndicators: false,
    headingLatinFont: 'Georgia',
    headingCjkFont: 'SimHei',
    bodyLatinFont: 'Arial',
    bodyCjkFont: 'SimSun',
    themeColor: '#2563EB',
    micaOpacityPercent: 72,
  }
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({
    lastWorkspace: null,
    appearance: storedAppearance,
  }), 'utf8')

  expect((await new SettingsStore(root).load()).appearance).toEqual({
    ...storedAppearance,
    showEditIndicators: true,
    editorTheme: 'system',
    micaOpacityPercent: 0,
  })
})

it('drops invalid editor appearance settings while loading', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({
    lastWorkspace: null,
    appearance: { ...{
  minimumContentMarginPx: 30,
  maximumContentWidthPx: 1200,
  preserveSingleLineBreaks: true,
  headingLatinFont: 'Arial',
  headingCjkFont: 'SimHei',
  bodyLatinFont: 'Arial',
  bodyCjkFont: 'SimHei',
}, maximumContentWidthPx: 1201 },
  }), 'utf8')

  expect(await new SettingsStore(root).load()).toEqual({
    lastWorkspace: null,
    appearance: undefined,
    search: undefined,
    windowBounds: undefined,
    fontDefaultsVersion: undefined,
    layout: { leftSidebarWidth: 300, rightSidebarWidth: 530 },
    screenshotOcr: { preferredTier: 'small' },
    mainBackground: DEFAULT_BACKGROUND_SETTINGS,
    shellIntegration: { documentOpenMenu: true, markdownShellNew: true },
  })
})

it('migrates missing layout settings and clamps previously saved sidebar widths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({
    lastWorkspace: null,
    layout: { leftSidebarWidth: 900, rightSidebarWidth: 2000 },
  }), 'utf8')

  expect((await new SettingsStore(root).load()).layout).toEqual({
    leftSidebarWidth: 600,
    rightSidebarWidth: 1800,
  })
})

it('backs up malformed JSON and returns defaults', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)
  await writeFile(path.join(root, 'settings.json'), '{broken', 'utf8')
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const reportError = vi.fn()
  const store = new SettingsStore(root, () => 100, {
    createBackupSuffix: () => 'test',
    reportError,
  })

  expect(await store.load()).toEqual(DEFAULT_SETTINGS)
  expect(await readFile(path.join(root, 'settings.corrupt-100-test.json'), 'utf8')).toBe('{broken')
  expect(reportError).toHaveBeenCalledOnce()
  expect(reportError).toHaveBeenCalledWith(
    'Could not parse settings',
    expect.any(SyntaxError),
  )
  expect(consoleError).not.toHaveBeenCalled()
})
