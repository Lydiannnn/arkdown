import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

const FIXTURE_PATH = '/__structured-block-layout-fixture'
const VIRTUAL_FIXTURE_ID = 'virtual:structured-block-layout-fixture'
const RESOLVED_FIXTURE_ID = `\0${VIRTUAL_FIXTURE_ID}`
test('returns a code block to a light panel inside a dark document', async ({ page }) => {
  await openFixture(page)
  await page.evaluate(() => { document.documentElement.dataset.arkdownTheme = 'dark' })
  const code = blockForLanguage(page, 'TypeScript')
  await setBlockColorMode(code, 'dark')
  await expect(code).toHaveCSS('background-color', 'rgb(24, 24, 24)')
  await setBlockColorMode(code, 'theme')
  await expect(code).toHaveCSS('color-scheme', 'light')
  const rgb = await code.evaluate(element => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    context.fillStyle = getComputedStyle(element).backgroundColor
    context.fillRect(0, 0, 1, 1)
    return Array.from(context.getImageData(0, 0, 1, 1).data)
  })
  expect(rgb.slice(0, 3).every(value => value > 230)).toBe(true)
  await expect(code.locator('.cm-content')).toHaveCSS('color', 'rgb(95, 99, 104)')
})

const fixtureModule = String.raw`
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { VisualEditor } from '/src/renderer/editor/VisualEditor.tsx'
import '/src/renderer/app/styles.css'
import '/src/renderer/app/main-window-theme.css'

const h = React.createElement
const fence = String.fromCharCode(96).repeat(3)
const initialMarkdown = [
  '---',
  'title: Arkdown',
  '---',
  '',
  '# Structured blocks',
  '',
  fence + 'typescript',
  'const arkdown = "content-first"',
  'const longLine = "' + 'x'.repeat(180) + '"',
  fence,
  '',
  '$$',
  'E = mc^2',
  '$$',
].join('\n')

window.arkdown = {
  readClipboardFormats: async () => ({
    ok: true,
    value: { plainText: '', markdown: null, html: null },
  }),
}

function Fixture() {
  const [markdown, setMarkdown] = useState(initialMarkdown)
  return h('main', {
    'aria-label': '结构化块样式夹具',
    className: 'editor-content',
    style: { boxSizing: 'border-box', height: '100vh', overflow: 'auto', padding: '24px 18px' },
  }, h(VisualEditor, {
    markdown,
    onChange: setMarkdown,
    onReady() { document.body.dataset.editorReady = 'true' },
  }))
}

createRoot(document.querySelector('#fixture-root')).render(h(Fixture))
`

let vite: ViteDevServer | undefined
let fixtureUrl = ''

