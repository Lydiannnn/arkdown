import { codeBlockConfig, codeBlockView } from '@milkdown/kit/component/code-block'
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import type {
  Decoration,
  DecorationSource,
  EditorView,
  NodeView,
  NodeViewConstructor,
  ViewMutationRecord,
} from '@milkdown/kit/prose/view'
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark'
import { $view } from '@milkdown/kit/utils'
import {
  Compartment,
  EditorState,
  type Extension,
  type Line,
  type SelectionRange,
} from '@codemirror/state'
import {
  EditorView as CodeMirror,
  type KeyBinding,
  type ViewUpdate,
  drawSelection,
  keymap as codeMirrorKeymap,
} from '@codemirror/view'
import { exitCode } from '@milkdown/kit/prose/commands'
import { redo, undo } from '@milkdown/kit/prose/history'
import { TextSelection } from '@milkdown/kit/prose/state'
import type {
  MermaidRegistryPort,
  MermaidRenderer,
  MermaidSyntaxErrorSummary,
} from './mermaid-types'
import {
  isMermaidLanguage,
  MERMAID_ERROR_SUMMARY_MAX_LENGTH,
  MERMAID_MAX_BLOCKS,
} from './mermaid-types'
import { MermaidRegistryCapacityError } from './mermaid-view-registry'

interface Dependencies {
  registry: MermaidRegistryPort
  renderer: MermaidRenderer
}

interface MermaidViewDependencies extends Dependencies {
  extensions: Extension[]
}

const MERMAID_QUEUE_RETRY_DELAY_MS = 100
const MERMAID_QUEUE_RETRY_MAX_DELAY_MS = 1_000
const DOM_CODE_EXPLANATION_REQUEST_EVENT = 'arkdown:request-code-explanation'

export const CODE_EXPLANATION_REQUEST_EVENT = 'arkdown:code-explanation-request'

export interface CodeExplanationRequestDetail {
  language: string
  code: string
}

function isMermaidCodeBlock(node: ProseMirrorNode): boolean {
  return node.attrs.frontmatter !== true && isMermaidLanguage(node.attrs.language)
}

function isOrdinaryCodeBlock(node: ProseMirrorNode): boolean {
  return node.type.name === 'code_block' && node.attrs.frontmatter !== true && !isMermaidLanguage(node.attrs.language)
}

class MermaidCodeBlockView implements NodeView {
  readonly dom = document.createElement('div')

  private readonly preview = document.createElement('div')
  private readonly sourceHost = document.createElement('div')
  private readonly toggleSourceButton = document.createElement('button')
  private readonly returnCodeBlockButton = document.createElement('button')
  private readonly readOnlyCompartment = new Compartment()
  private readonly instanceId = `arkdown-mermaid-${nextMermaidInstanceId++}`
  private observer: IntersectionObserver | null = null
  private unregister: () => void = () => undefined
  private unsubscribeCapacity: (() => void) | null = null

  private cm: CodeMirror | null = null
  private renderTimer: ReturnType<typeof setTimeout> | null = null
  private resolveRenderTimer: (() => void) | null = null
  private renderController: AbortController | null = null
  private generation = 0
  private visible = false
  private destroyed = false
  private updating = false
  private composing = false
  private pendingCompositionUpdate = false
  private sourceMode = false
  private renderState: 'pending' | 'ready' | 'error' = 'pending'
  private printFrozen = false
  private capacityLimited = false

