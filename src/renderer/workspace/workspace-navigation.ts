import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Heading, RootContent } from 'mdast'
import type {
  ApiResult,
  DocumentSnapshot,
  TreeEntry,
} from '../../shared/contracts'

export interface OutlineItem {
  depth: number
  text: string
  index: number
}

export interface WorkspaceDocumentCard {
  relativePath: string
  title: string
  previewLines: string[]
}

export interface WorkspaceSearchMatch {
  relativePath: string
  title: string
  preview: string
  contentMatches: boolean
}

export interface WorkspaceDocumentScan {
  paths: string[]
  truncated: boolean
}

export interface WorkspaceSearchResult {
  matches: WorkspaceSearchMatch[]
  truncated: boolean
  failedDirectories: string[]
  failedDocuments: string[]
}

export interface WorkspaceCurrentDirectorySearchResult extends WorkspaceSearchResult {
  scannedDocuments: number
  hasDescendants: boolean
}

type ListDirectory = (relativePath: string) => Promise<ApiResult<TreeEntry[]>>
type ReadDocument = (relativePath: string) => Promise<ApiResult<DocumentSnapshot>>

function outlineHeadings(markdown: string): Heading[] {
  const headings: Heading[] = []
  const visit = (node: RootContent) => {
    if (node.type === 'heading') headings.push(node)
    if ('children' in node) node.children.forEach(visit)
  }
  fromMarkdown(markdown).children.forEach(visit)
  return headings
}

function outlineText(node: RootContent): string {
  if ('value' in node) return node.value
  if (node.type === 'image') return node.alt ?? ''
  return 'children' in node ? node.children.map(outlineText).join('') : ''
}

export function extractOutline(markdown: string): OutlineItem[] {
  return outlineHeadings(markdown).map((heading, index) => ({
    depth: heading.depth, text: outlineText(heading).trim(), index,
  }))
}

export function outlineHeadingOffset(markdown: string, index: number): number | undefined {
  return outlineHeadings(markdown)[index]?.position?.start.offset
}

export function outlineHasChildren(items: readonly OutlineItem[], index: number): boolean {
  const item = items[index]
  const next = items[index + 1]
  return Boolean(item && next && next.depth > item.depth)
}

export function visibleOutlineItems(
  items: readonly OutlineItem[],
  collapsed: ReadonlySet<number>,
): OutlineItem[] {
  const result: OutlineItem[] = []
  const collapsedDepths: number[] = []
  for (const item of items) {
    while (
      collapsedDepths.length
      && item.depth <= collapsedDepths[collapsedDepths.length - 1]!
    ) {
      collapsedDepths.pop()
    }
    const hidden = collapsedDepths.length > 0
    if (!hidden) result.push(item)
    if (!hidden && collapsed.has(item.index)) collapsedDepths.push(item.depth)
  }
  return result
}

export async function scanWorkspaceDocuments(
  listDirectory: ListDirectory,
  limit = 500,
  root = '',
): Promise<WorkspaceDocumentScan> {
  const paths: string[] = []
  const directories = [root]

  for (let directoryIndex = 0; directoryIndex < directories.length; directoryIndex += 1) {
    const result = await listDirectory(directories[directoryIndex]!)
    if (!result.ok) continue

    for (const entry of result.value) {
      if (entry.kind !== 'document') continue
      if (paths.length >= limit) return { paths, truncated: true }
      paths.push(entry.relativePath)
    }
    for (const entry of result.value) {
      if (entry.kind === 'directory') directories.push(entry.relativePath)
    }
  }

  return { paths, truncated: false }
}

