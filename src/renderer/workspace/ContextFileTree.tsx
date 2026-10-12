import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { ApiResult, TreeEntry } from '../../shared/contracts'
import { fileIconKindForPath } from '../../shared/file-icon-kind'
import { isVisibleWorkspacePath } from '../../shared/document-types'
import { WorkspaceFileDragButton } from './WorkspaceFileDragButton'
import './workspace-file-drag.css'
import { FileTypeIcon } from '../icons/FileTypeIcon'
import {
  workspaceColorMarkForPath,
  type WorkspaceColorMarksSnapshot,
} from '../../shared/workspace-color-marks'

type ListDirectory = (relativePath: string) => Promise<ApiResult<TreeEntry[]>>

export interface WorkspaceTreeLocateRequest {
  relativePath: string
  version: number
}

interface TreeProps {
  workspaceRoot?: string
  entries: TreeEntry[]
  listDirectory: ListDirectory
  onOpenDocument(path: string): void
  onEntryContextMenu(event: ReactMouseEvent<HTMLElement>, entry: TreeEntry): void
  selectedDirectory: string
  onDirectoryToggle?(path: string, open: boolean): void
  activePath: string | null
  contextPath: string | null
  colorMarks?: WorkspaceColorMarksSnapshot['marks']
  locateRequest?: WorkspaceTreeLocateRequest | null
  onLocateComplete?(version: number): void
  refreshVersion?: number
  depth?: number
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : '无法加载此文件夹。'
}

function colorFor(
  relativePath: string,
  marks: WorkspaceColorMarksSnapshot['marks'] | undefined,
) {
  return workspaceColorMarkForPath(marks, relativePath)
}

function rowStyle(depth: number, colorMark: string | undefined): CSSProperties {
  return {
    '--tree-depth': depth,
    ...(colorMark ? { '--tree-color-mark': colorMark } : {}),
  } as CSSProperties
}

function Directory({
  entry,
  workspaceRoot,
  listDirectory,
  onOpenDocument,
  onEntryContextMenu,
  selectedDirectory,
  onDirectoryToggle,
  activePath,
  contextPath,
  colorMarks,
  locateRequest,
  onLocateComplete,
  refreshVersion = 0,
  depth = 0,
}: Omit<TreeProps, 'entries'> & { entry: TreeEntry }) {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<TreeEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const mounted = useRef(true)
  const loadRequest = useRef(0)
  const observedRefreshVersion = useRef(refreshVersion)
  const row = useRef<HTMLButtonElement>(null)
  const colorMark = colorFor(entry.relativePath, colorMarks)

  useEffect(() => () => { mounted.current = false }, [])

  const load = useCallback(async () => {
    const request = ++loadRequest.current
    setLoading(true)
    setError(null)
    try {
      const result = await listDirectory(entry.relativePath)
      if (!mounted.current || loadRequest.current !== request) return
      if (result.ok) setChildren(result.value)
      else setError(result.error.message)
    } catch (caught) {
      if (mounted.current && loadRequest.current === request) setError(messageFor(caught))
    } finally {
      if (mounted.current && loadRequest.current === request) setLoading(false)
    }
  }, [entry.relativePath, listDirectory])

  useEffect(() => {
    if (observedRefreshVersion.current === refreshVersion) return
    observedRefreshVersion.current = refreshVersion
    if (open || children !== null) void load()
  }, [children, load, open, refreshVersion])

  useEffect(() => {
    if (!locateRequest?.relativePath.startsWith(`${entry.relativePath}/`)) return
    setOpen(true)
    void load()
  }, [entry.relativePath, load, locateRequest?.relativePath, locateRequest?.version])

  useEffect(() => {
    if (locateRequest?.relativePath !== entry.relativePath) return
    row.current?.scrollIntoView?.({ block: 'center' })
    row.current?.focus({ preventScroll: true })
    onLocateComplete?.(locateRequest.version)
  }, [
    entry.relativePath,
    locateRequest?.relativePath,
    locateRequest?.version,
    onLocateComplete,
  ])

  const toggle = () => {
    setOpen((current) => {
      const next = !current
      onDirectoryToggle?.(entry.relativePath, next)
      if (next && children === null) void load()
      return next
    })
  }

  return <li>
    <button
      aria-expanded={open}
      className="tree-row"
      draggable
      data-entry-path={entry.relativePath}
      data-entry-kind={entry.kind}
      data-context-selected={contextPath === entry.relativePath || undefined}
      data-located={locateRequest?.relativePath === entry.relativePath || undefined}
      data-directory-selected={open && selectedDirectory === entry.relativePath || undefined}
      data-color-mark={colorMark}
      onClick={toggle}
      onContextMenu={(event) => onEntryContextMenu(event, entry)}
      ref={row}
      style={rowStyle(depth, colorMark)}
      type="button"
    >
      <span className="tree-row-content">
        {colorMark && <span aria-hidden="true" className="tree-color-indicator" />}
        <FileTypeIcon folderOpen={open} kind="folder" />
        <span className="tree-row-label">{entry.name}</span>
      </span>
    </button>
    {open && loading && <p className="tree-loading">正在加载…</p>}
    {open && error && <p className="tree-error" role="alert">{error}</p>}
    {open && children && <Tree
      workspaceRoot={workspaceRoot}
      activePath={activePath}
      contextPath={contextPath}
      colorMarks={colorMarks}
      entries={children}
      listDirectory={listDirectory}
      locateRequest={locateRequest}
      onEntryContextMenu={onEntryContextMenu}
      onLocateComplete={onLocateComplete}
      onOpenDocument={onOpenDocument}
      refreshVersion={refreshVersion}
      selectedDirectory={selectedDirectory}
      onDirectoryToggle={onDirectoryToggle}
      depth={depth + 1}
    />}
  </li>
}

