import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { saveWithNativeShortcut } from './support/native-shortcuts'
import {
  cleanupRuntime,
  createRuntimeInstance,
  runE2eStage,
  shutdownElectronApplicationScope,
  type RuntimeInstance,
} from './support/runtime'

const ROOT_NAME = 'report.md'
const UNSAVED = 'Unsaved root survives preview navigation'
const ROOT_MARKDOWN = [
  '# Root report', '', 'Original root content.', '',
  '[Report detail](./reports/detail.md)', '',
  '[Browser JSON](./config/browser.json)', '',
  '[Widget TSX](./src/widget.tsx)', '',
  '[Theme CSS](./src/theme.css)', '',
  'Editable note.', '',
].join('\n')
const DETAIL_MARKDOWN = [
  '# Detail report', '', 'Preview searchable content.', '', '- [ ] Immutable task', '',
  '[Back to root](../report.md)', '',
  '[More details](./appendix.md#destination)', '',
  '[Code location](../src/long.ts#L45)', '',
  ...Array.from({ length: 35 }, (_, index) => `Reading paragraph ${index + 1}.\n`),
].join('\n')
const JSON_TEXT = '\ufeff{\r\n\t"value": 1,\r\n\t"literal": "<script>unsafe()</script>"\r\n}\r\n'

async function launch(runtime: RuntimeInstance, workspace: string): Promise<ElectronApplication> {
  const temporary = path.join(runtime.root, 'temp')
  await mkdir(temporary, { recursive: true })
  return runE2eStage('连接文档查看 Electron 主进程', () => electron.launch({
    executablePath: runtime.executable,
    cwd: runtime.application,
    timeout: 30_000,
    args: ['--disable-gpu', `--user-data-dir=${runtime.userData}`],
    env: {
      ...process.env,
      APPDATA: runtime.root,
      LOCALAPPDATA: runtime.root,
      TEMP: temporary,
      TMP: temporary,
      TMPDIR: temporary,
      ARKDOWN_E2E: '1',
      ARKDOWN_E2E_RECOVER: '1',
      ARKDOWN_E2E_WORKSPACE: workspace,
    },
  }))
}

async function setTheme(page: Page, theme: 'minimal' | 'dark'): Promise<void> {
  // Exercise the real preference IPC and renderer subscription, rather than injecting CSS.
  await page.evaluate(async (editorTheme) => {
    const api = window.arkdown
    const current = await api.getPreferenceSnapshot?.('appearance')
    if (!current?.ok || current.value.group !== 'appearance' || !api.patchPreferences) {
      throw new Error('Appearance API is unavailable')
    }
    const saved = await api.patchPreferences({ observed: current.value, changes: { editorTheme } })
    if (!saved.ok) throw new Error(saved.error.message)
    if (saved.value.status === 'conflict') throw new Error('Appearance preference update conflicted')
  }, theme)
  await expect(page.locator('html')).toHaveAttribute('data-arkdown-theme', theme)
}

