import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PreferencesShell,
  scrollPreferenceTarget,
} from '../../src/renderer/settings/PreferencesShell'

class TestResizeObserver {
  static instances: TestResizeObserver[] = []

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this)
  }

  disconnect() {}

  observe() {}

  unobserve() {}

  emit() {
    this.callback([], this as unknown as ResizeObserver)
  }
}

beforeEach(() => {
  TestResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    addEventListener: vi.fn(),
    matches: false,
    removeEventListener: vi.fn(),
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function rectangle(top: number): DOMRect {
  return {
    bottom: top + 24,
    height: 24,
    left: 0,
    right: 320,
    top,
    width: 320,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }
}

function renderPreferenceShell() {
  render(
    <PreferencesShell
      ariaLabel="偏好设置"
      footer={null}
      toc={<>
        <a href="#section-one">第一节</a>
        <a href="#section-two">第二节</a>
        <a href="#section-three">第三节</a>
      </>}
      tocLabel="偏好设置目录"
    >
      <section><h2 id="section-one">第一节</h2></section>
      <section><h2 id="section-two">第二节</h2></section>
      <section><h2 id="section-three">第三节</h2></section>
    </PreferencesShell>,
  )

  const viewport = screen.getByRole('region', { name: '设置内容' })
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 1800 },
    scrollTop: { configurable: true, value: 0, writable: true },
  })
  viewport.getBoundingClientRect = () => rectangle(0)
  const headings = [
    screen.getByRole('heading', { name: '第一节' }),
    screen.getByRole('heading', { name: '第二节' }),
    screen.getByRole('heading', { name: '第三节' }),
  ]
  const links = within(screen.getByRole('navigation', { name: '偏好设置目录' }))
    .getAllByRole('link')
  return { headings, links, viewport }
}

describe('scrollPreferenceTarget', () => {
  it('places the selected heading one fifth below the preference viewport top', () => {
    const scrollTo = vi.fn()
    const viewport = {
      clientHeight: 500,
      getBoundingClientRect: () => ({ top: 80 }),
      scrollHeight: 1800,
      scrollTop: 300,
      scrollTo,
    } as unknown as HTMLElement
    const target = {
      getBoundingClientRect: () => ({ top: 680 }),
    } as unknown as HTMLElement

    scrollPreferenceTarget(viewport, target)

    expect(scrollTo).toHaveBeenCalledWith({ behavior: 'smooth', top: 800 })
  })

  it('clamps the target position to the legal scroll range', () => {
    const scrollTo = vi.fn()
    const viewport = {
      clientHeight: 500,
      getBoundingClientRect: () => ({ top: 0 }),
      scrollHeight: 900,
      scrollTop: 360,
      scrollTo,
    } as unknown as HTMLElement
    const target = {
      getBoundingClientRect: () => ({ top: 760 }),
    } as unknown as HTMLElement

    scrollPreferenceTarget(viewport, target)

    expect(scrollTo).toHaveBeenCalledWith({ behavior: 'smooth', top: 400 })
  })
})

