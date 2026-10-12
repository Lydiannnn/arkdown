import { randomUUID } from 'node:crypto'
import { normalizeShortcutBindings, type ShortcutBindings } from '../../shared/keyboard-shortcuts'
import { parseUpdateInstallation } from '../../shared/app-update'
import { normalizeDefaultApplicationsPrompt, type DefaultApplicationsPromptState } from '../../shared/default-applications'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { normalizeShellIntegrationPreferences, type ShellIntegrationPreferences } from '../../shared/shell-integration-preferences'
import {
  parseBrowserSearchPreferences,
  type BrowserSearchPreferences,
} from '../../shared/search-preferences'
import {
  parseEditorAppearancePreferences,
  type EditorAppearancePreferences,
} from '../../shared/editor-appearance-preferences'
import {
  DEFAULT_FLOATING_TRANSLATION_SETTINGS,
  migrateLargeModelSettings,
  normalizeLargeModelSettings,
  parseLargeModelSettings,
  type LargeModelSettings,
} from '../../shared/large-model-settings'
import { FONT_DEFAULTS_VERSION } from './font-defaults-migration'
import { parseScreenTranslationPatch } from '../../shared/screen-translation'
import {
  copyDesktopLifecyclePreferences,
  DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES,
  normalizeDesktopLifecyclePreferences,
  type DesktopLifecyclePreferences,
} from '../../shared/desktop-lifecycle-preferences'
import {
  copyStickyNotePreferences,
  DEFAULT_STICKY_NOTE_PREFERENCES,
  normalizeStickyNotePreferences,
  type StickyNotePreferences,
} from '../../shared/sticky-note-preferences'
import {
  copyScreenshotOcrPreferences,
  DEFAULT_SCREENSHOT_OCR_PREFERENCES,
  normalizeScreenshotOcrPreferences,
  type ScreenshotOcrPreferences,
} from '../../shared/screenshot-ocr-models'
import {
  normalizeLayoutPreferences,
  type LayoutPreferences,
} from '../../shared/layout-preferences'
import {
  copyBackgroundSettings,
  DEFAULT_BACKGROUND_SETTINGS,
  normalizeBackgroundSettings,
  type BackgroundSettings,
} from '../../shared/background-settings'

export interface WindowBounds {
  width: number
  height: number
  x?: number
  y?: number
}

export interface AppSettings {
  applicationUpdate?: { installationId: string }
  shortcuts?: ShortcutBindings
  fontDefaultsVersion?: number
  windowBounds?: WindowBounds
  lastWorkspace: string | null
  lastFolderPickerPath?: string
  workspaceIntroSeen?: boolean
  search?: BrowserSearchPreferences
  appearance?: EditorAppearancePreferences
  layout?: LayoutPreferences
  models?: LargeModelSettings
  stickyNotes?: StickyNotePreferences
  desktopLifecycle?: DesktopLifecyclePreferences
  shellIntegration?: ShellIntegrationPreferences
  defaultApplicationsPrompt?: DefaultApplicationsPromptState
  screenshotOcr?: ScreenshotOcrPreferences
  mainBackground?: BackgroundSettings
}

export interface SettingsStoreDependencies {
  readTextFile: (filePath: string) => Promise<string>
  copyFileExclusive: (from: string, to: string) => Promise<void>
  removeFile: (filePath: string) => Promise<void>
  ensureDirectory: (directory: string) => Promise<void>
  writeTextFileAtomic: (filePath: string, contents: string) => Promise<void>
  createBackupSuffix: () => string
  reportError: (message: string, error: unknown) => void
}

