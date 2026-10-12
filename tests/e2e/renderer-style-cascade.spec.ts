import { _electron as electron, expect, test } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { cleanupRuntime, createRuntimeInstance, shutdownElectronApplication, shutdownElectronApplicationScope } from './support/runtime'
import { DEFAULT_SETTINGS } from '../../src/main/settings/settings-store'
import { DEFAULT_EDITOR_APPEARANCE } from '../../src/shared/editor-appearance-preferences'
import { ArknotePipeClient } from '../../src/main/arknote/arknote-pipe-client'
import { arknotePipeName } from '../../src/shared/arknote-protocol'

// Exercise emitted CSS in Electron: jsdom/component mocks cannot detect a lazy
// stylesheet replacing the application overrides after the editor mounts.
for (const theme of ['minimal', 'dark'] as const) {
  test(`preserves tuned document styles after lazy loading (${theme})`, async ({}, testInfo) => {
    const runtime = await createRuntimeInstance(process.env.ARKDOWN_E2E_SHARED_APPLICATION!, 'arkdown-style-cascade-')
    const workspace = path.join(runtime.root, 'workspace')
    const documentPath = path.join(workspace, '01-欢迎使用.md')
    await mkdir(workspace, { recursive: true })
    await mkdir(runtime.portableData, { recursive: true })
    await writeFile(documentPath, await readFile(path.resolve('initial-workspace/01-欢迎使用.md'), 'utf8'), 'utf8')
    await writeFile(path.join(runtime.portableData, 'settings.json'), JSON.stringify({
      ...DEFAULT_SETTINGS, lastWorkspace: workspace,
      windowBounds: { width: 1600, height: 1000 },
      appearance: { ...DEFAULT_EDITOR_APPEARANCE, editorTheme: theme },
      defaultApplicationsPrompt: { starts: 2, handled: true },
      shellIntegration: { documentOpenMenu: false, markdownShellNew: false },
    }), 'utf8')
    const stopNotes = async () => shutdownElectronApplication({
      executable: runtime.arknoteExecutable,
      requestClose: async () => {
        const token = await readFile(path.join(runtime.portableData, 'arknote/service-token'), 'utf8').catch(() => '')
        if (!token) return
        const client = new ArknotePipeClient({ pipeName: arknotePipeName(runtime.application), token: token.trim(), timeoutMs: 2000 })
        try {
          await client.connect()
          await client.request('service.quit', {}, value => value)
        } catch (error) {
          // The quit acknowledgement can race the intentional pipe closure.
          if (!(error instanceof Error && (error.message === 'Arknote connection closed'
            || ('code' in error && error.code === 'ENOENT')))) throw error
        } finally { client.close() }
      },
    })
    let application
    const started = Date.now()
    try {
      application = await electron.launch({
        executablePath: runtime.executable, cwd: runtime.application, timeout: 30000,
        args: [`--user-data-dir=${runtime.userData}`, documentPath],
        env: { ...process.env, APPDATA: runtime.root, LOCALAPPDATA: runtime.root,
          ARKDOWN_E2E: '1', ARKDOWN_E2E_RECOVER: '1', ARKDOWN_E2E_WORKSPACE: workspace,
          ARKDOWN_REGISTRY_TEST_ROOT: `Software\\ArkdownNativeTests\\${path.basename(runtime.root)}` },
      })
      const page = await application.firstWindow()
      const editor = page.locator('.visual-editor .ProseMirror').first()
      await expect(editor).toContainText('把想法写下来')
      const editableMs = Date.now() - started
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setBounds({ x: 20, y: 20, width: 1600, height: 1000 })
        window.show(); window.focus()
      })
      await page.evaluate(() => document.fonts.ready)
      const snapshot = async () => page.evaluate(() => {
        const properties = ['font-family', 'font-size', 'font-weight', 'line-height', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-bottom', 'color', 'background-color', 'border-left-color', 'width', 'height']
        const selectors = ['.visual-editor .ProseMirror', '.ProseMirror h1', '.ProseMirror h2', '.ProseMirror > p', '.ProseMirror blockquote', '.ProseMirror li p', '.ProseMirror li .label', '.ProseMirror table', '.ProseMirror th', '.ProseMirror td', '.ProseMirror a']
        const styles = Object.fromEntries(selectors.map(selector => {
          const element = document.querySelector(selector)!
          const computed = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return [selector, { css: Object.fromEntries(properties.map(property => [property, computed.getPropertyValue(property)])), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }]
        }))
        const quote = getComputedStyle(document.querySelector('.ProseMirror blockquote')!, '::before')
        return { styles, quoteColor: quote.backgroundColor, dpr: devicePixelRatio,
          sheets: Array.from(document.styleSheets).map(sheet => sheet.href),
          theme: document.documentElement.dataset.arkdownTheme }
      })
      const initial = await snapshot()
      await testInfo.attach(`${theme}-styles.json`, { body: JSON.stringify({ editableMs, ...initial }, null, 2), contentType: 'application/json' })
      await testInfo.attach(`${theme}.png`, { body: await page.screenshot(), contentType: 'image/png' })
      if (process.env.ARKDOWN_STYLE_EVIDENCE) {
        await mkdir(process.env.ARKDOWN_STYLE_EVIDENCE, { recursive: true })
        await writeFile(path.join(process.env.ARKDOWN_STYLE_EVIDENCE, `${theme}.json`), JSON.stringify({ editableMs, ...initial }, null, 2), 'utf8')
        await page.screenshot({ path: path.join(process.env.ARKDOWN_STYLE_EVIDENCE, `${theme}.png`) })
      }
      const css = (selector: string) => initial.styles[selector].css
      expect.soft(css('.visual-editor .ProseMirror')['padding-left']).toBe('0px')
      expect.soft(css('.visual-editor .ProseMirror')['padding-right']).toBe('0px')
      expect.soft(css('.visual-editor .ProseMirror')['padding-top']).toBe('90px')
      expect.soft(css('.ProseMirror h1')['font-weight']).toBe('650')
      expect.soft(css('.ProseMirror h1')['font-size']).toBe('36px')
      expect.soft(css('.ProseMirror h1')['line-height']).toBe('43.2px')
      expect.soft(css('.ProseMirror h2')['font-size']).toBe('28px')
      expect.soft(css('.ProseMirror > p')['padding-top']).toBe('0px')
      expect.soft(css('.ProseMirror > p')['line-height']).toBe('25.6px')
      expect.soft(initial.quoteColor).toBe('rgb(198, 40, 40)')
      const taskText = initial.styles['.ProseMirror li p'].rect
      const taskBox = initial.styles['.ProseMirror li .label'].rect
      expect.soft(Math.abs(taskText.y + taskText.height / 2 - taskBox.y - taskBox.height / 2)).toBeLessThan(0.1)
      // Returning from source mode must not inject a second, conflicting theme.
      await page.locator('.source-mode-toolbar-button').click()
      await expect(page.locator('.source-editor')).toBeVisible()
      await page.locator('.source-mode-toolbar-button').click()
      await expect(editor).toContainText('把想法写下来')
      expect((await snapshot()).styles).toEqual(initial.styles)
      // Keep the user's chosen heading fonts authoritative over Crepe's title font.
      const customFonts = await page.evaluate(async () => {
        const observed = await window.arkdown.getPreferenceSnapshot!('appearance')
        if (!observed.ok || observed.value.group !== 'appearance') {
          throw new Error('Appearance observation is unavailable')
        }
        return await window.arkdown.patchPreferences!({
          observed: observed.value,
          changes: { headingLatinFont: 'Arial', headingCjkFont: 'SimHei' },
        })
      })
      expect(customFonts.ok).toBe(true)
      expect(customFonts).toMatchObject({ ok: true, value: {
        status: expect.stringMatching(/^(committed|unchanged)$/u),
        snapshot: { group: 'appearance', values: {
          editorTheme: theme, headingLatinFont: 'Arial', headingCjkFont: 'SimHei',
        } },
      } })
      await expect.poll(async () => (await snapshot()).styles['.ProseMirror h1'].css['font-family']).toMatch(/^Arial, SimHei,/)
    } finally {
      await shutdownElectronApplicationScope({ application, executable: runtime.executable,
        requestClose: async app => { await app.close(); await stopNotes() } })
      await cleanupRuntime(runtime.root)
    }
  })
}
