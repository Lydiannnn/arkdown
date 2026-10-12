import type { ApiResult } from './contracts'
import { isWindowsAbsolutePath } from './local-resource-path'
import { parseDocumentViewLink, parseLocalFileLink } from './document-view-link'

export const DOCUMENT_VIEW_ERROR_MESSAGES = Object.freeze({
  DOCUMENT_VIEW_NO_SOURCE: '请先保存当前文档，再查看相对链接。',
  DOCUMENT_VIEW_INVALID_LINK: '此链接不是可查看的相对文件路径。',
  DOCUMENT_VIEW_STALE: '文档查看会话已失效，请重新打开链接。',
  DOCUMENT_VIEW_NOT_FOUND: '找不到链接指向的文件或文件夹。',
  DOCUMENT_VIEW_TOO_LARGE: '文件超过文档查看的 8 MiB 大小限制。',
  DOCUMENT_VIEW_BINARY: '此文件包含二进制内容，无法作为文本文档查看。',
  DOCUMENT_VIEW_ENCODING: '此文件不是有效的 UTF-8 文本，无法查看。',
  DOCUMENT_VIEW_UNSUPPORTED: '此文件类型或文件状态不支持文档查看。',
  DOCUMENT_VIEW_CHANGED: '文件在读取期间发生变化，请重试。',
  DOCUMENT_VIEW_READ_FAILED: '无法读取此文件，请检查文件访问权限。',
} as const)

/** Owned by the main-process document session; never accepted from IPC callers. */
export interface DocumentViewSource {
  absolutePath: string
  session: number
}

export interface DocumentViewLocation {
  anchor?: string
  line?: number
}

/** Main-to-renderer intent; contains no document text and never authorizes a read. */
export interface DocumentLocationIntent extends DocumentViewLocation {
  absolutePath: string
}

export interface DocumentViewSnapshot {
  id: string
  /** Canonical filesystem path; relative child links resolve from this directory. */
  absolutePath: string
  displayName: string
  text: string
  kind: 'markdown' | 'text' | 'code'
  revision: string
  line?: number
  anchor?: string
}

export type DocumentViewResult =
  | { kind: 'document'; document: DocumentViewSnapshot }
  | { kind: 'directory'; id: string; absolutePath: string; displayName: string }
  | { kind: 'external-file'; id: string; absolutePath: string; displayName: string }

export interface DocumentViewRequest {
  href: string
  sourceId?: string
  /** Bounded visible ancestor tokens to retain during this navigation; never grants path access. */
  activeIds?: string[]
}

export const DOCUMENT_VIEW_MAX_ACTIVE_IDS = 32

export interface LocalFileRevealRequest {
  href: string
  sourceId?: string
}

export function parseLocalFileRevealRequest(value: unknown): LocalFileRevealRequest | undefined {
  const item = record(value, ['href'], ['sourceId'])
  if (!item || !parseLocalFileLink(item.href)) return undefined
  if (Object.hasOwn(item, 'sourceId') && !parseDocumentViewId(item.sourceId)) return undefined
  return { href: item.href as string, ...(typeof item.sourceId === 'string' ? { sourceId: item.sourceId } : {}) }
}

export interface DocumentViewApi {
  navigateDocumentView(input: DocumentViewRequest): Promise<ApiResult<DocumentViewResult>>
  /** Returns a new snapshot token; the old token keeps its original accepted revision. */
  refreshDocumentView(id: string): Promise<ApiResult<DocumentViewSnapshot>>
  inspectDocumentView(id: string): Promise<ApiResult<{ changed: boolean; exists: boolean }>>
  openDocumentView(id: string): Promise<ApiResult<null>>
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const result: Record<string, unknown> = {}
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) return undefined
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return undefined
      result[key] = descriptor.value
    }
    return required.every(key => Object.hasOwn(result, key)) ? result : undefined
  } catch { return undefined }
}

