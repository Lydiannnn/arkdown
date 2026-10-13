import { execFile } from 'node:child_process'
import path from 'node:path'
import { compareUpdateVersions } from '../../shared/app-update'
import { RUNTIME_COMPONENT_DEFINITIONS } from '../../shared/optional-component-catalog'
import { discoverCodexCliExecutables } from './codex-cli-executable'

const isExecutable = (value: unknown): value is string => typeof value === 'string'
  && path.win32.isAbsolute(value) && path.win32.extname(value).toLowerCase() === '.exe'

/** Reuse external CLIs only at the managed component's version floor; account state is checked separately. */
export async function probeCodexExecutable(executable: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || !isExecutable(executable)) return false
  return new Promise(resolve => {
    execFile(executable, ['--version'], {
      shell: false, windowsHide: true, timeout: 2_000, maxBuffer: 4096, encoding: 'utf8', signal,
    }, (error, stdout) => {
      const version = /^codex-cli (\S+)$/u.exec(stdout.trim())?.[1]
      const order = version === undefined ? undefined
        : compareUpdateVersions(version, RUNTIME_COMPONENT_DEFINITIONS['codex-cli'].descriptor.version)
      resolve(!error && !signal.aborted && (order === 0 || order === 1))
    })
  })
}

interface CodexRuntimeSelectionOptions {
  resolveManaged(): Promise<string | undefined>
  installManaged(signal: AbortSignal): Promise<string | undefined>
  discoverCommands?(): Promise<readonly string[]>
  probeExternal?(executable: string, signal: AbortSignal): Promise<boolean>
}

/** User operations validate once; their health, login and model transports read one selected path. */
export function createCodexRuntimeSelection(options: CodexRuntimeSelectionOptions) {
  type Flight = { controller: AbortController; promise: Promise<string | undefined>; waiters: Set<symbol> }
  let selected: string | undefined
  let disposed = false
  let flight: Flight | undefined
  const pending = new Set<Promise<string | undefined>>()
  const prepare = async (signal: AbortSignal): Promise<string | undefined> => {
    if (signal.aborted) return undefined
    const managed = await options.resolveManaged()
    if (signal.aborted) return undefined
    if (isExecutable(managed)) return managed
    const candidates = await (options.discoverCommands ?? discoverCodexCliExecutables)().catch(() => [])
    if (signal.aborted) return undefined
    const seen = new Set<string>()
    for (const executable of candidates) {
      if (!isExecutable(executable) || seen.has(executable.toLowerCase())) continue
      seen.add(executable.toLowerCase())
      const valid = await (options.probeExternal ?? probeCodexExecutable)(executable, signal).catch(() => false)
      if (signal.aborted) return undefined
      if (valid) return executable
    }
    const installed = await options.installManaged(signal)
    return !signal.aborted && isExecutable(installed) ? installed : undefined
  }
  return {
    resolve: async (): Promise<string | undefined> => disposed ? undefined : selected,
    ensure(signal?: AbortSignal): Promise<string | undefined> {
      if (disposed || signal?.aborted) return Promise.resolve(undefined)
      let current = flight
      if (!current) {
        const controller = new AbortController()
        const entry: Flight = { controller, waiters: new Set(), promise: Promise.resolve(undefined) }
        const promise = Promise.resolve().then(() => prepare(controller.signal)).then(executable => {
          if (disposed || controller.signal.aborted || flight !== entry) return undefined
          selected = executable
          return executable
        }).finally(() => {
          pending.delete(promise)
          if (flight === entry) flight = undefined
        })
        entry.promise = promise
        pending.add(promise)
        flight = current = entry
      }
      const entry = current, waiter = Symbol('codex-runtime-caller')
      entry.waiters.add(waiter)
      return new Promise((resolve, reject) => {
        const detach = () => { entry.waiters.delete(waiter); signal?.removeEventListener('abort', abort) }
        const abort = () => {
          detach()
          if (entry.waiters.size === 0) {
            entry.controller.abort()
            if (flight === entry) flight = undefined
          }
          resolve(undefined)
        }
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
        void entry.promise.then(value => { detach(); resolve(signal?.aborted ? undefined : value) }, error => { detach(); reject(error) })
      })
    },
    async dispose() {
      disposed = true
      selected = undefined
      flight?.controller.abort()
      await Promise.allSettled(pending)
    },
  }
}
