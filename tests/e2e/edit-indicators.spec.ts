import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  cleanupRuntime,
  createRuntimeInstance,
  shutdownElectronApplicationScope,
  type RuntimeInstance,
} from './support/runtime'

const OPENING_MARKDOWN = [
  '# Indicator lifecycle',
  '',
  'Opening paragraph.',
  '',
  '## Foldable section',
  '',
  ...Array.from({ length: 30 }, (_, index) => (
    `Long wrapping line ${index + 1}: ${'width-sensitive content '.repeat(12)}`
  )),
  '',
].join('\n')

const TASK_MARKDOWN = '# Checklist\r\n\r\n' + Array.from({ length: 106 }, (_, index) => (
  `- [ ] **Task ${index + 1}**: verify \`Ctrl+S\` and [links](https://example.com).`
)).join('\r\n') + '\r\n'

let application: ElectronApplication | undefined
let page: Page
let runtime: RuntimeInstance
let requestedDpr = 1.5

const sourceMarkers = () => page.locator('.arkdown-source-edit-indicator')

async function sourceEditorState(): Promise<{
  content: string | null
  foldCount: number
  scrollTop: number
  selection: { anchorOffset: number; focusOffset: number; text: string }
}> {
  return await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>('.source-editor .cm-content')!
    const scroller = document.querySelector<HTMLElement>('.source-editor .cm-scroller')!
    const selection = getSelection()
    return {
      content: content.textContent,
      foldCount: document.querySelectorAll('.arkdown-source-fold-triangle--right').length,
      scrollTop: scroller.scrollTop,
      selection: {
        anchorOffset: selection?.anchorOffset ?? -1,
        focusOffset: selection?.focusOffset ?? -1,
        text: selection?.toString() ?? '',
      },
    }
  })
}

async function openViewMenu(): Promise<void> {
  await page.getByTestId('app-titlebar').getByRole('button', { name: '视图', exact: true }).click()
  await expect(page.locator('.application-menu-popover')).toBeVisible()
}

async function toggleIndicators(): Promise<void> {
  await openViewMenu()
  await page.getByRole('menuitemcheckbox', { name: '源码编辑提示', exact: true }).click()
}

async function setEditorZoom(target: 70 | 100 | 200): Promise<void> {
  const pane = page.locator('.editor-pane')
  while (Number(await pane.getAttribute('data-editor-zoom-percent')) !== target) {
    const current = Number(await pane.getAttribute('data-editor-zoom-percent'))
    await openViewMenu()
    await page.getByRole('menuitem', {
      name: current < target ? '仅放大编辑区' : '仅缩小编辑区',
      exact: true,
    }).click()
    await expect(pane).not.toHaveAttribute('data-editor-zoom-percent', String(current))
  }
}

async function environmentSnapshot(): Promise<Record<string, unknown>> {
  const native = await application!.evaluate(({ BrowserWindow, screen }) => ({
    systemScale: screen.getPrimaryDisplay().scaleFactor,
    windowBounds: BrowserWindow.getAllWindows()[0]?.getBounds() ?? null,
  }))
  const actualDpr = await page.evaluate(() => devicePixelRatio)
  expect(native.systemScale).toBe(1.5)
  expect(actualDpr).toBe(requestedDpr)
  return { requestedDpr, actualDpr, ...native }
}

async function attachGeometry(testInfo: TestInfo, label: string): Promise<void> {
  const screenshot = await page.screenshot()
  const geometry = await page.locator([
    '.arkdown-visual-edit-indicator-segment',
    '.arkdown-source-edit-indicator',
  ].join(',')).evaluateAll((elements) => elements.map((element) => {
    const box = (element as HTMLElement).getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      className: element.className,
      background: style.backgroundColor,
      boxShadow: style.boxShadow,
      pointerEvents: style.pointerEvents,
    }
  }))
  await testInfo.attach(`${label}.png`, { body: screenshot, contentType: 'image/png' })
  await testInfo.attach(`${label}.json`, {
    body: Buffer.from(JSON.stringify({
      ...await environmentSnapshot(),
      geometry,
      screenshotSampling: geometry.map(({ box, background }) => ({
        physicalCenter: {
          x: Math.floor((box.x + box.width / 2) * requestedDpr),
          y: Math.floor((box.y + box.height / 2) * requestedDpr),
        },
        expectedCssColor: background,
      })),
    }, null, 2)),
    contentType: 'application/json',
  })
}

