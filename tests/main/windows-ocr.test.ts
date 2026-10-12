import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWindowsOcrService,
  createWindowsOcrScriptResolver,
  parseBoundedOcrJsonDocument,
  WindowsOcrError,
  type OcrBridgeChild,
  type WindowsOcrDiagnostic,
  type WindowsOcrOptions,
} from '../../src/main/screenshot-translation/windows-ocr'

const SESSION_ID = '00000000-0000-4000-8000-000000000001'
const roots: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function png(width = 200, height = 100, byteLength = 33): Uint8Array {
  const bytes = new Uint8Array(Math.max(byteLength, 33))
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  new DataView(bytes.buffer).setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  bytes[24] = 8
  bytes[25] = 6
  return bytes
}

const OK = {
  status: 'ok', width: 200, height: 100, language: 'en-US',
  blocks: [{
    id: 'line-1', text: 'Hello', rectPx: { x: 10, y: 20, width: 50, height: 20 },
    words: [{ text: 'Hello', rectPx: { x: 10, y: 20, width: 50, height: 20 } }],
  }],
}

class FakeChild extends EventEmitter implements OcrBridgeChild {
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  kill = vi.fn(() => { this.killed = true; queueMicrotask(() => this.emit('close', null, 'SIGTERM')); return true })
}

function respondingChild(payload: unknown = OK, exitCode = 0): FakeChild {
  const child = new FakeChild()
  queueMicrotask(() => {
    child.stdout.end(`${JSON.stringify(payload)}\n`)
    child.stderr.end()
    child.emit('close', exitCode, null)
  })
  return child
}

function rawChild(payload: string | Buffer, exitCode = 0): FakeChild {
  const child = new FakeChild()
  queueMicrotask(() => {
    child.stdout.end(payload)
    child.stderr.end()
    child.emit('close', exitCode, null)
  })
  return child
}

async function setup(spawn = vi.fn(() => respondingChild()), overrides: Partial<WindowsOcrOptions> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-ocr-test-'))
  roots.push(root)
  const diagnostics: WindowsOcrDiagnostic[] = []
  const service = createWindowsOcrService({
    tempRoot: root,
    resolveScriptPath: () => 'C:\\trusted\\windows-ocr.ps1',
    spawn: spawn as never,
    stdoutLimit: 1024 * 1024,
    stderrLimit: 1024 * 1024,
    diagnostic: (event) => diagnostics.push(event),
    ...overrides,
  })
  return { root, service, spawn, diagnostics }
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'WindowsOcrError', code })
}

