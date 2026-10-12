import { useEffect, useRef, type KeyboardEvent } from 'react'
import searchIcon from '../assets/workspace/search.png'
import { AppIcon } from '../icons/AppIcon'
import './document-find-bar.css'

export interface DocumentFindBarProps {
  query: string
  onClose(): void
  onNavigate(direction: 'next' | 'previous'): void
  onQuery(query: string): void
  focusRequest: number
  current: number
  total: number
}

export function DocumentFindBar({
  query,
  onClose,
  onNavigate,
  onQuery,
  focusRequest,
  current,
  total,
}: DocumentFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusRequest])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      onNavigate(event.shiftKey ? 'previous' : 'next')
    }
  }

  const iconSize = 22 / (window.devicePixelRatio || 1)

  return (
    <div className="document-find-bar" role="search" onBlur={(event) => {
      if (!query.trim() && !event.currentTarget.contains(event.relatedTarget)) onClose()
    }}>
      <img
        alt=""
        aria-hidden="true"
        className="document-find-icon"
        draggable={false}
        src={searchIcon}
        style={{ width: iconSize, height: iconSize }}
      />
      <input
        aria-label="在文档中搜索"
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="输入要查找的内容..."
        ref={inputRef}
        type="search"
        value={query}
      />
      <span className="document-find-navigation">
        <button
          aria-label="上一条搜索结果"
          className="document-find-nav"
          data-tooltip="上一条"
          disabled={total === 0}
          onClick={() => onNavigate('previous')}
          onMouseDown={(event) => event.preventDefault()}
          type="button"
        >
          <AppIcon name="find-previous" size={14} />
        </button>
        <button
          aria-label="下一条搜索结果"
          className="document-find-nav"
          data-tooltip="下一条"
          disabled={total === 0}
          onClick={() => onNavigate('next')}
          onMouseDown={(event) => event.preventDefault()}
          type="button"
        >
          <AppIcon name="find-next" size={14} />
        </button>
      </span>
      <span
        aria-label={total ? `当前第 ${current} 条，共 ${total} 条搜索结果` : '没有搜索结果'}
        className="document-find-count"
      >
        {current}/{total}
      </span>
      <span aria-hidden="true" className="document-find-divider" />
      <button
        aria-label="关闭文档搜索"
        className="document-find-close"
        onClick={onClose}
        data-tooltip="关闭"
        type="button"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  )
}
