import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { ArknotePipeClient } from '../../src/main/arknote/arknote-pipe-client'
import { StickyNoteStore } from '../../src/main/sticky-notes/sticky-note-store'
import { arknotePipeName } from '../../src/shared/arknote-protocol'
import type { Menu } from 'electron'
import type { StickyNoteStyleReference } from '../../src/shared/sticky-note-preferences'
import {
  cleanupRuntime,
  createRuntimeInstance,
  launchElectronWithDeadline,
  runE2eStage,
  shutdownElectronApplication,
  shutdownElectronApplicationScope,
  type RuntimeInstance,
} from './support/runtime'

const execFile = promisify(execFileCallback)
const POWERSHELL = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)
const ROOT_PROCESS_SCRIPT = `$target = [IO.Path]::GetFullPath($env:ARKNOTE_E2E_EXECUTABLE)
$pids = @(
  Get-CimInstance Win32_Process -Filter "Name = 'Arknote.exe'" |
    Where-Object {
      $_.ExecutablePath -and
      [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target -and
      $_.CommandLine -notlike '*--type=*'
    } |
    Select-Object ProcessId, ParentProcessId, CommandLine, CreationDate
)
ConvertTo-Json -InputObject $pids -Compress
`

let runtime: RuntimeInstance
let arkdown: ElectronApplication | undefined
let arknote: ElectronApplication | undefined
let workspace = ''
let processQueryScript = ''
let trayStateDirectory = ''
const processLogs: string[] = []

function runtimeEnvironment(): Record<string, string> {
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined))
  return {
    ...inherited,
    APPDATA: runtime.root,
    LOCALAPPDATA: runtime.root,
    ARKDOWN_E2E: '1',
    ARKDOWN_E2E_RECOVER: '1',
    ARKDOWN_E2E_TRAY_STATE_DIRECTORY: trayStateDirectory,
    ...(workspace ? { ARKDOWN_E2E_WORKSPACE: workspace } : {}),
  }
}

interface E2eTrayState {
  role: 'arkdown' | 'arknote'
  processId: number
  active: number
  created: number
  destroyed: number
}

async function readTrayState(role: E2eTrayState['role']): Promise<E2eTrayState> {
  return JSON.parse(await readFile(path.join(trayStateDirectory, role + '.json'), 'utf8')) as E2eTrayState
}

function captureProcessLogs(application: ElectronApplication, label: string): void {
  const child = application.process()
  child.stdout?.on('data', (chunk) => processLogs.push(`[${label}:stdout] ${String(chunk)}`))
  child.stderr?.on('data', (chunk) => processLogs.push(`[${label}:stderr] ${String(chunk)}`))
  child.once('exit', (code, signal) => {
    processLogs.push(`[${label}:exit] code=${String(code)} signal=${String(signal)}`)
  })
}

interface ArknoteProcessDetails {
  ProcessId: number
  ParentProcessId: number
  CommandLine: string
  CreationDate: string
}

async function rootArknoteProcesses(): Promise<ArknoteProcessDetails[]> {
  await writeFile(processQueryScript, ROOT_PROCESS_SCRIPT, 'utf8')
  const { stdout } = await execFile(
    POWERSHELL,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', processQueryScript],
    {
      env: { ...process.env, ARKNOTE_E2E_EXECUTABLE: runtime.arknoteExecutable },
      timeout: 15_000,
      windowsHide: true,
    },
  )
  const parsed = JSON.parse(stdout.trim() || '[]') as unknown
  if (!Array.isArray(parsed) || !parsed.every((value) => (
    typeof value === 'object'
    && value !== null
    && Number.isSafeInteger((value as ArknoteProcessDetails).ProcessId)
    && Number.isSafeInteger((value as ArknoteProcessDetails).ParentProcessId)
    && typeof (value as ArknoteProcessDetails).CommandLine === 'string'
  ))) throw new Error(`Unexpected Arknote process list: ${stdout}`)
  return parsed as ArknoteProcessDetails[]
}

async function rootArknotePids(): Promise<number[]> {
  return (await rootArknoteProcesses()).map((process) => process.ProcessId)
}

async function waitForSurface(
  application: ElectronApplication,
  surface: 'arknote-box' | 'arknote-settings' | 'sticky-note',
): Promise<Page> {
  await expect.poll(() => application.windows().some((page) => {
    try {
      return new URL(page.url()).searchParams.get('surface') === surface
    } catch {
      return false
    }
  }), { timeout: 20_000 }).toBe(true)
  const page = application.windows().find((candidate) => {
    try {
      return new URL(candidate.url()).searchParams.get('surface') === surface
    } catch {
      return false
    }
  })
  if (!page) throw new Error(`Arknote surface was not found: ${surface}`)
  const selector = surface === 'arknote-box'
    ? '.arknote-box-window-root'
    : surface === 'arknote-settings'
      ? 'main[aria-label="Arknote 设置"]'
      : '[data-surface="sticky-note"]'
  await expect(page.locator(selector)).toBeVisible({ timeout: 15_000 })
  return page
}

