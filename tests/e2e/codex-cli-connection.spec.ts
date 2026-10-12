import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  cleanupRuntime,
  createRuntimeInstance,
  runE2eStage,
  shutdownElectronApplicationScope,
} from './support/runtime'

const FAKE_CODEX_VERSION = 'codex-cli 0.154.0-e2e'
const FAKE_CODEX_MODELS = [
  { modelId: 'arkdown-e2e-reasoning', displayName: 'E2E Reasoning', supportedReasoningEfforts: ['low', 'high', 'ultra'], defaultReasoningEffort: 'low', isDefault: true },
  { modelId: 'arkdown-e2e-fast', displayName: 'E2E Fast', supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low', isDefault: false },
]
const FORBIDDEN_PERSISTED_KEY = /(?:account|auth|credential|diagnostic|log|output|path|secret|stderr|stdout|token|api.?key)/iu

interface FakeCodexRecord {
  event: 'exit' | 'message' | 'start'
  method?: string
  mode?: string
  pid: number
  ppid?: number
}

interface PersistedModels {
  codexCli?: null | {
    cliVersion?: string
    lastTestedAt?: string
    status?: string
    models?: typeof FAKE_CODEX_MODELS
  }
  connections?: unknown[]
  aiConversation?: { connectionId?: string | null; reasoningEffort?: string }
  selectionTranslation?: { connectionId?: string | null; reasoningEffort?: string }
  screenshotTranslation?: { connectionId?: string | null; reasoningEffort?: string }
  floatingTranslation?: { connectionId?: string | null; reasoningEffort?: string; target?: string }
  version?: number
  [key: string]: unknown
}

interface PersistedSettings {
  models?: PersistedModels
}

let application: ElectronApplication | undefined
let applicationClosed = false
let applicationRootPid: number | undefined
let fakeCodexLog = ''
let page: Page
let runtimeExecutable = ''
let runtimeRoot = ''
let settingsPath = ''
let testOwnedFakePids: number[] = []
let launchOptions: NonNullable<Parameters<typeof electron.launch>[0]>

function fakeCodexSource(): string {
  return `import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const logPath = process.env.ARKDOWN_E2E_FAKE_CODEX_LOG
if (!logPath) throw new Error('ARKDOWN_E2E_FAKE_CODEX_LOG is required')
const args = process.argv.slice(2)
const mode = args.length === 1 && args[0] === '--version'
  ? '--version'
  : args.length === 1 && args[0] === 'app-server'
    ? 'app-server'
    : 'unsupported'
const record = (value) => appendFileSync(logPath, JSON.stringify(value) + '\\n', 'utf8')
const catalog = ${JSON.stringify(FAKE_CODEX_MODELS)}
record({ event: 'start', pid: process.pid, ppid: process.ppid, mode })
process.once('exit', () => record({ event: 'exit', pid: process.pid, mode }))

if (mode === 'unsupported') {
  process.stderr.write('Unsupported fake Codex arguments: ' + JSON.stringify(args) + '\\n')
  process.exitCode = 64
} else if (mode === '--version') {
  process.stdout.write('${FAKE_CODEX_VERSION}\\n')
  process.exitCode = 0
} else {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', (line) => {
    const message = JSON.parse(line)
    record({ event: 'message', pid: process.pid, method: message.method })
    if (message.id === 1 && message.method === 'initialize') {
      process.stdout.write(JSON.stringify({ id: 1, result: { userAgent: 'arkdown-e2e-fake' } }) + '\\n')
    } else if (message.id === 2 && message.method === 'account/read') {
      process.stdout.write(JSON.stringify({
        id: 2,
        result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true },
      }) + '\\n')
    } else if (message.method === 'model/list') {
      process.stdout.write(JSON.stringify({ id: message.id, result: {
        data: catalog.map((model) => ({
          model: model.modelId, displayName: model.displayName,
          supportedReasoningEfforts: model.supportedReasoningEfforts.map((reasoningEffort) => ({ reasoningEffort, description: 'Synthetic effort description' })),
          defaultReasoningEffort: model.defaultReasoningEffort, isDefault: model.isDefault, hidden: false,
          privateDiagnostic: 'E2E_PRIVATE_CATALOG_FIELD_MUST_NOT_PERSIST',
        })), nextCursor: null,
      } }) + '\\n')
    }
  })
  input.on('close', () => { process.exitCode = 0 })
}
`
}

function isolatedPath(fakeBin: string): string {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  return [fakeBin, path.join(systemRoot, 'System32'), systemRoot].join(path.delimiter)
}

function environmentWithoutPath(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLocaleUpperCase('en-US') !== 'PATH'),
  )
}

