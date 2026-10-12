import { parseArknoteBoxTheme, type ArknoteBoxTheme } from '../../shared/arknote-box-theme'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import writeFileAtomic from 'write-file-atomic'
import {
  copyStickyNotePreferences,
  DEFAULT_STICKY_NOTE_PREFERENCES,
  parseStickyNotePreferences,
  type StickyNotePreferences,
} from '../../shared/sticky-note-preferences'
import { parseDesktopLifecyclePreferences } from '../../shared/desktop-lifecycle-preferences'
import { parseEditorAppearancePreferences } from '../../shared/editor-appearance-preferences'
import { DEFAULT_THEME_COLOR, isThemeColor, normalizeThemeColor } from '../../shared/theme-color'
import type { StickyNoteWindowBounds } from '../../shared/sticky-notes'
import {
  copyArknotePreferences,
  ARKNOTE_MATERIAL_PREFERENCE_KEYS,
  parseArknotePreferencesUpdate,
  type ArknotePreferences,
  type ArknotePreferencesUpdate,
} from '../../shared/arknote-preferences'
import { assertAbsoluteNormalizedPath } from './arknote-paths'
import { copyStickyNoteMicaAppearance, DEFAULT_STICKY_NOTE_MICA_APPEARANCE, parseStickyNoteMicaAppearance, type StickyNoteMicaAppearance } from '../../shared/sticky-note-mica-appearance'
import { copyStickyNoteGlassAppearances, DEFAULT_STICKY_NOTE_GLASS_APPEARANCES, parseStickyNoteGlassAppearances, type StickyNoteGlassAppearances } from '../../shared/sticky-note-glass-appearance'
import { copyStickyNoteMaterialEffects, DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS, parseStickyNoteMaterialEffects, type StickyNoteMaterialEffects } from '../../shared/sticky-note-material-effects'
import type { StickyNoteWallpaperAppearances } from '../../shared/sticky-note-glass-appearance'

export interface ArknoteSettings {
  schemaVersion: 1
  hideTaskbarIcons: boolean
  launchAtLogin: boolean
  registerDesktopContextMenu: boolean
  startupHintDismissed: boolean
  stickyNotes: StickyNotePreferences
  themeColor: string
  micaAppearance: StickyNoteMicaAppearance
  glassAppearances: StickyNoteGlassAppearances
  materialEffects: StickyNoteMaterialEffects
  boxWindowBounds: StickyNoteWindowBounds | null
  boxTheme?: ArknoteBoxTheme
}

export type ArknoteSettingsUpdate =
  Omit<ArknoteSettings, keyof StickyNoteWallpaperAppearances>
  & Partial<StickyNoteWallpaperAppearances>

export const DEFAULT_ARKNOTE_SETTINGS: ArknoteSettings = Object.freeze({
  schemaVersion: 1,
  hideTaskbarIcons: false,
  launchAtLogin: false,
  registerDesktopContextMenu: true,
  startupHintDismissed: false,
  stickyNotes: copyStickyNotePreferences(DEFAULT_STICKY_NOTE_PREFERENCES),
  themeColor: DEFAULT_THEME_COLOR,
  micaAppearance: copyStickyNoteMicaAppearance(DEFAULT_STICKY_NOTE_MICA_APPEARANCE),
  glassAppearances: copyStickyNoteGlassAppearances(DEFAULT_STICKY_NOTE_GLASS_APPEARANCES),
  materialEffects: copyStickyNoteMaterialEffects(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS),
  boxWindowBounds: null,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value)
  return own.length === keys.length
    && own.every((key) => typeof key === 'string' && keys.includes(key))
}

function parseBoxBounds(value: unknown): StickyNoteWindowBounds | null | undefined {
  if (value === null) return null
  if (!isRecord(value) || !exactKeys(value, ['x', 'y', 'width', 'height'])) return undefined
  const { x, y, width, height } = value
  if (
    !Number.isSafeInteger(x)
    || !Number.isSafeInteger(y)
    || !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || Number(width) < 360
    || Number(height) < 480
    || Number(width) > 10_000
    || Number(height) > 10_000
    || Math.abs(Number(x)) > 100_000
    || Math.abs(Number(y)) > 100_000
  ) return undefined
  return { x: Number(x), y: Number(y), width: Number(width), height: Number(height) }
}