async function nativeWindowTitle(application: ElectronApplication, page: Page): Promise<string> {
  return await application.evaluate(({ BrowserWindow }, targetUrl) => (
    BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === targetUrl)?.getTitle() ?? ''
  ), page.url())
}

async function nativeWindowSize(application: ElectronApplication, page: Page): Promise<{
  width: number
  height: number
}> {
  return await application.evaluate(({ BrowserWindow }, targetUrl) => {
    const bounds = BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === targetUrl)?.getBounds()
    return { width: bounds?.width ?? 0, height: bounds?.height ?? 0 }
  }, page.url())
}
async function closeNativeWindow(application: ElectronApplication, page: Page): Promise<void> {
  const targetUrl = page.url()
  await application.evaluate(({ BrowserWindow }, url) => {
    const target = BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === url)
    if (!target) throw new Error(`Native window was not found: ${url}`)
    target.close()
  }, targetUrl)

  await expect.poll(() => page.isClosed(), { timeout: 15_000 }).toBe(true)
}

async function launchArkdown(): Promise<Page> {
  arkdown = await runE2eStage('启动 Arkdown 客户端', async () => await electron.launch({
    executablePath: runtime.executable,
    cwd: runtime.application,
    timeout: 30_000,
    args: ['--disable-gpu'],
    env: runtimeEnvironment(),
  }))
  captureProcessLogs(arkdown, 'Arkdown')
  return await arkdown.firstWindow({ timeout: 20_000 })
}

async function launchArknote(args: readonly string[] = []): Promise<ElectronApplication> {
  const application = await runE2eStage('启动 Arknote 服务', async () => await launchElectronWithDeadline({
    attemptTimeoutMs: 2_000,
    dispose: async (candidate: ElectronApplication) => {
      await shutdownElectronApplicationScope({
        application: candidate,
        executable: runtime.arknoteExecutable,
        requestClose: async (targetApplication) => await targetApplication.close(),
      })
    },
    isAlive: (candidate: ElectronApplication) => {
      const child = candidate.process()
      return child.exitCode === null && !child.killed
    },
    isRetryable: (error: unknown) => {
      const message = String(error)
      return message.includes('being used by another process')
        || message.includes('Process failed to launch')
    },
    launch: async (timeoutMs: number) => await electron.launch({
      executablePath: runtime.arknoteExecutable,
      cwd: runtime.application,
      timeout: timeoutMs,
      args: ['--disable-gpu', ...args],
      env: runtimeEnvironment(),
    }),
    retryDelayMs: 250,
    stabilityDelayMs: 500,
    totalTimeoutMs: 10_000,
  }))
  captureProcessLogs(application, 'Arknote')
  arknote = application
  return application
}

async function connectService(): Promise<ArknotePipeClient> {
  const tokenPath = path.join(runtime.portableData, 'arknote', 'service-token')
  const token = await expect.poll(async () => {
    try { return (await readFile(tokenPath, 'utf8')).trim() } catch { return '' }
  }, { timeout: 15_000 }).toMatch(/^[a-f0-9]{64}$/u).then(async () => (await readFile(tokenPath, 'utf8')).trim())
  const client = new ArknotePipeClient({
    pipeName: arknotePipeName(runtime.application),
    token,
    timeoutMs: 10_000,
  })
  await client.connect()
  return client
}

async function quitService(): Promise<void> {
  await mkdir(trayStateDirectory, { recursive: true })
  let quitOutcome = 'accepted'
  try {
    await shutdownElectronApplication({
      executable: runtime.arknoteExecutable,
      requestClose: async () => {
        const client = await connectService()
        try {
          await client.request('service.quit', {}, (value) => value === null ? null : undefined)
        } finally {
          client.close()
        }
      },
    })
  } catch (error) {
    let health = 'unavailable'
    const probe = await connectService().catch(() => undefined)
    if (probe) {
      health = await probe.request('health.ping', {}, (value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
        return (value as { ready?: unknown }).ready === true ? 'ready' : undefined
      }).catch((failure: unknown) => failure instanceof Error ? failure.message : String(failure))
      probe.close()
    }
    throw new Error(`Arknote did not exit; quit=${quitOutcome}; health=${health}; processes=${JSON.stringify(await rootArknoteProcesses())}; cause=${String(error)}`)
  }
}

