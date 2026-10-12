import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import { transformRendererCsp } from '../../src/renderer/csp-policy'
import { MermaidImageExportService } from '../../src/main/assets/mermaid-image-export-service'

const FIXTURE_PATH = '/__mermaid-node-view-fixture'
const VIRTUAL_ENTRY_PATH = '/__mermaid-node-view-fixture-entry.ts'
const RESOLVED_ENTRY_ID = '\0virtual:mermaid-node-view-fixture-entry'
const SHADOW_PATH = '/__mermaid-shadow-canary'
const VIRTUAL_SHADOW_ENTRY_PATH = '/__mermaid-shadow-canary-entry.ts'
const RESOLVED_SHADOW_ENTRY_ID = '\0virtual:mermaid-shadow-canary-entry'
const productionRendererHtml = transformRendererCsp(
  readFileSync(resolve(process.cwd(), 'src/renderer/index.html'), 'utf8'),
  'build',
)
const productionCspMatch = productionRendererHtml.match(
  /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
)
if (!productionCspMatch) throw new Error('Production renderer CSP meta content not found')
const PRODUCTION_CSP = productionCspMatch[1]!

const inertViteClientModule = String.raw`
const styles = new Map()
export function createHotContext() {
  return {
    accept() {}, acceptExports() {}, decline() {}, dispose() {}, prune() {}, invalidate() {},
    on() {}, off() {}, send() {},
  }
}
export function updateStyle(id, content) {
  let style = styles.get(id)
  if (!style) {
    style = document.createElement('style')
    style.setAttribute('data-vite-dev-id', id)
    document.head.append(style)
    styles.set(id, style)
  }
  style.textContent = content
}
export function removeStyle(id) {
  styles.get(id)?.remove()
  styles.delete(id)
}
export function injectQuery(url) { return url }
export class ErrorOverlay extends HTMLElement {}
`

const fixtureModule = String.raw`
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { VisualEditor } from '/src/renderer/editor/VisualEditor.tsx'
import { SourceEditor } from '/src/renderer/editor/SourceEditor.tsx'
import { EditorView as CodeMirror } from '@codemirror/view'
import { ContextMenuProvider } from '/src/renderer/context-menu/ContextMenuProvider.tsx'
import { TooltipProvider } from '/src/renderer/tooltip/TooltipProvider.tsx'
import '/src/renderer/app/styles.css'

const h = React.createElement
const fence = String.fromCharCode(96).repeat(3)
const initialMarkdown = [
  '# Mermaid browser fixture',
  '',
  fence + 'mermaid',
  'flowchart LR',
  '  A["你好 🌟"] --> B["完成 ✅"]',
  fence,
  '',
  fence + 'mermaid',
  'sequenceDiagram',
  '  participant User',
  '  participant Service',
  '  User->>Service: Request',
  '  Service-->>User: Response',
  fence,
  '',
  fence + 'mermaid',
  'classDiagram',
  '  Animal <|-- Duck',
  fence,
  '',
  fence + 'mermaid',
  'stateDiagram-v2',
  '  [*] --> Idle',
  '  Idle --> Running',
  '  Running --> [*]',
  fence,
  '',
  fence + 'mermaid',
  'erDiagram',
  '  CUSTOMER ||--o{ ORDER : places',
  '  ORDER {',
  '    string id',
  '  }',
  fence,
  '',
  fence + 'mermaid',
  'gantt',
  '  title Release plan',
  '  dateFormat YYYY-MM-DD',
  '  section Build',
  '  Task one :done, a1, 2026-08-01, 2d',
  fence,
  '',
  fence + 'mermaid',
  'not-a-real-diagram @@@',
  fence,
  '',
  fence + 'typescript',
  'const ordinaryCode = "unchanged"',
  fence,
  '',
  '$$',
  'E = mc^2',
  '$$',
].join('\n')

const lightAppearance = Object.freeze({
  revision: 1,
  editorTheme: 'minimal',
  colorScheme: 'light',
  themeColor: '#336699',
  bodyFontFamily: '"Arial", "Microsoft YaHei"',
})
const darkAppearance = Object.freeze({
  ...lightAppearance,
  revision: 2,
  colorScheme: 'dark',
  themeColor: '#cc5500',
})

window.arkdown = {
  readClipboardFormats: async () => ({
    ok: true,
    value: { plainText: '', markdown: null, html: null },
  }),
  copyMermaidImage: async (pngDataUrl) => {
    window.__arkdownMermaidCopyPayload = pngDataUrl
    return { ok: true, value: null }
  },
  saveMermaidImage: async (payload) => {
    window.__arkdownMermaidSavePayload = payload
    return { ok: true, value: null }
  },
}

function Fixture() {
  const [markdown, setMarkdown] = useState(initialMarkdown)
  const [mode, setMode] = useState('visual')
  const [editorRevision, setEditorRevision] = useState(0)
  const [appearance, setAppearance] = useState(lightAppearance)
  window.__fixtureMarkdown = markdown
  window.__fixtureSourceEndpoints = () => {
    const cm = CodeMirror.findFromDOM(document.querySelector('.source-editor .cm-editor'))
    return {
      from: cm.state.selection.main.from,
      to: cm.state.selection.main.to,
      length: cm.state.doc.length,
      start: cm.coordsAtPos(0),
      end: cm.coordsAtPos(cm.state.doc.length),
    }
  }
  window.__fixtureVirtualizeSourceEndpoint = () => {
    const cm = CodeMirror.findFromDOM(document.querySelector('.source-editor .cm-editor'))
    const coordsAtPos = cm.coordsAtPos.bind(cm)
    // Exercise CodeMirror's documented nullable geometry boundary without faking selection.
    cm.coordsAtPos = (position, side) => position === 0 ? null : coordsAtPos(position, side)
  }

  const rebuildLanguage = (from, to) => {
    document.body.removeAttribute('data-editor-ready')
    setMarkdown((current) => current.replace(fence + from, fence + to))
    setEditorRevision((current) => current + 1)
  }

  return h('main', {
    'data-testid': 'fixture',
    style: {
      boxSizing: 'border-box',
      minInlineSize: 0,
      height: '100vh',
      overflow: 'auto',
      padding: '16px',
    },
  },
  h('nav', { 'aria-label': 'Mermaid fixture controls' },
    h('button', {
      'data-testid': 'scroll-regression',
      onClick: () => {
        document.body.removeAttribute('data-editor-ready')
        setMarkdown([
          '# Scroll regression', '',
          ...Array.from({ length: 80 }, (_, index) => 'Paragraph before ' + index + '.\n'),
          fence, 'flowchart LR', '  Before --> After', fence, '',
          ...Array.from({ length: 80 }, (_, index) => 'Paragraph after ' + index + '.\n'),
        ].join('\n'))
        setEditorRevision((current) => current + 1)
      },
    }, 'Long code document'),
    h('button', {
      'data-testid': 'translation-source',
      onClick: () => {
        setMode('source')
        setMarkdown(Array.from({ length: 4000 }, (_, index) => 'Line ' + index + ' translation text').join('\n'))
      },
    }, 'Long source'),
    h('button', {
      'data-testid': 'translation-visual',
      onClick: () => {
        setMode('visual')
        setMarkdown('# Full document\n\nFirst paragraph.\n\nLast paragraph.')
        setEditorRevision((current) => current + 1)
      },
    }, 'Visual document'),
    h('button', {
      type: 'button',
      'data-testid': 'theme-refresh',
      onClick: () => setAppearance((current) => current.colorScheme === 'light'
        ? darkAppearance
        : lightAppearance),
    }, '刷新主题'),
    h('button', {
      type: 'button',
      'data-testid': 'switch-to-javascript',
      onClick: () => rebuildLanguage('mermaid', 'javascript'),
    }, '外部 Markdown 更新为 JavaScript'),
    h('button', {
      type: 'button',
      'data-testid': 'switch-to-mermaid',
      onClick: () => rebuildLanguage('javascript', 'mermaid'),
    }, '外部 Markdown 更新为 Mermaid')),
  h('div', { id: 'host-svg-sentinel', style: { color: 'rgb(17, 34, 51)', inlineSize: '60px' } },
    h('svg', { width: 40, height: 20, viewBox: '0 0 40 20' },
      h('path', { d: 'M1 1 L39 19', fill: 'none', stroke: 'currentColor', strokeWidth: 2 }))),
  h(mode === 'source' ? SourceEditor : VisualEditor, {
    key: editorRevision,
    markdown,
    mermaidAppearance: appearance,
    onChange: setMarkdown,
    onTranslationSelection(selection) { window.__fixtureTranslation = selection },
    onReady() { document.body.dataset.editorReady = 'true' },
  }))
}

createRoot(document.querySelector('#fixture-root')).render(
  h(TooltipProvider, null, h(ContextMenuProvider, null, h(Fixture))),
)
`

