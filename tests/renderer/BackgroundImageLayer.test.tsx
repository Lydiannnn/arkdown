import { act, fireEvent, render, screen } from '@testing-library/react'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackgroundImageLayer } from '../../src/renderer/backgrounds/BackgroundImageLayer'
import { BACKGROUND_MASK_TYPES, DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

type ResizeCallback = ResizeObserverCallback

const resizeObservers = vi.hoisted(() => [] as Array<{
  callback: ResizeCallback
  observe: ReturnType<typeof vi.fn<(target: Element) => void>>
  disconnect: ReturnType<typeof vi.fn<() => void>>
}>)

function rect(width: number, height: number): DOMRect {
  return {
    x: 0, y: 0, top: 0, right: width, bottom: height, left: 0, width, height,
    toJSON: () => ({}),
  }
}

function setNaturalSize(image: HTMLImageElement, width: number, height: number) {
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: width },
    naturalHeight: { configurable: true, value: height },
  })
}

beforeEach(() => {
  resizeObservers.length = 0
  vi.stubGlobal('ResizeObserver', class {
    record: (typeof resizeObservers)[number]
    constructor(callback: ResizeCallback) {
      this.record = {
        callback,
        observe: vi.fn<(target: Element) => void>(),
        disconnect: vi.fn<() => void>(),
      }
      resizeObservers.push(this.record)
    }
    observe(target: Element) { this.record.observe(target) }
    disconnect() { this.record.disconnect() }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BackgroundImageLayer', () => {
  it('keeps the background out of the accessibility tree and normal input flow', () => {
    render(<BackgroundImageLayer
      anchor="right-bottom"
      imageUrl="arkdown-background://aurora.webp"
      settings={{ ...DEFAULT_BACKGROUND_SETTINGS, maskType: 'diagonal-top-left' }}
    />)

    const layer = screen.getByTestId('background-image-layer')
    const image = screen.getByTestId('background-image-layer-image')
    expect(layer).toHaveAttribute('aria-hidden', 'true')
    expect(layer).toHaveAttribute('data-mask-type', 'diagonal-top-left')
    expect(layer).toHaveStyle({ pointerEvents: 'none', userSelect: 'none' })
    expect(image).toHaveAttribute('alt', '')
    expect(image).toHaveAttribute('draggable', 'false')
  })

  it('does not add a layer when there is no image to render', () => {
    render(<BackgroundImageLayer
      anchor="left-top"
      imageUrl={null}
      settings={DEFAULT_BACKGROUND_SETTINGS}
    />)

    expect(screen.queryByTestId('background-image-layer')).toBeNull()
  })

  it('does not pass mask parameters to the image when the mask is none', () => {
    render(<BackgroundImageLayer
      anchor="left-top"
      imageUrl="arkdown-background://unmasked.png"
      settings={{
        ...DEFAULT_BACKGROUND_SETTINGS,
        imageOpacityPercent: 37,
        maskType: 'none',
        maskOpacityPercent: 92,
        maskTransitionPercent: 4,
      }}
    />)

    const image = screen.getByTestId('background-image-layer-image')
    expect(image).toHaveStyle({ opacity: '0.37' })
    expect(image.style.getPropertyValue('--background-mask-opacity')).toBe('')
    expect(image.style.getPropertyValue('--background-mask-softness')).toBe('')
    expect(image.style.getPropertyValue('--background-mask-hidden-opacity')).toBe('')
  })

  it('does not retain the removed diamond mask selector', async () => {
    const css = await readFile(path.join(
      process.cwd(),
      'src/renderer/backgrounds/background-image-layer.css',
    ), 'utf8')

    expect(css).not.toContain("data-mask-type='diamond'")
  })

  it('maps all eight mask IDs to image data attributes', () => {
    render(<>
      {BACKGROUND_MASK_TYPES.map((maskType) => <BackgroundImageLayer
        anchor="left-top"
        imageUrl={`arkdown-background://${maskType}.png`}
        key={maskType}
        settings={{ ...DEFAULT_BACKGROUND_SETTINGS, maskType }}
      />)}
    </>)

    expect(screen.getAllByTestId('background-image-layer-image').map((image) => (
      image.getAttribute('data-mask-type')
    ))).toEqual(BACKGROUND_MASK_TYPES)
  })

  it('maps corner and central-band masks to their specified fade directions', async () => {
    const css = await readFile(path.join(
      process.cwd(),
      'src/renderer/backgrounds/background-image-layer.css',
    ), 'utf8')

    expect(css).toMatch(/diagonal-top-left'\] \{ --background-mask-origin: top left/u)
    expect(css).toMatch(/diagonal-top-right'\] \{ --background-mask-origin: top right/u)
    expect(css).toMatch(/diagonal-bottom-left'\] \{ --background-mask-origin: bottom left/u)
    expect(css).toMatch(/diagonal-bottom-right'\] \{ --background-mask-origin: bottom right/u)
    expect(css).toMatch(/column-horizontal'\][\s\S]*?linear-gradient\(to bottom/u)
    expect(css).toMatch(/column-vertical'\][\s\S]*?linear-gradient\(to right/u)
  })

  it('shortens the fade region as mask transition speed increases', () => {
    const { rerender } = render(<BackgroundImageLayer
      anchor="left-top"
      imageUrl="arkdown-background://transition.png"
      settings={{ ...DEFAULT_BACKGROUND_SETTINGS, maskType: 'circle', maskTransitionPercent: 20 }}
    />)
    const image = screen.getByTestId('background-image-layer-image')
    expect(image.style.getPropertyValue('--background-mask-softness')).toBe('80%')

    rerender(<BackgroundImageLayer
      anchor="left-top"
      imageUrl="arkdown-background://transition.png"
      settings={{ ...DEFAULT_BACKGROUND_SETTINGS, maskType: 'circle', maskTransitionPercent: 80 }}
    />)
    expect(image.style.getPropertyValue('--background-mask-softness')).toBe('20%')
  })

  it('maps mask strength only to the white-region alpha without changing fade geometry', () => {
    const { rerender } = render(<BackgroundImageLayer
      anchor="left-top"
      imageUrl="arkdown-background://strength.png"
      settings={{ ...DEFAULT_BACKGROUND_SETTINGS, maskType: 'circle', maskTransitionPercent: 0, maskStrengthPercent: 50 }}
    />)
    const image = screen.getByTestId('background-image-layer-image')
    expect(image.style.getPropertyValue('--background-mask-hidden-opacity')).toBe('0.5')
    expect(image.style.getPropertyValue('--background-mask-softness')).toBe('100%')

    rerender(<BackgroundImageLayer
      anchor="left-top"
      imageUrl="arkdown-background://strength.png"
      settings={{ ...DEFAULT_BACKGROUND_SETTINGS, maskType: 'circle', maskTransitionPercent: 0, maskStrengthPercent: 90 }}
    />)
    expect(image.style.getPropertyValue('--background-mask-hidden-opacity')).toBe('0.1')
    expect(image.style.getPropertyValue('--background-mask-softness')).toBe('100%')
  })

  it('keeps central-band gradient stops ordered across the full transition range', () => {
    const { rerender } = render(<BackgroundImageLayer
      anchor="left-top"
      imageUrl="arkdown-background://band.png"
      settings={{
        ...DEFAULT_BACKGROUND_SETTINGS,
        maskType: 'column-horizontal',
        maskTransitionPercent: 20,
      }}
    />)
    const image = screen.getByTestId('background-image-layer-image')
    expect(image.style.getPropertyValue('--background-mask-band-start')).toBe('40%')
    expect(image.style.getPropertyValue('--background-mask-band-end')).toBe('60%')

    rerender(<BackgroundImageLayer
      anchor="left-top"
      imageUrl="arkdown-background://band.png"
      settings={{
        ...DEFAULT_BACKGROUND_SETTINGS,
        maskType: 'column-vertical',
        maskTransitionPercent: 80,
      }}
    />)
    expect(image.style.getPropertyValue('--background-mask-band-start')).toBe('10%')
    expect(image.style.getPropertyValue('--background-mask-band-end')).toBe('90%')
  })

  it('loads an image at shrink-only cover size and reports when it is undersized', () => {
    const onImageCoverageChange = vi.fn()
    render(<BackgroundImageLayer
      anchor="right-bottom"
      imageUrl="arkdown-background://small.png"
      settings={{ ...DEFAULT_BACKGROUND_SETTINGS, imageOpacityPercent: 42 }}
      onImageCoverageChange={onImageCoverageChange}
    />)
    const layer = screen.getByTestId('background-image-layer')
    const image = screen.getByTestId('background-image-layer-image') as HTMLImageElement
    vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue(rect(800, 600))
    act(() => resizeObservers[0]!.callback([], {} as ResizeObserver))
    setNaturalSize(image, 400, 300)

    fireEvent.load(image)

    expect(layer).toHaveAttribute('data-image-coverage', 'undersized')
    expect(image).toHaveStyle({
      width: '400px', height: '300px', left: '400px', top: '300px', opacity: '0.42',
    })
    expect(onImageCoverageChange).toHaveBeenLastCalledWith('undersized')
  })

  it('recalculates image placement when the container is resized', () => {
    render(<BackgroundImageLayer
      anchor="right-bottom"
      imageUrl="arkdown-background://wide.webp"
      settings={DEFAULT_BACKGROUND_SETTINGS}
    />)
    const layer = screen.getByTestId('background-image-layer')
    const image = screen.getByTestId('background-image-layer-image') as HTMLImageElement
    const getRect = vi.spyOn(layer, 'getBoundingClientRect')
    getRect.mockReturnValue(rect(500, 300))
    act(() => resizeObservers[0]!.callback([], {} as ResizeObserver))
    setNaturalSize(image, 1000, 400)

    fireEvent.load(image)
    expect(image).toHaveStyle({ left: '-250px', top: '0px' })

    getRect.mockReturnValue(rect(600, 300))
    act(() => resizeObservers[0]!.callback([], {} as ResizeObserver))
    expect(image).toHaveStyle({ left: '-150px', top: '0px' })
  })

  it('returns to a hidden loading state while a replacement image is measured', () => {
    const settings = { ...DEFAULT_BACKGROUND_SETTINGS, imageOpacityPercent: 42 }
    const { rerender } = render(<BackgroundImageLayer
      anchor="right-bottom"
      imageUrl="arkdown-background://first.webp"
      settings={settings}
    />)
    const layer = screen.getByTestId('background-image-layer')
    const first = screen.getByTestId('background-image-layer-image') as HTMLImageElement
    vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue(rect(500, 300))
    act(() => resizeObservers[0]!.callback([], {} as ResizeObserver))
    setNaturalSize(first, 1000, 400)
    fireEvent.load(first)
    expect(first).toHaveStyle({ visibility: 'visible' })

    rerender(<BackgroundImageLayer
      anchor="right-bottom"
      imageUrl="arkdown-background://replacement.webp"
      settings={settings}
    />)

    expect(layer).toHaveAttribute('data-image-coverage', 'loading')
    expect(screen.getByTestId('background-image-layer-image')).toHaveStyle({ visibility: 'hidden' })
  })
})
