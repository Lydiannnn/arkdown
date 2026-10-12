import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { saveWithNativeShortcut } from './support/native-shortcuts'
import { markdownContainsText } from './support/markdown-markers'
import path from 'node:path'
import {
  AI_CONVERSATION_E2E_READ_COMMAND,
  AI_CONVERSATION_E2E_WORKSPACE_DENY_COMMAND,
  AI_CONVERSATION_E2E_WORKSPACE_ONCE_COMMAND,
  AI_CONVERSATION_E2E_WORKSPACE_SESSION_COMMAND,
  AI_CONVERSATION_E2E_WORKSPACE_SESSION_SECOND_COMMAND,
  AiConversationLoopbackServer,
} from './support/ai-conversation-loopback'
import {
  cleanupRuntime,
  createRuntimeInstance,
  runE2eStage,
  shutdownElectronApplicationScope,
  type RuntimeInstance,
} from './support/runtime'

const API_KEY = 'arkdown-ai-conversation-local-e2e-key'
const CONNECTION_NAME = 'AI Conversation Local E2E'
const MODEL_ID = 'gpt-5-arkdown-ai-e2e'
const SESSION_MARKER = 'E2E_SESSION_MARKER_WORKSPACE_A'
const UNSAVED_MARKER = 'UNSAVED-B-a41c'

let application: ElectronApplication | undefined
let loopback: AiConversationLoopbackServer | undefined
let page: Page
let runtime: RuntimeInstance
let workspaceA = ''
let workspaceB = ''

