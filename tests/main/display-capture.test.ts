import { describe, expect, it } from 'vitest'
import {
  DisplayCaptureError,
  createDisplayCaptureService,
  type NativeImageLike,
} from '../../src/main/screenshot-translation/display-capture'

const DATA_URL = 'data:image/png;base64,AA=='

class Image implements NativeImageLike {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly bitmap: Uint8Array = Buffer.from([255, 255, 255, 255]),
    readonly dataUrl = DATA_URL,
    readonly empty = false,
    readonly cropResult?: NativeImageLike,
  ) {}

  getSize() { return { width: this.width, height: this.height } }
  isEmpty() { return this.empty }
  toDataURL() { return this.dataUrl }
  toBitmap() { return Buffer.from(this.bitmap) }
  crop(): NativeImageLike { return this.cropResult ?? new Image(1, 1) }
}

function pixels(width: number, height: number, rgba = [40, 50, 60, 255]): Buffer {
  return Buffer.from(Array.from({ length: width * height }, () => rgba).flat())
}

function display(id: number, overrides: Record<string, unknown> = {}) {
  return { id, bounds: { x: 0, y: 0, width: 100, height: 80 }, scaleFactor: 1, ...overrides }
}

function source(displayId: string, thumbnail = new Image(100, 80, pixels(100, 80))) {
  return { display_id: displayId, thumbnail }
}

function service(displays: unknown[], sources: unknown[] | (() => unknown[] | Promise<unknown[]>)) {
  const requests: unknown[] = []
  const capture = createDisplayCaptureService({
    screen: { getAllDisplays: () => displays as never },
    desktopCapturer: { getSources: async (options: unknown) => {
      requests.push(options)
      return (typeof sources === 'function' ? sources() : sources) as never
    } },
  })
  return { capture, requests }
}

describe('display capture', () => {
  it('matches sources by exact display ID and preserves display order', async () => {
    const left = display(22, { bounds: { x: -100, y: 0, width: 100, height: 80 } })
    const right = display(7)
    const { capture, requests } = service([left, right], [source('7'), source('22')])

    await expect(capture.captureAll()).resolves.toMatchObject([
      { snapshot: { displayId: '22', boundsDip: left.bounds } },
      { snapshot: { displayId: '7', boundsDip: right.bounds } },
    ])
    expect(requests).toEqual([
      { types: ['screen'], fetchWindowIcons: false, thumbnailSize: { width: 100, height: 80 } },
      { types: ['screen'], fetchWindowIcons: false, thumbnailSize: { width: 100, height: 80 } },
    ])
  })

  it.each([1, 1.25, 1.5, 2])('requests physical thumbnail dimensions at DPR %s', async (scaleFactor) => {
    const current = display(1, { bounds: { x: 0, y: 0, width: 101, height: 79 }, scaleFactor })
    const { capture, requests } = service([current], [source('1')])
    await capture.captureAll()
    expect(requests[0]).toEqual({
      types: ['screen'], fetchWindowIcons: false,
      thumbnailSize: { width: Math.ceil(101 * scaleFactor), height: Math.ceil(79 * scaleFactor) },
    })
  })

  it('uses actual independent X/Y thumbnail ratios for fractional inverted and clipped crops', async () => {
    const original = new Image(130, 70, pixels(130, 70))
    const { capture } = service(
      [display(1, { bounds: { x: -100, y: 20, width: 100, height: 80 }, scaleFactor: 1.25 })],
      [source('1', original)],
    )
    const [snapshot] = await capture.captureAll()
    let cropRect: unknown
    const cropper = Object.assign(original, { crop: (rect: unknown) => { cropRect = rect; return new Image(3, 3, pixels(3, 3)) } })
    const captured = { ...snapshot, image: cropper }
    capture.crop(captured, { x: -0.2, y: 98.1, width: -99.4, height: -77.9 })
    expect(cropRect).toEqual({ x: 0, y: 0, width: 130, height: 69 })
  })

  it('publishes actual image dimensions and rejects every unusable capture state', async () => {
    const valid = new Image(91, 77, pixels(91, 77))
    const { capture } = service([display(1)], [source('1', valid)])
    await expect(capture.captureAll()).resolves.toMatchObject([{ snapshot: { imageSizePx: { width: 91, height: 77 } } }])

    const invalidThumbnails = [
      new Image(0, 1), new Image(1, 1, Buffer.alloc(4), DATA_URL, true),
      new Image(1, 1, Buffer.from([1, 1, 1, 255])),
      new Image(2, 2, Buffer.from([255, 255, 255, 255])),
      new Image(1, 1, pixels(1, 1), 'data:image/jpeg;base64,AA=='),
    ]
    for (const thumbnail of invalidThumbnails) {
      const candidate = service([display(1)], [source('1', thumbnail)]).capture
      await expect(candidate.captureAll()).rejects.toMatchObject({ code: expect.any(String) })
    }
  })

  it('rejects invalid displays, unavailable sources, missing or duplicate source IDs', async () => {
    for (const displays of [[], [display(-1)], [display(1), display(1)], [display(1, { bounds: { x: 0, y: 0, width: 0, height: 1 } })]]) {
      await expect(service(displays, [source('1')]).capture.captureAll()).rejects.toBeInstanceOf(DisplayCaptureError)
    }
    await expect(service([display(1)], () => { throw new Error('no capture') }).capture.captureAll()).rejects.toMatchObject({ code: 'CAPTURE_UNAVAILABLE' })
    await expect(service([display(1)], []).capture.captureAll()).rejects.toMatchObject({ code: 'CAPTURE_UNAVAILABLE' })
    await expect(service([display(1)], [source('1'), source('1')]).capture.captureAll()).rejects.toMatchObject({ code: 'CAPTURE_UNAVAILABLE' })
  })

  it('does not mutate inputs and rejects empty or black crop results', async () => {
    const image = new Image(100, 80, pixels(100, 80))
    const { capture } = service([display(1)], [source('1', image)])
    const [captured] = await capture.captureAll()
    const selection = { x: 0, y: 0, width: 10, height: 10 }
    expect(() => capture.crop(captured, selection)).not.toThrow()
    expect(selection).toEqual({ x: 0, y: 0, width: 10, height: 10 })
    const invalid = { ...captured, image: new Image(100, 80, pixels(100, 80), DATA_URL, false, new Image(1, 1, Buffer.alloc(4))) }
    try {
      capture.crop(invalid, selection)
      throw new Error('crop unexpectedly succeeded')
    } catch (error) {
      expect(error).toMatchObject({ code: 'CAPTURE_EMPTY' })
    }
  })

  it('rejects JPEG and oversized cropped transport as empty', async () => {
    const image = new Image(100, 80, pixels(100, 80))
    const { capture } = service([display(1)], [source('1', image)])
    const [captured] = await capture.captureAll()
    for (const dataUrl of [
      'data:image/jpeg;base64,AA==',
      `data:image/png;base64,${'A'.repeat(44_739_244)}`,
    ]) {
      const invalidTransport = new Image(1, 1, pixels(1, 1), dataUrl)
      const candidate = { ...captured, image: Object.assign(image, { crop: (): NativeImageLike => invalidTransport }) }
      try {
        capture.crop(candidate, { x: 0, y: 0, width: 1, height: 1 })
        throw new Error('crop unexpectedly succeeded')
      } catch (error) {
        expect(error).toMatchObject({ code: 'CAPTURE_EMPTY' })
      }
    }
  })
})
