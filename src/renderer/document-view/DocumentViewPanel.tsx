import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { ArrowClockwise, ArrowLeft, CaretRight, FolderOpen, MagnifyingGlass, X } from '@phosphor-icons/react'
import { EditorView } from '@codemirror/view'
import { selectAll } from '@codemirror/commands'
import { closeSearchPanel, openSearchPanel, searchPanelOpen } from '@codemirror/search'
import type { ArkdownApi } from '../../shared/contracts'
import { useOptionalContextMenu } from '../context-menu/ContextMenuProvider'
import { installLinkInteraction } from '../editor/local-link-handler'
import { parseLocalFileLink } from '../../shared/document-view-link'
import { revealLocalFileLink } from '../editor/reveal-local-file-link'
import { useOptionalBusinessDialog } from '../modal/BusinessDialogProvider'
import { DocumentViewMarkdown } from './DocumentViewMarkdown'
import { ReadonlyCodeDocument } from './ReadonlyCodeDocument'
import type { DocumentViewController } from './use-document-view'
import { documentViewBreadcrumbLabels } from './document-view-breadcrumbs'
import './document-view.css'

export interface DocumentViewPanelProps {
  controller: DocumentViewController
  openExternal?: ArkdownApi['openExternal']
  className?: string
}

function findRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return []
  const nodes: Text[] = []
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  const text = nodes.map((node) => node.data).join('').toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  const ranges: Range[] = []
  for (let start = text.indexOf(needle); start >= 0; start = text.indexOf(needle, start + needle.length)) {
    const range = root.ownerDocument.createRange()
    let offset = 0
    let hasStart = false
    for (const node of nodes) {
      const end = offset + node.length
      if (!hasStart && start < end) { range.setStart(node, start - offset); hasStart = true }
      if (hasStart && start + needle.length <= end) { range.setEnd(node, start + needle.length - offset); break }
      offset = end
    }
    ranges.push(range)
  }
  return ranges
}

