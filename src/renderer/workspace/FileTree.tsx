import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { ApiResult, TreeEntry } from '../../shared/contracts'
import {
  workspaceColorMarkForPath,
  type WorkspaceColorMarksSnapshot,
} from '../../shared/workspace-color-marks'

type ListDirectory = (relativePath: string) => Promise<ApiResult<TreeEntry[]>>

const rootRequests = new WeakMap<ListDirectory, { retryVersion: number; promise: Promise<ApiResult<TreeEntry[]>> }>()

function rootRequest(listDirectory: ListDirectory, retryVersion: number): Promise<ApiResult<TreeEntry[]>> {
  const existing = rootRequests.get(listDirectory)
  if (existing && existing.retryVersion === retryVersion) return existing.promise
  const promise = listDirectory('')
  const record = { retryVersion, promise }
  rootRequests.set(listDirectory, record)
  const clear = () => { if (rootRequests.get(listDirectory) === record) rootRequests.delete(listDirectory) }
  void promise.then(clear, clear)
  return promise
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : '无法加载此文件夹。'
}

function colorFor(relativePath: string, marks: WorkspaceColorMarksSnapshot['marks'] | undefined) {
  return workspaceColorMarkForPath(marks, relativePath)
}

function markedRowProps(relativePath: string, marks: WorkspaceColorMarksSnapshot['marks'] | undefined) {
  const color = colorFor(relativePath, marks)
  return {
    'data-color-mark': color,
    style: color ? { '--tree-color-mark': color } as CSSProperties : undefined,
  }
}

function Directory({ colorMarks, entry, listDirectory, onOpenDocument }: {
  colorMarks?: WorkspaceColorMarksSnapshot['marks']
  entry: TreeEntry
  listDirectory: ListDirectory
  onOpenDocument: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<TreeEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const mounted = useRef(false)
  const loadingRef = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const loadChildren = useCallback(async () => {
    if (children !== null || loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    setError(null)
    try {
      const result = await listDirectory(entry.relativePath)
      if (!mounted.current) return
      if (result.ok) setChildren(result.value)
      else setError(result.error.message)
    } catch (error) {
      if (mounted.current) setError(messageFor(error))
    } finally {
      if (mounted.current) setLoading(false)
      loadingRef.current = false
    }
  }, [children, entry.relativePath, listDirectory])

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) void loadChildren()
  }

  return <li>
    <button className="tree-row" onClick={toggle} aria-expanded={open} {...markedRowProps(entry.relativePath, colorMarks)}>
      {colorFor(entry.relativePath, colorMarks) && <span aria-hidden="true" className="tree-color-indicator" />}
      <span className="tree-indicator" aria-hidden="true">{open ? '▾' : '▸'}</span>{entry.name}
    </button>
    {open && loading && <p className="tree-loading">正在加载…</p>}
    {open && error && <p className="tree-error" role="alert">{error} <button onClick={() => void loadChildren()}>Retry</button></p>}
    {open && children && <Tree colorMarks={colorMarks} entries={children} listDirectory={listDirectory} onOpenDocument={onOpenDocument} />}
  </li>
}

function Tree({ colorMarks, entries, listDirectory, onOpenDocument }: {
  colorMarks?: WorkspaceColorMarksSnapshot['marks']
  entries: TreeEntry[]
  listDirectory: ListDirectory
  onOpenDocument: (path: string) => void
}) {
  return <ul className="file-tree">{entries.map((entry) => entry.kind === 'directory'
    ? <Directory colorMarks={colorMarks} key={entry.relativePath} entry={entry} listDirectory={listDirectory} onOpenDocument={onOpenDocument} />
    : <li key={entry.relativePath}><button className="tree-row" onClick={() => onOpenDocument(entry.relativePath)} {...markedRowProps(entry.relativePath, colorMarks)}>{colorFor(entry.relativePath, colorMarks) && <span aria-hidden="true" className="tree-color-indicator" />}{entry.name}</button></li>
   )}</ul>
}

export function FileTree({ colorMarks, listDirectory, onOpenDocument }: {
  colorMarks?: WorkspaceColorMarksSnapshot['marks']
  listDirectory: ListDirectory
  onOpenDocument: (path: string) => void
}) {
  const [entries, setEntries] = useState<TreeEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [retryVersion, setRetryVersion] = useState(0)

  useEffect(() => {
    let active = true
    setEntries([])
    setError(null)
    setLoading(true)
    void rootRequest(listDirectory, retryVersion).then((result) => {
      if (!active) return
      if (result.ok) setEntries(result.value)
      else setError(result.error.message)
    }).catch((error: unknown) => {
      if (active) setError(messageFor(error))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [listDirectory, retryVersion])

  if (loading) return <p className="tree-loading">正在加载…</p>
  if (error) return <p className="tree-error" role="alert">{error} <button onClick={() => setRetryVersion((version) => version + 1)}>Retry</button></p>
  return <Tree colorMarks={colorMarks} entries={entries} listDirectory={listDirectory} onOpenDocument={onOpenDocument} />
}
