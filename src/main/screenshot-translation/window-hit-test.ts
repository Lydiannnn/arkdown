import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { ScreenshotPoint, ScreenshotRect } from '../../shared/screenshot-translation'
import { isWindowHandle } from './window-exclusions'

export interface WindowHit {
  readonly hwnd: string
  readonly processId: number
  readonly processCreationIdentity: string
  readonly boundsPx: ScreenshotRect
}
export interface WindowHitTestService {
  hitTest(screenPointPx: ScreenshotPoint, excludedWindowHandles: ReadonlySet<string>): Promise<WindowHit | null>
  dispose(): Promise<void>
}

interface BridgeChild extends ChildProcess {
  stdin: NonNullable<ChildProcess['stdin']>
  stdout: NonNullable<ChildProcess['stdout']>
  stderr: NonNullable<ChildProcess['stderr']>
}

type SpawnAdapter = (command: string, args: readonly string[], options: {
  shell: false
  windowsHide: true
  stdio: 'pipe'
  env: NodeJS.ProcessEnv
}) => BridgeChild

export interface WindowHitTestOptions {
  scriptPath: string
  timeoutMs?: number
  stdoutLineLimit?: number
  stderrLimit?: number
  pendingLimit?: number
  spawn?: SpawnAdapter
}

interface Pending { resolve: (value: WindowHit | null) => void; timer: NodeJS.Timeout }
interface Bridge {
  child: BridgeChild
  stdout: StringDecoder
  stderrBytes: number
  buffer: string
  exited: Promise<void>
  spawned: boolean
  terminating: boolean
}

const COORDINATE_LIMIT = 1_000_000
const FRAME_DIMENSION_LIMIT = 32_768
const DEFAULT_TIMEOUT_MS = 3_000
const DEFAULT_LINE_LIMIT = 16 * 1024
const DEFAULT_PENDING_LIMIT = 64

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
}

function isCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= COORDINATE_LIMIT
}

function isProcessId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isFrameDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= FRAME_DIMENSION_LIMIT
}

function parseResponse(value: unknown, expectedId: number, excluded: ReadonlySet<string>): WindowHit | null | undefined {
  if (!exactRecord(value, ['requestId', 'hit']) || value.requestId !== expectedId || !Number.isSafeInteger(value.requestId) || value.requestId <= 0) return undefined
  if (value.hit === null) return null
  if (!exactRecord(value.hit, ['hwnd', 'processId', 'processCreationIdentity', 'boundsPx'])) return undefined
  const hit = value.hit
  const processId = hit.processId
  if (!isProcessId(processId) || !isWindowHandle(hit.hwnd) || excluded.has(hit.hwnd)
    || typeof hit.processCreationIdentity !== 'string' || !/^[1-9][0-9]{9,19}$/u.test(hit.processCreationIdentity)) return undefined
  const bounds = hit.boundsPx
  if (!exactRecord(bounds, ['x', 'y', 'width', 'height'])) return undefined
  const { x, y, width, height } = bounds
  if (!isCoordinate(x) || !isCoordinate(y)
    || !isFrameDimension(width) || !isFrameDimension(height)
    || x > COORDINATE_LIMIT - width || y > COORDINATE_LIMIT - height) return undefined
  return { hwnd: hit.hwnd, processId, processCreationIdentity: hit.processCreationIdentity, boundsPx: { x, y, width, height } }
}

function validInput(point: ScreenshotPoint, excluded: ReadonlySet<string>): string[] | undefined {
  if (!isCoordinate(point.x) || !isCoordinate(point.y) || excluded.size > 256) return undefined
  const values = [...excluded]
  if (values.some((value) => !isWindowHandle(value)) || new Set(values).size !== values.length) return undefined
  return values.sort((left, right) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0)
}

