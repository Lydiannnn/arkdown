import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  cleanupRuntimeAfterExactShutdowns,
  createRuntimeInstance,
  runE2eStage,
  shutdownElectronApplication,
  shutdownElectronApplicationScope,
  type RuntimeInstance,
} from './support/runtime'
import { ScreenshotTranslationLoopbackServer } from './support/screenshot-translation-loopback'
import {
  parseLocalPaddleOcrEvidence,
  screenshotOcrFixture,
  validateStartedNativeSource,
  type WindowsOcrEvidence,
  type ScreenshotOcrFixtureKind,
} from './support/windows-screenshot-source'
import {
  chooseScreenshotSourceDisplay,
  createScreenshotEnvironmentEvidence,
  probeWindowsDisplayCapabilities,
  type ScreenshotEnvironmentEvidence,
  type WindowsDisplayCapabilities,
} from './support/windows-display-capabilities'
import { createWindowHitTestService } from '../../src/main/screenshot-translation/window-hit-test'
import { ArknotePipeClient } from '../../src/main/arknote/arknote-pipe-client'
import { arknotePipeName } from '../../src/shared/arknote-protocol'
import { SCREENSHOT_TRANSLATION_ACCELERATOR } from '../../src/shared/screenshot-translation'
import { SCREENSHOT_OCR_RESOURCE_URLS } from '../../src/shared/screenshot-ocr-manifest'

const execFileAsync = promisify(execFile)
const API_KEY = 'arkdown-screenshot-e2e-key'
const CONNECTION_NAME = 'E2E Screenshot Translation'
const MODEL_ID = 'e2e-screenshot-model'
const INVALID_CONNECTION_NAME = 'E2E Incomplete Screenshot Translation'
const INVALID_MODEL_ID = 'e2e-incomplete-screenshot-model'
const TARGET_MARKERS = ['ARKDOWN OCR TARGET', 'Screenshot translation source line'] as const
const ADJACENT_DECOY = 'ADJACENT-DECOY-SECRET-9917'
const SOURCE_PATH_MARKER = 'windows-screenshot-source.ps1'

interface NativeSourceMetadata {
  pid: number
  target: { hwnd: number; bounds: { x: number; y: number; width: number; height: number } }
  decoy: { hwnd: number; bounds: { x: number; y: number; width: number; height: number } }
  hotkeyOccupied: boolean
  perMonitorDpiAware: boolean
}

interface NativeSource {
  child: ChildProcess
  evidencePath: string
  metadata: NativeSourceMetadata
  signalPath: string
  windowHitTestDisplay?: {
    status: 'differently-scaled-secondary-exercised' | 'authoritative-unavailable-primary-fallback'
    scaleFactor: number
  }
}

interface TestScreenshotFixture {
  bounds: { x: number; y: number; width: number; height: number }
  windowId: number
}

interface ActiveTierObservation {
  activeTier: 'small' | 'medium'
}

let application: ElectronApplication | undefined
let mainPage: Page | undefined
let runtime: RuntimeInstance | undefined
let capabilities: WindowsDisplayCapabilities | undefined
let source: NativeSource | undefined
let fixtureWindow: TestScreenshotFixture | undefined
let loopbacks: ScreenshotTranslationLoopbackServer[] = []
let screenshotDiagnostics: string[] = []

test.describe.configure({ timeout: 900_000, mode: 'serial' })
test.use({ screenshot: 'off', trace: 'off' })

function powershellPath(): string {
  return path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
}

function exactOwnKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function exactNativeSource(value: unknown): value is NativeSourceMetadata {
  if (!exactOwnKeys(value, ['pid', 'target', 'decoy', 'perMonitorDpiAware', 'hotkeyOccupied'])) return false
  const record = value as Partial<NativeSourceMetadata>
  const validWindow = (window: unknown) => {
    if (!exactOwnKeys(window, ['hwnd', 'bounds'])) return false
    const candidate = window as { hwnd?: unknown; bounds?: Record<string, unknown> }
    const bounds = candidate.bounds
    return exactOwnKeys(bounds, ['x', 'y', 'width', 'height'])
      && Number.isSafeInteger(candidate.hwnd)
      && (candidate.hwnd as number) > 0
      && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key]))
      && Number(bounds.width) > 0
      && Number(bounds.height) > 0
  }
  return Number.isSafeInteger(record.pid)
    && (record.pid ?? 0) > 0
    && typeof record.hotkeyOccupied === 'boolean'
    && record.perMonitorDpiAware === true
    && validWindow(record.target)
    && validWindow(record.decoy)
}

async function readFirstLine(child: ChildProcess, timeoutMs = 10_000): Promise<string> {
  const stdout = child.stdout
  if (!stdout) throw new Error('Native screenshot fixture has no stdout')
  return await new Promise<string>((resolve, reject) => {
    let buffered = ''
    let settled = false
    let timer: NodeJS.Timeout
    const finish = (error: Error | undefined, value?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stdout.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve(value ?? '')
    }
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString()
      const newline = buffered.indexOf('\n')
      if (newline < 0) return
      finish(undefined, buffered.slice(0, newline).trim())
    }
    const onError = (error: Error) => finish(error)
    const onExit = (code: number | null) => finish(
      new Error(`Native screenshot fixture exited before readiness (${String(code)})`),
    )
    timer = setTimeout(
      () => finish(new Error('Native screenshot fixture did not become ready')),
      timeoutMs,
    )
    stdout.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

async function startNativeSource(
  preferNegativeDisplay = false,
  occupyShortcut = false,
  evidenceKind: 'region' | 'window' = 'window',
  preferDifferentlyScaledSecondary = false,
): Promise<NativeSource> {
  if (!runtime || !capabilities) throw new Error('Packaged runtime is not prepared')
  const windowHitTestDisplay = preferDifferentlyScaledSecondary
    ? chooseScreenshotSourceDisplay(capabilities.displays, 'differently-scaled-secondary')
    : undefined
  const primary = windowHitTestDisplay?.display
    ?? (preferNegativeDisplay
      ? capabilities.displays.find(({ bounds }) => bounds.x < 0 || bounds.y < 0)
      : undefined)
    ?? capabilities.displays.find(({ bounds }) => bounds.x === 0 && bounds.y === 0)
    ?? capabilities.displays[0]!
  const left = primary.workArea.x + Math.max(620, primary.workArea.width - 730)
  const top = primary.workArea.y + 90
  const signalPath = path.join(runtime.root, `close-source-${Date.now()}.signal`)
  const evidencePath = path.join(runtime.root, `ocr-evidence-${Date.now()}.png`)
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.resolve('tests/e2e/fixtures/windows-screenshot-source.ps1'),
    '-SignalPath',
    signalPath,
    '-Left',
    String(left),
    '-Top',
    String(top),
    '-ScaleFactor',
    String(primary.scaleFactor),
    '-OcrEvidencePath',
    evidencePath,
    '-OcrEvidenceKind',
    evidenceKind,
    ...(occupyShortcut ? ['-OccupyShortcut'] : []),
  ]
  const child = spawn(powershellPath(), args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  })
  const metadata = await validateStartedNativeSource({
    child,
    cleanup: async () => await stopStartingNativeSource(child, signalPath),
    readFirstLine: async () => await readFirstLine(child),
    validate: exactNativeSource,
  })
  return {
    child,
    evidencePath,
    metadata,
    signalPath,
    windowHitTestDisplay: windowHitTestDisplay && {
      status: windowHitTestDisplay.evidence,
      scaleFactor: windowHitTestDisplay.display.scaleFactor,
    },
  }
}

