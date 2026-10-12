import { markdown as markdownLanguage } from '@codemirror/lang-markdown'
import { isolateHistory, redo, undo } from '@codemirror/commands'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { clipboardHasImage, readClipboardMarkdown, type ReadClipboardImage } from './clipboard-image-paste'
import {
  search,
} from '@codemirror/search'
import { EditorView, lineNumbers, type ViewUpdate } from '@codemirror/view'
import { createCodeDocumentTextState, loadCodeDocumentLanguage, normalizeCodeDocumentText } from './code-document-language'
import CodeMirror from '@uiw/react-codemirror'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { extractOutline, outlineHeadingOffset } from '../workspace/workspace-navigation'
import { documentHeadingAnchor } from '../../shared/document-heading-anchor'
import { useOptionalContextMenu } from '../context-menu/ContextMenuProvider'
import { useOptionalBusinessDialog } from '../modal/BusinessDialogProvider'
import type {
  TranslationSelection,
  TranslationSelectionGeometry,
} from '../../shared/selection-translation'
import type { ClipboardFormatsSnapshot } from '../../shared/contracts'
import {
  exportSourceStickyNoteSelection,
  type StickyNoteSelectionExport,
} from '../sticky-notes/sticky-note-selection-export'
import { buildSourceEditorMenu } from './context-menu/editor-menu-model'
import { applySourceTextCommand } from './context-menu/source-editor-commands'
import { resolveSourceInlineFormatStates } from './context-menu/inline-format-state'
import { sanitizeClipboardHtml } from './context-menu/clipboard-formats'
import {
  createTranslationSelectionProvenance,
  isDocumentTranslationShortcut,
  normalizeAnchorRect,
  pointerReleaseRect,
  selectionEndpointRect,
} from './translation-selection'
import { exportSourceTranslationSelection } from './translation-selection-content'
import {
  DOCUMENT_FIND_EVENT,
  dispatchDocumentFindSnapshot,
  readDocumentFindAction,
} from './document-find-events'
import { createSourceDocumentFindSession } from './source-document-find'
import type {
  TranslationHistoryEditorHandle,
  TranslationHistoryEditorPort,
} from './translation-history'
import {
  bindPendingSourceTranslationAnchor,
  capturePendingSourceTranslationAnchor,
  configureSourceTranslationHistoryView,
  discardPendingSourceTranslationAnchor,
  flushSourceTranslationHistoryAnchors,
  promotePendingSourceTranslationAnchor,
  revealSourceTranslationHistoryRecord,
  sourceTranslationHistoryExtension,
  syncSourceTranslationHistoryRecords,
} from './source-translation-history'
import {
  setSourceEditIndicators,
  sourceEditIndicatorGutter,
} from './edit-indicators/source-edit-indicator-gutter'
import { codeMirrorTooltips } from './codemirror-tooltips'
import { sourceFoldGutter } from './edit-indicators/source-fold-gutter'
import type { EditIndicatorState } from './edit-indicators/line-diff'
import {
  droppedLinkInsertionRange,
  serializeDroppedLocalLink,
  type DroppedLinkInsertion,
  type DroppedMarkdownInsertion,
} from './dropped-link-insertion'
import {
  captureSourceModePosition,
  resolveSourceModePosition,
  type EditorModePosition,
} from './editor-mode-position'
import {
  isEditorMarginSelectionExcluded,
  type EditorMarginSelectionPort,
} from './editor-margin-selection'
import {
  createWorkspaceAiEditorAdapter,
  type WorkspaceAiEditorPort,
} from './workspace-ai-editor-adapter'

const MARKDOWN_EXTENSIONS = [markdownLanguage(), EditorView.lineWrapping, search()]
const EMPTY_LINE_INDICATORS: readonly EditIndicatorState[] = Object.freeze([])

function sourcePositionHit(
  view: EditorView,
  point: { clientX: number; clientY: number },
): { horizontalDistance: number; position: number } | null {
  const position = view.posAtCoords({ x: point.clientX, y: point.clientY }, false)
  if (position === null) return null
  const caret = view.coordsAtPos(position)
  if (!caret || point.clientY < caret.top - 2 || point.clientY > caret.bottom + 2) return null
  // A CJK/emoji glyph can be wider than CodeMirror's default Latin character.
  // Accept its actual rendered box without extending the hit area into margins.
  for (const characterPosition of [position, position - 1]) {
    if (characterPosition < 0 || characterPosition >= view.state.doc.length) continue
    const character = view.coordsForChar(characterPosition)
    if (character && point.clientX >= character.left && point.clientX <= character.right
      && point.clientY >= character.top && point.clientY <= character.bottom) {
      return { horizontalDistance: 0, position }
    }
  }
  const horizontalDistance = point.clientX < caret.left
    ? caret.left - point.clientX
    : point.clientX > caret.right
      ? point.clientX - caret.right
      : 0
  return { horizontalDistance, position }
}

function sourceTextHitTolerance(view: EditorView): number {
  return Math.max(2, view.defaultCharacterWidth * 0.75)
}