export function createWindowHitTestService(options: WindowHitTestOptions): WindowHitTestService {
  const spawn = options.spawn ?? nodeSpawn as unknown as SpawnAdapter
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const stdoutLineLimit = options.stdoutLineLimit ?? DEFAULT_LINE_LIMIT
  const stderrLimit = options.stderrLimit ?? DEFAULT_LINE_LIMIT
  const pendingLimit = options.pendingLimit ?? DEFAULT_PENDING_LIMIT
  let bridge: Bridge | undefined
  let disposed = false
  let disposePromise: Promise<void> | undefined
  let requestId = 0
  const terminatingBridges = new Set<Bridge>()
  const pending = new Map<number, Pending>()
  const exclusions = new Map<number, ReadonlySet<string>>()

  const settle = (id: number, result: WindowHit | null) => {
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    exclusions.delete(id)
    clearTimeout(request.timer)
    request.resolve(result)
  }
  const teardown = (target = bridge): Promise<void> => {
    if (!target) return Promise.resolve()
    if (target.terminating) return target.exited
    target.terminating = true
    if (bridge === target) bridge = undefined
    terminatingBridges.add(target)
    void target.exited.finally(() => terminatingBridges.delete(target))
    target.child.stdin.removeAllListeners()
    target.child.stdout.removeAllListeners()
    target.child.stderr.removeAllListeners()
    if (!target.child.killed) { try { target.child.kill() } catch { /* best effort */ } }
    for (const id of [...pending.keys()]) settle(id, null)
    return target.exited
  }
  const handleLine = (target: Bridge, line: string) => {
    if (Buffer.byteLength(line, 'utf8') > stdoutLineLimit) return teardown(target)
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { return teardown(target) }
    if (!exactRecord(parsed, ['requestId', 'hit'])) return teardown(target)
    const responseId = parsed.requestId
    if (!isProcessId(responseId) || !pending.has(responseId)) return teardown(target)
    const hit = parseResponse(parsed, responseId, exclusions.get(responseId) ?? new Set())
    if (hit === undefined) return teardown(target)
    settle(responseId, hit)
  }
  const start = (): Bridge | undefined => {
    if (disposed) return undefined
    if (bridge) return bridge
    let child: BridgeChild
    try {
      child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', options.scriptPath], {
        shell: false, windowsHide: true, stdio: 'pipe', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
    } catch { return undefined }
    let spawned = Number.isSafeInteger(child.pid) && child.pid! > 0
    let target: Bridge | undefined
    const exited = new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      child.once('spawn', () => {
        spawned = true
        if (target) target.spawned = true
      })
      child.once('exit', finish)
      child.once('close', finish)
      child.on('error', () => {
        if (!spawned) finish()
      })
    })
    target = {
      child, stdout: new StringDecoder('utf8'), stderrBytes: 0, buffer: '', exited, spawned, terminating: false,
    }
    bridge = target
    child.stdout.on('data', (chunk: Buffer | string) => {
      if (bridge !== target) return
      target.buffer += target.stdout.write(chunk)
      let newline = target.buffer.indexOf('\n')
      while (newline !== -1) {
        const line = target.buffer.slice(0, newline).replace(/\r$/, '')
        target.buffer = target.buffer.slice(newline + 1)
        handleLine(target, line)
        if (bridge !== target) return
        newline = target.buffer.indexOf('\n')
      }
      if (Buffer.byteLength(target.buffer, 'utf8') > stdoutLineLimit) teardown(target)
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (bridge !== target) return
      target.stderrBytes += Buffer.byteLength(chunk)
      if (target.stderrBytes > stderrLimit) teardown(target)
    })
    child.stdin.on('error', () => teardown(target))
    child.once('error', () => teardown(target))
    child.once('exit', () => teardown(target))
    child.once('close', () => teardown(target))
    return target
  }

  return {
    hitTest(screenPointPx, excludedWindowHandles) {
      const excluded = validInput(screenPointPx, excludedWindowHandles)
      if (!excluded || disposed || pending.size >= pendingLimit || requestId >= Number.MAX_SAFE_INTEGER) return Promise.resolve(null)
      const target = start()
      if (!target) return Promise.resolve(null)
      const id = ++requestId
      return new Promise<WindowHit | null>((resolve) => {
        const timer = setTimeout(() => teardown(target), timeoutMs)
        pending.set(id, { resolve, timer })
        exclusions.set(id, new Set(excluded))
        try {
          target.child.stdin.write(`${JSON.stringify({ requestId: id, x: screenPointPx.x, y: screenPointPx.y, excludedWindowHandles: excluded })}\n`)
        } catch { teardown(target) }
      })
    },
    dispose() {
      disposePromise ??= (async () => {
        disposed = true
        await teardown()
        while (terminatingBridges.size > 0) {
          await Promise.all([...terminatingBridges].map((target) => target.exited))
        }
      })()
      return disposePromise
    },
  }
}