async function waitForNativeSourceExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true
  return await new Promise<boolean>((resolve) => {
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

async function forceStopNativeSource(child: ChildProcess, pid: number | undefined): Promise<void> {
  if (child.exitCode !== null) return
  if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) {
    child.kill()
    await waitForNativeSourceExit(child, 2_000)
    return
  }
  try {
    await execFileAsync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), [
      '/PID',
      String(pid),
      '/T',
      '/F',
    ], { windowsHide: true })
  } catch (error) {
    if (child.exitCode === null) throw error
  }
}

async function stopStartingNativeSource(child: ChildProcess, signalPath: string): Promise<void> {
  if (child.exitCode !== null) return
  await writeFile(signalPath, 'close', 'utf8').catch(() => undefined)
  if (await waitForNativeSourceExit(child, 10_000)) return
  await forceStopNativeSource(child, child.pid)
}

async function stopNativeSource(target: NativeSource | undefined): Promise<void> {
  if (!target || target.child.exitCode !== null) return
  await writeFile(target.signalPath, 'close', 'utf8')
  if (await waitForNativeSourceExit(target.child, 10_000)) return
  await forceStopNativeSource(target.child, target.metadata.pid)
}

async function startTestScreenshotFixture(kind: ScreenshotOcrFixtureKind): Promise<TestScreenshotFixture> {
  if (!application) throw new Error('Electron application is unavailable')
  const fixture = screenshotOcrFixture(kind)
  return await application.evaluate(async ({ BrowserWindow, screen }, input) => {
    const workArea = screen.getPrimaryDisplay().workArea
    const width = Math.min(input.width, Math.max(80, workArea.width - 40))
    const height = Math.min(input.height, Math.max(40, workArea.height - 40))
    const target = new BrowserWindow({
      backgroundColor: '#ffffff',
      frame: false,
      height,
      resizable: false,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
      width,
      x: workArea.x + Math.floor((workArea.width - width) / 2),
      y: workArea.y + Math.floor((workArea.height - height) / 2),
    })
    const fixtureStore = globalThis as typeof globalThis & {
      __arkdownScreenshotE2eFixtureWindows?: unknown[]
    }
    ;(fixtureStore.__arkdownScreenshotE2eFixtureWindows ??= []).push(target)
    await target.loadURL('about:blank')
    await target.webContents.executeJavaScript(`
      document.open();
      document.write(${JSON.stringify(input.html)});
      document.close();
      document.fonts.ready.then(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
    `)
    target.setAlwaysOnTop(true, 'screen-saver')
    target.showInactive()
    const bounds = target.getContentBounds()
    return { bounds, windowId: target.id }
  }, fixture)
}

async function closeTestScreenshotFixture(target: TestScreenshotFixture | undefined): Promise<void> {
  if (!application || !target) return
  await application.evaluate(({ BrowserWindow }, windowId) => {
    const candidate = BrowserWindow.fromId(windowId)
    if (candidate && !candidate.isDestroyed()) candidate.close()
    const fixtureStore = globalThis as typeof globalThis & {
      __arkdownScreenshotE2eFixtureWindows?: unknown[]
    }
    fixtureStore.__arkdownScreenshotE2eFixtureWindows = (
      fixtureStore.__arkdownScreenshotE2eFixtureWindows ?? []
    ).filter((entry) => (
      typeof entry !== 'object' || entry === null || (entry as { id?: unknown }).id !== windowId
    ))
  }, target.windowId)
  await expect.poll(async () => await application?.evaluate(
    ({ BrowserWindow }, windowId) => BrowserWindow.fromId(windowId) !== null,
    target.windowId,
  )).toBe(false)
}

async function surfaceWindow(surface: string, point?: { x: number; y: number }): Promise<{
  bounds: { x: number; y: number; width: number; height: number }
  page: Page
}> {
  if (!application) throw new Error('Electron application is unavailable')
  let resolved: { bounds: { x: number; y: number; width: number; height: number }; page: Page } | undefined
  await expect.poll(async () => {
    for (const candidate of application!.windows()) {
      if (!candidate.url().includes(`surface=${surface}`)) continue
      try {
        const bounds = await candidate.evaluate(() => ({
          x: window.screenX,
          y: window.screenY,
          width: window.outerWidth,
          height: window.outerHeight,
        }))
        if (!point || (point.x >= bounds.x && point.y >= bounds.y
          && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height)) {
          resolved = { bounds, page: candidate }
          return true
        }
      } catch { /* a surface may close while another candidate becomes ready */ }
    }
    return false
  }).toBe(true)
  if (!resolved) throw new Error(`Surface ${surface} has no matching native window`)
  return resolved
}

async function openScreenshotMenu(): Promise<void> {
  if (!mainPage) throw new Error('Main renderer is unavailable')
  await mainPage.getByTestId('app-titlebar').getByRole('button', { name: '工具', exact: true }).click()
  const command = mainPage.getByRole('menuitem', { name: /截图翻译/u })
  await expect(command).toBeVisible({ timeout: 5_000 })
  await command.click()
}