  constructor(
    private node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly deps: MermaidViewDependencies,
  ) {
    this.dom.className = 'arkdown-mermaid-block'
    this.dom.tabIndex = -1
    this.syncHostState()
    this.dom.addEventListener('arkdown:mermaid-set-mode', this.setModeFromEvent)

    const toolbar = document.createElement('div')
    toolbar.className = 'arkdown-mermaid-toolbar'
    this.returnCodeBlockButton.type = 'button'
    this.returnCodeBlockButton.dataset.action = 'return-code-block'
    this.returnCodeBlockButton.textContent = '<'
    this.returnCodeBlockButton.setAttribute('aria-label', '返回普通代码块')
    this.returnCodeBlockButton.dataset.tooltip = '返回普通代码块'
    this.returnCodeBlockButton.disabled = !view.editable
    this.returnCodeBlockButton.addEventListener('click', this.returnToCodeBlock)
    this.toggleSourceButton.type = 'button'
    this.toggleSourceButton.dataset.action = 'toggle-source'
    this.toggleSourceButton.textContent = '编辑源码'
    this.toggleSourceButton.addEventListener('click', this.toggleSource)
    toolbar.append(this.returnCodeBlockButton, this.toggleSourceButton)

    this.preview.className = 'arkdown-mermaid-preview'
    this.setPreviewAnnouncement('status', 'polite')
    this.preview.textContent = '正在生成 Mermaid 图形…'
    this.sourceHost.className = 'arkdown-mermaid-source'
    this.sourceHost.hidden = true
    this.dom.append(toolbar, this.preview, this.sourceHost)

    if (!this.register()) {
      this.capacityLimited = true
      this.renderError('resource-error', 'BLOCK_LIMIT')
      this.unsubscribeCapacity = deps.registry.subscribeCapacityAvailable?.(
        this.retryCapacityRegistration,
      ) ?? null
      return
    }
    this.startObserving()
  }

  private register(): boolean {
    try {
      this.unregister = this.deps.registry.register(this)
      return true
    } catch (error) {
      if (error instanceof MermaidRegistryCapacityError) return false
      throw error
    }
  }

  private startObserving(): void {
    if (typeof IntersectionObserver === 'undefined') {
      this.visible = true
      this.refresh('source')
    } else {
      this.observer = new IntersectionObserver((entries) => {
        const entry = entries.find((candidate) => candidate.target === this.dom)
        if (!entry) return
        this.visible = entry.isIntersecting
        if (this.visible) this.refresh('source')
      }, { rootMargin: '300px' })
      this.observer.observe(this.dom)
    }
  }

  private readonly retryCapacityRegistration = () => {
    if (this.destroyed || !this.capacityLimited || !this.register()) return
    this.capacityLimited = false
    this.unsubscribeCapacity?.()
    this.unsubscribeCapacity = null
    this.renderLoading()
    this.startObserving()
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type || !isMermaidCodeBlock(node)) return false
    const sourceChanged = node.textContent !== this.node.textContent
    this.node = node
    this.returnCodeBlockButton.disabled = !this.view.editable

    if (this.cm) {
      this.updateReadOnly()
      if (!this.updating) {
        const change = computeChange(this.cm.state.doc.toString(), node.textContent)
        if (change) {
          this.updating = true
          this.cm.dispatch({
            changes: { from: change.from, to: change.to, insert: change.text },
          })
          this.updating = false
        }
      }
    }