const shadowCanaryModule = String.raw`
import { sanitizeMermaidSvg, svgToDataUrl } from '/src/renderer/editor/mermaid/mermaid-svg-sanitizer.ts'

const raw = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="32" viewBox="0 0 40 32">'
  + '<defs><filter id="shadow" x="-100%" y="-100%" width="400%" height="400%">'
  + '<feDropShadow dx="14" dy="0" stdDeviation="0" flood-color="#ff0000" flood-opacity="1"/>'
  + '</filter></defs><rect x="4" y="10" width="8" height="12" fill="#000000" filter="url(#shadow)"/>'
  + '</svg>'
const safe = sanitizeMermaidSvg(raw)
const image = document.createElement('img')
image.alt = 'Sanitized drop shadow canary'
image.dataset.testid = 'shadow-canary-image'
image.src = svgToDataUrl(safe)
document.body.append(image)
await image.decode()
const canvas = document.createElement('canvas')
canvas.dataset.testid = 'shadow-canary-canvas'
canvas.width = 40
canvas.height = 32
document.body.append(canvas)
const context = canvas.getContext('2d', { willReadFrequently: true })
context.drawImage(image, 0, 0, 40, 32)
const parsed = new DOMParser().parseFromString(safe, 'image/svg+xml')
const filterNode = Array.from(parsed.querySelectorAll('*')).find(
  (element) => element.localName.toLowerCase() === 'fedropshadow',
)
const reference = parsed.querySelector('rect')?.getAttribute('filter') ?? null
const result = document.createElement('output')
result.dataset.testid = 'shadow-canary-result'
result.textContent = JSON.stringify({
  localName: filterNode?.localName ?? null,
  reference,
  sourcePixel: Array.from(context.getImageData(7, 16, 1, 1).data),
  shadowPixel: Array.from(context.getImageData(21, 16, 1, 1).data),
  backgroundPixel: Array.from(context.getImageData(32, 16, 1, 1).data),
})
document.body.append(result)
document.body.dataset.shadowReady = 'true'
`

interface Diagnostics {
  externalRequests: string[]
  websockets: string[]
  cspMessages: string[]
  pageErrors: string[]
}

interface SvgInspection {
  root: string
  text: string
  styleRuleCount: number
  forbiddenElement: string | null
  unsafeReference: string | null
  dropShadowLocalNames: string[]
  cssDropShadowFilters: string[]
  lightAppearancePaintCount: number
  darkAppearancePaintCount: number
  paintEvidence: string[]
}

let vite: ViteDevServer | undefined
let fixtureUrl = ''
let fixtureOrigin = ''

