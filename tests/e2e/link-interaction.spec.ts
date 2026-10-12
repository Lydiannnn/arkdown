import type { AddressInfo } from 'node:net'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

const FIXTURE_PATH = '/__link-interaction-fixture'
const VIRTUAL_FIXTURE_ID = 'virtual:link-interaction-fixture'
const RESOLVED_FIXTURE_ID = `\0${VIRTUAL_FIXTURE_ID}`

const fixtureModule = String.raw`
import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ContextMenuProvider } from '/src/renderer/context-menu/ContextMenuProvider.tsx'
import { VisualEditor } from '/src/renderer/editor/VisualEditor.tsx'
import '/src/renderer/app/styles.css'
import '/src/renderer/context-menu/context-menu.css'

const h = React.createElement
const openedTargets = []

window.arkdown = {
  openExternal: async (target) => {
    openedTargets.push(target)
    return { ok: true, value: null }
  },
}

function Fixture() {
  const [document, setDocument] = useState({ key: 0, markdown: '' })
  const [current, setCurrent] = useState('')
  const [ready, setReady] = useState(false)
  const currentRef = useRef('')
  const editorRef = useRef(null)

  currentRef.current = current
  useEffect(() => {
    window.linkInteractionFixture = {
      clearOpened() {
        openedTargets.length = 0
      },
      openedTargets() {
        return [...openedTargets]
      },
      dropLocalPath(absolutePath, clientX, clientY) {
        return editorRef.current?.insertDroppedLink?.({
          absolutePath,
          clientX,
          clientY,
          kind: 'file',
        }) ?? false
      },
      reset(markdown = '') {
        currentRef.current = markdown
        setCurrent(markdown)
        setReady(false)
        setDocument((previous) => ({ key: previous.key + 1, markdown }))
      },
      roundTrip() {
        const markdown = currentRef.current
        setReady(false)
        setDocument((previous) => ({ key: previous.key + 1, markdown }))
      },
    }
  }, [])

  return h(ContextMenuProvider, null,
    h('main', { className: 'fixture-shell' },
      h('output', {
        id: 'link-fixture-state',
        'data-document-key': String(document.key),
        'data-ready': String(ready),
      }, current),
      h(VisualEditor, {
        ref: editorRef,
        key: document.key,
        documentKey: 'link-fixture-' + document.key + '.md',
        markdown: document.markdown,
        onChange(markdown) {
          currentRef.current = markdown
          setCurrent(markdown)
        },
        onReady() {
          setReady(true)
        },
      }),
    ),
  )
}

const root = createRoot(document.querySelector('#fixture-root'))
window.mountLinkInteractionFixture = () => root.render(h(Fixture))
`

let vite: ViteDevServer
let fixtureUrl: string

test.beforeAll(async () => {
  vite = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'link-interaction-playwright-fixture',
      resolveId(id) {
        return id === VIRTUAL_FIXTURE_ID ? RESOLVED_FIXTURE_ID : undefined
      },
      load(id) {
        return id === RESOLVED_FIXTURE_ID ? fixtureModule : undefined
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const pathname = request.url?.split('?')[0]
          if (pathname === '/__line-end-atom.svg') {
            response.statusCode = 200
            response.setHeader('Content-Type', 'image/svg+xml')
            response.end('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#4183c4"/></svg>')
            return
          }
          if (pathname !== FIXTURE_PATH) {
            next()
            return
          }
          const html = await server.transformIndexHtml(FIXTURE_PATH, `<!doctype html>
            <html style="--theme-color-rgb:124 58 237">
              <head><meta charset="UTF-8"><style>
                html, body, #fixture-root { width:100%; height:100%; margin:0; }
                body { overflow:hidden; background:#fff; }
                .fixture-shell { box-sizing:border-box; width:900px; min-height:520px; margin:36px; padding:24px; }
                #link-fixture-state { display:none; }
                .visual-editor { min-height:420px; }
                .visual-editor .ProseMirror { min-height:360px; padding:24px !important; font:18px/1.7 "Segoe UI", sans-serif; }
              </style></head>
              <body><div id="fixture-root"></div>
                <script type="module">import '${VIRTUAL_FIXTURE_ID}'</script>
              </body>
            </html>`)
          response.statusCode = 200
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.end(html)
        })
      },
    }],
  })
  await vite.listen()
  const address = vite.httpServer!.address() as AddressInfo
  fixtureUrl = `http://127.0.0.1:${address.port}${FIXTURE_PATH}`
})