    if (sourceChanged) this.refresh('source')
    return true
  }

  refresh(reason: 'source' | 'theme' | 'print'): void {
    if (this.destroyed || this.capacityLimited) return
    if (this.printFrozen && reason !== 'print') return

    this.generation += 1
    const generation = this.generation
    this.renderState = 'pending'
    this.syncHostState()
    this.clearRenderTimer()
    this.renderController?.abort()
    this.renderController = null

    if (!this.visible && reason !== 'print') return
    if (reason === 'print') {
      this.startRender(generation, true)
      return
    }
    const delay = reason === 'source' ? 250 : 0
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null
      this.startRender(generation)
    }, delay)
  }

  preparePrint(freezeAfterPrint: boolean): void {
    if (this.destroyed || this.capacityLimited) return
    if (freezeAfterPrint) {
      this.printFrozen = true
      this.observer?.disconnect()
    }
    this.generation += 1
    this.clearRenderTimer()
    this.renderController?.abort()
    this.renderController = null
  }

  finishPrintTimeout(): void {
    if (this.destroyed || this.capacityLimited || this.renderState !== 'pending') return
    this.generation += 1
    this.clearRenderTimer()
    this.renderController?.abort()
    this.renderController = null
    this.renderError('resource-error', 'TIMEOUT')
  }

  setSelection(anchor: number, head: number): void {
    this.showSource()
    if (!this.cm?.dom.isConnected) return
    this.cm.focus()
    this.updating = true
    this.cm.dispatch({ selection: { anchor, head } })
    this.updating = false
  }

  selectNode(): void {
    this.dom.classList.add('selected')
    this.dom.focus()
  }

  deselectNode(): void {
    this.dom.classList.remove('selected')
  }

  stopEvent(): boolean {
    return true
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.generation += 1
    this.clearRenderTimer()
    this.renderController?.abort()
    this.renderController = null
    this.observer?.disconnect()
    this.unsubscribeCapacity?.()
    this.unsubscribeCapacity = null
    this.unregister()
    this.toggleSourceButton.removeEventListener('click', this.toggleSource)
    this.returnCodeBlockButton.removeEventListener('click', this.returnToCodeBlock)
    this.dom.removeEventListener('arkdown:mermaid-set-mode', this.setModeFromEvent)
    this.cm?.destroy()
    this.cm = null
  }

  private readonly toggleSource = () => {
    if (this.sourceMode) this.showPreview()
    else this.showSource()
  }

  private readonly returnToCodeBlock = () => {
    if (this.destroyed || !this.view.editable) return
    const position = this.getPos()
    if (position == null) return
    const current = this.view.state.doc.nodeAt(position)
    if (!current || current.type !== this.node.type || !isMermaidCodeBlock(current)) return
    this.view.dispatch(this.view.state.tr.setNodeAttribute(position, 'language', ''))
  }

  private showSource(): void {
    this.initializeCodeMirror()
    this.sourceMode = true
    this.preview.hidden = true
    this.sourceHost.hidden = false
    this.toggleSourceButton.textContent = '显示图形'
    this.syncHostState()
  }

  private showPreview(): void {
    this.sourceMode = false
    this.preview.hidden = false
    this.sourceHost.hidden = true
    this.toggleSourceButton.textContent = '编辑源码'
    this.syncHostState()
  }

  private readonly setModeFromEvent = (event: Event) => {
    if (this.destroyed) return
    const mode = (event as CustomEvent<{ mode?: unknown }>).detail?.mode
    if (mode === 'source') this.showSource()
    else if (mode === 'preview') this.showPreview()
  }

  private syncHostState(): void {
    this.dom.dataset.arkdownMermaidMode = this.sourceMode ? 'source' : 'preview'
    this.dom.dataset.arkdownMermaidRenderState = this.renderState
    this.dom.dataset.arkdownMermaidRenderGeneration = String(this.generation)
  }

  private initializeCodeMirror(): void {
    if (this.cm) {
      this.updateReadOnly()
      return
    }

    this.cm = new CodeMirror({
      doc: this.node.textContent,
      parent: this.sourceHost,
      root: this.view.root,
      extensions: [
        this.readOnlyCompartment.of(EditorState.readOnly.of(!this.view.editable)),
        drawSelection(),
        codeMirrorKeymap.of(this.keymap()),
        EditorState.changeFilter.of(() => this.view.editable),
        ...this.deps.extensions,
        CodeMirror.updateListener.of(this.forwardCodeMirrorUpdate),
      ],
    })
    this.cm.contentDOM.addEventListener('compositionstart', this.onCompositionStart)
    this.cm.contentDOM.addEventListener('compositionend', this.onCompositionEnd)
  }

  private updateReadOnly(): void {
    if (!this.cm || this.cm.state.readOnly === !this.view.editable) return
    this.cm.dispatch({
      effects: this.readOnlyCompartment.reconfigure(
        EditorState.readOnly.of(!this.view.editable),
      ),
    })
  }

  private readonly onCompositionStart = () => {
    this.composing = true
  }

  private readonly onCompositionEnd = () => {
    this.composing = false
    if (!this.pendingCompositionUpdate) return
    this.pendingCompositionUpdate = false
    queueMicrotask(() => this.synchronizeCodeMirrorToProseMirror())
  }

  private readonly forwardCodeMirrorUpdate = (update: ViewUpdate) => {
    if (this.updating || !this.cm?.hasFocus) return
    if (this.composing || update.view.composing) {
      if (update.docChanged || update.selectionSet) this.pendingCompositionUpdate = true
      return
    }
    if (update.docChanged || update.selectionSet || update.focusChanged) {
      this.synchronizeCodeMirrorToProseMirror()
    }
  }

  private synchronizeCodeMirrorToProseMirror(): void {
    if (!this.cm || this.destroyed || this.updating || !this.view.editable) return
    const position = this.getPos()
    if (position == null) return

    const source = this.cm.state.doc.toString()
    const currentSource = this.node.textContent
    const start = position + 1
    const main = this.cm.state.selection.main
    const selectionAnchor = start + main.anchor
    const selectionHead = start + main.head
    const currentSelection = this.view.state.selection
    if (
      source === currentSource
      && currentSelection.anchor === selectionAnchor
      && currentSelection.head === selectionHead
    ) return

    const transaction = this.view.state.tr
    if (source !== currentSource) {
      transaction.insertText(source, start, start + currentSource.length)
    }
    transaction.setSelection(TextSelection.create(
      transaction.doc,
      Math.min(selectionAnchor, transaction.doc.content.size),
      Math.min(selectionHead, transaction.doc.content.size),
    ))

    this.updating = true
    this.view.dispatch(transaction)
    this.updating = false
  }

  private keymap(): KeyBinding[] {
    return [
      { key: 'ArrowUp', run: () => this.maybeEscape('line', -1) },
      { key: 'ArrowLeft', run: () => this.maybeEscape('char', -1) },
      { key: 'ArrowDown', run: () => this.maybeEscape('line', 1) },
      { key: 'ArrowRight', run: () => this.maybeEscape('char', 1) },
      {
        key: 'Mod-Enter',
        run: () => {
          if (!this.view.editable) return false
          if (!exitCode(this.view.state, this.view.dispatch)) return false
          this.view.focus()
          return true
        },
      },
      {
        key: 'Mod-z',
        run: () => this.view.editable && undo(this.view.state, this.view.dispatch),
      },
      {
        key: 'Shift-Mod-z',
        run: () => this.view.editable && redo(this.view.state, this.view.dispatch),
      },
      {
        key: 'Mod-y',
        run: () => this.view.editable && redo(this.view.state, this.view.dispatch),
      },
      {
        key: 'Backspace',
        run: () => this.backspaceAtStart(),
      },
    ]
  }

  private backspaceAtStart(): boolean {
    if (!this.cm || !this.view.editable) return false
    const ranges = this.cm.state.selection.ranges
    if (ranges.length !== 1) return false
    const selection = ranges[0]
    if (!selection || !selection.empty || selection.anchor > 0) return false
    if (this.cm.state.doc.lines >= 2) return false

    const position = this.getPos()
    if (position == null) return false
    const state = this.view.state
    const paragraph = state.schema.nodes.paragraph
    if (!paragraph) return false
    const transaction = state.tr.replaceWith(
      position,
      position + this.node.nodeSize,
      paragraph.createChecked({}, this.node.content),
    )
    transaction.setSelection(TextSelection.near(transaction.doc.resolve(position)))
    this.view.dispatch(transaction)
    this.view.focus()
    return true
  }

  private maybeEscape(unit: 'line' | 'char', direction: -1 | 1): boolean {
    if (!this.cm) return false
    let main: SelectionRange | Line = this.cm.state.selection.main
    if (!main.empty) return false
    if (unit === 'line') main = this.cm.state.doc.lineAt(main.head)
    if (direction < 0 ? main.from > 0 : main.to < this.cm.state.doc.length) return false

    const position = this.getPos()
    if (position == null) return false
    const target = position + (direction < 0 ? 0 : this.node.nodeSize)
    const selection = TextSelection.near(this.view.state.doc.resolve(target), direction)
    this.view.dispatch(this.view.state.tr.setSelection(selection).scrollIntoView())
    this.view.focus()
    return true
  }

  private startRender(generation: number, allowOffscreen = false): void {
    if (this.destroyed || generation !== this.generation) return
    const source = this.node.textContent
    const appearance = this.deps.registry.appearance()
    const controller = new AbortController()
    this.renderController = controller
    this.renderLoading()

    const task = (async () => {
      let queueRetryCount = 0
      while (this.canApplyRender(source, generation, appearance.revision, controller)) {
        const result = await this.deps.renderer.render({
          instanceId: this.instanceId,
          generation,
          source,
          appearance,
          signal: controller.signal,
        })
        if (!this.canApplyRender(source, generation, appearance.revision, controller)) return
        if (result.status === 'resource-error' && result.code === 'QUEUE_LIMIT') {
          this.renderLoading()
          await this.waitForQueueRetry(queueRetryCount)
          queueRetryCount += 1
          if (!allowOffscreen && !this.visible) return
          continue
        }
        if (result.status === 'ready') this.renderReady(result.dataUrl)
        else if (result.status === 'syntax-error') {
          this.renderError(result.status, undefined, result.summary)
        } else this.renderError(result.status, result.code)
        return
      }
    })().catch(() => {
      if (this.canApplyRender(source, generation, appearance.revision, controller)) {
        this.renderError('unknown')
      }
    })

    this.deps.registry.track(this.instanceId, generation, task)
  }

  private canApplyRender(
    source: string,
    generation: number,
    appearanceRevision: number,
    controller: AbortController,
  ): boolean {
    return !this.destroyed
      && !controller.signal.aborted
      && generation === this.generation
      && source === this.node.textContent
      && appearanceRevision === this.deps.registry.appearance().revision
  }

  private renderLoading(): void {
    this.renderState = 'pending'
    this.syncHostState()
    this.setPreviewAnnouncement('status', 'polite')
    this.preview.replaceChildren(document.createTextNode('正在生成 Mermaid 图形…'))
  }

  private renderReady(dataUrl: string): void {
    this.renderState = 'ready'
    this.syncHostState()
    this.preview.removeAttribute('role')
    this.preview.removeAttribute('aria-live')
    const image = document.createElement('img')
    image.alt = 'Mermaid diagram'
    image.src = dataUrl
    image.draggable = false
    image.tabIndex = 0
    image.setAttribute('role', 'button')
    image.setAttribute('aria-label', '在新窗口查看 Mermaid 图形')
    image.dataset.tooltip = '在新窗口查看 Mermaid 图形'
    const { colorScheme, themeColor } = this.deps.registry.appearance()
    const generation = this.generation
    let opening = false
    const open = async () => {
      if (opening || this.destroyed || generation !== this.generation || this.sourceMode) return
      opening = true
      this.preview.querySelector('[data-mermaid-viewer-error]')?.remove()
      try {
        const result = await window.arkdown?.openMermaidViewer?.({ svgDataUrl: dataUrl, colorScheme, themeColor })
        if (!result?.ok) throw new Error(result && !result.ok ? result.error.message : '无法打开 Mermaid 查看窗口')
      } catch (error) {
        if (!this.destroyed && generation === this.generation && !this.sourceMode) {
          const message = document.createElement('span')
          message.dataset.mermaidViewerError = ''
          message.setAttribute('role', 'alert')
          message.textContent = error instanceof Error ? error.message : '无法打开 Mermaid 查看窗口'
          this.preview.append(message)
        }
      } finally { opening = false }
    }
    image.addEventListener('mousedown', event => { if (event.button === 0) event.preventDefault() })
    image.addEventListener('click', event => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      void open()
    })
    image.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      event.stopPropagation()
      void open()
    })
    this.preview.replaceChildren(image)
  }

  private renderError(
    status: 'syntax-error' | 'resource-error' | 'unknown',
    code?: 'SOURCE_LIMIT' | 'EDGE_LIMIT' | 'SVG_LIMIT' | 'TIMEOUT' | 'QUEUE_LIMIT' | 'BLOCK_LIMIT',
    syntaxSummary?: MermaidSyntaxErrorSummary,
  ): void {
    this.renderState = 'error'
    this.syncHostState()
    this.setPreviewAnnouncement('alert', 'assertive')
    let message = '无法生成 Mermaid 图形'
    if (status === 'syntax-error') message = 'Mermaid 语法错误'
    else if (code === 'SOURCE_LIMIT') message = 'Mermaid 源码超过 20,000 字符限制'
    else if (code === 'BLOCK_LIMIT') message = `Mermaid 图块超过 ${MERMAID_MAX_BLOCKS} 个限制`
    else if (code === 'TIMEOUT') message = 'Mermaid 图形生成超时'
    else if (code === 'EDGE_LIMIT' || code === 'SVG_LIMIT' || code === 'QUEUE_LIMIT') {
      message = 'Mermaid 图形过于复杂，无法安全显示'
    }

    const label = document.createElement('span')
    label.textContent = message
    let summary: HTMLSpanElement | null = null
    if (status === 'syntax-error') {
      let summaryText = '请检查图表类型、关键字和连线语法'
      if (syntaxSummary?.kind === 'unknown-diagram') summaryText = '无法识别图表类型'
      else if (
        syntaxSummary?.kind === 'line'
        && Number.isSafeInteger(syntaxSummary.line)
        && syntaxSummary.line >= 1
      ) {
        summaryText = `第 ${syntaxSummary.line} 行附近存在语法错误`
      }
      summary = document.createElement('span')
      summary.className = 'arkdown-mermaid-error-summary'
      summary.textContent = summaryText.slice(0, MERMAID_ERROR_SUMMARY_MAX_LENGTH)
    }
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.dataset.action = 'edit-error-source'
    edit.textContent = '编辑源码'
    edit.addEventListener('click', () => this.showSource(), { once: true })
    this.preview.replaceChildren(label, ...(summary ? [summary] : []), edit)
  }

  private setPreviewAnnouncement(role: 'status' | 'alert', live: 'polite' | 'assertive'): void {
    this.preview.setAttribute('role', role)
    this.preview.setAttribute('aria-live', live)
  }

  private clearRenderTimer(): void {
    if (this.renderTimer !== null) clearTimeout(this.renderTimer)
    this.renderTimer = null
    const resolve = this.resolveRenderTimer
    this.resolveRenderTimer = null
    resolve?.()
  }

  private waitForQueueRetry(retryCount: number): Promise<void> {
    this.clearRenderTimer()
    const delay = Math.min(
      MERMAID_QUEUE_RETRY_DELAY_MS * (2 ** retryCount),
      MERMAID_QUEUE_RETRY_MAX_DELAY_MS,
    )
    return new Promise((resolve) => {
      this.resolveRenderTimer = resolve
      this.renderTimer = setTimeout(() => {
        this.renderTimer = null
        this.resolveRenderTimer = null
        resolve()
      }, delay)
    })
  }
}

