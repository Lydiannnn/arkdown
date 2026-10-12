import { EventEmitter } from 'node:events'
import { spawn as realSpawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createWindowHitTestService } from '../../src/main/screenshot-translation/window-hit-test'

class Stream extends EventEmitter {
  writes: string[] = []
  write(value: string) { this.writes.push(value); return true }
}

class Child extends EventEmitter {
  readonly stdin = new Stream()
  readonly stdout = new Stream()
  readonly stderr = new Stream()
  pid: number | undefined = 1234
  killed = 0
  kill = vi.fn(() => { this.killed += 1; this.emit('exit', null) })
}

function bridge(timeoutMs?: number, spawned = true) {
  const children: Child[] = []
  const spawn = vi.fn(() => {
    const child = new Child()
    if (!spawned) child.pid = undefined
    children.push(child)
    return child
  })
  const service = createWindowHitTestService({
    scriptPath: 'C:\\bridge.ps1',
    spawn: spawn as never,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
  return { service, spawn, children }
}

function reply(child: Child, value: unknown) { child.stdout.emit('data', Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')) }

describe('window hit test bridge', () => {
  it.each([
    { hwnd: 9007199254740993 },
    { hwnd: '18446744073709551616' },
    { hwnd: '001' },
    { processCreationIdentity: '' },
    { processCreationIdentity: 132000000000000000 },
    { windowTitle: 'must-not-cross-protocol' },
  ])('rejects unsafe native identity response %j', async (invalid) => {
    const { service, children } = bridge()
    const result = service.hitTest({ x: 10, y: 10 }, new Set())
    reply(children[0], { requestId: 1, hit: { hwnd: '9007199254740993', processId: 77, processCreationIdentity: '132000000000000000', boundsPx: { x: 0, y: 0, width: 100, height: 100 }, ...invalid } })
    await expect(result).resolves.toBeNull()
    await service.dispose()
  })

  it('keeps the full 64-bit handle and creation identity without exposing them to number conversion', async () => {
    const { service, children } = bridge()
    const result = service.hitTest({ x: 10, y: 10 }, new Set(['9007199254740992']))
    const hit = { hwnd: '9007199254740993', processId: 77, processCreationIdentity: '132000000000000000', boundsPx: { x: 0, y: 0, width: 100, height: 100 } }
    reply(children[0], { requestId: 1, hit })
    await expect(result).resolves.toEqual(hit)
    await service.dispose()
  })
  it('starts one persistent PowerShell bridge and serializes exact sorted requests', async () => {
    const { service, spawn, children } = bridge()
    const one = service.hitTest({ x: -12, y: 34 }, new Set(['9', '2']))
    expect(spawn).toHaveBeenCalledWith('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\bridge.ps1'], expect.objectContaining({ shell: false, windowsHide: true, stdio: 'pipe' }))
    expect(children[0].stdin.writes).toEqual(['{"requestId":1,"x":-12,"y":34,"excludedWindowHandles":["2","9"]}\n'])
    reply(children[0], { requestId: 1, hit: { hwnd: '10077', processCreationIdentity: '132000000000000000', processId: 77, boundsPx: { x: -10, y: 20, width: 800, height: 600 } } })
    await expect(one).resolves.toEqual({ hwnd: '10077', processCreationIdentity: '132000000000000000', processId: 77, boundsPx: { x: -10, y: 20, width: 800, height: 600 } })
    const two = service.hitTest({ x: 0, y: 0 }, new Set())
    expect(spawn).toHaveBeenCalledTimes(1)
    reply(children[0], { requestId: 2, hit: null })
    await expect(two).resolves.toBeNull()
  })

  it('accepts only exact safe matching response lines and never leaks errors', async () => {
    const { service, children, spawn } = bridge()
    const pending = service.hitTest({ x: 1, y: 1 }, new Set(['1004']))
    reply(children[0], { requestId: 1, hit: { hwnd: '1004', processCreationIdentity: '132000000000000000', processId: 4, boundsPx: { x: 0, y: 0, width: 1, height: 1 } } })
    await expect(pending).resolves.toBeNull()
    const next = service.hitTest({ x: 1, y: 1 }, new Set())
    reply(children[1], { requestId: 2.5, hit: null, extra: 'secret stderr' })
    await expect(next).resolves.toBeNull()
  })

  it('handles fragmented output and refuses stale/malformed/oversized replies without settling another request', async () => {
    const { service, children } = bridge()
    const pending = service.hitTest({ x: 1, y: 2 }, new Set())
    children[0].stdout.emit('data', Buffer.from('{"requestId":1,"hit":', 'utf8'))
    children[0].stdout.emit('data', Buffer.from('null}\n', 'utf8'))
    await expect(pending).resolves.toBeNull()
    const stale = service.hitTest({ x: 2, y: 3 }, new Set())
    reply(children[0], { requestId: 99, hit: null })
    expect(children[0].killed).toBe(1)
    await expect(stale).resolves.toBeNull()
  })

  it('parses two individually bounded replies delivered in one aggregate stdout chunk', async () => {
    const { service, children, spawn } = bridge()
    const one = service.hitTest({ x: 1, y: 1 }, new Set())
    const two = service.hitTest({ x: 2, y: 2 }, new Set())
    const padding = ' '.repeat(9_000)
    children[0].stdout.emit('data', Buffer.from(`{"requestId":1,"hit":null}${padding}\n{"requestId":2,"hit":null}${padding}\n`, 'utf8'))
    await expect(one).resolves.toBeNull()
    await expect(two).resolves.toBeNull()
    expect(children[0].killed).toBe(0)
    const three = service.hitTest({ x: 3, y: 3 }, new Set())
    expect(spawn).toHaveBeenCalledOnce()
    reply(children[0], { requestId: 3, hit: null })
    await expect(three).resolves.toBeNull()
  })

  it('owns stdin errors, settles pending work, and removes stdin listeners on disposal', async () => {
    const { service, children } = bridge()
    const pending = service.hitTest({ x: 1, y: 1 }, new Set())
    expect(children[0].stdin.listenerCount('error')).toBeGreaterThan(0)
    children[0].stdin.emit('error', new Error('EPIPE'))
    await expect(pending).resolves.toBeNull()
    expect(children[0].stdin.listenerCount('error')).toBe(0)
  })

  it('tears down on timeout, stderr/stdout overflow, child error or exit, then restarts lazily', async () => {
    vi.useFakeTimers()
    try {
      const { service, children, spawn } = bridge(20)
      const timeout = service.hitTest({ x: 0, y: 0 }, new Set())
      await vi.advanceTimersByTimeAsync(21)
      await expect(timeout).resolves.toBeNull()
      expect(children[0].kill).toHaveBeenCalledOnce()
      const restart = service.hitTest({ x: 1, y: 1 }, new Set())
      expect(spawn).toHaveBeenCalledTimes(2)
      children[1].stderr.emit('data', Buffer.alloc(16_385))
      await expect(restart).resolves.toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('keeps the first request alive through a normal PowerShell cold start', async () => {
    vi.useFakeTimers()
    try {
      const { service, children } = bridge()
      const pending = service.hitTest({ x: 10, y: 20 }, new Set())
      await vi.advanceTimersByTimeAsync(1_500)
      expect(children[0].kill).not.toHaveBeenCalled()
      reply(children[0], { requestId: 1, hit: { hwnd: '10077', processCreationIdentity: '132000000000000000', processId: 77, boundsPx: { x: 0, y: 0, width: 100, height: 100 } } })
      await expect(pending).resolves.toEqual({ hwnd: '10077', processCreationIdentity: '132000000000000000', processId: 77, boundsPx: { x: 0, y: 0, width: 100, height: 100 } })
    } finally { vi.useRealTimers() }
  })

  it('settles pending work exactly once and never respawns after idempotent disposal', async () => {
    const { service, children, spawn } = bridge()
    const pending = service.hitTest({ x: 0, y: 0 }, new Set())
    service.dispose(); service.dispose()
    await expect(pending).resolves.toBeNull()
    expect(children[0].kill).toHaveBeenCalledOnce()
    await expect(service.hitTest({ x: 0, y: 0 }, new Set())).resolves.toBeNull()
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('does not settle disposal until the owned PowerShell child has exited', async () => {
    const { service, children } = bridge()
    const pending = service.hitTest({ x: 0, y: 0 }, new Set())
    children[0].kill.mockImplementationOnce(() => { children[0].killed += 1 })
    const disposing = service.dispose()
    let disposed = false
    void disposing.then(() => { disposed = true })
    await expect(pending).resolves.toBeNull()
    expect(disposed).toBe(false)
    children[0].emit('exit', null)
    await disposing
    expect(disposed).toBe(true)
  })

  it('awaits every terminating bridge when a timed-out child exits after its replacement', async () => {
    vi.useFakeTimers()
    try {
      const { service, children } = bridge(20)
      const timedOut = service.hitTest({ x: 0, y: 0 }, new Set())
      children[0].kill.mockImplementationOnce(() => { children[0].killed += 1 })
      await vi.advanceTimersByTimeAsync(21)
      await expect(timedOut).resolves.toBeNull()

      const replacement = service.hitTest({ x: 1, y: 1 }, new Set())
      reply(children[1], { requestId: 2, hit: null })
      await expect(replacement).resolves.toBeNull()
      children[1].kill.mockImplementationOnce(() => { children[1].killed += 1 })
      let disposed = false
      const disposing = service.dispose().then(() => { disposed = true })
      children[1].emit('exit', null)
      await Promise.resolve()
      await Promise.resolve()
      expect(disposed).toBe(false)
      children[0].emit('exit', null)
      await disposing
      expect(disposed).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('treats a spawn error as a terminal child event and bounds disposal without a later exit', async () => {
    const { service, children } = bridge(undefined, false)
    const pending = service.hitTest({ x: 0, y: 0 }, new Set())
    children[0].kill.mockImplementationOnce(() => { children[0].killed += 1 })
    children[0].emit('error', new Error('spawn failed'))

    await expect(pending).resolves.toBeNull()
    await expect(service.dispose()).resolves.toBeUndefined()
  })

  it('does not treat a post-spawn error or failed kill as proof that the child exited', async () => {
    const { service, children } = bridge()
    const pending = service.hitTest({ x: 0, y: 0 }, new Set())
    children[0].kill.mockImplementationOnce(() => {
      children[0].killed += 1
      throw new Error('kill failed')
    })
    children[0].emit('error', new Error('post-spawn bridge error'))
    await expect(pending).resolves.toBeNull()

    let disposed = false
    const disposing = service.dispose().then(() => { disposed = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(disposed).toBe(false)
    children[0].emit('close', null)
    await disposing
    expect(disposed).toBe(true)
  })

  it('fails closed for bad inputs and script contains the persistent, bounded Win32 protocol', async () => {
    const { service, spawn } = bridge()
    await expect(service.hitTest({ x: 1.5, y: 0 }, new Set())).resolves.toBeNull()
    await expect(service.hitTest({ x: 0, y: 0 }, new Set(['0']))).resolves.toBeNull()
    expect(spawn).not.toHaveBeenCalled()
  })

  it.runIf(process.env.ARKDOWN_NATIVE_WINDOW_HIT_TEST === '1' && process.platform === 'win32')('PowerShell rejects case variants and scalar arrays while keeping the line bridge alive', async () => {
    const script = resolve(process.cwd(), 'scripts/windows-window-hit-test.ps1')
    const child = realSpawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'pipe', windowsHide: true })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stdin.end('{"RequestId":1,"x":0,"y":0,"excludedWindowHandles":[]}\n{"requestId":2,"x":0,"y":0,"excludedWindowHandles":1}\n{"requestId":3,"x":0,"y":0,"excludedWindowHandles":null}\n{"requestId":-1,"x":0,"y":0,"excludedWindowHandles":[]}\n{"requestId":9007199254740992,"x":0,"y":0,"excludedWindowHandles":[]}\n{"requestId":1.5,"x":0,"y":0,"excludedWindowHandles":[]}\n{"requestId":4,"x":0,"y":0,"excludedWindowHandles":[]}\n')
    await once(child, 'exit')
    const replies = Buffer.concat(chunks).toString('utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line))
    expect(replies.map((reply) => reply.requestId)).toEqual([0, 2, 3, 0, 0, 0, 4])
    expect(replies.every((reply) => Object.prototype.hasOwnProperty.call(reply, 'hit'))).toBe(true)
  })

  it('establishes Per-Monitor-V2 awareness before any native coordinate query and fails closed otherwise', () => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/windows-window-hit-test.ps1'), 'utf8')
    const initialize = source.indexOf('$script:DpiReady = Initialize-DpiAwareness')
    const readLoop = source.indexOf('while (($line = [Console]::In.ReadLine()) -ne $null)')
    const coordinateDispatch = source.indexOf('$hit = Get-Hit $request')
    expect(source).toContain('SetProcessDpiAwarenessContext')
    expect(source).toContain('SetLastError=true')
    expect(source).toContain('[IntPtr](-4)')
    expect(source).toContain('GetDpiAwarenessContextForProcess')
    expect(source).toContain('GetCurrentProcess')
    expect(source).toContain('AreDpiAwarenessContextsEqual')
    expect(source).toContain('[Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 5')
    expect(initialize).toBeGreaterThan(-1)
    expect(initialize).toBeLessThan(readLoop)
    expect(readLoop).toBeLessThan(coordinateDispatch)
    expect(source.indexOf('if (-not $script:DpiReady) { Write-NullReply $requestId; continue }'))
      .toBeLessThan(coordinateDispatch)
  })
})
