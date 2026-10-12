import type { Crepe } from '@milkdown/crepe'
import { commandsCtx, editorViewCtx, parserCtx, serializerCtx } from '@milkdown/kit/core'
import { getMarkRange } from '@milkdown/kit/prose'
import {
  DOMParser as ProseMirrorDOMParser,
  Fragment,
  Slice,
} from '@milkdown/kit/prose/model'
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { redo, undo } from '@milkdown/kit/prose/history'
import {
  deleteColumn,
  deleteRow,
  deleteTable,
  CellSelection,
} from '@milkdown/kit/prose/tables'
import {
  addColAfterCommand,
  addColBeforeCommand,
  addRowAfterCommand,
  addRowBeforeCommand,
  moveColCommand,
  moveRowCommand,
  selectColCommand,
  setAlignCommand,
} from '@milkdown/kit/preset/gfm'
import type { ContextMenuController } from '../../context-menu/ContextMenuProvider'
import type { BusinessDialogController } from '../../modal/BusinessDialogProvider'
import { chooseImageForInsertion } from '../image-insertion'
import { openLinkTarget, type OpenDocumentLink } from '../local-link-handler'
import { revealLocalFileLink } from '../reveal-local-file-link'
import { createLinkEditorPopover } from '../link-editor-popover'
import { replaceTextInsideTableCell } from '../table-cell-transactions'
import { parseMarkdownInsertionSlice } from '../markdown-slice'
import { buildStructuredBlockInsertionTransaction } from '../structured-block-insertion'
import { sanitizeClipboardHtml, selectionTargetPlainText, selectionTargetHtml, selectionTargetMarkdown, writeSelectionClipboard } from './clipboard-formats'
import { captureSelectionTarget, resolveSelectionTarget, tableCellPositionAtDOMTarget, targetContainsPosition, type EditorSelectionTarget, type SelectionTargetIdentity } from '../editor-selection-target'
import { commandItemById } from '../../context-menu/context-menu-types'
import { resolveEditorDomContext } from './editor-context'
import { resolveEditorActiveBlocks } from './editor-active-blocks'
import { buildVisualEditorMenu, type EditorContextSnapshot } from './editor-menu-model'
import type { EditorActiveBlocks } from './editor-menu-model'
import {
  executeHorizontalRuleCommand,
  insertionMarkdownForCommand,
  isHorizontalRuleCommandId,
  tableElementToMarkdown,
} from './visual-editor-commands'
import { executeImageResourceCommand } from './image-context-actions'
import {
  deleteImageAtPosition,
  replaceImageSyntaxAtPosition,
  updateLinkAtPosition,
} from './object-transactions'
import type { ClipboardFormatsSnapshot } from '../../../shared/contracts'
import { resolveVisualInlineFormatStates } from './inline-format-state'
import {
  buildMermaidPasteTransaction,
  serializeMermaidMarkdown,
} from '../mermaid/mermaid-clipboard'
import { rasterizeMermaidSvgDataUrl } from '../mermaid/mermaid-image-export'

interface VisualContextMenuOptions {
  crepe: Crepe
  menu: ContextMenuController
  commit(): void
  getMarkdown(): string
  pasteClipboard?(tableText: boolean): Promise<boolean>
  openLinkEditor?: typeof createLinkEditorPopover
  openDocumentLink?: OpenDocumentLink
  createStickyNote?(selectionChanged?: boolean): void
  allowYamlFrontmatter?: boolean
  dialogs?: Pick<BusinessDialogController, 'alert' | 'confirm' | 'prompt'> | null
  isCurrent?(): boolean
  getSelectionIdentity?(): SelectionTargetIdentity
  rasterizeMermaidImage?: typeof rasterizeMermaidSvgDataUrl
}

interface ParentNodeMatch {
  node: {
    type: { name: string; create(attrs?: unknown, content?: unknown): unknown }
    attrs: Record<string, unknown>
    nodeSize: number
    textContent: string
  }
  position: number
}

const EDITOR_COMMANDS: Readonly<Record<string, string>> = {
  'paragraph-body': 'paragraph',
  'heading-1': 'heading-1',
  'heading-2': 'heading-2',
  'heading-3': 'heading-3',
  'heading-4': 'heading-4',
  'heading-5': 'heading-5',
  'heading-6': 'heading-6',
  'toggle-bullet-list': 'unordered-list',
  'toggle-ordered-list': 'ordered-list',
  'toggle-task-list': 'task-list',
  'toggle-blockquote': 'blockquote',
  'toggle-code-block': 'code-fence',
  'toggle-strong': 'strong',
  'toggle-emphasis': 'emphasis',
  'toggle-strike': 'strike',
  'toggle-underline': 'underline',
  'clear-inline-formatting': 'clear-inline-formatting',
  'toggle-inline-formula': 'inline-formula',
  'toggle-highlight': 'highlight',
  'toggle-superscript': 'superscript',
  'toggle-subscript': 'subscript',
  'toggle-inline-code': 'inline-code',
  'toggle-link': 'link',
  'list-indent': 'list-indent',
  'list-outdent': 'list-outdent',
  'clear-formatting': 'clear-formatting',
  'heading-promote': 'heading-promote',
  'heading-demote': 'heading-demote',
}

