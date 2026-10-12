import type { EditorView } from '@milkdown/kit/prose/view'
import { applyManualLink } from './smart-link-plugin'

export interface LinkEditorPopoverOptions {
  view: EditorView
  from: number
  to: number
  initialHref?: string
  anchor: { left: number; top: number; bottom: number }
  onCommit?(): void
}

export interface LinkEditorPopoverController {
  element: HTMLFormElement
  close(): void
}

const openLinkEditors = new WeakMap<Document, LinkEditorPopoverController>()
const viewportMargin = 8
const anchorGap = 6

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

function placeInsideViewport(
  element: HTMLElement,
  anchor: LinkEditorPopoverOptions['anchor'],
): void {
  const ownerDocument = element.ownerDocument
  const viewport = ownerDocument.defaultView
  const viewportWidth = viewport?.innerWidth ?? ownerDocument.documentElement.clientWidth
  const viewportHeight = viewport?.innerHeight ?? ownerDocument.documentElement.clientHeight
  const bounds = element.getBoundingClientRect()
  const maximumLeft = viewportWidth - bounds.width - viewportMargin
  const maximumTop = viewportHeight - bounds.height - viewportMargin
  const below = anchor.bottom + anchorGap
  const above = anchor.top - anchorGap - bounds.height
  const top = below + bounds.height <= viewportHeight - viewportMargin
    ? clamp(below, viewportMargin, maximumTop)
    : above >= viewportMargin
      ? clamp(above, viewportMargin, maximumTop)
      : clamp(below, viewportMargin, maximumTop)
  element.style.left = `${clamp(anchor.left, viewportMargin, maximumLeft)}px`
  element.style.top = `${top}px`
}

export function createLinkEditorPopover({
  view,
  from,
  to,
  initialHref = '',
  anchor,
  onCommit,
}: LinkEditorPopoverOptions): LinkEditorPopoverController {
  const ownerDocument = view.dom.ownerDocument
  openLinkEditors.get(ownerDocument)?.close()

  const element = ownerDocument.createElement('form')
  element.className = 'arkdown-link-editor-popover'
  element.setAttribute('aria-label', initialHref ? '编辑链接' : '插入链接')
  element.style.visibility = 'hidden'

  const label = ownerDocument.createElement('label')
  label.textContent = '链接地址'
  const input = ownerDocument.createElement('input')
  input.type = 'text'
  input.value = initialHref
  input.autocomplete = 'off'
  input.spellcheck = false
  label.append(input)

  const feedback = ownerDocument.createElement('div')
  feedback.className = 'arkdown-link-editor-error'
  feedback.setAttribute('role', 'alert')
  feedback.hidden = true

  const actions = ownerDocument.createElement('div')
  actions.className = 'arkdown-link-editor-actions'
  const cancel = ownerDocument.createElement('button')
  cancel.type = 'button'
  cancel.textContent = '取消'
  const confirm = ownerDocument.createElement('button')
  confirm.type = 'submit'
  confirm.textContent = '确定'
  actions.append(cancel, confirm)
  element.append(label, feedback, actions)

  let closed = false
  let controller: LinkEditorPopoverController
  const close = () => {
    if (closed) return
    closed = true
    ownerDocument.removeEventListener('pointerdown', onOutsidePointerDown, true)
    element.remove()
    if (openLinkEditors.get(ownerDocument) === controller) openLinkEditors.delete(ownerDocument)
    view.focus()
  }
  const submit = () => {
    if (!applyManualLink(view, from, to, input.value)) {
      feedback.textContent = '请输入有效的网页地址或 Windows 绝对路径。'
      feedback.hidden = false
      input.setAttribute('aria-invalid', 'true')
      input.focus()
      return
    }
    close()
    onCommit?.()
  }
  const onOutsidePointerDown = (event: Event) => {
    if (event.target instanceof Node && element.contains(event.target)) return
    close()
  }

  element.addEventListener('submit', (event) => {
    event.preventDefault()
    submit()
  })
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
  })
  cancel.addEventListener('click', close)
  ownerDocument.body.append(element)
  placeInsideViewport(element, anchor)
  element.style.visibility = 'visible'
  ownerDocument.addEventListener('pointerdown', onOutsidePointerDown, true)
  input.focus()
  input.select()

  controller = { element, close }
  openLinkEditors.set(ownerDocument, controller)
  return controller
}
