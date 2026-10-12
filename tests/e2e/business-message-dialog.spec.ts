import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRuntimeInstance, waitForElectronExecutablesQuiet } from './support/runtime'

const body = '# Dialog acceptance\n\nSYNTHETIC-SAVED-ORIGINAL\n'
let activeRun: { app: ElectronApplication; runtime: Awaited<ReturnType<typeof prepare>> } | undefined
test.afterEach(async () => {
  if (!activeRun) return
  const { app, runtime } = activeRun
  activeRun = undefined
  if (app.windows().some(page => !page.isClosed())) {
    await app.evaluate(({ app }) => app.quit()).catch(() => undefined)
  }
  await quiet(runtime)
})
async function prepare() {
  const shared = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!shared) throw new Error('Package-auditing global setup is required')
  const runtime = await createRuntimeInstance(shared, 'arkdown-e2e-message-')
  const workspace = path.join(runtime.root, 'workspace')
  await mkdir(workspace, { recursive: true }); await mkdir(runtime.portableData, { recursive: true })
  const document = path.join(workspace, 'acceptance.md')
  await writeFile(document, body, { encoding: 'utf8', flag: 'wx' })
  await writeFile(path.join(runtime.portableData, 'settings.json'), JSON.stringify({ lastWorkspace: workspace, workspaceIntroSeen: true,
    desktopLifecycle: { launchAtLogin: false, closeBehavior: 'quit', stickyNoteAutostartPrompted: true },
    shellIntegration: { documentOpenMenu: false, markdownShellNew: false },
    defaultApplicationsPrompt: { starts: 2, handled: true, version: '1.0.4' },
  }), { encoding: 'utf8', flag: 'wx' })
  return { ...runtime, workspace, document }
}
async function launch(runtime: Awaited<ReturnType<typeof prepare>>) {
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  for (const key of Object.keys(environment)) {
    if (/^(?:ARKDOWN_|ARKNOTE_|CODEX_|OPENAI_|ANTHROPIC_|AZURE_OPENAI_|GEMINI_|DEEPSEEK_|OLLAMA_|ELECTRON_)/iu.test(key)
      || /^(?:NODE_OPTIONS|PORTABLE_EXECUTABLE_DIR|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/iu.test(key)) delete environment[key]
  }
  Object.assign(environment, { APPDATA: runtime.root, LOCALAPPDATA: runtime.root, ARKDOWN_E2E: '1' })
  const app = await electron.launch({ executablePath: runtime.executable, cwd: runtime.application, timeout: 30_000,
    args: [runtime.document, `--user-data-dir=${runtime.userData}`], env: environment })
  activeRun = { app, runtime }
  return app
}
async function messageWindow(app: ElectronApplication) {
  let page: Page | undefined
  await expect.poll(() => { page = app.windows().find(candidate => !candidate.isClosed() && candidate.url().includes('surface=business-dialog')); return !!page }).toBe(true)
  await expect(page!.getByRole('dialog')).toBeVisible()
  return page!
}
async function editorWindow(app: ElectronApplication, text: string) {
  let page: Page | undefined
  await expect.poll(async () => {
    for (const candidate of app.windows()) {
      if (!candidate.isClosed() && await candidate.locator('.ProseMirror').filter({ hasText: text }).count()) { page = candidate; return true }
    }
    return false
  }).toBe(true)
  return page!
}
async function reviewDrafts(page: Page) {
  await page.getByTestId('app-titlebar').getByRole('button', { name: '文件', exact: true }).click()
  await page.getByRole('menuitem', { name: /查看保留的草稿/u }).click()
}
async function closeWindow(page: Page) {
  await page.getByRole('group', { name: '窗口控制', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
}
async function closeByKey(page: Page, key: string) {
  expect(page.isClosed()).toBe(false)
  const closed = page.waitForEvent('close'); void closed.catch(() => undefined)
  // Main destroys the native dialog on keydown, so Chromium can close before
  // Playwright receives the matching keyup acknowledgement.
  await page.keyboard.press(key).catch(error => { if (!page.isClosed()) throw error })
  await closed
}
async function quiet(runtime: Awaited<ReturnType<typeof prepare>>) {
  await waitForElectronExecutablesQuiet({ executables: [runtime.executable, runtime.arknoteExecutable], quietPeriodMs: 1300, timeoutMs: 15_000 })
}

test('real message windows preserve keyboard choices and the parent in light and dark themes', async ({}, info) => {
  const runtime = await prepare(), app = await launch(runtime)
  const main = await editorWindow(app, 'SYNTHETIC-SAVED-ORIGINAL')
  for (const dark of [false, true]) {
    await main.getByTestId('app-titlebar').getByRole('button', { name: '主题', exact: true }).click()
    await main.getByRole('menuitemradio', { name: dark ? '深色模式' : '浅色模式', exact: true }).click()
    await expect(main.locator('html')).toHaveAttribute('data-arkdown-theme', dark ? 'dark' : 'minimal')
    await reviewDrafts(main)
    const prompt = await messageWindow(app)
    await expect(prompt.getByRole('button', { name: '确定', exact: true })).toBeFocused()
    await expect(prompt.getByRole('dialog')).toHaveAccessibleDescription('没有可恢复的草稿。已打开的草稿可在对应窗口中继续编辑。')
    expect(await prompt.locator('html').getAttribute('data-arkdown-theme')).toBe(dark ? 'dark' : 'minimal')
    expect(await prompt.locator('.arkdown-dialog__primary').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(65, 131, 196)')
    await expect.poll(() => prompt.evaluate(() => window.innerHeight)).toBeLessThan(240)
    const geometry = await prompt.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>('.business-message-dialog')!
      const content = dialog.querySelector<HTMLElement>('.arkdown-dialog__content')!
      const actions = dialog.querySelector<HTMLElement>('.arkdown-dialog__actions')!
      const button = actions.querySelector<HTMLElement>('button')!
      return { height: dialog.offsetHeight, viewport: innerHeight, gap: actions.offsetTop - content.offsetTop - content.offsetHeight,
        margin: getComputedStyle(actions).marginTop, buttonHeight: button.offsetHeight, fontSize: getComputedStyle(button).fontSize }
    })
    expect(geometry.margin).toBe('22px')
    // Individual offset values round to CSS integers at 150% Windows scaling.
    expect(Math.abs(geometry.gap - 22)).toBeLessThanOrEqual(1)
    expect(Math.abs(geometry.height - geometry.viewport)).toBeLessThanOrEqual(1)
    expect(geometry.buttonHeight).toBe(32)
    expect(geometry.fontSize).toBe('14px')
    await prompt.screenshot({ path: info.outputPath(`message-${dark ? 'dark' : 'light'}.png`), animations: 'disabled' })
    await closeByKey(prompt, dark ? 'Enter' : 'Escape')
    expect(main.isClosed()).toBe(false)
    await expect(main.locator('.ProseMirror')).toContainText('SYNTHETIC-SAVED-ORIGINAL')
  }
  await reviewDrafts(main)
  const prompt = await messageWindow(app), dismissed = prompt.waitForEvent('close')
  void dismissed.catch(() => undefined)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('surface=business-dialog'))!.close())
  await dismissed; expect(main.isClosed()).toBe(false)
  const closed = app.waitForEvent('close'); void closed.catch(() => undefined)
  await closeWindow(main); await closed; await quiet(runtime)
  expect(await readFile(runtime.document, 'utf8')).toBe(body)
})

