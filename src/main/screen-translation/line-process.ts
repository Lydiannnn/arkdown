import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/** Dedicated child, no shell, no stdout logging, bounded UTF-8 protocol. */
export class ScreenLineProcess {
  private child: ChildProcessWithoutNullStreams | undefined
  private starting: Promise<void> | undefined
  private stopped: Promise<void> = Promise.resolve()
  private listeners = new Set<(value: Record<string, unknown>) => void>()
  private exits = new Set<() => void>()
  private epoch = 0
  private stopping = false
  constructor(private readonly options: { executable: string; args?: string[]; env?: NodeJS.ProcessEnv;
    protocol: number; readyTimeoutMs?: number; lineLimit?: number }) {}
  onMessage(listener: (value: Record<string, unknown>) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  onExit(listener: () => void): () => void { this.exits.add(listener); return () => { this.exits.delete(listener) } }
  async start(): Promise<void> {
    if (this.stopping) await this.stopped
    if (this.starting) return this.starting
    const epoch = this.epoch
    await this.stopped
    if (epoch !== this.epoch) throw new Error('悬浮翻译窗组件启动已取消。')
    if (this.starting) return this.starting
    const operation = new Promise<void>((resolve, reject) => {
      let ready = false
      let text = ''
      const decoder = new StringDecoder('utf8')
      const child = spawn(this.options.executable, this.options.args ?? [], {
        shell: false, windowsHide: true, stdio: 'pipe', env: this.options.env ?? process.env,
      })
      this.child = child
      let didExit!: () => void
      this.stopped = new Promise<void>(done => { didExit = done })
      const fail = () => { if (!ready) reject(new Error('悬浮翻译窗组件启动失败，请检查完整程序包。')); child.kill() }
      const timer = setTimeout(fail, this.options.readyTimeoutMs ?? 60_000)
      child.stderr.on('data', () => { /* Drain diagnostic output; never persist arbitrary child text. */ })
      child.stdin.on('error', () => fail())
      child.once('error', fail)
      child.once('close', () => {
        clearTimeout(timer)
        if (!ready) reject(new Error('悬浮翻译窗组件未能启动。'))
        if (this.child === child) { this.child = undefined; this.starting = undefined; this.stopping = false }
        didExit()
        for (const listener of this.exits) listener()
      })
      child.stdout.on('data', (chunk: Buffer) => {
        text += decoder.write(chunk)
        if (text.length > (this.options.lineLimit ?? 2_000_000)) { fail(); return }
        let end: number
        while ((end = text.indexOf('\n')) >= 0) {
          const line = text.slice(0, end).trim(); text = text.slice(end + 1)
          let value: Record<string, unknown>
          try { value = JSON.parse(line.replace(/^\uFEFF/, '')) as Record<string, unknown> } catch { fail(); return }
          if (!value || typeof value !== 'object' || Array.isArray(value)) { fail(); return }
          if (!ready) {
            if ((value.ready === true || value.type === 'ready') && value.protocol === this.options.protocol) {
              ready = true; clearTimeout(timer); resolve()
            } else { fail(); return }
          } else for (const listener of this.listeners) listener(value)
        }
      })
    })
    this.starting = operation
    // Rejected starts are cleared after close, so a replacement cannot overlap the old process.
    return operation
  }
  send(value: unknown): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error('悬浮翻译窗组件已退出，请重新打开。')
    const line = JSON.stringify(value) + '\n'
    if (line.length > 32_000_000) throw new Error('选区过大，请缩小选区。')
    this.child.stdin.write(line, 'utf8')
  }
  async stop(graceful = false): Promise<void> {
    this.epoch += 1
    const child = this.child
    if (!child) { await this.stopped; return }
    this.stopping = true
    if (graceful) child.stdin.end()
    else child.kill()
    const timer = setTimeout(() => child.kill(), 10_000)
    await this.stopped
    clearTimeout(timer)
  }
}
