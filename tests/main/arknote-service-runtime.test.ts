import { describe, expect, it, vi } from 'vitest'
import {
  ArknoteMutationGateRegistry,
  ArknoteServiceRuntime,
  createArknoteSaveCoordinator,
  initialArknoteLaunchCommand,
} from '../../src/main/arknote/arknote-service-runtime'

function harness() {
  const order: string[] = []
  const options = {
    launchArguments: ['Arknote.exe', '--arkdown-autostart'],
    store: { initialize: vi.fn(async () => { order.push('store') }) },
    session: {
      restore: vi.fn(async () => { order.push('restore'); return 0 }),
      captureAndFlush: vi.fn(async () => { order.push('flush') }),
    },
    pipe: {
      start: vi.fn(async () => { order.push('pipe-start') }),
      stop: vi.fn(async () => { order.push('pipe-stop') }),
      broadcast: vi.fn((event: unknown) => {
        order.push(`broadcast:${String((event as { type?: string }).type)}`)
      }),
    },
    tray: {
      initialize: vi.fn(() => { order.push('tray-start') }),
      destroy: vi.fn(() => { order.push('tray-destroy') }),
    },
    windows: {
      closeAll: vi.fn(async () => { order.push('windows-close') }),
    },
    mutations: {
      pauseAndDrain: vi.fn(async () => { order.push('mutations-pause') }),
      resume: vi.fn(() => { order.push('mutations-resume') }),
    },
    openBox: vi.fn(async () => { order.push('box') }),
    createNote: vi.fn(async () => { order.push('create') }),
    openSettings: vi.fn(async () => { order.push('settings') }),
    quitApp: vi.fn(() => { order.push('quit') }),
  }
  return { runtime: new ArknoteServiceRuntime(options), options, order }
}

describe('ArknoteServiceRuntime', () => {
  it('acknowledges saved and closed note windows before update quit, without recapturing an empty session', async () => {
    const { runtime, options } = harness()
    await runtime.initialize(); await runtime.prepareUpdateQuit()
    expect(options.session.captureAndFlush).toHaveBeenCalledOnce()
    expect(options.windows.closeAll).toHaveBeenCalledWith({ flush: false, preserveSessionState: true })
    expect(options.pipe.stop).not.toHaveBeenCalled(); expect(options.quitApp).not.toHaveBeenCalled()
    expect(options.pipe.broadcast).not.toHaveBeenCalled()
    await runtime.flushAndQuit()
    expect(options.session.captureAndFlush).toHaveBeenCalledOnce(); expect(options.quitApp).toHaveBeenCalledOnce()
  })
  it('restores note admission and saved window state if an update handoff is cancelled', async () => {
    const { runtime, options } = harness()
    await runtime.initialize(); await runtime.prepareUpdateQuit(); await runtime.cancelUpdateQuit()
    expect(options.mutations.resume).toHaveBeenCalled()
    expect(options.session.restore).toHaveBeenCalledTimes(2)
    await runtime.execute('new-note'); expect(options.createNote).toHaveBeenCalledOnce()
  })
  it('initializes store, pipe, tray, and saved note session before accepting commands', async () => {
    const { runtime, options, order } = harness()

    await runtime.initialize()

    expect(order).toEqual(['store', 'pipe-start', 'tray-start', 'restore'])
    expect(options.session.restore).toHaveBeenCalledWith(options.launchArguments)
  })

  it('restores displayed notes on an ordinary Arknote service start', async () => {
    const { runtime, options } = harness()
    options.launchArguments.splice(0, options.launchArguments.length, 'Arknote.exe')

    await runtime.initialize()

    expect(options.session.restore).toHaveBeenCalledWith([
      'Arknote.exe',
      '--arkdown-autostart',
    ])
  })
  it('executes the three supported launch commands', async () => {
    const { runtime, order } = harness()

    await runtime.execute('open-box')
    await runtime.execute('new-note')
    await runtime.execute('open-settings')

    expect(order).toEqual([
      'store',
      'pipe-start',
      'tray-start',
      'restore',
      'box',
      'create',
      'settings',
    ])
  })

  it('waits for initialization and executes concurrent launch commands in strict FIFO order', async () => {
    const { runtime, options, order } = harness()
    let finishStore: (() => void) | undefined
    let finishCreate: (() => void) | undefined
    options.store.initialize.mockImplementationOnce(() => {
      order.push('store')
      return new Promise<void>((resolve) => { finishStore = resolve })
    })
    options.createNote.mockImplementationOnce(() => {
      order.push('create')
      return new Promise<void>((resolve) => { finishCreate = resolve })
    })

    const first = runtime.execute('new-note')
    const second = runtime.execute('open-box')
    await vi.waitFor(() => expect(options.store.initialize).toHaveBeenCalledTimes(1))
    expect(options.createNote).not.toHaveBeenCalled()
    expect(options.openBox).not.toHaveBeenCalled()

    finishStore?.()
    await vi.waitFor(() => expect(options.createNote).toHaveBeenCalledTimes(1))
    expect(options.openBox).not.toHaveBeenCalled()

    finishCreate?.()
    await Promise.all([first, second])
    expect(order).toEqual([
      'store',
      'pipe-start',
      'tray-start',
      'restore',
      'create',
      'box',
    ])
  })

  it('drains all mutation gates before capture and rejects tray or second-instance commands', async () => {
    const { runtime, options } = harness()
    let finishDrain: (() => void) | undefined
    options.mutations.pauseAndDrain.mockImplementationOnce(() => (
      new Promise<void>((resolve) => { finishDrain = resolve })
    ))

    const quitting = runtime.flushAndQuit()
    await vi.waitFor(() => expect(options.mutations.pauseAndDrain).toHaveBeenCalledTimes(1))

    await expect(runtime.execute('new-note')).rejects.toThrow('Arknote 正在退出')
    expect(options.session.captureAndFlush).not.toHaveBeenCalled()

    finishDrain?.()
    await quitting
    expect(options.session.captureAndFlush).toHaveBeenCalledTimes(1)
  })
  it('blocks shutdown when a save fails, leaving windows, tray, and process alive', async () => {
    const { runtime, options, order } = harness()
    options.session.captureAndFlush.mockRejectedValueOnce(new Error('disk full'))

    await expect(runtime.flushAndQuit()).rejects.toThrow('disk full')

    expect(order).toEqual(['mutations-pause', 'mutations-resume'])
    expect(options.session.captureAndFlush).toHaveBeenCalledTimes(1)
    expect(options.windows.closeAll).not.toHaveBeenCalled()
    expect(options.tray.destroy).not.toHaveBeenCalled()
    expect(options.pipe.stop).not.toHaveBeenCalled()
    expect(options.quitApp).not.toHaveBeenCalled()
  })

  it.each([
    'capture',
    'broadcast',
    'windows',
    'tray',
    'pipe',
    'quit',
  ] as const)('allows a deterministic retry when %s fails during shutdown', async (point) => {
    const { runtime, options } = harness()
    const failure = new Error(point + ' failed')
    switch (point) {
      case 'capture':
        options.session.captureAndFlush.mockRejectedValueOnce(failure)
        break
      case 'broadcast':
        options.pipe.broadcast.mockImplementationOnce(() => { throw failure })
        break
      case 'windows':
        options.windows.closeAll.mockRejectedValueOnce(failure)
        break
      case 'tray':
        options.tray.destroy.mockImplementationOnce(() => { throw failure })
        break
      case 'pipe':
        options.pipe.stop.mockRejectedValueOnce(failure)
        break
      case 'quit':
        options.quitApp.mockImplementationOnce(() => { throw failure })
        break
    }

    await expect(runtime.flushAndQuit()).rejects.toThrow(point + ' failed')
    await expect(runtime.execute('open-settings')).resolves.toBeUndefined()
    await expect(runtime.flushAndQuit()).resolves.toBeUndefined()

    expect(options.mutations.pauseAndDrain).toHaveBeenCalledTimes(2)
    expect(options.mutations.resume).toHaveBeenCalledTimes(1)
    expect(options.session.captureAndFlush).toHaveBeenCalledTimes(2)
  })

  it('flushes, broadcasts, and closes only Arknote-owned resources on successful exit', async () => {
    const { runtime, options, order } = harness()

    await runtime.flushAndQuit()

    expect(order).toEqual([
      'mutations-pause',
      'flush',
      'windows-close',
      'broadcast:service-stopping',
      'tray-destroy',
      'pipe-stop',
      'quit',
    ])
    expect(options.windows.closeAll).toHaveBeenCalledWith({
      flush: false,
      preserveSessionState: true,
    })
  })
})

