import { Crepe } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/classic.css'
import './structured-blocks.css'
import './mermaid/mermaid-code-block.css'
import { codeMirrorTooltips } from './codemirror-tooltips'
import './visual-drop-caret.css'
import { commandsCtx, editorViewCtx, editorViewOptionsCtx, parserCtx, remarkCtx, serializerCtx } from '@milkdown/kit/core'
import { getMarkRange } from '@milkdown/kit/prose'
import { lift } from '@milkdown/kit/prose/commands'
import { Fragment, type Node as ProseMirrorNode, type Schema } from '@milkdown/kit/prose/model'
import { EditorState, NodeSelection, Plugin, TextSelection, type SelectionBookmark, type Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { CellSelection } from '@milkdown/kit/prose/tables'
import { captureSelectionTarget, createSelectionTargetPlugin, isCrossCellSelection, resolveSelectionTarget, type EditorSelectionTarget } from './editor-selection-target'
import { selectionTargetHtml, selectionTargetPlainText } from './context-menu/clipboard-formats'
import {
  blockquoteSchema,
  bulletListSchema,
  codeBlockSchema,
  emphasisSchema,
  headingSchema,
  inlineCodeSchema,
  listItemSchema,
  liftListItemCommand,
  orderedListAttr,
  orderedListSchema,
  paragraphSchema,
  remarkPreserveEmptyLinePlugin,
  setBlockTypeCommand,
  strongSchema,
  sinkListItemCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
  wrapInBlockTypeCommand,
} from '@milkdown/kit/preset/commonmark'
import { strikethroughSchema, toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm'
import { $prose } from '@milkdown/kit/utils'
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { createUserEditProvenance } from './user-edit-provenance'
import { createTaskCheckboxSerializer } from './task-checkbox-serialization'
import type { MenuCommand } from '../../shared/menu-commands'
import {
  DEFAULT_EDITOR_APPEARANCE,
  DEFAULT_EDITOR_THEME,
  type EditorTheme,
} from '../../shared/editor-appearance-preferences'
import { normalizeAutomaticLinkText, parseLinkTarget } from '../../shared/link-target'
import type {
  SelectionAnchorRect,
  TranslationSelection,
  TranslationSelectionGeometry,
} from '../../shared/selection-translation'
import {
  exportVisualStickyNoteSelection,
  type StickyNoteSelectionExport,
} from '../sticky-notes/sticky-note-selection-export'
import { installLinkInteraction, type OpenDocumentLink } from './local-link-handler'
import {
  buildVisualDroppedLinkTransaction,
  type DroppedLinkInsertion,
  type DroppedMarkdownInsertion,
} from './dropped-link-insertion'
import { createLinkEditorPopover } from './link-editor-popover'
import {
  createSmartLinkPlugin,
} from './smart-link-plugin'
import { frontmatterEditorPlugins } from './frontmatter-code-block'
import {
  applyExtendedVisualInlineCommand,
  extendedInlineMarkPlugins,
  type ExtendedVisualInlineCommand,
} from './extended-inline-marks'
import {
  createTranslationSelectionProvenance,
  isDocumentTranslationShortcut,
  normalizeAnchorRect,
  pointerReleaseRect,
  selectionEndpointRect,
} from './translation-selection'
import {
  exportVisualTranslationSelection,
  selectionTouchesTable,
} from './translation-selection-content'
import { localAssetLinkView } from './local-asset-link-view'
import { defaultHorizontalRuleView } from './horizontal-rule-view'
import {
  createLocalMarkdownImageView,
  createLocalMediaHtmlView,
} from './local-media-view'
import { useOptionalContextMenu } from '../context-menu/ContextMenuProvider'
import { useOptionalBusinessDialog } from '../modal/BusinessDialogProvider'
import { createVisualContextMenuHandler } from './context-menu/visual-context-menu'
import { installStructuredBlockAppearance } from './structured-block-appearance'
import { createStructuredBlockFocusExitPlugin } from './structured-block-focus-exit'
import { supportsYamlFrontmatterForDocument } from './structured-block-insertion'
import {
  buildListSelectionTransaction,
} from './list-selection-transform'
import {
  descriptorToTableNode,
  enhancedTableEditorPlugins,
  prepareEnhancedTables,
  restorePreparedEnhancedTables,
  serializeDocumentWithEnhancedTables,
  type PreparedEnhancedTable,
} from './enhanced-table-schema'
import {
  replaceTextInsideTableCell,
  selectionIsInsideSingleTableCell,
  splitParagraphInsideTableCell,
} from './table-cell-transactions'
import {
  DOCUMENT_FIND_EVENT,
  dispatchDocumentFindSnapshot,
  readDocumentFindAction,
  type DocumentFindAction,
} from './document-find-events'
import { createVisualDocumentFindSession } from './visual-document-find'
import { createResponsiveTableLayout } from './responsive-table-layout'
import { parseMarkdownInsertionSlice, type MarkdownParser } from './markdown-slice'
import { createVisualTabPlugin } from './visual-tab-commands'
import type {
  TranslationHistoryEditorHandle,
  TranslationHistoryEditorPort,
} from './translation-history'
import {
  isEditorMarginSelectionExcluded,
  type EditorMarginSelectionPort,
} from './editor-margin-selection'

import {
  bindPendingTranslationAnchor,
  capturePendingTranslationAnchor,
  createVisualTranslationHistoryPlugin,
  discardPendingTranslationAnchor,
  flushTranslationHistoryAnchors,
  promotePendingTranslationAnchor,
  revealTranslationHistoryRecord,
  syncTranslationHistoryRecords,
} from './visual-translation-history-plugin'
import { describeVisualLogicalBlocks } from './visual-logical-blocks'
import {
  captureSerializedVisualModePosition,
  captureVisualModePosition,
  resolveVisualModePosition,
  type EditorModePosition,
} from './editor-mode-position'
import {
  createVisualDropInsertionPlugin,
  type VisualDropTargetHandle,
} from './visual-drop-insertion'
import {
  createWorkspaceAiEditorAdapter,
  type WorkspaceAiEditorPort,
} from './workspace-ai-editor-adapter'
import { createVisualInputCaretPlugin } from './visual-input-caret'
import { closeHistory } from '@milkdown/kit/prose/history'
import { clipboardHasImage, readClipboardMarkdown, type ReadClipboardImage } from './clipboard-image-paste'
import { createVisualLineEndCaretPlugin } from './visual-line-end-caret'
import { createVisualParagraphEnterPlugin } from './visual-paragraph-enter'
import {
  CODE_EXPLANATION_REQUEST_EVENT,
  createAdaptiveMermaidCodeBlockView,
  type CodeExplanationRequestDetail,
} from './mermaid/adaptive-code-block-view'
import { getWindowMermaidRenderService } from './mermaid/mermaid-render-service'
import type { MermaidAppearance, MermaidRegistryPort } from './mermaid/mermaid-types'
import { createMermaidViewRegistry } from './mermaid/mermaid-view-registry'

type VisualEditorEventCommand = MenuCommand
  | 'underline'
  | 'clear-inline-formatting'
  | 'inline-formula'
  | 'highlight'
  | 'superscript'
  | 'subscript'

const DEFAULT_MERMAID_APPEARANCE: MermaidAppearance = Object.freeze({
  revision: 0,
  editorTheme: DEFAULT_EDITOR_THEME,
  colorScheme: 'light',
  themeColor: DEFAULT_EDITOR_APPEARANCE.themeColor,
  bodyFontFamily: [
    DEFAULT_EDITOR_APPEARANCE.bodyLatinFont,
    DEFAULT_EDITOR_APPEARANCE.bodyCjkFont,
  ].map((font) => JSON.stringify(font)).join(', '),
})

export interface VisualEditorProps {
  interactionLocked?: boolean
  readClipboardImage?: ReadClipboardImage
  inputCaret?: 'custom' | 'native'
  markdown: string
  editorTheme?: EditorTheme
  mermaidAppearance?: MermaidAppearance
  /** Internal main-process-owned deadline used only by the isolated print surface. */
  mermaidPrintDeadlineEpochMs?: number
  initialModePosition?: EditorModePosition | null
  spellCheckEnabled?: boolean
  documentAbsolutePath?: string | null
  documentKey?: string
  dirty?: boolean
  translationHistory?: TranslationHistoryEditorPort
  onChange: (markdown: string) => void
  onTranslationSelection?(selection: TranslationSelection | null): void
  onTranslationAnchorChange?(geometry: TranslationSelectionGeometry | null): void
  translationAnchorRefreshKey?: number | string
  onStickyNoteSelection?(selection: StickyNoteSelectionExport | null): void
  onCreateStickyNote?(): void
  readOnly?: boolean
  onReady?(): void | Promise<void>
  onTranslationHistoryReady?(documentKey: string): void
  onFindReady?(): void
  onCodeExplanationRequest?(detail: CodeExplanationRequestDetail): void
  onDocumentLink?: OpenDocumentLink
}

export type VisualBlockStyle = 'paragraph' | 'heading-4' | 'blockquote' | 'mixed'

export interface VisualEditorHandle extends TranslationHistoryEditorHandle {
  flush(): string | null
  whenRenderIdle(): Promise<void>
  createWorkspaceAiEditorPort?(): WorkspaceAiEditorPort
  captureModeSwitch?(fallbackMarkdown: string): {
    checkpoint: string
    position: EditorModePosition | null
  } | null
  captureModePosition?(targetMarkdown?: string): EditorModePosition | null
  captureSelection(): boolean
  pasteClipboard?(imageOnly?: boolean): Promise<boolean>
  insertMarkdown(markdown: string): boolean
  insertDroppedLink?(input: DroppedLinkInsertion): boolean
  insertDroppedMarkdown?(input: DroppedMarkdownInsertion): boolean
  selectedBlockStyle(): VisualBlockStyle
  setSelectedBlockStyle(style: Exclude<VisualBlockStyle, 'mixed'>): boolean
  marginSelectionPort?(): EditorMarginSelectionPort | null
}

interface PreparedVisualAiReplacement {
  readonly document: ProseMirrorNode
}

interface VisualAiExactMarkdownMirror {
  readonly document: ProseMirrorNode
  readonly markdown: string
}

export const VISUAL_AI_TRANSACTION_META = 'arkdown:workspace-ai-transaction'

function countVisualDocumentMarker(
  documentNode: ProseMirrorNode,
  marker: string,
): number {
  let count = 0
  documentNode.forEach((child) => {
    let cursor = 0
    while (cursor <= child.textContent.length - marker.length) {
      const found = child.textContent.indexOf(marker, cursor)
      if (found < 0) break
      count += 1
      cursor = found + marker.length
    }
  })
  return count
}

export function restorePreparedEnhancedTablesInDocument(
  documentNode: ProseMirrorNode,
  schema: Schema,
  tables: readonly PreparedEnhancedTable[],
): ProseMirrorNode | null {
  if (!tables.length) return documentNode
  if (new Set(tables.map((table) => table.marker)).size !== tables.length) return null
  const byMarker = new Map(tables.map((table) => [table.marker, table.descriptor]))
  const replacements: Array<{ from: number; to: number; node: ProseMirrorNode }> = []
  const matched = new Set<string>()
  documentNode.descendants((node, position) => {
    if (node.type.name !== 'paragraph') return true
    const descriptor = byMarker.get(node.textContent)
    if (!descriptor) return true
    const table = descriptorToTableNode(schema, descriptor)
    if (table && !matched.has(node.textContent)) {
      matched.add(node.textContent)
      replacements.push({ from: position, to: position + node.nodeSize, node: table })
    }
    return false
  })
  if (
    replacements.length !== tables.length
    || tables.some((table) => countVisualDocumentMarker(documentNode, table.marker) !== 1)
  ) return null
  let transaction = EditorState.create({ doc: documentNode }).tr
  for (const replacement of replacements.reverse()) {
    transaction = transaction.replaceWith(replacement.from, replacement.to, replacement.node)
  }
  return tables.some((table) => countVisualDocumentMarker(transaction.doc, table.marker) !== 0)
    ? null
    : transaction.doc
}

interface SelectedTopLevelBlock {
  node: ProseMirrorNode
  offset: number
}

function selectedTopLevelBlocks(state: EditorState): SelectedTopLevelBlock[] {
  const blocks: SelectedTopLevelBlock[] = []
  const { selection } = state
  const cursorIndex = selection.empty ? selection.$from.index(0) : -1
  state.doc.forEach((node, offset, index) => {
    const selected = selection.empty
      ? index === cursorIndex
      : selection.from < offset + node.nodeSize && selection.to > offset
    if (selected) blocks.push({ node, offset })
  })
  return blocks
}

function topLevelBlockStyle(
  state: EditorState,
  node: ProseMirrorNode,
): VisualBlockStyle {
  const { blockquote, heading, paragraph } = state.schema.nodes
  if (node.type === blockquote) return 'blockquote'
  if (node.type === heading && node.attrs.level === 4) return 'heading-4'
  if (node.type === paragraph) return 'paragraph'
  return 'mixed'
}

function selectedBlockStyleForState(state: EditorState): VisualBlockStyle {
  const blocks = selectedTopLevelBlocks(state)
  const first = blocks[0] ? topLevelBlockStyle(state, blocks[0].node) : 'mixed'
  return first !== 'mixed' && blocks.every(({ node }) => topLevelBlockStyle(state, node) === first)
    ? first
    : 'mixed'
}

export function captureProseMirrorSelectionBookmark(
  view: EditorView,
  domSelection: Selection | null,
): SelectionBookmark {
  if (view.state.selection instanceof CellSelection) return view.state.selection.getBookmark()
  const anchorNode = domSelection?.anchorNode
  const focusNode = domSelection?.focusNode
  if (
    anchorNode
    && focusNode
    && view.dom
    && view.dom.contains(anchorNode)
    && view.dom.contains(focusNode)
  ) {
    const anchor = view.posAtDOM(anchorNode, domSelection.anchorOffset)
    const head = view.posAtDOM(focusNode, domSelection.focusOffset)
    const mapped = TextSelection.between(
      view.state.doc.resolve(anchor),
      view.state.doc.resolve(head),
    )
    if (!view.state.selection.eq(mapped)) {
      view.dispatch(view.state.tr.setSelection(mapped))
    }
  }
  return view.state.selection.getBookmark()
}

interface DomSelectionEndpoints {
  anchorNode: Node
  anchorOffset: number
  focusNode: Node
  focusOffset: number
}

function captureDomSelectionEndpoints(
  view: EditorView,
  domSelection: Selection | null,
): DomSelectionEndpoints | null {
  const anchorNode = domSelection?.anchorNode
  const focusNode = domSelection?.focusNode
  if (
    !anchorNode
    || !focusNode
    || !view.dom?.contains(anchorNode)
    || !view.dom.contains(focusNode)
  ) return null
  return {
    anchorNode,
    anchorOffset: domSelection.anchorOffset,
    focusNode,
    focusOffset: domSelection.focusOffset,
  }
}

function restoreModeSwitchSelection(
  view: EditorView,
  beforeState: EditorState | null,
  endpoints: DomSelectionEndpoints | null,
): EditorState {
  const afterState = view.state
  let selection = afterState.selection
  let mappedEndpoints = false
  if (
    endpoints
    && view.dom?.contains(endpoints.anchorNode)
    && view.dom.contains(endpoints.focusNode)
  ) {
    try {
      const anchor = view.posAtDOM(endpoints.anchorNode, endpoints.anchorOffset)
      const head = view.posAtDOM(endpoints.focusNode, endpoints.focusOffset)
      selection = TextSelection.between(
        afterState.doc.resolve(anchor),
        afterState.doc.resolve(head),
      )
      mappedEndpoints = true
    } catch {
      // A DOM reconciliation can invalidate an endpoint. Fall back below.
    }
  }
  if (!mappedEndpoints && beforeState?.doc.eq(afterState.doc)) {
    try {
      selection = TextSelection.between(
        afterState.doc.resolve(beforeState.selection.anchor),
        afterState.doc.resolve(beforeState.selection.head),
      )
    } catch {
      selection = afterState.selection
    }
  }
  return afterState.selection.eq(selection)
    ? afterState
    : afterState.apply(afterState.tr.setSelection(selection))
}

export function buildMarkdownInsertionTransaction(
  state: EditorState,
  bookmark: SelectionBookmark,
  parser: MarkdownParser,
  markdown: string,
): Transaction {
  const selection = bookmark.resolve(state.doc)
  const transaction = state.tr
    .setSelection(selection)
    .replaceSelection(parseMarkdownInsertionSlice(parser, state.schema, markdown))
    .scrollIntoView()
  const link = state.schema.marks.link
  return link ? transaction.removeStoredMark(link) : transaction
}

export function buildSelectedBlockStyleTransaction(
  state: EditorState,
  style: Exclude<VisualBlockStyle, 'mixed'>,
): Transaction | null {
  const blocks = selectedTopLevelBlocks(state)
  if (!blocks.length || selectedBlockStyleForState(state) === style) return null
  const { blockquote, heading, paragraph } = state.schema.nodes
  if (!blockquote || !heading || !paragraph) return null

  const convertTextblock = (node: ProseMirrorNode) => {
    if (!node.isTextblock) return null
    return style === 'heading-4'
      ? heading.create({ level: 4 }, node.content, node.marks)
      : paragraph.create(null, node.content, node.marks)
  }
  const replacements: ProseMirrorNode[] = []
  if (style === 'blockquote') {
    let pendingParagraphs: ProseMirrorNode[] = []
    const flushPending = () => {
      if (!pendingParagraphs.length) return
      replacements.push(blockquote.create(null, pendingParagraphs))
      pendingParagraphs = []
    }
    for (const { node } of blocks) {
      if (node.type === blockquote) {
        flushPending()
        replacements.push(node)
        continue
      }
      const converted = convertTextblock(node)
      if (!converted) return null
      pendingParagraphs.push(converted)
    }
    flushPending()
  } else {
    for (const { node } of blocks) {
      if (node.type === blockquote) {
        let supported = true
        node.forEach((child) => {
          const converted = convertTextblock(child)
          if (converted) replacements.push(converted)
          else supported = false
        })
        if (!supported) return null
        continue
      }
      const converted = convertTextblock(node)
      if (!converted) return null
      replacements.push(converted)
    }
  }
  if (!replacements.length) return null

  const from = blocks[0].offset
  const last = blocks[blocks.length - 1]
  const to = last.offset + last.node.nodeSize
  const replacement = Fragment.fromArray(replacements)
  const transaction = state.tr.replaceWith(from, to, replacement)
  const selectionFrom = Math.min(from + 1, transaction.doc.content.size)
  const selectionTo = Math.max(
    selectionFrom,
    Math.min(from + replacement.size - 1, transaction.doc.content.size),
  )
  return transaction.setSelection(TextSelection.between(
    transaction.doc.resolve(selectionFrom),
    transaction.doc.resolve(selectionTo),
  ))
}

function flushPendingDomChanges(crepe: Crepe): void {
  try {
    crepe.editor.action((context) => {
      // Milkdown 7.21.3 has no public synchronous DOM boundary. Its pinned
      // ProseMirror view queues native input for up to 20 ms before serialization.
      const view = context.get(editorViewCtx) as unknown as {
        domObserver?: {
          forceFlush?(): void
          flush?(): void
        }
      }
      view.domObserver?.forceFlush?.()
      view.domObserver?.flush?.()
    })
  } catch {
    // A missing or torn-down view has nothing left to flush.
  }
}

function applyNativeSpellCheck(view: EditorView, enabled: boolean): void {
  view.dom.spellcheck = enabled
  view.dom.setAttribute('spellcheck', String(enabled))
}

function measureVisualTranslationGeometry(
  proseMirror: HTMLElement,
  view: EditorView,
): TranslationSelectionGeometry | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  if (
    range.collapsed
    || !proseMirror.contains(range.startContainer)
    || !proseMirror.contains(range.endContainer)
  ) return null
  const anchorRect = normalizeAnchorRect(range.getBoundingClientRect())
  const focusNode = selection.focusNode ?? range.endContainer
  const rawFocusOffset = selection.focusNode ? selection.focusOffset : range.endOffset
  const focusOffset = Number.isSafeInteger(rawFocusOffset) ? rawFocusOffset : 0
  if (!anchorRect || !proseMirror.contains(focusNode)) return null
  const focusPosition = view.posAtDOM(focusNode, focusOffset)
  const focusRect = selectionEndpointRect(
    typeof view.coordsAtPos === 'function'
      ? view.coordsAtPos(focusPosition)
      : range.getBoundingClientRect(),
  )
  return focusRect ? { anchorRect, focusRect } : null
}

export const VisualEditor = forwardRef<VisualEditorHandle, VisualEditorProps>(
  function VisualEditor({ interactionLocked = false, markdown, readClipboardImage, inputCaret = 'custom', editorTheme = DEFAULT_EDITOR_THEME, mermaidAppearance = DEFAULT_MERMAID_APPEARANCE, mermaidPrintDeadlineEpochMs, initialModePosition = null, spellCheckEnabled = false, documentAbsolutePath = null, documentKey, dirty, translationHistory, onChange, onTranslationSelection, onTranslationAnchorChange, translationAnchorRefreshKey, onStickyNoteSelection, onCreateStickyNote, readOnly = false, onReady, onFindReady, onTranslationHistoryReady, onCodeExplanationRequest, onDocumentLink }, ref) {
    const contextMenu = useOptionalContextMenu()
    const businessDialogs = useOptionalBusinessDialog()
    const businessDialogsRef = useRef(businessDialogs)
    businessDialogsRef.current = businessDialogs
    const rootRef = useRef<HTMLDivElement>(null)
    const editorViewRef = useRef<EditorView | null>(null)
    const interactionLockedRef = useRef(interactionLocked)
    useLayoutEffect(() => {
      interactionLockedRef.current = interactionLocked
      editorViewRef.current?.setProps({ editable: () => !readOnly && !interactionLockedRef.current })
    }, [interactionLocked, readOnly])
    const mermaidRegistryRef = useRef<MermaidRegistryPort | null>(null)
    const mermaidAppearanceRef = useRef(mermaidAppearance)
    mermaidAppearanceRef.current = mermaidAppearance
    const spellCheckEnabledRef = useRef(spellCheckEnabled)
    spellCheckEnabledRef.current = spellCheckEnabled
    const documentKeyRef = useRef(documentKey)
    const documentAbsolutePathRef = useRef(documentAbsolutePath)
    documentAbsolutePathRef.current = documentAbsolutePath
    const clipboardLifetimeRef = useRef(0)
    useLayoutEffect(() => { clipboardLifetimeRef.current += 1 }, [documentKey])
    const readClipboardImageRef = useRef(readClipboardImage)
    readClipboardImageRef.current = readClipboardImage
    const pasteClipboardRef = useRef<(imageOnly?: boolean, tableText?: boolean) => Promise<boolean>>(async () => false)
    const translationHistoryRef = useRef(translationHistory)
    documentKeyRef.current = documentKey
    translationHistoryRef.current = translationHistory
    const historyRecords = documentKey && translationHistory
      ? translationHistory.recordsForDocument(documentKey)
      : []
    const initialMarkdownRef = useRef(markdown)
    const initialModePositionRef = useRef(initialModePosition)
    const onChangeRef = useRef(onChange)
    const aiDirtyRef = useRef(false)
    const aiExactMarkdownMirrorRef = useRef<VisualAiExactMarkdownMirror | null>(null)
    const aiObservedDocumentRef = useRef<ProseMirrorNode | null>(null)
    const aiMarkdownPropRef = useRef(markdown)
    const aiCaptureRef = useRef<() => Readonly<{ markdown: string; dirty: boolean }>>(() => {
      throw new Error('Visual editor is unavailable')
    })
    const aiPrepareRef = useRef<(replacementMarkdown: string) => PreparedVisualAiReplacement>(() => {
      throw new Error('Visual editor is unavailable')
    })
    const aiApplyRef = useRef<(
      prepared: PreparedVisualAiReplacement,
      replacementMarkdown: string,
    ) => void>(() => {
      throw new Error('Visual editor is unavailable')
    })
    const aiAdapterStateRef = useRef<{
      documentKey: string | undefined
      adapter: ReturnType<typeof createWorkspaceAiEditorAdapter<PreparedVisualAiReplacement>>
    } | null>(null)
    const onTranslationSelectionRef = useRef(onTranslationSelection)
    const onTranslationAnchorChangeRef = useRef(onTranslationAnchorChange)
    const onStickyNoteSelectionRef = useRef(onStickyNoteSelection)
    const onCreateStickyNoteRef = useRef(onCreateStickyNote)
    const onReadyRef = useRef(onReady)
    const onFindReadyRef = useRef(onFindReady)
    const onTranslationHistoryReadyRef = useRef(onTranslationHistoryReady)
    const onCodeExplanationRequestRef = useRef(onCodeExplanationRequest)
    const onDocumentLinkRef = useRef(onDocumentLink)
    onDocumentLinkRef.current = onDocumentLink
    const flushRef = useRef<() => string | null>(() => null)
    const captureModeSwitchRef = useRef<(fallbackMarkdown: string) => ({
      checkpoint: string
      position: EditorModePosition | null
    } | null)>(() => null)
    const captureModePositionRef = useRef<(targetMarkdown?: string) => EditorModePosition | null>(() => null)
    const captureSelectionRef = useRef<() => boolean>(() => false)
    const insertMarkdownRef = useRef<(markdown: string) => boolean>(() => false)
    const insertDroppedLinkRef = useRef<(input: DroppedLinkInsertion) => boolean>(() => false)
    const insertDroppedMarkdownRef = useRef<(input: DroppedMarkdownInsertion) => boolean>(() => false)
    const selectedBlockStyleRef = useRef<() => VisualBlockStyle>(() => 'mixed')
    const setSelectedBlockStyleRef = useRef<(style: Exclude<VisualBlockStyle, 'mixed'>) => boolean>(() => false)
    const marginSelectionPortRef = useRef<EditorMarginSelectionPort | null>(null)
    const revealTranslationHistoryRecordRef = useRef<TranslationHistoryEditorHandle['revealTranslationHistoryRecord']>(() => false)
    const flushTranslationHistoryAnchorsRef = useRef<TranslationHistoryEditorHandle['flushTranslationHistoryAnchors']>(() => [])
    const capturePendingTranslationAnchorRef = useRef<TranslationHistoryEditorHandle['capturePendingTranslationAnchor']>(() => false)
    const bindPendingTranslationAnchorRef = useRef<TranslationHistoryEditorHandle['bindPendingTranslationAnchor']>(() => undefined)
    const promotePendingTranslationAnchorRef = useRef<TranslationHistoryEditorHandle['promotePendingTranslationAnchor']>(() => null)
    const discardPendingTranslationAnchorRef = useRef<TranslationHistoryEditorHandle['discardPendingTranslationAnchor']>(() => undefined)
    const syncTranslationHistoryRecordsRef = useRef<(records: typeof historyRecords) => boolean>(() => false)
    const mermaidPrintDeadlineEpochMsRef = useRef(mermaidPrintDeadlineEpochMs)
    onChangeRef.current = onChange
    onTranslationSelectionRef.current = onTranslationSelection
    onTranslationAnchorChangeRef.current = onTranslationAnchorChange
    onStickyNoteSelectionRef.current = onStickyNoteSelection
    onCreateStickyNoteRef.current = onCreateStickyNote
    onReadyRef.current = onReady
    onFindReadyRef.current = onFindReady
    onTranslationHistoryReadyRef.current = onTranslationHistoryReady
    onCodeExplanationRequestRef.current = onCodeExplanationRequest
    mermaidPrintDeadlineEpochMsRef.current = mermaidPrintDeadlineEpochMs

    useImperativeHandle(ref, () => ({
      flush: () => flushRef.current(),
      createWorkspaceAiEditorPort: () => {
        const current = aiAdapterStateRef.current
        if (!current) throw new Error('Visual editor AI adapter is unavailable')
        return current.adapter.createPort()
      },
      whenRenderIdle: async () => {
        const registry = mermaidRegistryRef.current
        if (!registry) return
        await registry.renderAll(mermaidPrintDeadlineEpochMsRef.current)
        await registry.whenIdle()
      },
      captureModeSwitch: (fallbackMarkdown) => captureModeSwitchRef.current(fallbackMarkdown),
      captureModePosition: (targetMarkdown) => captureModePositionRef.current(targetMarkdown),
      captureSelection: () => captureSelectionRef.current(),
      pasteClipboard: (imageOnly) => pasteClipboardRef.current(imageOnly),
      insertMarkdown: (nextMarkdown) => insertMarkdownRef.current(nextMarkdown),
      insertDroppedLink: (input) => insertDroppedLinkRef.current(input),
      insertDroppedMarkdown: (input) => insertDroppedMarkdownRef.current(input),
      selectedBlockStyle: () => selectedBlockStyleRef.current(),
      setSelectedBlockStyle: (style) => setSelectedBlockStyleRef.current(style),
      marginSelectionPort: () => marginSelectionPortRef.current,
      revealTranslationHistoryRecord: (recordId, alignment) => revealTranslationHistoryRecordRef.current(recordId, alignment),
      flushTranslationHistoryAnchors: () => flushTranslationHistoryAnchorsRef.current(),
      capturePendingTranslationAnchor: (pendingKey) => capturePendingTranslationAnchorRef.current(pendingKey),
      bindPendingTranslationAnchor: (pendingKey, requestId) => bindPendingTranslationAnchorRef.current(pendingKey, requestId),
      promotePendingTranslationAnchor: (requestId) => promotePendingTranslationAnchorRef.current(requestId),
      discardPendingTranslationAnchor: (key) => discardPendingTranslationAnchorRef.current(key),
    }), [])

    useLayoutEffect(() => {
      mermaidRegistryRef.current?.refreshAppearance(mermaidAppearance)
    }, [mermaidAppearance])

    useEffect(() => {
      const view = editorViewRef.current
      if (view) applyNativeSpellCheck(view, spellCheckEnabled)
    }, [spellCheckEnabled])

    useLayoutEffect(() => {
      aiDirtyRef.current = typeof dirty === 'boolean' ? dirty : false
      aiExactMarkdownMirrorRef.current = null
      aiObservedDocumentRef.current = null
      const adapter = createWorkspaceAiEditorAdapter<PreparedVisualAiReplacement>({
        capture: () => aiCaptureRef.current(),
        prepareReplacement: (replacementMarkdown) => aiPrepareRef.current(replacementMarkdown),
        applyReplacement: (prepared, replacementMarkdown) => (
          aiApplyRef.current(prepared, replacementMarkdown)
        ),
      })
      aiAdapterStateRef.current = { documentKey, adapter }
      return () => {
        adapter.dispose()
        if (aiAdapterStateRef.current?.adapter === adapter) aiAdapterStateRef.current = null
      }
    }, [documentKey])

    useLayoutEffect(() => {
      if (aiMarkdownPropRef.current !== markdown) {
        if (aiExactMarkdownMirrorRef.current?.markdown !== markdown) {
          aiExactMarkdownMirrorRef.current = null
        }
        aiMarkdownPropRef.current = markdown
      }
      if (typeof dirty === 'boolean') aiDirtyRef.current = dirty
    }, [dirty, markdown])

    useLayoutEffect(() => {
      if (!documentKey || !translationHistory) return
      if (syncTranslationHistoryRecordsRef.current(historyRecords) && documentKey) {
        onTranslationHistoryReadyRef.current?.(documentKey)
      }
    })

    useLayoutEffect(() => {
      if (translationAnchorRefreshKey === undefined) return
      const callback = onTranslationAnchorChangeRef.current
      if (!callback) return
      const proseMirror = rootRef.current?.querySelector<HTMLElement>('.ProseMirror')
      const view = editorViewRef.current
      if (!proseMirror || !view) {
        callback(null)
        return
      }
      try {
        callback(measureVisualTranslationGeometry(proseMirror, view))
      } catch {
        callback(null)
      }
    }, [translationAnchorRefreshKey])

    useEffect(() => {
      const root = rootRef.current
      if (!root) return
      const requestCodeExplanation = (event: Event) => {
        const detail = (event as CustomEvent<unknown>).detail
        if (
          typeof detail !== 'object'
          || detail === null
          || !('language' in detail)
          || typeof detail.language !== 'string'
          || !('code' in detail)
          || typeof detail.code !== 'string'
          || !detail.code
        ) return
        onCodeExplanationRequestRef.current?.({
          language: detail.language,
          code: detail.code,
        })
      }
      root.addEventListener(CODE_EXPLANATION_REQUEST_EVENT, requestCodeExplanation)
      return () => root.removeEventListener(
        CODE_EXPLANATION_REQUEST_EVENT,
        requestCodeExplanation,
      )
    }, [])

    useEffect(() => {
      const navigate = (event: Event) => {
        const detail = (event as CustomEvent<unknown>).detail
        if (
          typeof detail !== 'object'
          || detail === null
          || !('index' in detail)
          || !Number.isSafeInteger(detail.index)
        ) return
        const headings = rootRef.current?.querySelectorAll(
          '.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, '
          + '.ProseMirror h4, .ProseMirror h5, .ProseMirror h6',
        )
        const heading = headings?.item(detail.index as number)
        heading?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      window.addEventListener('arkdown:navigate-heading', navigate)
      return () => window.removeEventListener('arkdown:navigate-heading', navigate)
    }, [])

    useEffect(() => {
      const root = rootRef.current
      if (!root) return

      const mermaidRenderer = getWindowMermaidRenderService()
      const mermaidRegistry = createMermaidViewRegistry(mermaidAppearanceRef.current)
      mermaidRegistryRef.current = mermaidRegistry
      let mermaidDisposed = false
      const disposeMermaid = () => {
        if (mermaidDisposed) return
        mermaidDisposed = true
        if (mermaidRegistryRef.current === mermaidRegistry) mermaidRegistryRef.current = null
        mermaidRegistry.dispose()
      }

      const detachLinkInteraction = installLinkInteraction(
        root,
        window.arkdown?.openExternal,
        (message) => { void businessDialogsRef.current?.alert({ title: message }) },
        (href) => {
          if (!onDocumentLinkRef.current) throw new Error('请在 Arkdown 文档窗口中查看相对文档链接')
          return onDocumentLinkRef.current(href)
        },
      )

      let active = true
      let ready = false
      let lastCommittedMarkdown = initialMarkdownRef.current
      let destroyStarted = false
      let destroyTask: Promise<void> | null = null
      let pendingFindAction: DocumentFindAction | null = null
      let findSession: ReturnType<typeof createVisualDocumentFindSession> | null = null
      let detachResponsiveTables: () => void = () => undefined
      let activeLinkEditor: ReturnType<typeof createLinkEditorPopover> | null = null
      const externalDropTarget: VisualDropTargetHandle = { request: { status: 'idle' } }
      const translationProvenance = createTranslationSelectionProvenance()
      let translationSurface: HTMLElement | null = null
      let translationGeneration = 0
      let translationPointerRect: SelectionAnchorRect | null = null
      let documentTranslationActive = false

      const openLinkEditor = (options: Parameters<typeof createLinkEditorPopover>[0]) => {
        const controller = createLinkEditorPopover(options)
        activeLinkEditor = controller
        return controller
      }

      const invalidateTranslationGesture = (invalidate = () => translationProvenance.reset()) => {
        translationGeneration += 1
        translationSurface = null
        invalidate()
      }

      const currentProseMirror = (): HTMLElement | null => {
        const proseMirror = root.querySelector<HTMLElement>('.ProseMirror')
        const view = editorViewRef.current
        return proseMirror && proseMirror.isConnected && view?.dom === proseMirror
          ? proseMirror
          : null
      }
      const currentScrollContainer = (): HTMLElement | null => {
        const proseMirror = currentProseMirror()
        return proseMirror?.closest<HTMLElement>('.editor-surface') ?? root
      }
      const isSidebarLayoutStable = () => {
        const track = root.closest('.editor-pane')
          ?.querySelector<HTMLElement>('.editor-right-sidebar-motion-track')
        return !track || track.dataset.phase === 'open'
      }
      const marginSelectionPort: EditorMarginSelectionPort = {
        isEligibleMarginStart: (event) => {
          const proseMirror = currentProseMirror()
          const scroll = currentScrollContainer()
          if (!proseMirror || !scroll || !isSidebarLayoutStable()) return false
          const exclusionScroll = scroll.classList.contains('editor-surface') ? scroll : null
          if (isEditorMarginSelectionExcluded(event, event.target, exclusionScroll)) return false
          const viewport = scroll.getBoundingClientRect()
          const content = proseMirror.getBoundingClientRect()
          if (
            event.clientX < viewport.left
            || event.clientX > viewport.right
            || event.clientY < viewport.top
            || event.clientY > viewport.bottom
          ) return false
          const outsideTextColumn = event.clientX < content.left || event.clientX > content.right
          if (!outsideTextColumn) return false
          return !(
            scroll.classList.contains('has-visual-translation-history-rail')
            && event.clientX > content.right
          )
        },
        activationPositionAtPoint: ({ clientX, clientY }) => {
          const proseMirror = currentProseMirror()
          const view = editorViewRef.current
          const scroll = currentScrollContainer()
          if (!proseMirror || !view || !scroll) return null
          const content = proseMirror.getBoundingClientRect()
          const viewport = scroll.getBoundingClientRect()
          const visibleTop = Math.max(content.top, viewport.top)
          const visibleBottom = Math.min(content.bottom, viewport.bottom)
          if (
            clientX < content.left
            || clientX > content.right
            || clientY < visibleTop
            || clientY > visibleBottom
          ) return null
          return view.posAtCoords({ left: clientX, top: clientY })?.pos ?? null
        },
        positionAtPoint: ({ clientX, clientY }) => {
          const proseMirror = currentProseMirror()
          const view = editorViewRef.current
          const scroll = currentScrollContainer()
          if (!proseMirror || !view || !scroll) return null
          const content = proseMirror.getBoundingClientRect()
          const viewport = scroll.getBoundingClientRect()
          const left = Math.max(content.left + 0.5, Math.min(content.right - 0.5, clientX))
          const visibleTop = Math.max(content.top, viewport.top)
          const visibleBottom = Math.min(content.bottom, viewport.bottom)
          if (visibleBottom <= visibleTop) return null
          const top = Math.max(visibleTop + 0.5, Math.min(visibleBottom - 0.5, clientY))
          return view.posAtCoords({ left, top })?.pos ?? null
        },
        applySelection: (anchor, head) => {
          const view = editorViewRef.current
          if (!view) return
          const size = view.state.doc.content.size
          const next = TextSelection.between(
            view.state.doc.resolve(Math.max(0, Math.min(size, Math.trunc(anchor)))),
            view.state.doc.resolve(Math.max(0, Math.min(size, Math.trunc(head)))),
          )
          if (!view.state.selection.eq(next)) view.dispatch(view.state.tr.setSelection(next))
        },
        focus: () => editorViewRef.current?.focus(),
        scrollContainer: currentScrollContainer,
        beginPointerSelection: (event) => {
          const proseMirror = currentProseMirror()
          if (!proseMirror) return
          translationGeneration += 1
          translationSurface = proseMirror
          translationProvenance.pointerDown(event)
        },
        cancelPointerSelection: () => invalidateTranslationGesture(),
      }

      const reportVisualSelection = (
        proseMirror: HTMLElement,
        generation: number,
        releaseRect: SelectionAnchorRect,
      ) => {
        if (
          !active
          || generation !== translationGeneration
          || !root.isConnected
          || root.querySelector<HTMLElement>('.ProseMirror') !== proseMirror
          || !onTranslationSelectionRef.current
        ) return
        documentTranslationActive = false
        const selection = window.getSelection()
        if (!selection || selection.rangeCount !== 1) {
          onTranslationSelectionRef.current(null)
          return
        }

        const range = selection.getRangeAt(0)
        if (
          range.collapsed
          || !proseMirror.contains(range.startContainer)
          || !proseMirror.contains(range.endContainer)
        ) {
          onTranslationSelectionRef.current(null)
          return
        }

        try {
          const exported: {
            content: TranslationSelection['content']
            geometry: TranslationSelectionGeometry
            range: { from: number; to: number }
          } | null = crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            if (view.state.selection instanceof NodeSelection || view.state.selection instanceof CellSelection) return null
            const from = view.posAtDOM(range.startContainer, range.startOffset)
            const to = view.posAtDOM(range.endContainer, range.endOffset)
            const start = Math.max(0, Math.min(from, to))
            const end = Math.min(view.state.doc.content.size, Math.max(from, to))
            if (start === end) return null
            const geometry = measureVisualTranslationGeometry(proseMirror, view)
            if (!geometry) return null
            return {
              range: { from: start, to: end },
              content: exportVisualTranslationSelection({
                slice: view.state.doc.slice(start, end),
                listContext: { documentNode: view.state.doc, from: start, to: end },
                schema: view.state.schema,
                serializer: context.get(serializerCtx),
                selectionTouchesTable: selectionTouchesTable(
                  view.state.doc,
                  start,
                  end,
                ),
              }).content,
              geometry,
            }
          })
          if (!exported || !exported.content.markdown.trim()) {
            onTranslationSelectionRef.current(null)
            return
          }
          onTranslationSelectionRef.current({
            content: exported.content,
            range: exported.range,
            mode: 'visual',
            anchorRect: exported.geometry.anchorRect,
            focusRect: exported.geometry.focusRect,
            releaseRect,
          })
        } catch {
          onTranslationSelectionRef.current(null)
        }
      }

      const reportVisualDocumentSelection = (
        proseMirror: HTMLElement,
        generation: number,
      ) => {
        const callback = onTranslationSelectionRef.current
        if (
          !active
          || generation !== translationGeneration
          || !root.isConnected
          || root.querySelector<HTMLElement>('.ProseMirror') !== proseMirror
          || !callback
        ) return

        try {
          const exported: {
            content: TranslationSelection['content']
            geometry: TranslationSelectionGeometry
          } | null = crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            const selection = view.state.selection
            const end = view.state.doc.content.size
            if (end === 0 || selection.from !== 0 || selection.to !== end) return null
            const geometry = measureVisualTranslationGeometry(proseMirror, view)
            if (!geometry) return null
            return {
              content: exportVisualTranslationSelection({
                slice: view.state.doc.slice(0, end),
                schema: view.state.schema,
                serializer: context.get(serializerCtx),
                selectionTouchesTable: selectionTouchesTable(view.state.doc, 0, end),
              }).content,
              geometry,
            }
          })
          if (!exported || !exported.content.markdown.trim()) {
            documentTranslationActive = false
            callback(null)
            return
          }
          documentTranslationActive = true
          callback({
            content: exported.content,
            mode: 'visual',
            scope: 'document',
            anchorRect: exported.geometry.anchorRect,
            focusRect: exported.geometry.focusRect,
            releaseRect: translationPointerRect ?? exported.geometry.focusRect,
          })
        } catch {
          documentTranslationActive = false
          callback(null)
        }
      }

      const onTranslationPointerDown = (event: PointerEvent) => {
        translationGeneration += 1
        translationSurface = null
        const proseMirror = root.querySelector<HTMLElement>('.ProseMirror')
        const target = event.target
        if (
          !proseMirror
          || !(target instanceof Node)
          || !proseMirror.contains(target)
          || (target instanceof Element && target.closest('img, video, audio, .arkdown-local-image'))
        ) {
          translationProvenance.reset()
          return
        }
        translationSurface = proseMirror
        translationProvenance.pointerDown(event)
      }
      const onTranslationPointerMove = (event: PointerEvent) => {
        const proseMirror = currentProseMirror()
        const target = event.target
        if (
          event.pointerType !== 'mouse'
          || !proseMirror
          || !(target instanceof Node)
          || !proseMirror.contains(target)
        ) return
        translationPointerRect = pointerReleaseRect(event)
      }
      const onTranslationPointerUp = (event: PointerEvent) => {
        const proseMirror = translationSurface
        translationSurface = null
        const releaseRect = pointerReleaseRect(event)
        if (!proseMirror || !translationProvenance.pointerUp(event) || !releaseRect) return
        const generation = translationGeneration
        // Wait for the compatibility mouse events to finish collapsing a clicked selection.
        requestAnimationFrame(() => reportVisualSelection(proseMirror, generation, releaseRect))
      }
      const onTranslationCompositionStart = () => {
        invalidateTranslationGesture(() => translationProvenance.compositionStart())
      }
      const onTranslationCompositionEnd = () => {
        invalidateTranslationGesture(() => translationProvenance.compositionEnd())
      }
      const onTranslationDragStart = () => {
        invalidateTranslationGesture(() => translationProvenance.dragStart())
      }
      const onTranslationContextMenu = () => {
        invalidateTranslationGesture(() => translationProvenance.contextMenu())
      }
      const onTranslationKeyDown = (event: KeyboardEvent) => {
        invalidateTranslationGesture(() => translationProvenance.keyDown())
        if (!isDocumentTranslationShortcut(event)) {
          if (documentTranslationActive) {
            documentTranslationActive = false
            onTranslationSelectionRef.current?.(null)
          }
          return
        }
        const proseMirror = currentProseMirror()
        const target = event.target
        if (
          !proseMirror
          || !(target instanceof Node)
          || !proseMirror.contains(target)
        ) return
        const generation = translationGeneration
        // Wait until the native key event has updated ProseMirror's selection.
        requestAnimationFrame(() => reportVisualDocumentSelection(proseMirror, generation))
      }
      const resetForBlur = () => invalidateTranslationGesture()
      const onTranslationBlur = (event: FocusEvent) => {
        const relatedTarget = event.relatedTarget
        if (relatedTarget instanceof Node && root.contains(relatedTarget)) return
        if (relatedTarget !== null) {
          resetForBlur()
          return
        }
        queueMicrotask(() => {
          if (!active) return
          const activeElement = document.activeElement
          if (activeElement instanceof Node && root.contains(activeElement)) return
          resetForBlur()
        })
      }

      root.addEventListener('pointerdown', onTranslationPointerDown)
      root.addEventListener('pointermove', onTranslationPointerMove)
      root.ownerDocument.addEventListener('pointerup', onTranslationPointerUp, true)
      root.addEventListener('compositionstart', onTranslationCompositionStart)
      root.addEventListener('compositionend', onTranslationCompositionEnd)
      root.addEventListener('dragstart', onTranslationDragStart)
      root.addEventListener('contextmenu', onTranslationContextMenu)
      root.addEventListener('keydown', onTranslationKeyDown, true)
      root.addEventListener('blur', onTranslationBlur, true)

      const applyFindAction = (action: DocumentFindAction) => {
        if (!findSession) {
          pendingFindAction = action
          return
        }
        switch (action.type) {
          case 'query':
            findSession.setQuery(action.query)
            break
          case 'next':
            findSession.next()
            break
          case 'previous':
            findSession.previous()
            break
          case 'close':
            findSession.close()
            break
        }
      }

      const onDocumentFind = (event: Event) => {
        const action = readDocumentFindAction(event)
        if (action) applyFindAction(action)
      }
      window.addEventListener(DOCUMENT_FIND_EVENT, onDocumentFind)

      const provenance = createUserEditProvenance()
      const detachProvenance = provenance.attach(root)
      const preparedEnhancedTables = prepareEnhancedTables(initialMarkdownRef.current)
      const crepe = new Crepe({
        root,
        defaultValue: preparedEnhancedTables.markdown,
        featureConfigs: {
          [Crepe.Feature.Placeholder]: { text: '拖入文档或开始输入文字...', mode: 'doc' },
          [Crepe.Feature.CodeMirror]: {
            copyText: '复制',
            extensions: [codeMirrorTooltips],
            searchPlaceholder: '搜索语言',
            noResultText: '未找到语言',
            previewLabel: '预览',
            previewLoading: '正在生成预览…',
          },
        },
        features: {
          [Crepe.Feature.AI]: false,
          [Crepe.Feature.BlockEdit]: false,
          [Crepe.Feature.Cursor]: false,
          [Crepe.Feature.ImageBlock]: false,
          [Crepe.Feature.LinkTooltip]: false,
          [Crepe.Feature.Latex]: true,
          [Crepe.Feature.Table]: false,
          [Crepe.Feature.TopBar]: false,
          [Crepe.Feature.Toolbar]: false,
        },
      })
      const detachStructuredBlockAppearance = installStructuredBlockAppearance(root)
      crepe.editor.config((context) => {
        context.update(orderedListAttr.key, (current) => (node) => {
          const attributes = current(node)
          return {
            ...attributes,
            style: [attributes.style, `--arkdown-ordered-list-start: ${node.attrs.order - 1}`]
              .filter(Boolean).join(';'),
          }
        })
        context.update(editorViewOptionsCtx, (current) => ({
          ...current,
          editable: () => !readOnly && !interactionLockedRef.current,
        }))
      })
      crepe.editor.use($prose(createVisualTabPlugin))
      crepe.editor.use($prose(createSelectionTargetPlugin))
      crepe.editor.use($prose(createSmartLinkPlugin))
      crepe.editor.use($prose(createVisualParagraphEnterPlugin))
      if (inputCaret === 'custom') crepe.editor.use($prose(createVisualInputCaretPlugin))
      crepe.editor.use($prose(createStructuredBlockFocusExitPlugin))
      crepe.editor.use($prose(() => createVisualLineEndCaretPlugin()))
      crepe.editor.use($prose(() => createVisualDropInsertionPlugin({ externalDropTarget })))
      crepe.editor.use($prose(() => provenance.plugin))
      crepe.editor.use($prose(() => new Plugin<null>({
        filterTransaction: transaction => !interactionLockedRef.current
          || (!transaction.docChanged && !transaction.selectionSet),
        state: {
          init: () => null,
          apply: (transaction, value) => {
            if (
              active
              && ready
              && transaction.docChanged
              && transaction.getMeta(VISUAL_AI_TRANSACTION_META) !== true
            ) {
              aiExactMarkdownMirrorRef.current = null
              aiObservedDocumentRef.current = transaction.doc
              aiDirtyRef.current = true
              aiAdapterStateRef.current?.adapter.noteEditorEdit()
            }
            return value
          },
        },
      })))
      if (documentKey && translationHistory) {
        crepe.editor.use($prose(() => createVisualTranslationHistoryPlugin({
          records: historyRecords,
          onOpenRecord: (recordId) => translationHistoryRef.current?.onOpenRecord(recordId),
          onAnchorsChanged: (updates) => {
            const currentDocumentKey = documentKeyRef.current
            if (currentDocumentKey) {
              translationHistoryRef.current?.onAnchorsChanged(currentDocumentKey, updates)
            }
          },
        })))
      }
      crepe.editor.use(localAssetLinkView)
      crepe.editor.use(defaultHorizontalRuleView)
      for (const plugin of frontmatterEditorPlugins) crepe.editor.use(plugin)
      for (const plugin of extendedInlineMarkPlugins) crepe.editor.use(plugin)
      for (const plugin of enhancedTableEditorPlugins) crepe.editor.use(plugin)
      crepe.editor.use(createAdaptiveMermaidCodeBlockView({
        registry: mermaidRegistry,
        renderer: mermaidRenderer,
      }))

      let serializeTaskCheckboxes: ReturnType<typeof createTaskCheckboxSerializer> | null = null
      const resetTaskCheckboxBaseline = (document: ProseMirrorNode, source: string) => {
        serializeTaskCheckboxes = createTaskCheckboxSerializer(document, source, (node) => (
          crepe.editor.action((context) => serializeDocumentWithEnhancedTables(
            node, node.type.schema, context.get(serializerCtx),
          ))
        ), (source) => crepe.editor.action((context) => context.get(remarkCtx).parse(source)))
      }

      const getEditorMarkdown = (): string => {
        let serialized: string | null = null
        try {
        crepe.editor.action((context) => {
          const view = context.get(editorViewCtx)
          serialized = serializeTaskCheckboxes?.(view.state.doc) ?? serializeDocumentWithEnhancedTables(
            view.state.doc,
            view.state.schema,
            context.get(serializerCtx),
          )
        })
        } catch {
          return crepe.getMarkdown()
        }
        return serialized ?? crepe.getMarkdown()
      }

      captureModePositionRef.current = (targetMarkdown) => {
        if (!active || !ready) return null
        let position: EditorModePosition | null = null
        try {
          flushPendingDomChanges(crepe)
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            position = captureSerializedVisualModePosition(
              view.state,
              (documentNode) => serializeDocumentWithEnhancedTables(
                documentNode,
                view.state.schema,
                context.get(serializerCtx),
              ),
              targetMarkdown,
            )
          })
        } catch {
          const view = editorViewRef.current
          position = view
            ? captureVisualModePosition(view.state.doc, view.state.selection.head)
            : null
        }
        return position
      }

      const commitUserMarkdown = (nextMarkdown: string): string => {
        provenance.consumePending()
        if (readOnly) return nextMarkdown
        if (nextMarkdown !== lastCommittedMarkdown) {
          lastCommittedMarkdown = nextMarkdown
          aiExactMarkdownMirrorRef.current = null
          aiObservedDocumentRef.current = editorViewRef.current?.state?.doc ?? null
          aiDirtyRef.current = true
          onChangeRef.current(nextMarkdown)
        }
        return nextMarkdown
      }

      aiCaptureRef.current = () => {
        if (!active || !ready || readOnly || interactionLockedRef.current) throw new Error('Visual editor is unavailable')
        flushPendingDomChanges(crepe)
        let documentNode: ProseMirrorNode | null = null
        crepe.editor.action((context) => {
          documentNode = context.get(editorViewCtx).state.doc
        })
        if (!documentNode) throw new Error('Visual editor is unavailable')
        if (
          aiObservedDocumentRef.current
          && aiObservedDocumentRef.current !== documentNode
        ) {
          aiExactMarkdownMirrorRef.current = null
          aiAdapterStateRef.current?.adapter.noteEditorEdit()
        }
        aiObservedDocumentRef.current = documentNode
        const mirror = aiExactMarkdownMirrorRef.current
        return {
          markdown: mirror?.document === documentNode ? mirror.markdown : getEditorMarkdown(),
          dirty: aiDirtyRef.current,
        }
      }
      aiPrepareRef.current = (replacementMarkdown) => {
        if (!active || !ready || readOnly || interactionLockedRef.current) throw new Error('Visual editor is unavailable')
        let parsed: ProseMirrorNode | null = null
        crepe.editor.action((context) => {
          const view = context.get(editorViewCtx)
          const prepared = prepareEnhancedTables(replacementMarkdown)
          if (!prepared.valid) return
          const documentNode = context.get(parserCtx)(prepared.markdown)
          parsed = restorePreparedEnhancedTablesInDocument(
            documentNode,
            view.state.schema,
            prepared.tables,
          )
        })
        if (!parsed) throw new Error('Visual replacement could not be parsed')
        return Object.freeze({ document: parsed })
      }
      aiApplyRef.current = (prepared, replacementMarkdown) => {
        if (!active || !ready || readOnly || interactionLockedRef.current) throw new Error('Visual editor is unavailable')
        let appliedDocument: ProseMirrorNode | null = null
        crepe.editor.action((context) => {
          const view = context.get(editorViewCtx)
          if (view.isDestroyed || prepared.document.type !== view.state.doc.type) {
            throw new Error('Visual editor lifecycle changed')
          }
          view.dispatch(
            view.state.tr.replaceWith(
              0,
              view.state.doc.content.size,
              prepared.document.content,
            ).setMeta(VISUAL_AI_TRANSACTION_META, true),
          )
          appliedDocument = view.state.doc
        })
        if (!appliedDocument) throw new Error('Visual editor transaction was not applied')
        resetTaskCheckboxBaseline(appliedDocument, replacementMarkdown)
        lastCommittedMarkdown = replacementMarkdown
        aiObservedDocumentRef.current = appliedDocument
        aiExactMarkdownMirrorRef.current = Object.freeze({
          document: appliedDocument,
          markdown: replacementMarkdown,
        })
        aiDirtyRef.current = true
        onChangeRef.current(replacementMarkdown)
      }

      captureModeSwitchRef.current = (fallbackMarkdown) => {
        if (!active || !ready) return null
        const capture: {
          beforeState: EditorState | null
          endpoints: DomSelectionEndpoints | null
          state: EditorState | null
          serialize: ((documentNode: ProseMirrorNode) => string) | null
        } = {
          beforeState: null,
          endpoints: null,
          state: null,
          serialize: null,
        }
        try {
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            capture.beforeState = view.state
            capture.endpoints = captureDomSelectionEndpoints(
              view,
              root.ownerDocument.getSelection(),
            )
          })
        } catch {
          // Flushing can still provide the regular mode-switch fallback.
        }
        try {
          flushPendingDomChanges(crepe)
        } catch {
          return null
        }
        let checkpoint: string
        try {
          checkpoint = provenance.needsSynchronousCheckpoint()
            ? getEditorMarkdown()
            : fallbackMarkdown
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            capture.state = restoreModeSwitchSelection(
              view,
              capture.beforeState,
              capture.endpoints,
            )
            capture.serialize = (documentNode) => serializeDocumentWithEnhancedTables(
              documentNode,
              view.state.schema,
              context.get(serializerCtx),
            )
          })
          if (!capture.state || !capture.serialize) return null
          const position = captureSerializedVisualModePosition(
            capture.state,
            capture.serialize,
            checkpoint,
          )
          if (!position) return null
          if (provenance.needsSynchronousCheckpoint()) {
            commitUserMarkdown(checkpoint)
          }
          return { checkpoint, position }
        } catch {
          return null
        }
      }

      let selectionBookmark: SelectionBookmark | null = null
      let toolbarTarget: EditorSelectionTarget | null = null
      const toolbarSelection = (view: EditorView) => toolbarTarget && resolveSelectionTarget(view.state,
        { documentKey: documentKeyRef.current, lifetime: clipboardLifetimeRef.current }, toolbarTarget)
      pasteClipboardRef.current = async (imageOnly = false, tableText = false) => {
        if (!active || !ready || readOnly || interactionLockedRef.current) return false
        const key = documentKeyRef.current
        const lifetime = clipboardLifetimeRef.current
        const captured = crepe.editor.action((context) => {
          const view = context.get(editorViewCtx)
          captureProseMirrorSelectionBookmark(view, root.ownerDocument.getSelection())
          return captureSelectionTarget(view.state, { documentKey: key, lifetime })
        })
        if ((captured.cells?.positions.length ?? 0) > 1) return false
        const image = await readClipboardMarkdown(readClipboardImageRef.current, true)
        const text = image ?? (imageOnly ? null : await navigator.clipboard?.readText())
        if (interactionLockedRef.current || !text || !active || !ready || documentKeyRef.current !== key || clipboardLifetimeRef.current !== lifetime) return false
        let inserted = false
        crepe.editor.action((context) => {
          const view = context.get(editorViewCtx)
          if (!resolveSelectionTarget(view.state, { documentKey: documentKeyRef.current, lifetime: clipboardLifetimeRef.current }, captured)) return
          const dispatchPaste = (transaction: Transaction) => view.dispatch(closeHistory(transaction).setMeta('uiEvent', 'paste'))
          if (!image && tableText) {
            if (!replaceTextInsideTableCell(
              { state: view.state, dispatch: dispatchPaste },
              text,
              captured.kind === 'cells'
                ? TextSelection.create(view.state.doc, captured.from, captured.to)
                : captured.bookmark.resolve(view.state.doc),
            )) return
          } else {
            dispatchPaste(buildMarkdownInsertionTransaction(view.state, captured.bookmark, context.get(parserCtx), text))
          }
          view.dispatch(closeHistory(view.state.tr))
          view.focus()
          inserted = true
        })
        if (inserted) queueMicrotask(() => {
          try { commitUserMarkdown(getEditorMarkdown()) } catch { /* editor closed */ }
        })
        return inserted
      }
      captureSelectionRef.current = () => {
        if (!active || !ready || readOnly || interactionLockedRef.current) return false
        try {
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            selectionBookmark = captureProseMirrorSelectionBookmark(
              view,
              root.ownerDocument.getSelection(),
            )
            toolbarTarget = captureSelectionTarget(view.state, { documentKey: documentKeyRef.current, lifetime: clipboardLifetimeRef.current })
            view.focus()
          })
          return true
        } catch {
          selectionBookmark = null
          toolbarTarget = null
          return false
        }
      }

      insertMarkdownRef.current = (nextMarkdown) => {
        if (!active || !ready || readOnly || interactionLockedRef.current || !selectionBookmark) return false
        if (!nextMarkdown || nextMarkdown.length > 1_000_000) return false
        let inserted = false
        try {
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            if (!toolbarSelection(view) || (toolbarTarget?.cells?.positions.length ?? 0) > 1) return
            const transaction = buildMarkdownInsertionTransaction(
              view.state,
              selectionBookmark!,
              context.get(parserCtx),
              nextMarkdown,
            )
            view.focus()
            view.dispatch(transaction)
            selectionBookmark = transaction.selection.getBookmark()
            toolbarTarget = captureSelectionTarget(view.state, { documentKey: documentKeyRef.current, lifetime: clipboardLifetimeRef.current })
            inserted = true
          })
        } catch {
          inserted = false
        }
        if (inserted) queueMicrotask(() => {
          try { commitUserMarkdown(getEditorMarkdown()) } catch { /* editor was closed */ }
        })
        return inserted
      }

      const consumeDroppedInsertionTarget = (
        view: EditorView,
        input: Pick<DroppedLinkInsertion, 'clientX' | 'clientY' | 'visualDropRequestId'>,
      ): { pos: number; cached: boolean } | null => {
        const request = externalDropTarget.request
        if (request.status === 'invalidated') {
          if (
            input.visualDropRequestId !== undefined
            && input.visualDropRequestId !== request.requestId
          ) return null
          externalDropTarget.request = { status: 'idle' }
          return null
        }
        if (request.status === 'dragging') return null
        if (
          request.status === 'pending'
          && input.visualDropRequestId !== undefined
          && input.visualDropRequestId !== request.requestId
        ) return null
        if (request.status === 'idle' && input.visualDropRequestId !== undefined) return null
        const cachedTarget = request.status === 'pending' ? request.target : null
        externalDropTarget.request = { status: 'idle' }
        const pos = cachedTarget?.pos
          ?? view.posAtCoords({ left: input.clientX, top: input.clientY })?.pos
        return pos === undefined ? null : { pos, cached: cachedTarget !== null }
      }

      const commitDroppedInsertion = (inserted: boolean) => {
        if (inserted) queueMicrotask(() => {
          try { commitUserMarkdown(getEditorMarkdown()) } catch { /* editor was closed */ }
        })
      }

      insertDroppedLinkRef.current = (input) => {
        if (!active || !ready || readOnly || interactionLockedRef.current) return false
        let inserted = false
        try {
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            const target = consumeDroppedInsertionTarget(view, input)
            if (!target) return
            const transaction = buildVisualDroppedLinkTransaction(
              view.state,
              target.pos,
              input.absolutePath,
              input.kind,
              target.cached ? { from: target.pos, to: target.pos } : undefined,
            )
            if (!transaction) return
            view.dispatch(transaction)
            view.focus()
            inserted = true
          })
        } catch {
          inserted = false
        }
        commitDroppedInsertion(inserted)
        return inserted
      }

      insertDroppedMarkdownRef.current = (input) => {
        if (
          !active
          || !ready
          || readOnly
          || interactionLockedRef.current
          || !input.markdown
          || input.markdown.length > 1_000_000
        ) return false
        let inserted = false
        try {
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            const target = consumeDroppedInsertionTarget(view, input)
            if (!target) return
            const bookmark = TextSelection.near(view.state.doc.resolve(target.pos)).getBookmark()
            const transaction = buildMarkdownInsertionTransaction(
              view.state,
              bookmark,
              context.get(parserCtx),
              input.markdown,
            )
            view.dispatch(transaction)
            view.focus()
            inserted = true
          })
        } catch {
          inserted = false
        }
        commitDroppedInsertion(inserted)
        return inserted
      }

      selectedBlockStyleRef.current = () => {
        if (!active || !ready || readOnly || interactionLockedRef.current || !selectionBookmark) return 'mixed'
        let selectedStyle: VisualBlockStyle = 'mixed'
        try {
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            const selection = toolbarSelection(view)
            if (!selection) return
            const restoredState = view.state.apply(view.state.tr.setSelection(selection))
            selectedStyle = selectedBlockStyleForState(restoredState)
          })
        } catch {
          selectedStyle = 'mixed'
        }
        return selectedStyle
      }

      setSelectedBlockStyleRef.current = (style) => {
        if (!active || !ready || readOnly || interactionLockedRef.current || !selectionBookmark) return false
        let handled = false
        let changed = false
        try {
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            const selection = toolbarSelection(view)
            if (!selection) return
            view.focus()
            const restoredState = view.state.apply(view.state.tr.setSelection(selection))
            if (selectedBlockStyleForState(restoredState) === style) {
              handled = true
              return
            }
            const transaction = buildSelectedBlockStyleTransaction(restoredState, style)
            if (!transaction) return
            view.dispatch(transaction)
            selectionBookmark = transaction.selection.getBookmark()
            toolbarTarget = captureSelectionTarget(view.state, { documentKey: documentKeyRef.current, lifetime: clipboardLifetimeRef.current })
            handled = true
            changed = true
          })
        } catch {
          handled = false
          changed = false
        }
        if (changed) queueMicrotask(() => {
          try { commitUserMarkdown(getEditorMarkdown()) } catch { /* editor was closed */ }
        })
        return handled
      }

      const withEditorView = <Result,>(
        fallback: Result,
        operation: (view: EditorView) => Result,
      ): Result => {
        if (!active || !ready) return fallback
        let result = fallback
        crepe.editor.action((context) => {
          const view = context.get(editorViewCtx)
          if (view.isDestroyed) return
          result = operation(view)
        })
        return result
      }
      const withHistoryView = <Result,>(
        fallback: Result,
        operation: (view: EditorView) => Result,
      ): Result => {
        if (!documentKeyRef.current || !translationHistoryRef.current) return fallback
        return withEditorView(fallback, operation)
      }
      syncTranslationHistoryRecordsRef.current = (records) => withEditorView(
        false,
        (view) => {
          syncTranslationHistoryRecords(view, records)
          return true
        },
      )
      revealTranslationHistoryRecordRef.current = (recordId, alignment) => withHistoryView(
        false,
        (view) => revealTranslationHistoryRecord(view, recordId, alignment),
      )
      flushTranslationHistoryAnchorsRef.current = () => withHistoryView(
        [],
        (view) => flushTranslationHistoryAnchors(view),
      )
      capturePendingTranslationAnchorRef.current = (pendingKey) => withHistoryView(
        false,
        (view) => capturePendingTranslationAnchor(view, pendingKey),
      )
      bindPendingTranslationAnchorRef.current = (pendingKey, requestId) => withHistoryView(
        undefined,
        (view) => bindPendingTranslationAnchor(view, pendingKey, requestId),
      )
      promotePendingTranslationAnchorRef.current = (requestId) => withHistoryView(
        null,
        (view) => promotePendingTranslationAnchor(view, requestId),
      )
      discardPendingTranslationAnchorRef.current = (key) => withHistoryView(
        undefined,
        (view) => discardPendingTranslationAnchor(view, key),
      )

      const onTableEnter = (event: KeyboardEvent) => {
        if (
          !active
          || !ready
          || readOnly
          || interactionLockedRef.current
          || event.key !== 'Enter'
          || event.ctrlKey
          || event.metaKey
          || event.altKey
          || event.shiftKey
          || event.isComposing
        ) return
        let handled = false
        try {
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            if (!selectionIsInsideSingleTableCell(view.state)) return
            handled = splitParagraphInsideTableCell(view.state, view.dispatch)
            if (handled) view.focus()
          })
        } catch {
          handled = false
        }
        if (!handled) return
        event.preventDefault()
        event.stopImmediatePropagation()
        queueMicrotask(() => {
          try { commitUserMarkdown(getEditorMarkdown()) } catch { /* editor was closed */ }
        })
      }
      root.addEventListener('keydown', onTableEnter, true)

      const captureStickyNoteSelection = (preferEditorSelection = false) => {
        const report = onStickyNoteSelectionRef.current
        if (!report) return
        try {
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            const proseMirror = view.dom
            const browserSelection = window.getSelection()
            const target = captureSelectionTarget(view.state, {
              documentKey: documentKeyRef.current, lifetime: clipboardLifetimeRef.current,
            })
            let from = target.from
            let to = target.to
            if (target.kind === 'text' && !preferEditorSelection && browserSelection?.rangeCount === 1) {
              const range = browserSelection.getRangeAt(0)
              if (
                proseMirror.contains(range.startContainer)
                && proseMirror.contains(range.endContainer)
              ) {
                from = view.posAtDOM(range.startContainer, range.startOffset)
                to = view.posAtDOM(range.endContainer, range.endOffset)
              }
            }
            const start = Math.max(0, Math.min(from, to))
            const end = Math.min(view.state.doc.content.size, Math.max(from, to))
            if (start === end) {
              report(null)
              return
            }
            // Keep authoritative node/cell slices. A different DOM range is cropped exactly,
            // without snapping a selected leaf block to a nearby text cursor.
            const slice = start === target.from && end === target.to ? target.slice : target.doc.slice(start, end)
            const insideTable = (position: number) => {
              const resolved = view.state.doc.resolve(position)
              for (let depth = resolved.depth; depth > 0; depth -= 1) {
                if (resolved.node(depth).type.name === 'table') return true
              }
              return false
            }
            report(exportVisualStickyNoteSelection({
              slice,
              ...(target.kind === 'cells' ? {} : { listContext: { documentNode: target.doc, from: start, to: end } }),
              schema: view.state.schema,
              serialize: (document) => serializeDocumentWithEnhancedTables(
                document,
                view.state.schema,
                context.get(serializerCtx),
              ),
              selectionTouchesTable: insideTable(start) || insideTable(end),
            }))
          })
        } catch {
          report(null)
        }
      }

      const baseVisualContextMenu = contextMenu && !readOnly
        ? createVisualContextMenuHandler({
            crepe,
            menu: contextMenu,
            getMarkdown: getEditorMarkdown,
            pasteClipboard: (tableText) => pasteClipboardRef.current(false, tableText),
            createStickyNote: (selectionChanged) => {
              if (selectionChanged) captureStickyNoteSelection(true)
              onCreateStickyNoteRef.current?.()
            },
            commit: () => {
              try { commitUserMarkdown(getEditorMarkdown()) } catch { /* editor was closed */ }
            },
            openLinkEditor,
            openDocumentLink: (href) => {
              if (!onDocumentLinkRef.current) throw new Error('请在 Arkdown 文档窗口中查看相对文档链接')
              return onDocumentLinkRef.current(href)
            },
            allowYamlFrontmatter: supportsYamlFrontmatterForDocument(documentAbsolutePath),
            dialogs: businessDialogsRef.current,
            isCurrent: () => active && ready && !interactionLockedRef.current,
            getSelectionIdentity: () => ({ documentKey: documentKeyRef.current, lifetime: clipboardLifetimeRef.current }),
          })
        : null
      const visualContextMenu = baseVisualContextMenu
        ? (event: MouseEvent) => {
            captureStickyNoteSelection()
            baseVisualContextMenu(event)
          }
        : null
      if (visualContextMenu) root.addEventListener('contextmenu', visualContextMenu)

      crepe.editor.use(createLocalMediaHtmlView(() => {
        if (!active || !ready) return
        queueMicrotask(() => {
          try { commitUserMarkdown(getEditorMarkdown()) } catch { /* editor was closed */ }
        })
      }, !readOnly, () => documentAbsolutePathRef.current))
      crepe.editor.use(createLocalMarkdownImageView(() => {
        if (!active || !ready) return
        queueMicrotask(() => {
          try { commitUserMarkdown(getEditorMarkdown()) } catch { /* editor was closed */ }
        })
      }, () => documentAbsolutePathRef.current, !readOnly))

      const runMenuCommand = (event: Event) => {
        if (!active || !ready || readOnly || interactionLockedRef.current) return
        if (document.activeElement?.closest('.document-view-panel')) return
        const command = (event as CustomEvent<unknown>).detail as VisualEditorEventCommand
        let handled = true
        let focusAfterCommand = true
        let commitAfterCommand = true
        try {
          crepe.editor.action((context) => {
            const commands = context.get(commandsCtx)
            const view = context.get(editorViewCtx)
            const findAncestor = (names: readonly string[]) => {
              const resolved = view.state.selection.$from
              for (let depth = resolved.depth; depth > 0; depth -= 1) {
                const node = resolved.node(depth)
                if (names.includes(node.type.name)) {
                  return { node, position: resolved.before(depth) }
                }
              }
              return null
            }
            const transformListSelection = (
              nodeType: Parameters<typeof buildListSelectionTransaction>[2],
              checked?: boolean,
            ) => {
              const result = buildListSelectionTransaction(
                view.state,
                listItemSchema.type(context),
                nodeType,
                { toggle: true, ...(typeof checked === 'boolean' ? { checked } : {}) },
              )
              commitAfterCommand = result.status === 'changed'
              if (result.status === 'changed') view.dispatch(result.transaction)
            }

            switch (command) {
              case 'paragraph':
                commands.call(setBlockTypeCommand.key, { nodeType: paragraphSchema.type(context) })
                break
              case 'heading-1':
              case 'heading-2':
              case 'heading-3':
              case 'heading-4':
              case 'heading-5':
              case 'heading-6':
                commands.call(setBlockTypeCommand.key, {
                  nodeType: headingSchema.type(context),
                  attrs: { level: Number(command.at(-1)) },
                })
                break
              case 'unordered-list': {
                transformListSelection(bulletListSchema.type(context))
                break
              }
              case 'ordered-list': {
                transformListSelection(orderedListSchema.type(context))
                break
              }
              case 'task-list': {
                transformListSelection(bulletListSchema.type(context), false)
                break
              }
              case 'blockquote':
                if (findAncestor(['blockquote'])) {
                  lift(view.state, view.dispatch)
                } else {
                  commands.call(wrapInBlockTypeCommand.key, { nodeType: blockquoteSchema.type(context) })
                }
                break
              case 'code-fence':
                commands.call(setBlockTypeCommand.key, {
                  nodeType: findAncestor(['code_block'])
                    ? paragraphSchema.type(context)
                    : codeBlockSchema.type(context),
                })
                break
              case 'strong':
                commands.call(toggleStrongCommand.key)
                break
              case 'list-indent':
                commands.call(sinkListItemCommand.key)
                break
              case 'list-outdent':
                commands.call(liftListItemCommand.key)
                break
              case 'clear-formatting': {
                commands.call(setBlockTypeCommand.key, { nodeType: paragraphSchema.type(context) })
                view.dispatch(view.state.tr.removeMark(
                  view.state.selection.from,
                  view.state.selection.to,
                ))
                break
              }
              case 'heading-promote':
              case 'heading-demote': {
                const parent = view.state.selection.$from.parent
                const current = Number(parent.attrs.level)
                if (parent.type === headingSchema.type(context) && Number.isInteger(current)) {
                  const level = Math.min(6, Math.max(1, current + (command === 'heading-promote' ? -1 : 1)))
                  view.dispatch(view.state.tr.setNodeMarkup(view.state.selection.$from.before(), undefined, { ...parent.attrs, level }))
                }
                break
              }
              case 'emphasis':
                commands.call(toggleEmphasisCommand.key)
                break
              case 'strike':
                commands.call(toggleStrikethroughCommand.key)
                break
              case 'underline':
              case 'clear-inline-formatting':
              case 'inline-formula':
              case 'highlight':
              case 'superscript':
              case 'subscript': {
                const extendedCommand: ExtendedVisualInlineCommand = command === 'underline'
                  ? 'toggle-underline'
                  : command === 'inline-formula'
                    ? 'toggle-inline-formula'
                    : command === 'highlight'
                      ? 'toggle-highlight'
                      : command === 'superscript'
                        ? 'toggle-superscript'
                        : command === 'subscript'
                          ? 'toggle-subscript'
                          : 'clear-inline-formatting'
                handled = applyExtendedVisualInlineCommand(
                  view.state,
                  view.dispatch,
                  extendedCommand,
                )
                break
              }
              case 'inline-code':
                commands.call(toggleInlineCodeCommand.key)
                break
              case 'link':
                {
                  const type = view.state.schema.marks.link
                  const selection = view.state.selection
                  if (!type) {
                    handled = false
                    break
                  }
                  const existing = selection.empty
                    ? getMarkRange(view.state.doc.resolve(selection.from), type)
                    : null
                  const from = existing?.from ?? selection.from
                  const to = existing?.to ?? selection.to
                  if (from >= to) {
                    handled = false
                    break
                  }
                  let anchor = { left: 8, top: 8, bottom: 8 }
                  try {
                    const coordinates = view.coordsAtPos(to)
                    anchor = {
                      left: coordinates.left,
                      top: coordinates.top,
                      bottom: coordinates.bottom,
                    }
                  } catch {
                    const rect = view.dom.getBoundingClientRect()
                    anchor = { left: rect.left, top: rect.top, bottom: rect.bottom }
                  }
                  openLinkEditor({
                    view,
                    from,
                    to,
                    initialHref: existing ? String(existing.mark.attrs.href ?? '') : '',
                    anchor,
                    onCommit: () => queueMicrotask(() => {
                      try { commitUserMarkdown(getEditorMarkdown()) } catch { /* editor was closed */ }
                    }),
                  })
                  focusAfterCommand = false
                  commitAfterCommand = false
                }
                break
              default:
                handled = false
            }
            if (handled && focusAfterCommand) context.get(editorViewCtx).focus()
          })
        } catch {
          handled = false
        }
        if (handled && commitAfterCommand) queueMicrotask(() => {
          try { commitUserMarkdown(getEditorMarkdown()) } catch { /* editor was closed */ }
        })
      }
      window.addEventListener('arkdown:editor-command', runMenuCommand)

      const insertMarkdown = (event: Event) => {
        if (!active || !ready || readOnly || interactionLockedRef.current) return
        const markdown = (event as CustomEvent<unknown>).detail
        if (typeof markdown !== 'string' || !markdown || markdown.length > 1_000_000) return
        try {
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            const transaction = view.state.tr.replaceSelection(
              parseMarkdownInsertionSlice(context.get(parserCtx), view.state.schema, markdown),
            ).scrollIntoView()
            const link = view.state.schema.marks.link
            view.dispatch(link ? transaction.removeStoredMark(link) : transaction)
            view.focus()
          })
          queueMicrotask(() => {
            try { commitUserMarkdown(getEditorMarkdown()) } catch { /* editor was closed */ }
          })
        } catch {
          // A torn-down editor cannot accept an insertion.
        }
      }
      window.addEventListener('arkdown:insert-markdown', insertMarkdown)

      const onPlainTextPaste = (event: ClipboardEvent) => {
        if (!active || !ready || readOnly || interactionLockedRef.current || event.defaultPrevented || !event.clipboardData) return
        if (editorViewRef.current?.composing) return
        if (editorViewRef.current && isCrossCellSelection(editorViewRef.current.state)) {
          event.preventDefault()
          event.stopPropagation()
          void businessDialogsRef.current?.alert({ title: '请先在单个单元格内放置文字光标再粘贴。' })
          return
        }
        if (clipboardHasImage(event.clipboardData)) {
          event.preventDefault()
          event.stopPropagation()
          void pasteClipboardRef.current(true).catch(() => businessDialogsRef.current?.alert({ title: '无法粘贴剪贴板图片' }))
          return
        }
        if (event.clipboardData.types.includes('text/html')) return
        const text = event.clipboardData.getData('text/plain')
        if (!text) return
        const target = parseLinkTarget(text) ?? normalizeAutomaticLinkText(text)
        event.preventDefault()
        try {
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            const link = view.state.schema.marks.link
            if (target && link) {
              const href = target.kind === 'web' ? target.url : target.path
              view.dispatch(view.state.tr.replaceSelectionWith(
                view.state.schema.text(text, [link.create({ href, title: null })]),
                false,
              ).scrollIntoView())
            } else {
              view.dispatch(view.state.tr.replaceSelection(
                parseMarkdownInsertionSlice(context.get(parserCtx), view.state.schema, text),
              ).scrollIntoView())
            }
            view.focus()
          })
          queueMicrotask(() => {
            try { commitUserMarkdown(getEditorMarkdown()) } catch { /* editor was closed */ }
          })
        } catch {
          // A torn-down editor cannot accept pasted text.
        }
      }
      root.addEventListener('paste', onPlainTextPaste, true)

      const onCellClipboard = (event: ClipboardEvent) => {
        const view = editorViewRef.current
        if (!active || !ready || !view || view.composing || !isCrossCellSelection(view.state)
          || interactionLockedRef.current || (event.type === 'cut' && readOnly)) return
        event.preventDefault()
        event.stopPropagation()
        const identity = { documentKey: documentKeyRef.current, lifetime: clipboardLifetimeRef.current }
        const selected = captureSelectionTarget(view.state, identity)
        try {
          if (!event.clipboardData) throw new Error('Clipboard unavailable')
          event.clipboardData.setData('text/plain', selectionTargetPlainText(selected))
          event.clipboardData.setData('text/html', selectionTargetHtml(selected, view.state.schema))
        } catch {
          void businessDialogsRef.current?.alert({ title: '无法复制选中内容，未执行剪切。' })
          return
        }
        if (event.type === 'cut' && active && ready && editorViewRef.current === view
          && resolveSelectionTarget(view.state,
            { documentKey: documentKeyRef.current, lifetime: clipboardLifetimeRef.current }, selected)) {
          view.dispatch(view.state.tr.deleteSelection().setMeta('uiEvent', 'cut').scrollIntoView())
          commitUserMarkdown(getEditorMarkdown())
        }
      }
      root.addEventListener('copy', onCellClipboard, true)
      root.addEventListener('cut', onCellClipboard, true)

      flushRef.current = () => {
        if (!active || !ready) return null
        flushPendingDomChanges(crepe)
        if (!provenance.needsSynchronousCheckpoint()) return null
        try {
          return commitUserMarkdown(getEditorMarkdown())
        } catch {
          return null
        }
      }

      crepe.on((listener) => {
        listener.markdownUpdated(() => {
          findSession?.refresh()
          if (
            !active
            || !ready
            || !provenance.hasPending()
            || provenance.isComposing()
          ) return
          commitUserMarkdown(getEditorMarkdown())
        })
      })

      const destroyOnce = (): Promise<void> => {
        if (destroyStarted) return destroyTask ?? Promise.resolve()
        destroyStarted = true
        disposeMermaid()
        try {
          destroyTask = Promise.resolve(crepe.destroy()).then(
            () => undefined,
            () => undefined,
          )
        } catch {
          destroyTask = Promise.resolve()
        }
        return destroyTask
      }

      let creation: Promise<unknown>
      try {
        creation = crepe.editor
          .remove(remarkPreserveEmptyLinePlugin)
          .then(() => crepe.create())
      } catch (error) {
        creation = Promise.reject(error)
      }

      void creation.then(
        () => {
          if (active) {
            ready = true
            crepe.editor.action((context) => {
              const view = context.get(editorViewCtx)
              editorViewRef.current = view
              marginSelectionPortRef.current = marginSelectionPort
              applyNativeSpellCheck(view, spellCheckEnabledRef.current)
            })
            const proseMirror = root.querySelector<HTMLElement>('.ProseMirror')
            if (proseMirror) {
              findSession = createVisualDocumentFindSession(
                proseMirror,
                undefined,
                dispatchDocumentFindSnapshot,
              )
              if (pendingFindAction) {
                applyFindAction(pendingFindAction)
                pendingFindAction = null
              }
            }
            if (preparedEnhancedTables.tables.length) {
              crepe.editor.action((context) => {
                const view = context.get(editorViewCtx)
                if (restorePreparedEnhancedTables(view, preparedEnhancedTables.tables)) return
                let fallbackDocument: ProseMirrorNode
                try {
                  fallbackDocument = context.get(parserCtx)(initialMarkdownRef.current)
                } catch {
                  const paragraph = view.state.schema.nodes.paragraph!.create(
                    null,
                    view.state.schema.text(initialMarkdownRef.current),
                  )
                  fallbackDocument = view.state.schema.nodes.doc!.create(null, paragraph)
                }
                if (preparedEnhancedTables.tables.some((table) => (
                  fallbackDocument.textContent.includes(table.marker)
                ))) {
                  const paragraph = view.state.schema.nodes.paragraph!.create(
                    null,
                    view.state.schema.text(initialMarkdownRef.current),
                  )
                  fallbackDocument = view.state.schema.nodes.doc!.create(null, paragraph)
                }
                view.dispatch(view.state.tr.replaceWith(
                  0,
                  view.state.doc.content.size,
                  fallbackDocument.content,
                ))
              })
            }
            crepe.editor.action((context) => {
              const view = context.get(editorViewCtx)
              if (!readOnly && view.state?.doc) resetTaskCheckboxBaseline(view.state.doc, initialMarkdownRef.current)
              const restored = initialModePositionRef.current
                ? resolveVisualModePosition(view.state.doc, initialModePositionRef.current)
                : null
              if (!restored) return
              view.dispatch(view.state.tr.setSelection(
                TextSelection.near(view.state.doc.resolve(restored.selection)),
              ).scrollIntoView())
              view.focus()
              const center = () => {
                if (!active) return
                const block = describeVisualLogicalBlocks(view.state.doc)[restored.blockIndex]
                const dom = block ? view.nodeDOM(block.position) : null
                if (dom instanceof Element) dom.scrollIntoView({ block: 'center' })
              }
              root.ownerDocument.defaultView?.requestAnimationFrame(center)
            })
            detachResponsiveTables = createResponsiveTableLayout(root)
            if (
              documentKey
              && translationHistoryRef.current
              && syncTranslationHistoryRecordsRef.current(historyRecords)
            ) {
              onTranslationHistoryReadyRef.current?.(documentKey)
            }
            if (findSession) onFindReadyRef.current?.()
            void Promise.resolve(onReadyRef.current?.()).catch(() => undefined)
          } else return destroyOnce()
        },
        () => destroyOnce(),
      ).catch(() => undefined)

      return () => {
        activeLinkEditor?.close()
        activeLinkEditor = null
        active = false
        ready = false
        disposeMermaid()
        editorViewRef.current = null
        aiCaptureRef.current = () => { throw new Error('Visual editor is unavailable') }
        aiPrepareRef.current = () => { throw new Error('Visual editor is unavailable') }
        aiApplyRef.current = () => { throw new Error('Visual editor is unavailable') }
        aiExactMarkdownMirrorRef.current = null
        aiObservedDocumentRef.current = null
        marginSelectionPortRef.current = null
        flushRef.current = () => null
        captureModeSwitchRef.current = () => null
        captureModePositionRef.current = () => null
        captureSelectionRef.current = () => false
        insertMarkdownRef.current = () => false
        insertDroppedLinkRef.current = () => false
        insertDroppedMarkdownRef.current = () => false
        externalDropTarget.request = { status: 'idle' }
        selectedBlockStyleRef.current = () => 'mixed'
        setSelectedBlockStyleRef.current = () => false
        revealTranslationHistoryRecordRef.current = () => false
        flushTranslationHistoryAnchorsRef.current = () => []
        capturePendingTranslationAnchorRef.current = () => false
        bindPendingTranslationAnchorRef.current = () => undefined
        promotePendingTranslationAnchorRef.current = () => null
        discardPendingTranslationAnchorRef.current = () => undefined
        syncTranslationHistoryRecordsRef.current = () => false
        selectionBookmark = null
        toolbarTarget = null
        window.removeEventListener('arkdown:editor-command', runMenuCommand)
        window.removeEventListener('arkdown:insert-markdown', insertMarkdown)
        root.removeEventListener('paste', onPlainTextPaste, true)
        root.removeEventListener('copy', onCellClipboard, true)
        root.removeEventListener('cut', onCellClipboard, true)
        window.removeEventListener(DOCUMENT_FIND_EVENT, onDocumentFind)
        findSession?.dispose()
        detachResponsiveTables()
        detachStructuredBlockAppearance()
        detachLinkInteraction()
        root.removeEventListener('keydown', onTableEnter, true)
        root.removeEventListener('pointerdown', onTranslationPointerDown)
        root.removeEventListener('pointermove', onTranslationPointerMove)
        root.ownerDocument.removeEventListener('pointerup', onTranslationPointerUp, true)
        root.removeEventListener('compositionstart', onTranslationCompositionStart)
        root.removeEventListener('compositionend', onTranslationCompositionEnd)
        root.removeEventListener('dragstart', onTranslationDragStart)
        root.removeEventListener('contextmenu', onTranslationContextMenu)
        root.removeEventListener('keydown', onTranslationKeyDown, true)
        root.removeEventListener('blur', onTranslationBlur, true)
        invalidateTranslationGesture()
        detachProvenance()
        provenance.destroy()
        if (visualContextMenu) root.removeEventListener('contextmenu', visualContextMenu)
        void creation.then(destroyOnce, destroyOnce).catch(() => undefined)
      }
    }, [])

    return <div
      aria-label="Markdown visual editor"
      className="visual-editor"
      data-editor-theme={editorTheme}
      ref={rootRef}
    />
  },
)
