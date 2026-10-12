import { readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

const FIXTURE_ENTRY = '/workspace-color-marks-layout-fixture.tsx'
let vite: ViteDevServer | undefined
let fixtureUrl = ''

test.beforeAll(async () => {
  const productionHtml = await readFile(path.resolve('src/renderer/index.html'), 'utf8')
  const componentPath = path.resolve('src/renderer/workspace/ContextFileTree.tsx').replaceAll('\\', '/')
  const appStylesheetPath = path.resolve('src/renderer/app/styles.css').replaceAll('\\', '/')
  const workspaceStylesheetPath = path.resolve('src/renderer/workspace/workspace-context-menu.css').replaceAll('\\', '/')
  vite = await createServer({
    configFile: path.resolve('vite.renderer.config.ts'),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    plugins: [{
      name: 'workspace-color-marks-layout-fixture',
      resolveId(id) {
        return id === FIXTURE_ENTRY ? `\0${FIXTURE_ENTRY}` : undefined
      },
      load(id) {
        if (id !== `\0${FIXTURE_ENTRY}`) return undefined
        return [
          "import React from 'react'",
          "import { createRoot } from 'react-dom/client'",
          `import '/@fs/${appStylesheetPath}'`,
          `import '/@fs/${workspaceStylesheetPath}'`,
          `import { ContextFileTree } from '/@fs/${componentPath}'`,
          "const h = React.createElement",
          "const rootEntries = [{ kind:'directory', name:'Notes', relativePath:'Notes' }, { kind:'file', name:'active.md', relativePath:'active.md' }, { kind:'file', name:'plain.md', relativePath:'plain.md' }]",
          "const children = [{ kind:'file', name:'child.md', relativePath:'Notes/child.md' }]",
          "const listDirectory = async (relativePath) => ({ ok:true, value:relativePath === 'Notes' ? children : rootEntries })",
          "const marks = { notes:'#2563EB', 'active.md':'#800080' }",
          "function Fixture() { return h('main', { className:'sidebar workspace-tree-context', 'aria-label':'颜色标记文件树' }, h(ContextFileTree, { activePath:'active.md', colorMarks:marks, contextPath:null, listDirectory, onEntryContextMenu() {}, onOpenDocument() {}, selectedDirectory:'Notes' })) }",
          "const style = document.createElement('style')",
          "style.textContent = 'html,body,#root{width:100%;height:100%;margin:0}.workspace-tree-context{width:320px;padding:12px;background:rgb(250 250 250);--theme-color-rgb:198 40 40}'",
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

test('keeps direct color marks compact and compatible with tree states', async ({ page }, testInfo) => {
  await page.goto(fixtureUrl)
  expect(await page.evaluate(() => devicePixelRatio)).toBe(Number(testInfo.project.metadata.requestedDpr))

  const tree = page.getByLabel('颜色标记文件树')
  const folder = tree.getByRole('button', { name: 'Notes' })
  const active = tree.getByRole('button', { name: 'active.md' })
  const plain = tree.getByRole('button', { name: 'plain.md' })
  await expect(folder).toHaveAttribute('data-color-mark', '#2563EB')
  await expect(active).toHaveAttribute('data-color-mark', '#800080')
  await expect(active.locator('.tree-color-indicator')).toBeVisible()
  await expect(active).toHaveAttribute('aria-current', 'page')
  await expect(plain).not.toHaveAttribute('data-color-mark', /.+/)

  const markedStyle = await active.evaluate((element) => {
    const row = getComputedStyle(element)
    const panel = getComputedStyle(element, '::before')
    const indicator = getComputedStyle(element.querySelector('.tree-color-indicator')!)
    return {
      overflow: row.overflow,
      radius: panel.borderRadius,
      background: panel.backgroundColor,
      shadow: panel.boxShadow,
      indicatorWidth: indicator.width,
      indicatorHeight: indicator.height,
    }
  })
  expect(markedStyle).toMatchObject({
    overflow: 'hidden',
    radius: '6px',
    indicatorWidth: '3px',
    indicatorHeight: '13px',
  })
  expect(markedStyle.background).toMatch(/(?:\/ 0\.1\)|0\.1\))/)
  expect(markedStyle.shadow).toMatch(/(?:\/ 0\.18\)|0\.18\))/)

  await expect(active).toHaveCSS('background-color', 'rgba(198, 40, 40, 0.05)')
  await active.hover()
  await expect(active).toHaveCSS('background-color', 'rgba(198, 40, 40, 0.05)')
  expect(await active.evaluate((element) => getComputedStyle(element).boxShadow))
    .toContain('rgba(0, 0, 0, 0.05)')
  await active.focus()
  await expect(active).toBeFocused()

  await folder.click()
  const child = tree.getByRole('button', { name: 'child.md' })
  await expect(child).toBeVisible()
  await expect(child).not.toHaveAttribute('data-color-mark', /.+/)
  expect(await child.evaluate((element) => getComputedStyle(element, '::before').content)).toBe('none')

  await page.evaluate(() => {
    document.querySelector('.workspace-tree-context')?.setAttribute('style', 'width:320px;padding:12px;background:rgb(24 24 24);color-scheme:dark')
  })
  await expect(active.locator('.tree-color-indicator')).toHaveCSS('background-color', 'rgb(128, 0, 128)')
  expect(await active.evaluate((element) => getComputedStyle(element, '::before').backgroundColor)).toMatch(/(?:\/ 0\.1\)|0\.1\))/)
})