function writeText(value: string): Promise<void> {
  const writer = navigator.clipboard?.writeText
  return typeof writer === 'function'
    ? writer.call(navigator.clipboard, value)
    : Promise.reject(new Error('Clipboard unavailable'))
}

async function writeMermaidText(value: string): Promise<void> {
  const writer = navigator.clipboard?.writeText
  if (typeof writer !== 'function') throw new Error('Clipboard unavailable')
  await writer.call(navigator.clipboard, value)
}

function insertMarkdown(markdown: string): void {
  window.dispatchEvent(new CustomEvent('arkdown:insert-markdown', { detail: markdown }))
}

function plainTextSlice(
  schema: Parameters<typeof ProseMirrorDOMParser.fromSchema>[0],
  text: string,
): Slice {
  const paragraph = schema.nodes.paragraph
  if (!paragraph) return Slice.maxOpen(Fragment.from(schema.text(text)))
  return Slice.maxOpen(Fragment.fromArray(
    text.replace(/\r\n?/gu, '\n').split('\n').map((line) => (
      paragraph.create(null, line === '' ? undefined : schema.text(line))
    )),
  ))
}

function htmlSlice(
  schema: Parameters<typeof ProseMirrorDOMParser.fromSchema>[0],
  html: string,
): Slice {
  const container = document.createElement('div')
  container.innerHTML = sanitizeClipboardHtml(html)
  return new Slice(ProseMirrorDOMParser.fromSchema(schema).parse(container).content, 0, 0)
}

function markdownClipboardSlice(
  parser: Parameters<typeof parseMarkdownInsertionSlice>[0],
  schema: Parameters<typeof ProseMirrorDOMParser.fromSchema>[0],
  markdown: string,
): Slice {
  const parsed = parser(markdown)
  const paragraph = schema.nodes.paragraph
  if (parsed.childCount === 1 && paragraph && parsed.firstChild?.type === paragraph) {
    return Slice.maxOpen(parsed.firstChild.content)
  }
  return new Slice(parsed.content, 0, 0)
}

function findParentNode(
  view: {
    state: {
      doc: { resolve(position: number): {
        depth: number
        node(depth: number): ParentNodeMatch['node']
        before(depth: number): number
      } }
    }
  },
  position: number,
  names: readonly string[],
): ParentNodeMatch | null {
  const resolved = view.state.doc.resolve(position)
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const node = resolved.node(depth)
    if (names.includes(node.type.name)) {
      return { node, position: resolved.before(depth) }
    }
  }
  return null
}

function sourceFromContext(context: EditorContextSnapshot, target: Element): string {
  if (context.source && !context.source.startsWith('arkdown-asset:')) return context.source
  return target.closest('.arkdown-local-image')?.getAttribute('data-source')
    ?? target.closest('img')?.getAttribute('data-source')
    ?? ''
}

function findMermaidNodeByHost(
  view: EditorView,
  host: HTMLElement,
): ParentNodeMatch | null {
  let match: ParentNodeMatch | null = null
  view.state.doc.descendants((node, position) => {
    if (
      node.type.name === 'code_block'
      && node.attrs.frontmatter !== true
      && String(node.attrs.language ?? '').trim().toLocaleLowerCase('en-US') === 'mermaid'
      && view.nodeDOM(position) === host
    ) {
      match = { node, position }
      return false
    }
    return undefined
  })
  return match
}

