import { describe, expect, it } from 'vitest'
import { chooseViewerScales, zoomScrollPosition } from '../../src/renderer/mermaid-viewer/viewer-geometry'
import { measureSmallestVisibleText, naturalSvgSize } from '../../src/renderer/mermaid-viewer/viewer-svg'

describe('Mermaid viewer geometry', () => {
  it('enlarges a wide diagram until its smallest text reaches 14 CSS px', () => {
    expect(chooseViewerScales({ width: 2000, height: 800 }, { width: 1000, height: 600 }, 10))
      .toEqual({ fit: 0.476, reading: 1.4, initial: 1.4 })
  })
  it('keeps a small legible diagram at natural size and falls back to fit without text', () => {
    expect(chooseViewerScales({ width: 100, height: 80 }, { width: 1000, height: 600 }, 16).initial).toBe(1)
    expect(chooseViewerScales({ width: 2000, height: 800 }, { width: 1000, height: 600 }, null).initial).toBe(0.476)
  })
  it('never returns zero, infinite or NaN scale for unavailable layout', () => {
    for (const dimensions of [{ width: 0, height: 0 }, { width: Infinity, height: NaN }]) {
      const scales = chooseViewerScales(dimensions, dimensions, NaN)
      expect(scales.initial).toBeGreaterThan(0)
      expect(Number.isFinite(scales.initial)).toBe(true)
    }
  })
  it('keeps the same diagram point under the zoom anchor when centering becomes overflow', () => {
    expect(zoomScrollPosition(0, 400, 600, 400, 1, 2)).toBe(224)
    expect(zoomScrollPosition(100, 200, 600, 1000, 1, 1.5)).toBe(238)
  })
})

describe('visible SVG text measurement', () => {
  it('bounds malformed or extreme SVG viewport dimensions before mounting', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 1e300 5e299')
    expect(naturalSvgSize(svg)).toEqual({ width: 1_000_000, height: 500_000 })
    svg.setAttribute('viewBox', '0 0 NaN Infinity')
    expect(naturalSvgSize(svg)).toEqual({ width: 800, height: 600 })
  })
  function fixture(markup: string) {
    const host = document.createElement('div')
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400">${markup}</svg>`
    document.body.append(host)
    const svg = shadow.querySelector('svg')!
    Object.defineProperty(svg, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400 }) })
    for (const element of svg.querySelectorAll('text, tspan')) {
      Object.defineProperty(element, 'getScreenCTM', { value: () => ({ a: 1, b: 0, c: 0, d: Number(element.getAttribute('data-scale') || 1) }) })
      Object.defineProperty(element, 'getBoundingClientRect', { value: () => ({ left: 5, top: 5, right: 100, bottom: 30, width: 95, height: 25 }) })
    }
    return { host, svg }
  }
  it('measures each direct run and applies its full rendered text transform', () => {
    const { host, svg } = fixture('<text style="font-size:20px">Parent<tspan style="font-size:12px" data-scale="0.5">Small</tspan></text>')
    expect(measureSmallestVisibleText(svg)).toBe(6)
    host.remove()
  })
  it('excludes definitions, empty runs and hidden ancestors', () => {
    const { host, svg } = fixture('<defs><text style="font-size:1px">Definition</text></defs><g style="display:none"><text style="font-size:2px">Hidden</text></g><text style="font-size:1px"> </text><text style="opacity:0;font-size:2px">Transparent</text><text style="font-size:16px">Visible</text>')
    expect(measureSmallestVisibleText(svg)).toBe(16)
    host.remove()
  })
  it('returns no text when geometry cannot be measured', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.innerHTML = '<text>Unmeasurable</text>'
    expect(measureSmallestVisibleText(svg)).toBeNull()
  })
  it('ignores text whose fill and stroke are fully transparent', () => {
    const { host, svg } = fixture('<text style="font-size:2px;fill-opacity:0;stroke:none">Invisible</text><text style="font-size:16px">Visible</text>')
    expect(measureSmallestVisibleText(svg)).toBe(16)
    host.remove()
  })
})