export function parseArknoteSettings(value: unknown): ArknoteSettings | undefined {
  if (!isRecord(value)) return undefined
  const currentKeys = [
    'schemaVersion',
    'hideTaskbarIcons',
    'launchAtLogin',
    'registerDesktopContextMenu',
    'startupHintDismissed',
    'stickyNotes',
    'themeColor',
    'micaAppearance',
    'glassAppearances',
    'materialEffects',
    'boxWindowBounds',
    'boxTheme',
  ] as const
  const keys = Reflect.ownKeys(value)
  if (keys.length < 5 || keys.length > 12 || !keys.every((key) =>
    typeof key === 'string' && currentKeys.includes(key as typeof currentKeys[number]))) return undefined
  const stickyNotes = parseStickyNotePreferences(value.stickyNotes)
  const boxWindowBounds = parseBoxBounds(value.boxWindowBounds)
  const micaAppearance = Object.hasOwn(value, 'micaAppearance')
    ? parseStickyNoteMicaAppearance(value.micaAppearance)
    : copyStickyNoteMicaAppearance(DEFAULT_STICKY_NOTE_MICA_APPEARANCE)
  const glassAppearances = Object.hasOwn(value, 'glassAppearances')
    ? parseStickyNoteGlassAppearances(value.glassAppearances)
    : copyStickyNoteGlassAppearances(DEFAULT_STICKY_NOTE_GLASS_APPEARANCES)
  const materialEffects = Object.hasOwn(value, 'materialEffects')
    ? parseStickyNoteMaterialEffects(value.materialEffects)
    : copyStickyNoteMaterialEffects(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS)
  if (
    value.schemaVersion !== 1
    || !(value.hideTaskbarIcons === undefined || typeof value.hideTaskbarIcons === 'boolean')
    || typeof value.launchAtLogin !== 'boolean'
    || typeof value.registerDesktopContextMenu !== 'boolean'
    || !(value.startupHintDismissed === undefined || typeof value.startupHintDismissed === 'boolean')
    || !(value.themeColor === undefined || isThemeColor(value.themeColor))
    || stickyNotes === undefined
    || boxWindowBounds === undefined
    || !micaAppearance
    || !glassAppearances
    || !materialEffects
    || (Object.hasOwn(value, 'boxTheme') && !parseArknoteBoxTheme(value.boxTheme))
  ) return undefined
  return {
    schemaVersion: 1,
    hideTaskbarIcons: value.hideTaskbarIcons ?? false,
    launchAtLogin: value.launchAtLogin,
    registerDesktopContextMenu: value.registerDesktopContextMenu,
    startupHintDismissed: value.startupHintDismissed ?? false,
    stickyNotes,
    micaAppearance,
    glassAppearances,
    materialEffects,
    themeColor: value.themeColor === undefined ? DEFAULT_THEME_COLOR : normalizeThemeColor(value.themeColor),
    boxWindowBounds,
    ...(value.boxTheme ? { boxTheme: parseArknoteBoxTheme(value.boxTheme)! } : {}),
  }
}

export function copyArknoteSettings(value: ArknoteSettings): ArknoteSettings {
  return {
    ...value,
    stickyNotes: copyStickyNotePreferences(value.stickyNotes),
    micaAppearance: copyStickyNoteMicaAppearance(value.micaAppearance),
    glassAppearances: copyStickyNoteGlassAppearances(value.glassAppearances),
    materialEffects: copyStickyNoteMaterialEffects(value.materialEffects),
    boxWindowBounds: value.boxWindowBounds ? { ...value.boxWindowBounds } : null,
    ...(value.boxTheme ? { boxTheme: { ...value.boxTheme } } : {}),
  }
}

export function arknotePreferencesFromSettings(
  value: ArknoteSettings,
  effectiveThemeColor: string = value.themeColor,
): ArknotePreferences {
  return copyArknotePreferences({
    launchAtLogin: value.launchAtLogin,
    registerDesktopContextMenu: value.registerDesktopContextMenu,
    startupHintDismissed: value.startupHintDismissed,
    stickyNotes: value.stickyNotes,
    themeColor: normalizeThemeColor(effectiveThemeColor),
    micaAppearance: value.micaAppearance,
    glassAppearances: value.glassAppearances,
    materialEffects: value.materialEffects,
  })
}

export function applyArknotePreferences(
  settings: ArknoteSettings,
  preferences: ArknotePreferencesUpdate,
): ArknoteSettings {
  const update = parseArknotePreferencesUpdate(preferences)
  if (!update) throw new Error('Arknote 设置无效')
  const value = copyArknotePreferences({ ...arknotePreferencesFromSettings(settings), ...update })
  return {
    ...copyArknoteSettings(settings),
    launchAtLogin: value.launchAtLogin,
    registerDesktopContextMenu: value.registerDesktopContextMenu,
    startupHintDismissed: value.startupHintDismissed,
    stickyNotes: value.stickyNotes,
    themeColor: value.themeColor,
    micaAppearance: value.micaAppearance,
    glassAppearances: value.glassAppearances,
    materialEffects: value.materialEffects,
  }
}

export function parseArknoteSettingsUpdate(value: unknown): ArknoteSettingsUpdate | undefined {
  const parsed: ArknoteSettingsUpdate | undefined = parseArknoteSettings(value)
  if (!parsed || !isRecord(value)) return undefined
  for (const key of ARKNOTE_MATERIAL_PREFERENCE_KEYS) {
    if (!Object.hasOwn(value, key)) delete parsed[key]
  }
  return parsed
}