function isFixtureTransport(url: string): boolean {
  const target = new URL(url)
  const fixture = new URL(fixtureOrigin)
  if (target.protocol === 'http:' || target.protocol === 'https:') {
    return target.origin === fixture.origin
  }
  return (target.protocol === 'ws:' || target.protocol === 'wss:')
    && target.host === fixture.host
}

test.beforeAll(async () => {
  vite = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      hmr: false,
      ws: false,
    },
    plugins: [{
      name: 'mermaid-node-view-playwright-fixture',
      resolveId(id) {
        if (id === VIRTUAL_ENTRY_PATH) return RESOLVED_ENTRY_ID
        if (id === VIRTUAL_SHADOW_ENTRY_PATH) return RESOLVED_SHADOW_ENTRY_ID
        return undefined
      },
      load(id) {
        if (id === RESOLVED_ENTRY_ID) return fixtureModule
        if (id === RESOLVED_SHADOW_ENTRY_ID) return shadowCanaryModule
        return undefined
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const pathname = request.url?.split('?')[0]
          if (pathname === '/@vite/client') {
            response.statusCode = 200
            response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
            response.end(inertViteClientModule)
            return
          }
          if (pathname !== FIXTURE_PATH && pathname !== SHADOW_PATH) {
            next()
            return
          }
          const entry = pathname === SHADOW_PATH ? VIRTUAL_SHADOW_ENTRY_PATH : VIRTUAL_ENTRY_PATH
          const html = `<!doctype html>
            <html lang="zh-CN"><head><meta charset="UTF-8" />
              <meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />
              <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            </head><body style="margin:0;overflow:hidden">
              <div id="fixture-root"></div>
              <script type="module" src="${entry}"></script>
            </body></html>`
          response.statusCode = 200
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.end(html)
        })
      },
    }],
  })
  await vite.listen()
  await vite.warmupRequest(VIRTUAL_ENTRY_PATH)
  await vite.waitForRequestsIdle()
  const address = vite.httpServer?.address() as AddressInfo | null
  if (!address || typeof address === 'string') throw new Error('Ephemeral Vite address unavailable')
  fixtureOrigin = `http://127.0.0.1:${address.port}`
  fixtureUrl = `${fixtureOrigin}${FIXTURE_PATH}`
})

test.afterAll(async () => {
  await vite?.close()
  vite = undefined
})

async function openFixture(page: Page): Promise<Diagnostics> {
  const diagnostics: Diagnostics = {
    externalRequests: [],
    websockets: [],
    cspMessages: [],
    pageErrors: [],
  }
  page.on('request', (request) => {
    const url = request.url()
    if (!url.startsWith('data:') && !isFixtureTransport(url)) {
      diagnostics.externalRequests.push(url)
    }
  })
  page.on('websocket', (socket) => {
    if (!isFixtureTransport(socket.url())) diagnostics.websockets.push(socket.url())
  })
  page.on('console', (message) => {
    if (/content security policy|refused to|\bcsp\b/i.test(message.text())) {
      diagnostics.cspMessages.push(message.text())
    }
  })
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message))
  await page.addInitScript(() => {
    const violations: string[] = []
    Object.defineProperty(window, '__arkdownCspViolations', { value: violations })
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(`${event.effectiveDirective}:${event.blockedURI}`)
    })
  })
  await page.route('**/*', async (route) => {
    const url = route.request().url()
    if (url.startsWith('data:') || isFixtureTransport(url)) await route.continue()
    else {
      diagnostics.externalRequests.push(url)
      await route.abort('blockedbyclient')
    }
  })

  await page.goto(fixtureUrl)
  await expect(page.locator('body')).toHaveAttribute('data-editor-ready', 'true')
  await expect(page.locator('.arkdown-mermaid-block')).toHaveCount(7)
  await expect(page.locator('.milkdown-code-block')).toHaveCount(2)
  return diagnostics
}

function stockBlock(page: Page, sourceText: string): Locator {
  return page.locator('.milkdown-code-block').filter({ hasText: sourceText })
}

async function inspectImage(image: Locator): Promise<SvgInspection> {
  return image.evaluate((element) => {
    const source = (element as HTMLImageElement).src
    const encoded = source.slice(source.indexOf(',') + 1)
    const binary = atob(encoded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const svg = new TextDecoder().decode(bytes)
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const compactSvg = svg.toLowerCase().replace(/\s+/g, '')
    const lightAppearancePaints = [
      ['#ffffff', '#fff', 'rgb(255,255,255)'],
      ['#f4f6f8', 'rgb(244,246,248)'],
      ['#20242a', 'rgb(32,36,42)'],
      ['#5b6571', 'rgb(91,101,113)'],
    ]
    const darkAppearancePaints = [
      ['#17191d', 'rgb(23,25,29)'],
      ['#242830', 'rgb(36,40,48)'],
      ['#f3f4f6', 'rgb(243,244,246)'],
      ['#7d8794', 'rgb(125,135,148)'],
    ]
    const root = parsed.documentElement
    const rootStyle = Array.from(root.children).find(
      (child) => child.localName.toLowerCase() === 'style',
    )
    let styleRuleCount = 0
    if (rootStyle?.textContent) {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(rootStyle.textContent)
      styleRuleCount = sheet.cssRules.length
    }
    const allElements = [root, ...Array.from(root.querySelectorAll('*'))]
    const unsafeAttribute = allElements.flatMap(
      (node) => Array.from(node.attributes),
    ).find((attribute) => (
      !attribute.name.toLowerCase().startsWith('xmlns')
      && /(?:https?|data|file):|^\s*\/\//i.test(attribute.value)
    ))
    const unsafeCss = rootStyle?.textContent?.match(/(?:https?|data|file):|\/\//i)?.[0]
    const forbidden = allElements.find((node) => new Set([
      'script', 'foreignobject', 'iframe', 'object', 'embed', 'image',
      'animate', 'animatemotion', 'animatetransform',
    ]).has(node.localName.toLowerCase()))
    return {
      root: root.localName,
      text: root.textContent ?? '',
      styleRuleCount,
      forbiddenElement: forbidden?.localName ?? null,
      unsafeReference: unsafeAttribute
        ? `${unsafeAttribute.name}=${unsafeAttribute.value}`
        : unsafeCss ?? null,
      dropShadowLocalNames: allElements
        .filter((node) => node.localName.toLowerCase() === 'fedropshadow')
        .map((node) => node.localName),
      cssDropShadowFilters: Array.from(
        rootStyle?.textContent?.matchAll(/\bfilter\s*:\s*(drop-shadow\([^;{}]+);/gi) ?? [],
        (match) => match[1]!.trim(),
      ),
      lightAppearancePaintCount: lightAppearancePaints.filter(
        (equivalents) => equivalents.some((paint) => compactSvg.includes(paint)),
      ).length,
      darkAppearancePaintCount: darkAppearancePaints.filter(
        (equivalents) => equivalents.some((paint) => compactSvg.includes(paint)),
      ).length,
      paintEvidence: Array.from(new Set(
        svg.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]+\)/gi) ?? [],
      )).slice(0, 80),
    }
  })
}

