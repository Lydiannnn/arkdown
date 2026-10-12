import { afterEach, expect, it, vi } from 'vitest'
import {
  createMarginSelectionController,
  isEditorMarginSelectionExcluded,
  type EditorMarginSelectionPort,
} from '../../src/renderer/editor/editor-margin-selection'

interface FrameHarness {
  flush(): void
  pending(): number
  request(callback: FrameRequestCallback): number
  cancel(id: number): void
}

function frameHarness(): FrameHarness {
  let nextId = 1
  const callbacks = new Map<number, FrameRequestCallback>()
  return {
    request(callback) {
      const id = nextId++
      callbacks.set(id, callback)
      return id
    },
    cancel(id) { callbacks.delete(id) },
    flush() {
      const pending = [...callbacks.entries()]
      callbacks.clear()
      for (const [, callback] of pending) callback(performance.now())
    },
    pending: () => callbacks.size,
  }
}

function pointer(
  type: string,
  input: Partial<MouseEventInit> & {
    pointerId?: number
    pointerType?: string
    isPrimary?: boolean
  } = {},
): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: input.button ?? 0,
    clientX: input.clientX ?? 0,
    clientY: input.clientY ?? 0,
  })
  Object.defineProperties(event, {
    pointerId: { value: input.pointerId ?? 1 },
    pointerType: { value: input.pointerType ?? 'mouse' },
    isPrimary: { value: input.isPrimary ?? true },
  })
  return event as unknown as PointerEvent
}

function setup(input: {
  activationPosition?(point: { clientX: number; clientY: number }): number | null
  eligible?: boolean
  scroll?: HTMLElement | null
  position?(point: { clientX: number; clientY: number }): number | null
} = {}) {
  const frames = frameHarness()
  const target = document.body.appendChild(document.createElement('div'))
  const setPointerCapture = vi.fn()
  const releasePointerCapture = vi.fn()
  Object.defineProperties(target, {
    setPointerCapture: { configurable: true, value: setPointerCapture },
    releasePointerCapture: { configurable: true, value: releasePointerCapture },
  })
  const calls: Array<[number, number]> = []
  const positionAtPoint = vi.fn(input.position ?? ((point) => Math.round(point.clientX)))
  const port: EditorMarginSelectionPort = {
    isEligibleMarginStart: vi.fn(() => input.eligible ?? true),
    activationPositionAtPoint: vi.fn(input.activationPosition ?? positionAtPoint),
    positionAtPoint,
    applySelection: vi.fn((anchor, head) => { calls.push([anchor, head]) }),
    focus: vi.fn(),
    scrollContainer: vi.fn(() => input.scroll ?? null),
    beginPointerSelection: vi.fn(),
    cancelPointerSelection: vi.fn(),
  }
  const controller = createMarginSelectionController({
    getPort: () => port,
    requestFrame: frames.request,
    cancelFrame: frames.cancel,
  })
  return {
    calls,
    controller,
    frames,
    port,
    releasePointerCapture,
    setPointerCapture,
    target,
  }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

it('leaves an ordinary margin click and its existing selection untouched', () => {
  const harness = setup()
  harness.controller.pointerDown(pointer('pointerdown', { clientX: 10 }), harness.target)
  document.dispatchEvent(pointer('pointerup', { clientX: 10 }))

  expect(harness.port.beginPointerSelection).not.toHaveBeenCalled()
  expect(harness.port.focus).not.toHaveBeenCalled()
  expect(harness.calls).toEqual([])
  expect(harness.setPointerCapture).not.toHaveBeenCalled()
})

it('activates only after four CSS pixels and a distinct mapped endpoint', () => {
  const harness = setup({ position: ({ clientX }) => clientX < 15 ? 1 : 7 })
  harness.controller.pointerDown(pointer('pointerdown', { clientX: 10, clientY: 10 }), harness.target)
  window.dispatchEvent(pointer('pointermove', { clientX: 13, clientY: 10 }))
  harness.frames.flush()
  expect(harness.calls).toEqual([])

  window.dispatchEvent(pointer('pointermove', { clientX: 16, clientY: 10 }))
  harness.frames.flush()

  expect(harness.port.beginPointerSelection).toHaveBeenCalledOnce()
  expect(harness.port.focus).toHaveBeenCalledOnce()
  expect(harness.setPointerCapture).toHaveBeenCalledWith(1)
  expect(harness.calls).toEqual([[1, 7]])
})

it('does not activate or autoscroll until a margin drag enters the text column', () => {
  const scroll = document.body.appendChild(document.createElement('div'))
  Object.defineProperties(scroll, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 500 },
    clientWidth: { configurable: true, value: 200 },
    scrollWidth: { configurable: true, value: 200 },
    getBoundingClientRect: {
      configurable: true,
      value: () => new DOMRect(0, 0, 200, 100),
    },
  })
  const harness = setup({
    scroll,
    position: ({ clientX }) => Math.round(clientX),
    activationPosition: ({ clientX }) => (
      clientX >= 80 && clientX <= 120 ? Math.round(clientX) : null
    ),
  })
  harness.controller.pointerDown(
    pointer('pointerdown', { clientX: 10, clientY: 20 }),
    harness.target,
  )

  window.dispatchEvent(pointer('pointermove', { clientX: 20, clientY: 99 }))
  harness.frames.flush()

  expect(scroll.scrollTop).toBe(0)
  expect(harness.port.beginPointerSelection).not.toHaveBeenCalled()
  expect(harness.port.focus).not.toHaveBeenCalled()
  expect(harness.setPointerCapture).not.toHaveBeenCalled()
  expect(harness.calls).toEqual([])

  window.dispatchEvent(pointer('pointermove', { clientX: 90, clientY: 50 }))
  harness.frames.flush()

  expect(harness.port.beginPointerSelection).toHaveBeenCalledOnce()
  expect(harness.setPointerCapture).toHaveBeenCalledWith(1)
  expect(harness.calls).toEqual([[10, 90]])
})

