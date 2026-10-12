import { APP_UPDATE_WEBSITE, compareUpdateVersions, parseUpdateVersion, type UpdateCandidate, type UpdateIdentity } from '../../shared/app-update'

export interface UpdateArtifact extends UpdateIdentity {
  filename: string
  url: string
  bytes: number
  sha256: string
}
export interface UpdateDecision { candidate: UpdateCandidate | null; artifact?: UpdateArtifact }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const date = (value: unknown): boolean => typeof value === 'string' && value.length <= 40
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))

/** Only initial URLs authenticated by the fixed update service. Redirects have a separate policy. */
export function isUpdateArtifactUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false
    if (url.hostname === 'download.cotax.tech') return true
    return url.hostname === 'github.com' && /^\/Lydiannnn\/arkdown-releases\/releases\/download\/[^/]+\/[^/]+$/i.test(url.pathname)
  } catch { return false }
}
function validPackage(value: unknown): value is Record<string, unknown> {
  if (!record(value) || !['Full', 'Lite'].includes(value.edition as string)
    || !['installer', 'portable'].includes(value.kind as string) || !text(value.filename, 300) || !value.filename
    || /[<>:"/\\|?*\x00-\x1f]/.test(value.filename) || /[. ]$/.test(value.filename)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value.filename)
    || !(value.kind === 'portable' ? /\.zip$/i : /\.exe$/i).test(value.filename)
    || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 32 * 1024 ** 3
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) || !text(value.url, 4096)) return false
  return isUpdateArtifactUrl(value.url)
}

export function parseUpdateDecision(value: unknown, identity: UpdateIdentity): UpdateDecision | undefined {
  const installed = parseUpdateVersion(identity.version)
  if (!installed || (identity.channel === 'stable' && installed.prerelease.length)) return undefined
  if (!record(value) || value.schemaVersion !== 1 || typeof value.available !== 'boolean'
    || typeof value.required !== 'boolean' || value.channel !== identity.channel
    || !['optional', 'recommended', 'required', 'urgent'].includes(value.mode as string)
    || !text(value.message, 4096) || value.websiteUrl !== APP_UPDATE_WEBSITE
    || !(value.deadline === null || date(value.deadline))) return undefined
  const version = value.version === null ? null : parseUpdateVersion(value.version)
  if (version === undefined || (identity.channel === 'stable' && version?.prerelease.length)) return undefined
  if (!value.available) {
    if (value.release !== null || value.required || !['no_release', 'up_to_date', 'rollout_excluded'].includes(value.reason as string)) return undefined
    return { candidate: null }
  }
  if (!version || compareUpdateVersions(value.version as string, identity.version) !== 1
    || !['update_available', 'rollout_fallback'].includes(value.reason as string)) return undefined
  // A contradictory policy is invalid, never a source of additional exit authority.
  if (value.required && (value.mode === 'optional' || value.mode === 'recommended')) return undefined
  const release = value.release
  if (!record(release) || release.schemaVersion !== 1 || release.product !== 'Arkdown'
    || release.version !== value.version || release.channel !== identity.channel || release.websiteUrl !== APP_UPDATE_WEBSITE
    || release.platform !== 'Windows x64' || !date(release.publishedAt)
    || !text(release.title, 1000) || !text(release.notes, 100_000)
    || !validPackage(release) || release.edition !== identity.edition || release.kind !== identity.kind
    || !Array.isArray(release.packages) || release.packages.length !== 4 || !release.packages.every(validPackage)) return undefined
  const pairs = new Set(release.packages.map(item => `${item.edition}:${item.kind}`))
  if (pairs.size !== 4 || !release.packages.some(item => ['kind', 'edition', 'filename', 'bytes', 'sha256', 'url']
    .every(key => item[key] === release[key]))) return undefined
  return { candidate: { version: value.version as string, mode: value.mode as UpdateCandidate['mode'],
    required: value.required, message: value.message }, artifact: {
      version: value.version as string, channel: identity.channel, edition: identity.edition, kind: identity.kind,
      filename: release.filename as string, url: release.url as string, bytes: release.bytes as number, sha256: release.sha256 as string,
    } }
}
