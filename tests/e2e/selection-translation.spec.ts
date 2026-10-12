import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
  runE2eStage,
  shutdownElectronApplicationScope,
} from './support/runtime'

const API_KEY = 'arkdown-selection-e2e-secret'
const CONNECTION_NAME = 'E2E Selection Translation'
const MODEL_ID = 'e2e-selection-model'
const FIXED_TEST_MESSAGE = 'Reply with OK only.'
const SHORT_SENTINEL = '短文本哨兵'
const ADJACENT_SECRET = '相邻机密绝不外发-SECRET-7093'
const MULTILINE_FIRST = '多行哨兵第一行'
const MULTILINE_SECOND = '多行哨兵第二行'
const MULTILINE_SENTINEL = `${MULTILINE_FIRST}\n${MULTILINE_SECOND}`
const MULTILINE_MARKDOWN = [MULTILINE_FIRST + '\\', MULTILINE_SECOND].join('\n')
const SOURCE_SENTINEL =
  '[源码链接](https://example.invalid/selected-path) 与 `inline_code`'
const CANCELLATION_SENTINEL = '取消延迟哨兵'
const STRUCTURED_LIST_MARKDOWN = '2. Lei\n3. Lin'
const STRUCTURED_LIST_DOM_SELECTION = 'Lei\n\n3.\nLin'
const NO_OUTPUT_SENTINEL = '无输出超时哨兵'
const PARTIAL_TIMEOUT_SENTINEL = '部分输出超时哨兵'
const ACTIVITY_RESET_SENTINEL = '持续活动重置哨兵'
const STRUCTURED_LIST_RESULT = '2. Lei translated\n3. Lin translated'
const PARTIAL_TIMEOUT_RESULT = 'partial output retained'
const ACTIVITY_DELTA = 'active-stream-output '.repeat(420)
const SHORT_RESULT_PARTS = ['Short sentinel ', 'translated'] as const
const MULTILINE_RESULT_PARTS = ['First translated line\n', 'Second translated line'] as const
const SOURCE_RESULT_PARTS = [
  '[Translated source](https://example.invalid/selected-path) and ',
  '`inline_code`',
] as const
const CANCELLATION_FIRST_DELTA = 'Cancellation started'
const CANCELLATION_HELD_DELTA = ' - forbidden later delta'
const FULL_DOCUMENT_MARKDOWN = '# 全文翻译测试\n\n' + '完整文档翻译须保留原文与撤销历史。'.repeat(8) + '\n\n末段'
const FULL_DOCUMENT_UNDO_MARKER = '撤销标记'
const FULL_DOCUMENT_REQUEST = FULL_DOCUMENT_MARKDOWN + FULL_DOCUMENT_UNDO_MARKER
const translationSystemMessage = (language: 'en' | 'zh-CN') =>
  `Translate natural-language text in the user's Markdown into ${language}. Preserve Markdown markers, hierarchy, ordered-list numbers, table column count, URLs, resource paths, and code. Translate link text and image alt text, but do not change link targets. Output only the translated Markdown. Do not add explanations, code fences, or new structure.`
const VISUAL_SYSTEM_MESSAGE = translationSystemMessage('en')
const SOURCE_SYSTEM_MESSAGE = translationSystemMessage('en')
const STRUCTURED_SYSTEM_MESSAGE = translationSystemMessage('zh-CN')
const MAX_REQUEST_BODY_BYTES = 64 * 1024

async function choosePreferencesOption(
  page: Page,
  container: Page | Locator,
  label: string,
  option: string,
): Promise<void> {
  const trigger = container.getByRole('combobox', { name: label })
  await trigger.click()
  const listbox = page.getByRole('listbox', { name: label })
  await expect(listbox).toBeVisible()
  await listbox.getByRole('option', { name: option, exact: true }).click()
  await expect(trigger).toContainText(option)
}
const SENSITIVE_LOG_MARKERS = [
  API_KEY,
  SHORT_SENTINEL,
  ADJACENT_SECRET,
  MULTILINE_FIRST,
  MULTILINE_SECOND,
  MULTILINE_MARKDOWN,
  SOURCE_SENTINEL,
  CANCELLATION_SENTINEL,
  STRUCTURED_LIST_MARKDOWN,
  NO_OUTPUT_SENTINEL,
  PARTIAL_TIMEOUT_SENTINEL,
  ACTIVITY_RESET_SENTINEL,
  VISUAL_SYSTEM_MESSAGE,
  SOURCE_SYSTEM_MESSAGE,
  ...SHORT_RESULT_PARTS,
  ...MULTILINE_RESULT_PARTS,
  ...SOURCE_RESULT_PARTS,
  CANCELLATION_FIRST_DELTA,
  CANCELLATION_HELD_DELTA,
  FULL_DOCUMENT_REQUEST,
  STRUCTURED_LIST_RESULT,
  PARTIAL_TIMEOUT_RESULT,
  ACTIVITY_DELTA,
] as const
const SENSITIVE_LOG_MARKER_BUFFERS = SENSITIVE_LOG_MARKERS.map((marker) => (
  Buffer.from(marker, 'utf8')
))
const MAX_SENSITIVE_LOG_MARKER_BYTES = Math.max(
  ...SENSITIVE_LOG_MARKER_BUFFERS.map((marker) => marker.byteLength),
)

const FIXTURE_MARKDOWN = [
  '# 划词翻译 E2E',
  '',
  `${SHORT_SENTINEL} ${ADJACENT_SECRET}`,
  '',
  `${MULTILINE_FIRST}  `,
  MULTILINE_SECOND,
  '',
  SOURCE_SENTINEL,
  '',
  CANCELLATION_SENTINEL,
  '',
  STRUCTURED_LIST_MARKDOWN,
  '',
  NO_OUTPUT_SENTINEL,
  '',
  PARTIAL_TIMEOUT_SENTINEL,
  '',
  ACTIVITY_RESET_SENTINEL,
  '',
].join('\n')

interface TranslationRequestRecord {
  containsAdjacentSecret: boolean
  systemContent: string
  userContent: string
}

interface OpenAiPayload {
  messages?: unknown
  model?: unknown
  stream?: unknown
}