function Document({
  entry,
  workspaceRoot,
  activePath,
  contextPath,
  colorMarks,
  locateRequest,
  onEntryContextMenu,
  onLocateComplete,
  onOpenDocument,
  depth = 0,
}: Pick<
  TreeProps,
  | 'workspaceRoot'
  | 'activePath'
  | 'contextPath'
  | 'colorMarks'
  | 'locateRequest'
  | 'onEntryContextMenu'
  | 'onLocateComplete'
  | 'onOpenDocument'
  | 'depth'
> & { entry: TreeEntry }) {
  const row = useRef<HTMLButtonElement>(null)
  const colorMark = colorFor(entry.relativePath, colorMarks)

  useEffect(() => {
    if (locateRequest?.relativePath !== entry.relativePath) return
    row.current?.scrollIntoView?.({ block: 'center' })
    row.current?.focus({ preventScroll: true })
    onLocateComplete?.(locateRequest.version)
  }, [
    entry.relativePath,
    locateRequest?.relativePath,
    locateRequest?.version,
    onLocateComplete,
  ])

  return <li>
    <div className="workspace-file-row">
    <button
      aria-current={activePath === entry.relativePath ? 'page' : undefined}
      className="tree-row"
      draggable
      data-entry-path={entry.relativePath}
      data-entry-kind={entry.kind}
      data-context-selected={contextPath === entry.relativePath || undefined}
      data-located={locateRequest?.relativePath === entry.relativePath || undefined}
      data-color-mark={colorMark}
      onClick={() => onOpenDocument(entry.relativePath)}
      onContextMenu={(event) => onEntryContextMenu(event, entry)}
      ref={row}
      style={rowStyle(depth, colorMark)}
      type="button"
    >
      <span className="tree-row-content">
        {colorMark && <span aria-hidden="true" className="tree-color-indicator" />}
        <FileTypeIcon kind={fileIconKindForPath(entry.relativePath)} />
        <span className="tree-row-label">{entry.name}</span>
      </span>
    </button>
    {workspaceRoot && entry.relativePath && isVisibleWorkspacePath(entry.relativePath) && <WorkspaceFileDragButton
      key={`${workspaceRoot}:${entry.relativePath}`} workspace={workspaceRoot} relativePath={entry.relativePath} name={entry.name} />}
    </div>
  </li>
}

