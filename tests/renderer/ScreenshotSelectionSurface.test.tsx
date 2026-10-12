import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ArkdownApi } from '../../src/shared/contracts'
import type { ScreenshotCaptureEvent } from '../../src/shared/screenshot-translation'
import { ScreenshotSelectionSurface } from '../../src/renderer/screenshot/ScreenshotSelectionSurface'

const sessionId = '123e4567-e89b-42d3-a456-426614174000'
const display = {
  displayId: '1', boundsDip: { x: 100, y: 200, width: 100, height: 80 }, scaleFactor: 1.25,
  imageSizePx: { width: 125, height: 100 }, dataUrl: 'data:image/png;base64,AAAA',
}

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number
  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 1
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function installApi(overrides: Partial<ArkdownApi> = {}) {
  let listener: ((event: ScreenshotCaptureEvent) => void) | undefined
  const api = {
    onScreenshotCaptureEvent: vi.fn((next: (event: ScreenshotCaptureEvent) => void) => {
      listener = next
      next({ sessionId, type: 'selection-ready', display })
      return () => { if (listener === next) listener = undefined }
    }),
    updateScreenshotCapturePointer: vi.fn().mockResolvedValue({ ok: true, value: null }),
    commitScreenshotCapture: vi.fn().mockResolvedValue({ ok: true, value: null }),
    cancelScreenshotCapture: vi.fn().mockResolvedValue({ ok: true, value: null }),
    ...overrides,
  } as unknown as ArkdownApi
  Object.defineProperty(window, 'arkdown', { configurable: true, value: api })
  Object.defineProperty(window, 'PointerEvent', { configurable: true, value: TestPointerEvent })
  return { api, emit: (event: ScreenshotCaptureEvent) => listener?.(event) }
}

function pointer(root: HTMLElement, type: string, x: number, y: number, pointerId = 1) {
  fireEvent(root, new TestPointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, pointerId }))
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('acknowledges readiness only after the static snapshot decodes and two committed paint frames', async () => {
  const decode = deferred<void>()
  const frames: FrameRequestCallback[] = []
  class TestImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    src = ''
    decode = vi.fn(() => decode.promise)
  }
  vi.stubGlobal('Image', TestImage)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  const ready = vi.fn().mockResolvedValue({ ok: true, value: null })
  installApi({ readyScreenshotCapture: ready })
  render(<ScreenshotSelectionSurface sessionId={sessionId} displayId="1" />)

  expect(ready).not.toHaveBeenCalled()
  decode.resolve()
  await waitFor(() => expect(frames).toHaveLength(1))
  frames.shift()!(0)
  await waitFor(() => expect(frames).toHaveLength(1))
  expect(ready).not.toHaveBeenCalled()
  frames.shift()!(1)
  await waitFor(() => expect(ready).toHaveBeenCalledWith({ sessionId, displayId: '1' }))
})

it('renders a pre-ready noninteractive shell and accepts only its matching display snapshot', async () => {
  let listener: ((event: ScreenshotCaptureEvent) => void) | undefined
  installApi({
    onScreenshotCaptureEvent: ((next: (event: ScreenshotCaptureEvent) => void) => {
      listener = next
      return () => undefined
    }) as ArkdownApi['onScreenshotCaptureEvent'],
  })
  render(<ScreenshotSelectionSurface sessionId={sessionId} displayId="1" />)
  const root = screen.getByRole('application')
  expect(root).not.toHaveClass('is-ready')
  pointer(root, 'pointerdown', 10, 10)
  expect(window.arkdown.updateScreenshotCapturePointer).not.toHaveBeenCalled()

  listener?.({ sessionId, type: 'selection-ready', display: { ...display, displayId: '2' } })
  expect(root).not.toHaveClass('is-ready')
  listener?.({ sessionId, type: 'selection-ready', display })
  await waitFor(() => expect(root).toHaveClass('is-ready'))
})