test.afterAll(async () => {
  await vite.close()
})

const editor = (page: Page) => page.locator('.visual-editor .ProseMirror')
const state = (page: Page) => page.locator('#link-fixture-state')

async function mount(page: Page): Promise<void> {
  await page.goto(fixtureUrl)
  await page.evaluate(() => {
    (window as typeof window & { mountLinkInteractionFixture(): void })
      .mountLinkInteractionFixture()
  })
  await expect(editor(page)).toBeVisible()
  await expect(state(page)).toHaveAttribute('data-ready', 'true')
}

async function replaceDocument(page: Page, markdown = '', roundTrip = false): Promise<void> {
  const previousKey = await state(page).getAttribute('data-document-key')
  await page.evaluate(({ markdown, roundTrip }) => {
    const fixture = (window as typeof window & {
      linkInteractionFixture: {
        reset(value?: string): void
        roundTrip(): void
      }
    }).linkInteractionFixture
    if (roundTrip) fixture.roundTrip()
    else fixture.reset(markdown)
  }, { markdown, roundTrip })
  await expect(state(page)).not.toHaveAttribute('data-document-key', previousKey ?? '')
  await expect(state(page)).toHaveAttribute('data-ready', 'true')
  await expect(editor(page)).toBeVisible()
}

async function pastePlainText(page: Page, text: string): Promise<void> {
  await editor(page).click()
  await editor(page).evaluate((surface, pastedText) => {
    const clipboard = new DataTransfer()
    clipboard.setData('text/plain', pastedText)
    surface.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
      composed: true,
    }))
  }, text)
}

async function waitForSerializedMarkdown(page: Page): Promise<string> {
  await expect.poll(async () => (await state(page).textContent())?.length ?? 0).toBeGreaterThan(0)
  return await state(page).textContent() ?? ''
}

async function expectLink(
  page: Page,
  visibleText: string,
  href: string,
): Promise<Locator> {
  const link = editor(page).locator('a').filter({ hasText: visibleText })
  await expect(link).toHaveCount(1)
  await expect(link).toHaveText(visibleText)
  await expect(link).toHaveAttribute('href', href)
  return link
}

async function pointInText(
  locator: Locator,
  characterIndex: number,
  trailing = false,
): Promise<{ x: number; y: number }> {
  return await locator.evaluate((element, input) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let remaining = input.characterIndex
    let node: Text | null = walker.nextNode() as Text | null
    while (node && remaining >= (node.data.length || 1)) {
      remaining -= node.data.length
      node = walker.nextNode() as Text | null
    }
    if (!node || !node.data.length) throw new Error('No text geometry at requested index')
    const offset = Math.min(remaining, node.data.length - 1)
    const range = document.createRange()
    range.setStart(node, offset)
    range.setEnd(node, offset + 1)
    const rect = range.getBoundingClientRect()
    return {
      x: input.trailing ? rect.right - 1 : rect.left + 1,
      y: rect.top + rect.height / 2,
    }
  }, { characterIndex, trailing })
}

async function openedTargets(page: Page): Promise<string[]> {
  return await page.evaluate(() => (
    (window as typeof window & {
      linkInteractionFixture: { openedTargets(): string[] }
    }).linkInteractionFixture.openedTargets()
  ))
}

test.beforeEach(async ({ page }) => {
  await mount(page)
})

