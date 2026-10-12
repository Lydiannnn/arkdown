import { describe, expect, it, vi } from 'vitest'

import {
  sanitizeMermaidSvg,
  svgToDataUrl,
  type MermaidCssValidator,
} from '../../src/renderer/editor/mermaid/mermaid-svg-sanitizer'

const safeCssValidator: MermaidCssValidator = (css) => css

describe('sanitizeMermaidSvg', () => {
  it('rebuilds a safe flowchart SVG from allowlisted nodes and attributes', () => {
    const result = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><defs><marker id="arrow"><path d="M0 0L10 5L0 10z"/></marker></defs><g class="node"><rect x="1" y="1" width="18" height="10" rx="2"/><text x="10" y="8">安全</text><path d="M10 11L10 19" marker-end="url(#arrow)"/></g></svg>',
    )

    expect(result).toContain('<svg')
    expect(result).toContain('<marker')
    expect(result).toContain('marker-end="url(#arrow)"')
    expect(result).toContain('<text')
  })

  it('accepts an inert flowchart accessibility and edge metadata fixture', () => {
    const result = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" role="graphics-document document" aria-roledescription="flowchart-v2"><g><path id="L_A_B_0" data-edge="true" data-et="edge" data-id="L_A_B_0" data-points=\'[{"x":0,"y":0}]\' data-look="classic" d="M0 0L1 1" clip-rule="evenodd"/><text x="1" y="1" dy="1em">A</text></g></svg>',
    )

    expect(result).toContain('aria-roledescription="flowchart-v2"')
    expect(result).toContain('data-edge="true"')
    expect(result).toContain('data-et="edge"')
    expect(result).toContain('data-id="L_A_B_0"')
    expect(result).toContain('data-points="[{&quot;x&quot;:0,&quot;y&quot;:0}]"')
    expect(result).toContain('data-look="classic"')
    expect(result).toContain('clip-rule="evenodd"')
    expect(result).toContain('dy="1em"')
  })

  it('accepts a local drop-shadow filter fixture', () => {
    const result = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><filter id="drop-shadow"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.25" flood-color="#000000"/></filter></defs><rect x="1" y="1" width="18" height="10" filter="url(#drop-shadow)"/></svg>',
    )

    expect(result).toContain('<filter id="drop-shadow"')
    expect(result).toContain('<feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.25" flood-color="#000000"')
    expect(result).toContain('filter="url(#drop-shadow)"')
  })

  it('preserves XML-sensitive SVG element and attribute casing for image output', () => {
    const result = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" preserveAspectRatio="xMidYMid"><defs><path id="edge" d="M0 0L1 1" pathLength="1"/><clipPath id="clip"><rect width="1" height="1"/></clipPath><linearGradient id="linear" gradientUnits="userSpaceOnUse" gradientTransform="rotate(10)" spreadMethod="pad"><stop offset="0"/></linearGradient><radialGradient id="radial"/><marker id="marker" markerWidth="4" markerHeight="4" refX="1" refY="1" markerUnits="strokeWidth"/><pattern id="pattern" patternUnits="userSpaceOnUse" patternContentUnits="objectBoundingBox" patternTransform="translate(1 1)"/><filter id="shadow"><feDropShadow stdDeviation="2"/></filter></defs><text textLength="10" lengthAdjust="spacing"><textPath href="#edge" startOffset="50%">A</textPath></text></svg>',
    )

    for (const tag of ['clipPath', 'textPath', 'linearGradient', 'radialGradient', 'feDropShadow']) {
      expect(result).toContain(`<${tag}`)
    }
    for (const attribute of [
      'viewBox', 'preserveAspectRatio', 'pathLength', 'gradientUnits', 'gradientTransform',
      'spreadMethod', 'markerWidth', 'markerHeight', 'refX', 'refY', 'markerUnits',
      'patternUnits', 'patternContentUnits', 'patternTransform', 'textLength', 'lengthAdjust',
      'startOffset', 'stdDeviation',
    ]) {
      expect(result).toContain(`${attribute}=`)
    }
  })

  it('accepts inert Mermaid sequence metadata and static transform origins', () => {
    const result = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><g name="张三🌟 https://example.test" data-type="activation https:" data-from="Alice https:" data-to="Bob https:" transform-origin="220px 60px"/><g transform-origin="left center 0"/></svg>',
    )

    expect(result).toContain('name="张三🌟 https://example.test"')
    expect(result).toContain('data-type="activation https:"')
    expect(result).toContain('data-from="Alice https:"')
    expect(result).toContain('data-to="Bob https:"')
    expect(result).toContain('transform-origin="220px 60px"')
    expect(result).toContain('transform-origin="left center 0"')
  })

  it.each([
    'url(#shadow)',
    'var(--origin)',
    'calc(220px + 60px)',
    '220px;fill:red',
    '220px\u008560px',
    'NaNpx 60px',
    'Infinitypx 60px',
    'https://example.com/origin',
    '//example.com/origin',
  ])('rejects unsafe transform-origin values', (origin) => {
    expect(() => sanitizeMermaidSvg(
      `<svg xmlns="http://www.w3.org/2000/svg"><g transform-origin="${origin}"/></svg>`,
    )).toThrow('Unsafe Mermaid SVG')
  })

  it('rejects unknown data attributes instead of enabling a data wildcard', () => {
    expect(() => sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><g data-evil="https://example.com"/></svg>',
    )).toThrow('Unsafe Mermaid SVG')
  })

  it.each([
    '<rect width="1" height="1" filter="url(https://example.com/filter.svg#shadow)"/>',
    '<defs><filter id="shadow"><feImage href="#local"/></filter></defs>',
    '<defs><filter id="shadow"><feGaussianBlur stdDeviation="2"/></filter></defs>',
  ])('rejects unsafe filter content instead of silently removing it', (child) => {
    expect(() => sanitizeMermaidSvg(`<svg xmlns="http://www.w3.org/2000/svg">${child}</svg>`))
      .toThrow('Unsafe Mermaid SVG')
  })

  it.each([
    ['script', '<script>alert(1)</script>'],
    ['foreignObject', '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'],
    ['iframe', '<iframe/>'],
    ['image', '<image href="#local"/>'],
    ['animation', '<animate attributeName="x" values="0;1"/>'],
  ])('rejects the forbidden %s element instead of silently removing it', (_name, child) => {
    expect(() => sanitizeMermaidSvg(`<svg xmlns="http://www.w3.org/2000/svg">${child}</svg>`))
      .toThrow('Unsafe Mermaid SVG')
  })

  it('rejects event handlers and every non-fragment reference', () => {
    const samples = [
      '<path d="M0 0" onclick="alert(1)"/>',
      '<use href="https://example.com/x.svg#p"/>',
      '<use href="data:image/svg+xml;base64,AAAA"/>',
      '<use href="javascript:alert(1)"/>',
      '<use href="//example.com/x.svg#p"/>',
      '<g xmlns:remote="https://example.com/schema"/>',
    ]

    for (const child of samples) {
      expect(() => sanitizeMermaidSvg(`<svg xmlns="http://www.w3.org/2000/svg">${child}</svg>`))
        .toThrow('Unsafe Mermaid SVG')
    }
  })

  it.each([
    '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>',
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&xxe;</svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path></svg>',
  ])('rejects declarations, entities, and malformed XML', (svg) => {
    expect(() => sanitizeMermaidSvg(svg)).toThrow('Unsafe Mermaid SVG')
  })

  it.each([
    '@import "https://example.com/evil.css"; .node { fill: red; }',
    '.node { fill: url(https://example.com/fill.svg); }',
    '.node { fill: url(data:image/svg+xml;base64,AAAA); }',
    '.node { background-image: image-set("https://example.com/fill.png" 1x); }',
    '.node { behavior: url(#evil); }',
    '.node { -moz-binding: url(#evil); }',
    '.node { width: expression(alert(1)); }',
  ])('rejects active or externally referencing root CSS', (css) => {
    expect(() => sanitizeMermaidSvg(
      `<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style><rect class="node" width="1" height="1"/></svg>`,
      { cssValidator: safeCssValidator },
    )).toThrow('Unsafe Mermaid SVG')
  })

  it('accepts one direct root style with local fragment references after CSSOM validation', () => {
    const cssValidator = vi.fn<MermaidCssValidator>((css) => css.replace(/\s+/g, ' ').trim())
    const result = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.edge { marker-end: url(#arrow); fill: #fff; }</style><defs><marker id="arrow"><path d="M0 0L1 1"/></marker></defs><path class="edge" d="M0 0L1 1"/></svg>',
      { cssValidator },
    )

    expect(cssValidator).toHaveBeenCalledOnce()
    expect(result).toContain('url(#arrow)')
    expect(result).toContain('<style')
  })

  it('runs inline declarations through CSSOM reconstruction and retains local fragments', () => {
    const cssValidator = vi.fn<MermaidCssValidator>((css) => css.replace(/\s+/g, ' ').trim())
    const result = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="paint"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="1" height="1" style="fill: url(#paint); stroke: #000;"/></svg>',
      { cssValidator },
    )

    expect(cssValidator).toHaveBeenCalledWith('.arkdown-inline{fill: url(#paint); stroke: #000;}')
    expect(result).toContain('style="fill: url(#paint); stroke: #000;"')
  })

  it('rejects relative image-set resources in inline declarations', () => {
    expect(() => sanitizeMermaidSvg(
      `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" style="background-image: image-set('relative.png' 1x);"/></svg>`,
      { cssValidator: safeCssValidator },
    )).toThrow('Unsafe Mermaid SVG')
  })

  it('staticizes Mermaid edge animation rules in a direct root stylesheet', () => {
    const result = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@keyframes dash { to { stroke-dashoffset: 0; } } .edge { animation: dash 2s linear infinite; transition: stroke 200ms; stroke: #333; stroke-dasharray: 5; }</style><path class="edge" d="M0 0L1 1"/></svg>',
      { cssValidator: safeCssValidator },
    )

    expect(result).not.toMatch(/@keyframes|animation\s*:|transition\s*:/i)
    expect(result).toContain('stroke: #333')
    expect(result).toContain('stroke-dasharray: 5')
  })

  it('staticizes animation and transition declarations in inline style', () => {
    const result = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1" style="stroke: #333; animation-name: dash; animation-duration: 2s; transition-property: stroke; -moz-animation: dash 2s; -o-transition: stroke 1s;"/></svg>',
      { cssValidator: safeCssValidator },
    )

    expect(result).not.toMatch(/animation|transition/i)
    expect(result).toContain('style="stroke: #333;"')
  })

  it('rejects multiple or nested style elements', () => {
    expect(() => sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:red}</style><style>.b{fill:blue}</style></svg>',
      { cssValidator: safeCssValidator },
    )).toThrow('Unsafe Mermaid SVG')
    expect(() => sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><g><style>.a{fill:red}</style></g></svg>',
      { cssValidator: safeCssValidator },
    )).toThrow('Unsafe Mermaid SVG')
  })
})

describe('svgToDataUrl', () => {
  it('encodes Unicode as exact UTF-8 data image bytes', () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><text>中文🙂</text></svg>'
    const dataUrl = svgToDataUrl(source)
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(dataUrl.split(',')[1]!), (char) => char.charCodeAt(0)),
    )

    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(decoded).toBe(source)
  })

  it('rejects SVG data larger than the configured UTF-8 byte limit', () => {
    expect(() => svgToDataUrl(`<!--${'🙂'.repeat(600_000)}-->`)).toThrow('Mermaid SVG is too large')
  })
})
