import { discoverCodexCliExecutables } from './codex-cli-executable'
import { version } from '../../../package.json'
import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { TextDecoder } from 'node:util'
import type { CodexCliConnectionStatus } from '../../shared/large-model-settings'
import { parseCodexCliModelSummary, type CodexCliModelSummary } from '../../shared/large-model-settings'

const VERSION_OUTPUT_LIMIT_BYTES = 4 * 1024
const VERSION_VALUE_LIMIT_CHARACTERS = 512
const APP_SERVER_STREAM_LIMIT_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000
// Newer app-server builds can take several seconds to drain after a successful model list.
const DEFAULT_SUCCESS_CLEANUP_TIMEOUT_MS = 10_000
const DEFAULT_DISCOVERY_TIMEOUT_MS = 2_000
const DEFAULT_TERMINATION_TIMEOUT_MS = 2_000

export interface CodexCliLaunchSpec {
  command: string
  prefixArgs: readonly string[]
}

export interface CodexCliProbeResult {
  status: CodexCliConnectionStatus
  cliVersion?: string
  models?: CodexCliModelSummary[]
}

export interface CodexCliConnectionTester {
  test(): Promise<CodexCliProbeResult>
  dispose(): Promise<void>
}

export interface CodexCliSpawnOptions {
  windowsHide: true
  windowsVerbatimArguments: boolean
  shell: false
  stdio: ['pipe', 'pipe', 'pipe']
}

export interface CodexCliSpawnedChild {
  readonly pid?: number
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  once(event: 'error', listener: (error: Error) => void): this
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this
  removeListener(event: 'error', listener: (error: Error) => void): this
  removeListener(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this
  kill(signal?: NodeJS.Signals | number): boolean
}

export type CodexCliSpawn = (
  command: string,
  args: readonly string[],
  options: CodexCliSpawnOptions,
) => CodexCliSpawnedChild

export type CodexCliTerminateProcessTree = (pid: number) => Promise<void>

export interface CodexCliConnectionTesterOptions {
  resolveExecutable?: () => Promise<string | undefined>
  discoverCommands?: () => Promise<readonly string[]>
  spawn?: CodexCliSpawn
  comSpec?: string
  timeoutMs?: number
  cleanupTimeoutMs?: number
  discoveryTimeoutMs?: number
  terminationTimeoutMs?: number
  terminateProcessTree?: CodexCliTerminateProcessTree
}

type VersionResult =
  | { status: 'connected'; cliVersion: string }
  | { status: 'launch-failed' | 'timeout' }

class DiscoveryTimeoutError extends Error {}

function defaultDiscoverCommands(timeoutMs: number): Promise<readonly string[]> {
  return discoverCodexCliExecutables(timeoutMs)
}

function defaultTerminateProcessTree(
  pid: number,
  timeoutMs: number,
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve()
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGTERM')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return Promise.reject(error)
    }
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      maxBuffer: VERSION_OUTPUT_LIMIT_BYTES,
      timeout: timeoutMs,
      windowsHide: true,
    }, (error) => error ? reject(error) : resolve())
  })
}

function launchSpecFor(
  candidates: readonly string[],
  comSpec: string,
): CodexCliLaunchSpec | undefined {
  const absoluteCandidates = candidates
    .map((candidate) => candidate.trim())
    .filter((candidate) => path.win32.isAbsolute(candidate))
  const executable = absoluteCandidates.find(
    (candidate) => path.win32.extname(candidate).toLocaleLowerCase('en-US') === '.exe',
  )
  if (executable) return { command: executable, prefixArgs: [] }
  const wrapper = absoluteCandidates.find(
    (candidate) => path.win32.extname(candidate).toLocaleLowerCase('en-US') === '.cmd'
      && !/[\r\n"%！!&|<>()^]/u.test(candidate),
  )
  return wrapper === undefined
    ? undefined
    : { command: comSpec, prefixArgs: ['/d', '/s', '/c', `""${wrapper}"`] }
}

type CodexCliOperation = '--version' | 'app-server'

function isCmdWrapperLaunch(launch: CodexCliLaunchSpec): boolean {
  return launch.prefixArgs.length === 4
    && launch.prefixArgs[0] === '/d'
    && launch.prefixArgs[1] === '/s'
    && launch.prefixArgs[2] === '/c'
}

function operationArguments(
  launch: CodexCliLaunchSpec,
  operation: CodexCliOperation,
): readonly string[] {
  if (isCmdWrapperLaunch(launch)) {
    return ['/d', '/s', '/c', `${launch.prefixArgs[3]} ${operation}"`]
  }
  return [...launch.prefixArgs, operation]
}

function boundedDiscovery(
  discoverCommands: () => Promise<readonly string[]>,
  timeoutMs: number,
): Promise<{ timedOut: false; candidates: readonly string[] } | { timedOut: true }> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (
      result: { timedOut: false; candidates: readonly string[] } | { timedOut: true },
    ): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }
    const timeout = setTimeout(() => finish({ timedOut: true }), timeoutMs)
    void Promise.resolve()
      .then(discoverCommands)
      .then(
        (candidates) => finish({ timedOut: false, candidates }),
        (error: unknown) => finish(error instanceof DiscoveryTimeoutError
          ? { timedOut: true }
          : { timedOut: false, candidates: [] }),
      )
  })
}