async function sendNativeShortcut(): Promise<void> {
  const { stdout } = await execFileAsync(powershellPath(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.resolve('tests/e2e/fixtures/windows-send-shortcut.ps1'),
  ], { encoding: 'utf8', windowsHide: true })
  if ((JSON.parse(stdout.trim()) as { ok?: unknown }).ok !== true) {
    throw new Error('Native screenshot shortcut did not report success')
  }
}

async function waitForScreenshotSelectionSurface(): Promise<void> {
  if (!application) throw new Error('Electron application is unavailable')
  await expect.poll(() => application!.windows().filter((window) => (
    window.url().includes('surface=screenshot-selection')
  )).length, {
    timeout: 15_000,
    message: `screenshot diagnostics: ${screenshotDiagnostics.join(',') || 'none'}`,
  }).toBeGreaterThan(0)
}

async function assertScreenshotSelectionCoversItsDisplay(testInfo: TestInfo): Promise<void> {
  if (!application) throw new Error('Electron application is unavailable')
  const evidence = await application.evaluate(({ BrowserWindow, screen }) => BrowserWindow.getAllWindows()
    .filter((window) => window.webContents.getURL().includes('surface=screenshot-selection'))
    .map((window) => {
      const contentBounds = window.getContentBounds()
      let displayId: string | null = null
      try { displayId = new URL(window.webContents.getURL()).searchParams.get('displayId') } catch { /* invalid routes fail below */ }
      const display = screen.getAllDisplays().find((candidate) => String(candidate.id) === displayId)
      const displayBounds = display?.bounds ?? null
      const workArea = display?.workArea ?? null
      return {
        displayId,
        contentBounds,
        displayBounds,
        displayWorkAreaDelta: displayBounds && workArea ? {
          left: workArea.x - displayBounds.x,
          top: workArea.y - displayBounds.y,
          right: displayBounds.x + displayBounds.width - (workArea.x + workArea.width),
          bottom: displayBounds.y + displayBounds.height - (workArea.y + workArea.height),
        } : null,
        contentWorkAreaDelta: workArea ? {
          left: workArea.x - contentBounds.x,
          top: workArea.y - contentBounds.y,
          right: contentBounds.x + contentBounds.width - (workArea.x + workArea.width),
          bottom: contentBounds.y + contentBounds.height - (workArea.y + workArea.height),
        } : null,
      }
    }))
  await testInfo.attach('screenshot-selection-overlay-bounds.json', {
    body: Buffer.from(JSON.stringify(evidence, null, 2), 'utf8'),
    contentType: 'application/json',
  })
  expect(evidence).not.toHaveLength(0)
  for (const overlay of evidence) {
    expect(overlay.displayId).not.toBeNull()
    expect(overlay.displayBounds).not.toBeNull()
    expect(overlay.displayWorkAreaDelta).not.toBeNull()
    expect(overlay.contentWorkAreaDelta).not.toBeNull()
    if (!overlay.displayBounds || !overlay.displayWorkAreaDelta || !overlay.contentWorkAreaDelta) continue
    expect(overlay.contentBounds).toEqual(overlay.displayBounds)
    expect(overlay.contentWorkAreaDelta).toEqual(overlay.displayWorkAreaDelta)
  }
}

async function attachPackagedOcrBoundaryEvidence(result: Page, testInfo: TestInfo): Promise<void> {
  const resources = await result.evaluate(async (urls) => {
    const probe = async (url: string): Promise<number> => {
      try {
        const response = await fetch(url, { cache: 'no-store' })
        await response.body?.cancel()
        return response.status
      } catch { return 0 }
    }
    return {
      smallDetection: await probe(urls.smallDetection),
      smallRecognition: await probe(urls.smallRecognition),
      ortModule: await probe(`${urls.ortPrefix}ort-wasm-simd-threaded.jsep.mjs`),
      ortWasm: await probe(`${urls.ortPrefix}ort-wasm-simd-threaded.jsep.wasm`),
      workerApi: typeof Worker === 'function',
      offscreenCanvasApi: typeof OffscreenCanvas === 'function',
      imageBitmapApi: typeof ImageBitmap === 'function' && typeof createImageBitmap === 'function',
    }
  }, SCREENSHOT_OCR_RESOURCE_URLS)
  const workers = result.workers().filter((worker) => worker.url().includes('screenshot-ocr-worker'))
  const directWorkerResult = workers[0]
    ? await result.evaluate(async (workerUrl) => {
        const width = 112
        const height = 56
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d')
        if (!context) return 'image-unavailable'
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, width, height)
        context.fillStyle = '#111111'
        context.font = 'bold 28px Arial'
        context.fillText('Codex', 8, 37)
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
        if (!blob) return 'image-unavailable'
        let bytes: ArrayBuffer
        try { bytes = await blob.arrayBuffer() } catch { return 'image-unavailable' }
        return await new Promise<string>((resolve) => {
          const worker = new Worker(workerUrl, { type: 'module', name: 'arkdown-screenshot-ocr-boundary-probe' })
          let diagnostic = 'NO_DIAGNOSTIC'
          const finish = (value: string) => { clearTimeout(timer); worker.terminate(); resolve(value) }
          const timer = setTimeout(() => finish('timeout'), 60_000)
          worker.onerror = () => finish('worker-error')
          worker.onmessageerror = () => finish('message-error')
          worker.onmessage = ({ data }) => {
            if (typeof data !== 'object' || data === null) return
            if ((data as { type?: unknown }).type === 'diagnostic') {
              const code = String((data as { code?: unknown }).code)
              if (/^[A-Z_]+$/u.test(code)) diagnostic = code
              return
            }
            if ((data as { type?: unknown }).type !== 'result') return
            const value = data as { ok?: unknown; code?: unknown }
            if (value.ok === true) finish('success')
            else if (value.ok === false && ['OCR_UNAVAILABLE', 'OCR_TIMEOUT', 'OCR_FAILED'].includes(String(value.code))) {
              finish(`${String(value.code)}:${diagnostic}`)
            } else finish('invalid-result')
          }
          worker.postMessage({
            type: 'recognize', requestId: 1,
            sessionId: '123e4567-e89b-42d3-a456-426614174000', generation: 1,
            image: { width, height, bytes }, tier: 'small',
          }, [bytes])
        })
      }, workers[0].url())
    : 'not-run'
  const body = JSON.stringify({
    resultWindow: 'ocr-failure-visible',
    mainSubmission: 'accepted-before-deadline',
    outerWorker: workers.length > 0 ? 'running' : 'missing',
    directWorkerResult,
    sdkAdapter: workers.length > 0 && Object.values(resources).every((value) => value === 200 || value === true)
      ? 'local-resources-ready'
      : 'not-reached',
    resourceStatus: {
      smallDetection: resources.smallDetection,
      smallRecognition: resources.smallRecognition,
      ortModule: resources.ortModule,
      ortWasm: resources.ortWasm,
    },
    platformApis: {
      worker: resources.workerApi,
      offscreenCanvas: resources.offscreenCanvasApi,
      imageBitmap: resources.imageBitmapApi,
    },
  }, null, 2)
  await writeFile(testInfo.outputPath('screenshot-ocr-boundary-evidence.json'), body, 'utf8')
  await testInfo.attach('screenshot-ocr-boundary-evidence.json', {
    body: Buffer.from(body, 'utf8'),
    contentType: 'application/json',
  })
}

