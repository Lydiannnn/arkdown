import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { arknotePipeName, type ArknoteCommand } from '../../shared/arknote-protocol'
import { parseStickyNoteEvent, type StickyNoteEvent } from '../../shared/sticky-notes'
import { ArknotePipeClient } from './arknote-pipe-client'
import { arknotePaths } from './arknote-paths'
import { ARKNOTE_AUTOSTART_ARGUMENT } from '../sticky-notes/sticky-note-autostart'

export type Parser<T> = (value: unknown) => T | undefined

export type ArknoteServiceEvent =
  | StickyNoteEvent
  | { type: 'service-stopping' }
  | { type: 'service-disconnected' }

export interface ArknoteClientTransport {
  connect(): Promise<void>
  request<T>(command: ArknoteCommand, payload: unknown, parser: Parser<T>): Promise<T>
  subscribe(listener: (event: unknown) => void): () => void
  close(): void
}

interface ClientFactoryOptions {
  pipeName: string
  token: string
  timeoutMs: number
  onDisconnect(): void
}

export interface ArknoteLaunchedProcess {
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  once(event: 'error' | 'exit', listener: () => void): unknown
  removeListener(event: 'error' | 'exit', listener: () => void): unknown
}

export interface ArknoteClientRuntimeOptions {
  executablePath: string
  connectionTimeoutMs?: number
  retryDelayMs?: number
  now?: () => number
  access?: (filePath: string) => Promise<void>
  readToken?: (filePath: string) => Promise<string>
  launch?: (executablePath: string, args: readonly string[]) => ArknoteLaunchedProcess | void
  delay?: (milliseconds: number) => Promise<void>
  onConnected?: (client: ArknoteClientTransport) => Promise<void>
  createClient?: (options: ClientFactoryOptions) => ArknoteClientTransport
}

const TOKEN_PATTERN = /^[a-f0-9]{64}$/u
const LAUNCH_RETRY_MS = 500

function parseServiceEvent(value: unknown): ArknoteServiceEvent | undefined {
  if (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Reflect.ownKeys(value).length === 1
    && Object.prototype.hasOwnProperty.call(value, 'type')
    && (value as { type?: unknown }).type === 'service-stopping'
  ) return { type: 'service-stopping' }
  return parseStickyNoteEvent(value)
}

export class ArknoteClientRuntime {
  private readonly applicationDirectory: string
  private readonly arknoteExecutablePath: string
  private readonly tokenPath: string
  private readonly pipeName: string
  private readonly connectionTimeoutMs: number
  private readonly retryDelayMs: number
  private readonly now: () => number
  private readonly accessFile: (filePath: string) => Promise<void>
  private readonly readTokenFile: (filePath: string) => Promise<string>
  private readonly launchExecutable: NonNullable<ArknoteClientRuntimeOptions['launch']>
  private readonly delay: (milliseconds: number) => Promise<void>
  private readonly createClient: (options: ClientFactoryOptions) => ArknoteClientTransport
  private readonly listeners = new Set<(event: ArknoteServiceEvent) => void>()
  private client: ArknoteClientTransport | null = null
  private connectingClient: ArknoteClientTransport | null = null
  private unsubscribeTransport: (() => void) | null = null
  private starting: Promise<void> | null = null
  private launchedProcess: ArknoteLaunchedProcess | null = null
  private unsubscribeProcess: (() => void) | null = null
  private disposed = false
  private readonly onConnected?: ArknoteClientRuntimeOptions['onConnected']
  get isConnected(): boolean { return this.client !== null && !this.disposed }

