import net from 'node:net'
import {
  ARKNOTE_PROTOCOL_VERSION,
  ArknoteFrameDecoder,
  encodeArknoteFrame,
  parseArknoteHello,
  parseArknoteRequest,
  type ArknoteCommand,
} from '../../shared/arknote-protocol'

export interface ArknotePipeServerOptions {
  pipeName: string
  token: string
  handleRequest(command: ArknoteCommand, payload: unknown): Promise<unknown>
}

interface ConnectedClient {
  socket: net.Socket
  authenticated: boolean
  decoder: ArknoteFrameDecoder
}

export class ArknotePipeServer {
  private server: net.Server | null = null
  private readonly clients = new Set<ConnectedClient>()

  constructor(private readonly options: ArknotePipeServerOptions) {}

  async start(): Promise<void> {
    if (this.server) return
    const server = net.createServer((socket) => this.accept(socket))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening)
        this.server = null
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        server.on('error', () => undefined)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.options.pipeName)
    })
  }

  broadcast(event: unknown): void {
    const frame = encodeArknoteFrame({
      kind: 'event',
      version: ARKNOTE_PROTOCOL_VERSION,
      event,
    })
    for (const client of this.clients) {
      if (client.authenticated && !client.socket.destroyed) client.socket.write(frame)
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    for (const client of this.clients) client.socket.destroy()
    this.clients.clear()
    if (!server) return
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }

  private accept(socket: net.Socket): void {
    const client: ConnectedClient = {
      socket,
      authenticated: false,
      decoder: new ArknoteFrameDecoder(),
    }
    this.clients.add(client)
    socket.on('data', (chunk) => {
      try {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        for (const message of client.decoder.push(bytes)) void this.handle(client, message)
      } catch {
        socket.destroy()
      }
    })
    socket.on('error', () => undefined)
    socket.once('close', () => this.clients.delete(client))
  }

  private async handle(client: ConnectedClient, message: unknown): Promise<void> {
    if (!client.authenticated) {
      const hello = parseArknoteHello(message)
      if (!hello || hello.token !== this.options.token) {
        client.socket.end(encodeArknoteFrame({
          kind: 'hello-rejected',
          version: ARKNOTE_PROTOCOL_VERSION,
          message: 'Arknote authentication failed',
        }))
        return
      }
      client.authenticated = true
      client.socket.write(encodeArknoteFrame({
        kind: 'hello-accepted',
        version: ARKNOTE_PROTOCOL_VERSION,
      }))
      return
    }

    const request = parseArknoteRequest(message)
    if (!request) {
      client.socket.destroy()
      return
    }
    try {
      const value = await this.options.handleRequest(request.command, request.payload)
      if (!client.socket.destroyed) client.socket.write(encodeArknoteFrame({
        kind: 'response',
        version: ARKNOTE_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        value,
      }))
    } catch (error) {
      if (!client.socket.destroyed) client.socket.write(encodeArknoteFrame({
        kind: 'response',
        version: ARKNOTE_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: false,
        error: {
          message: error instanceof Error && error.message
            ? error.message.slice(0, 500)
            : 'Arknote request failed',
        },
      }))
    }
  }
}