function isSourceMarginStart(view: EditorView, event: PointerEvent): boolean {
  const scroll = view.scrollDOM
  if (isEditorMarginSelectionExcluded(event, event.target, scroll)) return false
  const viewport = scroll.getBoundingClientRect()
  if (
    event.clientX < viewport.left
    || event.clientX > viewport.right
    || event.clientY < viewport.top
    || event.clientY > viewport.bottom
  ) return false
  const editorSurface = view.dom.closest<HTMLElement>('.editor-surface')
  if (
    editorSurface?.classList.contains('has-source-translation-history-rail')
    && event.clientX > view.dom.getBoundingClientRect().right
  ) return false
  const hit = sourcePositionHit(view, event)
  return Boolean(hit && hit.horizontalDistance > sourceTextHitTolerance(view))
}
const BASIC_SETUP = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: true,
  searchKeymap: false,
}

export interface SourceEditorProps {
  documentPath?: string
  plainText?: boolean
  colorScheme?: 'light' | 'dark'
  interactionLocked?: boolean
  readClipboardImage?: ReadClipboardImage
  markdown: string
  initialModePosition?: EditorModePosition | null
  lineIndicators?: readonly EditIndicatorState[]
  showEditIndicators?: boolean
  zoomPercent?: number
  spellCheckEnabled?: boolean
  documentKey?: string
  dirty?: boolean
  translationHistory?: TranslationHistoryEditorPort
  onChange: (markdown: string) => void
  onTranslationSelection?(selection: TranslationSelection | null): void
  onTranslationAnchorChange?(geometry: TranslationSelectionGeometry | null): void
  translationAnchorRefreshKey?: number | string
  onStickyNoteSelection?(selection: StickyNoteSelectionExport | null): void
  onCreateStickyNote?(): void
  onTranslationHistoryReady?(documentKey: string): void
  onFindReady?(): void
}

export interface SourceEditorHandle extends TranslationHistoryEditorHandle {
  insertDroppedLink(input: DroppedLinkInsertion): boolean
  insertDroppedMarkdown(input: DroppedMarkdownInsertion): boolean
  createWorkspaceAiEditorPort?(): WorkspaceAiEditorPort
  captureModePosition?(): EditorModePosition | null
  revealLine?(line: number): void
  revealAnchor?(anchor: string): boolean
  marginSelectionPort?(): EditorMarginSelectionPort | null
}

export function reconfigureSourceSpellCheck(
  view: EditorView,
  compartment: Compartment,
  enabled: boolean,
): void {
  view.dispatch({
    effects: compartment.reconfigure(
      EditorView.contentAttributes.of({ spellcheck: String(enabled) }),
    ),
  })
}

function measureSourceTranslationGeometry(
  view: EditorView,
  documentPointerRect?: TranslationSelection['releaseRect'] | null,
): TranslationSelectionGeometry | null {
  if (!view.dom.isConnected) return null
  const selection = view.state.selection.main
  if (selection.from === selection.to) return null
  const start = view.coordsAtPos(selection.from)
  const end = view.coordsAtPos(selection.to)
  if (!start || !end) {
    // Only Ctrl+A may use the visible viewport when CodeMirror virtualizes an endpoint.
    if (documentPointerRect === undefined) return null
    const visible = view.scrollDOM.getBoundingClientRect()
    const left = Math.max(0, visible.left)
    const top = Math.max(0, visible.top)
    const right = Math.min(window.innerWidth, visible.right)
    const bottom = Math.min(window.innerHeight, visible.bottom)
    const anchorRect = normalizeAnchorRect({
      left, top, right, bottom, width: right - left, height: bottom - top,
    })
    if (!anchorRect) return null
    return { anchorRect, focusRect: documentPointerRect ?? anchorRect }
  }
  const left = Math.min(start.left, start.right, end.left, end.right)
  const top = Math.min(start.top, start.bottom, end.top, end.bottom)
  const right = Math.max(start.left, start.right, end.left, end.right)
  const bottom = Math.max(start.top, start.bottom, end.top, end.bottom)
  const anchorRect = normalizeAnchorRect({
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  })
  const focusRect = selectionEndpointRect(view.coordsAtPos(selection.head))
  return anchorRect && focusRect ? { anchorRect, focusRect } : null
}