describe('PreferencesShell scroll-linked directory', () => {
  it('omits the footer region when no actions are provided', () => {
    renderPreferenceShell()
    expect(screen.queryByLabelText('设置操作')).not.toBeInTheDocument()
  })

  it('retains the footer region for standalone consumers that provide actions', () => {
    render(<PreferencesShell ariaLabel="Arknote 设置" tocLabel="目录" toc={null}
      footer={<button type="button">关闭</button>}>
      <h1>Arknote 设置</h1>
    </PreferencesShell>)
    expect(within(screen.getByLabelText('设置操作')).getByRole('button', { name: '关闭' })).toBeVisible()
  })

  it('exposes the desktop TOC offset without offsetting the settings content', () => {
    renderPreferenceShell()
    const toc = screen.getByRole('navigation', { name: '偏好设置目录' })
    toc.getBoundingClientRect = () => ({
      ...rectangle(0),
      left: 100,
      right: 250,
      width: 150,
      x: 100,
    })

    act(() => TestResizeObserver.instances.forEach((observer) => observer.emit()))

    const layout = toc.closest<HTMLElement>('.preferences-page-layout')
    const settings = layout?.querySelector<HTMLElement>('.preferences-settings')
    expect(layout?.style.getPropertyValue('--preferences-toc-offset')).toBe('30px')
    expect(settings?.style.transform).toBe('')
    expect(settings?.style.translate).toBe('')
    expect(settings?.style.left).toBe('')
  })

  it('remeasures from the unshifted TOC edge after applying a constrained offset', () => {
    renderPreferenceShell()
    const toc = screen.getByRole('navigation', { name: '偏好设置目录' })
    const layout = toc.closest<HTMLElement>('.preferences-page-layout')!
    toc.getBoundingClientRect = () => {
      const appliedOffset = Number.parseFloat(
        layout.style.getPropertyValue('--preferences-toc-offset'),
      ) || 0
      return {
        ...rectangle(0),
        left: 46 - appliedOffset,
        right: 196 - appliedOffset,
        width: 150,
        x: 46 - appliedOffset,
      }
    }

    act(() => TestResizeObserver.instances.forEach((observer) => observer.emit()))
    expect(layout.style.getPropertyValue('--preferences-toc-offset')).toBe('30px')

    act(() => TestResizeObserver.instances.forEach((observer) => observer.emit()))
    expect(layout.style.getPropertyValue('--preferences-toc-offset')).toBe('30px')
  })

  it('keeps the last heading above the one-fifth reference line selected', async () => {
    const { headings, links, viewport } = renderPreferenceShell()
    const headingTops = [20, 240, 640]
    headings.forEach((heading, index) => {
      heading.getBoundingClientRect = () => rectangle(headingTops[index])
    })

    fireEvent.scroll(viewport)
    await waitFor(() => expect(links[0]).toHaveAttribute('aria-current', 'location'))

    headingTops.splice(0, 3, -260, 80, 420)
    viewport.scrollTop = 300
    fireEvent.scroll(viewport)
    await waitFor(() => expect(links[1]).toHaveAttribute('aria-current', 'location'))
    expect(links[0]).not.toHaveAttribute('aria-current')
    expect(links[2]).not.toHaveAttribute('aria-current')
  })

  it('selects the final directory item at the bottom scroll boundary', async () => {
    const { headings, links, viewport } = renderPreferenceShell()
    const headingTops = [-900, -300, 360]
    headings.forEach((heading, index) => {
      heading.getBoundingClientRect = () => rectangle(headingTops[index])
    })
    viewport.scrollTop = 1300

    fireEvent.scroll(viewport)
    await waitFor(() => expect(links[2]).toHaveAttribute('aria-current', 'location'))
  })

  it('keeps the first item selected when the preference page does not scroll', async () => {
    const { headings, links, viewport } = renderPreferenceShell()
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 400 })
    const headingTops = [20, 180, 340]
    headings.forEach((heading, index) => {
      heading.getBoundingClientRect = () => rectangle(headingTops[index])
    })

    fireEvent.scroll(viewport)
    await waitFor(() => expect(links[0]).toHaveAttribute('aria-current', 'location'))
    expect(links[2]).not.toHaveAttribute('aria-current')
  })

  it('selects a clicked item immediately and locks it during smooth scrolling', async () => {
    const { headings, links, viewport } = renderPreferenceShell()
    const headingTops = [20, 240, 640]
    headings.forEach((heading, index) => {
      heading.getBoundingClientRect = () => rectangle(headingTops[index])
    })
    viewport.scrollTo = vi.fn()

    fireEvent.scroll(viewport)
    await waitFor(() => expect(links[0]).toHaveAttribute('aria-current', 'location'))

    fireEvent.click(links[2])
    expect(links[2]).toHaveAttribute('aria-current', 'location')
    expect(viewport.scrollTo).toHaveBeenCalledWith({ behavior: 'smooth', top: 540 })

    headingTops.splice(0, 3, -260, 80, 420)
    act(() => fireEvent.scroll(viewport))
    expect(links[2]).toHaveAttribute('aria-current', 'location')
    expect(links[1]).not.toHaveAttribute('aria-current')
  })
})