async function assertDensePointerStability(
  selection: Awaited<ReturnType<typeof surfaceWindow>>,
  target: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const highlight = selection.page.locator('.screenshot-selection-highlight')
  const local = (x: number, y: number) => ({
    x: x - selection.bounds.x,
    y: y - selection.bounds.y,
  })
  const inset = Math.min(36, Math.max(8, target.width / 6))
  const y = target.y + target.height / 2
  const points = Array.from({ length: 24 }, (_, index) => local(
    target.x + inset + (target.width - inset * 2) * index / 23,
    y + Math.sin(index) * Math.min(12, target.height / 8),
  ))
  const expected = {
    x: target.x - selection.bounds.x,
    y: target.y - selection.bounds.y,
    width: target.width,
    height: target.height,
  }
  const observeHighlight = async () => await highlight.evaluate((element, expectedRect) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      geometryMatches: Math.max(
        Math.abs(rect.left - expectedRect.x),
        Math.abs(rect.top - expectedRect.y),
        Math.abs(rect.width - expectedRect.width),
        Math.abs(rect.height - expectedRect.height),
      ) <= 1.5,
      maskVisible: getComputedStyle(element, '::after').backgroundColor === 'rgba(0, 0, 0, 0.12)',
      visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0,
    }
  }, expected)
  for (const point of points) {
    await selection.page.mouse.move(point.x, point.y)
    await selection.page.waitForTimeout(16)
    await expect.poll(observeHighlight, { timeout: 750, intervals: [8, 16, 32] }).toEqual({
      geometryMatches: true,
      maskVisible: true,
      visible: true,
    })
  }
  await selection.page.waitForTimeout(250)
  expect(await observeHighlight()).toEqual({ geometryMatches: true, maskVisible: true, visible: true })
}

async function observeManagerActiveTier(
  expectedTier: 'small' | 'medium',
): Promise<ActiveTierObservation> {
  if (!mainPage) throw new Error('Main renderer is unavailable')
  const observation = await mainPage.evaluate(async () => {
    const getState = window.arkdown.getScreenshotOcrModelState
    if (!getState) return null
    const state = await getState()
    return state.ok ? { activeTier: state.value.state.activeTier } : null
  })
  expect(observation).toEqual({ activeTier: expectedTier })
  if (!observation) throw new Error('Screenshot OCR model state was unavailable')
  return observation
}

async function selectTargetRegion(
  kind: 'region' | 'window',
  targetBounds?: { x: number; y: number; width: number; height: number },
): Promise<Page> {
  const target = targetBounds ?? source?.metadata.target.bounds
  if (!target) throw new Error('Screenshot source bounds are unavailable')
  const center = { x: target.x + target.width / 2, y: target.y + target.height / 2 }
  const selection = await surfaceWindow('screenshot-selection', center)
  await expect(selection.page.getByRole('application', { name: '截图选择' })).toBeVisible()
  if (kind === 'region') {
    const horizontalInset = targetBounds ? 2 : 12
    const topInset = targetBounds ? 2 : 30
    const bottomInset = targetBounds ? 2 : 12
    const start = {
      x: target.x - selection.bounds.x + horizontalInset,
      y: target.y - selection.bounds.y + topInset,
    }
    const end = {
      x: target.x - selection.bounds.x + target.width - horizontalInset,
      y: target.y - selection.bounds.y + target.height - bottomInset,
    }
    await selection.page.mouse.move(start.x, start.y)
    await selection.page.mouse.down()
    await selection.page.mouse.move(end.x, end.y, { steps: 12 })
    try {
      await selection.page.mouse.up()
    } catch (error) {
      if (!selection.page.isClosed()) throw error
    }
    await closeTestScreenshotFixture(fixtureWindow)
    fixtureWindow = undefined
  } else {
    await assertDensePointerStability(selection, target)
    const local = { x: center.x - selection.bounds.x, y: center.y - selection.bounds.y }
    await selection.page.mouse.click(local.x, local.y)
  }
  const result = await surfaceWindow('screenshot-translation')
  await expect(result.page.getByRole('img', { name: '截图原文' })).toBeVisible({ timeout: 10_000 })
  return result.page
}

async function choosePreferencesOption(page: Page, label: string, option: string): Promise<void> {
  const trigger = page.getByRole('combobox', { name: label })
  await trigger.click()
  const choice = page.getByRole('listbox', { name: label }).getByRole('option', { name: option, exact: true })
  await expect(choice).toBeVisible()
  await choice.evaluate((element) => (element as HTMLElement).click())
  await expect(trigger).toContainText(option)
}