class TranslationLoopbackServer {
  private server: Server | undefined
  private readonly timers = new Set<NodeJS.Timeout>()
  private readonly records: TranslationRequestRecord[] = []
  private readonly failures = new Set<string>()
  private heldCancellationResponse: ServerResponse | undefined
  private closing = false
  cancellationClosed = false
  fixedRequestCount = 0
  port = 0

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response).catch(() => {
        this.failures.add('request-handler')
        if (response.destroyed) return
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      const server = this.server!
      const onError = (error: Error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1')
    })
    this.port = (this.server.address() as AddressInfo).port
  }

  get translationRequestCount(): number {
    return this.records.length
  }

  hasExactTranslationRequest(index: number, expected: {
    systemContent: string
    userContent: string
  }): boolean {
    const record = this.records[index]
    return record?.systemContent === expected.systemContent
      && record.userContent === expected.userContent
  }

  requestContainsAdjacentSecret(index: number): boolean | undefined {
    return this.records[index]?.containsAdjacentSecret
  }

  isHealthy(): boolean {
    return this.failures.size === 0
  }

  async close(): Promise<void> {
    this.closing = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.heldCancellationResponse?.destroy()
    this.heldCancellationResponse = undefined

    const server = this.server
    this.server = undefined
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 2_000)
      server.close(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
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
    let byteLength = 0
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      byteLength += bytes.byteLength
      if (byteLength > MAX_REQUEST_BODY_BYTES) {
        this.failures.add('request-body-limit')
        response.writeHead(413).end()
        return
      }
      chunks.push(bytes)
    }

    let payload: OpenAiPayload
    let rawBody = Buffer.concat(chunks, byteLength).toString('utf8')
    chunks.length = 0
    try {
      payload = JSON.parse(rawBody) as OpenAiPayload
    } catch {
      rawBody = ''
      this.failures.add('request-json')
      response.writeHead(400).end()
      return
    }
    const containsAdjacentSecret = rawBody.includes(ADJACENT_SECRET)
    rawBody = ''

    if (payload.model !== MODEL_ID || payload.stream !== true) {
      this.failures.add('request-envelope')
      response.writeHead(400).end()
      return
    }
    if (!Array.isArray(payload.messages)) {
      this.failures.add('messages-shape')
      response.writeHead(400).end()
      return
    }

    const messages = payload.messages as {
      content?: unknown
      role?: unknown
    }[]
    if (
      messages.length === 1
      && messages[0]?.role === 'user'
      && messages[0].content === FIXED_TEST_MESSAGE
    ) {
      this.fixedRequestCount += 1
      this.sendFixedSuccess(response)
      return
    }
    if (
      messages.length !== 2
      || messages[0]?.role !== 'system'
      || typeof messages[0].content !== 'string'
      || messages[1]?.role !== 'user'
      || typeof messages[1].content !== 'string'
    ) {
      this.failures.add('translation-messages-shape')
      response.writeHead(400).end()
      return
    }

    const systemContent = messages[0].content
    const userContent = messages[1].content
    const resultParts = this.resultPartsFor(userContent, systemContent)
    if (!resultParts) {
      this.failures.add('translation-content')
      response.writeHead(400).end()
      return
    }
    this.records.push({
      containsAdjacentSecret,
      systemContent,
      userContent,
    })

    if (userContent === CANCELLATION_SENTINEL || userContent.trimEnd() === FULL_DOCUMENT_REQUEST) {
      this.sendCancellationStart(response)
      return
    }
    if (userContent === NO_OUTPUT_SENTINEL) {
      this.sendHeldStream(response)
      return
    }
    if (userContent === PARTIAL_TIMEOUT_SENTINEL) {
      this.sendHeldStream(response, PARTIAL_TIMEOUT_RESULT)
      return
    }
    if (userContent === ACTIVITY_RESET_SENTINEL) {
      this.sendActiveHeldStream(response)
      return
    }
    this.sendTwoPartSuccess(response, resultParts)
  }

  private resultPartsFor(
    userContent: string,
    systemContent: string,
  ): readonly [string, string] | undefined {
    if (userContent.trimEnd() === FULL_DOCUMENT_REQUEST && systemContent === VISUAL_SYSTEM_MESSAGE) {
      return [CANCELLATION_FIRST_DELTA, CANCELLATION_HELD_DELTA]
    }
    if (userContent === SHORT_SENTINEL && systemContent === VISUAL_SYSTEM_MESSAGE) {
      return SHORT_RESULT_PARTS
    }
    if (userContent === MULTILINE_MARKDOWN && systemContent === VISUAL_SYSTEM_MESSAGE) {
      return MULTILINE_RESULT_PARTS
    }
    if (userContent === SOURCE_SENTINEL && systemContent === SOURCE_SYSTEM_MESSAGE) {
      return SOURCE_RESULT_PARTS
    }
    if (userContent === CANCELLATION_SENTINEL && systemContent === VISUAL_SYSTEM_MESSAGE) {
      return [CANCELLATION_FIRST_DELTA, CANCELLATION_HELD_DELTA]
    }
    if (userContent === STRUCTURED_LIST_MARKDOWN && systemContent === STRUCTURED_SYSTEM_MESSAGE) {
      return [STRUCTURED_LIST_RESULT, '']
    }
    if (userContent === NO_OUTPUT_SENTINEL && systemContent === VISUAL_SYSTEM_MESSAGE) {
      return ['', '']
    }
    if (userContent === PARTIAL_TIMEOUT_SENTINEL && systemContent === VISUAL_SYSTEM_MESSAGE) {
      return [PARTIAL_TIMEOUT_RESULT, '']
    }
    if (userContent === ACTIVITY_RESET_SENTINEL && systemContent === VISUAL_SYSTEM_MESSAGE) {
      return [ACTIVITY_DELTA, '']
    }
    return undefined
  }

  private writeSseDelta(response: ServerResponse, delta: string): void {
    response.write(`data: ${JSON.stringify({
      choices: [{ delta: { content: delta } }],
    })}\n\n`)
  }

  private writeSseHeaders(response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'close',
    })
  }

  private sendFixedSuccess(response: ServerResponse): void {
    this.writeSseHeaders(response)
    this.writeSseDelta(response, 'O')
    this.writeSseDelta(response, 'K')
    response.end('data: [DONE]\n\n')
  }

  private sendTwoPartSuccess(
    response: ServerResponse,
    parts: readonly [string, string],
  ): void {
    this.writeSseHeaders(response)
    this.writeSseDelta(response, parts[0])
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (response.destroyed) return
      this.writeSseDelta(response, parts[1])
      response.end('data: [DONE]\n\n')
    }, 50)
    this.timers.add(timer)
  }

  private sendCancellationStart(response: ServerResponse): void {
    this.cancellationClosed = false
    this.writeSseHeaders(response)
    let completed = false
    response.once('close', () => {
      if (completed || this.closing) return
      this.cancellationClosed = true
      if (this.heldCancellationResponse === response) {
        this.heldCancellationResponse = undefined
      }
    })
    response.once('finish', () => {
      completed = true
    })
    response.once('error', () => {
      if (!this.closing && !this.cancellationClosed) {
        this.failures.add('cancellation-response')
      }
    })
    this.heldCancellationResponse = response
    this.writeSseDelta(response, CANCELLATION_FIRST_DELTA)
  }

  private sendHeldStream(response: ServerResponse, initialDelta?: string): void {
    this.writeSseHeaders(response)
    this.heldCancellationResponse = response
    if (initialDelta) this.writeSseDelta(response, initialDelta)
    response.once('close', () => {
      if (this.heldCancellationResponse === response) this.heldCancellationResponse = undefined
    })
  }

  private sendActiveHeldStream(response: ServerResponse): void {
    this.sendHeldStream(response, ACTIVITY_DELTA)
    for (const delayMs of [7_000, 14_000]) {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        if (!response.destroyed) this.writeSseDelta(response, ACTIVITY_DELTA)
      }, delayMs)
      this.timers.add(timer)
    }
  }
}

