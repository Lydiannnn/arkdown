import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  cleanupRuntime,
  createRuntimeInstance,
  runE2eStage,
  shutdownElectronApplicationScope,
} from './support/runtime'

const SEARCH_SENTINEL = 'arkdown-search-sentinel'

let application: ElectronApplication | undefined
let page: Page
let runtimeExecutable = ''
let runtimeRoot = ''
let workspace = ''

test.beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'arkdown-search-e2e-'))
  await mkdir(path.join(workspace, 'nested'))
  await Promise.all([
    writeFile(
      path.join(workspace, 'direct-hit.md'),
      `# Direct result\n\n${SEARCH_SENTINEL}\n`,
      'utf8',
    ),
    writeFile(
      path.join(workspace, 'unmatched.md'),
      '# Unmatched result\n\nThis file must not match.\n',
      'utf8',
    ),
    writeFile(
      path.join(workspace, 'nested', 'nested-hit.md'),
      `# Nested result\n\n${SEARCH_SENTINEL}\n`,
      'utf8',
    ),
  ])

  const sharedApplication = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!sharedApplication) throw new Error('Electron E2E shared runtime is not prepared')
  const runtime = await createRuntimeInstance(sharedApplication, 'arkdown-search-e2e-runtime-')
  runtimeRoot = runtime.root
  runtimeExecutable = runtime.executable

  application = await runE2eStage('连接两阶段搜索 Electron 主进程', async () => {
    return await electron.launch({
      executablePath: runtime.executable,
      cwd: runtime.application,
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
        ARKDOWN_E2E_RECOVER: '1',
        ARKDOWN_E2E_WORKSPACE: workspace,
      },
    })
  })
  page = await runE2eStage('等待两阶段搜索窗口', async () => {
    return await application!.firstWindow({ timeout: 15_000 })
  })

  page.on('console', (message) => {
    if (message.type() === 'error') console.error('Search E2E renderer console', message.text())
  })
  page.on('pageerror', (error) => {
    console.error('Search E2E renderer page error', error.stack ?? error.message)
  })

  const searchButton = page.getByRole('button', { name: '搜索工作区' })
  try {
    await expect(searchButton).toBeEnabled({ timeout: 10_000 })
  } catch (error) {
    console.error('Search E2E window diagnostic', {
      body: await page.locator('body').innerText().catch(() => '<unavailable>'),
      title: await page.title(),
      url: page.url(),
    })
    throw error
  }
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
  if (workspace) await rm(workspace, { force: true, recursive: true })
  if (runtimeRoot) await cleanupRuntime(runtimeRoot)
  workspace = ''
  runtimeExecutable = ''
  runtimeRoot = ''
})

test('pauses after root results until the user searches descendant folders', async () => {
  await page.getByRole('button', { name: '搜索工作区' }).click()
  const searchInput = page.getByRole('searchbox', { name: '搜索工作区' })
  await searchInput.fill(SEARCH_SENTINEL)
  await searchInput.press('Enter')

  const results = page.getByRole('list', { name: '工作区搜索结果' })
  const searchMore = page.getByRole('button', { name: '搜索更多层级文件夹' })
  const directResult = results.getByRole('button').filter({ hasText: 'direct-hit.md' })
  const nestedResult = results.getByRole('button').filter({ hasText: 'nested/nested-hit.md' })

  await expect(directResult).toBeVisible()
  await expect(nestedResult).toHaveCount(0)
  await expect(searchMore).toBeVisible()

  await searchMore.click()

  await expect(directResult).toBeVisible()
  await expect(nestedResult).toBeVisible()
  await expect(searchMore).toHaveCount(0)
})
