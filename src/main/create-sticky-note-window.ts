import { app, BrowserWindow, screen, type BrowserWindowConstructorOptions } from 'electron'
import path from 'node:path'
import {
  isCanonicalStickyNoteId,
  type StickyNoteWindowBounds,
} from '../shared/sticky-notes'
import { stickyNoteMaterialDescriptor } from '../shared/sticky-note-materials'
import type { StickyNoteStyleReference } from '../shared/sticky-note-preferences'
import type { StickyNoteMicaAppearance } from '../shared/sticky-note-mica-appearance'
import {
  copyStickyNoteWallpaperAppearances,
  parseStickyNoteWallpaperAppearances,
  type StickyNoteWallpaperAppearances,
} from '../shared/sticky-note-glass-appearance'
import { preloadPathForBuild } from './create-main-window'
import { applyStickyNotePinnedState } from './sticky-notes/sticky-note-always-on-top'
import { createStickyNoteMaterialEffectsController } from './sticky-notes/sticky-note-material-effects'
import {
  createStickyNoteNativeSurfaceController,
  loadStickyNoteNativeSurface,
} from './sticky-notes/sticky-note-native-surface'

import {
  restoreStickyNoteWindowBounds,
  validStickyNoteBounds as validBounds,
} from './sticky-notes/sticky-note-window-bounds'
export { restoreStickyNoteWindowBounds } from './sticky-notes/sticky-note-window-bounds'

const DEFAULT_STICKY_NOTE_SIZE = 320
const MINIMUM_STICKY_NOTE_SIZE = 180
const materialEffectsController = createStickyNoteMaterialEffectsController({
  onError: (error) => console.warn('Sticky-note material effects delivery failed:', error),
})
const nativeSurfaceController = createStickyNoteNativeSurfaceController({
  platform: process.platform,
  load: () => loadStickyNoteNativeSurface({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    buildDirectory: __dirname,
    arch: process.arch,
  }),
  onError: (error) => console.warn('Sticky-note native wallpaper surface unavailable:', error),
})

export function setStickyNoteMicaAppearance(appearance: StickyNoteMicaAppearance): boolean {
  return nativeSurfaceController.setAppearance(appearance)
}

export function setStickyNoteWallpaperAppearances(appearances: StickyNoteWallpaperAppearances): boolean {
  const parsed = parseStickyNoteWallpaperAppearances(appearances)
  if (!parsed) throw new Error('Invalid sticky-note wallpaper appearances')
  let nativeApplied = false
  try {
    nativeApplied = nativeSurfaceController.setWallpaperAppearances(copyStickyNoteWallpaperAppearances(parsed))
  } catch (error) {
    console.warn('Sticky-note native wallpaper appearance update failed:', error)
  }
  // Both outputs belong to the existing preview/save transaction. Keep the
  // effective renderer snapshot current even while a native update needs retry.
  const effectsApplied = materialEffectsController.setEffects(parsed.materialEffects)
  return nativeApplied && effectsApplied
}

export interface StickyNoteNativeSurface {
  material: 'none' | 'mica' | 'acrylic'
}

export function stickyNoteNativeSurface(
  style: StickyNoteStyleReference,
): StickyNoteNativeSurface {
  const descriptor = style.mode === 'material'
    ? stickyNoteMaterialDescriptor(style.materialPresetId)
    : null
  return descriptor === null
    ? { material: 'none' }
    : { material: descriptor.nativeMaterial }
}

export function buildStickyNoteWindowOptions(
  preload: string,
  bounds: StickyNoteWindowBounds | null | undefined,
  style: StickyNoteStyleReference,
  hideTaskbarIcons = false,
): BrowserWindowConstructorOptions {
  const surface = stickyNoteNativeSurface(style)
  const options: BrowserWindowConstructorOptions = {
    width: DEFAULT_STICKY_NOTE_SIZE,
    height: DEFAULT_STICKY_NOTE_SIZE,
    minWidth: MINIMUM_STICKY_NOTE_SIZE,
    minHeight: MINIMUM_STICKY_NOTE_SIZE,
    frame: false,
    roundedCorners: true,
    hasShadow: nativeSurfaceController.hasShadow(style),
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    skipTaskbar: hideTaskbarIcons === true,
    title: '便签 — Arknote',
    // Bootstrapping every note with a material makes Electron create a
    // transparent WebContents. Classic notes immediately disable the native
    // backdrop below; their opaque renderer surface remains unchanged.
    backgroundMaterial: surface.material === 'none' ? 'mica' : surface.material,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  }
  if (!validBounds(bounds)) return options
  return {
    ...options,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  }
}

export function stickyNoteWindowUrl(rendererUrl: string, noteId: string): string {
  if (!isCanonicalStickyNoteId(noteId)) throw new Error('便签 ID 无效')
  const url = new URL(rendererUrl)
  url.search = ''
  url.searchParams.set('surface', 'sticky-note')
  url.searchParams.set('noteId', noteId)
  return url.toString()
}

export interface CreateStickyNoteWindowInput {
  noteId: string
  hideTaskbarIcons?: boolean
  bounds?: StickyNoteWindowBounds | null
  pinned?: boolean
  style: StickyNoteStyleReference
}

export type StickyNoteBrowserWindow = BrowserWindow & {
  setStickyNoteSurface(style: StickyNoteStyleReference): void
}

export function createStickyNoteWindow(input: CreateStickyNoteWindowInput): StickyNoteBrowserWindow {
  if (!isCanonicalStickyNoteId(input.noteId)) throw new Error('便签 ID 无效')
  const window = new BrowserWindow(buildStickyNoteWindowOptions(
    preloadPathForBuild(__dirname),
    input.bounds,
    input.style,
    input.hideTaskbarIcons,
  ))
  if (process.platform === 'win32') {
    try {
      // Load lazily only when Electron's original request still reads inexactly.
      const addon = () => loadStickyNoteNativeSurface({
        isPackaged: app.isPackaged, resourcesPath: process.resourcesPath,
        buildDirectory: __dirname, arch: process.arch,
      })
      const hwnd = () => {
        const handle = window.getNativeWindowHandle()
        return handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())
      }
      const status = restoreStickyNoteWindowBounds(window, input.bounds, {
        getPhysicalRect: () => {
          const read = addon().getPhysicalRect
          if (!read) throw new Error('Native bounds API unavailable')
          return read(hwnd())
        },
        setPhysicalSize: (expected, size) => {
          const resize = addon().setPhysicalSize
          if (!resize) throw new Error('Native bounds API unavailable')
          return resize(hwnd(), expected, size)
        },
        screenToDipRect: rect => screen.screenToDipRect(window, rect),
        getDisplay: () => screen.getDisplayMatching(window.getBounds()),
      })
      if (status !== 'exact' && status !== 'invalid') {
        console.warn('Sticky-note bounds restoration incomplete:', { status, requested: input.bounds, actual: window.getBounds() })
      }
    } catch (error) { console.warn('Sticky-note bounds restoration failed:', error) }
  }
  const managedWindow = Object.assign(window, {
    setStickyNoteSurface: nativeSurfaceController.bind(window, input.style),
  })
  applyStickyNotePinnedState(window, input.pinned === true)
  materialEffectsController.bind(window)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(stickyNoteWindowUrl(
      MAIN_WINDOW_VITE_DEV_SERVER_URL,
      input.noteId,
    ))
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      { query: { surface: 'sticky-note', noteId: input.noteId } },
    )
  }

  return managedWindow
}