async function configureScreenshotModel(
  server: ScreenshotTranslationLoopbackServer,
  input: { connectionName?: string; modelId?: string } = {},
): Promise<void> {
  if (!mainPage) throw new Error('Main renderer is unavailable')
  const connectionName = input.connectionName ?? CONNECTION_NAME
  const modelId = input.modelId ?? MODEL_ID
  const titlebar = mainPage.getByTestId('app-titlebar')
  await titlebar.getByRole('button', { name: '文件', exact: true }).click()
  await mainPage.getByRole('menuitem', { name: /偏好设置/u }).click()
  await mainPage.locator('a[href="#preferences-large-model-heading"]').click()
  await mainPage.locator('.large-model-settings-section').getByRole('button', { name: '管理大模型' }).click()
  await mainPage.getByRole('button', { name: '添加大模型' }).click()
  const dialog = mainPage.getByRole('dialog', { name: '添加大模型' })
  await dialog.getByLabel('配置名称').fill(connectionName)
  await choosePreferencesOption(mainPage, '服务商', '其他')
  await choosePreferencesOption(mainPage, '接口协议', 'OpenAI 兼容')
  await dialog.getByLabel('Base URL').fill(`http://127.0.0.1:${server.port}/v1`)
  await dialog.getByLabel('模型 ID').fill(modelId)
  await dialog.getByLabel('API Key').fill(API_KEY)
  await dialog.getByRole('button', { name: '连接', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 15_000 })
  await choosePreferencesOption(mainPage, '截图翻译模型', connectionName)
  await mainPage.getByRole('button', { name: '返回', exact: true }).click()
  await mainPage.getByRole('button', { name: '取消', exact: true }).click()
}

async function selectScreenshotModel(connectionName: string): Promise<void> {
  if (!mainPage) throw new Error('Main renderer is unavailable')
  await mainPage.getByTestId('app-titlebar').getByRole('button', { name: '文件', exact: true }).click()
  await mainPage.getByRole('menuitem', { name: /偏好设置/u }).click()
  await mainPage.locator('a[href="#preferences-large-model-heading"]').click()
  await mainPage.locator('.large-model-settings-section').getByRole('button', { name: '管理大模型' }).click()
  await choosePreferencesOption(mainPage, '截图翻译模型', connectionName)
  await mainPage.getByRole('button', { name: '返回', exact: true }).click()
  await mainPage.getByRole('button', { name: '取消', exact: true }).click()
}

async function installScreenshotMediumModel(): Promise<void> {
  if (!mainPage) throw new Error('Main renderer is unavailable')
  await mainPage.getByTestId('app-titlebar').getByRole('button', { name: '文件', exact: true }).click()
  await mainPage.getByRole('menuitem', { name: /偏好设置/u }).click()
  await mainPage.locator('a[href="#preferences-screenshot-heading"]').click()
  await expect(mainPage.getByRole('heading', { name: '截图OCR识别', level: 2 })).toBeVisible()
  await mainPage.getByRole('button', { name: '下载并更新' }).click()
  await expect(mainPage.getByRole('button', { name: '正在下载' })).toHaveAttribute('aria-disabled', 'true')
  const progress = mainPage.getByRole('progressbar', { name: '下载进度' })
  await expect(progress).toBeVisible({ timeout: 30_000 })
  const bounded = await progress.evaluate((element) => {
    const value = Number(element.getAttribute('aria-valuenow'))
    return Number.isFinite(value) && value >= 0 && value <= 100
  })
  expect(bounded).toBe(true)
  await expect(mainPage.getByRole('button', { name: '已安装' })).toBeVisible({ timeout: 600_000 })
  await mainPage.getByRole('button', { name: '取消', exact: true }).click()
}

async function removeScreenshotMediumModel(): Promise<void> {
  if (!mainPage) throw new Error('Main renderer is unavailable')
  await mainPage.getByTestId('app-titlebar').getByRole('button', { name: '文件', exact: true }).click()
  await mainPage.getByRole('menuitem', { name: /偏好设置/u }).click()
  await mainPage.locator('a[href="#preferences-screenshot-heading"]').click()
  await mainPage.getByRole('button', { name: '已安装' }).click()
  const dialog = mainPage.getByRole('dialog', { name: '是否删除PP-OCRv6 Medium模型？' })
  await expect(dialog).toContainText('删除后将恢复使用PP-OCRv6轻度模型')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '是', exact: true }).click()
  await expect(mainPage.getByRole('button', { name: '下载并更新' })).toBeVisible({ timeout: 30_000 })
  await mainPage.getByRole('button', { name: '取消', exact: true }).click()
}

async function inspectExtractedText(
  result: Page,
  expectedMarkers: readonly string[],
  forbiddenMarkers: readonly string[] = [],
): Promise<WindowsOcrEvidence> {
  const toggle = result.locator('.screenshot-result-toolbar__extract')
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  const content = result.locator('.screenshot-text-sidebar__content p:not(.screenshot-text-sidebar__empty)')
  await expect(content.first()).toBeVisible({ timeout: 15_000 })
  const evidence = await content.evaluateAll((paragraphs, markers) => {
    const combined = paragraphs.map((paragraph) => paragraph.textContent ?? '').join('\n')
    return {
      blockCount: paragraphs.length,
      expectedPresent: markers.expected.every((marker) => combined.includes(marker)),
      forbiddenAbsent: markers.forbidden.every((marker) => !combined.includes(marker)),
      wordCount: combined.split(/\s+/u).filter(Boolean).length,
    }
  }, { expected: [...expectedMarkers], forbidden: [...forbiddenMarkers] })
  expect(evidence.expectedPresent).toBe(true)
  expect(evidence.forbiddenAbsent).toBe(true)
  expect(evidence.blockCount).toBeGreaterThan(0)
  expect(evidence.wordCount).toBeGreaterThan(0)
  return {
    language: 'mul',
    status: 'completed',
    blockCount: evidence.blockCount,
    wordCount: evidence.wordCount,
  }
}

async function assertNativeWindowHit(target: NativeSource): Promise<void> {
  if (!capabilities) throw new Error('Display capabilities unavailable')
  const scaleFactor = target.windowHitTestDisplay?.scaleFactor ?? capabilities.primaryRealScaleFactor
  const bounds = target.metadata.target.bounds
  const service = createWindowHitTestService({
    scriptPath: path.resolve('scripts/windows-window-hit-test.ps1'),
    timeoutMs: 5_000,
  })
  try {
    const hit = await service.hitTest({
      x: Math.round((bounds.x + bounds.width / 2) * scaleFactor),
      y: Math.round((bounds.y + bounds.height / 2) * scaleFactor),
    }, new Set())
    expect(hit?.processId).toBe(target.metadata.pid)
  } finally {
    service.dispose()
  }
}

