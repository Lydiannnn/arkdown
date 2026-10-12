import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const EXCLUDED_TOP_LEVEL_ENTRIES = new Set(['pandoc', 'portable-data', 'temp'])
const HARD_LINK_FALLBACK_ERRORS = new Set(['EACCES', 'EMLINK', 'ENOTSUP', 'EPERM', 'EXDEV'])
const execFileAsync = promisify(execFile)

const PROCESS_QUERY_SCRIPT = `param(
  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath
)

$target = [System.IO.Path]::GetFullPath($ExecutablePath)
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, ExecutablePath, CreationDate)
$result = @($all | Where-Object { $_.ExecutablePath -and $_.CreationDate } | ForEach-Object {
  [PSCustomObject]@{
    executablePath = [System.IO.Path]::GetFullPath($_.ExecutablePath)
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    creationTime = $_.CreationDate.ToUniversalTime().ToString('o')
  }
})
ConvertTo-Json -InputObject $result -Compress
`

export interface SharedRuntime {
  application: string
  executable: string
  root: string
}

export interface RuntimeInstance {
  application: string
  arknoteExecutable: string
  executable: string
  portableData: string
  root: string
  userData: string
}

export interface ElectronProcessObservation {
  executablePath: string
  pid: number
  parentPid: number
  creationTime: string
}

export interface ShutdownElectronApplicationOptions {
  delay?(milliseconds: number): Promise<void>
  enumerateProcesses?(executablePath: string): Promise<readonly ElectronProcessObservation[]>
  executable: string
  fallbackTimeoutMs?: number
  forceKill?(pids: readonly number[]): Promise<void>
  gracefulTimeoutMs?: number
  now?(): number
  pollIntervalMs?: number
  quietPeriodMs?: number
  requestClose(): Promise<void>
}

export interface ShutdownElectronApplicationScopeOptions<T> {
  afterQuiet?(): Promise<void>
  application: T | null | undefined
  executable: string
  requestClose(application: T): Promise<void>
  shutdownOptions?: Omit<
    ShutdownElectronApplicationOptions,
    'executable' | 'requestClose'
  >
}

export interface PrepareSharedRuntimeOptions {
  additionalExecutableNames?: readonly string[]
  executableName: string
  instrumentExecutable: (executable: string) => Promise<void>
  packagedApplication: string
  tempDirectory?: string
}

export async function runE2eStage<T>(
  name: string,
  operation: () => Promise<T>,
  log: (message: string) => void = console.log,
): Promise<T> {
  const startedAt = performance.now()
  log(`[Electron E2E] ${name}：开始`)
  try {
    const result = await operation()
    log(`[Electron E2E] ${name}：完成（${Math.round(performance.now() - startedAt)} ms）`)
    return result
  } catch (error) {
    log(`[Electron E2E] ${name}：失败（${Math.round(performance.now() - startedAt)} ms）`)
    throw error
  }
}

async function linkOrCopyFile(source: string, destination: string): Promise<void> {
  try {
    await link(source, destination)
  } catch (error) {
    if (!HARD_LINK_FALLBACK_ERRORS.has((error as NodeJS.ErrnoException).code ?? '')) throw error
    await copyFile(source, destination)
  }
}

