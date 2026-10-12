import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import {
  cleanupRuntime,
  createRuntimeInstance,
  shutdownElectronApplicationScope,
} from './support/runtime'

const API_KEY = 'arkdown-history-e2e-key'
const CONNECTION_NAME = 'History E2E Model'
const MODEL_ID = 'history-e2e-model'
const FIXED_TEST_MESSAGE = 'Reply with OK only.'
const COMPLETED = 'completed-one'
const STOPPED = 'stopped-one'
const TIMED_OUT = 'timeout-one'
const CROSS_A = 'cross-a'
const CROSS_B = 'cross-b'
const ACTIVE = 'active-stream'
const WINDOW_ONE = 'window-one'
const WINDOW_TWO = 'window-two'
const EVICTION_TOKENS = Array.from(
  { length: 100 },
  (_, index) => `evict-${String(index + 1).padStart(3, '0')}`,
)
const DOCUMENT_A = [
  '# History A',
  '',
  COMPLETED,
  '',
  STOPPED,
  '',
  TIMED_OUT,
  '',
  CROSS_A,
  '',
  ACTIVE,
  '',
  WINDOW_ONE,
  '',
  ...EVICTION_TOKENS.flatMap((token) => [token, '']),
].join('\n')
const DOCUMENT_B = ['# History B', '', CROSS_B, ''].join('\n')
const DOCUMENT_C = ['# History C', '', WINDOW_TWO, ''].join('\n')

type StreamKind = 'complete' | 'hold'

interface StreamPlan {
  first: string
  kind: StreamKind
}

class TranslationHistoryLoopback {
  private server: Server | null = null
  private readonly heldResponses = new Set<ServerResponse>()
  private readonly failures = new Set<string>()
  translationRequestCount = 0
  port = 0

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        this.failures.add('handler')
        if (!response.destroyed) response.writeHead(500).end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      const server = this.server!
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    this.port = (this.server.address() as AddressInfo).port
  }

  assertHealthy(): void {
    expect([...this.failures]).toEqual([])
  }

  async close(): Promise<void> {
    for (const response of this.heldResponses) response.destroy()
    this.heldResponses.clear()
    const server = this.server
    this.server = null
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000)
      server.close(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private planFor(content: string): StreamPlan {
    if (content === STOPPED) return { first: `partial:${content}`, kind: 'hold' }
    if (content === TIMED_OUT) return { first: `partial-timeout:${content}`, kind: 'hold' }
    if (content === ACTIVE) return { first: `active-partial:${content}`, kind: 'hold' }
    return { first: `translated:${content}`, kind: 'complete' }
  }

  private writeHeaders(response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'close',
    })
  }

  private writeDelta(response: ServerResponse, content: string): void {
    response.write(`data: ${JSON.stringify({
      choices: [{ delta: { content } }],
    })}\n\n`)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      this.failures.add('route')
      response.writeHead(404).end()
      return
    }
    if (request.headers.authorization !== `Bearer ${API_KEY}`) {
      this.failures.add('authorization')
      response.writeHead(401).end()
      return
    }
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += bytes.byteLength
      if (total > 128 * 1024) {
        this.failures.add('body-limit')
        response.writeHead(413).end()
        return
      }
      chunks.push(bytes)
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages?: Array<{ content?: unknown; role?: unknown }>
      model?: unknown
      stream?: unknown
    }
    if (payload.model !== MODEL_ID || payload.stream !== true || !Array.isArray(payload.messages)) {
      this.failures.add('envelope')
      response.writeHead(400).end()
      return
    }
    if (
      payload.messages.length === 1
      && payload.messages[0]?.role === 'user'
      && payload.messages[0].content === FIXED_TEST_MESSAGE
    ) {
      this.writeHeaders(response)
      this.writeDelta(response, 'OK')
      response.end('data: [DONE]\n\n')
      return
    }
    const user = payload.messages.at(-1)
    if (user?.role !== 'user' || typeof user.content !== 'string') {
      this.failures.add('messages')
      response.writeHead(400).end()
      return
    }
    this.translationRequestCount += 1
    const plan = this.planFor(user.content)
    this.writeHeaders(response)
    this.writeDelta(response, plan.first)
    if (plan.kind === 'complete') {
      response.end('data: [DONE]\n\n')
      return
    }
    this.heldResponses.add(response)
    response.once('close', () => this.heldResponses.delete(response))
  }
}

