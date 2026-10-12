import { DEFAULT_BACKGROUND_SETTINGS, parseBackgroundSettings, type BackgroundSettings } from '../../shared/background-settings'
import { isUpdateUuid } from '../../shared/app-update'
import { normalizeDefaultApplicationsPrompt } from '../../shared/default-applications'
import { normalizeShortcutBindings } from '../../shared/keyboard-shortcuts'
import { DEFAULT_SHELL_INTEGRATION_PREFERENCES, SHELL_INTEGRATION_FEATURES, type ShellIntegrationFeature } from '../../shared/shell-integration-preferences'
import { DEFAULT_SCREENSHOT_OCR_PREFERENCES } from '../../shared/screenshot-ocr-models'
import { migrateFontDefaults } from './font-defaults-migration'
import { sanitizeWindowBounds } from './settings-store'
import { SettingsReductionAbort, SettingsTransactionDraft } from './settings-transaction-draft'
import { reduceModelSettingsOperation } from './settings-transaction-models'
import {
  BACKGROUND_CONTROL_FIELDS, hasSettingsKeys, isSettingsRecord, isSettingsRevision,
  parseTransactionPreference, PREFERENCE_FIELDS, preferenceValue, pruneSettingsTombstones,
  SETTINGS_TRANSACTION_OPERATION_LIMIT, settingsTransactionMetadata, settingsValuesEqual,
  SHORTCUT_TRANSACTION_FIELDS,
} from './settings-transaction-schema'
import type {
  SettingsPreferenceGroup, SettingsTransactionOperation, SettingsTransactionReduction,
  SettingsTransactionRequest, SettingsTransactionSnapshot,
} from './settings-transaction-types'

const preferenceKinds: Readonly<Record<string, SettingsPreferenceGroup>> = {
  'search.patch': 'search', 'appearance.patch': 'appearance', 'layout.patch': 'layout',
  'sticky-notes.patch': 'stickyNotes', 'desktop-lifecycle.patch': 'desktopLifecycle',
}
const lwwKinds = new Set(['window-bounds.set', 'window-bounds.clear', 'workspace.set', 'folder-picker.set', 'folder-picker.clear'])

function patchPreference(draft: SettingsTransactionDraft, operation: Record<string, unknown>, group: SettingsPreferenceGroup): void {
  if (!hasSettingsKeys(operation, ['kind', 'changes'])) draft.invalid()
  const current = preferenceValue(draft.next.settings, group)
  const original = preferenceValue(draft.latest.settings, group) as unknown as Record<string, unknown>
  const next = draft.patch(operation.changes, PREFERENCE_FIELDS[group], current as unknown as Record<string, unknown>,
    (field, expected) => draft.checkField(`${group}.${field}`, expected, original[field]),
    (field, before, after, apply) => draft.writeField(`${group}.${field}`, before, after, apply))
  const parsed = parseTransactionPreference(group, next)
  // Reject implicit normalizer changes to fields not named by the operation.
  if (parsed === undefined || !settingsValuesEqual(parsed, next)) draft.invalid('invalid-value')
  if (!settingsValuesEqual(current, next)) Object.assign(draft.next.settings, { [group]: parsed })
}

function patchShortcuts(draft: SettingsTransactionDraft, operation: Record<string, unknown>): void {
  if (!hasSettingsKeys(operation, ['kind', 'changes']) || !isSettingsRecord(operation.changes)
    || Object.keys(operation.changes).some(id => !SHORTCUT_TRANSACTION_FIELDS.includes(id))) draft.invalid()
  const current = draft.next.settings.shortcuts ?? {}
  const next = { ...current }
  for (const [id, change] of Object.entries(operation.changes)) {
    if (change === undefined) continue
    if (!isSettingsRecord(change)) draft.invalid()
    const clearing = change.kind === 'clear'
    if (!(clearing || change.kind === 'set')
      || !hasSettingsKeys(change, ['kind', 'expected', ...(clearing ? [] : ['value'])])) draft.invalid()
    if (!clearing && change.value === undefined) continue
    if (!clearing && !(change.value === null || typeof change.value === 'string')) draft.invalid('invalid-value')
    const value = clearing ? undefined : change.value as string | null
    draft.checkField(`shortcuts.${id}`, change.expected, draft.latest.settings.shortcuts?.[id])
    draft.writeField(`shortcuts.${id}`, current[id], value, () => {
      if (clearing) delete next[id]
      else next[id] = value as string | null
    })
  }
  if (!settingsValuesEqual(normalizeShortcutBindings(next), next)) draft.invalid('invalid-value')
  if (!settingsValuesEqual(current, next)) draft.next.settings.shortcuts = next
}

