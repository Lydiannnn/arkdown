import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import path from 'node:path'
import type { DocumentViewLocation, DocumentViewRequest, DocumentViewResult, DocumentViewSnapshot, DocumentViewSource, LocalFileRevealRequest } from '../../shared/document-view'
import { DOCUMENT_VIEW_ERROR_MESSAGES as messages, parseDocumentViewRequest } from '../../shared/document-view'
import { parseDocumentViewLink, parseLocalFileLink } from '../../shared/document-view-link'
import { appError } from '../../shared/public-errors'
import { documentTextKindForPath } from '../../shared/document-types'

export const DOCUMENT_VIEW_MAX_BYTES = 8 * 1024 * 1024
const MAX_TOKENS = 128
const safeAttachments = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg', '.pdf', '.docx', '.xlsx', '.pptx', '.epub', '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.mp4', '.webm', '.ogv', '.mov', '.m4v'])
export type DocumentViewErrorCode = keyof typeof messages
export class DocumentViewError extends Error {
  constructor(readonly code: DocumentViewErrorCode) {
    super(messages[code])
    this.name = 'DocumentViewError'
  }
}
function fail(code: DocumentViewErrorCode): never { throw new DocumentViewError(code) }
function convertError(error: unknown): never {
  if (error instanceof DocumentViewError) throw error
  const code = (error as NodeJS.ErrnoException)?.code
  fail(code === 'ENOENT' || code === 'ENOTDIR' ? 'DOCUMENT_VIEW_NOT_FOUND' : 'DOCUMENT_VIEW_READ_FAILED')
}
function sameStats(a: Stats, b: Stats) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}
function fingerprint(stats: Stats) {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`
}
type Entry = {
  id: string
  absolutePath: string
  category: DocumentViewResult['kind']
  revision: string
  refreshSequence: number
  line?: number
  anchor?: string
}

export function createDocumentViewService(options: {
  getSource: () => DocumentViewSource | null
  openDocument: (path: string, location?: DocumentViewLocation) => Promise<void>
  openExternalPath: (path: string) => Promise<void>
  revealPath?: (path: string) => void
}) {
  const entries = new Map<string, Entry>()
  let owner: DocumentViewSource | null = null
  let generation = 0
  let navigationSequence = 0
  let retainedIds = new Set<string>()
  function clear() { entries.clear(); retainedIds.clear(); owner = null; generation++ }
  function source() {
    const current = options.getSource()
    if (!current || !path.isAbsolute(current.absolutePath) || !Number.isSafeInteger(current.session)) {
      clear()
      return fail('DOCUMENT_VIEW_NO_SOURCE')
    }
    if (owner?.absolutePath !== current.absolutePath || owner.session !== current.session) {
      clear()
      owner = { ...current }
    }
    const captured = { ...current }
    const epoch = generation
    return {
      value: captured,
      assert() {
        const latest = options.getSource()
        if (generation !== epoch || latest?.absolutePath !== captured.absolutePath || latest.session !== captured.session) {
          fail('DOCUMENT_VIEW_STALE')
        }
      },
    }
  }
  type Context = ReturnType<typeof source>
  function entry(id: string) {
    const found = typeof id === 'string' ? entries.get(id) : undefined
    if (!found) return fail('DOCUMENT_VIEW_STALE')
    // Keep actively used breadcrumbs alive; the least recently used token is evicted.
    entries.delete(id)
    entries.set(id, found)
    return found
  }
  function assertEntry(context: Context, item: Entry) {
    context.assert()
    if (entries.get(item.id) !== item) fail('DOCUMENT_VIEW_STALE')
  }
  function remember(item: Entry, additionallyRetained: readonly string[] = []) {
    entries.set(item.id, item)
    if (entries.size <= MAX_TOKENS) return
    const retained = new Set([...retainedIds, ...additionallyRetained, item.id])
    const oldest = [...entries.keys()].find(id => !retained.has(id))
    if (oldest) entries.delete(oldest)
  }
  async function metadata(absolutePath: string, context: Pick<Context, 'assert'>) {
    try {
      const stats = await lstat(absolutePath)
      context.assert()
      if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) fail('DOCUMENT_VIEW_UNSUPPORTED')
      const canonical = await realpath(absolutePath)
      context.assert()
      const canonicalStats = await lstat(canonical)
      context.assert()
      if (!sameStats(stats, canonicalStats)) fail('DOCUMENT_VIEW_CHANGED')
      return { stats, canonical }
    } catch (error) { context.assert(); return convertError(error) }
  }
  function category(absolutePath: string, canonical: string, stats: Stats): DocumentViewResult['kind'] {
    if (stats.isDirectory()) return 'directory'
    const textKind = documentTextKindForPath(absolutePath)
    if (textKind && documentTextKindForPath(canonical) === textKind) return 'document'
    if (safeAttachments.has(path.extname(absolutePath).toLowerCase()) && safeAttachments.has(path.extname(canonical).toLowerCase())) return 'external-file'
    return fail('DOCUMENT_VIEW_UNSUPPORTED')
  }
  async function readBytes(absolutePath: string, context: Context) {
    let handle: FileHandle | undefined
    try {
      const before = await metadata(absolutePath, context)
      if (!before.stats.isFile()) fail('DOCUMENT_VIEW_UNSUPPORTED')
      if (before.stats.size > DOCUMENT_VIEW_MAX_BYTES) fail('DOCUMENT_VIEW_TOO_LARGE')
      handle = await open(absolutePath, 'r')
      context.assert()
      const opened = await handle.stat()
      context.assert()
      if (!sameStats(before.stats, opened)) fail('DOCUMENT_VIEW_CHANGED')
      const chunks: Buffer[] = []
      let total = 0
      while (true) {
        // Read at most one byte over the bound, even if the file grows after stat.
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, DOCUMENT_VIEW_MAX_BYTES + 1 - total))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, total)
        context.assert()
        if (!bytesRead) break
        total += bytesRead
        if (total > DOCUMENT_VIEW_MAX_BYTES) fail('DOCUMENT_VIEW_TOO_LARGE')
        chunks.push(buffer.subarray(0, bytesRead))
      }
      const after = await handle.stat()
      context.assert()
      const current = await metadata(absolutePath, context)
      if (!sameStats(opened, after) || !sameStats(after, current.stats) || before.canonical !== current.canonical) fail('DOCUMENT_VIEW_CHANGED')
      return Buffer.concat(chunks, total)
    } catch (error) { context.assert(); return convertError(error) }
    finally { await handle?.close() }
  }
  async function snapshot(item: Entry, context: Context): Promise<DocumentViewSnapshot> {
    const bytes = await readBytes(item.absolutePath, context)
    context.assert()
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { return fail('DOCUMENT_VIEW_ENCODING') }
    if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) fail('DOCUMENT_VIEW_BINARY')
    const kind = documentTextKindForPath(item.absolutePath)
    if (!kind) return fail('DOCUMENT_VIEW_UNSUPPORTED')
    return {
      id: item.id, absolutePath: item.absolutePath, displayName: path.basename(item.absolutePath),
      text, kind, revision: createHash('sha256').update(bytes).digest('hex'),
      ...(item.line !== undefined ? { line: item.line } : {}), ...(item.anchor ? { anchor: item.anchor } : {}),
    }
  }
  return {
    async revealLink(input: LocalFileRevealRequest): Promise<void> {
      try {
        const link = parseLocalFileLink(input.href)
        if (!link) throw appError('INVALID_INPUT')
        const context = link.kind === 'relative' || input.sourceId ? source() : undefined
        const sourceEntry = input.sourceId ? entry(input.sourceId) : undefined
        if (sourceEntry && sourceEntry.category !== 'document') fail('DOCUMENT_VIEW_UNSUPPORTED')
        const base = sourceEntry?.absolutePath ?? context?.value.absolutePath
        const requested = link.kind === 'absolute' ? link.path
          : path.resolve(path.dirname(base!), link.path.replace(/[\\/]/g, path.sep))
        // Revealing checks existence only; binary/large files are valid targets too.
        const target = await metadata(requested, context ?? { assert() {} })
        if (context && sourceEntry) assertEntry(context, sourceEntry)
        if (!options.revealPath) throw appError('OPERATION_FAILED')
        options.revealPath(target.canonical)
      } catch (error) {
        if (error instanceof DocumentViewError
          && (error.code === 'DOCUMENT_VIEW_NOT_FOUND' || error.code === 'DOCUMENT_VIEW_NO_SOURCE')) {
          throw appError('LOCAL_FILE_NOT_FOUND')
        }
        throw error
      }
    },
    async navigate(input: DocumentViewRequest): Promise<DocumentViewResult> {
      const context = source()
      const request = parseDocumentViewRequest(input)
      if (!request) return fail('DOCUMENT_VIEW_INVALID_LINK')
      const sequence = ++navigationSequence
      const link = parseDocumentViewLink(request.href)
      if (!link || link.kind !== 'relative') return fail('DOCUMENT_VIEW_INVALID_LINK')
      const active = (request.activeIds ?? []).map(id => entry(id))
      const sourceEntry = request.sourceId !== undefined ? entry(request.sourceId) : undefined
      if (sourceEntry && sourceEntry.category !== 'document') fail('DOCUMENT_VIEW_UNSUPPORTED')
      const base = sourceEntry?.absolutePath ?? context.value.absolutePath
      const requestedPath = path.resolve(path.dirname(base), link.path.replace(/[\\/]/g, path.sep))
      const target = await metadata(requestedPath, context)
      // Tokens and downstream relative navigation follow the physical document's
      // directory. The original href remains caller-owned and is never rewritten.
      const absolutePath = target.canonical
      const targetCategory = category(requestedPath, absolutePath, target.stats)
      const item: Entry = {
        // A navigation gets its own accepted revision. Ignoring its response must
        // not silently advance the revision of an older snapshot still on screen.
        id: randomUUID(), absolutePath, category: targetCategory,
        revision: fingerprint(target.stats), refreshSequence: 0, ...('line' in link ? { line: link.line } : {}),
        ...('anchor' in link ? { anchor: link.anchor } : {}),
      }
      const result: DocumentViewResult = item.category === 'document'
        ? { kind: 'document', document: await snapshot(item, context) }
        : { kind: item.category, id: item.id, absolutePath, displayName: path.basename(absolutePath) || absolutePath }
      context.assert()
      if (sequence !== navigationSequence) fail('DOCUMENT_VIEW_STALE')
      for (const ancestor of active) assertEntry(context, ancestor)
      if (sourceEntry) assertEntry(context, sourceEntry)
      if (result.kind === 'document') item.revision = result.document.revision
      for (const ancestor of active) entry(ancestor.id)
      // Keep the last reported visible branch across refresh-only activity too.
      // This remains bounded by activeIds (32), source, and the returned target.
      retainedIds = new Set([...active.map(ancestor => ancestor.id), ...(sourceEntry ? [sourceEntry.id] : []), item.id])
      remember(item)
      return result
    },
    async refresh(id: string): Promise<DocumentViewSnapshot> {
      const context = source()
      const item = entry(id)
      if (item.category !== 'document') return fail('DOCUMENT_VIEW_UNSUPPORTED')
      const sequence = ++item.refreshSequence
      const successor = { ...item, id: randomUUID(), refreshSequence: 0 }
      const result = await snapshot(successor, context)
      assertEntry(context, item)
      if (sequence !== item.refreshSequence) fail('DOCUMENT_VIEW_STALE')
      // The renderer can ignore an otherwise successful refresh. Preserve the
      // original token's accepted revision until its snapshot is actually replaced.
      successor.revision = result.revision
      remember(successor, [item.id])
      return result
    },
    async inspect(id: string): Promise<{ changed: boolean; exists: boolean }> {
      const context = source()
      const item = entry(id)
      try {
        const current = await metadata(item.absolutePath, context)
        const currentCategory = category(item.absolutePath, current.canonical, current.stats)
        if (currentCategory !== item.category) return { changed: true, exists: true }
        const revision = item.category === 'document'
          ? createHash('sha256').update(await readBytes(item.absolutePath, context)).digest('hex')
          : fingerprint(current.stats)
        assertEntry(context, item)
        return { changed: revision !== item.revision, exists: true }
      } catch (error) {
        assertEntry(context, item)
        if (error instanceof DocumentViewError && error.code === 'DOCUMENT_VIEW_NOT_FOUND') return { changed: true, exists: false }
        throw error
      }
    },
    async open(id: string): Promise<void> {
      const context = source()
      const item = entry(id)
      const target = await metadata(item.absolutePath, context)
      if (category(item.absolutePath, target.canonical, target.stats) !== item.category) fail('DOCUMENT_VIEW_UNSUPPORTED')
      // Text/code files must always use Arkdown's document opener, never OS execution.
      if (item.category === 'document') await snapshot(item, context)
      assertEntry(context, item)
      if (item.category === 'document') {
        if (item.anchor || item.line) await options.openDocument(item.absolutePath, {
          ...(item.anchor ? { anchor: item.anchor } : {}), ...(item.line ? { line: item.line } : {}),
        })
        else await options.openDocument(item.absolutePath)
      }
      else await options.openExternalPath(item.absolutePath)
      context.assert()
    },
    clear,
  }
}
