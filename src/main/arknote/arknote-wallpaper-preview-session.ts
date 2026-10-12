import type { BrowserWindow, WebContents } from 'electron'
import { PublicError } from '../../shared/public-errors'
import { copyStickyNoteMicaAppearance, parseStickyNoteMicaAppearance, type StickyNoteMicaAppearance } from '../../shared/sticky-note-mica-appearance'
import { copyStickyNoteWallpaperAppearances, parseStickyNoteWallpaperAppearances, type StickyNoteWallpaperAppearances } from '../../shared/sticky-note-glass-appearance'

/** One owner and one native snapshot across all settings renderer generations. */
export class ArknoteWallpaperPreviewCoordinator {
  private owner: symbol | null = null

  constructor(
    private readonly getSaved: () => StickyNoteWallpaperAppearances,
    private readonly apply: (value: StickyNoteWallpaperAppearances) => boolean,
  ) {}

  createSession(): ArknoteWallpaperPreviewSession {
    const owner = Symbol('Wallpaper preview owner')
    this.owner = owner
    return new ArknoteWallpaperPreviewSession(this.getSaved, this, owner)
  }

  isCurrent(owner: symbol): boolean { return this.owner === owner }

  preview(owner: symbol, value: StickyNoteWallpaperAppearances): boolean {
    if (!this.isCurrent(owner)) throw new Error('壁纸材质预览会话已过期')
    return this.apply(copyStickyNoteWallpaperAppearances(value))
  }

  commit(owner: symbol): boolean {
    // An already accepted save may finish after reload. Its persisted result is
    // valid, but only the newest renderer is allowed to change the live preview.
    if (!this.isCurrent(owner)) return true
    return this.apply(copyStickyNoteWallpaperAppearances(this.getSaved()))
  }

  restore(owner: symbol): void {
    if (this.isCurrent(owner)) this.apply(copyStickyNoteWallpaperAppearances(this.getSaved()))
  }
}

/** The Mica compatibility endpoint uses this same session and current glass draft. */
export class ArknoteWallpaperPreviewSession {
  private active = true
  private cancelled = false
  private closed = false
  private saving = false
  private draft: StickyNoteWallpaperAppearances

  constructor(
    private readonly getSaved: () => StickyNoteWallpaperAppearances,
    private readonly coordinator: ArknoteWallpaperPreviewCoordinator,
    private readonly owner: symbol,
  ) {
    this.draft = copyStickyNoteWallpaperAppearances(getSaved())
  }

  private assertAvailable(): void {
    if (!this.active || this.saving || !this.coordinator.isCurrent(this.owner)) {
      throw new Error('壁纸材质预览会话已关闭、过期或正在保存')
    }
  }

  preview(input: StickyNoteWallpaperAppearances | null): StickyNoteWallpaperAppearances {
    const retryingCancel = input === null && this.cancelled && !this.closed
      && !this.saving && this.coordinator.isCurrent(this.owner)
    if (!retryingCancel) this.assertAvailable()
    const value = input === null ? copyStickyNoteWallpaperAppearances(this.getSaved()) : parseStickyNoteWallpaperAppearances(input)
    if (!value) throw new PublicError('INVALID_INPUT')
    // Cancel is final even if a native restore fails; no queued preview may
    // reapply an abandoned draft after the user has cancelled.
    if (input === null) { this.active = false; this.cancelled = true }
    this.draft = copyStickyNoteWallpaperAppearances(value)
    if (!this.coordinator.preview(this.owner, value)) throw new Error('部分便签未能应用壁纸材质参数，请重新尝试')
    return copyStickyNoteWallpaperAppearances(value)
  }

  previewMica(input: StickyNoteMicaAppearance | null): StickyNoteMicaAppearance {
    this.assertAvailable()
    const micaAppearance = input === null ? copyStickyNoteMicaAppearance(this.getSaved().micaAppearance) : parseStickyNoteMicaAppearance(input)
    if (!micaAppearance) throw new PublicError('INVALID_INPUT')
    return this.preview({ ...this.draft, micaAppearance }).micaAppearance
  }

  async save<T>(persist: () => Promise<T>, finish = true): Promise<T> {
    this.assertAvailable()
    // A single synchronous barrier protects all three recipes, including the
    // last full draft whose debounced native preview has not run yet.
    this.saving = true
    try {
      const result = await persist()
      if (!this.coordinator.commit(this.owner)) throw new PublicError('WALLPAPER_APPEARANCE_SAVED_NOT_APPLIED')
      if (finish) this.active = false
      return result
    } catch (error) {
      if (!this.active) this.coordinator.restore(this.owner)
      throw error
    } finally {
      this.saving = false
    }
  }

  close(): void {
    this.active = false
    this.closed = true
    // A failed cancel already closed the preview barrier, but close/reload must
    // still get another chance to restore any pending native configuration.
    this.coordinator.restore(this.owner)
  }
}

export function bindArknoteWallpaperPreviewSession(
  window: Pick<BrowserWindow, 'once'> & { webContents: Pick<WebContents, 'on'> },
  coordinator: ArknoteWallpaperPreviewCoordinator,
) {
  let session = coordinator.createSession()
  let closed = false
  let navigating = false
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return
    session.close()
    navigating = true
  })
  window.webContents.on('did-finish-load', () => {
    if (closed || !navigating) return
    session = coordinator.createSession()
    navigating = false
  })
  window.webContents.on('render-process-gone', () => {
    session.close()
    navigating = true
  })
  window.once('closed', () => { closed = true; session.close() })
  return {
    preview: (input: StickyNoteWallpaperAppearances | null) => session.preview(input),
    previewMica: (input: StickyNoteMicaAppearance | null) => session.previewMica(input),
    save: <T>(persist: () => Promise<T>) => session.save(persist),
    saveImmediate: <T>(persist: () => Promise<T>) => session.save(persist, false),
  }
}
