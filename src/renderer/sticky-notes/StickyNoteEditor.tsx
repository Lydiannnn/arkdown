import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react'
import { VisualEditor, type VisualEditorHandle } from '../editor/VisualEditor'
import { useOptionalContextMenu } from '../context-menu/ContextMenuProvider'
import { useOptionalBusinessDialog } from '../modal/BusinessDialogProvider'
import {
  buildStickyNoteBlankMenu,
  buildStickyNoteTextMenu,
  stickyNoteColorForCommand,
  stickyNoteHorizontalRuleForCommand,
  stickyNoteMaterialForCommand,
  stickyNoteTextureForCommand,
} from './sticky-note-context-menu'
import type { StickyNoteFontSizeChange } from './sticky-note-font-size'
import {
  DEFAULT_STICKY_NOTE_FONT_SIZE_PX,
  type StickyNoteLineSpacingMode,
} from '../../shared/sticky-notes'
import {
  DEFAULT_STICKY_NOTE_PREFERENCES,
  type StickyNoteColorPresetId,
  type StickyNotePreferences,
  type StickyNoteStyleReference,
  type StickyNoteTexturePresetId,
} from '../../shared/sticky-note-preferences'
import type { StickyNoteMaterialPresetId } from '../../shared/sticky-note-materials'
import { serializeHorizontalRule } from '../editor/horizontal-rule-styles'
import { StickyNoteOverlayScrollbar } from './StickyNoteOverlayScrollbar'
import { resolveEditorDomContext } from '../editor/context-menu/editor-context'
import { buildVisualEditorMenu } from '../editor/context-menu/editor-menu-model'
import {
  executeHorizontalRuleCommand,
  isHorizontalRuleCommandId,
} from '../editor/context-menu/visual-editor-commands'

export interface StickyNoteEditorProps {
  documentKey?: string
  documentAbsolutePath?: string
  readClipboardImage?: () => Promise<string | null>
  markdown: string
  focused?: boolean
  lineSpacingMode?: StickyNoteLineSpacingMode
  fontSizePx?: number
  preferences?: StickyNotePreferences
  style?: StickyNoteStyleReference
  onChange(markdown: string): void
  onAdjustFontSize?(change: StickyNoteFontSizeChange): void | Promise<void>
  onSetColor?(presetId: StickyNoteColorPresetId): void | Promise<void>
  onSetLineSpacingMode?(lineSpacingMode: StickyNoteLineSpacingMode): void | Promise<void>
  onSetMaterial?(presetId: StickyNoteMaterialPresetId): void | Promise<void>
  onSetTexture?(presetId: StickyNoteTexturePresetId): void | Promise<void>
  onRename?(): void | Promise<void>
  onArchive?(): void | Promise<void>
  onInsertImage?(): void | Promise<void>
  onOpenBackgroundSettings?(): void | Promise<void>
}

function caretRangeAtPoint(x: number, y: number): Range | null {
  const range = document.caretRangeFromPoint?.(x, y)
  if (range) return range
  const position = document.caretPositionFromPoint?.(x, y)
  if (!position) return null
  const fallback = document.createRange()
  fallback.setStart(position.offsetNode, position.offset)
  fallback.collapse(true)
  return fallback
}

