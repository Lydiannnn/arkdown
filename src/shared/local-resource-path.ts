import { documentTypeForPath, type DocumentCategory } from './document-types'

export const EXTERNAL_ASSET_HOST = 'external'

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/
const WINDOWS_UNC_PATH = /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/

export function isWindowsAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= 32_767
    && (WINDOWS_DRIVE_PATH.test(value) || WINDOWS_UNC_PATH.test(value))
  )
}

export function externalAssetUrl(absolutePath: string): string {
  if (!isWindowsAbsolutePath(absolutePath)) throw new Error('Invalid Windows path')
  return `arkdown-asset://${EXTERNAL_ASSET_HOST}/${encodeURIComponent(absolutePath)}`
}

export function externalAssetPathFromUrl(value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (
    parsed.protocol !== 'arkdown-asset:'
    || parsed.hostname !== EXTERNAL_ASSET_HOST
    || parsed.search
    || parsed.hash
  ) return null
  try {
    const result = decodeURIComponent(parsed.pathname.slice(1))
    return isWindowsAbsolutePath(result) ? result : null
  } catch {
    return null
  }
}

export function localResourceCategory(
  value: unknown,
): DocumentCategory | null {
  return isWindowsAbsolutePath(value)
    ? (documentTypeForPath(value)?.category ?? null)
    : null
}

export function isPreviewableLocalResource(value: unknown): value is string {
  const category = localResourceCategory(value)
  return category === 'image' || category === 'audio' || category === 'video'
}

export function isLocalAttachmentPath(value: unknown): value is string {
  const category = localResourceCategory(value)
  return category === 'pdf' || category === 'attachment'
}
