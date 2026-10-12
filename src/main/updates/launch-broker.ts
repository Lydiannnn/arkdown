import { createHash } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
const validPaths = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 128
  && value.every(p => typeof p === 'string' && p.length <= 32760 && path.win32.isAbsolute(p) && !/[\x00-\x1f]/.test(p))
/** Same installation/profile shares one main process, with independently owned document windows. */
export class ArkdownLaunchBroker {
  private readonly pipe: string
  private server?: net.Server
  private readonly sockets = new Set<net.Socket>()
  private readonly queue: string[][] = []
  private handler?: (paths: string[]) => Promise<boolean>
  private draining = false
  private handoffSealed = false
  constructor(identity: string, pipe?: string) { this.pipe = pipe ?? '\\\\.\\pipe\\arkdown-launch-' + createHash('sha256').update(identity).digest('hex') }
  async claim(paths: string[]): Promise<boolean> {
    if (!validPaths(paths)) throw new Error('Invalid document launch request')
    const server = net.createServer(socket => {
      this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket))
      socket.setTimeout(5000, () => socket.destroy()); socket.on('error', () => {})
      let buffer = ''; let received = false
      socket.setEncoding('utf8'); socket.on('data', chunk => {
        if (received) return
        buffer += chunk; if (buffer.length > 131072) { socket.destroy(); return }
        const newline = buffer.indexOf('\n'); if (newline < 0) return
        received = true
        try {
          const value = JSON.parse(buffer.slice(0, newline))
          if (this.handoffSealed || value?.protocol !== 1 || !validPaths(value.paths) || this.queue.length >= 128) throw new Error('Invalid launch')
          this.queue.push(value.paths); socket.end('{"accepted":true}\n'); this.resume()
        } catch { socket.end('{"accepted":false}\n') }
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => reject(error)
        server.once('error', fail); server.listen(this.pipe, () => { server.off('error', fail); resolve() })
      })
      server.on('error', () => {}); this.server = server; return true
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
    await this.forwardToRunning(paths)
    return false
  }
  /** Never acquire ownership while an external update helper holds the gate. */
  async forwardToRunning(paths: string[]): Promise<void> {
    if (!validPaths(paths)) throw new Error('Invalid document launch request')
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(this.pipe); let response = ''; let settled = false
      const finish = (error?: Error) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve() }
      socket.setTimeout(5000, () => finish(new Error('正在运行的 Arkdown 未响应，请稍后重试。')))
      socket.on('error', () => finish(new Error('无法连接正在运行的 Arkdown，请先正常关闭它后重试。')))
      socket.on('connect', () => socket.write(JSON.stringify({ protocol: 1, paths }) + '\n'))
      socket.setEncoding('utf8'); socket.on('data', chunk => {
        response += chunk
        if (response.length > 1024) { finish(new Error('Invalid launch response')); return }
        if (!response.includes('\n')) return
        try { finish(JSON.parse(response).accepted === true ? undefined : new Error('文档打开请求未被接纳。')) } catch { finish(new Error('Invalid launch response')) }
      })
      socket.on('end', () => { if (!settled) finish(new Error('Arkdown 在接收打开请求时退出，请重新打开文档。')) })
    })
  }
  setHandler(handler: (paths: string[]) => Promise<boolean>): void { this.handler = handler; this.resume() }
  resume(): void {
    if (this.draining || !this.handler) return
    this.draining = true
    void (async () => {
      try { while (this.queue.length) { if (!await this.handler!(this.queue[0])) break; this.queue.shift() } }
      finally { this.draining = false }
    })().catch(() => {}) // Failed launches remain queued; the caller owns error presentation.
  }
  get pendingDocuments(): string[] { return [...new Set(this.queue.flat())] }
  sealForUpdate(): string[] { this.handoffSealed = true; return this.pendingDocuments }
  cancelUpdateHandoff(): void { this.handoffSealed = false; this.resume() }
  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    return new Promise(resolve => { if (!this.server) resolve(); else this.server.close(() => resolve()) })
  }
}
