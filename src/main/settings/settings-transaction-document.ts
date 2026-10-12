import { parseUpdateInstallation } from '../../shared/app-update'
import { parseBackgroundSettings } from '../../shared/background-settings'
import { normalizeDefaultApplicationsPrompt } from '../../shared/default-applications'
import { parseDesktopLifecyclePreferences } from '../../shared/desktop-lifecycle-preferences'
import { parseEditorAppearancePreferences } from '../../shared/editor-appearance-preferences'
import { normalizeShortcutBindings } from '../../shared/keyboard-shortcuts'
import { migrateLargeModelSettings, parseLargeModelSettings } from '../../shared/large-model-settings'
import { parseCompleteLayoutPreferences } from '../../shared/layout-preferences'
import { parseBrowserSearchPreferences } from '../../shared/search-preferences'
import { parseShellIntegrationPreferences } from '../../shared/shell-integration-preferences'
import { parseStickyNotePreferences } from '../../shared/sticky-note-preferences'
import { DEFAULT_SETTINGS, normalizeStoredAppSettings, sanitizeWindowBounds } from './settings-store'
import { createSettingsTransactionSnapshot, hasSettingsKeys, isSettingsRecord, settingsTransactionMetadata, settingsValuesEqual } from './settings-transaction-schema'
import { parseSettingsJson, SETTINGS_FILE_MAX_BYTES, SettingsStorageError } from './settings-transaction-files'
import type { SettingsTransactionSnapshot } from './settings-transaction-types'

const keys = ['applicationUpdate', 'shortcuts', 'fontDefaultsVersion', 'windowBounds', 'lastWorkspace', 'lastFolderPickerPath', 'workspaceIntroSeen', 'search', 'appearance', 'layout', 'models', 'stickyNotes', 'desktopLifecycle', 'shellIntegration', 'defaultApplicationsPrompt', 'screenshotOcr', 'mainBackground', '_settingsTransaction']

/** Read-only legacy parsing; corrupt provided groups are never replaced with empty defaults. */
export function decodeSettingsTransactionDocument(bytes: Buffer | null): SettingsTransactionSnapshot {
  if (bytes === null) return createSettingsTransactionSnapshot(structuredClone(DEFAULT_SETTINGS))
  if (bytes.length > SETTINGS_FILE_MAX_BYTES) throw new SettingsStorageError('SETTINGS_STORAGE_TOO_LARGE')
  try {
    const raw = parseSettingsJson(bytes)
    if (!hasSettingsKeys(raw, [], keys)) throw new Error('Invalid root')
    for (const [key, parse] of Object.entries({
      applicationUpdate: parseUpdateInstallation,
      search: parseBrowserSearchPreferences, appearance: parseEditorAppearancePreferences,
      layout: parseCompleteLayoutPreferences, stickyNotes: parseStickyNotePreferences,
      desktopLifecycle: parseDesktopLifecyclePreferences, shellIntegration: parseShellIntegrationPreferences,
      mainBackground: parseBackgroundSettings, windowBounds: sanitizeWindowBounds,
      models: (value: unknown) => parseLargeModelSettings(value) ?? migrateLargeModelSettings(value),
    })) if (Object.hasOwn(raw, key) && parse(raw[key]) === undefined) throw new Error('Invalid group')
    if (Object.hasOwn(raw, 'lastWorkspace') && !(raw.lastWorkspace === null || typeof raw.lastWorkspace === 'string')) throw new Error('Invalid workspace')
    if (Object.hasOwn(raw, 'workspaceIntroSeen') && typeof raw.workspaceIntroSeen !== 'boolean') throw new Error('Invalid intro marker')
    if (Object.hasOwn(raw, 'lastFolderPickerPath') && (typeof raw.lastFolderPickerPath !== 'string' || !raw.lastFolderPickerPath.trim())) throw new Error('Invalid picker')
    if (Object.hasOwn(raw, 'shortcuts') && (!isSettingsRecord(raw.shortcuts) || !settingsValuesEqual(normalizeShortcutBindings(raw.shortcuts), raw.shortcuts))) throw new Error('Invalid shortcuts')
    if (Object.hasOwn(raw, 'defaultApplicationsPrompt') && !settingsValuesEqual(normalizeDefaultApplicationsPrompt(raw.defaultApplicationsPrompt), raw.defaultApplicationsPrompt)) throw new Error('Invalid prompt')
    if (Object.hasOwn(raw, 'screenshotOcr') && (!hasSettingsKeys(raw.screenshotOcr, ['preferredTier']) || !['small', 'medium'].includes(raw.screenshotOcr.preferredTier as string))) throw new Error('Invalid OCR')
    if (Object.hasOwn(raw, 'fontDefaultsVersion') && (typeof raw.fontDefaultsVersion !== 'number' || !Number.isSafeInteger(raw.fontDefaultsVersion) || raw.fontDefaultsVersion < 0 || raw.fontDefaultsVersion > 3)) throw new Error('Invalid migration version')
    const settings = normalizeStoredAppSettings(raw)
    if (typeof raw.fontDefaultsVersion === 'number') settings.fontDefaultsVersion = raw.fontDefaultsVersion
    return createSettingsTransactionSnapshot(settings, raw._settingsTransaction)
  } catch { throw new SettingsStorageError('SETTINGS_STORAGE_MALFORMED') }
}

export function encodeSettingsTransactionDocument(snapshot: SettingsTransactionSnapshot): Buffer {
  const metadata = settingsTransactionMetadata(snapshot)
  const bytes = Buffer.from(`${JSON.stringify({ ...snapshot.settings, _settingsTransaction: metadata }, null, 2)}\n`, 'utf8')
  decodeSettingsTransactionDocument(bytes)
  return bytes
}
