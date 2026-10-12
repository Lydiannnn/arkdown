export const SHELL_INTEGRATION_FEATURES = ['documentOpenMenu', 'markdownShellNew'] as const
export type ShellIntegrationFeature = typeof SHELL_INTEGRATION_FEATURES[number]
export type ShellIntegrationPreferences = Record<ShellIntegrationFeature, boolean>
export interface ShellIntegrationUpdate { feature: ShellIntegrationFeature; enabled: boolean }
export interface ShellIntegrationSnapshot {
  values: ShellIntegrationPreferences
  unavailable: ShellIntegrationFeature[]
  observation: { version: 1; revision: number; minimumBaseRevision: number; fields: Partial<Record<ShellIntegrationFeature, number>> }
}
export interface ObservedShellIntegrationUpdate extends ShellIntegrationUpdate { observed: ShellIntegrationSnapshot }
export const DEFAULT_SHELL_INTEGRATION_PREFERENCES: ShellIntegrationPreferences = Object.freeze({
  documentOpenMenu: true, markdownShellNew: true,
})

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).length === keys.length
    && Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key))
}

export function parseShellIntegrationPreferences(value: unknown): ShellIntegrationPreferences | undefined {
  if (!exactRecord(value, SHELL_INTEGRATION_FEATURES)
    || SHELL_INTEGRATION_FEATURES.some((key) => typeof value[key] !== 'boolean')) return undefined
  return { documentOpenMenu: value.documentOpenMenu as boolean, markdownShellNew: value.markdownShellNew as boolean }
}

export function normalizeShellIntegrationPreferences(value: unknown): ShellIntegrationPreferences {
  return parseShellIntegrationPreferences(value) ?? { ...DEFAULT_SHELL_INTEGRATION_PREFERENCES }
}

export function parseShellIntegrationUpdate(value: unknown): ShellIntegrationUpdate | undefined {
  if (!exactRecord(value, ['feature', 'enabled']) || typeof value.enabled !== 'boolean'
    || !SHELL_INTEGRATION_FEATURES.includes(value.feature as ShellIntegrationFeature)) return undefined
  return { feature: value.feature as ShellIntegrationFeature, enabled: value.enabled }
}

export function parseShellIntegrationSnapshot(value: unknown): ShellIntegrationSnapshot | undefined {
  if (!exactRecord(value, ['values', 'unavailable', 'observation'])) return undefined
  const values = parseShellIntegrationPreferences(value.values), observation = value.observation
  if (!values || !exactRecord(observation, ['version', 'revision', 'minimumBaseRevision', 'fields'])
    || observation.version !== 1 || !Number.isSafeInteger(observation.revision) || Number(observation.revision) < 0
    || !Number.isSafeInteger(observation.minimumBaseRevision) || Number(observation.minimumBaseRevision) < 0
    || Number(observation.minimumBaseRevision) > Number(observation.revision)) return undefined
  const fields = observation.fields
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)
    || !exactRecord(fields, Reflect.ownKeys(fields).filter((key): key is string => typeof key === 'string'))
    || Reflect.ownKeys(fields).some(key => !SHELL_INTEGRATION_FEATURES.includes(key as ShellIntegrationFeature))) return undefined
  const revisions: Partial<Record<ShellIntegrationFeature, number>> = {}
  for (const feature of SHELL_INTEGRATION_FEATURES) {
    if (!Object.hasOwn(fields, feature)) continue
    const revision = fields[feature]
    if (!Number.isSafeInteger(revision) || Number(revision) < 0 || Number(revision) > Number(observation.revision)) return undefined
    revisions[feature] = Number(revision)
  }
  const unavailable = value.unavailable
  if (!Array.isArray(unavailable) || unavailable.length > SHELL_INTEGRATION_FEATURES.length
    || Object.getPrototypeOf(unavailable) !== Array.prototype || Reflect.ownKeys(unavailable).length !== unavailable.length + 1
    || new Set(unavailable).size !== unavailable.length
    || unavailable.some(feature => !SHELL_INTEGRATION_FEATURES.includes(feature))) return undefined
  return { values, unavailable: [...unavailable], observation: { version: 1, revision: Number(observation.revision),
    minimumBaseRevision: Number(observation.minimumBaseRevision), fields: revisions } }
}

export function parseObservedShellIntegrationUpdate(value: unknown): ObservedShellIntegrationUpdate | undefined {
  if (!exactRecord(value, ['feature', 'enabled', 'observed'])) return undefined
  const update = parseShellIntegrationUpdate({ feature: value.feature, enabled: value.enabled })
  const observed = parseShellIntegrationSnapshot(value.observed)
  return update && observed ? { ...update, observed } : undefined
}