async function quitControlledArknote(application: ElectronApplication): Promise<void> {
  await shutdownElectronApplicationScope({
    application,
    executable: runtime.arknoteExecutable,
    requestClose: async (targetApplication) => await targetApplication.close(),
  })
  if (arknote === application) arknote = undefined
}

test.beforeEach(async () => {
  processLogs.length = 0
  const sharedApplication = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!sharedApplication) throw new Error('Electron E2E shared runtime is not prepared')
  runtime = await createRuntimeInstance(sharedApplication, 'arknote-service-e2e-runtime-')
  workspace = path.join(runtime.root, 'workspace')
  trayStateDirectory = path.join(runtime.root, 'tray-state')
  processQueryScript = path.join(runtime.root, 'arknote-processes.ps1')
  await mkdir(workspace, { recursive: true })
  await mkdir(trayStateDirectory, { recursive: true })
  await writeFile(processQueryScript, ROOT_PROCESS_SCRIPT, 'utf8')
})

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && processLogs.length > 0) {
    await testInfo.attach('electron-process.log', {
      body: Buffer.from(processLogs.join('\n'), 'utf8'),
      contentType: 'text/plain',
    })
  }
  const arkdownTarget = arkdown
  const arknoteTarget = arknote
  arkdown = undefined
  arknote = undefined
  const shutdownErrors: unknown[] = []
  if (runtime?.executable) {
    await shutdownElectronApplicationScope({
      application: arkdownTarget,
      executable: runtime.executable,
      requestClose: async (targetApplication) => await targetApplication.close(),
    }).catch((error: unknown) => shutdownErrors.push(error))
  }
  if (runtime?.arknoteExecutable) {
    await shutdownElectronApplicationScope({
      application: arknoteTarget,
      executable: runtime.arknoteExecutable,
      requestClose: async (targetApplication) => await targetApplication.close(),
    }).catch((error: unknown) => shutdownErrors.push(error))
  }
  if (shutdownErrors.length > 0) {
    throw new AggregateError(shutdownErrors, 'Electron shutdown did not stabilize')
  }
  if (processQueryScript) await rm(processQueryScript, { force: true })
  if (workspace) await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  if (runtime?.root) await cleanupRuntime(runtime.root)
})

test('first card click raises an unpinned note directly above the Arkdown source window', async () => {
  arknote = await launchArknote()
  const mainPage = await launchArkdown()
  await expect(mainPage.locator('.sticky-note-box-toolbar-button')).toBeVisible({ timeout: 15_000 })
  await mainPage.locator('.sticky-note-box-toolbar-button').click()
  await expect(mainPage.locator('.sticky-note-grid')).toBeVisible({ timeout: 15_000 })

  const noteId = await mainPage.evaluate(async () => {
    const created = await window.arkdown.createStickyNote({
      name: 'Foreground First Click',
      markdown: '# Foreground First Click',
    })
    if (!created.ok) throw new Error(created.error.message)
    return created.value.record.id
  })
  const card = mainPage.getByRole('button', { name: 'Foreground First Click', exact: true })
  await expect(card).toBeVisible()

  await arknote.evaluate(({ BrowserWindow }) => {
    type Target = { webContents: { getURL(): string } }
    type Method = (this: Target, ...args: unknown[]) => unknown
    const prototype = BrowserWindow.prototype as unknown as {
      show: Method
      moveAbove: Method
      focus: Method
      moveTop: Method
      setAlwaysOnTop: Method
    }
    const originals = {
      show: prototype.show,
      moveAbove: prototype.moveAbove,
      focus: prototype.focus,
      moveTop: prototype.moveTop,
      setAlwaysOnTop: prototype.setAlwaysOnTop,
    }
    const calls: string[] = []
    ;(globalThis as typeof globalThis & { __arknoteForegroundCalls?: string[] })
      .__arknoteForegroundCalls = calls
    const isSticky = (window: Target) => {
      try {
        return new URL(window.webContents.getURL()).searchParams.get('surface') === 'sticky-note'
      } catch {
        return false
      }
    }
    prototype.show = function (this: Target, ...args: unknown[]) {
      if (isSticky(this)) calls.push('show')
      return originals.show.apply(this, args)
    }
    prototype.moveAbove = function (this: Target, ...args: unknown[]) {
      if (isSticky(this)) calls.push('moveAbove(' + String(args[0]) + ')')
      return originals.moveAbove.apply(this, args)
    }
    prototype.focus = function (this: Target, ...args: unknown[]) {
      if (isSticky(this)) calls.push('focus')
      return originals.focus.apply(this, args)
    }
    prototype.moveTop = function (this: Target, ...args: unknown[]) {
      if (isSticky(this)) calls.push('moveTop')
      return originals.moveTop.apply(this, args)
    }
    prototype.setAlwaysOnTop = function (this: Target, ...args: unknown[]) {
      if (isSticky(this)) calls.push('setAlwaysOnTop(' + String(args[0]) + ')')
      return originals.setAlwaysOnTop.apply(this, args)
    }
  })
  const sourceMediaId = await arkdown!.evaluate(({ BrowserWindow }, targetUrl) => {
    const window = BrowserWindow.getAllWindows()
      .find((candidate) => candidate.webContents.getURL() === targetUrl)
    if (!window) throw new Error('Arkdown source window was not found')
    return window.getMediaSourceId()
  }, mainPage.url())

  await card.click()
  await waitForSurface(arknote, 'sticky-note')
  await expect.poll(async () => await arknote!.evaluate(() => (
    (globalThis as typeof globalThis & { __arknoteForegroundCalls?: string[] })
      .__arknoteForegroundCalls ?? []
  ))).toEqual([
    'setAlwaysOnTop(true)', 'show', 'moveAbove(' + sourceMediaId + ')',
    'focus', 'moveTop', 'setAlwaysOnTop(false)',
  ])
  await expect.poll(async () => await arknote!.evaluate(({ BrowserWindow }, id) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => {
      try { return new URL(candidate.webContents.getURL()).searchParams.get('noteId') === id }
      catch { return false }
    })
    return window
      ? { focused: window.isFocused(), top: window.isAlwaysOnTop(), visible: window.isVisible() }
      : null
  }, noteId)).toEqual({ focused: true, top: false, visible: true })
})

