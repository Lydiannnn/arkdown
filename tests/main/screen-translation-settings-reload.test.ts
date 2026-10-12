// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import { ScreenTranslationModule, type ScreenTranslationModuleOptions } from '../../src/main/screen-translation/module'
import { ScreenTranslationSettingsStore } from '../../src/main/screen-translation/settings-store'
import { DEFAULT_SCREEN_TRANSLATION, type ScreenTranslationPreferences } from '../../src/shared/screen-translation'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'

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
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(), access: vi.fn(async () => undefined) }))
vi.mock('../../src/main/screen-translation/line-process', () => ({
  ScreenLineProcess: class implements NativeDouble {
    private receive: (value: Record<string, unknown>) => void = () => undefined
    private exited: () => void = () => undefined
    constructor() { doubles.natives.push(this) }
    onMessage(listener: (value: Record<string, unknown>) => void) { this.receive = listener; return () => undefined }
    onExit(listener: () => void) { this.exited = listener; return () => undefined }
    start = vi.fn(async () => undefined)
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

function from(window: BrowserWindow) { return { sender: window.webContents, senderFrame: window.webContents.mainFrame } }
function invoke(window: BrowserWindow, input: unknown) { return doubles.handler!(from(window), input) }

describe('screen translation explicit reload with the real local store', () => {
  let root: string
  let module: ScreenTranslationModule
  let owner: BrowserWindow
  let settingsPath: string
  beforeEach(async () => {
    doubles.windows.length = 0; doubles.natives.length = 0; doubles.workers.length = 0
    root = await mkdtemp(path.join(tmpdir(), 'arkdown-screen-reload-'))
    settingsPath = path.join(root, 'screen-translation', 'settings.json')
    await mkdir(path.dirname(settingsPath))
    await writeFile(settingsPath, JSON.stringify({ ...DEFAULT_SCREEN_TRANSLATION, backend: 'baidu' }), 'utf8')
    const models = structuredClone(DEFAULT_LARGE_MODEL_SETTINGS)
    module = new ScreenTranslationModule({ dataRoot: root, helperPath: 'synthetic-helper', workerPath: 'synthetic-worker',
      preload: 'synthetic-preload', rendererFile: 'synthetic-renderer', settings: { get: () => ({ lastWorkspace: null }) },
      models: { getSettings: () => models, setFloatingTranslation: vi.fn(async () => models), getCredentialSnapshot: vi.fn() },
      client: {} as ScreenTranslationModuleOptions['client'], openModels: vi.fn(),
      globalShortcut: { register: () => true, unregister: () => undefined, isRegistered: () => false } })
    owner = new BrowserWindow({ show: false })
    await module.open(owner)
  })
  afterEach(async () => {
    await module.dispose()
    await rm(root, { recursive: true, force: true })
    vi.clearAllMocks()
  })
  it.each(['unreadable', 'malformed', 'invalid-schema', 'oversized'] as const)('retains local failure and close barrier after a %s actual reload', async failure => {
    const panel = doubles.windows.at(-1)!
    // A directory at the file path deterministically prevents an atomic settings write.
    await rm(settingsPath)
    await mkdir(settingsPath)
    expect(await invoke(panel, { method: 'settings', patch: { backend: 'model' } })).toMatchObject({ ok: false })
    if (failure !== 'unreadable') {
      await rm(settingsPath, { recursive: true })
      await writeFile(settingsPath, failure === 'malformed' ? '{invalid'
        : failure === 'invalid-schema' ? JSON.stringify({ backend: 'invalid' }) : ' '.repeat(16_385), 'utf8')
    }
    expect(await invoke(panel, { method: 'state', reloadSettings: true })).toMatchObject({ ok: false })
    await expect(module.close()).rejects.toThrow()
    expect(panel.isDestroyed()).toBe(false)
    expect(module.snapshot().preferences.backend).toBe('baidu')
    if (failure === 'unreadable') await rm(settingsPath, { recursive: true })
    await writeFile(settingsPath, JSON.stringify({ ...DEFAULT_SCREEN_TRANSLATION, backend: 'baidu' }), 'utf8')
    expect(await invoke(panel, { method: 'state', reloadSettings: true })).toMatchObject({ ok: true })
    await module.close()
    expect(panel.isDestroyed()).toBe(true)
  })
  it('keeps startup tolerant but treats an explicitly missing file as defaults instead of stale cache', async () => {
    const store = new ScreenTranslationSettingsStore(path.dirname(settingsPath))
    await store.load()
    expect(store.get().backend).toBe('baidu')
    await writeFile(settingsPath, '{invalid', 'utf8')
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.get().backend).toBe('baidu')
    await expect(store.reload()).rejects.toThrow()
    await rm(settingsPath)
    await expect(store.reload()).resolves.toBeUndefined()
    expect(store.get()).toEqual(DEFAULT_SCREEN_TRANSLATION)
  })
})
