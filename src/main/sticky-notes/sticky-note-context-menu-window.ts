import {
  STICKY_NOTE_CONTEXT_MENU_CHANNELS,
  type StickyNoteContextMenuCommand,
  type StickyNoteContextMenuOpenInput,
} from '../../shared/sticky-note-context-menu'

interface ContextMenuWebContents {
  id?: number
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

interface ContextMenuOwnerWindow {
  webContents: ContextMenuWebContents & { id: number }
  isDestroyed(): boolean
  on(event: 'move' | 'resize' | 'blur', listener: () => void): void
  once(event: 'closed', listener: () => void): void
}

interface ContextMenuOverlayWindow {
  webContents: ContextMenuWebContents
  isDestroyed(): boolean
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void
  showInactive(): void
  moveTop(): void
  setOpacity(opacity: number): void
  setIgnoreMouseEvents(ignore: boolean): void
  hide(): void
  on(event: 'blur', listener: () => void): void
  once(event: 'closed', listener: () => void): void
  whenReady?(): Promise<void>
}

export interface StickyNoteContextMenuWindowOptions {
  createWindow(): ContextMenuOverlayWindow
  displayForPoint(point: { x: number; y: number }): {
    workArea: { x: number; y: number; width: number; height: number }
  }
}

interface ActiveMenu {
  owner: ContextMenuOwnerWindow
  requestId: string
}

export class StickyNoteContextMenuWindow {
  private readonly owners = new Map<number, ContextMenuOwnerWindow>()
  private overlay: ContextMenuOverlayWindow | null = null
  private overlayShown = false
  private active: ActiveMenu | null = null
  private pending: ActiveMenu | null = null
  private creating: Promise<ContextMenuOverlayWindow> | null = null

  constructor(private readonly options: StickyNoteContextMenuWindowOptions) {}

  registerOwner(owner: ContextMenuOwnerWindow): () => void {
    const ownerWebContentsId = owner.webContents.id
    this.owners.set(ownerWebContentsId, owner)
    const dismiss = () => {
      if (this.active?.owner === owner || this.pending?.owner === owner) this.dismiss()
    }
    owner.on('move', dismiss)
    owner.on('resize', dismiss)
    owner.on('blur', dismiss)
    owner.once('closed', () => {
      dismiss()
      this.owners.delete(ownerWebContentsId)
    })
    return () => {
      dismiss()
      if (this.owners.get(ownerWebContentsId) === owner) this.owners.delete(ownerWebContentsId)
    }
  }

  async open(senderWebContentsId: number, input: StickyNoteContextMenuOpenInput): Promise<boolean> {
    const owner = this.owners.get(senderWebContentsId)
    if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) return false
    if (this.active || this.pending) this.dismiss()
    const pending = { owner, requestId: input.requestId }
    this.pending = pending
    const overlay = await this.getOverlay()
    if (this.pending !== pending) return true
    if (
      overlay.isDestroyed()
      || overlay.webContents.isDestroyed()
      || owner.isDestroyed()
      || owner.webContents.isDestroyed()
    ) {
      this.pending = null
      return false
    }

    const { workArea } = this.options.displayForPoint({ x: input.screenX, y: input.screenY })
    overlay.setBounds(workArea)
    // Place the hidden window before its first native show; the renderer-ready
    // handshake reveals the menu only after it has laid out at these bounds.
    overlay.webContents.send(STICKY_NOTE_CONTEXT_MENU_CHANNELS.show, {
      requestId: input.requestId,
      x: input.screenX - workArea.x,
      y: input.screenY - workArea.y,
      items: input.items,
      ...(input.widthCssPx === undefined ? {} : { widthCssPx: input.widthCssPx }),
      ...(input.submenuWidthCssPx === undefined ? {} : { submenuWidthCssPx: input.submenuWidthCssPx }),
      ...(input.rootIconGutter === undefined ? {} : { rootIconGutter: input.rootIconGutter }),
      ...(input.themeColorRgb === undefined ? {} : { themeColorRgb: input.themeColorRgb }),
      ...(input.colorScheme === undefined ? {} : { colorScheme: input.colorScheme }),
    })
    return true
  }

  ready(sender: ContextMenuWebContents, requestId: string): boolean {
    const overlay = this.overlay
    const pending = this.pending
    if (
      !overlay
      || overlay.isDestroyed()
      || overlay.webContents.isDestroyed()
      || sender !== overlay.webContents
      || !pending
      || pending.requestId !== requestId
    ) return false
    if (pending.owner.isDestroyed() || pending.owner.webContents.isDestroyed()) {
      this.dismiss()
      return false
    }
    this.pending = null
    this.active = pending
    // Enter the native visibility lifecycle only once. Later menus reuse the
    // transparent surface, so repeated right clicks cannot restart Aura's show
    // animation. The first show happens at the final bounds after layout.
    if (!this.overlayShown) {
      overlay.showInactive()
      this.overlayShown = true
    }
    // A pinned owner can rise above the reusable overlay between menu openings.
    // Restore z-order without taking focus (which would dismiss the owner's menu).
    overlay.moveTop()
    overlay.setOpacity(1)
    overlay.setIgnoreMouseEvents(false)
    return true
  }

  execute(sender: ContextMenuWebContents, command: StickyNoteContextMenuCommand): boolean {
    const overlay = this.overlay
    const active = this.active
    if (!overlay || sender !== overlay.webContents || !active) return false
    if (command.requestId !== active.requestId) return false
    if (active.owner.isDestroyed() || active.owner.webContents.isDestroyed()) {
      this.dismiss()
      return false
    }
    active.owner.webContents.send(STICKY_NOTE_CONTEXT_MENU_CHANNELS.command, command)
    return true
  }

  close(sender: ContextMenuWebContents, requestId: string): boolean {
    const current = this.active ?? this.pending
    if (!current || current.requestId !== requestId) return false
    const overlaySender = this.active !== null && this.overlay?.webContents === sender
    const ownerSender = current.owner.webContents === sender
    if (!overlaySender && !ownerSender) return false
    this.dismiss()
    return true
  }

  dismiss(): void {
    const current = this.active ?? this.pending
    this.active = null
    this.pending = null
    if (this.overlay && !this.overlay.isDestroyed()) {
      // Pass through without forwarding mouse movement back to the invisible
      // Chromium view; that view must not compete with the note's cursor.
      this.overlay.setIgnoreMouseEvents(true)
      this.overlay.setOpacity(0)
      if (current && !this.overlay.webContents.isDestroyed()) {
        this.overlay.webContents.send(STICKY_NOTE_CONTEXT_MENU_CHANNELS.reset, {
          requestId: current.requestId,
        })
      }
    }
    if (current && !current.owner.isDestroyed() && !current.owner.webContents.isDestroyed()) {
      current.owner.webContents.send(STICKY_NOTE_CONTEXT_MENU_CHANNELS.closed, {
        requestId: current.requestId,
      })
    }
  }

  private async getOverlay(): Promise<ContextMenuOverlayWindow> {
    if (this.creating) return this.creating
    if (this.overlay && !this.overlay.isDestroyed()) return this.overlay
    this.creating = (async () => {
      const overlay = this.options.createWindow()
      this.overlay = overlay
      this.overlayShown = false
      overlay.on('blur', () => this.dismiss())
      overlay.once('closed', () => {
        if (this.overlay === overlay) {
          this.overlay = null
          this.overlayShown = false
          this.active = null
          this.pending = null
        }
      })
      await overlay.whenReady?.()
      return overlay
    })()
    try {
      return await this.creating
    } finally {
      this.creating = null
    }
  }
}