test('Arkdown starts one Arknote service, receives sidebar updates, and reconnects after service exit', async () => {
  const mainPage = await launchArkdown()
  const arkdownUserData = path.normalize(await arkdown!.evaluate(({ app }) => app.getPath('userData')))
  expect(path.basename(arkdownUserData)).toBe('Arkdown')
  expect(arkdownUserData).not.toBe(path.join(runtime.portableData, 'arknote', 'electron-profile'))
  expect(arkdownUserData).not.toBe(runtime.userData)
  await expect.poll(() => readTrayState('arkdown'), { timeout: 15_000 }).toMatchObject({
    role: 'arkdown', active: 0, created: 0, destroyed: 0,
  })
  await expect(mainPage.locator('.sticky-note-box-toolbar-button')).toBeVisible({ timeout: 15_000 })
  await mainPage.locator('.sticky-note-box-toolbar-button').click()
  await expect(mainPage.locator('.sticky-note-box-panel')).toBeVisible({ timeout: 20_000 })

  await expect(mainPage.locator('.sticky-note-first-use-dialog')).toHaveCount(0)
  await expect(mainPage.locator('.sticky-note-grid')).toBeVisible({ timeout: 15_000 })

  await expect.poll(async () => mainPage.locator('.sticky-note-box-motion').evaluate((element) =>
    element.getBoundingClientRect().width
  )).toBeGreaterThan(300)

  const toolbarClose = await mainPage.evaluate(async () => {
    const shell = document.querySelector<HTMLElement>('.app-shell')!
    const motion = document.querySelector<HTMLElement>('.sticky-note-box-motion')!
    const editor = document.querySelector<HTMLElement>('.editor-host')!
    const toggle = document.querySelector<HTMLButtonElement>('.sticky-note-box-toolbar-button')!
    const startWidth = motion.getBoundingClientRect().width
    const editorStartWidth = editor.getBoundingClientRect().width
    toggle.click()
    const samples: number[] = []
    const startedAt = performance.now()
    while (performance.now() - startedAt < 420) {
      await new Promise<void>((resolve) => setTimeout(resolve, 16))
      samples.push(motion.getBoundingClientRect().width)
    }
    return {
      startWidth,
      editorStartWidth,
      finalWidth: motion.getBoundingClientRect().width,
      editorFinalWidth: editor.getBoundingClientRect().width,
      hasIntermediateWidth: samples.some((width) => width > 1 && width < startWidth - 1),
      openClassRemains: shell.classList.contains('sticky-note-box-open'),
    }
  })
  expect(toolbarClose.startWidth).toBeGreaterThan(300)
  expect(toolbarClose.hasIntermediateWidth).toBe(true)
  expect(toolbarClose.finalWidth).toBeLessThanOrEqual(1)
  expect(toolbarClose.editorFinalWidth).toBeGreaterThan(toolbarClose.editorStartWidth)
  expect(toolbarClose.openClassRemains).toBe(false)

  await mainPage.locator('.sticky-note-box-toolbar-button').click()
  await expect(mainPage.locator('.sticky-note-box-motion')).toHaveAttribute('data-open', 'true')
  await mainPage.locator('.sticky-note-box-header button').click()
  await expect(mainPage.locator('.sticky-note-box-motion')).toHaveAttribute('data-open', 'false')
  await expect.poll(async () => mainPage.locator('.sticky-note-box-motion').evaluate((element) =>
    element.getBoundingClientRect().width
  )).toBeLessThanOrEqual(1)

  await mainPage.locator('.sticky-note-box-toolbar-button').click()
  await expect(mainPage.locator('.sticky-note-box-motion')).toHaveAttribute('data-open', 'true')
  await expect(mainPage.locator('.sticky-note-grid')).toBeVisible({ timeout: 15_000 })
  await expect.poll(rootArknotePids, { timeout: 15_000 }).toHaveLength(1)
  const firstTrayState = await expect.poll(() => readTrayState('arknote'), { timeout: 15_000 })
    .toMatchObject({ role: 'arknote', active: 1, created: 1, destroyed: 0 })
    .then(() => readTrayState('arknote'))

  await execFile(runtime.arknoteExecutable, ['--open-box', '--disable-gpu'], {
    cwd: runtime.application,
    env: runtimeEnvironment(),
    timeout: 15_000,
    windowsHide: true,
  })
  await expect.poll(rootArknotePids, { timeout: 15_000 }).toHaveLength(1)
  await expect.poll(() => readTrayState('arknote'), { timeout: 15_000 }).toEqual(firstTrayState)
  await expect.poll(() => readTrayState('arkdown')).toMatchObject({ active: 0, created: 0, destroyed: 0 })

  await mainPage.locator('.sticky-note-create-card').click()
  const nameDialog = mainPage.locator('.sticky-note-name-dialog')
  await nameDialog.locator('input').fill('Task 11 同步便签')
  await nameDialog.locator('button').last().click()
  await expect(mainPage.getByRole('button', { name: 'Task 11 同步便签', exact: true }))
    .toBeVisible({ timeout: 15_000 })

  await quitService()
  await expect.poll(() => readTrayState('arknote'), { timeout: 15_000 }).toMatchObject({
    processId: firstTrayState.processId, active: 0, created: 1, destroyed: 1,
  })
  await expect(mainPage.locator('.sticky-note-box-motion')).toHaveAttribute('data-open', 'false', { timeout: 15_000 })
  await expect(mainPage.locator('body')).toContainText('Arknote 服务已断开')
  expect(mainPage.isClosed()).toBe(false)

  // The window has just completed a native DPI-scaled grid transition; dispatch through
  // the live button so this service-reconnect assertion does not depend on OS hit-test rounding.
  await mainPage.locator('.sticky-note-box-toolbar-button')
    .evaluate((button) => (button as HTMLButtonElement).click())
  await expect(mainPage.locator('.sticky-note-box-panel')).toBeVisible({ timeout: 20_000 })
  await expect(mainPage.getByRole('button', { name: 'Task 11 同步便签', exact: true }))
    .toBeVisible({ timeout: 15_000 })
  await expect.poll(rootArknotePids, { timeout: 15_000 }).toHaveLength(1)
  const reconnectedTrayState = await expect.poll(() => readTrayState('arknote'), { timeout: 15_000 })
    .toMatchObject({ role: 'arknote', active: 1, created: 1, destroyed: 0 })
    .then(() => readTrayState('arknote'))
  expect(reconnectedTrayState.processId).not.toBe(firstTrayState.processId)
  await expect.poll(() => readTrayState('arkdown')).toMatchObject({ active: 0, created: 0, destroyed: 0 })
})

