import type { NativeImage } from 'electron'

export interface StickyNoteTrayMenuItem {
  label?: string
  type?: 'separator' | 'checkbox'
  checked?: boolean
  enabled?: boolean
  icon?: NativeImage | string
  submenu?: StickyNoteTrayMenuItem[]
  click?(): void
}

interface StickyNoteTrayTarget {
  setToolTip(value: string): void
  setContextMenu(menu: unknown): void
  destroy(): void
  isDestroyed(): boolean
  on?(event: 'double-click', listener: () => void): void
}

interface BaseTrayOptions {
  createTray(): StickyNoteTrayTarget
  buildMenu(template: StickyNoteTrayMenuItem[]): unknown
  onTrayCreated?(): void
  onTrayDestroyed?(): void
}

export interface StickyNoteTrayOptions extends BaseTrayOptions {
  showApp(): void
  openNoteBox(): void
  createNote(): void
  showAllNotes(): void
  hideAllNotes(): void
  quit(): void
}

export interface ArknoteTrayOptions extends BaseTrayOptions {
  openNoteBox(): void
  createNote(): void
  openArkdown(): void
  openSettings(): void
  quit(): void
  taskbar?: { hidden(): boolean; setHidden(hidden: boolean): Promise<void> }
  activeNotes?: {
    list(): Promise<readonly ArknoteTrayNote[]>
    open(noteId: string): Promise<unknown>
    subscribe(listener: () => void): () => void
    checkIcon: NativeImage | string
  }
  reportError?(error: unknown): void
}

export interface ArknoteTrayNote {
  id: string
  name: string
  displayed: boolean
}

class TrayController {
  private tray: StickyNoteTrayTarget | null = null

  constructor(
    private readonly createTray: () => StickyNoteTrayTarget,
    private readonly initializeTray: (tray: StickyNoteTrayTarget) => void,
    private readonly onTrayCreated: () => void,
    private readonly onTrayDestroyed: () => void,
  ) {}

  initialize(): void {
    if (this.tray && !this.tray.isDestroyed()) return
    const tray = this.createTray()
    this.initializeTray(tray)
    this.tray = tray
    this.onTrayCreated()
  }

  destroy(): void {
    const tray = this.tray
    this.tray = null
    if (tray && !tray.isDestroyed()) {
      tray.destroy()
      this.onTrayDestroyed()
    }
  }

  setMenu(menu: unknown): void {
    if (this.tray && !this.tray.isDestroyed()) this.tray.setContextMenu(menu)
  }
}

export class StickyNoteTray {
  private readonly controller: TrayController

  constructor(private readonly options: StickyNoteTrayOptions) {
    this.controller = new TrayController(options.createTray, (tray) => {
      tray.setToolTip('Arkdown')
      tray.setContextMenu(options.buildMenu([
        { label: 'Arkdown', enabled: false },
        { type: 'separator' },
        { label: '显示 Arkdown', click: options.showApp },
        { label: '打开便签盒子', click: options.openNoteBox },
        { label: '创建便签', click: options.createNote },
        { type: 'separator' },
        { label: '显示全部便签', click: options.showAllNotes },
        { label: '隐藏全部便签', click: options.hideAllNotes },
        { type: 'separator' },
        { label: '退出', click: options.quit },
      ]))
    }, options.onTrayCreated ?? (() => undefined), options.onTrayDestroyed ?? (() => undefined))
  }

  initialize(): void {
    this.controller.initialize()
  }

  destroy(): void {
    this.controller.destroy()
  }
}

export class ArknoteTray {
  private readonly controller: TrayController
  private active = false
  private refreshVersion = 0
  private unsubscribeNotes: (() => void) | undefined
  private notes: readonly ArknoteTrayNote[] = []
  private noteListMessage = '暂无便签'
  private taskbarPending = false
  private taskbarPaused = false
  private readonly taskbarDrainWaiters = new Set<() => void>()