export const SourceEditor = forwardRef<SourceEditorHandle, SourceEditorProps>(
function SourceEditor({ documentPath, plainText = false, colorScheme = 'light', interactionLocked = false, markdown, readClipboardImage, initialModePosition = null, lineIndicators = EMPTY_LINE_INDICATORS, showEditIndicators = false, zoomPercent = 100, spellCheckEnabled = false, documentKey, dirty, translationHistory, onChange, onTranslationSelection, onTranslationAnchorChange, translationAnchorRefreshKey, onStickyNoteSelection, onCreateStickyNote, onFindReady, onTranslationHistoryReady }: SourceEditorProps, ref) {
  const editorText = plainText ? normalizeCodeDocumentText(markdown) : markdown
  const contextMenu = useOptionalContextMenu()
  const businessDialogs = useOptionalBusinessDialog()
  const viewRef = useRef<EditorView | null>(null)
  const plainTextRef = useRef(plainText)
  plainTextRef.current = plainText
  const codeTextStateRef = useRef<ReturnType<typeof createCodeDocumentTextState> | null>(null)
  if (plainText && !codeTextStateRef.current) codeTextStateRef.current = createCodeDocumentTextState(markdown)
  const languageCompartmentRef = useRef(new Compartment())
  useEffect(() => {
    const view = viewRef.current
    if (!view || !plainText) return
    let active = true
    view.dispatch({ effects: languageCompartmentRef.current.reconfigure([]) })
    void loadCodeDocumentLanguage(documentPath ?? '').then(extension => {
      if (active && viewRef.current === view) view.dispatch({ effects: languageCompartmentRef.current.reconfigure(extension) })
    }).catch(() => { /* A missing optional language pack leaves editable plain source. */ })
    return () => { active = false }
  }, [documentPath, plainText])
  const interactionLockedRef = useRef(interactionLocked)
  useLayoutEffect(() => { interactionLockedRef.current = interactionLocked }, [interactionLocked])
  useEffect(() => {
    const navigate = (event: Event) => {
      if (plainTextRef.current) return
      const index = (event as CustomEvent<{ index?: number }>).detail?.index
      const view = viewRef.current
      if (!view || !Number.isSafeInteger(index)) return
      const offset = outlineHeadingOffset(view.state.doc.toString(), index!)
      if (offset === undefined) return
      view.dispatch({ selection: { anchor: offset }, effects: EditorView.scrollIntoView(offset, { y: 'center' }) })
      view.focus()
    }
    window.addEventListener('arkdown:navigate-heading', navigate)
    return () => window.removeEventListener('arkdown:navigate-heading', navigate)
  }, [])
  const findSessionRef = useRef<ReturnType<typeof createSourceDocumentFindSession> | null>(null)
  const findMarkdownRef = useRef(editorText)
  const documentKeyRef = useRef(documentKey)
  const clipboardLifetimeRef = useRef(0)
  useLayoutEffect(() => { clipboardLifetimeRef.current += 1 }, [documentKey])
  const translationHistoryRef = useRef(translationHistory)
  const onChangeRef = useRef(onChange)
  const aiDirtyRef = useRef(false)
  const aiAdapterStateRef = useRef<{
    documentKey: string | undefined
    adapter: ReturnType<typeof createWorkspaceAiEditorAdapter<string>>
  } | null>(null)
  documentKeyRef.current = documentKey
  translationHistoryRef.current = translationHistory
  onChangeRef.current = onChange
  const historyRecords = documentKey && translationHistory
    ? translationHistory.recordsForDocument(documentKey)
    : []
  const spellCheckCompartmentRef = useRef<Compartment | null>(null)
  if (!spellCheckCompartmentRef.current) {
    spellCheckCompartmentRef.current = new Compartment()
  }
  const spellCheckEnabledRef = useRef(spellCheckEnabled)
  spellCheckEnabledRef.current = spellCheckEnabled
  const configuredSpellCheckRef = useRef(spellCheckEnabled)
  const extensionsRef = useRef([
    EditorState.transactionFilter.of(transaction => interactionLockedRef.current
      && (transaction.docChanged || transaction.selection !== undefined) ? [] : transaction),
    sourceFoldGutter,
    codeMirrorTooltips,
    lineNumbers(),
    sourceEditIndicatorGutter,
    ...(plainText ? [search(), languageCompartmentRef.current.of([]), codeTextStateRef.current!.extension] : MARKDOWN_EXTENSIONS),
    spellCheckCompartmentRef.current.of(EditorView.contentAttributes.of({
      spellcheck: String(spellCheckEnabled),
    })),
    sourceTranslationHistoryExtension,
  ])
  const translationProvenanceRef = useRef<ReturnType<
    typeof createTranslationSelectionProvenance
  > | null>(null)
  if (!translationProvenanceRef.current) {
    translationProvenanceRef.current = createTranslationSelectionProvenance()
  }
  const translationProvenance = translationProvenanceRef.current
  const translationSurfaceRef = useRef<HTMLElement | null>(null)
  const translationPointerRectRef = useRef<TranslationSelection['releaseRect'] | null>(null)
  const documentTranslationGenerationRef = useRef(0)
  const documentTranslationActiveRef = useRef(false)
  const onTranslationSelectionRef = useRef(onTranslationSelection)
  onTranslationSelectionRef.current = onTranslationSelection
  const onTranslationAnchorChangeRef = useRef(onTranslationAnchorChange)
  onTranslationAnchorChangeRef.current = onTranslationAnchorChange
  const onFindReadyRef = useRef(onFindReady)
  onFindReadyRef.current = onFindReady
  const onTranslationHistoryReadyRef = useRef(onTranslationHistoryReady)
  onTranslationHistoryReadyRef.current = onTranslationHistoryReady
  const installedHistoryRecordsRef = useRef<readonly unknown[] | null>(null)
  const indicatorPayloadRef = useRef({ states: lineIndicators, visible: showEditIndicators })
  indicatorPayloadRef.current = { states: lineIndicators, visible: showEditIndicators }
  const dispatchedIndicatorPayloadRef = useRef<{
    states: readonly EditIndicatorState[]
    visible: boolean
  } | null>(null)
  const sourceScrollRatioRef = useRef(0)
  const sourceScrollCleanupRef = useRef<(() => void) | null>(null)
  const zoomPercentRef = useRef(zoomPercent)

  const marginSelectionPortRef = useRef<EditorMarginSelectionPort | null>(null)
  if (!marginSelectionPortRef.current) {
    marginSelectionPortRef.current = {
      isEligibleMarginStart: (event) => {
        const view = viewRef.current
        if (!view?.dom.isConnected) return false
        const track = view.dom.closest('.editor-pane')
          ?.querySelector<HTMLElement>('.editor-right-sidebar-motion-track')
        if (track && track.dataset.phase !== 'open') return false
        return isSourceMarginStart(view, event)
      },
      activationPositionAtPoint: (point) => {
        const view = viewRef.current
        if (!view?.dom.isConnected) return null
        const hit = sourcePositionHit(view, point)
        return hit && hit.horizontalDistance <= sourceTextHitTolerance(view)
          ? hit.position
          : null
      },
      positionAtPoint: ({ clientX, clientY }) => viewRef.current
        ?.posAtCoords({ x: clientX, y: clientY }, false) ?? null,
      applySelection: (anchor, head) => {
        const view = viewRef.current
        if (!view) return
        const length = view.state.doc.length
        view.dispatch({
          selection: {
            anchor: Math.max(0, Math.min(length, Math.trunc(anchor))),
            head: Math.max(0, Math.min(length, Math.trunc(head))),
          },
        })
      },
      focus: () => viewRef.current?.focus(),
      scrollContainer: () => viewRef.current?.scrollDOM ?? null,
      beginPointerSelection: (event) => {
        const contentDOM = viewRef.current?.contentDOM
        if (!contentDOM) return
        translationSurfaceRef.current = contentDOM
        translationProvenance.pointerDown(event)
      },
      cancelPointerSelection: () => {
        translationSurfaceRef.current = null
        translationProvenance.reset()
      },
    }
  }

  const withHistoryView = <Result,>(
    fallback: Result,
    operation: (view: EditorView) => Result,
  ): Result => {
    const view = viewRef.current
    if (
      !view
      || !view.dom.isConnected
      || !documentKeyRef.current
      || !translationHistoryRef.current
    ) return fallback
    return operation(view)
  }

  useImperativeHandle(ref, () => ({
    createWorkspaceAiEditorPort: () => {
      const current = aiAdapterStateRef.current
      if (!current) {
        throw new Error('Source editor AI adapter is unavailable')
      }
      return current.adapter.createPort()
    },
    marginSelectionPort: () => viewRef.current ? marginSelectionPortRef.current : null,
    revealLine: (lineNumber) => {
      const view = viewRef.current
      if (!view || !Number.isSafeInteger(lineNumber) || lineNumber < 1) return
      const line = view.state.doc.line(Math.min(lineNumber, view.state.doc.lines))
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start' }) })
      view.focus()
    },
    revealAnchor: (anchor) => {
      const view = viewRef.current
      if (!view || plainTextRef.current) return false
      const text = view.state.doc.toString()
      const counts = new Map<string, number>()
      const heading = extractOutline(text).find((item) => {
        const base = documentHeadingAnchor(item.text)
        const count = counts.get(base) ?? 0
        counts.set(base, count + 1)
        return (count ? `${base}-${count}` : base) === anchor
      })
      const offset = heading && outlineHeadingOffset(text, heading.index)
      if (offset === undefined) return false
      view.dispatch({ selection: { anchor: offset }, effects: EditorView.scrollIntoView(offset, { y: 'start' }) })
      view.focus()
      return true
    },
    captureModePosition: () => {
      const view = viewRef.current
      if (!view) return null
      const head = view.state.selection.main.head
      const line = view.state.doc.lineAt(head)
      return captureSourceModePosition(view.state.doc.toString(), line.number - 1, head - line.from)
    },
    insertDroppedLink: (input) => {
      const view = viewRef.current
      if (plainTextRef.current || interactionLockedRef.current || !view) return false
      const position = view.posAtCoords({ x: input.clientX, y: input.clientY })
      if (position === null) return false
      const markdown = serializeDroppedLocalLink(input.absolutePath, input.kind)
      const range = droppedLinkInsertionRange(position, view.state.selection.main)
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: markdown },
        selection: { anchor: range.from + markdown.length },
      })
      view.focus()
      return true
    },
    insertDroppedMarkdown: (input) => {
      const view = viewRef.current
      if (plainTextRef.current || interactionLockedRef.current || !view || !input.markdown || input.markdown.length > 1_000_000) return false
      const position = view.posAtCoords({ x: input.clientX, y: input.clientY })
      if (position === null) return false
      view.dispatch({
        changes: { from: position, to: position, insert: input.markdown },
        selection: { anchor: position + input.markdown.length },
      })
      view.focus()
      return true
    },
    revealTranslationHistoryRecord: (recordId, alignment) => withHistoryView(
      false,
      (view) => revealSourceTranslationHistoryRecord(view, recordId, alignment),
    ),
    flushTranslationHistoryAnchors: () => withHistoryView(
      [],
      flushSourceTranslationHistoryAnchors,
    ),
    capturePendingTranslationAnchor: (pendingKey) => withHistoryView(
      false,
      (view) => capturePendingSourceTranslationAnchor(view, pendingKey),
    ),
    bindPendingTranslationAnchor: (pendingKey, requestId) => withHistoryView(
      undefined,
      (view) => bindPendingSourceTranslationAnchor(view, pendingKey, requestId),
    ),
    promotePendingTranslationAnchor: (requestId) => withHistoryView(
      null,
      (view) => promotePendingSourceTranslationAnchor(view, requestId),
    ),
    discardPendingTranslationAnchor: (key) => withHistoryView(
      undefined,
      (view) => discardPendingSourceTranslationAnchor(view, key),
    ),
  }), [])

  const applySpellCheck = (view: EditorView) => {
    const next = spellCheckEnabledRef.current
    if (configuredSpellCheckRef.current === next) return
    reconfigureSourceSpellCheck(view, spellCheckCompartmentRef.current!, next)
    configuredSpellCheckRef.current = next
  }

  useEffect(() => {
    const view = viewRef.current
    if (view) applySpellCheck(view)
  }, [spellCheckEnabled])

  useLayoutEffect(() => {
    if (findMarkdownRef.current === editorText) return
    findMarkdownRef.current = editorText
    findSessionRef.current?.refresh(editorText)
  }, [editorText])

  useLayoutEffect(() => {
    const view = viewRef.current
    const payload = indicatorPayloadRef.current
    const previous = dispatchedIndicatorPayloadRef.current
    if (!view || (previous?.states === payload.states && previous.visible === payload.visible)) return
    view.dispatch({ effects: setSourceEditIndicators.of(payload) })
    dispatchedIndicatorPayloadRef.current = payload
  }, [lineIndicators, showEditIndicators])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view || zoomPercentRef.current === zoomPercent) {
      return () => undefined
    }
    const scrollDOM = view.scrollDOM
    const scrollRatio = sourceScrollRatioRef.current
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (viewRef.current !== view) return
        scrollDOM.scrollTop = scrollRatio * (scrollDOM.scrollHeight - scrollDOM.clientHeight)
      })
    })
    zoomPercentRef.current = zoomPercent
    return () => {
      const range = scrollDOM.scrollHeight - scrollDOM.clientHeight
      sourceScrollRatioRef.current = range > 0 ? scrollDOM.scrollTop / range : 0
    }
  }, [zoomPercent])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (view && installedHistoryRecordsRef.current !== historyRecords) {
      syncSourceTranslationHistoryRecords(view, historyRecords)
      installedHistoryRecordsRef.current = historyRecords
      if (documentKey) onTranslationHistoryReadyRef.current?.(documentKey)
    }
  })

  useLayoutEffect(() => {
    if (translationAnchorRefreshKey === undefined) return
    const callback = onTranslationAnchorChangeRef.current
    const view = viewRef.current
    if (!callback || !view) return
    try {
      callback(measureSourceTranslationGeometry(view))
    } catch {
      callback(null)
    }
  }, [translationAnchorRefreshKey])

  useEffect(() => {
    const onFind = (event: Event) => {
      if (document.activeElement?.closest('.document-view-panel')) return
      const action = readDocumentFindAction(event)
      const session = findSessionRef.current
      if (!action || !session) return
      if (action.type === 'query') {
        session.setQuery(action.query)
        return
      }
      if (action.type === 'next') {
        session.next()
        return
      }
      if (action.type === 'previous') {
        session.previous()
        return
      }
      session.close()
    }
    window.addEventListener(DOCUMENT_FIND_EVENT, onFind)
    return () => {
      window.removeEventListener(DOCUMENT_FIND_EVENT, onFind)
      findSessionRef.current?.dispose()
    }
  }, [])

  useEffect(
    () => () => {
      translationSurfaceRef.current = null
      translationProvenance.reset()
      viewRef.current = null
      findSessionRef.current = null
      dispatchedIndicatorPayloadRef.current = null
      sourceScrollCleanupRef.current?.()
      sourceScrollCleanupRef.current = null
    },
    [translationProvenance],
  )

  useLayoutEffect(() => {
    aiDirtyRef.current = typeof dirty === 'boolean' ? dirty : false
    const adapter = createWorkspaceAiEditorAdapter<string>({
      capture: () => {
        const view = viewRef.current
        if (interactionLockedRef.current || !view?.dom.isConnected) throw new Error('Source editor is unavailable')
        return { markdown: view.state.doc.toString(), dirty: aiDirtyRef.current }
      },
      prepareReplacement: (replacementMarkdown) => replacementMarkdown,
      applyReplacement: (_prepared, replacementMarkdown) => {
        const view = viewRef.current
        if (interactionLockedRef.current || !view?.dom.isConnected) throw new Error('Source editor is unavailable')
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: replacementMarkdown },
        })
      },
    })
    aiAdapterStateRef.current = { documentKey, adapter }
    return () => {
      adapter.dispose()
      if (aiAdapterStateRef.current?.adapter === adapter) aiAdapterStateRef.current = null
    }
  }, [documentKey])

  useLayoutEffect(() => {
    if (typeof dirty === 'boolean') aiDirtyRef.current = dirty
  }, [dirty])

  const pasteClipboard = async (imageOnly = false): Promise<void> => {
    if (interactionLockedRef.current) return
    const view = viewRef.current
    if (!view) return
    const key = documentKeyRef.current
    const lifetime = clipboardLifetimeRef.current
    const doc = view.state.doc
    const { from, to } = view.state.selection.main
    const text = plainTextRef.current
      ? await navigator.clipboard?.readText()
      : await readClipboardMarkdown(readClipboardImage, imageOnly)
    if (interactionLockedRef.current || !text || viewRef.current !== view || !view.dom.isConnected
      || documentKeyRef.current !== key || clipboardLifetimeRef.current !== lifetime || view.state.doc !== doc) return
    view.dispatch({
      changes: { from, to, insert: text }, selection: { anchor: from + text.length },
      annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.paste')],
    })
    view.focus()
  }

  const execute = async (
    id: string,
    clipboardFormats?: ClipboardFormatsSnapshot,
  ): Promise<void> => {
    if (interactionLockedRef.current) return
    const view = viewRef.current
    if (!view) return
    if (plainTextRef.current && !['search-selection', 'undo', 'redo', 'copy', 'cut', 'paste', 'paste-plain', 'delete-selection', 'select-all', 'move-line-up', 'move-line-down'].includes(id)) return
    const selection = view.state.selection.main
    const selected = view.state.sliceDoc(selection.from, selection.to)

    if (id === 'create-sticky-note') {
      onCreateStickyNote?.()
      return
    }
    if (id === 'search-selection') {
      const result = await window.arkdown.searchSelection?.(selected)
      if (result && !result.ok) await businessDialogs?.alert({ title: result.error.message })
      return
    }
    if (id === 'undo') {
      undo(view)
      return
    }
    if (id === 'redo') {
      redo(view)
      return
    }
    if (id === 'copy' || id === 'cut') {
      await navigator.clipboard?.writeText(selected)
      if (id === 'cut') view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: '' },
      })
      return
    }
    if (id === 'paste') {
      await pasteClipboard()
      return
    }
    if (id === 'paste-plain' || id === 'paste-markdown' || id === 'paste-html') {
      let formats = clipboardFormats
      if (!formats) {
        const text = await navigator.clipboard?.readText()
        if (typeof text !== 'string') return
        formats = { plainText: text, markdown: null, html: null }
      }
      const text = id === 'paste-plain'
        ? formats.plainText
        : id === 'paste-markdown'
          ? formats.markdown ?? formats.plainText
          : formats.html === null
            ? null
            : sanitizeClipboardHtml(formats.html)
      if (text === null) return
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: text },
        selection: { anchor: selection.from + text.length },
      })
      return
    }
    if (id === 'delete-selection') {
      view.dispatch({ changes: { from: selection.from, to: selection.to, insert: '' } })
      return
    }
    if (id === 'select-all') {
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
      return
    }

    const result = applySourceTextCommand(
      view.state.doc.toString(),
      selection.anchor,
      selection.head,
      id,
    )
    if (result.markdown !== view.state.doc.toString()) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: result.markdown },
        selection: { anchor: result.anchor, head: result.head },
      })
    }
  }

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    documentTranslationGenerationRef.current += 1
    translationSurfaceRef.current = null
    translationProvenance.contextMenu()
    const view = viewRef.current
    if (!contextMenu || !view) return
    event.preventDefault()
    const point = view.posAtCoords({ x: event.clientX, y: event.clientY })
    const previous = view.state.selection.main
    if (
      point !== null
      && (point < previous.from || point > previous.to)
    ) {
      view.dispatch({ selection: { anchor: point } })
    }
    const selection = view.state.selection.main
    const selected = view.state.sliceDoc(selection.from, selection.to)
    onStickyNoteSelection?.(selected
      ? exportSourceStickyNoteSelection(view.state.doc.toString(), selection.from, selection.to)
      : null)
    const openMenu = (formats?: ClipboardFormatsSnapshot) => contextMenu.openMenu({
      x: event.clientX,
      y: event.clientY,
      items: buildSourceEditorMenu(
        selected,
        formats,
        resolveSourceInlineFormatStates(
          view.state.doc.toString(),
          selection.anchor,
          selection.head,
        ),
      ).filter(item => !plainTextRef.current || [
        'search-selection', 'undo', 'redo', 'cut', 'copy', 'paste', 'delete-selection', 'select-all', 'paste-plain', 'move-line-up', 'move-line-down', 'source-search-separator', 'source-edit-separator', 'source-line-separator',
      ].includes(item.id)),
      execute: (id) => execute(id, formats),
      restoreFocus: () => viewRef.current?.focus(),
    })
    if (!window.arkdown?.readClipboardFormats) {
      openMenu()
      return
    }
    void window.arkdown.readClipboardFormats().then((result) => {
      openMenu(result.ok
        ? result.value
        : { plainText: '', markdown: null, html: null })
    }).catch(() => openMenu({ plainText: '', markdown: null, html: null }))
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    documentTranslationGenerationRef.current += 1
    translationSurfaceRef.current = null
    const view = viewRef.current
    const contentDOM = viewRef.current?.contentDOM
    const target = event.target
    if (
      !contentDOM
      || !(target instanceof Node)
      || !contentDOM.contains(target)
    ) {
      translationProvenance.reset()
      return
    }
    const hit = view ? sourcePositionHit(view, event.nativeEvent) : null
    if (
      event.defaultPrevented
      || !view
      || !hit
      || hit.horizontalDistance > sourceTextHitTolerance(view)
    ) {
      translationProvenance.reset()
      return
    }
    translationSurfaceRef.current = contentDOM
    translationProvenance.pointerDown(event.nativeEvent)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const contentDOM = viewRef.current?.contentDOM
    const target = event.target
    if (
      event.pointerType !== 'mouse'
      || !contentDOM
      || !(target instanceof Node)
      || !contentDOM.contains(target)
    ) return
    translationPointerRectRef.current = pointerReleaseRect(event.nativeEvent)
  }

  const finishTranslationPointer = (event: PointerEvent) => {
    const view = viewRef.current
    const contentDOM = translationSurfaceRef.current
    translationSurfaceRef.current = null
    if (
      !translationProvenance.pointerUp(event)
      || !contentDOM
      || !view
      || view.contentDOM !== contentDOM
    ) return
    documentTranslationActiveRef.current = false
    if (!onTranslationSelection) return
    if (!view.dom.isConnected) {
      onTranslationSelection(null)
      return
    }

    try {
      const selection = view.state.selection.main
      if (selection.from === selection.to) {
        onTranslationSelection(null)
        return
      }
      const markdown = view.state.sliceDoc(selection.from, selection.to)
      const content = exportSourceTranslationSelection(markdown).content
      const geometry = measureSourceTranslationGeometry(view)
      const releaseRect = pointerReleaseRect(event)
      if (!content.markdown.trim() || !geometry || !releaseRect) {
        onTranslationSelection(null)
        return
      }
      onTranslationSelection({
        content,
        range: { from: selection.from, to: selection.to },
        mode: 'source',
        anchorRect: geometry.anchorRect,
        focusRect: geometry.focusRect,
        releaseRect,
      })
    } catch {
      onTranslationSelection(null)
    }
  }

  useEffect(() => {
    const ownerDocument = viewRef.current?.dom.ownerDocument ?? document
    ownerDocument.addEventListener('pointerup', finishTranslationPointer, true)
    return () => ownerDocument.removeEventListener('pointerup', finishTranslationPointer, true)
  })

  const onBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    documentTranslationGenerationRef.current += 1
    const editorRoot = event.currentTarget
    const relatedTarget = event.relatedTarget
    if (relatedTarget instanceof Node && editorRoot.contains(relatedTarget)) return
    const reset = () => {
      translationSurfaceRef.current = null
      translationProvenance.reset()
    }
    if (relatedTarget !== null) {
      reset()
      return
    }
    queueMicrotask(() => {
      if (!editorRoot.isConnected) return
      const activeElement = document.activeElement
      if (activeElement instanceof Node && editorRoot.contains(activeElement)) return
      reset()
    })
  }

  const onCompositionStart = () => {
    translationSurfaceRef.current = null
    translationProvenance.compositionStart()
  }
  const onCompositionEnd = () => {
    translationSurfaceRef.current = null
    translationProvenance.compositionEnd()
  }
  const onDragStart = () => {
    translationSurfaceRef.current = null
    translationProvenance.dragStart()
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const generation = ++documentTranslationGenerationRef.current
    translationSurfaceRef.current = null
    translationProvenance.keyDown()
    if (!isDocumentTranslationShortcut(event.nativeEvent)) {
      if (documentTranslationActiveRef.current) {
        documentTranslationActiveRef.current = false
        onTranslationSelectionRef.current?.(null)
      }
      return
    }
    const shortcutView = viewRef.current
    const shortcutDocumentKey = documentKeyRef.current
    // Native event listeners may drain microtasks before CodeMirror handles Ctrl+A.
    requestAnimationFrame(() => {
      const view = viewRef.current
      const callback = onTranslationSelectionRef.current
      if (
        !view || view !== shortcutView || !callback || !view.dom.isConnected
        || shortcutDocumentKey !== documentKeyRef.current
        || generation !== documentTranslationGenerationRef.current
      ) return
      const selection = view.state.selection.main
      const length = view.state.doc.length
      if (length === 0 || selection.from !== 0 || selection.to !== length) {
        documentTranslationActiveRef.current = false
        callback(null)
        return
      }
      try {
        const geometry = measureSourceTranslationGeometry(view, translationPointerRectRef.current)
        const content = exportSourceTranslationSelection(view.state.sliceDoc(0, length)).content
        if (!geometry || !content.markdown.trim()) {
          documentTranslationActiveRef.current = false
          callback(null)
          return
        }
        documentTranslationActiveRef.current = true
        callback({
          content,
          mode: 'source',
          scope: 'document',
          anchorRect: geometry.anchorRect,
          focusRect: geometry.focusRect,
          releaseRect: translationPointerRectRef.current ?? geometry.focusRect,
        })
      } catch {
        documentTranslationActiveRef.current = false
        callback(null)
      }
    })
  }

  const onSourceChange = useRef((nextMarkdown: string, update?: ViewUpdate) => {
    aiDirtyRef.current = true
    aiAdapterStateRef.current?.adapter.noteEditorEdit()
    findMarkdownRef.current = nextMarkdown
    findSessionRef.current?.refresh(nextMarkdown)
    const text = plainTextRef.current && update && codeTextStateRef.current
      ? codeTextStateRef.current.text(update.state) : nextMarkdown
    onChangeRef.current(text)
  })

  return (
    <div
      className="source-editor-context"
      onPasteCapture={(event) => {
        if (plainTextRef.current) {
          if (event.defaultPrevented) return
          event.preventDefault()
          event.stopPropagation()
          const view = viewRef.current
          const text = event.clipboardData.getData('text/plain')
          if (!view || interactionLockedRef.current || !text) return
          const { from, to } = view.state.selection.main
          const normalized = normalizeCodeDocumentText(text)
          view.dispatch({ changes: { from, to, insert: normalized }, selection: { anchor: from + normalized.length }, annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.paste')] })
          return
        }
        if (event.defaultPrevented || !clipboardHasImage(event.clipboardData)) return
        event.preventDefault()
        event.stopPropagation()
        void pasteClipboard(true).catch(() => businessDialogs?.alert({ title: '无法粘贴剪贴板图片' }))
      }}
      onBlur={onBlur}
      onCompositionEnd={onCompositionEnd}
      onCompositionStart={onCompositionStart}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
      onKeyDownCapture={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
    >
      <CodeMirror
        aria-label={plainText ? 'Code source editor' : 'Markdown source editor'}
        theme={colorScheme}
        basicSetup={BASIC_SETUP}
        readOnly={interactionLocked}
        editable={!interactionLocked}
        className="source-editor"
        extensions={extensionsRef.current}
        height="100%"
        onChange={onSourceChange.current}
        onCreateEditor={(view) => {
          if (viewRef.current === view) return
          viewRef.current = view
          findSessionRef.current = createSourceDocumentFindSession(
            view,
            editorText,
            dispatchDocumentFindSnapshot,
          )
          const indicatorPayload = indicatorPayloadRef.current
          view.dispatch({ effects: setSourceEditIndicators.of(indicatorPayload) })
          dispatchedIndicatorPayloadRef.current = indicatorPayload
          const scrollDOM = view.scrollDOM
          const rememberSourceScroll = (event: Event) => {
            if (!event.isTrusted) return
            const range = scrollDOM.scrollHeight - scrollDOM.clientHeight
            sourceScrollRatioRef.current = range > 0 ? scrollDOM.scrollTop / range : 0
          }
          sourceScrollCleanupRef.current?.()
          scrollDOM.addEventListener('scroll', rememberSourceScroll)
          sourceScrollCleanupRef.current = () => {
            scrollDOM.removeEventListener('scroll', rememberSourceScroll)
          }
          applySpellCheck(view)
          configureSourceTranslationHistoryView(view, {
            onOpenRecord: (recordId) => translationHistoryRef.current?.onOpenRecord(recordId),
            onAnchorsChanged: (updates) => {
              const currentDocumentKey = documentKeyRef.current
              if (currentDocumentKey) {
                translationHistoryRef.current?.onAnchorsChanged(currentDocumentKey, updates)
              }
            },
          })
          syncSourceTranslationHistoryRecords(view, historyRecords)
          installedHistoryRecordsRef.current = historyRecords
          const restored = initialModePosition
            ? resolveSourceModePosition(view.state.doc.toString(), initialModePosition)
            : null
          if (restored) {
            const line = view.state.doc.line(restored.line + 1)
            const anchor = Math.min(line.to, line.from + restored.column)
            view.dispatch({
              selection: { anchor },
              effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
            })
            view.focus()
          }
          if (documentKey) onTranslationHistoryReadyRef.current?.(documentKey)
          onFindReadyRef.current?.()
        }}
        value={editorText}
      />
    </div>
  )
})
