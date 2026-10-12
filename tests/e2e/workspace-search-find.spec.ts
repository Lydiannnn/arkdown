import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

const fixtureModule = String.raw`
import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { EditorPane } from '/src/renderer/editor/EditorPane.tsx'
import '/src/renderer/app/styles.css'
const h = React.createElement
window.readSourceSelection = () => {
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor'))
  return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)
}
window.arkdown = {
  cancelTranslation: async () => ({ok:true,value:null}),
  onTranslationEvent: () => () => {},
  onAiConversationEvent: () => () => {},
}
const markdown = Array.from({length:50}, (_, i) => i === 35 || i === 45 ? 'Needle found here.' : 'Paragraph ' + i).join('\n\n')
function Fixture() {
  const generation = useRef(0)
  const [target, setTarget] = useState('old.md')
  const [request, setRequest] = useState(null)
  function locate() {
    const id = ++generation.current
    setTarget('target.md')
    setRequest({ id, documentKey:'target.md', query:'Needle', isCurrent:() => id === generation.current })
  }
  return h('main', {className:'fixture'},
    h('button', {onClick:locate}, 'Open body result'),
    h('button', {onClick:() => { ++generation.current; setRequest(null); setTarget('plain.md') }}, 'Open filename result'),
    h(EditorPane, { documentKey:target, markdown:target === 'old.md' ? 'Old editor' : markdown,
      initialMode:new URLSearchParams(location.search).get('mode') || 'visual', findRequest:request,
      onChange() {}, onOpenLargeModelSettings() {},
    }))
}
createRoot(document.getElementById('root')).render(h(Fixture))
`
let vite: ViteDevServer
let fixtureUrl: string

test.beforeAll(async () => {
  vite = await createServer({
    root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'workspace-search-find-fixture',
      resolveId: (id) => id === 'virtual:search-find' ? '\0virtual:search-find' : undefined,
      load: (id) => id === '\0virtual:search-find' ? fixtureModule : undefined,
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url?.split('?')[0] !== '/__search-find') return next()
          const html = await server.transformIndexHtml('/__search-find', `<!doctype html>
            <html><head><meta charset="UTF-8"><style>
              html,body,#root{height:100%;margin:0}.fixture{height:760px;padding:10px}
              .editor-pane{height:700px}.editor-surface{height:100%}
            </style></head><body><div id="root"></div>
            <script type="module">import 'virtual:search-find'</script></body></html>`)
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.end(html)
        })
      },
    }],
  })
  await vite.listen()
  fixtureUrl = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}/__search-find`
})

test.afterAll(async () => { await vite?.close() })

test('real visual and source adapters find a newly mounted target and repeat navigation', async ({ page }) => {
  await page.goto(fixtureUrl)
  await page.getByRole('button', { name: 'Open body result' }).click()
  const find = page.getByRole('searchbox', { name: '在文档中搜索' })
  await expect(find).toHaveValue('Needle')
  await expect(page.getByText('1/2', { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (CSS.highlights?.get('arkdown-document-find-match')?.size ?? 0))).toBe(2)
  await page.getByRole('button', { name: '下一条搜索结果' }).click()
  await expect(page.getByText('2/2', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭文档搜索' }).click()
  await page.getByRole('button', { name: 'Open body result' }).click()
  await expect(page.getByText('1/2', { exact: true })).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('arkdown:editor-command', {detail:'toggle-source-mode'})))
  await expect(page.locator('.cm-editor')).toBeVisible()
  await page.getByRole('button', { name: '关闭文档搜索' }).click()
  await page.getByRole('button', { name: 'Open body result' }).click()
  await expect(page.getByText('1/2', { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as unknown as { readSourceSelection(): string }).readSourceSelection())).toBe('Needle')
  await expect.poll(() => page.locator('.cm-scroller').evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Open filename result' }).click()
  await expect(find).toHaveCount(0)
})