let nextMermaidInstanceId = 1

function computeChange(
  oldValue: string,
  newValue: string,
): { from: number; to: number; text: string } | null {
  if (oldValue === newValue) return null
  let start = 0
  let oldEnd = oldValue.length
  let newEnd = newValue.length
  while (start < oldEnd && oldValue.charCodeAt(start) === newValue.charCodeAt(start)) start += 1
  while (
    oldEnd > start
    && newEnd > start
    && oldValue.charCodeAt(oldEnd - 1) === newValue.charCodeAt(newEnd - 1)
  ) {
    oldEnd -= 1
    newEnd -= 1
  }
  return { from: start, to: oldEnd, text: newValue.slice(start, newEnd) }
}

class AdaptiveCodeBlockView implements NodeView {
  readonly dom: HTMLElement
  private readonly child: NodeView
  private explanationBridgeAttached = false
  private mermaidBridgeAttached = false

  constructor(
    private node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    decorations: readonly Decoration[],
    innerDecorations: DecorationSource,
    base: NodeViewConstructor,
    deps: MermaidViewDependencies,
  ) {
    this.child = isMermaidCodeBlock(node)
      ? new MermaidCodeBlockView(node, view, getPos, deps)
      : base(node, view, getPos, decorations, innerDecorations)
    this.dom = this.child.dom
    this.dom.classList.add('arkdown-adaptive-code-block')
    this.syncOrdinaryCodeBlockBridges(node)
  }

