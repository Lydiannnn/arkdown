import { featureModelConnections } from '../../shared/large-model-settings'
import type { AppSettings } from './settings-store'
import {
  editorAppearancePreferencesEqual,
  normalizeEditorAppearancePreferences,
  type EditorAppearancePreferences,
  type EditorAppearanceSnapshot,
} from '../../shared/editor-appearance-preferences'
import {
  layoutPreferencesEqual,
  normalizeLayoutPreferences,
  type LayoutPreferences,
  type LayoutPreferencesSnapshot,
} from '../../shared/layout-preferences'
import type { AiWritePolicy, ReasoningEffort, ThinkingMode } from '../../shared/large-model-settings'
import { copyBackgroundSettings } from '../../shared/background-settings'
import { copyStickyNotePreferences } from '../../shared/sticky-note-preferences'

interface SettingsWriter {
  save(settings: AppSettings): Promise<void>
}

export interface SettingsUpdater {
  get(): AppSettings
  update(mutator: (settings: AppSettings) => AppSettings): Promise<void>
}

export interface EditorAppearanceCompareAndSetResult {
  applied: boolean
  snapshot: EditorAppearanceSnapshot
}

export interface AiConversationWritePolicySnapshot {
  readonly policy: AiWritePolicy
  readonly revision: number
}

export interface AiConversationWritePolicySource {
  getAiConversationWritePolicySnapshot(): AiConversationWritePolicySnapshot
  subscribeAiConversationWritePolicy(
    listener: (snapshot: AiConversationWritePolicySnapshot) => void,
  ): () => void
}

export interface AiConversationModelSelectionSnapshot {
  readonly connectionId: string | null
  readonly thinkingMode: ThinkingMode
  readonly reasoningEffort: ReasoningEffort
  readonly revision: number
}

export interface AiConversationModelSelectionSource {
  getAiConversationModelSelectionSnapshot(): AiConversationModelSelectionSnapshot
  subscribeAiConversationModelSelection(
    listener: (snapshot: AiConversationModelSelectionSnapshot) => void,
  ): () => void
}

export interface LayoutPreferencesCompareAndSetResult {
  applied: boolean
  snapshot: LayoutPreferencesSnapshot
}

function copySettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    shortcuts: settings.shortcuts ? { ...settings.shortcuts } : undefined,
    windowBounds: settings.windowBounds ? { ...settings.windowBounds } : undefined,
    search: settings.search ? { ...settings.search } : undefined,
    layout: settings.layout ? { ...settings.layout } : undefined,
    desktopLifecycle: settings.desktopLifecycle ? { ...settings.desktopLifecycle } : undefined,
    shellIntegration: settings.shellIntegration ? { ...settings.shellIntegration } : undefined,
    defaultApplicationsPrompt: settings.defaultApplicationsPrompt ? { ...settings.defaultApplicationsPrompt } : undefined,
    mainBackground: settings.mainBackground
      ? copyBackgroundSettings(settings.mainBackground)
      : undefined,
    stickyNotes: settings.stickyNotes
      ? copyStickyNotePreferences(settings.stickyNotes)
      : undefined,
    models: settings.models
      ? {
          version: 6,
          ...(settings.models.floatingTranslation ? { floatingTranslation: { ...settings.models.floatingTranslation } } : {}),
          codexCli: settings.models.codexCli ? structuredClone(settings.models.codexCli) : null,
          connections: settings.models.connections.map((connection) => ({
            ...connection,
            capabilityOverride: connection.capabilityOverride === null
              ? null
              : { ...connection.capabilityOverride },
          })),
          selectionTranslation: { ...settings.models.selectionTranslation },
          screenshotTranslation: { ...settings.models.screenshotTranslation },
          aiConversation: { ...settings.models.aiConversation },
        }
      : undefined,
  }
}

function aiConversationModelSignature(settings: AppSettings): string {
  const models = settings.models
  if (models === undefined) return JSON.stringify([null, 'default', 'default', null])
  const selection = models.aiConversation
  const selected = selection.connectionId === null ? null
    : featureModelConnections(models).find((connection) => connection.id === selection.connectionId) ?? null
  return JSON.stringify([selection.connectionId, selection.thinkingMode, selection.reasoningEffort, selected])
}

export class SettingsCoordinator implements SettingsUpdater {
  private current: AppSettings
  private tail = Promise.resolve()
  private appearanceRevision = 0
  private readonly appearanceListeners = new Set<() => void>()
  private layoutRevision = 0
  private aiConversationWritePolicyRevision = 0
  private aiConversationModelSelectionRevision = 0
  private readonly aiConversationWritePolicyListeners = new Set<
    (snapshot: AiConversationWritePolicySnapshot) => void
  >()
  private readonly aiConversationModelSelectionListeners = new Set<
    (snapshot: AiConversationModelSelectionSnapshot) => void
  >()

  constructor(
    private readonly writer: SettingsWriter,
    initialSettings: AppSettings,
  ) {
    this.current = copySettings(initialSettings)
  }

  get(): AppSettings {
    return copySettings(this.current)
  }

