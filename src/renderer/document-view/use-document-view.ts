import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { DocumentViewApi, DocumentViewResult } from '../../shared/document-view'
import { parseDocumentViewLink } from '../../shared/document-view-link'

export interface DocumentViewEntry {
  id: string
  absolutePath: string
  displayName: string
  result: DocumentViewResult
  scrollTop: number
}

interface NavigationState {
  entries: DocumentViewEntry[]
  loading: boolean
  error: string | null
  changed: boolean
  missing: boolean
  anchor?: string
  line?: number
  navigationVersion: number
}

export interface UseDocumentViewOptions {
  api: DocumentViewApi | undefined
  sourceKey: string
  sourcePath: string | null
  sourceName: string
  onOpenView(): void
  onReturnToSource(location?: DocumentViewLocation): void
}

export interface DocumentViewLocation {
  anchor?: string
  line?: number
}

const initialState = (): NavigationState => ({ entries: [], loading: false, error: null, changed: false, missing: false, navigationVersion: 0 })
const pathKey = (path: string) => path.replaceAll('/', '\\').toLocaleLowerCase('en-US')
const entryFor = (result: DocumentViewResult): DocumentViewEntry => {
  const { id, absolutePath, displayName } = result.kind === 'document' ? result.document : result
  return { id, absolutePath, displayName, result, scrollTop: 0 }
}
const MAX_HISTORY_ENTRIES = 32
const MAX_HISTORY_TEXT_BYTES = 16 * 1024 * 1024

function boundedHistory(entries: DocumentViewEntry[]): DocumentViewEntry[] {
  let textBytes = 0
  let start = entries.length
  while (start > 0 && entries.length - start < MAX_HISTORY_ENTRIES) {
    const entry = entries[start - 1]!
    const bytes = entry.result.kind === 'document' ? entry.result.document.text.length * 2 : 0
    if (start < entries.length && textBytes + bytes > MAX_HISTORY_TEXT_BYTES) break
    textBytes += bytes
    start -= 1
  }
  return entries.slice(start)
}