test.beforeAll(async () => {
  vite = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    plugins: [{
      name: 'structured-block-layout-playwright-fixture',
      resolveId(id) {
        return id === VIRTUAL_FIXTURE_ID ? RESOLVED_FIXTURE_ID : undefined
      },
      load(id) {
        return id === RESOLVED_FIXTURE_ID ? fixtureModule : undefined
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url?.split('?')[0] !== FIXTURE_PATH) {
            next()
            return
          }
          const html = await server.transformIndexHtml(FIXTURE_PATH, `<!doctype html>
            <html><head><meta charset="UTF-8"></head>
            <body style="margin:0;overflow:hidden">
              <div id="fixture-root"></div>
              <script type="module">import '${VIRTUAL_FIXTURE_ID}'</script>
            </body></html>`)
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
  fixtureUrl = `http://127.0.0.1:${address.port}${FIXTURE_PATH}`
})

test.afterAll(async () => {
  await vite?.close()
  vite = undefined
})

async function openFixture(page: Page) {
  await page.goto(fixtureUrl)
  await expect(page.locator('body')).toHaveAttribute('data-editor-ready', 'true')
  await expect(page.locator('.milkdown-code-block')).toHaveCount(3)
}

function blockForLanguage(page: Page, language: string): Locator {
  return page.locator('.milkdown-code-block').filter({
    has: page.locator('.language-button', { hasText: language }),
  })
}

async function setBlockColorMode(block: Locator, mode: 'theme' | 'dark') {
  if (await block.getAttribute('data-arkdown-color-mode') === mode) return
  await block.locator('.arkdown-block-theme-toggle').click()
  await expect(block).toHaveAttribute('data-arkdown-color-mode', mode)
}

async function neutralBaseResults(controls: Locator[]) {
  return Promise.all(controls.map((control) => control.evaluate((element) => {
    const probe = element.ownerDocument.createElement('span')
    probe.style.background = 'color-mix(in srgb, #fff 95%, #000 5%)'
    element.append(probe)
    const expected = getComputedStyle(probe).backgroundColor
    probe.remove()
    return getComputedStyle(element).backgroundColor === expected
  })))
}

test('mounts the production VisualEditor and preserves the installed language picker behavior', async ({ page }) => {
  await openFixture(page)
  const code = blockForLanguage(page, 'TypeScript')
  const trigger = code.locator('.language-button')
  await trigger.click()

  const picker = code.locator('.language-picker')
  const search = picker.locator('.search-input')
  await expect(picker).toBeVisible()
  await expect(search).toBeFocused()
  await search.fill('java')
  await expect(picker.locator('.language-list-item')).toHaveCount(3)
  await expect(picker.locator('.language-list-item').first()).toContainText('TypeScript')
  await expect(picker.locator('.language-list-item')).toContainText(['TypeScript', 'Java', 'JavaScript'])

  // Milkdown 7.21.3 leaves list traversal to native Tab focus: Arrow keys do
  // not select an option, while Escape clears the filter without closing.
  await page.keyboard.press('ArrowDown')
  await expect(search).toBeFocused()
  await expect(picker.locator('.language-list-item[aria-selected="true"]')).toContainText('TypeScript')
  await page.keyboard.press('Escape')
  await expect(search).toHaveValue('')
  await expect(picker).toBeVisible()

  await search.fill('json')
  await picker.locator('.language-list-item[data-language="JSON"]').click()
  const updatedCode = page.locator('.milkdown-code-block').filter({ hasText: 'content-first' })
  await expect(updatedCode.locator('.language-button')).toContainText('JSON')
  await expect(updatedCode.locator('.list-wrapper')).toHaveCount(0)
})

test('leaves the production Front Matter trigger and popup on their established styling', async ({ page }) => {
  await openFixture(page)
  const frontmatter = page.locator('.milkdown-code-block[data-arkdown-frontmatter="true"]')
  const trigger = frontmatter.locator('.language-button')
  expect(await trigger.evaluate((element) => {
    const probe = element.ownerDocument.createElement('span')
    probe.style.background = 'color-mix(in srgb, var(--crepe-color-surface-low, #fff) 72%, transparent)'
    element.append(probe)
    const expected = getComputedStyle(probe).backgroundColor
    probe.remove()
    return getComputedStyle(element).backgroundColor === expected
  })).toBe(true)

  await trigger.click()
  const wrapper = frontmatter.locator('.list-wrapper')
  const searchBox = wrapper.locator('.search-box')
  const firstOption = wrapper.locator('.language-list-item').first()
  await expect(wrapper).toHaveCSS('border-radius', '9px')
  await expect(wrapper).toHaveCSS('padding', '6px')
  expect(await wrapper.evaluate((element) => {
    const probe = element.ownerDocument.createElement('span')
    probe.style.background = 'var(--crepe-color-surface-low, #fff)'
    probe.style.borderColor = 'var(--arkdown-structured-block-border)'
    probe.style.boxShadow = 'var(--crepe-shadow-1, 0 10px 28px rgb(0 0 0 / 12%))'
    element.append(probe)
    const probeStyle = getComputedStyle(probe)
    const actualStyle = getComputedStyle(element)
    const matches = actualStyle.backgroundColor === probeStyle.backgroundColor
      && actualStyle.borderTopColor === probeStyle.borderTopColor
      && actualStyle.boxShadow === probeStyle.boxShadow
    probe.remove()
    return matches
  })).toBe(true)
  await expect(searchBox).toHaveCSS('border-radius', '7px')
  await expect(searchBox).toHaveCSS('padding', '5px 9px')
  await expect(searchBox).toHaveCSS('outline-style', 'solid')
  await expect(searchBox).toHaveCSS('outline-width', '2px')
  await expect(firstOption).toHaveCSS('border-radius', '6px')
  expect(await wrapper.locator('.language-list').evaluate(
    (element) => getComputedStyle(element, '::-webkit-scrollbar').width,
  )).not.toBe('12px')
})

test('uses neutral light controls and dark top controls without restyling the LaTeX preview toggle', async ({ page }, testInfo) => {
  await openFixture(page)
  expect(await page.evaluate(() => devicePixelRatio)).toBe(Number(testInfo.project.metadata.requestedDpr))

  const code = blockForLanguage(page, 'TypeScript')
  const codeControls = [
    code.locator('.language-button'),
    code.locator('.arkdown-block-theme-toggle'),
    code.locator('.copy-button'),
  ]
  const latex = blockForLanguage(page, 'LaTeX')
  const latexControls = [
    latex.locator('.language-button'),
    latex.locator('.arkdown-block-theme-toggle'),
    latex.locator('.copy-button'),
  ]
  for (const block of [code, latex]) await setBlockColorMode(block, 'theme')
  await page.mouse.move(0, 0)
  await expect.poll(() => neutralBaseResults(codeControls)).toEqual([true, true, true])
  await expect.poll(() => neutralBaseResults(latexControls)).toEqual([true, true, true])
  for (const control of [...codeControls, ...latexControls]) {
    expect(await control.evaluate((element) => {
      const color = getComputedStyle(element).color.match(/[\d.]+/gu)?.slice(0, 3).map(Number) ?? []
      return color.length === 3 && color.every((channel) => channel < 105)
    })).toBe(true)
  }

  for (const block of [code, latex]) await setBlockColorMode(block, 'dark')
  await page.mouse.move(0, 0)
  for (const control of [...codeControls, ...latexControls]) {
    await expect(control).toHaveCSS('background-color', 'rgb(35, 38, 40)')
    await expect(control).toHaveCSS('color', 'rgba(255, 255, 255, 0.86)')
    await expect(control).toHaveCSS('border-top-color', 'rgba(255, 255, 255, 0.13)')
  }

  for (const control of [...codeControls, ...latexControls]) {
    const geometry = await control.boundingBox()
    expect(geometry?.height).toBe(32)
  }
  for (const controls of [codeControls, latexControls]) {
    expect((await controls[1]!.boundingBox())?.width).toBe(32)
    expect((await controls[2]!.boundingBox())?.width).toBe(32)
    await expect(controls[0]!).toHaveCSS('border-radius', '7px')
  }
  for (const icon of [
    code.locator('.language-button svg'),
    code.locator('.arkdown-block-theme-toggle svg'),
    code.locator('.copy-button svg'),
  ]) await expect(icon).toHaveCSS('height', /1[46]px/)

  const previewToggle = latex.locator('.preview-toggle-button')
  await expect(previewToggle).toBeVisible()
  expect(await previewToggle.evaluate((element) => {
    const probe = element.ownerDocument.createElement('span')
    probe.style.background = 'var(--crepe-color-secondary)'
    element.append(probe)
    const expected = getComputedStyle(probe).backgroundColor
    probe.remove()
    return getComputedStyle(element).backgroundColor === expected
  })).toBe(true)
})

test('matches PreferencesSelect popup tokens and keeps one neutral search focus treatment', async ({ page }) => {
  await openFixture(page)
  const code = blockForLanguage(page, 'TypeScript')
  const trigger = code.locator('.language-button')
  const controls = [trigger, code.locator('.arkdown-block-theme-toggle'), code.locator('.copy-button')]
  const closedBoxes = await Promise.all(controls.map((control) => control.boundingBox()))
  await trigger.click()

  const picker = code.locator('.language-picker')
  const wrapper = picker.locator('.list-wrapper')
  const searchBox = picker.locator('.search-box')
  const search = picker.locator('.search-input')
  await expect(wrapper).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.98)')
  await expect(wrapper).toHaveCSS('border-radius', '8px')
  await expect(wrapper).toHaveCSS('padding', '5px')
  await expect(wrapper).toHaveCSS('box-shadow', 'rgba(0, 0, 0, 0.16) 0px 10px 28px 0px')
  await expect(picker.locator('.language-list-item').first()).toHaveCSS('min-height', '32px')
  await expect(picker.locator('.language-list-item').first()).toHaveCSS('border-radius', '5px')
  expect(await picker.locator('.language-list').evaluate(
    (element) => getComputedStyle(element, '::-webkit-scrollbar').width,
  )).toBe('12px')
  await expect(search).toBeFocused()
  expect(await searchBox.evaluate((element) => {
    const style = getComputedStyle(element)
    return { outline: style.outlineStyle, shadow: style.boxShadow }
  })).toEqual({ outline: 'none', shadow: 'none' })
  expect(await search.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('none')

  const selected = picker.locator('.language-list-item[aria-selected="true"]')
  await expect(selected).toHaveCSS('font-weight', '650')
  expect(await selected.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe('rgba(0, 0, 0, 0)')
  const hoverOption = picker.locator('.language-list-item').nth(1)
  await hoverOption.hover()
  expect(await hoverOption.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe('rgba(0, 0, 0, 0)')
  await hoverOption.focus()
  await expect(hoverOption).toBeFocused()

  const openBoxes = await Promise.all(controls.map((control) => control.boundingBox()))
  expect(openBoxes).toEqual(closedBoxes)

  await page.keyboard.press('Escape')
  await trigger.click()
  const latex = blockForLanguage(page, 'LaTeX')
  await latex.locator('.language-button').click()
  await expect(latex.locator('.list-wrapper')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.98)')
})

test('keeps the real Floating UI popup inside the viewport at right and bottom edges', async ({ page }) => {
  await openFixture(page)
  await page.locator('main').evaluate((element) => {
    const panel = element as HTMLElement
    panel.style.inlineSize = '190px'
    panel.style.blockSize = '240px'
    panel.style.margin = '80px auto 0'
    panel.style.padding = '16px'
    panel.style.overflow = 'auto'
  })
  const code = blockForLanguage(page, 'TypeScript')
  await code.evaluate((element) => {
    const block = element as HTMLElement
    block.style.marginBlockStart = '420px'
    block.scrollIntoView({ block: 'end', inline: 'end' })
  })
  await code.locator('.language-button').click()
  const picker = code.locator('.language-picker')
  await expect(picker).toBeVisible()
  const geometry = await picker.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const editorRect = element.closest('main')!.getBoundingClientRect()
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      editorLeft: editorRect.left,
      editorTop: editorRect.top,
      editorRight: editorRect.right,
      editorBottom: editorRect.bottom,
      blockOverflow: getComputedStyle(element.closest('.milkdown-code-block')!).overflow,
      visibleAtCenter: (() => {
        const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return target instanceof Node && element.contains(target)
      })(),
    }
  })
  expect(geometry.left).toBeGreaterThanOrEqual(0)
  expect(geometry.top).toBeGreaterThanOrEqual(0)
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth)
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight)
  expect(geometry.left).toBeGreaterThanOrEqual(geometry.editorLeft)
  expect(geometry.top).toBeGreaterThanOrEqual(geometry.editorTop)
  expect(geometry.right).toBeLessThanOrEqual(geometry.editorRight)
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.editorBottom)
  expect(geometry.blockOverflow).toBe('visible')
  expect(geometry.visibleAtCenter).toBe(true)
})