test('typed delimiters and exact paste survive real VisualEditor Markdown round-trips', async ({ page }) => {
  const cases = [
    {
      input: 'www.example.com/guide',
      visible: 'www.example.com/guide',
      href: 'https://www.example.com/guide',
      enter: async () => {
        await editor(page).click()
        await page.keyboard.insertText('www.example.com/guide')
        await page.keyboard.press('Space')
      },
    },
    {
      input: 'https://example.com/pasted',
      visible: 'https://example.com/pasted',
      href: 'https://example.com/pasted',
      enter: () => pastePlainText(page, 'https://example.com/pasted'),
    },
    {
      input: 'C:\\Workspace\\note.md',
      visible: 'C:\\Workspace\\note.md',
      href: 'C:\\Workspace\\note.md',
      enter: async () => {
        await editor(page).click()
        await page.keyboard.insertText('C:\\Workspace\\note.md')
        await page.keyboard.press('Space')
      },
    },
    {
      input: '"C:\\Workspace\\My Guide.md"',
      visible: '"C:\\Workspace\\My Guide.md"',
      href: 'C:\\Workspace\\My Guide.md',
      enter: async () => {
        await editor(page).click()
        await page.keyboard.insertText('"C:\\Workspace\\My Guide.md"')
        await page.keyboard.press('Enter')
      },
    },
    {
      input: 'C:\\Workspace\\Pasted Guide.md',
      visible: 'C:\\Workspace\\Pasted Guide.md',
      href: 'C:\\Workspace\\Pasted Guide.md',
      enter: () => pastePlainText(page, 'C:\\Workspace\\Pasted Guide.md'),
    },
    {
      input: '\\\\server\\share\\Team Notes.md',
      visible: '\\\\server\\share\\Team Notes.md',
      href: '\\\\server\\share\\Team Notes.md',
      enter: () => pastePlainText(page, '\\\\server\\share\\Team Notes.md'),
    },
    {
      input: 'file:///C:/Workspace/File%20Target.md',
      visible: 'file:///C:/Workspace/File%20Target.md',
      href: 'C:\\Workspace\\File Target.md',
      enter: () => pastePlainText(page, 'file:///C:/Workspace/File%20Target.md'),
    },
  ]

  for (const sample of cases) {
    await replaceDocument(page)
    await sample.enter()
    await expectLink(page, sample.visible, sample.href)
    const serialized = await waitForSerializedMarkdown(page)
    expect(serialized, `serialized Markdown for ${sample.input}`).toContain(sample.visible)

    await replaceDocument(page, '', true)
    await expectLink(page, sample.visible, sample.href)
  }
})

