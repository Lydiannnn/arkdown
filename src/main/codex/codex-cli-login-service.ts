import { execFile, spawn } from 'node:child_process'
import { version } from '../../../package.json'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import type { CodexCliLoginOutcome, CodexCliLoginStatus } from '../../shared/codex-cli-login'
import type { CodexCliSpawn, CodexCliSpawnedChild } from './codex-cli-connection-test'
import { CODEX_RESTRICTED_CONFIG } from './codex-cli-model-adapter'

export interface CodexCliLoginService {
  start(ownerId: string): Promise<CodexCliLoginOutcome>
  cancel(ownerId: string): Promise<void>
  dispose(): Promise<void>
}
export interface CodexCliLoginServiceOptions {
  resolveExecutable(): Promise<string | undefined>
  openExternal(url: string): Promise<unknown>
  spawn?: CodexCliSpawn
  timeoutMs?: number
  cleanupTimeoutMs?: number
  terminateProcessTree?(pid: number): Promise<void>
}

/** Pinned CLI 0.144.1 constructs this exact authorization endpoint. */
export function isOfficialCodexLoginUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 16_384 || /[\x00-\x20\x7f\\]/u.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'auth.openai.com'
      && url.pathname === '/oauth/authorize' && !url.username && !url.password && !url.port && !url.hash
      && url.href === value
  } catch { return false }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function defaultTerminate(pid: number): Promise<void> {
  return new Promise((resolve, reject) => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'],
    { windowsHide: true, timeout: 5_000, maxBuffer: 4096 }, error => error ? reject(error) : resolve()))
}

