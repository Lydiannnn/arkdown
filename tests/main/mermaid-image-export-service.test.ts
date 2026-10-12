import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { MermaidImageExportService } from '../../src/main/assets/mermaid-image-export-service'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><path d="M0 0h20v10H0z"/></svg>'
const SVG_DATA_URL = `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`

function pngHeader(width = 1200, height = 600): Buffer {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  bytes[24] = 8
  bytes[25] = 6
  return bytes
}

const PNG_DATA_URL = `data:image/png;base64,${pngHeader().toString('base64')}`

function fixture(target: string | null = 'C:\\exports\\diagram.svg') {
  const nativeImage = {
    isEmpty: () => false,
    getSize: () => ({ width: 1200, height: 600 }),
    toPNG: () => Buffer.from('canonical-png'),
  }
  const dependencies = {
    createNativeImage: vi.fn(() => nativeImage),
    writeClipboardImage: vi.fn(),
    chooseTarget: vi.fn(async () => target),
    writeFileAtomic: vi.fn(async () => undefined),
  }
  return {
    dependencies,
    nativeImage,
    service: new MermaidImageExportService(dependencies),
  }
}

describe('MermaidImageExportService', () => {
  it('copies only a bounded decodable PNG through the native clipboard image path', async () => {
    const { service, dependencies, nativeImage } = fixture()

    await service.copyPng(PNG_DATA_URL)

    expect(dependencies.createNativeImage).toHaveBeenCalledWith(PNG_DATA_URL)
    expect(dependencies.writeClipboardImage).toHaveBeenCalledWith(nativeImage)
  })

  it.each([
    ['', 'empty input'],
    [SVG_DATA_URL, 'non-PNG data URL'],
    ['data:image/png;base64,%%%%', 'malformed base64'],
  ])('rejects unsafe PNG input (%s: %s) before clipboard side effects', async (input) => {
    const { service, dependencies } = fixture()

    await expect(service.copyPng(input)).rejects.toBeDefined()

    expect(dependencies.writeClipboardImage).not.toHaveBeenCalled()
  })

  it('rejects empty, oversized, or over-dimensioned decoded images', async () => {
    const cases = [
      { isEmpty: () => true, getSize: () => ({ width: 1, height: 1 }), toPNG: () => Buffer.from('x') },
      { isEmpty: () => false, getSize: () => ({ width: 4097, height: 1 }), toPNG: () => Buffer.from('x') },
      { isEmpty: () => false, getSize: () => ({ width: 4096, height: 4096 }), toPNG: () => Buffer.alloc(17 * 1024 * 1024) },
    ]
    for (const nativeImage of cases) {
      const writeClipboardImage = vi.fn()
      const service = new MermaidImageExportService({
        createNativeImage: () => nativeImage,
        writeClipboardImage,
        chooseTarget: async () => null,
        writeFileAtomic: async () => undefined,
      })
      await expect(service.copyPng(PNG_DATA_URL)).rejects.toBeDefined()
      expect(writeClipboardImage).not.toHaveBeenCalled()
    }
  })

  it('rejects over-dimensioned PNG headers before invoking the native decoder', async () => {
    const { service, dependencies } = fixture()
    const dataUrl = `data:image/png;base64,${pngHeader(4097, 1).toString('base64')}`

    await expect(service.copyPng(dataUrl)).rejects.toBeDefined()

    expect(dependencies.createNativeImage).not.toHaveBeenCalled()
  })

  it('atomically saves the validated SVG when the chooser returns an SVG target', async () => {
    const { service, dependencies } = fixture('C:\\exports\\diagram.svg')

    await expect(service.save({ svgDataUrl: SVG_DATA_URL, pngDataUrl: PNG_DATA_URL }))
      .resolves.toBe('C:\\exports\\diagram.svg')

    expect(dependencies.writeFileAtomic).toHaveBeenCalledWith(
      'C:\\exports\\diagram.svg',
      Buffer.from(SVG),
    )
  })

  it('re-encodes and atomically saves PNG rather than writing untrusted input bytes', async () => {
    const { service, dependencies } = fixture('C:\\exports\\diagram.png')

    await service.save({ svgDataUrl: SVG_DATA_URL, pngDataUrl: PNG_DATA_URL })

    expect(dependencies.writeFileAtomic).toHaveBeenCalledWith(
      'C:\\exports\\diagram.png',
      Buffer.from('canonical-png'),
    )
  })

  it('returns null without decoding or writing when save is cancelled', async () => {
    const { service, dependencies } = fixture(null)

    await expect(service.save({ svgDataUrl: SVG_DATA_URL, pngDataUrl: PNG_DATA_URL }))
      .resolves.toBeNull()

    expect(dependencies.createNativeImage).not.toHaveBeenCalled()
    expect(dependencies.writeFileAtomic).not.toHaveBeenCalled()
  })

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/x.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>.node{fill:url(javascript:alert(1))}</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.com/x.css";</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/2000/svg"><x:script>alert(1)</x:script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><?xml-stylesheet href="https://example.com/x.css"?></svg>',
    '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"></svg>',
  ])('rejects active or externally-referencing SVG before writing', async (svg) => {
    const { service, dependencies } = fixture('C:\\exports\\diagram.svg')
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`

    await expect(service.save({ svgDataUrl: dataUrl, pngDataUrl: PNG_DATA_URL }))
      .rejects.toBeDefined()

    expect(dependencies.writeFileAtomic).not.toHaveBeenCalled()
  })

  it('allows the local fragment URLs used by sanitized Mermaid filters and markers', async () => {
    const { service, dependencies } = fixture('C:\\exports\\diagram.svg')
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><style>.node{filter:url(#shadow)}</style><defs><filter id="shadow"/></defs></svg>'
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`

    await expect(service.save({ svgDataUrl: dataUrl, pngDataUrl: PNG_DATA_URL }))
      .resolves.toBe('C:\\exports\\diagram.svg')

    expect(dependencies.writeFileAtomic).toHaveBeenCalledWith(
      'C:\\exports\\diagram.svg',
      Buffer.from(svg),
    )
  })

  it.each([
    'diagram.txt',
    'diagram',
    'relative.svg',
  ])('rejects an invalid or relative chooser target %s', async (target) => {
    const { service, dependencies } = fixture(target)

    await expect(service.save({ svgDataUrl: SVG_DATA_URL, pngDataUrl: PNG_DATA_URL }))
      .rejects.toBeDefined()

    expect(dependencies.writeFileAtomic).not.toHaveBeenCalled()
  })
})