async function sentinelSnapshot(page: Page) {
  return page.locator('#host-svg-sentinel').evaluate((host) => {
    const path = host.querySelector('path')!
    const image = host.querySelector('svg')!
    const style = getComputedStyle(path)
    const rect = image.getBoundingClientRect()
    return {
      display: style.display,
      fill: style.fill,
      opacity: style.opacity,
      stroke: style.stroke,
      width: rect.width,
      height: rect.height,
    }
  })
}

async function waitForSafeImage(block: Locator): Promise<Locator> {
  await block.scrollIntoViewIfNeeded()
  const image = block.locator(
    '.arkdown-mermaid-preview > img[src^="data:image/svg+xml;base64,"]',
  )
  await expect(image).toBeVisible()
  await expect(block.locator('svg')).toHaveCount(0)
  return image
}

async function expectCleanDiagnostics(page: Page, diagnostics: Diagnostics) {
  const cspViolations = await page.evaluate(
    () => (window as typeof window & { __arkdownCspViolations?: string[] }).__arkdownCspViolations ?? [],
  )
  expect(diagnostics.externalRequests).toEqual([])
  expect(diagnostics.websockets).toEqual([])
  expect(diagnostics.cspMessages).toEqual([])
  expect(cspViolations).toEqual([])
  expect(diagnostics.pageErrors).toEqual([])
}

test('keeps sanitized drop-shadow casing and a visible rasterized shadow', async ({ page }) => {
  await page.goto(`${fixtureOrigin}${SHADOW_PATH}`)
  await expect(page.locator('body')).toHaveAttribute('data-shadow-ready', 'true')
  await expect(page.getByTestId('shadow-canary-image'))
    .toHaveAttribute('src', /^data:image\/svg\+xml;base64,/)
  const result = JSON.parse(
    await page.getByTestId('shadow-canary-result').textContent() ?? '{}',
  ) as {
    localName: string | null
    reference: string | null
    sourcePixel: number[]
    shadowPixel: number[]
    backgroundPixel: number[]
  }

  expect(result.localName).toBe('feDropShadow')
  expect(result.reference).toMatch(/^url\(#[A-Za-z_][A-Za-z0-9_.:-]*\)$/)
  expect(result.sourcePixel).toEqual([0, 0, 0, 255])
  expect(result.shadowPixel[0]).toBeGreaterThanOrEqual(240)
  expect(result.shadowPixel[1]).toBeLessThanOrEqual(15)
  expect(result.shadowPixel[2]).toBeLessThanOrEqual(15)
  expect(result.shadowPixel[3]).toBeGreaterThanOrEqual(240)
  expect(result.backgroundPixel[3]).toBe(0)
})

test('keeps invalid-source, stock-block, host isolation, and zero-external-network contracts', async ({ page }) => {
  const diagnostics = await openFixture(page)
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]'))
    .toHaveAttribute('content', PRODUCTION_CSP)
  expect(PRODUCTION_CSP).not.toMatch(/blob:|https:|unsafe-eval/)
  await expect(stockBlock(page, 'ordinaryCode')).toContainText('ordinaryCode')
  await expect(stockBlock(page, 'E = mc^2')).toContainText('E = mc^2')

  const sentinelBefore = await sentinelSnapshot(page)
  const invalid = page.locator('.arkdown-mermaid-block').nth(6)
  await invalid.scrollIntoViewIfNeeded()
  const error = invalid.locator('.arkdown-mermaid-preview[role="alert"]')
  await expect(error).toContainText('Mermaid 语法错误')
  await expect(error).not.toContainText('not-a-real-diagram')
  await expect(invalid.locator('img, svg')).toHaveCount(0)
  await error.getByRole('button', { name: '编辑源码' }).click()
  const source = invalid.locator('.cm-content')
  await source.click()
  await expect(source).toBeFocused()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(' keyboard-edit')
  await expect(source).toContainText('keyboard-edit')

  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('flowchart LR\n  Recover["Recovered"] --> Ready["Ready"]')
  const recoveredImage = invalid.locator(
    '.arkdown-mermaid-preview > img[src^="data:image/svg+xml;base64,"]',
  )
  await expect(recoveredImage).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/)
  await expect(invalid.locator('.arkdown-mermaid-preview[role="alert"]')).toHaveCount(0)
  expect((await inspectImage(recoveredImage)).text).toContain('Recovered')
  await invalid.getByRole('button', { name: '显示图形' }).click()
  await expect(recoveredImage).toBeVisible()

  expect(await sentinelSnapshot(page)).toEqual(sentinelBefore)
  await expect(page.locator('.arkdown-mermaid-block svg')).toHaveCount(0)
  await expectCleanDiagnostics(page, diagnostics)
})