async function assertCompleteTranslationIds(
  result: Page,
  server: ScreenshotTranslationLoopbackServer,
): Promise<WindowsOcrEvidence> {
  const requested = server.requestRecords().at(-1)
  if (!requested) throw new Error('No bounded screenshot translation request was recorded')
  const ocr = parseLocalPaddleOcrEvidence(requested, [], [ADJACENT_DECOY, SOURCE_PATH_MARKER])
  const requestedIds = requested.map(({ id }) => id).sort()
  expect(new Set(requestedIds).size).toBe(requestedIds.length)
  expect(requestedIds.every((id) => /^line-[1-9][0-9]*$/u.test(id))).toBe(true)
  await expect(result.locator('.screenshot-translated-block.is-measuring'))
    .toHaveCount(0, { timeout: 30_000 })
  const translated = result.locator(
    '.screenshot-translated-block:not(.is-measuring)[aria-hidden="false"]',
  )
  await expect(translated).toHaveCount(requestedIds.length)
  const visibleIds = await translated.evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return {
      id: element.getAttribute('data-block-id'),
      visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
        && rect.width > 0 && rect.height > 0,
    }
  }))
  expect(visibleIds.every(({ visible }) => visible)).toBe(true)
  expect(visibleIds.map(({ id }) => id).sort()).toEqual(requestedIds)
  for (const id of requestedIds) {
    await expect(result.locator(
      `.screenshot-translated-block:not(.is-measuring)[aria-hidden="false"][data-block-id="${id}"]`,
    )).toHaveCount(1)
  }
  await expect(result.getByRole('alert')).toHaveCount(0)
  return ocr
}

async function attachEvidence(
  testInfo: TestInfo,
  runtimeEvidence: Pick<ScreenshotEnvironmentEvidence, 'shortcut' | 'ocr'>,
): Promise<void> {
  if (!capabilities) throw new Error('Display capabilities unavailable')
  const evidence = createScreenshotEnvironmentEvidence(capabilities, runtimeEvidence)
  expect(evidence.primaryRealScaleFactor).toBe(1.5)
  await testInfo.attach('screenshot-translation-environment.json', {
    body: Buffer.from(JSON.stringify(evidence, null, 2), 'utf8'),
    contentType: 'application/json',
  })
}

async function closeScreenshotSurfaces(): Promise<void> {
  if (!application) return
  for (const page of application.windows()) {
    if (page.isClosed()) continue
    if (page.url().includes('surface=screenshot-selection')) {
      await page.keyboard.press('Escape').catch(() => undefined)
    } else if (page.url().includes('surface=screenshot-translation')) {
      await page.getByRole('button', { name: '关闭截图翻译窗口' }).click().catch(() => undefined)
    }
  }
  await expect.poll(() => application?.windows().filter((page) => (
    page.url().includes('surface=screenshot-selection')
      || page.url().includes('surface=screenshot-translation')
  )).length ?? 0, { timeout: 15_000 }).toBe(0)
}

async function assertNoScreenshotTemporaryData(): Promise<void> {
  if (!runtime) return
  const directory = path.join(runtime.application, 'temp', 'screenshot-translation')
  const countEntries = async (current: string): Promise<number> => {
    const entries = await readdir(current, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    let count = entries.length
    for (const entry of entries) {
      if (entry.isDirectory()) count += await countEntries(path.join(current, entry.name))
    }
    return count
  }
  const count = await countEntries(directory)
  expect(count).toBe(0)
}

async function shutdownRuntimeArknote(targetRuntime: RuntimeInstance): Promise<void> {
  await shutdownElectronApplication({
    executable: targetRuntime.arknoteExecutable,
    requestClose: async () => {
      const token = await readFile(
        path.join(targetRuntime.portableData, 'arknote', 'service-token'),
        'utf8',
      ).then((value) => value.trim()).catch(() => '')
      if (!/^[a-f0-9]{64}$/u.test(token)) return
      const client = new ArknotePipeClient({
        pipeName: arknotePipeName(targetRuntime.application),
        timeoutMs: 10_000,
        token,
      })
      try {
        await client.connect()
      } catch {
        client.close()
        return
      }
      try {
        await client.request('service.quit', {}, (value) => value === null ? null : undefined)
          .catch((error: unknown) => {
            if (error instanceof Error && error.message === 'Arknote connection closed') return null
            throw error
          })
      } finally {
        client.close()
      }
    },
  })
}

test.beforeEach(async ({}, testInfo) => {
  screenshotDiagnostics = []
  expect(testInfo.project.name).toBe('native-150')
  const shared = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!shared) throw new Error('Electron E2E shared runtime is not prepared')
  capabilities = await probeWindowsDisplayCapabilities()
  runtime = await createRuntimeInstance(shared, 'arkdown-screenshot-translation-e2e-')
  const userData = path.join(runtime.root, 'user-data')
  const processTemp = path.join(runtime.root, 'process-temp')
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(processTemp, { recursive: true }),
    mkdir(path.join(runtime.application, 'portable-data'), { recursive: true }),
  ])
  if (testInfo.title.includes('menu region capture')) {
    source = await startNativeSource(true, true, 'region')
    expect(source.metadata.hotkeyOccupied).toBe(true)
  }
  application = await electron.launch({
    executablePath: runtime.executable,
    cwd: runtime.application,
    timeout: 30_000,
    args: [`--user-data-dir=${userData}`],
    env: {
      ...process.env,
      APPDATA: runtime.root,
      LOCALAPPDATA: runtime.root,
      TEMP: processTemp,
      TMP: processTemp,
      TMPDIR: processTemp,
      ARKDOWN_E2E: '1',
    },
  })
  const diagnosticPattern = /Screenshot translation diagnostic\s+([A-Z_]+)/gu
  for (const stream of [application.process().stdout, application.process().stderr]) {
    stream?.setEncoding('utf8')
    stream?.on('data', (chunk: string) => {
      for (const match of chunk.matchAll(diagnosticPattern)) screenshotDiagnostics.push(match[1]!)
    })
  }
  mainPage = await application.firstWindow({ timeout: 15_000 })
  await expect(mainPage.locator('.app-titlebar')).toBeVisible({ timeout: 10_000 })
  await application.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().includes('surface='))
    const area = screen.getPrimaryDisplay().workArea
    window?.setBounds({ x: area.x + 12, y: area.y + 40, width: Math.min(580, area.width - 24), height: Math.min(760, area.height - 80) })
  })
  if (source?.metadata.hotkeyOccupied) {
    await stopNativeSource(source)
    source = await startNativeSource(true, false, 'region')
    expect(source.metadata.hotkeyOccupied).toBe(false)
  }
})