async function chooseOption(
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

async function openPreferences(): Promise<void> {
  const titlebar = page.getByTestId('app-titlebar')
  await titlebar.getByRole('button', { name: '文件', exact: true }).click()
  await page.getByRole('menuitem', { name: /偏好设置/u }).click()
  await expect(page.locator('.preferences-page')).toBeVisible()
}

async function expectSummaryWithClose() {
  const preferences = page.locator('.preferences-page')
  await expect(preferences.getByRole('heading', { name: '偏好设置', exact: true })).toBeVisible()
  await expect(preferences.locator('.preferences-page-actions').getByRole('button', { name: '关闭', exact: true })).toBeVisible()
  await expect(preferences.getByRole('button', { name: /^(保存|取消|确认)$/u })).toHaveCount(0)
  const geometry = await preferences.evaluate((element) => ({
    pageBottom: element.getBoundingClientRect().bottom,
    footerBottom: element.querySelector('.preferences-page-actions')!
      .getBoundingClientRect().bottom,
    contentBottom: element.querySelector('.preferences-page-content')!
      .getBoundingClientRect().bottom,
  }))
  expect(Math.abs(geometry.pageBottom - geometry.footerBottom)).toBeLessThanOrEqual(1)
  expect(geometry.contentBottom).toBeLessThan(geometry.footerBottom)
  return geometry
}

async function expectAppliedGeneralPreferences(): Promise<void> {
  await expect.poll(() => page.evaluate(async () => (
    await window.arkdown.getSearchPreferences!()
  ))).toEqual({ ok: true, value: { provider: 'google', customTemplate: '' } })
  await expect.poll(() => page.evaluate(async () => (
    await window.arkdown.getEditorAppearancePreferences!()
  ))).toMatchObject({ ok: true, value: { appearance: { spellCheckEnabled: true } } })
}

async function configureAiConversationModel() {
  await openPreferences()
  await expectSummaryWithClose()
  await chooseOption(page.locator('.preferences-page'), '搜索提供商', 'Google')
  await page.getByRole('checkbox', { name: '拼写检查', exact: true }).check()
  await expectAppliedGeneralPreferences()

  const modelHeadingLink = page.locator('a[href="#preferences-large-model-heading"]')
  await modelHeadingLink.click()
  const section = page.locator('.large-model-settings-section')
  await expect(section).toBeVisible()
  await expect(section.getByRole('button', { name: '管理大模型' })).toBeVisible()
  const managerTreeLink = page.locator('a.preferences-toc-secondary[href="#preferences-large-model-manager"]')
  await expect(managerTreeLink).toHaveText('管理大模型')
  await managerTreeLink.click()
  const manager = page.locator('.large-model-manager')
  await expect(manager).toBeVisible()

  const back = page.locator('.preferences-page-header').getByRole('button', { name: /返回/u })
  expect(await back.evaluate((element) => element.getBoundingClientRect().width)).toBe(32)
  const bottomBackButton = page.locator('.preferences-page-actions')
    .getByRole('button', { name: '返回', exact: true })
  await expect(bottomBackButton).toBeVisible()
  await expect(page.locator('.preferences-page-actions').getByRole('button')).toHaveCount(1)
  await expect(bottomBackButton).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(bottomBackButton).toHaveCSS('color', 'rgb(51, 51, 51)')
  await expect(bottomBackButton).toHaveCSS('border-color', 'rgb(201, 201, 201)')

  await manager.getByRole('button', { name: '添加大模型' }).click()
  const dialog = page.getByRole('dialog', { name: '添加大模型' })
  await expect(dialog).toBeVisible()
  await chooseOption(dialog, '服务商', '其他')
  await chooseOption(dialog, '接口协议', 'OpenAI 兼容')
  await dialog.getByLabel('配置名称').fill(CONNECTION_NAME)
  await dialog.getByLabel('Base URL').fill(loopback!.baseUrl)
  await dialog.getByLabel('模型 ID').fill(MODEL_ID)
  await dialog.getByLabel('API Key').fill(API_KEY)
  await dialog.getByLabel('上下文窗口').fill('128000')
  await dialog.getByLabel('最大输入').fill('95000')
  await dialog.getByLabel('最大输出').fill('32768')
  await dialog.getByRole('button', { name: '连接', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 15_000 })
  const modelCard = manager.getByRole('article', { name: CONNECTION_NAME })
  await expect(modelCard).toBeVisible()
  const disclosure = modelCard.getByRole('button', { name: `${CONNECTION_NAME}详情` })
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  await disclosure.click()
  await expect(modelCard.getByRole('group', { name: `${CONNECTION_NAME}连接详情` })).toBeVisible()
  await disclosure.click()
  await expect.poll(() => loopback!.probeRequestCount).toBe(1)

  await chooseOption(manager, 'AI 对话模型', CONNECTION_NAME)
  await chooseOption(manager, 'AI 对话推理强度', '高')
  await expect(manager.getByRole('combobox', { name: 'AI 对话推理强度' })).toContainText('高')
  await expect.poll(() => page.evaluate(async () => {
    const result = await window.arkdown.getLargeModelSettings!()
    if (!result.ok) return null
    const connection = result.value.connections.find(({ id }) => (
      id === result.value.aiConversation.connectionId
    ))
    return {
      modelId: connection?.modelId,
      name: connection?.name,
      reasoningEffort: result.value.aiConversation.reasoningEffort,
    }
  })).toEqual({ modelId: MODEL_ID, name: CONNECTION_NAME, reasoningEffort: 'high' })
  const bottomBack = await bottomBackButton.boundingBox()
  if (!bottomBack) throw new Error('Preferences manager back button has no geometry')
  expect(bottomBack.width).toBeCloseTo(126, 0)
  expect(bottomBack.height).toBeCloseTo(32, 0)
  await bottomBackButton.click()
  await expect(manager).toHaveCount(0)
  const summary = await expectSummaryWithClose()
  await expect(section).toContainText(CONNECTION_NAME)

  await managerTreeLink.click()
  await expect(manager.getByRole('combobox', { name: 'AI 对话模型' })).toContainText(CONNECTION_NAME)
  await expect(manager.getByRole('combobox', { name: 'AI 对话推理强度' })).toContainText('高')
  await back.click()
  await expect(manager).toHaveCount(0)
  await expectSummaryWithClose()
  await back.click()
  await expect(page.locator('.preferences-page')).toHaveCount(0)
  await expectAppliedGeneralPreferences()

  await openPreferences()
  await expectSummaryWithClose()
  await expect(page.getByRole('combobox', { name: '搜索提供商' })).toContainText('Google')
  await expect(page.getByRole('checkbox', { name: '拼写检查', exact: true })).toBeChecked()
  await managerTreeLink.click()
  await expect(manager.getByRole('combobox', { name: 'AI 对话模型' })).toContainText(CONNECTION_NAME)
  await expect(manager.getByRole('combobox', { name: 'AI 对话推理强度' })).toContainText('高')
  await back.click()
  await expectSummaryWithClose()
  await back.click()
  await expect(page.locator('.preferences-page')).toHaveCount(0)
  return { bottomBack, summary }
}

async function openDocument(name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  await expect(page.locator('.ProseMirror')).toBeVisible()
}

async function sendAiMessage(content: string): Promise<void> {
  const composer = page.getByRole('textbox', { name: '发送消息给 AI' })
  await expect(composer).toHaveCSS('font-size', '13px')
  await expect(composer).toHaveCSS('resize', 'none')
  await composer.fill(content)
  await page.getByRole('button', { name: '发送', exact: true }).click()
}

async function chooseWritePolicy(label: '每次询问' | '按文档许可' | '按工作区许可'): Promise<void> {
  const policy = page.locator('.ai-conversation-write-policy')
  const trigger = policy.getByRole('button', { name: /^写入策略：/u })
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
  await policy.getByRole('menuitemradio', { name: new RegExp(`^${label}`, 'u') }).click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(trigger).toHaveAccessibleName(`写入策略：${label}`)
  // LEGACY-017 accepts focus loss after the asynchronous policy save.
  // Keep menu/label checks and wait for the control to become usable again.
  await expect(trigger).toBeEnabled()
}

async function nativeAndRendererGeometry() {
  const native = await application!.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const display = window ? screen.getDisplayMatching(window.getBounds()) : screen.getPrimaryDisplay()
    return {
      bounds: window?.getBounds() ?? null,
      contentBounds: window?.getContentBounds() ?? null,
      workAreaSize: display.workAreaSize,
      scaleFactor: display.scaleFactor,
    }
  })
  const renderer = await page.evaluate(() => ({
    devicePixelRatio,
    height: innerHeight,
    width: innerWidth,
  }))
  return { native, renderer }
}