async function withDeadline<T>(label: string, operation: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs)
    operation.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

async function choosePreferencesOption(
  targetPage: Page,
  container: Page | Locator,
  label: string,
  option: string,
): Promise<void> {
  const trigger = container.getByRole('combobox', { name: label, exact: true })
  // The fourth feature can put a trigger outside the settings viewport. Finish
  // scrolling before opening; scrolling an already-open portal dismisses it.
  await trigger.scrollIntoViewIfNeeded()
  await trigger.click()
  const listbox = targetPage.getByRole('listbox', { name: label, exact: true })
  await expect(listbox).toBeVisible()
  await listbox.getByRole('option', { name: option, exact: true }).click()
  await expect(trigger).toContainText(option)
}

async function readPersistedSettings(): Promise<PersistedSettings> {
  return JSON.parse((await readFile(settingsPath, 'utf8')).replace(/^\uFEFF/u, '')) as PersistedSettings
}

async function launchPackagedApplication(): Promise<void> {
  applicationClosed = false
  application = await runE2eStage('launch packaged app with isolated fake Codex PATH', async () => await electron.launch(launchOptions))
  applicationRootPid = application.process().pid
  application.once('close', () => { applicationClosed = true })
  page = await runE2eStage('wait for packaged application window', async () => {
    const firstWindow = await withDeadline('packaged Electron first window', application!.firstWindow({ timeout: 15_000 }), 18_000)
    await expect(firstWindow.locator('.app-titlebar')).toBeVisible({ timeout: 10_000 })
    return firstWindow
  })
}

async function openModelManagement(): Promise<void> {
  const titlebar = page.getByTestId('app-titlebar')
  await titlebar.getByRole('button', { name: '文件', exact: true }).click()
  await page.getByRole('menuitem', { name: /偏好设置/u }).click()
  await expect(page.locator('.preferences-page')).toBeVisible({ timeout: 10_000 })
  await page.locator('a[href="#preferences-large-model-heading"]').click()
  const section = page.locator('.large-model-settings-section')
  await expect(section).toBeVisible()
  await section.getByRole('button', { name: '管理大模型' }).click()
  await expect(page.locator('.large-model-manager')).toBeVisible()
}

async function readFakeCodexRecords(): Promise<FakeCodexRecord[]> {
  const source = await readFile(fakeCodexLog, 'utf8').catch(() => '')
  return source.split(/\r?\n/u).filter(Boolean).map((line) => (
    JSON.parse(line) as FakeCodexRecord
  ))
}