  update(
    node: ProseMirrorNode,
    decorations: readonly Decoration[],
    innerDecorations: DecorationSource,
  ): boolean {
    if (node.type !== this.node.type) return false
    if (isMermaidCodeBlock(node) !== isMermaidCodeBlock(this.node)) return false
    const updated = this.child.update?.(node, decorations, innerDecorations) ?? false
    if (updated) {
      this.node = node
      this.syncOrdinaryCodeBlockBridges(node)
    }
    return updated
  }

  setSelection(anchor: number, head: number, root: Document | ShadowRoot): void {
    this.child.setSelection?.(anchor, head, root)
  }

  selectNode(): void {
    this.child.selectNode?.()
  }

  deselectNode(): void {
    this.child.deselectNode?.()
  }

  stopEvent(event: Event): boolean {
    return this.child.stopEvent?.(event) ?? false
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return this.child.ignoreMutation?.(mutation) ?? true
  }

  destroy(): void {
    this.syncOrdinaryCodeBlockBridges(null)
    this.child.destroy?.()
  }

  private readonly convertToMermaid = () => {
    if (!this.view.editable || !isOrdinaryCodeBlock(this.node)) return
    const position = this.getPos()
    if (position == null) return
    const current = this.view.state.doc.nodeAt(position)
    if (!current || current.type !== this.node.type || !isOrdinaryCodeBlock(current)) return
    this.view.dispatch(this.view.state.tr.setNodeAttribute(position, 'language', 'mermaid'))
  }

