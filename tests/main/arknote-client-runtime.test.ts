import path from 'node:path'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ default: { spawn: spawnMock }, spawn: spawnMock }))
import {
  ArknoteClientRuntime,
  registerArknoteClientShutdown,
  type ArknoteClientTransport,
} from '../../src/main/arknote/arknote-client-runtime'
import {
  acquireArknoteSingleInstance,
  arknoteSingleInstanceData,
} from '../../src/main/arknote/arknote-second-instance'

const TOKEN = 'a'.repeat(64)
const EXECUTABLE_PATH = 'C:\\Portable\\Arkdown.exe'

function missingFile(): NodeJS.ErrnoException {
  return Object.assign(new Error('missing'), { code: 'ENOENT' })
}

function launchedProcess() {
  return Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    unref: vi.fn(),
    kill: vi.fn(),
  })
}

function transport(connect: () => Promise<void> = async () => undefined) {
  let disconnect: (() => void) | undefined
  let eventListener: ((event: unknown) => void) | undefined
  const value: ArknoteClientTransport = {
    connect: vi.fn(connect),
    request: vi.fn(async (_command, _payload, parser) => {
      const parsed = parser(null)
      if (parsed === undefined) throw new Error('invalid fixture')
      return parsed
    }),
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      eventListener = listener
      return () => { if (eventListener === listener) eventListener = undefined }
    }),
    close: vi.fn(),
  }
  return {
    value,
    installDisconnect(listener: () => void) { disconnect = listener },
    disconnect() { disconnect?.() },
    emit(event: unknown) { eventListener?.(event) },
  }
}