export async function listWorkspaceDocuments(
  listDirectory: ListDirectory,
  limit = 500,
  root = '',
): Promise<string[]> {
  const result = await scanWorkspaceDocuments(listDirectory, limit, root)
  return result.paths.sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

function cleanPreviewLine(line: string): string {
  return line
    .replace(/^\s*(?:>\s*)+/, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function documentPreviewLines(markdown: string, limit = 3): string[] {
  const lines: string[] = []
  let fenced = false
  for (const sourceLine of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(sourceLine)) {
      fenced = !fenced
      continue
    }
    if (/^\s*#{1,6}(?:\s|$)/.test(sourceLine)) continue
    if (/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(sourceLine)) continue
    const line = cleanPreviewLine(sourceLine)
    if (!line) continue
    lines.push(line)
    if (lines.length >= limit) break
  }
  return lines
}

export async function listWorkspaceDocumentCards(
  listDirectory: ListDirectory,
  readDocument: ReadDocument,
  limit = 500,
): Promise<WorkspaceDocumentCard[]> {
  const paths = await listWorkspaceDocuments(listDirectory, limit)
  const cards: WorkspaceDocumentCard[] = []
  for (const relativePath of paths) {
    const result = await readDocument(relativePath)
    cards.push({
      relativePath,
      title: relativePath.split('/').at(-1) ?? relativePath,
      previewLines: result.ok ? documentPreviewLines(result.value.markdown) : [],
    })
  }
  return cards
}


export interface RootDocumentCards {
  cards: WorkspaceDocumentCard[]
  hasNested: boolean
}

async function documentCardsForPaths(
  paths: readonly string[],
  readDocument: ReadDocument,
  signal?: AbortSignal,
): Promise<WorkspaceDocumentCard[]> {
  const cards: WorkspaceDocumentCard[] = []
  for (let index = 0; index < paths.length; index += 4) {
    if (signal?.aborted) break
    const chunk = paths.slice(index, index + 4)
    const results = await Promise.all(chunk.map(async (relativePath) => {
      const result = await readDocument(relativePath)
      return {
        relativePath,
        title: relativePath.split('/').at(-1) ?? relativePath,
        previewLines: result.ok ? documentPreviewLines(result.value.markdown) : [],
      }
    }))
    if (!signal?.aborted) cards.push(...results)
  }
  return cards
}

export async function listRootDocumentCards(
  listDirectory: ListDirectory,
  readDocument: ReadDocument,
  signal?: AbortSignal,
): Promise<RootDocumentCards> {
  const result = await listDirectory('')
  if (!result.ok || signal?.aborted) return { cards: [], hasNested: false }
  const paths = result.value
    .filter((entry) => entry.kind === 'document')
    .map((entry) => entry.relativePath)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
  return {
    cards: await documentCardsForPaths(paths, readDocument, signal),
    hasNested: result.value.some((entry) => entry.kind === 'directory'),
  }
}

export async function* streamNestedDocumentCards(options: {
  listDirectory: ListDirectory
  readDocument: ReadDocument
  signal?: AbortSignal
}): AsyncGenerator<WorkspaceDocumentCard[]> {
  const root = await options.listDirectory('')
  if (!root.ok || options.signal?.aborted) return
  const directories = root.value
    .filter((entry) => entry.kind === 'directory')
    .map((entry) => entry.relativePath)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))

  for (let index = 0; index < directories.length; index += 1) {
    if (options.signal?.aborted) return
    const result = await options.listDirectory(directories[index]!)
    if (!result.ok) continue
    const childDirectories = result.value
      .filter((entry) => entry.kind === 'directory')
      .map((entry) => entry.relativePath)
      .sort((left, right) => left.localeCompare(right, 'zh-CN'))
    directories.push(...childDirectories)
    const paths = result.value
      .filter((entry) => entry.kind === 'document')
      .map((entry) => entry.relativePath)
      .sort((left, right) => left.localeCompare(right, 'zh-CN'))
    const cards = await documentCardsForPaths(paths, options.readDocument, options.signal)
    if (cards.length && !options.signal?.aborted) yield cards
  }
}

function previewFor(markdown: string, normalizedQuery: string): string {
  const plain = documentPreviewLines(markdown, 200).join(' ')
  const index = plain.toLocaleLowerCase('zh-CN').indexOf(normalizedQuery)
  if (index < 0) return plain.slice(0, 90)
  const start = Math.max(0, index - 28)
  const end = Math.min(plain.length, index + normalizedQuery.length + 58)
  return `${start > 0 ? '…' : ''}${plain.slice(start, end)}${end < plain.length ? '…' : ''}`
}

async function searchDocumentEntry(
  relativePath: string,
  normalizedQuery: string,
  readDocument: ReadDocument,
): Promise<{ match: WorkspaceSearchMatch | null; readFailed: boolean }> {
  const pathMatches = relativePath.toLocaleLowerCase('zh-CN').includes(normalizedQuery)
  let document: ApiResult<DocumentSnapshot>
  try {
    document = await readDocument(relativePath)
  } catch {
    document = {
      ok: false,
      error: { code: 'READ_FAILED', message: 'Unable to read document' },
    }
  }
  if (!document.ok) {
    return {
      match: pathMatches
        ? {
            relativePath,
            title: relativePath.split('/').at(-1) ?? relativePath,
            preview: '文件名匹配（正文读取失败）',
            contentMatches: false,
          }
        : null,
      readFailed: true,
    }
  }
  const contentMatches = document.value.markdown
    .toLocaleLowerCase('zh-CN')
    .includes(normalizedQuery)
  if (!pathMatches && !contentMatches) return { match: null, readFailed: false }
  return {
    match: {
      relativePath,
      title: relativePath.split('/').at(-1) ?? relativePath,
      preview: previewFor(document.value.markdown, normalizedQuery),
      contentMatches,
    },
    readFailed: false,
  }
}

export async function searchCurrentDirectoryDocuments(options: {
  query: string
  listDirectory: ListDirectory
  readDocument: ReadDocument
  root?: string
  limit?: number
}): Promise<WorkspaceCurrentDirectorySearchResult> {
  const query = options.query.trim()
  if (!query) {
    return {
      matches: [],
      truncated: false,
      failedDirectories: [],
      failedDocuments: [],
      scannedDocuments: 0,
      hasDescendants: false,
    }
  }
  const root = options.root ?? ''
  let directory: ApiResult<TreeEntry[]>
  try {
    directory = await options.listDirectory(root)
  } catch {
    directory = {
      ok: false,
      error: { code: 'READ_FAILED', message: 'Unable to list directory' },
    }
  }
  if (!directory.ok) {
    return {
      matches: [],
      truncated: false,
      failedDirectories: [root],
      failedDocuments: [],
      scannedDocuments: 0,
      hasDescendants: false,
    }
  }

  const normalized = query.toLocaleLowerCase('zh-CN')
  const limit = options.limit ?? 500
  const matches: WorkspaceSearchMatch[] = []
  const failedDocuments: string[] = []
  const documents = directory.value.filter((entry) => entry.kind === 'document')
  let scannedDocuments = 0
  let truncated = false

  for (const entry of documents) {
    if (scannedDocuments >= limit) {
      truncated = true
      break
    }
    scannedDocuments += 1
    const result = await searchDocumentEntry(
      entry.relativePath,
      normalized,
      options.readDocument,
    )
    if (result.match) matches.push(result.match)
    if (result.readFailed) failedDocuments.push(entry.relativePath)
  }

  return {
    matches,
    truncated,
    failedDirectories: [],
    failedDocuments,
    scannedDocuments,
    hasDescendants: directory.value.some((entry) => entry.kind === 'directory'),
  }
}

export async function searchDescendantDocuments(options: {
  query: string
  listDirectory: ListDirectory
  readDocument: ReadDocument
  root?: string
  remainingLimit: number
  onProgress?: (result: WorkspaceSearchResult) => void
}): Promise<WorkspaceSearchResult> {
  const query = options.query.trim()
  if (!query) {
    return {
      matches: [],
      truncated: false,
      failedDirectories: [],
      failedDocuments: [],
    }
  }
  const rootPath = options.root ?? ''
  let root: ApiResult<TreeEntry[]>
  try {
    root = await options.listDirectory(rootPath)
  } catch {
    root = {
      ok: false,
      error: { code: 'READ_FAILED', message: 'Unable to list directory' },
    }
  }
  if (!root.ok) {
    return {
      matches: [],
      truncated: false,
      failedDirectories: [rootPath],
      failedDocuments: [],
    }
  }

  const normalized = query.toLocaleLowerCase('zh-CN')
  const matches: WorkspaceSearchMatch[] = []
  const failedDirectories: string[] = []
  const failedDocuments: string[] = []
  const directories = root.value
    .filter((entry) => entry.kind === 'directory')
    .map((entry) => entry.relativePath)
  let scannedDocuments = 0
  let truncated = false

  for (let directoryIndex = 0; directoryIndex < directories.length; directoryIndex += 1) {
    const relativeDirectory = directories[directoryIndex]!
    let directory: ApiResult<TreeEntry[]>
    try {
      directory = await options.listDirectory(relativeDirectory)
    } catch {
      directory = {
        ok: false,
        error: { code: 'READ_FAILED', message: 'Unable to list directory' },
      }
    }
    if (!directory.ok) {
      failedDirectories.push(relativeDirectory)
      options.onProgress?.({
        matches: [...matches],
        truncated,
        failedDirectories: [...failedDirectories],
        failedDocuments: [...failedDocuments],
      })
      continue
    }

    for (const entry of directory.value) {
      if (entry.kind !== 'document') continue
      if (scannedDocuments >= options.remainingLimit) {
        truncated = true
        break
      }
      scannedDocuments += 1
      const result = await searchDocumentEntry(
        entry.relativePath,
        normalized,
        options.readDocument,
      )
      if (result.match) matches.push(result.match)
      if (result.readFailed) failedDocuments.push(entry.relativePath)
    }

    options.onProgress?.({
      matches: [...matches],
      truncated,
      failedDirectories: [...failedDirectories],
      failedDocuments: [...failedDocuments],
    })
    if (truncated) break
    directories.push(...directory.value
      .filter((entry) => entry.kind === 'directory')
      .map((entry) => entry.relativePath))
  }

  return { matches, truncated, failedDirectories, failedDocuments }
}

export async function searchWorkspaceDocuments(options: {
  query: string
  listDirectory: ListDirectory
  readDocument: ReadDocument
  root?: string
  limit?: number
  onProgress?: (result: WorkspaceSearchResult) => void
}): Promise<WorkspaceSearchResult> {
  const limit = options.limit ?? 500
  const current = await searchCurrentDirectoryDocuments({
    query: options.query,
    listDirectory: options.listDirectory,
    readDocument: options.readDocument,
    root: options.root,
    limit,
  })
  options.onProgress?.({
    matches: [...current.matches],
    truncated: current.truncated,
    failedDirectories: [...current.failedDirectories],
    failedDocuments: [...current.failedDocuments],
  })
  if (current.truncated || !current.hasDescendants) {
    return {
      matches: current.matches,
      truncated: current.truncated,
      failedDirectories: current.failedDirectories,
      failedDocuments: current.failedDocuments,
    }
  }

  const descendants = await searchDescendantDocuments({
    query: options.query,
    listDirectory: options.listDirectory,
    readDocument: options.readDocument,
    root: options.root,
    remainingLimit: Math.max(0, limit - current.scannedDocuments),
    onProgress: (result) => {
      options.onProgress?.({
        matches: [...current.matches, ...result.matches],
        truncated: result.truncated,
        failedDirectories: [...current.failedDirectories, ...result.failedDirectories],
        failedDocuments: [...current.failedDocuments, ...result.failedDocuments],
      })
    },
  })
  return {
    matches: [...current.matches, ...descendants.matches],
    truncated: descendants.truncated,
    failedDirectories: [...current.failedDirectories, ...descendants.failedDirectories],
    failedDocuments: [...current.failedDocuments, ...descendants.failedDocuments],
  }
}