let application: ElectronApplication | null = null
let loopback: TranslationHistoryLoopback | null = null
let runtimeApplication = ''
let runtimeExecutable = ''
let runtimeRoot = ''
let workspace = ''

async function chooseOption(
  page: Page,
  container: Page | Locator,
  label: string,
  option: string | RegExp,
): Promise<void> {
  const trigger = container.getByRole('combobox', { name: label })
  await trigger.click()
  const listbox = page.getByRole('listbox', { name: label })
  await expect(listbox).toBeVisible()
  await listbox.getByRole('option', { name: option }).click()
}

async function configureTranslationModel(page: Page, server: TranslationHistoryLoopback): Promise<void> {
  const titlebar = page.getByTestId('app-titlebar')
  await titlebar.getByRole('button', { name: '文件', exact: true }).click()
  await page.getByRole('menuitem', { name: /偏好设置/ }).click()
  await expect(page.locator('.preferences-page')).toBeVisible()
  await page.locator('a[href="#preferences-large-model-heading"]').click()
  await page.locator('.large-model-settings-section')
    .getByRole('button', { name: '管理大模型' }).click()
  await page.getByRole('button', { name: '添加大模型' }).click()
  const dialog = page.getByRole('dialog', { name: '添加大模型' })
  await dialog.getByLabel('配置名称').fill(CONNECTION_NAME)
  await chooseOption(page, dialog, '服务商', '其他')
  await chooseOption(page, dialog, '接口协议', 'OpenAI 兼容')
  await dialog.getByLabel('Base URL').fill(`http://127.0.0.1:${server.port}/v1`)
  await dialog.getByLabel('模型 ID').fill(MODEL_ID)
  await dialog.getByLabel('API Key').fill(API_KEY)
  await dialog.getByRole('button', { name: '连接', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 15_000 })
  await chooseOption(page, page, '划词翻译模型', new RegExp(CONNECTION_NAME))
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.locator('.preferences-page')).toHaveCount(0)
}

async function dragSelectText(page: Page, text: string): Promise<void> {
  const points = await page.locator('.ProseMirror').evaluate((root, selectedText) => {
    interface TextRun { node: Text; start: number; end: number }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const runs: TextRun[] = []
    let combined = ''
    let next = walker.nextNode()
    while (next) {
      const value = next.textContent ?? ''
      runs.push({ node: next as Text, start: combined.length, end: combined.length + value.length })
      combined += value
      next = walker.nextNode()
    }
    const startIndex = combined.indexOf(selectedText)
    if (startIndex < 0) throw new Error(`Selection text not found: ${selectedText}`)
    const startRun = runs.find(({ start, end }) => startIndex >= start && startIndex < end)
    startRun?.node.parentElement?.scrollIntoView({ block: 'center' })
    const point = (index: number, end: boolean) => {
      const run = runs.find(({ start, end: runEnd }) => index >= start && index < runEnd)
      if (!run) throw new Error('Selection boundary not found')
      const range = document.createRange()
      const offset = index - run.start
      range.setStart(run.node, offset)
      range.setEnd(run.node, offset + 1)
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
      return {
        x: end ? rect.right - rect.width * 0.2 : rect.left + rect.width * 0.2,
        y: rect.top + rect.height / 2,
      }
    }
    return {
      start: point(startIndex, false),
      end: point(startIndex + selectedText.length - 1, true),
    }
  }, text)
  await page.mouse.move(points.start.x, points.start.y)
  await page.mouse.down()
  await page.mouse.move(points.end.x, points.end.y, { steps: 10 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toBe(text)
}

async function beginTranslation(page: Page, token: string): Promise<Locator> {
  const before = loopback!.translationRequestCount
  await dragSelectText(page, token)
  const popover = page.locator('.translation-popover:visible')
  await expect(popover).toBeVisible()
  await popover.getByRole('button', { name: '翻译', exact: true }).click()
  await expect.poll(() => loopback!.translationRequestCount).toBe(before + 1)
  return popover
}

async function completeTranslation(page: Page, token: string): Promise<Locator> {
  const popover = await beginTranslation(page, token)
  await expect(popover.locator('.translation-output')).toContainText(`translated:${token}`)
  await expect(popover.getByRole('button', { name: '关闭', exact: true })).toBeVisible()
  return popover
}

async function openHistoryFromPopover(popover: Locator): Promise<Locator> {
  await popover.getByRole('button', { name: '翻译记录', exact: true }).click()
  const sidebar = popover.page().locator('.editor-right-sidebar:visible')
  await expect(sidebar.locator('.translation-history-view')).toBeVisible()
  return sidebar
}

async function dismissTranslation(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.locator('.translation-popover:visible')).toHaveCount(0)
  await expect(page.locator('.editor-right-sidebar:visible')).toHaveCount(0)
}

async function openDocument(page: Page, name: string, token: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.locator('.ProseMirror')).toContainText(token)
}

