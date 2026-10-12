import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import {
  cleanupRuntime,
  createRuntimeInstance,
  runE2eStage,
  shutdownElectronApplicationScope,
} from './support/runtime'

const API_KEY = 'arkdown-e2e-secret'
const CONNECTION_NAME = 'E2E Local Model'
const MODEL_ID = 'e2e-model'
const FIXED_TEST_MESSAGE = 'Reply with OK only.'

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

interface PersistedConnection {
  id: string
  lastTestedAt: string | null
}

interface PersistedSettings {
  models?: {
    connections?: PersistedConnection[]
    selectionTranslation?: {
      connectionId?: string | null
    }
  }
}

interface PersistedVault {
  version?: number
  secrets?: Record<string, string>
}

class LoopbackModelServer {
  private server: Server | undefined
  private pendingRetestResponse: ServerResponse | undefined
  private pendingTimeoutResponse: ServerResponse | undefined
  fixedRequestCount = 0
  port = 0

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response).catch(() => {
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

  releaseRetestResponse(): void {
    const response = this.pendingRetestResponse
    if (!response) throw new Error('The retest request has not reached the loopback server')
    this.pendingRetestResponse = undefined
    this.sendSuccess(response)
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.pendingRetestResponse?.destroy()
    this.pendingRetestResponse = undefined
    this.pendingTimeoutResponse?.destroy()
    this.pendingTimeoutResponse = undefined
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
      response.writeHead(404).end()
      return
    }
    if (request.headers.authorization !== `Bearer ${API_KEY}`) {
      response.writeHead(401).end()
      return
    }

    let source = ''
    for await (const chunk of request) {
      source += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      if (source.length > 64 * 1024) {
        response.writeHead(413).end()
        return
      }
    }

    let fixedMessageReceived = false
    try {
      const payload = JSON.parse(source) as {
        messages?: { role?: unknown; content?: unknown }[]
      }
      fixedMessageReceived = Array.isArray(payload.messages)
        && payload.messages.some(
          (message) => message.role === 'user' && message.content === FIXED_TEST_MESSAGE,
        )
    } catch {
      fixedMessageReceived = false
    }
    source = ''

    if (!fixedMessageReceived) {
      response.writeHead(400).end()
      return
    }

    this.fixedRequestCount += 1
    if (this.fixedRequestCount === 2) {
      this.pendingRetestResponse = response
      return
    }
    if (this.fixedRequestCount === 3) {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'close',
      })
      this.pendingTimeoutResponse = response
      response.once('close', () => {
        if (this.pendingTimeoutResponse === response) this.pendingTimeoutResponse = undefined
      })
      return
    }
    this.sendSuccess(response)
  }

  private sendSuccess(response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'close',
    })
    response.write('data: {"choices":[{"delta":{"content":"O"}}]}\n\n')
    response.end('data: {"choices":[{"delta":{"content":"K"}}]}\n\ndata: [DONE]\n\n')
  }
}

let application: ElectronApplication | undefined
let loopback: LoopbackModelServer | undefined
let page: Page
let runtimeApplication = ''
let runtimeExecutable = ''
let runtimeRoot = ''
let settingsPath = ''
let vaultPath = ''

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

async function readPersistedSettings(): Promise<PersistedSettings> {
  return JSON.parse(await readFile(settingsPath, 'utf8')) as PersistedSettings
}

function containsOwnKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((candidate) => containsOwnKey(candidate, key))
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return Object.prototype.hasOwnProperty.call(record, key)
    || Object.values(record).some((candidate) => containsOwnKey(candidate, key))
}