test('ordinary click and drag edit the real inline link while Ctrl opens exactly once', async ({ page }) => {
  await replaceDocument(
    page,
    'prefix [https://example.com/guide](https://example.com/guide) suffix',
  )
  const link = await expectLink(page, 'https://example.com/guide', 'https://example.com/guide')
  await link.hover()
  await expect(page.locator('.milkdown-link-preview, .milkdown-link-edit')).toHaveCount(0)

  const caretPoint = await pointInText(link, 10)
  await page.mouse.click(caretPoint.x, caretPoint.y)
  expect(await page.evaluate(() => {
    const selection = window.getSelection()
    const parent = selection?.anchorNode instanceof Element
      ? selection.anchorNode
      : selection?.anchorNode?.parentElement
    return {
      collapsed: selection?.isCollapsed ?? false,
      insideLink: Boolean(parent?.closest('a[href]')),
    }
  })).toEqual({ collapsed: true, insideLink: true })
  expect(await openedTargets(page)).toEqual([])
  expect(page.url()).toBe(fixtureUrl)

  const withinStart = await pointInText(link, 3)
  const withinEnd = await pointInText(link, 17, true)
  await page.mouse.move(withinStart.x, withinStart.y)
  await page.mouse.down()
  await page.mouse.move(withinEnd.x, withinEnd.y, { steps: 12 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .not.toBe('')
  expect(await openedTargets(page)).toEqual([])
  expect(page.url()).toBe(fixtureUrl)

  const paragraph = editor(page).locator('p').first()
  const acrossStart = await pointInText(paragraph, 2)
  const acrossEnd = await pointInText(
    paragraph,
    'prefix https://example.com/guide suffix'.length - 2,
    true,
  )
  await page.mouse.click(acrossStart.x, acrossStart.y)
  await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed ?? true))
    .toBe(true)
  await page.mouse.move(acrossStart.x, acrossStart.y)
  await page.mouse.down()
  await page.mouse.move(acrossEnd.x, acrossEnd.y, { steps: 16 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toContain('https://example.com/guide')
  const acrossSelection = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  expect(acrossSelection).toContain('https://example.com/guide')
  expect(await openedTargets(page)).toEqual([])

  await link.hover()
  await page.keyboard.down('Control')
  await expect(link).toHaveClass(/arkdown-link-openable/)
  expect(await link.evaluate((node) => getComputedStyle(node).cursor)).toBe('pointer')
  await link.click({ modifiers: ['Control'] })
  await expect.poll(() => openedTargets(page)).toEqual(['https://example.com/guide'])
  await page.keyboard.up('Control')
  await expect(link).not.toHaveClass(/arkdown-link-openable/)
  expect(await link.evaluate((node) => getComputedStyle(node).cursor)).toBe('text')

  await page.keyboard.down('Control')
  await expect(link).toHaveClass(/arkdown-link-openable/)
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(link).not.toHaveClass(/arkdown-link-openable/)
  await page.keyboard.up('Control')
  expect(await openedTargets(page)).toEqual(['https://example.com/guide'])
})

test('keeps far-right clicks at the end of the rendered row for every line-break shape', async ({ page }) => {
  const cases = [
    {
      markdown: '第一行\n第二行',
      prepare: async () => {
        await page.locator('body').evaluate((body) => body.classList.add('preserve-single-line-breaks'))
      },
      expected: '第一行§\n第二行',
    },
    {
      markdown: '第一段\n\n第二段',
      prepare: async () => undefined,
      expected: '第一段§\n\n第二段',
    },
    {
      markdown: 'This is a deliberately long rendered row that wraps before the final words.',
      prepare: async () => {
        await editor(page).locator('p').first().evaluate((paragraph) => {
          paragraph.style.width = '260px'
        })
      },
      expected: null,
    },
    {
      markdown: '开头 **粗体** *斜体* [链接](https://example.com) `代码` 结尾',
      prepare: async () => undefined,
      expected: '开头 **粗体** *斜体* [链接](https://example.com) `代码` 结尾§',
    },
    {
      markdown: '公式 $x^2$',
      prepare: async () => {
        await expect(editor(page).locator('p').first().locator('[contenteditable="false"]'))
          .not.toHaveCount(0)
      },
      expected: '公式 $x^2$§',
    },
    {
      markdown: '图 ![说明](/__line-end-atom.svg)',
      prepare: async () => {
        const image = editor(page).locator('img[alt="说明"]')
        await expect(image).toHaveCount(1)
        await expect.poll(() => image.evaluate((element) => (
          (element as HTMLImageElement).complete
          && (element as HTMLImageElement).naturalWidth > 0
        ))).toBe(true)
      },
      rowSelector: 'img[alt="说明"]',
      expected: '图 ![说明](/__line-end-atom.svg)§',
    },
    {
      markdown: '',
      prepare: async () => undefined,
      expected: '§',
    },
  ]

  for (const sample of cases) {
    await replaceDocument(page, sample.markdown)
    await sample.prepare()
    const paragraph = editor(page).locator('p').first()
    const rowSelector = 'rowSelector' in sample ? sample.rowSelector : null
    const click = rowSelector
      ? await paragraph.evaluate((element, selector) => {
          const atomRect = element.querySelector(selector)!.getBoundingClientRect()
          const paragraphRect = element.getBoundingClientRect()
          return {
            x: paragraphRect.right - 4,
            y: atomRect.top + atomRect.height / 2,
            expectedText: '',
            expectedOffset: 0,
          }
        }, rowSelector)
      : await paragraph.evaluate((element) => {
          const textNodes: Text[] = []
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            textNodes.push(node as Text)
          }
          const characters = textNodes.flatMap((text) => Array.from(
            text.data,
            (_character, index) => {
              const range = document.createRange()
              range.setStart(text, index)
              range.setEnd(text, index + 1)
              const rect = range.getClientRects()[0]
              return rect ? { text, index, rect } : []
            },
          )).flat()
          const paragraphRect = element.getBoundingClientRect()
          if (!characters.length) {
            return {
              x: paragraphRect.right - 4,
              y: paragraphRect.top + paragraphRect.height / 2,
              expectedText: '',
              expectedOffset: 0,
            }
          }
          const firstTop = Math.min(...characters.map(({ rect }) => rect.top))
          const row = characters.filter(({ rect }) => Math.abs(rect.top - firstTop) <= 1)
          const last = row.reduce((rightmost, current) => (
            current.rect.right >= rightmost.rect.right ? current : rightmost
          ))
          return {
            x: paragraphRect.right - 4,
            y: (last.rect.top + last.rect.bottom) / 2,
            expectedText: last.text.data,
            expectedOffset: last.index + 1,
          }
        })

    await page.mouse.click(click.x, click.y)
    await expect(page.locator('.arkdown-visual-input-caret')).toHaveCount(1)
    expect(await page.locator('.arkdown-visual-input-caret').evaluate((caret) => ({
      width: getComputedStyle(caret, '::after').width,
      animationName: getComputedStyle(caret, '::after').animationName,
      nativeColor: getComputedStyle(caret.closest('.ProseMirror')!).caretColor,
    }))).toEqual({
      width: '2px',
      animationName: 'arkdown-visual-caret-blink',
      nativeColor: 'rgba(0, 0, 0, 0)',
    })

    await page.keyboard.insertText('§')
    await expect.poll(async () => await state(page).textContent() ?? '').toContain('§')
    const serialized = await state(page).textContent() ?? ''
    if (sample.expected) {
      expect(serialized).toContain(sample.expected)
    } else {
      const expectedText = click.expectedText.slice(0, click.expectedOffset)
        + '§'
        + click.expectedText.slice(click.expectedOffset)
      expect(serialized).toContain(expectedText)
    }
  }
})

test('never collapses short or out-and-return native drag selections', async ({ page }) => {
  await replaceDocument(page, '0123456789 abcdefghijklmnopqrstuvwxyz')
  const paragraph = editor(page).locator('p').first()
  await paragraph.click()
  await expect(editor(page)).toHaveClass(/arkdown-visual-input-caret-active/)

  const shortStart = await pointInText(paragraph, 3)
  const shortEnd = await pointInText(paragraph, 5, true)
  await page.mouse.move(shortStart.x, shortStart.y)
  await page.mouse.down()
  await page.mouse.move(shortEnd.x, shortEnd.y, { steps: 4 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .not.toBe('')

  const returnStart = await pointInText(paragraph, 2)
  const returnEnd = await pointInText(paragraph, 18, true)
  const editorBox = await editor(page).boundingBox()
  if (!editorBox) throw new Error('Expected rendered editor geometry')
  await page.mouse.click(returnStart.x, returnStart.y)
  await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed ?? true))
    .toBe(true)
  await page.mouse.move(returnStart.x, returnStart.y)
  await page.mouse.down()
  await page.mouse.move(editorBox.x + editorBox.width + 80, editorBox.y - 20, { steps: 8 })
  await page.mouse.move(returnEnd.x, returnEnd.y, { steps: 8 })
  await page.mouse.up()

  await expect.poll(
    () => page.evaluate(() => window.getSelection()?.toString() ?? ''),
  ).not.toBe('')
  expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(false)
})

test('uses the native caret throughout composition and restores the custom caret after PM flushes', async ({ page }) => {
  await replaceDocument(page, '输入法')
  const surface = editor(page)
  await surface.click()
  await expect(surface).toHaveClass(/arkdown-visual-input-caret-active/)

  const during = await surface.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', {
      bubbles: true,
      data: '拼',
    }))
    return {
      active: element.classList.contains('arkdown-visual-input-caret-active'),
      caretColor: getComputedStyle(element).caretColor,
      customCaretPresent: Boolean(element.querySelector('.arkdown-visual-input-caret')),
    }
  })
  expect(during).toMatchObject({ active: false, customCaretPresent: true })
  expect(during.caretColor).not.toBe('rgba(0, 0, 0, 0)')

  const immediatelyAfter = await surface.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionend', {
      bubbles: true,
      data: '拼音',
    }))
    return {
      active: element.classList.contains('arkdown-visual-input-caret-active'),
      caretColor: getComputedStyle(element).caretColor,
    }
  })
  expect(immediatelyAfter.active).toBe(false)
  expect(immediatelyAfter.caretColor).not.toBe('rgba(0, 0, 0, 0)')

  await expect(surface).toHaveClass(/arkdown-visual-input-caret-active/, { timeout: 1_000 })
  await expect.poll(() => surface.evaluate((element) => getComputedStyle(element).caretColor))
    .toBe('rgba(0, 0, 0, 0)')
})

