import { DEFAULT_LARGE_MODEL_SETTINGS, type LargeModelSettings } from '../../../src/shared/large-model-settings'
import { createArkdownApi, type ScreenshotTranslationEventTransport } from '../../../src/preload/arkdown-api'
import { createScreenshotOcrHostController } from '../../../src/renderer/screenshot/screenshot-ocr-host'
import { IPC_CHANNELS, type ApiResult } from '../../../src/shared/contracts'
import { parseModelFeaturePatch, parseObservedModelCommand } from '../../../src/shared/model-settings-commands'
import { modelObservation, modelCommit } from '../../helpers/model-observation'
import type {
  ScreenshotOcrHostCommand,
  ScreenshotTranslationGenerationInput,
} from '../../../src/shared/screenshot-translation'

interface CommandRecord {
  channel: string
  input: unknown
}

interface PendingStart {
  input: ScreenshotTranslationGenerationInput
  resolve(value: ApiResult<ScreenshotTranslationGenerationInput>): void
}

interface ScreenshotLayoutFixture {
  clearCommands(): void
  commands(): readonly CommandRecord[]
  createImage(): string
  createSmallImage(): string
  emit(payload: unknown): void
  emitOcrHost(command: ScreenshotOcrHostCommand): void
  ready: Promise<void>
  resolveNextStart(): boolean
  setStartDeferred(deferred: boolean): void
  workerStats(): { created: number; terminated: number }
}

declare global {
  interface Window {
    screenshotLayoutFixture: ScreenshotLayoutFixture
  }
}

let settings: LargeModelSettings = structuredClone(DEFAULT_LARGE_MODEL_SETTINGS)
let modelRevision = 1
if (location.search.includes('thinking')) {
  const id = '11111111-1111-4111-8111-111111111111'
  settings = { ...settings, connections: [{ id, name: 'Screenshot model', provider: 'deepseek', protocol: 'openai', accessType: 'standard-api',
    baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-v4-pro', status: 'connected', apiKeyHint: '••••test', lastTestedAt: null, capabilityOverride: null }],
    screenshotTranslation: { connectionId: id, thinkingMode: 'disabled', reasoningEffort: 'low', targetLanguage: 'en' } }
}
const records: CommandRecord[] = []
const pendingStarts: PendingStart[] = []
let listener: ((payload: unknown) => void) | undefined
let hostListener: ((payload: unknown) => void) | undefined
let deferStart = false
let workersCreated = 0
let workersTerminated = 0

const NativeWorker = window.Worker
const fakeWorkerUrl = new URL('./screenshot-ocr-fake-worker.ts', import.meta.url)
window.Worker = class ScreenshotOcrFixtureWorker extends NativeWorker {
  readonly #isScreenshotOcr: boolean
  constructor(url: URL | string, options?: WorkerOptions) {
    const resolved = new URL(String(url), window.location.href)
    const isScreenshotOcr = resolved.pathname.endsWith('/screenshot/screenshot-ocr-bootstrap-worker.ts')
    super(isScreenshotOcr ? fakeWorkerUrl : url, isScreenshotOcr ? { ...options, type: 'module' } : options)
    this.#isScreenshotOcr = isScreenshotOcr
    if (isScreenshotOcr) workersCreated += 1
  }
  override terminate(): void {
    if (this.#isScreenshotOcr) workersTerminated += 1
    super.terminate()
  }
} as typeof Worker

const resultTransport: ScreenshotTranslationEventTransport = {
  subscribe(next) {
    listener = next
    return () => {
      if (listener === next) listener = undefined
    }
  },
}

const hostTransport = {
  subscribe(next: (payload: unknown) => void) {
    hostListener = next
    return () => { if (hostListener === next) hostListener = undefined }
  },
}

const success = <T,>(value: T): ApiResult<T> => ({ ok: true, value })

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const input = args[0]
  records.push({ channel, input })
  if (channel === IPC_CHANNELS.getLargeModelSettings) return success(settings)
  if (channel === IPC_CHANNELS.getModelSettingsSnapshot) return success(modelObservation(settings, modelRevision))
  if (channel === IPC_CHANNELS.setScreenshotTranslationSettings) {
    const command = parseObservedModelCommand(input, value => parseModelFeaturePatch('screenshotTranslation', value))
    if (!command) throw new Error('Layout fixture requires an observed screenshot settings patch')
    settings = { ...settings, screenshotTranslation: { ...settings.screenshotTranslation, ...command.input } }
    return success(modelCommit(settings, ++modelRevision))
  }
  if (channel === IPC_CHANNELS.startScreenshotTranslation) {
    const generation = input as ScreenshotTranslationGenerationInput
    if (deferStart) {
      return await new Promise<ApiResult<ScreenshotTranslationGenerationInput>>((resolve) => {
        pendingStarts.push({ input: generation, resolve })
      })
    }
    return success({ sessionId: generation.sessionId, generation: generation.generation + 1 })
  }
  return success(null)
}

window.arkdown = createArkdownApi(
  invoke,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined, // screenshotCaptureEventTransport
  resultTransport,
  undefined,
  hostTransport,
)

const ocrHost = createScreenshotOcrHostController({
  subscribe: (next) => window.arkdown.onScreenshotOcrHostCommand!(next),
  subscribeModelState: (next) => window.arkdown.onScreenshotOcrModelState!(next),
  submit: (input) => window.arkdown.submitScreenshotOcr!(input),
  settle: (input) => window.arkdown.settleScreenshotOcr!(input),
})
ocrHost.start()

let readyResolve!: () => void
const ready = new Promise<void>((resolve) => { readyResolve = resolve })

window.screenshotLayoutFixture = Object.freeze({
  clearCommands() {
    records.length = 0
  },
  commands() {
    return records.map((record) => ({ ...record }))
  },
  createImage() {
    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 400
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D context unavailable')
    context.fillStyle = '#f4f0e8'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#1f2937'
    context.font = '32px Segoe UI, sans-serif'
    context.fillText('FIRST SOURCE LINE', 80, 106)
    context.font = '28px Segoe UI, sans-serif'
    context.fillText('Second source text for geometry', 400, 274)
    context.fillStyle = '#b91c1c'
    context.fillRect(12, 344, 34, 18)
    return canvas.toDataURL('image/png')
  },
  createSmallImage() {
    const canvas = document.createElement('canvas')
    canvas.width = 40
    canvas.height = 20
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D context unavailable')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, 40, 20)
    context.fillStyle = '#111111'
    context.font = '10px sans-serif'
    context.fillText('Codex 中', 1, 13)
    return canvas.toDataURL('image/png')
  },
  emit(payload: unknown) {
    if (!listener) throw new Error('Screenshot result event listener is not mounted')
    listener(payload)
  },
  emitOcrHost(command: ScreenshotOcrHostCommand) {
    hostListener?.(command)
  },
  ready,
  resolveNextStart() {
    const pending = pendingStarts.shift()
    if (!pending) return false
    pending.resolve(success({
      sessionId: pending.input.sessionId,
      generation: pending.input.generation + 1,
    }))
    return true
  },
  setStartDeferred(deferred: boolean) {
    deferStart = deferred
  },
  workerStats() {
    return { created: workersCreated, terminated: workersTerminated }
  },
})

void import('../../../src/renderer/main').then(() => readyResolve())