function applyBackground(draft: SettingsTransactionDraft, operation: Record<string, unknown>): void {
  if (!hasSettingsKeys(operation, ['kind', 'changes', 'image']) || !isSettingsRecord(operation.image)) draft.invalid()
  const current = draft.next.settings.mainBackground ?? DEFAULT_BACKGROUND_SETTINGS
  const original = draft.latest.settings.mainBackground ?? DEFAULT_BACKGROUND_SETTINGS
  const next = draft.patch(operation.changes, BACKGROUND_CONTROL_FIELDS, current as unknown as Record<string, unknown>,
    (field, expected) => draft.checkField(`mainBackground.${field}`, expected, (original as unknown as Record<string, unknown>)[field]),
    (field, before, after, apply) => draft.writeField(`mainBackground.${field}`, before, after, apply))
  const image = operation.image
  if (image.kind === 'keep') {
    if (!hasSettingsKeys(image, ['kind'])) draft.invalid()
  } else {
    const removing = image.kind === 'remove'
    if (!(removing || image.kind === 'replace')
      || !hasSettingsKeys(image, ['kind', 'expected', ...(removing ? [] : ['relativePath'])])) draft.invalid()
    // This accepts only the existing managed directory. Copying/ownership checks remain with main's resource owner.
    if (!removing && (typeof image.relativePath !== 'string' || image.relativePath.length > 256
      || !/^backgrounds\/main\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|avif|bmp|svg)$/.test(image.relativePath))) draft.invalid('invalid-value')
    const path = removing ? null : image.relativePath as string
    draft.checkField('mainBackground.imageRelativePath', image.expected, original.imageRelativePath)
    draft.writeField('mainBackground.imageRelativePath', current.imageRelativePath, path, () => { next.imageRelativePath = path })
  }
  const parsed = parseBackgroundSettings(next)
  if (!parsed || !settingsValuesEqual(parsed, next)) draft.invalid('invalid-value')
  if (!settingsValuesEqual(current, parsed)) draft.next.settings.mainBackground = parsed as BackgroundSettings
}

function applyLatestAction(draft: SettingsTransactionDraft, operation: Record<string, unknown>): void {
  const hasValue = operation.kind === 'window-bounds.set' || operation.kind === 'workspace.set' || operation.kind === 'folder-picker.set'
  if (!hasSettingsKeys(operation, ['kind', 'mode', ...(hasValue ? ['value'] : [])]) || operation.mode !== 'last-writer-wins') draft.invalid()
  switch (operation.kind) {
    case 'window-bounds.set': {
      if (!hasSettingsKeys(operation.value, ['width', 'height'], ['x', 'y'])) draft.invalid('invalid-value')
      const bounds = sanitizeWindowBounds(operation.value)
      if (!bounds || !settingsValuesEqual(bounds, operation.value)) draft.invalid('invalid-value')
      draft.writeField('windowBounds', draft.next.settings.windowBounds, bounds, () => { draft.next.settings.windowBounds = bounds })
      return
    }
    case 'window-bounds.clear':
      draft.writeField('windowBounds', draft.next.settings.windowBounds, undefined, () => { delete draft.next.settings.windowBounds }); return
    case 'workspace.set':
      if (!(operation.value === null || typeof operation.value === 'string')) draft.invalid('invalid-value')
      draft.writeField('lastWorkspace', draft.next.settings.lastWorkspace, operation.value, () => { draft.next.settings.lastWorkspace = operation.value as string | null }); return
    case 'folder-picker.set':
      if (typeof operation.value !== 'string' || !operation.value.trim()) draft.invalid('invalid-value')
      draft.writeField('lastFolderPickerPath', draft.next.settings.lastFolderPickerPath, operation.value, () => { draft.next.settings.lastFolderPickerPath = operation.value as string }); return
    case 'folder-picker.clear':
      draft.writeField('lastFolderPickerPath', draft.next.settings.lastFolderPickerPath, undefined, () => { delete draft.next.settings.lastFolderPickerPath }); return
  }
}

