import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cleanupRuntime, createRuntimeInstance, shutdownElectronApplicationScope, type RuntimeInstance } from './support/runtime'

const SOURCE = ['# Mermaid reading', '', ...Array.from({ length: 12 }, (_, i) => `Context paragraph ${i + 1}.\n`),
  '```mermaid', 'flowchart LR', ...Array.from({ length: 12 }, (_, i) => `N${i}["Process step ${i + 1}"] --> N${i + 1}["Process step ${i + 2}"]`), '```', '', 'Editable footer.', ''].join('\n')
const TRANSFORMED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1200" viewBox="0 0 2000 1200"><rect width="2000" height="1200" fill="#fff"/><g transform="scale(0.5)"><text x="100" y="120" font-size="24" fill="#222">Title <tspan id="small-label" font-size="8">Small visible label</tspan></text><text x="100" y="200" font-size="0.1" visibility="hidden">Hidden</text></g></svg>'

async function closeWithEscape(page: Page) {
  expect(page.isClosed()).toBe(false)
  const closed = page.waitForEvent('close')
  const [, sent] = await Promise.all([closed, page.keyboard.press('Escape').then(
    () => ({ error: undefined }), error => ({ error }),
  )])
  // Escape closes on keydown; Electron may destroy the CDP target before the
  // synthetic keyup reply. Require the close event and reject unrelated errors.
  if (sent.error) expect(String(sent.error)).toContain('Target page, context or browser has been closed')
  expect(page.isClosed()).toBe(true)
}

async function openSnapshot(page: Page, app: ElectronApplication, svg: string, dark = false) {
  const opened = app.waitForEvent('window', { timeout: 15_000 })
  const reply = await page.evaluate(async ({ svg, dark }) => {
    const svgDataUrl = 'data:image/svg+xml;base64,' + btoa(svg)
    return window.arkdown.openMermaidViewer?.({ svgDataUrl, colorScheme: dark ? 'dark' : 'light', themeColor: '#c62828' })
  }, { svg, dark })
  expect(reply).toEqual({ ok: true, value: null })
  const viewer = await opened
  await expect(viewer.getByRole('button', { name: '阅读大小', exact: true })).toBeEnabled()
  return viewer
}