describe('ArknoteMutationGateRegistry', () => {
  it('drains a gate registered while an existing gate is still draining', async () => {
    let finishFirst: (() => void) | undefined
    const firstPending = new Promise<void>((resolve) => { finishFirst = resolve })
    const first = { pauseAndDrain: vi.fn(() => firstPending), resume: vi.fn() }
    const second = { pauseAndDrain: vi.fn(async () => undefined), resume: vi.fn() }
    const registry = new ArknoteMutationGateRegistry()
    registry.register(first)

    const draining = registry.pauseAndDrain()
    await vi.waitFor(() => expect(first.pauseAndDrain).toHaveBeenCalledTimes(1))
    registry.register(second)
    finishFirst?.()

    await draining
    expect(second.pauseAndDrain).toHaveBeenCalledTimes(1)
    registry.resume()
    expect(first.resume).toHaveBeenCalledTimes(1)
    expect(second.resume).toHaveBeenCalledTimes(1)
  })
})
describe('initialArknoteLaunchCommand', () => {
  it('opens the box for a direct launch and preserves explicit launch commands', () => {
    expect(initialArknoteLaunchCommand(['Arknote.exe'])).toBe('open-box')
    expect(initialArknoteLaunchCommand(['Arknote.exe', '--arkdown-autostart'])).toBeUndefined()
    expect(initialArknoteLaunchCommand(['Arknote.exe', '--open-box'])).toBe('open-box')
    expect(initialArknoteLaunchCommand(['Arknote.exe', '--new-note'])).toBe('new-note')
    expect(initialArknoteLaunchCommand(['Arknote.exe', '--open-settings'])).toBe('open-settings')
  })
})
describe('createArknoteSaveCoordinator', () => {
  it('saves after 2000ms of inactivity and keeps the five-second safety snapshot', async () => {
    vi.useFakeTimers()
    try {
      const writeMarkdown = vi.fn(async () => ({}) as never)
      const coordinator = createArknoteSaveCoordinator({ writeMarkdown })
      const noteId = '123e4567-e89b-42d3-a456-426614174000'

      coordinator.stage(noteId, 'first')
      await vi.advanceTimersByTimeAsync(1_999)
      expect(writeMarkdown).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(writeMarkdown).toHaveBeenCalledTimes(1)

      coordinator.stage(noteId, 'second')
      for (let second = 1; second <= 5; second += 1) {
        await vi.advanceTimersByTimeAsync(1_000)
        if (second < 5) coordinator.stage(noteId, `second-${second}`)
      }
      expect(writeMarkdown).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