test('startup recovery has no parent, while later recovery is modal and opens the selected draft safely', async ({}, info) => {
  const runtime = await prepare(), draftId = randomUUID(), markdown = '# Recovered\n\nSYNTHETIC-RECOVERED-CONTENT\n'
  const directory = path.join(runtime.application, 'temp/drafts', draftId)
  await mkdir(directory, { recursive: true })
  const manifest = { version: 1, draftId, originalAbsolutePath: runtime.document, workspaceAbsolutePath: runtime.workspace,
    originalRevision: createHash('sha256').update(body).digest('hex'), originalMtimeMs: 1, encoding: 'utf8', newline: 'lf',
    updatedAt: '2026-10-01T00:00:00.000Z', ignoredAt: null, appVersion: '1.0.3', bodySha256: createHash('sha256').update(markdown).digest('hex'), assets: [] }
  await writeFile(path.join(directory, 'body.md'), markdown, 'utf8')
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest), 'utf8')
  const app = await launch(runtime), startup = await messageWindow(app)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('surface=business-dialog'))!.getParentWindow() === null)).toBe(true)
  await startup.screenshot({ path: info.outputPath('startup-recovery.png'), animations: 'disabled' })
  await closeByKey(startup, 'Escape')
  const main = await editorWindow(app, 'SYNTHETIC-SAVED-ORIGINAL')
  expect(JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')).ignoredAt).toBeTruthy()
  await reviewDrafts(main)
  const review = await messageWindow(app)
  expect(await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('surface=business-dialog'))!
    return window.isModal() && window.getParentWindow() !== null
  })).toBe(true)
  await closeByKey(review, 'Enter')
  const recovered = await editorWindow(app, 'SYNTHETIC-RECOVERED-CONTENT')
  await recovered.screenshot({ path: info.outputPath('recovered-draft.png') })
  await closeWindow(recovered)
  const discard = recovered.getByRole('button', { name: '不保存', exact: true })
  await expect(discard).toBeVisible()
  const recoveredClosed = recovered.waitForEvent('close'); void recoveredClosed.catch(() => undefined)
  await discard.click(); await recoveredClosed
  const closed = app.waitForEvent('close'); void closed.catch(() => undefined)
  await closeWindow(main); await closed; await quiet(runtime)
  expect(await readFile(runtime.document, 'utf8')).toBe(body)
})