  constructor(options: ArknoteClientRuntimeOptions) {
    this.onConnected = options.onConnected
    this.applicationDirectory = path.dirname(options.executablePath)
    this.arknoteExecutablePath = path.join(this.applicationDirectory, 'Arknote.exe')
    this.tokenPath = arknotePaths(this.applicationDirectory).token
    this.pipeName = arknotePipeName(this.applicationDirectory)
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? 5_000
    this.retryDelayMs = options.retryDelayMs ?? 50
    this.now = options.now ?? Date.now
    this.accessFile = options.access ?? access
    this.readTokenFile = options.readToken ?? ((filePath) => readFile(filePath, 'utf8'))
    this.launchExecutable = options.launch ?? ((executablePath, args) => {
      const child = spawn(executablePath, [...args], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.once('error', () => undefined)
      child.unref()
      return child
    })
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds)
    }))
    this.createClient = options.createClient ?? ((clientOptions) => new ArknotePipeClient({
      pipeName: clientOptions.pipeName,
      token: clientOptions.token,
      timeoutMs: clientOptions.timeoutMs,
      onDisconnect: clientOptions.onDisconnect,
    }))
  }

  ensureStarted(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Arknote client is disposed'))
    if (this.client) return Promise.resolve()
    if (!this.starting) {
      this.starting = this.start().finally(() => { this.starting = null })
    }
    return this.starting
  }
  /** Update preflight may attach to a running service but must never launch one. */
  async connectIfRunning(): Promise<boolean> {
    if (this.disposed) return false
    if (this.client) return true
    return this.tryConnect(this.now() + this.connectionTimeoutMs)
  }

  async openBox(): Promise<void> {
    await this.ensureStarted()
  }

  async request<T>(
    command: ArknoteCommand,
    payload: unknown,
    parser: Parser<T>,
  ): Promise<T> {
    await this.ensureStarted()
    if (!this.client) throw new Error('Arknote is not connected')
    return await this.client.request(command, payload, parser)
  }

  /** Passive reads/theme previews must never relaunch a stopped note service. */
  async requestIfConnected<T>(command: ArknoteCommand, payload: unknown, parser: Parser<T>): Promise<T | undefined> {
    const client = this.client
    if (this.disposed || !client) return undefined
    return await client.request(command, payload, parser)
  }

  subscribe(listener: (event: ArknoteServiceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.disposed = true
    this.releaseLaunchedProcess()
    const connecting = this.connectingClient
    this.connectingClient = null
    connecting?.close()
    this.disconnect(false)
    this.listeners.clear()
  }

  private async start(): Promise<void> {
    const deadline = this.now() + this.connectionTimeoutMs
    if (await this.tryConnect(deadline)) return
    this.throwIfDisposed()
    if (this.now() >= deadline) throw new Error('无法启动 Arknote')
    let lastLaunchAt = Number.NEGATIVE_INFINITY
    // Legacy injected launchers may not return a handle. Treat their attempt as
    // pending for this flight rather than guessing that a slow start has failed.
    let launchedWithoutHandle = false
    const launch = () => {
      if (this.launchedProcess || launchedWithoutHandle) return
      lastLaunchAt = this.now()
      try {
        const child = this.launchExecutable(this.arknoteExecutablePath, [ARKNOTE_AUTOSTART_ARGUMENT])
        if (child) this.trackLaunchedProcess(child)
        else launchedWithoutHandle = true
      } catch { /* A definite spawn failure can be retried within this deadline. */ }
    }
    if (!this.launchedProcess) {
      try {
        await this.withinDeadline(deadline, () => this.accessFile(this.arknoteExecutablePath))
      } catch {
        this.throwIfDisposed()
        throw new Error('无法启动 Arknote')
      }
      this.throwIfDisposed()
      if (this.now() >= deadline) throw new Error('无法启动 Arknote')
      launch()
    }

    while (this.now() < deadline) {
      this.throwIfDisposed()
      if (await this.tryConnect(deadline)) return
      this.throwIfDisposed()
      if (this.now() >= deadline) break
      if (this.now() - lastLaunchAt >= LAUNCH_RETRY_MS) {
        launch()
      }
      const remaining = deadline - this.now()
      if (remaining <= 0) break
      try {
        await this.withinDeadline(
          deadline,
          () => this.delay(Math.min(this.retryDelayMs, remaining)),
        )
      } catch {
        break
      }
    }
    this.throwIfDisposed()
    throw new Error('无法启动 Arknote')
  }

  private trackLaunchedProcess(child: ArknoteLaunchedProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return
    this.launchedProcess = child
    const ended = () => {
      if (this.launchedProcess === child) this.releaseLaunchedProcess()
    }
    this.unsubscribeProcess = () => {
      child.removeListener('error', ended)
      child.removeListener('exit', ended)
    }
    child.once('error', ended)
    child.once('exit', ended)
  }

  private releaseLaunchedProcess(): void {
    this.unsubscribeProcess?.()
    this.unsubscribeProcess = null
    this.launchedProcess = null
  }

  private throwIfDisposed(): void {
    if (this.disposed) throw new Error('Arknote client is disposed')
  }

  private async withinDeadline<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
    const remaining = deadline - this.now()
    if (remaining <= 0) throw new Error('无法启动 Arknote')
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('无法启动 Arknote')), remaining)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async tryConnect(deadline: number): Promise<boolean> {
    let token: string
    try {
      token = (await this.withinDeadline(
        deadline,
        () => this.readTokenFile(this.tokenPath),
      )).trim()
      if (!TOKEN_PATTERN.test(token)) return false
    } catch {
      return false
    }

    this.throwIfDisposed()
    const timeoutMs = deadline - this.now()
    if (timeoutMs <= 0) return false
    let candidate!: ArknoteClientTransport
    candidate = this.createClient({
      pipeName: this.pipeName,
      token,
      timeoutMs,
      onDisconnect: () => {
        if (this.client !== candidate) return
        this.disconnect(true)
      },
    })
    this.connectingClient = candidate
    try {
      await this.withinDeadline(deadline, () => candidate.connect())
    } catch {
      if (this.connectingClient === candidate) candidate.close()
      return false
    } finally {
      if (this.connectingClient === candidate) this.connectingClient = null
    }
    if (this.disposed) {
      candidate.close()
      return false
    }
    this.client = candidate
    this.unsubscribeTransport = candidate.subscribe((value) => {
      const event = parseServiceEvent(value)
      if (!event) return
      if (event.type === 'service-stopping') {
        if (this.client !== candidate) return
        this.disconnect(false)
      }
      for (const listener of this.listeners) listener(event)
    })
    try { await this.onConnected?.(candidate) } catch { /* A theme sync failure does not disable the note service. */ }
    // A stopping/disconnected transport is not a successful startup. Do not
    // relaunch it or replay callers queued behind this connection flight.
    this.throwIfDisposed()
    if (this.client !== candidate) throw new Error('Arknote connection closed')
    return true
  }

  private disconnect(notify: boolean): void {
    const client = this.client
    if (!client) return
    this.client = null
    this.unsubscribeTransport?.()
    this.unsubscribeTransport = null
    client.close()
    if (!notify) return
    for (const listener of this.listeners) listener({ type: 'service-disconnected' })
  }
}

export interface ArknoteAppLifecycle {
  once(event: 'will-quit', listener: () => void): void
}

export function registerArknoteClientShutdown(
  appLifecycle: ArknoteAppLifecycle,
  client: Pick<ArknoteClientRuntime, 'dispose'>,
): void {
  appLifecycle.once('will-quit', () => client.dispose())
}