it('latches region mode at 4 CSS px and ignores a non-active pointer-up', async () => {
  const { api } = installApi()
  render(<ScreenshotSelectionSurface sessionId={sessionId} displayId="1" />)
  const root = screen.getByRole('application')

  pointer(root, 'pointerdown', 10, 10, 7)
  pointer(root, 'pointermove', 13.9, 10, 7)
  expect(document.querySelector('.screenshot-selection-region')).toBeNull()
  pointer(root, 'pointermove', 12.4, 13.2, 7)
  expect(document.querySelector('.screenshot-selection-region')).not.toBeNull()
  pointer(root, 'pointermove', 11, 11, 7)
  expect(document.querySelector('.screenshot-selection-region')).not.toBeNull()
  pointer(root, 'pointermove', 20, 20, 7)
  pointer(root, 'pointerup', 20, 20, 8)
  expect(api.commitScreenshotCapture).not.toHaveBeenCalled()
  pointer(root, 'pointerup', 20, 20, 7)

  await waitFor(() => expect(api.commitScreenshotCapture).toHaveBeenCalledWith({
    sessionId, displayId: '1', kind: 'region', rectDip: { x: 110, y: 210, width: 10, height: 10 },
  }))
})

it('keeps the original active pointer when a second pointer goes down', async () => {
  const { api } = installApi()
  render(<ScreenshotSelectionSurface sessionId={sessionId} displayId="1" />)
  const root = screen.getByRole('application')
  pointer(root, 'pointerdown', 10, 10, 21)
  pointer(root, 'pointerdown', 30, 30, 22)
  pointer(root, 'pointermove', 50, 50, 22)
  pointer(root, 'pointerup', 50, 50, 22)
  expect(api.commitScreenshotCapture).not.toHaveBeenCalled()

  pointer(root, 'pointermove', 20, 20, 21)
  pointer(root, 'pointerup', 20, 20, 21)
  await waitFor(() => expect(api.commitScreenshotCapture).toHaveBeenCalledWith({
    sessionId, displayId: '1', kind: 'region', rectDip: { x: 110, y: 210, width: 10, height: 10 },
  }))
})

it('recovers from pointer-capture exceptions and a failed region commit', async () => {
  const commit = vi.fn()
    .mockResolvedValueOnce({ ok: false, error: { code: 'OPERATION_FAILED', message: 'failed' } })
    .mockResolvedValueOnce({ ok: true, value: null })
  const { api } = installApi({ commitScreenshotCapture: commit })
  render(<ScreenshotSelectionSurface sessionId={sessionId} displayId="1" />)
  const root = screen.getByRole('application')
  Object.defineProperty(root, 'setPointerCapture', { configurable: true, value: vi.fn(() => { throw new Error('capture failed') }) })
  Object.defineProperty(root, 'releasePointerCapture', { configurable: true, value: vi.fn(() => { throw new Error('release failed') }) })

  expect(() => {
    pointer(root, 'pointerdown', 5, 5, 3)
    pointer(root, 'pointermove', 15, 15, 3)
    pointer(root, 'pointerup', 15, 15, 3)
  }).not.toThrow()
  await waitFor(() => expect(commit).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(root).not.toHaveAttribute('aria-busy', 'true'))

  pointer(root, 'pointerdown', 20, 20, 4)
  pointer(root, 'pointermove', 30, 30, 4)
  pointer(root, 'pointerup', 30, 30, 4)
  await waitFor(() => expect(api.commitScreenshotCapture).toHaveBeenCalledTimes(2))
})

it('does not commit a stale highlight when the release probe fails', async () => {
  const { api, emit } = installApi({
    updateScreenshotCapturePointer: vi.fn().mockResolvedValue({ ok: false, error: { code: 'OPERATION_FAILED', message: 'failed' } }),
  })
  render(<ScreenshotSelectionSurface sessionId={sessionId} displayId="1" />)
  emit({ sessionId, type: 'window-highlight', displayId: '1', hit: { processId: 77, rectDip: { x: 110, y: 210, width: 20, height: 20 } } })
  const root = screen.getByRole('application')
  pointer(root, 'pointerdown', 10, 10, 5)
  pointer(root, 'pointerup', 10, 10, 5)

  await waitFor(() => expect(api.updateScreenshotCapturePointer).toHaveBeenCalled())
  expect(api.commitScreenshotCapture).not.toHaveBeenCalled()
  expect(document.querySelector('.screenshot-selection-highlight')).not.toBeNull()
})