  update(mutator: (settings: AppSettings) => AppSettings): Promise<void> {
    const operation = this.tail.then(async () => {
      const previousAppearance = this.getEditorAppearanceSnapshot().appearance
      const previousPolicy = this.getAiConversationWritePolicySnapshot().policy
      const previousModelSignature = aiConversationModelSignature(this.current)
      const next = copySettings(mutator(this.get()))
      await this.writer.save(copySettings(next))
      this.current = next
      if (!editorAppearancePreferencesEqual(previousAppearance, this.getEditorAppearanceSnapshot().appearance)) this.notifyAppearance()
      const nextPolicy = this.getAiConversationWritePolicySnapshot().policy
      if (nextPolicy !== previousPolicy) {
        this.aiConversationWritePolicyRevision += 1
        const snapshot = this.getAiConversationWritePolicySnapshot()
        for (const listener of this.aiConversationWritePolicyListeners) {
          try { listener(snapshot) } catch { /* settings persistence remains authoritative */ }
        }
      }
      if (aiConversationModelSignature(this.current) !== previousModelSignature) {
        this.aiConversationModelSelectionRevision += 1
        const snapshot = this.getAiConversationModelSelectionSnapshot()
        for (const listener of this.aiConversationModelSelectionListeners) {
          try { listener(snapshot) } catch { /* settings persistence remains authoritative */ }
        }
      }
    })
    this.tail = operation.catch(() => undefined)
    return operation
  }

  subscribeEditorAppearance(listener: () => void): () => void {
    this.appearanceListeners.add(listener)
    return () => { this.appearanceListeners.delete(listener) }
  }
  private notifyAppearance(): void {
    for (const listener of this.appearanceListeners) { try { listener() } catch { /* Observers do not change save results. */ } }
  }

  getEditorAppearanceSnapshot(): EditorAppearanceSnapshot {
    return {
      appearance: normalizeEditorAppearancePreferences(this.current.appearance),
      revision: this.appearanceRevision,
    }
  }

  getAiConversationWritePolicySnapshot(): AiConversationWritePolicySnapshot {
    return Object.freeze({
      policy: this.current.models?.aiConversation.writePolicy ?? 'ask-every-time',
      revision: this.aiConversationWritePolicyRevision,
    })
  }

  subscribeAiConversationWritePolicy(
    listener: (snapshot: AiConversationWritePolicySnapshot) => void,
  ): () => void {
    this.aiConversationWritePolicyListeners.add(listener)
    return () => { this.aiConversationWritePolicyListeners.delete(listener) }
  }

  getAiConversationModelSelectionSnapshot(): AiConversationModelSelectionSnapshot {
    return Object.freeze({
      connectionId: this.current.models?.aiConversation.connectionId ?? null,
      thinkingMode: this.current.models?.aiConversation.thinkingMode ?? 'default',
      reasoningEffort: this.current.models?.aiConversation.reasoningEffort ?? 'default',
      revision: this.aiConversationModelSelectionRevision,
    })
  }

  subscribeAiConversationModelSelection(
    listener: (snapshot: AiConversationModelSelectionSnapshot) => void,
  ): () => void {
    this.aiConversationModelSelectionListeners.add(listener)
    return () => { this.aiConversationModelSelectionListeners.delete(listener) }
  }

  getLayoutSnapshot(): LayoutPreferencesSnapshot {
    return { layout: normalizeLayoutPreferences(this.current.layout), revision: this.layoutRevision }
  }

  compareAndSetLayout(
    expectedRevision: number,
    expectedLayout: LayoutPreferences,
    replacement: LayoutPreferences,
  ): Promise<LayoutPreferencesCompareAndSetResult> {
    const operation = this.tail.then(async () => {
      const current = this.getLayoutSnapshot()
      if (
        current.revision !== expectedRevision
        || !layoutPreferencesEqual(current.layout, expectedLayout)
      ) return { applied: false, snapshot: current }
      const next = copySettings({ ...this.get(), layout: replacement })
      await this.writer.save(copySettings(next))
      this.current = next
      this.layoutRevision += 1
      return { applied: true, snapshot: this.getLayoutSnapshot() }
    })
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  setEditorAppearance(
    appearance: EditorAppearancePreferences,
  ): Promise<EditorAppearanceSnapshot> {
    const operation = this.tail.then(async () => {
      const next = copySettings({ ...this.get(), appearance })
      await this.writer.save(copySettings(next))
      this.current = next
      this.appearanceRevision += 1
      this.notifyAppearance()
      return this.getEditorAppearanceSnapshot()
    })
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  compareAndSetEditorAppearance(
    expectedRevision: number,
    expectedAppearance: EditorAppearancePreferences,
    replacement: EditorAppearancePreferences,
  ): Promise<EditorAppearanceCompareAndSetResult> {
    const operation = this.tail.then(async () => {
      const current = this.getEditorAppearanceSnapshot()
      if (
        current.revision !== expectedRevision
        || !editorAppearancePreferencesEqual(current.appearance, expectedAppearance)
      ) {
        return { applied: false, snapshot: current }
      }
      const next = copySettings({ ...this.get(), appearance: replacement })
      await this.writer.save(copySettings(next))
      this.current = next
      this.appearanceRevision += 1
      this.notifyAppearance()
      return { applied: true, snapshot: this.getEditorAppearanceSnapshot() }
    })
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }
}