test('Mermaid click opens a readable vector snapshot with zoom, pan and close without changing the editor', async ({}, testInfo) => {
  test.setTimeout(240_000)
  const shared = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!shared) throw new Error('Provenance-audited runtime required')
  const workspace = await mkdtemp(path.join(tmpdir(), 'arkdown-mermaid-viewer-workspace-'))
  let runtime: RuntimeInstance | undefined
  let application: ElectronApplication | undefined
  const sourcePath = path.join(workspace, 'mermaid-reading.md')
  try {
    await writeFile(sourcePath, SOURCE, 'utf8')
    runtime = await createRuntimeInstance(shared, 'arkdown-mermaid-viewer-runtime-')
    const temporary = path.join(runtime.root, 'temp')
    await mkdir(temporary, { recursive: true })
    application = await electron.launch({ executablePath: runtime.executable, cwd: runtime.application, timeout: 30_000,
      args: ['--disable-gpu', `--user-data-dir=${runtime.userData}`],
      env: { ...process.env, APPDATA: runtime.root, LOCALAPPDATA: runtime.root, TEMP: temporary, TMP: temporary, TMPDIR: temporary,
        ARKDOWN_E2E: '1', ARKDOWN_E2E_RECOVER: '1', ARKDOWN_E2E_WORKSPACE: workspace } })
    const app = application
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.getByRole('button', { name: 'mermaid-reading.md', exact: true }).click()
    const editor = page.locator('.visual-editor .ProseMirror')
    await expect(editor).toContainText('Editable footer.')
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText(' Unsaved footer survives viewer.')
    await expect(page.locator('.document-save-controls')).toHaveAttribute('data-state', 'dirty')
    const dirtyText = await editor.innerText()
    const image = page.getByRole('button', { name: '在新窗口查看 Mermaid 图形', exact: true })
    await image.scrollIntoViewIfNeeded()
    await expect(image).toBeVisible()
    const before = await image.boundingBox()
    const opened = app.waitForEvent('window', { timeout: 15_000 })
    await image.click()
    const viewer = await opened
    viewer.on('pageerror', error => errors.push(error.message))
    await expect(viewer.getByRole('button', { name: '阅读大小', exact: true })).toBeEnabled()
    const labels = viewer.locator('.mermaid-viewer-svg .node text')
    await expect(labels.first()).toBeVisible()
    const sizes = await labels.evaluateAll(elements => elements.filter(element => element.textContent?.trim()).map(element => {
      const matrix = (element as SVGGraphicsElement).getScreenCTM()!
      return parseFloat(getComputedStyle(element).fontSize) * Math.hypot(matrix.c, matrix.d)
    }))
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(13.9)
    expect(await viewer.locator('.mermaid-viewer-viewport').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
    await viewer.screenshot({ path: testInfo.outputPath('mermaid-reading-size.png') })

    await test.step('wheel zoom, pan, fit and reading controls work in the real renderer', async () => {
      const output = viewer.getByLabel('缩放比例')
      const initial = await output.textContent()
      const viewport = viewer.locator('.mermaid-viewer-viewport')
      await viewport.hover()
      await viewer.mouse.wheel(0, -150)
      await expect(output).not.toHaveText(initial!)
      const bounds = await viewport.boundingBox()
      await viewer.mouse.move(bounds!.x + 350, bounds!.y + 160)
      await viewer.mouse.down()
      await viewer.mouse.move(bounds!.x + 170, bounds!.y + 160, { steps: 5 })
      await viewer.mouse.up()
      expect(await viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(50)
      await viewer.getByRole('button', { name: '适合窗口', exact: true }).click()
      expect(await viewport.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      await viewer.getByRole('button', { name: '阅读大小', exact: true }).click()
      await expect(output).toHaveText(initial!)
      await viewer.getByRole('button', { name: '放大', exact: true }).click()
      await expect(output).not.toHaveText(initial!)
      await viewer.getByRole('button', { name: '缩小', exact: true }).click()
      await expect(output).toHaveText(initial!)
    })

    await test.step('the same snapshot reuses a window and Escape preserves editor content and position', async () => {
      await page.bringToFront()
      await image.click()
      expect(app.windows()).toHaveLength(2)
      await viewer.bringToFront()
      await closeWithEscape(viewer)
      await page.bringToFront()
      expect(await editor.innerText()).toBe(dirtyText)
      await expect(page.locator('.document-save-controls')).toHaveAttribute('data-state', 'dirty')
      const after = await image.boundingBox()
      expect(Math.abs(after!.y - before!.y)).toBeLessThan(2)
      expect(await readFile(sourcePath, 'utf8')).toBe(SOURCE)
    })

    await test.step('nested SVG transforms and tspan sizes determine the 14 CSS pixel threshold', async () => {
      const transformed = await openSnapshot(page, app, TRANSFORMED_SVG)
      transformed.on('pageerror', error => errors.push(error.message))
      await expect(transformed.getByLabel('缩放比例')).toHaveText('350%')
      const small = transformed.locator('.mermaid-viewer-svg #small-label')
      const measured = await small.evaluate(element => {
        const matrix = (element as SVGGraphicsElement).getScreenCTM()!
        return parseFloat(getComputedStyle(element).fontSize) * Math.hypot(matrix.c, matrix.d)
      })
      expect(measured).toBeCloseTo(14, 1)
      await transformed.screenshot({ path: testInfo.outputPath('mermaid-transformed-text.png') })
      await test.step('the canvas menu saves a complete PNG despite zoom and pan', async () => {
        const savedPath = path.join(workspace, 'complete-mermaid.png')
        await app.evaluate(({ dialog }, filePath) => {
          const holder = dialog as typeof dialog & { __mermaidOriginalSave?: typeof dialog.showSaveDialog }
          holder.__mermaidOriginalSave = dialog.showSaveDialog
          dialog.showSaveDialog = async () => ({ canceled: false, filePath })
        }, savedPath)
        try {
          expect(await transformed.evaluate(() => window.devicePixelRatio)).toBe(1.5)
          await transformed.getByRole('button', { name: '放大', exact: true }).click()
          const canvas = transformed.getByLabel('图表画布')
          await canvas.evaluate(element => { element.scrollLeft = 300; element.scrollTop = 200 })
          await canvas.click({ button: 'right', position: { x: 200, y: 160 } })
          await transformed.getByRole('menuitem', { name: '保存为图片', exact: true }).click()
          await expect.poll(async () => readFile(savedPath).then(bytes => bytes.length, () => 0)).toBeGreaterThan(33)
          const png = await readFile(savedPath)
          expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
          // Original 2000 × 1200 snapshot at the native 150% density; viewport is smaller.
          expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([3000, 1800])
          expect(await transformed.getByRole('alert').count()).toBe(0)
        } finally {
          await app.evaluate(({ dialog }) => {
            const holder = dialog as typeof dialog & { __mermaidOriginalSave?: typeof dialog.showSaveDialog }
            if (holder.__mermaidOriginalSave) dialog.showSaveDialog = holder.__mermaidOriginalSave
            delete holder.__mermaidOriginalSave
          })
        }
      })
      await closeWithEscape(transformed)
    })

    await test.step('textless diagrams fit, dark snapshots and window resizing remain usable', async () => {
      const textless = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2400 1800"><rect width="2400" height="1800" fill="#20242a"/><circle cx="1200" cy="900" r="700" fill="#c62828"/></svg>'
      const dark = await openSnapshot(page, app, textless, true)
      await expect(dark.locator('html')).toHaveAttribute('data-arkdown-theme', 'dark')
      const viewport = dark.locator('.mermaid-viewer-viewport')
      expect(await viewport.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      const native = await app.browserWindow(dark)
      try { await native.evaluate(window => window.setSize(600, 420)) } finally { await native.dispose() }
      await expect.poll(() => viewport.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      await dark.getByRole('button', { name: '最大化', exact: true }).click()
      await expect(dark.getByRole('button', { name: '还原', exact: true })).toBeVisible()
      await dark.getByRole('button', { name: '还原', exact: true }).click()
      await dark.screenshot({ path: testInfo.outputPath('mermaid-dark-fit.png') })
      const closed = dark.waitForEvent('close')
      await dark.getByRole('button', { name: '关闭', exact: true }).click()
      await closed
    })
    expect(errors).toEqual([])
    expect(await readFile(sourcePath, 'utf8')).toBe(SOURCE)
  } finally {
    if (runtime) {
      await shutdownElectronApplicationScope({ application, executable: runtime.executable, requestClose: target => target.close() })
      await cleanupRuntime(runtime.root)
    }
    const resolved = path.resolve(workspace)
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('arkdown-mermaid-viewer-workspace-')) throw new Error('Unexpected test workspace path')
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
