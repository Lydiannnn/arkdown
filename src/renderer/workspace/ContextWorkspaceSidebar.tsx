import { WORKSPACE_ENTRY_MIME, encodeWorkspaceDrag } from './workspace-drag'
import { useKeyboardShortcuts } from '../settings/use-keyboard-shortcuts'
import { matchesShortcut } from '../../shared/keyboard-shortcuts'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type {
  ApiResult,
  DocumentSnapshot,
  TreeEntry,
  WorkspaceSummary,
} from '../../shared/contracts'
import {
  workspaceColorMarkForPath,
  type WorkspaceColorMarksSnapshot,
} from '../../shared/workspace-color-marks'
import { useOptionalContextMenu } from '../context-menu/ContextMenuProvider'
import { AppIcon } from '../icons/AppIcon'
import { ArkdownDialog } from '../modal/ArkdownDialog'
import {
  ContextFileTree,
  type WorkspaceTreeLocateRequest,
} from './ContextFileTree'
import {
  buildWorkspaceMenu,
  type WorkspaceMenuTarget,
} from './workspace-menu-model'
import './workspace-sidebar.css'
import './workspace-file-actions.css'
import './workspace-context-menu.css'
import { WorkspacePickerButton } from './WorkspacePickerButton'
import {
  searchCurrentDirectoryDocuments,
  searchDescendantDocuments,
  type WorkspaceSearchMatch,
  type WorkspaceSearchResult,
} from './workspace-navigation'

type ListDirectory = (relativePath: string) => Promise<ApiResult<TreeEntry[]>>
type ReadDocument = (relativePath: string) => Promise<ApiResult<DocumentSnapshot>>
type SearchStage =
  | 'idle'
  | 'searching-current'
  | 'awaiting-descendants'
  | 'searching-descendants'
  | 'complete'

type SearchFailures = Pick<WorkspaceSearchResult, 'failedDirectories' | 'failedDocuments'>

const EMPTY_SEARCH_FAILURES: SearchFailures = {
  failedDirectories: [],
  failedDocuments: [],
}

export interface ContextWorkspaceSidebarProps {
  workspace: WorkspaceSummary | null
  chooseWorkspace(): Promise<void>
  workspaceError: string | null
  isChoosing: boolean
  listDirectory: ListDirectory
  readDocument: ReadDocument
  markdown: string
  currentDocument: string | null
  refreshVersion: number
  locateRequest?: WorkspaceTreeLocateRequest | null
  onLocateComplete?(version: number): void
  onOpenDocument(relativePath: string, contentQuery?: string): void
  onCreateDocument(relativePath: string): Promise<boolean>
  onReloadDocument(): void
  onRevealDocument(): void
  onTrashDocument(): void
  onWorkspaceMenuCommand(command: string, target: WorkspaceMenuTarget): Promise<void>
  colorMarks?: WorkspaceColorMarksSnapshot['marks']
}

function documentTarget(relativePath: string): WorkspaceMenuTarget {
  return {
    kind: 'document',
    name: relativePath.split('/').at(-1) ?? relativePath,
    relativePath,
  }
}