test.afterEach(async () => {
  const targetApplication = application
  const targetRuntime = runtime
  const targetSource = source
  const targetFixtureWindow = fixtureWindow
  const targetLoopbacks = [...loopbacks]
  let failure: unknown
  const attempt = async (operation: () => Promise<void>) => {
    try { await operation() } catch (error) { failure ??= error }
  }
  await attempt(closeScreenshotSurfaces)
  await attempt(async () => await closeTestScreenshotFixture(targetFixtureWindow))
  await attempt(assertNoScreenshotTemporaryData)
  await attempt(async () => await stopNativeSource(targetSource))
  for (const targetLoopback of targetLoopbacks) {
    await attempt(async () => await targetLoopback.close())
  }
  await attempt(async () => {
    if (!targetRuntime) return
    await cleanupRuntimeAfterExactShutdowns({
      root: targetRuntime.root,
      executables: [targetRuntime.executable, targetRuntime.arknoteExecutable],
      shutdownArkdown: async () => await shutdownElectronApplicationScope({
        application: targetApplication,
        executable: targetRuntime.executable,
        requestClose: async (target) => await target.close(),
      }),
      shutdownArknote: async () => await shutdownRuntimeArknote(targetRuntime),
      beforeCleanup: assertNoScreenshotTemporaryData,
    })
  })
  application = undefined
  mainPage = undefined
  runtime = undefined
  source = undefined
  fixtureWindow = undefined
  loopbacks = []
  capabilities = undefined
  screenshotDiagnostics = []
  if (failure) throw failure
})

test('menu region capture covers the taskbar and recognizes the small English fixture with local Small OCR', async ({}, testInfo) => {
  if (!source) throw new Error('Shortcut-occupying source fixture is unavailable')
  fixtureWindow = await startTestScreenshotFixture('english-small')
  await openScreenshotMenu()
  await waitForScreenshotSelectionSurface()
  await assertScreenshotSelectionCoversItsDisplay(testInfo)
  const result = await selectTargetRegion('region', fixtureWindow.bounds)
  await expect.poll(async () => await result.title()).toBe('Arkdown截图翻译')
  await expect.poll(async () => await application?.evaluate(({ BrowserWindow }) => (
    BrowserWindow.getAllWindows()
      .find((candidate) => candidate.webContents.getURL().includes('surface=screenshot-translation'))
      ?.getTitle()
  ))).toBe('Arkdown截图翻译')
  if (await result.getByRole('alert').textContent() === '文字识别未能完成') {
    await attachPackagedOcrBoundaryEvidence(result, testInfo)
  }
  await expect(result.getByRole('alert')).toContainText('尚未配置截图翻译使用的大模型', { timeout: 20_000 })
  const ocr = await inspectExtractedText(result, ['Codex'], [ADJACENT_DECOY])
  await result.locator('.screenshot-text-sidebar__content p').first().selectText()
  await result.getByRole('complementary', { name: '提取的文字' }).press('Shift+F10')
  const copy = result.getByRole('menuitem', { name: '复制' })
  await expect(copy).toBeEnabled()
  await copy.press('Enter')
  await expect.poll(async () => (
    await application?.evaluate(({ clipboard }) => clipboard.readText())
  )?.includes('Codex') === true).toBe(true)
  await attachEvidence(testInfo, {
    shortcut: 'occupied-menu-fallback',
    ocr,
  })
})

