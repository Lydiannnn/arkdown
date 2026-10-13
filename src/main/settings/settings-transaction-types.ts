import type { BackgroundSettings } from '../../shared/background-settings'
import type { DefaultApplicationsPromptState } from '../../shared/default-applications'
import type { DesktopLifecyclePreferences } from '../../shared/desktop-lifecycle-preferences'
import type { EditorAppearancePreferences } from '../../shared/editor-appearance-preferences'
import type {
  AiConversationSettings, CodexCliConnectionSummary, FloatingTranslationSettings,
  ModelConnectionSummary, ScreenshotTranslationSettings, SelectionTranslationSettings,
} from '../../shared/large-model-settings'
import type { LayoutPreferences } from '../../shared/layout-preferences'
import type { BrowserSearchPreferences } from '../../shared/search-preferences'
import type { ShellIntegrationFeature } from '../../shared/shell-integration-preferences'
import type { ScreenshotOcrTier } from '../../shared/screenshot-ocr-models'
import type { StickyNotePreferences } from '../../shared/sticky-note-preferences'
import type { AppSettings, WindowBounds } from './settings-store'

/** Main-only contract. IPC adapters construct these operations after input validation. */
export interface ExpectedSetting<T> { value: T; revision: number }
export type CheckedSettingsPatch<T> = {
  [K in keyof T]?: { value: T[K]; expected: ExpectedSetting<T[K]> }
}

export interface SettingsPreferenceGroups {
  search: BrowserSearchPreferences
  appearance: EditorAppearancePreferences
  layout: LayoutPreferences
  stickyNotes: StickyNotePreferences
  desktopLifecycle: DesktopLifecyclePreferences
}
export interface ModelFeatureGroups {
  // Consent has a separate, one-way operation.
  selectionTranslation: Omit<SelectionTranslationSettings, 'privacyNoticeAccepted'>
  screenshotTranslation: ScreenshotTranslationSettings
  floatingTranslation: FloatingTranslationSettings
  aiConversation: AiConversationSettings
}
export type SettingsPreferenceGroup = keyof SettingsPreferenceGroups
export type ModelFeature = keyof ModelFeatureGroups
export type ConnectionField = Exclude<keyof ModelConnectionSummary, 'id'>
export type ConnectionRevisionField = ConnectionField | 'entity' | 'credential'
export type ModelTestInputs = Pick<ModelConnectionSummary,
  'provider' | 'accessType' | 'protocol' | 'baseUrl' | 'modelId' | 'capabilityOverride'>
export type ExpectedModelTestInputs = {
  [K in keyof ModelTestInputs]: ExpectedSetting<ModelTestInputs[K]>
} & { credentialRevision: number }

/** Keys are accepted only from the finite schema allowlist, never JSON paths. */
export interface SettingsFieldRevisions {
  fields: Partial<Record<string, number>>
  connections: Record<string, Partial<Record<ConnectionRevisionField, number>>>
  tombstones: Record<string, number>
}
export interface SettingsTransactionMetadata {
  version: 1
  revision: number
  minimumBaseRevision: number
  fieldRevisions: SettingsFieldRevisions
}
export interface SettingsTransactionSnapshot {
  settings: AppSettings
  revision: number
  minimumBaseRevision: number
  fieldRevisions: SettingsFieldRevisions
}

type PreferenceOperation = {
  [G in SettingsPreferenceGroup]: {
    kind: G extends 'stickyNotes' ? 'sticky-notes.patch'
      : G extends 'desktopLifecycle' ? 'desktop-lifecycle.patch' : `${G}.patch`
    changes: CheckedSettingsPatch<SettingsPreferenceGroups[G]>
  }
}[SettingsPreferenceGroup]
type FeatureOperation = {
  [F in ModelFeature]: { kind: 'model-feature.patch'; feature: F; changes: CheckedSettingsPatch<ModelFeatureGroups[F]> }
}[ModelFeature]
export type ShortcutFieldChange =
  | { kind: 'set'; value: string | null; expected: ExpectedSetting<string | null | undefined> }
  | { kind: 'clear'; expected: ExpectedSetting<string | null | undefined> }
export type BackgroundControls = Omit<BackgroundSettings, 'imageRelativePath'>
export type BackgroundImageChange =
  | { kind: 'keep' }
  | { kind: 'remove'; expected: ExpectedSetting<string | null> }
  | { kind: 'replace'; relativePath: string; expected: ExpectedSetting<string | null> }