describe('ArknoteClientRuntime', () => {
  it('rejects a connection stopped during initial theme synchronization without replaying queued mutations', async () => {
    let finishTheme!: () => void
    const client = transport()
    const launch = vi.fn()
    const runtime = new ArknoteClientRuntime({ executablePath: EXECUTABLE_PATH,
      readToken: async () => TOKEN, launch,
      onConnected: () => new Promise<void>((resolve) => { finishTheme = resolve }),
      createClient: options => { client.installDisconnect(options.onDisconnect); return client.value },
    })
    const connection = runtime.ensureStarted().then(() => 'resolved', () => 'rejected')
    const result = runtime.request('note.delete', { noteId: 'old-note' }, value => value === null ? null : undefined)
      .then(() => 'resolved', () => 'rejected')
    await vi.waitFor(() => expect(finishTheme).toBeTypeOf('function'))
    client.emit({ type: 'service-stopping' })
    finishTheme()
    expect(await connection).toBe('rejected')
    expect(await result).toBe('rejected')
    expect(runtime.isConnected).toBe(false)
    expect(client.value.request).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    runtime.dispose()
  })

  it('synchronizes each successful connection without restarting a deliberately stopped service', async () => {
    const client = transport()
    const launch = vi.fn()
    const onConnected = vi.fn(async (value: ArknoteClientTransport) => { await value.request('settings.box-theme', { mode: 'dark', themeColor: '#2563EB' }, value => value === null ? null : undefined) })
    const runtime = new ArknoteClientRuntime({ executablePath: EXECUTABLE_PATH, readToken: async () => TOKEN,
      launch, onConnected, createClient: options => { client.installDisconnect(options.onDisconnect); return client.value } })
    expect(runtime.isConnected).toBe(false)
    await runtime.ensureStarted()
    expect(runtime.isConnected).toBe(true)
    expect(onConnected).toHaveBeenCalledOnce()
    await runtime.ensureStarted()
    expect(onConnected).toHaveBeenCalledOnce()
    client.emit({ type: 'service-stopping' })
    expect(runtime.isConnected).toBe(false)
    expect(launch).not.toHaveBeenCalled()
    await runtime.ensureStarted()
    expect(onConnected).toHaveBeenCalledTimes(2)
    runtime.dispose()
    expect(runtime.isConnected).toBe(false)
  })
  it('handles an asynchronous executable spawn error until the bounded timeout', async () => {
    let now = 0
    const child = launchedProcess()
    const once = vi.spyOn(child, 'once')
    spawnMock.mockReturnValueOnce(child)
    const runtime = new ArknoteClientRuntime({
      executablePath: EXECUTABLE_PATH,
      connectionTimeoutMs: 50,
      retryDelayMs: 25,
      now: () => now,
      access: vi.fn(async () => undefined),
      readToken: vi.fn(async () => { throw missingFile() }),
      delay: vi.fn(async (milliseconds) => {
        now += milliseconds
        if (now === 25) child.emit('error', new Error('spawn failed'))
      }),
      createClient: () => transport().value,
    })

    await expect(runtime.ensureStarted()).rejects.toThrow('无法启动 Arknote')
    expect(once).toHaveBeenCalledWith('error', expect.any(Function))
    expect(child.listenerCount('exit')).toBe(0)
    runtime.dispose()
  })

  it('lazily launches the same-directory Arknote.exe and connects after its token appears', async () => {
    const client = transport()
    const launch = vi.fn()
    const readToken = vi.fn()
      .mockRejectedValueOnce(missingFile())
      .mockResolvedValue(TOKEN)
    const runtime = new ArknoteClientRuntime({
      executablePath: EXECUTABLE_PATH,
      access: vi.fn(async () => undefined),
      readToken,
      launch,
      delay: vi.fn(async () => undefined),
      createClient: (options) => {
        client.installDisconnect(options.onDisconnect)
        return client.value
      },
    })

    await runtime.openBox()

    expect(launch).toHaveBeenCalledWith(
      path.win32.join('C:\\Portable', 'Arknote.exe'),
      ['--arkdown-autostart'],
    )
    expect(client.value.connect).toHaveBeenCalledTimes(1)
  })


  it.each(['error', 'exit', 'throw'] as const)('retries a definite launch %s within the original deadline', async (failure) => {
    let now = 0
    const launchTimes: number[] = []
    const children: ReturnType<typeof launchedProcess>[] = []
    const launch = vi.fn(() => {
      launchTimes.push(now)
      if (failure === 'throw') throw new Error('spawn failed')
      const child = launchedProcess()
      children.push(child)
      return child
    })
    const runtime = new ArknoteClientRuntime({
      executablePath: EXECUTABLE_PATH,
      connectionTimeoutMs: 1_100,
      retryDelayMs: 100,
      now: () => now,
      access: vi.fn(async () => undefined),
      readToken: vi.fn(async () => { throw missingFile() }),
      launch,
      delay: vi.fn(async (milliseconds) => {
        now += milliseconds
        const child = children.at(-1)
        if (child && child.exitCode === null) {
          child.exitCode = 1
          child.emit(failure, failure === 'error' ? new Error('spawn failed') : 1)
        }
      }),
      createClient: () => transport().value,
    })

    await expect(runtime.ensureStarted()).rejects.toThrow('无法启动 Arknote')

    expect(launch).toHaveBeenCalledTimes(3)
    expect(launchTimes).toEqual([0, 500, 1_000])
    expect(now).toBe(1_100)
    for (const child of children) {
      expect(child.listenerCount('exit')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
    }
    runtime.dispose()
  })

  it('shares one slow healthy launch between concurrent callers without opening an Arknote surface', async () => {
    let now = 0
    let serviceStarting = false
    let secondInstance: ((
      event: unknown,
      argv: string[],
      cwd: string,
      additionalData: unknown,
    ) => void) | undefined
    const openedSurfaces: string[] = []
    const child = launchedProcess()
    const app = {
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn((event: 'second-instance', listener: typeof secondInstance) => {
        if (event === 'second-instance') secondInstance = listener
      }),
      quit: vi.fn(),
    }
    const launch = vi.fn((_executablePath: string, args: readonly string[]) => {
      if (!serviceStarting) {
        serviceStarting = true
        acquireArknoteSingleInstance(
          app,
          ['Arknote.exe', ...args],
          (command) => openedSurfaces.push(command),
        )
        return child
      }
      secondInstance?.({}, [], '', arknoteSingleInstanceData(['Arknote.exe', ...args]))
      return child
    })
    const client = transport()
    const runtime = new ArknoteClientRuntime({
      executablePath: EXECUTABLE_PATH,
      connectionTimeoutMs: 1_200,
      retryDelayMs: 100,
      now: () => now,
      access: vi.fn(async () => undefined),
      readToken: vi.fn(async () => {
        if (now < 600) throw missingFile()
        return TOKEN
      }),
      launch,
      delay: vi.fn(async (milliseconds) => { now += milliseconds }),
      createClient: () => client.value,
    })

    const first = runtime.ensureStarted()
    expect(runtime.ensureStarted()).toBe(first)
    await first

    expect(launch).toHaveBeenCalledTimes(1)
    expect(client.value.connect).toHaveBeenCalledOnce()
    expect(openedSurfaces).toEqual([])
    runtime.dispose()
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('keeps a live process across startup timeouts and reconnects after its pipe becomes ready', async () => {
    let now = 0
    let ready = false
    const child = launchedProcess()
    const launch = vi.fn(() => child)
    const client = transport()
    const runtime = new ArknoteClientRuntime({
      executablePath: EXECUTABLE_PATH,
      connectionTimeoutMs: 700,
      retryDelayMs: 100,
      now: () => now,
      access: async () => undefined,
      readToken: async () => { if (!ready) throw missingFile(); return TOKEN },
      launch,
      delay: async (milliseconds) => { now += milliseconds },
      createClient: (options) => { client.installDisconnect(options.onDisconnect); return client.value },
    })

    await expect(runtime.ensureStarted()).rejects.toThrow('无法启动 Arknote')
    expect(now).toBe(700)
    await expect(runtime.ensureStarted()).rejects.toThrow('无法启动 Arknote')
    expect(now).toBe(1_400)
    ready = true
    await runtime.ensureStarted()
    client.disconnect()
    ready = false
    await expect(runtime.ensureStarted()).rejects.toThrow('无法启动 Arknote')
    expect(launch).toHaveBeenCalledOnce()
    child.exitCode = 0
    child.emit('exit', 0)
    launch.mockImplementation(() => { ready = true; return launchedProcess() })
    await runtime.ensureStarted()
    expect(runtime.isConnected).toBe(true)
    expect(launch).toHaveBeenCalledTimes(2)
    runtime.dispose()
  })

  it('does not relaunch at the deadline after a failed pipe connection consumes the remaining time', async () => {
    let now = 0
    const child = launchedProcess()
    const launch = vi.fn(() => child)
    let tokenReads = 0
    const runtime = new ArknoteClientRuntime({
      executablePath: EXECUTABLE_PATH,
      connectionTimeoutMs: 700,
      now: () => now,
      access: async () => undefined,
      readToken: async () => { if (++tokenReads === 1) throw missingFile(); return TOKEN },
      launch,
      createClient: () => transport(async () => {
        child.exitCode = 1
        child.emit('exit', 1)
        now = 700
        throw new Error('pipe unavailable')
      }).value,
    })

    await expect(runtime.ensureStarted()).rejects.toThrow('无法启动 Arknote')
    expect(launch).toHaveBeenCalledOnce()
    runtime.dispose()
  })

  it('does not launch if disposed while executable access is pending', async () => {
    let finishAccess!: () => void
    const launch = vi.fn(() => launchedProcess())
    const runtime = new ArknoteClientRuntime({
      executablePath: EXECUTABLE_PATH,
      readToken: async () => { throw missingFile() },
      access: () => new Promise<void>((resolve) => { finishAccess = resolve }),
      launch,
    })
    const starting = runtime.ensureStarted()
    await vi.waitFor(() => expect(finishAccess).toBeTypeOf('function'))
    runtime.dispose()
    finishAccess()
    await expect(starting).rejects.toThrow('Arknote client is disposed')
    expect(launch).not.toHaveBeenCalled()
  })

  it('does not create a connection if disposed while token reading is pending', async () => {
    let finishRead!: (token: string) => void
    const createClient = vi.fn(() => transport().value)
    const runtime = new ArknoteClientRuntime({
      executablePath: EXECUTABLE_PATH,
      readToken: () => new Promise<string>((resolve) => { finishRead = resolve }),
      createClient,
    })
    const starting = runtime.ensureStarted()
    await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'))
    runtime.dispose()
    finishRead(TOKEN)
    await expect(starting).rejects.toThrow('Arknote client is disposed')
    expect(createClient).not.toHaveBeenCalled()
  })

  it('reports a bounded startup failure when the service never becomes connectable', async () => {
    let now = 0
    const runtime = new ArknoteClientRuntime({
      executablePath: EXECUTABLE_PATH,
      connectionTimeoutMs: 100,
      retryDelayMs: 25,
      now: () => now,
      access: vi.fn(async () => undefined),
      readToken: vi.fn(async () => { throw missingFile() }),
      launch: vi.fn(),
      delay: vi.fn(async (milliseconds) => { now += milliseconds }),
      createClient: () => transport().value,
    })

    await expect(runtime.ensureStarted()).rejects.toThrow('无法启动 Arknote')
    expect(now).toBe(100)
  })

  it('settles at the total deadline when token reading never resolves', async () => {
    vi.useFakeTimers()
    try {
      let outcome = 'pending'
      const access = vi.fn(async () => undefined)
      const runtime = new ArknoteClientRuntime({
        executablePath: EXECUTABLE_PATH,
        connectionTimeoutMs: 100,
        access,
        readToken: vi.fn(() => new Promise<string>(() => undefined)),
      })
      void runtime.ensureStarted().then(
        () => { outcome = 'resolved' },
        (error: Error) => { outcome = error.message },
      )

      await vi.advanceTimersByTimeAsync(100)

      expect(outcome).toBe('无法启动 Arknote')
      expect(access).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles at the same total deadline when executable access never resolves', async () => {
    vi.useFakeTimers()
    try {
      let outcome = 'pending'
      const access = vi.fn(() => new Promise<void>(() => undefined))
      const runtime = new ArknoteClientRuntime({
        executablePath: EXECUTABLE_PATH,
        connectionTimeoutMs: 100,
        access,
        readToken: vi.fn(async () => { throw missingFile() }),
      })
      void runtime.ensureStarted().then(
        () => { outcome = 'resolved' },
        (error: Error) => { outcome = error.message },
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(access).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(100)

      expect(outcome).toBe('无法启动 Arknote')
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses connectionTimeoutMs as one total ensureStarted deadline', async () => {
    let now = 0
    const launch = vi.fn()
    const blocked = transport(async () => { now += 100; throw new Error('connect timeout') })
    const runtime = new ArknoteClientRuntime({
      executablePath: EXECUTABLE_PATH,
      connectionTimeoutMs: 100,
      now: () => now,
      access: vi.fn(async () => undefined),
      readToken: vi.fn(async () => TOKEN),
      launch,
      createClient: () => blocked.value,
    })

    await expect(runtime.ensureStarted()).rejects.toThrow('无法启动 Arknote')
    expect(now).toBe(100)
    expect(launch).not.toHaveBeenCalled()
  })

  it('stays usable after a cancelled quit and disposes once when quit becomes irrevocable', async () => {
    const listeners = new Map<string, () => void>()
    const appLifecycle = {
      once: vi.fn((event: 'will-quit', listener: () => void) => {
        listeners.set(event, () => {
          listeners.delete(event)
          listener()
        })
      }),
      emit(event: string) { listeners.get(event)?.() },
    }
    const client = transport()
    const runtime = new ArknoteClientRuntime({
      executablePath: EXECUTABLE_PATH,
      readToken: vi.fn(async () => TOKEN),
      createClient: () => client.value,
    })
    const dispose = vi.spyOn(runtime, 'dispose')
    registerArknoteClientShutdown(appLifecycle, runtime)

    appLifecycle.emit('before-quit')
    await expect(runtime.openBox()).resolves.toBeUndefined()
    appLifecycle.emit('will-quit')
    appLifecycle.emit('will-quit')

    expect(dispose).toHaveBeenCalledOnce()
    expect(client.value.close).toHaveBeenCalledOnce()
    await expect(runtime.openBox()).rejects.toThrow('Arknote client is disposed')
  })

  it('stops retrying when disposed during startup', async () => {
    let now = 0
    let runtime!: ArknoteClientRuntime
    const delay = vi.fn(async (milliseconds: number) => {
      now += milliseconds
      runtime.dispose()
    })
    runtime = new ArknoteClientRuntime({
      executablePath: EXECUTABLE_PATH,
      connectionTimeoutMs: 100,
      retryDelayMs: 25,
      now: () => now,
      access: vi.fn(async () => undefined),
      readToken: vi.fn(async () => { throw missingFile() }),
      launch: vi.fn(),
      delay,
      createClient: () => transport().value,
    })

    await expect(runtime.ensureStarted()).rejects.toThrow('Arknote client is disposed')
    expect(delay).toHaveBeenCalledTimes(1)
  })

  it('closes an in-flight connection attempt when disposed', async () => {
    let rejectConnect: ((error: Error) => void) | undefined
    const client = transport(() => new Promise<void>((_resolve, reject) => { rejectConnect = reject }))
    const runtime = new ArknoteClientRuntime({
      executablePath: EXECUTABLE_PATH,
      readToken: vi.fn(async () => TOKEN),
      createClient: () => client.value,
    })

    const starting = runtime.ensureStarted()
    await vi.waitFor(() => expect(client.value.connect).toHaveBeenCalledTimes(1))
    runtime.dispose()
    const closeCalls = vi.mocked(client.value.close).mock.calls.length
    rejectConnect?.(new Error('closed'))
    await expect(starting).rejects.toThrow('Arknote client is disposed')
    expect(closeCalls).toBe(1)
  })

  it('does not launch when the same-directory executable is missing', async () => {
    const launch = vi.fn()
    const runtime = new ArknoteClientRuntime({
      executablePath: EXECUTABLE_PATH,
      access: vi.fn(async () => { throw missingFile() }),
      readToken: vi.fn(async () => { throw missingFile() }),
      launch,
      createClient: () => transport().value,
    })

    await expect(runtime.openBox()).rejects.toThrow('无法启动 Arknote')
    expect(launch).not.toHaveBeenCalled()
  })

  it('invalidates a stopping client before pipe close and reconnects without a second lifecycle event', async () => {
    const stopping = transport()
    const fresh = transport()
    const clients = [stopping, fresh]
    const events: unknown[] = []
    const runtime = new ArknoteClientRuntime({
      executablePath: EXECUTABLE_PATH,
      readToken: vi.fn(async () => TOKEN),
      createClient: (options) => {
        const client = clients.shift()
        if (!client) throw new Error('unexpected client')
        client.installDisconnect(options.onDisconnect)
        return client.value
      },
    })
    runtime.subscribe((event) => events.push(event))

    await runtime.openBox()
    stopping.emit({ type: 'service-stopping' })
    await runtime.openBox()
    stopping.disconnect()

    expect(stopping.value.close).toHaveBeenCalledOnce()
    expect(fresh.value.connect).toHaveBeenCalledOnce()
    expect(events).toEqual([{ type: 'service-stopping' }])
  })

  it('emits one strict disconnect event and reconnects on the next open request', async () => {
    const first = transport()
    const unavailable = transport(async () => { throw new Error('pipe unavailable') })
    const reconnected = transport()
    const clients = [first, unavailable, reconnected]
    const events: unknown[] = []
    const launch = vi.fn()
    const runtime = new ArknoteClientRuntime({
      executablePath: EXECUTABLE_PATH,
      access: vi.fn(async () => undefined),
      readToken: vi.fn(async () => TOKEN),
      launch,
      delay: vi.fn(async () => undefined),
      createClient: (options) => {
        const client = clients.shift()
        if (!client) throw new Error('unexpected client')
        client.installDisconnect(options.onDisconnect)
        return client.value
      },
    })
    runtime.subscribe((event) => events.push(event))

    await runtime.openBox()
    first.disconnect()
    first.disconnect()
    await runtime.openBox()

    expect(events).toEqual([{ type: 'service-disconnected' }])
    expect(unavailable.value.connect).toHaveBeenCalledTimes(1)
    expect(reconnected.value.connect).toHaveBeenCalledTimes(1)
    expect(launch).toHaveBeenCalledTimes(1)
  })
})