/** Preserve the original settings.set payload's material presence after validating it. */
export function arknotePreferencesUpdateFromSettings(value: ArknoteSettingsUpdate): ArknotePreferencesUpdate {
  const { schemaVersion: _schema, boxWindowBounds: _bounds, boxTheme: _boxTheme, hideTaskbarIcons: _taskbar, ...preferences } = value
  const parsed = parseArknotePreferencesUpdate(preferences)
  if (!parsed) throw new Error('Arknote 设置无效')
  return parsed
}

/** Keep the existing pipe shape, but never promote omitted material fields to writes. */
export function arknoteSettingsForPreferencesUpdate(
  current: ArknoteSettings,
  preferences: ArknotePreferencesUpdate,
): ArknoteSettingsUpdate {
  const parsed = parseArknotePreferencesUpdate(preferences)
  if (!parsed) throw new Error('Arknote 设置无效')
  const value: ArknoteSettingsUpdate = applyArknotePreferences(current, parsed)
  for (const key of ARKNOTE_MATERIAL_PREFERENCE_KEYS) {
    if (!Object.hasOwn(parsed, key)) delete value[key]
  }
  return value
}

export function arknoteSettingsFromLegacy(value: unknown): ArknoteSettings {
  const source = isRecord(value) ? value : {}
  const stickyNotes = parseStickyNotePreferences(source.stickyNotes)
    ?? DEFAULT_STICKY_NOTE_PREFERENCES
  const desktopLifecycle = parseDesktopLifecyclePreferences(source.desktopLifecycle)
  const appearance = parseEditorAppearancePreferences(source.appearance)
  return {
    ...copyArknoteSettings(DEFAULT_ARKNOTE_SETTINGS),
    launchAtLogin: desktopLifecycle?.launchAtLogin ?? false,
    stickyNotes: copyStickyNotePreferences(stickyNotes),
    themeColor: appearance?.themeColor ?? DEFAULT_THEME_COLOR,
  }
}

export class ArknoteSettingsUpdateQueue {
  private current: ArknoteSettings
  private tail: Promise<void> = Promise.resolve()

  constructor(
    initial: ArknoteSettings,
    private readonly persist: (
      next: ArknoteSettings,
      previous: ArknoteSettings,
    ) => Promise<void>,
  ) {
    const parsed = parseArknoteSettings(initial)
    if (!parsed) throw new Error('Arknote 设置无效')
    this.current = copyArknoteSettings(parsed)
  }

  get(): ArknoteSettings {
    return copyArknoteSettings(this.current)
  }

  replace(value: ArknoteSettings): Promise<ArknoteSettings> {
    return this.update(() => value)
  }

  update(
    transform: (current: ArknoteSettings) => ArknoteSettings,
  ): Promise<ArknoteSettings> {
    const operation = this.tail.then(async () => {
      const previous = copyArknoteSettings(this.current)
      const next = parseArknoteSettings(transform(copyArknoteSettings(previous)))
      if (!next) throw new Error('Arknote 设置无效')
      await this.persist(next, previous)
      this.current = copyArknoteSettings(next)
      return copyArknoteSettings(this.current)
    })
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }
}

/** The service merges after earlier writes finish, never against the client's read snapshot. */
export function saveArknoteSettingsUpdate(
  queue: Pick<ArknoteSettingsUpdateQueue, 'update'>,
  input: unknown,
): Promise<ArknoteSettings> {
  const update = parseArknoteSettingsUpdate(input)
  if (!update) return Promise.reject(new Error('Arknote 设置无效'))
  const preferences = arknotePreferencesUpdateFromSettings(update)
  return queue.update(current => applyArknotePreferences(current, preferences))
}

export class ArknoteSettingsStore {
  readonly filePath: string

  constructor(
    private readonly root: string,
    private readonly now = Date.now,
    private readonly backupSuffix: () => string = () => randomUUID(),
  ) {
    assertAbsoluteNormalizedPath(root, 'Arknote 设置目录')
    this.filePath = path.join(root, 'settings.json')
  }

  async load(): Promise<ArknoteSettings> {
    let source: string
    try {
      source = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return copyArknoteSettings(DEFAULT_ARKNOTE_SETTINGS)
      }
      throw error
    }
    try {
      const parsed = parseArknoteSettings(JSON.parse(source.replace(/^\uFEFF/u, '')) as unknown)
      if (!parsed) throw new Error('Invalid Arknote settings')
      return copyArknoteSettings(parsed)
    } catch {
      const backupPath = path.join(
        this.root,
        `settings.corrupt-${this.now()}-${this.backupSuffix()}.json`,
      )
      await copyFile(this.filePath, backupPath, constants.COPYFILE_EXCL)
      await rm(this.filePath, { force: true })
      return copyArknoteSettings(DEFAULT_ARKNOTE_SETTINGS)
    }
  }

  async save(settings: ArknoteSettings): Promise<void> {
    const parsed = parseArknoteSettings(settings)
    if (!parsed) throw new Error('Arknote 设置无效')
    await mkdir(this.root, { recursive: true })
    await writeFileAtomic(
      this.filePath,
      `${JSON.stringify(parsed, null, 2)}\n`,
      { encoding: 'utf8', fsync: true },
    )
  }
}