test('reconstrains the real popup after filtering, scrolling, resize, and close-reopen', async ({ page }) => {
  await openFixture(page)
  const panel = page.locator('main')
  await panel.evaluate((element) => {
    const editor = element as HTMLElement
    editor.style.inlineSize = '260px'
    editor.style.blockSize = '460px'
    editor.style.margin = '48px auto 0'
    editor.style.overflow = 'auto'
  })
  const code = blockForLanguage(page, 'TypeScript')
  const trigger = code.locator('.language-button')
  await trigger.click()
  const picker = code.locator('.language-picker')
  const search = picker.locator('.search-input')
  const expectBounded = async () => expect.poll(() => picker.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const boundary = element.closest('main')!.getBoundingClientRect()
    return rect.left >= boundary.left
      && rect.top >= boundary.top
      && rect.right <= boundary.right
      && rect.bottom <= boundary.bottom
  })).toBe(true)

  await expectBounded()
  await search.fill('no-language-has-this-name')
  await expectBounded()
  await search.fill('')
  await expectBounded()
  await panel.evaluate((element) => { element.scrollTop += 80 })
  await expectBounded()
  await page.setViewportSize({ width: 400, height: 620 })
  await expectBounded()

  await trigger.click()
  await expect(picker.locator('.list-wrapper')).toHaveCount(0)
  await expect.poll(() => picker.evaluate((element) => getComputedStyle(element).translate))
    .toBe('none')
  await trigger.click()
  await expectBounded()
})

test('reconstrains the real popup when the editor scroll container itself resizes', async ({ page }) => {
  await openFixture(page)
  const panel = page.locator('main')
  await panel.evaluate((element) => {
    const editor = element as HTMLElement
    editor.style.inlineSize = '320px'
    editor.style.blockSize = '520px'
    editor.style.margin = '48px auto 0'
    editor.style.padding = '16px'
    editor.style.overflow = 'auto'
  })
  const code = blockForLanguage(page, 'TypeScript')
  const picker = code.locator('.language-picker')
  await code.locator('.language-button').click()

  const isBounded = () => picker.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const boundary = element.closest('main')!.getBoundingClientRect()
    return rect.left >= boundary.left
      && rect.top >= boundary.top
      && rect.right <= boundary.right
      && rect.bottom <= boundary.bottom
  })
  await expect.poll(isBounded).toBe(true)

  await panel.evaluate((element) => { element.style.inlineSize = '180px' })
  await expect.poll(isBounded).toBe(true)
})