async function closeApplication(target: ElectronApplication | null): Promise<void> {
  await shutdownElectronApplicationScope({
    application: target,
    executable: runtimeExecutable,
    requestClose: async (targetApplication) => await targetApplication.close(),
  })
}

async function launchRuntime(): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = path.join(runtimeRoot, 'user-data')
  const processTemp = path.join(runtimeRoot, 'process-temp')
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(processTemp, { recursive: true })])
  const app = await electron.launch({
    executablePath: runtimeExecutable,
    cwd: runtimeApplication,
    timeout: 30_000,
    args: ['--disable-gpu', `--user-data-dir=${userData}`, path.join(workspace, 'a.md')],
    env: {
      ...process.env,
      APPDATA: runtimeRoot,
      LOCALAPPDATA: runtimeRoot,
      TEMP: processTemp,
      TMP: processTemp,
      TMPDIR: processTemp,
      ARKDOWN_E2E: '1',
      ARKDOWN_E2E_WORKSPACE: workspace,
    },
  })
  const page = await app.firstWindow({ timeout: 15_000 })
  await expect(page.locator('.app-titlebar')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.ProseMirror')).toContainText(COMPLETED)
  return { app, page }
}

test.describe.configure({ mode: 'serial', timeout: 180_000 })

test.beforeEach(async () => {
  const sharedApplication = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!sharedApplication) throw new Error('Electron E2E shared runtime is not prepared')
  const runtime = await createRuntimeInstance(
    sharedApplication,
    'arkdown-translation-history-e2e-runtime-',
  )
  runtimeRoot = runtime.root
  runtimeApplication = runtime.application
  runtimeExecutable = runtime.executable
  workspace = path.join(runtimeRoot, 'workspace')
  const portableData = path.join(runtimeApplication, 'portable-data')
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(portableData, { recursive: true }),
  ])
  await Promise.all([
    writeFile(path.join(workspace, 'a.md'), DOCUMENT_A, 'utf8'),
    writeFile(path.join(workspace, 'b.md'), DOCUMENT_B, 'utf8'),
    writeFile(path.join(workspace, 'c.md'), DOCUMENT_C, 'utf8'),
    writeFile(
      path.join(portableData, 'settings.json'),
      `${JSON.stringify({ lastWorkspace: workspace }, null, 2)}\n`,
      'utf8',
    ),
  ])
  loopback = new TranslationHistoryLoopback()
  await loopback.start()
})

test.afterEach(async () => {
  const app = application
  application = null
  if (runtimeExecutable) await closeApplication(app)
  await loopback?.close()
  loopback = null
  if (runtimeRoot) await cleanupRuntime(runtimeRoot)
  runtimeApplication = ''
  runtimeExecutable = ''
  runtimeRoot = ''
  workspace = ''
})

