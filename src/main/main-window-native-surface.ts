import { app, nativeTheme, type BrowserWindow } from 'electron'
import { DEFAULT_STICKY_NOTE_MICA_APPEARANCE } from '../shared/sticky-note-mica-appearance'
import { resolveEditorTheme, type EditorTheme } from '../shared/editor-appearance-preferences'
import {
  createStickyNoteNativeSurfaceController,
  loadStickyNoteNativeSurface,
} from './sticky-notes/sticky-note-native-surface'

/** A separate controller keeps note previews from changing the main shell. */
export function createMainWindowNativeSurfaceController(
  options: Parameters<typeof createStickyNoteNativeSurfaceController>[0],
) {
  const controller = createStickyNoteNativeSurfaceController(options)
  let selectedTheme: EditorTheme = 'system'
  let systemDark = false
  let appliedTheme: 'minimal' | 'dark' = 'minimal'
  let applicationComplete = true
  const apply = () => {
    const next = resolveEditorTheme(selectedTheme, systemDark)
    if (next === appliedTheme && applicationComplete) return
    appliedTheme = next
    applicationComplete = controller.setAppearance(next === 'dark'
      ? { tintColor: '#202020', tintOpacity: 0.84, luminosityOpacity: 0.1, saturation: 0.8 }
      : DEFAULT_STICKY_NOTE_MICA_APPEARANCE)
  }
  return {
    setTheme(theme: EditorTheme): void {
      selectedTheme = theme
      apply()
    },
    setSystemDark(dark: boolean): void {
      systemDark = dark
      apply()
    },
    bind(window: Parameters<typeof controller.bind>[0]): void {
      controller.bind(window, { mode: 'material', materialPresetId: 'mica-light' })
    },
  }
}

let controller: ReturnType<typeof createMainWindowNativeSurfaceController> | undefined

export function bindMainWindowNativeSurface(window: BrowserWindow, theme: EditorTheme = 'system'): void {
  if (!controller) {
    controller = createMainWindowNativeSurfaceController({
      platform: process.platform,
      load: () => loadStickyNoteNativeSurface({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        buildDirectory: __dirname,
        arch: process.arch,
      }),
      onError: (error) => console.warn('Main window persistent Mica unavailable:', error),
    })
    controller.setSystemDark(nativeTheme.shouldUseDarkColors)
    nativeTheme.on('updated', () => controller?.setSystemDark(nativeTheme.shouldUseDarkColors))
  }
  controller.setTheme(theme)
  controller.bind(window)
}

export function setMainWindowsEditorTheme(theme: EditorTheme): void {
  controller?.setTheme(theme)
}
