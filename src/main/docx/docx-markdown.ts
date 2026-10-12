import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { documentTypeForPath } from '../../shared/document-types'

const markdownImagePattern = /!\[([^\]\r\n]*)\]\((?:<([^>\r\n]+)>|([^)\r\n]+))\)(?:\{[^}\r\n]*\})?/g
const htmlImagePattern = /<img\b[^>]*>/gi
const htmlAttributePattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function escapeMarkdownAlt(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll(']', '\\]')
}

function decodedPath(value: string): string {
  try {
    return decodeURI(value)
  } catch {
    return value
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function imagePathFromHtmlSource(source: string): string | null {
  if (path.isAbsolute(source)) return source
  if (!source.toLocaleLowerCase('en-US').startsWith('file:')) return null
  try {
    return fileURLToPath(source)
  } catch {
    return null
  }
}

function htmlAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>()
  htmlAttributePattern.lastIndex = 0
  for (const match of tag.matchAll(htmlAttributePattern)) {
    attributes.set(
      match[1].toLocaleLowerCase('en-US'),
      decodeHtmlAttribute(match[2] ?? match[3] ?? ''),
    )
  }
  return attributes
}

function importedImagePath(rawTarget: string, importRoot: string): string | null {
  const decodedTarget = decodedPath(rawTarget.trim())
  if (!decodedTarget || path.isAbsolute(decodedTarget)) return null

  const portableTarget = decodedTarget.replaceAll('/', path.sep)
  const mediaRoot = path.resolve(importRoot, 'media')
  const absoluteTarget = path.resolve(importRoot, portableTarget)
  if (!isInside(mediaRoot, absoluteTarget)) return null
  if (documentTypeForPath(absoluteTarget)?.category !== 'image') return null
  return absoluteTarget
}

function importedImageTag(
  source: string,
  alt: string,
  importRoot: string,
): string | null {
  const absoluteTarget = importedImagePath(source, importRoot)
  if (!absoluteTarget) return null
  return `<img src="${escapeHtmlAttribute(absoluteTarget)}" alt="${escapeHtmlAttribute(alt)}" style="zoom:100%;" />`
}

export function normalizeImportedDocxMarkdown(
  markdown: string,
  importRoot: string,
): string {
  const normalizedMarkdownImages = markdown.replace(
    markdownImagePattern,
    (original, alt: string, bracketedTarget: string | undefined, plainTarget: string | undefined) => {
      return importedImageTag(
        bracketedTarget ?? plainTarget ?? '',
        alt,
        importRoot,
      ) ?? original
    },
  )

  return normalizedMarkdownImages.replace(htmlImagePattern, (tag) => {
    const attributes = htmlAttributes(tag)
    const source = attributes.get('src')
    if (!source) return tag
    return importedImageTag(source, attributes.get('alt') ?? '', importRoot) ?? tag
  })
}

export function normalizeMarkdownForDocxExport(markdown: string): string {
  return markdown.replace(htmlImagePattern, (tag) => {
    const attributes = htmlAttributes(tag)
    const source = attributes.get('src')
    if (!source) return tag
    const absolutePath = imagePathFromHtmlSource(source)
    if (!absolutePath || documentTypeForPath(absolutePath)?.category !== 'image') return tag
    const alt = escapeMarkdownAlt(attributes.get('alt') ?? '')
    const pandocPath = absolutePath.replaceAll('\\', '/')
    return `![${alt}](<${pandocPath}>)`
  })
}
