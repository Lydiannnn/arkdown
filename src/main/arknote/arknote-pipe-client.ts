import { PUBLIC_ERROR_MESSAGES, PublicError } from '../../shared/public-errors'
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import {
  ARKNOTE_PROTOCOL_VERSION,
  ArknoteFrameDecoder,
  encodeArknoteFrame,
  parseArknoteEventFrame,
  parseArknoteHelloResponse,
  parseArknoteResponse,
  type ArknoteCommand,
} from '../../shared/arknote-protocol'

interface PendingRequest<T = unknown> {
  parser(value: unknown): T | undefined
  resolve(value: T): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export interface ArknotePipeClientOptions {
  pipeName: string
  token: string
  timeoutMs?: number
  onDisconnect?(): void
}

export class ArknotePipeClient {
  private socket: net.Socket | null = null
  private decoder = new ArknoteFrameDecoder()
  private authenticated = false
  private connection: Promise<void> | null = null
  private connectResolve: (() => void) | null = null
  private connectReject: ((error: Error) => void) | null = null
  private connectTimer: NodeJS.Timeout | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<(event: unknown) => void>()
  private readonly timeoutMs: number

  constructor(private readonly options: ArknotePipeClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 5_000
  }

  connect(): Promise<void> {
    if (this.authenticated && this.socket && !this.socket.destroyed) return Promise.resolve()
    if (this.connection) return this.connection

    this.connection = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve
      this.connectReject = reject
      const socket = net.createConnection(this.options.pipeName)
      this.socket = socket
      this.decoder = new ArknoteFrameDecoder()
      this.connectTimer = setTimeout(() => {
        this.failConnection(new Error('Timed out connecting to Arknote'))
        socket.destroy()
      }, this.timeoutMs)
      socket.once('connect', () => {
        socket.write(encodeArknoteFrame({
          kind: 'hello',
          version: ARKNOTE_PROTOCOL_VERSION,
          token: this.options.token,
        }))
      })
      socket.on('data', (chunk) => {
        try {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          for (const message of this.decoder.push(bytes)) this.handle(message)
        } catch (error) {
          this.failConnection(error instanceof Error ? error : new Error('Invalid Arknote frame'))
          socket.destroy()
        }
      })
      socket.on('error', (error) => this.failConnection(error))
      socket.once('close', () => this.handleClose(socket))
    })
    return this.connection
  }

  async request<T>(
    command: ArknoteCommand,
    payload: unknown,
    parser: (value: unknown) => T | undefined,
  ): Promise<T> {
    await this.connect()
    const socket = this.socket
    if (!socket || socket.destroyed || !this.authenticated) {
      throw new Error('Arknote is not connected')
    }
    const requestId = randomUUID()
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`Arknote request timed out: ${command}`))
      }, this.timeoutMs)
      this.pending.set(requestId, { parser, resolve, reject, timer })
      socket.write(encodeArknoteFrame({
        kind: 'request',
        version: ARKNOTE_PROTOCOL_VERSION,
        requestId,
        command,
        payload,
      }))
    })
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    const socket = this.socket
    const error = new Error('Arknote connection closed')
    this.failConnection(error)
    this.socket = null
    this.authenticated = false
    this.connection = null
    if (socket && !socket.destroyed) socket.destroy()
  }

  private handle(message: unknown): void {
    if (!this.authenticated) {
      const hello = parseArknoteHelloResponse(message)
      if (!hello) {
        this.failConnection(new Error('Arknote returned an invalid handshake'))
        this.socket?.destroy()
        return
      }
      if (hello.kind === 'hello-rejected') {
        this.failConnection(new Error(hello.message))
        this.socket?.destroy()
        return
      }
      this.authenticated = true
      this.clearConnectTimer()
      const resolve = this.connectResolve
      this.connectResolve = null
      this.connectReject = null
      resolve?.()
      return
    }

    const response = parseArknoteResponse(message)
    if (response) {
      const pending = this.pending.get(response.requestId)
      if (!pending) return
      this.pending.delete(response.requestId)
      clearTimeout(pending.timer)
      if (!response.ok) {
        // Keep the existing wire format; restore only fixed, safe preference errors.
        const preferenceCode = (['SHELL_INTEGRATION_CONFLICT', 'SHELL_INTEGRATION_UNSUPPORTED', 'SHELL_INTEGRATION_ROLLBACK_INCOMPLETE', 'WALLPAPER_APPEARANCE_SAVED_NOT_APPLIED'] as const)
          .find((code) => PUBLIC_ERROR_MESSAGES[code] === response.error.message)
        pending.reject(preferenceCode ? new PublicError(preferenceCode) : new Error(response.error.message))
        return
      }
      const parsed = pending.parser(response.value)
      if (parsed === undefined) {
        pending.reject(new Error('Arknote response format is incompatible'))
        return
      }
      pending.resolve(parsed)
      return
    }

    const event = parseArknoteEventFrame(message)
    if (!event) return
    for (const listener of this.listeners) {
      try { listener(event.event) } catch { /* a listener cannot break transport */ }
    }
  }

  private failConnection(error: Error): void {
    const reject = this.connectReject
    this.connectReject = null
    this.connectResolve = null
    this.clearConnectTimer()
    if (reject) reject(error)
    this.rejectPending(error)
  }

  private handleClose(socket: net.Socket): void {
    if (this.socket !== socket) return
    const wasAuthenticated = this.authenticated
    this.socket = null
    this.authenticated = false
    this.connection = null
    this.failConnection(new Error('Arknote connection closed'))
    if (wasAuthenticated) this.options.onDisconnect?.()
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
