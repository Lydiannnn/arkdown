import {
  applicationMenuItemById,
  buildApplicationMenuModel,
  DEFAULT_APPLICATION_MENU_RUNTIME_STATE,
  type ApplicationMenuItem,
  type ApplicationMenuSection,
  type ApplicationMenuWindowState,
} from '../shared/application-menu-model'
import { APPLICATION_MENU_CHANGED_CHANNEL } from '../shared/contracts'
import { recentDocumentMenuItemId } from './recent-documents/recent-document-menu-id'
import type { ShortcutBindings } from '../shared/keyboard-shortcuts'

export interface ApplicationMenuWebContents {
  readonly id: number
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
  once(event: 'destroyed', listener: () => void): unknown
}

export interface ApplicationMenuSynchronizerDependencies {
  getShortcutBindings?(): ShortcutBindings
  getRecentDocuments(): readonly string[]
  getFocusedWebContentsId(): number | null
  installNativeModel(model: readonly ApplicationMenuSection[]): void
}

const DEFAULT_WINDOW_STATE: ApplicationMenuWindowState = Object.freeze({
  hasPrintableDocument: DEFAULT_APPLICATION_MENU_RUNTIME_STATE.hasPrintableDocument,
  spellCheckEnabled: DEFAULT_APPLICATION_MENU_RUNTIME_STATE.spellCheckEnabled,
  showEditIndicators: DEFAULT_APPLICATION_MENU_RUNTIME_STATE.showEditIndicators,
  editorZoomPercent: DEFAULT_APPLICATION_MENU_RUNTIME_STATE.editorZoomPercent,
  fullscreen: DEFAULT_APPLICATION_MENU_RUNTIME_STATE.fullscreen,
})

interface WindowEntry {
  contents: ApplicationMenuWebContents
  state: ApplicationMenuWindowState
  model: readonly ApplicationMenuSection[] | null
}

export class ApplicationMenuSynchronizer {
  private readonly windows = new Map<number, WindowEntry>()

  constructor(private readonly dependencies: ApplicationMenuSynchronizerDependencies) {}

  register(contents: ApplicationMenuWebContents): void {
    const entry: WindowEntry = {
      contents,
      state: { ...DEFAULT_WINDOW_STATE },
      model: null,
    }
    this.windows.set(contents.id, entry)
    contents.once('destroyed', () => {
      if (this.windows.get(contents.id) === entry) this.windows.delete(contents.id)
    })
  }

  updateWindowState(id: number, state: ApplicationMenuWindowState): boolean {
    const entry = this.liveEntry(id)
    if (!entry) return false
    entry.state = { ...state }
    this.refresh()
    return true
  }

  updateWindowFullscreen(id: number, fullscreen: boolean): boolean {
    const entry = this.liveEntry(id)
    if (!entry) return false
    entry.state = { ...entry.state, fullscreen }
    this.refresh()
    return true
  }

  modelForWindow(id: number): readonly ApplicationMenuSection[] | null {
    const entry = this.liveEntry(id)
    return entry?.model ?? null
  }

  itemForWindow(id: number, itemId: string): ApplicationMenuItem | null {
    const model = this.modelForWindow(id)
    return model ? applicationMenuItemById(itemId, model) : null
  }

  refresh(): void {
    const focusedId = this.dependencies.getFocusedWebContentsId()
    let focusedModel: readonly ApplicationMenuSection[] | null = null
    for (const [id, entry] of this.windows) {
      if (entry.contents.isDestroyed()) {
        this.windows.delete(id)
        continue
      }
      const model = this.buildModel(entry.state)
      try {
        entry.contents.send(APPLICATION_MENU_CHANGED_CHANNEL, model)
      } catch {
        if (entry.contents.isDestroyed()) this.windows.delete(id)
        continue
      }
      entry.model = model
      if (id === focusedId) focusedModel = model
    }
    if (focusedModel) this.dependencies.installNativeModel(focusedModel)
  }

  private liveEntry(id: number): WindowEntry | null {
    const entry = this.windows.get(id)
    if (!entry) return null
    if (!entry.contents.isDestroyed()) return entry
    this.windows.delete(id)
    return null
  }

  private buildModel(state: ApplicationMenuWindowState): readonly ApplicationMenuSection[] {
    return buildApplicationMenuModel({
      ...state,
      shortcutBindings: this.dependencies.getShortcutBindings?.(),
      recentDocuments: this.dependencies.getRecentDocuments().map((absolutePath) => ({
        id: recentDocumentMenuItemId(absolutePath),
        absolutePath,
      })),
    })
  }
}
