import {
  isCanonicalStickyNoteId,
  type StickyNoteContentMeasurement,
  type StickyNoteDocument,
  type StickyNoteRecord,
  type StickyNoteSaveState,
  type StickyNoteWindowBounds,
} from '../../shared/sticky-notes'
import type { StickyNoteStyleReference } from '../../shared/sticky-note-preferences'
import { stickyNoteNativeSurface } from '../create-sticky-note-window'
import { applyStickyNotePinnedState } from './sticky-note-always-on-top'

export interface StickyNoteWorkArea {
  x: number
  y: number
  width: number
  height: number
}

function usableWorkArea(area: StickyNoteWorkArea): boolean {
  return (
    Number.isSafeInteger(area.x)
    && Number.isSafeInteger(area.y)
    && Number.isSafeInteger(area.width)
    && area.width > 0
    && Number.isSafeInteger(area.height)
    && area.height > 0
  )
}

function safeWindowDimension(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function intersectsWorkArea(
  bounds: StickyNoteWindowBounds,
  area: StickyNoteWorkArea,
): boolean {
  return (
    bounds.x < area.x + area.width
    && bounds.x + bounds.width > area.x
    && bounds.y < area.y + area.height
    && bounds.y + bounds.height > area.y
  )
}

export function normalizeStickyNoteWindowBounds(
  bounds: StickyNoteWindowBounds,
  workAreas: readonly StickyNoteWorkArea[],
): StickyNoteWindowBounds {
  const areas = workAreas.filter(usableWorkArea)
  const primary = areas[0] ?? { x: 0, y: 0, width: 1920, height: 1080 }
  const candidate: StickyNoteWindowBounds = {
    x: Number.isSafeInteger(bounds.x) ? bounds.x : primary.x,
    y: Number.isSafeInteger(bounds.y) ? bounds.y : primary.y,
    width: Math.max(180, safeWindowDimension(bounds.width, 320)),
    height: Math.max(180, safeWindowDimension(bounds.height, 320)),
  }
  const matchedArea = areas.find((area) => intersectsWorkArea(candidate, area))
  const target = matchedArea ?? primary
  const width = Math.max(180, Math.min(candidate.width, Math.max(180, target.width)))
  const height = Math.max(180, Math.min(candidate.height, Math.max(180, target.height)))
  if (!matchedArea) {
    return {
      x: target.x + Math.round((target.width - width) / 2),
      y: target.y + Math.round((target.height - height) / 2),
      width,
      height,
    }
  }
  const maxX = Math.max(target.x, target.x + target.width - width)
  const maxY = Math.max(target.y, target.y + target.height - height)
  return {
    x: Math.min(Math.max(candidate.x, target.x), maxX),
    y: Math.min(Math.max(candidate.y, target.y), maxY),
    width,
    height,
  }
}

export interface StickyNoteWindowTarget {
  show(): void
  hide(): void
  focus(): void
  moveTop(): void
  moveAbove?(sourceMediaId: string): void
  destroy(): void
  isDestroyed(): boolean
  setBackgroundMaterial(material: 'none' | 'mica' | 'acrylic'): void
  setStickyNoteSurface?(style: StickyNoteStyleReference): void
  setAlwaysOnTop(pinned: boolean, level?: string): void
  sendFindRequest?(query: string): void
  getBounds(): StickyNoteWindowBounds
  setBounds(bounds: StickyNoteWindowBounds): void
  on(event: 'close' | 'closed', listener: (event?: { preventDefault(): void }) => void): void
  once(event: 'ready-to-show', listener: () => void): void
}

interface StickyNoteWindowStore {
  get(noteId: string): Promise<StickyNoteDocument>
  updateRecord(
    noteId: string,
    updater: (record: StickyNoteRecord) => StickyNoteRecord,
  ): Promise<StickyNoteRecord>
}

interface StickyNoteWindowSaveCoordinator {
  flush(noteId: string): Promise<StickyNoteSaveState>
}

export interface StickyNoteWindowManagerOptions {
  store: StickyNoteWindowStore
  saveCoordinator: StickyNoteWindowSaveCoordinator
  createWindow(input: {
    noteId: string
    bounds: StickyNoteWindowBounds | null
    pinned: boolean
    style: StickyNoteStyleReference
  }): StickyNoteWindowTarget
  normalizeBounds(bounds: StickyNoteWindowBounds): StickyNoteWindowBounds
  sizeForContent?(
    measurement: StickyNoteContentMeasurement,
    currentBounds: StickyNoteWindowBounds,
  ): { width: number; height: number }
  now?: () => Date
  onWindowState?: (noteId: string, open: boolean, pinned: boolean) => void
}

export interface StickyNoteOpenOptions {
  focus?: boolean
  autoSize?: boolean
  findQuery?: string
  foregroundSourceId?: string
}

export class StickyNoteWindowManager {
  private readonly windows = new Map<string, StickyNoteWindowTarget>()
  private readonly pendingAutoSize = new Set<string>()
  private readonly suppressedCloseNotifications = new WeakSet<StickyNoteWindowTarget>()
  private readonly destroyingWindows = new WeakSet<StickyNoteWindowTarget>()
  private readonly closingWindows = new WeakSet<StickyNoteWindowTarget>()
  private readonly closingAttempts = new WeakMap<StickyNoteWindowTarget, Promise<void>>()
  private readonly foregroundPromotionTokens = new WeakMap<StickyNoteWindowTarget, symbol>()
  private readonly now: () => Date

  constructor(private readonly options: StickyNoteWindowManagerOptions) {
    this.now = options.now ?? (() => new Date())
  }

  private requireNoteId(noteId: string): void {
    if (!isCanonicalStickyNoteId(noteId)) throw new Error('便签 ID 无效')
  }

  private bringToFront(
    noteId: string,
    window: StickyNoteWindowTarget,
    pinned: boolean,
    focus: boolean,
    foregroundSourceId?: string,
  ): void {
    if (this.windows.get(noteId) !== window) return
    if (window.isDestroyed() || this.closingWindows.has(window)) return
    const temporarilyPinned = !pinned && focus
    const promotionToken = temporarilyPinned ? Symbol('foreground-promotion') : undefined
    try {
      if (pinned) this.foregroundPromotionTokens.delete(window)
      if (promotionToken) this.foregroundPromotionTokens.set(window, promotionToken)
      if (pinned || temporarilyPinned) applyStickyNotePinnedState(window, true)
      window.show()
      if (window.isDestroyed()) {
        if (promotionToken) this.foregroundPromotionTokens.delete(window)
        return
      }
      if (!pinned && foregroundSourceId && window.moveAbove) {
        try {
          window.moveAbove(foregroundSourceId)
        } catch {
          // The source window may have closed between the request and promotion.
        }
      }
      if (focus && !window.isDestroyed()) window.focus()
      if (!window.isDestroyed()) window.moveTop()
      if (temporarilyPinned) {
        setTimeout(() => {
          if (this.foregroundPromotionTokens.get(window) !== promotionToken) return
          this.foregroundPromotionTokens.delete(window)
          if (this.windows.get(noteId) !== window) return
          if (window.isDestroyed()) return
          applyStickyNotePinnedState(window, false)
        }, 150)
      }
    } catch {
      // A closing or destroyed native window cannot be promoted.
    }
  }

  async open(noteId: string, openOptions: StickyNoteOpenOptions = {}): Promise<void> {
    this.requireNoteId(noteId)
    let note: StickyNoteDocument
    while (true) {
      note = await this.options.store.get(noteId)
      if (note.record.status !== 'active') throw new Error('归档便签不能打开编辑窗口')

      const existing = this.windows.get(noteId)
      if (existing && !existing.isDestroyed()) {
        const activeAttempt = this.closingAttempts.get(existing)
        if (activeAttempt) {
          try {
            await activeAttempt
          } catch {
            if (this.windows.get(noteId) !== existing || existing.isDestroyed()) continue
            if (openOptions.autoSize) this.pendingAutoSize.add(noteId)
            this.bringToFront(
              noteId,
              existing,
              note.record.pinned,
              openOptions.focus !== false,
              openOptions.foregroundSourceId,
            )
            if (openOptions.findQuery) existing.sendFindRequest?.(openOptions.findQuery)
            return
          }
          // The runtime marks a user-requested open as released before calling us,
          // but a successful close clears that state while this request is waiting.
          await this.options.store.updateRecord(noteId, (record) => ({
            ...record,
            released: true,
          }))
          continue
        }
        if (openOptions.autoSize) this.pendingAutoSize.add(noteId)
        this.bringToFront(
          noteId,
          existing,
          note.record.pinned,
          openOptions.focus !== false,
          openOptions.foregroundSourceId,
        )
        if (openOptions.findQuery) existing.sendFindRequest?.(openOptions.findQuery)
        return
      }
      if (existing) this.windows.delete(noteId)
      break
    }

    const bounds = note.record.windowBounds
      ? this.options.normalizeBounds(note.record.windowBounds)
      : null
    const window = this.options.createWindow({
      noteId,
      bounds,
      pinned: note.record.pinned,
      style: note.record.style,
    })
    this.windows.set(noteId, window)
    if (openOptions.autoSize) this.pendingAutoSize.add(noteId)
    window.on('close', (event) => {
      if (this.destroyingWindows.has(window)) return
      event?.preventDefault()
      void this.close(noteId).catch(() => undefined)
    })
    window.on('closed', () => {
      if (this.windows.get(noteId) === window) {
        this.windows.delete(noteId)
        this.pendingAutoSize.delete(noteId)
        if (!this.suppressedCloseNotifications.has(window)) {
          void this.finalizeClosed(noteId, window)
        }
      }
    })
    window.once('ready-to-show', () => {
      this.bringToFront(
        noteId,
        window,
        note.record.pinned,
        openOptions.focus !== false,
        openOptions.foregroundSourceId,
      )
    })
    this.options.onWindowState?.(noteId, true, note.record.pinned)
    if (openOptions.findQuery) window.sendFindRequest?.(openOptions.findQuery)
  }

  private async finalizeClosed(noteId: string, window: StickyNoteWindowTarget): Promise<void> {
    try {
      const state = await this.options.saveCoordinator.flush(noteId)
      if (state.status === 'error') return
      await this.persistBounds(noteId, window)
      await this.clearDisplayState(noteId)
      this.options.onWindowState?.(noteId, false, false)
    } catch {
      // Native teardown cannot safely re-open the window; staged text remains retryable.
    }
  }

  private async clearDisplayState(noteId: string): Promise<void> {
    await this.options.store.updateRecord(noteId, (record) => ({
      ...record,
      released: false,
      pinned: false,
    }))
  }

  private async persistBounds(noteId: string, window: StickyNoteWindowTarget): Promise<void> {
    const bounds = this.options.normalizeBounds(window.getBounds())
    await this.options.store.updateRecord(noteId, (record) => ({
      ...record,
      windowBounds: bounds,
      lastOpenedAt: this.now().toISOString(),
    }))
  }

  async close(noteId: string): Promise<void> {
    this.requireNoteId(noteId)
    const window = this.windows.get(noteId)
    if (!window || window.isDestroyed()) {
      this.windows.delete(noteId)
      await this.clearDisplayState(noteId)
      this.options.onWindowState?.(noteId, false, false)
      return
    }

    const activeAttempt = this.closingAttempts.get(window)
    if (activeAttempt) {
      await activeAttempt
      return
    }

    this.closingWindows.add(window)
    const attempt = (async () => {
      const state = await this.options.saveCoordinator.flush(noteId)
      if (state.status === 'error') throw new Error(state.message)
      await this.persistBounds(noteId, window)
      await this.clearDisplayState(noteId)
      this.suppressedCloseNotifications.add(window)
      this.destroyingWindows.add(window)
      window.destroy()
      this.pendingAutoSize.delete(noteId)
      if (this.windows.get(noteId) === window) this.windows.delete(noteId)
      this.options.onWindowState?.(noteId, false, false)
    })()
    this.closingAttempts.set(window, attempt)

    try {
      await attempt
    } finally {
      if (this.closingAttempts.get(window) === attempt) {
        this.closingAttempts.delete(window)
        if (!window.isDestroyed()) this.closingWindows.delete(window)
      }
    }
  }

  async reclaim(noteId: string): Promise<void> {
    await this.close(noteId)
  }

  async resizeToContent(
    noteId: string,
    measurement: StickyNoteContentMeasurement,
  ): Promise<void> {
    this.requireNoteId(noteId)
    if (!this.pendingAutoSize.has(noteId)) return
    const window = this.windows.get(noteId)
    if (!window || window.isDestroyed()) {
      this.pendingAutoSize.delete(noteId)
      return
    }
    const current = window.getBounds()
    const size = this.options.sizeForContent?.(measurement, current)
    if (!size) return
    const next = this.options.normalizeBounds({ ...current, ...size })
    window.setBounds(next)
    this.pendingAutoSize.delete(noteId)
    await this.persistBounds(noteId, window)
  }

  async setPinned(noteId: string, pinned: boolean): Promise<void> {
    this.requireNoteId(noteId)
    const window = this.windows.get(noteId)
    if (window && !window.isDestroyed()) {
      this.foregroundPromotionTokens.delete(window)
      applyStickyNotePinnedState(window, pinned)
    }
    await this.options.store.updateRecord(noteId, (record) => ({
      ...record,
      released: pinned ? true : record.released,
      pinned,
    }))
    this.options.onWindowState?.(noteId, Boolean(window && !window.isDestroyed()), pinned)
  }

  applyStyle(noteId: string, style: StickyNoteStyleReference): void {
    this.requireNoteId(noteId)
    const window = this.windows.get(noteId)
    if (!window || window.isDestroyed()) return
    if (window.setStickyNoteSurface) {
      window.setStickyNoteSurface(style)
      return
    }
    const surface = stickyNoteNativeSurface(style)
    window.setBackgroundMaterial(surface.material)
  }

  async closeAll(options: {
    flush: boolean
    preserveSessionState?: boolean
  }): Promise<void> {
    const noteIds = [...this.windows.keys()]
    for (const noteId of noteIds) {
      const window = this.windows.get(noteId)
      if (!window || window.isDestroyed()) continue
      if (options.preserveSessionState) this.suppressedCloseNotifications.add(window)
      if (options.flush) {
        await this.close(noteId)
      } else {
        await this.persistBounds(noteId, window)
        window.destroy()
      }
    }
  }

  showAll(): void {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) window.show()
    }
  }

  hideAll(): void {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) window.hide()
    }
  }

  openNoteIds(): readonly string[] {
    return [...this.windows.entries()]
      .filter(([, window]) => !window.isDestroyed())
      .map(([noteId]) => noteId)
  }
}
