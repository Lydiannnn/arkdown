import { isPublicErrorCode, type PublicErrorCode } from './public-errors'
import { isWindowsAbsolutePath } from './local-resource-path'

export type DocumentConversionFormat = 'pdf' | 'pptx' | 'xlsx' | 'epub'
export type DocumentConversionComponentSource = 'packaged' | 'https'
export type DocumentConversionComponentStatus =
  | 'absent'
  | 'installing'
  | 'installed'
  | 'update-available'
  | 'failed'

export interface ComponentInstallProgress {
  phase: 'reading' | 'downloading' | 'verifying' | 'extracting'
  receivedBytes: number
  totalBytes: number
}

export interface DocumentConversionComponentState {
  revision: number
  source: DocumentConversionComponentSource
  status: DocumentConversionComponentStatus
  installedVersion: string | null
  availableVersion: string
  progress: ComponentInstallProgress | null
  errorCode: PublicErrorCode | null
  busy: boolean
  bundled?: boolean
}

export interface DocumentConversionComponentDescriptor {
  source: DocumentConversionComponentSource
  version: string
  archiveName: string
  bytes: number
  sha256: string
  url: string | null
}

export interface ConvertedDocument {
  source: {
    absolutePath: string
    fileName: string
    format: DocumentConversionFormat
    bytes: number
    modifiedAtMs: number
  }
  markdown: string
  converterVersion: string
  fingerprint: string
  warnings: readonly string[]
}

export const MAX_DOCUMENT_CONVERSION_INPUT_BYTES = 256 * 1024 * 1024
export const MAX_DOCUMENT_CONVERSION_OUTPUT_BYTES = 32 * 1024 * 1024

const FORMATS = new Set<DocumentConversionFormat>(['pdf', 'pptx', 'xlsx', 'epub'])
const COMPONENT_SOURCES = new Set<DocumentConversionComponentSource>(['packaged', 'https'])
const COMPONENT_STATUSES = new Set<DocumentConversionComponentStatus>([
  'absent',
  'installing',
  'installed',
  'update-available',
  'failed',
])
const INSTALL_PHASES = new Set<ComponentInstallProgress['phase']>([
  'reading',
  'downloading',
  'verifying',
  'extracting',
])
const LOWERCASE_SHA256_PATTERN = /^[0-9a-f]{64}$/
const COMPONENT_VERSION_PATTERN = /^[0-9A-Za-z](?:[0-9A-Za-z._-]{0,127})$/

function isExactOwnRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function windowsBaseName(absolutePath: string): string {
  const segments = absolutePath.split(/[\\/]/)
  return segments[segments.length - 1] ?? ''
}

function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) return ''
  return fileName.slice(dot + 1).toLocaleLowerCase('en-US')
}

function parseExactStringArray(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (lengthDescriptor === undefined || typeof lengthDescriptor.value !== 'number') return undefined
    const length = lengthDescriptor.value
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== length + 1 || !ownKeys.includes('length')) return undefined

    const result: string[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (
        descriptor === undefined
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || typeof descriptor.value !== 'string'
      ) return undefined
      result.push(descriptor.value)
    }
    return result
  } catch {
    return undefined
  }
}