it('commits only the highlight produced by the release probe', async () => {
  const update = vi.fn().mockResolvedValue({ ok: true, value: null })
  const installed = installApi({ updateScreenshotCapturePointer: update })
  update.mockImplementationOnce(async () => ({ ok: true, value: null }))
  update.mockImplementationOnce(async () => ({
    ok: true,
    value: { processId: 88, rectDip: { x: 120, y: 220, width: 30, height: 20 } },
  }))
  render(<ScreenshotSelectionSurface sessionId={sessionId} displayId="1" />)
  installed.emit({
    sessionId,
    type: 'window-highlight',
    displayId: '1',
    hit: { processId: 77, rectDip: { x: 100, y: 200, width: 10, height: 10 } },
  })
  const root = screen.getByRole('application')
  pointer(root, 'pointerdown', 25, 25, 12)
  pointer(root, 'pointerup', 25, 25, 12)

  await waitFor(() => expect(installed.api.commitScreenshotCapture).toHaveBeenCalledWith({
    sessionId,
    displayId: '1',
    kind: 'window',
    processId: 88,
    rectDip: { x: 120, y: 220, width: 30, height: 20 },
  }))
})

it('keeps an old hover highlight when the pointer API fails', async () => {
  const installed = installApi({
    updateScreenshotCapturePointer: vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: 'failed' },
    }),
  })
  render(<ScreenshotSelectionSurface sessionId={sessionId} displayId="1" />)
  installed.emit({
    sessionId,
    type: 'window-highlight',
    displayId: '1',
    hit: { processId: 77, rectDip: { x: 110, y: 210, width: 20, height: 20 } },
  })
  await waitFor(() => expect(document.querySelector('.screenshot-selection-highlight')).not.toBeNull())
  pointer(screen.getByRole('application'), 'pointermove', 30, 30, 13)
  await waitFor(() => expect(document.querySelector('.screenshot-selection-highlight')).not.toBeNull())
})

it('keeps one pointer probe in flight and replaces queued hover points with the latest one', async () => {
  const first = deferred<{ ok: true; value: null }>()
  const second = deferred<{ ok: true; value: null }>()
  const update = vi.fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
  const installed = installApi({ updateScreenshotCapturePointer: update })
  const view = render(<ScreenshotSelectionSurface sessionId={sessionId} displayId="1" />)
  installed.emit({
    sessionId,
    type: 'window-highlight',
    displayId: '1',
    hit: { processId: 77, rectDip: { x: 110, y: 210, width: 20, height: 20 } },
  })
  const root = screen.getByRole('application')

  for (let index = 0; index < 100; index += 1) pointer(root, 'pointermove', index, 10, 13)

  await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
  expect(document.querySelector('.screenshot-selection-highlight')).not.toBeNull()
  first.resolve({ ok: true, value: null })
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
  expect(update).toHaveBeenLastCalledWith({
    sessionId,
    displayId: '1',
    screenPointDip: { x: 199, y: 210 },
  })
  view.unmount()
  second.resolve({ ok: true, value: null })
})

it('abandons an asynchronous release probe after unmount', async () => {
  const probe = deferred<{ ok: true; value: null }>()
  const { api, emit } = installApi({ updateScreenshotCapturePointer: vi.fn(() => probe.promise) })
  const view = render(<ScreenshotSelectionSurface sessionId={sessionId} displayId="1" />)
  emit({ sessionId, type: 'window-highlight', displayId: '1', hit: { processId: 77, rectDip: { x: 110, y: 210, width: 20, height: 20 } } })
  const root = screen.getByRole('application')
  pointer(root, 'pointerdown', 10, 10, 6)
  pointer(root, 'pointerup', 10, 10, 6)
  view.unmount()
  probe.resolve({ ok: true, value: null })
  await probe.promise
  await Promise.resolve()
  expect(api.commitScreenshotCapture).not.toHaveBeenCalled()
})