test.beforeEach(async ({}, testInfo) => {
  requestedDpr = Number(testInfo.project.metadata.requestedDpr)
  const sharedApplication = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!sharedApplication) throw new Error('Electron E2E shared runtime is not prepared')
  runtime = await createRuntimeInstance(sharedApplication, 'arkdown-edit-indicators-e2e-runtime-')
  const workspace = path.join(runtime.root, 'workspace')
  await mkdir(workspace, { recursive: true })
  await Promise.all([
    writeFile(path.join(workspace, 'indicators.md'), OPENING_MARKDOWN, 'utf8'),
    writeFile(path.join(workspace, 'blank.md'), '', 'utf8'),
    writeFile(path.join(workspace, 'checklist.md'), TASK_MARKDOWN, 'utf8'),
  ])
  application = await electron.launch({
    executablePath: runtime.executable,
    cwd: runtime.application,
    timeout: 30_000,
    args: [
      '--disable-gpu',
      `--force-device-scale-factor=${requestedDpr}`,
      `--user-data-dir=${runtime.userData}`,
    ],
    env: {
      ...process.env,
      APPDATA: runtime.root,
      LOCALAPPDATA: runtime.root,
      ARKDOWN_E2E: '1',
      ARKDOWN_E2E_RECOVER: '1',
      ARKDOWN_E2E_WORKSPACE: workspace,
    },
  })
  page = await application.firstWindow({ timeout: 15_000 })
  await page.getByRole('button', { name: 'indicators.md', exact: true }).click()
  await expect(page.locator('.ProseMirror')).toContainText('Indicator lifecycle')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus())
})

test.afterEach(async () => {
  const target = application
  application = undefined
  if (runtime?.executable) {
    await shutdownElectronApplicationScope({
      application: target,
      executable: runtime.executable,
      requestClose: async (targetApplication) => await targetApplication.close(),
    })
  }
  if (runtime?.root) await cleanupRuntime(runtime.root)
})

test('keeps task toggles local through undo, save, and source mode', async () => {
  await page.getByRole('button', { name: 'checklist.md', exact: true }).click()
  const unchecked = page.locator('.ProseMirror .label.unchecked')
  await expect(unchecked).toHaveCount(106)
  await unchecked.first().click()

  const menuCommand = async (menu: string, command: RegExp) => {
    await page.getByTestId('app-titlebar').getByRole('button', { name: menu, exact: true }).click()
    await page.getByRole('menuitem', { name: command }).click()
  }
  await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus())
  await page.locator('.ProseMirror h1').click()
  await page.keyboard.press('Control+z')
  await expect(unchecked).toHaveCount(106)
  await page.keyboard.press('Control+y')
  await menuCommand('文件', /^保存\s/)
  const filename = path.join(runtime.root, 'workspace', 'checklist.md')
  const firstSaved = TASK_MARKDOWN.replace('- [ ] **Task 1**', '- [x] **Task 1**')
  await expect.poll(() => readFile(filename, 'utf8')).toBe(firstSaved)

  await unchecked.first().click()
  await menuCommand('文件', /^保存\s/)
  const secondSaved = firstSaved.replace('- [ ] **Task 2**', '- [x] **Task 2**')
  await expect.poll(() => readFile(filename, 'utf8')).toBe(secondSaved)
  await page.locator('.source-mode-toolbar-button').click()
  await expect(page.locator('.arkdown-source-edit-indicator--unsaved')).toHaveCount(0)
  await expect(page.locator('.arkdown-source-edit-indicator--saved')).toHaveCount(2)
  await page.getByRole('button', { name: 'blank.md', exact: true }).click()
  await page.getByRole('button', { name: 'checklist.md', exact: true }).click()
  if (!await page.locator('.source-editor').isVisible()) await page.locator('.source-mode-toolbar-button').click()
  await expect(page.locator('.source-editor')).toBeVisible()
  await expect.poll(() => page.workers().filter(worker => /edit-indicator/.test(worker.url())).length).toBe(1)
  await expect(page.locator('.arkdown-source-edit-indicator--none').first()).toBeVisible()
  await expect(page.locator('.arkdown-source-edit-indicator--saved')).toHaveCount(0)
  expect(await readFile(filename, 'utf8')).toBe(secondSaved)
})