export function DocumentViewPanel({ controller, openExternal, className = '' }: DocumentViewPanelProps) {
  const { state, current } = controller
  const contextMenu = useOptionalContextMenu()
  const dialogs = useOptionalBusinessDialog()
  const panel = useRef<HTMLElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const codeView = useRef<EditorView | null>(null)
  const findInput = useRef<HTMLInputElement>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [findResult, setFindResult] = useState({ index: -1, count: 0 })
  const currentDocument = current?.result.kind === 'document' ? current.result.document : null
  const breadcrumbs = [state.root, ...state.entries]
  const breadcrumbLabels = documentViewBreadcrumbLabels(breadcrumbs)

  useEffect(() => {
    const check = () => { void controller.checkForChanges() }
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [controller.checkForChanges, current?.id])
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = current?.scrollTop ?? 0
    if (state.anchor && content.current) {
      const target = Array.from(content.current.querySelectorAll<HTMLElement>('[data-document-view-anchor]'))
        .find((element) => element.dataset.documentViewAnchor === state.anchor)
      target?.scrollIntoView?.({ block: 'start' })
      if (!target) controller.reportError('未找到链接指定的章节，已显示文档')
    }
    if (state.line && codeView.current) {
      const view = codeView.current
      const line = view.state.doc.line(Math.min(Math.max(state.line, 1), view.state.doc.lines))
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start' }) })
    }
    controller.consumeLocation()
    setFindResult({ index: -1, count: 0 })
  }, [current?.id, currentDocument?.revision, state.navigationVersion])
  useEffect(() => { if (findOpen) findInput.current?.focus() }, [findOpen])
  useEffect(() => {
    if (!content.current) return
    return installLinkInteraction(content.current, openExternal ?? window.arkdown?.openExternal, controller.reportError, controller.openLink)
  }, [controller.openLink, controller.reportError, current?.id, openExternal])

  const showFind = useCallback(() => {
    if (codeView.current) { openSearchPanel(codeView.current); return }
    setFindOpen(true)
    findInput.current?.focus()
  }, [])
  useEffect(() => {
    const handleCommand = (event: Event) => {
      const command = (event as CustomEvent<unknown>).detail
      if (command === 'find-in-document' || command === 'toggle-document-find') showFind()
    }
    window.addEventListener('arkdown:document-view-command', handleCommand)
    return () => window.removeEventListener('arkdown:document-view-command', handleCommand)
  }, [showFind])
  const findNext = (backward = false) => {
    if (!content.current) return
    const matches = findRanges(content.current, query)
    if (!matches.length) { setFindResult({ index: -1, count: 0 }); return }
    const index = (findResult.index + (backward ? -1 : 1) + matches.length) % matches.length
    const match = matches[index]!
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(match)
    match.startContainer.parentElement?.scrollIntoView?.({ block: 'nearest' })
    setFindResult({ index, count: matches.length })
  }
  const handleKey = (event: KeyboardEvent<HTMLElement>) => {
    const key = event.key.toLowerCase()
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
    if ((event.ctrlKey || event.metaKey) && ['f', 'a', 'c', 'x', 'v', 's', 'z', 'y'].includes(key)) {
      event.stopPropagation()
      if (key === 'f') { event.preventDefault(); showFind() }
      if (key === 'a' && !typing) {
        event.preventDefault()
        if (codeView.current) { selectAll(codeView.current); return }
        if (content.current) {
          const range = document.createRange()
          range.selectNodeContents(content.current)
          window.getSelection()?.removeAllRanges()
          window.getSelection()?.addRange(range)
        }
      }
      if (['s', 'z', 'y'].includes(key) || (!typing && ['x', 'v'].includes(key))) event.preventDefault()
    }
    if (key === 'escape' && (findOpen || (codeView.current && searchPanelOpen(codeView.current.state)))) {
      event.preventDefault()
      event.stopPropagation()
      setFindOpen(false)
      if (codeView.current) closeSearchPanel(codeView.current)
      panel.current?.focus()
    }
  }
  const openMenu = (event: MouseEvent, id?: string) => {
    event.preventDefault()
    event.stopPropagation()
    const target = id ?? current?.id
    if (!contextMenu || !target) return
    contextMenu.openMenu({
      x: event.clientX, y: event.clientY,
      rootIconGutter: 'none',
      items: [{ kind: 'command', id: 'open-document-view', label: '使用新窗口打开' }],
      execute: () => controller.open(target),
      restoreFocus: () => panel.current?.focus(),
    })
  }

  const openContentMenu = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!contextMenu || !currentDocument) return
    // Snapshot the local selection before the menu takes focus. Never copy a
    // selection from the main editor or use a stale, unfocused code selection.
    const selection = window.getSelection()
    const localSelection = selection && !selection.isCollapsed
      && content.current?.contains(selection.anchorNode)
      && content.current?.contains(selection.focusNode)
    const view = codeView.current
    const text = view && (view.hasFocus || localSelection)
      ? view.state.selection.ranges.map(({ from, to }) => view.state.sliceDoc(from, to)).join('\n')
      : localSelection ? selection.toString() : ''
    const target = currentDocument.id
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
    const href = anchor && content.current?.contains(anchor) ? anchor.getAttribute('href') : null
    const localHref = href && parseLocalFileLink(href) ? href : null
    contextMenu.openMenu({
      x: event.clientX, y: event.clientY,
      rootIconGutter: 'none',
      items: [
        { kind: 'command', id: 'copy-document-view', label: '复制', shortcut: 'Ctrl+C', disabled: !text },
        { kind: 'command', id: 'open-document-view', label: '在新窗口打开该文档' },
        ...(localHref ? [{ kind: 'command' as const, id: 'link-reveal', label: '打开文件位置' }] : []),
      ],
      execute: async (id) => {
        if (id === 'link-reveal' && localHref) {
          await revealLocalFileLink({ href: localHref, sourceId: target }, dialogs)
          return
        }
        if (id === 'open-document-view') { await controller.open(target); return }
        if (id !== 'copy-document-view' || !text) return
        try {
          if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
          await navigator.clipboard.writeText(text)
        } catch { controller.reportError('复制失败，请重试') }
      },
      restoreFocus: () => panel.current?.focus({ preventScroll: true }),
    })
  }

  return <section className={`document-view-panel ${className}`} ref={panel} tabIndex={-1} aria-label="文档查看" onKeyDownCapture={handleKey} onPointerDownCapture={(event) => {
    if (event.button === 0 && event.target instanceof Element && !event.target.closest('button, input, textarea, .cm-editor')) panel.current?.focus({ preventScroll: true })
  }}>
    <div className="document-view-toolbar">
      <button aria-label="返回上一文档" data-tooltip="返回上一文档" disabled={!current} onClick={controller.back}><ArrowLeft size={16} /></button>
      <span className="document-view-readonly">只读</span>
      <span className="document-view-toolbar-spacer" />
      <button aria-label="查找文档" data-tooltip="查找文档（Ctrl＋F）" disabled={!currentDocument} onClick={showFind}><MagnifyingGlass size={16} /></button>
      <button aria-label="刷新文档" data-tooltip="刷新文档" disabled={!currentDocument || state.loading} onClick={() => void controller.refresh()}><ArrowClockwise size={16} /></button>
    </div>
    <nav className="document-view-breadcrumbs" aria-label="文档查看路径" onContextMenu={(event) => openMenu(event)}>
      {breadcrumbs.map((entry, index) => <span className="document-view-crumb" key={entry.id}>
        {index > 0 && <CaretRight size={12} aria-hidden="true" />}
        <button data-tooltip={entry.absolutePath ?? entry.displayName} aria-current={entry.id === current?.id ? 'page' : undefined} onClick={() => controller.select(entry.id)} onContextMenu={(event) => openMenu(event, entry.id)}>{breadcrumbLabels[index]}</button>
      </span>)}
    </nav>
    {findOpen && <div className="document-view-find">
      <input ref={findInput} type="search" aria-label="在文档查看中查找" value={query} onChange={(event) => { setQuery(event.target.value); setFindResult({ index: -1, count: 0 }) }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); findNext(event.shiftKey) } }} />
      <span role="status">{findResult.index + 1}/{findResult.count}</span>
      <button aria-label="下一个匹配" onClick={() => findNext()}><CaretRight size={14} /></button>
      <button aria-label="关闭查找" onClick={() => setFindOpen(false)}><X size={14} /></button>
    </div>}
    {state.error && <div className="document-view-notice document-view-error" role="alert">{state.error}</div>}
    {state.missing ? <div className="document-view-notice" role="status">目标已移动或删除，当前显示上次读取的内容</div>
      : state.changed && <div className="document-view-notice" role="status">文件已更改，刷新以查看最新内容</div>}
    {state.loading && <div className="document-view-notice" role="status">正在读取…</div>}
    <div className="document-view-scroll" ref={scroll} data-testid="document-view-scroll" onContextMenu={openContentMenu} onScroll={(event) => controller.setScroll(event.currentTarget.scrollTop)}>
      <div ref={content} className="document-view-content" data-ui-selectable="true">
        {!current && <p className="document-view-empty">Ctrl＋单击文档中的相对链接，在此查看内容。</p>}
        {currentDocument?.kind === 'markdown' && <DocumentViewMarkdown document={currentDocument} />}
        {currentDocument && currentDocument.kind !== 'markdown' && <ReadonlyCodeDocument document={currentDocument} onView={(view) => { codeView.current = view }} />}
        {current && current.result.kind !== 'document' && <div className="document-view-target">
          <FolderOpen size={28} aria-hidden="true" />
          <strong>{current.displayName}</strong>
          <span>{current.absolutePath}</span>
          <button onClick={() => void controller.open()}>{current.result.kind === 'directory' ? '在资源管理器中打开' : '使用默认应用打开'}</button>
        </div>}
      </div>
    </div>
  </section>
}