export function createVisualContextMenuHandler({
  crepe,
  menu,
  commit,
  getMarkdown,
  pasteClipboard,
  openLinkEditor = createLinkEditorPopover,
  openDocumentLink,
  createStickyNote,
  allowYamlFrontmatter = true,
  dialogs,
  isCurrent: isEditorCurrent = () => true,
  getSelectionIdentity = () => ({ documentKey: null, lifetime: 0 }),
  rasterizeMermaidImage = rasterizeMermaidSvgDataUrl,
}: VisualContextMenuOptions): (event: MouseEvent) => void {
  let menuGeneration = 0
  return (event: MouseEvent) => {
    const generation = ++menuGeneration
    let selectionTarget: EditorSelectionTarget | null = null
    let capturedView: EditorView | null = null
    const isCurrent = () => {
      if (generation !== menuGeneration || !isEditorCurrent() || !selectionTarget || !capturedView || capturedView.isDestroyed) return false
      try {
        return crepe.editor.action(context => {
          const view = context.get(editorViewCtx)
          return view === capturedView && resolveSelectionTarget(view.state, getSelectionIdentity(), selectionTarget!) !== null
        })
      } catch { return false }
    }
    const restoreTarget = () => {
      if (!isCurrent()) return false
      const view = capturedView!
      const selection = resolveSelectionTarget(view.state, getSelectionIdentity(), selectionTarget!)
      if (!selection) return false
      if (!view.state.selection.eq(selection)) view.dispatch(view.state.tr.setSelection(selection))
      return resolveSelectionTarget(view.state, getSelectionIdentity(), selectionTarget!) !== null
    }
    const commitLater = () => queueMicrotask(() => {
      // Successful edits advance the target revision; commit only in the same editor lifetime.
      const identity = getSelectionIdentity()
      if (isEditorCurrent() && identity.documentKey === selectionTarget?.identity.documentKey
        && identity.lifetime === selectionTarget?.identity.lifetime) commit()
    })
    const showAlert = (title: string) => dialogs?.alert({ title }) ?? Promise.resolve()
    const requestConfirmation = async (
      title: string,
      description: string,
      confirmLabel: string,
    ) => {
      if (!dialogs || !isCurrent()) return false
      const result = await dialogs.confirm({ title, description, confirmLabel, cancelLabel: '取消', tone: 'danger' })
      return isCurrent() && result === 'confirm'
    }
    const requestText = async (title: string, defaultValue: string, inputLabel: string) => {
      if (!dialogs || !isCurrent()) return null
      const result = await dialogs.prompt({ title, defaultValue, inputLabel, confirmLabel: '确定', cancelLabel: '取消' })
      return isCurrent() ? result : null
    }
    const runCurrentEditorAction = (action: () => void): boolean => {
      if (!restoreTarget()) return false
      action()
      return true
    }

    event.preventDefault()
    event.stopPropagation()

    const target = event.target instanceof Element ? event.target : null
    if (!target) return

    let selectionText = window.getSelection()?.toString() ?? ''
    let hasSelection = selectionText.length > 0
    let editorPosition = 0
    let editorSelectionFrom = 0
    let editorSelectionTo = 0
    let intentionalFocusOwner: HTMLElement | null = null
    let activeBlocks: EditorActiveBlocks = {
      blockquote: false,
      codeBlock: false,
      bulletList: false,
      orderedList: false,
      taskList: false,
      paragraphStyle: null,
    }
    let activeInlineFormats: EditorContextSnapshot['activeInlineFormats']
    try {
      crepe.editor.action((context) => {
        const view = context.get(editorViewCtx)
        const mermaidHost = target.closest<HTMLElement>('.arkdown-mermaid-block')
        const previewBlock = mermaidHost?.dataset.arkdownMermaidMode === 'preview'
          ? findMermaidNodeByHost(view, mermaidHost)
          : null
        const browserSelection = window.getSelection()
        const priorTarget = captureSelectionTarget(view.state, getSelectionIdentity())
        const located = view.posAtCoords({ left: event.clientX, top: event.clientY })
        const cellPosition = priorTarget.kind === 'cells' ? tableCellPositionAtDOMTarget(view, target) : null
        const codeHost = target.closest('.milkdown-code-block')
        const codeBlockPosition = located?.inside ?? -1
        const codeBlock = codeBlockPosition >= 0 ? view.state.doc.nodeAt(codeBlockPosition) : null
        // CodeMirror is an opaque NodeView: posAtCoords can return either outer
        // boundary. Use its interior only when the clicked host owns that node.
        const codePosition = codeHost
          && !target.closest('.arkdown-mermaid-block, [data-arkdown-frontmatter="true"]')
          && codeBlock?.type.name === 'code_block'
          && codeBlock.attrs.frontmatter !== true
          && view.nodeDOM(codeBlockPosition) === codeHost
          ? codeBlockPosition + 1
          : null
        const hitPosition = cellPosition ?? codePosition ?? located?.pos ?? view.state.selection.from
        const preserveCells = priorTarget.kind === 'cells' && targetContainsPosition(priorTarget, hitPosition)
        if (previewBlock && !preserveCells) {
          // Focusing a text selection inside the NodeView opens its source editor.
          view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, previewBlock.position)))
        } else if (!(view.state.selection instanceof CellSelection) && browserSelection?.rangeCount === 1) {
          const range = browserSelection.getRangeAt(0)
          if (
            !range.collapsed
            && view.dom.contains(range.startContainer)
            && view.dom.contains(range.endContainer)
          ) {
            const start = view.posAtDOM(range.startContainer, range.startOffset)
            const end = view.posAtDOM(range.endContainer, range.endOffset)
            if (start !== end) {
              view.dispatch(view.state.tr.setSelection(TextSelection.between(
                view.state.doc.resolve(Math.min(start, end)),
                view.state.doc.resolve(Math.max(start, end)),
              )))
            }
          }
        }
        editorPosition = preserveCells ? hitPosition : previewBlock?.position ?? hitPosition
        if (!targetContainsPosition(captureSelectionTarget(view.state, getSelectionIdentity()), editorPosition)) {
          view.dispatch(view.state.tr.setSelection(
            TextSelection.near(view.state.doc.resolve(editorPosition)),
          ))
        }
        const active = view.state.selection
        editorSelectionFrom = active.from
        editorSelectionTo = active.to
        selectionTarget = captureSelectionTarget(view.state, getSelectionIdentity())
        capturedView = view
        selectionText = selectionTargetPlainText(selectionTarget)
        hasSelection = !active.empty
        activeBlocks = resolveEditorActiveBlocks(
          view.state.doc,
          Math.min(editorPosition, view.state.doc.content.size),
        )
        activeInlineFormats = resolveVisualInlineFormatStates(view.state)
      })
    } catch {
      return
    }

    const capturedTarget = selectionTarget as EditorSelectionTarget | null
    const snapshot: EditorContextSnapshot = {
      ...resolveEditorDomContext(target, selectionText),
      ...(capturedTarget?.cells && capturedTarget.cells.positions.length > 1 ? { kind: 'table' as const } : {}),
      cellSelection: capturedTarget?.kind === 'cells',
      crossCellSelection: (capturedTarget?.cells?.positions.length ?? 0) > 1,
      hasSelection,
      activeBlocks,
      activeInlineFormats,
    }

    const execute = async (id: string): Promise<void> => {
      if (commandItemById(buildVisualEditorMenu(snapshot), id)?.disabled || !restoreTarget()) return
      if (id === 'create-sticky-note') {
        let selectedClickedLink = false
        if (snapshot.kind === 'link' && !hasSelection) {
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            const type = view.state.schema.marks.link
            if (!type) return
            const range = getMarkRange(view.state.doc.resolve(editorPosition), type)
            if (!range) return
            view.dispatch(view.state.tr.setSelection(TextSelection.create(
              view.state.doc,
              range.from,
              range.to,
            )))
            selectedClickedLink = true
          })
        }
        createStickyNote?.(selectedClickedLink || selectionTarget?.kind === 'cells')
        return
      }

      if (id === 'search-selection') {
        const result = await window.arkdown.searchSelection?.(snapshot.selectionText)
        if (result && !result.ok) await showAlert(result.error.message)
        return
      }

      if (snapshot.kind === 'horizontal-rule' && isHorizontalRuleCommandId(id)) {
        const element = snapshot.horizontalRule?.element
        if (!element) return
        await executeHorizontalRuleCommand(element, id)
        if (id !== 'horizontal-rule-copy') commitLater()
        return
      }

      const editorCommand = EDITOR_COMMANDS[id]
      if (editorCommand) {
        window.dispatchEvent(new CustomEvent('arkdown:editor-command', {
          detail: editorCommand,
        }))
        return
      }

      if (id.startsWith('insert-')) {
        if (id === 'insert-link-reference') {
          if (editorSelectionFrom >= editorSelectionTo) return
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            let anchor = { left: event.clientX, top: event.clientY, bottom: event.clientY }
            try {
              const coordinates = view.coordsAtPos(editorSelectionTo)
              anchor = {
                left: coordinates.left,
                top: coordinates.top,
                bottom: coordinates.bottom,
              }
            } catch {
              // The context-menu coordinates remain a stable fallback.
            }
            const controller = openLinkEditor({
              view,
              from: editorSelectionFrom,
              to: editorSelectionTo,
              anchor,
              onCommit: commitLater,
            })
            intentionalFocusOwner = controller.element
          })
          return
        }
        if (id === 'insert-image') {
          chooseImageForInsertion({
            api: window.arkdown,
            insertMarkdown: (markdown) => {
              if (!restoreTarget()) return
              crepe.editor.action((context) => {
                const view = context.get(editorViewCtx)
                const position = Math.min(editorPosition, view.state.doc.content.size)
                const selection = TextSelection.near(view.state.doc.resolve(position))
                view.dispatch(view.state.tr
                  .setSelection(selection)
                  .replaceSelection(parseMarkdownInsertionSlice(context.get(parserCtx), view.state.schema, markdown))
                  .scrollIntoView())
              })
              commitLater()
            },
            reportError: (message) => { void showAlert(message) },
          })
          return
        }
        if (id === 'insert-paragraph-before' || id === 'insert-paragraph-after') {
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            const paragraph = view.state.schema.nodes.paragraph
            if (!paragraph) return
            const match = findParentNode(view, editorPosition, [
              'paragraph', 'heading', 'blockquote', 'code_block', 'list_item',
            ])
            const position = match
              ? id === 'insert-paragraph-before'
                ? match.position
                : match.position + match.node.nodeSize
              : view.state.selection.to
            view.dispatch(view.state.tr.insert(position, paragraph.create()).scrollIntoView())
          })
          commitLater()
          return
        }
        if (
          id === 'insert-code-block'
          || id === 'insert-math-block'
          || id === 'insert-yaml'
        ) {
          if (id === 'insert-yaml' && !allowYamlFrontmatter) {
            await showAlert('YAML Front Matter 只能插入到空白 Markdown 文档开头。')
            return
          }
          if (id === 'insert-yaml' && getMarkdown().trim() !== '') {
            await showAlert('YAML Front Matter 只能插入到空白 Markdown 文档开头。')
            return
          }
          let inserted = false
          let yamlInsertionRejected = false
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            const transaction = buildStructuredBlockInsertionTransaction(
              view.state,
              id === 'insert-yaml'
                ? { language: 'YAML', frontmatter: true }
                : { language: id === 'insert-math-block' ? 'LaTeX' : '' },
            )
            if (!transaction) {
              if (id === 'insert-yaml') yamlInsertionRejected = true
              return
            }
            view.dispatch(transaction)
            view.focus()
            inserted = true
          })
          if (yamlInsertionRejected) {
            await showAlert('YAML Front Matter 只能插入到空白 Markdown 文档开头。')
          }
          if (inserted) commitLater()
          return
        }
        const insertion = insertionMarkdownForCommand(id, getMarkdown())
        if (insertion === null) return
        insertMarkdown(insertion)
        return
      }

      if (id === 'undo' || id === 'redo') {
        crepe.editor.action((context) => {
          const view = context.get(editorViewCtx)
          ;(id === 'undo' ? undo : redo)(view.state, view.dispatch)
        })
        commitLater()
        return
      }

      if (id === 'copy' || id === 'cut') {
        if (!selectionTarget || !capturedView) return
        try {
          await writeSelectionClipboard(selectionTargetPlainText(selectionTarget), selectionTargetHtml(selectionTarget, capturedView.state.schema))
          if (id === 'cut' && restoreTarget()) {
            capturedView.dispatch(capturedView.state.tr.deleteSelection().scrollIntoView())
            commitLater()
          }
        } catch { await showAlert('无法复制选中内容，未执行剪切。') }
        return
      }
      if (id === 'paste') {
        try {
          if (pasteClipboard) { await pasteClipboard(snapshot.kind === 'table'); return }
          const text = await navigator.clipboard?.readText()
          if (typeof text !== 'string') throw new Error('Clipboard unavailable')
          if (!restoreTarget()) return
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            if (snapshot.kind === 'table') {
              const selection = view.state.selection
              replaceTextInsideTableCell(view, text, selection instanceof CellSelection
                ? TextSelection.create(view.state.doc, selection.from, selection.to) : selection)
              view.focus()
              return
            }
            view.dispatch(view.state.tr.replaceSelection(
              parseMarkdownInsertionSlice(context.get(parserCtx), view.state.schema, text),
            ).scrollIntoView())
            view.focus()
          })
          commitLater()
        } catch {
          await showAlert('无法读取剪贴板内容，请使用 Ctrl+V 重试。')
        }
        return
      }

      if (id === 'delete-selection') {
        crepe.editor.action((context) => {
          const view = context.get(editorViewCtx)
          view.dispatch(view.state.tr.deleteSelection().scrollIntoView())
        })
        commitLater()
        return
      }

      if (id === 'paste-mermaid') {
        if (snapshot.kind === 'table' || snapshot.activeBlocks?.codeBlock) return
        try {
          const text = snapshot.clipboardFormats?.plainText
            ?? await navigator.clipboard?.readText()
          if (typeof text !== 'string') return
          let changed = false
          runCurrentEditorAction(() => {
            crepe.editor.action((context) => {
              const view = context.get(editorViewCtx)
              const transaction = buildMermaidPasteTransaction(view.state, text)
              if (!transaction) return
              view.dispatch(transaction)
              view.focus()
              changed = true
            })
          })
          if (changed) commitLater()
        } catch {
          await showAlert('无法读取剪贴板内容，请使用 Ctrl+Shift+V 重试。')
        }
        return
      }

      if (id === 'copy-plain' || id === 'copy-markdown') {
        if (!selectionTarget) return
        const value = id === 'copy-plain' ? selectionTargetPlainText(selectionTarget)
          : crepe.editor.action(context => selectionTargetMarkdown(selectionTarget!, context.get(editorViewCtx).state.schema, context.get(serializerCtx)))
        await writeText(value)
        return
      }
      if (id === 'copy-html') {
        if (selectionTarget && capturedView) await writeText(selectionTargetHtml(selectionTarget, capturedView.state.schema))
        return
      }
      if (id === 'paste-plain' || id === 'paste-markdown' || id === 'paste-html') {
        let formats = snapshot.clipboardFormats
        if (!formats) {
          const text = await navigator.clipboard?.readText()
          if (typeof text !== 'string') return
          formats = { plainText: text, markdown: null, html: null }
        }
        if (!restoreTarget()) return
        const insertion = id === 'paste-plain'
          ? formats.plainText
          : id === 'paste-markdown'
            ? formats.markdown ?? formats.plainText
            : formats.html
        if (insertion === null) return
        crepe.editor.action((context) => {
          const view = context.get(editorViewCtx)
          if (snapshot.kind === 'table') {
            const tableText = id === 'paste-html'
              ? new DOMParser().parseFromString(
                  sanitizeClipboardHtml(insertion),
                  'text/html',
                ).body.textContent ?? ''
              : insertion
            const selection = view.state.selection
            replaceTextInsideTableCell(view, tableText, selection instanceof CellSelection
              ? TextSelection.create(view.state.doc, selection.from, selection.to) : selection)
            return
          }
          const slice = id === 'paste-plain'
            ? plainTextSlice(view.state.schema, insertion)
            : id === 'paste-html'
              ? htmlSlice(view.state.schema, insertion)
              : markdownClipboardSlice(context.get(parserCtx), view.state.schema, insertion)
          view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView())
          view.focus()
        })
        commitLater()
        return
      }

      if (snapshot.kind === 'link') {
        const href = snapshot.href ?? ''
        if (id === 'link-reveal' && href) {
          await revealLocalFileLink({ href }, dialogs)
          return
        }
        if (id === 'link-open' && href) {
          await openLinkTarget(href, window.arkdown.openExternal, (message) => {
            void showAlert(message)
          }, openDocumentLink)
          return
        }
        if (id === 'link-copy-address') {
          await writeText(href)
          return
        }
        if (id === 'link-edit') {
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            const type = view.state.schema.marks.link
            if (!type) return
            const range = getMarkRange(view.state.doc.resolve(editorPosition), type)
            if (!range) return
            let anchor = { left: event.clientX, top: event.clientY, bottom: event.clientY }
            try {
              const coordinates = view.coordsAtPos(range.to)
              anchor = {
                left: coordinates.left,
                top: coordinates.top,
                bottom: coordinates.bottom,
              }
            } catch {
              // The context-menu coordinates remain a stable fallback.
            }
            const controller = openLinkEditor({
              view,
              from: range.from,
              to: range.to,
              initialHref: String(range.mark.attrs.href ?? href),
              anchor,
              onCommit: commitLater,
            })
            intentionalFocusOwner = controller.element
          })
          return
        }
        if (id === 'link-remove') {
          let changed = false
          crepe.editor.action((context) => {
            changed = updateLinkAtPosition(
              context.get(editorViewCtx),
              editorPosition,
              null,
            )
          })
          if (changed) commitLater()
          return
        }
      }

      if (snapshot.kind === 'image') {
        const wrapper = target.closest<HTMLElement>('.arkdown-local-image')
        const source = sourceFromContext(snapshot, target)
        const resourceAction = await executeImageResourceCommand(
          id,
          source,
          window.arkdown,
          writeText,
        )
        if (resourceAction.handled) {
          if (resourceAction.error) await showAlert(resourceAction.error)
          if (resourceAction.replacementSource) {
            const replace = await requestConfirmation(
              '切换图片引用',
              '图片副本已创建。是否把当前文档引用切换到该副本？',
              '切换',
            )
            if (replace) {
              wrapper?.dispatchEvent(new CustomEvent('arkdown:image-update', {
                detail: { source: resourceAction.replacementSource },
              }))
            }
          }
          return
        }
        if (id === 'image-alt') {
          const current = target.closest('img')?.getAttribute('alt') ?? ''
          const alt = await requestText('图片替代文本：', current, '图片替代文本')
          if (alt !== null) wrapper?.dispatchEvent(new CustomEvent('arkdown:image-update', {
            detail: { alt },
          }))
          return
        }
        if (id.startsWith('image-zoom-')) {
          const value = id === 'image-zoom-adaptive'
            ? null
            : Number(id.slice('image-zoom-'.length))
          wrapper?.dispatchEvent(new CustomEvent('arkdown:image-update', {
            detail: { zoom: value },
          }))
          return
        }
        if (id.startsWith('image-align-')) {
          const alignment = id.slice('image-align-'.length)
          if (alignment === 'left' || alignment === 'center' || alignment === 'right') {
            wrapper?.dispatchEvent(new CustomEvent('arkdown:image-update', {
              detail: { alignment },
            }))
          }
          return
        }
        if (id === 'image-to-markdown' || id === 'image-to-html') {
          const image = target.closest('img')
          const alt = image?.getAttribute('alt') ?? ''
          const rawZoom = image?.style.getPropertyValue('zoom') ?? ''
          const parsedZoom = Number.parseFloat(rawZoom)
          let changed = false
          crepe.editor.action((context) => {
            changed = replaceImageSyntaxAtPosition(
              context.get(editorViewCtx),
              editorPosition,
              id === 'image-to-markdown' ? 'markdown' : 'html',
              source,
              alt,
              Number.isFinite(parsedZoom) ? parsedZoom : null,
            )
          })
          if (!changed) await showAlert('图片语法转换失败。')
          else commitLater()
          return
        }
        if (id === 'delete-object') {
          let changed = false
          crepe.editor.action((context) => {
            changed = deleteImageAtPosition(
              context.get(editorViewCtx),
              editorPosition,
            )
          })
          if (changed) commitLater()
          return
        }
      }

      if (snapshot.kind === 'mermaid') {
        const host = target.closest<HTMLElement>('.arkdown-mermaid-block')
        if (!host?.isConnected) return
        if (id === 'mermaid-toggle-source') {
          const mode = host.dataset.arkdownMermaidMode === 'source' ? 'preview' : 'source'
          host.dispatchEvent(new CustomEvent('arkdown:mermaid-set-mode', {
            detail: { mode },
          }))
          return
        }

        let source: string | null = null
        crepe.editor.action((context) => {
          const match = findMermaidNodeByHost(context.get(editorViewCtx), host)
          if (match) source = match.node.textContent
        })
        if (source === null) return
        if (id === 'mermaid-copy-source') {
          try {
            await writeMermaidText(source)
          } catch {
            if (isCurrent()) await showAlert('无法复制 Mermaid 源码。')
          }
          return
        }
        if (id === 'mermaid-copy-markdown') {
          try {
            await writeMermaidText(serializeMermaidMarkdown(source))
          } catch {
            if (isCurrent()) await showAlert('无法复制 Mermaid Markdown。')
          }
          return
        }
        if (id === 'mermaid-copy-image' || id === 'mermaid-save-image') {
          const image = host.querySelector<HTMLImageElement>('.arkdown-mermaid-preview img')
          const renderGeneration = host.dataset.arkdownMermaidRenderGeneration
          const svgDataUrl = host.dataset.arkdownMermaidRenderState === 'ready'
            ? image?.getAttribute('src') ?? ''
            : ''
          if (!svgDataUrl.startsWith('data:image/svg+xml;base64,')) return
          try {
            const pngDataUrl = await rasterizeMermaidImage(svgDataUrl)
            const currentImage = host.querySelector<HTMLImageElement>('.arkdown-mermaid-preview img')
            if (
              !isCurrent()
              || !host.isConnected
              || host.dataset.arkdownMermaidRenderState !== 'ready'
              || host.dataset.arkdownMermaidRenderGeneration !== renderGeneration
              || currentImage?.getAttribute('src') !== svgDataUrl
            ) return
            const result = id === 'mermaid-copy-image'
              ? await window.arkdown.copyMermaidImage?.(pngDataUrl)
              : await window.arkdown.saveMermaidImage?.({ svgDataUrl, pngDataUrl })
            if (!result) throw new Error('Mermaid image export is unavailable')
            if (!result.ok && isCurrent()) await showAlert(result.error.message)
          } catch {
            if (isCurrent()) {
              await showAlert(id === 'mermaid-copy-image'
                ? '无法复制 Mermaid 图形。'
                : '无法保存 Mermaid 图形。')
            }
          }
          return
        }
      }

      if (snapshot.kind === 'table') {
        const table = target.closest('table')
        if (id === 'table-copy-markdown' && table) {
          await writeText(tableElementToMarkdown(table))
          return
        }
        if (id === 'table-copy-html' && table) {
          await writeText(sanitizeClipboardHtml(table.outerHTML))
          return
        }
        const cells = selectionTarget?.cells
        const allRows = cells ? cells.rect.top === 0 && cells.rect.bottom === cells.height : table?.rows.length === 1
        const allColumns = cells ? cells.rect.left === 0 && cells.rect.right === cells.width : (target.closest('tr')?.children.length ?? 0) === 1
        if (id === 'table-delete-row' && allRows) {
          const confirmed = await requestConfirmation(
            '删除整个表格',
            '选中范围覆盖表格的所有行。继续将删除整个表格，是否继续？',
            '继续删除',
          )
          if (!confirmed) return
        }
        if (
          id === 'table-delete-column'
          && allColumns
        ) {
          const confirmed = await requestConfirmation(
            '删除整个表格',
            '选中范围覆盖表格的所有列。继续将删除整个表格，是否继续？',
            '继续删除',
          )
          if (!confirmed) return
        }
        const actionCompleted = runCurrentEditorAction(() => {
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            const commands = context.get(commandsCtx)
            switch (id) {
            case 'table-row-before':
              commands.call(addRowBeforeCommand.key)
              break
            case 'table-row-after':
              commands.call(addRowAfterCommand.key)
              break
            case 'table-column-before':
              commands.call(addColBeforeCommand.key)
              break
            case 'table-column-after':
              commands.call(addColAfterCommand.key)
              break
            case 'table-delete-row':
              deleteRow(view.state, view.dispatch)
              break
            case 'table-delete-column':
              deleteColumn(view.state, view.dispatch)
              break
            case 'table-delete':
              deleteTable(view.state, view.dispatch)
              break
            case 'table-align-left':
              commands.call(selectColCommand.key, {
                index: snapshot.table?.columnIndex ?? 0,
                pos: editorPosition,
              })
              commands.call(setAlignCommand.key, 'left')
              break
            case 'table-align-center':
              commands.call(selectColCommand.key, {
                index: snapshot.table?.columnIndex ?? 0,
                pos: editorPosition,
              })
              commands.call(setAlignCommand.key, 'center')
              break
            case 'table-align-right':
              commands.call(selectColCommand.key, {
                index: snapshot.table?.columnIndex ?? 0,
                pos: editorPosition,
              })
              commands.call(setAlignCommand.key, 'right')
              break
            case 'table-move-row-up':
            case 'table-move-row-down': {
              const from = target.closest('tr')?.rowIndex ?? 0
              commands.call(moveRowCommand.key, {
                from,
                to: Math.max(0, from + (id.endsWith('up') ? -1 : 1)),
                pos: editorPosition,
              })
              break
            }
            case 'table-move-column-left':
            case 'table-move-column-right': {
              const from = (target.closest('td, th') as HTMLTableCellElement | null)?.cellIndex ?? 0
              commands.call(moveColCommand.key, {
                from,
                to: Math.max(0, from + (id.endsWith('left') ? -1 : 1)),
                pos: editorPosition,
              })
              break
            }
            case 'table-format': {
              if (!table) break
              const parsed = context.get(parserCtx)(tableElementToMarkdown(table))
              const match = findParentNode(view, editorPosition, ['table'])
              const next = parsed.firstChild
              if (match && next) {
                view.dispatch(view.state.tr.replaceWith(
                  match.position,
                  match.position + match.node.nodeSize,
                  next,
                ))
              }
              break
            }
            }
          })
        })
        if (actionCompleted) commitLater()
        return
      }

      if (snapshot.kind === 'code') {
        const code = target.closest<HTMLElement>('pre, .milkdown-code-block')
          ?? target.closest<HTMLElement>('code')
        if (id === 'code-copy') {
          await writeText(code?.textContent ?? '')
          return
        }
        if (id === 'code-wrap') {
          code?.classList.toggle('arkdown-code-wrap')
          return
        }
        if (id === 'code-language') {
          let currentLanguage: string | null = null
          crepe.editor.action((context) => {
            const view = context.get(editorViewCtx)
            const match = findParentNode(view, editorPosition, ['code_block'])
            if (match) currentLanguage = String(match.node.attrs.language ?? '')
          })
          if (currentLanguage === null) return
          const language = await requestText('代码语言：', currentLanguage, '代码语言')
          if (language === null) return
          let changed = false
          runCurrentEditorAction(() => {
            crepe.editor.action((context) => {
              const view = context.get(editorViewCtx)
              const match = findParentNode(view, editorPosition, ['code_block'])
              if (!match) return
              view.dispatch(view.state.tr.setNodeMarkup(
                match.position,
                undefined,
                { ...match.node.attrs, language: language.trim() },
              ))
              changed = true
            })
          })
          if (changed) commitLater()
          return
        }
        crepe.editor.action((context) => {
          const view = context.get(editorViewCtx)
          const match = findParentNode(view, editorPosition, ['code_block'])
          if (!match) return
          if (id === 'delete-object') {
            view.dispatch(view.state.tr.delete(
              match.position,
              match.position + match.node.nodeSize,
            ))
            return
          }
          if (id === 'code-indent' || id === 'code-outdent') {
            const text = match.node.textContent
              .split('\n')
              .map((line) => id === 'code-indent'
                ? `    ${line}`
                : line.replace(/^(?: {1,4}|\t)/, ''))
              .join('\n')
            const replacement = match.node.type.create(
              match.node.attrs,
              text ? view.state.schema.text(text) : undefined,
            ) as never
            view.dispatch(view.state.tr.replaceWith(
              match.position,
              match.position + match.node.nodeSize,
              replacement,
            ))
          }
        })
        commitLater()
        return
      }

      if (snapshot.kind === 'task' && id === 'task-toggle') {
        crepe.editor.action((context) => {
          const view = context.get(editorViewCtx)
          const match = findParentNode(view, editorPosition, ['list_item'])
          if (match) view.dispatch(view.state.tr.setNodeMarkup(
            match.position,
            undefined,
            { ...match.node.attrs, checked: !snapshot.checked },
          ))
        })
        commitLater()
        return
      }

      if (id === 'delete-object') {
        crepe.editor.action((context) => {
          const view = context.get(editorViewCtx)
          const match = findParentNode(view, editorPosition, [
            'image', 'html', 'list_item', 'code_block', 'table',
          ])
          if (match) view.dispatch(view.state.tr.delete(
            match.position,
            match.position + match.node.nodeSize,
          ))
        })
        commitLater()
      }
    }

    const openMenu = (formats?: ClipboardFormatsSnapshot) => {
      if (!isCurrent()) return
      if (formats) snapshot.clipboardFormats = formats
      menu.openMenu({
        x: event.clientX,
        y: event.clientY,
        items: buildVisualEditorMenu(snapshot),
        execute,
        shouldRestoreFocus: () => !intentionalFocusOwner?.isConnected
          || !intentionalFocusOwner.contains(intentionalFocusOwner.ownerDocument.activeElement),
        restoreFocus: () => {
          try {
            if (isCurrent()) capturedView?.focus()
          } catch {
            // Editor was destroyed while the menu was open.
          }
        },
      })
    }
    if (!window.arkdown?.readClipboardFormats) {
      openMenu()
      return
    }
    if (snapshot.kind === 'mermaid') {
      openMenu()
      return
    }
    void window.arkdown.readClipboardFormats().then((result) => {
      openMenu(result.ok
        ? result.value
        : { plainText: '', markdown: null, html: null })
    }).catch(() => openMenu({ plainText: '', markdown: null, html: null }))
  }
}
