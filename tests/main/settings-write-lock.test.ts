// @vitest-environment node
import { fork } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Server } from 'node:net'
import path from 'node:path'
import { build } from 'rolldown'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { withSettingsWriteLock } from '../../src/main/settings/settings-write-lock'

// Windows pipe semantics are the product contract; no unsafe file-lock fallback on other OSes.
describe.skipIf(process.platform !== 'win32')('settings write lock', () => {
  let sandbox: string
  let workerPath: string
  beforeAll(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-lock-'))
    workerPath = path.join(sandbox, 'lock-worker.cjs')
    await build({ input: path.resolve('tests/fixtures/settings-lock-worker.ts'), platform: 'node',
      output: { file: workerPath, format: 'cjs' } })
  })
  afterAll(async () => { await rm(sandbox, { recursive: true, force: true }) })
  async function directory(name: string) {
    const root = path.join(sandbox, name)
    await mkdir(root)
    return root
  }
  function holder(root: string, timeout = 2000) {
    const child = fork(workerPath, [root, String(timeout)], {
      execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    const events: Array<{ event: string; code?: string; value?: string }> = []
    let stderr = ''
    child.stderr!.on('data', (data) => { stderr += String(data) })
    child.on('message', (message) => { events.push(message as typeof events[number]) })
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    return {
      events,
      async waitFor(event: string) {
        await vi.waitFor(() => expect(events.some((item) => item.event === event), stderr).toBe(true),
          { timeout: 4000, interval: 10 })
        return events.find((item) => item.event === event)!
      },
      async stop(crash = false) {
        if (child.exitCode !== null || child.signalCode !== null) return
        if (crash) child.kill('SIGKILL')
        else if (child.connected) child.send('release')
        const fallback = setTimeout(() => child.kill(), 5000)
        await exited
        clearTimeout(fallback)
      },
    }
  }

  it('keeps a second process outside until the first operation settles', async () => {
    const root = await directory('exclusive')
    // The operation outlives its own acquisition deadline while the second waiter times out.
    const first = holder(root, 80)
    let second: ReturnType<typeof holder> | undefined
    try {
      await first.waitFor('acquired')
      second = holder(root, 120)
      const result = await second.waitFor('error')
      expect(result.code).toBe('SETTINGS_LOCK_TIMEOUT')
      expect(second.events.some((item) => item.event === 'acquired')).toBe(false)
      await first.stop()
      await expect(withSettingsWriteLock(root, async () => 'next', 1000)).resolves.toBe('next')
    } finally { await first.stop(); await second?.stop() }
  })

  it('automatically releases ownership after the holding process is killed', async () => {
    const root = await directory('crash')
    const first = holder(root)
    try {
      await first.waitFor('acquired')
      await first.stop(true)
      await expect(withSettingsWriteLock(root, async () => 42, 1000)).resolves.toBe(42)
    } finally { await first.stop() }
  })

  it.each(['resolve', 'reject'] as const)('retains ownership across repeated accept errors until the operation can %s', async (outcome) => {
    const root = await directory(`accept-error-${outcome}`)
    const originalListen = Server.prototype.listen
    let ownedServer!: Server
    // Observe the actual server, forwarding every call to Node. No fake lock or transport.
    const observer = vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server, ...args) {
      ownedServer = this
      return Reflect.apply(originalListen, this, args) as Server
    })
    let release!: () => void
    const pendingWrite = new Promise<void>((resolve) => { release = resolve })
    let operationEntered = false
    let operationSettled = false
    const failure = new Error('synthetic operation rejection')
    const result = withSettingsWriteLock(root, async () => {
      operationEntered = true
      await pendingWrite
      if (outcome === 'reject') throw failure
      return 'committed'
    }, 1000).then(
      (value) => { operationSettled = true; return { value } },
      (error: unknown) => { operationSettled = true; return { error } },
    )
    let contender: ReturnType<typeof holder> | undefined
    try {
      await vi.waitFor(() => expect(operationEntered).toBe(true))
      observer.mockRestore()
      for (let index = 0; index < 2; index += 1) {
        // Node may emit accept errors after listening; ownership must outlive all of them.
        expect(() => ownedServer.emit('error', Object.assign(new Error('synthetic accept error'), { code: 'EIO' })))
          .not.toThrow()
        contender = holder(root, 100)
        await vi.waitFor(() => expect(contender!.events.some((event) =>
          event.event === 'acquired' || event.event === 'error')).toBe(true))
        expect(contender.events.find((event) => event.event !== 'waiting')).toEqual({
          event: 'error', code: 'SETTINGS_LOCK_TIMEOUT',
        })
        expect(operationSettled).toBe(false)
        await contender.stop()
      }
      release()
      if (outcome === 'reject') expect((await result as { error: unknown }).error).toBe(failure)
      else expect(await result).toEqual({ value: 'committed' })
      await expect(withSettingsWriteLock(root, async () => 'next', 500)).resolves.toBe('next')
    } finally {
      observer.mockRestore()
      release()
      await result
      await contender?.stop()
    }
  })

  it('times out without invoking or later orphaning the queued operation', async () => {
    const root = await directory('timeout')
    const first = holder(root)
    let invocations = 0
    try {
      await first.waitFor('acquired')
      const started = performance.now()
      await expect(withSettingsWriteLock(root, async () => { invocations += 1 }, 100))
        .rejects.toMatchObject({ code: 'SETTINGS_LOCK_TIMEOUT' })
      expect(performance.now() - started).toBeLessThan(1000)
      await first.stop()
      // A fresh waiter must acquire after the timeout; an orphan listener blocks it.
      await withSettingsWriteLock(root, async () => undefined, 500)
      expect(invocations).toBe(0)
    } finally { await first.stop() }
  })

  it('releases after rejected operations and serializes same-process contenders', async () => {
    const root = await directory('exception')
    const failure = new Error('synthetic write failed')
    await expect(withSettingsWriteLock(root, async () => { throw failure }, 500)).rejects.toBe(failure)
    let current = 0
    let peak = 0
    await Promise.all(Array.from({ length: 4 }, () => withSettingsWriteLock(root, async () => {
      current += 1
      peak = Math.max(peak, current)
      await new Promise((resolve) => setTimeout(resolve, 20))
      current -= 1
    }, 1000)))
    expect(peak).toBe(1)
  })

  it('does not share ownership between different data roots', async () => {
    const a = await directory('independent-a')
    const b = await directory('independent-b')
    await withSettingsWriteLock(a, async () => {
      await expect(withSettingsWriteLock(b, async () => 'independent', 150)).resolves.toBe('independent')
    }, 500)
  })

  it('treats junctions, path normalization and case aliases as the same directory', async () => {
    const root = await directory('AliasRoot')
    const alias = path.join(sandbox, 'junction')
    await symlink(root, alias, 'junction')
    const first = holder(root)
    try {
      await first.waitFor('acquired')
      for (const alternate of [alias, root.toUpperCase(), path.join(root, '..', 'AliasRoot') + path.sep]) {
        await expect(withSettingsWriteLock(alternate, async () => undefined, 60))
          .rejects.toMatchObject({ code: 'SETTINGS_LOCK_TIMEOUT' })
      }
    } finally { await first.stop() }
  })

  it('rejects reentrant acquisition instead of deadlocking the owning operation', async () => {
    const root = await directory('reentrant')
    await withSettingsWriteLock(root, async () => {
      await expect(withSettingsWriteLock(root, async () => undefined, 500))
        .rejects.toMatchObject({ code: 'SETTINGS_LOCK_REENTRANT' })
    }, 1000)
  })

  it('fails closed for invalid deadlines or non-directory identities', async () => {
    const root = await directory('invalid')
    for (const timeout of [0, -1, NaN, Infinity, 2 ** 31]) {
      await expect(withSettingsWriteLock(root, async () => undefined, timeout))
        .rejects.toMatchObject({ code: 'SETTINGS_LOCK_INVALID_TIMEOUT' })
    }
    const file = path.join(root, 'file')
    await writeFile(file, 'synthetic')
    await expect(withSettingsWriteLock(file, async () => undefined, 200))
      .rejects.toMatchObject({ code: 'SETTINGS_LOCK_IDENTITY_FAILED' })
  })
})
