import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  cleanupRuntime,
  createRuntimeInstance,
  runE2eStage,
  shutdownElectronApplicationScope,
} from './support/runtime'

const LINE_BREAK_TEXT = 'First line\nSecond line\n'
const LIST_LINE_TEXT = '第一行\n第二行\n第三行\n'
const LIST_CASES = [
  { command: 'ordered-list', file: 'ordered-lines.md', selector: 'ol > .milkdown-list-item-block' },
  { command: 'unordered-list', file: 'unordered-lines.md', selector: 'ul > .milkdown-list-item-block' },
  { command: 'task-list', file: 'task-lines.md', selector: 'ul > .milkdown-list-item-block' },
] as const

let application: ElectronApplication | undefined
let page: Page
let runtimeApplication: string
let runtimeExecutable: string
let runtimeRoot: string
let workspace: string

async function launchWorkspace(): Promise<void> {
  application = await runE2eStage('连接 Electron 主进程', async () => {
    return await electron.launch({
      executablePath: path.join(runtimeApplication, 'Arkdown.exe'),
      cwd: runtimeApplication,
      timeout: 30_000,
      args: [
        '--disable-gpu',
        `--user-data-dir=${path.join(runtimeRoot, 'user-data')}`,
      ],
      env: {
        ...process.env,
        APPDATA: runtimeRoot,
        LOCALAPPDATA: runtimeRoot,
        ARKDOWN_E2E: '1',
        ARKDOWN_E2E_WORKSPACE: workspace,
      },
    })
  })
  page = await runE2eStage('等待首个窗口', async () => {
    return await application!.firstWindow({ timeout: 15_000 })
  })
  await expect(page.getByRole('button', { name: 'linebreaks.md', exact: true }))
    .toBeVisible({ timeout: 10_000 })
}

test.beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'arkdown-linebreaks-e2e-'))
  const sharedApplication = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!sharedApplication) throw new Error('Electron E2E shared runtime is not prepared')
  const runtime = await createRuntimeInstance(sharedApplication, 'arkdown-linebreaks-runtime-')
  runtimeRoot = runtime.root
  runtimeApplication = runtime.application
  runtimeExecutable = runtime.executable
  await writeFile(path.join(workspace, 'linebreaks.md'), LINE_BREAK_TEXT, 'utf8')
  await Promise.all(LIST_CASES.map(({ file }) =>
    writeFile(path.join(workspace, file), LIST_LINE_TEXT, 'utf8'),
  ))
  await launchWorkspace()
})

test.afterEach(async () => {
  const target = application
  application = undefined
  if (runtimeExecutable) {
    await shutdownElectronApplicationScope({
      application: target,
      executable: runtimeExecutable,
      requestClose: async (targetApplication) => await targetApplication.close(),
    })
  }
  if (workspace) {
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  if (runtimeRoot) {
    await runE2eStage('清理隔离运行实例', async () => {
      await cleanupRuntime(runtimeRoot)
    })
  }
})

test('preserves single source line breaks only while the preference is enabled', async () => {
  await page.getByRole('button', { name: 'linebreaks.md', exact: true }).click()
  await expect(page.locator('.ProseMirror')).toBeVisible()

  const appShell = page.locator('.app-shell')
  await expect(appShell).toHaveClass(/preserve-single-line-breaks/)
  await expect(page.locator(
    '.ProseMirror span[data-type="hardbreak"][data-is-inline="true"]',
  )).toHaveCount(1)

  const lineTops = async () => page.locator('.ProseMirror p').evaluate((paragraph) => {
    const placeholder = paragraph.querySelector(
      'span[data-type="hardbreak"][data-is-inline="true"]',
    )
    const firstText = placeholder?.previousSibling
    const secondText = placeholder?.nextSibling
    if (!placeholder || !firstText || !secondText) {
      throw new Error('Expected text nodes around the inline hardbreak placeholder')
    }
    const top = (node: Node) => {
      const range = document.createRange()
      range.selectNodeContents(node)
      return range.getBoundingClientRect().top
    }
    return { first: top(firstText), second: top(secondText) }
  })

  const enabled = await lineTops()
  expect(enabled.second).toBeGreaterThan(enabled.first + 1)

  await appShell.evaluate((element) => {
    element.classList.remove('preserve-single-line-breaks')
  })
  const disabled = await lineTops()
  expect(Math.abs(disabled.second - disabled.first)).toBeLessThanOrEqual(1)

  await appShell.evaluate((element) => {
    element.classList.add('preserve-single-line-breaks')
  })
  const visual = page.locator('.ProseMirror')
  await visual.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('!')
  await page.keyboard.press('Control+S')

  await expect.poll(async () => readFile(
    path.join(workspace, 'linebreaks.md'),
    'utf8',
  )).toContain('First line\nSecond line!')
  const saved = await readFile(path.join(workspace, 'linebreaks.md'), 'utf8')
  expect(saved).not.toContain('<br')
  expect(saved).not.toMatch(/ {2,}\n/u)
})

test('turns selected real line breaks into separate ordered, unordered, and task items', async () => {
  for (const { command, file, selector } of LIST_CASES) {
    await page.getByRole('button', { name: file, exact: true }).click()
    const paragraph = page.locator('.ProseMirror p').first()
    await expect(paragraph.locator('span[data-type="hardbreak"][data-is-inline="true"]'))
      .toHaveCount(2)

    await paragraph.evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toContain('第三行')

    await page.evaluate((detail) => {
      window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail }))
    }, command)

    const items = page.locator(`.ProseMirror ${selector}`)
    await expect(items).toHaveCount(3)
    await expect(items.locator('p')).toHaveText(['第一行', '第二行', '第三行'])
    if (command === 'task-list') {
      await expect(page.locator('.ProseMirror .label.unchecked')).toHaveCount(3)
    }
    await page.keyboard.press('Control+S')
    await expect(page.getByRole('status')).toContainText('已保存', { timeout: 5_000 })
  }
})
