import { beforeEach, describe, expect, it } from 'vitest'
import {
  installUiSelectionGuard,
  isNativeSelectAllSurface,
  isTextSelectionSurface,
} from '../../src/renderer/app/ui-selection-guard'

function sendSelectAll(target: EventTarget, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    key: 'a',
    ...options,
  })
  if (options.isComposing) Object.defineProperty(event, 'isComposing', { value: true })
  target.dispatchEvent(event)
  return event
}

beforeEach(() => {
  window.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe('selection surfaces', () => {
  it('recognizes native and read-only text selection surfaces', () => {
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const proseMirror = document.createElement('div')
    proseMirror.className = 'ProseMirror'
    const codeMirror = document.createElement('div')
    codeMirror.className = 'cm-content'
    const translation = document.createElement('pre')
    translation.className = 'translation-output'
    const readable = document.createElement('div')
    readable.dataset.uiSelectable = 'true'
    const menuButton = document.createElement('button')
    const label = document.createElement('span')

    for (const surface of [input, textarea, editable, proseMirror, codeMirror, translation, readable]) {
      expect(isTextSelectionSurface(surface)).toBe(true)
    }
    for (const nativeSurface of [input, textarea, editable, proseMirror, codeMirror]) {
      expect(isNativeSelectAllSurface(nativeSurface)).toBe(true)
    }
    expect(isTextSelectionSurface(menuButton)).toBe(false)
    expect(isTextSelectionSurface(label)).toBe(false)
    expect(isNativeSelectAllSurface(translation)).toBe(false)
    expect(isNativeSelectAllSurface(readable)).toBe(false)
  })
})

describe('installUiSelectionGuard', () => {
  it('leaves Ctrl+A native on editing surfaces', () => {
    const root = document.body.appendChild(document.createElement('div'))
    const input = root.appendChild(document.createElement('input'))
    const proseMirror = root.appendChild(document.createElement('div'))
    proseMirror.className = 'ProseMirror'
    const cleanup = installUiSelectionGuard(root)

    expect(sendSelectAll(input).defaultPrevented).toBe(false)
    expect(sendSelectAll(proseMirror).defaultPrevented).toBe(false)

    cleanup()
  })

  it('selects only the nearest explicitly readable region', () => {
    const root = document.body.appendChild(document.createElement('div'))
    const outer = root.appendChild(document.createElement('div'))
    outer.dataset.uiSelectable = 'true'
    outer.append('outer ')
    const inner = outer.appendChild(document.createElement('div'))
    inner.dataset.uiSelectable = 'true'
    inner.tabIndex = 0
    const nestedText = inner.appendChild(document.createElement('span'))
    nestedText.textContent = 'inner text'
    const cleanup = installUiSelectionGuard(root)

    inner.focus()
    const event = sendSelectAll(document.activeElement!)
    const selection = window.getSelection()!

    expect(document.activeElement).toBe(inner)
    expect(event.defaultPrevented).toBe(true)
    expect(selection.toString()).toBe('inner text')
    expect(selection.getRangeAt(0).commonAncestorContainer).toBe(inner)

    cleanup()
  })

  it('prevents Ctrl+A on ordinary application chrome without creating a selection', () => {
    const root = document.body.appendChild(document.createElement('div'))
    const button = root.appendChild(document.createElement('button'))
    button.textContent = 'Open menu'
    const cleanup = installUiSelectionGuard(root)

    const event = sendSelectAll(button)

    expect(event.defaultPrevented).toBe(true)
    expect(window.getSelection()?.rangeCount).toBe(0)

    cleanup()
  })

  it('owns marked main-app portals without claiming unrelated document surfaces', () => {
    const root = document.body.appendChild(document.createElement('div'))
    const portal = document.body.appendChild(document.createElement('div'))
    portal.dataset.uiSelectionPortal = 'true'
    const portalButton = portal.appendChild(document.createElement('button'))
    const unrelatedButton = document.body.appendChild(document.createElement('button'))
    const cleanup = installUiSelectionGuard(root)

    portalButton.focus()
    const portalEvent = sendSelectAll(document.activeElement!)
    unrelatedButton.focus()
    const unrelatedEvent = sendSelectAll(document.activeElement!)

    expect(portalEvent.defaultPrevented).toBe(true)
    expect(unrelatedEvent.defaultPrevented).toBe(false)

    cleanup()
  })

  it('preserves native select-all inside a marked main-app portal', () => {
    const root = document.body.appendChild(document.createElement('div'))
    const portal = document.body.appendChild(document.createElement('div'))
    portal.dataset.uiSelectionPortal = 'true'
    const input = portal.appendChild(document.createElement('input'))
    const cleanup = installUiSelectionGuard(root)

    input.focus()
    const event = sendSelectAll(document.activeElement!)

    expect(document.activeElement).toBe(input)
    expect(event.defaultPrevented).toBe(false)

    cleanup()
  })

  it('removes its listener during cleanup', () => {
    const root = document.body.appendChild(document.createElement('div'))
    const button = root.appendChild(document.createElement('button'))
    const cleanup = installUiSelectionGuard(root)

    cleanup()

    expect(sendSelectAll(button).defaultPrevented).toBe(false)
  })

  it('ignores non-primary shortcuts, events outside the root, and composing input', () => {
    const root = document.body.appendChild(document.createElement('div'))
    const button = root.appendChild(document.createElement('button'))
    const outside = document.body.appendChild(document.createElement('button'))
    const cleanup = installUiSelectionGuard(root)
    const composing = sendSelectAll(button, { isComposing: true })

    expect(sendSelectAll(button, { metaKey: true }).defaultPrevented).toBe(false)
    expect(sendSelectAll(outside).defaultPrevented).toBe(false)
    expect(composing.defaultPrevented).toBe(false)

    cleanup()
  })
})
