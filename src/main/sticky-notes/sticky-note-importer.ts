import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { decodeDocument } from '../documents/document-codec'
import type {
  StickyNoteDocument,
  StickyNoteImportResult,
  StickyNoteStatus,
  StickyNoteSummary,
} from '../../shared/sticky-notes'
import { stickyNotePaths } from './sticky-note-paths'
import { defaultStickyNoteName, validateStickyNoteName } from './sticky-note-name'
import {
  StickyNoteResourceRewriter,
  type RewriteStickyNoteResourcesInput,
  type RewriteStickyNoteResourcesResult,
} from './sticky-note-resource-rewriter'

const IMPORTABLE_EXTENSIONS = new Set(['.md', '.markdown', '.txt'])

interface StickyNoteImportStore {
  list(status: StickyNoteStatus): Promise<StickyNoteSummary[]>
  create(input: { name: string; markdown?: string }): Promise<StickyNoteDocument>
  writeMarkdown(noteId: string, markdown: string): Promise<StickyNoteDocument>
  delete(noteId: string): Promise<void>
}

interface StickyNoteImportResourceRewriter {
  rewrite(input: RewriteStickyNoteResourcesInput): Promise<RewriteStickyNoteResourcesResult>
}

export interface StickyNoteImporterOptions {
  root: string
  store: StickyNoteImportStore
  resourceRewriter?: StickyNoteImportResourceRewriter
  now?: () => Date
}

function uniqueName(suggestedName: string, existingNames: readonly string[]): string {
  const cleaned = suggestedName
    .trim()
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/gu, '_')
    .replace(/[. ]+$/gu, '')
    .slice(0, 80)
  const baseName = validateStickyNoteName(cleaned, []).ok ? cleaned : '导入便签'
  const normalized = new Set(
    existingNames.map((name) => name.toLocaleLowerCase('en-US')),
  )
  if (!normalized.has(baseName.toLocaleLowerCase('en-US'))) return baseName
  for (let suffix = 2; suffix <= 100_000; suffix += 1) {
    const suffixText = `（${suffix}）`
    const candidate = `${baseName.slice(0, 80 - suffixText.length)}${suffixText}`
    if (!normalized.has(candidate.toLocaleLowerCase('en-US'))) return candidate
  }
  throw new Error('无法生成唯一便签名')
}

export class StickyNoteImporter {
  private readonly resourceRewriter: StickyNoteImportResourceRewriter

  constructor(private readonly options: StickyNoteImporterOptions) {
    if (!path.isAbsolute(options.root)) throw new Error('便签数据根目录必须是绝对路径')
    this.resourceRewriter = options.resourceRewriter ?? new StickyNoteResourceRewriter()
  }

  async importFile(absolutePath: string): Promise<StickyNoteImportResult> {
    if (
      typeof absolutePath !== 'string'
      || !path.isAbsolute(absolutePath)
      || !IMPORTABLE_EXTENSIONS.has(path.extname(absolutePath).toLocaleLowerCase('en-US'))
    ) throw new Error('仅支持导入 Markdown 或 TXT 文档')
    const metadata = await lstat(absolutePath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('仅支持导入普通 Markdown 或 TXT 文件')
    }
    const decoded = decodeDocument(await readFile(absolutePath))
    return this.importMarkdown({
      suggestedName: path.basename(absolutePath, path.extname(absolutePath)),
      markdown: decoded.markdown,
      sourceDirectory: path.dirname(absolutePath),
    })
  }

  async importMarkdown(input: {
    suggestedName: string
    markdown: string
    sourceDirectory: string | null
  }): Promise<StickyNoteImportResult> {
    if (
      typeof input.suggestedName !== 'string'
      || typeof input.markdown !== 'string'
      || (input.sourceDirectory !== null && !path.isAbsolute(input.sourceDirectory))
    ) throw new Error('便签导入参数无效')
    const [active, archived] = await Promise.all([
      this.options.store.list('active'),
      this.options.store.list('archived'),
    ])
    const existingNames = [...active, ...archived].map(({ record }) => record.name)
    const suggestedName = input.suggestedName.trim() === ''
      ? defaultStickyNoteName(this.options.now?.() ?? new Date(), existingNames)
      : input.suggestedName
    const name = uniqueName(suggestedName, existingNames)
    const created = await this.options.store.create({ name, markdown: input.markdown })
    try {
      const rewritten = await this.resourceRewriter.rewrite({
        markdown: input.markdown,
        sourceDirectory: input.sourceDirectory,
        resourcesDirectory: stickyNotePaths(this.options.root, created.record).resources,
      })
      const note = rewritten.markdown === input.markdown
        ? created
        : await this.options.store.writeMarkdown(created.record.id, rewritten.markdown)
      return { note, warnings: rewritten.warnings }
    } catch (error) {
      await this.options.store.delete(created.record.id).catch(() => undefined)
      throw error
    }
  }
}