test('converts an ordinary code block with the fish-tail toolbar control', async ({ page }) => {
  const diagnostics = await openFixture(page)
  const ordinary = stockBlock(page, 'ordinaryCode')
  await ordinary.scrollIntoViewIfNeeded()

  const languageButton = ordinary.locator('.language-button')
  const convertButton = ordinary.getByRole('button', {
    name: '将此代码块转换为 Mermaid 图形',
  })
  await expect(convertButton).toBeVisible()
  await expect(convertButton.locator('svg')).toHaveAttribute('fill', 'none')
  await expect(convertButton.locator('svg')).toHaveAttribute('stroke', 'currentColor')
  const aiButton = ordinary.locator('.arkdown-code-explanation-button')
  const tools = ordinary.locator('.tools')
  const group = tools.locator('.tools-button-group')
  const layout = await tools.evaluate((element) => {
    const rect = (selector: string) => element.querySelector(selector)!.getBoundingClientRect()
    const language = rect('.language-button')
    const mermaid = rect('.arkdown-mermaid-convert-button')
    const ai = rect('.arkdown-code-explanation-button')
    const trailing = rect('.tools-button-group')
    return {
      languageGap: mermaid.left - language.right,
      aiGap: ai.left - mermaid.right,
      trailingRight: trailing.right,
      toolsRight: element.getBoundingClientRect().right,
    }
  })
  await expect(aiButton).toBeVisible()
  await expect(group).toBeVisible()
  expect(layout.languageGap).toBeCloseTo(8, 0)
  expect(layout.aiGap).toBeCloseTo(8, 0)
  expect(layout.trailingRight).toBeCloseTo(layout.toolsRight, 0)
  expect(await languageButton.evaluate((button) => (
    button.nextElementSibling?.classList.contains('arkdown-mermaid-convert-button')
  ))).toBe(true)

  const source = ordinary.locator('.cm-content')
  await source.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('flowchart LR\n  ConvertFish["Code"] --> Ready["Mermaid"]')
  await stockBlock(page, 'ConvertFish').getByRole('button', {
    name: '将此代码块转换为 Mermaid 图形',
  }).click()

  await expect(page.locator('.arkdown-mermaid-block')).toHaveCount(8)
  const converted = page.locator('.arkdown-mermaid-block').last()
  const image = await waitForSafeImage(converted)
  const inspection = await inspectImage(image)
  expect(inspection.text).toContain('Code')
  expect(inspection.text).toContain('Mermaid')
  await expectCleanDiagnostics(page, diagnostics)
})

test('keeps the viewport at the code block when converting with a previous selection at the heading', async ({ page }) => {
  const diagnostics = await openFixture(page)
  await page.getByTestId('scroll-regression').click()
  await expect(page.locator('body')).toHaveAttribute('data-editor-ready', 'true')
  await page.locator('.ProseMirror h1').click()
  const ordinary = stockBlock(page, 'Before --> After')
  await ordinary.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  const scroller = page.getByTestId('fixture')
  const before = await scroller.evaluate((element) => element.scrollTop)
  expect(before).toBeGreaterThan(500)
  const top = (await ordinary.boundingBox())!.y
  await ordinary.getByRole('button', { name: '将此代码块转换为 Mermaid 图形' }).click()
  const converted = page.locator('.arkdown-mermaid-block')
  await expect(converted).toHaveCount(1)
  expect(Math.abs(await scroller.evaluate((element) => element.scrollTop) - before)).toBeLessThan(32)
  await expect(converted.locator('.arkdown-mermaid-preview > img')).toBeVisible()
  expect(Math.abs((await converted.boundingBox())!.y - top)).toBeLessThan(32)
  await converted.getByRole('button', { name: '返回普通代码块' }).click()
  await expect(ordinary).toBeVisible()
  expect(Math.abs(await scroller.evaluate((element) => element.scrollTop) - before)).toBeLessThan(32)
  expect(Math.abs((await ordinary.boundingBox())!.y - top)).toBeLessThan(32)
  await expectCleanDiagnostics(page, diagnostics)
})

test('uses Arkdown tooltips on code controls and dismisses them on pointer press', async ({ page }) => {
  const diagnostics = await openFixture(page)
  await page.getByTestId('scroll-regression').click()
  await expect(page.locator('body')).toHaveAttribute('data-editor-ready', 'true')
  const ordinary = stockBlock(page, 'Before --> After')
  await ordinary.scrollIntoViewIfNeeded()
  const button = ordinary.getByRole('button', { name: '将此代码块转换为 Mermaid 图形' })
  await expect(button).not.toHaveAttribute('title')
  await button.hover()
  await expect(page.locator('.global-tooltip')).toHaveText('将此代码块转换为 Mermaid 图形')
  await button.click()
  await expect(page.locator('.global-tooltip')).toHaveCount(0)
  await expectCleanDiagnostics(page, diagnostics)
})