function spawnOptions(launch: CodexCliLaunchSpec): CodexCliSpawnOptions {
  return {
    windowsHide: true,
    windowsVerbatimArguments: isCmdWrapperLaunch(launch),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  }
}

function bufferSize(chunk: Buffer | string): number {
  return typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
}

type ChildTerminationResult = 'closed' | 'termination-failed' | 'timeout'

interface TrackedChild {
  readonly child: CodexCliSpawnedChild
  readonly closed: Promise<void>
  markClosed(): void
  isClosed(): boolean
  termination?: Promise<ChildTerminationResult>
}

interface CodexCliChildTracker {
  track(child: CodexCliSpawnedChild): CodexCliSpawnedChild
  terminate(child: CodexCliSpawnedChild): Promise<ChildTerminationResult>
  dispose(): Promise<void>
}

function closeChildStdin(child: CodexCliSpawnedChild): void {
  if (!child.stdin.writableEnded && !child.stdin.destroyed) child.stdin.end()
}

function createChildTracker(
  terminateProcessTree: CodexCliTerminateProcessTree,
  timeoutMs: number,
): CodexCliChildTracker {
  const active = new Map<CodexCliSpawnedChild, TrackedChild>()

  const track = (child: CodexCliSpawnedChild): CodexCliSpawnedChild => {
    let closed = false
    let resolveClosed!: () => void
    let entry!: TrackedChild
    const onError = (): void => {
      if (!Number.isSafeInteger(child.pid) || (child.pid as number) <= 0) entry.markClosed()
    }
    entry = {
      child,
      closed: new Promise<void>((resolve) => { resolveClosed = resolve }),
      markClosed() {
        if (closed) return
        closed = true
        active.delete(child)
        child.removeListener('error', onError)
        resolveClosed()
      },
      isClosed: () => closed,
    }
    active.set(child, entry)
    child.once('close', entry.markClosed)
    child.once('error', onError)
    return child
  }

  const terminateEntry = (entry: TrackedChild): Promise<ChildTerminationResult> => {
    if (entry.isClosed()) return Promise.resolve('closed')
    if (entry.termination) return entry.termination
    const attempt = new Promise<ChildTerminationResult>((resolve) => {
      let settled = false
      let terminationFailed = false
      const finish = (result: ChildTerminationResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(result)
      }
      const timeout = setTimeout(
        () => finish(terminationFailed ? 'termination-failed' : 'timeout'),
        timeoutMs,
      )
      void entry.closed.then(() => finish('closed'))
      const pid = entry.child.pid
      if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return
      void Promise.resolve()
        .then(() => terminateProcessTree(pid as number))
        .catch(() => { terminationFailed = true })
    })
    entry.termination = attempt
    void attempt.then((result) => {
      if (result !== 'closed' && entry.termination === attempt) entry.termination = undefined
    })
    return attempt
  }

  const terminate = (child: CodexCliSpawnedChild): Promise<ChildTerminationResult> => {
    const entry = active.get(child)
    return entry ? terminateEntry(entry) : Promise.resolve('closed')
  }

  const dispose = async (): Promise<void> => {
    const entries = [...active.values()]
    for (const { child } of entries) closeChildStdin(child)
    const terminateWithRetry = async (entry: TrackedChild): Promise<ChildTerminationResult> => {
      const first = await terminateEntry(entry)
      if (first === 'closed' || !active.has(entry.child)) return first
      return await terminateEntry(entry)
    }
    const results = await Promise.all(entries.map(terminateWithRetry))
    if (results.some((result) => result !== 'closed')) {
      throw new Error('Codex CLI child process did not close')
    }
  }

  return { track, terminate, dispose }
}

