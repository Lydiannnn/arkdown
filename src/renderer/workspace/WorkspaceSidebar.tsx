import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ApiResult,
  DocumentSnapshot,
  TreeEntry,
  WorkspaceSummary,
} from '../../shared/contracts'
import { FileTree } from './FileTree'
import './workspace-sidebar.css'
import './workspace-file-actions.css'
import {
  extractOutline,
  listWorkspaceDocuments,
  searchWorkspaceDocuments,
  type WorkspaceSearchMatch,
} from './workspace-navigation'

type SidebarTab = 'files' | 'documents' | 'outline' | 'search'
type ListDirectory = (relativePath: string) => Promise<ApiResult<TreeEntry[]>>
type ReadDocument = (relativePath: string) => Promise<ApiResult<DocumentSnapshot>>

export function WorkspaceSidebar(props: {
  workspace: WorkspaceSummary | null
  chooseWorkspace: () => Promise<void>
  workspaceError: string | null
  isChoosing: boolean
  listDirectory: ListDirectory
  readDocument: ReadDocument
  markdown: string
  currentDocument: string | null
  refreshVersion: number
  onOpenDocument: (relativePath: string) => void
  onCreateDocument: (relativePath: string) => Promise<boolean>
  onReloadDocument: () => void
  onRevealDocument: () => void
  onTrashDocument: () => void
}) {
  const [tab, setTab] = useState<SidebarTab>('files')
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<WorkspaceSearchMatch[]>([])
  const [documents, setDocuments] = useState<string[]>([])
  const [searching, setSearching] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const searchVersion = useRef(0)
  const searchInput = useRef<HTMLInputElement>(null)
  const newDocumentInput = useRef<HTMLInputElement>(null)
  const outline = useMemo(() => extractOutline(props.markdown), [props.markdown])

  useEffect(() => {
    if (tab !== 'documents') return
    let active = true
    void listWorkspaceDocuments(props.listDirectory).then((result) => {
      if (active) setDocuments(result)
    })
    return () => { active = false }
  }, [props.listDirectory, props.refreshVersion, tab])

  useEffect(() => {
    if (tab === 'search') searchInput.current?.focus()
  }, [tab])

  useEffect(() => {
    if (creating) newDocumentInput.current?.focus()
  }, [creating])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey) return
      const key = event.key.toLowerCase()
      if (key === 'n' && !event.shiftKey && props.workspace) {
        event.preventDefault()
        setCreating(true)
      } else if (key === 'p' || (key === 'f' && event.shiftKey)) {
        event.preventDefault()
        setTab('search')
      } else if (event.shiftKey && key === '1') {
        event.preventDefault()
        setTab('outline')
      } else if (event.shiftKey && key === '2') {
        event.preventDefault()
        setTab('documents')
      } else if (event.shiftKey && key === '3') {
        event.preventDefault()
        setTab('files')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [props.workspace])

  useEffect(() => {
    if (tab !== 'search' || !props.workspace) return
    const version = ++searchVersion.current
    if (!query.trim()) {
      setMatches([])
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = window.setTimeout(() => {
      void searchWorkspaceDocuments({
        query,
        listDirectory: props.listDirectory,
        readDocument: props.readDocument,
      }).then((result) => {
        if (searchVersion.current === version) setMatches(result.matches)
      }).finally(() => {
        if (searchVersion.current === version) setSearching(false)
      })
    }, 160)
    return () => window.clearTimeout(timer)
  }, [props.listDirectory, props.readDocument, query, tab])

  const navigateHeading = (index: number) => {
    window.dispatchEvent(new CustomEvent('arkdown:navigate-heading', {
      detail: { index },
    }))
  }

  const submitNewDocument = async (event: React.FormEvent) => {
    event.preventDefault()
    let relativePath = newName.trim().replaceAll('\\', '/')
    if (!relativePath) {
      setCreateError('请输入文档名称')
      return
    }
    if (!/\.[^/]+$/.test(relativePath)) relativePath += '.md'
    setCreateError(null)
    if (await props.onCreateDocument(relativePath)) {
      setCreating(false)
      setNewName('')
    }
  }

  const currentButton = (relativePath: string) => (
    <button
      aria-current={props.currentDocument === relativePath ? 'page' : undefined}
      onClick={() => props.onOpenDocument(relativePath)}
      type="button"
    >
      <strong>{relativePath.split('/').at(-1)}</strong>
      <span>{relativePath}</span>
    </button>
  )

  return <aside className="sidebar">
    <div className="sidebar-heading">
      <button
        className="sidebar-title"
        disabled={props.isChoosing}
        onClick={() => void props.chooseWorkspace()}
        type="button"
      >
        {props.workspace?.name ?? '打开文件夹'}
      </button>
      <div aria-label="文件操作" className="workspace-actions">
        <button aria-label="新建文档" disabled={!props.workspace} onClick={() => setCreating(true)} data-tooltip="新建（Ctrl+N）" type="button">＋</button>
        <button aria-label="从磁盘重新加载" disabled={!props.currentDocument} onClick={props.onReloadDocument} data-tooltip="从磁盘重新加载" type="button">↻</button>
        <button aria-label="打开文件位置" disabled={!props.currentDocument} onClick={props.onRevealDocument} data-tooltip="打开文件位置" type="button">⌖</button>
        <button aria-label="删除当前文档" disabled={!props.currentDocument} onClick={props.onTrashDocument} data-tooltip="移入回收站" type="button">×</button>
      </div>
    </div>
    {creating && <form className="new-document-form" onSubmit={(event) => void submitNewDocument(event)}>
      <input
        aria-label="新文档名称"
        onChange={(event) => setNewName(event.target.value)}
        placeholder="名称或子目录/名称"
        ref={newDocumentInput}
        value={newName}
      />
      <button type="submit">创建</button>
      <button onClick={() => { setCreating(false); setCreateError(null) }} type="button">取消</button>
      {createError && <p role="alert">{createError}</p>}
    </form>}
    <nav aria-label="侧边栏视图" className="sidebar-tabs">
      <button aria-pressed={tab === 'files'} onClick={() => setTab('files')} type="button">文件</button>
      <button aria-pressed={tab === 'documents'} onClick={() => setTab('documents')} type="button">文档</button>
      <button aria-pressed={tab === 'outline'} onClick={() => setTab('outline')} type="button">大纲</button>
      <button aria-pressed={tab === 'search'} onClick={() => setTab('search')} type="button">搜索</button>
    </nav>
    {props.workspaceError && <p className="tree-error" role="alert">{props.workspaceError}</p>}
    {tab === 'files' && props.workspace && <FileTree
      key={props.refreshVersion}
      listDirectory={props.listDirectory}
      onOpenDocument={props.onOpenDocument}
    />}
    {tab === 'documents' && (
      documents.length
        ? <ul aria-label="工作区文档列表" className="document-list">
            {documents.map((relativePath) => <li key={relativePath}>
              {currentButton(relativePath)}
            </li>)}
          </ul>
        : <p className="sidebar-empty">工作区内没有 Markdown 文档</p>
    )}
    {tab === 'outline' && (
      outline.length
        ? <ol aria-label="文档大纲" className="outline-list">
            {outline.map((item) => <li key={`${item.index}:${item.text}`}>
              <button
                onClick={() => navigateHeading(item.index)}
                style={{ paddingLeft: `${10 + (item.depth - 1) * 12}px` }}
                type="button"
              >
                {item.text}
              </button>
            </li>)}
          </ol>
        : <p className="sidebar-empty">当前文档没有标题</p>
    )}
    {tab === 'search' && <section className="workspace-search">
      <input
        aria-label="搜索工作区"
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索文件名和正文（Ctrl+P）"
        ref={searchInput}
        type="search"
        value={query}
      />
      {searching && <p className="tree-loading">正在搜索…</p>}
      {!searching && query.trim() && matches.length === 0 && (
        <p className="sidebar-empty">没有匹配结果</p>
      )}
      <ul aria-label="工作区搜索结果" className="search-results">
        {matches.map((match) => <li key={match.relativePath}>
          <button onClick={() => props.onOpenDocument(match.relativePath)} type="button">
            <strong>{match.relativePath}</strong>
            <span>{match.preview}</span>
          </button>
        </li>)}
      </ul>
    </section>}
  </aside>
}
