import { describe, expect, it, vi } from 'vitest'
import { BackgroundSettingsWindowRegistry } from '../../src/main/backgrounds/background-settings-window-registry'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'
import type { BackgroundIpcService } from '../../src/main/ipc/register-ipc'
import { BackgroundWorkflow } from '../../src/main/backgrounds/background-workflow'
import { EventEmitter } from 'node:events'

const NOTE_ID = '00000000-0000-4000-8000-000000000001'
const main = { kind: 'main' as const }
const sticky = { kind: 'sticky-note' as const, noteId: NOTE_ID }
const presentation = { settings: DEFAULT_BACKGROUND_SETTINGS, imageUrl: null }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function harness(options: { begin?: () => Promise<typeof presentation> } = {}) {
  const listeners = new Map<string, () => void>()
  const window = {
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(() => listeners.get('closed')?.()),
    once: vi.fn((event: string, listener: () => void) => { listeners.set(event, listener) }),
  }
  const workflow = {
    begin: vi.fn(async () => options.begin ? options.begin() : presentation),
    getSession: vi.fn(async () => presentation),
    get: vi.fn(async () => presentation),
    choose: vi.fn(async () => presentation),
    remove: vi.fn(async () => presentation),
    preview: vi.fn(async () => undefined),
    apply: vi.fn(async () => presentation),
    cancel: vi.fn(async () => undefined),
    end: vi.fn(),
  }
  const registration = { dispose: vi.fn() }
  const createWindow = vi.fn(() => window)
  let scopedService: BackgroundIpcService | undefined
  const register = vi.fn((_window: typeof window, service: BackgroundIpcService) => {
    scopedService = service
    return registration
  })
  const reportError = vi.fn()
  const registry = new BackgroundSettingsWindowRegistry({
    workflow,
    createWindow,
    register,
    reportError,
  })
  const originDeliver = vi.fn()
  return {
    registry,
    workflow,
    window,
    listeners,
    registration,
    createWindow,
    register,
    reportError,
    originDeliver,
    get scopedService() { return scopedService },
  }
}

describe('BackgroundSettingsWindowRegistry', () => {
  it('begins before creating and registering one target window, then reuses it on repeat open', async () => {
    const harnessed = harness()
    const service = harnessed.registry.serviceFor(harnessed.originDeliver)

    await service.open(main)

    expect(harnessed.workflow.begin).toHaveBeenCalledWith(main, harnessed.originDeliver, expect.any(Object))
    expect(harnessed.createWindow).toHaveBeenCalledWith(main)
    expect(harnessed.register).toHaveBeenCalledWith(harnessed.window, expect.any(Object))
    expect(harnessed.window.show).not.toHaveBeenCalled()

    harnessed.listeners.get('ready-to-show')?.()
    expect(harnessed.window.show).toHaveBeenCalledOnce()

    await service.open(main)
    expect(harnessed.createWindow).toHaveBeenCalledOnce()
    expect(harnessed.window.show).toHaveBeenCalledTimes(2)
    expect(harnessed.window.focus).toHaveBeenCalledOnce()
  })

  it('coalesces concurrent opens for the same target before a window exists', async () => {
    const start = deferred<typeof presentation>()
    const harnessed = harness({ begin: () => start.promise })
    const service = harnessed.registry.serviceFor(harnessed.originDeliver)

    const first = service.open(sticky)
    const second = service.open(sticky)
    expect(harnessed.workflow.begin).toHaveBeenCalledOnce()
    expect(harnessed.createWindow).not.toHaveBeenCalled()

    start.resolve(presentation)
    await Promise.all([first, second])
    expect(harnessed.createWindow).toHaveBeenCalledOnce()
  })

  it('binds registered IPC operations to one target and leaves the settings window open after apply', async () => {
    const harnessed = harness()
    await harnessed.registry.serviceFor(harnessed.originDeliver).open(main)
    const scoped = harnessed.scopedService
    if (!scoped) throw new Error('Expected settings IPC to be registered')

    await expect(scoped.choose(sticky)).rejects.toThrow('target')
    await scoped.choose(main)
    await scoped.remove(main)
    await scoped.preview(main, { ...DEFAULT_BACKGROUND_SETTINGS, imageOpacityPercent: 44 })
    await scoped.apply(main, DEFAULT_BACKGROUND_SETTINGS)

    expect(harnessed.workflow.choose).toHaveBeenCalledWith(main)
    expect(harnessed.workflow.remove).toHaveBeenCalledWith(main)
    expect(harnessed.workflow.preview).toHaveBeenCalledWith(main, {
      ...DEFAULT_BACKGROUND_SETTINGS, imageOpacityPercent: 44,
    })
    expect(harnessed.workflow.apply).toHaveBeenCalledWith(main, DEFAULT_BACKGROUND_SETTINGS)
    expect(harnessed.window.close).not.toHaveBeenCalled()
  })

  it('restores preview on an ordinary close and always disposes registration then ends the workflow', async () => {
    const harnessed = harness()
    await harnessed.registry.serviceFor(harnessed.originDeliver).open(main)

    harnessed.listeners.get('closed')?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(harnessed.workflow.cancel).toHaveBeenCalledWith(main, expect.any(Object))
    expect(harnessed.registration.dispose).toHaveBeenCalledOnce()
    expect(harnessed.workflow.end).toHaveBeenCalledWith(main, expect.any(Object))
  })

  it('cancels explicitly before closing without restoring twice', async () => {
    const harnessed = harness()
    await harnessed.registry.serviceFor(harnessed.originDeliver).open(main)
    const scoped = harnessed.scopedService
    if (!scoped) throw new Error('Expected settings IPC to be registered')

    await scoped.cancel(main)
    await Promise.resolve()

    expect(harnessed.workflow.cancel).toHaveBeenCalledTimes(1)
    expect(harnessed.window.close).toHaveBeenCalledOnce()
    expect(harnessed.registration.dispose).toHaveBeenCalledOnce()
    expect(harnessed.workflow.end).toHaveBeenCalledWith(main, expect.any(Object))
  })
})