/** A login-only child owns OAuth. No credentials, URLs or protocol diagnostics are returned to the renderer. */
export function createCodexCliLoginService(options: CodexCliLoginServiceOptions): CodexCliLoginService {
  const spawnProcess: CodexCliSpawn = options.spawn ?? ((command, args, childOptions) => spawn(command, [...args], childOptions))
  const cleanupMs = options.cleanupTimeoutMs ?? 1_200
  let disposed = false
  let flight: { ownerId: string; cancel(): void; promise: Promise<CodexCliLoginOutcome> } | undefined
  const children = new Set<{ child: CodexCliSpawnedChild; closed: Promise<void>; hasClosed: boolean }>()
  const waitClosed = async (entry: { closed: Promise<void>; hasClosed: boolean }): Promise<boolean> => {
    if (entry.hasClosed) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([entry.closed, new Promise<void>(resolve => { timer = setTimeout(resolve, cleanupMs) })]) }
    finally { clearTimeout(timer) }
    return entry.hasClosed
  }
  const stop = async (entry: { child: CodexCliSpawnedChild; closed: Promise<void>; hasClosed: boolean }): Promise<void> => {
    try { entry.child.stdin.end() } catch { /* Continue with process cleanup. */ }
    if (!await waitClosed(entry)) {
      if (entry.child.pid) await (options.terminateProcessTree ?? defaultTerminate)(entry.child.pid).catch(() => undefined)
      if (!await waitClosed(entry)) throw new Error('Codex login process termination unconfirmed')
    }
    children.delete(entry)
  }
  const service: CodexCliLoginService = {
    start(ownerId) {
      if (disposed || !ownerId || (children.size > 0 && !flight)) return Promise.resolve({ status: 'failed' })
      if (flight) return flight.ownerId === ownerId ? flight.promise : Promise.resolve({ status: 'failed' })
      let finish!: (status: CodexCliLoginStatus) => void
      let cancelled = false
      let loginId: string | undefined
      let active: { child: CodexCliSpawnedChild; closed: Promise<void>; hasClosed: boolean } | undefined
      let done = false
      const outcome = new Promise<CodexCliLoginStatus>(resolve => {
        finish = status => { if (!done) { done = true; resolve(status) } }
      })
      const send = (value: unknown) => {
        if (!active || active.hasClosed) throw new Error('Login process unavailable')
        active.child.stdin.write(JSON.stringify(value) + '\n')
      }
      const cancel = () => {
        cancelled = true
        if (loginId && active && !active.hasClosed) {
          try { send({ id: 3, method: 'account/login/cancel', params: { loginId } }) } catch { /* Closing still cancels this dedicated process. */ }
        }
        finish('cancelled')
      }
      const promise = Promise.resolve().then(async () => {
        const timer = setTimeout(() => finish('timeout'), options.timeoutMs ?? 5 * 60_000)
        void (async () => {
          const executable = await options.resolveExecutable()
          if (done || cancelled || disposed) return
          if (!executable) { finish('not-found'); return }
          if (!path.win32.isAbsolute(executable) || path.win32.extname(executable).toLowerCase() !== '.exe') { finish('failed'); return }
          const config = Object.entries(CODEX_RESTRICTED_CONFIG).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])
          const child = spawnProcess(executable, [...config, 'app-server'], {
            windowsHide: true, windowsVerbatimArguments: false, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
          })
          let close!: () => void
          active = { child, hasClosed: false, closed: new Promise(resolve => { close = resolve }) }
          const entry = active
          children.add(entry)
          child.once('close', () => { entry.hasClosed = true; close(); if (!done) finish('failed') })
          child.once('error', () => { if (!child.pid) { entry.hasClosed = true; close() }; finish('failed') })
          child.stdin.on('error', () => finish('failed'))
          child.stdout.on('error', () => finish('failed'))
          child.stderr.on('error', () => finish('failed'))
          let bytes = 0, text = '', initialized = false, loginRequested = false
          let queue = Promise.resolve()
          const decoder = new TextDecoder('utf-8', { fatal: true })
          const packet = async (message: unknown) => {
            if (done) return
            if (!record(message)) { finish('failed'); return }
            if (message.id !== undefined && typeof message.method === 'string') {
              // This process cannot delegate tools, approvals, token refresh or arbitrary RPCs.
              send({ id: message.id, error: { code: -32601, message: 'Unsupported request' } }); return
            }
            if (message.id === 1) {
              if (initialized || !record(message.result) || message.error) { finish('failed'); return }
              initialized = true
              send({ method: 'initialized', params: {} })
              loginRequested = true
              send({ id: 2, method: 'account/login/start', params: { type: 'chatgpt' } })
            } else if (message.id === 2) {
              const result = message.result
              if (!loginRequested || loginId || message.error || !record(result) || result.type !== 'chatgpt'
                || typeof result.loginId !== 'string' || !result.loginId || result.loginId.length > 256
                || !isOfficialCodexLoginUrl(result.authUrl)) { finish('failed'); return }
              loginId = result.loginId
              await options.openExternal(result.authUrl)
            } else if (message.method === 'account/login/completed' && record(message.params)
              && loginId && message.params.loginId === loginId) {
              finish(message.params.success === true ? 'completed' : 'failed')
            }
          }
          child.stdout.on('data', (chunk: Buffer | string) => {
            if (done) return
            try {
              bytes += Buffer.byteLength(chunk)
              if (bytes > 1024 * 1024) { finish('failed'); return }
              text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
              let end: number
              while ((end = text.indexOf('\n')) >= 0) {
                const line = text.slice(0, end); text = text.slice(end + 1)
                if (line.length > 65_536) { finish('failed'); return }
                if (line.trim()) { const message: unknown = JSON.parse(line); queue = queue.then(() => packet(message)).catch(() => finish('failed')) }
              }
              if (text.length > 65_536) finish('failed')
            } catch { finish('failed') }
          })
          child.stderr.on('data', (chunk: Buffer | string) => { bytes += Buffer.byteLength(chunk); if (bytes > 1024 * 1024) finish('failed') })
          send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'arkdown', version }, capabilities: {} } })
        })().catch(() => finish('failed'))
        const status = await outcome
        clearTimeout(timer)
        try { if (active) await stop(active) } catch { return { status: 'failed' as const } }
        return { status }
      }).finally(() => { if (flight?.promise === promise) flight = undefined })
      flight = { ownerId, cancel, promise }
      return promise
    },
    async cancel(ownerId) { if (flight?.ownerId === ownerId) { const current = flight; current.cancel(); await current.promise } },
    async dispose() {
      disposed = true
      if (flight) { const current = flight; current.cancel(); await current.promise }
      await Promise.all([...children].map(stop))
    },
  }
  return service
}