function applyPrompt(draft: SettingsTransactionDraft, operation: Record<string, unknown>): void {
  const current = normalizeDefaultApplicationsPrompt(draft.next.settings.defaultApplicationsPrompt)
  if (operation.kind === 'default-applications.record-start') {
    if (!hasSettingsKeys(operation, ['kind', 'version', 'installationId']) || typeof operation.version !== 'string'
      || !(operation.installationId === null || typeof operation.installationId === 'string')) draft.invalid()
    const candidate = { starts: 0, handled: false, version: operation.version,
      ...(operation.installationId === null ? {} : { installationId: operation.installationId }) }
    if (!settingsValuesEqual(candidate, normalizeDefaultApplicationsPrompt(candidate))) draft.invalid('invalid-value')
    const changed = current.version !== operation.version || (current.installationId ?? null) !== operation.installationId
    const next = { ...candidate, starts: Math.min(2, current.starts + 1), handled: changed ? false : current.handled }
    draft.writeField('defaultApplicationsPrompt', current, next, () => { draft.next.settings.defaultApplicationsPrompt = next })
  } else {
    if (!hasSettingsKeys(operation, ['kind', 'expected'])) draft.invalid()
    draft.checkField('defaultApplicationsPrompt', operation.expected, normalizeDefaultApplicationsPrompt(draft.latest.settings.defaultApplicationsPrompt))
    const next = { ...current, starts: 2, handled: true }
    draft.writeField('defaultApplicationsPrompt', current, next, () => { draft.next.settings.defaultApplicationsPrompt = next })
  }
}

function migrateFonts(draft: SettingsTransactionDraft, operation: Record<string, unknown>): void {
  if (!hasSettingsKeys(operation, ['kind'])) draft.invalid()
  const result = migrateFontDefaults(draft.next.settings)
  if (!result.changed) return
  const before = preferenceValue(draft.next.settings, 'appearance')
  const after = preferenceValue(result.settings, 'appearance')
  for (const field of PREFERENCE_FIELDS.appearance) {
    draft.writeField(`appearance.${field}`, before[field], after[field], () => undefined)
  }
  draft.writeField('fontDefaultsVersion', draft.next.settings.fontDefaultsVersion, result.settings.fontDefaultsVersion, () => undefined)
  draft.next.settings.appearance = after
  draft.next.settings.fontDefaultsVersion = result.settings.fontDefaultsVersion
}

function applyOperation(draft: SettingsTransactionDraft, operation: Record<string, unknown>): void {
  const kind = operation.kind as string
  if (Object.hasOwn(preferenceKinds, kind)) { patchPreference(draft, operation, preferenceKinds[kind]!); return }
  if (lwwKinds.has(kind)) { applyLatestAction(draft, operation); return }
  if (reduceModelSettingsOperation(draft, operation)) return
  switch (kind) {
    case 'application-update.ensure-identity':
      if (!hasSettingsKeys(operation, ['kind', 'candidateId']) || !isUpdateUuid(operation.candidateId)) draft.invalid()
      if (!draft.next.settings.applicationUpdate) draft.writeField('applicationUpdate', undefined, { installationId: operation.candidateId },
        () => { draft.next.settings.applicationUpdate = { installationId: operation.candidateId as string } })
      return
    case 'workspace-intro.mark-seen':
      if (!hasSettingsKeys(operation, ['kind'])) draft.invalid()
      draft.writeField('workspaceIntroSeen', draft.next.settings.workspaceIntroSeen === true, true,
        () => { draft.next.settings.workspaceIntroSeen = true })
      return
    case 'shortcuts.patch': patchShortcuts(draft, operation); return
    case 'main-background.apply': applyBackground(draft, operation); return
    case 'default-applications.record-start':
    case 'default-applications.mark-handled': applyPrompt(draft, operation); return
    case 'migration.font-defaults': migrateFonts(draft, operation); return
    case 'shell-integration.set': {
      if (!hasSettingsKeys(operation, ['kind', 'feature', 'value', 'expected']) || typeof operation.value !== 'boolean'
        || !SHELL_INTEGRATION_FEATURES.includes(operation.feature as ShellIntegrationFeature)) draft.invalid()
      const feature = operation.feature as ShellIntegrationFeature
      const current = draft.next.settings.shellIntegration ?? DEFAULT_SHELL_INTEGRATION_PREFERENCES
      draft.checkField(`shellIntegration.${feature}`, operation.expected,
        (draft.latest.settings.shellIntegration ?? DEFAULT_SHELL_INTEGRATION_PREFERENCES)[feature])
      draft.writeField(`shellIntegration.${feature}`, current[feature], operation.value,
        () => { draft.next.settings.shellIntegration = { ...current, [feature]: operation.value as boolean } })
      return
    }
    case 'screenshot-ocr.set-tier': {
      if (!hasSettingsKeys(operation, ['kind', 'value', 'expected']) || (operation.value !== 'small' && operation.value !== 'medium')) draft.invalid()
      const current = draft.next.settings.screenshotOcr ?? DEFAULT_SCREENSHOT_OCR_PREFERENCES
      draft.checkField('screenshotOcr.preferredTier', operation.expected,
        (draft.latest.settings.screenshotOcr ?? DEFAULT_SCREENSHOT_OCR_PREFERENCES).preferredTier)
      draft.writeField('screenshotOcr.preferredTier', current.preferredTier, operation.value,
        () => { draft.next.settings.screenshotOcr = { preferredTier: operation.value as 'small' | 'medium' } })
      return
    }
    default: draft.invalid()
  }
}