function Tree(props: TreeProps) {
  const depth = props.depth ?? 0
  const tree = useRef<HTMLUListElement>(null)
  const keyboardNavigation = useRef(false)
  useEffect(() => {
    if (depth !== 0 || !keyboardNavigation.current) return
    const focused = document.activeElement
    if (!(focused instanceof Element)
      || !focused.matches('.tree-row[data-entry-kind="document"]')
      || !tree.current?.contains(focused)) return
    // A cancelled/failed open restores activePath. Follow it without stealing
    // focus from the editor or a modal that is still handling the transition.
    const current = tree.current.querySelector<HTMLButtonElement>('.tree-row[aria-current="page"]')
    if (current && current !== focused) {
      current.focus({ preventScroll: true })
      current.scrollIntoView?.({ block: 'nearest' })
    }
  }, [depth, props.activePath])
  const navigateDocuments = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    const row = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('.tree-row[data-entry-kind="document"]')
      : null
    if (!row) return
    // Only mounted rows participate: collapsed descendants are not navigable.
    const documents = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '.tree-row[data-entry-kind="document"]',
    ))
    const index = documents.indexOf(row)
    if (index < 0) return
    event.preventDefault()
    const next = documents[index + (event.key === 'ArrowDown' ? 1 : -1)]
    if (!next) return
    keyboardNavigation.current = true
    next.focus({ preventScroll: true })
    next.scrollIntoView?.({ block: 'nearest' })
    props.onOpenDocument(next.dataset.entryPath!)
  }
  return <ul className="file-tree" ref={tree}
    onKeyDown={depth === 0 ? navigateDocuments : undefined}
    onPointerDown={depth === 0 ? () => { keyboardNavigation.current = false } : undefined}>
    {props.entries.map((entry) => entry.kind === 'directory'
      ? <Directory
          workspaceRoot={props.workspaceRoot}
          activePath={props.activePath}
          contextPath={props.contextPath}
          colorMarks={props.colorMarks}
          entry={entry}
          key={entry.relativePath}
          listDirectory={props.listDirectory}
          locateRequest={props.locateRequest}
          onEntryContextMenu={props.onEntryContextMenu}
          onLocateComplete={props.onLocateComplete}
          onOpenDocument={props.onOpenDocument}
          refreshVersion={props.refreshVersion}
          selectedDirectory={props.selectedDirectory}
          onDirectoryToggle={props.onDirectoryToggle}
          depth={depth}
        />
      : <Document
          workspaceRoot={props.workspaceRoot}
          activePath={props.activePath}
          contextPath={props.contextPath}
          colorMarks={props.colorMarks}
          entry={entry}
          key={entry.relativePath}
          locateRequest={props.locateRequest}
          onEntryContextMenu={props.onEntryContextMenu}
          onLocateComplete={props.onLocateComplete}
          onOpenDocument={props.onOpenDocument}
          depth={depth}
        />)}
  </ul>
}

export function ContextFileTree(props: Omit<TreeProps, 'entries'>) {
  const [entries, setEntries] = useState<TreeEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const listDirectorySource = useRef(props.listDirectory)

  useEffect(() => {
    let active = true
    const sourceChanged = listDirectorySource.current !== props.listDirectory
    listDirectorySource.current = props.listDirectory
    if (sourceChanged) {
      setEntries([])
      setError(null)
      setLoading(true)
    }
    void props.listDirectory('').then((result) => {
      if (!active) return
      if (result.ok) {
        setEntries(result.value)
        setError(null)
      }
      else setError(result.error.message)
    }).catch((caught: unknown) => {
      if (active) setError(messageFor(caught))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [props.listDirectory, props.refreshVersion])

  if (loading) return <p className="tree-loading">正在加载…</p>
  if (error) return <p className="tree-error" role="alert">{error}</p>
  return <Tree entries={entries} {...props} />
}
