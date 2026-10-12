import type {
  StickyNoteDocument,
  StickyNoteSearchInput,
  StickyNoteSearchResult,
  StickyNoteStatus,
  StickyNoteSummary,
} from '../../shared/sticky-notes'

interface StickyNoteSearchStore {
  list(status: StickyNoteStatus): Promise<StickyNoteSummary[]>
  get(noteId: string): Promise<StickyNoteDocument>
}

interface IndexedStickyNote {
  result: StickyNoteSearchResult
  normalizedName: string
  normalizedContent: string
  plainContent: string
}

function searchablePlainText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/^[\t ]{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])[\t ]+/gmu, '')
    .replace(/[`*_~|]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase()
}

function excerptAround(content: string, normalizedContent: string, query: string): string {
  const match = normalizedContent.indexOf(query)
  if (match < 0) return content.slice(0, 96)
  const start = Math.max(0, match - 32)
  const end = Math.min(content.length, match + query.length + 64)
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`
}

export class StickyNoteSearchIndex {
  private readonly cache = new Map<StickyNoteStatus, Map<string, IndexedStickyNote>>()
  private readonly loading = new Map<StickyNoteStatus, Promise<Map<string, IndexedStickyNote>>>()

  constructor(private readonly store: StickyNoteSearchStore) {}

  private async indexDocument(document: StickyNoteDocument): Promise<IndexedStickyNote> {
    const plainContent = searchablePlainText(document.markdown)
    return {
      result: {
        noteId: document.record.id,
        name: document.record.name,
        excerpt: plainContent.slice(0, 96),
        archivedAt: document.record.archivedAt,
      },
      normalizedName: normalize(document.record.name),
      normalizedContent: normalize(plainContent),
      plainContent,
    }
  }

  private async load(status: StickyNoteStatus): Promise<Map<string, IndexedStickyNote>> {
    const cached = this.cache.get(status)
    if (cached) return cached
    const currentLoad = this.loading.get(status)
    if (currentLoad) return currentLoad
    const task = (async () => {
      try {
        const summaries = await this.store.list(status)
        const documents = await Promise.all(summaries.map(({ record }) => this.store.get(record.id)))
        const entries = await Promise.all(documents.map((document) => this.indexDocument(document)))
        const next = new Map(entries.map((entry) => [entry.result.noteId, entry]))
        this.cache.set(status, next)
        return next
      } finally {
        this.loading.delete(status)
      }
    })()
    this.loading.set(status, task)
    return task
  }

  async search(input: StickyNoteSearchInput): Promise<StickyNoteSearchResult[]> {
    const query = normalize(input.query.trim())
    if (!query) return []
    const index = await this.load(input.status)
    return [...index.values()]
      .filter((entry) =>
        entry.normalizedName.includes(query) || entry.normalizedContent.includes(query))
      .map((entry) => ({
        ...entry.result,
        excerpt: entry.normalizedName.includes(query)
          ? entry.result.excerpt
          : excerptAround(entry.plainContent, entry.normalizedContent, query),
      }))
  }

  async refresh(noteId: string): Promise<void> {
    for (const cached of this.cache.values()) cached.delete(noteId)
    try {
      const document = await this.store.get(noteId)
      const cached = this.cache.get(document.record.status)
      if (cached) cached.set(noteId, await this.indexDocument(document))
    } catch {
      // Deleted or damaged notes are removed from every loaded status cache.
    }
  }
}
