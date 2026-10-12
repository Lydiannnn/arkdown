// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { BrowserWindow, ipcMain } from 'electron'
import { ScreenTranslationModule, type ScreenTranslationModuleOptions } from '../../src/main/screen-translation/module'
import { DEFAULT_SCREEN_TRANSLATION, SCREEN_TRANSLATION_CHANNEL, type ScreenTranslationPreferences } from '../../src/shared/screen-translation'
import { DEFAULT_LARGE_MODEL_SETTINGS, featureModelConnections, type ModelConnectionSummary } from '../../src/shared/large-model-settings'
import { observeModelSettings, modelFeatureRequest, publicModelMutation } from '../../src/main/settings/settings-command-adapter'
import { reduceSettingsTransaction } from '../../src/main/settings/settings-transaction-reducer'
import type { SettingsTransactionSnapshot } from '../../src/main/settings/settings-transaction-types'
import type { PublicModelSettingsSnapshot } from '../../src/shared/settings-observation'

interface NativeDouble {
  start: Mock; send: Mock; stop: Mock
  emit(value: Record<string, unknown>): void
  exit(): void
}
interface WorkerDouble { request: Mock; stop: Mock; dispose: Mock }
const doubles = vi.hoisted(() => ({
  windows: [] as BrowserWindow[], natives: [] as NativeDouble[], workers: [] as WorkerDouble[],
  preferences: {} as ScreenTranslationPreferences,
  handler: undefined as undefined | ((event: unknown, input: unknown) => Promise<{ ok: boolean; value?: unknown; error?: string }>),
  translateModel: vi.fn(async () => []),
  nativeStart: undefined as undefined | (() => Promise<void>),
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class MockWindow extends EventEmitter {
    dead = false
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {}, send: vi.fn(), isDestroyed: () => this.dead, setWindowOpenHandler: vi.fn(),
    })
    constructor(readonly options: Record<string, unknown>) { super(); doubles.windows.push(this as unknown as BrowserWindow) }
    isDestroyed() { return this.dead }
    getNativeWindowHandle() { return Buffer.alloc(8, 1) }
    setContentProtection = vi.fn()
    setContentSize = vi.fn()
    loadURL = vi.fn(async () => undefined)
    loadFile = vi.fn(async () => undefined)
    show = vi.fn()
    focus = vi.fn()
    destroy = vi.fn(() => { this.dead = true; this.emit('closed') })
  }
  return {
    BrowserWindow: MockWindow,
    ipcMain: {
      handle: vi.fn((_channel, handler) => { doubles.handler = handler }),
      removeHandler: vi.fn(() => { doubles.handler = undefined }),
    },
    clipboard: { writeText: vi.fn() }, nativeTheme: { shouldUseDarkColors: false },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), dipToScreenPoint: (point: unknown) => point,
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 900 }, scaleFactor: 1 }) },
  }
})
vi.mock('node:fs/promises', () => ({ access: vi.fn(async () => undefined), mkdir: vi.fn(async () => undefined) }))
vi.mock('../../src/main/screen-translation/settings-store', () => ({
  ScreenTranslationSettingsStore: class {
    constructor(readonly directory: string) {}
    load = vi.fn(async () => undefined)
    reload = vi.fn(async () => undefined)
    get() { return { ...doubles.preferences } }
    update = vi.fn(async (patch: Partial<ScreenTranslationPreferences>) => { doubles.preferences = { ...doubles.preferences, ...patch } })
  },
}))
vi.mock('../../src/main/screen-translation/line-process', () => ({
  ScreenLineProcess: class implements NativeDouble {
    private receive: (value: Record<string, unknown>) => void = () => undefined
    private exited: () => void = () => undefined
    constructor() { doubles.natives.push(this) }
    onMessage(listener: (value: Record<string, unknown>) => void) { this.receive = listener; return () => undefined }
    onExit(listener: () => void) { this.exited = listener; return () => undefined }
    start = vi.fn(async () => { await doubles.nativeStart?.() })
    send = vi.fn()
    stop = vi.fn(async () => undefined)
    emit(value: Record<string, unknown>) { this.receive(value) }
    exit() { this.exited() }
  },
}))
vi.mock('../../src/main/screen-translation/worker-client', () => ({
  ScreenWorkerError: class extends Error { constructor(message: string, readonly needsSettings = false) { super(message) } },
  ScreenTranslationWorker: class implements WorkerDouble {
    constructor() { doubles.workers.push(this) }
    request = vi.fn(async (input: { mode: string }, _signal?: AbortSignal) => input.mode === 'credentials-status' ? { configured: true } : { blocks: [] })
    stop = vi.fn(async () => undefined)
    dispose = vi.fn(async () => undefined)
  },
}))
vi.mock('../../src/main/screen-translation/model-translator', () => ({
  ScreenModelTranslator: class { clear = vi.fn(); translate = doubles.translateModel },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function settle() { for (let i = 0; i < 12; i += 1) await Promise.resolve() }
function request(id = 1) { return { type: 'request', id, backend: doubles.preferences.backend, target: doubles.preferences.target, image: 'aGVsbG8=' } }
function from(window: BrowserWindow) { return { sender: window.webContents, senderFrame: window.webContents.mainFrame } }
function invoke(window: BrowserWindow, input: unknown) { return doubles.handler!(from(window), input) }

const connection: ModelConnectionSummary = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Synthetic model', provider: 'other', protocol: 'openai',
  accessType: 'standard-api', baseUrl: 'https://example.invalid/v1', modelId: 'synthetic-model',
  apiKeyHint: '••••test', status: 'connected', lastTestedAt: null, capabilityOverride: null,
}

describe('ScreenTranslationModule window isolation and lifecycle', () => {
  let module: ScreenTranslationModule
  let owner: BrowserWindow
  let options: ScreenTranslationModuleOptions & { models: NonNullable<ScreenTranslationModuleOptions['models']> }
  let registrations: Set<string>

  beforeEach(() => {
    vi.useFakeTimers()
    doubles.windows.length = 0; doubles.natives.length = 0; doubles.workers.length = 0
    doubles.preferences = { ...DEFAULT_SCREEN_TRANSLATION, backend: 'baidu', target: 'zh' }
    doubles.handler = undefined; doubles.nativeStart = undefined
    registrations = new Set()
    options = {
      dataRoot: 'C:/synthetic-arkdown-tests', helperPath: 'C:/synthetic/helper.exe', workerPath: 'C:/synthetic/worker.exe',
      preload: 'C:/synthetic/preload.js', rendererFile: 'C:/synthetic/index.html',
      settings: { get: () => ({ lastWorkspace: null }) },
      models: { getSettings: () => ({ ...DEFAULT_LARGE_MODEL_SETTINGS, connections: [connection], floatingTranslation: { connectionId: doubles.preferences.connectionId, thinkingMode: doubles.preferences.thinkingMode, reasoningEffort: doubles.preferences.reasoningEffort, target: doubles.preferences.target } }),
        setFloatingTranslation: vi.fn(async (value) => { doubles.preferences = { ...doubles.preferences, ...value }; return options.models.getSettings() }),
        getCredentialSnapshot: vi.fn(async () => ({ connection, apiKey: 'synthetic-test-key' })) },
      client: {} as ScreenTranslationModuleOptions['client'], openModels: vi.fn(),
      globalShortcut: {
        register: vi.fn((accelerator, _callback) => { registrations.add(accelerator); return true }),
        unregister: vi.fn(accelerator => { registrations.delete(accelerator) }),
        isRegistered: vi.fn(accelerator => registrations.has(accelerator)),
      },
    }
    owner = new BrowserWindow({ show: false })
    module = new ScreenTranslationModule(options)
  })
  afterEach(async () => {
    await module.dispose()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  async function observedFixture() {
    let current: SettingsTransactionSnapshot = { settings: { lastWorkspace: null, models: options.models.getSettings() },
      revision: 0, minimumBaseRevision: 0, fieldRevisions: { fields: {}, connections: {}, tombstones: {} } }
    const observedModels = {
      getDisplay: () => observeModelSettings(current),
      getSettings: vi.fn(async () => observeModelSettings(current)),
      setFloatingTranslation: vi.fn(async (observed: PublicModelSettingsSnapshot, patch: { target?: string }) => {
        const result = reduceSettingsTransaction(current, modelFeatureRequest(observed, 'floatingTranslation', patch))
        if (result.status !== 'prepared') return publicModelMutation(result)
        current = result.snapshot
        return publicModelMutation({ status: 'committed', snapshot: current, cleanupPending: false })
      }),
    }
    options.models.getSettings = () => structuredClone(current.settings.models!)
    vi.mocked(options.models.setFloatingTranslation).mockImplementation(async patch => {
      current.settings.models!.floatingTranslation = { ...current.settings.models!.floatingTranslation!, ...patch }
      return options.models.getSettings()
    })
    await module.dispose()
    module = new ScreenTranslationModule(Object.assign({}, options, { observedModels,
      authority: { readExecution: vi.fn(), admitExecution: vi.fn() } }))
    await module.open(owner)
    observedModels.getSettings.mockClear()
    return { observedModels, panel: doubles.windows.at(-1)!,
      read: () => structuredClone(current),
      externalTarget(target: string) {
        current.revision += 1
        current.settings.models!.floatingTranslation!.target = target
        current.fieldRevisions.fields['models.floatingTranslation.target'] = current.revision
      } }
  }

  it('blocks new floating work during update handoff while still allowing normal close', async () => {
    options.admitWork = vi.fn(() => false)
    await module.open(owner)
    expect(doubles.windows).toHaveLength(1)
    options.admitWork = vi.fn(() => true)
    await module.open(owner)
    const panel = doubles.windows.at(-1)!
    options.admitWork = vi.fn(() => false)
    expect(await invoke(panel, { method: 'command', action: 'once' })).toMatchObject({ ok: false, error: '正在准备更新，请稍候。' })
    expect(await invoke(panel, { method: 'command', action: 'close' })).toMatchObject({ ok: true })
  })

  it.each(['dispose', 'owner-closed', 'renderer-gone', 'user-close-success', 'user-close-failure'] as const)(
    'T03 gates late runtime initialization during %s while an admitted setting settles', async cause => {
    const verifying = deferred<string>(), held = deferred<void>()
    const components = {
      getState: () => ({ status: 'installed' as const, version: '1.0.0', downloadBytes: 1000, progress: null, error: null }),
      subscribe: vi.fn(() => () => {}), ensureRuntime: vi.fn(() => verifying.promise),
      install: vi.fn(async () => {}), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
    }
    await module.dispose()
    module = new ScreenTranslationModule({ ...options, componentManager: components })
    const opening = module.open(owner)
    await settle()
    const panel = doubles.windows.at(-1)!
    vi.mocked(options.models.setFloatingTranslation).mockImplementationOnce(async () => {
      await held.promise
      if (cause === 'user-close-failure') throw new Error('synthetic setting failure')
      return options.models.getSettings()
    })
    const saving = invoke(panel, { method: 'settings', patch: { target: 'en' } })
    await settle()
    if (cause === 'owner-closed') owner.destroy()
    if (cause === 'renderer-gone') panel.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    const closing = cause === 'dispose' ? module.dispose() : module.close()
    await settle()
    try {
      verifying.resolve('C:/synthetic/verified.exe')
      await settle()
      expect(doubles.natives).toHaveLength(0)
      expect(doubles.workers).toHaveLength(0)
    } finally { held.resolve(); await saving }
    if (cause === 'user-close-failure') {
      await expect(closing).rejects.toThrow()
      await opening
      expect(panel.isDestroyed()).toBe(false)
      expect(module.snapshot().engineReady).toBe(true)
      expect(doubles.natives).toHaveLength(1)
    } else {
      await closing; await opening
      expect(panel.isDestroyed()).toBe(true)
      expect(doubles.natives).toHaveLength(0)
    }
  })

  it('T03 does not activate a late native start during disposal waiting for a setting', async () => {
    const starting = deferred<void>(), held = deferred<void>()
    doubles.nativeStart = () => starting.promise
    const opening = module.open(owner)
    await settle()
    const panel = doubles.windows.at(-1)!
    expect(doubles.natives).toHaveLength(1)
    vi.mocked(options.models.setFloatingTranslation).mockImplementationOnce(async () => {
      await held.promise; return options.models.getSettings()
    })
    const saving = invoke(panel, { method: 'settings', patch: { target: 'en' } })
    await settle()
    const disposing = module.dispose()
    try {
      starting.resolve(); await opening
      expect(module.snapshot().engineReady).toBe(false)
      expect(registrations.size).toBe(0)
      expect(doubles.workers[0]!.request).not.toHaveBeenCalled()
    } finally { held.resolve(); await saving; await disposing }
  })

  it('T03 preserves the submitted observation and reports a central settings conflict without replaying it', async () => {
    const f = await observedFixture()
    const observed = f.observedModels.getDisplay()
    f.externalTarget('jp')
    const result = await invoke(f.panel, { method: 'settings', patch: { target: 'en' }, observed })
    expect(result).toMatchObject({ ok: true, value: { status: 'conflict' } })
    expect(f.read().settings.models!.floatingTranslation!.target).toBe('jp')
    expect(options.models.setFloatingTranslation).not.toHaveBeenCalled()
    expect(f.observedModels.getSettings).not.toHaveBeenCalled()
    await invoke(f.panel, { method: 'settings', patch: { target: 'en' }, observed })
    expect(f.read().settings.models!.floatingTranslation!.target).toBe('jp')
    await invoke(f.panel, { method: 'state', reloadSettings: true })
    expect(doubles.natives[0]!.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'configure', target: 'jp' }))
  })

  it('T03 requires the renderer observation for central edits but keeps local backend updates independent', async () => {
    const f = await observedFixture()
    expect(await invoke(f.panel, { method: 'settings', patch: { target: 'en' } })).toMatchObject({ ok: false })
    expect(f.read().settings.models!.floatingTranslation!.target).toBe('zh')
    expect(await invoke(f.panel, { method: 'settings', patch: { backend: 'model' } })).toMatchObject({ ok: true })
    expect(module.snapshot().preferences.backend).toBe('model')
    expect(f.observedModels.setFloatingTranslation).not.toHaveBeenCalled()
    expect(module.snapshot()).toMatchObject({ modelObservation: f.observedModels.getDisplay() })
  })

  it('T03 waits pending settings before destroying resources and refuses new settings during user close', async () => {
    const f = await observedFixture(), held = deferred<void>()
    const original = f.observedModels.setFloatingTranslation.getMockImplementation()!
    f.observedModels.setFloatingTranslation.mockImplementation(async (...args) => { await held.promise; return original(...args) })
    const saving = invoke(f.panel, { method: 'settings', patch: { target: 'en' }, observed: f.observedModels.getDisplay() })
    await settle()
    const closing = module.close()
    await settle()
    expect(f.panel.isDestroyed()).toBe(false)
    expect(doubles.workers[0]!.dispose).not.toHaveBeenCalled()
    expect(await invoke(f.panel, { method: 'settings', patch: { backend: 'model' } })).toMatchObject({ ok: false })
    held.resolve(); await saving; await closing
    expect(f.read().settings.models!.floatingTranslation!.target).toBe('en')
    expect(f.panel.isDestroyed()).toBe(true)
  })

  it('T03 retains failed settings on user close and ordinary reads, while explicit reload permits closing', async () => {
    const f = await observedFixture()
    f.observedModels.setFloatingTranslation.mockRejectedValueOnce(new Error('synthetic write failure'))
    expect(await invoke(f.panel, { method: 'settings', patch: { target: 'en' }, observed: f.observedModels.getDisplay() })).toMatchObject({ ok: false })
    await expect(module.close()).rejects.toThrow()
    expect(f.panel.isDestroyed()).toBe(false)
    await invoke(f.panel, { method: 'state' })
    await expect(module.close()).rejects.toThrow()
    // An unrelated local or credential write cannot dismiss the failed central draft.
    await invoke(f.panel, { method: 'settings', patch: { triggerMode: 'automatic' } })
    await expect(module.close()).rejects.toThrow()
    f.observedModels.getSettings.mockRejectedValueOnce(new Error('synthetic read failure'))
    expect(await invoke(f.panel, { method: 'state', reloadSettings: true })).toMatchObject({ ok: false })
    await expect(module.close()).rejects.toThrow()
    await invoke(f.panel, { method: 'state', reloadSettings: true })
    await module.close()
    expect(f.panel.isDestroyed()).toBe(true)
  })

  it('T03 allows a successful exact retry to clear only its own failure and close', async () => {
    const f = await observedFixture(), observed = f.observedModels.getDisplay()
    f.observedModels.setFloatingTranslation.mockRejectedValueOnce(new Error('synthetic write failure'))
    const input = { method: 'settings', patch: { target: 'en' }, observed }
    expect(await invoke(f.panel, input)).toMatchObject({ ok: false })
    await expect(module.close()).rejects.toThrow()
    expect(await invoke(f.panel, input)).toMatchObject({ ok: true })
    expect(f.observedModels.setFloatingTranslation.mock.calls).toEqual([
      [observed, { target: 'en' }], [observed, { target: 'en' }],
    ])
    await module.close()
    expect(f.panel.isDestroyed()).toBe(true)
  })

  it.each(['owner-closed', 'renderer-gone'] as const)('T03 upgrades a pending user close after %s without retaining an unreachable failure', async cause => {
    const f = await observedFixture(), held = deferred<void>()
    f.observedModels.setFloatingTranslation.mockImplementation(async () => { await held.promise; throw new Error('synthetic write failure') })
    const saving = invoke(f.panel, { method: 'settings', patch: { target: 'en' }, observed: f.observedModels.getDisplay() })
    await settle()
    const closing = module.close()
    try {
      if (cause === 'owner-closed') owner.destroy()
      else f.panel.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
      await settle()
      expect(f.panel.isDestroyed()).toBe(false)
    } finally { held.resolve() }
    await saving; await closing
    expect(f.panel.isDestroyed()).toBe(true)
    expect(f.observedModels.setFloatingTranslation).toHaveBeenCalledOnce()
  })

  it('T03 prevents every native close event until an already pending settings save settles', async () => {
    const f = await observedFixture(), held = deferred<void>()
    const original = f.observedModels.setFloatingTranslation.getMockImplementation()!
    f.observedModels.setFloatingTranslation.mockImplementation(async (...args) => { await held.promise; return original(...args) })
    const saving = invoke(f.panel, { method: 'settings', patch: { target: 'en' }, observed: f.observedModels.getDisplay() })
    await settle()
    const first = { preventDefault: vi.fn() }, again = { preventDefault: vi.fn() }
    f.panel.emit('close', first); f.panel.emit('close', again)
    const closing = module.close()
    try {
      expect(first.preventDefault).toHaveBeenCalledOnce()
      expect(again.preventDefault).toHaveBeenCalledOnce()
      expect(f.panel.isDestroyed()).toBe(false)
    } finally { held.resolve() }
    await saving; await closing
    expect(f.panel.isDestroyed()).toBe(true)
  })

  it('T03 does not reopen after a close supersedes the initial observed settings read', async () => {
    const f = await observedFixture(), held = deferred<void>()
    await module.close()
    const count = doubles.windows.length
    f.observedModels.getSettings.mockImplementationOnce(async () => { await held.promise; return f.observedModels.getDisplay() })
    const opening = module.open(owner)
    await settle()
    await module.close()
    held.resolve(); await opening
    expect(doubles.windows).toHaveLength(count)
    expect(module.snapshot().engineReady).toBe(false)
  })

  it('T03 unavailable-owner disposal waits settings settlement but does not retain an unreachable failed draft', async () => {
    const f = await observedFixture(), held = deferred<void>()
    f.observedModels.setFloatingTranslation.mockImplementation(async () => { await held.promise; throw new Error('synthetic failure') })
    const saving = invoke(f.panel, { method: 'settings', patch: { target: 'en' }, observed: f.observedModels.getDisplay() })
    await settle()
    const disposing = module.dispose()
    await settle()
    expect(f.panel.isDestroyed()).toBe(false)
    held.resolve(); await saving; await disposing
    expect(f.panel.isDestroyed()).toBe(true)
  })

  it('passes a paired floating-feature observation to the model translator without a legacy credential read', async () => {
    doubles.preferences = { ...DEFAULT_SCREEN_TRANSLATION, backend: 'model', connectionId: connection.id }
    const models = options.models.getSettings()
    const pairedConnection = { ...connection, apiKeyHint: '••••test', baseUrl: 'https://paired.example/v1' }
    models.connections = [pairedConnection]
    const observed = { settings: models, observation: { version: 1 as const, revision: 1, minimumBaseRevision: 0, fields: {}, connections: { [connection.id]: { entity: 1 } } } }
    const authority = {
      readExecution: vi.fn(async () => ({ connection: pairedConnection, apiKey: 'paired-test', observed,
        snapshot: { settings: { lastWorkspace: null, models }, revision: 1, minimumBaseRevision: 0, fieldRevisions: { fields: {}, connections: { [connection.id]: { entity: 1 } }, tombstones: {} } } })),
      admitExecution: async <T>(_observed: unknown, _target: unknown, start: () => { completion: Promise<T> }) => start(),
    }
    await module.dispose()
    module = new ScreenTranslationModule({ ...options, authority })
    await module.open(owner)
    doubles.natives[0]!.emit(request())
    await settle()
    expect(authority.readExecution).toHaveBeenCalledWith({ feature: 'floatingTranslation' })
    expect(options.models.getCredentialSnapshot).not.toHaveBeenCalled()
    expect(doubles.translateModel).toHaveBeenCalledWith(expect.any(Array), pairedConnection, 'paired-test', expect.any(Object), expect.any(AbortSignal), { authority, observed })
  })

  it('waits for explicit installation and starts the verified runtime only once', async () => {
    let installed = false
    const components = {
      getState: () => ({ status: installed ? 'installed' as const : 'absent' as const, version: '1.0.0', downloadBytes: 1000, progress: null, error: null }),
      subscribe: vi.fn(() => () => {}),
      ensureRuntime: vi.fn(async () => installed ? 'C:\\synthetic\\verified\\ArkTranslateEngine.exe' : undefined),
      install: vi.fn(async () => { installed = true }), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
    }
    await module.dispose()
    module = new ScreenTranslationModule({ ...options, componentManager: components })
    await module.open(owner)
    const panel = doubles.windows.at(-1)!
    expect(doubles.workers).toHaveLength(0)
    expect(doubles.natives).toHaveLength(0)
    expect(components.install).not.toHaveBeenCalled()
    expect(registrations.size).toBe(0)
    expect(module.snapshot().component?.status).toBe('absent')
    expect((await invoke(panel, { method: 'command', action: 'install-engine' })).ok).toBe(true)
    expect(doubles.workers).toHaveLength(1)
    expect(module.snapshot().engineReady).toBe(true)
    await invoke(panel, { method: 'command', action: 'install-engine' })
    expect(doubles.workers).toHaveLength(1)
    await module.close()
    expect(components.cancel).toHaveBeenCalled()
    await module.open(owner)
    expect(doubles.workers).toHaveLength(2)
    expect(components.install).toHaveBeenCalledTimes(1)
  })

  it('does not launch a late successful installation after the panel closes', async () => {
    const pending = deferred<void>()
    let installed = false
    const components = {
      getState: () => ({ status: installed ? 'installed' as const : 'absent' as const, version: '1.0.0', downloadBytes: 1000, progress: null, error: null }),
      subscribe: vi.fn(() => () => {}), ensureRuntime: vi.fn(async () => installed ? 'C:\\synthetic\\verified.exe' : undefined),
      install: vi.fn(async () => { await pending.promise; installed = true }), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
    }
    await module.dispose()
    module = new ScreenTranslationModule({ ...options, componentManager: components })
    await module.open(owner)
    const install = invoke(doubles.windows.at(-1)!, { method: 'command', action: 'install-engine' })
    await settle()
    await module.close()
    pending.resolve()
    await install
    expect(components.cancel).toHaveBeenCalled()
    expect(doubles.workers).toHaveLength(0)
    expect(doubles.natives).toHaveLength(0)
  })

  it('isolates component initialization errors to the tool and retries on demand', async () => {
    const create = vi.fn(async () => { throw new Error('synthetic disk failure') })
    await module.dispose()
    module = new ScreenTranslationModule({ ...options, createComponentManager: create })
    expect(create).not.toHaveBeenCalled()
    await module.open(owner)
    expect(module.snapshot().component?.status).toBe('failed')
    expect(module.snapshot().component?.error).toContain('重试')
    expect(doubles.workers).toHaveLength(0)
    expect(doubles.windows.at(-1)?.isDestroyed()).toBe(false)
    await invoke(doubles.windows.at(-1)!, { method: 'command', action: 'install-engine' })
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('starts the reopened panel after an old generation finishes runtime verification', async () => {
    const verifying = deferred<string | undefined>()
    const components = {
      getState: () => ({ status: 'installed' as const, version: '1.0.0', downloadBytes: 1000, progress: null, error: null }),
      subscribe: vi.fn(() => () => {}), ensureRuntime: vi.fn(async () => 'C:\\synthetic\\verified.exe'),
      install: vi.fn(async () => {}), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
    }
    components.ensureRuntime.mockImplementationOnce(() => verifying.promise as Promise<string>)
    await module.dispose()
    module = new ScreenTranslationModule({ ...options, componentManager: components })
    const first = module.open(owner)
    await settle()
    await module.close()
    const reopened = module.open(owner)
    verifying.resolve('C:\\synthetic\\verified.exe')
    await Promise.all([first, reopened])
    expect(doubles.windows.at(-1)?.isDestroyed()).toBe(false)
    expect(module.snapshot().engineReady).toBe(true)
    expect(doubles.workers).toHaveLength(1)
  })

  it('allows IPC only from the dedicated panel webContents and its exact mainFrame', async () => {
    await module.open(owner)
    const panel = doubles.windows.at(-1)!
    const native = doubles.natives[0]!
    native.send.mockClear()
    const valid = await invoke(panel, { method: 'state' })
    expect(valid.ok).toBe(true)
    expect(ipcMain.handle).toHaveBeenCalledWith(SCREEN_TRANSLATION_CHANNEL, expect.any(Function))

    for (const event of [from(owner), { sender: panel.webContents, senderFrame: {} },
      { sender: owner.webContents, senderFrame: panel.webContents.mainFrame }, { sender: panel.webContents, senderFrame: null }]) {
      expect(await doubles.handler!(event, { method: 'command', action: 'once' })).toEqual({ ok: false, error: '此窗口无权操作悬浮翻译窗。' })
    }
    expect(native.send).not.toHaveBeenCalled()
    await module.close()
    expect((await doubles.handler!(from(panel), { method: 'state' })).ok).toBe(false)
  })

  it('opens a resizable 360 x 450 CSS pixel panel in hotkey mode', async () => {
    await module.open(owner)
    const panel = doubles.windows.at(-1)! as unknown as { options: Record<string, unknown> }
    expect(panel.options).toMatchObject({ width: 360, height: 450, minWidth: 360, minHeight: 450,
      resizable: true, title: '悬浮翻译窗 — Arkdown' })
    expect(module.snapshot().preferences.triggerMode).toBe('hotkey')
    expect(module.snapshot().status.triggerMode).toBe('hotkey')
    expect(doubles.natives[0]!.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'configure', triggerMode: 'hotkey' }))
  })

  it.each(['packaged', 'development'])('corrects the default content size once before %s loading and preserves an open panel size', async mode => {
    if (mode === 'development') options.rendererUrl = 'http://127.0.0.1:1234'
    await module.open(owner)
    const panel = doubles.windows.at(-1)!
    const load = vi.mocked(mode === 'development' ? panel.loadURL : panel.loadFile)
    const resize = vi.mocked(panel.setContentSize)
    expect(resize).toHaveBeenCalledExactlyOnceWith(360, 450)
    expect(resize.mock.invocationCallOrder[0]).toBeLessThan(load.mock.invocationCallOrder[0]!)
    panel.emit('ready-to-show')
    expect(resize.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(panel.show).mock.invocationCallOrder[0]!)
    await module.open(owner)
    expect(resize).toHaveBeenCalledTimes(1)
  })

  it('selects a discovered CLI model and submits OCR text without requiring an API key', async () => {
    const models = { ...DEFAULT_LARGE_MODEL_SETTINGS, codexCli: { status: 'connected' as const,
      cliVersion: 'synthetic-cli', lastTestedAt: '2026-09-13T00:00:00.000Z',
      models: [{ modelId: 'synthetic-model', displayName: 'Synthetic CLI model', supportedReasoningEfforts: ['low' as const, 'ultra' as const], defaultReasoningEffort: 'low' as const, isDefault: true }] } }
    const cli = featureModelConnections(models).find(item => item.modelId === 'synthetic-model')!
    options.models.getSettings = () => ({ ...models, floatingTranslation: { connectionId: doubles.preferences.connectionId,
      thinkingMode: doubles.preferences.thinkingMode, reasoningEffort: doubles.preferences.reasoningEffort, target: doubles.preferences.target } })
    vi.mocked(options.models.getCredentialSnapshot).mockResolvedValue({ connection: cli, apiKey: '' })
    await module.open(owner)
    const panel = doubles.windows.at(-1)!
    expect((await invoke(panel, { method: 'settings', patch: { backend: 'model', connectionId: cli.id, reasoningEffort: 'ultra' } })).ok).toBe(true)
    const native = doubles.natives[0]!
    native.emit(request())
    await settle()
    expect(doubles.translateModel).toHaveBeenCalledWith([], cli, '', expect.objectContaining({ reasoningEffort: 'ultra' }), expect.any(AbortSignal))
    expect(native.send).toHaveBeenCalledWith({ type: 'result', id: 1, result: { blocks: [] } })
  })

  it('aborts work and unregisters shortcuts when the helper exits, without replying to the dead helper', async () => {
    await module.open(owner)
    const native = doubles.natives[0]!
    const worker = doubles.workers[0]!
    const outstanding = deferred<{ blocks: [] }>()
    worker.request.mockImplementationOnce(() => outstanding.promise)
    native.emit(request())
    const signal = worker.request.mock.calls.at(-1)![1] as AbortSignal
    expect(signal.aborted).toBe(false)
    native.send.mockClear()
    native.exit()
    expect(signal.aborted).toBe(true)
    expect(worker.stop).toHaveBeenCalledOnce()
    expect(registrations.size).toBe(0)
    expect(module.snapshot().engineReady).toBe(false)
    outstanding.resolve({ blocks: [] })
    await settle()
    expect(native.send).not.toHaveBeenCalled()
    expect(module.snapshot().status.error).toContain('屏幕取景组件已退出')
  })

  it('reads the manager binding instead of stale local model preferences and saves panel edits centrally', async () => {
    const central = { ...DEFAULT_LARGE_MODEL_SETTINGS, connections: [connection], floatingTranslation: {
      connectionId: connection.id as string | null, thinkingMode: 'enabled' as const, reasoningEffort: 'high' as const,
    } }
    doubles.preferences = { ...DEFAULT_SCREEN_TRANSLATION, backend: 'model' }
    options.models.getSettings = () => structuredClone(central)
    vi.mocked(options.models.setFloatingTranslation).mockImplementation(async value => {
      Object.assign(central.floatingTranslation, value); return structuredClone(central)
    })
    await module.open(owner)
    expect(module.snapshot().preferences).toMatchObject({ backend: 'model', ...central.floatingTranslation })
    const panel = doubles.windows.at(-1)!
    expect((await invoke(panel, { method: 'settings', patch: { connectionId: null } })).ok).toBe(true)
    expect(options.models.setFloatingTranslation).toHaveBeenCalledWith({ connectionId: null })
    expect(doubles.preferences).toEqual({ ...DEFAULT_SCREEN_TRANSLATION, backend: 'model' })
    expect(module.snapshot().preferences.connectionId).toBeNull()
  })

  it('reads shared target language and sends a target-only edit without changing the local backend or model', async () => {
    const central = { ...DEFAULT_LARGE_MODEL_SETTINGS, connections: [connection], floatingTranslation: {
      connectionId: connection.id, thinkingMode: 'enabled' as const, reasoningEffort: 'high' as const, target: 'fra',
    } }
    doubles.preferences = { ...DEFAULT_SCREEN_TRANSLATION, backend: 'baidu', target: 'zh' }
    options.models.getSettings = () => structuredClone(central)
    vi.mocked(options.models.setFloatingTranslation).mockImplementation(async patch => {
      Object.assign(central.floatingTranslation, patch); return structuredClone(central)
    })
    await module.open(owner)
    expect(module.snapshot().preferences).toMatchObject({ backend: 'baidu', target: 'fra', connectionId: connection.id })
    const panel = doubles.windows.at(-1)!
    expect((await invoke(panel, { method: 'settings', patch: { target: 'jp' } })).ok).toBe(true)
    expect(options.models.setFloatingTranslation).toHaveBeenCalledExactlyOnceWith({ target: 'jp' })
    expect(central.floatingTranslation).toEqual({ connectionId: connection.id, thinkingMode: 'enabled', reasoningEffort: 'high', target: 'jp' })
    expect(doubles.preferences).toEqual({ ...DEFAULT_SCREEN_TRANSLATION, backend: 'baidu', target: 'zh' })
    expect(module.snapshot().preferences.target).toBe('jp')
  })

  it('does not send OCR text to a model cleared in the manager before the context poll', async () => {
    doubles.preferences = { ...DEFAULT_SCREEN_TRANSLATION, backend: 'model', connectionId: connection.id }
    await module.open(owner)
    const worker = doubles.workers[0]!
    const outstanding = deferred<{ blocks: [] }>()
    worker.request.mockImplementationOnce(() => outstanding.promise)
    doubles.natives[0]!.emit(request())
    await settle()
    doubles.preferences.connectionId = null
    outstanding.resolve({ blocks: [] })
    await settle()
    expect(doubles.translateModel).not.toHaveBeenCalled()
  })

  it('does not let an old request ID 1 completion remove a new session request ID 1 controller', async () => {
    await module.open(owner)
    const oldNative = doubles.natives[0]!
    const oldWorker = doubles.workers[0]!
    const oldResult = deferred<{ blocks: [] }>()
    oldWorker.request.mockImplementationOnce(() => oldResult.promise)
    oldNative.emit(request(1))
    const oldSignal = oldWorker.request.mock.calls.at(-1)![1] as AbortSignal
    await module.close()
    await module.open(owner)
    const newNative = doubles.natives[1]!
    const newWorker = doubles.workers[1]!
    const newResult = deferred<{ blocks: [] }>()
    newWorker.request.mockImplementationOnce(() => newResult.promise)
    newNative.emit(request(1))
    const newSignal = newWorker.request.mock.calls.at(-1)![1] as AbortSignal
    expect(oldSignal.aborted).toBe(true)
    expect(newSignal.aborted).toBe(false)
    oldNative.send.mockClear(); newNative.send.mockClear()
    oldResult.resolve({ blocks: [] })
    await settle()
    expect(oldNative.send).not.toHaveBeenCalled()
    expect(newNative.send).not.toHaveBeenCalled()
    // Observable regression assertion: the new ID 1 must still be cancellable.
    newNative.emit({ type: 'cancel', id: 1 })
    expect(newSignal.aborted).toBe(true)
    newResult.resolve({ blocks: [] })
    await settle()
  })

  it('does not submit OCR to either worker after a cancelled credential lookup resolves across close/reopen', async () => {
    doubles.preferences = { ...DEFAULT_SCREEN_TRANSLATION, backend: 'model', connectionId: connection.id }
    const credentials = deferred<{ connection: ModelConnectionSummary; apiKey: string }>()
    vi.mocked(options.models.getCredentialSnapshot).mockImplementationOnce(() => credentials.promise)
    await module.open(owner)
    const oldNative = doubles.natives[0]!
    const oldWorker = doubles.workers[0]!
    oldNative.emit(request())
    expect(options.models.getCredentialSnapshot).toHaveBeenCalledOnce()
    await module.close()
    await module.open(owner)
    const newNative = doubles.natives[1]!
    const newWorker = doubles.workers[1]!
    oldWorker.request.mockClear(); newWorker.request.mockClear()
    oldNative.send.mockClear(); newNative.send.mockClear()
    credentials.resolve({ connection, apiKey: 'synthetic-test-key' })
    await settle()
    expect(oldWorker.request).not.toHaveBeenCalled()
    expect(newWorker.request).not.toHaveBeenCalled()
    expect(doubles.translateModel).not.toHaveBeenCalled()
    expect(oldNative.send).not.toHaveBeenCalled()
    expect(newNative.send).not.toHaveBeenCalled()
  })

  it('cancels a pending credential lookup within the same session before it can issue OCR', async () => {
    doubles.preferences = { ...DEFAULT_SCREEN_TRANSLATION, backend: 'model', connectionId: connection.id }
    const credentials = deferred<{ connection: ModelConnectionSummary; apiKey: string }>()
    vi.mocked(options.models.getCredentialSnapshot).mockImplementationOnce(() => credentials.promise)
    await module.open(owner)
    const native = doubles.natives[0]!
    const worker = doubles.workers[0]!
    worker.request.mockClear()
    native.emit(request())
    native.emit({ type: 'cancel', id: 1 })
    credentials.resolve({ connection, apiKey: 'synthetic-test-key' })
    await settle()
    expect(worker.request).not.toHaveBeenCalled()
    expect(doubles.translateModel).not.toHaveBeenCalled()
    expect(native.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'result', id: 1, error: '已取消' }))
  })

  it('closes idempotently, aborts active work, releases global registrations, stops children and removes owner listener', async () => {
    await module.open(owner)
    const panel = doubles.windows.at(-1)!
    const native = doubles.natives[0]!
    const worker = doubles.workers[0]!
    const result = deferred<{ blocks: [] }>()
    worker.request.mockImplementationOnce(() => result.promise)
    native.emit(request())
    const signal = worker.request.mock.calls.at(-1)![1] as AbortSignal
    const registered = [...registrations]
    expect(registered).toHaveLength(3)
    expect(owner.listenerCount('closed')).toBe(1)
    const closing = module.close()
    expect(module.close()).toBe(closing)
    await closing
    expect(signal.aborted).toBe(true)
    expect(native.send).toHaveBeenCalledWith({ type: 'close' })
    expect(native.stop).toHaveBeenCalledExactlyOnceWith(true)
    expect(worker.dispose).toHaveBeenCalledOnce()
    expect(panel.isDestroyed()).toBe(true)
    expect(owner.listenerCount('closed')).toBe(0)
    for (const accelerator of registered) expect(options.globalShortcut.unregister).toHaveBeenCalledWith(accelerator)
    expect(registrations.size).toBe(0)
    expect(module.snapshot().engineReady).toBe(false)
    result.resolve({ blocks: [] })
    await settle()
    await module.dispose()
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(SCREEN_TRANSLATION_CHANNEL)
    expect(doubles.handler).toBeUndefined()
  })

  it('clears through the scoped shortcut, aborts outstanding work and keeps the panel available for a new translation', async () => {
    await module.open(owner)
    const panel = doubles.windows.at(-1)!
    const native = doubles.natives[0]!
    const worker = doubles.workers[0]!
    const result = deferred<{ blocks: [] }>()
    worker.request.mockImplementationOnce(() => result.promise)
    native.emit(request())
    const signal = worker.request.mock.calls.at(-1)![1] as AbortSignal
    const registration = vi.mocked(options.globalShortcut.register).mock.calls.find(([key]) => key === 'Ctrl+Shift+D')
    expect(registration).toBeDefined()
    registration![1]()
    await settle()
    expect(signal.aborted).toBe(true)
    expect(native.send).toHaveBeenCalledWith({ type: 'clear' })
    expect(module.snapshot().status.result.blocks).toEqual([])
    expect(panel.isDestroyed()).toBe(false)
    native.send.mockClear()
    result.resolve({ blocks: [] })
    await settle()
    expect(native.send).not.toHaveBeenCalled()
    expect((await invoke(panel, { method: 'command', action: 'once' })).ok).toBe(true)
    expect(native.send).toHaveBeenCalledWith({ type: 'once' })
  })
})