function isOperationsArray(value: unknown): value is SettingsTransactionOperation[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > SETTINGS_TRANSACTION_OPERATION_LIMIT || Reflect.ownKeys(value).length !== value.length + 1) return false
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !isSettingsRecord(descriptor.value)
      || typeof descriptor.value.kind !== 'string') return false
  }
  return true
}

/** Main operations carry bounded data, never accessors, class instances, cycles, or executable values. */
function isRequestData(value: unknown, ancestors = new Set<object>(), budget = { remaining: 65_536 }, depth = 0): boolean {
  budget.remaining -= 1
  if (budget.remaining < 0 || depth > 20) return false
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || ancestors.has(value)) return false
  const array = Array.isArray(value)
  if (array ? Object.getPrototypeOf(value) !== Array.prototype : !isSettingsRecord(value)) return false
  const keys = Reflect.ownKeys(value)
  if (array && keys.length !== (value as unknown[]).length + 1) return false
  ancestors.add(value)
  for (const key of keys) {
    if (array && key === 'length') continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value')
      || !isRequestData(descriptor.value, ancestors, budget, depth + 1)) return false
  }
  ancestors.delete(value)
  return true
}

/**
 * Prepare against a normalized, authoritative snapshot read by main while holding T01's lock.
 * This is pure: it neither commits nor changes caches. Journal recovery, schema-preserving
 * atomic persistence, and cache adoption belong to the outer transaction owner.
 */
export function reduceSettingsTransaction(latest: SettingsTransactionSnapshot, request: SettingsTransactionRequest): SettingsTransactionReduction {
  settingsTransactionMetadata(latest) // Fail closed on corrupt metadata; never silently reset it.
  if (!hasSettingsKeys(request, ['baseRevision', 'operations']) || !isSettingsRevision(request.baseRevision)
    || !isOperationsArray(request.operations) || !isRequestData(request)) return { status: 'invalid', reason: 'invalid-request' }
  if (request.baseRevision > latest.revision) return { status: 'conflict', reason: 'future-revision', fields: [], snapshot: structuredClone(latest) }
  if (request.baseRevision < latest.minimumBaseRevision && request.operations.some(operation =>
    !lwwKinds.has(operation.kind) || !('mode' in operation) || operation.mode !== 'last-writer-wins')) {
    return { status: 'conflict', reason: 'snapshot-too-old', fields: [], snapshot: structuredClone(latest) }
  }
  const draft = new SettingsTransactionDraft(latest, request.baseRevision)
  try {
    request.operations.forEach((operation, index) => {
      draft.operationIndex = index
      applyOperation(draft, operation as unknown as Record<string, unknown>)
    })
    if (!draft.changedFields.size && !draft.changedConnections.size) return { status: 'unchanged', snapshot: structuredClone(latest) }
    if (latest.revision === Number.MAX_SAFE_INTEGER) draft.invalid('revision-exhausted')
    const revision = latest.revision + 1
    draft.next.revision = revision
    for (const field of draft.changedFields) draft.next.fieldRevisions.fields[field] = revision
    for (const [id, fields] of draft.changedConnections) {
      if (draft.removedConnections.has(id)) {
        delete draft.next.fieldRevisions.connections[id]
        draft.next.fieldRevisions.tombstones[id] = revision
      } else {
        delete draft.next.fieldRevisions.tombstones[id]
        const revisions = draft.next.fieldRevisions.connections[id] ?? {}
        for (const field of fields) revisions[field] = revision
        draft.next.fieldRevisions.connections[id] = revisions
      }
    }
    const metadata = { version: 1 as const, revision, minimumBaseRevision: draft.next.minimumBaseRevision,
      fieldRevisions: draft.next.fieldRevisions }
    pruneSettingsTombstones(metadata)
    draft.next.minimumBaseRevision = metadata.minimumBaseRevision
    settingsTransactionMetadata(draft.next)
    return { status: 'prepared', snapshot: draft.next, ...(draft.credentialChange ? { credentialChange: draft.credentialChange } : {}) }
  } catch (error) {
    if (error instanceof SettingsReductionAbort) return error.result
    throw error
  }
}
