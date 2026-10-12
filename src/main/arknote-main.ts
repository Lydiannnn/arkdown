import path from 'node:path'
import { defaultStickyNoteStyle } from '../shared/sticky-note-preferences'
import { realpath, stat } from 'node:fs/promises'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import {
  app, nativeTheme,
  clipboard,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  screen,
  shell,
} from 'electron'
import { createArknoteStickyNoteLinkOpener } from './arknote/arknote-link-opener'
import { createStickyNoteWindow, setStickyNoteWallpaperAppearances } from './create-sticky-note-window'
import { ArknoteWallpaperPreviewCoordinator, bindArknoteWallpaperPreviewSession } from './arknote/arknote-wallpaper-preview-session'
import { copyStickyNoteWallpaperAppearances } from '../shared/sticky-note-glass-appearance'
import { ARKNOTE_MATERIAL_PREFERENCE_KEYS, type ArknotePreferencesUpdate } from '../shared/arknote-preferences'
import { createStickyNoteContextMenuBrowserWindow } from './create-sticky-note-context-menu-window'
import { StickyNoteContextMenuWindow } from './sticky-notes/sticky-note-context-menu-window'
import {
  STICKY_NOTE_CONTEXT_MENU_CHANNELS,
  parseStickyNoteContextMenuClosed,
  parseStickyNoteContextMenuReady,
  parseStickyNoteContextMenuCommand,
  parseStickyNoteContextMenuOpenInput,
} from '../shared/sticky-note-context-menu'
import { PUBLIC_ERROR_MESSAGES, PublicError } from '../shared/public-errors'
import { createArknoteBoxWindow } from './create-arknote-box-window'
import { createArknoteSettingsWindow } from './create-arknote-settings-window'
import { ArknoteBoxThemeController } from './arknote/arknote-box-theme'
import { ArknoteSettingsQuitBarrier } from './arknote/arknote-settings-quit'
import { ArknoteWindowManager } from './arknote/arknote-window-manager'
import {
  registerArknoteBoxWindowIpc,
  registerArknoteSettingsWindowIpc,
  registerBackgroundSettingsWindowIpc,
  registerStickyNoteWindowIpc,
} from './ipc/register-ipc'
import { AssetAccessRegistry, ASSET_PROTOCOL } from './assets/asset-path'
import { AssetService } from './assets/asset-service'
import { WorkspaceService } from './workspace/workspace-service'
import { createStickyBackgroundBackend } from './backgrounds/background-backends'
import { BackgroundSettingsWindowRegistry, type BackgroundSettingsWindow } from './backgrounds/background-settings-window-registry'
import { BackgroundWorkflow, type BackgroundPresentationEvent } from './backgrounds/background-workflow'
import { createBackgroundSettingsWindow } from './create-background-settings-window'
import {
  migrateEmbeddedArknoteSettings,
  migrateEmbeddedStickyNotes,
} from './arknote/arknote-data-migration'
import { ArknoteCommandRouter } from './arknote/arknote-command-router'
import { ArknotePipeServer } from './arknote/arknote-pipe-server'
import { arknotePaths } from './arknote/arknote-paths'
import { createArknoteQuitGuard } from './arknote/arknote-quit-guard'
import {
  ArknoteMutationGateRegistry,
  ArknoteServiceRuntime,
  createArknoteSaveCoordinator,
  initialArknoteLaunchCommand,
} from './arknote/arknote-service-runtime'
import { loadOrCreateArknoteServiceToken } from './arknote/arknote-service-token'
import {
  ArknoteSettingsStore,
  applyArknotePreferences,
  arknotePreferencesFromSettings,
  copyArknoteSettings,
  saveArknoteSettingsUpdate,
  type ArknoteSettings,
} from './arknote/arknote-settings-store'
import { DesktopContextMenuRegistration } from './arknote/desktop-context-menu'
import { createArknoteContextMenuSettings } from './arknote/context-menu-settings'
import {
  acquireArknoteSingleInstance,
  type ArknoteLaunchCommand,
} from './arknote/arknote-second-instance'
import { StickyNoteAutostart } from './sticky-notes/sticky-note-autostart'
import { StickyNoteImporter } from './sticky-notes/sticky-note-importer'
import { StickyNoteRuntime } from './sticky-notes/sticky-note-runtime'
import { StickyNoteSearchIndex } from './sticky-notes/sticky-note-search-index'
import { StickyNoteSessionState } from './sticky-notes/sticky-note-session-state'
import { StickyNoteStore } from './sticky-notes/sticky-note-store'
import { ArknoteTray } from './sticky-notes/sticky-note-tray'
import { createArknoteTaskbarPreferenceChange, ArknoteTaskbarPreferenceError } from './arknote/taskbar-preference'
import { createStickyNoteTrayCheckIcon } from './sticky-notes/sticky-note-tray-icon'
import {
  normalizeStickyNoteWindowBounds,
  StickyNoteWindowManager,
} from './sticky-notes/sticky-note-window-manager'
import { calculateStickyNoteWindowSize } from './sticky-notes/sticky-note-window-sizing'
import type { StickyNoteWindowBounds } from '../shared/sticky-notes'
import {
  BACKGROUND_PRESENTATION_CHANNEL,
  STICKY_NOTE_EVENT_CHANNEL,
} from '../shared/contracts'
import { arknotePipeName } from '../shared/arknote-protocol'
import { createE2eTrayProbe } from './e2e-bootstrap'
import { createNativeTray } from './native-tray-factory'
import { configureNativeTrayObserver } from './native-tray-observer'
import { defaultStickyNoteName } from './sticky-notes/sticky-note-name'
import { brandingResourcePath } from './branding'
import { preloadPathForBuild } from './create-main-window'
import { createBusinessMessageDialog } from './dialogs/business-message-dialog'