export const DEFAULT_SETTINGS: AppSettings = {
  fontDefaultsVersion: FONT_DEFAULTS_VERSION,
  lastWorkspace: null,
  shellIntegration: normalizeShellIntegrationPreferences(undefined),
  stickyNotes: copyStickyNotePreferences(DEFAULT_STICKY_NOTE_PREFERENCES),
  desktopLifecycle: copyDesktopLifecyclePreferences(DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES),
  screenshotOcr: copyScreenshotOcrPreferences(DEFAULT_SCREENSHOT_OCR_PREFERENCES),
  layout: normalizeLayoutPreferences(undefined),
  mainBackground: copyBackgroundSettings(DEFAULT_BACKGROUND_SETTINGS),
}

export function sanitizeWindowBounds(value: unknown): WindowBounds | undefined {
  if (typeof value !== 'object' || value === null) return undefined

  const { width, height, x, y } = value as Record<string, unknown>
  if (
    typeof width !== 'number' ||
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    typeof height !== 'number' ||
    !Number.isSafeInteger(height) ||
    height <= 0
  ) {
    return undefined
  }

  const bounds: WindowBounds = { width, height }
  if (typeof x === 'number' && Number.isSafeInteger(x) && typeof y === 'number' && Number.isSafeInteger(y)) {
    bounds.x = x
    bounds.y = y
  }
  return bounds
}

function copySettings(value: unknown): AppSettings {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_SETTINGS }

  const {
    shortcuts,
    applicationUpdate,
    appearance,
    fontDefaultsVersion,
    lastFolderPickerPath,
    workspaceIntroSeen,
    lastWorkspace,
    windowBounds,
    search,
    models,
    layout,
    stickyNotes,
    desktopLifecycle,
    shellIntegration,
    defaultApplicationsPrompt,
    screenshotOcr,
    mainBackground,
  } = value as Record<string, unknown>
  const parsedModels = parseLargeModelSettings(models) ?? migrateLargeModelSettings(models)
  return {
    ...(parseUpdateInstallation(applicationUpdate) ? { applicationUpdate: parseUpdateInstallation(applicationUpdate) } : {}),
    ...(shortcuts === undefined ? {} : { shortcuts: normalizeShortcutBindings(shortcuts) }),
    fontDefaultsVersion: fontDefaultsVersion === FONT_DEFAULTS_VERSION
      ? FONT_DEFAULTS_VERSION
      : undefined,
    lastWorkspace: typeof lastWorkspace === 'string' ? lastWorkspace : null,
    ...(workspaceIntroSeen === true ? { workspaceIntroSeen: true } : {}),
    ...(typeof lastFolderPickerPath === 'string' && lastFolderPickerPath.trim()
      ? { lastFolderPickerPath }
      : {}),
    windowBounds: sanitizeWindowBounds(windowBounds),
    search: parseBrowserSearchPreferences(search),
    appearance: parseEditorAppearancePreferences(appearance),
    layout: normalizeLayoutPreferences(layout),
    shellIntegration: normalizeShellIntegrationPreferences(shellIntegration),
    ...(defaultApplicationsPrompt === undefined ? {} : { defaultApplicationsPrompt: normalizeDefaultApplicationsPrompt(defaultApplicationsPrompt) }),
    ...(Object.hasOwn(value, 'stickyNotes')
      ? { stickyNotes: normalizeStickyNotePreferences(stickyNotes) }
      : {}),
    ...(Object.hasOwn(value, 'desktopLifecycle')
      ? { desktopLifecycle: normalizeDesktopLifecyclePreferences(desktopLifecycle) }
      : {}),
    ...(parsedModels === undefined ? {} : { models: parsedModels }),
    screenshotOcr: normalizeScreenshotOcrPreferences(screenshotOcr),
    mainBackground: normalizeBackgroundSettings(mainBackground),
  }
}

/** Pure legacy normalization for the inactive transaction document adapter; no read/write/migration effects. */
export function normalizeStoredAppSettings(value: unknown): AppSettings {
  return copySettings(value)
}