test('direct Arknote and forwarded --new-note use only the Arknote profile', async () => {
  const application = await launchArknote()
  const boxPage = await waitForSurface(application, 'arknote-box')
  await expect.poll(() => readTrayState('arknote'), { timeout: 15_000 }).toMatchObject({
    role: 'arknote', active: 1, created: 1, destroyed: 0,
  })
  await expect(boxPage).toHaveTitle('Arknote')
  expect(await nativeWindowTitle(application, boxPage)).toBe('Arknote')
  expect(await application.evaluate(({ app }) => app.getName())).toBe('Arknote')
  expect(path.normalize(await application.evaluate(({ app }) => app.getPath('userData'))))
    .toBe(path.join(runtime.portableData, 'arknote', 'electron-profile'))
  expect(application.windows().some((page) => page.url().includes('surface=arkdown'))).toBe(false)
  await expect(boxPage.locator('.sticky-note-grid')).toBeVisible({ timeout: 15_000 })

  await execFile(runtime.arknoteExecutable, ['--open-settings', '--disable-gpu'], {
    cwd: runtime.application,
    env: runtimeEnvironment(),
    timeout: 15_000,
    windowsHide: true,
  })
  const settingsPage = await waitForSurface(application, 'arknote-settings')
  await expect(settingsPage).toHaveTitle('设置 — Arknote')
  const settingsSize = await nativeWindowSize(application, settingsPage)
  expect(Math.abs(settingsSize.width - 1180)).toBeLessThanOrEqual(1)
  expect(Math.abs(settingsSize.height - 780)).toBeLessThanOrEqual(1)
  expect(await nativeWindowTitle(application, settingsPage)).toBe('设置 — Arknote')
  await expect(settingsPage.locator('.preferences-shell')).toBeVisible()
  await expect(settingsPage.getByRole('navigation', { name: 'Arknote 设置目录' })).toBeVisible()
  for (const name of ['开机启动', '材质', '颜色']) {
    await expect(settingsPage.getByRole('link', { name })).toBeVisible()
  }

  const layout = await settingsPage.locator('.preferences-page-layout').evaluate((root) => {
    const toc = root.querySelector<HTMLElement>('.preferences-toc')!
    const settings = root.querySelector<HTMLElement>('.preferences-settings')!
    const tocRect = toc.getBoundingClientRect()
    const settingsRect = settings.getBoundingClientRect()
    return {
      innerWidth: window.innerWidth,
      tocRight: tocRect.right,
      settingsLeft: settingsRect.left,
    }
  })
  expect(layout.innerWidth).toBeGreaterThan(900)
  expect(layout.tocRight).toBeLessThan(layout.settingsLeft)

  const content = settingsPage.locator('.preferences-page-content')
  const initialContentHeight = await content.evaluate((element) => element.clientHeight)
  await content.evaluate((element, height) => {
    element.style.maxHeight = `${height - 40}px`
  }, initialContentHeight)
  await expect.poll(() => content.evaluate((element) => element.clientHeight))
    .toBeLessThan(initialContentHeight)
  const metrics = await content.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)
  await settingsPage.locator('a[href="#preferences-context-menu-heading"]').click()
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

  const servicePids = await rootArknotePids()
  expect(servicePids).toHaveLength(1)
  await closeNativeWindow(application, settingsPage)
  await expect.poll(rootArknotePids, { timeout: 15_000 }).toEqual(servicePids)


  await execFile(runtime.arknoteExecutable, ['--open-settings', '--disable-gpu'], {
    cwd: runtime.application,
    env: runtimeEnvironment(),
    timeout: 15_000,
    windowsHide: true,
  })
  const cancelSettingsPage = await waitForSurface(application, 'arknote-settings')
  await cancelSettingsPage.getByRole('button', { name: '取消' }).click()
  await expect.poll(() => cancelSettingsPage.isClosed(), { timeout: 15_000 }).toBe(true)
  await expect.poll(rootArknotePids, { timeout: 15_000 }).toEqual(servicePids)

  await execFile(runtime.arknoteExecutable, ['--open-settings', '--disable-gpu'], {
    cwd: runtime.application,
    env: runtimeEnvironment(),
    timeout: 15_000,
    windowsHide: true,
  })
  const saveSettingsPage = await waitForSurface(application, 'arknote-settings')
  const saveSettingsButton = saveSettingsPage.getByRole('button', { name: '保存' })
  await expect(saveSettingsButton).toBeEnabled({ timeout: 15_000 })
  await saveSettingsButton.click()
  await expect.poll(() => saveSettingsPage.isClosed(), { timeout: 15_000 }).toBe(true)
  await expect.poll(rootArknotePids, { timeout: 15_000 }).toEqual(servicePids)
  await execFile(runtime.arknoteExecutable, ['--new-note', '--disable-gpu'], {
    cwd: runtime.application,
    env: runtimeEnvironment(),
    timeout: 15_000,
    windowsHide: true,
  })
  const notePage = await waitForSurface(application, 'sticky-note')
  await expect(notePage).toHaveTitle(/.+ — Arknote$/u)
  await expect.poll(rootArknotePids, { timeout: 15_000 }).toEqual(servicePids)
  expect(await nativeWindowTitle(application, notePage)).toMatch(/.+ — Arknote$/u)
  const noteId = new URL(notePage.url()).searchParams.get('noteId')
  if (!noteId) throw new Error('Arknote --new-note did not expose a note id')
  const editor = notePage.locator('.sticky-note-editor .ProseMirror')
  await editor.click()
  await notePage.keyboard.press('Control+a')
  await notePage.keyboard.insertText(['# Task 11', '', 'forwarded-new-note-token'].join(String.fromCharCode(10)))
  await expect.poll(async () => {
    const result = await notePage.evaluate(async (id) => await window.arkdown.readStickyNote(id), noteId)
    return result.ok ? result.value.markdown : ''
  }, { timeout: 12_000 }).toContain('forwarded-new-note-token')

  await notePage.locator('.sticky-note-titlebar button').last().click()
  await expect.poll(() => notePage.isClosed(), { timeout: 15_000 }).toBe(true)
  await expect.poll(async () => {
    const result = await boxPage.evaluate(async (id) => await window.arkdown.readStickyNote(id), noteId)
    return result.ok ? result.value.record.released : true
  }, { timeout: 15_000 }).toBe(false)
  await quitControlledArknote(application)
})

