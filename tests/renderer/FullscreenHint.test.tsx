import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FullscreenHint } from '../../src/renderer/chrome/FullscreenHint'

describe('FullscreenHint', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })))
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('is accessible and pointer inert for three visible seconds and one fading second', () => {
    render(<FullscreenHint activationKey={1} visible />)

    const hint = screen.getByRole('status')
    expect(hint).toHaveTextContent('按下 Esc 以退出全屏')
    expect(hint).toHaveAttribute('aria-live', 'polite')
    expect(hint).toHaveAttribute('aria-atomic', 'true')
    expect(hint).toHaveStyle({ pointerEvents: 'none' })
    expect(hint).not.toHaveClass('is-fading')

    act(() => vi.advanceTimersByTime(2_999))
    expect(screen.getByRole('status')).not.toHaveClass('is-fading')
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole('status')).toHaveClass('is-fading')
    act(() => vi.advanceTimersByTime(999))
    expect(screen.getByRole('status')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('clears immediately on leave and does not update after unmount', () => {
    const view = render(<FullscreenHint activationKey={1} visible />)
    expect(vi.getTimerCount()).toBe(2)

    view.rerender(<FullscreenHint activationKey={1} visible={false} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(0)

    view.rerender(<FullscreenHint activationKey={2} visible />)
    expect(vi.getTimerCount()).toBe(2)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
    expect(() => act(() => vi.runAllTimers())).not.toThrow()
  })

  it('restarts deterministically for a repeated enter without duplicate hints', () => {
    const view = render(<FullscreenHint activationKey={1} visible />)
    act(() => vi.advanceTimersByTime(3_500))
    expect(screen.getByRole('status')).toHaveClass('is-fading')

    view.rerender(<FullscreenHint activationKey={2} visible />)
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('status')).not.toHaveClass('is-fading')
    act(() => vi.advanceTimersByTime(2_999))
    expect(screen.getByRole('status')).not.toHaveClass('is-fading')
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole('status')).toHaveClass('is-fading')
    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('removes the visual transition for reduced motion but preserves the lifecycle', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })))
    render(<FullscreenHint activationKey={1} visible />)

    expect(screen.getByRole('status')).toHaveStyle({ transition: 'none' })
    act(() => vi.advanceTimersByTime(3_000))
    expect(screen.getByRole('status')).toHaveClass('is-fading')
    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
