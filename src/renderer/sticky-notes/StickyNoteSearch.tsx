import { useEffect, useRef, useState } from 'react'
import type {
  StickyNoteSearchResult,
  StickyNoteStatus,
} from '../../shared/sticky-notes'

interface StickyNoteSearchProps {
  status: StickyNoteStatus
  onClose(): void
  onSelect(result: StickyNoteSearchResult, query: string): void
}

function archivedDate(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN')
}

export function StickyNoteSearch({ status, onClose, onSelect }: StickyNoteSearchProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<StickyNoteSearchResult[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const sequence = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    sequence.current += 1
    setQuery('')
    setResults([])
    setMessage(null)
    inputRef.current?.focus()
  }, [status])

  const search = (nextQuery: string) => {
    setQuery(nextQuery)
    setMessage(null)
    const trimmed = nextQuery.trim()
    const request = ++sequence.current
    if (!trimmed) {
      setResults([])
      return
    }
    void window.arkdown.searchStickyNotes(status, trimmed).then((result) => {
      if (request !== sequence.current) return
      if (!result.ok) {
        setResults([])
        setMessage(result.error.message)
        return
      }
      setResults(result.value)
      setMessage(result.value.length ? null : '没有找到匹配的便签')
    })
  }

  return (
    <section aria-label={status === 'active' ? '搜索便签' : '搜索归档便签'} className="sticky-note-search">
      <div className="sticky-note-search-field">
        <span aria-hidden="true">⌕</span>
        <input
          aria-label="搜索便签"
          onChange={(event) => search(event.target.value)}
          placeholder="输入便签名或内容…"
          ref={inputRef}
          role="searchbox"
          value={query}
        />
        <button aria-label="关闭便签搜索" onClick={onClose} type="button">×</button>
      </div>
      {message && <p className="sticky-note-box-message" role="status">{message}</p>}
      <div aria-label="便签搜索结果" className="sticky-note-search-results" role="list">
        {results.map((result) => (
          <button
            aria-label={`${result.name} ${result.excerpt}`}
            key={result.noteId}
            onClick={() => onSelect(result, query.trim())}
            type="button"
          >
            <strong>{result.name}</strong>
            {status === 'archived' && result.archivedAt && (
              <time dateTime={result.archivedAt}>{archivedDate(result.archivedAt)}</time>
            )}
            <span>{result.excerpt || '未找到可显示的正文片段'}</span>
          </button>
        ))}
      </div>
    </section>
  )
}
