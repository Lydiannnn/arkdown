import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  cleanupRuntime,
  createRuntimeInstance,
  shutdownElectronApplicationScope,
  type RuntimeInstance,
} from './support/runtime'

let application: ElectronApplication | undefined
let page: Page
let runtime: RuntimeInstance
let workspace = ''
let requestedDpr = 1.5

async function fullscreenState(): Promise<boolean> {
  return await application!.evaluate(({ BrowserWindow }) => (
    BrowserWindow.getAllWindows()[0]?.isFullScreen() ?? false
  ))
}

async function setFullscreenThroughNativeEvent(fullscreen: boolean): Promise<void> {
  await application!.evaluate(async ({ BrowserWindow }, next) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) throw new Error('Arkdown BrowserWindow is unavailable')
    if (window.isFullScreen() === next) return
    await new Promise<void>((resolve) => {
      if (next) window.once('enter-full-screen', () => resolve())
      else window.once('leave-full-screen', () => resolve())
      window.setFullScreen(next)
    })
  }, fullscreen)
}

async function attachEnvironment(testInfo: TestInfo, extra: Record<string, unknown> = {}): Promise<void> {
  const native = await application!.evaluate(({ BrowserWindow, screen }) => ({
    systemScale: screen.getPrimaryDisplay().scaleFactor,
    windowBounds: BrowserWindow.getAllWindows()[0]?.getBounds() ?? null,
  }))
  const actualDpr = await page.evaluate(() => window.devicePixelRatio)
  expect(native.systemScale).toBe(1.5)
  expect(actualDpr).toBe(requestedDpr)
  await testInfo.attach('fullscreen-geometry.json', {
    body: Buffer.from(JSON.stringify({ requestedDpr, actualDpr, ...native, ...extra }, null, 2)),
    contentType: 'application/json',
  })
}

test.beforeEach(async ({}, testInfo) => {
  requestedDpr = Number(testInfo.project.metadata.requestedDpr)
  const sharedApplication = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!sharedApplication) throw new Error('Electron E2E shared runtime is not prepared')
  runtime = await createRuntimeInstance(sharedApplication, 'arkdown-fullscreen-e2e-runtime-')
  workspace = path.join(runtime.root, 'workspace')
  await mkdir(workspace, { recursive: true })
  await writeFile(path.join(workspace, 'fullscreen.md'), '# Fullscreen focus\n\nBody\n', 'utf8')
  application = await electron.launch({
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
      ARKDOWN_E2E: '1',
      ARKDOWN_E2E_RECOVER: '1',
      ARKDOWN_E2E_WORKSPACE: workspace,
    },
  })
  page = await application.firstWindow({ timeout: 15_000 })
  await expect(page.locator('.app-titlebar')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: 'fullscreen.md', exact: true })).toBeVisible()
})

test.afterEach(async () => {
  const target = application
  application = undefined
  if (runtime?.executable) {
    await shutdownElectronApplicationScope({
      application: target,
      executable: runtime.executable,
      requestClose: async (targetApplication) => await targetApplication.close(),
    })
  }
  if (runtime?.root) await cleanupRuntime(runtime.root)
})

test('double-clicks the real draggable title bar to enter and leave fullscreen', async () => {
  await application!.evaluate(({ BrowserWindow }) => {
    const marker = globalThis as typeof globalThis & { __arkdownMaximizeEvents?: number }
    marker.__arkdownMaximizeEvents = 0
    BrowserWindow.getAllWindows()[0]?.on('maximize', () => {
      marker.__arkdownMaximizeEvents = (marker.__arkdownMaximizeEvents ?? 0) + 1
    })
  })
  const titlebar = page.getByTestId('app-titlebar')
  const bounds = await titlebar.boundingBox()
  if (!bounds) throw new Error('Arkdown title bar has no visible geometry')
  const point = {
    x: bounds.x + bounds.width * 0.72,
    y: bounds.y + bounds.height / 2,
  }

  await page.mouse.dblclick(point.x, point.y, { delay: 100 })
  await expect.poll(fullscreenState).toBe(true)
  expect(await application!.evaluate(({ BrowserWindow }) => (
    BrowserWindow.getAllWindows()[0]?.isMaximized() ?? true
  ))).toBe(false)
  expect(await application!.evaluate(() => (
    (globalThis as typeof globalThis & { __arkdownMaximizeEvents?: number }).__arkdownMaximizeEvents ?? -1
  ))).toBe(0)

  await page.mouse.dblclick(point.x, point.y, { delay: 100 })
  await expect.poll(fullscreenState).toBe(false)
  expect(page.isClosed()).toBe(false)
  expect(await application!.evaluate(() => (
    (globalThis as typeof globalThis & { __arkdownMaximizeEvents?: number }).__arkdownMaximizeEvents ?? -1
  ))).toBe(0)
})

