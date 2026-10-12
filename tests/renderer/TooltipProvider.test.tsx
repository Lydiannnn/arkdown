import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissTooltip, TooltipProvider } from '../../src/renderer/tooltip/TooltipProvider'

const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
  x: left,
  y: top,
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
  toJSON: () => ({}),
}) as DOMRect

describe('TooltipProvider', () => {
  let frames: Map<number, FrameRequestCallback>
  let nextFrame: number

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('innerWidth', 1_000)
    vi.stubGlobal('innerHeight', 800)
    frames = new Map()
    nextFrame = 1
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrame++
      frames.set(id, callback)
      return id
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const flushFrames = () => {
    const pending = [...frames.entries()]
    frames.clear()
    act(() => pending.forEach(([, callback]) => callback(0)))
  }

  const useGeometry = (target: DOMRect, tooltip: DOMRect) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function getBounds(this: HTMLElement) {
        return this.classList.contains('global-tooltip') ? tooltip : target
      })
  }

  it.each([
    ['uses the preferred bottom-right offset', 100, 80, 60, 20, 112, 96],
    ['flips left and upward before clamping at the viewport edge', 995, 795, 80, 30, 903, 749],
    ['clamps only as the final guard', -100, -80, 60, 20, 8, 8],
  ] as const)('%s', (_label, clientX, clientY, width, height, left, top) => {
    useGeometry(rect(300, 200, 40, 24), rect(0, 0, width, height))
    render(
      <TooltipProvider>
        <button data-tooltip="Pointer tip">Pointer target</button>
      </TooltipProvider>,
    )

    fireEvent.pointerOver(screen.getByRole('button'), { clientX, clientY })
    act(() => vi.advanceTimersByTime(400))

    expect(screen.getByRole('tooltip')).toHaveStyle({ left: `${left}px`, top: `${top}px` })
  })

  it('follows the latest pointer position while the tooltip is visible', () => {
    useGeometry(rect(300, 200, 40, 24), rect(0, 0, 60, 20))
    render(
      <TooltipProvider>
        <button data-tooltip="Pointer tip">Pointer target</button>
      </TooltipProvider>,
    )
    const target = screen.getByRole('button')
    fireEvent.pointerOver(target, { clientX: 100, clientY: 80 })
    act(() => vi.advanceTimersByTime(400))
    expect(screen.getByRole('tooltip')).toHaveStyle({ left: '112px', top: '96px' })

    fireEvent.pointerMove(target, { clientX: 240, clientY: 180 })
    flushFrames()

    expect(screen.getByRole('tooltip')).toHaveStyle({ left: '252px', top: '196px' })
  })

  it('coalesces pointer moves to one animation frame and uses the latest point', () => {
    useGeometry(rect(300, 200, 40, 24), rect(0, 0, 60, 20))
    render(
      <TooltipProvider>
        <button data-tooltip="Pointer tip">Pointer target</button>
      </TooltipProvider>,
    )
    const target = screen.getByRole('button')
    fireEvent.pointerOver(target, { clientX: 100, clientY: 80 })
    act(() => vi.advanceTimersByTime(400))

    fireEvent.pointerMove(target, { clientX: 120, clientY: 90 })
    fireEvent.pointerMove(target, { clientX: 200, clientY: 140 })
    fireEvent.pointerMove(target, { clientX: 260, clientY: 190 })

    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('tooltip')).toHaveStyle({ left: '112px', top: '96px' })
    flushFrames()
    expect(screen.getByRole('tooltip')).toHaveStyle({ left: '272px', top: '206px' })
  })

  it('keeps keyboard focus anchored to the trigger rectangle after pointer input', () => {
    useGeometry(rect(200, 100, 40, 20), rect(0, 0, 60, 20))
    render(
      <TooltipProvider>
        <button data-tooltip="Keyboard tip">Keyboard target</button>
      </TooltipProvider>,
    )
    const target = screen.getByRole('button')
    fireEvent.pointerOver(target, { clientX: 700, clientY: 500 })
    fireEvent.keyDown(document, { key: 'Tab' })
    fireEvent.focusIn(target)
    act(() => vi.advanceTimersByTime(400))

    expect(screen.getByRole('tooltip')).toHaveStyle({ left: '190px', top: '127px' })
    expect(window.requestAnimationFrame).not.toHaveBeenCalled()
  })

  it('does not reopen on pointer-induced focus while a button is held', () => {
    render(<TooltipProvider><button data-tooltip="Tip">Target</button></TooltipProvider>)
    const target = screen.getByRole('button')
    fireEvent.pointerOver(target)
    act(() => vi.advanceTimersByTime(400))
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.pointerDown(target, { buttons: 1 })
    fireEvent.focusIn(target)

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(800))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('suppresses pointer transitions and movement while pressed, including another trigger', () => {
    render(<TooltipProvider>
      <button data-tooltip="First tip">First</button>
      <button data-tooltip="Second tip">Second</button>
    </TooltipProvider>)
    const first = screen.getByRole('button', { name: 'First' })
    const second = screen.getByRole('button', { name: 'Second' })
    fireEvent.pointerOver(first)
    fireEvent.pointerDown(first, { buttons: 1 })
    fireEvent.pointerOut(first, { relatedTarget: second, buttons: 1 })
    fireEvent.pointerOver(second, { relatedTarget: first, buttons: 1 })
    fireEvent.pointerMove(second, { buttons: 1 })
    act(() => vi.advanceTimersByTime(800))

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it.each(['click', 'Escape', 'dismiss event'] as const)(
    'keeps %s dismissal until the pointer leaves and re-enters the trigger', (action) => {
      render(<TooltipProvider>
        <button data-tooltip="Tip"><span>Target</span><span>Icon</span></button>
      </TooltipProvider>)
      const target = screen.getByRole('button')
      fireEvent.pointerOver(target)
      act(() => vi.advanceTimersByTime(400))
      expect(screen.getByRole('tooltip')).toBeInTheDocument()
      if (action === 'click') {
        fireEvent.pointerDown(target, { buttons: 1 })
        fireEvent.pointerUp(target)
        fireEvent.click(target)
      } else if (action === 'Escape') fireEvent.keyDown(document, { key: 'Escape' })
      else act(() => dismissTooltip())

      fireEvent.focusIn(target)
      fireEvent.pointerOut(screen.getByText('Target'), { relatedTarget: screen.getByText('Icon') })
      fireEvent.pointerOver(screen.getByText('Icon'), { relatedTarget: screen.getByText('Target') })
      fireEvent.pointerMove(target)
      act(() => vi.advanceTimersByTime(800))
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

      fireEvent.pointerOut(target, { relatedTarget: document.body })
      fireEvent.pointerOver(target, { relatedTarget: document.body })
      act(() => vi.advanceTimersByTime(399))
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
      act(() => vi.advanceTimersByTime(1))
      expect(screen.getByRole('tooltip')).toHaveTextContent('Tip')
    },
  )

  it('restores keyboard tips with Tab after a pointer click', () => {
    render(<TooltipProvider>
      <button
        data-tooltip="Tip"
        onKeyDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >Target</button>
    </TooltipProvider>)
    const target = screen.getByRole('button')
    fireEvent.pointerDown(target, { buttons: 1 })
    fireEvent.pointerUp(target)
    fireEvent.click(target)
    fireEvent.focusIn(target)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.keyDown(target, { key: 'Tab' })
    fireEvent.focusIn(target)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Tip')
  })

  it('suppresses the hovered tooltip on Escape when another trigger retains focus', () => {
    render(<TooltipProvider>
      <button data-tooltip="Hover tip"><span>Hover target</span><span>Icon</span></button>
      <button data-tooltip="Focus tip">Focus target</button>
    </TooltipProvider>)
    const focused = screen.getByRole('button', { name: 'Focus target' })
    const hovered = screen.getByRole('button', { name: 'Hover targetIcon' })
    act(() => focused.focus())
    fireEvent.pointerOver(screen.getByText('Hover target'))
    act(() => vi.advanceTimersByTime(400))
    expect(focused).toHaveFocus()
    expect(screen.getByRole('tooltip')).toHaveTextContent('Hover tip')

    fireEvent.keyDown(focused, { key: 'Escape' })
    fireEvent.pointerOut(screen.getByText('Hover target'), { relatedTarget: screen.getByText('Icon') })
    fireEvent.pointerOver(screen.getByText('Icon'), { relatedTarget: screen.getByText('Hover target') })
    act(() => vi.advanceTimersByTime(800))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.pointerOut(hovered, { relatedTarget: document.body })
    fireEvent.pointerOver(hovered, { relatedTarget: document.body })
    act(() => vi.advanceTimersByTime(400))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Hover tip')
  })

  it.each([
    [200, 100, 40, 20],
    [8, 8, 40, 20],
    [950, 760, 40, 32],
  ])('keeps a keyboard tooltip outside its trigger at (%s, %s)', (x, y, width, height) => {
    useGeometry(rect(x, y, width, height), rect(0, 0, 100, 40))
    render(<TooltipProvider><button data-tooltip="Tip">Target</button></TooltipProvider>)
    fireEvent.keyDown(document, { key: 'Tab' })
    fireEvent.focusIn(screen.getByRole('button'))
    const tooltip = screen.getByRole('tooltip')
    const left = Number.parseFloat(tooltip.style.left)
    const top = Number.parseFloat(tooltip.style.top)

    expect(left >= x + width || left + 100 <= x || top >= y + height || top + 40 <= y).toBe(true)
    expect(left).toBeGreaterThanOrEqual(8)
    expect(left + 100).toBeLessThanOrEqual(992)
    expect(top).toBeGreaterThanOrEqual(8)
    expect(top + 40).toBeLessThanOrEqual(792)
  })

  it('removes a stale dynamic label and shows its replacement on a new hover', async () => {
    const view = render(<TooltipProvider><button data-tooltip="Before">Target</button></TooltipProvider>)
    fireEvent.pointerOver(screen.getByRole('button'))
    act(() => vi.advanceTimersByTime(400))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Before')
    view.rerender(<TooltipProvider><button data-tooltip="After">Target</button></TooltipProvider>)
    await act(async () => undefined)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.pointerOut(screen.getByRole('button'), { relatedTarget: document.body })
    fireEvent.pointerOver(screen.getByRole('button'))
    act(() => vi.advanceTimersByTime(400))
    expect(screen.getByRole('tooltip')).toHaveTextContent('After')
  })

  it.each([
    ['base', undefined],
    ['modal', 'modal'],
    ['context-menu', 'context-menu'],
  ] as const)('keeps the %s tooltip in its owning portal layer', (layer, attribute) => {
    useGeometry(rect(200, 100, 40, 20), rect(0, 0, 60, 20))
    render(
      <TooltipProvider>
        <div data-tooltip-layer={attribute}>
          <button data-tooltip={`${layer} tip`}>{layer} target</button>
        </div>
      </TooltipProvider>,
    )

    fireEvent.focusIn(screen.getByRole('button'))

    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveAttribute('data-tooltip-layer', layer)
  })

  it('cancels a pending pointer update when scrolling dismisses the tooltip', () => {
    useGeometry(rect(300, 200, 40, 24), rect(0, 0, 60, 20))
    render(
      <TooltipProvider>
        <button data-tooltip="Pointer tip">Pointer target</button>
      </TooltipProvider>,
    )
    const target = screen.getByRole('button')
    fireEvent.pointerOver(target, { clientX: 100, clientY: 80 })
    act(() => vi.advanceTimersByTime(400))
    fireEvent.pointerMove(target, { clientX: 240, clientY: 180 })
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1)

    fireEvent.scroll(window)

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(window.cancelAnimationFrame).toHaveBeenCalledTimes(1)
    flushFrames()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('shows one themed tooltip after 400ms and hides it on Escape', () => {
    render(
      <TooltipProvider>
        <button data-tooltip="在文档中搜索">搜索</button>
      </TooltipProvider>,
    )
    fireEvent.pointerOver(screen.getByRole('button', { name: '搜索' }))
    act(() => vi.advanceTimersByTime(399))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole('tooltip')).toHaveTextContent('在文档中搜索')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('moves between nearby controls without another full delay', () => {
    render(
      <TooltipProvider>
        <button data-tooltip="搜索">搜索</button>
        <button data-tooltip="重载">重载</button>
      </TooltipProvider>,
    )
    const search = screen.getByRole('button', { name: '搜索' })
    const reload = screen.getByRole('button', { name: '重载' })
    fireEvent.pointerOver(search)
    act(() => vi.advanceTimersByTime(400))
    expect(screen.getByRole('tooltip')).toHaveTextContent('搜索')
    fireEvent.pointerOver(reload, { relatedTarget: search })
    expect(screen.getByRole('tooltip')).toHaveTextContent('重载')
  })

  it('carries the owning modal layer through the tooltip portal', () => {
    render(
      <TooltipProvider>
        <div data-tooltip-layer="modal">
          <button data-tooltip="模态框操作">模态框按钮</button>
        </div>
      </TooltipProvider>,
    )

    fireEvent.focusIn(screen.getByRole('button', { name: '模态框按钮' }))

    expect(screen.getByRole('tooltip')).toHaveAttribute('data-tooltip-layer', 'modal')
  })

  it('removes a tooltip when its active target leaves the DOM', async () => {
    const view = render(
      <TooltipProvider>
        <button data-tooltip="临时操作">临时操作</button>
      </TooltipProvider>,
    )
    fireEvent.pointerOver(screen.getByRole('button', { name: '临时操作' }))
    act(() => vi.advanceTimersByTime(400))
    expect(screen.getByRole('tooltip')).toHaveTextContent('临时操作')

    view.rerender(<TooltipProvider><span>目标已移除</span></TooltipProvider>)
    await act(async () => undefined)

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})
