import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { documentTypeForPath, type DocumentCategory } from '../../shared/document-types'
import { externalAssetPathFromUrl } from '../../shared/local-resource-path'
import type { StickyNoteImportWarning } from '../../shared/sticky-notes'

const MAX_REFERENCE_LENGTH = 32_767
const SUPPORTED_HTML_MEDIA = new Map<string, DocumentCategory>([
  ['img', 'image'],
  ['audio', 'audio'],
  ['video', 'video'],
])

interface ResourceReference {
  start: number
  end: number
  value: string
  category: DocumentCategory
}

export interface CopiedStickyNoteResource {
  source: string
  relativePath: string
  sha256: string
}

export interface RewriteStickyNoteResourcesInput {
  markdown: string
  sourceDirectory: string | null
  resourcesDirectory: string
}

export interface RewriteStickyNoteResourcesResult {
  markdown: string
  warnings: StickyNoteImportWarning[]
  copiedResources: CopiedStickyNoteResource[]
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function isRemoteOrEmbedded(value: string): boolean {
  return /^(?:https?:|data:|blob:|mailto:|javascript:|#)/iu.test(value)
}

function decodePathReference(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function resolveLocalReference(
  value: string,
  sourceDirectory: string | null,
): string | null {
  const decoded = decodeHtmlAttribute(value.trim())
  if (
    decoded.length === 0
    || decoded.length > MAX_REFERENCE_LENGTH
    || isRemoteOrEmbedded(decoded)
  ) return null

  const arkdownAssetPath = externalAssetPathFromUrl(decoded)
  if (arkdownAssetPath) return path.resolve(arkdownAssetPath)

  if (/^file:/iu.test(decoded)) {
    try {
      return path.resolve(fileURLToPath(decoded))
    } catch {
      return null
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(decoded) && !path.win32.isAbsolute(decoded)) {
    return null
  }
  if (path.win32.isAbsolute(decoded) || path.isAbsolute(decoded)) {
    return path.resolve(decodePathReference(decoded))
  }
  if (!sourceDirectory) return null
  return path.resolve(sourceDirectory, decodePathReference(decoded.replaceAll('/', path.sep)))
}

function backtickRun(source: string, start: number): number {
  let end = start
  while (source[end] === '`') end += 1
  return end - start
}

function matchingInlineCodeEnd(source: string, start: number, run: number): number {
  const delimiter = '`'.repeat(run)
  const result = source.indexOf(delimiter, start + run)
  return result === -1 ? source.length : result + run
}

function markdownImageReference(
  source: string,
  start: number,
): ResourceReference | null {
  if (source[start] !== '!' || source[start + 1] !== '[') return null
  let cursor = start + 2
  let escaped = false
  while (cursor < source.length) {
    const character = source[cursor]
    if (!escaped && character === ']') break
    escaped = !escaped && character === '\\'
    if (character !== '\\') escaped = false
    cursor += 1
  }
  if (cursor >= source.length || source[cursor + 1] !== '(') return null
  cursor += 2
  while (/\s/u.test(source[cursor] ?? '')) cursor += 1
  if (source[cursor] === '<') {
    const targetStart = cursor + 1
    let targetEnd = targetStart
    while (targetEnd < source.length && source[targetEnd] !== '>') targetEnd += 1
    if (targetEnd >= source.length) return null
    return {
      start: targetStart,
      end: targetEnd,
      value: source.slice(targetStart, targetEnd),
      category: 'image',
    }
  }

  const targetStart = cursor
  let depth = 0
  escaped = false
  while (cursor < source.length) {
    const character = source[cursor]
    if (!escaped) {
      if (character === '(') depth += 1
      if (character === ')') {
        if (depth === 0) break
        depth -= 1
      }
      if (depth === 0 && /\s/u.test(character)) break
    }
    escaped = !escaped && character === '\\'
    if (character !== '\\') escaped = false
    cursor += 1
  }
  if (cursor === targetStart) return null
  return {
    start: targetStart,
    end: cursor,
    value: source.slice(targetStart, cursor).replaceAll('\\ ', ' '),
    category: 'image',
  }
}

function htmlMediaReference(
  source: string,
  start: number,
): { reference: ResourceReference | null; next: number } | null {
  if (source[start] !== '<') return null
  const opening = /^<\s*(img|audio|video)\b/iu.exec(source.slice(start, start + 16))
  const tagName = opening?.[1]?.toLocaleLowerCase('en-US')
  const category = tagName ? SUPPORTED_HTML_MEDIA.get(tagName) : undefined
  if (!opening || !category) return null

  let cursor = start + opening[0].length
  let quote: '"' | "'" | null = null
  while (cursor < source.length) {
    const character = source[cursor]
    if (quote) {
      if (character === quote) quote = null
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      break
    }
    cursor += 1
  }
  if (cursor >= source.length) return { reference: null, next: source.length }
  const tagEnd = cursor + 1
  const tag = source.slice(start, tagEnd)
  const sourceAttribute = /\bsrc\s*=\s*(["'])(.*?)\1/isu.exec(tag)
  if (!sourceAttribute || sourceAttribute.index === undefined) {
    return { reference: null, next: tagEnd }
  }
  const valueOffset = sourceAttribute[0].indexOf(sourceAttribute[2])
  const valueStart = start + sourceAttribute.index + valueOffset
  return {
    reference: {
      start: valueStart,
      end: valueStart + sourceAttribute[2].length,
      value: sourceAttribute[2],
      category,
    },
    next: tagEnd,
  }
}

export function collectReferences(markdown: string): ResourceReference[] {
  const references: ResourceReference[] = []
  let offset = 0
  let fence: { marker: '`' | '~'; length: number } | null = null
  for (const lineWithEnding of markdown.match(/[^\n]*(?:\n|$)/gu) ?? []) {
    if (lineWithEnding === '') continue
    const line = lineWithEnding.endsWith('\n')
      ? lineWithEnding.slice(0, -1)
      : lineWithEnding
    const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(line)
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1][0] as '`' | '~'
      if (!fence) fence = { marker, length: fenceMatch[1].length }
      else if (fence.marker === marker && fenceMatch[1].length >= fence.length) fence = null
      offset += lineWithEnding.length
      continue
    }
    if (fence) {
      offset += lineWithEnding.length
      continue
    }

    let cursor = 0
    while (cursor < line.length) {
      if (line[cursor] === '`') {
        const run = backtickRun(line, cursor)
        cursor = matchingInlineCodeEnd(line, cursor, run)
        continue
      }
      const html = htmlMediaReference(line, cursor)
      if (html) {
        if (html.reference) {
          references.push({
            ...html.reference,
            start: offset + html.reference.start,
            end: offset + html.reference.end,
          })
        }
        cursor = html.next
        continue
      }
      const image = markdownImageReference(line, cursor)
      if (image) {
        references.push({
          ...image,
          start: offset + image.start,
          end: offset + image.end,
        })
        cursor = image.end
        continue
      }
      cursor += 1
    }
    offset += lineWithEnding.length
  }
  return references
}

function collisionName(fileName: string, suffix: number): string {
  const extension = path.extname(fileName)
  const stem = fileName.slice(0, fileName.length - extension.length)
  return `${stem}-${suffix}${extension}`
}

function warningReason(error: unknown): StickyNoteImportWarning['reason'] {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' ? 'missing' : 'unreadable'
}

export class StickyNoteResourceRewriter {
  async rewrite(
    input: RewriteStickyNoteResourcesInput,
  ): Promise<RewriteStickyNoteResourcesResult> {
    if (
      typeof input.markdown !== 'string'
      || !path.isAbsolute(input.resourcesDirectory)
      || (input.sourceDirectory !== null && !path.isAbsolute(input.sourceDirectory))
    ) throw new Error('便签资源导入参数无效')

    const references = collectReferences(input.markdown)
    const warnings: StickyNoteImportWarning[] = []
    const copiedResources: CopiedStickyNoteResource[] = []
    const replacementByRange = new Map<string, string>()
    const relativePathByHash = new Map<string, string>()
    const hashByOutputName = new Map<string, string>()

    for (const reference of references) {
      const source = resolveLocalReference(reference.value, input.sourceDirectory)
      if (!source) continue
      const definition = documentTypeForPath(source)
      if (!definition || definition.category !== reference.category) {
        warnings.push({ source, reason: 'unsupported' })
        continue
      }
      try {
        const metadata = await lstat(source)
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          warnings.push({ source, reason: 'unsupported' })
          continue
        }
      } catch (error) {
        warnings.push({ source, reason: warningReason(error) })
        continue
      }

      let contents: Buffer
      try {
        contents = await readFile(source)
      } catch (error) {
        warnings.push({ source, reason: warningReason(error) })
        continue
      }
      const sha256 = createHash('sha256').update(contents).digest('hex')
      let relativePath = relativePathByHash.get(sha256)
      if (!relativePath) {
        let outputName = path.basename(source)
        let suffix = 2
        while (
          hashByOutputName.has(outputName.toLocaleLowerCase('en-US'))
          && hashByOutputName.get(outputName.toLocaleLowerCase('en-US')) !== sha256
        ) {
          outputName = collisionName(path.basename(source), suffix)
          suffix += 1
        }
        relativePath = `resources/${outputName}`
        await mkdir(input.resourcesDirectory, { recursive: true })
        await writeFile(path.join(input.resourcesDirectory, outputName), contents, { flag: 'wx' })
        hashByOutputName.set(outputName.toLocaleLowerCase('en-US'), sha256)
        relativePathByHash.set(sha256, relativePath)
        copiedResources.push({ source, relativePath, sha256 })
      }
      replacementByRange.set(`${reference.start}:${reference.end}`, relativePath)
    }

    let markdown = input.markdown
    for (const reference of [...references].reverse()) {
      const replacement = replacementByRange.get(`${reference.start}:${reference.end}`)
      if (!replacement) continue
      markdown = `${markdown.slice(0, reference.start)}${replacement}${markdown.slice(reference.end)}`
    }
    return { markdown, warnings, copiedResources }
  }
}