test('runs indicators only in source mode while preserving save, undo and reopening', async ({}, testInfo) => {
  const indicatorWorkers = () => page.workers().filter(worker => /edit-indicator/.test(worker.url())).length
  await expect(page.locator('[data-arkdown-edit-indicator-state]')).toHaveCount(0)
  await expect(page.locator('.arkdown-visual-edit-indicator-layer')).toHaveCount(0)
  expect(indicatorWorkers()).toBe(0)
  await page.locator('.source-mode-toolbar-button').click()
  const source = page.locator('.source-editor .cm-content')
  await expect.poll(indicatorWorkers).toBe(1)
  await source.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('\nUnsaved change')
  await expect(page.locator('.arkdown-source-edit-indicator--unsaved').first()).toBeVisible()
  const menuSave = async () => {
    await page.getByTestId('app-titlebar').getByRole('button', {name:'文件',exact:true}).click()
    await page.getByRole('menuitem', {name:/^保存\s/}).click()
  }
  await menuSave()
  await expect(page.locator('.arkdown-source-edit-indicator--unsaved')).toHaveCount(0)
  await expect(page.locator('.arkdown-source-edit-indicator--saved').first()).toBeVisible()
  await source.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(' again')
  await expect(page.locator('.arkdown-source-edit-indicator--unsaved').first()).toBeVisible()
  await page.keyboard.press('Control+z')
  await expect(page.locator('.arkdown-source-edit-indicator--unsaved')).toHaveCount(0)
  await page.locator('.source-mode-toolbar-button').click()
  await expect(page.locator('.ProseMirror')).toContainText('Unsaved change')
  await expect.poll(indicatorWorkers).toBe(0)
  await expect(page.locator('[data-arkdown-edit-indicator-state]')).toHaveCount(0)
  await page.locator('.source-mode-toolbar-button').click()
  await expect.poll(indicatorWorkers).toBe(1)
  // CodeMirror only mounts markers for the rendered viewport.
  await source.click()
  await page.keyboard.press('Control+End')
  await expect(page.locator('.arkdown-source-edit-indicator--saved').first()).toBeVisible()
  await page.getByRole('button', {name:'blank.md',exact:true}).click()
  await page.getByRole('button', {name:'indicators.md',exact:true}).click()
  if (!await page.locator('.source-editor').isVisible()) await page.locator('.source-mode-toolbar-button').click()
  await expect(page.locator('.source-editor')).toBeVisible()
  await expect.poll(indicatorWorkers).toBe(1)
  await expect(page.locator('.arkdown-source-edit-indicator--none').first()).toBeVisible()
  await expect(page.locator('.arkdown-source-edit-indicator--saved')).toHaveCount(0)
  await expect(page.locator('.arkdown-source-edit-indicator--unsaved')).toHaveCount(0)
  await attachGeometry(testInfo,'source-indicator-lifecycle')
})