async function stubWorkspacePicker(target: string): Promise<void> {
  await application!.evaluate(({ dialog }, directory) => {
    const marker = globalThis as typeof globalThis & { __arkdownAiPickerCount?: number }
    marker.__arkdownAiPickerCount ??= 0
    dialog.showOpenDialog = async () => {
      marker.__arkdownAiPickerCount = (marker.__arkdownAiPickerCount ?? 0) + 1
      return { canceled: false, filePaths: [directory] }
    }
  }, target)
}

async function pickerCount(): Promise<number> {
  return await application!.evaluate(() => (
    (globalThis as typeof globalThis & { __arkdownAiPickerCount?: number })
      .__arkdownAiPickerCount ?? 0
  ))
}

test.beforeEach(async ({}, testInfo) => {
  const sharedApplication = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!sharedApplication) throw new Error('Electron E2E shared runtime is not prepared')
  runtime = await createRuntimeInstance(sharedApplication, 'arkdown-ai-conversation-e2e-runtime-')
  workspaceA = path.join(runtime.root, 'workspace-a')
  workspaceB = path.join(runtime.root, 'workspace-b')
  const processTemp = path.join(runtime.root, 'process-temp')
  await Promise.all([
    mkdir(workspaceA, { recursive: true }),
    mkdir(workspaceB, { recursive: true }),
    mkdir(processTemp, { recursive: true }),
    mkdir(runtime.userData, { recursive: true }),
  ])
  await Promise.all([
    writeFile(path.join(workspaceA, 'a.md'), '# A\n\nSaved A\n', 'utf8'),
    writeFile(path.join(workspaceA, 'b.md'), '# B\n\nSaved B\n', 'utf8'),
    writeFile(path.join(workspaceB, 'c.md'), '# C\n\nSaved C\n', 'utf8'),
  ])

  loopback = new AiConversationLoopbackServer({
    apiKey: API_KEY,
    documentMarkers: [UNSAVED_MARKER],
    modelId: MODEL_ID,
  })
  await runE2eStage('启动 AI 对话本地 loopback provider', async () => await loopback!.start())
  const requestedDpr = Number(testInfo.project.metadata.requestedDpr ?? 1.5)
  application = await runE2eStage('启动隔离 packaged Arkdown', async () => await electron.launch({
    executablePath: runtime.executable,
    cwd: runtime.application,
    timeout: 30_000,
    args: [
      '--disable-gpu',
      `--force-device-scale-factor=${requestedDpr}`,
      `--user-data-dir=${runtime.userData}`,
    ],
    env: {
      ...process.env,
      APPDATA: runtime.root,
      LOCALAPPDATA: runtime.root,
      TEMP: processTemp,
      TMP: processTemp,
      TMPDIR: processTemp,
      ARKDOWN_E2E: '1',
      ARKDOWN_E2E_RECOVER: '1',
      ARKDOWN_E2E_WORKSPACE: workspaceA,
    },
  }))
  page = await application.firstWindow({ timeout: 15_000 })
  await expect(page.locator('.app-titlebar')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: 'a.md', exact: true })).toBeVisible()
})

