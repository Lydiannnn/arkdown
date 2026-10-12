import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  StickyNoteOverlayScrollbar,
  calculateStickyScrollbarGeometry,
} from '../../src/renderer/sticky-notes/StickyNoteOverlayScrollbar'

let resizeCallback: ResizeObserverCallback | null = null

class FakeResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback
  }
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}

function scroller(input: { clientHeight: number; scrollHeight: number; scrollTop?: number }) {
  const element = document.createElement('div')
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: input.clientHeight },
    scrollHeight: { configurable: true, value: input.scrollHeight },
    scrollTop: { configurable: true, writable: true, value: input.scrollTop ?? 0 },
  })
  return element
}

beforeEach(() => {
  resizeCallback = null
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('StickyNoteOverlayScrollbar', () => {
  it('hides when content does not overflow or the window is unfocused', () => {
    const element = scroller({ clientHeight: 200, scrollHeight: 200 })
    const { rerender } = render(<StickyNoteOverlayScrollbar focused scrollElement={element} />)
    expect(screen.queryByRole('scrollbar')).not.toBeInTheDocument()

    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 600 })
    rerender(<StickyNoteOverlayScrollbar focused={false} scrollElement={element} />)
    expect(screen.queryByRole('scrollbar')).not.toBeInTheDocument()
  })

  it('synchronizes the thumb with native scrolling and ResizeObserver geometry', async () => {
    const element = scroller({ clientHeight: 200, scrollHeight: 800, scrollTop: 300 })
    const { rerender } = render(<StickyNoteOverlayScrollbar focused scrollElement={element} />)
    const scrollbar = await screen.findByRole('scrollbar')
    const thumb = scrollbar.querySelector<HTMLElement>('.sticky-note-overlay-scrollbar-thumb')!
    expect(thumb.style.height).toBe('50px')
    expect(thumb.style.transform).toBe('translateY(75px)')

    element.scrollTop = 600
    fireEvent.scroll(element)
    await waitFor(() => expect(thumb.style.transform).toBe('translateY(150px)'))

    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 300 })
    act(() => resizeCallback?.([], {} as ResizeObserver))
    rerender(<StickyNoteOverlayScrollbar focused scrollElement={element} />)
    await waitFor(() => expect(thumb.style.height).toBe('112.5px'))
  })

  it('converts thumb dragging to native scrollTop without reserving editor width', async () => {
    const element = scroller({ clientHeight: 200, scrollHeight: 800 })
    render(<StickyNoteOverlayScrollbar focused scrollElement={element} />)
    const scrollbar = await screen.findByRole('scrollbar')
    const thumb = scrollbar.querySelector<HTMLElement>('.sticky-note-overlay-scrollbar-thumb')!

    fireEvent.pointerDown(thumb, { button: 0, clientY: 20, pointerId: 7 })
    fireEvent.pointerMove(thumb, { clientY: 70, pointerId: 7 })

    expect(element.scrollTop).toBe(200)
    expect(scrollbar).toHaveClass('sticky-note-overlay-scrollbar')
  })

  it('uses a minimum thumb height for very long notes', () => {
    expect(calculateStickyScrollbarGeometry({
      clientHeight: 200,
      scrollHeight: 10_000,
      scrollTop: 5_000,
    })).toEqual({ visible: true, thumbHeight: 24, thumbTop: 89.79591836734694 })
  })
})