function setCollapsedSelection(range: Range): void {
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function collapseAtNearestEditorPosition(editor: HTMLElement, candidate: Range | null): void {
  const range = candidate && editor.contains(candidate.startContainer)
    ? candidate.cloneRange()
    : document.createRange()
  if (!candidate || !editor.contains(candidate.startContainer)) {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let last: Text | null = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node as Text
    if (last) range.setStart(last, last.data.length)
    else range.selectNodeContents(editor)
  }
  range.collapse(true)
  setCollapsedSelection(range)
  editor.focus()
}

function pointHitsRange(range: Range, x: number, y: number): boolean {
  return Array.from(range.getClientRects?.() ?? []).some((rect) => (
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  ))
}

interface TextPointHit {
  text: Text
  index: number
  character: string
}

function textHitAtCaret(range: Range | null, x: number, y: number): TextPointHit | null {
  if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return null
  const text = range.startContainer as Text
  if (text.data.length === 0) return null
  const offset = Math.max(0, Math.min(range.startOffset, text.data.length))
  const starts = [offset - 1, offset].filter((start) => start >= 0 && start < text.data.length)
  const index = starts.find((start) => {
    const probe = document.createRange()
    probe.setStart(text, start)
    probe.setEnd(text, start + 1)
    return pointHitsRange(probe, x, y)
  })
  return index === undefined ? null : { text, index, character: text.data[index] }
}

function selectionContainsPoint(selection: Selection, x: number, y: number): boolean {
  return selection.rangeCount === 1 && !selection.isCollapsed
    && pointHitsRange(selection.getRangeAt(0), x, y)
}

interface PendingBlankPointer {
  pointerId: number
  x: number
  y: number
  range: Range | null
}

const BLANK_CLICK_MAX_DISTANCE = 4

export const StickyNoteEditor = forwardRef<VisualEditorHandle, StickyNoteEditorProps>(
  function StickyNoteEditor({
    markdown,
    documentKey,
    documentAbsolutePath,
    readClipboardImage,
    focused = true,
    fontSizePx,
    lineSpacingMode = 'compact',
    preferences = DEFAULT_STICKY_NOTE_PREFERENCES,
    style = { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
    onChange,
    onAdjustFontSize,
    onSetColor,
    onSetLineSpacingMode,
    onSetMaterial,
    onSetTexture,
    onRename,
    onArchive,
    onInsertImage,
    onOpenBackgroundSettings,
  }, ref) {
    const menu = useOptionalContextMenu()
    const businessDialogs = useOptionalBusinessDialog()
    const editorRef = useRef<HTMLElement>(null)
    const visualEditorRef = useRef<VisualEditorHandle>(null)
    const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null)
    const pendingBlankPointer = useRef<PendingBlankPointer | null>(null)
    useImperativeHandle(ref, () => ({
      flush: () => visualEditorRef.current?.flush() ?? null,
      whenRenderIdle: () => visualEditorRef.current?.whenRenderIdle() ?? Promise.resolve(),
      captureSelection: () => visualEditorRef.current?.captureSelection() ?? false,
      insertMarkdown: (nextMarkdown) => visualEditorRef.current?.insertMarkdown(nextMarkdown) ?? false,
      selectedBlockStyle: () => visualEditorRef.current?.selectedBlockStyle() ?? 'mixed',
      setSelectedBlockStyle: (nextStyle) => visualEditorRef.current?.setSelectedBlockStyle(nextStyle) ?? false,
      revealTranslationHistoryRecord: (recordId) => (
        visualEditorRef.current?.revealTranslationHistoryRecord(recordId) ?? false
      ),
      flushTranslationHistoryAnchors: () => (
        visualEditorRef.current?.flushTranslationHistoryAnchors() ?? []
      ),
      capturePendingTranslationAnchor: (pendingKey) => (
        visualEditorRef.current?.capturePendingTranslationAnchor(pendingKey) ?? false
      ),
      bindPendingTranslationAnchor: (pendingKey, requestId) => {
        visualEditorRef.current?.bindPendingTranslationAnchor(pendingKey, requestId)
      },
      promotePendingTranslationAnchor: (requestId) => (
        visualEditorRef.current?.promotePendingTranslationAnchor(requestId) ?? null
      ),
      discardPendingTranslationAnchor: (key) => {
        visualEditorRef.current?.discardPendingTranslationAnchor(key)
      },
    }), [])
    const onPointerDownCapture = useCallback((event: React.PointerEvent<HTMLElement>) => {
      pendingBlankPointer.current = null
      if (event.button !== 0 || !event.isPrimary) return
      const editor = editorRef.current?.querySelector<HTMLElement>('.ProseMirror')
      if (!editor) return
      const hit = caretRangeAtPoint(event.clientX, event.clientY)
      const textHit = textHitAtCaret(hit, event.clientX, event.clientY)
      if (textHit && !/\s/u.test(textHit.character)) return
      pendingBlankPointer.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        range: hit?.cloneRange() ?? null,
      }
    }, [])
    const onPointerUpCapture = useCallback((event: React.PointerEvent<HTMLElement>) => {
      const pending = pendingBlankPointer.current
      pendingBlankPointer.current = null
      if (!pending || event.pointerId !== pending.pointerId || event.button !== 0) return
      const distance = Math.hypot(event.clientX - pending.x, event.clientY - pending.y)
      if (distance > BLANK_CLICK_MAX_DISTANCE) return
      const editor = editorRef.current?.querySelector<HTMLElement>('.ProseMirror')
      if (editor) collapseAtNearestEditorPosition(editor, pending.range)
    }, [])
    const onPointerCancelCapture = useCallback(() => {
      pendingBlankPointer.current = null
    }, [])

    const onContextMenuCapture = useCallback((event: React.MouseEvent<HTMLElement>) => {
      if (!menu) return
      const editor = editorRef.current?.querySelector<HTMLElement>('.ProseMirror')
      const target = event.target instanceof Element ? event.target : null
      if (!editor || !target || !editor.contains(target)) return
      event.preventDefault()
      event.stopPropagation()
      const hit = caretRangeAtPoint(event.clientX, event.clientY)
      const selection = window.getSelection()
      const editorContext = resolveEditorDomContext(target, selection?.toString() ?? '')
      const horizontalRule = editorContext.kind === 'horizontal-rule'
        ? editorContext.horizontalRule?.element ?? null
        : null
      const textMenu = !horizontalRule && Boolean(
        selection && selectionContainsPoint(selection, event.clientX, event.clientY),
      )
      if (!textMenu && !horizontalRule) collapseAtNearestEditorPosition(editor, hit)
      visualEditorRef.current?.captureSelection()
      const selectedBlockStyle = visualEditorRef.current?.selectedBlockStyle() ?? 'mixed'
      const resolvedFontSizePx = fontSizePx ?? DEFAULT_STICKY_NOTE_FONT_SIZE_PX
      const items = horizontalRule
        ? buildVisualEditorMenu(editorContext)
        : textMenu
          ? buildStickyNoteTextMenu(selectedBlockStyle)
          : buildStickyNoteBlankMenu({
              preferences,
              style,
              fontSizePx: resolvedFontSizePx,
              lineSpacingMode,
              selectedBlockStyle,
            })
      menu.openMenu({
        x: event.clientX + 6, y: event.clientY, widthCssPx: 200, submenuWidthCssPx: 200, items,
        restoreFocus: () => {
          visualEditorRef.current?.captureSelection()
          editor.focus()
        },
        execute: async (id) => {
          if (horizontalRule && isHorizontalRuleCommandId(id)) {
            await executeHorizontalRuleCommand(horizontalRule, id)
          } else if (id === 'sticky-paragraph-heading-4') {
            visualEditorRef.current?.setSelectedBlockStyle('heading-4')
          } else if (id === 'sticky-paragraph-paragraph') {
            visualEditorRef.current?.setSelectedBlockStyle('paragraph')
          } else if (id === 'sticky-paragraph-blockquote') {
            visualEditorRef.current?.setSelectedBlockStyle('blockquote')
          } else if (id === 'sticky-copy' || id === 'sticky-cut' || id === 'sticky-delete') {
            visualEditorRef.current?.captureSelection()
            document.execCommand(id.slice('sticky-'.length))
          }
          else if (id === 'sticky-paste') {
            try {
              if (visualEditorRef.current?.pasteClipboard) {
                await visualEditorRef.current.pasteClipboard()
                return
              }
              const text = await navigator.clipboard?.readText()
              if (typeof text !== 'string' || !visualEditorRef.current?.insertMarkdown(text)) {
                throw new Error('direct paste failed')
              }
            } catch {
              void businessDialogs?.alert({ title: '请使用 Ctrl+V 粘贴' })
            }
          } else {
            const horizontalRule = stickyNoteHorizontalRuleForCommand(id)
            const materialPresetId = stickyNoteMaterialForCommand(id)
            const colorPresetId = stickyNoteColorForCommand(id, preferences)
            const texturePresetId = stickyNoteTextureForCommand(id, preferences)
            if (horizontalRule) {
              visualEditorRef.current?.insertMarkdown(serializeHorizontalRule(horizontalRule))
            } else if (id === 'sticky-line-spacing-compact') {
              await onSetLineSpacingMode?.('compact')
            } else if (id === 'sticky-line-spacing-standard') {
              await onSetLineSpacingMode?.('standard')
            } else if (id === 'sticky-insert-image') await onInsertImage?.()
            else if (id === 'sticky-background-settings') await onOpenBackgroundSettings?.()
            else if (materialPresetId) await onSetMaterial?.(materialPresetId)
            else if (colorPresetId) await onSetColor?.(colorPresetId)
            else if (texturePresetId) await onSetTexture?.(texturePresetId)
            else if (id === 'sticky-rename') await onRename?.()
            else if (id === 'sticky-archive') await onArchive?.()
            else if (id === 'sticky-font-size-increase') await onAdjustFontSize?.('increase')
            else if (id === 'sticky-font-size-decrease') await onAdjustFontSize?.('decrease')
          }
        },
      })
    }, [fontSizePx, lineSpacingMode, menu, onAdjustFontSize, onArchive, onInsertImage, onOpenBackgroundSettings, onRename, onSetColor, onSetLineSpacingMode, onSetMaterial, onSetTexture, preferences, style])
    return (
      <section
        className="sticky-note-editor-shell"
        onContextMenuCapture={onContextMenuCapture}
        onPointerCancelCapture={onPointerCancelCapture}
        onPointerDownCapture={onPointerDownCapture}
        onPointerUpCapture={onPointerUpCapture}
        ref={editorRef}
      >
        <div className="sticky-note-editor" id="sticky-note-editor-scroller" ref={setScrollElement}>
          <VisualEditor inputCaret="native" documentKey={documentKey} documentAbsolutePath={documentAbsolutePath} readClipboardImage={readClipboardImage} markdown={markdown} onChange={onChange} ref={visualEditorRef} />
        </div>
        <StickyNoteOverlayScrollbar focused={focused} scrollElement={scrollElement} />
      </section>
    )
  },
)