it('keeps a text-column hit as a candidate when active clamped mapping is unavailable', () => {
  const harness = setup({
    activationPosition: ({ clientX }) => clientX >= 20 ? 7 : null,
    position: ({ clientX }) => clientX < 20 ? 1 : null,
  })
  harness.controller.pointerDown(pointer('pointerdown', { clientX: 10 }), harness.target)
  window.dispatchEvent(pointer('pointermove', { clientX: 30 }))
  harness.frames.flush()

  expect(harness.port.beginPointerSelection).not.toHaveBeenCalled()
  expect(harness.setPointerCapture).not.toHaveBeenCalled()
  expect(harness.calls).toEqual([])
})

it('keeps the pre-scroll text endpoint when post-scroll remapping is temporarily unavailable', () => {
  const scroll = document.body.appendChild(document.createElement('div'))
  Object.defineProperties(scroll, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 500 },
    clientWidth: { configurable: true, value: 200 },
    scrollWidth: { configurable: true, value: 200 },
    getBoundingClientRect: {
      configurable: true,
      value: () => new DOMRect(0, 0, 200, 100),
    },
  })
  const harness = setup({
    scroll,
    activationPosition: () => 7,
    position: ({ clientX }) => {
      if (clientX < 20) return 1
      return scroll.scrollTop === 0 ? 7 : null
    },
  })
  harness.controller.pointerDown(
    pointer('pointerdown', { clientX: 10, clientY: 20 }),
    harness.target,
  )
  window.dispatchEvent(pointer('pointermove', { clientX: 30, clientY: 99 }))
  harness.frames.flush()

  expect(scroll.scrollTop).toBeGreaterThan(0)
  expect(harness.calls).toEqual([[1, 7]])
})

it('supports reverse selection and coalesces pointer moves into one animation frame', () => {
  const harness = setup()
  harness.controller.pointerDown(pointer('pointerdown', { clientX: 90 }), harness.target)
  window.dispatchEvent(pointer('pointermove', { clientX: 70 }))
  window.dispatchEvent(pointer('pointermove', { clientX: 30 }))

  expect(harness.frames.pending()).toBe(1)
  harness.frames.flush()
  expect(harness.calls).toEqual([[90, 30]])
})

