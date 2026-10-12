import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useSidebarResize } from '../../src/renderer/app/use-sidebar-resize'

function Harness({ initialWidth = 260 }: { initialWidth?: number }) {
  const resize = useSidebarResize({
    initialWidth,
    minWidth: 180,
    maxWidth: 600,
  })
  return <div
    data-user-resize-generation={resize.userResizeGeneration}
    data-testid="shell"
    style={{ '--sidebar-width': `${resize.width}px` } as React.CSSProperties}
  >
    <div data-testid="separator" {...resize.separatorProps} />
  </div>
}

it('resizes, clamps, resets, and supports keyboard adjustment', () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
  render(<Harness />)
  const shell = screen.getByTestId('shell')
  const separator = screen.getByRole('separator')

  fireEvent.pointerDown(separator, { clientX: 260, pointerId: 1 })
  fireEvent.pointerMove(window, { clientX: 410, pointerId: 1 })
  expect(shell).toHaveStyle({ '--sidebar-width': '410px' })

  fireEvent.pointerMove(window, { clientX: 900, pointerId: 1 })
  expect(shell).toHaveStyle({ '--sidebar-width': '540px' })

  fireEvent.pointerMove(window, { clientX: 0, pointerId: 1 })
  expect(shell).toHaveStyle({ '--sidebar-width': '180px' })

  fireEvent.doubleClick(separator)
  expect(shell).toHaveStyle({ '--sidebar-width': '260px' })

  fireEvent.keyDown(separator, { key: 'ArrowRight' })
  expect(shell).toHaveStyle({ '--sidebar-width': '270px' })
  fireEvent.keyDown(separator, { key: 'ArrowLeft' })
  expect(shell).toHaveStyle({ '--sidebar-width': '260px' })

  act(() => fireEvent.pointerUp(window, { pointerId: 1 }))
})

it('restores a persisted width and clamps it to the current viewport allowance', () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 })
  const view = render(<Harness initialWidth={300} />)
  const shell = screen.getByTestId('shell')
  expect(shell).toHaveStyle({ '--sidebar-width': '300px' })

  view.rerender(<Harness initialWidth={600} />)
  expect(shell).toHaveStyle({ '--sidebar-width': '450px' })
})

it('advances the user generation only for real resize input, not restored width synchronization', () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
  const view = render(<Harness initialWidth={300} />)
  const shell = screen.getByTestId('shell')
  const separator = screen.getByRole('separator')

  expect(shell).toHaveAttribute('data-user-resize-generation', '0')
  view.rerender(<Harness initialWidth={420} />)
  expect(shell).toHaveStyle({ '--sidebar-width': '420px' })
  expect(shell).toHaveAttribute('data-user-resize-generation', '0')

  fireEvent.keyDown(separator, { key: 'ArrowRight' })
  expect(shell).toHaveStyle({ '--sidebar-width': '430px' })
  expect(shell).toHaveAttribute('data-user-resize-generation', '1')
})

it('does not advance the user generation when pointer and double-click input keep the width unchanged', () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
  render(<Harness initialWidth={300} />)
  const shell = screen.getByTestId('shell')
  const separator = screen.getByRole('separator')

  fireEvent.pointerDown(separator, { clientX: 300, pointerId: 7 })
  fireEvent.pointerMove(window, { clientX: 300, pointerId: 7 })
  expect(shell).toHaveStyle({ '--sidebar-width': '300px' })
  expect(shell).toHaveAttribute('data-user-resize-generation', '0')

  fireEvent.doubleClick(separator)
  expect(shell).toHaveStyle({ '--sidebar-width': '300px' })
  expect(shell).toHaveAttribute('data-user-resize-generation', '0')

  fireEvent.pointerMove(window, { clientX: 310, pointerId: 7 })
  expect(shell).toHaveStyle({ '--sidebar-width': '310px' })
  expect(shell).toHaveAttribute('data-user-resize-generation', '1')

  fireEvent.doubleClick(separator)
  expect(shell).toHaveStyle({ '--sidebar-width': '300px' })
  expect(shell).toHaveAttribute('data-user-resize-generation', '2')
  act(() => fireEvent.pointerUp(window, { pointerId: 7 }))
})