function defaultDependencies(): SettingsStoreDependencies {
  return {
    readTextFile: (filePath) => readFile(filePath, 'utf8'),
    copyFileExclusive: (from, to) => copyFile(from, to, constants.COPYFILE_EXCL),
    removeFile: (filePath) => rm(filePath, { force: true }),
    ensureDirectory: async (directory) => {
      await mkdir(directory, { recursive: true })
    },
    writeTextFileAtomic: (filePath, contents) =>
      writeFileAtomic(filePath, contents, { encoding: 'utf8', fsync: true }),
    createBackupSuffix: randomUUID,
    reportError: (message, error) => console.error(message, error),
  }
}

export class SettingsStore {
  readonly filePath: string
  private readonly dependencies: SettingsStoreDependencies

  constructor(
    private readonly root: string,
    private readonly now = Date.now,
    dependencies: Partial<SettingsStoreDependencies> = {},
  ) {
    this.filePath = path.join(root, 'settings.json')
    this.dependencies = { ...defaultDependencies(), ...dependencies }
  }

  async load(): Promise<AppSettings> {
    let source: string
    try {
      source = await this.dependencies.readTextFile(this.filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.migrateFloatingTranslation({ ...DEFAULT_SETTINGS })

      this.dependencies.reportError('Could not read settings', error)
      return { ...DEFAULT_SETTINGS }
    }

    try {
      const settings = copySettings(JSON.parse(source.replace(/^\uFEFF/, '')) as unknown)
      return this.migrateFloatingTranslation(settings)
    } catch (error) {
      const backupPath = path.join(
        this.root,
        `settings.corrupt-${this.now()}-${this.dependencies.createBackupSuffix()}.json`,
      )
      try {
        await this.dependencies.copyFileExclusive(this.filePath, backupPath)
        try {
          await this.dependencies.removeFile(this.filePath)
        } catch (removeError) {
          this.dependencies.reportError('Could not remove malformed settings after backup', removeError)
        }
      } catch (backupError) {
        this.dependencies.reportError('Could not back up malformed settings', backupError)
      }
      this.dependencies.reportError('Could not parse settings', error)
      return { ...DEFAULT_SETTINGS }
    }
  }

  private async migrateFloatingTranslation(settings: AppSettings): Promise<AppSettings> {
    // Existing central model choices (including null) and targets always win.
    // Only absent fields are imported; backend/geometry and credentials stay local.
    if (!settings.models?.floatingTranslation || !Object.hasOwn(settings.models.floatingTranslation, 'target')) {
      let legacy: ReturnType<typeof parseScreenTranslationPatch>
      try {
        const legacyText = await this.dependencies.readTextFile(path.join(this.root, 'screen-translation', 'settings.json'))
        if (legacyText.length <= 16_384) {
          legacy = parseScreenTranslationPatch(JSON.parse(legacyText.replace(/^\uFEFF/, '')))
        }
      } catch { /* Optional legacy module settings do not prevent editor startup. */ }
      if (settings.models || legacy) {
        const models = normalizeLargeModelSettings(settings.models)
        const target = legacy?.target ?? 'auto'
        const oldBinding = legacy && Object.hasOwn(legacy, 'connectionId') ? parseLargeModelSettings({ ...models, floatingTranslation: {
          connectionId: legacy.connectionId, thinkingMode: legacy.thinkingMode ?? 'disabled', reasoningEffort: legacy.reasoningEffort ?? 'low', target,
        } })?.floatingTranslation : undefined
        settings.models = { ...models, floatingTranslation: {
          ...(models.floatingTranslation ?? oldBinding ?? DEFAULT_FLOATING_TRANSLATION_SETTINGS), target,
        } }
        try { await this.save(settings) } catch (error) {
          this.dependencies.reportError('Could not persist floating translation settings migration', error)
        }
      }
    }
    return settings
  }

  async save(settings: AppSettings): Promise<void> {
    await this.dependencies.ensureDirectory(this.root)
    await this.dependencies.writeTextFileAtomic(this.filePath, `${JSON.stringify(copySettings(settings), null, 2)}\n`)
  }
}
