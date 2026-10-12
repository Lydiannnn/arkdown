import { parseUpdateTransfer, type UpdateTransferSnapshot } from './update-transfer'
export const APP_UPDATE_WEBSITE = 'https://arkdown.cotax.tech/'
export const APP_UPDATE_CHANGED = 'app-update:changed'
export function parseUpdateAbout(value: unknown): { interactionId: string; open: boolean } | undefined {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return undefined
  const r = value as Record<string, unknown>
  if (Object.keys(r).length !== 2 || !Object.hasOwn(r, 'interactionId') || !Object.hasOwn(r, 'open')
    || typeof r.interactionId !== 'string' || !/^[\w-]{1,80}$/.test(r.interactionId) || typeof r.open !== 'boolean') return undefined
  return { interactionId: r.interactionId, open: r.open }
}
export function parseUpdateSnapshot(value: unknown): UpdateSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const r = value as Record<string, unknown>
  if (Object.keys(r).length !== (Object.hasOwn(r, 'transfer') ? 7 : 6) || (Object.hasOwn(r, 'transfer') && !parseUpdateTransfer(r.transfer))
    || !Number.isSafeInteger(r.revision) || (r.revision as number) < 0
    || !parseUpdateVersion(r.currentVersion) || !['idle', 'checking', 'available', 'upToDate', 'unavailable'].includes(r.status as string)
    || typeof r.bubbleVisible !== 'boolean' || !['hidden', 'visible', 'closing', 'protecting'].includes(r.requiredPrompt as string)) return undefined
  if (r.candidate !== null) {
    if (!r.candidate || typeof r.candidate !== 'object') return undefined
    const c = r.candidate as Record<string, unknown>
    if (Object.keys(c).length !== 4 || typeof c.version !== 'string' || compareUpdateVersions(c.version, r.currentVersion as string) !== 1
      || typeof c.required !== 'boolean' || !['optional', 'recommended', 'required', 'urgent'].includes(c.mode as string)
      || typeof c.message !== 'string' || c.message.length > 4096) return undefined
  }
  return structuredClone(value) as UpdateSnapshot
}
export function parseUpdateInstallation(value: unknown): { installationId: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 1 && isUpdateUuid(record.installationId) ? { installationId: record.installationId } : undefined
}
export type UpdateChannel = 'stable' | 'beta'
export interface UpdateIdentity {
  version: string
  channel: UpdateChannel
  edition: 'Full' | 'Lite'
  kind: 'installer' | 'portable'
}
export interface UpdateCandidate {
  version: string
  mode: 'optional' | 'recommended' | 'required' | 'urgent'
  required: boolean
  message: string
}
export interface UpdateSnapshot {
  transfer?: UpdateTransferSnapshot
  revision: number
  status: 'idle' | 'checking' | 'available' | 'upToDate' | 'unavailable'
  currentVersion: string
  candidate: UpdateCandidate | null
  bubbleVisible: boolean
  requiredPrompt: 'hidden' | 'visible' | 'closing' | 'protecting'
}
export type UpdateEventType = 'update_check' | 'update_opened' | 'website_opened'
export interface UpdateVersion { numbers: string[]; prerelease: string[] }

export function parseUpdateVersion(value: unknown): UpdateVersion | undefined {
  if (typeof value !== 'string' || value.length > 48) return undefined
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)$/.exec(value)
  // Build metadata is optional, while each metadata identifier must be nonempty.
  const parsed = match ?? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value)
  if (!parsed) return undefined
  const prerelease = parsed[4]?.split('.') ?? []
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return undefined
  return { numbers: parsed.slice(1, 4), prerelease }
}

function decimalOrder(a: string, b: string): -1 | 0 | 1 {
  return a.length !== b.length ? (a.length < b.length ? -1 : 1) : a === b ? 0 : a < b ? -1 : 1
}
export function compareUpdateVersions(a: string, b: string): -1 | 0 | 1 | undefined {
  const left = parseUpdateVersion(a), right = parseUpdateVersion(b)
  if (!left || !right) return undefined
  for (let i = 0; i < 3; i++) { const order = decimalOrder(left.numbers[i], right.numbers[i]); if (order) return order }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1
  }
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const x = left.prerelease[i], y = right.prerelease[i]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (x === y) continue
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
    return nx && ny ? decimalOrder(x, y) : nx !== ny ? (nx ? -1 : 1) : x < y ? -1 : 1
  }
  return 0
}

export const isUpdateUuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