export const ARKNOTE_BACKGROUND_IMAGE_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'svg',
] as const

interface ArknoteBackgroundDialogResult {
  canceled: boolean
  filePaths: string[]
}

export async function chooseArknoteBackgroundImage(
  showOpenDialog: (options: Electron.OpenDialogOptions) => Promise<ArknoteBackgroundDialogResult>,
  defaultPath?: string,
): Promise<string | null> {
  const selected = await showOpenDialog({
    title: '选择背景图片',
    properties: ['openFile'],
    ...(defaultPath ? { defaultPath } : {}),
    filters: [{
      name: '图片文件',
      extensions: [...ARKNOTE_BACKGROUND_IMAGE_EXTENSIONS],
    }],
  })
  return selected.canceled ? null : selected.filePaths[0] ?? null
}

export interface ArknoteBackgroundWiringOptions {
  notes: Pick<StickyNoteRuntime, 'read' | 'resolveBackgroundImagePath' | 'applyBackground'>
  assetAccess: Pick<AssetAccessRegistry, 'urlFor'>
  stickyNoteWindows: ReadonlySet<BrowserWindow>
  chooseBackgroundImage: () => Promise<string | null>
  createWindow: (target: import('../shared/background-settings').BackgroundTarget) => BackgroundSettingsWindow
  register: (
    window: BackgroundSettingsWindow,
    backgrounds: import('./ipc/register-ipc').BackgroundIpcService,
  ) => { dispose(): void }
  reportError?: (error: unknown) => void
}

function sendBackgroundPresentation(
  window: BrowserWindow,
  event: BackgroundPresentationEvent,
): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send(BACKGROUND_PRESENTATION_CHANNEL, event)
}

export function createArknoteBackgroundWiring(
  options: ArknoteBackgroundWiringOptions,
): BackgroundSettingsWindowRegistry {
  const workflow = new BackgroundWorkflow({
    backend: createStickyBackgroundBackend(options.notes, (source) => options.assetAccess.urlFor(source)),
    chooseSource: () => options.chooseBackgroundImage(),
    broadcast: (event) => {
      for (const window of options.stickyNoteWindows) {
        sendBackgroundPresentation(window, event)
      }
    },
  })
  return new BackgroundSettingsWindowRegistry({
    workflow,
    createWindow: options.createWindow,
    register: options.register,
    reportError: options.reportError,
  })
}

