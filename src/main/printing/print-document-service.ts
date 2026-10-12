import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  WebContentsPrintOptions,
} from 'electron'
import type { PrintDocumentInput, PrintSurfaceDocumentInput } from '../../shared/printing'
import { isPrintDocumentToken, parsePrintDocumentInput } from '../../shared/printing'

export const PRINT_DOCUMENT_SURFACE_TIMEOUT_MS = 30_000

type Listener = (...args: unknown[]) => void

interface EventTargetLike {
  on(event: string, listener: Listener): unknown
  once(event: string, listener: Listener): unknown
  removeListener(event: string, listener: Listener): unknown
}

export interface PrintOwnerWindowLike extends EventTargetLike {
  readonly webContents: {
    readonly id: number
    isDestroyed(): boolean
    once?(event: string, listener: Listener): unknown
    removeListener?(event: string, listener: Listener): unknown
  }
  isDestroyed(): boolean
}

export interface PrintWindowLike extends EventTargetLike {
  readonly webContents: EventTargetLike & {
    readonly id: number
    readonly mainFrame: unknown
    isDestroyed(): boolean
    print(
      options: WebContentsPrintOptions,
      callback: (success: boolean, failureReason: string) => void,
    ): void
    setWindowOpenHandler?(handler: () => { action: 'deny' }): void
  }
  destroy(): void
  isDestroyed(): boolean
  loadURL?(url: string): Promise<void>
  loadFile?(filePath: string, options: { query: Record<string, string> }): Promise<void>
}

export interface PrintSurfaceAccess {
  take(token: string): PrintSurfaceDocumentInput
  ready(token: string): void
}

interface DisposableRegistration {
  dispose(): void
}

export interface PrintDocumentServiceDependencies {
  preloadPath: string
  createWindow(options: BrowserWindowConstructorOptions): PrintWindowLike
  loadSurface(window: PrintWindowLike, token: string): Promise<void>
  registerSurface(window: PrintWindowLike, access: PrintSurfaceAccess): DisposableRegistration
  randomToken(): string
  timeoutMs?: number
  now?: () => number
}

interface Deferred {
  promise: Promise<void>
  resolve(): void
  reject(error: Error): void
}

interface PrintJob {
  token: string
  owner: PrintOwnerWindowLike
  surface: PrintWindowLike
  payload: PrintDocumentInput | null
  surfaceDeadlineEpochMs: number
  taken: boolean
  ready: boolean
  readySignal: Deferred
  abortSignal: Deferred
  registration: DisposableRegistration | null
  timeout: ReturnType<typeof setTimeout> | null
  finished: boolean
  cleaned: boolean
  listeners: Array<{ target: EventTargetLike; event: string; listener: Listener }>
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

export function buildPrintWindowOptions(
  preloadPath: string,
  owner: PrintOwnerWindowLike,
): BrowserWindowConstructorOptions {
  return {
    width: 900,
    height: 1_200,
    show: false,
    skipTaskbar: true,
    backgroundColor: '#ffffff',
    parent: owner as BrowserWindow,
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  }
}

export async function loadPrintDocumentSurface(
  window: PrintWindowLike,
  options: {
    token: string
    devServerUrl?: string
    rendererHtmlPath: string
  },
): Promise<void> {
  if (!isPrintDocumentToken(options.token)) throw new Error('Invalid print token')
  if (options.devServerUrl) {
    if (!window.loadURL) throw new Error('Print surface URL loading is unavailable')
    const url = new URL(options.devServerUrl)
    url.searchParams.set('surface', 'print')
    url.searchParams.set('token', options.token)
    await window.loadURL(url.toString())
    return
  }
  if (!window.loadFile) throw new Error('Print surface file loading is unavailable')
  await window.loadFile(options.rendererHtmlPath, {
    query: { surface: 'print', token: options.token },
  })
}

function printWebContents(window: PrintWindowLike): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      reject(new Error('Print surface was destroyed before printing'))
      return
    }
    try {
      window.webContents.print(
        { silent: false, printBackground: true },
        (success, failureReason) => {
          if (success || failureReason.trim().toLocaleLowerCase('en-US') === 'print job canceled') {
            resolve()
            return
          }
          reject(new Error(failureReason || 'Print job failed'))
        },
      )
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Print job failed'))
    }
  })
}

export class PrintDocumentService {
  private readonly jobs = new Map<string, PrintJob>()
  private readonly owners = new Map<object, PrintJob>()
  private readonly timeoutMs: number
  private readonly now: () => number

  constructor(private readonly dependencies: PrintDocumentServiceDependencies) {
    this.timeoutMs = dependencies.timeoutMs ?? PRINT_DOCUMENT_SURFACE_TIMEOUT_MS
    this.now = dependencies.now ?? Date.now
  }

