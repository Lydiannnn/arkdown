import { readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

const FIXTURE_ENTRY = '/document-find-layout-fixture.tsx'
let vite: ViteDevServer | undefined
let fixtureUrl = ''

test.beforeAll(async () => {
  const productionHtml = await readFile(path.resolve('src/renderer/index.html'), 'utf8')
  const componentPath = path.resolve('src/renderer/editor/DocumentFindBar.tsx').replaceAll('\\', '/')
  const sessionPath = path.resolve('src/renderer/editor/visual-document-find.ts').replaceAll('\\', '/')
  const appStylesheetPath = path.resolve('src/renderer/app/styles.css').replaceAll('\\', '/')
  vite = await createServer({
    configFile: path.resolve('vite.renderer.config.ts'),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    plugins: [{
      name: 'document-find-layout-fixture',
      resolveId(id) {
        return id === FIXTURE_ENTRY ? `\0${FIXTURE_ENTRY}` : undefined
      },
      load(id) {
        if (id !== `\0${FIXTURE_ENTRY}`) return undefined
        return [
          "import React, { useEffect, useRef, useState } from 'react'",
          "import { createRoot } from 'react-dom/client'",
          `import '/@fs/${appStylesheetPath}'`,
          `import { DocumentFindBar } from '/@fs/${componentPath}'`,
          `import { createVisualDocumentFindSession } from '/@fs/${sessionPath}'`,
          "const matches = new Set([15, 30, 45, 60, 75])",
          "const h = React.createElement",
          "function Fixture() {",
          "  const rootRef = useRef(null)",
          "  const sessionRef = useRef(null)",
          "  const [query, setQuery] = useState('')",
          "  const [snapshot, setSnapshot] = useState({ query:'', current:0, total:0, revision:0 })",
          "  useEffect(() => {",
          "    if (!rootRef.current) return",
          "    sessionRef.current = createVisualDocumentFindSession(rootRef.current, { set() {}, delete() {} }, setSnapshot)",
          "    return () => sessionRef.current?.dispose()",
          "  }, [])",
          "  const onQuery = (next) => { setQuery(next); sessionRef.current?.setQuery(next) }",
          "  const onNavigate = (direction) => sessionRef.current?.[direction]()",
          "  return h('main', { className:'editor-pane fixture-pane' },",
          "    h(DocumentFindBar, { current:snapshot.current, focusRequest:1, onClose() {}, onNavigate, onQuery, query, total:snapshot.total }),",
          "    h('div', { id:'document-scroll' }, h('article', { className:'ProseMirror', ref:rootRef },",
          "      Array.from({ length:90 }, (_, index) => h('p', { key:index, 'data-index':index }, matches.has(index) ? `Needle result ${index}` : `Long document paragraph ${index}`))",
          "    ))",
          "  )",
          "}",
          "const style = document.createElement('style')",
          "style.textContent = 'html,body,#root{width:100%;height:100%;margin:0}.fixture-pane{position:relative;width:100%;height:100%;overflow:hidden}.fixture-pane #document-scroll{height:100%;overflow:auto;padding:64px 32px 24px;box-sizing:border-box}.fixture-pane p{margin:0 0 24px;line-height:24px}'",
          "document.head.append(style)",
          "document.body.innerHTML = '<div id=\"root\"></div>'",
          "createRoot(document.getElementById('root')).render(h(Fixture))",
        ].join('\n')
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url?.split('?')[0] !== '/') {
            next()
            return
          }
          const fixtureHtml = productionHtml.replace(
            '<script type="module" src="/main.tsx"></script>',
            `<script type="module" src="${FIXTURE_ENTRY}"></script>`,
          )
          const html = await server.transformIndexHtml(request.url ?? '/', fixtureHtml)
          response.statusCode = 200
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.end(html)
        })
      },
    }],
  })
  await vite.listen()
  const address = vite.httpServer?.address() as AddressInfo | null
  if (!address || typeof address === 'string') throw new Error('Ephemeral Vite address unavailable')
  fixtureUrl = `http://127.0.0.1:${address.port}`
})

test.afterAll(async () => {
  await vite?.close()
  vite = undefined
})

test('keeps long-document result navigation visible, count-aware, and focused', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 720 })
  await page.goto(fixtureUrl)
  expect(await page.evaluate(() => devicePixelRatio)).toBe(Number(testInfo.project.metadata.requestedDpr))

  const bar = page.getByRole('search')
  const input = page.getByRole('searchbox', { name: '在文档中搜索' })
  await expect(bar).toBeVisible()
  await input.fill('needle')
  await expect(page.getByText('1/5')).toBeVisible()
  await expect(page.getByRole('button', { name: '上一条搜索结果' })).toHaveAttribute('data-tooltip', '上一条')
  await expect(page.getByRole('button', { name: '下一条搜索结果' })).toHaveAttribute('data-tooltip', '下一条')

  const geometry = await bar.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const inputRect = element.querySelector('input')!.getBoundingClientRect()
    return { left: rect.left, right: rect.right, inputWidth: inputRect.width }
  })
  expect(geometry.left).toBeGreaterThanOrEqual(0)
  expect(geometry.right).toBeLessThanOrEqual(360)
  expect(geometry.inputWidth).toBeGreaterThan(90)

  const firstScroll = await page.locator('#document-scroll').evaluate((element) => element.scrollTop)
  expect(firstScroll).toBeGreaterThan(0)
  await input.press('Enter')
  await expect(page.getByText('2/5')).toBeVisible()
  await expect(input).toBeFocused()
  const secondScroll = await page.locator('#document-scroll').evaluate((element) => element.scrollTop)
  expect(secondScroll).toBeGreaterThan(firstScroll)

  await input.press('Shift+Enter')
  await expect(page.getByText('1/5')).toBeVisible()
  await expect(input).toBeFocused()
})