test('restores a saved Arknote display and persists window X closure', async () => {
  const store = new StickyNoteStore({ root: path.join(runtime.portableData, 'arknote') })
  await store.initialize()
  const seeded = await store.create({
    name: 'Task 11 恢复便签',
    markdown: ['# Task 11', '', 'restored-display-token'].join(String.fromCharCode(10)),
  })
  await store.updateRecord(seeded.record.id, (record) => ({
    ...record,
    released: true,
    pinned: false,
  }))
  await store.writeOpenNoteIds([seeded.record.id])

  const application = await launchArknote()
  const restoredPage = await waitForSurface(application, 'sticky-note')
  const restoredBox = await waitForSurface(application, 'arknote-box')
  expect(new URL(restoredPage.url()).searchParams.get('noteId')).toBe(seeded.record.id)
  await expect(restoredPage).toHaveTitle(/.+ — Arknote$/u)
  expect(await nativeWindowTitle(application, restoredPage)).toMatch(/.+ — Arknote$/u)
  await expect(restoredPage.locator('.sticky-note-editor .ProseMirror'))
    .toContainText('restored-display-token')

  await restoredPage.locator('.sticky-note-titlebar button').last().click()
  await expect.poll(() => restoredPage.isClosed(), { timeout: 15_000 }).toBe(true)
  await expect.poll(async () => {
    const result = await restoredBox.evaluate(
      async (id) => await window.arkdown.readStickyNote(id),
      seeded.record.id,
    )
    return result.ok ? result.value.record.released : true
  }, { timeout: 15_000 }).toBe(false)
  await quitControlledArknote(application)

  const index = JSON.parse(await readFile(
    path.join(runtime.portableData, 'arknote', 'notes', 'index.json'),
    'utf8',
  )) as { openNoteIdsAtLastSession?: string[] }
  expect(index.openNoteIdsAtLastSession ?? []).not.toContain(seeded.record.id)
})