test.afterEach(async ({}, testInfo) => {
  const targetApplication = application
  const targetLoopback = loopback
  application = undefined
  loopback = undefined
  let cleanupFailure: unknown
  let runtimeQuiet = !runtime?.executable
  const attempt = async (operation: () => Promise<void>) => {
    try { await operation() } catch (error) { cleanupFailure ??= error }
  }
  await attempt(async () => {
    if (!runtime?.executable) return
    await shutdownElectronApplicationScope<ElectronApplication>({
      application: targetApplication,
      executable: runtime.executable,
      requestClose: async (candidate) => await candidate.close(),
    })
    runtimeQuiet = true
  })
  await attempt(async () => {
    if (!targetLoopback) return
    try {
      if (testInfo.status === testInfo.expectedStatus) targetLoopback.assertHealthy()
      else {
        let providerFailure: string | null = null
        try { targetLoopback.assertHealthy() } catch (error) {
          providerFailure = error instanceof Error ? error.message : String(error)
        }
        await testInfo.attach('ai-conversation-loopback-failure.json', {
          body: Buffer.from(JSON.stringify({
            providerFailure,
            requests: targetLoopback.requestRecords(),
          }, null, 2)),
          contentType: 'application/json',
        })
      }
    } finally {
      await targetLoopback.close()
    }
  })
  await attempt(async () => {
    if (runtimeQuiet && runtime?.root) await cleanupRuntime(runtime.root)
  })
  if (cleanupFailure) throw cleanupFailure
})

test('uses an exact 1800x1080 CSS px content area when the native display can contain it', async ({}, testInfo) => {
  expect(testInfo.project.name).toBe('native-150')
  const { native, renderer } = await nativeAndRendererGeometry()
  test.skip(
    native.workAreaSize.width <= 1800 || native.workAreaSize.height <= 1080,
    `Host display work area ${native.workAreaSize.width}x${native.workAreaSize.height} cannot contain 1800x1080 CSS px plus the native frame`,
  )
  expect(native.scaleFactor).toBe(1.5)
  expect(native.contentBounds).toMatchObject({ width: 1800, height: 1080 })
  expect(renderer).toMatchObject({ devicePixelRatio: 1.5, width: 1800, height: 1080 })
  // Windows rounds the retained native frame at fractional DPI and screen positions.
  // The requested CSS content area stays exact; only the separate outer frame varies.
  expect(native.bounds!.width).toBeGreaterThanOrEqual(1800)
  expect(native.bounds!.width).toBeLessThanOrEqual(1802)
  expect(native.bounds!.height).toBeGreaterThanOrEqual(1080)
  expect(native.bounds!.height).toBeLessThanOrEqual(1082)
})