  constructor(private readonly options: ArknoteTrayOptions) {
    this.controller = new TrayController(options.createTray, (tray) => {
      tray.setToolTip('Arknote')
      tray.setContextMenu(options.buildMenu(this.menuTemplate()))
      tray.on?.('double-click', options.openNoteBox)
    }, options.onTrayCreated ?? (() => undefined), options.onTrayDestroyed ?? (() => undefined))
  }

  private menuTemplate(): StickyNoteTrayMenuItem[] {
    const options = this.options
    return [
      { label: '打开便签盒子', click: options.openNoteBox },
      { label: '创建新便签', click: options.createNote },
      { label: '活动中的便签', submenu: this.notes.length === 0
        ? [{ label: this.noteListMessage, enabled: false }]
        : this.notes.map((note) => ({
          // Windows treats & as a menu mnemonic; note names are literal text.
          label: note.name.replace(/&/gu, '&&'),
          ...(note.displayed ? { icon: options.activeNotes?.checkIcon } : {}),
          click: () => {
            if (!this.active) return
            void options.activeNotes?.open(note.id).catch((error) => options.reportError?.(error))
          },
        })),
      },
      { label: '打开 Arkdown', click: options.openArkdown },
      { type: 'separator' },
      { label: '不显示任务栏图标', type: 'checkbox', checked: options.taskbar?.hidden() ?? false,
        enabled: !!options.taskbar && !this.taskbarPending && !this.taskbarPaused, click: () => { void this.toggleTaskbar() } },
      { label: '设置…', click: options.openSettings },
      { label: '退出 Arknote', click: options.quit },
    ]
  }

  private async toggleTaskbar(): Promise<void> {
    if (!this.active || this.taskbarPaused || this.taskbarPending || !this.options.taskbar) return
    this.taskbarPending = true
    const next = !this.options.taskbar.hidden()
    this.controller.setMenu(this.options.buildMenu(this.menuTemplate()))
    try { await this.options.taskbar.setHidden(next) }
    catch (error) { this.options.reportError?.(error) }
    finally {
      this.taskbarPending = false
      for (const resolve of this.taskbarDrainWaiters) resolve()
      this.taskbarDrainWaiters.clear()
      if (this.active) this.controller.setMenu(this.options.buildMenu(this.menuTemplate()))
    }
  }

  /** Participate in the existing Arknote quit fence; never abandon a started save. */
  pauseAndDrain(): Promise<void> {
    this.taskbarPaused = true
    if (this.active) this.controller.setMenu(this.options.buildMenu(this.menuTemplate()))
    return this.taskbarPending ? new Promise(resolve => this.taskbarDrainWaiters.add(resolve)) : Promise.resolve()
  }

  resume(): void {
    this.taskbarPaused = false
    if (this.active) this.controller.setMenu(this.options.buildMenu(this.menuTemplate()))
  }

  private async refreshNotes(): Promise<void> {
    if (!this.active || !this.options.activeNotes) return
    const version = ++this.refreshVersion
    try {
      const notes = await this.options.activeNotes.list()
      if (!this.active || version !== this.refreshVersion) return
      this.notes = notes
      this.noteListMessage = '暂无便签'
    } catch (error) {
      if (!this.active || version !== this.refreshVersion) return
      this.noteListMessage = '暂时无法读取便签'
      this.options.reportError?.(error)
    }
    this.controller.setMenu(this.options.buildMenu(this.menuTemplate()))
  }

  initialize(): void {
    if (this.active) return
    this.active = true
    this.noteListMessage = this.options.activeNotes ? '正在读取便签…' : '暂无便签'
    this.controller.initialize()
    this.unsubscribeNotes = this.options.activeNotes?.subscribe(() => { void this.refreshNotes() })
    void this.refreshNotes()
  }

  destroy(): void {
    this.active = false
    this.refreshVersion += 1
    this.unsubscribeNotes?.()
    this.unsubscribeNotes = undefined
    this.controller.destroy()
  }
}
