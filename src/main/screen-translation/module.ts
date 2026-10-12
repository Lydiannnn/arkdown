import { BrowserWindow, ipcMain, clipboard, nativeTheme, screen, type IpcMainInvokeEvent } from 'electron'
import { access, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { ModelConnectionService } from '../models/model-connection-service'
import type { ModelProtocolClient } from '../models/model-protocol-client'
import { ModelProtocolError } from '../models/model-errors'
import type { SettingsUpdater } from '../settings/settings-coordinator'
import { normalizeEditorAppearancePreferences, resolveEditorTheme } from '../../shared/editor-appearance-preferences'
import { normalizeShortcutBindings, shortcutFor } from '../../shared/keyboard-shortcuts'
import { parseScreenTranslationBlocks, parseScreenTranslationBounds, parseScreenTranslationPatch, screenTranslationRecord,
  SCREEN_TRANSLATION_CHANNEL, SCREEN_TRANSLATION_STATE, SCREEN_TRANSLATION_SHORTCUTS,
  type ScreenTranslationPreferences, type ScreenTranslationSnapshot, type ScreenTranslationStatus } from '../../shared/screen-translation'
import { ScreenLineProcess } from './line-process'
import { ScreenTranslationWorker, ScreenWorkerError } from './worker-client'
import { readScreenTranslationBlocks } from './translation-pipeline'
import { ScreenModelTranslator, type ScreenModelAuthorityContext } from './model-translator'
import type { SettingsAuthority } from '../settings/settings-authority'
import { ScreenTranslationSettingsStore } from './settings-store'
import { ScreenScopedShortcut } from './scoped-shortcut'
import type { ScreenshotGlobalShortcutAdapter } from '../screenshot-translation/screenshot-shortcut'
import type { ModelCapabilityRulesState } from '../../shared/model-capability-rules-state'
import { DEFAULT_FLOATING_TRANSLATION_SETTINGS, featureModelConnections, isCodexCliConnection, type FloatingTranslationSettings, type LargeModelSettings } from '../../shared/large-model-settings'
import { parsePublicModelSettingsSnapshot, type PublicModelSettingsSnapshot, type PublicModelMutationResult } from '../../shared/settings-observation'
import type { ScreenTranslationComponentManager } from './component-manager'
import { SCREEN_TRANSLATION_COMPONENT_DESCRIPTOR } from '../../shared/screen-translation-component-manifest'

const initialStatus = (): ScreenTranslationStatus => ({ automatic: false, triggerMode: 'hotkey', busy: false,
  showOriginal: false, result: { blocks: [] }, error: null, status: '拖动准星选择区域，然后开始翻译。' })
function handleString(window: BrowserWindow): string {
  const bytes = window.getNativeWindowHandle()
  return (bytes.length >= 8 ? bytes.readBigUInt64LE(0) : BigInt(bytes.readUInt32LE(0))).toString()
}
const modelMessages: Record<string, string> = {
  'authentication-failed': '大模型认证失败，请在管理大模型中检查 API Key。',
  'model-not-found': '未找到配置的大模型，请重新选择。', 'invalid-endpoint': '大模型接口地址无效或不可用。',
  timeout: '大模型请求超时，请重试或缩小选区。', 'rate-limited': '大模型请求过于频繁，请稍后重试。',
  'quota-exceeded': '大模型账户余额或配额不足。', 'incompatible-response': '大模型返回的格式不兼容，请重试。',
}

export interface ScreenTranslationObservedModels {
  getDisplay(): PublicModelSettingsSnapshot
  getSettings(): Promise<PublicModelSettingsSnapshot>
  setFloatingTranslation(observed: PublicModelSettingsSnapshot, patch: Partial<FloatingTranslationSettings>): Promise<PublicModelMutationResult>
}
type LegacyModels = Pick<ModelConnectionService, 'getSettings' | 'getCredentialSnapshot' | 'setFloatingTranslation'>
interface ScreenTranslationModuleBaseOptions {
  dataRoot: string; helperPath: string; workerPath?: string; preload: string; rendererFile: string; rendererUrl?: string
  componentManager?: ScreenTranslationComponentManager
  createComponentManager?(): Promise<ScreenTranslationComponentManager>
  settings: Pick<SettingsUpdater, 'get'>
  client: ModelProtocolClient; globalShortcut: ScreenshotGlobalShortcutAdapter
  getModelRules?(): ModelCapabilityRulesState
  openModels(owner: BrowserWindow): void
  admitWork?(owner: BrowserWindow): boolean
}
export type ScreenTranslationModuleOptions = ScreenTranslationModuleBaseOptions & (
  | { observedModels: ScreenTranslationObservedModels; authority: Pick<SettingsAuthority, 'readExecution' | 'admitExecution'>; models?: LegacyModels }
  // Compatibility for old synthetic fixtures; production supplies observedModels and authority.
  | { observedModels?: undefined; models: LegacyModels; authority?: Pick<SettingsAuthority, 'readExecution' | 'admitExecution'> }
)
class ScreenSettingsConflict extends Error {
  constructor() { super('翻译设置已被其他窗口修改，请放弃修改并重新载入。') }
}
type ScreenSettingsCategory = 'central' | 'local' | 'credentials'
export class ScreenTranslationModule {
  private readonly store: ScreenTranslationSettingsStore
  private readonly translator: ScreenModelTranslator
  private window?: BrowserWindow
  private owner?: BrowserWindow
  private native?: ScreenLineProcess
  private worker?: ScreenTranslationWorker
  private status = initialStatus()
  private configuredBaidu = false
  private engineReady = false
  private opening?: Promise<void>
  private closing?: Promise<void>
  private forceClosing = false
  private starting?: { generation: number; promise: Promise<void> }
  private unsubscribeComponent?: () => void
  private componentManager?: ScreenTranslationComponentManager
  private componentInitialization?: Promise<ScreenTranslationComponentManager | undefined>
  private componentInitializationError: string | null = null
  private disposed = false
  private generation = 0
  private translationRevision = 0
  private requests = new Map<number, AbortController>()
  private contextTimer?: ReturnType<typeof setInterval>
  private geometryTimer?: ReturnType<typeof setTimeout>
  private lastContext = ''
  private ownerClose?: () => void
  private settingsTail: Promise<unknown> = Promise.resolve()
  private settingsFailures = new Map<ScreenSettingsCategory, unknown>()
  readonly shortcuts: { id: string; registration: ScreenScopedShortcut }[]
  constructor(private readonly options: ScreenTranslationModuleOptions) {
    this.store = new ScreenTranslationSettingsStore(path.join(options.dataRoot, 'screen-translation'))
    this.translator = new ScreenModelTranslator(options.client)
    const bindings = normalizeShortcutBindings(options.settings.get().shortcuts)
    this.shortcuts = [
      { id: SCREEN_TRANSLATION_SHORTCUTS.once, registration: new ScreenScopedShortcut(options.globalShortcut,
        shortcutFor(SCREEN_TRANSLATION_SHORTCUTS.once, bindings), () => { void this.command('once').catch(error => this.showError(error)) }, () => this.shortcutError()) },
      { id: SCREEN_TRANSLATION_SHORTCUTS.toggle, registration: new ScreenScopedShortcut(options.globalShortcut,
        shortcutFor(SCREEN_TRANSLATION_SHORTCUTS.toggle, bindings), () => { void this.command(this.status.automatic ? 'pause' : 'start').catch(error => this.showError(error)) }, () => this.shortcutError()) },
      { id: SCREEN_TRANSLATION_SHORTCUTS.clear, registration: new ScreenScopedShortcut(options.globalShortcut,
        shortcutFor(SCREEN_TRANSLATION_SHORTCUTS.clear, bindings), () => { void this.command('clear').catch(error => this.showError(error)) }, () => this.shortcutError()) },
    ]
    this.componentManager = options.componentManager
    this.unsubscribeComponent = this.componentManager?.subscribe(() => this.publish())
    ipcMain.handle(SCREEN_TRANSLATION_CHANNEL, async (event, input: unknown) => {
      try { this.assertOwner(event); return { ok: true, value: await this.handle(input) } }
      catch (error) { return { ok: false, error: this.safeError(error) } }
    })
  }
  private assertOwner(event: IpcMainInvokeEvent): void {
    if (!this.window || this.window.isDestroyed() || event.sender !== this.window.webContents
      || event.senderFrame !== this.window.webContents.mainFrame) throw new Error('此窗口无权操作悬浮翻译窗。')
  }
  private safeError(error: unknown): string {
    if (error instanceof ModelProtocolError) return modelMessages[error.status] ?? '大模型请求失败。'
    if (error instanceof Error && error.message.length <= 240 && /[\u3400-\u9fff]/.test(error.message)
      && !/https?:\/\/|Bearer\s|access_token|api_key=|secret_key=/i.test(error.message)) return error.message
    return '悬浮翻译窗操作失败，请重试。'
  }
  private showError(error: unknown): void { this.status = { ...this.status, error: this.safeError(error) }; this.publish() }
  private shortcutError(): void { this.showError(new Error('悬浮翻译窗快捷键被占用。可使用按钮，或在编辑 → 快捷键中修改。')) }
  private modelSettings(): LargeModelSettings {
    return this.options.observedModels ? this.options.observedModels.getDisplay().settings : this.options.models.getSettings()
  }
  private preferences(models = this.modelSettings()): ScreenTranslationPreferences {
    const binding = models.floatingTranslation
    return { ...this.store.get(), ...DEFAULT_FLOATING_TRANSLATION_SETTINGS, ...binding, target: binding?.target ?? 'auto' }
  }
  snapshot(): ScreenTranslationSnapshot {
    const appearance = normalizeEditorAppearancePreferences(this.options.settings.get().appearance)
    const bindings = normalizeShortcutBindings(this.options.settings.get().shortcuts)
    const observed = this.options.observedModels?.getDisplay()
    const models = observed?.settings ?? this.modelSettings()
    return {
      ...(this.componentManager ? { component: this.componentManager.getState() } : this.options.createComponentManager ? {
        component: { status: this.componentInitializationError ? 'failed' as const : 'absent' as const,
          version: SCREEN_TRANSLATION_COMPONENT_DESCRIPTOR.version, downloadBytes: SCREEN_TRANSLATION_COMPONENT_DESCRIPTOR.bytes,
          progress: null, error: this.componentInitializationError },
      } : {}),
      preferences: this.preferences(models), models, ...(observed ? { modelObservation: observed } : {}), configuredBaidu: this.configuredBaidu,
      modelRules: this.options.getModelRules?.(),
      status: structuredClone(this.status), engineReady: this.engineReady,
      theme: { mode: resolveEditorTheme(appearance.editorTheme, nativeTheme.shouldUseDarkColors) === 'dark' ? 'dark' : 'light', accent: appearance.themeColor },
      shortcuts: { once: shortcutFor(SCREEN_TRANSLATION_SHORTCUTS.once, bindings), toggle: shortcutFor(SCREEN_TRANSLATION_SHORTCUTS.toggle, bindings), clear: shortcutFor(SCREEN_TRANSLATION_SHORTCUTS.clear, bindings) },
    }
  }
  private publish(): void {
    if (this.window && !this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
      try { this.window.webContents.send(SCREEN_TRANSLATION_STATE, this.snapshot()) } catch { /* Closing renderer. */ }
    }
  }
  async open(owner: BrowserWindow): Promise<void> {
    if (this.disposed) return
    if (this.options.admitWork?.(owner) === false) return
    if (this.closing) await this.closing
    if (this.opening) return this.opening
    if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); return }
    const operation = this.openInternal(owner)
    this.opening = operation
    try { await operation } finally { if (this.opening === operation) this.opening = undefined }
  }
  private async openInternal(owner: BrowserWindow): Promise<void> {
    const generation = ++this.generation
    await this.store.load()
    await this.options.observedModels?.getSettings()
    if (generation !== this.generation || owner.isDestroyed() || this.disposed || this.closing) return
    this.owner = owner; this.status = { ...initialStatus(), triggerMode: this.store.get().triggerMode }; this.engineReady = false
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const width = Math.min(360, display.workArea.width)
    const height = Math.min(450, display.workArea.height)
    const window = new BrowserWindow({ width, height, minWidth: width, minHeight: height, resizable: true,
      x: display.workArea.x + display.workArea.width - width - 16, y: display.workArea.y + 16,
      title: '悬浮翻译窗 — Arkdown', show: false, frame: false, roundedCorners: true,
      alwaysOnTop: true, skipTaskbar: false, backgroundColor: this.snapshot().theme.mode === 'dark' ? '#181818' : '#ffffff',
      webPreferences: { preload: this.options.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    })
    this.window = window
    // Fractional-DPI native frames can inflate constructor dimensions; target the page once before loading.
    window.setContentSize(width, height)
    window.setContentProtection(true)
    window.on('page-title-updated', event => event.preventDefault())
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.on('close', event => { event.preventDefault(); void this.close().catch(error => this.showError(error)) })
    window.webContents.on('render-process-gone', () => { void this.closeForDisposal().catch(error => this.showError(error)) })
    window.once('ready-to-show', () => { if (!window.isDestroyed()) { window.show(); this.publish() } })
    this.ownerClose = () => { void this.closeForDisposal().catch(error => this.showError(error)) }
    owner.once('closed', this.ownerClose)
    try {
      if (this.options.rendererUrl) {
        const url = new URL(this.options.rendererUrl); url.search = ''; url.searchParams.set('surface', 'screen-translation')
        await window.loadURL(url.toString())
      } else await window.loadFile(this.options.rendererFile, { query: { surface: 'screen-translation' } })
      await this.startEngine(generation)
    } catch (error) { if (generation === this.generation) this.showError(error) }
  }
  private async startEngine(generation: number): Promise<void> {
    if (this.engineReady || generation !== this.generation || this.disposed || this.closing) return
    if (this.starting) {
      const pending = this.starting
      if (pending.generation === generation) return pending.promise
      await pending.promise
      if (this.starting === pending) this.starting = undefined
      return this.startEngine(generation)
    }
    const operation = this.startEngineInternal(generation)
    this.starting = { generation, promise: operation }
    try { await operation } finally { if (this.starting?.promise === operation) this.starting = undefined }
  }
  private async prepareComponentManager(): Promise<ScreenTranslationComponentManager | undefined> {
    if (this.componentManager || !this.options.createComponentManager) return this.componentManager
    if (this.componentInitialization) return this.componentInitialization
    const operation = (async () => {
      try {
        const manager = await this.options.createComponentManager!()
        if (this.disposed) { await manager.dispose(); return undefined }
        this.componentManager = manager
        this.componentInitializationError = null
        this.unsubscribeComponent = manager.subscribe(() => this.publish())
        this.publish()
        return manager
      } catch {
        this.componentInitializationError = '无法准备翻译组件，请检查目录权限后重试。'
        this.publish()
        return undefined
      }
    })()
    this.componentInitialization = operation
    try { return await operation } finally { if (this.componentInitialization === operation) this.componentInitialization = undefined }
  }
  private async startEngineInternal(generation: number): Promise<void> {
    const current = () => generation === this.generation && !this.disposed && !this.closing && !this.forceClosing
    const settleInteractiveClose = async () => {
      // A failed user close retains this panel and may resume its initialization.
      // Unavailable-owner disposal must never start another helper while draining.
      while (this.closing && !this.disposed && !this.forceClosing && generation === this.generation) {
        await this.closing.catch(() => undefined)
      }
    }
    try {
      const manager = await this.prepareComponentManager()
      await settleInteractiveClose()
      if (!current()) return
      const workerPath = manager ? await manager.ensureRuntime()
        : this.options.createComponentManager ? undefined : this.options.workerPath
      await settleInteractiveClose()
      if (!current()) return
      if (!workerPath) { this.publish(); return }
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      await Promise.all([access(this.options.helperPath), access(workerPath)])
      await settleInteractiveClose()
      if (!current()) return
      this.worker = new ScreenTranslationWorker({ executable: workerPath,
        credentialsFile: path.join(this.store.directory, 'baidu.credentials.json') })
      this.native = new ScreenLineProcess({ executable: this.options.helperPath, args: ['--parent-pid', String(process.pid)],
        protocol: 1, readyTimeoutMs: 15_000, lineLimit: 32_000_000 })
      this.native.onMessage(value => this.onNative(value, generation))
      this.native.onExit(() => {
        if (generation !== this.generation || this.closing) return
        this.generation += 1
        this.native = undefined
        clearInterval(this.contextTimer)
        this.engineReady = false; this.abortRequests(); void this.worker?.stop()
        this.shortcuts.forEach(item => item.registration.deactivate())
        this.showError(new Error('屏幕取景组件已退出，请关闭后重新打开此工具。'))
      })
      await this.native.start()
      await settleInteractiveClose()
      if (!current()) return
      const saved = this.store.get().bounds
      const point = screen.dipToScreenPoint({ x: display.workArea.x + 80, y: display.workArea.y + 120 })
      const bounds = saved ?? { ...point, width: Math.round(600 * display.scaleFactor), height: Math.round(280 * display.scaleFactor) }
      this.configure(bounds)
      this.engineReady = true
      this.shortcuts.forEach(item => item.registration.activate())
      this.lastContext = this.contextSignature()
      this.contextTimer = setInterval(() => { try { this.synchronizeContext() } catch (error) { this.showError(error) } }, 1000)
      this.publish()
      const status = await this.worker.request({ mode: 'credentials-status' })
      await settleInteractiveClose()
      if (!current()) return
      this.configuredBaidu = status.configured === true; this.publish()
    } catch (error) {
      await settleInteractiveClose()
      if (!current()) return
      this.engineReady = false
      clearInterval(this.contextTimer)
      this.shortcuts.forEach(item => item.registration.deactivate())
      const native = this.native; const worker = this.worker
      this.native = undefined; this.worker = undefined
      await Promise.allSettled([native?.stop(true), worker?.dispose()])
      if (current()) this.showError(error)
    }
  }
  private contextSignature(): string {
    const state = this.snapshot()
    const selected = featureModelConnections(state.models).find(connection => connection.id === state.preferences.connectionId)
    return JSON.stringify([state.theme, state.models, selected, state.modelRules])
  }
  private synchronizeContext(): void {
    const next = this.contextSignature()
    if (this.lastContext === next) return
    this.lastContext = next
    // Changing a model while a request is in flight must never publish its old response.
    this.abortRequests(); this.translator.clear(); this.configure(); this.publish()
  }
  private configure(bounds?: ScreenTranslationPreferences['bounds']): void {
    const state = this.snapshot()
    const dark = state.theme.mode === 'dark'
    this.native?.send({ type: 'configure', backend: state.preferences.backend, target: state.preferences.target,
      triggerMode: state.preferences.triggerMode, ...(bounds ? { bounds } : {}),
      theme: { background: dark ? '#181818' : '#FFFFFF', foreground: dark ? '#E3E3E3' : '#333333',
        accent: state.theme.accent, border: dark ? '#555555' : '#DDDDDD' },
      excludedWindowHandles: this.window ? [handleString(this.window)] : [],
    })
  }
  private onNative(value: Record<string, unknown>, generation: number): void {
    if (generation !== this.generation) return
    if (value.type === 'request') { void this.translate(value, generation).catch(error => {
      if (generation === this.generation) this.showError(error)
    }); return }
    if (value.type === 'cancel' && typeof value.id === 'number') { this.requests.get(value.id)?.abort(); this.requests.delete(value.id); return }
    if (value.type === 'error') { this.showError(new Error(String(value.message))); return }
    if (value.type !== 'state') return
    const blocks = screenTranslationRecord(value.result) ? parseScreenTranslationBlocks(value.result.blocks) : undefined
    if (!blocks || typeof value.automatic !== 'boolean' || typeof value.busy !== 'boolean'
      || typeof value.showOriginal !== 'boolean' || !['automatic', 'hotkey'].includes(value.triggerMode as string)) return
    const bounds = parseScreenTranslationBounds(value.bounds)
    this.status = { automatic: value.automatic, busy: value.busy, showOriginal: value.showOriginal,
      triggerMode: value.triggerMode as 'automatic' | 'hotkey', result: { blocks }, ...(bounds ? { bounds } : {}),
      error: typeof value.error === 'string' ? this.safeError(new Error(value.error)) : null,
      status: typeof value.status === 'string' ? value.status.slice(0, 240) : '',
    }
    if (bounds && JSON.stringify(bounds) !== JSON.stringify(this.store.get().bounds)) {
      clearTimeout(this.geometryTimer)
      this.geometryTimer = setTimeout(() => { void this.store.update({ bounds }).catch(error => this.showError(error)) }, 500)
    }
    this.publish()
  }
  private abortRequests(): void { for (const request of this.requests.values()) request.abort(); this.requests.clear() }
  private async translate(value: Record<string, unknown>, generation: number): Promise<void> {
    if (this.closing || this.disposed || this.settingsFailures.size) return
    const id = value.id
    if (!Number.isSafeInteger(id) || (id as number) < 1 || this.requests.has(id as number) || this.requests.size > 1) return
    if (typeof value.image !== 'string' || value.image.length > 28_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.image)) return
    const preferences = this.preferences()
    if (value.target !== preferences.target || value.backend !== preferences.backend) {
      this.native?.send({ type: 'result', id, error: '翻译设置已变更，请重新开始。' }); return
    }
    const controller = new AbortController(); this.requests.set(id as number, controller)
    const modelContext = this.contextSignature()
    const assertCurrentContext = () => {
      if (modelContext !== this.contextSignature()) { this.synchronizeContext(); controller.abort() }
      controller.signal.throwIfAborted()
    }
    const revision = this.translationRevision
    const native = this.native
    const worker = this.worker
    const reply = (result: Record<string, unknown>) => {
      if (generation !== this.generation || revision !== this.translationRevision || native !== this.native || !native) return
      if (modelContext !== this.contextSignature()) { this.synchronizeContext(); return }
      try { native.send({ type: 'result', id, ...result }) }
      catch (error) { this.showError(error) }
    }
    try {
      if (!worker) throw new Error('翻译组件尚未就绪。')
      let connection: Awaited<ReturnType<ModelConnectionService['getCredentialSnapshot']>> | undefined
      let authorityContext: ScreenModelAuthorityContext | undefined
      if (preferences.backend === 'model') {
        if (!preferences.connectionId) throw new ScreenWorkerError('请选择悬浮翻译窗使用的大模型。', true)
        if (this.options.authority) {
          const paired = await this.options.authority.readExecution({ feature: 'floatingTranslation' })
          const binding = paired.observed.settings.floatingTranslation ?? DEFAULT_FLOATING_TRANSLATION_SETTINGS
          if (binding.connectionId !== preferences.connectionId || binding.thinkingMode !== preferences.thinkingMode
            || binding.reasoningEffort !== preferences.reasoningEffort || (binding.target ?? 'auto') !== preferences.target) {
            throw new ScreenWorkerError('翻译设置已变更，请重新开始。', true)
          }
          connection = { connection: paired.connection, apiKey: isCodexCliConnection(paired.connection) ? '' : paired.apiKey }
          authorityContext = { authority: this.options.authority, observed: paired.observed }
        } else if (!this.options.observedModels) connection = await this.options.models.getCredentialSnapshot(preferences.connectionId)
        else throw new ScreenWorkerError('翻译设置服务尚未就绪。', true)
        controller.signal.throwIfAborted()
        if (!connection.apiKey && !isCodexCliConnection(connection.connection)) throw new ScreenWorkerError('无法读取模型密钥，请在管理大模型中重新配置。', true)
      }
      controller.signal.throwIfAborted()
      let blocks = await readScreenTranslationBlocks(worker, value.image, preferences, controller.signal, assertCurrentContext)
      if (connection) blocks = authorityContext
        ? await this.translator.translate(blocks, connection.connection, connection.apiKey!, preferences, controller.signal, authorityContext)
        : await this.translator.translate(blocks, connection.connection, connection.apiKey!, preferences, controller.signal)
      controller.signal.throwIfAborted()
      reply({ result: { blocks } })
    } catch (error) {
      reply({
        error: controller.signal.aborted ? '已取消' : this.safeError(error),
        needsSettings: error instanceof ScreenWorkerError && error.needsSettings
          || error instanceof ModelProtocolError && ['authentication-failed', 'model-not-found', 'invalid-endpoint'].includes(error.status) })
    } finally { if (this.requests.get(id as number) === controller) this.requests.delete(id as number) }
  }
  private async handle(input: unknown): Promise<unknown> {
    if (!screenTranslationRecord(input)) throw new Error('悬浮翻译窗请求无效。')
    if (input.method !== 'state' && input.method !== 'command' && this.owner
      && this.options.admitWork?.(this.owner) === false) throw new Error('正在准备更新，请稍候。')
    if (input.method === 'state') {
      if (input.reloadSettings !== undefined && input.reloadSettings !== true) throw new Error('悬浮翻译窗请求无效。')
      if (this.closing || this.disposed) throw new Error('悬浮翻译窗正在关闭。')
      const operation = this.settingsTail.then(async () => {
        await this.options.observedModels?.getSettings()
        if (input.reloadSettings === true) {
          await this.store.reload()
          this.native?.send({ type: 'automatic', enabled: false }); this.abortRequests()
          this.translator.clear(); this.configure()
          this.settingsFailures.clear()
          this.status = { ...this.status, error: null }
          this.publish()
        }
        return this.snapshot()
      })
      this.settingsTail = operation.catch(() => undefined)
      return operation
    }
    if (input.method === 'command') return this.command(input.action)
    if (input.method === 'settings') {
      const patch = parseScreenTranslationPatch(input.patch)
      if (!patch || !Object.keys(patch).length || 'bounds' in patch) throw new Error('悬浮翻译窗设置无效。')
      const { connectionId, thinkingMode, reasoningEffort, target, ...localPatch } = patch
      const central = connectionId !== undefined || thinkingMode !== undefined || reasoningEffort !== undefined || target !== undefined
      const observed = central && this.options.observedModels ? parsePublicModelSettingsSnapshot(input.observed) : undefined
      if (central && this.options.observedModels && (!observed || Object.keys(localPatch).length)) throw new Error('翻译设置观察无效，请重新载入后操作。')
      return this.serializeSettings(central ? 'central' : 'local', async () => {
        if (!this.options.observedModels && patch.connectionId && !featureModelConnections(this.modelSettings()).some(item => item.id === patch.connectionId)) throw new Error('所选模型已不存在，请重新选择。')
        this.native?.send({ type: 'automatic', enabled: false }); this.abortRequests()
        if (central) {
          const centralPatch = {
            ...(connectionId === undefined ? {} : { connectionId }),
            ...(thinkingMode === undefined ? {} : { thinkingMode }),
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            ...(target === undefined ? {} : { target }),
          }
          if (this.options.observedModels) {
            const result = await this.options.observedModels.setFloatingTranslation(observed!, centralPatch)
            if (result.status === 'conflict') throw new ScreenSettingsConflict()
          } else await this.options.models.setFloatingTranslation(centralPatch)
        }
        if (Object.keys(localPatch).length) await this.store.update(localPatch)
        this.translator.clear(); this.configure(); this.publish(); return this.snapshot()
      }).catch(error => { if (error instanceof ScreenSettingsConflict) return { status: 'conflict' as const }; throw error })
    }
    if (input.method === 'credentials') {
      const { apiKey, secretKey } = input
      if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 4096
        || typeof secretKey !== 'string' || !secretKey.trim() || secretKey.length > 4096) throw new Error('请同时填写 API Key 和 Secret Key。')
      return this.serializeSettings('credentials', async () => {
        this.native?.send({ type: 'automatic', enabled: false }); this.abortRequests()
        await mkdir(this.store.directory, { recursive: true })
        const result = await this.worker?.request({ mode: 'configure-credentials', api_key: apiKey.trim(), secret_key: secretKey.trim() })
        if (result?.configured !== true) throw new Error('百度密钥保存失败，请重试。')
        this.configuredBaidu = true; this.configure(); this.publish(); return this.snapshot()
      })
    }
    throw new Error('悬浮翻译窗操作无效。')
  }
  private serializeSettings<T>(category: ScreenSettingsCategory, action: () => Promise<T>): Promise<T> {
    if (this.closing || this.disposed) return Promise.reject(new Error('悬浮翻译窗正在关闭。'))
    const operation = this.settingsTail.then(async () => {
      try { const value = await action(); this.settingsFailures.delete(category); return value }
      catch (error) { this.settingsFailures.set(category, error); throw error }
    })
    // The queue remains usable for an explicit retry; failure stays separately visible to close.
    this.settingsTail = operation.catch(() => undefined)
    return operation
  }
  private async command(action: unknown): Promise<ScreenTranslationSnapshot | void> {
    if (action === 'close') return this.close()
    if (!['pause', 'clear', 'copy', 'cancel-install'].includes(String(action)) && this.owner
      && this.options.admitWork?.(this.owner) === false) throw new Error('正在准备更新，请稍候。')
    if (this.closing || this.disposed) throw new Error('悬浮翻译窗正在关闭。')
    if (action === 'cancel-install') {
      await this.componentManager?.cancel()
      this.publish(); return this.snapshot()
    }
    if (action === 'install-engine') {
      if (this.engineReady) return this.snapshot()
      const generation = this.generation
      const manager = await this.prepareComponentManager()
      if (!manager || generation !== this.generation || this.closing || this.disposed) return this.snapshot()
      this.status = { ...this.status, error: null }
      await manager.install()
      if (generation === this.generation && manager.getState().status === 'installed') {
        await this.startEngine(generation)
      }
      this.publish(); return this.snapshot()
    }
    if (action === 'clear') {
      this.translationRevision += 1
      this.abortRequests(); this.translator.clear()
      this.native?.send({ type: 'clear' })
      this.status = { ...this.status, automatic: false, busy: false, showOriginal: false,
        result: { blocks: [] }, error: null, status: '译文已清除，等待再次翻译。' }
      this.publish(); return this.snapshot()
    }
    if (action === 'pause') { this.native?.send({ type: 'automatic', enabled: false }); this.abortRequests(); return this.snapshot() }
    if (action === 'copy') { clipboard.writeText(this.status.result.blocks.map(block => block.text).join('\n')); return this.snapshot() }
    if (action === 'open-models') {
      this.native?.send({ type: 'automatic', enabled: false }); this.abortRequests()
      if (this.owner && !this.owner.isDestroyed()) this.options.openModels(this.owner)
      return this.snapshot()
    }
    if (!this.engineReady || !this.native) throw new Error('悬浮翻译窗组件尚未就绪。')
    if (action === 'show-original' || action === 'show-translation') {
      this.native.send({ type: 'original', show: action === 'show-original' }); return this.snapshot()
    }
    if (action !== 'once' && action !== 'start') throw new Error('悬浮翻译窗操作无效。')
    const revision = this.translationRevision
    await this.settingsTail
    if (this.settingsFailures.size) throw new Error('翻译设置尚未保存，请重试或放弃修改并重新载入。')
    if (this.closing || this.disposed) return this.snapshot()
    if (revision !== this.translationRevision || !this.native || !this.engineReady) return this.snapshot()
    const preferences = this.preferences()
    if (preferences.backend === 'baidu' && !this.configuredBaidu) throw new Error('请先配置百度智能云翻译密钥。')
    if (preferences.backend === 'model' && !featureModelConnections(this.modelSettings()).some(item => item.id === preferences.connectionId)) throw new Error('请先选择悬浮翻译窗使用的大模型。')
    this.native.send(action === 'once' ? { type: 'once' } : { type: 'automatic', enabled: true })
    return this.snapshot()
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    const operation = this.closeInternal(); this.closing = operation
    void operation.finally(() => { this.closing = undefined; this.forceClosing = false }).catch(() => undefined)
    return operation
  }
  private closeForDisposal(): Promise<void> { this.forceClosing = true; return this.close() }
  private async closeInternal(): Promise<void> {
    await this.settingsTail
    if (!this.forceClosing && !this.disposed && this.owner && !this.owner.isDestroyed()
      && this.window && !this.window.isDestroyed() && !this.window.webContents.isDestroyed() && this.settingsFailures.size) {
      throw new Error('翻译设置尚未保存，请重试或放弃修改并重新载入后关闭。')
    }
    this.generation += 1; this.engineReady = false; this.abortRequests()
    this.opening = undefined
    clearInterval(this.contextTimer); clearTimeout(this.geometryTimer)
    if (this.ownerClose && this.owner && !this.owner.isDestroyed()) this.owner.removeListener('closed', this.ownerClose)
    this.shortcuts.forEach(item => item.registration.deactivate())
    const native = this.native; const worker = this.worker; this.native = undefined; this.worker = undefined
    try { native?.send({ type: 'close' }) } catch { /* Already exited. */ }
    await Promise.allSettled([native?.stop(true), worker?.dispose(), this.componentManager?.cancel()])
    if (this.status.bounds) await this.store.update({ bounds: this.status.bounds }).catch(() => undefined)
    const window = this.window; this.window = undefined; this.owner = undefined
    if (window && !window.isDestroyed()) window.destroy()
    this.status = initialStatus(); this.requests.clear(); this.configuredBaidu = false
    this.settingsFailures.clear()
  }
  async dispose(): Promise<void> {
    this.disposed = true; this.unsubscribeComponent?.(); await this.closeForDisposal()
    await this.componentInitialization
    await this.componentManager?.dispose()
    this.shortcuts.forEach(item => item.registration.dispose()); ipcMain.removeHandler(SCREEN_TRANSLATION_CHANNEL)
  }
}