async function removeOwnedWorkspace(workspace: string): Promise<void> {
  const resolved = path.resolve(workspace)
  if (path.dirname(resolved) !== path.resolve(tmpdir())
    || !path.basename(resolved).startsWith('arkdown-document-view-workspace-')) {
    throw new Error(`Refusing cleanup outside the owned document-view workspace: ${resolved}`)
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

test('relative previews preserve the dirty root, isolate reading actions, and open faithful code in a new window', async ({}, testInfo) => {
  test.setTimeout(240_000)
  const shared = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!shared) throw new Error('Provenance-audited Electron E2E shared runtime is not prepared')
  const workspace = await mkdtemp(path.join(tmpdir(), 'arkdown-document-view-workspace-'))
  let runtime: RuntimeInstance | undefined
  let application: ElectronApplication | undefined
  const rootPath = path.join(workspace, ROOT_NAME)
  const detailPath = path.join(workspace, 'reports', 'detail.md')
  const jsonPath = path.join(workspace, 'config', 'browser.json')
  try {
    runtime = await createRuntimeInstance(shared, 'arkdown-document-view-runtime-')
    for (const directory of ['reports', 'config', 'src']) await mkdir(path.join(workspace, directory))
    await writeFile(rootPath, ROOT_MARKDOWN, 'utf8')
    await writeFile(detailPath, DETAIL_MARKDOWN, 'utf8')
    await writeFile(path.join(workspace, 'reports', 'appendix.md'), '# Appendix\n\nOpened from the preview link.\n\n'
      + Array.from({ length: 50 }, (_, index) => `Reading appendix paragraph ${index + 1}.\n\n`).join('')
      + '## Destination\n\nLinked destination content.\n', 'utf8')
    await writeFile(path.join(workspace, 'src', 'long.ts'), Array.from({ length: 80 }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n'), 'utf8')
    await writeFile(jsonPath, JSON_TEXT, 'utf8')
    await writeFile(path.join(workspace, 'src', 'widget.tsx'), 'export const Widget = () => <div>Literal TSX</div>;\n', 'utf8')
    await writeFile(path.join(workspace, 'src', 'theme.css'), '.example { color: rebeccapurple; }\n', 'utf8')
    application = await launch(runtime, workspace)
    const app = application
    const page = await runE2eStage('等待文档查看主窗口', () => app.firstWindow({ timeout: 15_000 }))
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.getByRole('button', { name: ROOT_NAME, exact: true }).click()
    const mainEditor = page.locator('.visual-editor .ProseMirror')
    const preview = page.getByRole('region', { name: '文档查看', exact: true })
    const rootSave = page.locator('.document-save-controls')
    await expect(mainEditor).toContainText('Original root content.')
    await mainEditor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText(` ${UNSAVED}`)
    await expect(rootSave).toHaveAttribute('data-state', 'dirty')
    const dirtyText = await mainEditor.innerText()

    await test.step('ordinary clicks keep original href; Ctrl+click opens a separate readonly preview', async () => {
      const link = mainEditor.getByRole('link', { name: 'Report detail', exact: true })
      await expect(link).toHaveAttribute('href', './reports/detail.md')
      await link.click()
      await expect(preview).toHaveCount(0)
      await link.click({ modifiers: ['Control'] })
      await expect(preview.getByRole('heading', { name: 'Detail report', exact: true })).toBeVisible()
      await expect(page.getByRole('tab', { name: '文档查看', exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(preview.getByRole('checkbox')).toBeDisabled()
      await expect(preview.getByRole('checkbox')).not.toBeChecked()
      expect(await readFile(detailPath, 'utf8')).toBe(DETAIL_MARKDOWN)
      expect(await mainEditor.innerText()).toBe(dirtyText)
      expect(await readFile(rootPath, 'utf8')).toBe(ROOT_MARKDOWN)
      await expect(rootSave).toHaveAttribute('data-state', 'dirty')
    })

    await test.step('A → B → A focuses the unsaved original and keeps the checklist preview usable', async () => {
      await preview.getByRole('link', { name: 'Back to root', exact: true }).click({ modifiers: ['Control'] })
      await expect(mainEditor).toBeFocused()
      expect(await mainEditor.innerText()).toBe(dirtyText)
      await expect(rootSave).toHaveAttribute('data-state', 'dirty')
      expect(await readFile(rootPath, 'utf8')).toBe(ROOT_MARKDOWN)
      await expect(preview.getByRole('heading', { name: 'Detail report', exact: true })).toBeVisible()
      await expect(preview.getByRole('button', { name: '返回上一文档', exact: true })).toBeEnabled()
      await preview.getByRole('button', { name: '返回上一文档', exact: true }).click()
      await expect(mainEditor).toBeFocused()
      await expect(preview.getByRole('heading', { name: 'Detail report', exact: true })).toBeVisible()
    })

    await test.step('a nested relative link opens another editing window and retains the current preview', async () => {
      const childPromise = app.waitForEvent('window', { timeout: 15_000 })
      await preview.getByRole('link', { name: 'More details', exact: true }).click({ modifiers: ['Control'] })
      const child = await childPromise
      await expect(child.locator('.visual-editor .ProseMirror')).toContainText('Opened from the preview link.')
      await expect(child.locator('.visual-editor .ProseMirror').getByRole('heading', { name: 'Destination', exact: true })).toBeInViewport()
      await page.bringToFront()
      await expect(preview.getByRole('heading', { name: 'Detail report', exact: true })).toBeVisible()
      expect(await mainEditor.innerText()).toBe(dirtyText)
      await expect(rootSave).toHaveAttribute('data-state', 'dirty')
      await page.evaluate(() => window.getSelection()?.removeAllRanges())
      await preview.getByText('Preview searchable content.', { exact: true }).click({ button: 'right' })
      await expect(page.getByRole('menuitem', { name: '复制', exact: true })).toBeDisabled()
      await page.keyboard.press('Escape')
      await preview.getByText('Preview searchable content.', { exact: true }).click()
      await page.keyboard.press('Control+a')
      await preview.getByText('Preview searchable content.', { exact: true }).click({ button: 'right' })
      await page.getByRole('menuitem', { name: '复制', exact: true }).click()
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('Preview searchable content.')
      const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
      expect(copied).toContain('Preview searchable content.')
      expect(copied).not.toContain(UNSAVED)
      await preview.getByText('Preview searchable content.', { exact: true }).click({ button: 'right' })
      const detailPromise = app.waitForEvent('window', { timeout: 15_000 })
      await page.getByRole('menuitem', { name: '在新窗口打开该文档', exact: true }).click()
      const detail = await detailPromise
      await expect(detail.locator('.visual-editor .ProseMirror')).toContainText('Preview searchable content.')
      await page.bringToFront()
      await expect(preview.getByRole('heading', { name: 'Detail report', exact: true })).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath('document-view-retained-checklist.png') })
      const codePromise = app.waitForEvent('window', { timeout: 15_000 })
      await preview.getByRole('link', { name: 'Code location', exact: true }).click({ modifiers: ['Control'] })
      const code = await codePromise
      await expect(code.locator('.source-editor .cm-activeLine')).toHaveText('const line45 = 45;')
      await expect(code.locator('.source-editor .cm-activeLine')).toBeInViewport()
      await page.bringToFront()
      await expect(preview.getByRole('heading', { name: 'Detail report', exact: true })).toBeVisible()
    })

    await test.step('tab switches retain reading position; Ctrl+F/A and Escape stay scoped', async () => {
      const scroll = preview.locator('.document-view-scroll')
      await scroll.evaluate((element) => { element.scrollTop = 230; element.dispatchEvent(new Event('scroll')) })
      const savedScroll = await scroll.evaluate((element) => element.scrollTop)
      expect(savedScroll).toBeGreaterThan(100)
      await page.getByRole('tab', { name: 'AI 对话', exact: true }).click()
      await expect(preview).toHaveCount(0)
      await page.getByRole('tab', { name: '文档查看', exact: true }).click()
      await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(savedScroll)
      await preview.getByText('Preview searchable content.', { exact: true }).click()
      await page.keyboard.press('Control+f')
      const find = preview.getByRole('searchbox', { name: '在文档查看中查找' })
      await expect(find).toBeFocused()
      await expect(page.locator('.document-find-bar')).toHaveCount(0)
      await find.fill('searchable')
      await find.press('Enter')
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('searchable')
      await page.keyboard.press('Escape')
      await expect(find).toHaveCount(0)
      await expect(preview).toBeVisible()
      await page.keyboard.press('Control+a')
      const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
      expect(selected).toContain('Preview searchable content.')
      expect(selected).not.toContain(UNSAVED)
      await page.keyboard.insertText('SHOULD NOT EDIT A READONLY PREVIEW')
      expect(await mainEditor.innerText()).toBe(dirtyText)
      expect(await readFile(detailPath, 'utf8')).toBe(DETAIL_MARKDOWN)
    })

    await test.step('external edits require refresh; light and dark screenshots use real preferences', async () => {
      const updated = DETAIL_MARKDOWN.replace('Preview searchable content.', 'Preview changed on disk.')
      await writeFile(detailPath, updated, 'utf8')
      await page.getByRole('tab', { name: 'AI 对话', exact: true }).click()
      await page.getByRole('tab', { name: '文档查看', exact: true }).click()
      await expect(preview).toContainText('文件已更改，刷新以查看最新内容')
      await expect(preview).toContainText('Preview searchable content.')
      await preview.getByRole('button', { name: '刷新文档', exact: true }).click()
      await expect(preview).toContainText('Preview changed on disk.')
      await expect(preview).not.toContainText('文件已更改，刷新以查看最新内容')
      await preview.locator('.document-view-scroll').evaluate((element) => { element.scrollTop = 0 })
      for (const theme of ['minimal', 'dark'] as const) {
        await setTheme(page, theme)
        await expect(preview).toHaveCSS('background-color', theme === 'dark' ? 'rgb(24, 24, 24)' : 'rgb(255, 255, 255)')
        await expect(mainEditor.getByRole('link', { name: 'Report detail', exact: true }))
          .toHaveCSS('color', theme === 'dark' ? 'rgb(138, 180, 232)' : 'rgb(57, 120, 184)')
        await page.screenshot({ path: testInfo.outputPath(`document-view-markdown-${theme}.png`) })
      }
      expect(await mainEditor.innerText()).toBe(dirtyText)
      await expect(rootSave).toHaveAttribute('data-state', 'dirty')
    })

    await test.step('JSON, TSX and CSS preview literally without changing the main document', async () => {
      for (const [label, href, name, text] of [
        ['Browser JSON', './config/browser.json', 'browser.json', '<script>unsafe()</script>'],
        ['Widget TSX', './src/widget.tsx', 'widget.tsx', '<div>Literal TSX</div>'],
        ['Theme CSS', './src/theme.css', 'theme.css', '.example { color: rebeccapurple; }'],
      ]) {
        const link = mainEditor.getByRole('link', { name: label!, exact: true })
        await expect(link).toHaveAttribute('href', href!)
        await link.click({ modifiers: ['Control'] })
        await expect(preview.getByRole('button', { name: name!, exact: true })).toHaveAttribute('aria-current', 'page')
        await expect(preview.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')
        await expect(preview.locator('.cm-content')).toContainText(text!)
        await expect(preview.locator('.cm-lineNumbers')).toBeVisible()
        await expect(preview.locator('script')).toHaveCount(0)
        expect(await mainEditor.innerText()).toBe(dirtyText)
        await expect(rootSave).toHaveAttribute('data-state', 'dirty')
      }
      expect(await readFile(jsonPath)).toEqual(Buffer.from(JSON_TEXT, 'utf8'))
    })

    await test.step('breadcrumb opens a code editing window; save preserves BOM, CRLF, tabs and final newline', async () => {
      await mainEditor.getByRole('link', { name: 'Browser JSON', exact: true }).click({ modifiers: ['Control'] })
      const crumb = preview.getByRole('button', { name: 'browser.json', exact: true })
      await expect(crumb).toHaveAttribute('data-tooltip', jsonPath)
      await crumb.click({ button: 'right' })
      const childPromise = app.waitForEvent('window', { timeout: 15_000 })
      await page.getByRole('menuitem', { name: '使用新窗口打开', exact: true }).click()
      const child = await childPromise
      const editor = child.locator('.source-editor .cm-content')
      await expect(child.getByRole('heading', { name: 'browser.json', exact: true })).toBeVisible()
      await expect(editor).toBeVisible()
      await expect(editor).toHaveAttribute('contenteditable', 'true')
      await expect(child.getByRole('button', { name: '源码模式/渲染模式', exact: true })).toBeDisabled()
      await expect(child.locator('.visual-editor .ProseMirror')).toHaveCount(0)
      expect(await readFile(jsonPath)).toEqual(Buffer.from(JSON_TEXT, 'utf8'))
      await editor.click()
      await child.keyboard.press('Control+Home')
      await child.keyboard.press('ArrowDown')
      await child.keyboard.press('End')
      await child.keyboard.press('ArrowLeft')
      await child.keyboard.press('Shift+ArrowLeft')
      await child.keyboard.insertText('2')
      await expect(editor).toContainText('"value": 2,')
      await expect(child.locator('.document-save-controls')).toHaveAttribute('data-state', 'dirty')
      await saveWithNativeShortcut(app, child)
      const expected = Buffer.from(JSON_TEXT.replace('"value": 1,', '"value": 2,'), 'utf8')
      await expect.poll(async () => (await readFile(jsonPath)).equals(expected)).toBe(true)
      await expect(child.locator('.document-save-controls')).toHaveAttribute('data-state', 'saved')
      await child.screenshot({ path: testInfo.outputPath('document-view-new-window-code.png') })
      await page.bringToFront()
      expect(await mainEditor.innerText()).toBe(dirtyText)
      await expect(rootSave).toHaveAttribute('data-state', 'dirty')
    })

    await test.step('saving the root after preview preserves original relative hrefs', async () => {
      await mainEditor.click()
      await saveWithNativeShortcut(app, page)
      await expect(rootSave).toHaveAttribute('data-state', 'saved')
      const saved = await readFile(rootPath, 'utf8')
      expect(saved).toContain(UNSAVED)
      for (const href of ['./reports/detail.md', './config/browser.json', './src/widget.tsx', './src/theme.css']) {
        expect(saved).toContain(`](${href})`)
      }
      expect(saved).not.toContain(workspace)
      expect(errors).toEqual([])
    })
  } finally {
    if (runtime) {
      await shutdownElectronApplicationScope({
        application,
        executable: runtime.executable,
        requestClose: (target) => target.close(),
      })
      // The lifecycle helper must establish process-tree quiescence before either directory is removed.
      await cleanupRuntime(runtime.root)
    }
    await removeOwnedWorkspace(workspace)
  }
})

test('local link menus reveal main and preview targets and retain missing-link documents', async ({}, testInfo) => {
  const shared = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!shared) throw new Error('Audited runtime is not prepared')
  const workspace = await mkdtemp(path.join(tmpdir(), 'arkdown-document-view-workspace-'))
  let runtime: RuntimeInstance | undefined
  let application: ElectronApplication | undefined
  try {
    const target = path.join(workspace, '中文 target.md')
    const absolute = target.replaceAll('\\', '/')
    const rootText = `[Relative](<./中文 target.md>)\n\n[Absolute](<${absolute}>)\n\n[Preview](sub/detail.md)\n\n[Missing](missing.md)\n`
    await mkdir(path.join(workspace, 'sub'))
    await writeFile(target, '# Target\n')
    await writeFile(path.join(workspace, 'report.md'), rootText)
    await writeFile(path.join(workspace, 'sub/detail.md'), `[Preview relative](<../中文 target.md>)\n\n[Preview absolute](<${absolute}>)\n`)
    runtime = await createRuntimeInstance(shared, 'arkdown-document-view-runtime-')
    application = await launch(runtime, workspace)
    const app = application
    // Record the native shell boundary; actual Explorer selection is checked manually.
    await app.evaluate(({ shell }) => {
      ;(globalThis as any).__revealedFiles = []
      shell.showItemInFolder = (file) => { (globalThis as any).__revealedFiles.push(file) }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'report.md', exact: true }).click()
    const editor = page.locator('.visual-editor .ProseMirror')
    let calls = 0
    for (const label of ['Relative', 'Absolute']) {
      await editor.getByRole('link', { name: label, exact: true }).click({ button: 'right' })
      await page.getByRole('menuitem', { name: '打开文件位置', exact: true }).click()
      await expect.poll(() => app.evaluate(() => (globalThis as any).__revealedFiles)).toEqual(Array(++calls).fill(target))
    }
    await editor.getByRole('link', { name: 'Preview', exact: true }).click({ modifiers: ['Control'] })
    const preview = page.getByRole('region', { name: '文档查看', exact: true })
    for (const label of ['Preview relative', 'Preview absolute']) {
      await preview.getByRole('link', { name: label, exact: true }).click({ button: 'right' })
      await page.getByRole('menuitem', { name: '打开文件位置', exact: true }).click()
      await expect.poll(() => app.evaluate(() => (globalThis as any).__revealedFiles)).toEqual(Array(++calls).fill(target))
      await expect(preview.getByRole('button', { name: 'detail.md', exact: true })).toHaveAttribute('aria-current', 'page')
    }
    await editor.getByRole('link', { name: 'Missing', exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '打开文件位置', exact: true }).click()
    await expect(page.getByRole('alertdialog')).toContainText('无法找到文件。目标文件已不在原位置，或当前文档已被移动到新位置。')
    await page.screenshot({ path: testInfo.outputPath('local-link-missing-dialog.png') })
    await page.keyboard.press('Escape')
    expect(await readFile(path.join(workspace, 'report.md'), 'utf8')).toBe(rootText)
    await expect(preview.getByRole('link', { name: 'Preview relative', exact: true })).toBeVisible()
  } finally {
    if (runtime) {
      await shutdownElectronApplicationScope({ application, executable: runtime.executable, requestClose: (target) => target.close() })
      await cleanupRuntime(runtime.root)
    }
    await removeOwnedWorkspace(workspace)
  }
})

test('the supplied report and trial checklist keep their preview when linking back to the report', async ({}, testInfo) => {
  const originalReport = process.env.ARKDOWN_DOCUMENT_VIEW_REAL_REPORT
  test.skip(!originalReport, 'Set ARKDOWN_DOCUMENT_VIEW_REAL_REPORT for a read-only copy of the supplied report')
  test.setTimeout(120_000)
  const original = await readFile(originalReport!)
  const relative = /\[试用清单\]\(([^)]+)\)/.exec(original.toString('utf8'))?.[1]
  if (!relative || path.basename(relative) !== relative) throw new Error('Expected a sibling trial checklist')
  const originalChecklist = path.join(path.dirname(originalReport!), relative)
  const checklist = await readFile(originalChecklist)
  const shared = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!shared) throw new Error('Provenance-audited Electron E2E shared runtime is not prepared')
  const workspace = await mkdtemp(path.join(tmpdir(), 'arkdown-document-view-workspace-'))
  let runtime: RuntimeInstance | undefined
  let application: ElectronApplication | undefined
  try {
    await writeFile(path.join(workspace, path.basename(originalReport!)), original)
    await writeFile(path.join(workspace, relative), checklist)
    runtime = await createRuntimeInstance(shared, 'arkdown-document-view-runtime-')
    application = await launch(runtime, workspace)
    const page = await application.firstWindow()
    await page.getByRole('button', { name: path.basename(originalReport!), exact: true }).click()
    const editor = page.locator('.visual-editor .ProseMirror')
    await editor.getByRole('link', { name: '试用清单', exact: true }).click({ modifiers: ['Control'] })
    const preview = page.getByRole('region', { name: '文档查看', exact: true })
    await expect(preview.getByRole('link', { name: '阶段报告', exact: true })).toBeVisible()
    const previewText = await preview.locator('.document-view-content').innerText()
    await preview.getByRole('link', { name: '阶段报告', exact: true }).click({ modifiers: ['Control'] })
    await expect(editor).toBeFocused()
    expect(await preview.locator('.document-view-content').innerText()).toBe(previewText)
    await expect(preview.getByRole('button', { name: '返回上一文档', exact: true })).toBeEnabled()
    await preview.getByRole('button', { name: '返回上一文档', exact: true }).click()
    await expect(editor).toBeFocused()
    expect(await preview.locator('.document-view-content').innerText()).toBe(previewText)
    await page.screenshot({ path: testInfo.outputPath('document-view-real-report-checklist.png') })
    expect(await readFile(originalReport!)).toEqual(original)
    expect(await readFile(originalChecklist)).toEqual(checklist)
  } finally {
    if (runtime) {
      await shutdownElectronApplicationScope({ application, executable: runtime.executable, requestClose: (target) => target.close() })
      await cleanupRuntime(runtime.root)
    }
    await removeOwnedWorkspace(workspace)
  }
})
