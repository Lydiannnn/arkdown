import { sanitizeMermaidSvg } from '../editor/mermaid/mermaid-svg-sanitizer'
import type { ViewerSize } from './viewer-geometry'

export function decodeViewerSvg(dataUrl: string): string {
  if (!dataUrl.startsWith('data:image/svg+xml;base64,')) throw new Error('Invalid Mermaid snapshot')
  const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), character => character.charCodeAt(0))
  return sanitizeMermaidSvg(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

export function naturalSvgSize(svg: SVGSVGElement): ViewerSize {
  const bounded = (width: number, height: number): ViewerSize => {
    const divisor = Math.max(1, width / 1_000_000, height / 1_000_000)
    return { width: Math.max(1, width / divisor), height: Math.max(1, height / divisor) }
  }
  const box = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  if (box.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0) {
    return bounded(box[2]!, box[3]!)
  }
  const width = Number.parseFloat(svg.getAttribute('width') ?? '')
  const height = Number.parseFloat(svg.getAttribute('height') ?? '')
  return bounded(Number.isFinite(width) && width > 0 ? width : 800, Number.isFinite(height) && height > 0 ? height : 600)
}

function isVisibleRun(element: SVGGraphicsElement, root: SVGSVGElement): boolean {
  if (element.closest('defs, symbol, marker, clipPath, mask, pattern')) return false
  if (!Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) return false
  const style = getComputedStyle(element)
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
  const unpainted = (paint: string) => paint === 'none' || paint === 'transparent'
    || /^(?:rgba|hsla)\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(paint)
    || /^(?:rgba?|hsla?)\([^)]*\/\s*0(?:\.0+)?%?\s*\)$/.test(paint)
  const visibleFill = !unpainted(style.fill) && style.getPropertyValue('fill-opacity') !== '0'
  const visibleStroke = Boolean(style.stroke) && !unpainted(style.stroke)
    && style.getPropertyValue('stroke-opacity') !== '0' && Number.parseFloat(style.getPropertyValue('stroke-width') || '1') > 0
  if (!visibleFill && !visibleStroke) return false
  for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
    const ancestorStyle = getComputedStyle(ancestor)
    if (ancestorStyle.display === 'none' || ancestorStyle.opacity === '0') return false
    if (ancestor === root) break
  }
  const rect = element.getBoundingClientRect()
  const bounds = root.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 && rect.right > bounds.left && rect.left < bounds.right && rect.bottom > bounds.top && rect.top < bounds.bottom
}

// Measure the mounted, natural-size SVG. getScreenCTM includes the viewBox,
// nested SVG/group transforms and tspan transforms, in CSS (not device) pixels.
export function measureSmallestVisibleText(svg: SVGSVGElement): number | null {
  let smallest = Infinity
  for (const element of svg.querySelectorAll<SVGGraphicsElement>('text, tspan, textPath')) {
    try {
      if (!isVisibleRun(element, svg)) continue
      const matrix = element.getScreenCTM?.()
      if (!matrix) continue
      const effectiveSize = Number.parseFloat(getComputedStyle(element).fontSize) * Math.hypot(matrix.c, matrix.d)
      if (Number.isFinite(effectiveSize) && effectiveSize > 0) smallest = Math.min(smallest, effectiveSize)
    } catch { /* A missing browser geometry measurement falls back to fit. */ }
  }
  return Number.isFinite(smallest) ? smallest : null
}