test('covers the packaged AI conversation layout, editor context, authorization, and workspace lifecycle', async ({}, testInfo) => {
  expect(testInfo.project.name).toBe('native-150')
  const geometry = await nativeAndRendererGeometry()
  const nativeGeometry = geometry.native
  const rendererGeometry = geometry.renderer
  const requestedDpr = Number(testInfo.project.metadata.requestedDpr ?? 1.5)
  expect(rendererGeometry.devicePixelRatio).toBe(requestedDpr)
  const expectedSystemScale = Number(testInfo.project.metadata.expectedSystemScale ?? 1.5)
  expect(nativeGeometry.scaleFactor).toBe(expectedSystemScale)

  const settingsButtonGeometry = await configureAiConversationModel()
  await openDocument('a.md')
  await page.getByRole('button', { name: '打开右侧栏' }).click()
  const rightSidebar = page.getByRole('complementary', { name: '右侧栏' })
  await expect(rightSidebar).toBeVisible()
  await expect(rightSidebar.getByRole('tab', { name: 'AI 对话' })).toHaveAttribute('aria-selected', 'true')
  await expect(rightSidebar.getByRole('tab', { name: '翻译' })).toHaveAttribute('aria-selected', 'false')
  await expect(rightSidebar.getByRole('tab', { name: '文档查看' })).toHaveAttribute('aria-selected', 'false')
  expect(await rightSidebar.getByRole('tab').allTextContents()).toEqual(['AI 对话', '翻译', '文档查看'])
  await expect(rightSidebar.getByText('尚未配置大模型')).toHaveCount(0)

  const layout = await page.evaluate(() => {
    const rect = (selector: string) => {
      const value = document.querySelector(selector)!.getBoundingClientRect()
      return { left: value.left, right: value.right, width: value.width }
    }
    const panel = document.querySelector<HTMLElement>('.ai-conversation-sidebar')!
    return {
      left: rect('.sidebar'),
      middle: rect('.editor-host'),
      right: rect('.editor-right-sidebar'),
      panelFontSize: getComputedStyle(panel).fontSize,
      editorMinimumMargin: getComputedStyle(document.querySelector('.app-shell')!)
        .getPropertyValue('--editor-minimum-margin').trim(),
      editorMaximumWidth: getComputedStyle(document.querySelector('.app-shell')!)
        .getPropertyValue('--editor-maximum-width').trim(),
    }
  })
  expect(layout.left.width).toBeCloseTo(300, 0)
  expect(layout.right.width).toBeCloseTo(530, 0)
  expect(layout.middle.left).toBeCloseTo(layout.left.right, 0)
  expect(layout.right.left).toBeGreaterThan(layout.middle.left)
  expect(layout.panelFontSize).toBe('13px')
  expect(layout.editorMinimumMargin).toBe('50px')
  expect(layout.editorMaximumWidth).toBe('800px')
  await expect(rightSidebar).not.toContainText('AI可能出错，请核对重要信息。')
  await expect(rightSidebar).not.toContainText('AI 可能出错，请核对重要信息。')

  await sendAiMessage(`自然对话 ${SESSION_MARKER}`)
  await expect(rightSidebar.getByText(`LOOPBACK_CHAT_OK:${SESSION_MARKER}`, { exact: true }))
    .toBeVisible({ timeout: 15_000 })
  await expect(rightSidebar.getByRole('button', { name: '清空对话' })).toBeEnabled()

  await openDocument('b.md')
  await expect(rightSidebar.getByText(`LOOPBACK_CHAT_OK:${SESSION_MARKER}`, { exact: true }))
    .toBeVisible()
  const editor = page.locator('.ProseMirror')
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(` ${UNSAVED_MARKER}`)
  await expect(editor).toContainText(UNSAVED_MARKER)
  expect(await readFile(path.join(workspaceA, 'b.md'), 'utf8')).not.toContain(UNSAVED_MARKER)

  const documentAccess = rightSidebar.getByRole('button', { name: '让 AI 查看文档' })
  const requestsBeforeDocumentAccess = loopback!.conversationRequestCount
  await expect(documentAccess).toHaveAttribute('aria-pressed', 'true')
  await expect(rightSidebar.getByRole('button', { name: '让 AI 查看文档' }))
    .toHaveAttribute('aria-pressed', 'true')
  expect(loopback!.conversationRequestCount).toBe(requestsBeforeDocumentAccess)
  const firstConversationRequest = loopback!.requestRecords()
    .find(({ kind }) => kind === 'conversation')
  expect(firstConversationRequest).toBeDefined()
  expect(JSON.stringify(firstConversationRequest!.body)).not.toContain(UNSAVED_MARKER)
  await sendAiMessage(`分析当前文档并总结 ${AI_CONVERSATION_E2E_READ_COMMAND}`)
  await expect(rightSidebar.getByText(`LOOPBACK_READ_OK:${UNSAVED_MARKER}`, { exact: true }))
    .toBeVisible({ timeout: 15_000 })
  expect(loopback!.documentReadMarkers()).toEqual([UNSAVED_MARKER])
  expect(await readFile(path.join(workspaceA, 'b.md'), 'utf8')).not.toContain(UNSAVED_MARKER)

  const usage = rightSidebar.getByLabel('上下文占用')
  await expect(usage).toHaveText('18% · 23,410 / 128,000')
  const footerGeometry = await page.evaluate(() => {
    const usage = document.querySelector('.ai-conversation-context-usage')!.getBoundingClientRect()
    const meta = document.querySelector('.ai-conversation-footer-meta')!.getBoundingClientRect()
    const composer = document.querySelector('.ai-conversation-composer')!.getBoundingClientRect()
    return {
      usageRight: usage.right,
      usageBottom: usage.bottom,
      metaRight: meta.right,
      composerRight: composer.right,
      composerBottom: composer.bottom,
    }
  })
  expect(Math.abs(footerGeometry.usageRight - footerGeometry.metaRight)).toBeLessThanOrEqual(1)
  expect(Math.abs(footerGeometry.usageRight - footerGeometry.composerRight)).toBeLessThanOrEqual(1)
  expect(footerGeometry.usageBottom).toBeGreaterThan(footerGeometry.composerBottom)

  await saveWithNativeShortcut(application!, page)
  await expect.poll(async () => await readFile(path.join(workspaceA, 'b.md'), 'utf8'))
    .toContain(UNSAVED_MARKER)

  await expect(rightSidebar.getByRole('button', { name: '让 AI 查看工作区' })).toHaveAttribute('aria-pressed', 'true')
  await expect(rightSidebar.getByRole('button', { name: '让 AI 查看工作区' }))
    .toHaveAttribute('aria-pressed', 'true')

  await chooseWritePolicy('每次询问')
  await sendAiMessage(`读取并编辑 b.md ${AI_CONVERSATION_E2E_WORKSPACE_ONCE_COMMAND}`)
  let authorization = rightSidebar.getByRole('group', { name: 'AI 写入许可申请' })
  await expect(authorization).toContainText('允许 AI 执行本次写入操作。')
  await expect(authorization).toContainText('b.md')
  await authorization.getByRole('button', { name: '允许', exact: true }).click()
  await expect(rightSidebar.getByText('编辑 · 本次操作 · 已允许：b.md', { exact: true }))
    .toBeVisible()
  await expect(rightSidebar.getByText('LOOPBACK_WORKSPACE_WRITE_OK:AI_EDITED_ONCE', {
    exact: true,
  })).toBeVisible({ timeout: 15_000 })
  await expect(editor).toContainText('AI_EDITED_ONCE')
  expect(markdownContainsText(await readFile(path.join(workspaceA, 'b.md'), 'utf8'), 'AI_EDITED_ONCE')).toBe(false)
  await saveWithNativeShortcut(application!, page)
  await expect.poll(async () => markdownContainsText(
    await readFile(path.join(workspaceA, 'b.md'), 'utf8'), 'AI_EDITED_ONCE',
  )).toBe(true)
  const editedPath = path.join(workspaceA, 'b.md')
  await expect(rightSidebar.locator('.ai-conversation-operation-record', {
    hasText: editedPath,
  }).filter({ hasText: '已修改' })).toBeVisible()

  await chooseWritePolicy('按文档许可')
  await sendAiMessage(`申请当前会话文档许可 ${AI_CONVERSATION_E2E_WORKSPACE_SESSION_COMMAND}`)
  // The selected, readable current document already has the document-grant scope.
  // Completion without an approval click also exercises the fresh post-edit read.
  await expect(rightSidebar.getByText('LOOPBACK_WORKSPACE_WRITE_OK:AI_EDITED_SESSION', {
    exact: true,
  })).toBeVisible({ timeout: 15_000 })
  await expect(rightSidebar.getByRole('group', { name: 'AI 写入许可申请' })).toHaveCount(0)
  await sendAiMessage(`复用当前会话文档许可 ${AI_CONVERSATION_E2E_WORKSPACE_SESSION_SECOND_COMMAND}`)
  await expect(rightSidebar.getByText('LOOPBACK_WORKSPACE_WRITE_OK:AI_EDITED_SESSION_SECOND', {
    exact: true,
  })).toBeVisible({ timeout: 15_000 })
  await expect(rightSidebar.getByRole('group', { name: 'AI 写入许可申请' })).toHaveCount(0)
  await expect(editor).toContainText('AI_EDITED_SESSION_SECOND')
  expect(markdownContainsText(await readFile(path.join(workspaceA, 'b.md'), 'utf8'), 'AI_EDITED_SESSION_SECOND')).toBe(false)
  await saveWithNativeShortcut(application!, page)
  await expect.poll(async () => markdownContainsText(
    await readFile(path.join(workspaceA, 'b.md'), 'utf8'), 'AI_EDITED_SESSION_SECOND',
  )).toBe(true)

  await chooseWritePolicy('每次询问')
  await sendAiMessage(`拒绝本次写入 ${AI_CONVERSATION_E2E_WORKSPACE_DENY_COMMAND}`)
  authorization = rightSidebar.getByRole('group', { name: 'AI 写入许可申请' })
  await expect(authorization).toContainText('允许 AI 执行本次写入操作。')
  await authorization.getByRole('button', { name: '拒绝', exact: true }).click()
  await expect(rightSidebar.getByText('编辑 · 本次操作 · 已拒绝：b.md', { exact: true }))
    .toBeVisible()
  await expect(rightSidebar.getByText(
    'LOOPBACK_WORKSPACE_WRITE_DENIED:AI_EDITED_DENIED_SHOULD_NOT_PERSIST',
    { exact: true },
  )).toBeVisible({ timeout: 15_000 })
  expect(markdownContainsText(await readFile(path.join(workspaceA, 'b.md'), 'utf8'), 'AI_EDITED_DENIED_SHOULD_NOT_PERSIST')).toBe(false)

  await stubWorkspacePicker(workspaceB)
  await page.getByRole('button', { name: 'workspace-a', exact: true }).click()
  const introduction = page.getByRole('dialog', { name: '让文档出现在这里', exact: true })
  await expect(introduction).toBeVisible()
  expect(await pickerCount()).toBe(0)
  await introduction.getByRole('button', { name: '好的', exact: true }).click()
  await expect(introduction).toHaveCount(0)
  const cancelDialog = page.getByRole('dialog', { name: '切换工作区将创建新的AI对话' })
  await expect(cancelDialog).toContainText('之后再切回原先工作区可以继续之前的对话')
  await cancelDialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(cancelDialog).toHaveCount(0)
  expect(await pickerCount()).toBe(0)
  await expect(page.getByRole('button', { name: 'workspace-a', exact: true })).toBeVisible()
  await expect(rightSidebar.getByText(`LOOPBACK_CHAT_OK:${SESSION_MARKER}`, { exact: true }))
    .toBeVisible()
  await expect(rightSidebar.getByRole('button', { name: '让 AI 查看文档' }))
    .toHaveAttribute('aria-pressed', 'true')
  await expect(rightSidebar.getByRole('button', { name: '让 AI 查看工作区' }))
    .toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: 'workspace-a', exact: true }).click()
  const switchDialog = page.getByRole('dialog', { name: '切换工作区将创建新的AI对话' })
  await switchDialog.getByRole('button', { name: '切换', exact: true }).click()
  await expect(page.getByRole('button', { name: 'workspace-b', exact: true })).toBeVisible({
    timeout: 15_000,
  })
  expect(await pickerCount()).toBe(1)
  await expect(rightSidebar.getByText(`LOOPBACK_CHAT_OK:${SESSION_MARKER}`, { exact: true }))
    .toHaveCount(0)
  await expect(rightSidebar.getByRole('button', { name: '让 AI 查看文档' }))
    .toHaveAttribute('aria-pressed', 'true')
  await expect(rightSidebar.getByRole('button', { name: '让 AI 查看工作区' }))
    .toHaveAttribute('aria-pressed', 'true')

  await stubWorkspacePicker(workspaceA)
  await page.getByRole('button', { name: 'workspace-b', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '切换工作区将创建新的AI对话' }))
    .toHaveCount(0)
  await expect(page.getByRole('button', { name: 'workspace-a', exact: true })).toBeVisible({
    timeout: 15_000,
  })
  expect(await pickerCount()).toBe(2)
  await expect(rightSidebar.getByText(`LOOPBACK_CHAT_OK:${SESSION_MARKER}`, { exact: true }))
    .toBeVisible()
  await expect(rightSidebar.getByText(`LOOPBACK_READ_OK:${UNSAVED_MARKER}`, { exact: true }))
    .toBeVisible()
  await expect(rightSidebar.getByRole('button', { name: '让 AI 查看文档' }))
    .toHaveAttribute('aria-pressed', 'true')
  await expect(rightSidebar.getByRole('button', { name: '让 AI 查看工作区' }))
    .toHaveAttribute('aria-pressed', 'true')

  const providerRequests = loopback!.requestRecords()
  expect(loopback!.conversationRequestCount).toBeGreaterThanOrEqual(15)
  expect(providerRequests.every(({ headers }) => (
    headers.authorization === 'Bearer [REDACTED]'
  ))).toBe(true)
  expect(providerRequests.filter(({ kind }) => kind === 'conversation').every(({ body }) => (
    body.max_tokens === 32_768 && body.reasoning_effort === 'high'
  ))).toBe(true)
  const serializedProviderBodies = JSON.stringify(providerRequests.map(({ body }) => body))
  expect(serializedProviderBodies).not.toContain(API_KEY)
  expect(serializedProviderBodies).not.toMatch(/"authorization"\s*:/iu)
  expect(serializedProviderBodies).not.toMatch(/"api[_-]?key"\s*:/iu)
  expect(JSON.stringify(providerRequests)).not.toContain(API_KEY)
  await testInfo.attach('ai-conversation-e2e-evidence.json', {
    body: Buffer.from(JSON.stringify({
      nativeGeometry,
      rendererGeometry,
      layout,
      settingsButtonGeometry,
      footerGeometry,
      providerRequests,
    }, null, 2)),
    contentType: 'application/json',
  })
})