test('uses confirmed native fullscreen state for hint, menu, restore, and Escape priority', async ({}, testInfo) => {
  expect(await fullscreenState()).toBe(false)
  await page.getByRole('button', { name: 'fullscreen.md', exact: true }).click()
  const editor = page.locator('.ProseMirror')
  await editor.click()

  const enteredAt = Date.now()
  await setFullscreenThroughNativeEvent(true)
  expect(await fullscreenState()).toBe(true)
  const hint = page.getByText('按下 Esc 以退出全屏', { exact: true })
  await expect(hint).toBeVisible()
  const initial = await hint.evaluate((element) => {
    element.setAttribute('data-e2e-activation', 'first')
    const box = element.getBoundingClientRect()
    return {
      className: element.className,
      opacity: getComputedStyle(element).opacity,
      center: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
      viewport: { width: innerWidth, height: innerHeight },
    }
  })
  expect(initial.opacity).toBe('1')
  expect(initial.center.x).toBeCloseTo(initial.viewport.width / 2, 0)
  expect(initial.center.y).toBeCloseTo(initial.viewport.height / 2, 0)

  await page.waitForTimeout(800)
  await application!.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.setFullScreen(true)
    if (window && !window.isMaximized()) window.maximize()
  })
  await expect(hint).toHaveAttribute('data-e2e-activation', 'first')
  await page.waitForTimeout(250)
  await expect(hint).not.toHaveClass(/is-fading/)
  await page.waitForTimeout(Math.max(0, 3_100 - (Date.now() - enteredAt)))
  await expect(hint).toHaveClass(/is-fading/)
  await expect.poll(async () => Number(await hint.evaluate((element) => getComputedStyle(element).opacity)))
    .toBeLessThan(1)
  await expect(hint).toHaveCount(0, { timeout: 1_500 })
  expect(Date.now() - enteredAt).toBeGreaterThanOrEqual(3_900)
  expect(Date.now() - enteredAt).toBeLessThan(5_000)

  await page.getByTestId('app-titlebar').getByRole('button', { name: '视图', exact: true }).click()
  const fullscreenRow = page.getByRole('menuitemcheckbox', { name: '退出全屏', exact: true })
  await expect(fullscreenRow).toHaveAttribute('aria-checked', 'true')
  await expect(fullscreenRow).toHaveClass(/application-menu-theme-state/)
  expect(await fullscreenRow.evaluate((element) => getComputedStyle(element).color)).not.toBe('rgb(51, 51, 51)')
  await page.keyboard.press('Escape')
  await expect(page.locator('.application-menu-popover')).toHaveCount(0)
  expect(await fullscreenState()).toBe(true)

  await page.getByTestId('app-titlebar').getByRole('button', { name: '文件', exact: true }).click()
  await page.getByRole('menuitem', { name: /偏好设置/ }).click()
  await expect(page.locator('.preferences-page')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.preferences-page')).toHaveCount(0)
  expect(await fullscreenState()).toBe(true)

  await editor.click()
  expect(await page.evaluate(() => document.activeElement?.closest('.editor-surface') !== null)).toBe(true)
  await page.keyboard.press('Escape')
  await expect.poll(fullscreenState).toBe(false)
  expect(page.isClosed()).toBe(false)
  expect(await page.evaluate(() => document.activeElement?.closest('.editor-surface') !== null)).toBe(true)

  await setFullscreenThroughNativeEvent(true)
  const restore = page.getByRole('button', { name: '恢复窗口', exact: true })
  await expect(restore).toBeVisible()
  await restore.click()
  await expect.poll(fullscreenState).toBe(false)
  expect(page.isClosed()).toBe(false)

  await setFullscreenThroughNativeEvent(true)
  await page.getByTestId('app-titlebar').getByRole('button', { name: '视图', exact: true }).click()
  await page.getByRole('menuitemcheckbox', { name: '退出全屏', exact: true }).click()
  await expect.poll(fullscreenState).toBe(false)
  await expect(editor).toBeVisible()
  expect(await page.evaluate(() => document.activeElement?.closest('.editor-surface') !== null)).toBe(true)

  await attachEnvironment(testInfo, { hintInitial: initial, elapsedMs: Date.now() - enteredAt })
})