function realRegistry() {
  const backend = {
    get: vi.fn(async () => presentation),
    previewSource: vi.fn(async () => 'asset:chosen'),
    apply: vi.fn(async () => presentation),
  }
  const workflow = new BackgroundWorkflow({ backend, chooseSource: async () => 'C:\\image.png', broadcast: vi.fn() })
  const windows: Array<ReturnType<typeof createWindow>> = []
  const services: BackgroundIpcService[] = []
  function createWindow() {
    const listeners = new Map<string, () => void>()
    return { show: vi.fn(), focus: vi.fn(), close: vi.fn(() => listeners.get('closed')?.()),
      once: (event: string, listener: () => void) => { listeners.set(event, listener) } }
  }
  const registry = new BackgroundSettingsWindowRegistry({
    workflow,
    createWindow: () => { const window = createWindow(); windows.push(window); return window },
    register: (_window, service) => { services.push(service); return { dispose: vi.fn() } },
  })
  return { registry, backend, windows, services }
}

it('keeps the first main owner when another main window reuses the global session', async () => {
  const { registry, windows, services } = realRegistry()
  const ownerA = {}, ownerB = {}
  const deliverA = vi.fn(), deliverB = vi.fn()
  await registry.serviceFor(deliverA, ownerA).open(main)
  await registry.serviceFor(deliverB, ownerB).open(main)
  expect(windows).toHaveLength(1)
  await registry.closeForOwner(ownerB)
  await services[0]!.preview(main, DEFAULT_BACKGROUND_SETTINGS)
  expect(deliverA).toHaveBeenCalledOnce()
  expect(deliverB).not.toHaveBeenCalled()
  expect(windows[0]!.close).not.toHaveBeenCalled()
  await registry.closeForOwner(ownerA)
  expect(windows[0]!.close).toHaveBeenCalledOnce()
  expect(deliverA).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'restore' }))
})

it('binds the actual owner closed event and leaves a canceled close usable', async () => {
  const { registry, windows, services } = realRegistry()
  const owner = new EventEmitter()
  await registry.serviceForOwner(owner, vi.fn()).open(main)
  owner.emit('close', { preventDefault() {} })
  await services[0]!.preview(main, DEFAULT_BACKGROUND_SETTINGS)
  expect(windows[0]!.close).not.toHaveBeenCalled()
  owner.emit('closed')
  await vi.waitFor(() => expect(windows[0]!.close).toHaveBeenCalledOnce())
  await expect(services[0]!.preview(main, DEFAULT_BACKGROUND_SETTINGS)).rejects.toThrow('unavailable')
})

it('closes only the committed note owner, with target and all cleanup available', async () => {
  const { registry, windows, services } = realRegistry()
  const a = {}, b = {}
  const other = { kind: 'sticky-note' as const, noteId: '00000000-0000-4000-8000-000000000002' }
  await registry.serviceFor(vi.fn(), a).open(sticky)
  await registry.serviceFor(vi.fn(), b).open(other)
  await registry.closeForOwner(a)
  expect(windows[0]!.close).toHaveBeenCalledOnce()
  expect(windows[1]!.close).not.toHaveBeenCalled()
  await services[1]!.preview(other, DEFAULT_BACKGROUND_SETTINGS)
  await registry.closeForTarget(other)
  expect(windows[1]!.close).toHaveBeenCalledOnce()
  await registry.serviceFor(vi.fn(), a).open(main)
  await registry.closeAll()
  expect(windows[2]!.close).toHaveBeenCalledOnce()
})

it('does not create an orphan after its owner closes during begin and another owner reopens', async () => {
  const { registry, backend, windows, services } = realRegistry()
  const pending = deferred<typeof presentation>()
  backend.get.mockReturnValueOnce(pending.promise)
  const owner = {}
  const oldOpen = registry.serviceFor(vi.fn(), owner).open(main)
  await registry.closeForOwner(owner)
  await registry.serviceFor(vi.fn(), {}).open(main)
  pending.resolve(presentation)
  await oldOpen
  expect(windows).toHaveLength(1)
  await services[0]!.preview(main, DEFAULT_BACKGROUND_SETTINGS)
})

it('rejects old scoped operations and old cancel cleanup cannot erase the reopened session', async () => {
  const { registry, backend, services } = realRegistry()
  const owner = {}
  await registry.serviceFor(vi.fn(), owner).open(main)
  const stale = services[0]!
  const pending = deferred<typeof presentation>()
  backend.get.mockReturnValueOnce(pending.promise)
  const closing = registry.closeForOwner(owner)
  const deliver = vi.fn()
  await registry.serviceFor(deliver, {}).open(main)
  await expect(stale.preview(main, DEFAULT_BACKGROUND_SETTINGS)).rejects.toThrow('unavailable')
  await expect(stale.choose(main)).rejects.toThrow('unavailable')
  await expect(stale.remove(main)).rejects.toThrow('unavailable')
  await expect(stale.apply(main, DEFAULT_BACKGROUND_SETTINGS)).rejects.toThrow('unavailable')
  await expect(stale.cancel(main)).rejects.toThrow('unavailable')
  pending.resolve(presentation)
  await closing
  await services[1]!.preview(main, DEFAULT_BACKGROUND_SETTINGS)
  expect(deliver).toHaveBeenCalledOnce()
})
