import { act, render } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { MenuHairline } from '../../src/renderer/context-menu/MenuHairline'
import {
  getMenuHairlineOffsetCssPx,
  getMenuHairlineThicknessCssPx,
  normalizeMenuHairlineDpr,
} from '../../src/renderer/context-menu/menu-hairline'

function expectedStrokeTransform(top: number, dpr: number): string {
  const thickness = getMenuHairlineThicknessCssPx(dpr)
  const edgeOffset = getMenuHairlineOffsetCssPx(top, dpr)
  return `translateY(${edgeOffset + (thickness - 1) / 2}px) scaleY(${thickness})`
}

function invokeListener<T extends Event>(listener: EventListenerOrEventListenerObject, event: T): void {
  if (typeof listener === 'function') listener(event)
  else listener.handleEvent(event)
}

describe('menu hairline geometry', () => {
  it.each([
    [1, 1],
    [1.25, 0.8],
    [1.5, 2 / 3],
    [2, 0.5],
  ] as const)('draws one physical pixel at DPR %s', (dpr, expectedCssPixels) => {
    expect(getMenuHairlineThicknessCssPx(dpr)).toBe(expectedCssPixels)
  })

  it.each([
    [10.2, 1],
    [10.2, 1.25],
    [10.2, 1.5],
    [10.2, 2],
    [23.75, 1.25],
    [31.125, 1.5],
    [-4.4, 2],
  ] as const)('snaps CSS top %s onto the DPR %s physical grid', (cssTop, dpr) => {
    const physicalTop = (cssTop + getMenuHairlineOffsetCssPx(cssTop, dpr)) * dpr

    expect(physicalTop).toBeCloseTo(Math.round(cssTop * dpr), 10)
    expect(physicalTop).toBeCloseTo(Math.round(physicalTop), 10)
  })

  it.each([Number.NaN, 0, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'falls back to DPR 1 for invalid value %s',
    (value) => {
      expect(normalizeMenuHairlineDpr(value)).toBe(1)
      expect(getMenuHairlineThicknessCssPx(value)).toBe(1)
      expect(getMenuHairlineOffsetCssPx(10.2, value)).toBeCloseTo(-0.2, 10)
    },
  )
})

describe('MenuHairline measurement lifecycle', () => {
  it('remeasures every signal independently, rebinds resolution, and releases all observers', () => {
    const dprDescriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
    const visualViewportDescriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport')
    const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(window, 'ResizeObserver')
    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    const originalBounds = HTMLElement.prototype.getBoundingClientRect
    const addWindowListener = vi.spyOn(window, 'addEventListener')
    const removeWindowListener = vi.spyOn(window, 'removeEventListener')
    const activeWindowResizeListeners = new Set<EventListenerOrEventListenerObject>()
    const visualViewport = new EventTarget()
    const addVisualViewportListener = vi.spyOn(visualViewport, 'addEventListener')
    const removeVisualViewportListener = vi.spyOn(visualViewport, 'removeEventListener')
    const activeVisualViewportResizeListeners = new Set<EventListenerOrEventListenerObject>()
    const resolutionQueries: Array<{
      media: string
      listeners: Set<EventListenerOrEventListenerObject>
    }> = []
    const observedTargets: Element[] = []
    const disconnect = vi.fn()
    let resizeObserverCallback: ResizeObserverCallback | null = null
    let currentDpr = 1.25
    let currentTop = 10.2

    class HairlineResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeObserverCallback = callback
      }
      observe(target: Element) {
        observedTargets.push(target)
      }
      unobserve() {}
      disconnect() {
        disconnect()
      }
    }

    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      get: () => currentDpr,
    })
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    })
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: HairlineResizeObserver,
    })
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((media: string) => {
        const record = {
          media,
          listeners: new Set<EventListenerOrEventListenerObject>(),
        }
        resolutionQueries.push(record)
        return {
          matches: true,
          media,
          onchange: null,
          addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
            if (type === 'change') record.listeners.add(listener)
          },
          removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
            if (type === 'change') record.listeners.delete(listener)
          },
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(() => true),
        } as unknown as MediaQueryList
      }),
    })
    HTMLElement.prototype.getBoundingClientRect = function getBounds() {
      if (this.classList.contains('menu-hairline')) {
        return {
          x: 0, y: currentTop, left: 0, top: currentTop, right: 120, bottom: currentTop + 1,
          width: 120, height: 1, toJSON: () => ({}),
        } as DOMRect
      }
      return originalBounds.call(this)
    }

    try {
      const view = render(createElement(
        'div',
        { role: 'menu' },
        createElement(MenuHairline, { className: 'test-menu-separator' }),
      ))
      const menu = view.getByRole('menu')
      const wrapper = view.getByRole('separator')
      const stroke = wrapper.querySelector<HTMLElement>('.menu-hairline-stroke')!
      const assertGeometry = () => {
        expect(stroke.style.height).toBe('1px')
        expect(stroke.style.transform).toBe(expectedStrokeTransform(currentTop, currentDpr))
      }

      assertGeometry()
      const windowResizeListener = addWindowListener.mock.calls
        .find(([type]) => type === 'resize')?.[1]
      const visualViewportResizeListener = addVisualViewportListener.mock.calls
        .find(([type]) => type === 'resize')?.[1]
      expect(windowResizeListener).toBeDefined()
      expect(visualViewportResizeListener).toBeDefined()
      activeWindowResizeListeners.add(windowResizeListener!)
      activeVisualViewportResizeListeners.add(visualViewportResizeListener!)
      expect(resolutionQueries).toHaveLength(1)
      expect(resolutionQueries[0]?.media).toBe('(resolution: 1.25dppx)')
      expect(resolutionQueries[0]?.listeners.size).toBe(1)
      expect(observedTargets).toEqual([wrapper, menu])

      currentDpr = 1.5
      currentTop = 11.125
      act(() => window.dispatchEvent(new Event('resize')))
      assertGeometry()

      currentDpr = 2
      currentTop = 12.3
      act(() => visualViewport.dispatchEvent(new Event('resize')))
      assertGeometry()

      const oldResolutionListener = [...resolutionQueries[0]!.listeners][0]!
      currentDpr = 1
      currentTop = 13.4
      act(() => invokeListener(oldResolutionListener, new Event('change')))
      assertGeometry()
      expect(resolutionQueries[0]?.listeners.size).toBe(0)
      expect(resolutionQueries).toHaveLength(2)
      expect(resolutionQueries[1]?.media).toBe('(resolution: 1dppx)')
      expect(resolutionQueries[1]?.listeners.size).toBe(1)

      currentDpr = 1.5
      currentTop = 14.4
      act(() => resizeObserverCallback?.([], {} as ResizeObserver))
      assertGeometry()

      const currentResolutionListener = [...resolutionQueries[1]!.listeners][0]!
      const cachedResizeObserverCallback = resizeObserverCallback!
      view.unmount()

      expect(removeWindowListener).toHaveBeenCalledWith('resize', windowResizeListener)
      expect(removeVisualViewportListener).toHaveBeenCalledWith('resize', visualViewportResizeListener)
      for (const [type, listener] of removeWindowListener.mock.calls) {
        if (type === 'resize') activeWindowResizeListeners.delete(listener)
      }
      for (const [type, listener] of removeVisualViewportListener.mock.calls) {
        if (type === 'resize' && listener) activeVisualViewportResizeListeners.delete(listener)
      }
      expect(activeWindowResizeListeners).toEqual(new Set())
      expect(activeVisualViewportResizeListeners).toEqual(new Set())
      expect(resolutionQueries.every(({ listeners }) => listeners.size === 0)).toBe(true)
      expect(disconnect).toHaveBeenCalledTimes(1)

      const queryCountAfterUnmount = resolutionQueries.length
      expect(() => {
        invokeListener(windowResizeListener!, new Event('resize'))
        invokeListener(visualViewportResizeListener!, new Event('resize'))
        invokeListener(oldResolutionListener, new Event('change'))
        invokeListener(currentResolutionListener, new Event('change'))
        cachedResizeObserverCallback([], {} as ResizeObserver)
      }).not.toThrow()
      expect(resolutionQueries).toHaveLength(queryCountAfterUnmount)
      expect(resolutionQueries.every(({ listeners }) => listeners.size === 0)).toBe(true)
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalBounds
      addWindowListener.mockRestore()
      removeWindowListener.mockRestore()
      addVisualViewportListener.mockRestore()
      removeVisualViewportListener.mockRestore()
      if (dprDescriptor) Object.defineProperty(window, 'devicePixelRatio', dprDescriptor)
      if (visualViewportDescriptor) Object.defineProperty(window, 'visualViewport', visualViewportDescriptor)
      else Reflect.deleteProperty(window, 'visualViewport')
      if (resizeObserverDescriptor) Object.defineProperty(window, 'ResizeObserver', resizeObserverDescriptor)
      else Reflect.deleteProperty(window, 'ResizeObserver')
      if (matchMediaDescriptor) Object.defineProperty(window, 'matchMedia', matchMediaDescriptor)
      else Reflect.deleteProperty(window, 'matchMedia')
    }
  })

  it('uses the separator owner document DPR instead of the global window DPR', () => {
    const globalDprDescriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
    const iframe = document.createElement('iframe')
    document.body.append(iframe)
    const ownerWindow = iframe.contentWindow!
    const ownerDocument = iframe.contentDocument!
    const ownerDprDescriptor = Object.getOwnPropertyDescriptor(ownerWindow, 'devicePixelRatio')
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
    Object.defineProperty(ownerWindow, 'devicePixelRatio', { configurable: true, value: 1.25 })

    try {
      const container = ownerDocument.createElement('div')
      ownerDocument.body.append(container)
      const view = render(
        createElement(MenuHairline, { className: 'owner-document-separator' }),
        { container },
      )
      const stroke = container.querySelector<HTMLElement>('.menu-hairline-stroke')!

      expect(stroke.ownerDocument).toBe(ownerDocument)
      expect(stroke.style.transform).toBe(expectedStrokeTransform(0, 1.25))
      expect(stroke.style.transform).not.toContain('scaleY(0.5)')
      view.unmount()
    } finally {
      if (ownerDprDescriptor) Object.defineProperty(ownerWindow, 'devicePixelRatio', ownerDprDescriptor)
      if (globalDprDescriptor) Object.defineProperty(window, 'devicePixelRatio', globalDprDescriptor)
      iframe.remove()
    }
  })

  it.each([
    ['throws while measuring', () => { throw new Error('measurement failed') }],
    ['returns a non-finite top', () => ({
      x: 0, y: Number.POSITIVE_INFINITY, left: 0, top: Number.POSITIVE_INFINITY,
      right: 0, bottom: Number.POSITIVE_INFINITY, width: 0, height: 1,
      toJSON: () => ({}),
    } as DOMRect)],
  ] as const)('falls back without crashing when getBoundingClientRect %s', (_label, measure) => {
    const originalBounds = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function getBounds() {
      return this.classList.contains('menu-hairline') ? measure() : originalBounds.call(this)
    }
    try {
      const view = render(createElement(MenuHairline, { className: 'fallback-separator' }))
      const stroke = view.getByRole('separator').querySelector<HTMLElement>('.menu-hairline-stroke')!
      expect(stroke.style.height).toBe('1px')
      expect(stroke.style.top).toBe('0px')
      expect(stroke.style.transform).toBe('translateY(0px) scaleY(1)')
      view.unmount()
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalBounds
    }
  })
})