export function useDocumentView(options: UseDocumentViewOptions) {
  const [state, setState] = useState<NavigationState>(initialState)
  const stateRef = useRef(state)
  stateRef.current = state
  const optionsRef = useRef(options)
  optionsRef.current = options
  const requestVersion = useRef(0)
  const sourceVersion = `${options.sourceKey}\0${options.sourcePath ?? ''}`
  const sourceRef = useRef(sourceVersion)
  // Invalidate during render, before an old promise can settle between render and effects.
  if (sourceRef.current !== sourceVersion) {
    sourceRef.current = sourceVersion
    requestVersion.current += 1
  }
  useLayoutEffect(() => { setState(initialState()) }, [sourceVersion])
  useLayoutEffect(() => () => { requestVersion.current += 1 }, [])

  const reportError = useCallback((error: string) => setState((current) => ({ ...current, error, loading: false })), [])
  const select = useCallback((id: string, location?: DocumentViewLocation) => {
    requestVersion.current += 1
    if (id === 'source') {
      // Focusing the editor is not a new source session. Keep the reading pane
      // usable, including its scroll position, when a link/crumb returns here.
      setState((current) => ({ ...current, loading: false, error: null, anchor: undefined, line: undefined }))
      optionsRef.current.onReturnToSource(location)
      return
    }
    setState((current) => {
      const index = current.entries.findIndex((entry) => entry.id === id)
      return index < 0 ? current : { ...current, entries: current.entries.slice(0, index + 1), error: null, changed: false, missing: false, loading: false, anchor: undefined, line: undefined, navigationVersion: current.navigationVersion + 1 }
    })
  }, [])

  const navigate = useCallback(async (href: string, sourceId?: string) => {
    const parsed = parseDocumentViewLink(href)
    if (!parsed) return
    optionsRef.current.onOpenView()
    if (parsed.kind === 'anchor') {
      requestVersion.current += 1
      setState((current) => ({ ...current, loading: false, error: null, anchor: parsed.anchor, line: undefined, navigationVersion: current.navigationVersion + 1 }))
      return
    }
    const version = ++requestVersion.current
    const { api, sourcePath } = optionsRef.current
    if (!api) { reportError('文档查看暂不可用'); return }
    setState((current) => ({ ...current, loading: true, error: null }))
    try {
      const activeIds = stateRef.current.entries.map((entry) => entry.id)
      const response = await api.navigateDocumentView({ href, ...(sourceId ? { sourceId } : {}), ...(activeIds.length ? { activeIds } : {}) })
      if (version !== requestVersion.current) return
      if (!response.ok) { reportError(response.error.message); return }
      const entry = entryFor(response.value)
      if (sourcePath && pathKey(entry.absolutePath) === pathKey(sourcePath)) {
        const snapshot = response.value.kind === 'document' ? response.value.document : undefined
        select('source', snapshot && (snapshot.anchor || snapshot.line)
          ? { anchor: snapshot.anchor, line: snapshot.line } : undefined)
        return
      }
      setState((current) => {
        const sourceIndex = sourceId ? current.entries.findIndex((item) => item.id === sourceId) : -1
        const branch = current.entries.slice(0, sourceIndex + 1)
        const index = branch.findIndex((item) => pathKey(item.absolutePath) === pathKey(entry.absolutePath))
        // Re-read cycles keep the old reading position but use the returned revision/text together.
        const entries = boundedHistory(index < 0 ? [...branch, entry]
          : [...branch.slice(0, index), { ...entry, scrollTop: branch[index]!.scrollTop }])
        return { entries, loading: false, error: null, changed: false, missing: false, anchor: response.value.kind === 'document' ? response.value.document.anchor : undefined, line: response.value.kind === 'document' ? response.value.document.line : undefined, navigationVersion: current.navigationVersion + 1 }
      })
    } catch {
      if (version === requestVersion.current) reportError('无法读取目标，请重试')
    }
  }, [reportError, select])

  const openLink = useCallback(async (href: string) => {
    const parsed = parseDocumentViewLink(href)
    if (!parsed) return
    if (parsed.kind === 'anchor') { await navigate(href); return }
    const current = stateRef.current.entries.at(-1)
    const { api, sourcePath } = optionsRef.current
    if (!current || !api) return
    const version = ++requestVersion.current
    setState((state) => ({ ...state, loading: true, error: null }))
    try {
      // Resolve against the main-owned preview token, never a renderer-supplied
      // path. Opening its successor must not replace the displayed snapshot.
      const response = await api.navigateDocumentView({ href, sourceId: current.id, activeIds: stateRef.current.entries.map((entry) => entry.id) })
      if (version !== requestVersion.current) return
      if (!response.ok) { reportError(response.error.message); return }
      const target = entryFor(response.value)
      if (sourcePath && pathKey(target.absolutePath) === pathKey(sourcePath)) {
        const snapshot = response.value.kind === 'document' ? response.value.document : undefined
        select('source', snapshot && (snapshot.anchor || snapshot.line)
          ? { anchor: snapshot.anchor, line: snapshot.line } : undefined)
        return
      }
      const opened = await api.openDocumentView(target.id)
      if (version !== requestVersion.current) return
      if (!opened.ok) { reportError(opened.error.message); return }
      setState((state) => ({ ...state, loading: false }))
    } catch {
      if (version === requestVersion.current) reportError('无法打开目标，请重试')
    }
  }, [navigate, reportError, select])

  const back = useCallback(() => {
    const entries = stateRef.current.entries
    select(entries.length > 1 ? entries[entries.length - 2]!.id : 'source')
  }, [select])

  const setScroll = useCallback((scrollTop: number) => {
    setState((current) => ({ ...current, entries: current.entries.map((entry, index) => index === current.entries.length - 1 ? { ...entry, scrollTop } : entry) }))
  }, [])

  const consumeLocation = useCallback(() => {
    setState((current) => current.anchor === undefined && current.line === undefined
      ? current : { ...current, anchor: undefined, line: undefined })
  }, [])

  const refresh = useCallback(async () => {
    const entry = stateRef.current.entries.at(-1)
    const api = optionsRef.current.api
    if (!api || entry?.result.kind !== 'document') return
    const version = ++requestVersion.current
    setState((current) => ({ ...current, loading: true, error: null }))
    try {
      const response = await api.refreshDocumentView(entry.id)
      if (version !== requestVersion.current) return
      if (!response.ok) { reportError(response.error.message); return }
      setState((current) => ({ ...current, entries: boundedHistory(current.entries.map((item) => item.id === entry.id ? { ...entryFor({ kind: 'document', document: response.value }), scrollTop: item.scrollTop } : item)), loading: false, changed: false, missing: false, anchor: undefined, line: undefined, navigationVersion: current.navigationVersion + 1 }))
    } catch {
      if (version === requestVersion.current) reportError('无法刷新目标，请重试')
    }
  }, [reportError])

  const checkForChanges = useCallback(async () => {
    const entry = stateRef.current.entries.at(-1)
    const api = optionsRef.current.api
    const version = requestVersion.current
    if (!api || !entry) return
    try {
      const response = await api.inspectDocumentView(entry.id)
      if (version !== requestVersion.current || stateRef.current.entries.at(-1)?.id !== entry.id) return
      if (!response.ok) { reportError(response.error.message); return }
      setState((current) => ({ ...current, changed: response.value.changed, missing: !response.value.exists }))
    } catch {
      if (version === requestVersion.current) reportError('无法检查目标是否已更改')
    }
  }, [reportError])

  const open = useCallback(async (id?: string) => {
    if (id === 'source') { optionsRef.current.onReturnToSource(); return }
    const target = id ?? stateRef.current.entries.at(-1)?.id
    const version = requestVersion.current
    if (!target || !optionsRef.current.api) return
    try {
      const response = await optionsRef.current.api.openDocumentView(target)
      if (version === requestVersion.current && !response.ok) reportError(response.error.message)
    } catch {
      if (version === requestVersion.current) reportError('无法打开目标，请重试')
    }
  }, [reportError])

  return {
    state: { ...state, root: { id: 'source' as const, absolutePath: options.sourcePath, displayName: options.sourceName } },
    current: state.entries.at(-1) ?? null,
    navigate, openLink, back, select, refresh, open, checkForChanges, setScroll, consumeLocation, reportError,
  }
}

export type DocumentViewController = ReturnType<typeof useDocumentView>
