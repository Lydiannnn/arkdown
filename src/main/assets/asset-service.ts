import { copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes } from 'mdast'
import { draftPaths, isClipboardAssetName } from '../drafts/draft-paths'
import { collectReferences, resolveLocalReference } from '../sticky-notes/sticky-note-resource-rewriter'
import { documentTypeForPath } from '../../shared/document-types'
import { appError } from '../../shared/public-errors'
import type { WorkspaceService } from '../workspace/workspace-service'
import type { ImportedAsset } from '../../shared/contracts'
import type { AssetAccessRegistry } from './asset-path'

interface ClipboardImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  toPNG(): Buffer
}

// Check each existing ancestor before creation; neither managed storage nor a
// document's assets directory may redirect writes through a junction/symlink.
async function safeDirectory(directory: string): Promise<void> {
  const parent = path.dirname(directory)
  if (parent !== directory) await safeDirectory(parent)
  let metadata = await lstat(directory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!metadata) {
    await mkdir(directory)
    metadata = await lstat(directory)
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw appError('INVALID_INPUT')
}

function html(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function markdownLabel(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
}

function codeRanges(markdown: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const visit = (node: Nodes): void => {
    if (node.type === 'code' || node.type === 'inlineCode') {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start !== undefined && end !== undefined) ranges.push({ start, end })
    } else if ('children' in node) node.children.forEach(visit)
  }
  visit(fromMarkdown(markdown))
  return ranges
}

function markdownFor(
  category: ImportedAsset['category'],
  source: string,
): string {
  const fileName = path.basename(source)
  const label = markdownLabel(fileName)
  if (category === 'image') {
    const alt = path.basename(source, path.extname(source))
    return `<img src="${html(source)}" alt="${html(alt)}" style="zoom:100%;" />`
  }
  if (category === 'audio') return `<audio src="${html(source)}"></audio>`
  if (category === 'video') {
    return `<video src="${html(source)}" controls=""></video>`
  }
  return `[${label}](<${source}>)`
}

export class AssetService {
  constructor(private readonly options: {
    workspace: WorkspaceService
    tempRoot: string
    sessionId: string
    access: AssetAccessRegistry
    readClipboardImage?: () => ClipboardImage
  }) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.sessionId)) {
      throw new Error('Invalid asset session id')
    }
  }

  async allowWorkspaceRoot(): Promise<void> {
    // Source-linked resources never grant access to a whole workspace.
  }

  async import(sourceAbsolutePath: string, _draftId?: string): Promise<ImportedAsset> {
    if (typeof sourceAbsolutePath !== 'string' || !path.isAbsolute(sourceAbsolutePath)) {
      throw appError('INVALID_INPUT')
    }
    const definition = documentTypeForPath(sourceAbsolutePath)
    if (!definition?.insertInEditor || definition.category === 'document') {
      throw appError('UNSUPPORTED_FILE_TYPE')
    }
    const sourceMetadata = await lstat(sourceAbsolutePath).catch(() => {
      throw appError('FILE_NOT_FOUND')
    })
    if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile()) {
      throw appError('UNSUPPORTED_FILE_TYPE')
    }
    const source = await realpath(sourceAbsolutePath).catch(() => {
      throw appError('FILE_NOT_FOUND')
    })
    const canonicalDefinition = documentTypeForPath(source)
    if (!canonicalDefinition?.insertInEditor || canonicalDefinition.category === 'document') {
      throw appError('UNSUPPORTED_FILE_TYPE')
    }
    const category = canonicalDefinition.category
    const previewUrl = category === 'image' || category === 'audio' || category === 'video'
      ? await this.options.access.urlFor(source)
      : ''
    return {
      assetId: createHash('sha256').update(source).digest('hex'),
      category,
      fileName: path.basename(source),
      relativePath: source,
      previewUrl,
      markdown: markdownFor(category, source),
    }
  }

  async stageClipboardImage(draftId: string): Promise<ImportedAsset | null> {
    const { assetDirectory } = draftPaths(this.options.tempRoot, draftId)
    const image = this.options.readClipboardImage?.()
    if (!image || image.isEmpty()) return null
    const { width, height } = image.getSize()
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || width < 1 || height < 1 || width > 4096 || height > 4096
      || width * height > 16_000_000) throw appError('INVALID_INPUT')
    const bytes = image.toPNG()
    if (bytes.length < 33 || bytes.length > 16 * 1024 * 1024
      || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR'
      || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) {
      throw appError('INVALID_INPUT')
    }
    await safeDirectory(assetDirectory)
    // The durable managed filename is included in DraftService's hashed manifest.
    const assetId = randomUUID()
    const fileName = `clipboard-${assetId}.png`
    const target = path.join(assetDirectory, fileName)
    try {
      await writeFile(target, bytes, { flag: 'wx' })
      const previewUrl = await this.options.access.urlFor(target)
      const relativePath = target.replaceAll('\\', '/')
      return { assetId, fileName, category: 'image', relativePath, previewUrl, markdown: `![](<${relativePath}>)` }
    } catch (error) {
      await rm(target, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async pasteClipboardImageToNote(noteId: string, copy: (noteId: string, source: string) => Promise<string>): Promise<string | null> {
    const temporaryId = randomUUID()
    const staged = await this.stageClipboardImage(temporaryId)
    if (!staged) return null
    try { return await copy(noteId, staged.relativePath) }
    finally { await rm(draftPaths(this.options.tempRoot, temporaryId).assetDirectory, { recursive: true, force: true }) }
  }

  async migrateDraftAssets(draftId: string, markdown: string, documentAbsolutePath?: string): Promise<{
    markdown: string
    rollback(): Promise<void>
  }> {
    return this.migrateOwnedDraftAssets([draftId], markdown, documentAbsolutePath)
  }

  // Source ids are supplied only by main's current document/history ownership.
  // A durable successor draft must never depend on a process-local history lease.
  async rebindDraftAssets(draftId: string, markdown: string, historyIds: readonly string[]): Promise<string> {
    if (!historyIds.length) return markdown
    const destination = draftPaths(this.options.tempRoot, draftId).assetDirectory
    const references = this.managedReferences(markdown, historyIds.filter((id) => id !== draftId))
    if (!references.length) return markdown
    await safeDirectory(destination)
    const replacements = new Map<string, string>()
    for (const reference of references) {
      if (replacements.has(reference.value)) continue
      await safeDirectory(path.dirname(reference.source!))
      const metadata = await lstat(reference.source!)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw appError('INVALID_INPUT')
      const bytes = await readFile(reference.source!)
      const target = path.join(destination, path.basename(reference.source!))
      // Preserve the immutable managed filename so repeated backups reuse the
      // same copy. A name collision with different bytes is a hard failure.
      await copyFile(reference.source!, target, constants.COPYFILE_EXCL).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      })
      const copied = await lstat(target)
      if (!copied.isFile() || copied.isSymbolicLink()
        || createHash('sha256').update(await readFile(target)).digest('hex') !== createHash('sha256').update(bytes).digest('hex')) {
        throw appError('INVALID_INPUT')
      }
      replacements.set(reference.value, target.replaceAll('\\', '/'))
    }
    for (const reference of [...references].reverse()) {
      markdown = markdown.slice(0, reference.start) + replacements.get(reference.value)! + markdown.slice(reference.end)
    }
    return markdown
  }

  private managedReferences(markdown: string, draftIds: readonly string[]) {
    const directories = new Set(draftIds.map((id) => path.resolve(draftPaths(this.options.tempRoot, id).assetDirectory)))
    const code = codeRanges(markdown)
    return collectReferences(markdown)
      .filter((reference) => !code.some((range) => reference.start >= range.start && reference.end <= range.end))
      .map((reference) => ({ ...reference, source: resolveLocalReference(reference.value, null) }))
      .filter((reference) => reference.category === 'image' && reference.source
        && directories.has(path.resolve(path.dirname(reference.source)))
        && isClipboardAssetName(path.basename(reference.source)))
  }

  async migrateOwnedDraftAssets(draftIds: readonly string[], markdown: string, documentAbsolutePath?: string): Promise<{
    markdown: string
    rollback(): Promise<void>
  }> {
    const references = this.managedReferences(markdown, draftIds)
    const copied: string[] = []
    const rollback = async () => { await Promise.all(copied.map((target) => rm(target, { force: true }))) }
    if (!references.length) return { markdown, rollback }
    if (!documentAbsolutePath || !path.isAbsolute(documentAbsolutePath)) throw appError('INVALID_INPUT')
    const destination = path.join(path.dirname(documentAbsolutePath), 'assets')
    try {
      await safeDirectory(destination)
      const replacements = new Map<string, string>()
      for (const reference of references) {
        if (replacements.has(reference.value)) continue
        await safeDirectory(path.dirname(reference.source!))
        const metadata = await lstat(reference.source!)
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw appError('INVALID_INPUT')
        const fileName = `clipboard-${randomUUID()}.png`
        const target = path.join(destination, fileName)
        await copyFile(reference.source!, target, constants.COPYFILE_EXCL)
        copied.push(target)
        replacements.set(reference.value, `assets/${fileName}`)
      }
      for (const reference of [...references].reverse()) {
        markdown = markdown.slice(0, reference.start) + replacements.get(reference.value)! + markdown.slice(reference.end)
      }
      return { markdown, rollback }
    } catch (error) {
      await rollback()
      throw error
    }
  }
}
