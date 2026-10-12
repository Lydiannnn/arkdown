import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
let vite: ViteDevServer
let url: string

test.beforeAll(async () => {
  const html = await readFile('src/renderer/index.html', 'utf8')
  const entry = path.resolve('tests/e2e/fixtures/startup-guide-layout-fixture.tsx').replaceAll('\\', '/')
  vite = await createServer({ configFile: path.resolve('vite.renderer.config.ts'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'startup-guide-fixture', configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/') { next(); return }
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(await server.transformIndexHtml('/', html.replace('/main.tsx', `/@fs/${entry}`)))
      })
    } }],
  })
  await vite.listen()
  url = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`
})
test.afterAll(async () => { await vite?.close() })

test('routes body and blank document drops and roundtrips a relative image through source mode', async ({ page }) => {
  await page.goto(url)
  await expect(page.locator('.ProseMirror').first()).toHaveAttribute('contenteditable', 'true')
  await page.evaluate(() => {
    window.arkdown.pathForDroppedFile = file => `C:\\Preview\\${file.name}`
    window.arkdown.inspectDroppedPath = async absolutePath => ({ ok: true, value: { kind: 'file', absolutePath } })
    window.arkdown.openDroppedPath = async () => ({ ok: true, value: {
      workspace: { name: 'Preview', absolutePath: 'C:/Preview' },
      document: { relativePath: 'image.md', markdown: '# Image\n\n![Photo](assets/photo%20one.png)', revision: 'a'.repeat(64), encoding: 'utf8', newline: 'lf', mtimeMs: 1 },
    } })
    window.arkdown.prepareDroppedPath = async absolutePath => {
      const result = await window.arkdown.openDroppedPath(absolutePath)
      return result.ok ? { ok: true, value: { ...result.value, token: '123e4567-e89b-42d3-a456-426614174000' } } : result
    }
    window.arkdown.settleDroppedPath = async (_token, accept) => accept
      ? window.arkdown.openDroppedPath('C:/Preview/image.md') : { ok: true, value: null }
    window.arkdown.discardDraft = async () => ({ ok: true, value: null })
  })
  const body = page.locator('.ProseMirror').first()
  await body.locator('h1').evaluate(element => {
    const rect = element.getBoundingClientRect()
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['text'], 'insert.md'))
    const init = { bubbles: true, cancelable: true, clientX: rect.left + 30, clientY: rect.top + rect.height / 2, dataTransfer }
    element.dispatchEvent(new DragEvent('dragover', init))
    element.dispatchEvent(new DragEvent('drop', init))
  })
  await expect(body.locator('a[href*="insert.md"]')).toHaveCount(1)
  await page.locator('.editor-host').evaluate(element => {
    const rect = element.getBoundingClientRect()
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['text'], 'image.md'))
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: rect.left + 2, clientY: rect.top + 90, dataTransfer }))
  })
  const dialog = page.getByRole('dialog', { name: '打开新文档' })
  await expect(dialog).toContainText('即将打开文档 image.md，是否保存当前文档？')
  await dialog.getByRole('button', { name: '不保存', exact: true }).click()
  const image = page.locator('.arkdown-local-image')
  await expect(image).toHaveAttribute('data-source', 'C:\\Preview\\assets\\photo one.png')
  await image.evaluate(element => element.dispatchEvent(new CustomEvent('arkdown:image-update', { detail: { alignment: 'right', zoom: 75 } })))
  await expect(image).toHaveAttribute('data-alignment', 'right')
  await page.getByRole('button', { name: '源码模式/渲染模式' }).click()
  await expect(page.locator('.cm-content')).toContainText('src="assets/photo%20one.png"')
  await expect(page.locator('.cm-content')).toContainText('zoom:75%')
  await page.getByRole('button', { name: '源码模式/渲染模式' }).click()
  await expect(image).toHaveAttribute('data-source', 'C:\\Preview\\assets\\photo one.png')
  await expect(image).toHaveAttribute('data-alignment', 'right')
})

test('uses the real editable startup document and ordinary chrome at desktop and narrow sizes', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  const editor = page.locator('.ProseMirror').first()
  await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 15_000 })
  await expect(editor.getByRole('heading', { name: '把想法写下来' })).toBeVisible()
  await expect(page.getByRole('toolbar', { name: '编辑工具栏' })).toBeVisible()
  await expect(page.locator('.startup-guide-status')).toHaveCount(0)
  await expect(page.getByText('点击上方选择工作区')).toHaveCount(0)
  await expect(editor.getByRole('table')).toBeVisible()
  const tasks = editor.locator('.label.unchecked, .label.checked')
  await expect(tasks).toHaveCount(3)
  await tasks.first().click()
  await expect(tasks.first()).toHaveClass(/\bchecked\b/)
  await page.getByRole('button', { name: '源码模式/渲染模式' }).click()
  await expect(page.locator('.cm-content')).toContainText('[x] 收集参考资料')
  await page.getByRole('button', { name: '源码模式/渲染模式' }).click()
  await expect(tasks.first()).toHaveClass(/\bchecked\b/)
  for (const width of [1280, 760]) {
    await page.setViewportSize({ width, height: 720 })
    await page.evaluate(() => document.fonts.ready)
    const result = await page.evaluate(() => {
      const heading = document.querySelector('.sidebar-heading')!
      const sidebar = document.querySelector('.sidebar')!
      const title = document.querySelector('.sidebar-title')!
      const icon = title.querySelector('.workspace-library-icon')!.getBoundingClientRect()
      const label = title.querySelector('.workspace-title-label')!.getBoundingClientRect()
      return { left: heading.getBoundingClientRect().left - sidebar.getBoundingClientRect().left,
        background: getComputedStyle(heading).backgroundColor, radius: getComputedStyle(heading).borderTopRightRadius,
        iconWidth: icon.width, iconHeight: icon.height, iconTextGap: label.left - icon.right,
        iconCenterOffset: icon.top + icon.height / 2 - label.top - label.height / 2,
        titleSize: getComputedStyle(title).fontSize, menuSize: getComputedStyle(document.querySelector('.app-menu-button')!).fontSize,
        toggle: getComputedStyle(document.querySelector('.app-sidebar-toggle')!).transform,
        overflow: document.documentElement.scrollWidth - innerWidth }
    })
    expect(result.left).toBe(0)
    expect(result.background).toBe('rgba(0, 0, 0, 0)')
    expect(result.iconWidth).toBe(22)
    expect(result.iconHeight).toBe(22)
    expect(result.iconTextGap).toBe(6)
    expect(Math.abs(result.iconCenterOffset)).toBeLessThanOrEqual(0.5)
    expect(result.radius).toBe('16px')
    expect(result.titleSize).toBe('15px')
    expect(result.menuSize).toBe('13px')
    expect(result.toggle).toBe('matrix(1, 0, 0, 1, 2, 0)')
    expect(result.overflow).toBeLessThanOrEqual(1)
    await page.screenshot({ path: testInfo.outputPath(`startup-${width}.png`) })
  }
  expect(errors).toEqual([])
})

test('shows a brief first-use explanation and then selects the folder without repeating it', async ({ page }, testInfo) => {
  await page.goto(url)
  await page.getByRole('button', { name: '选择工作区', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '让文档出现在这里' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('选一个文档文件夹，里面的文档就会显示在左侧文件树中。')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('workspace-introduction.png'), animations: 'disabled' })
  await dialog.getByRole('button', { name: '好的', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: '我的笔记.md', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '我的文档', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('keeps the explanation static for reduced motion and supports keyboard dismissal', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' })
  await page.goto(url)
  const trigger = page.getByRole('button', { name: '选择工作区', exact: true })
  await trigger.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('.workspace-introduction-tree span').first()).toHaveCSS('animation-name', 'none')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('pristine welcome actions open a workspace or a new document without a save prompt', async ({ page }) => {
  await page.goto(url)
  await expect(page).toHaveTitle('欢迎使用.md — Arkdown')
  await page.getByRole('link', { name: '选择工作区', exact: true }).click()
  await expect(page.getByRole('button', { name: '我的文档', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '我的笔记.md', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.ProseMirror')).toContainText('把想法写下来')
  await expect(page).toHaveTitle('欢迎使用.md — Arkdown')
  await page.goto(url)
  await expect(page).toHaveTitle('欢迎使用.md — Arkdown')
  await page.getByRole('link', { name: '新建文档', exact: true }).click()
  await expect(page.locator('.ProseMirror')).not.toContainText('把想法写下来')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('edited welcome actions confirm unsaved changes and tree drops insert paths', async ({ page }) => {
  await page.goto(url)
  await expect(page.locator('.ProseMirror')).toBeVisible()
  await expect(page.locator('.statusbar')).toHaveCount(0)
  // Make a real edit; opening/serializing the welcome document must not supply this precondition.
  const task = page.locator('.ProseMirror .label').first()
  await task.click()
  await expect(task).toHaveClass(/\bchecked\b/)
  await expect(page).toHaveTitle('● 欢迎使用.md — Arkdown')
  await page.getByRole('link', { name: '选择工作区', exact: true }).click()
  const saveDialog = page.getByRole('dialog', { name: '是否保存对“欢迎使用.md”的更改？' })
  await expect(saveDialog).toBeVisible()
  await saveDialog.getByRole('button', { name: '不保存', exact: true }).click()
  await expect(page.getByRole('button', { name: '我的文档', exact: true })).toBeVisible()
  const row = page.locator('.tree-row', { hasText: '我的笔记.md' })
  await expect(row).toBeVisible()
  await row.click()
  const target = page.locator('.ProseMirror p').first()
  const box = (await target.boundingBox())!
  const source = (await row.boundingBox())!
  await page.mouse.move(source.x + 30, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 45, box.y + box.height / 2, { steps: 16 })
  await page.mouse.up()
  const inserted = page.locator('.ProseMirror a.arkdown-local-link')
  await expect(inserted).toHaveText('我的笔记.md')
  expect((await inserted.getAttribute('href'))?.replaceAll('\\', '/')).toBe('C:/Preview/Notes/我的笔记.md')
  const folder = page.getByRole('button', { name: '资料', exact: true })
  const folderBox = (await folder.boundingBox())!
  await page.mouse.move(folderBox.x + 35, folderBox.y + folderBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 15, box.y + box.height / 2, { steps: 16 })
  await page.mouse.up()
  const folderLink = page.locator('.ProseMirror a.arkdown-local-link', { hasText: '资料' })
  await expect(folderLink).toBeVisible()
  expect((await folderLink.getAttribute('href'))?.replaceAll('\\', '/')).toBe('C:/Preview/Notes/资料')
  await page.goto(url)
  await task.click()
  await expect(task).toHaveClass(/\bchecked\b/)
  await expect(page).toHaveTitle('● 欢迎使用.md — Arkdown')
  await page.getByRole('link', { name: '新建文档', exact: true }).click()
  await expect(saveDialog).toBeVisible()
  await saveDialog.getByRole('button', { name: '不保存', exact: true }).click()
  await expect(page.locator('.ProseMirror')).not.toContainText('把想法写下来')
})

test('pushes the body aside for the outline and navigates in rendered and source modes', async ({ page }, testInfo) => {
  await page.goto(url)
  const editor = page.locator('.editor-surface')
  const original = (await editor.boundingBox())!
  const trigger = page.getByRole('button', { name: '大纲', exact: true })
  await trigger.click()
  const outline = page.getByRole('navigation', { name: '文档大纲' })
  await expect(outline).toBeVisible()
  await expect.poll(async () => (await editor.boundingBox())!.x - original.x).toBeGreaterThan(100)
  await outline.getByRole('button', { name: '现在开始', exact: true }).click()
  await expect(page.locator('.ProseMirror').getByRole('heading', { name: '现在开始', exact: true })).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('outline-rendered.png') })
  await page.getByRole('button', { name: '源码模式/渲染模式' }).click()
  await outline.getByRole('button', { name: '现在开始', exact: true }).click()
  await expect(page.locator('.cm-activeLine')).toContainText('## 现在开始')
  await page.locator('.cm-content').press('Control+a')
  await page.keyboard.insertText('没有标题的普通正文')
  await expect(trigger).toHaveCount(0)
})
