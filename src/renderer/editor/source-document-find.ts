import { SearchQuery, setSearchQuery } from '@codemirror/search'
import type { EditorView } from '@codemirror/view'
import type { DocumentFindSnapshot } from './document-find-events'

interface MatchRange {
  from: number
  to: number
}

export interface SourceDocumentFindSession {
  setQuery(query: string): DocumentFindSnapshot
  next(): DocumentFindSnapshot
  previous(): DocumentFindSnapshot
  refresh(markdown?: string): DocumentFindSnapshot
  close(): DocumentFindSnapshot
  snapshot(): DocumentFindSnapshot
  dispose(): void
}

function findLiteralMatches(markdown: string, query: string): MatchRange[] {
  if (!query) return []
  const haystack = markdown.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  const matches: MatchRange[] = []
  let offset = 0
  while (offset <= haystack.length - needle.length) {
    const from = haystack.indexOf(needle, offset)
    if (from < 0) break
    matches.push({ from, to: from + needle.length })
    offset = Math.max(from + needle.length, from + 1)
  }
  return matches
}

export function createSourceDocumentFindSession(
  view: EditorView,
  initialMarkdown: string,
  onSnapshot?: (snapshot: DocumentFindSnapshot) => void,
): SourceDocumentFindSession {
  let markdown = initialMarkdown
  let activeQuery = ''
  let matches: MatchRange[] = []
  let currentIndex = -1
  let revision = 0

  const snapshot = (): DocumentFindSnapshot => ({
    query: activeQuery,
    current: currentIndex < 0 ? 0 : currentIndex + 1,
    total: matches.length,
    revision,
  })

  const publish = (): DocumentFindSnapshot => {
    revision += 1
    const next = snapshot()
    onSnapshot?.(next)
    return next
  }

  const reveal = () => {
    const match = matches[currentIndex]
    if (!match) return
    view.dispatch({
      selection: { anchor: match.from, head: match.to },
      scrollIntoView: true,
    })
  }

  const replaceMatches = (preferredIndex: number) => {
    matches = findLiteralMatches(markdown, activeQuery)
    currentIndex = matches.length
      ? Math.min(Math.max(preferredIndex, 0), matches.length - 1)
      : -1
    reveal()
  }

  return {
    setQuery(query) {
      activeQuery = query
      view.dispatch({
        effects: setSearchQuery.of(new SearchQuery({
          search: query,
          caseSensitive: false,
          literal: true,
        })),
      })
      replaceMatches(0)
      return publish()
    },
    next() {
      if (matches.length) currentIndex = (currentIndex + 1) % matches.length
      reveal()
      return publish()
    },
    previous() {
      if (matches.length) currentIndex = (currentIndex - 1 + matches.length) % matches.length
      reveal()
      return publish()
    },
    refresh(nextMarkdown) {
      markdown = nextMarkdown ?? view.state.doc.toString()
      replaceMatches(0)
      return publish()
    },
    close() {
      activeQuery = ''
      matches = []
      currentIndex = -1
      view.dispatch({
        effects: setSearchQuery.of(new SearchQuery({ search: '', literal: true })),
      })
      return publish()
    },
    snapshot,
    dispose() {
      activeQuery = ''
      matches = []
      currentIndex = -1
    },
  }
}