  async print(owner: BrowserWindow, input: PrintDocumentInput): Promise<void>
  async print(owner: PrintOwnerWindowLike, input: PrintDocumentInput): Promise<void> {
    const payload = parsePrintDocumentInput(input)
    if (!payload) throw new Error('Invalid print document input')
    if (owner.isDestroyed() || owner.webContents.isDestroyed()) {
      throw new Error('Print owner is unavailable')
    }
    const ownerKey = owner.webContents as object
    if (this.owners.has(ownerKey)) throw new Error('A print job is already active for this window')

    const token = this.createToken()
    const surface = this.dependencies.createWindow(
      buildPrintWindowOptions(this.dependencies.preloadPath, owner),
    )
    const surfaceDeadlineEpochMs = this.now() + this.timeoutMs
    const job: PrintJob = {
      token,
      owner,
      surface,
      payload,
      surfaceDeadlineEpochMs,
      taken: false,
      ready: false,
      readySignal: deferred(),
      abortSignal: deferred(),
      registration: null,
      timeout: null,
      finished: false,
      cleaned: false,
      listeners: [],
    }
    this.jobs.set(token, job)
    this.owners.set(ownerKey, job)

    const access: PrintSurfaceAccess = {
      take: (candidate) => this.take(job, candidate),
      ready: (candidate) => this.ready(job, candidate),
    }
    try {
      job.registration = this.dependencies.registerSurface(surface, access)
      this.installLifecycle(job)
      job.timeout = setTimeout(() => {
        this.abort(job, new Error('Print surface timed out'))
      }, Math.max(0, surfaceDeadlineEpochMs - this.now()))

      const operation = (async () => {
        await this.dependencies.loadSurface(surface, token)
        await job.readySignal.promise
        if (job.timeout !== null) {
          clearTimeout(job.timeout)
          job.timeout = null
        }
        await printWebContents(surface)
      })()
      await Promise.race([operation, job.abortSignal.promise])
      job.finished = true
    } finally {
      job.finished = true
      this.cleanup(job)
    }
  }

  private createToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = this.dependencies.randomToken()
      if (isPrintDocumentToken(token) && !this.jobs.has(token)) return token
    }
    throw new Error('Unable to create a print token')
  }

  private take(job: PrintJob, token: string): PrintSurfaceDocumentInput {
    if (
      job.cleaned
      || this.jobs.get(token) !== job
      || token !== job.token
      || job.taken
      || !job.payload
    ) throw new Error('Print document token is unavailable')
    const payload = job.payload
    job.payload = null
    job.taken = true
    return { ...payload, surfaceDeadlineEpochMs: job.surfaceDeadlineEpochMs }
  }

  private ready(job: PrintJob, token: string): void {
    if (
      job.cleaned
      || this.jobs.get(token) !== job
      || token !== job.token
      || !job.taken
      || job.ready
    ) throw new Error('Print document token is unavailable')
    if (this.now() >= job.surfaceDeadlineEpochMs) {
      const error = new Error('Print surface timed out')
      this.abort(job, error)
      throw error
    }
    job.ready = true
    job.readySignal.resolve()
  }

  private installLifecycle(job: PrintJob): void {
    const listenOnce = (target: EventTargetLike, event: string, message: string) => {
      const listener = () => this.abort(job, new Error(message))
      target.once(event, listener)
      job.listeners.push({ target, event, listener })
    }
    listenOnce(job.owner, 'closed', 'Print owner was closed')
    listenOnce(job.surface, 'closed', 'Print surface was closed')
    listenOnce(job.surface.webContents, 'destroyed', 'Print surface was destroyed')
    listenOnce(job.surface.webContents, 'render-process-gone', 'Print renderer exited')
    if (job.owner.webContents.once && job.owner.webContents.removeListener) {
      listenOnce(job.owner.webContents as unknown as EventTargetLike, 'destroyed', 'Print owner was destroyed')
      listenOnce(
        job.owner.webContents as unknown as EventTargetLike,
        'render-process-gone',
        'Print owner renderer exited',
      )
    }
    const preventNavigation: Listener = (event) => {
      if (typeof event === 'object' && event !== null && 'preventDefault' in event) {
        const preventDefault = (event as { preventDefault?: unknown }).preventDefault
        if (typeof preventDefault === 'function') preventDefault.call(event)
      }
    }
    job.surface.webContents.on('will-navigate', preventNavigation)
    job.listeners.push({ target: job.surface.webContents, event: 'will-navigate', listener: preventNavigation })
    job.surface.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }))
  }

  private abort(job: PrintJob, error: Error): void {
    if (job.finished || job.cleaned) return
    job.abortSignal.reject(error)
  }

  private cleanup(job: PrintJob): void {
    if (job.cleaned) return
    job.cleaned = true
    job.payload = null
    this.jobs.delete(job.token)
    if (this.owners.get(job.owner.webContents as object) === job) {
      this.owners.delete(job.owner.webContents as object)
    }
    if (job.timeout !== null) clearTimeout(job.timeout)
    for (const { target, event, listener } of job.listeners) {
      target.removeListener(event, listener)
    }
    job.listeners.length = 0
    job.registration?.dispose()
    if (!job.surface.isDestroyed()) job.surface.destroy()
  }
}