it('uses one 42% mask, exposes physical pixel dimensions, and anchors the size label to the selection', () => {
  installApi()
  render(<ScreenshotSelectionSurface sessionId={sessionId} displayId="1" />)
  const root = screen.getByRole('application')
  pointer(root, 'pointerdown', 10, 10, 9)
  pointer(root, 'pointermove', 14, 14, 9)

  const mask = document.querySelector('.screenshot-selection-mask') as HTMLElement
  const region = document.querySelector('.screenshot-selection-region') as HTMLElement
  const size = document.querySelector('.screenshot-selection-size') as HTMLOutputElement
  expect(getComputedStyle(mask).backgroundColor).toBe('rgba(0, 0, 0, 0.42)')
  expect(['', 'none']).toContain(getComputedStyle(region).boxShadow)
  expect(size.textContent).toContain('6')
  expect(size.style.left).toBe('10px')
  expect(size.style.top).toBe('18px')
})

it('moves the original screenshot cutout with the latest window candidate and removes it on a miss', async () => {
  const { emit } = installApi()
  render(<ScreenshotSelectionSurface sessionId={sessionId} displayId="1" />)
  for (const [x, y, width, height] of [[110, 210, 20, 20], [130, 225, 45, 40]]) {
    emit({ sessionId, type: 'window-highlight', displayId: '1',
      hit: { processId: 77, rectDip: { x, y, width, height } } })
    await waitFor(() => {
      const highlight = document.querySelector<HTMLElement>('.screenshot-selection-highlight')!
      expect(highlight).not.toBeNull()
      expect(highlight.style.left).toBe(`${x - 100}px`)
      expect(highlight.style.top).toBe(`${y - 200}px`)
      expect(highlight.style.width).toBe(`${width}px`)
      expect(highlight.style.height).toBe(`${height}px`)
      expect(highlight.style.backgroundImage).toContain(display.dataUrl)
      expect(highlight.style.backgroundPosition).toBe(`${100 - x}px ${200 - y}px`)
    })
    expect(document.querySelectorAll('.screenshot-selection-mask')).toHaveLength(1)
  }
  emit({ sessionId, type: 'window-highlight', displayId: '1', hit: null })
  await waitFor(() => expect(document.querySelector('.screenshot-selection-highlight')).toBeNull())
  expect(document.querySelector('.screenshot-selection-mask')).not.toBeNull()
})

it('leaves blur ownership to main, cancels once on renderer intent, and releases capture on unmount', () => {
  const { api } = installApi()
  const view = render(<ScreenshotSelectionSurface sessionId={sessionId} displayId="1" />)
  const root = screen.getByRole('application')
  const release = vi.fn()
  Object.defineProperty(root, 'setPointerCapture', { configurable: true, value: vi.fn() })
  Object.defineProperty(root, 'releasePointerCapture', { configurable: true, value: release })
  pointer(root, 'pointerdown', 10, 10, 11)
  window.dispatchEvent(new Event('blur'))
  expect(api.cancelScreenshotCapture).not.toHaveBeenCalled()
  fireEvent.keyDown(document, { key: 'Escape' })
  fireEvent.contextMenu(root)
  view.unmount()

  expect(api.cancelScreenshotCapture).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledWith(11)
})

it('allows cancellation retry after an IPC failure or rejection', async () => {
  const cancel = vi.fn()
    .mockResolvedValueOnce({ ok: false, error: { code: 'OPERATION_FAILED', message: 'failed' } })
    .mockRejectedValueOnce(new Error('transport failed'))
    .mockResolvedValueOnce({ ok: true, value: null })
  installApi({ cancelScreenshotCapture: cancel })
  render(<ScreenshotSelectionSurface sessionId={sessionId} displayId="1" />)

  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
  fireEvent.contextMenu(screen.getByRole('application'))
  await waitFor(() => expect(cancel).toHaveBeenCalledTimes(2))
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(cancel).toHaveBeenCalledTimes(3))
})