it('applies the pointerup endpoint before the document selection consumer observes it', () => {
  const harness = setup()
  harness.controller.pointerDown(pointer('pointerdown', { clientX: 10 }), harness.target)
  window.dispatchEvent(pointer('pointermove', { clientX: 30 }))
  harness.frames.flush()
  const observed: Array<Array<[number, number]>> = []
  const consumer = () => { observed.push([...harness.calls]) }
  document.addEventListener('pointerup', consumer, true)

  document.dispatchEvent(pointer('pointerup', { clientX: 44 }))
  document.removeEventListener('pointerup', consumer, true)

  expect(observed).toEqual([[[10, 30], [10, 44]]])
  expect(harness.port.cancelPointerSelection).not.toHaveBeenCalled()
  expect(harness.releasePointerCapture).toHaveBeenCalledWith(1)
})

it('activates a fast drag on pointerup even when no animation frame ran', () => {
  const harness = setup()
  harness.controller.pointerDown(pointer('pointerdown', { clientX: 10 }), harness.target)
  window.dispatchEvent(pointer('pointermove', { clientX: 30 }))

  document.dispatchEvent(pointer('pointerup', { clientX: 44 }))

  expect(harness.port.beginPointerSelection).toHaveBeenCalledOnce()
  expect(harness.calls).toEqual([[10, 44]])
  expect(harness.frames.pending()).toBe(0)
  expect(harness.port.cancelPointerSelection).not.toHaveBeenCalled()
})

it.each([
  ['right button', { button: 2 }],
  ['secondary pointer', { isPrimary: false }],
  ['touch', { pointerType: 'touch' }],
  ['pen', { pointerType: 'pen' }],
] as const)('rejects %s before installing a gesture', (_name, input) => {
  const harness = setup()
  harness.controller.pointerDown(pointer('pointerdown', input), harness.target)
  window.dispatchEvent(pointer('pointermove', { clientX: 30 }))
  harness.frames.flush()
  expect(harness.port.isEligibleMarginStart).not.toHaveBeenCalled()
  expect(harness.calls).toEqual([])
})

it('ignores another pointer and cancels the active gesture on Escape', () => {
  const harness = setup()
  harness.controller.pointerDown(pointer('pointerdown', { clientX: 10, pointerId: 4 }), harness.target)
  window.dispatchEvent(pointer('pointermove', { clientX: 30, pointerId: 5 }))
  harness.frames.flush()
  expect(harness.calls).toEqual([])

  window.dispatchEvent(pointer('pointermove', { clientX: 30, pointerId: 4 }))
  harness.frames.flush()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

  expect(harness.port.cancelPointerSelection).toHaveBeenCalledOnce()
  expect(harness.releasePointerCapture).toHaveBeenCalledWith(4)
  document.dispatchEvent(pointer('pointerup', { clientX: 50, pointerId: 4 }))
  expect(harness.calls).toEqual([[10, 30]])
})

it.each(['pointercancel', 'lostpointercapture', 'blur'] as const)(
  'cleans an active gesture on %s',
  (reason) => {
    const harness = setup()
    harness.controller.pointerDown(pointer('pointerdown', { clientX: 10 }), harness.target)
    window.dispatchEvent(pointer('pointermove', { clientX: 30 }))
    harness.frames.flush()
    if (reason === 'blur') window.dispatchEvent(new Event('blur'))
    else if (reason === 'lostpointercapture') harness.target.dispatchEvent(pointer(reason))
    else window.dispatchEvent(pointer(reason))
    expect(harness.port.cancelPointerSelection).toHaveBeenCalledOnce()
    expect(harness.frames.pending()).toBe(0)
  },
)

it('keeps capture failures contained and disposal idempotent', () => {
  const harness = setup()
  harness.setPointerCapture.mockImplementation(() => { throw new Error('capture unavailable') })
  harness.releasePointerCapture.mockImplementation(() => { throw new Error('capture lost') })
  harness.controller.pointerDown(pointer('pointerdown', { clientX: 10 }), harness.target)
  window.dispatchEvent(pointer('pointermove', { clientX: 30 }))
  harness.frames.flush()

  expect(() => {
    harness.controller.dispose()
    harness.controller.dispose()
  }).not.toThrow()
  expect(harness.port.cancelPointerSelection).toHaveBeenCalledOnce()
})