let application: ElectronApplication | undefined
let runtimeProcess: ChildProcess | undefined
let runtimeProcessClosed: Promise<void> | undefined
let loopback: TranslationLoopbackServer | undefined
let page: Page | undefined
let runtimeApplication = ''
let runtimeRoot = ''
let workspace = ''
let fixturePath = ''
let rendererFailureCount = 0
let rendererStartupFailures: string[] = []
let mainProcessDiagnostics: string[] = []
let processExitDiagnostic = 'not-exited'
let sensitiveDiagnosticObserved = false
let mainProcessDiagnosticTails = {
  stderr: Buffer.alloc(0),
  stdout: Buffer.alloc(0),
}

function scanMainProcessDiagnostic(
  stream: keyof typeof mainProcessDiagnosticTails,
  value: unknown,
): void {
  const diagnostic = Buffer.isBuffer(value)
    ? value
    : Buffer.from(String(value), 'utf8')
  const combined = Buffer.concat([mainProcessDiagnosticTails[stream], diagnostic])
  if (SENSITIVE_LOG_MARKER_BUFFERS.some((marker) => combined.includes(marker))) {
    sensitiveDiagnosticObserved = true
  }
  mainProcessDiagnosticTails[stream] = combined.subarray(
    Math.max(0, combined.byteLength - (MAX_SENSITIVE_LOG_MARKER_BYTES - 1)),
  )
  if (mainProcessDiagnostics.join('').length < 2_000) {
    mainProcessDiagnostics.push(
      `${stream}: [diagnostic ${diagnostic.byteLength} bytes]`,
    )
  }
}

function collectSanitizedDiagnostic(
  target: string[],
  label: string,
  value: unknown,
): void {
  const diagnostic = String(value)
  if (SENSITIVE_LOG_MARKERS.some((marker) => diagnostic.includes(marker))) {
    sensitiveDiagnosticObserved = true
  }
  if (target.join('').length >= 2_000) return
  let sanitized = diagnostic
  for (const marker of SENSITIVE_LOG_MARKERS) {
    sanitized = sanitized.replaceAll(marker, '[redacted]')
  }
  target.push(`${label}: ${sanitized.slice(0, 500)}`)
}