function isComponentVersion(value: unknown): value is string {
  return typeof value === 'string' && COMPONENT_VERSION_PATTERN.test(value)
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function parseInstallProgress(value: unknown): ComponentInstallProgress | undefined {
  if (!isExactOwnRecord(value, ['phase', 'receivedBytes', 'totalBytes'])) return undefined
  if (
    typeof value.phase !== 'string'
    || !INSTALL_PHASES.has(value.phase as ComponentInstallProgress['phase'])
    || !isSafeNonNegativeInteger(value.receivedBytes)
    || !isSafeNonNegativeInteger(value.totalBytes)
    || value.totalBytes === 0
    || value.receivedBytes > value.totalBytes
  ) return undefined
  return {
    phase: value.phase as ComponentInstallProgress['phase'],
    receivedBytes: value.receivedBytes,
    totalBytes: value.totalBytes,
  }
}

export function parseDocumentConversionComponentDescriptor(
  value: unknown,
): DocumentConversionComponentDescriptor | undefined {
  if (!isExactOwnRecord(value, [
    'source', 'version', 'archiveName', 'bytes', 'sha256', 'url',
  ])) return undefined
  if (
    typeof value.source !== 'string'
    || !COMPONENT_SOURCES.has(value.source as DocumentConversionComponentSource)
    || !isComponentVersion(value.version)
    || typeof value.archiveName !== 'string'
    || value.archiveName.length === 0
    || value.archiveName.includes('/')
    || value.archiveName.includes('\\')
    || !isSafeNonNegativeInteger(value.bytes)
    || value.bytes === 0
    || typeof value.sha256 !== 'string'
    || !LOWERCASE_SHA256_PATTERN.test(value.sha256)
  ) return undefined

  const source = value.source as DocumentConversionComponentSource
  if (source === 'packaged' ? value.url !== null : typeof value.url !== 'string' || !isHttpsUrl(value.url)) {
    return undefined
  }

  return {
    source,
    version: value.version,
    archiveName: value.archiveName,
    bytes: value.bytes,
    sha256: value.sha256,
    url: value.url as string | null,
  }
}

export function parseDocumentConversionComponentState(
  value: unknown,
): DocumentConversionComponentState | undefined {
  if (!isExactOwnRecord(value, [
    'revision', 'source', 'status', 'installedVersion', 'availableVersion', 'progress', 'errorCode',
    'busy', ...(typeof value === 'object' && value !== null && Object.hasOwn(value, 'bundled') ? ['bundled'] : []),
  ])) return undefined
  if (
    !isSafeNonNegativeInteger(value.revision)
    || typeof value.source !== 'string'
    || !COMPONENT_SOURCES.has(value.source as DocumentConversionComponentSource)
    || typeof value.status !== 'string'
    || !COMPONENT_STATUSES.has(value.status as DocumentConversionComponentStatus)
    || !(value.installedVersion === null || isComponentVersion(value.installedVersion))
    || !isComponentVersion(value.availableVersion)
    || !(value.progress === null || parseInstallProgress(value.progress) !== undefined)
    || !(value.errorCode === null || isPublicErrorCode(value.errorCode))
    || typeof value.busy !== 'boolean'
    || (Object.hasOwn(value, 'bundled') && typeof value.bundled !== 'boolean')
  ) return undefined

  const status = value.status as DocumentConversionComponentStatus
  const installedVersion = value.installedVersion as string | null
  const progress = value.progress === null ? null : parseInstallProgress(value.progress)!
  const errorCode = value.errorCode as PublicErrorCode | null
  if (status === 'absent') {
    if (installedVersion !== null || progress !== null || errorCode !== null || value.busy) return undefined
  } else if (status === 'installing') {
    if (progress === null || errorCode !== null || !value.busy) return undefined
  } else if (status === 'installed') {
    if (installedVersion !== value.availableVersion || progress !== null || errorCode !== null) return undefined
  } else if (status === 'update-available') {
    if (installedVersion === null || installedVersion === value.availableVersion || progress !== null || errorCode !== null) return undefined
  } else if (progress !== null || errorCode === null || value.busy) {
    return undefined
  }

  return {
    revision: value.revision,
    source: value.source as DocumentConversionComponentSource,
    status,
    installedVersion,
    availableVersion: value.availableVersion,
    progress,
    errorCode,
    busy: value.busy,
    ...(typeof value.bundled === 'boolean' ? { bundled: value.bundled } : {}),
  }
}

export function parseConvertedDocument(value: unknown): ConvertedDocument | undefined {
  if (!isExactOwnRecord(value, [
    'source', 'markdown', 'converterVersion', 'fingerprint', 'warnings',
  ])) return undefined
  if (!isExactOwnRecord(value.source, [
    'absolutePath', 'fileName', 'format', 'bytes', 'modifiedAtMs',
  ])) return undefined
  const absolutePath = value.source.absolutePath
  const fileName = value.source.fileName
  const format = value.source.format
  const warnings = parseExactStringArray(value.warnings)
  if (
    !isWindowsAbsolutePath(absolutePath)
    || typeof fileName !== 'string'
    || fileName.length === 0
    || typeof format !== 'string'
    || !FORMATS.has(format as DocumentConversionFormat)
    || windowsBaseName(absolutePath) !== fileName
    || fileExtension(fileName) !== format
    || !isSafeNonNegativeInteger(value.source.bytes)
    || value.source.bytes > MAX_DOCUMENT_CONVERSION_INPUT_BYTES
    || !isSafeNonNegativeInteger(value.source.modifiedAtMs)
    || typeof value.markdown !== 'string'
    || new TextEncoder().encode(value.markdown).byteLength > MAX_DOCUMENT_CONVERSION_OUTPUT_BYTES
    || !isComponentVersion(value.converterVersion)
    || typeof value.fingerprint !== 'string'
    || !LOWERCASE_SHA256_PATTERN.test(value.fingerprint)
    || warnings === undefined
  ) return undefined

  return {
    source: {
      absolutePath,
      fileName,
      format: format as DocumentConversionFormat,
      bytes: value.source.bytes,
      modifiedAtMs: value.source.modifiedAtMs,
    },
    markdown: value.markdown,
    converterVersion: value.converterVersion,
    fingerprint: value.fingerprint,
    warnings,
  }
}

export function documentConversionTimeoutMs(format: DocumentConversionFormat): number {
  return format === 'xlsx' ? 300_000 : 120_000
}