export function parseDocumentLocationIntent(value: unknown): DocumentLocationIntent | undefined {
  const item = record(value, ['absolutePath'], ['anchor', 'line'])
  if (!item || !isWindowsAbsolutePath(item.absolutePath)
    || (item.anchor === undefined && item.line === undefined)
    || (Object.hasOwn(item, 'line') && (typeof item.line !== 'number' || !Number.isSafeInteger(item.line) || item.line < 1))
    || (Object.hasOwn(item, 'anchor') && (typeof item.anchor !== 'string' || !item.anchor || item.anchor.length > 32_767 || /[\u0000-\u001f\u007f]/.test(item.anchor)))) return undefined
  return item as unknown as DocumentLocationIntent
}

export function parseDocumentViewId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : undefined
}

export function parseDocumentViewRequest(value: unknown): DocumentViewRequest | undefined {
  const item = record(value, ['href'], ['sourceId', 'activeIds'])
  if (!item || typeof item.href !== 'string' || parseDocumentViewLink(item.href)?.kind !== 'relative') return undefined
  if (Object.hasOwn(item, 'sourceId') && !parseDocumentViewId(item.sourceId)) return undefined
  let activeIds: string[] | undefined
  if (Object.hasOwn(item, 'activeIds')) {
    try {
      if (!Array.isArray(item.activeIds) || item.activeIds.length > DOCUMENT_VIEW_MAX_ACTIVE_IDS
        || Reflect.ownKeys(item.activeIds).length !== item.activeIds.length + 1) return undefined
      activeIds = []
      for (let index = 0; index < item.activeIds.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item.activeIds, String(index))
        const id = descriptor && Object.hasOwn(descriptor, 'value') ? parseDocumentViewId(descriptor.value) : undefined
        if (!id || activeIds.includes(id)) return undefined
        activeIds.push(id)
      }
    } catch { return undefined }
  }
  return { href: item.href, ...(typeof item.sourceId === 'string' ? { sourceId: item.sourceId } : {}), ...(activeIds ? { activeIds } : {}) }
}

function validLocation(item: Record<string, unknown>): boolean {
  return !!parseDocumentViewId(item.id) && isWindowsAbsolutePath(item.absolutePath)
    && typeof item.displayName === 'string' && item.displayName.length > 0 && item.displayName.length <= 32_767
}

export function parseDocumentViewSnapshot(value: unknown): DocumentViewSnapshot | undefined {
  const item = record(value, ['id', 'absolutePath', 'displayName', 'text', 'kind', 'revision'], ['line', 'anchor'])
  if (!item || !validLocation(item) || typeof item.text !== 'string' || item.text.length > 8 * 1024 * 1024
    || !['markdown', 'text', 'code'].includes(item.kind as string)
    || typeof item.revision !== 'string' || !/^[0-9a-f]{64}$/.test(item.revision)
    || (Object.hasOwn(item, 'line') && (typeof item.line !== 'number' || !Number.isSafeInteger(item.line) || item.line < 1))
    || (Object.hasOwn(item, 'anchor') && (typeof item.anchor !== 'string' || item.anchor.length > 32_767))) return undefined
  return item as unknown as DocumentViewSnapshot
}

export function parseDocumentViewResult(value: unknown): DocumentViewResult | undefined {
  const item = record(value, ['kind'], ['document', 'id', 'absolutePath', 'displayName'])
  if (!item) return undefined
  if (item.kind === 'document') {
    if (Object.keys(item).length !== 2) return undefined
    const document = parseDocumentViewSnapshot(item.document)
    return document ? { kind: 'document', document } : undefined
  }
  if ((item.kind === 'directory' || item.kind === 'external-file') && Object.keys(item).length === 4 && validLocation(item)) {
    return item as unknown as DocumentViewResult
  }
  return undefined
}

export function parseDocumentViewInspection(value: unknown): { changed: boolean; exists: boolean } | undefined {
  const item = record(value, ['changed', 'exists'])
  return item && typeof item.changed === 'boolean' && typeof item.exists === 'boolean'
    ? { changed: item.changed, exists: item.exists } : undefined
}