test('right-click opens first without Ctrl and manual linking preserves its label', async ({ page }) => {
  await replaceDocument(page, '[file target](file:///C:/Workspace/Menu%20Target.md)')
  const local = await expectLink(page, 'file target', 'C:\\Workspace\\Menu Target.md')
  await local.click({ button: 'right' })
  const rootMenu = page.locator('.context-menu-list:not(.context-menu-submenu)')
  await expect(rootMenu).toBeVisible()
  const firstAction = rootMenu.getByRole('menuitem').first()
  await expect(firstAction).toHaveText('打开')
  await firstAction.click()
  await expect.poll(() => openedTargets(page)).toEqual(['C:\\Workspace\\Menu Target.md'])

  await replaceDocument(page, 'selected label')
  const paragraph = editor(page).locator('p').first()
  const selectionStart = await pointInText(paragraph, 0)
  const selectionEnd = await pointInText(paragraph, 'selected label'.length - 1, true)
  await page.mouse.move(selectionStart.x, selectionStart.y)
  await page.mouse.down()
  await page.mouse.move(selectionEnd.x, selectionEnd.y, { steps: 10 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toBe('selected label')
  await page.mouse.click(selectionEnd.x - 2, selectionEnd.y, { button: 'right' })
  await page.getByRole('menuitem', { name: '插入', exact: true }).hover()
  await page.getByRole('menuitem', { name: '链接引用', exact: true }).click()
  const input = page.locator('.arkdown-link-editor-popover input')
  await expect(input).toBeFocused()
  await input.fill('www.example.com/manual')
  await input.press('Enter')
  let manual = await expectLink(page, 'selected label', 'https://www.example.com/manual')
  await page.keyboard.insertText(' trailing text')
  await expect(manual).toHaveText('selected label')
  await expect(paragraph).toHaveText('selected label trailing text')
  await expect.poll(() => state(page).textContent())
    .toContain('[selected label](https://www.example.com/manual) trailing text')

  await replaceDocument(page, '', true)
  manual = await expectLink(page, 'selected label', 'https://www.example.com/manual')
  await expect(paragraph).toHaveText('selected label trailing text')
  const editPoint = await pointInText(manual, 8)
  await page.mouse.click(editPoint.x, editPoint.y)
  await page.keyboard.insertText('!')
  const editedManual = editor(page).locator('a[href="https://www.example.com/manual"]')
  await expect(editedManual).toHaveText('selected! label')
  await expect(editedManual).toHaveAttribute('href', 'https://www.example.com/manual')

  await expect.poll(() => state(page).textContent())
    .toContain('[selected! label](https://www.example.com/manual)')
  await replaceDocument(page, '', true)
  const remountedManual = await expectLink(
    page,
    'selected! label',
    'https://www.example.com/manual',
  )
  await expect(remountedManual).toHaveText('selected! label')
  await expect(remountedManual).toHaveAttribute('href', 'https://www.example.com/manual')
})

test('typing after a dropped local-path link stays outside the link', async ({ page }) => {
  await replaceDocument(page, 'before')
  const paragraph = editor(page).locator('p').first()
  const dropPoint = await pointInText(paragraph, 'before'.length - 1, true)
  const inserted = await page.evaluate(({ x, y }) => (
    (window as typeof window & {
      linkInteractionFixture: {
        dropLocalPath(path: string, clientX: number, clientY: number): boolean
      }
    }).linkInteractionFixture.dropLocalPath('C:\\Files\\raw.bin', x, y)
  ), dropPoint)

  expect(inserted).toBe(true)
  const link = await expectLink(page, 'raw.bin', 'C:\\Files\\raw.bin')
  await page.keyboard.insertText('789')

  await expect(link).toHaveText('raw.bin')
  await expect(paragraph).toHaveText('beforeraw.bin789')
  await expect.poll(() => state(page).textContent())
    .toContain('[raw.bin](C:\\Files\\raw.bin)789')
})

test('typing after a dropped imported asset stays outside the link', async ({ page }) => {
  await replaceDocument(page, 'before')
  const paragraph = editor(page).locator('p').first()
  await paragraph.click()
  await page.keyboard.press('End')
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('arkdown:insert-markdown', {
      detail: '[guide.pdf](arkdown-asset:guide.pdf)',
    }))
  })

  const link = editor(page).locator('a').filter({ hasText: 'guide.pdf' })
  await expect(link).toHaveCount(1)
  await expect(link).toHaveText('guide.pdf')
  await page.keyboard.insertText('789')

  await expect(link).toHaveText('guide.pdf')
  await expect(paragraph).toContainText('guide.pdf789')
  await expect.poll(() => state(page).textContent())
    .toContain('[guide.pdf](arkdown-asset:guide.pdf)789')
})

test('editing an automatic literal target invalid removes its link mark', async ({ page }) => {
  await replaceDocument(page, '[https://example.com](https://example.com/)')
  const link = await expectLink(page, 'https://example.com', 'https://example.com/')
  await link.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('not a target')

  await expect(editor(page)).toHaveText('not a target')
  await expect(editor(page).locator('a')).toHaveCount(0)
})