async function readVersion(
  launch: CodexCliLaunchSpec,
  spawnProcess: CodexCliSpawn,
  trackChild: (child: CodexCliSpawnedChild) => CodexCliSpawnedChild,
  timeoutMs: number,
  terminateChild: (child: CodexCliSpawnedChild) => Promise<ChildTerminationResult>,
): Promise<VersionResult> {
  let child: CodexCliSpawnedChild
  try {
    child = trackChild(spawnProcess(
      launch.command,
      operationArguments(launch, '--version'),
      spawnOptions(launch),
    ))
  } catch {
    return { status: 'launch-failed' }
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let forcedStatus: 'launch-failed' | 'timeout' | undefined
    let settled = false
    const timeout = setTimeout(() => force('timeout'), timeoutMs)

    const cleanup = (): void => {
      clearTimeout(timeout)
      child.removeListener('error', onError)
      child.removeListener('close', onClose)
      child.stdout.removeListener('data', onStdout)
      child.stderr.removeListener('data', onStderr)
    }
    const settle = (result: VersionResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const force = (status: 'launch-failed' | 'timeout'): void => {
      if (forcedStatus) return
      forcedStatus = status
      clearTimeout(timeout)
      void terminateChild(child).then((result) => settle({
        status: result === 'termination-failed'
          ? 'launch-failed'
          : result === 'timeout' ? 'timeout' : status,
      }))
    }
    const onStdout = (chunk: Buffer | string): void => {
      stdoutBytes += bufferSize(chunk)
      if (stdoutBytes > VERSION_OUTPUT_LIMIT_BYTES) {
        force('launch-failed')
        return
      }
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    const onStderr = (chunk: Buffer | string): void => {
      stderrBytes += bufferSize(chunk)
      if (stderrBytes > VERSION_OUTPUT_LIMIT_BYTES) force('launch-failed')
    }
    const onError = (): void => {
      if (!Number.isSafeInteger(child.pid) || (child.pid as number) <= 0) {
        settle({ status: forcedStatus ?? 'launch-failed' })
        return
      }
      force(forcedStatus ?? 'launch-failed')
    }
    const onClose = (code: number | null): void => {
      if (forcedStatus) {
        settle({ status: forcedStatus })
        return
      }
      if (code !== 0) {
        settle({ status: 'launch-failed' })
        return
      }
      let cliVersion: string
      try {
        cliVersion = new TextDecoder('utf-8', { fatal: true })
          .decode(Buffer.concat(chunks, stdoutBytes))
          .trim()
      } catch {
        settle({ status: 'launch-failed' })
        return
      }
      if (cliVersion.length === 0 || cliVersion.length > VERSION_VALUE_LIMIT_CHARACTERS) {
        settle({ status: 'launch-failed' })
        return
      }
      settle({ status: 'connected', cliVersion })
    }

    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('error', onError)
    child.once('close', onClose)
    child.stdin.end()
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function statusFromAccountResponse(value: unknown): CodexCliConnectionStatus | undefined {
  if (!isRecord(value) || value.id !== 2 || !isRecord(value.result)) return undefined
  const account = value.result.account
  if (account === null) return 'not-logged-in'
  if (!isRecord(account) || typeof account.type !== 'string') return 'incompatible-response'
  return account.type === 'chatgpt' ? 'connected' : 'not-logged-in'
}

function probeAppServer(
  launch: CodexCliLaunchSpec,
  spawnProcess: CodexCliSpawn,
  trackChild: (child: CodexCliSpawnedChild) => CodexCliSpawnedChild,
  timeoutMs: number,
  cleanupTimeoutMs: number | undefined,
  terminateChild: (child: CodexCliSpawnedChild) => Promise<ChildTerminationResult>,
): Promise<Omit<CodexCliProbeResult, 'cliVersion'>> {
  let child: CodexCliSpawnedChild
  try {
    child = trackChild(spawnProcess(
      launch.command,
      operationArguments(launch, 'app-server'),
      spawnOptions(launch),
    ))
  } catch {
    return Promise.resolve({ status: 'launch-failed' })
  }

  return new Promise((resolve) => {
    let stdoutBytes = 0
    let stderrBytes = 0
    let pendingLine = Buffer.alloc(0)
    let outcome: CodexCliConnectionStatus | undefined
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let initializationComplete = false
    let modelRequestId = 2
    const models: CodexCliModelSummary[] = []
    const cursors = new Set<string>()

    const timeout = setTimeout(() => beginShutdown('timeout'), timeoutMs)
    const cleanup = (): void => {
      clearTimeout(timeout)
      if (cleanupTimer) clearTimeout(cleanupTimer)
      child.removeListener('error', onError)
      child.removeListener('close', onClose)
      child.stdin.removeListener('error', onStdinError)
      child.stdout.removeListener('data', onStdout)
      child.stderr.removeListener('data', onStderr)
    }
    const settle = (status: CodexCliConnectionStatus): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ status, ...(status === 'connected' ? { models } : {}) })
    }
    const closeStdin = (): void => {
      closeChildStdin(child)
    }
    const beginShutdown = (status: CodexCliConnectionStatus): void => {
      if (outcome !== undefined) return
      outcome = status
      clearTimeout(timeout)
      closeStdin()
      cleanupTimer = setTimeout(() => {
        void terminateChild(child).then((result) => settle(
          result === 'termination-failed'
            ? 'launch-failed'
            : result === 'timeout' ? 'timeout' : status,
        ))
      }, cleanupTimeoutMs ?? (status === 'connected' ? DEFAULT_SUCCESS_CLEANUP_TIMEOUT_MS : DEFAULT_CLEANUP_TIMEOUT_MS))
    }
    const rejectProtocol = (): void => beginShutdown('incompatible-response')
    const parseLine = (line: Buffer): void => {
      if (outcome !== undefined) return
      const normalized = line.at(-1) === 0x0d ? line.subarray(0, -1) : line
      if (normalized.length === 0) return
      let message: unknown
      try {
        message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(normalized)) as unknown
      } catch {
        rejectProtocol()
        return
      }
      if (!isRecord(message)) {
        rejectProtocol()
        return
      }
      if (message.id === 1) {
        if (initializationComplete || !isRecord(message.result)) {
          rejectProtocol()
          return
        }
        initializationComplete = true
        try {
          child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'account/read', params: {} })}\n`)
        } catch {
          beginShutdown('launch-failed')
        }
        return
      }
      if (typeof message.id === 'number' && message.id === modelRequestId && modelRequestId > 2) {
        if (!isRecord(message.result) || !Array.isArray(message.result.data)) { rejectProtocol(); return }
        for (const item of message.result.data) {
          if (!isRecord(item) || !Array.isArray(item.supportedReasoningEfforts)) { rejectProtocol(); return }
          if (item.hidden === true) continue
          const model = parseCodexCliModelSummary({ modelId: item.model, displayName: item.displayName,
            supportedReasoningEfforts: item.supportedReasoningEfforts.map(effort => isRecord(effort) ? effort.reasoningEffort : undefined),
            defaultReasoningEffort: item.defaultReasoningEffort, isDefault: item.isDefault })
          if (!model || models.some(known => known.modelId === model.modelId) || models.length >= 1000) { rejectProtocol(); return }
          models.push(model)
        }
        const cursor = message.result.nextCursor
        if (cursor === null || cursor === undefined) { beginShutdown('connected'); return }
        if (typeof cursor !== 'string' || cursor.length > 2048 || cursors.has(cursor) || cursors.size >= 10) { rejectProtocol(); return }
        cursors.add(cursor)
        try { child.stdin.write(`${JSON.stringify({ id: ++modelRequestId, method: 'model/list', params: { includeHidden: false, limit: 100, cursor } })}\n`) }
        catch { beginShutdown('launch-failed') }
        return
      }
      if (message.id !== 2) return
      if (modelRequestId > 2) { rejectProtocol(); return }
      if (!initializationComplete) {
        rejectProtocol()
        return
      }
      const accountStatus = statusFromAccountResponse(message) ?? 'incompatible-response'
      if (accountStatus !== 'connected') { beginShutdown(accountStatus); return }
      try { child.stdin.write(`${JSON.stringify({ id: ++modelRequestId, method: 'model/list', params: { includeHidden: false, limit: 100 } })}\n`) }
      catch { beginShutdown('launch-failed') }
    }
    const onStdout = (chunk: Buffer | string): void => {
      if (outcome !== undefined) return
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      stdoutBytes += bytes.byteLength
      if (stdoutBytes > APP_SERVER_STREAM_LIMIT_BYTES) {
        rejectProtocol()
        return
      }
      pendingLine = Buffer.concat([pendingLine, bytes])
      let lineEnd = pendingLine.indexOf(0x0a)
      while (lineEnd !== -1) {
        const line = pendingLine.subarray(0, lineEnd)
        pendingLine = pendingLine.subarray(lineEnd + 1)
        parseLine(line)
        if (outcome !== undefined) return
        lineEnd = pendingLine.indexOf(0x0a)
      }
    }
    const onStderr = (chunk: Buffer | string): void => {
      if (outcome !== undefined) return
      stderrBytes += bufferSize(chunk)
      if (stderrBytes > APP_SERVER_STREAM_LIMIT_BYTES) rejectProtocol()
    }
    const onStdinError = (): void => beginShutdown('launch-failed')
    const onError = (): void => {
      closeStdin()
      if (!Number.isSafeInteger(child.pid) || (child.pid as number) <= 0) {
        settle(outcome ?? 'launch-failed')
        return
      }
      beginShutdown(outcome ?? 'launch-failed')
    }
    const onClose = (): void => {
      closeStdin()
      settle(outcome ?? 'incompatible-response')
    }

    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.stdin.on('error', onStdinError)
    child.once('error', onError)
    child.once('close', onClose)

    const initializeRequest = {
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'arkdown', title: 'Arkdown', version },
      },
    }
    try {
      child.stdin.write(`${JSON.stringify(initializeRequest)}\n`)
    } catch {
      beginShutdown('launch-failed')
    }
  })
}

export function createCodexCliConnectionTester(
  options: CodexCliConnectionTesterOptions = {},
): CodexCliConnectionTester {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const cleanupTimeoutMs = options.cleanupTimeoutMs
  const discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS
  const terminationTimeoutMs = options.terminationTimeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS
  const discoverCommands = options.resolveExecutable
    ? async () => { const executable = await options.resolveExecutable!(); return executable ? [executable] : [] }
    : options.discoverCommands ?? (() => defaultDiscoverCommands(discoveryTimeoutMs))
  const spawnProcess: CodexCliSpawn = options.spawn ?? ((command, args, childOptions) => (
    spawn(command, [...args], childOptions) as CodexCliSpawnedChild
  ))
  const terminateProcessTree = options.terminateProcessTree
    ?? ((pid: number) => defaultTerminateProcessTree(pid, terminationTimeoutMs))
  const childTracker = createChildTracker(terminateProcessTree, terminationTimeoutMs)
  const comSpec = options.comSpec ?? process.env.ComSpec ?? 'cmd.exe'
  let disposed = false
  let disposePromise: Promise<void> | undefined

  return {
    async test(): Promise<CodexCliProbeResult> {
      if (disposed) throw new Error('Codex CLI connection tester is disposed')
      const discovery = await boundedDiscovery(discoverCommands, discoveryTimeoutMs)
      if (discovery.timedOut) return { status: 'timeout' }
      const launch = launchSpecFor(discovery.candidates, comSpec)
      if (!launch) return { status: 'not-found' }
      if (disposed) return { status: 'launch-failed' }

      const version = await readVersion(
        launch,
        spawnProcess,
        childTracker.track,
        timeoutMs,
        childTracker.terminate,
      )
      if (version.status !== 'connected') return { status: version.status }
      if (disposed) return { status: 'launch-failed', cliVersion: version.cliVersion }
      const probe = await probeAppServer(
        launch,
        spawnProcess,
        childTracker.track,
        timeoutMs,
        cleanupTimeoutMs,
        childTracker.terminate,
      )
      return { ...probe, cliVersion: version.cliVersion }
    },
    dispose(): Promise<void> {
      disposed = true
      if (!disposePromise) {
        let memoized!: Promise<void>
        memoized = childTracker.dispose().catch((error: unknown) => {
          if (disposePromise === memoized) disposePromise = undefined
          throw error
        })
        disposePromise = memoized
      }
      return disposePromise
    },
  }
}