test('packaged selection keeps a dense highlight and verifies complete Small and Medium translation lifecycles', async ({}, testInfo) => {
  const validLoopback = new ScreenshotTranslationLoopbackServer({
    apiKey: API_KEY,
    allowedOcrTokens: [
      'ARKDOWN', 'SCREENSHOT', 'OCR', 'TARGET', '8172',
      'TRANSLATION', 'SOURCE', 'LINE', 'LOCAL', 'TEXT', 'ONLY',
      'CODEX', '中英混合',
    ],
    modelId: MODEL_ID,
    translations: [],
    translationPrefix: '',
    forbiddenMarkers: [ADJACENT_DECOY, SOURCE_PATH_MARKER, runtime?.root ?? ''],
    holdTranslationRequest: 2,
  })
  const invalidLoopback = new ScreenshotTranslationLoopbackServer({
    apiKey: API_KEY,
    allowedOcrTokens: [
      'ARKDOWN', 'SCREENSHOT', 'OCR', 'TARGET', '8172',
      'TRANSLATION', 'SOURCE', 'LINE', 'LOCAL', 'TEXT', 'ONLY',
      'CODEX', '中英混合',
    ],
    modelId: INVALID_MODEL_ID,
    translations: [{ id: 'line-1', text: 'incomplete-batch' }],
    forbiddenMarkers: [ADJACENT_DECOY, SOURCE_PATH_MARKER, runtime?.root ?? ''],
  })
  loopbacks.push(validLoopback, invalidLoopback)
  await validLoopback.start()
  await invalidLoopback.start()
  await configureScreenshotModel(validLoopback)
  source = await startNativeSource(false, false, 'window', true)
  await assertNativeWindowHit(source)
  expect(source.windowHitTestDisplay).toBeDefined()
  await testInfo.attach('screenshot-window-hit-test-display.json', {
    body: Buffer.from(JSON.stringify(source.windowHitTestDisplay, null, 2), 'utf8'),
    contentType: 'application/json',
  })
  expect(await application?.evaluate(
    ({ globalShortcut }, accelerator) => globalShortcut.isRegistered(accelerator),
    SCREENSHOT_TRANSLATION_ACCELERATOR,
  )).toBe(true)
  const observedSmallTier = await observeManagerActiveTier('small')
  await sendNativeShortcut()
  await waitForScreenshotSelectionSurface()
  await assertScreenshotSelectionCoversItsDisplay(testInfo)
  const result = await selectTargetRegion('window')
  await expect.poll(async () => {
    try { validLoopback.assertHealthy() } catch {
      return 'loopback-unhealthy'
    }
    if (await result.getByRole('button', { name: '显示原文', exact: true }).count()) return 'translated'
    const alert = result.getByRole('alert')
    return await alert.count() ? 'ui-failed' : 'pending'
  }, { timeout: 120_000 }).toBe('translated')
  const smallOcr = await assertCompleteTranslationIds(result, validLoopback)
  const extractedSmall = await inspectExtractedText(
    result,
    TARGET_MARKERS,
    [ADJACENT_DECOY, SOURCE_PATH_MARKER],
  )
  expect(extractedSmall.blockCount).toBe(smallOcr.blockCount)
  expect(smallOcr.blockCount).toBeGreaterThan(1)
  expect(validLoopback.translationRequestCount).toBe(1)
  expect(() => validLoopback.assertHealthy()).not.toThrow()

  await configureScreenshotModel(invalidLoopback, {
    connectionName: INVALID_CONNECTION_NAME,
    modelId: INVALID_MODEL_ID,
  })
  await result.getByRole('button', { name: '显示原文', exact: true }).click()
  await result.getByRole('button', { name: '显示译文', exact: true }).click()
  await expect(result.locator('.screenshot-translated-block')).toHaveCount(smallOcr.blockCount)
  expect(invalidLoopback.translationRequestCount).toBe(0)
  await result.getByRole('button', { name: '重新翻译', exact: true }).click()
  await expect(result.getByRole('alert')).toContainText('模型返回的译文不完整或格式不正确，请重新翻译', { timeout: 30_000 })
  await expect(result.getByRole('img', { name: '截图原文' })).toBeVisible()
  await expect(result.getByRole('button', { name: '显示译文', exact: true })).toBeEnabled()
  await expect(result.getByRole('button', { name: '重新翻译', exact: true })).toBeEnabled()
  await expect(result.locator('.screenshot-translated-block')).toHaveCount(0)
  await expect(result.locator('.screenshot-text-sidebar__content p:not(.screenshot-text-sidebar__empty)'))
    .toHaveCount(smallOcr.blockCount)
  expect(invalidLoopback.translationRequestCount).toBe(2)
  expect(() => invalidLoopback.assertHealthy()).not.toThrow()

  await selectScreenshotModel(CONNECTION_NAME)
  await result.getByRole('button', { name: '重新翻译', exact: true }).click()
  await validLoopback.waitForHeldRequest()
  await result.getByRole('button', { name: '翻译中…', exact: true }).click()
  await expect.poll(() => validLoopback.heldRequestClosed).toBe(true)
  expect(validLoopback.releaseLateBytes()).toBe(false)
  await expect(result.locator('.screenshot-translated-block')).toHaveCount(0)
  expect(() => validLoopback.assertHealthy()).not.toThrow()
  await closeScreenshotSurfaces()

  await installScreenshotMediumModel()
  fixtureWindow = await startTestScreenshotFixture('mixed-cjk-latin')
  const observedMediumTier = await observeManagerActiveTier('medium')
  await openScreenshotMenu()
  await waitForScreenshotSelectionSurface()
  const mediumResult = await selectTargetRegion('region', fixtureWindow.bounds)
  await expect(mediumResult.getByRole('button', { name: '显示原文', exact: true }))
    .toBeVisible({ timeout: 180_000 })
  const mediumOcr = await assertCompleteTranslationIds(mediumResult, validLoopback)
  const extractedMedium = await inspectExtractedText(
    mediumResult,
    ['Codex', '中英混合'],
    [ADJACENT_DECOY, SOURCE_PATH_MARKER],
  )
  expect(extractedMedium.blockCount).toBe(mediumOcr.blockCount)
  await closeScreenshotSurfaces()

  fixtureWindow = await startTestScreenshotFixture('cancellation')
  await openScreenshotMenu()
  await waitForScreenshotSelectionSurface()
  const cancellationResult = await selectTargetRegion('region', fixtureWindow.bounds)
  await expect(cancellationResult.getByRole('button', { name: '识别文字中…', exact: true }))
    .toBeDisabled({ timeout: 15_000 })
  await cancellationResult.getByRole('button', { name: '关闭截图翻译窗口' }).click()
  await expect.poll(() => application?.windows().filter((page) => (
    page.url().includes('surface=screenshot-translation')
  )).length ?? 0).toBe(0)
  await assertNoScreenshotTemporaryData()

  await removeScreenshotMediumModel()
  fixtureWindow = await startTestScreenshotFixture('english-small')
  const observedFallbackTier = await observeManagerActiveTier('small')
  await openScreenshotMenu()
  await waitForScreenshotSelectionSurface()
  const fallbackResult = await selectTargetRegion('region', fixtureWindow.bounds)
  await expect(fallbackResult.getByRole('button', { name: '显示原文', exact: true }))
    .toBeVisible({ timeout: 120_000 })
  const fallbackOcr = await assertCompleteTranslationIds(fallbackResult, validLoopback)
  await inspectExtractedText(fallbackResult, ['Codex'])
  expect(() => validLoopback.assertHealthy()).not.toThrow()
  await testInfo.attach('screenshot-ocr-tier-evidence.json', {
    body: Buffer.from(JSON.stringify({
      fallback: { blockCount: fallbackOcr.blockCount, observedTier: observedFallbackTier },
      medium: { blockCount: mediumOcr.blockCount, observedTier: observedMediumTier },
      small: { blockCount: smallOcr.blockCount, observedTier: observedSmallTier },
    }, null, 2), 'utf8'),
    contentType: 'application/json',
  })
  await attachEvidence(testInfo, {
    shortcut: 'registered-and-activated',
    ocr: mediumOcr,
  })
})

test('Ctrl+wheel up and down share the packaged editor zoom state', async () => {
  const page = mainPage
  if (!page) throw new Error('Main renderer is unavailable')
  const pane = page.locator('.editor-pane')
  await expect(pane).toBeVisible()
  await expect(pane).toHaveAttribute('data-editor-zoom-percent', '100')
  const bounds = await pane.boundingBox()
  if (!bounds) throw new Error('Editor pane has no mouseable bounds')
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.keyboard.down('Control')
  try {
    await page.mouse.wheel(0, -120)
    await expect(pane).toHaveAttribute('data-editor-zoom-percent', '110')
    await page.waitForTimeout(75)
    await page.mouse.wheel(0, 120)
    await expect(pane).toHaveAttribute('data-editor-zoom-percent', '100')
  } finally {
    await page.keyboard.up('Control')
  }
})
