import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { rasterizeMermaidSvgDataUrl } from '../../src/renderer/editor/mermaid/mermaid-image-export'

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

function fixture() {
  const context = { drawImage: vi.fn() }
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toDataURL: vi.fn(() => 'data:image/png;base64,UE5H'),
  }
  const image = {} as CanvasImageSource
  const adapters = {
    loadImage: vi.fn(async () => image),
    createCanvas: vi.fn(() => canvas),
  }
  return { adapters, canvas, context, image }
}

describe('rasterizeMermaidSvgDataUrl', () => {
  it('rasterizes the SVG viewBox at a bounded high-density size', async () => {
    const { adapters, canvas, context, image } = fixture()
    const source = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"></svg>')

    await expect(rasterizeMermaidSvgDataUrl(source, adapters, 2))
      .resolves.toBe('data:image/png;base64,UE5H')

    expect(canvas.width).toBe(400)
    expect(canvas.height).toBe(200)
    expect(context.drawImage).toHaveBeenCalledWith(image, 0, 0, 400, 200)
  })

  it('limits large diagrams to a 4096px edge and sixteen million pixels', async () => {
    const { adapters, canvas } = fixture()
    const source = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10000 10000"></svg>')

    await rasterizeMermaidSvgDataUrl(source, adapters, 2)

    expect(canvas.width).toBe(4000)
    expect(canvas.height).toBe(4000)
  })

  it('uses finite positive width and height when no viewBox is present', async () => {
    const { adapters, canvas } = fixture()
    const source = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"></svg>')

    await rasterizeMermaidSvgDataUrl(source, adapters, 1)

    expect(canvas.width).toBe(320)
    expect(canvas.height).toBe(180)
  })

  it.each([
    '',
    'data:image/png;base64,UE5H',
    'data:image/svg+xml;base64,%%%%',
    svgDataUrl('<html></html>'),
    svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  ])('rejects malformed or dimensionless SVG input before rasterization', async (source) => {
    const { adapters } = fixture()

    await expect(rasterizeMermaidSvgDataUrl(source, adapters, 1)).rejects.toBeDefined()

    expect(adapters.loadImage).not.toHaveBeenCalled()
  })

  it('rejects a missing canvas context or non-PNG canvas result', async () => {
    const source = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>')
    const image = {} as CanvasImageSource

    await expect(rasterizeMermaidSvgDataUrl(source, {
      loadImage: async () => image,
      createCanvas: () => ({
        width: 0,
        height: 0,
        getContext: () => null,
        toDataURL: () => '',
      }),
    }, 1)).rejects.toBeDefined()

    await expect(rasterizeMermaidSvgDataUrl(source, {
      loadImage: async () => image,
      createCanvas: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
        toDataURL: () => 'data:image/jpeg;base64,SlBFRw==',
      }),
    }, 1)).rejects.toBeDefined()
  })
})