export function ContextWorkspaceSidebar(props: ContextWorkspaceSidebarProps) {
  const { snapshot: shortcutSnapshot } = useKeyboardShortcuts()
  const contextMenu = useOptionalContextMenu()
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [matches, setMatches] = useState<WorkspaceSearchMatch[]>([])
  const [searchStage, setSearchStage] = useState<SearchStage>('idle')
  const [currentSearchFailures, setCurrentSearchFailures] = useState<SearchFailures>(EMPTY_SEARCH_FAILURES)
  const [descendantSearchFailures, setDescendantSearchFailures] = useState<SearchFailures>(EMPTY_SEARCH_FAILURES)
  const [searchAttempt, setSearchAttempt] = useState(0)
  const [directScannedDocuments, setDirectScannedDocuments] = useState(0)
  const [searchLimitExceeded, setSearchLimitExceeded] = useState(false)
  const [contextPath, setContextPath] = useState<string | null>(null)
  const [selectedDirectory, setSelectedDirectory] = useState('')
  const searchVersion = useRef(0)
  const searchIdentity = useRef('')
  const directMatches = useRef<WorkspaceSearchMatch[]>([])
  const descendantsRequested = useRef(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const searchTrigger = useRef<HTMLButtonElement>(null)
  const searchLimitConfirm = useRef<HTMLButtonElement>(null)
  const scrollPositions = useRef({ files: 0, documents: 0, outline: 0, search: 0 })
  const filesScrollRef = useCallback((node: HTMLElement | null) => {
    if (node) node.scrollTop = scrollPositions.current.files
  }, [])
  const searchScrollRef = useCallback((node: HTMLElement | null) => {
    if (node) node.scrollTop = scrollPositions.current.search
  }, [])

  const closeSearch = useCallback(() => {
    searchVersion.current += 1
    searchIdentity.current = ''
    descendantsRequested.current = false
    setQuery('')
    setSubmittedQuery('')
    setMatches([])
    setSearchStage('idle')
    setCurrentSearchFailures(EMPTY_SEARCH_FAILURES)
    setDescendantSearchFailures(EMPTY_SEARCH_FAILURES)
    setDirectScannedDocuments(0)
    setSearchLimitExceeded(false)
    setSearchOpen(false)
  }, [])

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus()
  }, [searchOpen])

  useEffect(() => {
    if (!searchOpen) return
    const closeSearchOnEscape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape'
        || event.defaultPrevented
        || document.querySelector('[aria-modal="true"], [role="menu"]')
      ) return
      event.preventDefault()
      searchTrigger.current?.focus()
      closeSearch()
    }
    window.addEventListener('keydown', closeSearchOnEscape)
    return () => window.removeEventListener('keydown', closeSearchOnEscape)
  }, [closeSearch, searchOpen])

  useEffect(() => {
    setSelectedDirectory('')
  }, [props.workspace?.absolutePath])

  useEffect(() => {
    if (!selectedDirectory || !props.workspace) return
    let active = true
    void props.listDirectory(selectedDirectory).then((result) => {
      if (active && !result.ok) setSelectedDirectory('')
    }).catch(() => {
      if (active) setSelectedDirectory('')
    })
    return () => { active = false }
  }, [props.refreshVersion])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (window.arkdown?.onMenuCommand) return
      if (document.querySelector('[aria-modal="true"]')) return
      if (shortcutSnapshot.revision < 0 && window.arkdown?.getKeyboardShortcuts) return
      if (matchesShortcut(event, 'workspace.search', shortcutSnapshot.bindings)) {
        event.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    const detach = window.arkdown?.onMenuCommand?.(command => {
      if (command === 'search-workspace' && !document.querySelector('[aria-modal="true"]')) setSearchOpen(true)
    })
    return () => { window.removeEventListener('keydown', onKeyDown); detach?.() }
  }, [shortcutSnapshot])

  const runDescendantSearch = useCallback((
    version: number,
    directSearchMatches: WorkspaceSearchMatch[],
    scannedDocuments: number,
    preserveResults: boolean,
  ) => {
    setSearchStage('searching-descendants')
    setDescendantSearchFailures(EMPTY_SEARCH_FAILURES)
    void searchDescendantDocuments({
      query: submittedQuery,
      listDirectory: props.listDirectory,
      readDocument: props.readDocument,
      root: selectedDirectory,
      remainingLimit: Math.max(0, 500 - scannedDocuments),
      onProgress: (result) => {
        if (searchVersion.current !== version) return
        if (!preserveResults) setMatches([...directSearchMatches, ...result.matches])
        setSearchLimitExceeded(result.truncated)
      },
    }).then((result) => {
      if (searchVersion.current !== version) return
      setMatches([...directSearchMatches, ...result.matches])
      setDescendantSearchFailures({
        failedDirectories: result.failedDirectories,
        failedDocuments: result.failedDocuments,
      })
      setSearchLimitExceeded(result.truncated)
      setSearchStage('complete')
    }).catch(() => {
      if (searchVersion.current !== version) return
      setDescendantSearchFailures({ failedDirectories: [selectedDirectory], failedDocuments: [] })
      setSearchStage('complete')
    })
  }, [props.listDirectory, props.readDocument, selectedDirectory, submittedQuery])

  useEffect(() => {
    if (!searchOpen || !props.workspace || !submittedQuery) return
    const identity = [
      props.workspace.absolutePath,
      selectedDirectory,
      submittedQuery,
    ].join('\u0000')
    const retryingSameSearch = searchIdentity.current === identity
    searchIdentity.current = identity
    const version = ++searchVersion.current
    setSearchStage('searching-current')
    if (!retryingSameSearch) {
      directMatches.current = []
      descendantsRequested.current = false
      setMatches([])
    }
    setCurrentSearchFailures(EMPTY_SEARCH_FAILURES)
    setDescendantSearchFailures(EMPTY_SEARCH_FAILURES)
    setDirectScannedDocuments(0)
    setSearchLimitExceeded(false)
    void searchCurrentDirectoryDocuments({
      query: submittedQuery,
      listDirectory: props.listDirectory,
      readDocument: props.readDocument,
      root: selectedDirectory,
    }).then((result) => {
      if (searchVersion.current !== version) return
      directMatches.current = result.matches
      setCurrentSearchFailures({
        failedDirectories: result.failedDirectories,
        failedDocuments: result.failedDocuments,
      })
      setDirectScannedDocuments(result.scannedDocuments)
      setSearchLimitExceeded(result.truncated)
      if (descendantsRequested.current && result.hasDescendants && !result.truncated) {
        runDescendantSearch(version, result.matches, result.scannedDocuments, true)
        return
      }
      if (!result.failedDirectories.includes(selectedDirectory)) setMatches(result.matches)
      setSearchStage(
        result.hasDescendants && !result.truncated
          ? 'awaiting-descendants'
          : 'complete',
      )
    }).catch(() => {
      if (searchVersion.current !== version) return
      setCurrentSearchFailures({
        failedDirectories: [selectedDirectory],
        failedDocuments: [],
      })
      setSearchStage('complete')
    })
  }, [
    props.listDirectory,
    props.readDocument,
    props.workspace,
    selectedDirectory,
    searchAttempt,
    submittedQuery,
    searchOpen,
    runDescendantSearch,
  ])

  const searchDescendants = useCallback(() => {
    if (
      (
        searchStage !== 'awaiting-descendants'
        && !(
          searchStage === 'complete'
          && descendantSearchFailures.failedDirectories.length
            + descendantSearchFailures.failedDocuments.length > 0
        )
      )
      || !props.workspace
      || !submittedQuery
    ) return
    const version = ++searchVersion.current
    const directSearchMatches = [...directMatches.current]
    const retryingFailedDescendants = descendantSearchFailures.failedDirectories.length
      + descendantSearchFailures.failedDocuments.length > 0
    descendantsRequested.current = true
    runDescendantSearch(version, directSearchMatches, directScannedDocuments, retryingFailedDescendants)
  }, [
    descendantSearchFailures,
    directScannedDocuments,
    props.listDirectory,
    props.readDocument,
    props.workspace,
    searchStage,
    selectedDirectory,
    submittedQuery,
    runDescendantSearch,
  ])

  const failedDirectoryCount = currentSearchFailures.failedDirectories.length
    + descendantSearchFailures.failedDirectories.length
  const failedDocumentCount = currentSearchFailures.failedDocuments.length
    + descendantSearchFailures.failedDocuments.length
  const hasSearchFailures = failedDirectoryCount + failedDocumentCount > 0
  const currentDirectoryFailedEntirely = currentSearchFailures.failedDirectories.includes(selectedDirectory)
    && directScannedDocuments === 0
    && matches.length === 0
  const searchFailureMessage = currentDirectoryFailedEntirely
    ? '当前文件夹搜索失败'
    : [
        failedDirectoryCount ? `${failedDirectoryCount} 个文件夹无法搜索` : '',
        failedDocumentCount ? `${failedDocumentCount} 个文档无法读取` : '',
      ].filter(Boolean).join('，') + '，结果可能不完整'

  const retrySearch = useCallback(() => {
    const currentFailed = currentSearchFailures.failedDirectories.length + currentSearchFailures.failedDocuments.length > 0
    if (!currentFailed && descendantSearchFailures.failedDirectories.length + descendantSearchFailures.failedDocuments.length > 0) {
      searchDescendants()
      return
    }
    setSearchAttempt((attempt) => attempt + 1)
  }, [currentSearchFailures, descendantSearchFailures, searchDescendants])

  const openContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    target: WorkspaceMenuTarget,
  ) => {
    if (!contextMenu) return
    event.preventDefault()
    event.stopPropagation()
    const restoreTarget = event.currentTarget
    setContextPath(target.relativePath || null)
    contextMenu.openMenu({
      x: event.clientX,
      y: event.clientY,
      items: buildWorkspaceMenu(
        target,
        target.kind === 'root'
          ? undefined
          : workspaceColorMarkForPath(props.colorMarks, target.relativePath),
      ),
      execute: (command) => props.onWorkspaceMenuCommand(command, target),
      onClose: () => setContextPath(null),
      restoreFocus: () => restoreTarget.focus(),
    })
  }

  const rootTarget = (): WorkspaceMenuTarget => ({
    kind: 'root',
    name: props.workspace?.name ?? '工作区',
    relativePath: '',
  })

  return <aside className="sidebar" onDragStart={(event) => {
    const row = (event.target as Element).closest<HTMLElement>('[data-entry-path]')
    if (!row || !props.workspace) return
    event.dataTransfer.effectAllowed = 'link'
    event.dataTransfer.setData(WORKSPACE_ENTRY_MIME, encodeWorkspaceDrag(props.workspace.absolutePath,
      row.dataset.entryPath!, row.dataset.entryKind!))
  }}>
    <div className="sidebar-heading">
      <WorkspacePickerButton
        disabled={props.isChoosing}
        chooseWorkspace={props.chooseWorkspace}
        name={props.workspace?.name ?? '选择工作区'}
      />
      <div aria-label="文件操作" className="workspace-actions">
        <button
          aria-label="搜索工作区"
          aria-pressed={searchOpen}
          disabled={!props.workspace}
          onClick={() => {
            if (searchOpen) closeSearch()
            else setSearchOpen(true)
          }}
          data-tooltip="搜索工作区"
          ref={searchTrigger}
          type="button"
        >
          <AppIcon name="search" size={16} />
        </button>
        <button
          aria-label="从磁盘重新加载"
          disabled={!props.workspace}
          onClick={props.onReloadDocument}
          data-tooltip="从磁盘重新加载"
          type="button"
        >
          <AppIcon name="reload" size={16} />
        </button>
      </div>
    </div>
    {props.workspaceError && <p className="tree-error" role="alert">{props.workspaceError}</p>}
    {props.workspace && <section
      className="workspace-tree-context"
      hidden={searchOpen}
      onContextMenu={(event) => openContextMenu(event, rootTarget())}
      onScroll={(event) => { scrollPositions.current.files = event.currentTarget.scrollTop }}
      ref={filesScrollRef}
    >
      <ContextFileTree
        key={props.workspace.absolutePath}
        workspaceRoot={props.workspace.absolutePath}
        activePath={props.currentDocument}
        colorMarks={props.colorMarks}
        contextPath={contextPath}
        listDirectory={props.listDirectory}
        locateRequest={props.locateRequest}
        onEntryContextMenu={openContextMenu}
        onLocateComplete={props.onLocateComplete}
        onOpenDocument={props.onOpenDocument}
        refreshVersion={props.refreshVersion}
        selectedDirectory={selectedDirectory}
        onDirectoryToggle={(path, open) => {
          if (open) {
            setSelectedDirectory(path)
            return
          }
          setSelectedDirectory((selected) => (
            selected === path || selected.startsWith(`${path}/`) ? '' : selected
          ))
        }}
      />
    </section>}
    {searchOpen && <section
      className="workspace-search"
      onBlur={(event) => {
        if (event.relatedTarget === searchTrigger.current) return
        if (!query.trim() && !event.currentTarget.contains(event.relatedTarget)) closeSearch()
      }}
      onScroll={(event) => { scrollPositions.current.search = event.currentTarget.scrollTop }}
      ref={searchScrollRef}
    >
      <form onSubmit={(event) => {
        event.preventDefault()
        const next = query.trim()
        if (!next) {
          closeSearch()
          return
        }
        setSearchLimitExceeded(false)
        if (next === submittedQuery && hasSearchFailures) {
          retrySearch()
          return
        }
        setSubmittedQuery(next)
        setSearchAttempt((attempt) => attempt + 1)
      }}>
        <span className="workspace-search-field">
          <AppIcon name="search" size={15} />
          <input
            aria-label="搜索工作区"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="输入关键字后按回车"
            ref={searchInput}
            type="search"
            value={query}
          />
          {(submittedQuery || searchStage !== 'idle' || matches.length > 0) && <button
            aria-label="取消搜索"
            onClick={closeSearch}
            data-tooltip="取消搜索"
            type="button"
          >
            ×
          </button>}
        </span>
        <div className="workspace-search-submit"><button type="submit" disabled={!query.trim()}>搜索</button></div>
      </form>
      {selectedDirectory && <p className="search-scope">搜索范围：{selectedDirectory}</p>}
      {searchStage === 'searching-current' && <p className="tree-loading">正在搜索…</p>}
      {hasSearchFailures && searchStage !== 'searching-current' && searchStage !== 'searching-descendants' && (
        <div className="search-failure" role="alert">
          <span>{searchFailureMessage}</span>
        </div>
      )}
      {searchStage === 'awaiting-descendants' && matches.length === 0 && !hasSearchFailures && (
        <p className="sidebar-empty">当前文件夹没有匹配结果</p>
      )}
      {searchStage === 'complete' && submittedQuery && matches.length === 0 && !hasSearchFailures && (
        <p className="sidebar-empty">没有匹配结果</p>
      )}
      <ul aria-label="工作区搜索结果" className="search-results">
        {matches.map((match) => <li key={match.relativePath}>
          <button
            onClick={() => match.contentMatches
              ? props.onOpenDocument(match.relativePath, submittedQuery)
              : props.onOpenDocument(match.relativePath)}
            onContextMenu={(event) => openContextMenu(event, documentTarget(match.relativePath))}
            type="button"
          >
            <strong>{match.title}</strong>
            <small>{match.relativePath}</small>
            <span>{match.preview}</span>
          </button>
        </li>)}
      </ul>
      {searchStage === 'awaiting-descendants' && (
        <button
          className="search-more-directories"
          onClick={searchDescendants}
          type="button"
        >
          搜索更多层级文件夹
        </button>
      )}
      {searchStage === 'searching-descendants' && (
        <button className="search-more-directories" disabled type="button">
          正在搜索更多层级文件夹…
        </button>
      )}
    </section>}
    {searchLimitExceeded && (
      <ArkdownDialog
        actions={({ requestClose }) => <button
          className="arkdown-dialog__primary"
          onClick={() => requestClose(() => setSearchLimitExceeded(false))}
          ref={searchLimitConfirm}
          type="button"
        >确定</button>}
        cancelOnBackdrop={false}
        className="workspace-search-limit-dialog"
        description="文件超过500个，请缩小搜索范围"
        initialFocusRef={searchLimitConfirm}
        onCancel={() => setSearchLimitExceeded(false)}
        role="alertdialog"
        size="small"
        title="搜索范围过大"
      />
    )}
  </aside>
}