test.beforeEach(async () => {
  loopback = new LoopbackModelServer()
  await runE2eStage('start loopback model server', async () => {
    await loopback!.start()
  })

  const sharedApplication = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!sharedApplication) throw new Error('Electron E2E shared runtime is not prepared')
  const runtime = await createRuntimeInstance(
    sharedApplication,
    'arkdown-model-management-e2e-runtime-',
  )
  runtimeRoot = runtime.root
  runtimeApplication = runtime.application
  runtimeExecutable = runtime.executable
  const userData = path.join(runtimeRoot, 'user-data')
  const processTemp = path.join(runtimeRoot, 'process-temp')
  const workspace = path.join(runtimeRoot, 'workspace')
  const portableData = path.join(runtimeApplication, 'portable-data')
  settingsPath = path.join(portableData, 'settings.json')
  vaultPath = path.join(portableData, 'model-secrets.json')
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(processTemp, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(portableData, { recursive: true }),
  ])
  await Promise.all([
    writeFile(path.join(workspace, 'model-management.md'), '# Model management E2E\n', 'utf8'),
    writeFile(
      settingsPath,
      `${JSON.stringify({ lastWorkspace: workspace }, null, 2)}\n`,
      'utf8',
    ),
  ])

  application = await runE2eStage('launch isolated packaged Electron process', async () => {
    return await electron.launch({
      executablePath: runtime.executable,
      cwd: runtime.application,
      timeout: 30_000,
      args: [
        '--disable-gpu',
        `--user-data-dir=${userData}`,
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
  })
  page = await runE2eStage('wait for packaged application window', async () => {
    const firstWindow = await application!.firstWindow({ timeout: 15_000 })
    await withDeadline(
      'packaged renderer readiness',
      expect(firstWindow.locator('.app-titlebar')).toBeVisible({ timeout: 10_000 }),
      12_000,
    )
    return firstWindow
  })
})

test.afterEach(async () => {
  await runE2eStage('cleanup model-management E2E', async () => {
    const target = application
    const server = loopback
    const root = runtimeRoot
    const executable = runtimeExecutable
    application = undefined
    loopback = undefined
    let cleanupFailure: unknown
    let runtimeQuiet = root === '' && executable === ''
    let runtimeCleaned = root === ''
    const attempt = async (operation: () => Promise<void>) => {
      try {
        await operation()
      } catch (error) {
        cleanupFailure ??= error
      }
    }
    await attempt(async () => {
      if (!executable) {
        if (root) throw new Error('Model-management runtime has no executable scope for shutdown')
        return
      }
      await shutdownElectronApplicationScope({
        application: target,
        executable,
        requestClose: async (targetApplication) => {
          const window = targetApplication.windows().find((candidate) => !candidate.isClosed())
          if (!window) return
          const back = window.locator('.preferences-page-header').getByRole('button', { name: /返回/u })
          if (await window.locator('.large-model-manager').isVisible()) {
            await back.click()
            await expect(window.locator('.large-model-manager')).toHaveCount(0)
          }
          if (await window.locator('.preferences-page').isVisible()) {
            await back.click()
            await expect(window.locator('.preferences-page')).toHaveCount(0)
          }
          await window.getByRole('group', { name: '窗口控制', exact: true })
            .getByRole('button', { name: '关闭', exact: true }).click()
        },
      })
      runtimeQuiet = true
    })
    await attempt(async () => {
      await server?.close()
    })
    await attempt(async () => {
      if (!runtimeQuiet) return
      if (root) await cleanupRuntime(root)
      runtimeCleaned = true
    })
    if (runtimeCleaned) {
      runtimeApplication = ''
      runtimeExecutable = ''
      runtimeRoot = ''
      settingsPath = ''
      vaultPath = ''
    }
    if (cleanupFailure) throw cleanupFailure
  })
})

test('manages an encrypted loopback model connection in packaged Electron', async () => {
  await runE2eStage('open preferences from the packaged application menu', async () => {
    const titlebar = page.getByTestId('app-titlebar')
    await titlebar.getByRole('button', { name: '文件', exact: true }).click()
    await page.getByRole('menuitem', { name: /偏好设置/ }).click()
    await expect(page.locator('.preferences-page')).toBeVisible({ timeout: 10_000 })
  })

  await runE2eStage('navigate to model management', async () => {
    await page.locator('a[href="#preferences-large-model-heading"]').click()
    const section = page.locator('.large-model-settings-section')
    await expect(section).toBeVisible()
    await section.getByRole('button', { name: '管理大模型' }).click()
    await expect(page.locator('.large-model-manager')).toBeVisible()
  })

  await runE2eStage('connect loopback OpenAI-compatible model', async () => {
    await page.getByRole('button', { name: '添加大模型' }).click()
    const dialog = page.getByRole('dialog', { name: '添加大模型' })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('配置名称').fill(CONNECTION_NAME)
    await choosePreferencesOption(page, dialog, '服务商', '其他')
    await expect(dialog.getByRole('combobox', { name: '接入类型' })).toContainText('标准 API')
    await choosePreferencesOption(page, dialog, '接口协议', 'OpenAI 兼容')
    await dialog.getByLabel('Base URL').fill(`http://127.0.0.1:${loopback!.port}/v1`)
    await dialog.getByLabel('模型 ID').fill(MODEL_ID)
    await dialog.getByLabel('API Key').fill(API_KEY)
    await dialog.getByRole('button', { name: '连接', exact: true }).click()

    await expect(dialog).toHaveCount(0, { timeout: 15_000 })
    const card = page.getByRole('article', { name: CONNECTION_NAME })
    await expect(card).toBeVisible()
    await expect(card.locator('.large-model-status.is-connected')).toHaveText('连接正常')
    await expect.poll(() => loopback!.fixedRequestCount).toBe(1)
  })

  let connectionId = ''
  let firstTestedAt = ''
  await runE2eStage('verify public settings and encrypted vault', async () => {
    const settingsSource = await readFile(settingsPath, 'utf8')
    expect(settingsSource).not.toContain(API_KEY)
    const settings = JSON.parse(settingsSource) as PersistedSettings
    expect(containsOwnKey(settings, 'apiKey')).toBe(false)
    const connections = settings.models?.connections
    expect(connections).toHaveLength(1)
    connectionId = connections![0]!.id
    firstTestedAt = connections![0]!.lastTestedAt ?? ''
    expect(connectionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(Number.isFinite(Date.parse(firstTestedAt))).toBe(true)

    const vaultSource = await readFile(vaultPath, 'utf8')
    expect(vaultSource).not.toContain(API_KEY)
    const vault = JSON.parse(vaultSource) as PersistedVault
    expect(vault.version).toBe(1)
    expect(Object.keys(vault.secrets ?? {})).toEqual([connectionId])
    const ciphertext = vault.secrets?.[connectionId]
    expect(ciphertext).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    const encryptedSecret = Buffer.from(ciphertext!, 'base64')
    const plaintextSecret = Buffer.from(API_KEY, 'utf8')
    expect(encryptedSecret.equals(plaintextSecret)).toBe(false)
    expect(encryptedSecret.includes(plaintextSecret)).toBe(false)
  })

  await runE2eStage('bind the model before deletion', async () => {
    const binding = page.getByRole('combobox', { name: '划词翻译模型' })
    await choosePreferencesOption(
      page,
      page,
      '划词翻译模型',
      CONNECTION_NAME,
    )
    await expect(binding).toContainText(CONNECTION_NAME)
    await expect.poll(async () => (
      await readPersistedSettings()
    ).models?.selectionTranslation?.connectionId).toBe(connectionId)
  })

  await runE2eStage('retest the saved model connection', async () => {
    const card = page.getByRole('article', { name: CONNECTION_NAME })
    const details = card.getByRole('button', { name: `${CONNECTION_NAME}详情`, exact: true })
    await expect(details).toHaveAttribute('aria-expanded', 'false')
    await details.click()
    await expect(details).toHaveAttribute('aria-expanded', 'true')
    const recentTest = card.locator('dt', { hasText: '最近检测' }).locator('..').locator('dd')
    const previousVisibleTestTime = (await recentTest.textContent()) ?? ''
    expect(previousVisibleTestTime).not.toBe('')
    await expect.poll(() => Date.now()).toBeGreaterThan(Date.parse(firstTestedAt) + 1_000)
    const testButton = card.getByRole('button', { name: /^测试(?:中…)?$/ })
    await testButton.click()
    await expect.poll(() => loopback!.fixedRequestCount).toBe(2)
    await expect(testButton).toHaveText('测试中…')
    loopback!.releaseRetestResponse()
    await expect(testButton).toHaveText('测试', { timeout: 10_000 })
    await expect(card.locator('.large-model-status.is-connected')).toHaveText('连接正常')
    await expect(recentTest).not.toHaveText(previousVisibleTestTime)
    await expect.poll(async () => {
      const connections = (await readPersistedSettings()).models?.connections ?? []
      return connections.find((connection) => connection.id === connectionId)?.lastTestedAt
    }).not.toBe(firstTestedAt)
  })

  await runE2eStage('surface the ordinary 15-second no-content timeout through Preferences UI and IPC', async () => {
    // Delta-reset and heartbeat/empty-frame semantics stay covered by the focused protocol tests:
    // tests/main/model-protocol-client.test.ts ("refreshes ... only when non-empty ..." and
    // "does not refresh ... for an SSE heartbeat"). This packaged path covers no content only.
    const card = page.getByRole('article', { name: CONNECTION_NAME })
    const testButton = card.getByRole('button', { name: /^测试(?:中…)?$/ })
    await testButton.click()
    await expect.poll(() => loopback!.fixedRequestCount).toBe(3)
    await expect(testButton).toHaveText('测试中…')
    await expect(card.locator('.large-model-status.is-timeout'))
      .toHaveText('请求超时', { timeout: 20_000 })
    await expect(testButton).toHaveText('测试')
  })

  await runE2eStage('delete connection and clear vault and binding', async () => {
    const card = page.getByRole('article', { name: CONNECTION_NAME })
    await card.getByRole('button', { name: '删除', exact: true }).click()
    const removeDialog = page.getByRole('dialog', { name: '删除正在使用的大模型' })
    await expect(removeDialog).toBeVisible()
    await removeDialog.getByRole('button', { name: '删除', exact: true }).click()
    await expect(card).toHaveCount(0, { timeout: 10_000 })
    await expect(page.locator('.large-model-empty-state'))
      .toHaveText('暂未接入大模型，点击开始添加')
    await expect(page.getByRole('region', { name: '功能应用', exact: true })).toHaveCount(0)

    await expect.poll(async () => {
      const settings = await readPersistedSettings()
      return {
        connectionCount: settings.models?.connections?.length,
        connectionId: settings.models?.selectionTranslation?.connectionId,
      }
    }).toEqual({ connectionCount: 0, connectionId: null })
    await expect.poll(async () => stat(vaultPath).then(
      () => 'exists',
      (error: NodeJS.ErrnoException) => error.code,
    )).toBe('ENOENT')
  })
})