test('keeps hidden computation and editor state hot across fold, scroll, resize, zoom, and reduced motion', async ({}, testInfo) => {
  await page.locator('.source-mode-toolbar-button').click()
  const source = page.locator('.source-editor .cm-content')
  const sourceEditor = page.locator('.source-editor .cm-editor')
  const originalSourceEditor = await sourceEditor.elementHandle()
  if (!originalSourceEditor) throw new Error('Source editor identity is unavailable')
  await source.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('\n## Editable tail\n\nHidden computation')
  await expect(page.locator('.arkdown-source-edit-indicator--unsaved').first()).toBeVisible()
  await page.keyboard.press('Control+Home')
  // Fold the second heading, leaving the editable tail outside its range.
  // The gutter also has a hidden sizing marker, so use visible triangles.
  const fold = page.locator('.source-editor .arkdown-source-fold-triangle--down:visible').nth(1)
  await expect(fold).toBeVisible()
  await fold.click()
  await expect(page.locator('.arkdown-source-fold-triangle--right:visible').first()).toBeVisible()
  await source.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Control+Shift+ArrowLeft')
  const before = await sourceEditorState()
  expect(before.selection.text).toBe('computation')
  expect(before.selection.anchorOffset).toBeGreaterThanOrEqual(0)
  expect(before.selection.focusOffset).toBeGreaterThanOrEqual(0)
  expect(before.selection.anchorOffset).not.toBe(before.selection.focusOffset)

  await toggleIndicators()
  // Hidden indicators retain an empty gutter so text does not move horizontally.
  await expect(page.locator('.arkdown-source-edit-indicator--unsaved, .arkdown-source-edit-indicator--saved')).toHaveCount(0)
  const afterHidden = await sourceEditorState()
  expect(afterHidden.content).toBe(before.content)
  expect(afterHidden.selection).toEqual(before.selection)
  expect(afterHidden.foldCount).toBe(before.foldCount)
  expect(Math.abs(afterHidden.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1)
  await source.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(' latest')
  await page.keyboard.press('Control+Shift+ArrowLeft')
  const hidden = await sourceEditorState()
  expect(hidden.content).toContain(before.content)
  expect(hidden.content).toContain('Hidden computation latest')
  expect(hidden.foldCount).toBe(before.foldCount)
  expect(hidden.selection.text).toBe('latest')
  expect(hidden.selection.anchorOffset).toBeGreaterThanOrEqual(0)
  expect(hidden.selection.focusOffset).toBeGreaterThanOrEqual(0)
  expect(hidden.selection.anchorOffset).not.toBe(hidden.selection.focusOffset)

  await toggleIndicators()
  await expect(page.locator('.arkdown-source-edit-indicator--unsaved').first()).toBeVisible()
  const afterShown = await sourceEditorState()
  expect(afterShown.content).toBe(hidden.content)
  expect(afterShown.selection).toEqual(hidden.selection)
  expect(afterShown.foldCount).toBe(hidden.foldCount)
  expect(Math.abs(afterShown.scrollTop - hidden.scrollTop)).toBeLessThanOrEqual(1)
  expect(await sourceEditor.evaluate((node, original) => node.isSameNode(original), originalSourceEditor)).toBe(true)
  const sidebarResizer = page.locator('.sidebar-resizer')
  await expect(sidebarResizer).toBeVisible()
  const resizerBox = await sidebarResizer.boundingBox()
  if (!resizerBox) throw new Error('Sidebar resizer geometry is unavailable')
  const sidebarBefore = await page.locator('.sidebar').boundingBox()
  if (!sidebarBefore) throw new Error('Sidebar geometry is unavailable before resize')
  await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + 100)
  await page.mouse.down()
  await page.mouse.move(resizerBox.x + 80, resizerBox.y + 100, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => {
    const sidebarAfter = await page.locator('.sidebar').boundingBox()
    if (!sidebarAfter) throw new Error('Sidebar geometry is unavailable after resize')
    return Math.abs(sidebarAfter.width - sidebarBefore.width)
  }).toBeGreaterThan(40)
  await application!.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ width: 980, height: 720 })
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })

  const zoomGeometry: Record<string, number[]> = {}
  for (const zoom of [70, 100, 200] as const) {
    await setEditorZoom(zoom)
    const widths = await page.locator('.arkdown-source-edit-indicator').evaluateAll(
      (markers) => markers.slice(0, 5).map((marker) => marker.getBoundingClientRect().width),
    )
    expect(widths.length).toBeGreaterThan(0)
    expect(widths.every((width) => Math.abs(width - 5) < 0.05)).toBe(true)
    zoomGeometry[String(zoom)] = widths
  }
  expect(await page.locator('.arkdown-source-edit-indicator--unsaved').first().evaluate(
    (marker) => getComputedStyle(marker).animationName,
  )).toBe('none')
  expect(Object.keys(zoomGeometry)).toEqual(['70', '100', '200'])
  await attachGeometry(testInfo, 'edit-indicator-stress')
  await page.getByTestId('app-titlebar').getByRole('button', {name:'文件',exact:true}).click()
  await page.getByRole('menuitem', {name:/^保存\s/}).click()
  await expect.poll(() => readFile(path.join(runtime.root, 'workspace', 'indicators.md'), 'utf8'))
    .toContain('Hidden computation latest')
  await expect(page.getByRole('button', {name:'保存',exact:true})).toBeDisabled()
})