test('returns from preview with a left aligned control and preserves Markdown through undo and redo', async ({ page }) => {
  const diagnostics = await openFixture(page)
  const block = page.locator('.arkdown-mermaid-block').first()
  const back = block.getByRole('button', { name: '返回普通代码块' })
  await expect(back).toBeVisible()
  const backBox = await back.boundingBox()
  const toolbarBox = await block.locator('.arkdown-mermaid-toolbar').boundingBox()
  expect(backBox!.x - toolbarBox!.x).toBeCloseTo(10, 0)
  const before = await page.evaluate(() => (window as any).__fixtureMarkdown)
  await back.click()
  await expect.poll(() => page.evaluate(() => (window as any).__fixtureMarkdown.trimEnd()))
    .toBe(before.replace('```mermaid', '```').trimEnd())
  const after = await page.evaluate(() => (window as any).__fixtureMarkdown)
  await page.locator('.ProseMirror').focus()
  await page.keyboard.press('Control+z')
  await expect.poll(() => page.evaluate(() => (window as any).__fixtureMarkdown.trimEnd())).toBe(before.trimEnd())
  await expect(page.locator('.arkdown-mermaid-block')).toHaveCount(7)
  await page.keyboard.press('Control+y')
  await expect.poll(() => page.evaluate(() => (window as any).__fixtureMarkdown)).toBe(after)
  await expect(page.locator('.arkdown-mermaid-block')).toHaveCount(6)
  await expectCleanDiagnostics(page, diagnostics)
})

test('uses the Mermaid-only context menu and omits generic image actions', async ({ page }) => {
  const diagnostics = await openFixture(page)
  const first = page.locator('.arkdown-mermaid-block').first()
  const image = await waitForSafeImage(first)
  const originalMarkdown = await page.evaluate(() => (window as any).__fixtureMarkdown)

  await image.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: '右键菜单' })
  await expect(menu).toBeVisible()
  for (const label of [
    '编辑源码',
    '复制图形',
    '图形另存为…',
    '复制 Mermaid 源码',
    '复制为 Mermaid Markdown',
  ]) {
    await expect(menu.getByRole('menuitem', { name: label, exact: true })).toBeVisible()
  }
  for (const removedLabel of [
    '在资源管理器中显示',
    '复制图片到…',
    '复制图片地址',
    '编辑替代文本…',
    '删除图片引用',
  ]) {
    await expect(menu.getByRole('menuitem', { name: removedLabel, exact: true })).toHaveCount(0)
  }

  await menu.getByRole('menuitem', { name: '复制图形', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __arkdownMermaidCopyPayload?: string })
      .__arkdownMermaidCopyPayload ?? ''
  ))).toMatch(/^data:image\/png;base64,/)
  const copiedPngSize = await page.evaluate(async () => {
    const source = (window as typeof window & { __arkdownMermaidCopyPayload: string })
      .__arkdownMermaidCopyPayload
    const png = new Image()
    png.src = source
    await png.decode()
    return { width: png.naturalWidth, height: png.naturalHeight }
  })
  expect(copiedPngSize.width).toBeGreaterThan(0)
  expect(copiedPngSize.height).toBeGreaterThan(0)
  await expect(first).toHaveAttribute('data-arkdown-mermaid-mode', 'preview')
  expect(await page.evaluate(() => (window as any).__fixtureMarkdown)).toBe(originalMarkdown)

  await image.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: '图形另存为…', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & {
      __arkdownMermaidSavePayload?: { svgDataUrl: string; pngDataUrl: string }
    }).__arkdownMermaidSavePayload ?? null
  ))).toMatchObject({
    svgDataUrl: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
    pngDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
  })
  const exportPayload = await page.evaluate(() => (
    (window as typeof window & {
      __arkdownMermaidSavePayload: { svgDataUrl: string; pngDataUrl: string }
    }).__arkdownMermaidSavePayload
  ))
  let exportExtension: 'svg' | 'png' = 'svg'
  const written = new Map<string, Buffer>()
  const mainExport = new MermaidImageExportService({
    createNativeImage: () => ({
      isEmpty: () => false,
      getSize: () => copiedPngSize,
      toPNG: () => Buffer.from(exportPayload.pngDataUrl.split(',')[1]!, 'base64'),
    }),
    writeClipboardImage: () => undefined,
    chooseTarget: async () => `C:\\exports\\diagram.${exportExtension}`,
    writeFileAtomic: async (target, bytes) => { written.set(target, bytes) },
  })
  await expect(mainExport.save(exportPayload)).resolves.toBe('C:\\exports\\diagram.svg')
  exportExtension = 'png'
  await expect(mainExport.save(exportPayload)).resolves.toBe('C:\\exports\\diagram.png')
  expect(written.get('C:\\exports\\diagram.svg')?.toString('utf8')).toMatch(/^<svg\b/)
  expect(written.get('C:\\exports\\diagram.png')?.subarray(0, 8))
    .toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  await expect(first).toHaveAttribute('data-arkdown-mermaid-mode', 'preview')

  // A canceled native save resolves with null; closing the actual menu must keep preview.
  await page.evaluate(() => {
    (window as any).__arkdownMermaidSavePayload = null
    window.arkdown.saveMermaidImage = async (payload) => {
      ;(window as any).__arkdownMermaidSavePayload = payload
      return { ok: true, value: null }
    }
  })
  await image.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: '图形另存为…', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__arkdownMermaidSavePayload)).not.toBeNull()
  await expect(first).toHaveAttribute('data-arkdown-mermaid-mode', 'preview')
  await image.click({ button: 'right' })
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(first).toHaveAttribute('data-arkdown-mermaid-mode', 'preview')
  expect(await page.evaluate(() => (window as any).__fixtureMarkdown)).toBe(originalMarkdown)

  await image.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: '编辑源码', exact: true }).click()
  const source = first.locator('.cm-content')
  await expect(source).toBeVisible()
  await source.click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: '显示图形', exact: true })).toBeVisible()
  await expectCleanDiagnostics(page, diagnostics)
})

