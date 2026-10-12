import { markdownContainsText } from './support/markdown-markers'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { cleanupRuntime, createRuntimeInstance, shutdownElectronApplicationScope, type RuntimeInstance } from './support/runtime'
import { saveWithNativeShortcut } from './support/native-shortcuts'
import { EDIT_ONE, EDIT_TWO, FAILURE, KEY, MODEL, PARTIAL, ProgressLoopback, RAW_ERROR, STREAM, UNSAVED } from './support/ai-conversation-progress-loopback'

const CONNECTION = 'Native progress localhost'
const ORIGINAL = '# Synthetic note\n\nSaved original.\n'
let app: ElectronApplication | undefined
let page: Page
let runtime: RuntimeInstance
let server: ProgressLoopback
let workspace = ''
async function option(container: Locator, label: string, value: string) {
  const trigger = container.getByRole('combobox', { name: label, exact: true })
  await trigger.click()
  await page.getByRole('listbox', { name: label, exact: true }).getByRole('option', { name: value, exact: true }).click()
  await expect(trigger).toContainText(value)
}
async function configure() {
  await page.getByTestId('app-titlebar').getByRole('button', { name: '文件', exact: true }).click()
  await page.getByRole('menuitem', { name: /偏好设置/u }).click()
  await page.locator('a.preferences-toc-secondary[href="#preferences-large-model-manager"]').click()
  const manager = page.locator('.large-model-manager')
  await manager.getByRole('button', { name: '添加大模型', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加大模型', exact: true })
  await option(dialog, '服务商', '其他')
  await option(dialog, '接口协议', 'OpenAI 兼容')
  await dialog.getByLabel('配置名称', { exact: true }).fill(CONNECTION)
  await dialog.getByLabel('Base URL', { exact: true }).fill(server.baseUrl)
  await dialog.getByLabel('模型 ID', { exact: true }).fill(MODEL)
  await dialog.getByLabel('API Key', { exact: true }).fill(KEY)
  await dialog.getByLabel('上下文窗口', { exact: true }).fill('128000')
  await dialog.getByLabel('最大输入', { exact: true }).fill('95000')
  await dialog.getByLabel('最大输出', { exact: true }).fill('32768')
  await dialog.getByRole('button', { name: '连接', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await option(manager, 'AI 对话模型', CONNECTION)
  await option(manager, 'AI 对话推理强度', '高')
  // Read-only confirmation of real UI writes; no handler wrappers or settings mutation hooks.
  await expect.poll(() => page.evaluate(async () => {
    const result = await window.arkdown.getLargeModelSettings()
    if (!result.ok) return null
    const models = result.value
    return { model: models.connections.find(item => item.id === models.aiConversation.connectionId)?.modelId,
      effort: models.aiConversation.reasoningEffort }
  })).toEqual({ model: MODEL, effort: 'high' })
  await page.getByRole('button', { name: '返回偏好设置', exact: true }).click()
  await page.getByRole('button', { name: '返回编辑器', exact: true }).click()
  await expect(page.locator('.preferences-page')).toHaveCount(0)
}
function sidebar() { return page.getByRole('complementary', { name: '右侧栏', exact: true }) }
function panel() { return sidebar().getByRole('region', { name: '处理过程', exact: true }) }
function processRegion() { return sidebar().getByRole('region', { name: '过程内容', exact: true }) }
function log() { return sidebar().getByRole('log', { name: 'AI 对话消息', exact: true }) }
function composer() { return page.getByRole('textbox', { name: '发送消息给 AI', exact: true }) }
async function gap(target: Locator) {
  return target.evaluate(element => ({ gap: element.scrollHeight - element.clientHeight - element.scrollTop,
    top: element.scrollTop, overflow: element.scrollHeight - element.clientHeight }))
}
async function expectBottom(target: Locator) { await expect.poll(async () => Math.abs((await gap(target)).gap)).toBeLessThanOrEqual(3) }
async function scrollUp(target: Locator) {
  const box = await target.boundingBox()
  if (!box) throw new Error('Missing scroll region geometry')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20)
  await page.mouse.wheel(0, -650)
  await expect.poll(async () => (await gap(target)).gap).toBeGreaterThan(64)
}
async function elapsed() {
  const text = await panel().locator('.ai-process-times > span').first().innerText()
  const parsed = /^用时 · ([0-9]+\.[0-9])秒$/u.exec(text)
  expect(parsed).not.toBeNull()
  return Number(parsed![1])
}
async function send(command: string) {
  await composer().fill(command)
  await sidebar().getByRole('button', { name: '发送', exact: true }).click()
}
async function expectNoPermissionPrompt() {
  await expect(sidebar().getByRole('group', { name: 'AI 写入许可申请', exact: true })).toHaveCount(0)
  await expect(sidebar().getByRole('button', { name: '让 AI 查看文档', exact: true })).toHaveAttribute('aria-pressed', 'true')
}

test.beforeEach(async () => {
  const shared = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!shared) throw new Error('Existing globalSetup must supply the verified packaged runtime')
  runtime = await createRuntimeInstance(shared, 'arkdown-ai-progress-native-')
  workspace = path.join(runtime.root, 'workspace')
  await mkdir(workspace)
  await writeFile(path.join(workspace, 'note.md'), ORIGINAL, 'utf8')
  server = new ProgressLoopback()
  await server.start()
  const environment: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  for (const key of Object.keys(environment)) {
    if (/^(?:ARKDOWN_|ARKNOTE_|OPENAI_|ANTHROPIC_|AZURE_OPENAI_|GEMINI_|CODEX_)/i.test(key)
      || ['ELECTRON_RUN_AS_NODE', 'PORTABLE_EXECUTABLE_DIR', 'NODE_OPTIONS'].includes(key)) delete environment[key]
  }
  Object.assign(environment, { APPDATA: runtime.root, LOCALAPPDATA: runtime.root,
    CODEX_HOME: path.join(runtime.root, 'codex-home'), ARKDOWN_E2E: '1', ARKDOWN_E2E_RECOVER: '1', ARKDOWN_E2E_WORKSPACE: workspace })
  app = await electron.launch({ executablePath: runtime.executable, cwd: runtime.application, timeout: 30_000,
    args: ['--disable-gpu', `--user-data-dir=${runtime.userData}`], env: environment })
  page = await app.firstWindow({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'note.md', exact: true })).toBeVisible()
  await configure()
  await page.getByRole('button', { name: 'note.md', exact: true }).click()
  await expect(page.locator('.ProseMirror')).toContainText('Saved original.')
  await page.getByRole('button', { name: '打开右侧栏', exact: true }).click()
  // Explicitly grant once through the normal UI, regardless of initial preference.
  const permission = sidebar().getByRole('button', { name: '让 AI 查看文档', exact: true })
  if (await permission.getAttribute('aria-pressed') === 'true') await permission.click()
  await expect(permission).toHaveAttribute('aria-pressed', 'false')
  await permission.click()
  await expect(permission).toHaveAttribute('aria-pressed', 'true')
  const workspacePermission = sidebar().getByRole('button', { name: '让 AI 查看工作区', exact: true })
  if (await workspacePermission.getAttribute('aria-pressed') !== 'true') await workspacePermission.click()
  await expect(workspacePermission).toHaveAttribute('aria-pressed', 'true')
  expect(server.conversationCount).toBe(0)
  expect(server.probeCount).toBe(1)
})

test.afterEach(async ({}, info) => {
  const evidence = { phase: server?.phase, probeCount: server?.probeCount, conversationCount: server?.conversationCount,
    confirmedReads: server?.confirmedReads, confirmedWrites: server?.confirmedWrites, faults: server?.faults, toolDiagnostics: server?.toolDiagnostics, events: server?.events,
    runtimeRoot: runtime?.root, workspace }
  await info.attach('finite-loopback-evidence', { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json' })
  // Release held synthetic responses before normal shutdown so a failed test cannot hang a provider gate.
  await server?.close()
  const candidate = app; app = undefined
  let quiet = false
  if (runtime?.executable) {
    await shutdownElectronApplicationScope({ application: candidate, executable: runtime.executable,
      requestClose: async target => await target.close() })
    quiet = true
  }
  if (quiet && runtime?.root) await cleanupRuntime(runtime.root)
})

test('shows real provider process, follows inner and outer stream bottoms, and reuses current-document write permission for two edits', async ({}, info) => {
  const notePath = path.join(workspace, 'note.md')
  const originalBytes = await readFile(notePath)
  const originalMtime = (await stat(notePath)).mtimeMs
  await page.locator('.ProseMirror').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(' ' + UNSAVED)
  const policy = sidebar().getByRole('button', { name: /^写入策略：/u })
  await policy.click()
  await sidebar().getByRole('menuitemradio', { name: /^按文档许可/u }).click()
  await expect(policy).toHaveAccessibleName('写入策略：按文档许可')
  await expect.poll(() => page.evaluate(async () => {
    const result = await window.arkdown.getLargeModelSettings()
    return result.ok ? result.value.aiConversation.writePolicy : null
  })).toBe('document-grant')
  await send(STREAM)
  await expect(panel()).toHaveCount(1)
  await expect(processRegion()).toContainText('PROVIDER_THINKING_000')
  await expect(panel().locator('.ai-process-status')).toHaveText('正在思考')
  const early = await elapsed()
  await expect.poll(() => server.phase).toBe('reason-more')
  await expect.poll(async () => (await gap(processRegion())).overflow).toBeGreaterThan(150)
  await expectBottom(processRegion())
  await expectBottom(log())
  await composer().focus()
  await scrollUp(processRegion())
  server.release('reason-more')
  await expect.poll(() => server.phase).toBe('read-one')
  await expect(processRegion()).toContainText('REASON_TAIL_024')
  await expectBottom(processRegion())
  await expectBottom(log())
  await expect(composer()).toBeFocused()
  expect(await elapsed()).toBeGreaterThan(early)
  await expectNoPermissionPrompt()
  server.release('read-one')
  await expect.poll(() => server.phase).toBe('first-edit-confirmed')
  await expect(page.locator('.ProseMirror')).toContainText(EDIT_ONE)
  await expect(page.locator('.ProseMirror')).not.toContainText(EDIT_TWO)
  expect(server.confirmedWrites).toBe(1)
  await expectNoPermissionPrompt()
  expect(await readFile(notePath)).toEqual(originalBytes)
  server.release('first-edit-confirmed')
  await expect.poll(() => server.phase).toBe('answer-more')
  expect(server.conversationCount).toBe(6)
  expect(server.confirmedReads).toBe(3)
  expect(server.confirmedWrites).toBe(2)
  await expect(page.locator('.ProseMirror')).toContainText(EDIT_ONE)
  await expect(page.locator('.ProseMirror')).toContainText(EDIT_TWO)
  await expectNoPermissionPrompt()
  await expect(panel().getByRole('group', { name: '第 1 轮', exact: true })).toHaveCount(1)
  await expect(panel().getByRole('group', { name: '第 2 轮', exact: true })).toHaveCount(1)
  // Round 6 contains only the final answer; the process panel groups actual reasoning/tools.
  await expect(panel().getByRole('group', { name: '第 5 轮', exact: true })).toHaveCount(1)
  await expect(panel().locator('.ai-process-tool-status').filter({ hasText: /^已完成$/u })).toHaveCount(5)
  expect(await readFile(notePath)).toEqual(originalBytes)
  expect((await stat(notePath)).mtimeMs).toBe(originalMtime)
  await expect.poll(async () => (await gap(log())).overflow).toBeGreaterThan(150)
  await expectBottom(log())
  await composer().focus()
  await scrollUp(log())
  server.release('answer-more')
  await expect.poll(() => server.phase).toBe('finish-answer')
  await expect(log()).toContainText('ANSWER_TAIL_024')
  await expectBottom(log())
  await expect(composer()).toBeFocused()
  await info.attach('active-stream', { body: await page.screenshot(), contentType: 'image/png' })
  server.release('finish-answer')
  await expect(log()).toContainText('STREAM_COMPLETE')
  await expect(panel().locator('.ai-process-status')).toHaveText('已完成')
  await expect(panel().locator('.ai-process-times > span').filter({ hasText: /^用时 ·/u })).toHaveCount(1)
  await expect(panel()).toContainText(/思考用时 [0-9]+\.[0-9]秒/u)
  await expect(sidebar()).not.toContainText('native_tool_')
  await expect(sidebar()).not.toContainText(KEY)
  const completed = await elapsed()
  await page.waitForTimeout(1250) // One actual 1s presentation tick: terminal duration must remain frozen.
  expect(await elapsed()).toBe(completed)
  await scrollUp(log())
  const stoppedTop = (await gap(log())).top
  await page.waitForTimeout(1100)
  expect(Math.abs((await gap(log())).top - stoppedTop)).toBeLessThanOrEqual(3)
  expect(server.faults).toEqual([])
  await saveWithNativeShortcut(app!, page)
  await expect.poll(async () => markdownContainsText(await readFile(notePath, 'utf8'), UNSAVED)).toBe(true)
  await expect.poll(async () => markdownContainsText(await readFile(notePath, 'utf8'), EDIT_ONE)).toBe(true)
  await expect.poll(async () => markdownContainsText(await readFile(notePath, 'utf8'), EDIT_TWO)).toBe(true)
  await expect(page).toHaveTitle('note.md — Arkdown')
})

test('retains a partial answer and provider process with precise quota failure and no automatic retry', async ({}, info) => {
  await send(FAILURE)
  await expect.poll(() => server.phase).toBe('release-quota-error')
  await expect(log()).toContainText(PARTIAL)
  await expect(processRegion()).toContainText('ERROR_PROCESS_PREFIX')
  server.release('release-quota-error')
  await expect(sidebar()).toContainText('大模型账户余额或可用配额不足，请检查服务商账户。')
  await expect(sidebar().getByRole('article', { name: 'AI 未完成回复', exact: true })).toContainText(PARTIAL)
  await expect(panel().locator('.ai-process-status')).toContainText('已失败')
  await expect(processRegion()).toContainText('ERROR_PROCESS_PREFIX')
  await expect(sidebar()).not.toContainText('返回的数据格式不兼容')
  await expect(sidebar()).not.toContainText(RAW_ERROR)
  await expect(sidebar()).not.toContainText(KEY)
  const ended = await elapsed()
  await page.waitForTimeout(1250)
  expect(await elapsed()).toBe(ended)
  expect(server.conversationCount).toBe(1)
  expect(server.faults).toEqual([])
  expect(await readFile(path.join(workspace, 'note.md'), 'utf8')).toBe(ORIGINAL)
  await info.attach('quota-partial-retained', { body: await page.screenshot(), contentType: 'image/png' })
})