test('tray active notes reopen at saved positions across materials', async () => {
  const store = new StickyNoteStore({ root: path.join(runtime.portableData, 'arknote') })
  await store.initialize()
  const styles: StickyNoteStyleReference[] = [
    { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
    ...(['mica-light', 'warm-frosted-glass', 'clear-glass', 'flowing-glass'] as const)
      .map((materialPresetId) => ({ mode: 'material' as const, materialPresetId })),
  ]
  const notes = []
  for (const [index, style] of styles.entries()) {
    notes.push(await store.create({ name: `Tray test ${index}`, markdown: 'Tray reopen body', style }))
  }
  const application = await launchArknote()
  await waitForSurface(application, 'arknote-box')
  // Capture the real Electron menu on the next refresh; no product test hooks.
  await application.evaluate(({ Tray, BrowserWindow }) => {
    const original = Tray.prototype.setContextMenu
    Tray.prototype.setContextMenu = function (menu) {
      ;(globalThis as typeof globalThis & { __trayAccessMenu?: Menu }).__trayAccessMenu = menu ?? undefined
      return original.call(this, menu)
    }
    const focus = BrowserWindow.prototype.focus
    BrowserWindow.prototype.focus = function () {
      ;(globalThis as typeof globalThis & { __trayFocusedWindow?: number }).__trayFocusedWindow = this.id
      return focus.call(this)
    }
  })
  const client = await connectService()
  const snapshot = async () => await application.evaluate(() => (
    (globalThis as typeof globalThis & { __trayAccessMenu?: Menu }).__trayAccessMenu
      ?.items.find((item) => item.label === '活动中的便签')?.submenu?.items
      .filter((item) => item.label.startsWith('Tray test'))
      .map((item) => ({ label: item.label, displayed: Boolean(item.icon && typeof item.icon !== 'string' && !item.icon.isEmpty()) }))
    ?? []
  ))
  const clickNote = async (label: string) => await application.evaluate((_, name) => {
    const menu = (globalThis as typeof globalThis & { __trayAccessMenu?: Menu }).__trayAccessMenu
    const item = menu?.items.find((entry) => entry.label === '活动中的便签')?.submenu?.items
      .find((entry) => entry.label === name)
    if (!item) throw new Error(`Tray note menu missing: ${name}`)
    item.click(undefined, undefined, { triggeredByAccelerator: false })
  }, label)
  const findNoteWindow = async (id: string) => await application.evaluate(({ BrowserWindow }, noteId) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => (
      candidate.webContents.getURL().includes(`noteId=${noteId}`)
    ))
    if (!window || !window.isVisible()) return null
    return { id: window.id, bounds: window.getBounds() }
  }, id)
  try {
    await client.request('note.rename', { noteId: notes[0]!.record.id, name: 'Tray test renamed' }, (value) => value)
    await expect.poll(snapshot).toHaveLength(styles.length)
    expect((await snapshot()).every((item) => !item.displayed)).toBe(true)
    for (const [index, note] of notes.entries()) {
      const label = index === 0 ? 'Tray test renamed' : `Tray test ${index}`
      await clickNote(label)
      await expect.poll(() => findNoteWindow(note.record.id)).not.toBeNull()
      await expect.poll(async () => (await snapshot()).find((item) => item.label === label)?.displayed).toBe(true)
      if (index === 0) {
        const check = await application.evaluate(() => {
          const menu = (globalThis as typeof globalThis & { __trayAccessMenu?: Menu }).__trayAccessMenu
          const icon = menu?.items.find((item) => item.label === '活动中的便签')?.submenu?.items
            .find((item) => item.label === 'Tray test renamed')?.icon
          if (!icon || typeof icon === 'string') throw new Error('Tray check image is missing')
          const bytes = icon.toBitmap({ scaleFactor: 1.5 })
          let transparent = 0
          let red = 0
          for (let i = 0; i < bytes.length; i += 4) {
            if (bytes[i + 3] === 0) transparent++
            if (bytes[i + 3] === 255 && bytes[i + 2] === 198 && bytes[i + 1] === 40 && bytes[i] === 40) red++
          }
          return { size: icon.getSize(), transparent, red }
        })
        expect(check.size).toEqual({ width: 16, height: 16 })
        expect(check.transparent).toBeGreaterThan(100)
        expect(check.red).toBeGreaterThan(10)
      }
      const opened = (await findNoteWindow(note.record.id))!
      const saved = { x: 480, y: 240, width: 460, height: 350 }
      await application.evaluate(({ BrowserWindow }, { windowId, bounds }) => {
        BrowserWindow.fromId(windowId)!.setBounds(bounds)
        ;(globalThis as typeof globalThis & { __trayFocusedWindow?: number }).__trayFocusedWindow = undefined
      }, { windowId: opened.id, bounds: saved })
      await clickNote(label)
      await expect.poll(() => application.evaluate(() => (
        (globalThis as typeof globalThis & { __trayFocusedWindow?: number }).__trayFocusedWindow
      ))).toBe(opened.id)
      expect((await findNoteWindow(note.record.id))?.id).toBe(opened.id)
      const beforeClose = (await findNoteWindow(note.record.id))!.bounds
      await client.request('note.close', { noteId: note.record.id }, (value) => value)
      await expect.poll(async () => (await snapshot()).find((item) => item.label === label)?.displayed).toBe(false)
      const persisted = await client.request('note.read', { noteId: note.record.id }, (value) => value) as { record: { windowBounds: unknown; released: boolean } }
      expect(persisted.record.windowBounds).toEqual(beforeClose)
      expect(persisted.record.released).toBe(false)
      await clickNote(label)
      // Fractional Windows DPI can round the recreated frame's size. The tray
      // requirement is to restore its last position, without relocating it.
      await expect.poll(async () => {
        const bounds = (await findNoteWindow(note.record.id))?.bounds
        return bounds ? { x: bounds.x, y: bounds.y } : null
      }).toEqual({ x: beforeClose.x, y: beforeClose.y })
      await client.request('note.close', { noteId: note.record.id }, (value) => value)
    }
    await client.request('note.archive', { noteId: notes[0]!.record.id }, (value) => value)
    await expect.poll(snapshot).toHaveLength(styles.length - 1)
  } finally {
    client.close()
  }
  await quitControlledArknote(application)
})
