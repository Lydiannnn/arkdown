import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  cleanupRuntime, createRuntimeInstance, runE2eStage, shutdownElectronApplicationScope,
  type RuntimeInstance,
} from './support/runtime'

// Executed only against Task 7's provenance-audited package by the normal global setup.
let runtime: RuntimeInstance
let workspace = ''
let arkdown: ElectronApplication | undefined
let arknote: ElectronApplication | undefined
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600"><rect width="2400" height="1600" fill="#386dbe"/><circle cx="1800" cy="1100" r="300" fill="#efbd52"/></svg>'

test.beforeEach(async () => {
  const shared = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!shared) throw new Error('Audited Electron E2E shared runtime is not prepared')
  runtime = await createRuntimeInstance(shared, 'arkdown-background-e2e-')
  workspace = await mkdtemp(path.join(tmpdir(), 'arkdown-background-workspace-'))
  await mkdir(runtime.portableData, { recursive: true })
  await writeFile(
    path.join(runtime.portableData, 'settings.json'),
    `${JSON.stringify({ lastWorkspace: workspace }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(path.join(workspace, 'wallpaper.svg'), SVG, 'utf8')
  await writeFile(path.join(workspace, 'note.md'), '# Background owner\n\nKeep this removable', 'utf8')
})

async function stopApps() {
  const failures: unknown[] = []
  for (const [application, executable] of [
    [arkdown, runtime.executable], [arknote, runtime.arknoteExecutable],
  ] as const) {
    await shutdownElectronApplicationScope({
      application, executable,
      requestClose: async (target) => await target.close(),
    }).catch((error: unknown) => failures.push(error))
  }
  arkdown = undefined
  arknote = undefined
  if (failures.length) throw new AggregateError(failures, 'Background E2E shutdown did not stabilize')
}

test.afterEach(async () => {
  if (runtime) await stopApps()
  if (workspace) await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  if (runtime) await cleanupRuntime(runtime.root)
})

async function launch(kind: 'main' | 'note') {
  const application = await runE2eStage(`启动背景回归 ${kind}`, async () => await electron.launch({
    executablePath: kind === 'main' ? runtime.executable : runtime.arknoteExecutable,
    cwd: runtime.application, timeout: 30_000,
    args: ['--disable-gpu', ...(kind === 'main'
      ? [`--user-data-dir=${runtime.userData}`, path.join(workspace, 'note.md')]
      : ['--arkdown-autostart'])],
    env: { ...process.env, APPDATA: runtime.root, LOCALAPPDATA: runtime.root,
      ARKDOWN_E2E: '1', ARKDOWN_E2E_RECOVER: '1', ARKDOWN_E2E_WORKSPACE: '' },
  }))
  if (kind === 'note') { arknote = application; return undefined }
  arkdown = application
  const page = await application.firstWindow({ timeout: 15_000 })
  await expect(page.getByTestId('app-titlebar')).toBeVisible()
  await expect(page.getByRole('button', { name: 'note.md', exact: true })).toBeVisible()
  return page
}

function surfaces(application: ElectronApplication, surface: string, noteId?: string) {
  return application.windows().filter((page) => {
    if (page.isClosed()) return false
    try {
      const query = new URL(page.url()).searchParams
      return query.get('surface') === surface && (!noteId || query.get('noteId') === noteId)
    } catch { return false }
  })
}

async function background(application: ElectronApplication, noteId?: string) {
  await expect.poll(() => surfaces(application, 'background-settings', noteId).length).toBe(1)
  const page = surfaces(application, 'background-settings', noteId)[0]!
  await expect(page.getByRole('main', { name: '背景设置' })).toBeVisible()
  return page
}

async function mainMenu(page: Page, menu: string, command: string | RegExp) {
  await page.getByTestId('app-titlebar').getByRole('button', { name: menu, exact: true }).click()
  await page.getByRole('menuitem', { name: command, exact: typeof command === 'string' }).click()
}

async function assertImage(page: Page, alignment: string) {
  const image = page.getByTestId('background-image-layer-image').first()
  await expect(image).toHaveAttribute('src', /^arkdown-asset:/u)
  await expect.poll(() => image.evaluate((element) => {
    const img = element as HTMLImageElement
    return img.complete && img.naturalWidth > 0
  })).toBe(true)
  await expect(page.getByTestId('background-image-layer').first()).toHaveAttribute('data-alignment', alignment)
}

async function setOpacity(page: Page, value: number) {
  await page.getByLabel('图片不透明度', { exact: true }).evaluate((element, next) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, String(next))
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
  await expect(page.getByLabel('图片不透明度', { exact: true })).toHaveValue(String(value))
}

async function chooseSvg(application: ElectronApplication, page: Page) {
  // Only the native picker result is stubbed; chooser, local asset access, stores and image decode stay real.
  await application.evaluate(({ dialog }, source) => {
    const state = globalThis as typeof globalThis & { __backgroundPicker?: typeof dialog.showOpenDialog }
    state.__backgroundPicker = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] })
  }, path.join(workspace, 'wallpaper.svg'))
  try {
    await page.getByRole('button', { name: /^(添加图片|更换图片)$/u }).click()
    await assertImage(page, 'right-bottom')
  } finally {
    await application.evaluate(({ dialog }) => {
      const state = globalThis as typeof globalThis & { __backgroundPicker?: typeof dialog.showOpenDialog }
      if (state.__backgroundPicker) dialog.showOpenDialog = state.__backgroundPicker
      delete state.__backgroundPicker
    })
  }
}

async function applySvg(application: ElectronApplication, page: Page) {
  await chooseSvg(application, page)
  await page.getByLabel('图片对齐方式').selectOption('left-top')
  await setOpacity(page, 61)
  await assertImage(page, 'left-top')
  await expect(page.getByTestId('background-image-layer-image')).toHaveAttribute('data-mask-type', 'diagonal-top-left')
  await page.getByRole('button', { name: '应用', exact: true }).click()
  await expect.poll(() => page.isClosed()).toBe(true)
}

async function assertSavedSvg(root: string, relative: string) {
  expect(relative).toMatch(/\.svg$/u)
  const bytes = await readFile(path.join(root, relative))
  expect(createHash('sha256').update(bytes).digest('hex'))
    .toBe(createHash('sha256').update(SVG).digest('hex'))
}

test('main background theme entry, owner close veto/isolation and SVG save/reopen', async () => {
  const first = (await launch('main'))!
  await mainMenu(first, '文件', /偏好设置/u)
  await first.locator('a[href="#preferences-theme-heading"]').click()
  await first.getByRole('button', { name: '设置背景', exact: true }).click()
  let settings = await background(arkdown!)
  for (const [label, value] of [['图片不透明度', '50'], ['遮罩区域不透明度', '0'], ['遮罩过渡速度', '30'], ['遮罩强度', '80']]) {
    await expect(settings.getByLabel(label!, { exact: true })).toHaveValue(value!)
  }
  await expect(settings.getByLabel('图片对齐方式')).toHaveValue('right-bottom')
  await expect(settings.getByLabel('遮罩类型')).toHaveValue('diagonal-top-left')
  const display = await arkdown!.evaluate(({ screen }) => screen.getAllDisplays().map((item) => ({
    size: item.size, workArea: item.workArea, scaleFactor: item.scaleFactor,
  })))
  await test.info().attach('native-display-geometry', { body: JSON.stringify(display), contentType: 'application/json' })
  expect(await settings.locator('header').evaluate((element) => element.getBoundingClientRect().height)).toBe(60)
  await expect(settings.getByRole('button', { name: '应用', exact: true })).toBeInViewport()
  await expect(settings.getByRole('button', { name: '取消', exact: true })).toBeInViewport()
  const originalBounds = await arkdown!.evaluate(({ BrowserWindow }, url) => {
    const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL() === url)!
    const bounds = window.getBounds()
    window.setBounds({ ...bounds, width: 600, height: 560 })
    return bounds
  }, settings.url())
  await expect.poll(() => settings.locator('.background-settings-page__content').evaluate((element) => (
    element.scrollHeight > element.clientHeight
  ))).toBe(true)
  await expect(settings.getByRole('button', { name: '应用', exact: true })).toBeInViewport()
  await expect(settings.getByRole('button', { name: '取消', exact: true })).toBeInViewport()
  await arkdown!.evaluate(({ BrowserWindow }, input) => {
    BrowserWindow.getAllWindows().find((item) => item.webContents.getURL() === input.url)!.setBounds(input.bounds)
  }, { url: settings.url(), bounds: originalBounds })
  await applySvg(arkdown!, settings)
  await first.locator('.preferences-page-header').getByRole('button', { name: /返回/u }).click()
  await assertImage(first, 'left-top')
  await mainMenu(first, '主题', '设置背景...')
  settings = await background(arkdown!)

  const [second] = await Promise.all([
    arkdown!.waitForEvent('window'),
    mainMenu(first, '文件', '新建窗口 Ctrl+Shift+N'),
  ])
  await expect(second.getByTestId('app-titlebar')).toBeVisible()
  await mainMenu(second, '主题', '设置背景...')
  expect(await background(arkdown!)).toBe(settings)
  await second.locator('.window-close-button').click()
  await expect.poll(() => second.isClosed()).toBe(true)
  expect(settings.isClosed()).toBe(false)
  await setOpacity(settings, 72)
  await first.getByRole('button', { name: 'note.md', exact: true }).click()
  await first.locator('.ProseMirror').click()
  await first.keyboard.press('Control+End')
  await first.keyboard.press('Backspace')
  await first.evaluate(() => document.querySelector<HTMLButtonElement>('.window-close-button')!.click())
  const unsaved = first.getByRole('dialog', { name: '是否保存对“note.md”的更改？' })
  await unsaved.getByRole('button', { name: '取消', exact: true }).click()
  await expect(unsaved).toHaveCount(0)
  expect(settings.isClosed()).toBe(false)
  await setOpacity(settings, 73)

  const [keeper] = await Promise.all([
    arkdown!.waitForEvent('window'),
    mainMenu(first, '文件', '新建窗口 Ctrl+Shift+N'),
  ])
  await expect(keeper.getByTestId('app-titlebar')).toBeVisible()
  await first.locator('.window-close-button').click()
  await unsaved.getByRole('button', { name: '不保存', exact: true }).click()
  await expect.poll(() => first.isClosed() && settings.isClosed()).toBe(true)
  await mainMenu(keeper, '主题', '设置背景...')
  settings = await background(arkdown!)
  await expect(settings.getByLabel('图片不透明度', { exact: true })).toHaveValue('61')
  await assertImage(settings, 'left-top')
  await settings.getByRole('button', { name: '取消', exact: true }).click()
  await stopApps()

  const persisted = JSON.parse((await readFile(path.join(runtime.portableData, 'settings.json'), 'utf8')).replace(/^\uFEFF/u, ''))
  await assertSavedSvg(runtime.portableData, persisted.mainBackground.imageRelativePath)
  const restarted = (await launch('main'))!
  await mainMenu(restarted, '主题', '设置背景...')
  const reopened = await background(arkdown!)
  await assertImage(reopened, 'left-top')
  await expect(reopened.getByLabel('图片不透明度', { exact: true })).toHaveValue('61')
  await reopened.getByRole('button', { name: '取消', exact: true }).click()
})

async function openBox(main: Page) {
  await main.locator('.sticky-note-box-toolbar-button').click()
  await expect(main.locator('.sticky-note-box-panel')).toBeVisible()
  const hint = main.locator('.sticky-note-startup-hint')
  if (await hint.isVisible()) await hint.getByRole('button', { name: '不再提示' }).click()
  await expect(main.locator('.sticky-note-grid')).toBeVisible()
}

async function createNote(main: Page, name: string) {
  const existing = new Set(surfaces(arknote!, 'sticky-note'))
  await main.locator('.sticky-note-create-card').click()
  const dialog = main.locator('.sticky-note-name-dialog')
  await dialog.locator('input').fill(name)
  await dialog.locator('button').last().click()
  await expect.poll(() => surfaces(arknote!, 'sticky-note').filter((page) => !existing.has(page)).length).toBe(1)
  const note = surfaces(arknote!, 'sticky-note').find((page) => !existing.has(page))!
  await expect(note.locator('.sticky-note-editor .ProseMirror')).toBeVisible()
  return note
}

async function openNoteBackground(note: Page) {
  await note.locator('.sticky-note-editor .ProseMirror').click({ button: 'right' })
  await expect.poll(() => surfaces(arknote!, 'sticky-note-context-menu').length).toBe(1)
  const menu = surfaces(arknote!, 'sticky-note-context-menu')[0]!
  await menu.getByRole('menuitem', { name: '设置背景...', exact: true }).click()
  return background(arknote!, new URL(note.url()).searchParams.get('noteId')!)
}

test('sticky backgrounds remain owner-isolated and SVG survives a graceful service restart', async () => {
  await launch('note')
  let main = (await launch('main'))!
  await openBox(main)
  const a = await createNote(main, 'SVG owner A')
  const b = await createNote(main, 'SVG owner B')
  const idA = new URL(a.url()).searchParams.get('noteId')!
  await applySvg(arknote!, await openNoteBackground(a))
  await assertImage(a, 'left-top')
  const settingsA = await openNoteBackground(a)
  const settingsB = await openNoteBackground(b)
  await a.locator('.sticky-note-titlebar button').last().click()
  await expect.poll(() => a.isClosed() && settingsA.isClosed()).toBe(true)
  expect(settingsB.isClosed()).toBe(false)
  await setOpacity(settingsB, 76)
  await settingsB.getByRole('button', { name: '取消', exact: true }).click()
  await stopApps()

  const notesRoot = path.join(runtime.portableData, 'arknote', 'notes')
  const index = JSON.parse((await readFile(path.join(notesRoot, 'index.json'), 'utf8')).replace(/^\uFEFF/u, ''))
  const record = index.notes.find((item: { id: string }) => item.id === idA)
  expect(record.background.imageOpacityPercent).toBe(61)
  await assertSavedSvg(path.dirname(path.join(notesRoot, record.markdownRelativePath)), record.background.imageRelativePath)
  await launch('note')
  main = (await launch('main'))!
  await openBox(main)
  await main.getByRole('button', { name: 'SVG owner A', exact: true }).click()
  await expect.poll(() => surfaces(arknote!, 'sticky-note', idA).length).toBe(1)
  const reopenedNote = surfaces(arknote!, 'sticky-note', idA)[0]!
  await assertImage(reopenedNote, 'left-top')
  const reopened = await openNoteBackground(reopenedNote)
  await expect(reopened.getByLabel('图片不透明度', { exact: true })).toHaveValue('61')
  await assertImage(reopened, 'left-top')
  await reopened.getByRole('button', { name: '取消', exact: true }).click()
})
