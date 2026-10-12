import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { PublicError } from '../../shared/public-errors'

export interface RegistryThread {
  postMessage(message: object): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'exit', listener: (code: number) => void): unknown
}

/** PowerShell's process creation can block on Windows; keep it off the UI thread. */
export function createThreadedRegistryWorker(create: () => RegistryThread = () => new Worker(path.join(__dirname, 'registry-worker.js'))) {
  let current: { thread: RegistryThread; exited: Promise<void>; failed: boolean } | null = null
  let closing: Promise<void> | null = null
  let nextId = 0
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>()
  const fail = () => {
    for (const request of pending.values()) request.reject(new PublicError('OPERATION_FAILED'))
    pending.clear()
  }
  function ensureThread() {
    if (current) return current
    const thread = create()
    let complete!: () => void
    const state = { thread, failed: false, exited: new Promise<void>(resolve => { complete = resolve }) }
    current = state
    thread.on('message', (message) => {
      const result = message as { kind?: string; id?: number; ok?: boolean; value?: unknown; code?: string } | null
      if (!result || result.kind !== 'result' || typeof result.id !== 'number') return
      const request = pending.get(result.id)
      if (!request) return
      pending.delete(result.id)
      if (result.ok === true) request.resolve(result.value)
      else request.reject(new PublicError(result.code === 'SHELL_INTEGRATION_CONFLICT' ? 'SHELL_INTEGRATION_CONFLICT'
        : result.code === 'SHELL_INTEGRATION_UNSUPPORTED' ? 'SHELL_INTEGRATION_UNSUPPORTED'
        : result.code === 'INVALID_RESPONSE' ? 'INVALID_RESPONSE' : 'OPERATION_FAILED'))
    })
    thread.once('error', () => { state.failed = true; fail() })
    thread.once('exit', () => {
      if (current === state) { current = null; fail() }
      complete()
    })
    return state
  }
  return {
    async execute(payload: object): Promise<unknown> {
      if (closing) await closing
      const state = ensureThread()
      if (state.failed) throw new PublicError('OPERATION_FAILED')
      const id = ++nextId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        try { state.thread.postMessage({ kind: 'execute', id, payload }) }
        catch { pending.delete(id); reject(new PublicError('OPERATION_FAILED')) }
      })
    },
    close(): Promise<void> {
      if (closing) return closing
      if (!current) return Promise.resolve()
      const state = current
      closing = state.exited.finally(() => { closing = null })
      try { state.thread.postMessage({ kind: 'close' }) }
      catch { fail() }
      return closing
    },
  }
}