for (const mode of ['source', 'source-null-endpoint', 'visual'] as const) {
test(`selects the actual complete ${mode} document with Ctrl+A and preserves undo`, async ({ page }) => {
  const diagnostics = await openFixture(page)
    const editorMode = mode === 'visual' ? 'visual' : 'source'
    await page.getByTestId('translation-' + editorMode).click()
    const editor = editorMode === 'source'
      ? page.locator('.source-editor .cm-content')
      : page.locator('.ProseMirror')
    await expect(editor).toBeVisible()
    await editor.click()
    await page.keyboard.press('Control+End')
    const original = await page.evaluate(() => (window as any).__fixtureMarkdown)
    await page.keyboard.insertText('Undo marker')
    await expect.poll(() => page.evaluate(() => (window as any).__fixtureMarkdown)).toContain('Undo marker')
    const edited = await page.evaluate(() => (window as any).__fixtureMarkdown)
    if (mode === 'source-null-endpoint') {
      await page.evaluate(() => (window as any).__fixtureVirtualizeSourceEndpoint())
    }
    await page.keyboard.press('Control+A')
    await expect.poll(() => page.evaluate(() => (window as any).__fixtureTranslation?.scope)).toBe('document')
    const selection = await page.evaluate(() => (window as any).__fixtureTranslation)
    expect(selection.mode).toBe(editorMode)
    expect(selection.content.markdown.trim()).toBe(edited.trim())
    if (editorMode === 'source') {
      const endpoints = await page.evaluate(() => (window as any).__fixtureSourceEndpoints())
      expect(endpoints.from).toBe(0)
      expect(endpoints.to).toBe(endpoints.length)
      if (mode === 'source-null-endpoint') expect(endpoints.start).toBeNull()
    }
    await page.keyboard.press('Escape')
    expect(await page.evaluate(() => (window as any).__fixtureMarkdown)).toBe(edited)
    await editor.focus()
    await page.keyboard.press('Control+z')
    await expect.poll(() => page.evaluate(() => (window as any).__fixtureMarkdown.trimEnd())).toBe(original.trimEnd())
    await page.keyboard.press('Control+y')
    await expect.poll(() => page.evaluate(() => (window as any).__fixtureMarkdown)).toBe(edited)
  await expectCleanDiagnostics(page, diagnostics)
})
}

test('pastes a complete fenced selection as one Mermaid block from the submenu', async ({ page }) => {
  const diagnostics = await openFixture(page)
  await page.evaluate(() => {
    window.arkdown.readClipboardFormats = async () => ({
      ok: true,
      value: {
        plainText: [
          '```typescript',
          'flowchart LR',
          '  PasteMenu["Pasted"] --> Diagram["Diagram"]',
          '```',
        ].join('\n'),
        markdown: null,
        html: null,
      },
    })
  })

  await page.getByRole('heading', { name: 'Mermaid browser fixture' }).click({ button: 'right' })
  const clipboardSubmenu = page.getByRole('menuitem', { name: '复制 / 粘贴为…', exact: true })
  await clipboardSubmenu.hover()
  const pasteMermaid = page.getByRole('menuitem', { name: '粘贴为 Mermaid 图形', exact: true })
  await expect(pasteMermaid).toBeEnabled()
  await pasteMermaid.click()

  await expect(page.locator('.arkdown-mermaid-block')).toHaveCount(8)
  const pasted = page.locator('.arkdown-mermaid-block').first()
  expect(await pasted.evaluate((block) => {
    const preview = block.querySelector<HTMLElement>('.arkdown-mermaid-preview')
    return {
      mode: block.getAttribute('data-arkdown-mermaid-mode'),
      previewVisible: preview !== null
        && !preview.hidden
        && getComputedStyle(preview).display !== 'none',
      sourceEditorPresent: block.querySelector('.cm-editor') !== null,
    }
  })).toEqual({
    mode: 'preview',
    previewVisible: true,
    sourceEditorPresent: false,
  })
  const pastedImage = await waitForSafeImage(pasted)
  const inspection = await inspectImage(pastedImage)
  expect(inspection.text).toContain('Pasted')
  expect(inspection.text).toContain('Diagram')
  await expectCleanDiagnostics(page, diagnostics)
})