test('covers the complete packaged translation-history lifecycle', async () => {
  const launched = await launchRuntime()
  application = launched.app
  const first = launched.page
  let survivingPage = first
  await configureTranslationModel(first, loopback!)

  await test.step('records completed, stopped partial, and partial timeout results', async () => {
    let popover = await completeTranslation(first, COMPLETED)
    let history = await openHistoryFromPopover(popover)
    await expect(history.locator('.translation-history-output')).toContainText(`translated:${COMPLETED}`)
    await expect(history.locator('.translation-history-metadata')).toContainText('已完成')
    await dismissTranslation(first)

    popover = await beginTranslation(first, STOPPED)
    await expect(popover.locator('.translation-output')).toContainText(`partial:${STOPPED}`)
    await popover.getByRole('button', { name: '停止', exact: true }).click()
    await expect(popover.locator('.translation-status')).toContainText('已停止')
    history = await openHistoryFromPopover(popover)
    await expect(history.locator('.translation-history-output')).toContainText(`partial:${STOPPED}`)
    await expect(history.locator('.translation-history-metadata')).toContainText('已停止')
    await dismissTranslation(first)

    popover = await beginTranslation(first, TIMED_OUT)
    await expect(popover.locator('.translation-output')).toContainText(`partial-timeout:${TIMED_OUT}`)
    await expect(popover.getByRole('alert')).toContainText('翻译内容过多，请分批次翻译', {
      timeout: 20_000,
    })
    await expect(popover.getByRole('button', { name: '重试' })).toHaveCount(0)
    await expect(popover).toBeVisible()
    history = await openHistoryFromPopover(popover)
    await expect(history.locator('.translation-history-output'))
      .toContainText(`partial-timeout:${TIMED_OUT}`)
    await expect(history.locator('.translation-history-metadata')).toContainText('部分结果超时')
    await dismissTranslation(first)
  })

  await test.step('isolates history by document and restores each document selection', async () => {
    let popover = await completeTranslation(first, CROSS_A)
    await popover.getByRole('button', { name: '关闭', exact: true }).click()
    await openDocument(first, 'b.md', CROSS_B)
    popover = await completeTranslation(first, CROSS_B)
    let history = await openHistoryFromPopover(popover)
    await expect(history.locator('.translation-history-output')).toContainText(`translated:${CROSS_B}`)
    await expect(history.getByRole('button', { name: '上一条', exact: true })).toBeDisabled()
    await expect(history.getByRole('button', { name: '下一条', exact: true })).toBeDisabled()
    await dismissTranslation(first)

    await openDocument(first, 'a.md', CROSS_A)
    let marker = first.locator('.translation-history-rail-button')
    await expect(marker).toHaveCount(4)
    await marker.last().click()
    history = first.locator('.editor-right-sidebar:visible')
    await expect(history.locator('.translation-history-output')).toContainText(`translated:${CROSS_A}`)
    await expect.poll(() => first.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toBe(CROSS_A)
    await expect(history.getByRole('button', { name: '上一条', exact: true })).toBeEnabled()
    await expect(history.getByRole('button', { name: '下一条', exact: true })).toBeDisabled()
    await dismissTranslation(first)

    await openDocument(first, 'b.md', CROSS_B)
    marker = first.locator('.translation-history-rail-button')
    await expect(marker).toHaveCount(1)
    await marker.click()
    history = first.locator('.editor-right-sidebar:visible')
    await expect(history.locator('.translation-history-output')).toContainText(`translated:${CROSS_B}`)
    await dismissTranslation(first)
  })

  await test.step('keeps Stop reachable while browsing history during an active stream', async () => {
    const popover = await beginTranslation(first, ACTIVE)
    await expect(popover.locator('.translation-output')).toContainText(`active-partial:${ACTIVE}`)
    await popover.getByRole('button', { name: '翻译记录', exact: true }).click()
    const history = first.locator('.editor-right-sidebar:visible')
    await expect(history.locator('.translation-history-view')).toBeVisible()
    const stop = history.getByRole('button', { name: '停止翻译', exact: true })
    await expect(stop).toBeVisible()
    await stop.click()
    await expect(history.getByRole('button', { name: '停止翻译', exact: true })).toHaveCount(0)
    await dismissTranslation(first)
  })

  await test.step('evicts the oldest record when the 100th retained record is added', async () => {
    await openDocument(first, 'a.md', EVICTION_TOKENS[0])
    for (const token of EVICTION_TOKENS) {
      const popover = await completeTranslation(first, token)
      await popover.getByRole('button', { name: '关闭', exact: true }).click()
    }
    await expect(first.locator('.translation-history-rail-button')).toHaveCount(99)
    await dragSelectText(first, EVICTION_TOKENS.at(-1)!)
    const entry = first.locator('.translation-popover:visible')
    await entry.getByRole('button', { name: '翻译记录', exact: true }).click()
    const history = first.locator('.editor-right-sidebar:visible')
    for (let index = 0; index < 98; index += 1) {
      await history.getByRole('button', { name: '上一条', exact: true }).click()
    }
    await expect(history.getByRole('button', { name: '上一条', exact: true })).toBeDisabled()
    await expect(history.locator('.translation-history-output'))
      .toContainText(`translated:${EVICTION_TOKENS[1]}`)
    await expect(history.locator('.translation-history-output'))
      .not.toContainText(`translated:${EVICTION_TOKENS[0]}`)
    await dismissTranslation(first)
  })

  await test.step('isolates records between two Arkdown windows', async () => {
    const firstOwnerPromise = application!.waitForEvent('window')
    await first.getByTestId('app-titlebar').getByRole('button', { name: '文件', exact: true }).click()
    await first.getByRole('menuitem', { name: '新建窗口', exact: true }).click()
    const firstOwner = await firstOwnerPromise
    await expect(firstOwner.locator('.app-titlebar')).toBeVisible()
    await openDocument(firstOwner, 'a.md', WINDOW_ONE)
    let popover = await completeTranslation(firstOwner, WINDOW_ONE)
    const firstHistory = await openHistoryFromPopover(popover)

    const secondOwnerPromise = application!.waitForEvent('window')
    await firstOwner.getByTestId('app-titlebar').getByRole('button', { name: '文件', exact: true }).click()
    await firstOwner.getByRole('menuitem', { name: '新建窗口', exact: true }).click()
    const secondOwner = await secondOwnerPromise
    await expect(secondOwner.locator('.app-titlebar')).toBeVisible()
    await openDocument(secondOwner, 'c.md', WINDOW_TWO)
    popover = await completeTranslation(secondOwner, WINDOW_TWO)
    const secondHistory = await openHistoryFromPopover(popover)

    for (const history of [firstHistory, secondHistory]) {
      await expect(history.getByRole('button', { name: '上一条', exact: true })).toBeDisabled()
      await expect(history.getByRole('button', { name: '下一条', exact: true })).toBeDisabled()
    }
    await expect(secondHistory.locator('.translation-history-output')).toContainText(`translated:${WINDOW_TWO}`)
    await expect(secondHistory.locator('.translation-history-output')).not.toContainText(WINDOW_ONE)
    await expect(firstHistory.locator('.translation-history-output')).toContainText(`translated:${WINDOW_ONE}`)
    await expect(firstHistory.locator('.translation-history-output')).not.toContainText(WINDOW_TWO)

    const firstOwnerClosed = firstOwner.waitForEvent('close')
    await firstOwner.locator('.window-close-button').click()
    await firstOwnerClosed
    await expect(secondHistory.locator('.translation-history-output')).toContainText(`translated:${WINDOW_TWO}`)
    await expect(secondHistory.locator('.translation-history-output')).not.toContainText(WINDOW_ONE)
    await expect(secondHistory.getByRole('button', { name: '上一条', exact: true })).toBeDisabled()
    await expect(secondHistory.getByRole('button', { name: '下一条', exact: true })).toBeDisabled()

    const originalClosed = first.waitForEvent('close')
    await first.locator('.window-close-button').click()
    await originalClosed
    survivingPage = secondOwner
  })

  await test.step('closes gracefully, observes 2000 ms quiet, and restarts empty', async () => {
    await shutdownElectronApplicationScope({
      application,
      executable: runtimeExecutable,
      requestClose: async () => await survivingPage.locator('.window-close-button').click(),
    })
    application = null

    const restarted = await launchRuntime()
    application = restarted.app
    await expect(restarted.page.locator('.translation-history-rail-button')).toHaveCount(0)
    await expect(restarted.page.locator('.translation-history-view')).toHaveCount(0)
    await shutdownElectronApplicationScope({
      application: restarted.app,
      executable: runtimeExecutable,
      requestClose: async () => await restarted.page.locator('.window-close-button').click(),
    })
    application = null
  })

  loopback!.assertHealthy()
})