async function mapApplicationTree(options: {
  copiedExecutables: ReadonlySet<string>
  destinationRoot: string
  sourceRoot: string
}): Promise<void> {
  const mapDirectory = async (sourceDirectory: string, destinationDirectory: string): Promise<void> => {
    await mkdir(destinationDirectory, { recursive: true })
    const entries = await readdir(sourceDirectory, { withFileTypes: true })
    await Promise.all(entries.map(async (entry) => {
      const source = path.join(sourceDirectory, entry.name)
      const destination = path.join(destinationDirectory, entry.name)
      const relative = path.relative(options.sourceRoot, source)
      const [topLevel] = relative.split(path.sep)
      if (EXCLUDED_TOP_LEVEL_ENTRIES.has(topLevel)) return

      if (entry.isDirectory()) {
        await mapDirectory(source, destination)
        return
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported E2E runtime entry: ${source}`)
      }
      if (options.copiedExecutables.has(relative)) {
        await copyFile(source, destination)
        return
      }
      await linkOrCopyFile(source, destination)
    }))
  }

  await mapDirectory(options.sourceRoot, options.destinationRoot)
}

export interface ElectronLaunchDeadlineOptions<T> {
  attemptTimeoutMs: number
  delay?(milliseconds: number, signal: AbortSignal): Promise<void>
  dispose(candidate: T, signal: AbortSignal): Promise<void>
  isAlive(candidate: T, signal: AbortSignal): boolean | Promise<boolean>
  isRetryable?(error: unknown): boolean
  launch(timeoutMs: number, signal: AbortSignal): Promise<T>
  now?(): number
  retryDelayMs: number
  stabilityDelayMs: number
  terminate?(candidate: T | undefined): void | Promise<void>
  totalTimeoutMs: number
}

class ElectronLaunchDeadlineError extends Error {
  constructor() {
    super('Electron launch deadline expired')
    this.name = 'ElectronLaunchDeadlineError'
  }
}

export async function launchElectronWithDeadline<T>(
  options: ElectronLaunchDeadlineOptions<T>,
): Promise<T> {
  const now = options.now ?? Date.now
  const delay = options.delay ?? (async (milliseconds: number) => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds))
  })
  const deadline = now() + options.totalTimeoutMs
  const controller = new AbortController()
  let terminationRequested = false

  const expire = (candidate: T | undefined): ElectronLaunchDeadlineError => {
    if (!controller.signal.aborted) controller.abort()
    if (!terminationRequested) {
      terminationRequested = true
      try { void options.terminate?.(candidate) } catch { /* best-effort synchronous termination */ }
    }
    return new ElectronLaunchDeadlineError()
  }
  const runBeforeDeadline = async <R>(
    operation: () => Promise<R>,
    candidate: T | undefined,
  ): Promise<R> => {
    const remaining = deadline - now()
    if (remaining <= 0) throw expire(candidate)
    return await new Promise<R>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(expire(candidate))
      }, remaining)
      void Promise.resolve().then(operation).then((value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (now() >= deadline) reject(expire(candidate))
        else resolve(value)
      }, (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (now() >= deadline) reject(expire(candidate))
        else reject(error)
      })
    })
  }

  while (now() < deadline) {
    const timeoutMs = Math.min(options.attemptTimeoutMs, deadline - now())
    if (timeoutMs <= 0) break
    let candidate: T | undefined
    try {
      candidate = await runBeforeDeadline(
        async () => await options.launch(timeoutMs, controller.signal),
        undefined,
      )
      const stabilityDelay = Math.min(options.stabilityDelayMs, Math.max(0, deadline - now()))
      if (stabilityDelay > 0) {
        await runBeforeDeadline(
          async () => await delay(stabilityDelay, controller.signal),
          candidate,
        )
      }
      const alive = await runBeforeDeadline(
        async () => await options.isAlive(candidate as T, controller.signal),
        candidate,
      )
      if (alive) return candidate
      await runBeforeDeadline(
        async () => await options.dispose(candidate as T, controller.signal),
        candidate,
      )
      candidate = undefined
      throw new Error('Process failed to launch!')
    } catch (error) {
      if (error instanceof ElectronLaunchDeadlineError) throw error
      if (candidate !== undefined) {
        await runBeforeDeadline(
          async () => await options.dispose(candidate as T, controller.signal).catch(() => undefined),
          candidate,
        )
        candidate = undefined
      }
      if (options.isRetryable && !options.isRetryable(error)) throw error
      const retryDelay = Math.min(options.retryDelayMs, Math.max(0, deadline - now()))
      if (retryDelay > 0) {
        await runBeforeDeadline(
          async () => await delay(retryDelay, controller.signal),
          undefined,
        )
      }
    }
  }
  throw expire(undefined)
}

export async function cleanupRuntime(root: string): Promise<void> {
  await rm(root, {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 100,
  })
}

function trackedProcesses(
  observed: readonly ElectronProcessObservation[],
  executables: readonly string[],
  tracked: Map<number, string>,
): ElectronProcessObservation[] {
  const observedByPid = new Map(observed.map((observation) => [observation.pid, observation]))
  for (const observation of observed) {
    if (executables.some((executable) => path.resolve(observation.executablePath).localeCompare(
      executable,
      undefined,
      { sensitivity: 'accent' },
    ) === 0)) tracked.set(observation.pid, observation.creationTime)
  }
  let discovered = true
  while (discovered) {
    discovered = false
    for (const observation of observed) {
      const parent = observedByPid.get(observation.parentPid)
      if (!tracked.has(observation.pid) && parent
        && tracked.get(parent.pid) === parent.creationTime) {
        tracked.set(observation.pid, observation.creationTime)
        discovered = true
      }
    }
  }
  const matching = observed.filter((observation) => tracked.get(observation.pid) === observation.creationTime)
  const live = new Set(matching.map(({ pid, creationTime }) => `${pid}:${creationTime}`))
  for (const [pid, creationTime] of tracked) {
    if (!live.has(`${pid}:${creationTime}`)) tracked.delete(pid)
  }
  return matching
}

export async function cleanupRuntimeAfterExactShutdowns(options: {
  root: string
  shutdownArkdown(): Promise<void>
  shutdownArknote(): Promise<void>
  beforeCleanup?(): Promise<void>
  executables?: readonly string[]
}): Promise<void> {
  let shutdownFailure: unknown
  try {
    await options.shutdownArkdown()
  } catch (error) {
    shutdownFailure = error
  }
  try {
    await options.shutdownArknote()
  } catch (error) {
    shutdownFailure ??= error
  }
  if (shutdownFailure !== undefined) throw shutdownFailure
  if (options.executables) await waitForElectronExecutablesQuiet({ executables: options.executables })
  await options.beforeCleanup?.()
  await cleanupRuntime(options.root)
}

function createProcessEnumerator(executable: string): (
  executablePath: string,
) => Promise<readonly ElectronProcessObservation[]> {
  const scriptDirectory = path.join(path.dirname(executable), 'temp')
  const script = path.join(scriptDirectory, 'arkdown-e2e-process-query.ps1')
  const scriptReady = mkdir(scriptDirectory, { recursive: true })
    .then(async () => await writeFile(script, PROCESS_QUERY_SCRIPT, 'utf8'))

  return async (executablePath: string) => {
    await scriptReady
    const powershell = path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
    const { stdout } = await execFileAsync(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-ExecutablePath',
      executablePath,
    ], { encoding: 'utf8', windowsHide: true })
    const parsed: unknown = JSON.parse(stdout.trim() || '[]')
    const observations = Array.isArray(parsed) ? parsed : [parsed]
    return observations.flatMap((observation): ElectronProcessObservation[] => {
      if (!observation || typeof observation !== 'object') return []
      const candidate = observation as Partial<ElectronProcessObservation>
      if (typeof candidate.executablePath !== 'string'
        || !Number.isSafeInteger(candidate.pid)
        || (candidate.pid ?? 0) <= 0
        || !Number.isSafeInteger(candidate.parentPid)
        || (candidate.parentPid ?? -1) < 0
        || typeof candidate.creationTime !== 'string'
        || candidate.creationTime.length < 1
        || candidate.creationTime.length > 64) return []
      return [{
        executablePath: candidate.executablePath,
        pid: candidate.pid as number,
        parentPid: candidate.parentPid as number,
        creationTime: candidate.creationTime,
      }]
    })
  }
}

async function forceKillProcesses(pids: readonly number[]): Promise<void> {
  if (pids.length === 0) return
  const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  const args = [...new Set(pids)].flatMap((pid) => ['/PID', String(pid)])
  await execFileAsync(taskkill, [...args, '/T', '/F'], {
    encoding: 'utf8',
    windowsHide: true,
  })
}

export async function shutdownElectronApplication(
  options: ShutdownElectronApplicationOptions,
): Promise<void> {
  const executable = path.resolve(options.executable)
  const now = options.now ?? Date.now
  const delay = options.delay ?? (async (milliseconds: number) => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds))
  })
  const enumerateProcesses = options.enumerateProcesses ?? createProcessEnumerator(executable)
  const forceKill = options.forceKill ?? forceKillProcesses
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 10_000
  const fallbackTimeoutMs = options.fallbackTimeoutMs ?? 10_000
  const pollIntervalMs = options.pollIntervalMs ?? 100
  const quietPeriodMs = options.quietPeriodMs ?? 2_000
  const gracefulDeadline = now() + gracefulTimeoutMs
  let fallbackDeadline: number | undefined
  let quietSince: number | undefined
  let closeFailure: unknown
  const tracked = new Map<number, string>()
  let prefetched: readonly ElectronProcessObservation[] | undefined = await enumerateProcesses(executable)
  trackedProcesses(prefetched, [executable], tracked)

  const closeRequest = Promise.resolve()
    .then(async () => await options.requestClose())
    .catch((error: unknown) => { closeFailure = error })

  while (true) {
    const observed = prefetched
    prefetched = undefined
    const currentObserved = observed ?? await enumerateProcesses(executable)
    const matching = trackedProcesses(currentObserved, [executable], tracked)
    const currentTime = now()

    if (matching.length === 0) {
      quietSince ??= currentTime
      if (currentTime - quietSince >= quietPeriodMs) {
        await closeRequest
        if (closeFailure !== undefined) throw closeFailure
        return
      }
    } else {
      quietSince = undefined
    }

    if (fallbackDeadline === undefined && currentTime >= gracefulDeadline) {
      fallbackDeadline = currentTime + fallbackTimeoutMs
    }
    if (fallbackDeadline !== undefined && matching.length > 0) {
      await forceKill(matching.map(({ pid }) => pid))
    }
    if (fallbackDeadline !== undefined && currentTime >= fallbackDeadline) {
      throw new Error(`Electron processes did not become quiet for ${executable}`)
    }

    await delay(pollIntervalMs)
  }
}

export async function waitForElectronExecutablesQuiet(options: {
  executables: readonly string[]
  enumerateProcesses?: (executablePath: string) => Promise<readonly ElectronProcessObservation[]>
  delay?(milliseconds: number): Promise<void>
  now?(): number
  pollIntervalMs?: number
  quietPeriodMs?: number
  timeoutMs?: number
}): Promise<void> {
  const executables = [...new Set(options.executables.map((value) => path.resolve(value)))]
  if (executables.length === 0) throw new Error('Electron executable scope is empty')
  const enumerate = options.enumerateProcesses ?? createProcessEnumerator(executables[0]!)
  const delay = options.delay ?? (async (milliseconds: number) => await new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const now = options.now ?? Date.now
  const pollIntervalMs = options.pollIntervalMs ?? 100
  const quietPeriodMs = options.quietPeriodMs ?? 2_000
  const deadline = now() + (options.timeoutMs ?? 10_000)
  const tracked = new Map<number, string>()
  let quietSince: number | undefined
  while (true) {
    const matching = trackedProcesses(await enumerate(executables[0]!), executables, tracked)
    const current = now()
    if (matching.length === 0) {
      quietSince ??= current
      if (current - quietSince >= quietPeriodMs) return
    } else {
      quietSince = undefined
    }
    if (current >= deadline) throw new Error('Electron executable scope did not become quiet')
    await delay(pollIntervalMs)
  }
}

export async function shutdownElectronApplicationScope<T>(
  options: ShutdownElectronApplicationScopeOptions<T>,
): Promise<void> {
  const application = options.application
  await shutdownElectronApplication({
    ...options.shutdownOptions,
    executable: options.executable,
    requestClose: application === null || application === undefined
      ? async () => undefined
      : async () => await options.requestClose(application),
  })
  await options.afterQuiet?.()
}

export async function prepareSharedRuntime(
  options: PrepareSharedRuntimeOptions,
): Promise<SharedRuntime> {
  const executableNames = [
    options.executableName,
    ...(options.additionalExecutableNames ?? []),
  ]
  for (const executableName of executableNames) {
    const sourceExecutable = path.join(options.packagedApplication, executableName)
    const executableMetadata = await stat(sourceExecutable).catch(() => undefined)
    if (!executableMetadata?.isFile()) {
      throw new Error(`Packaged executable not found: ${sourceExecutable}`)
    }
  }

  const root = await mkdtemp(path.join(options.tempDirectory ?? tmpdir(), 'arkdown-e2e-shared-'))
  const application = path.join(root, 'Arkdown')
  const executable = path.join(application, options.executableName)
  try {
    await runE2eStage('准备共享运行文件', async () => {
      await mapApplicationTree({
        copiedExecutables: new Set(executableNames),
        destinationRoot: application,
        sourceRoot: options.packagedApplication,
      })
    })
    await runE2eStage('修改共享副本 Fuse', async () => {
      for (const executableName of executableNames) {
        await options.instrumentExecutable(path.join(application, executableName))
      }
    })
    return { application, executable, root }
  } catch (error) {
    await cleanupRuntime(root)
    throw error
  }
}

export async function createRuntimeInstance(
  sharedApplication: string,
  prefix = 'arkdown-e2e-runtime-',
): Promise<RuntimeInstance> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  const application = path.join(root, 'Arkdown')
  const executableName = 'Arkdown.exe'
  try {
    await runE2eStage('创建隔离运行实例', async () => {
      await mapApplicationTree({
        copiedExecutables: new Set(['Arkdown.exe', 'Arknote.exe']),
        destinationRoot: application,
        sourceRoot: sharedApplication,
      })
    })
    return {
      application,
      arknoteExecutable: path.join(application, 'Arknote.exe'),
      executable: path.join(application, executableName),
      portableData: path.join(application, 'portable-data'),
      root,
      userData: path.join(root, 'user-data'),
    }
  } catch (error) {
    await cleanupRuntime(root)
    throw error
  }
}