export async function openSiblingArkdown(
  applicationDirectory: string,
  dependencies: {
    stat(absolutePath: string): Promise<{ isFile(): boolean }>
    spawn(executable: string, args: string[], options: SpawnOptions): Pick<ChildProcess, 'once' | 'unref'>
    showError(message: string): void | Promise<void>
  },
): Promise<void> {
  const executable = path.join(applicationDirectory, 'Arkdown.exe')
  try {
    const file = await dependencies.stat(executable)
    if (!file.isFile()) throw new Error('Arkdown.exe 不是普通文件')
    await new Promise<void>((resolve, reject) => {
      const child = dependencies.spawn(executable, [], {
        // windowsHide also sets SW_HIDE for the GUI's first ShowWindow call.
        // This is an explicit request to open Arkdown, so allow its window.
        cwd: applicationDirectory, shell: false, windowsHide: false, detached: true, stdio: 'ignore',
      })
      child.once('error', reject)
      child.once('spawn', () => { child.unref(); resolve() })
    })
  } catch (error) {
    await dependencies.showError(`无法打开 Arkdown。请确认安装目录中存在可运行的 Arkdown.exe。\n${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function startArknote(): Promise<void> {
  const assetAccess = new AssetAccessRegistry()
  const initialCommand = initialArknoteLaunchCommand(process.argv)
  const pendingCommands: ArknoteLaunchCommand[] = initialCommand ? [initialCommand] : []
  let runtime: ArknoteServiceRuntime | null = null
  if (!acquireArknoteSingleInstance(
    app,
    process.argv,
    (command) => {
      if (runtime) void runtime.execute(command).catch((error) => {
        console.error('Failed to execute forwarded Arknote command', error)
      })
      else pendingCommands.push(command)
    },
  )) return
  const trayProbe = createE2eTrayProbe({
    environment: process.env,
    processId: process.pid,
    role: 'arknote',
  })
  configureNativeTrayObserver(trayProbe)

  await app.whenReady()
  // Arknote remains available in the tray even when a standalone prompt closes.
  app.on('window-all-closed', () => undefined)
  await protocol.handle(ASSET_PROTOCOL, async (request) => {
    const fileUrl = await assetAccess.responseUrl(request.url)
    return await net.fetch(fileUrl, { headers: request.headers })
  })
  const applicationDirectory = path.dirname(app.getPath('exe'))
  const portableRoot = path.join(applicationDirectory, 'portable-data')
  const paths = arknotePaths(applicationDirectory)
  const clipboardAssets = new AssetService({ workspace: new WorkspaceService(), tempRoot: path.join(paths.root, 'clipboard-temp'), sessionId: 'arknote', access: assetAccess,
    readClipboardImage: () => clipboard.readImage('clipboard'),
  })
  await migrateEmbeddedStickyNotes({ legacyRoot: portableRoot, arknoteRoot: paths.root })
  await migrateEmbeddedArknoteSettings({ legacyRoot: portableRoot, arknoteRoot: paths.root })

  const settingsStore = new ArknoteSettingsStore(paths.root)
  const initialSettings = await settingsStore.load()
  setStickyNoteWallpaperAppearances(copyStickyNoteWallpaperAppearances(initialSettings))
  const autostart = new StickyNoteAutostart({
    executablePath: app.getPath('exe'),
    setLoginItemSettings: (value) => {
      if (app.isPackaged) app.setLoginItemSettings(value)
    },
  })
  const desktopContextMenu = new DesktopContextMenuRegistration({
    executablePath: path.join(applicationDirectory, 'Arknote.exe'),
  })
  const settingsState = await createArknoteContextMenuSettings(
    initialSettings, desktopContextMenu, settingsStore, autostart,
    (message, error) => console.error(message, error),
  )
  let effectiveThemeColor = initialSettings.themeColor
  const businessDialogs = createBusinessMessageDialog({
    ipcMain, preloadPath: preloadPathForBuild(__dirname),
    rendererUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL || undefined,
    rendererFile: path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    appearance: () => ({ dark: settingsState.get().boxTheme?.mode === 'dark'
      || !settingsState.get().boxTheme && nativeTheme.shouldUseDarkColors }),
  })
  app.once('will-quit', () => businessDialogs.dispose())

  const store = new StickyNoteStore({
    root: paths.root,
    getDefaultStyle: () => defaultStickyNoteStyle(settingsState.get().stickyNotes),
  })
  const saves = createArknoteSaveCoordinator(store)
  const search = new StickyNoteSearchIndex(store)
  const importer = new StickyNoteImporter({ root: paths.root, store })
  const normalizeBounds = (bounds: StickyNoteWindowBounds): StickyNoteWindowBounds =>
    normalizeStickyNoteWindowBounds(bounds, [
      screen.getPrimaryDisplay().workArea,
      ...screen.getAllDisplays().map((display) => display.workArea),
    ])

  const contextMenus = new StickyNoteContextMenuWindow({
    createWindow: () => createStickyNoteContextMenuBrowserWindow(),
    displayForPoint: (point) => screen.getDisplayNearestPoint({
      x: Math.round(point.x),
      y: Math.round(point.y),
    }),
  })
  const menuFailure = (code: 'INVALID_INPUT' | 'UNTRUSTED_SENDER') => ({
    ok: false as const,
    error: { code, message: PUBLIC_ERROR_MESSAGES[code] },
  })
  ipcMain.handle(STICKY_NOTE_CONTEXT_MENU_CHANNELS.open, async (event, payload) => {
    const input = parseStickyNoteContextMenuOpenInput(payload)
    if (!input) return menuFailure('INVALID_INPUT')
    return await contextMenus.open(event.sender.id, input)
      ? { ok: true as const, value: null }
      : menuFailure('UNTRUSTED_SENDER')
  })
  ipcMain.handle(STICKY_NOTE_CONTEXT_MENU_CHANNELS.ready, (event, payload) => {
    const request = parseStickyNoteContextMenuReady(payload)
    if (!request) return menuFailure('INVALID_INPUT')
    return contextMenus.ready(event.sender, request.requestId)
      ? { ok: true as const, value: null }
      : menuFailure('UNTRUSTED_SENDER')
  })
  ipcMain.handle(STICKY_NOTE_CONTEXT_MENU_CHANNELS.execute, (event, payload) => {
    const command = parseStickyNoteContextMenuCommand(payload)
    if (!command) return menuFailure('INVALID_INPUT')
    return contextMenus.execute(event.sender, command)
      ? { ok: true as const, value: null }
      : menuFailure('UNTRUSTED_SENDER')
  })
  ipcMain.handle(STICKY_NOTE_CONTEXT_MENU_CHANNELS.close, (event, payload) => {
    const request = parseStickyNoteContextMenuClosed(payload)
    if (!request) return menuFailure('INVALID_INPUT')
    return contextMenus.close(event.sender, request.requestId)
      ? { ok: true as const, value: null }
      : menuFailure('UNTRUSTED_SENDER')
  })

  const mutationGates = new ArknoteMutationGateRegistry()
  const stickyNoteWindows = new Set<BrowserWindow>()
  const broadcastThemeColor = (themeColor: string) => {
    for (const window of stickyNoteWindows) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) {
        stickyNoteWindows.delete(window)
        continue
      }
      window.webContents.send(STICKY_NOTE_EVENT_CHANNEL, {
        type: 'theme-color-changed',
        themeColor,
      })
    }
  }
  let notes!: StickyNoteRuntime
  let session!: StickyNoteSessionState
  let pipe!: ArknotePipeServer
  let backgroundSettingsWindows!: BackgroundSettingsWindowRegistry
  const windows = new StickyNoteWindowManager({
    store,
    saveCoordinator: saves,
    normalizeBounds,
    sizeForContent: (measurement, bounds) => calculateStickyNoteWindowSize(
      measurement,
      screen.getDisplayMatching(bounds).workArea,
    ),
    onWindowState: (noteId, open, pinned) => {
      void session?.recordWindowState(noteId, open).catch((error) => {
        console.error('Failed to persist Arknote window state', error)
      })
      notes?.windowStateChanged(noteId, open, pinned)
    },
    createWindow: (input) => {
      const window = createStickyNoteWindow({ ...input, hideTaskbarIcons: settingsState.get().hideTaskbarIcons })
      stickyNoteWindows.add(window)
      const unregisterContextMenuOwner = contextMenus.registerOwner(window)
      const registration = registerStickyNoteWindowIpc({
        ipcMain,
        window,
        stickyNotes: notes,
        assets: clipboardAssets,
        clipboardNoteId: input.noteId,
        stickyNoteDataRoot: paths.root,
        getStickyNotePreferences: () => settingsState.get().stickyNotes,
        getArknotePreferences: () =>
          arknotePreferencesFromSettings(settingsState.get(), effectiveThemeColor),
        openExternal: createArknoteStickyNoteLinkOpener(window, {
          realpath,
          openExternal: (url) => shell.openExternal(url),
          openPath: (absolutePath) => shell.openPath(absolutePath),
        }),
        chooseStickyNoteImage: async (noteId) => {
          const selected = await dialog.showOpenDialog(window, {
            title: '插入图片',
            properties: ['openFile'],
            filters: [{
              name: '图片文件',
              extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'],
            }],
          })
          const absolutePath = selected.canceled ? undefined : selected.filePaths[0]
          return absolutePath ? notes.copyImage(noteId, absolutePath) : null
        },
        backgrounds: backgroundSettingsWindows.serviceForOwner(window, (event) => {
          sendBackgroundPresentation(window, event)
        }),
      })
      const unregisterMutationGate = mutationGates.register(registration)
      const unsubscribe = notes.subscribe((event) => {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send(STICKY_NOTE_EVENT_CHANNEL, event)
        }
      })
      window.on('session-end', () => {
        void session.captureAndFlush().catch((error) => {
          console.error('Failed to flush Arknote during Windows session end', error)
        })
      })
      window.once('closed', () => {
        stickyNoteWindows.delete(window)
        unregisterContextMenuOwner()
        unregisterMutationGate()
        unsubscribe()
        registration.dispose()
      })
      return window
    },
  })
  notes = new StickyNoteRuntime({
    store,
    importer,
    saveCoordinator: saves,
    windows,
    searchIndex: search,
  })
  let lastBackgroundImageDirectory: string | undefined
  backgroundSettingsWindows = createArknoteBackgroundWiring({
    notes,
    assetAccess,
    stickyNoteWindows,
    chooseBackgroundImage: async () => {
      const selected = await chooseArknoteBackgroundImage((options) => {
        const owner = BrowserWindow.getFocusedWindow()
        return owner
          ? dialog.showOpenDialog(owner, options)
          : dialog.showOpenDialog(options)
      }, lastBackgroundImageDirectory)
      if (selected) lastBackgroundImageDirectory = path.dirname(selected)
      return selected
    },
    createWindow: createBackgroundSettingsWindow,
    register: (window, backgrounds) => {
      const registration = registerBackgroundSettingsWindowIpc({
        ipcMain,
        window: window as BrowserWindow,
        backgrounds,
      })
      const unregisterMutationGate = mutationGates.register(registration)
      return {
        dispose: () => {
          unregisterMutationGate()
          registration.dispose()
        },
      }
    },
    reportError: (error) => console.error('Failed to manage background settings window', error),
  })
  session = new StickyNoteSessionState({
    store,
    windows,
    saves,
    reportError: (error) => console.error('Skipped invalid Arknote session entry', error),
  })

  let router!: ArknoteCommandRouter
  const token = await loadOrCreateArknoteServiceToken(paths.token)
  pipe = new ArknotePipeServer({
    pipeName: arknotePipeName(applicationDirectory),
    token,
    handleRequest: (command, payload) => router.handle(command, payload),
  })

  const trayImage = brandingResourcePath('arknote-app.ico')
  let service!: ArknoteServiceRuntime
  const tray = new ArknoteTray({
    createTray: () => createNativeTray(trayImage),
    buildMenu: (template) => Menu.buildFromTemplate(
      template as Electron.MenuItemConstructorOptions[],
    ),
    taskbar: {
      hidden: () => settingsState.get().hideTaskbarIcons,
      setHidden: async hidden => {
        const applyChange = createArknoteTaskbarPreferenceChange(hidden, {
          persist: async value => { await settingsState.update(current => ({ ...current, hideTaskbarIcons: value })) },
          windows: () => stickyNoteWindows,
        })
        for (;;) {
          try {
            await applyChange()
            return
          } catch (error) {
            const saved = error instanceof ArknoteTaskbarPreferenceError && error.code === 'apply-failed'
            const result = await businessDialogs.showMessageBox(undefined, { type: 'error', title: 'Arknote',
              message: saved ? '任务栏设置已保存，但部分便签尚未应用。' : '任务栏设置未能保存，原设置保留。',
              detail: saved ? '可以重试应用；之后打开的便签会使用已保存的设置。' : '请检查设置文件的访问权限或磁盘空间，然后重试。',
              buttons: ['重试', '稍后'], defaultId: 0, cancelId: 1, noLink: true,
            })
            if (result.response !== 0) throw error
          }
        }
      },
    },
    activeNotes: {
      list: async () => {
        // Read names/order from the index, without reading every note's body.
        const index = await store.initialize()
        const displayed = new Set(windows.openNoteIds())
        return index.notes.filter((record) => record.status === 'active').map((record) => ({
          id: record.id, name: record.name, displayed: displayed.has(record.id),
        }))
      },
      open: (noteId) => router.handle('note.open', { noteId }),
      subscribe: (listener) => notes.subscribe((event) => {
        if (event.type === 'index-changed' || event.type === 'note-name-changed'
            || event.type === 'note-display-state-changed') listener()
      }),
      checkIcon: createStickyNoteTrayCheckIcon(),
    },
    reportError: (error) => console.error('Failed to update or open tray note', error),
    openNoteBox: () => {
      void service.execute('open-box').catch((error) => console.error('Failed to open Arknote box', error))
    },
    createNote: () => {
      void service.execute('new-note').catch((error) => console.error('Failed to create Arknote note', error))
    },
    openArkdown: () => {
      void openSiblingArkdown(applicationDirectory, {
        stat, spawn,
        showError: async message => {
          await businessDialogs.showMessageBox(undefined, { type: 'error', title: '无法打开 Arkdown', message, buttons: ['确定'] })
        },
      }).catch(error => console.error('Failed to present Arkdown launch failure', error))
    },
    openSettings: () => {
      void service.execute('open-settings').catch((error) => console.error('Failed to open Arknote settings', error))
    },
    quit: () => {
      void service.flushAndQuit().catch((error) => console.error('Arknote quit was cancelled', error))
    },
  })

  mutationGates.register(tray)

  const saveSettings = async (value: unknown): Promise<ArknoteSettings> => {
    const updatesMaterials = typeof value === 'object' && value !== null
      && ARKNOTE_MATERIAL_PREFERENCE_KEYS.some(key => Object.hasOwn(value, key))
    const saved = await saveArknoteSettingsUpdate(settingsState, value)
    effectiveThemeColor = saved.themeColor
    // Only explicit material edits from the immediate-save main preferences
    // replace the live draft. Ordinary settings writes leave previews alone.
    const applied = !updatesMaterials || setStickyNoteWallpaperAppearances(copyStickyNoteWallpaperAppearances(saved))
    broadcastThemeColor(saved.themeColor)
    if (!applied) throw new PublicError('WALLPAPER_APPEARANCE_SAVED_NOT_APPLIED')
    return saved
  }

  const savePreferences = async (
    value: ArknotePreferencesUpdate,
  ) => {
    const saved = await settingsState.update((current) =>
      applyArknotePreferences(current, value))
    effectiveThemeColor = saved.themeColor
    broadcastThemeColor(saved.themeColor)
    return arknotePreferencesFromSettings(saved, effectiveThemeColor)
  }

  const boxTheme = new ArknoteBoxThemeController(ipcMain,
    settingsState.get().boxTheme ?? { mode: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', themeColor: effectiveThemeColor },
    async theme => { await settingsState.update(current => ({ ...current, boxTheme: theme })) })
  app.once('will-quit', () => boxTheme.dispose())
  const registerBoxWindow = (window: BrowserWindow) => {
    boxTheme.register(window)
    const registration = registerArknoteBoxWindowIpc({
      ipcMain,
      window,
      stickyNotes: notes,
      getStickyNotePreferences: () => settingsState.get().stickyNotes,
    })
    const unregisterMutationGate = mutationGates.register(registration)
    const unsubscribe = notes.subscribe((event) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(STICKY_NOTE_EVENT_CHANNEL, event)
      }
    })
    window.once('closed', () => {
      unregisterMutationGate()
      unsubscribe()
      registration.dispose()
    })
    return window
  }

  const wallpaperPreviews = new ArknoteWallpaperPreviewCoordinator(
    () => copyStickyNoteWallpaperAppearances(settingsState.get()),
    setStickyNoteWallpaperAppearances,
  )
  let settingsQuitBarrier: ArknoteSettingsQuitBarrier | null = null
  const registerSettingsWindow = (window: BrowserWindow) => {
    const quitBarrier = new ArknoteSettingsQuitBarrier({ ipcMain, window })
    settingsQuitBarrier = quitBarrier
    window.once('closed', () => { if (settingsQuitBarrier === quitBarrier) settingsQuitBarrier = null })
    const wallpaperSession = bindArknoteWallpaperPreviewSession(window, wallpaperPreviews)
    const registration = registerArknoteSettingsWindowIpc({
      ipcMain,
      window,
      getArknotePreferences: () => arknotePreferencesFromSettings(settingsState.get()),
      setArknotePreferences: (value) => wallpaperSession.saveImmediate(() => savePreferences(value)),
      previewStickyNoteWallpaperAppearances: async (value) => wallpaperSession.preview(value),
    })
    const unregisterMutationGate = mutationGates.register(registration)
    window.once('closed', () => {
      unregisterMutationGate()
      registration.dispose()
    })
    return window
  }

  const standaloneWindows = new ArknoteWindowManager({
    initialBoxBounds: settingsState.get().boxWindowBounds,
    createBoxWindow: (bounds) => registerBoxWindow(createArknoteBoxWindow(bounds)),
    createSettingsWindow: (section) =>
      registerSettingsWindow(createArknoteSettingsWindow(section)),
    persistBoxBounds: async (boxWindowBounds) => {
      await settingsState.update((current) => ({ ...current, boxWindowBounds }))
    },
    reportError: (error) => console.error('Failed to persist Arknote box bounds', error),
  })

  const quitGuard = createArknoteQuitGuard({
    quitApp: () => { businessDialogs.dispose(); app.exit(0) },
    flushAndQuit: () => service.flushAndQuit(),
    reportError: (error) => console.error('Arknote quit was cancelled', error),
  })
  router = new ArknoteCommandRouter({
    executeLaunchCommand: (command) => service.execute(command),
    quit: () => service.flushAndQuit(),
    prepareUpdate: () => service.prepareUpdateQuit(),
    cancelUpdate: () => service.cancelUpdateQuit(),
    notes,
    settings: {
      get: () => settingsState.get(),
      set: saveSettings,
      setBoxTheme: theme => boxTheme.set(theme),
      previewThemeColor: async (themeColor) => {
        effectiveThemeColor = themeColor
        broadcastThemeColor(themeColor)
      },
    },
  })
  mutationGates.register(router)
  service = new ArknoteServiceRuntime({
    launchArguments: process.argv,
    store,
    session,
    pipe,
    tray,
    windows: {
      closeAll: async (options) => {
        await windows.closeAll(options)
        await backgroundSettingsWindows.closeAll()
        await standaloneWindows.closeAll()
      },
    },
    mutations: mutationGates,
    prepareToQuit: () => settingsQuitBarrier?.prepare() ?? Promise.resolve(true),
    cancelQuitPreparation: () => settingsQuitBarrier?.cancel(),
    openBox: () => standaloneWindows.openBox(),
    openSettings: () => standaloneWindows.openSettings(),
    createNote: async () => {
      const [active, archived] = await Promise.all([
        notes.list('active'),
        notes.list('archived'),
      ])
      const name = defaultStickyNoteName(
        new Date(),
        [...active, ...archived].map(({ record }) => record.name),
      )
      const note = await notes.create({ name })
      await notes.open(note.record.id)
    },
    quitApp: quitGuard.quitApp,
  })
  notes.subscribe((event) => pipe.broadcast(event))
  app.on('before-quit', quitGuard.handleBeforeQuit)

  await service.initialize()
  while (pendingCommands.length > 0) {
    await service.execute(pendingCommands.shift()!)
  }
  runtime = service
}
