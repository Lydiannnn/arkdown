import type { DocumentFindSnapshot } from './document-find-events'

const MATCH_HIGHLIGHT = 'arkdown-document-find-match'
const CURRENT_HIGHLIGHT = 'arkdown-document-find-current'

export interface DocumentHighlightRegistry {
  set(name: string, ranges: Range[]): void
  delete(name: string): void
}

export interface VisualDocumentFindSession {
  setQuery(query: string): DocumentFindSnapshot
  next(): DocumentFindSnapshot
  previous(): DocumentFindSnapshot
  refresh(): DocumentFindSnapshot
  close(): DocumentFindSnapshot
  snapshot(): DocumentFindSnapshot
  dispose(): void
}

interface TextSegment {
  node: Text
  start: number
  end: number
  block: Element | null
}

function getBlockAncestor(node: Text, root: HTMLElement): Element | null {
  let element = node.parentElement
  while (element && element !== root) {
    if (/^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DIV|DL|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TD|TH|TR|UL)$/.test(element.tagName)) {
      return element
    }
    element = element.parentElement
  }
  return root
}

function collectText(root: HTMLElement): { text: string; segments: TextSegment[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const text = node as Text
      const parent = text.parentElement
      if (!text.data || !parent) return NodeFilter.FILTER_REJECT
      if (parent.closest('script, style, textarea, input, [aria-hidden="true"]')) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const segments: TextSegment[] = []
  let combined = ''
  let previousBlock: Element | null = null
  let current = walker.nextNode() as Text | null
  while (current) {
    const block = getBlockAncestor(current, root)
    if (combined && previousBlock && block !== previousBlock) combined += '\n'
    const start = combined.length
    combined += current.data
    segments.push({ node: current, start, end: combined.length, block })
    previousBlock = block
    current = walker.nextNode() as Text | null
  }
  return { text: combined, segments }
}

function findSegment(segments: TextSegment[], offset: number): TextSegment | null {
  return segments.find((segment) => offset >= segment.start && offset < segment.end) ?? null
}

function createMatchRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return []
  const { text, segments } = collectText(root)
  const haystack = text.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  const ranges: Range[] = []
  let index = 0
  while (index <= haystack.length - needle.length) {
    const start = haystack.indexOf(needle, index)
    if (start < 0) break
    const end = start + needle.length
    const startSegment = findSegment(segments, start)
    const endSegment = findSegment(segments, end - 1)
    if (startSegment && endSegment) {
      const range = document.createRange()
      range.setStart(startSegment.node, start - startSegment.start)
      range.setEnd(endSegment.node, end - endSegment.start)
      ranges.push(range)
    }
    index = Math.max(end, start + 1)
  }
  return ranges
}

function createBrowserRegistry(): DocumentHighlightRegistry {
  const cssHighlights = (CSS as unknown as {
    highlights?: {
      set(name: string, highlight: unknown): void
      delete(name: string): void
    }
  }).highlights
  const HighlightConstructor = (globalThis as unknown as {
    Highlight?: new (...ranges: Range[]) => unknown
  }).Highlight

  return {
    set(name, ranges) {
      if (cssHighlights && HighlightConstructor) {
        cssHighlights.set(name, new HighlightConstructor(...ranges))
      } else if (name === CURRENT_HIGHLIGHT && ranges[0]) {
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(ranges[0])
      }
    },
    delete(name) {
      cssHighlights?.delete(name)
      if (name === CURRENT_HIGHLIGHT && !cssHighlights) {
        window.getSelection()?.removeAllRanges()
      }
    },
  }
}

export function createVisualDocumentFindSession(
  root: HTMLElement,
  registry: DocumentHighlightRegistry = createBrowserRegistry(),
  onSnapshot?: (snapshot: DocumentFindSnapshot) => void,
): VisualDocumentFindSession {
  let activeQuery = ''
  let ranges: Range[] = []
  let currentIndex = -1
  let revision = 0

  const snapshot = (): DocumentFindSnapshot => ({
    query: activeQuery,
    current: currentIndex < 0 ? 0 : currentIndex + 1,
    total: ranges.length,
    revision,
  })

  const publish = (): DocumentFindSnapshot => {
    revision += 1
    const next = snapshot()
    onSnapshot?.(next)
    return next
  }

  const render = () => {
    if (!ranges.length) {
      registry.delete(MATCH_HIGHLIGHT)
      registry.delete(CURRENT_HIGHLIGHT)
      return
    }
    registry.set(MATCH_HIGHLIGHT, ranges)
    registry.set(CURRENT_HIGHLIGHT, [ranges[currentIndex]])
    const element = ranges[currentIndex].commonAncestorContainer.parentElement
    element?.scrollIntoView?.({ block: 'center', inline: 'nearest' })
  }

  const update = (query: string, preferredIndex = 0): DocumentFindSnapshot => {
    activeQuery = query
    ranges = createMatchRanges(root, query)
    currentIndex = ranges.length
      ? Math.min(Math.max(preferredIndex, 0), ranges.length - 1)
      : -1
    render()
    return publish()
  }

  return {
    setQuery: (query) => update(query),
    next() {
      if (ranges.length) currentIndex = (currentIndex + 1) % ranges.length
      render()
      return publish()
    },
    previous() {
      if (ranges.length) currentIndex = (currentIndex - 1 + ranges.length) % ranges.length
      render()
      return publish()
    },
    refresh() {
      return update(activeQuery, 0)
    },
    close() {
      activeQuery = ''
      ranges = []
      currentIndex = -1
      registry.delete(MATCH_HIGHLIGHT)
      registry.delete(CURRENT_HIGHLIGHT)
      return publish()
    },
    snapshot,
    dispose() {
      activeQuery = ''
      ranges = []
      currentIndex = -1
      registry.delete(MATCH_HIGHLIGHT)
      registry.delete(CURRENT_HIGHLIGHT)
    },
  }
}
