import { ScreenLineProcess } from './line-process'

export class ScreenWorkerError extends Error {
  constructor(message: string, readonly needsSettings = false) { super(message) }
}
export class ScreenTranslationWorker {
  private tail: Promise<unknown> = Promise.resolve()
  private nextId = 0
  private disposed = false
  readonly process: ScreenLineProcess
  constructor(options: { executable: string; credentialsFile: string; timeoutMs?: number; args?: string[] }) {
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.process = new ScreenLineProcess({ executable: options.executable, args: options.args, protocol: 2,
      readyTimeoutMs: this.timeoutMs, env: { ...process.env, ARKDOWN_SCREEN_TRANSLATION_CREDENTIALS_FILE: options.credentialsFile } })
  }
  private readonly timeoutMs: number
  request(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const run = this.tail.then(async () => {
      if (signal?.aborted) { await this.process.stop(); signal.throwIfAborted() }
      if (this.disposed) throw new Error('悬浮翻译窗组件已关闭。')
      const abortStart = () => { void this.process.stop() }
      signal?.addEventListener('abort', abortStart, { once: true })
      try { await this.process.start() } finally { signal?.removeEventListener('abort', abortStart) }
      if (signal?.aborted) { await this.process.stop(); signal.throwIfAborted() }
      if (this.disposed) throw new Error('悬浮翻译窗组件已关闭。')
      const id = ++this.nextId
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        let done = false
        const cleanup = () => { off(); offExit(); clearTimeout(timer); signal?.removeEventListener('abort', abort) }
        const finish = (error?: Error, result?: Record<string, unknown>) => {
          if (done) return
          done = true; cleanup()
          if (error) reject(error); else resolve(result!)
        }
        const abort = () => {
          finish(new DOMException('Aborted', 'AbortError')); void this.process.stop()
        }
        const off = this.process.onMessage(value => {
          if (value.id !== id) { finish(new ScreenWorkerError('翻译组件响应不匹配，请重试。')); void this.process.stop(); return }
          if (value.ok === true && value.result && typeof value.result === 'object' && !Array.isArray(value.result)) {
            finish(undefined, value.result as Record<string, unknown>)
          } else {
            // The local engine deliberately emits sanitized errors. Still cap messages at this boundary.
            const message = typeof value.error === 'string' && value.error.length <= 240
              && !/https?:\/\/|Bearer\s|access_token|secret_key|api_key=/i.test(value.error)
              ? value.error : '悬浮翻译窗处理失败，请重试。'
            finish(new ScreenWorkerError(message, value.needs_settings === true))
          }
        })
        const offExit = this.process.onExit(() => finish(new ScreenWorkerError('翻译组件已退出，请重试。')))
        const timer = setTimeout(() => { finish(new ScreenWorkerError('悬浮翻译窗超时，请缩小选区后重试。')); void this.process.stop() }, this.timeoutMs)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) { abort(); return }
        try { this.process.send({ ...input, id }) } catch { finish(new ScreenWorkerError('无法连接翻译组件，请重试。')) }
      })
    })
    this.tail = run.catch(() => undefined)
    return run
  }
  async stop(): Promise<void> { await this.process.stop() }
  async dispose(): Promise<void> { this.disposed = true; await this.process.stop(true); await this.tail }
}
