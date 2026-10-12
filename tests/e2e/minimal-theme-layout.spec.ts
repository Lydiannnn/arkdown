import type { AddressInfo } from 'node:net'
import { expect, test, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import { DEFAULT_EDITOR_APPEARANCE } from '../../src/shared/editor-appearance-preferences'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import { modelObservation } from '../helpers/model-observation'

let vite: ViteDevServer | undefined
let appUrl = ''

test.beforeAll(async () => {
  vite = await createServer({
    configFile: 'vite.renderer.config.ts',
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address() as AddressInfo | null
  if (!address || typeof address === 'string') throw new Error('Ephemeral Vite address unavailable')
  appUrl = `http://127.0.0.1:${address.port}/`
})

test.afterAll(async () => {
  await vite?.close()
})

async function openApp(page: Page) {
  await page.addInitScript(({ appearance, modelSnapshot }) => {
    const menuCommandEvent = 'arkdown-test-menu-command'
    let themeExecutions = 0
    let compareAndSetCalls = 0
    let editorCommandEvents = 0
    window.addEventListener('arkdown:editor-command', () => { editorCommandEvents += 1 })
    Object.defineProperty(window, 'arkdown', {
      configurable: true,
      value: {
        restoreWorkspace: async () => ({ ok: true, value: null }),
        onMenuCommand: (listener: (command: string) => void) => {
          const relay = (event: Event) => listener((event as CustomEvent).detail)
          window.addEventListener(menuCommandEvent, relay)
          return () => window.removeEventListener(menuCommandEvent, relay)
        },
        executeApplicationMenuItem: async (itemId: string) => {
          if (itemId === 'theme.minimal') {
            themeExecutions += 1
            window.dispatchEvent(new CustomEvent(menuCommandEvent, {
              detail: 'select-editor-theme-minimal',
            }))
          }
          return { ok: true, value: undefined }
        },
        compareAndSetEditorAppearancePreferences: async () => {
          compareAndSetCalls += 1
          return { ok: true, value: { appearance, revision: 1 } }
        },
        onApplicationMenuChanged: () => () => undefined,
        onWindowStateChanged: () => () => undefined,
        onPrepareClose: () => () => undefined,
        onEditorAppearancePreferencesChanged: () => () => undefined,
        onTranslationEvent: () => () => undefined,
        onRecoverDraft: () => () => undefined,
        onOpenIntent: () => () => undefined,
        onImportDocxIntent: () => () => undefined,
        updateApplicationMenuWindowState: async () => ({ ok: true, value: undefined }),
        getWindowState: async () => ({
          ok: true, value: { maximized: false, fullscreen: false, revision: 0 },
        }),
        recordRecentDocument: async () => ({ ok: true, value: [] }),
        getLargeModelSettings: async () => ({ ok: true, value: modelSnapshot.settings }),
        getModelSettingsSnapshot: async () => ({ ok: true, value: structuredClone(modelSnapshot) }),
        cancelTranslation: async () => ({ ok: true, value: null }),
        readClipboardFormats: async () => ({
          ok: true, value: { plainText: '', markdown: null, html: null },
        }),
      },
    })
    Object.defineProperty(window, '__minimalThemeFixture', {
      configurable: true,
      value: {
        counts: () => ({ themeExecutions, compareAndSetCalls, editorCommandEvents }),
      },
    })
  }, { appearance: DEFAULT_EDITOR_APPEARANCE, modelSnapshot: modelObservation(DEFAULT_LARGE_MODEL_SETTINGS) })
  await page.goto(appUrl)
  await expect(page.locator('.visual-editor')).toBeVisible()
}

test('keeps Minimal idempotent, transparent-Mica, and editor identity stable', async ({ page }, testInfo) => {
  await openApp(page)
  expect(await page.evaluate(() => devicePixelRatio)).toBe(testInfo.project.metadata.requestedDpr)
  const editor = page.locator('.visual-editor')
  await editor.evaluate((element) => { element.setAttribute('data-identity-probe', 'stable') })

  await expect(page.locator('.app-shell')).toHaveAttribute('data-editor-theme', 'minimal')
  await expect(page.locator('.editor-pane')).toHaveAttribute('data-editor-theme', 'minimal')
  await expect(editor).toHaveAttribute('data-editor-theme', 'minimal')
  expect(await page.locator('.sidebar').evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe('rgba(255, 255, 255, 0)')

  for (let click = 0; click < 2; click += 1) {
    await page.getByRole('button', { name: '主题', exact: true }).click()
    const minimal = page.getByRole('menuitemradio', { name: '简约', exact: true })
    await expect(minimal).toBeChecked()
    await expect(page.getByText('GitHub', { exact: true })).toHaveCount(0)
    await minimal.click()
  }

  await expect(editor).toHaveAttribute('data-identity-probe', 'stable')
  expect(await page.evaluate(() => (
    (window as unknown as {
      __minimalThemeFixture: { counts(): Record<string, number> }
    }).__minimalThemeFixture.counts()
  ))).toEqual({ themeExecutions: 2, compareAndSetCalls: 0, editorCommandEvents: 0 })
})