export type SettingsTransactionOperation = PreferenceOperation | FeatureOperation
  | { kind: 'application-update.ensure-identity'; candidateId: string }
  | { kind: 'workspace-intro.mark-seen' }
  | { kind: 'window-bounds.set'; value: WindowBounds; mode: 'last-writer-wins' }
  | { kind: 'window-bounds.clear'; mode: 'last-writer-wins' }
  | { kind: 'workspace.set'; value: string | null; mode: 'last-writer-wins' }
  | { kind: 'folder-picker.set'; value: string; mode: 'last-writer-wins' }
  | { kind: 'folder-picker.clear'; mode: 'last-writer-wins' }
  | { kind: 'shortcuts.patch'; changes: Record<string, ShortcutFieldChange | undefined> }
  | { kind: 'shell-integration.set'; feature: ShellIntegrationFeature; value: boolean; expected: ExpectedSetting<boolean> }
  | { kind: 'screenshot-ocr.set-tier'; value: ScreenshotOcrTier; expected: ExpectedSetting<ScreenshotOcrTier> }
  | { kind: 'default-applications.record-start'; version: string; installationId: string | null }
  | { kind: 'default-applications.mark-handled'; expected: ExpectedSetting<DefaultApplicationsPromptState> }
  | { kind: 'default-applications.mark-close-handled'; expected: ExpectedSetting<DefaultApplicationsPromptState> }
  | { kind: 'main-background.apply'; changes: CheckedSettingsPatch<BackgroundControls>; image: BackgroundImageChange }
  | { kind: 'model-connection.add'; connection: ModelConnectionSummary; expectedAbsentRevision: number }
  | {
    kind: 'model-connection.patch'; id: string
    changes: CheckedSettingsPatch<Omit<ModelConnectionSummary, 'id' | 'accessType'>>
    /**
     * Guard the source snapshot observed before testing a proposed edit. New candidate
     * values are carried by changes; main must bind its actual probe result to that candidate.
     */
    testedInputs?: ExpectedModelTestInputs
    credential?: { kind: 'replace'; expectedRevision: number }
  }
  | {
    kind: 'model-connection.record-test'; id: string; testedInputs: ExpectedModelTestInputs
    changes: CheckedSettingsPatch<Pick<ModelConnectionSummary, 'status' | 'lastTestedAt'>>
  }
  | {
    kind: 'model-connection.remove'; id: string
    expected: ExpectedSetting<ModelConnectionSummary>; expectedCredentialRevision: number
  }
  | { kind: 'translation-privacy.accept' }
  | { kind: 'codex-cli.record-test'; value: CodexCliConnectionSummary; expected: ExpectedSetting<CodexCliConnectionSummary | null> }
  | { kind: 'codex-cli.remove'; expected: ExpectedSetting<CodexCliConnectionSummary | null> }
  | { kind: 'migration.font-defaults' }
  | {
    kind: 'migration.floating-translation'
    /** Parsed optional legacy input, read by main. Existing central values always win. */
    legacy?: FloatingTranslationSettings
  }

export interface SettingsTransactionRequest {
  baseRevision: number
  operations: readonly SettingsTransactionOperation[]
}
export type SettingsConflictField =
  | { kind: 'field'; field: string }
  | { kind: 'connection'; id: string; field: ConnectionRevisionField | 'presence' }
export interface SettingsTransactionConflict {
  status: 'conflict'
  reason: 'future-revision' | 'snapshot-too-old' | 'field-changed' | 'connection-exists' | 'connection-missing'
  operationIndex?: number
  fields: SettingsConflictField[]
  snapshot: SettingsTransactionSnapshot
}
/** Ciphertext/key material is deliberately absent. Only the outer journal owner may commit this plan. */
export interface SettingsCredentialChange { id: string; kind: 'add' | 'replace' | 'remove' }
export type SettingsTransactionReduction = SettingsTransactionConflict
  | { status: 'invalid'; reason: 'invalid-request' | 'invalid-value' | 'duplicate-write' | 'credential-change-limit' | 'revision-exhausted'; operationIndex?: number }
  | { status: 'unchanged'; snapshot: SettingsTransactionSnapshot }
  | { status: 'prepared'; snapshot: SettingsTransactionSnapshot; credentialChange?: SettingsCredentialChange }