describe('bounded Windows OCR adapter', () => {
  it('accepts exactly six JSON container levels and rejects a seventh', () => {
    const nested = (depth: number) => `${'['.repeat(depth)}0${']'.repeat(depth)}`
    expect(parseBoundedOcrJsonDocument(nested(6))).toEqual([[[[[[0]]]]]])
    expect(() => parseBoundedOcrJsonDocument(nested(7))).toThrow()
  })

  it('detects duplicate JSON keys after escape decoding', () => {
    expect(() => parseBoundedOcrJsonDocument('{"text":1,"\\u0074ext":2}')).toThrow()
  })

  it('resolves the trusted OCR bridge from packaged resources or the development scripts root', () => {
    expect(createWindowsOcrScriptResolver({
      isPackaged: true, resourcesPath: 'C:\\Arkdown\\resources', developmentRoot: 'C:\\repo',
    })()).toBe('C:\\Arkdown\\resources\\screenshot-translation\\windows-ocr.ps1')
    expect(createWindowsOcrScriptResolver({
      isPackaged: false, resourcesPath: 'C:\\Arkdown\\resources', developmentRoot: 'C:\\repo',
    })()).toBe('C:\\repo\\scripts\\windows-ocr.ps1')
  })
  it('owns a random temporary PNG and launches a hidden non-shell PowerShell process', async () => {
    const { root, service, spawn } = await setup()
    const result = await service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal })

    expect(result).toEqual({ width: 200, height: 100, language: 'en-US', blocks: OK.blocks })
    expect(spawn).toHaveBeenCalledOnce()
    const calls = spawn.mock.calls as unknown as Array<[string, string[], Record<string, unknown>]>
    const [command, args, options] = calls[0]!
    expect(command).toBe('powershell.exe')
    expect(args.slice(0, 7)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\trusted\\windows-ocr.ps1'])
    expect(args[7]).toBe('-InputPath')
    expect(path.basename(args[8])).toBe('capture.png')
    expect(path.dirname(args[8])).not.toContain(SESSION_ID)
    expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    expect(await readdir(root)).toEqual([])
    await service.dispose()
  })

  it('uses a different random directory for repeated calls with the same session', async () => {
    const { service, spawn } = await setup()
    await service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal })
    await service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal })
    const calls = spawn.mock.calls as unknown as Array<[string, string[]]>
    const firstPath = calls[0]![1][8]!
    const secondPath = calls[1]![1][8]!
    expect(path.dirname(firstPath)).not.toBe(path.dirname(secondPath))
    await service.dispose()
  })

  it.each([
    ['empty bytes', new Uint8Array()],
    ['wrong signature', new Uint8Array(33)],
    ['truncated IHDR', png(200, 100).slice(0, 24)],
    ['zero width', png(0, 100)],
    ['dimension above limit', png(32_769, 1)],
    ['more than 25 million pixels', png(5_001, 5_000)],
  ])('rejects %s before filesystem or process creation', async (_name, bytes) => {
    const { root, service, spawn } = await setup()
    await expectCode(service.recognize({ sessionId: SESSION_ID, png: bytes, signal: new AbortController().signal }), 'OCR_FAILED')
    expect(spawn).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
    await service.dispose()
  })

  it('rejects oversized PNG bytes and a pre-aborted signal before spawning', async () => {
    const { service, spawn } = await setup()
    await expectCode(service.recognize({ sessionId: SESSION_ID, png: png(1, 1, 32 * 1024 * 1024 + 1), signal: new AbortController().signal }), 'OCR_FAILED')
    const abort = new AbortController(); abort.abort()
    await expectCode(service.recognize({ sessionId: SESSION_ID, png: png(), signal: abort.signal }), 'OCR_CANCELLED')
    expect(spawn).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('rejects non-exact or inherited recognition inputs before spawning', async () => {
    const { service, spawn } = await setup()
    await expectCode(service.recognize({
      sessionId: SESSION_ID, png: png(), signal: new AbortController().signal, extra: true,
    } as never), 'OCR_FAILED')
    const inherited = Object.assign(Object.create({ sessionId: SESSION_ID }), {
      png: png(), signal: new AbortController().signal,
    })
    await expectCode(service.recognize(inherited), 'OCR_FAILED')
    expect(spawn).not.toHaveBeenCalled()
    await service.dispose()
  })

  it.each([
    ['unknown top-level key', { ...OK, extra: true }],
    ['wrong image width', { ...OK, width: 201 }],
    ['out-of-bounds line', { ...OK, blocks: [{ ...OK.blocks[0], rectPx: { x: 180, y: 20, width: 50, height: 20 } }] }],
    ['duplicate line ids', { ...OK, blocks: [OK.blocks[0], OK.blocks[0]] }],
    ['non-NFC language', { ...OK, language: 'e\u0301' }],
    ['fixed error with leaked message', { status: 'error', code: 'ocr-failed', message: 'secret' }],
  ])('rejects malformed bridge output: %s', async (_name, output) => {
    const { service } = await setup(vi.fn(() => respondingChild(output)))
    await expectCode(service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal }), 'OCR_FAILED')
    await service.dispose()
  })

  it.each([
    ['duplicate root key', `{"status":"ok","status":"ok","width":200,"height":100,"language":"en-US","blocks":[]}`],
    ['duplicate nested key', `{"status":"ok","width":200,"height":100,"language":"en-US","blocks":[{"id":"line-1","text":"Hello","text":"Again","rectPx":{"x":10,"y":20,"width":50,"height":20},"words":[{"text":"Hello","rectPx":{"x":10,"y":20,"width":50,"height":20}}]}]}`],
    ['control payload', JSON.stringify({ ...OK, blocks: [{ ...OK.blocks[0], text: 'Hello\u0001' }] })],
    ['empty words', JSON.stringify({ ...OK, blocks: [{ ...OK.blocks[0], words: [] }] })],
    ['skipped line id', JSON.stringify({ ...OK, blocks: [{ ...OK.blocks[0], id: 'line-2' }] })],
    ['excess JSON depth', `{"status":"ok","width":200,"height":100,"language":"en-US","blocks":[[[[[[[[]]]]]]]]}`],
  ])('rejects exact JSON violation: %s', async (_name, raw) => {
    const { service } = await setup(vi.fn(() => rawChild(raw)))
    await expectCode(service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal }), 'OCR_FAILED')
    await service.dispose()
  })

  it.each([
    ['language-unavailable', 'OCR_LANGUAGE_UNAVAILABLE'],
    ['decode-failed', 'OCR_FAILED'],
    ['ocr-failed', 'OCR_FAILED'],
    ['output-limit', 'OCR_FAILED'],
  ])('maps fixed bridge code %s without exposing bridge detail', async (bridgeCode, expected) => {
    const { service } = await setup(vi.fn(() => respondingChild({ status: 'error', code: bridgeCode })))
    await expectCode(service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal }), expected)
    await service.dispose()
  })

  it('rejects BOM, trailing documents, malformed UTF-8, empty output, nonzero exits and process errors', async () => {
    const cases: Array<() => FakeChild> = [
      () => { const c = new FakeChild(); queueMicrotask(() => { c.stdout.end(`\ufeff${JSON.stringify(OK)}`); c.emit('close', 0, null) }); return c },
      () => { const c = new FakeChild(); queueMicrotask(() => { c.stdout.end(`${JSON.stringify(OK)}\n{}`); c.emit('close', 0, null) }); return c },
      () => { const c = new FakeChild(); queueMicrotask(() => { c.stdout.end(Buffer.from([0xc3, 0x28])); c.emit('close', 0, null) }); return c },
      () => { const c = new FakeChild(); queueMicrotask(() => c.emit('close', 0, null)); return c },
      () => respondingChild(OK, 9),
      () => { const c = new FakeChild(); queueMicrotask(() => c.emit('error', new Error('native-secret'))); return c },
    ]
    for (const makeChild of cases) {
      const { service } = await setup(vi.fn(makeChild))
      await expectCode(service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal }), 'OCR_FAILED')
      await service.dispose()
    }
  })

  it('maps signal-only child termination to a fixed failure and cleans up', async () => {
    const child = new FakeChild()
    const { root, service } = await setup(vi.fn(() => child))
    const pending = service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal })
    await vi.waitFor(() => expect(child.listenerCount('close')).toBeGreaterThan(0))
    child.emit('close', null, 'SIGTERM')
    await expectCode(pending, 'OCR_FAILED')
    expect(child.kill).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
    await service.dispose()
  })

  it('bounds stdout and stderr before concatenation', async () => {
    for (const stream of ['stdout', 'stderr'] as const) {
      const child = new FakeChild()
      const { service } = await setup(vi.fn(() => child))
      const pending = service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal })
      await vi.waitFor(() => expect(child.listenerCount('close')).toBeGreaterThan(0))
      child[stream].write(Buffer.alloc(1_048_577, 65))
      await expectCode(pending, 'OCR_FAILED')
      expect(child.kill).toHaveBeenCalledOnce()
      await service.dispose()
    }
  })

  it('times out at 30 seconds, kills once, ignores late close, and cleans up', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const { root, service } = await setup(vi.fn(() => child))
    const pending = service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal })
    await vi.waitFor(() => expect(child.listenerCount('close')).toBeGreaterThan(0))
    await vi.advanceTimersByTimeAsync(30_000)
    await expectCode(pending, 'OCR_TIMEOUT')
    child.stdout.end(`${JSON.stringify(OK)}\n`); child.emit('close', 0, null)
    expect(child.kill).toHaveBeenCalledOnce()
    expect(await readdir(root)).toEqual([])
    await service.dispose()
  })

  it('caller abort kills exactly once and ignores late stdout and close', async () => {
    const child = new FakeChild()
    const { root, service } = await setup(vi.fn(() => child))
    const abort = new AbortController()
    const pending = service.recognize({ sessionId: SESSION_ID, png: png(), signal: abort.signal })
    await vi.waitFor(() => expect(child.listenerCount('close')).toBeGreaterThan(0))
    abort.abort()
    await expectCode(pending, 'OCR_CANCELLED')
    child.stdout.write(`${JSON.stringify(OK)}\n`)
    child.emit('close', 0, null)
    expect(child.kill).toHaveBeenCalledOnce()
    expect(await readdir(root)).toEqual([])
    await service.dispose()
  })

  it('ignores a completed old invocation while a newer invocation is active', async () => {
    const oldChild = new FakeChild()
    const newChild = new FakeChild()
    const spawn = vi.fn().mockReturnValueOnce(oldChild).mockReturnValueOnce(newChild)
    const { service } = await setup(spawn)
    const abort = new AbortController()
    const oldPending = service.recognize({ sessionId: SESSION_ID, png: png(), signal: abort.signal })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    abort.abort()
    await expectCode(oldPending, 'OCR_CANCELLED')

    const newPending = service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    oldChild.stdout.end(`${JSON.stringify(OK)}\n`)
    oldChild.emit('close', 0, null)
    newChild.stdout.end(`${JSON.stringify(OK)}\n`)
    newChild.emit('close', 0, null)
    await expect(newPending).resolves.toMatchObject({ width: 200, height: 100 })
    expect(oldChild.kill).toHaveBeenCalledOnce()
    await service.dispose()
  })

  it('abort and dispose invalidate active calls and reject future work', async () => {
    const children = [new FakeChild(), new FakeChild()]
    const { root, service } = await setup(vi.fn(() => children.shift()!))
    const abort = new AbortController()
    const first = service.recognize({ sessionId: SESSION_ID, png: png(), signal: abort.signal })
    await vi.waitFor(() => expect(children).toHaveLength(1)); abort.abort()
    await expectCode(first, 'OCR_CANCELLED')
    const second = service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal })
    await vi.waitFor(() => expect(children).toHaveLength(0)); await service.dispose(); await service.dispose()
    await expectCode(second, 'OCR_CANCELLED')
    await expectCode(service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal }), 'OCR_UNAVAILABLE')
    expect(await readdir(root)).toEqual([])
  })

  it.each(['makeRoot', 'makeTemporaryDirectory', 'writeInputFile'] as const)(
    'maps %s setup filesystem errors to a fixed safe error without leaking paths',
    async (stage) => {
      const canary = 'C:\\private\\ocr-root\\native-secret'
      const overrides = { [stage]: async () => { throw new Error(canary) } } as Partial<WindowsOcrOptions>
      const { service, spawn } = await setup(vi.fn(() => respondingChild()), overrides)
      let caught: unknown
      try { await service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal }) } catch (error) { caught = error }
      expect(caught).toMatchObject({ name: 'WindowsOcrError', code: 'OCR_FAILED' })
      expect(JSON.stringify(caught)).not.toContain(canary)
      expect(spawn).not.toHaveBeenCalled()
      await service.dispose()
    },
  )

  it('tracks setup before its first await so dispose waits and cancels it', async () => {
    let release!: () => void
    const setupGate = new Promise<void>((resolve) => { release = resolve })
    const { service, spawn } = await setup(vi.fn(() => respondingChild()), {
      makeRoot: async () => setupGate,
    } as Partial<WindowsOcrOptions>)
    const recognition = service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal })
    let disposed = false
    const disposing = service.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release()
    await expectCode(recognition, 'OCR_CANCELLED')
    await disposing
    expect(spawn).not.toHaveBeenCalled()
  })

  it('uses the injected packaged/development script resolver instead of a caller path', async () => {
    const { service, spawn } = await setup(vi.fn(() => respondingChild()), {
      resolveScriptPath: () => 'C:\\trusted\\resources\\screenshot-translation\\windows-ocr.ps1',
    } as Partial<WindowsOcrOptions>)
    await service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal })
    const calls = spawn.mock.calls as unknown as Array<[string, string[]]>
    expect(calls[0]![1]).toContain('C:\\trusted\\resources\\screenshot-translation\\windows-ocr.ps1')
    await service.dispose()
  })

  it('keeps cleanup diagnostics bounded and preserves the primary result', async () => {
    const canaries = ['SECRET OCR TEXT', 'C:\\secret\\capture.png', 'native-secret', 'data:image/png;base64']
    const { service, diagnostics } = await setup()
    expect(await service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal })).toMatchObject({ width: 200 })
    for (const diagnostic of diagnostics) {
      const serialized = JSON.stringify(diagnostic)
      for (const canary of canaries) expect(serialized).not.toContain(canary)
      expect(Object.keys(diagnostic).sort()).toEqual(['code', 'phase'])
    }
    expect(WindowsOcrError).toBeTypeOf('function')
    await service.dispose()
  })

  it('preserves a successful OCR result when cleanup fails and emits only a fixed diagnostic', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arkdown-ocr-cleanup-test-'))
    roots.push(root)
    const diagnostics: WindowsOcrDiagnostic[] = []
    const service = createWindowsOcrService({
      tempRoot: root, resolveScriptPath: () => 'C:\\trusted\\windows-ocr.ps1',
      spawn: vi.fn(() => respondingChild()) as never,
      removeDirectory: async () => { throw new Error('C:\\secret\\capture.png SECRET OCR TEXT') },
      diagnostic: (event) => diagnostics.push(event),
    })
    await expect(service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal }))
      .resolves.toMatchObject({ width: 200, height: 100 })
    expect(diagnostics).toEqual([{ phase: 'cleanup', code: 'cleanup-failed' }])
    expect(JSON.stringify(diagnostics)).not.toMatch(/secret|capture\.png|OCR TEXT/iu)
    await service.dispose()
  })

  it('preserves a primary process failure when cleanup also fails', async () => {
    const child = new FakeChild()
    const diagnostics: WindowsOcrDiagnostic[] = []
    const { service } = await setup(vi.fn(() => child), {
      removeDirectory: async () => { throw new Error('C:\\private\\cleanup-native-secret') },
      diagnostic: (event) => diagnostics.push(event),
    })
    const pending = service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal })
    await vi.waitFor(() => expect(child.listenerCount('close')).toBeGreaterThan(0))
    child.emit('error', new Error('C:\\private\\process-native-secret'))
    await expectCode(pending, 'OCR_FAILED')
    expect(diagnostics).toEqual([{ phase: 'cleanup', code: 'cleanup-failed' }])
    expect(JSON.stringify(diagnostics)).not.toMatch(/private|native-secret/iu)
    await service.dispose()
  })

  it('keeps public errors, diagnostics, and spawn representations free of sensitive canaries', async () => {
    const child = new FakeChild()
    const nativeCanary = 'native-message-canary'
    const stdoutCanary = 'stdout-secret-canary'
    const stderrCanary = 'stderr-secret-canary'
    const forbidden = [
      'SECRET OCR TEXT', 'C:\\private\\source.png', 'data:image/png;base64',
      stdoutCanary, stderrCanary, nativeCanary,
    ]
    const { service, spawn, diagnostics } = await setup(vi.fn(() => child))
    const pending = service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal })
    await vi.waitFor(() => expect(child.listenerCount('close')).toBeGreaterThan(0))
    child.stdout.write(stdoutCanary)
    child.stderr.write(stderrCanary)
    child.emit('error', new Error(`${nativeCanary} C:\\private\\source.png SECRET OCR TEXT data:image/png;base64`))
    let caught: unknown
    try { await pending } catch (error) { caught = error }
    const exposed = JSON.stringify({
      error: caught instanceof WindowsOcrError
        ? { name: caught.name, code: caught.code, message: caught.message }
        : caught,
      diagnostics,
      spawn: spawn.mock.calls,
    })
    for (const canary of forbidden) expect(exposed).not.toContain(canary)
    await service.dispose()
  })

  it('settles and clears lifecycle ownership even when the diagnostic sink throws', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arkdown-ocr-diagnostic-test-'))
    roots.push(root)
    const service = createWindowsOcrService({
      tempRoot: root, resolveScriptPath: () => 'C:\\trusted\\windows-ocr.ps1',
      spawn: vi.fn(() => respondingChild()) as never,
      removeDirectory: async () => { throw new Error('cleanup') },
      diagnostic: () => { throw new Error('diagnostic') },
    })
    await expect(service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal }))
      .resolves.toMatchObject({ width: 200 })
    await expect(service.dispose()).resolves.toBeUndefined()
  })

  it('removes only its random direct child and preserves sibling data', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arkdown-ocr-sibling-test-'))
    roots.push(root)
    await mkdir(path.join(root, 'sibling')); await writeFile(path.join(root, 'sibling', 'keep.txt'), 'keep')
    const service = createWindowsOcrService({
      tempRoot: root, resolveScriptPath: () => 'C:\\trusted\\windows-ocr.ps1', spawn: vi.fn(() => respondingChild()) as never,
    })
    await service.recognize({ sessionId: SESSION_ID, png: png(), signal: new AbortController().signal })
    expect(await readdir(root)).toEqual(['sibling'])
    await service.dispose()
  })

  it.runIf(process.platform === 'win32')('executes the real Windows PowerShell 5.1 IAsyncAction await branch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arkdown-ocr-action-probe-'))
    roots.push(root)
    const target = path.join(root, 'delete-me.txt')
    const probe = path.join(root, 'action-probe.ps1')
    await writeFile(target, 'delete me')
    await writeFile(probe, [
      'param([string]$BridgePath, [string]$TargetPath)',
      "$ErrorActionPreference = 'Stop'",
      '. $BridgePath',
      'Initialize-ArkdownOcrWinRt',
      '$file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($TargetPath)) ([Windows.Storage.StorageFile])',
      'Await-WinRtAction ($file.DeleteAsync())',
      "[Console]::Out.Write('action-ok')",
    ].join('\r\n'), 'utf8')

    const result = await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe,
      '-BridgePath', path.resolve('scripts/windows-ocr.ps1'), '-TargetPath', target,
    ], { windowsHide: true, encoding: 'utf8' })
    expect(result.stdout).toBe('action-ok')
    expect(result.stderr).toBe('')
    await expect(access(target)).rejects.toThrow()
  })
})