test('renders, edits, refreshes, and rebuilds after external Markdown updates under production CSP', async ({ page }, testInfo) => {
  const diagnostics = await openFixture(page)
  expect(await page.evaluate(() => devicePixelRatio)).toBe(
    Number(testInfo.project.metadata.requestedDpr),
  )
  const sentinelBefore = await sentinelSnapshot(page)

  await expect(stockBlock(page, 'ordinaryCode')).toContainText('ordinaryCode')
  await expect(stockBlock(page, 'E = mc^2')).toContainText('E = mc^2')

  const blocks = page.locator('.arkdown-mermaid-block')
  const first = blocks.first()
  await first.scrollIntoViewIfNeeded()
  const images: Locator[] = []
  const inspections: SvgInspection[] = []
  for (let index = 0; index < 6; index += 1) {
    const block = blocks.nth(index)
    const image = await waitForSafeImage(block)
    images.push(image)
    const inspection = await inspectImage(image)
    inspections.push(inspection)
    expect(inspection.root).toBe('svg')
    expect(inspection.forbiddenElement).toBeNull()
    expect(inspection.unsafeReference).toBeNull()
    if (index === 0) {
      expect(inspection.dropShadowLocalNames).toContain('feDropShadow')
      expect(inspection.cssDropShadowFilters.length).toBeGreaterThan(0)
      expect(inspection.cssDropShadowFilters).toEqual(expect.arrayContaining([
        expect.stringMatching(/^drop-shadow\(/),
      ]))
      expect(inspection.cssDropShadowFilters.join(' ')).not.toMatch(/url\(/i)
    }
    const geometry = await block.evaluate((element) => {
      const host = element as HTMLElement
      const preview = host.querySelector<HTMLElement>('.arkdown-mermaid-preview')!
      const image = preview.querySelector<HTMLImageElement>('img')!
      const editor = host.closest<HTMLElement>('.ProseMirror')!
      const hostRect = host.getBoundingClientRect()
      const previewRect = preview.getBoundingClientRect()
      const imageRect = image.getBoundingClientRect()
      const editorRect = editor.getBoundingClientRect()
      return {
        hostScrollWidth: host.scrollWidth,
        hostClientWidth: host.clientWidth,
        hostRight: hostRect.right,
        editorRight: editorRect.right,
        previewOverflow: getComputedStyle(preview).overflowX,
        imageDisplay: getComputedStyle(image).display,
        imageWidth: imageRect.width,
        imageHeight: imageRect.height,
        imageRight: imageRect.right,
        previewRight: previewRect.right,
      }
    })
    expect(geometry.hostScrollWidth).toBeLessThanOrEqual(geometry.hostClientWidth + 1)
    expect(geometry.hostRight).toBeLessThanOrEqual(geometry.editorRight + 1)
    expect(geometry.previewOverflow).toMatch(/auto|hidden/)
    expect(geometry.imageDisplay).toBe('block')
    expect(geometry.imageWidth).toBeGreaterThan(0)
    expect(geometry.imageHeight).toBeGreaterThan(0)
    expect(geometry.imageRight).toBeLessThanOrEqual(geometry.previewRight + 1)
  }

  const flowchart = await inspectImage(images[0]!)
  expect(flowchart.text).toContain('你好 🌟')
  expect(flowchart.text).toContain('完成 ✅')
  expect(flowchart.styleRuleCount).toBeGreaterThan(0)
  expect(flowchart.lightAppearancePaintCount).toBe(4)
  expect(flowchart.darkAppearancePaintCount).toBe(0)
  const sequence = await inspectImage(images[1]!)
  expect(sequence.text).toContain('Request')
  expect(sequence.text).toContain('Response')
  expect(inspections.every((inspection) => inspection.darkAppearancePaintCount === 0)).toBe(true)

  const invalid = blocks.nth(6)
  await invalid.scrollIntoViewIfNeeded()
  const error = invalid.locator('.arkdown-mermaid-preview[role="alert"]')
  await expect(error).toContainText('Mermaid 语法错误')
  await expect(error).not.toContainText('not-a-real-diagram')
  await expect(invalid.locator('img')).toHaveCount(0)
  await error.getByRole('button', { name: '编辑源码' }).click()
  const invalidEditor = invalid.locator('.cm-content')
  await invalidEditor.click()
  await expect(invalidEditor).toBeFocused()

  await first.scrollIntoViewIfNeeded()
  await first.locator('[data-action="toggle-source"]').click()
  const source = first.locator('.cm-content')
  await source.click()
  await expect(source).toBeFocused()
  for (const nextSource of [
    'flowchart LR\n  A["较旧标签-1"] --> B["完成"]',
    'flowchart LR\n  A["较旧标签-2"] --> B["完成"]',
    'flowchart LR\n  A["最终标签-3 ✅"] --> B["完成"]',
  ]) {
    await page.keyboard.press('Control+A')
    await page.keyboard.insertText(nextSource)
  }
  await expect.poll(async () => {
    const image = first.locator('.arkdown-mermaid-preview > img')
    if (await image.count() === 0) return ''
    return (await inspectImage(image)).text
  }).toContain('最终标签-3 ✅')
  const newest = await inspectImage(first.locator('.arkdown-mermaid-preview > img'))
  expect(newest.text).not.toContain('较旧标签-1')
  expect(newest.text).not.toContain('较旧标签-2')
  await first.getByRole('button', { name: '显示图形' }).click()
  await expect(first.locator('.arkdown-mermaid-preview > img')).toBeVisible()

  const themeBlock = first
  await themeBlock.scrollIntoViewIfNeeded()
  const themeImage = themeBlock.locator('.arkdown-mermaid-preview > img')
  const beforeTheme = await themeImage.getAttribute('src')
  await page.getByTestId('theme-refresh').click()
  await expect.poll(() => themeImage.getAttribute('src'))
    .not.toBe(beforeTheme)
  await expect(themeImage)
    .toHaveAttribute('src', /^data:image\/svg\+xml;base64,/)
  const themedFlowchart = await inspectImage(themeImage)
  expect(
    themedFlowchart.darkAppearancePaintCount,
    `themed flowchart paints: ${JSON.stringify(themedFlowchart.paintEvidence)}`,
  ).toBe(4)
  expect(themedFlowchart.lightAppearancePaintCount).toBe(0)

  expect(await sentinelSnapshot(page)).toEqual(sentinelBefore)

  await page.getByTestId('switch-to-javascript').click()
  await expect(page.locator('body')).toHaveAttribute('data-editor-ready', 'true')
  await expect(page.locator('.arkdown-mermaid-block')).toHaveCount(6)
  await expect(stockBlock(page, '最终标签-3')).toContainText('最终标签-3')
  await expect(stockBlock(page, 'ordinaryCode')).toContainText('ordinaryCode')
  await expect(stockBlock(page, 'E = mc^2')).toContainText('E = mc^2')

  await page.getByTestId('switch-to-mermaid').click()
  await expect(page.locator('body')).toHaveAttribute('data-editor-ready', 'true')
  await expect(page.locator('.arkdown-mermaid-block')).toHaveCount(7)
  const rebuilt = page.locator('.arkdown-mermaid-block').first()
  const rebuiltImage = await waitForSafeImage(rebuilt)
  expect((await inspectImage(rebuiltImage)).text).toContain('最终标签-3 ✅')
  await expect(page.locator('.milkdown-code-block')).toHaveCount(2)

  await expectCleanDiagnostics(page, diagnostics)
})