it('autoscrolls once per frame and remaps the latest point after scrolling', () => {
  const scroll = document.body.appendChild(document.createElement('div'))
  Object.defineProperties(scroll, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 500 },
    clientWidth: { configurable: true, value: 200 },
    scrollWidth: { configurable: true, value: 200 },
    getBoundingClientRect: {
      configurable: true,
      value: () => new DOMRect(0, 0, 200, 100),
    },
  })
  const harness = setup({
    scroll,
    position: ({ clientY }) => Math.round(clientY + scroll.scrollTop),
  })
  harness.controller.pointerDown(pointer('pointerdown', { clientX: 10, clientY: 20 }), harness.target)
  window.dispatchEvent(pointer('pointermove', { clientX: 40, clientY: 99 }))
  harness.frames.flush()

  expect(scroll.scrollTop).toBeGreaterThan(0)
  expect(harness.calls.at(-1)?.[1]).toBeGreaterThan(99)
  expect(harness.frames.pending()).toBe(1)
  harness.controller.cancel()
  expect(harness.frames.pending()).toBe(0)
})

it('rejects interactive descendants, translation rails, sidebars, and scrollbar tracks', () => {
  const surface = document.body.appendChild(document.createElement('div'))
  Object.defineProperties(surface, {
    clientWidth: { configurable: true, value: 188 },
    clientHeight: { configurable: true, value: 88 },
    scrollWidth: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 300 },
    getBoundingClientRect: {
      configurable: true,
      value: () => new DOMRect(0, 0, 200, 100),
    },
  })
  const button = surface.appendChild(document.createElement('button'))
  const rail = surface.appendChild(document.createElement('div'))
  rail.className = 'translation-history-rail-layer'
  const splitter = surface.appendChild(document.createElement('div'))
  splitter.className = 'editor-right-sidebar-splitter'

  expect(isEditorMarginSelectionExcluded(pointer('pointerdown'), button, surface)).toBe(true)
  expect(isEditorMarginSelectionExcluded(pointer('pointerdown'), rail, surface)).toBe(true)
  expect(isEditorMarginSelectionExcluded(pointer('pointerdown'), splitter, surface)).toBe(true)
  expect(isEditorMarginSelectionExcluded(
    pointer('pointerdown', { clientX: 194, clientY: 40 }), surface, surface,
  )).toBe(true)
  expect(isEditorMarginSelectionExcluded(
    pointer('pointerdown', { clientX: 80, clientY: 94 }), surface, surface,
  )).toBe(true)
  expect(isEditorMarginSelectionExcluded(
    pointer('pointerdown', { clientX: 80, clientY: 40 }), surface, surface,
  )).toBe(false)
})

it.each([
  ['web link', 'a', ''],
  ['form control', 'input', ''],
  ['menu', 'div', 'role=menu'],
  ['drop target', 'div', 'data-drop-target=true'],
  ['active drag surface', 'div', 'data-dragging=true'],
  ['table cell', 'td', ''],
  ['table resize handle', 'div', 'class=column-resize-handle'],
  ['image', 'img', ''],
  ['video', 'video', ''],
  ['local image surface', 'div', 'class=arkdown-local-image'],
  ['media toolbar', 'div', 'class=arkdown-image-alignment-toolbar'],
  ['link editor', 'div', 'class=arkdown-link-editor-popover'],
  ['code or formula toolbar', 'div', 'class=milkdown-code-block,tools'],
  ['language popup', 'div', 'class=milkdown-code-block,language-picker'],
  ['CodeMirror gutter', 'div', 'class=cm-gutter'],
  ['translation rail button', 'button', 'class=translation-history-rail-button'],
  ['left sidebar', 'div', 'class=sidebar'],
  ['right sidebar', 'div', 'class=editor-right-sidebar'],
] as const)('excludes %s from margin gestures', (_name, tagName, attributes) => {
  const surface = document.body.appendChild(document.createElement('div'))
  const wrapper = surface.appendChild(document.createElement('div'))
  const target = wrapper.appendChild(document.createElement(tagName))
  for (const assignment of attributes.split(' ').filter(Boolean)) {
    const [name, value] = assignment.split('=')
    if (name === 'class' && value?.startsWith('milkdown-code-block,')) {
      wrapper.className = 'milkdown-code-block'
      target.className = value.slice('milkdown-code-block,'.length)
    } else if (name === 'class') target.className = value?.replaceAll(',', ' ') ?? ''
    else target.setAttribute(name!, value ?? '')
  }
  expect(isEditorMarginSelectionExcluded(pointer('pointerdown'), target, null)).toBe(true)
})