async function refreshTrackedFakePids(): Promise<FakeCodexRecord[]> {
  const records = await readFakeCodexRecords()
  testOwnedFakePids = [...new Set([
    ...testOwnedFakePids,
    ...records.filter((record) => record.event === 'start').map(({ pid }) => pid),
  ])]
  return records
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function ownKeysRecursively(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(ownKeysRecursively)
  if (value === null || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  return Object.entries(record).flatMap(([key, candidate]) => [key, ...ownKeysRecursively(candidate)])
}

test.beforeEach(async () => {
  const sharedApplication = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!sharedApplication) throw new Error('Electron E2E shared runtime is not prepared')
  const runtime = await createRuntimeInstance(
    sharedApplication,
    'arkdown-codex-cli-e2e-runtime-',
  )
  runtimeRoot = runtime.root
  runtimeExecutable = runtime.executable
  settingsPath = path.join(runtime.portableData, 'settings.json')
  fakeCodexLog = path.join(runtime.root, 'fake-codex-lifecycle.jsonl')
  testOwnedFakePids = []
  applicationClosed = false
  applicationRootPid = undefined

  const fakeBin = path.join(runtime.root, 'fake-bin')
  const fakeScript = path.join(fakeBin, 'fake-codex.mjs')
  const wrapper = path.join(fakeBin, 'codex.cmd')
  const processTemp = path.join(runtime.root, 'process-temp')
  const workspace = path.join(runtime.root, 'workspace')
  if (!path.isAbsolute(process.execPath) || /["\r\n]/u.test(process.execPath)) {
    throw new Error('The Playwright Node executable is not safe for the fake Codex wrapper')
  }
  if (/["\r\n]/u.test(fakeScript)) {
    throw new Error('The fake Codex script path is not safe for the wrapper')
  }
  await Promise.all([
    mkdir(fakeBin, { recursive: true }),
    mkdir(processTemp, { recursive: true }),
    mkdir(runtime.portableData, { recursive: true }),
    mkdir(runtime.userData, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ])
  await Promise.all([
    writeFile(fakeScript, fakeCodexSource(), 'utf8'),
    writeFile(
      wrapper,
      `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`,
      'utf8',
    ),
    writeFile(path.join(workspace, 'codex-cli-e2e.md'), '# Codex CLI E2E\n', 'utf8'),
    writeFile(
      settingsPath,
      `${JSON.stringify({ lastWorkspace: workspace }, null, 2)}\n`,
      'utf8',
    ),
  ])

  launchOptions = {
      executablePath: runtime.executable,
      cwd: runtime.application,
      timeout: 30_000,
      args: [
        '--disable-gpu',
        `--user-data-dir=${runtime.userData}`,
      ],
      env: {
        ...environmentWithoutPath(),
        APPDATA: runtime.root,
        LOCALAPPDATA: runtime.root,
        TEMP: processTemp,
        TMP: processTemp,
        TMPDIR: processTemp,
        PATH: isolatedPath(fakeBin),
        ARKDOWN_E2E: '1',
        ARKDOWN_E2E_FAKE_CODEX_LOG: fakeCodexLog,
      },
  }
  await launchPackagedApplication()
})

test.afterEach(async () => {
  await runE2eStage('cleanup Codex CLI packaged E2E', async () => {
    const target = application
    const executable = runtimeExecutable
    const root = runtimeRoot
    const rootPid = applicationRootPid
    application = undefined
    let quiet = root === '' && executable === ''
    let cleanupFailure: unknown
    try {
      await refreshTrackedFakePids()
      if (!executable) {
        if (root) throw new Error('Codex CLI runtime has no executable scope for shutdown')
      } else {
        await shutdownElectronApplicationScope({
          application: applicationClosed ? undefined : target,
          executable,
          requestClose: async (targetApplication) => await targetApplication.close(),
          shutdownOptions: {
            gracefulTimeoutMs: 10_000,
            quietPeriodMs: 2_000,
          },
        })
      }
      await refreshTrackedFakePids()
      const survivingFakePids = testOwnedFakePids.filter(isProcessAlive)
      if (survivingFakePids.length > 0) {
        throw new Error(`Tracked fake Codex PIDs survived shutdown: ${survivingFakePids.join(', ')}`)
      }
      // Never delete the runtime if a tracked fake CLI process survived app shutdown.
      quiet = true
      console.log(
        `[Codex CLI E2E cleanup] rootPid=${String(rootPid)} fakePids=${testOwnedFakePids.join(',') || 'none'} `
        + 'gracefulTimeoutMs=10000 stableZeroProcessMs=2000',
      )
    } catch (error) {
      cleanupFailure = error
    }
    if (quiet && root) {
      try {
        await cleanupRuntime(root)
      } catch (error) {
        cleanupFailure ??= error
      }
    }
    if (quiet) {
      fakeCodexLog = ''
      runtimeExecutable = ''
      runtimeRoot = ''
      settingsPath = ''
      testOwnedFakePids = []
      applicationClosed = false
      applicationRootPid = undefined
    }
    if (cleanupFailure) throw cleanupFailure
  })
})

test('discovers CLI models, persists feature model and effort selections across restart, and clears bindings on removal', async () => {
  await runE2eStage('open large-model management', openModelManagement)

  await runE2eStage('connect through the isolated fake Codex CLI', async () => {
    await page.getByRole('button', { name: '添加大模型' }).click()
    const dialog = page.getByRole('dialog', { name: '添加大模型' })
    await expect(dialog).toBeVisible()
    await choosePreferencesOption(page, dialog, '接入类型', 'Codex CLI')
    await expect(dialog.getByLabel('API Key')).toHaveCount(0)
    await expect(dialog.getByLabel('Base URL')).toHaveCount(0)
    await dialog.getByRole('button', { name: '检测连接' }).click()
    await expect(dialog).toHaveCount(0, { timeout: 15_000 })

    const card = page.getByRole('article', { name: 'Codex CLI' })
    await expect(card).toHaveCount(1)
    await expect(card.locator('.large-model-status.is-connected')).toHaveText('连接正常')
    await card.getByRole('button', { name: 'Codex CLI详情' }).click()
    await expect(card.getByText(FAKE_CODEX_VERSION, { exact: true })).toBeVisible()
    const testedAt = card.locator('dt', { hasText: '最近检测' }).locator('..').locator('dd')
    await expect(testedAt).not.toHaveText('从未')
    await expect(testedAt).not.toHaveText('')
    await expect(card.getByText('E2E Reasoning', { exact: true })).toBeVisible()
    await expect(card.getByText('E2E Fast', { exact: true })).toBeVisible()
  })

  await runE2eStage('verify public persistence and fake process protocol cleanup', async () => {
    const models = (await readPersistedSettings()).models
    expect(models?.version).toBe(6)
    expect(models?.codexCli).toMatchObject({
      cliVersion: FAKE_CODEX_VERSION,
      status: 'connected',
    })
    expect(Number.isFinite(Date.parse(models?.codexCli?.lastTestedAt ?? ''))).toBe(true)
    expect(Object.keys(models?.codexCli ?? {}).sort()).toEqual([
      'cliVersion',
      'lastTestedAt',
      'models',
      'status',
    ])
    expect(models?.codexCli?.models).toEqual(FAKE_CODEX_MODELS)
    expect(models?.connections).toEqual([])
    expect(ownKeysRecursively(models).filter((key) => FORBIDDEN_PERSISTED_KEY.test(key))).toEqual([])
    expect(JSON.stringify(models)).not.toContain('E2E_PRIVATE_CATALOG_FIELD_MUST_NOT_PERSIST')

    await expect.poll(async () => {
      const records = await refreshTrackedFakePids()
      const starts = records.filter((record) => record.event === 'start')
      const exits = new Set(records.filter((record) => record.event === 'exit').map(({ pid }) => pid))
      return starts.length === 2 && starts.every(({ pid }) => exits.has(pid))
    }).toBe(true)
    const records = await refreshTrackedFakePids()
    expect(records.filter((record) => record.event === 'start').map(({ mode }) => mode)).toEqual([
      '--version',
      'app-server',
    ])
    expect(records.filter((record) => record.event === 'message').map(({ method }) => method)).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'model/list',
    ])
    await expect.poll(() => testOwnedFakePids.filter(isProcessAlive)).toEqual([])
  })

  await runE2eStage('assign models to all four features and reasoning efforts to the three supported controls', async () => {
    await expect(page.getByRole('combobox', { name: '悬浮翻译窗模型', exact: true }).locator('xpath=ancestor::*[contains(@class,"preferences-field")]')).toHaveClass(/large-model-unassigned-prompt/)
    await choosePreferencesOption(page, page, 'AI 对话模型', 'Codex CLI · E2E Reasoning')
    const effort = page.getByRole('combobox', { name: 'AI 对话推理强度', exact: true })
    await effort.focus()
    await effort.press('ArrowDown')
    await expect(page.getByRole('listbox', { name: 'AI 对话推理强度', exact: true }).getByRole('option')).toHaveText(['默认', '低', '高', '极致'])
    await effort.press('Escape')
    await choosePreferencesOption(page, page, 'AI 对话推理强度', '极致')

    await choosePreferencesOption(page, page, '划词翻译模型', 'Codex CLI · E2E Reasoning')
    await choosePreferencesOption(page, page, '推理强度', '高')
    await choosePreferencesOption(page, page, '截图翻译模型', 'Codex CLI · E2E Fast')
    const screenshotEffort = page.getByRole('combobox', { name: '截图翻译推理强度', exact: true })
    await screenshotEffort.focus()
    await screenshotEffort.press('ArrowDown')
    await expect(page.getByRole('listbox', { name: '截图翻译推理强度', exact: true }).getByRole('option')).toHaveText(['默认', '低', '高'])
    await screenshotEffort.press('Escape')
    await choosePreferencesOption(page, page, '截图翻译推理强度', '高')
    await choosePreferencesOption(page, page, '悬浮翻译窗模型', 'Codex CLI · E2E Fast')
    await expect(page.getByRole('combobox', { name: '悬浮翻译窗推理强度', exact: true })).toHaveCount(0)
    await choosePreferencesOption(page, page, '悬浮翻译窗目标语言', '日语')
    await expect.poll(async () => (await readPersistedSettings()).models?.floatingTranslation?.target).toBe('jp')
    await expect.poll(async () => {
      const models = (await readPersistedSettings()).models
      return [models?.aiConversation, models?.selectionTranslation, models?.screenshotTranslation, models?.floatingTranslation].map(feature => ({ connectionId: feature?.connectionId, reasoningEffort: feature?.reasoningEffort }))
    }).toEqual([
      { connectionId: 'codex-cli:arkdown-e2e-reasoning', reasoningEffort: 'ultra' },
      { connectionId: 'codex-cli:arkdown-e2e-reasoning', reasoningEffort: 'high' },
      { connectionId: 'codex-cli:arkdown-e2e-fast', reasoningEffort: 'high' },
      { connectionId: 'codex-cli:arkdown-e2e-fast', reasoningEffort: 'low' },
    ])
  })

  await runE2eStage('restart only after the packaged process tree is quiet and restore CLI selections', async () => {
    await shutdownElectronApplicationScope({
      application,
      executable: runtimeExecutable,
      requestClose: async target => await target.close(),
      shutdownOptions: { gracefulTimeoutMs: 10_000, quietPeriodMs: 2_000 },
    })
    application = undefined
    await refreshTrackedFakePids()
    expect(testOwnedFakePids.filter(isProcessAlive)).toEqual([])
    await launchPackagedApplication()
    await openModelManagement()
    for (const [label, value] of [
      ['AI 对话模型', 'Codex CLI · E2E Reasoning'], ['AI 对话推理强度', '极致'],
      ['划词翻译模型', 'Codex CLI · E2E Reasoning'], ['推理强度', '高'],
      ['截图翻译模型', 'Codex CLI · E2E Fast'], ['截图翻译推理强度', '高'],
      ['悬浮翻译窗模型', 'Codex CLI · E2E Fast'],
      ['悬浮翻译窗目标语言', '日语'],
    ]) await expect(page.getByRole('combobox', { name: label, exact: true })).toContainText(value)
    await expect(page.getByRole('combobox', { name: '悬浮翻译窗推理强度', exact: true })).toHaveCount(0)
    const models = (await readPersistedSettings()).models
    expect(models?.version).toBe(6)
    expect(models?.codexCli?.models).toEqual(FAKE_CODEX_MODELS)
    expect((await refreshTrackedFakePids()).filter(record => record.event === 'start')).toHaveLength(2)
    await choosePreferencesOption(page, page, '悬浮翻译窗目标语言', '自动')
    await expect.poll(async () => (await readPersistedSettings()).models?.floatingTranslation?.target).toBe('auto')
  })

  await runE2eStage('remove Codex CLI and clear persisted singleton state', async () => {
    const card = page.getByRole('article', { name: 'Codex CLI' })
    await card.getByRole('button', { name: 'Codex CLI详情' }).click()
    await card.getByRole('button', { name: '移除' }).click()
    const confirmation = page.getByRole('dialog', { name: '移除 Codex CLI' })
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: '移除', exact: true }).click()
    await expect(card).toHaveCount(0, { timeout: 10_000 })
    await expect.poll(async () => (await readPersistedSettings()).models?.codexCli).toBeNull()
    const models = (await readPersistedSettings()).models
    expect(models?.connections).toEqual([])
    expect([models?.aiConversation, models?.selectionTranslation, models?.screenshotTranslation, models?.floatingTranslation].map(feature => feature?.connectionId)).toEqual([null, null, null, null])
    await expect(page.getByText('暂未接入大模型，点击开始添加', { exact: true })).toBeVisible()
    for (const label of ['AI 对话模型', '划词翻译模型', '截图翻译模型', '悬浮翻译窗模型']) {
      await expect(page.getByRole('combobox', { name: label, exact: true })).toHaveCount(0)
    }
  })
})