async function withDeadline<T>(
  label: string,
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${label} exceeded ${timeoutMs} ms`)),
      timeoutMs,
    )
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

function activePage(): Page {
  if (!page) throw new Error('Packaged application page is unavailable')
  return page
}

function activeServer(): TranslationLoopbackServer {
  if (!loopback) throw new Error('Loopback server is unavailable')
  return loopback
}

async function dragSelectText(options: {
  rootSelector: string
  startText: string
  endText?: string
  expectedSelection: string
}): Promise<void> {
  const appPage = activePage()
  const points = await appPage.locator(options.rootSelector).evaluate(
    (root, input) => {
      interface TextRun {
        end: number
        node: Text
        start: number
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const runs: TextRun[] = []
      let combined = ''
      let node = walker.nextNode()
      while (node) {
        const text = node.textContent ?? ''
        const start = combined.length
        combined += text
        runs.push({ node: node as Text, start, end: combined.length })
        node = walker.nextNode()
      }

      const findPoint = (text: string, atEnd: boolean) => {
        const match = combined.indexOf(text)
        if (match < 0) throw new Error('Selection glyph text was not found')
        const characterIndex = atEnd
          ? match + text.length - 1
          : match
        const run = runs.find(
          (candidate) => characterIndex >= candidate.start && characterIndex < candidate.end,
        )
        if (!run) throw new Error('Selection glyph boundary was not found')
        const localOffset = characterIndex - run.start
        const range = document.createRange()
        range.setStart(run.node, localOffset)
        range.setEnd(run.node, localOffset + 1)
        const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
        if (
          !Number.isFinite(rect.left)
          || !Number.isFinite(rect.top)
          || rect.width <= 0
          || rect.height <= 0
        ) {
          throw new Error('Selection glyph has no finite viewport rectangle')
        }
        return {
          x: atEnd ? rect.right - rect.width * 0.2 : rect.left + rect.width * 0.2,
          y: rect.top + rect.height / 2,
        }
      }

      return {
        start: findPoint(input.startText, false),
        end: findPoint(input.endText ?? input.startText, true),
      }
    },
    {
      startText: options.startText,
      endText: options.endText,
    },
  )

  await appPage.mouse.move(points.start.x, points.start.y)
  await appPage.mouse.down({ button: 'left' })
  await appPage.mouse.move(points.end.x, points.end.y, { steps: 12 })
  await appPage.mouse.up({ button: 'left' })

  await expect.poll(async () => (
    await appPage.evaluate((expected) => {
      const actual = window.getSelection()?.toString().replace(/\r\n?/gu, '\n') ?? ''
      return actual === expected
    }, options.expectedSelection)
  ), { timeout: 5_000 }).toBe(true)
}

async function visualEditorSnapshot(): Promise<string> {
  return await activePage().locator('.ProseMirror').evaluate((element) => {
    const descriptor = (element as HTMLElement & {
      pmViewDesc?: { node?: { type?: { name?: string }; toJSON?(): unknown } }
    }).pmViewDesc
    const node = descriptor?.node
    if (node?.type?.name !== 'doc' || typeof node.toJSON !== 'function') {
      throw new Error('Visual document snapshot is unavailable')
    }
    return JSON.stringify(node.toJSON())
  })
}

async function sourceEditorSnapshot(): Promise<string> {
  return (
    await activePage().locator('.source-editor .cm-line').allTextContents()
  ).join('\n')
}

async function assertFixtureFileUnchanged(): Promise<void> {
  expect((await readFile(fixturePath, 'utf8')) === FIXTURE_MARKDOWN).toBe(true)
}

async function assertDisplayedOutput(
  selector: string,
  expectedOutput: string,
): Promise<void> {
  const output = activePage().locator(selector)
  await expect(output).toBeVisible({ timeout: 10_000 })
  await expect.poll(async () => (await output.textContent()) === expectedOutput, {
    timeout: 10_000,
  }).toBe(true)
}

async function startSelectionTranslationInSidebar(): Promise<Locator> {
  const appPage = activePage()
  const trigger = appPage.getByRole('dialog', { name: '划词翻译', exact: true })
  await expect(trigger).toBeVisible()
  await trigger.getByRole('button', { name: '翻译选中的文本', exact: true }).click()
  await expect(trigger).toHaveCount(0)
  const sidebar = appPage.getByRole('complementary', { name: '右侧栏', exact: true })
  await expect(sidebar).toBeVisible({ timeout: 10_000 })
  await expect(sidebar.getByRole('tab', { name: '翻译', exact: true }))
    .toHaveAttribute('aria-selected', 'true')
  await expect(sidebar.getByRole('tabpanel', { name: '翻译', exact: true })).toBeVisible()
  await expect(appPage.getByTestId('editor-right-sidebar-motion-track'))
    .toHaveAttribute('data-phase', 'open')
  return sidebar
}

async function closeTranslationSidebar(sidebar: Locator): Promise<void> {
  await sidebar.locator('.translation-sidebar-live-scroll')
    .getByRole('button', { name: '关闭', exact: true }).click()
  await expect(sidebar).toHaveCount(0)
}

async function assertNativeCopiedMarkdown(copy: Locator, expectedMarkdown: string): Promise<void> {
  const target = application
  if (!target) throw new Error('Translation Electron application is unavailable')
  const previous = await target.evaluate(({ clipboard }) => ({
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: clipboard.readImage().toPNG().toString('base64'),
  }))
  try {
    await copy.click()
    // Compare in Electron so failed assertions never print the user's clipboard.
    await expect.poll(async () => await target.evaluate(
      ({ clipboard }, expected) => clipboard.readText() === expected,
      expectedMarkdown,
    ), { timeout: 10_000 }).toBe(true)
  } finally {
    await target.evaluate(({ clipboard, nativeImage }, saved) => {
      clipboard.write({
        text: saved.text,
        html: saved.html,
        rtf: saved.rtf,
        ...(saved.image ? {
          image: nativeImage.createFromBuffer(Buffer.from(saved.image, 'base64')),
        } : {}),
      })
    }, previous)
  }
}

test.describe.configure({ timeout: 240_000 })

test.beforeEach(async () => {
  rendererFailureCount = 0
  rendererStartupFailures = []
  mainProcessDiagnostics = []
  processExitDiagnostic = 'not-exited'
  sensitiveDiagnosticObserved = false
  mainProcessDiagnosticTails = {
    stderr: Buffer.alloc(0),
    stdout: Buffer.alloc(0),
  }
  runtimeProcess = undefined
  runtimeProcessClosed = undefined
  loopback = new TranslationLoopbackServer()
  await runE2eStage('start bounded loopback translation server', async () => {
    await loopback!.start()
  })

  const sharedApplication = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!sharedApplication) throw new Error('Electron E2E shared runtime is not prepared')
  const runtime = await createRuntimeInstance(
    sharedApplication,
    'arkdown-selection-translation-e2e-runtime-',
  )
  runtimeRoot = runtime.root
  runtimeApplication = runtime.application
  const userData = path.join(runtimeRoot, 'user-data')
  const processTemp = path.join(runtimeRoot, 'process-temp')
  workspace = path.join(runtimeRoot, 'workspace')
  const portableData = path.join(runtimeApplication, 'portable-data')
  fixturePath = path.join(workspace, 'selection-translation.md')
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(processTemp, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(portableData, { recursive: true }),
  ])
  await Promise.all([
    writeFile(fixturePath, FIXTURE_MARKDOWN, 'utf8'),
    writeFile(
      path.join(portableData, 'settings.json'),
      `${JSON.stringify({ lastWorkspace: workspace }, null, 2)}\n`,
      'utf8',
    ),
  ])

  application = await runE2eStage('launch isolated packaged translation runtime', async () => {
    const launched = await electron.launch({
      executablePath: runtime.executable,
      cwd: runtime.application,
      timeout: 30_000,
      args: [
        '--disable-gpu',
        `--user-data-dir=${userData}`,
        fixturePath,
      ],
      env: {
        ...process.env,
        APPDATA: runtimeRoot,
        LOCALAPPDATA: runtimeRoot,
        TEMP: processTemp,
        TMP: processTemp,
        TMPDIR: processTemp,
        ARKDOWN_E2E: '1',
      },
    })
    const child = launched.process()
    runtimeProcess = child
    runtimeProcessClosed = child.stdout?.closed === true && child.stderr?.closed === true
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once('close', () => resolve()))
    child.stdout?.on('data', (chunk) => {
      scanMainProcessDiagnostic('stdout', chunk)
    })
    child.stderr?.on('data', (chunk) => {
      scanMainProcessDiagnostic('stderr', chunk)
    })
    child.once('exit', (code, signal) => {
      processExitDiagnostic = JSON.stringify({ code, signal })
    })
    return launched
  })
  page = await runE2eStage('wait for isolated packaged renderer readiness', async () => {
    const firstWindow = await application!.firstWindow({ timeout: 15_000 })
    firstWindow.on('console', (message) => {
      if (message.type() !== 'error') return
      rendererFailureCount += 1
      collectSanitizedDiagnostic(rendererStartupFailures, 'console', message.text())
    })
    firstWindow.on('pageerror', (error) => {
      rendererFailureCount += 1
      collectSanitizedDiagnostic(rendererStartupFailures, 'pageerror', error.message)
    })
    try {
      await withDeadline(
        'packaged renderer readiness',
        expect(firstWindow.locator('.app-titlebar')).toBeVisible({ timeout: 10_000 }),
        12_000,
      )
    } catch (error) {
      throw new Error(
        'Packaged renderer did not become ready; diagnostic=' + JSON.stringify({
          closed: firstWindow.isClosed(),
          url: firstWindow.url(),
          rendererStartupFailures,
          mainProcessDiagnostics,
          processExitDiagnostic,
        }),
        { cause: error },
      )
    }
    rendererStartupFailures = []
    return firstWindow
  })
})

test.afterEach(async () => {
  await runE2eStage('cleanup packaged translation E2E resources', async () => {
    const child = runtimeProcess
    const processClosed = runtimeProcessClosed
    const server = loopback
    const root = runtimeRoot
    const executable = runtimeApplication ? path.join(runtimeApplication, 'Arkdown.exe') : ''
    const target = application
    application = undefined
    runtimeProcess = undefined
    runtimeProcessClosed = undefined
    loopback = undefined
    page = undefined
    let cleanupFailure: unknown
    let processStopped = root === '' && executable === ''
    const attempt = async (operation: () => Promise<void>) => {
      try {
        await operation()
      } catch (error) {
        cleanupFailure ??= error
      }
    }
    await attempt(async () => {
      await runE2eStage('close isolated Electron runtime and observe quiet', async () => {
        if (!executable) {
          if (root) throw new Error('Translation runtime has no executable scope for shutdown')
          return
        }
        await shutdownElectronApplicationScope({
          application: target,
          executable,
          requestClose: async (targetApplication) => await targetApplication.close(),
        })
        processStopped = true
      })
    })
    await attempt(async () => {
      await runE2eStage('drain Electron diagnostics and verify secrecy', async () => {
        if (child && processClosed) {
          await withDeadline('Electron stdio close', processClosed, 5_000)
        }
        expect(sensitiveDiagnosticObserved).toBe(false)
      })
    })
    await attempt(async () => {
      await runE2eStage('close bounded loopback translation server', async () => {
        await server?.close()
      })
    })
    await attempt(async () => {
      if (!processStopped) return
      await runE2eStage('remove isolated translation runtime files', async () => {
        if (root) await cleanupRuntime(root)
      })
    })
    runtimeApplication = ''
    runtimeRoot = ''
    workspace = ''
    fixturePath = ''
    if (cleanupFailure) throw cleanupFailure
  })
})

test('translates real mouse selections through packaged Electron without changing the document', async () => {
  const appPage = activePage()
  const server = activeServer()

  await runE2eStage('open packaged preferences from the application menu', async () => {
    const titlebar = appPage.getByTestId('app-titlebar')
    await titlebar.getByRole('button', { name: '文件', exact: true }).click()
    await appPage.getByRole('menuitem', { name: /偏好设置/ }).click()
    await expect(appPage.locator('.preferences-page')).toBeVisible({ timeout: 10_000 })
  })

  await runE2eStage('navigate to packaged large-model management', async () => {
    await appPage.locator('a[href="#preferences-large-model-heading"]').click()
    const section = appPage.locator('.large-model-settings-section')
    await expect(section).toBeVisible()
    await section.getByRole('button', { name: '管理大模型' }).click()
    await expect(appPage.locator('.large-model-manager')).toBeVisible()
  })

  let connectionId = ''
  await runE2eStage('connect the isolated loopback OpenAI model through real UI', async () => {
    await appPage.getByRole('button', { name: '添加大模型' }).click()
    const dialog = appPage.getByRole('dialog', { name: '添加大模型' })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('配置名称').fill(CONNECTION_NAME)
    await choosePreferencesOption(appPage, dialog, '服务商', '其他')
    await expect(dialog.getByRole('combobox', { name: '接入类型' })).toContainText('标准 API')
    await choosePreferencesOption(appPage, dialog, '接口协议', 'OpenAI 兼容')
    await dialog.getByLabel('Base URL').fill(`http://127.0.0.1:${server.port}/v1`)
    await dialog.getByLabel('模型 ID').fill(MODEL_ID)
    await dialog.getByLabel('API Key').fill(API_KEY)
    await dialog.getByRole('button', { name: '连接', exact: true }).click()
    await expect(dialog).toHaveCount(0, { timeout: 15_000 })
    await expect(appPage.getByRole('article', { name: CONNECTION_NAME })).toBeVisible()
    await expect.poll(() => server.fixedRequestCount, { timeout: 10_000 }).toBe(1)

    const settings = JSON.parse(await readFile(
      path.join(runtimeApplication, 'portable-data', 'settings.json'),
      'utf8',
    )) as { models?: { connections?: Array<{ id?: unknown }> } }
    const candidate = settings.models?.connections?.[0]?.id
    if (typeof candidate !== 'string' || candidate === '') {
      throw new Error('Connected loopback option ID is unavailable')
    }
    connectionId = candidate
  })

  await runE2eStage('bind selection translation and preserve automatic target language', async () => {
    const binding = appPage.getByRole('combobox', { name: '划词翻译模型' })
    const targetLanguage = appPage.getByRole('combobox', { name: '目标语言', exact: true })
    await expect(targetLanguage).toContainText('自动')
    await choosePreferencesOption(
      appPage,
      appPage,
      '划词翻译模型',
      CONNECTION_NAME,
    )
    await expect(binding).toContainText(CONNECTION_NAME)
    await expect(targetLanguage).toContainText('自动')
    await expect.poll(async () => {
      const settings = JSON.parse(await readFile(
        path.join(runtimeApplication, 'portable-data', 'settings.json'),
        'utf8',
      )) as {
        models?: {
          selectionTranslation?: {
            connectionId?: unknown
            targetLanguage?: unknown
          }
        }
      }
      return settings.models?.selectionTranslation?.connectionId === connectionId
        && settings.models.selectionTranslation.targetLanguage === 'auto'
    }, { timeout: 10_000 }).toBe(true)
  })

  await runE2eStage('return to the editor and open the isolated fixture', async () => {
    await appPage.getByRole('button', { name: '返回', exact: true }).click()
    await expect(appPage.locator('.large-model-manager')).toHaveCount(0)
    await appPage.locator('.preferences-page').getByRole('button', { name: '关闭', exact: true }).click()
    await expect(appPage.locator('.preferences-page')).toHaveCount(0)
    await expect(appPage.locator('.ProseMirror')).toContainText(SHORT_SENTINEL, {
      timeout: 10_000,
    })
  })

  await runE2eStage('translate the short visual mouse selection without a privacy gate', async () => {
    const beforeEditor = await visualEditorSnapshot()
    await dragSelectText({
      rootSelector: '.ProseMirror',
      startText: SHORT_SENTINEL,
      expectedSelection: SHORT_SENTINEL,
    })
    const sidebar = await startSelectionTranslationInSidebar()
    await expect(appPage.getByRole('dialog', { name: '划词翻译隐私提示' })).toHaveCount(0)
    await assertDisplayedOutput(
      '.editor-right-sidebar .translation-output-visual',
      SHORT_RESULT_PARTS.join(''),
    )
    await expect.poll(() => server.translationRequestCount, { timeout: 10_000 }).toBe(1)
    expect(server.hasExactTranslationRequest(0, {
      systemContent: VISUAL_SYSTEM_MESSAGE,
      userContent: SHORT_SENTINEL,
    })).toBe(true)
    expect(server.requestContainsAdjacentSecret(0)).toBe(false)
    expect((await visualEditorSnapshot()) === beforeEditor).toBe(true)
    await assertFixtureFileUnchanged()
    await closeTranslationSidebar(sidebar)
  })

  await runE2eStage('translate a multiline visual mouse selection in the sidebar', async () => {
    const beforeEditor = await visualEditorSnapshot()
    await dragSelectText({
      rootSelector: '.ProseMirror',
      startText: MULTILINE_FIRST,
      endText: MULTILINE_SECOND,
      expectedSelection: MULTILINE_SENTINEL,
    })
    const sidebar = await startSelectionTranslationInSidebar()
    await assertDisplayedOutput(
      '.editor-right-sidebar .translation-output-visual',
      MULTILINE_RESULT_PARTS.join(''),
    )
    await expect.poll(() => server.translationRequestCount, { timeout: 10_000 }).toBe(2)
    expect(server.hasExactTranslationRequest(1, {
      systemContent: VISUAL_SYSTEM_MESSAGE,
      userContent: MULTILINE_MARKDOWN,
    })).toBe(true)
    expect((await visualEditorSnapshot()) === beforeEditor).toBe(true)
    await assertFixtureFileUnchanged()
    await closeTranslationSidebar(sidebar)
  })

  await runE2eStage('translate a real CodeMirror mouse selection as safe Markdown with an exact raw copy', async () => {
    await appPage.getByRole('button', { name: '源码模式/渲染模式' }).click()
    const sourceEditor = appPage.locator('.source-editor .cm-content')
    await expect(sourceEditor).toBeVisible({ timeout: 10_000 })
    const beforeEditor = await sourceEditorSnapshot()
    await dragSelectText({
      rootSelector: '.source-editor .cm-content',
      startText: SOURCE_SENTINEL,
      expectedSelection: SOURCE_SENTINEL,
    })
    const sidebar = await startSelectionTranslationInSidebar()
    const sourceOutput = sidebar.locator('.translation-output-source')
    await assertDisplayedOutput(
      '.editor-right-sidebar .translation-output-source',
      'Translated source and inline_code',
    )
    expect(await sourceOutput.evaluate((element) => element.tagName === 'DIV')).toBe(true)
    await expect(sourceOutput.locator('a')).toHaveCount(1)
    await expect(sourceOutput.getByRole('link', { name: 'Translated source', exact: true }))
      .toHaveAttribute('href', 'https://example.invalid/selected-path')
    await expect(sourceOutput.locator('code')).toHaveCount(1)
    await expect(sourceOutput.locator('code')).toHaveText('inline_code')
    expect(await sourceOutput.evaluate((element) => (
      !(element as HTMLElement).isContentEditable
      && [...element.querySelectorAll<HTMLElement>('*')].every((child) => !child.isContentEditable)
    ))).toBe(true)
    await expect(sourceOutput.locator('input, textarea, select, script, iframe, object, embed'))
      .toHaveCount(0)
    await assertNativeCopiedMarkdown(
      sidebar.locator('.translation-sidebar-live-scroll')
        .getByRole('button', { name: '复制', exact: true }),
      SOURCE_RESULT_PARTS.join(''),
    )
    await expect.poll(() => server.translationRequestCount, { timeout: 10_000 }).toBe(3)
    expect(server.hasExactTranslationRequest(2, {
      systemContent: SOURCE_SYSTEM_MESSAGE,
      userContent: SOURCE_SENTINEL,
    })).toBe(true)
    expect((await sourceEditorSnapshot()) === beforeEditor).toBe(true)
    await assertFixtureFileUnchanged()
    await closeTranslationSidebar(sidebar)
  })

  await runE2eStage('cancel the delayed visual stream before teardown', async () => {
    await appPage.getByRole('button', { name: '源码模式/渲染模式' }).click()
    await expect(appPage.locator('.ProseMirror')).toBeVisible({ timeout: 10_000 })
    const beforeEditor = await visualEditorSnapshot()
    await dragSelectText({
      rootSelector: '.ProseMirror',
      startText: CANCELLATION_SENTINEL,
      expectedSelection: CANCELLATION_SENTINEL,
    })
    const sidebar = await startSelectionTranslationInSidebar()
    await assertDisplayedOutput(
      '.editor-right-sidebar .translation-output-visual',
      CANCELLATION_FIRST_DELTA,
    )
    await sidebar.getByRole('button', { name: '停止翻译', exact: true }).click()
    await expect(sidebar.getByText('已停止', { exact: true })).toBeVisible()
    await expect.poll(() => server.cancellationClosed, { timeout: 10_000 }).toBe(true)
    expect(await sidebar.locator('.translation-output').evaluate(
      (element, heldDelta) => !element.textContent?.includes(heldDelta),
      CANCELLATION_HELD_DELTA,
    )).toBe(true)
    await expect.poll(() => server.translationRequestCount, { timeout: 10_000 }).toBe(4)
    expect(server.hasExactTranslationRequest(3, {
      systemContent: VISUAL_SYSTEM_MESSAGE,
      userContent: CANCELLATION_SENTINEL,
    })).toBe(true)
    expect((await visualEditorSnapshot()) === beforeEditor).toBe(true)
    await assertFixtureFileUnchanged()
    await closeTranslationSidebar(sidebar)
  })

  await runE2eStage('preserve an ordered-list start through structured Markdown and safe DOM', async () => {
    await dragSelectText({
      rootSelector: '.ProseMirror',
      startText: 'Lei',
      endText: 'Lin',
      expectedSelection: STRUCTURED_LIST_DOM_SELECTION,
    })
    const sidebar = await startSelectionTranslationInSidebar()
    await expect(sidebar.locator('.translation-output ol[start="2"]')).toBeVisible({ timeout: 10_000 })
    await expect(sidebar.locator('.translation-output ol[start="2"] > li')).toHaveCount(2)
    await expect.poll(() => server.translationRequestCount).toBe(5)
    expect(server.hasExactTranslationRequest(4, {
      systemContent: STRUCTURED_SYSTEM_MESSAGE,
      userContent: STRUCTURED_LIST_MARKDOWN,
    })).toBe(true)
    await closeTranslationSidebar(sidebar)
  })

  await runE2eStage('show an ordinary retryable timeout after the 30-second first-response budget', async () => {
    await dragSelectText({
      rootSelector: '.ProseMirror',
      startText: NO_OUTPUT_SENTINEL,
      expectedSelection: NO_OUTPUT_SENTINEL,
    })
    const sidebar = await startSelectionTranslationInSidebar()
    await expect(sidebar.getByRole('alert')).toHaveText('大模型请求超时', { timeout: 35_000 })
    await expect(sidebar.getByRole('button', { name: '重试', exact: true })).toBeVisible()
    await expect(sidebar.getByRole('button', { name: '关闭', exact: true })).toBeVisible()
    await expect(sidebar.getByRole('button', { name: '复制', exact: true })).toHaveCount(0)
    await expect(sidebar.locator('.translation-output')).toHaveCount(0)
    await closeTranslationSidebar(sidebar)
  })

  await runE2eStage('retain partial output and remove Retry after 15 seconds of inactivity', async () => {
    await dragSelectText({
      rootSelector: '.ProseMirror',
      startText: PARTIAL_TIMEOUT_SENTINEL,
      expectedSelection: PARTIAL_TIMEOUT_SENTINEL,
    })
    const sidebar = await startSelectionTranslationInSidebar()
    await expect(sidebar.locator('.translation-output')).toContainText(PARTIAL_TIMEOUT_RESULT)
    await expect(sidebar.getByRole('alert')).toHaveText('翻译内容过多，请分批次翻译', { timeout: 20_000 })
    await expect(sidebar.getByRole('button', { name: '重试', exact: true })).toHaveCount(0)
    await expect(sidebar.getByRole('button', { name: '复制', exact: true })).toBeVisible()
    await expect(sidebar.getByRole('button', { name: '关闭', exact: true })).toBeVisible()
    await closeTranslationSidebar(sidebar)
  })

  await runE2eStage('reset inactivity on non-empty deltas beyond 15 seconds and keep Stop usable', async () => {
    await dragSelectText({
      rootSelector: '.ProseMirror',
      startText: ACTIVITY_RESET_SENTINEL,
      expectedSelection: ACTIVITY_RESET_SENTINEL,
    })
    const sidebar = await startSelectionTranslationInSidebar()
    const stop = sidebar.getByRole('button', { name: '停止翻译', exact: true })
    await expect(stop).toBeVisible()
    await expect(sidebar.locator('.translation-output')).toContainText('active-stream-output')
    const outputLengthBeforeGrowth = await sidebar.locator('.translation-output').evaluate(
      (output) => output.textContent?.length ?? 0,
    )
    expect(outputLengthBeforeGrowth).toBeGreaterThan(8_000)
    await stop.scrollIntoViewIfNeeded()
    await stop.click({ trial: true })
    const stopBoxBeforeGrowth = await stop.boundingBox()
    const sidebarBoxBeforeGrowth = await sidebar.boundingBox()
    const footerBoxBeforeGrowth = await sidebar.locator('.translation-sidebar-footer').boundingBox()
    expect(stopBoxBeforeGrowth).not.toBeNull()
    expect(sidebarBoxBeforeGrowth).not.toBeNull()
    expect(footerBoxBeforeGrowth).not.toBeNull()
    expect(stopBoxBeforeGrowth!.y).toBeGreaterThanOrEqual(sidebarBoxBeforeGrowth!.y)
    expect(stopBoxBeforeGrowth!.y + stopBoxBeforeGrowth!.height)
      .toBeLessThanOrEqual(sidebarBoxBeforeGrowth!.y + sidebarBoxBeforeGrowth!.height)
    expect(stopBoxBeforeGrowth!.y).toBeGreaterThanOrEqual(footerBoxBeforeGrowth!.y)
    expect(stopBoxBeforeGrowth!.y + stopBoxBeforeGrowth!.height)
      .toBeLessThanOrEqual(footerBoxBeforeGrowth!.y + footerBoxBeforeGrowth!.height)
    await appPage.waitForTimeout(16_000)
    await expect(sidebar.getByText('大模型请求超时', { exact: true })).toHaveCount(0)
    await expect(sidebar.getByText('翻译内容过多，请分批次翻译', { exact: true })).toHaveCount(0)
    const outputLengthAfterGrowth = await sidebar.locator('.translation-output').evaluate(
      (output) => output.textContent?.length ?? 0,
    )
    expect(outputLengthAfterGrowth).toBeGreaterThan(outputLengthBeforeGrowth * 2)
    await expect(stop).toBeVisible()
    await expect(stop).toBeEnabled()
    await expect(stop).toBeInViewport()
    await stop.click({ trial: true })
    const stopBoxAfterGrowth = await stop.boundingBox()
    expect(stopBoxAfterGrowth).not.toBeNull()
    expect(stopBoxAfterGrowth!.x).toBeCloseTo(stopBoxBeforeGrowth!.x, 0)
    expect(stopBoxAfterGrowth!.y).toBeCloseTo(stopBoxBeforeGrowth!.y, 0)
    await stop.click()
    await expect(sidebar.getByText('已停止', { exact: true })).toBeVisible()
    await expect.poll(() => server.translationRequestCount).toBe(8)
  })

  for (const mode of ['source', 'visual'] as const) {
    await runE2eStage(`preserve ${mode} document and undo after actual Ctrl+A translation cancellation`, async () => {
      // Establish a known complete document through real editor input, then make a
      // separate undoable edit in the mode being tested.
      await appPage.keyboard.press('Escape')
      await expect(appPage.getByRole('complementary', { name: '右侧栏', exact: true })).toHaveCount(0)
      if (await appPage.locator('.source-editor .cm-content').count() === 0) {
        await appPage.getByRole('button', { name: '源码模式/渲染模式' }).click()
      }
      const source = appPage.locator('.source-editor .cm-content')
      await expect(source).toBeVisible()
      await source.click()
      await appPage.keyboard.press('Control+A')
      await appPage.keyboard.insertText(FULL_DOCUMENT_MARKDOWN)
      await appPage.keyboard.press('Escape')
      if (mode === 'visual') await appPage.getByRole('button', { name: '源码模式/渲染模式' }).click()
      const editor = mode === 'source' ? source : appPage.locator('.ProseMirror')
      const snapshot = mode === 'source' ? sourceEditorSnapshot : visualEditorSnapshot
      await expect(editor).toBeVisible()
      await editor.focus()
      await appPage.keyboard.press('Control+End')
      const baseline = await snapshot()
      // CodeMirror and ProseMirror group adjacent typing for 500 ms.
      await appPage.waitForTimeout(600)
      await appPage.keyboard.insertText(FULL_DOCUMENT_UNDO_MARKER)
      await expect.poll(snapshot).toContain(FULL_DOCUMENT_UNDO_MARKER)
      const edited = await snapshot()
      const requestCount = server.translationRequestCount

      await appPage.keyboard.press('Control+A')
      const translate = appPage.getByRole('button', { name: '全文翻译', exact: true })
      await expect(translate).toBeVisible()
      await appPage.keyboard.press('Escape')
      await expect(translate).toHaveCount(0)
      expect(await snapshot()).toBe(edited)
      expect(server.translationRequestCount).toBe(requestCount)

      await editor.focus()
      await appPage.keyboard.press('Control+A')
      await translate.click()
      const sidebar = appPage.getByRole('complementary', { name: '右侧栏' })
      await expect(sidebar).toBeVisible()
      await assertDisplayedOutput(
        mode === 'source' ? '.editor-right-sidebar .translation-output-source' : '.editor-right-sidebar .translation-output-visual',
        CANCELLATION_FIRST_DELTA,
      )
      await expect.poll(() => server.translationRequestCount).toBe(requestCount + 1)
      expect(server.hasExactTranslationRequest(requestCount, {
        systemContent: VISUAL_SYSTEM_MESSAGE,
        userContent: FULL_DOCUMENT_REQUEST,
      })).toBe(true)
      await sidebar.getByRole('button', { name: '停止翻译', exact: true }).click()
      await expect(sidebar.getByText('已停止', { exact: true })).toBeVisible()
      await expect.poll(() => server.cancellationClosed).toBe(true)
      await expect(sidebar).not.toContainText(CANCELLATION_HELD_DELTA)
      expect(await snapshot()).toBe(edited)
      await closeTranslationSidebar(sidebar)
      await editor.focus()
      await appPage.keyboard.press('Control+z')
      await expect.poll(snapshot).toBe(baseline)
      await appPage.keyboard.press('Control+y')
      await expect.poll(snapshot).toBe(edited)
    })
  }

  await runE2eStage('verify bounded E2E diagnostics', async () => {
    expect(server.isHealthy()).toBe(true)
    expect(rendererFailureCount).toBe(0)
    expect(sensitiveDiagnosticObserved).toBe(false)
  })
})

test('guides an unconfigured sidebar translation to Preferences', async () => {
  const appPage = activePage()
  await expect(appPage.locator('.ProseMirror')).toContainText(SHORT_SENTINEL)
  await dragSelectText({
    rootSelector: '.ProseMirror',
    startText: SHORT_SENTINEL,
    expectedSelection: SHORT_SENTINEL,
  })
  const sidebar = await startSelectionTranslationInSidebar()
  await expect(sidebar.getByRole('alert')).toContainText('尚未配置大模型')
  await expect(sidebar.getByRole('button', { name: '重试' })).toHaveCount(0)
  const settings = sidebar.getByRole('button', { name: '前往配置', exact: true })
  await expect(settings).toBeVisible()
  await settings.click()
  await expect(sidebar).toHaveCount(0)
  await expect(appPage.locator('.preferences-page')).toBeVisible()
})