  private readonly requestCodeExplanation = () => {
    if (!this.view.editable || !isOrdinaryCodeBlock(this.node)) return
    const position = this.getPos()
    if (position == null) return
    const current = this.view.state.doc.nodeAt(position)
    if (!current || current.type !== this.node.type || !isOrdinaryCodeBlock(current)) return
    this.dom.dispatchEvent(new CustomEvent<CodeExplanationRequestDetail>(
      CODE_EXPLANATION_REQUEST_EVENT,
      {
        bubbles: true,
        detail: {
          language: String(current.attrs.language ?? ''),
          code: current.textContent,
        },
      },
    ))
  }

  private syncOrdinaryCodeBlockBridges(node: ProseMirrorNode | null): void {
    const ordinary = Boolean(node && isOrdinaryCodeBlock(node))
    if (ordinary && !this.mermaidBridgeAttached) {
      this.dom.addEventListener('arkdown:convert-code-block-to-mermaid', this.convertToMermaid)
      this.mermaidBridgeAttached = true
    } else if (!ordinary && this.mermaidBridgeAttached) {
      this.dom.removeEventListener('arkdown:convert-code-block-to-mermaid', this.convertToMermaid)
      this.mermaidBridgeAttached = false
    }

    if (ordinary && !this.explanationBridgeAttached) {
      this.dom.addEventListener(DOM_CODE_EXPLANATION_REQUEST_EVENT, this.requestCodeExplanation)
      this.explanationBridgeAttached = true
    } else if (!ordinary && this.explanationBridgeAttached) {
      this.dom.removeEventListener(DOM_CODE_EXPLANATION_REQUEST_EVENT, this.requestCodeExplanation)
      this.explanationBridgeAttached = false
    }
  }
}

export function createAdaptiveMermaidCodeBlockView(deps: Dependencies) {
  return $view(codeBlockSchema.node, (ctx): NodeViewConstructor => {
    const base = codeBlockView.view
    const extensions = ctx.get(codeBlockConfig.key).extensions
    return (node, view, getPos, decorations, innerDecorations) => new AdaptiveCodeBlockView(
      node,
      view,
      getPos,
      decorations,
      innerDecorations,
      base,
      { ...deps, extensions },
    )
  })
}
