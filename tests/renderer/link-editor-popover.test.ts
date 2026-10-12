import { fireEvent, getByRole } from '@testing-library/dom'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLinkEditorPopover } from '../../src/renderer/editor/link-editor-popover'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
  marks: {
    link: {
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
      toDOM: (mark) => ['a', { href: mark.attrs.href }, 0],
    },
  },
})

let view: EditorView | null = null
const initialInnerWidth = window.innerWidth
const initialInnerHeight = window.innerHeight

afterEach(() => {
  view?.destroy()
  view = null
  document.body.replaceChildren()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: initialInnerWidth })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: initialInnerHeight })
  vi.restoreAllMocks()
})

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
}

function observePopoverMeasurement(width: number, height: number): string[] {
  const measuredVisibility: string[] = []
  const nativeBounds = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains('arkdown-link-editor-popover')) {
      measuredVisibility.push(this.style.visibility)
      return new DOMRect(0, 0, width, height)
    }
    return nativeBounds.call(this)
  })
  return measuredVisibility
}

function openEditor(
  initialHref = '',
  anchor = { left: 24, top: 24, bottom: 40 },
) {
  const host = document.body.appendChild(document.createElement('div'))
  view = new EditorView(host, {
    state: EditorState.create({
      schema,
      doc: schema.nodes.doc!.create(undefined, [
        schema.nodes.paragraph!.create(undefined, schema.text('selected label')),
      ]),
    }),
  })
  const onCommit = vi.fn()
  const controller = createLinkEditorPopover({
    view,
    from: 1,
    to: 15,
    initialHref,
    anchor,
    onCommit,
  })
  return {
    controller,
    input: getByRole(controller.element, 'textbox') as HTMLInputElement,
    onCommit,
  }
}

function currentHref(): string | null {
  const node = view!.state.doc.firstChild!.firstChild!
  const link = node.marks.find((mark) => mark.type === schema.marks.link)
  return link ? String(link.attrs.href) : null
}

describe('manual link editor popover', () => {
  it('focuses and selects the address input when opened', () => {
    const { input } = openEditor('https://example.com')

    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
  })

  it('measures while hidden and clamps the popover inside the right viewport edge', () => {
    setViewport(800, 600)
    const measuredVisibility = observePopoverMeasurement(360, 140)

    const { controller, input } = openEditor('', {
      left: 760,
      top: 100,
      bottom: 120,
    })

    expect(measuredVisibility).toEqual(['hidden'])
    expect(controller.element.style.left).toBe('432px')
    expect(controller.element.style.top).toBe('126px')
    expect(controller.element.style.visibility).toBe('visible')
    expect(document.activeElement).toBe(input)
  })

  it('places the measured popover above an anchor near the bottom edge', () => {
    setViewport(800, 600)
    observePopoverMeasurement(360, 140)

    const { controller } = openEditor('', {
      left: 24,
      top: 520,
      bottom: 540,
    })

    expect(controller.element.style.left).toBe('24px')
    expect(controller.element.style.top).toBe('374px')
  })

  it('clamps both axes and preserves input focus in a constrained viewport', () => {
    setViewport(220, 100)
    observePopoverMeasurement(204, 84)

    const { controller, input } = openEditor('', {
      left: 210,
      top: 80,
      bottom: 90,
    })

    expect(controller.element.style.left).toBe('8px')
    expect(controller.element.style.top).toBe('8px')
    expect(document.activeElement).toBe(input)
  })

  it('confirms with Enter, preserves selected text, and restores editor focus', () => {
    const { controller, input, onCommit } = openEditor()
    fireEvent.input(input, { target: { value: 'www.example.com/guide' } })

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(view!.state.doc.textContent).toBe('selected label')
    expect(currentHref()).toBe('https://www.example.com/guide')
    expect(controller.element.isConnected).toBe(false)
    expect(document.activeElement).toBe(view!.dom)
    expect(onCommit).toHaveBeenCalledOnce()
  })

  it('shows inline feedback and keeps the editor open for an invalid target', () => {
    const { controller, input, onCommit } = openEditor()
    fireEvent.input(input, { target: { value: 'javascript:alert(1)' } })

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(getByRole(controller.element, 'alert')).toHaveTextContent('请输入有效的网页地址或 Windows 绝对路径。')
    expect(controller.element.isConnected).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(currentHref()).toBeNull()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('cancels with Escape without changing the selection and restores focus', () => {
    const { controller, input, onCommit } = openEditor()

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(view!.state.doc.textContent).toBe('selected label')
    expect(currentHref()).toBeNull()
    expect(controller.element.isConnected).toBe(false)
    expect(document.activeElement).toBe(view!.dom)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('cancels on an outside pointer press', () => {
    const { controller, onCommit } = openEditor()

    fireEvent.pointerDown(document.body)

    expect(controller.element.isConnected).toBe(false)
    expect(document.activeElement).toBe(view!.dom)
    expect(currentHref()).toBeNull()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('replaces an existing editor without leaving its outside-click listener active', () => {
    openEditor()
    const replacement = createLinkEditorPopover({
      view: view!,
      from: 1,
      to: 15,
      anchor: { left: 40, top: 32, bottom: 48 },
    })
    const input = getByRole(replacement.element, 'textbox') as HTMLInputElement

    fireEvent.pointerDown(input)

    expect(document.querySelectorAll('.arkdown-link-editor-popover')).toHaveLength(1)
    expect(document.activeElement).toBe(input)
    expect(replacement.element.isConnected).toBe(true)
  })
})
