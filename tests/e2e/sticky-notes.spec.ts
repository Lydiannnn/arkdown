import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CLIPBOARD_IMAGE_SENTINEL, expectNativePng, installNativeClipboardImage } from './support/clipboard-image'
import {
  cleanupRuntime,
  createRuntimeInstance,
  runE2eStage,
  shutdownElectronApplicationScope,
  type RuntimeInstance,
} from './support/runtime'

const IMPORT_FIXTURE = path.resolve('tests/fixtures/sticky-notes/e2e/import-with-image.md')
const IMPORT_IMAGE = path.resolve('tests/fixtures/sticky-notes/e2e/resources/fixture.svg')
const INTERACTION_POLISH_FIXTURE = path.resolve(
  'tests/fixtures/sticky-notes/e2e/interaction-polish.md',
)
const SELECTION_MARKDOWN = [
  '# Selection fixture',
  '',
  '- first list item',
  '- second list item',
  '',
  '| Name | Value |',
  '| --- | --- |',
  '| Alpha | One |',
  '| Beta | Two |',
  '',
].join('\n')

let application: ElectronApplication | undefined
let arknoteApplication: ElectronApplication | undefined
let mainPage: Page
let runtime: RuntimeInstance
let workspace = ''

async function hashFile(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

async function closeApplication(
  target: ElectronApplication | undefined,
  executable: string,
): Promise<void> {
  await shutdownElectronApplicationScope({
    application: target,
    executable,
    requestClose: async (targetApplication) => await targetApplication.close(),
  })
}

async function launchControlledArknote(autostart = true): Promise<ElectronApplication> {
  return await runE2eStage('启动受控 Arknote 服务', async () =>
    await electron.launch({
      executablePath: runtime.arknoteExecutable,
      cwd: runtime.application,
      timeout: 30_000,
      args: ['--disable-gpu', ...(autostart ? ['--arkdown-autostart'] : [])],
      env: {
        ...process.env,
        APPDATA: runtime.root,
        LOCALAPPDATA: runtime.root,
        ARKDOWN_E2E: '1',
        ARKDOWN_E2E_RECOVER: '1',
      },
    }))
}

async function launchControlledArkdown(): Promise<void> {
  application = await runE2eStage('连接便签 Electron 主进程', async () =>
    await electron.launch({
      executablePath: runtime.executable,
      cwd: runtime.application,
      timeout: 30_000,
      args: [
        '--disable-gpu',
        '--user-data-dir=' + runtime.userData,
      ],
      env: {
        ...process.env,
        APPDATA: runtime.root,
        LOCALAPPDATA: runtime.root,
        ARKDOWN_E2E: '1',
        ARKDOWN_E2E_RECOVER: '1',
        ARKDOWN_E2E_WORKSPACE: workspace,
      },
    }))
  const child = application.process()
  const stderr: string[] = []
  child.stderr?.on('data', (chunk) => stderr.push(String(chunk)))
  const exitedBeforeWindow = new Promise<never>((_resolve, reject) => {
    child.once('exit', (code, signal) => {
      reject(new Error(
        'Arkdown exited before creating a window: code=' + String(code)
        + ', signal=' + String(signal) + ', stderr=' + stderr.join(''),
      ))
    })
  })
  mainPage = await runE2eStage('等待便签主窗口', async () =>
    await Promise.race([
      application!.firstWindow({ timeout: 15_000 }),
      exitedBeforeWindow,
    ]))
  await waitForMainWindowReady(mainPage)
}

async function waitForMainWindowReady(page: Page): Promise<void> {
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('Sticky E2E renderer console', message.text())
  })
  page.on('pageerror', (error) => {
    console.error('Sticky E2E renderer page error', error.stack ?? error.message)
  })
  const toolbar = page.locator('.sticky-note-box-toolbar-button')
  const assertion = expect(toolbar).toBeVisible({ timeout: 10_000 })
  let deadline: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      assertion,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error(
          'Sticky-note toolbar readiness did not settle within 15 seconds',
        )), 15_000)
      }),
    ])
  } catch (error) {
    console.error('Sticky E2E window diagnostic', {
      closed: page.isClosed(),
      url: page.url(),
      windows: application?.windows().map((candidate) => candidate.url()) ?? [],
    })
    throw error
  } finally {
    if (deadline) clearTimeout(deadline)
  }
}

async function waitForStickyWindow(noteId?: string): Promise<Page> {
  const target = arknoteApplication
  if (!target) throw new Error('Controlled Arknote application is unavailable')
  const isStickyWindow = (page: Page) => {
    try {
      const url = new URL(page.url())
      return url.searchParams.get('surface') === 'sticky-note'
        && (noteId === undefined || url.searchParams.get('noteId') === noteId)
    }
    catch { return false }
  }
  await expect.poll(() => target.windows().some(isStickyWindow), { timeout: 15_000 }).toBe(true)
  const candidate = target.windows().find(isStickyWindow)
  if (!candidate) throw new Error('Sticky note window was not found')
  await expect(candidate.locator('[data-surface="sticky-note"]')).toBeVisible({ timeout: 15_000 })
  return candidate
}

async function mainWindowMediaSourceId(): Promise<string> {
  const target = application
  if (!target) throw new Error('Controlled Arkdown application is unavailable')
  return await target.evaluate(({ BrowserWindow }, targetUrl) => {
    const window = BrowserWindow.getAllWindows()
      .find((candidate) => candidate.webContents.getURL() === targetUrl)
    if (!window) throw new Error('Arkdown source window was not found')
    return window.getMediaSourceId()
  }, mainPage.url())
}

async function waitForContextMenuPage(): Promise<Page> {
  const target = arknoteApplication
  if (!target) throw new Error('Controlled Arknote application is unavailable')
  const isContextMenuPage = (page: Page) => {
    try { return new URL(page.url()).searchParams.get('surface') === 'sticky-note-context-menu' }
    catch { return false }
  }
  await expect.poll(() => target.windows().some(isContextMenuPage), { timeout: 15_000 }).toBe(true)
  const candidate = target.windows().find(isContextMenuPage)
  if (!candidate) throw new Error('Sticky note context-menu page was not found')
  await expect(candidate.locator('.external-context-menu .context-menu-list'))
    .toBeVisible({ timeout: 15_000 })
  return candidate
}

async function installPromotionProbe(): Promise<void> {
  const target = arknoteApplication
  if (!target) throw new Error('Controlled Arknote application is unavailable')
  await target.evaluate(({ BrowserWindow }) => {
    type PromotionTarget = { webContents: { getURL(): string } }
    type PromotionMethod = (this: PromotionTarget, ...args: unknown[]) => unknown
    type PromotionName = 'show' | 'moveTop' | 'moveAbove' | 'focus' | 'setAlwaysOnTop'
    type PromotionState = typeof globalThis & {
      __arkdownPromotionOriginals?: Record<PromotionName, PromotionMethod>
      __arkdownPromotionCalls?: string[]
    }
    const state = globalThis as PromotionState
    if (state.__arkdownPromotionOriginals) throw new Error('Promotion probe is already installed')
    const prototype = BrowserWindow.prototype as unknown as Record<PromotionName, PromotionMethod>
    const originals: Record<PromotionName, PromotionMethod> = {
      show: prototype.show,
      moveTop: prototype.moveTop,
      moveAbove: prototype.moveAbove,
      focus: prototype.focus,
      setAlwaysOnTop: prototype.setAlwaysOnTop,
    }
    const calls: string[] = []
    state.__arkdownPromotionOriginals = originals
    state.__arkdownPromotionCalls = calls
    const isStickyWindow = (window: PromotionTarget) => {
      try {
        return new URL(window.webContents.getURL()).searchParams.get('surface') === 'sticky-note'
      } catch {
        return false
      }
    }
    ;(['show', 'moveTop', 'moveAbove', 'focus', 'setAlwaysOnTop'] as const).forEach((name) => {
      prototype[name] = function (this: PromotionTarget, ...args: unknown[]) {
        if (isStickyWindow(this)) {
          calls.push(name === 'setAlwaysOnTop'
            ? 'setAlwaysOnTop(' + String(args[0]) + ')'
            : name === 'moveAbove'
              ? 'moveAbove(' + String(args[0]) + ')'
              : name)
        }
        return originals[name].apply(this, args)
      }
    })
  })
}

async function readPromotionCalls(): Promise<string[]> {
  const target = arknoteApplication
  if (!target) throw new Error('Controlled Arknote application is unavailable')
  return await target.evaluate(() => {
    const state = globalThis as typeof globalThis & { __arkdownPromotionCalls?: string[] }
    return [...(state.__arkdownPromotionCalls ?? [])]
  })
}

async function restorePromotionProbe(): Promise<void> {
  const target = arknoteApplication
  if (!target) throw new Error('Controlled Arknote application is unavailable')
  await target.evaluate(({ BrowserWindow }) => {
    type PromotionTarget = { webContents: { getURL(): string } }
    type PromotionMethod = (this: PromotionTarget, ...args: unknown[]) => unknown
    type PromotionName = 'show' | 'moveTop' | 'moveAbove' | 'focus' | 'setAlwaysOnTop'
    type PromotionState = typeof globalThis & {
      __arkdownPromotionOriginals?: Record<PromotionName, PromotionMethod>
      __arkdownPromotionCalls?: string[]
    }
    const state = globalThis as PromotionState
    const originals = state.__arkdownPromotionOriginals
    if (!originals) throw new Error('Promotion probe is not installed')
    const prototype = BrowserWindow.prototype as unknown as Record<PromotionName, PromotionMethod>
    prototype.show = originals.show
    prototype.moveTop = originals.moveTop
    prototype.moveAbove = originals.moveAbove
    prototype.focus = originals.focus
    prototype.setAlwaysOnTop = originals.setAlwaysOnTop
    delete state.__arkdownPromotionOriginals
    delete state.__arkdownPromotionCalls
  })
}

async function openStickyNoteBox(enableAutostart = true): Promise<void> {
  const panel = mainPage.locator('.sticky-note-box-panel')
  if (!await panel.isVisible().catch(() => false)) {
    await mainPage.locator('.sticky-note-box-toolbar-button').click()
  }
  await expect(panel).toBeVisible()
  const startupHint = mainPage.locator('.sticky-note-startup-hint')
  await expect(startupHint).toBeVisible({ timeout: 5_000 })
  await startupHint.getByRole('button', {
    name: enableAutostart ? '开机启动' : '不再提示',
  }).click()
  await expect(startupHint).toHaveCount(0, { timeout: 5_000 })
  await expect(mainPage.locator('.sticky-note-grid')).toBeVisible()
}

async function activeNotes() {
  return await mainPage.evaluate(async () => {
    const result = await window.arkdown.listStickyNotes('active')
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  })
}

async function archivedNotes() {
  return await mainPage.evaluate(async () => {
    const result = await window.arkdown.listStickyNotes('archived')
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  })
}

async function createArchivedFixtureNotes(names: readonly string[]): Promise<string[]> {
  return await mainPage.evaluate(async (fixtureNames) => {
    const ids: string[] = []
    for (const name of fixtureNames) {
      const created = await window.arkdown.createStickyNote({
        name,
        markdown: '# ' + name + '\n\nfixture-' + name,
      })
      if (!created.ok) throw new Error(created.error.message)
      const archived = await window.arkdown.archiveStickyNote(created.value.record.id)
      if (!archived.ok) throw new Error(archived.error.message)
      ids.push(created.value.record.id)
    }
    return ids
  }, [...names])
}

async function marqueeArchiveCards(cards: readonly Locator[]): Promise<void> {
  if (cards.length === 0) throw new Error('Archive marquee requires at least one card')
  const grid = mainPage.locator('.sticky-note-grid[data-interaction-mode="archive"]')
  const geometry = await Promise.all([
    grid.boundingBox(),
    ...cards.map(async (card) => await card.boundingBox()),
  ])
  const gridBox = geometry[0]
  const cardBoxes = geometry.slice(1)
  if (!gridBox || cardBoxes.some((box) => box === null)) {
    throw new Error('Archive marquee geometry is unavailable')
  }
  const boxes = cardBoxes as NonNullable<(typeof cardBoxes)[number]>[]
  const top = Math.min(...boxes.map((box) => box.y))
  const left = Math.min(...boxes.map((box) => box.x))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  const start = { x: right - 1, y: bottom + 6 }
  const end = { x: left + 1, y: top + 1 }

  expect(start.y).toBeLessThan(gridBox.y + gridBox.height)
  expect(await grid.evaluate((element, point) => (
    document.elementFromPoint(point.x, point.y) === element
  ), start)).toBe(true)
  await mainPage.mouse.move(start.x, start.y)
  await mainPage.mouse.down()
  await expect(grid.getByTestId('sticky-note-selection-marquee')).toHaveCount(1)
  await mainPage.mouse.move(end.x, end.y, { steps: 8 })
  await mainPage.mouse.up()

  await expect.poll(async () => await Promise.all(
    cards.map(async (card) => await card.getAttribute('aria-selected')),
  )).toEqual(cards.map(() => 'true'))
  await expect(grid.locator('.sticky-note-card[aria-selected="true"]')).toHaveCount(cards.length)
}

async function selectVisualTextRange(
  page: Page,
  startText: string,
  endText = startText,
): Promise<void> {
  await page.locator('.ProseMirror').evaluate((editor, input) => {
    const findText = (text: string): Text => {
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node.textContent ?? '').trim() === text) return node as Text
      }
      throw new Error('Visual editor text was not found: ' + text)
    }
    const start = findText(input.startText)
    const end = findText(input.endText)
    ;(editor as HTMLElement).focus()
    const range = document.createRange()
    range.setStart(start, 0)
    range.setEnd(end, end.data.length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  }, { startText, endText })
}

async function visualListDepths(page: Page, texts: readonly string[]): Promise<number[]> {
  return await page.locator('.ProseMirror').evaluate((editor, targets) => {
    const depthFor = (text: string): number => {
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      let textNode: Text | null = null
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node.textContent ?? '').trim() === text) {
          textNode = node as Text
          break
        }
      }
      if (!textNode) throw new Error('Visual list item was not found: ' + text)
      let depth = 0
      for (
        let element: Element | null = textNode.parentElement;
        element && element !== editor;
        element = element.parentElement
      ) {
        if (element.matches('.milkdown-list-item-block')) depth += 1
      }
      return depth
    }
    return targets.map(depthFor)
  }, [...texts])
}

async function dropFileOnNoteGrid(filePath: string): Promise<void> {
  const inputId = 'sticky-note-e2e-drop'
  await mainPage.evaluate((id) => {
    const input = document.createElement('input')
    input.id = id
    input.type = 'file'
    input.hidden = true
    document.body.append(input)
  }, inputId)
  const input = mainPage.locator('#' + inputId)
  await input.setInputFiles(filePath)
  await mainPage.evaluate((id) => {
    const picker = document.querySelector<HTMLInputElement>('#' + id)!
    const file = picker.files?.[0]
    if (!file) throw new Error('Dropped file is unavailable')
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const grid = document.querySelector<HTMLElement>('.sticky-note-grid')!
    grid.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }))
    grid.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }))
    picker.remove()
  }, inputId)
}

async function rootContextMenuCommands(): Promise<ReturnType<Page['locator']>> {
  const menu = mainPage.locator('.context-menu-list:not(.context-menu-submenu)')
  await expect(menu).toBeVisible()
  return menu.locator(':scope > .context-menu-entry > button')
}

test.beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'arkdown-sticky-e2e-workspace-'))
  await writeFile(path.join(workspace, 'selection.md'), SELECTION_MARKDOWN, 'utf8')
  await writeFile(
    path.join(workspace, 'interaction-polish.md'),
    await readFile(INTERACTION_POLISH_FIXTURE, 'utf8'),
    'utf8',
  )
  const sharedApplication = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!sharedApplication) throw new Error('Electron E2E shared runtime is not prepared')
  runtime = await createRuntimeInstance(sharedApplication, 'arkdown-sticky-e2e-runtime-')
  arknoteApplication = await launchControlledArknote()
  await launchControlledArkdown()
})

test.afterEach(async () => {
  const target = application
  const arknoteTarget = arknoteApplication
  application = undefined
  arknoteApplication = undefined
  const shutdownErrors: unknown[] = []
  if (runtime?.executable) {
    await closeApplication(target, runtime.executable)
      .catch((error: unknown) => shutdownErrors.push(error))
  }
  if (runtime?.arknoteExecutable) {
    await closeApplication(arknoteTarget, runtime.arknoteExecutable)
      .catch((error: unknown) => shutdownErrors.push(error))
  }
  if (shutdownErrors.length > 0) {
    throw new AggregateError(shutdownErrors, 'Electron shutdown did not stabilize')
  }
  if (workspace) await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  if (runtime?.root) await cleanupRuntime(runtime.root)
})

async function expectRenderedClipboardImages(images: Locator, count: number) {
  await expect(images).toHaveCount(count)
  await expect.poll(() => images.evaluateAll((elements) => elements.map((element) => {
    const image = element as HTMLImageElement
    return image.complete && image.naturalWidth > 0
  }))).toEqual(Array<boolean>(count).fill(true))
}

test('[interaction polish] archives support native multi-selection and permanent deletion', async () => {
  const fixtureIds: string[] = []
  try {
    await openStickyNoteBox(true)
    fixtureIds.push(...await createArchivedFixtureNotes(['Archive A', 'Archive B', 'Archive C']))
    await mainPage.getByRole('tab', { name: '\u5f52\u6863', exact: true }).click()

    const cards = ['Archive A', 'Archive B', 'Archive C'].map((name) =>
      mainPage.getByRole('button', { name, exact: true }))
    await expect(cards[0]).toBeVisible()
    await expect(cards[1]).toBeVisible()
    await expect(cards[2]).toBeVisible()
    await cards[0].click()
    await cards[2].click({ modifiers: ['Shift'] })
    await expect(cards[0]).toHaveAttribute('aria-selected', 'true')
    await expect(cards[1]).toHaveAttribute('aria-selected', 'true')
    await expect(cards[2]).toHaveAttribute('aria-selected', 'true')

    await cards[1].click({ modifiers: ['Control'] })
    await expect(cards[0]).toHaveAttribute('aria-selected', 'true')
    await expect(cards[1]).toHaveAttribute('aria-selected', 'false')
    await expect(cards[2]).toHaveAttribute('aria-selected', 'true')

    await cards[1].dblclick()
    await expect(mainPage.getByLabel('\u5f52\u6863\u4fbf\u7b7e\u9884\u89c8')).toBeVisible()
    await mainPage.getByRole('button', { name: '\u8fd4\u56de\u5f52\u6863\u5217\u8868' }).click()

    await marqueeArchiveCards(cards)
    await cards[0].dragTo(mainPage.getByRole('button', { name: '\u6c38\u4e45\u5220\u9664\u5f52\u6863\u4fbf\u7b7e' }))
    const confirmation = mainPage.getByRole('dialog', { name: '永久删除便签', exact: true })
    await expect(confirmation).toBeVisible()
    await expect(confirmation.getByText('确定永久删除选中的 3 个便签吗？', { exact: true })).toBeVisible()
    await confirmation.getByRole('button', { name: '永久删除', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    await expect.poll(async () => (await archivedNotes())
      .filter(({ record }) => record.name.startsWith('Archive ')).length).toBe(0)
  } finally {
    if (fixtureIds.length > 0) {
      await mainPage.evaluate(async (noteIds) => {
        await window.arkdown.deleteArchivedStickyNotes?.(noteIds)
      }, fixtureIds).catch(() => undefined)
    }
  }
})

test('[interaction polish] sticky desktop menu and editor behavior remain exact', async () => {
  let noteId = ''
  let promotionInstalled = false
  let clipboardCaptured = false
  let previousClipboard = ''
  try {
    await openStickyNoteBox(true)
    noteId = await mainPage.evaluate(async () => {
      const created = await window.arkdown.createStickyNote({
        name: 'Interaction Polish Desktop',
        markdown: [
          '# Interaction Polish Desktop',
          '',
          'beforeafter',
          '',
          '- geometry item',
          '',
          '<hr data-arkdown-style="purple" data-arkdown-height="3" data-arkdown-opacity="30" />',
          '',
        ].join('\n'),
      })
      if (!created.ok) throw new Error(created.error.message)
      return created.value.record.id
    })

    const card = mainPage.getByRole('button', { name: 'Interaction Polish Desktop', exact: true })
    await expect(card).toBeVisible()
    await card.click({ button: 'right' })
    const cardMenu = mainPage.locator('.context-menu-list:not(.context-menu-submenu)')
    await expect(cardMenu).toBeVisible()
    await expect.poll(async () => (await cardMenu.boundingBox())?.width).toBe(200)
    await expect(cardMenu).toHaveClass(/context-menu-root-no-icon-gutter/u)
    expect(await cardMenu.evaluate((element) => getComputedStyle(element).transform)).toBe('none')
    await mainPage.keyboard.press('Escape')
    await expect(cardMenu).toHaveCount(0)

    await installPromotionProbe()
    promotionInstalled = true
    const sourceMediaId = await mainWindowMediaSourceId()
    await card.click()
    const stickyPage = await waitForStickyWindow()
    await expect.poll(readPromotionCalls)
      .toEqual([
        'setAlwaysOnTop(true)', 'show', 'moveAbove(' + sourceMediaId + ')',
        'focus', 'moveTop', 'setAlwaysOnTop(false)',
      ])
    await expect.poll(async () => await arknoteApplication!.evaluate(
      ({ BrowserWindow }, id) => {
        const window = BrowserWindow.getAllWindows().find((candidate) => {
          try { return new URL(candidate.webContents.getURL()).searchParams.get('noteId') === id }
          catch { return false }
        })
        return window
          ? { focused: window.isFocused(), top: window.isAlwaysOnTop(), visible: window.isVisible() }
          : null
      },
      noteId,
    )).toEqual({ focused: true, top: false, visible: true })

    const pin = stickyPage.locator('.sticky-note-titlebar button[aria-pressed]')
    await pin.click()
    await expect(pin).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => {
      const note = await mainPage.evaluate(async (id) => {
        const result = await window.arkdown.readStickyNote(id)
        if (!result.ok) throw new Error(result.error.message)
        return result.value.record.pinned
      }, noteId)
      return note
    }).toBe(true)
    const pinnedCallStart = (await readPromotionCalls()).length
    await mainPage.evaluate(async (id) => {
      const opened = await window.arkdown.openStickyNote(id)
      if (!opened.ok) throw new Error(opened.error.message)
    }, noteId)
    await expect.poll(async () => (await readPromotionCalls()).slice(pinnedCallStart))
      .toEqual(['setAlwaysOnTop(true)', 'show', 'focus', 'moveTop'])
    await expect.poll(async () => await arknoteApplication!.evaluate(
      ({ BrowserWindow }, id) => {
        const window = BrowserWindow.getAllWindows().find((candidate) => {
          try { return new URL(candidate.webContents.getURL()).searchParams.get('noteId') === id }
          catch { return false }
        })
        return window
          ? { focused: window.isFocused(), top: window.isAlwaysOnTop() }
          : null
      },
      noteId,
    )).toEqual({ focused: true, top: true })

    await pin.click()
    await expect(pin).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => await mainPage.evaluate(async (id) => {
      const result = await window.arkdown.readStickyNote(id)
      if (!result.ok) throw new Error(result.error.message)
      return result.value.record.pinned
    }, noteId)).toBe(false)
    await expect.poll(async () => await arknoteApplication!.evaluate(
      ({ BrowserWindow }, id) => {
        const window = BrowserWindow.getAllWindows().find((candidate) => {
          try { return new URL(candidate.webContents.getURL()).searchParams.get('noteId') === id }
          catch { return false }
        })
        return window?.isAlwaysOnTop() ?? null
      },
      noteId,
    )).toBe(false)

    const unpinnedCallStart = (await readPromotionCalls()).length
    await mainPage.evaluate(async (id) => {
      const opened = await window.arkdown.openStickyNote(id)
      if (!opened.ok) throw new Error(opened.error.message)
    }, noteId)
    await expect.poll(async () => (await readPromotionCalls()).slice(unpinnedCallStart))
      .toEqual([
        'setAlwaysOnTop(true)', 'show', 'moveAbove(' + sourceMediaId + ')',
        'focus', 'moveTop', 'setAlwaysOnTop(false)',
      ])
    await expect.poll(async () => await arknoteApplication!.evaluate(
      ({ BrowserWindow }, id) => {
        const window = BrowserWindow.getAllWindows().find((candidate) => {
          try { return new URL(candidate.webContents.getURL()).searchParams.get('noteId') === id }
          catch { return false }
        })
        return window
          ? { focused: window.isFocused(), top: window.isAlwaysOnTop() }
          : null
      },
      noteId,
    )).toEqual({ focused: true, top: false })

    previousClipboard = await arknoteApplication!.evaluate(({ clipboard }) => clipboard.readText())
    clipboardCaptured = true
    await arknoteApplication!.evaluate(
      ({ clipboard }, text) => clipboard.writeText(text),
      'alpha\nbeta',
    )

    const paragraph = stickyPage.locator('.sticky-note-editor .ProseMirror p')
      .filter({ hasText: /^beforeafter$/u })
    await expect(paragraph).toHaveCount(1)
    const caret = await paragraph.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let text: Text | null = null
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node.textContent ?? '').includes('beforeafter')) {
          text = node as Text
          break
        }
      }
      if (!text) throw new Error('Paste target text node was not found')
      const offset = text.data.indexOf('beforeafter') + 'before'.length
      const range = document.createRange()
      range.setStart(text, offset)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      ;(element.closest('.ProseMirror') as HTMLElement | null)?.focus()
      const probe = document.createRange()
      probe.setStart(text, offset - 1)
      probe.setEnd(text, offset)
      const bounds = probe.getBoundingClientRect()
      return { x: bounds.right, y: bounds.top + bounds.height / 2 }
    })
    await stickyPage.mouse.click(caret.x, caret.y, { button: 'right' })
    await expect.poll(async () => await paragraph.evaluate(() => {
      const selection = window.getSelection()
      return selection?.anchorOffset ?? -1
    })).toBe('before'.length)

    let menuPage = await waitForContextMenuPage()
    let editorMenu = menuPage.locator(
      '.external-context-menu .context-menu-list:not(.context-menu-submenu)',
    )
    await expect.poll(async () => (await editorMenu.boundingBox())?.width).toBe(200)
    await expect(stickyPage.locator('.sticky-note-window')).toHaveAttribute('data-focused', 'true')
    await expect.poll(async () => await stickyPage.evaluate(() => document.hasFocus())).toBe(true)
    await expect.poll(async () => await arknoteApplication!.evaluate(
      ({ BrowserWindow }, id) => {
        const window = BrowserWindow.getAllWindows().find((candidate) => {
          try { return new URL(candidate.webContents.getURL()).searchParams.get('noteId') === id }
          catch { return false }
        })
        return window?.isFocused() ?? false
      },
      noteId,
    )).toBe(true)
    expect(await editorMenu.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        animationName: style.animationName,
        transitionDuration: style.transitionDuration,
        transform: style.transform,
      }
    })).toEqual({
      animationName: 'none',
      transitionDuration: '0s',
      transform: 'none',
    })
    await expect(editorMenu).not.toHaveClass(/context-menu-root-no-icon-gutter/u)
    const reservedColumns = await editorMenu.locator(
      ':scope > .context-menu-entry > .context-menu-command',
    ).first().evaluate((element) => getComputedStyle(element).gridTemplateColumns)
    expect(reservedColumns).toMatch(/^24px /u)
    await menuPage.getByRole('menuitem', { name: '\u7c98\u8d34', exact: true }).click()

    const markdownPath = path.join(
      runtime.portableData,
      'arknote',
      'notes',
      'active',
      noteId,
      'Interaction Polish Desktop.md',
    )
    await expect.poll(async () => await readFile(markdownPath, 'utf8'), { timeout: 10_000 })
      .toContain('beforealpha\nbetaafter')
    const pastedMarkdown = await readFile(markdownPath, 'utf8')
    expect(pastedMarkdown.match(/alpha/gu)).toHaveLength(1)
    expect(pastedMarkdown.match(/beta/gu)).toHaveLength(1)
    expect(pastedMarkdown).not.toContain('beforealpha\n\nbetaafter')
    expect(pastedMarkdown).not.toContain('beforealpha\nbeta\nafter')

    const openBlankEditorMenu = async (): Promise<Page> => {
      await expect(menuPage.locator('.external-context-menu .context-menu-list')).toHaveCount(0)
      await stickyPage.locator('.sticky-note-editor .ProseMirror p')
        .filter({ hasText: /beforealpha/u })
        .first()
        .click({ button: 'right' })
      return await waitForContextMenuPage()
    }

    menuPage = await openBlankEditorMenu()
    await stickyPage.keyboard.press('Escape')
    await expect(menuPage.locator('.external-context-menu .context-menu-list')).toHaveCount(0)
    await expect(stickyPage.locator('.sticky-note-window')).toHaveAttribute('data-focused', 'true')

    menuPage = await openBlankEditorMenu()
    await menuPage.getByRole('menuitem', { name: '\u884c\u95f4\u8ddd', exact: true }).click()
    const lineSpacingSubmenu = menuPage.locator('.context-menu-submenu')
    await expect(lineSpacingSubmenu).toBeVisible()
    expect(await lineSpacingSubmenu.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        animationName: style.animationName,
        transitionDuration: style.transitionDuration,
        transform: style.transform,
      }
    })).toEqual({
      animationName: 'none',
      transitionDuration: '0s',
      transform: 'none',
    })
    await menuPage.getByRole('menuitemcheckbox', {
      name: '\u4f7f\u7528\u6807\u51c6\u884c\u95f4\u8ddd',
      exact: true,
    }).click()
    await expect(stickyPage.locator('.sticky-note-window'))
      .toHaveAttribute('data-line-spacing-mode', 'standard')
    await expect.poll(async () => await mainPage.evaluate(async (id) => {
      const result = await window.arkdown.readStickyNote(id)
      if (!result.ok) throw new Error(result.error.message)
      return result.value.record.lineSpacingMode
    }, noteId)).toBe('standard')

    menuPage = await openBlankEditorMenu()
    await menuPage.getByRole('menuitem', { name: '\u884c\u95f4\u8ddd', exact: true }).click()
    await menuPage.getByRole('menuitemcheckbox', {
      name: '\u4f7f\u7528\u538b\u7f29\u884c\u95f4\u8ddd',
      exact: true,
    }).click()
    await expect(stickyPage.locator('.sticky-note-window'))
      .toHaveAttribute('data-line-spacing-mode', 'compact')
    await expect.poll(async () => await mainPage.evaluate(async (id) => {
      const result = await window.arkdown.readStickyNote(id)
      if (!result.ok) throw new Error(result.error.message)
      return result.value.record.lineSpacingMode
    }, noteId)).toBe('compact')

    const geometry = await stickyPage.locator('.sticky-note-editor .list-item').first()
      .evaluate((item) => {
        const label = item.querySelector<HTMLElement>(':scope > .label-wrapper')
        if (!label) throw new Error('Sticky list label was not found')
        return {
          gap: getComputedStyle(item).gap,
          labelWidth: getComputedStyle(label).width,
        }
      })
    expect(geometry).toEqual({ gap: '2px', labelWidth: '14px' })
    await expect(stickyPage.locator('hr[data-arkdown-opacity="30"]')).toHaveCount(1)

    menuPage = await openBlankEditorMenu()
    await menuPage.getByRole('menuitem', {
      name: '\u6c34\u5e73\u5206\u5272\u7ebf',
      exact: true,
    }).click()
    await menuPage.getByRole('menuitem', { name: '\u9ed1\u8272', exact: true }).click()
    await expect(stickyPage.locator('hr[data-arkdown-opacity="50"]')).toHaveCount(1)
    await expect(stickyPage.locator('hr[data-arkdown-opacity="30"]')).toHaveCount(1)
    await expect.poll(async () => {
      const markdown = await readFile(markdownPath, 'utf8')
      return {
        existing: markdown.match(/data-arkdown-opacity="30"/gu)?.length ?? 0,
        inserted: markdown.match(/data-arkdown-opacity="50"/gu)?.length ?? 0,
      }
    }, { timeout: 10_000 }).toEqual({ existing: 1, inserted: 1 })
  } finally {
    try {
      if (clipboardCaptured && arknoteApplication) {
        await arknoteApplication.evaluate(
          ({ clipboard }, text) => clipboard.writeText(text),
          previousClipboard,
        )
      }
      if (noteId) {
        await mainPage.evaluate(async (id) => {
          await window.arkdown.closeStickyNote(id)
          await window.arkdown.deleteStickyNote(id)
        }, noteId).catch(() => undefined)
      }
    } finally {
      if (promotionInstalled) await restorePromotionProbe()
    }
  }
})

test('[interaction polish] shared visual keyboard and styles stay scoped', async () => {
  await mainPage.getByRole('button', { name: 'interaction-polish.md', exact: true }).click()
  const editor = mainPage.locator('.ProseMirror')
  await expect(editor).toContainText('Interaction Polish Fixture')
  const modeButton = mainPage.getByRole('button', {
    name: '\u6e90\u7801\u6a21\u5f0f/\u6e32\u67d3\u6a21\u5f0f',
  })
  await expect(modeButton).toHaveAttribute('aria-pressed', 'false')
  const visualModeStyle = await modeButton.evaluate((button) => {
    const shell = document.querySelector<HTMLElement>('.app-shell')
    if (!shell) throw new Error('Arkdown application shell was not found')
    const channels = getComputedStyle(shell).getPropertyValue('--theme-color-rgb').trim()
    const theme = 'rgb(' + channels.split(/\s+/u).join(', ') + ')'
    const style = getComputedStyle(button)
    return {
      background: style.backgroundColor,
      color: style.color,
      theme,
    }
  })
  expect(visualModeStyle).toEqual({
    background: 'rgba(0, 0, 0, 0)',
    color: 'rgb(101, 105, 113)',
    theme: visualModeStyle.theme,
  })

  const paragraph = editor.locator('p').filter({ hasText: /Paragraph tab target/u }).first()
  await paragraph.click({ button: 'right' })
  const arkdownEditorMenu = mainPage.locator(
    '.context-menu-list:not(.context-menu-submenu)',
  )
  await expect(arkdownEditorMenu).toBeVisible()
  await expect.poll(async () => (await arkdownEditorMenu.boundingBox())?.width).toBe(272)
  await expect(arkdownEditorMenu).not.toHaveClass(/context-menu-root-no-icon-gutter/u)
  const arkdownEditorColumns = await arkdownEditorMenu.locator(
    ':scope > .context-menu-entry > .context-menu-command',
  ).first().evaluate((element) => getComputedStyle(element).gridTemplateColumns)
  expect(arkdownEditorColumns).toMatch(/^24px /u)
  await mainPage.keyboard.press('Escape')
  await expect(arkdownEditorMenu).toHaveCount(0)

  await selectVisualTextRange(mainPage, 'Paragraph tab target')
  await mainPage.keyboard.press('Tab')
  await expect(paragraph).toHaveText('\u3000\u3000Paragraph tab target')
  await mainPage.keyboard.press('Shift+Tab')
  await expect(paragraph).toHaveText('Paragraph tab target')

  const heading = editor.getByText('Heading tab target', { exact: true })
  await selectVisualTextRange(mainPage, 'Heading tab target')
  await mainPage.keyboard.press('Tab')
  await expect.poll(async () => await heading.evaluate((element) => element.tagName)).toBe('H5')
  await mainPage.keyboard.press('Shift+Tab')
  await expect.poll(async () => await heading.evaluate((element) => element.tagName)).toBe('H4')

  const listSelections = [
    ['Ordered second', 'Ordered third'],
    ['Unordered second', 'Unordered third'],
    ['Task second', 'Task third'],
  ] as const
  for (const [startText, endText] of listSelections) {
    await expect.poll(async () => await visualListDepths(mainPage, [startText, endText]))
      .toEqual([1, 1])
    await selectVisualTextRange(mainPage, startText, endText)
    await mainPage.keyboard.press('Tab')
    await expect.poll(async () => await visualListDepths(mainPage, [startText, endText]))
      .toEqual([2, 2])
    await mainPage.keyboard.press('Shift+Tab')
    await expect.poll(async () => await visualListDepths(mainPage, [startText, endText]))
      .toEqual([1, 1])
  }

  const code = editor.locator('.milkdown-code-block').filter({ hasText: 'code tab target' }).first()
  const codeContent = code.locator(
    '.cm-content, .milkdown-code-block-placeholder code',
  ).first()
  await expect(codeContent).toHaveText('code tab target')
  const codeBefore = await codeContent.textContent()
  await selectVisualTextRange(mainPage, 'code tab target')
  await mainPage.keyboard.press('Tab')
  await expect(codeContent).toHaveText(codeBefore ?? 'code tab target')

  await selectVisualTextRange(mainPage, 'Column A')
  await mainPage.keyboard.press('Tab')
  await expect.poll(async () => await mainPage.evaluate(() => {
    const anchor = window.getSelection()?.anchorNode
    const element = anchor instanceof Element ? anchor : anchor?.parentElement
    return element?.closest('th, td')?.textContent?.trim() ?? null
  })).toBe('Column B')

  const arkdownGeometry = await editor.locator('.list-item').first().evaluate((item) => {
    const label = item.querySelector<HTMLElement>(':scope > .label-wrapper')
    if (!label) throw new Error('Arkdown list label was not found')
    return {
      gap: getComputedStyle(item).gap,
      labelWidth: getComputedStyle(label).width,
    }
  })
  expect(arkdownGeometry).toEqual({ gap: '10px', labelWidth: '24px' })

  const quoteLine = await editor.locator('blockquote')
    .filter({ hasText: 'Quote theme target' })
    .evaluate((quote) => {
      const shell = document.querySelector<HTMLElement>('.app-shell')
      if (!shell) throw new Error('Arkdown application shell was not found')
      const channels = getComputedStyle(shell).getPropertyValue('--theme-color-rgb').trim()
      const theme = 'rgb(' + channels.split(/\s+/u).join(', ') + ')'
      return {
        afterContent: getComputedStyle(quote, '::after').content,
        beforeBackground: getComputedStyle(quote, '::before').backgroundColor,
        borderLeftWidth: getComputedStyle(quote).borderLeftWidth,
        theme,
      }
    })
  expect(quoteLine).toEqual({
    afterContent: 'none',
    beforeBackground: quoteLine.theme,
    borderLeftWidth: '0px',
    theme: quoteLine.theme,
  })

  await modeButton.click()
  await expect(modeButton).toHaveAttribute('aria-pressed', 'true')
  await mainPage.mouse.move(1, 1)
  const sourceModeStyle = await modeButton.evaluate((button) => {
    const style = getComputedStyle(button)
    return { background: style.backgroundColor, color: style.color }
  })
  expect(sourceModeStyle).toEqual({
    background: 'rgba(0, 0, 0, 0)',
    color: visualModeStyle.theme,
  })
  const codeMirror = mainPage.locator('.source-editor .cm-content')
  await expect(codeMirror).toBeVisible()
  const sourceLine = codeMirror.locator('.cm-line')
    .filter({ hasText: 'Unordered third' })
    .first()
  await expect(sourceLine).toHaveText('* Unordered third')
  await sourceLine.click()
  await expect.poll(async () => await codeMirror.evaluate(
    (element) => document.activeElement === element,
  )).toBe(true)
  await mainPage.keyboard.press('Tab')
  await expect(sourceLine).toHaveText('  * Unordered third')
  await expect.poll(async () => await codeMirror.evaluate(
    (element) => document.activeElement === element,
  )).toBe(true)
})

test('runs the sticky-note lifecycle, archive search, import, and selection workflows', async () => {
  await openStickyNoteBox(true)
  const initial = await activeNotes()
  expect(initial).toHaveLength(1)
  const help = await mainPage.evaluate(async (noteId) => {
    const result = await window.arkdown.readStickyNote(noteId)
    if (!result.ok) throw new Error(result.error.message)
    return result.value.markdown
  }, initial[0].record.id)
  expect(help).toContain('Arkdown')

  await mainPage.locator('.sticky-note-create-card').click()
  const nameDialog = mainPage.locator('.sticky-note-name-dialog')
  await nameDialog.locator('input').fill('E2E Note')
  const createdWindowPromise = waitForStickyWindow()
  await nameDialog.locator('button').last().click()
  let stickyPage = await createdWindowPromise
  const noteId = new URL(stickyPage.url()).searchParams.get('noteId')
  if (!noteId) throw new Error('Sticky note id is missing from the window URL')

  const editor = stickyPage.locator('.sticky-note-editor .ProseMirror')
  await editor.click()
  await stickyPage.keyboard.press('Control+a')
  await stickyPage.keyboard.insertText('# E2E Note\n\nlive-save-token')
  const markdownPath = path.join(runtime.portableData, 'arknote', 'notes', 'active', noteId, 'E2E Note.md')
  await expect.poll(async () => await readFile(markdownPath, 'utf8'), { timeout: 10_000 })
    .toContain('live-save-token')
  await expect(stickyPage.locator('.sticky-note-save-status')).toHaveCount(0)

  await expect(stickyPage.locator('.arkdown-visual-input-caret')).toHaveCount(0)
  expect(await editor.evaluate((element) => getComputedStyle(element).caretColor)).not.toBe('rgba(0, 0, 0, 0)')
  const restoreClipboard = await installNativeClipboardImage(arknoteApplication!)
  let clipboardResource = ''
  let clipboardHash = ''
  try {
    await editor.click()
    await stickyPage.keyboard.press('Control+End')
    await stickyPage.keyboard.press('Control+v')
    await expectRenderedClipboardImages(editor.locator('.arkdown-local-image > img'), 1)
    await expect(editor).not.toContainText(CLIPBOARD_IMAGE_SENTINEL)
    await stickyPage.keyboard.press('Control+z')
    await expect(editor.locator('.arkdown-local-image > img')).toHaveCount(0)
    await expect(editor).toContainText('live-save-token')
    await stickyPage.keyboard.press('Control+Shift+z')
    await expectRenderedClipboardImages(editor.locator('.arkdown-local-image > img'), 1)
    await expect.poll(async () => await readFile(markdownPath, 'utf8')).toMatch(/resources\/[^\s)>"']+\.png/u)
    clipboardResource = /resources\/([^\s)>"']+\.png)/u.exec(await readFile(markdownPath, 'utf8'))![1]!
    const imagePath = path.join(path.dirname(markdownPath), 'resources', clipboardResource)
    await expectNativePng(arknoteApplication!, imagePath)
    clipboardHash = await hashFile(imagePath)

    // Use the native external context-menu window, not a synthetic paste event.
    const paragraph = editor.locator('p').filter({ hasText: 'live-save-token' }).first()
    // The paragraph center can hit the inline image and select it for replacement.
    const glyph = await paragraph.evaluate((element) => {
      const token = 'live-save-token'
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text
        const tokenStart = text.data.indexOf(token)
        if (tokenStart < 0) continue
        const offset = tokenStart + token.length - 1
        const range = document.createRange()
        range.setStart(text, offset)
        range.setEnd(text, offset + 1)
        const rect = range.getClientRects()[0]
        if (!rect || rect.width <= 0 || rect.height <= 0) continue
        const x = rect.left + rect.width * 0.8
        const y = rect.top + rect.height / 2
        const hit = document.elementFromPoint(x, y)
        if (!Number.isFinite(x) || !Number.isFinite(y) || !hit || !element.contains(hit)
          || hit.closest('.arkdown-local-image, .arkdown-image-alignment-toolbar')) continue
        return { x, y, offset }
      }
      throw new Error('Visible paste target glyph was not found')
    })
    await stickyPage.mouse.click(glyph.x, glyph.y)
    await expect.poll(async () => await paragraph.evaluate((element, offset) => {
      const selection = window.getSelection()
      const anchor = selection?.anchorNode
      return selection?.rangeCount === 1 && selection.isCollapsed
        && anchor?.nodeType === Node.TEXT_NODE && element.contains(anchor)
        && (anchor.textContent ?? '').includes('live-save-token')
        && selection.anchorOffset === offset + 1
    }, glyph.offset)).toBe(true)
    await stickyPage.mouse.click(glyph.x, glyph.y, { button: 'right' })
    const menuPage = await waitForContextMenuPage()
    await menuPage.getByRole('menuitem', { name: '粘贴', exact: true }).click()
    await expectRenderedClipboardImages(editor.locator('.arkdown-local-image > img'), 2)
    await expect(editor).not.toContainText(CLIPBOARD_IMAGE_SENTINEL)
    await stickyPage.keyboard.press('Control+z')
    await expectRenderedClipboardImages(editor.locator('.arkdown-local-image > img'), 1)
    await stickyPage.keyboard.press('Control+Shift+z')
    await expectRenderedClipboardImages(editor.locator('.arkdown-local-image > img'), 2)
  } finally { await restoreClipboard() }

  await stickyPage.locator('.sticky-note-titlebar button').last().click()
  await expect.poll(() => stickyPage.isClosed()).toBe(true)
  await expect.poll(async () => {
    const closed = (await activeNotes()).find(({ record }) => record.id === noteId)?.record
    return closed ? { released: closed.released, pinned: closed.pinned } : null
  }).toEqual({ released: false, pinned: false })
  const reopenedWindowPromise = waitForStickyWindow()
  await mainPage.getByRole('button', { name: 'E2E Note', exact: true }).click()
  stickyPage = await reopenedWindowPromise
  await expect(stickyPage.locator('.sticky-note-editor .ProseMirror')).toContainText('live-save-token')
  await expectRenderedClipboardImages(stickyPage.locator('.sticky-note-editor .ProseMirror .arkdown-local-image > img'), 2)
  await stickyPage.locator('.sticky-note-titlebar button').first().click()
  await expect(stickyPage.locator('.sticky-note-titlebar button').first()).toHaveAttribute('aria-pressed', 'true')

  const noteCard = mainPage.getByRole('button', { name: 'E2E Note', exact: true })
  await noteCard.click()
  await expect.poll(() => stickyPage.isClosed()).toBe(true)

  await noteCard.dragTo(mainPage.locator('.sticky-note-recycle-target'))
  await expect(mainPage.locator('.sticky-note-archive-toast')).toContainText('便签已归档')
  await expect.poll(async () => (await archivedNotes()).some(({ record }) => record.id === noteId)).toBe(true)
  const archivedClipboardNote = (await archivedNotes()).find(({ record }) => record.id === noteId)!
  const archivedClipboardPath = path.join(runtime.portableData, 'arknote', 'notes', archivedClipboardNote.record.resourcesRelativePath, clipboardResource)
  expect(await hashFile(archivedClipboardPath)).toBe(clipboardHash)
  await expectNativePng(arknoteApplication!, archivedClipboardPath)
  await expect.poll(async () => {
    const result = await mainPage.evaluate(async () => await window.arkdown.searchStickyNotes('archived', 'live-save-token'))
    return result.ok ? result.value.length : -1
  }).toBe(1)

  await mainPage.locator('.sticky-note-box-panel').press('Control+f')
  const activeSearch = mainPage.locator('.sticky-note-search')
  await activeSearch.getByRole('searchbox').fill('live-save-token')
  await expect(activeSearch.locator('.sticky-note-search-results button')).toHaveCount(0)
  await activeSearch.locator('.sticky-note-search-field button').click()

  const archiveTab = mainPage.getByRole('tab', { name: '归档', exact: true })
  await archiveTab.click()
  await expect(archiveTab).toHaveAttribute('aria-selected', 'true')
  await mainPage.locator('.sticky-note-box-panel').press('Control+f')
  const archiveSearch = mainPage.locator('.sticky-note-search')
  await expect(archiveSearch).toHaveAttribute('aria-label', '搜索归档便签')
  const archiveSearchbox = archiveSearch.getByRole('searchbox')
  await archiveSearchbox.fill('live-save-token')
  await expect(archiveSearchbox).toHaveValue('live-save-token')
  await expect(archiveSearch.locator('.sticky-note-search-results button')).toHaveCount(1)
  await archiveSearch.locator('.sticky-note-search-field button').click()
  const archivedCard = mainPage.getByRole('button', { name: 'E2E Note', exact: true })
  await archivedCard.click({ button: 'right' })
  await (await rootContextMenuCommands()).nth(0).click()
  await expect.poll(async () => (await activeNotes()).some(({ record }) => record.id === noteId)).toBe(true)

  const restoredClipboardNote = (await activeNotes()).find(({ record }) => record.id === noteId)!
  expect(await hashFile(path.join(runtime.portableData, 'arknote', 'notes', restoredClipboardNote.record.resourcesRelativePath, clipboardResource))).toBe(clipboardHash)

  await mainPage.getByRole('tab', { name: '便签', exact: true }).click()
  const markdownHashBefore = await hashFile(IMPORT_FIXTURE)
  const imageHashBefore = await hashFile(IMPORT_IMAGE)
  await dropFileOnNoteGrid(IMPORT_FIXTURE)
  await expect.poll(async () => (await activeNotes()).some(({ record }) => record.name === 'import-with-image'))
    .toBe(true)
  const imported = (await activeNotes()).find(({ record }) => record.name === 'import-with-image')!
  const importedResource = path.join(
    runtime.portableData,
    'arknote',
    'notes',
    ...imported.record.resourcesRelativePath.split('/'),
  )
  await expect(stat(path.join(importedResource, 'fixture.svg'))).resolves.toBeTruthy()
  expect(await hashFile(IMPORT_FIXTURE)).toBe(markdownHashBefore)
  expect(await hashFile(IMPORT_IMAGE)).toBe(imageHashBefore)

  await mainPage.locator('.sticky-note-box-toolbar-button').click()
  await mainPage.getByRole('button', { name: 'selection.md', exact: true }).click()
  const visualEditor = mainPage.locator('.ProseMirror')
  await expect(visualEditor).toContainText('Selection fixture')
  await visualEditor.click()
  await mainPage.keyboard.press('Control+a')
  await visualEditor.locator('h1').evaluate((heading) => {
    const bounds = heading.getBoundingClientRect()
    heading.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      button: 2,
      cancelable: true,
      clientX: bounds.left + Math.min(30, bounds.width / 2),
      clientY: bounds.top + bounds.height / 2,
    }))
  })
  await rootContextMenuCommands()
  const selectionWindowPromise = waitForStickyWindow()
  await mainPage.getByRole('menuitem', { name: '建立便签' }).click()
  const selectionWindow = await selectionWindowPromise
  const selectionNoteId = new URL(selectionWindow.url()).searchParams.get('noteId')
  if (!selectionNoteId) throw new Error('Selection sticky note id is unavailable')
  const selectedDocument = await mainPage.evaluate(async (id) => {
    const result = await window.arkdown.readStickyNote(id)
    if (!result.ok) throw new Error(result.error.message)
    return result.value.markdown
  }, selectionNoteId)
  expect(selectedDocument).toMatch(/^[*-] first list item$/mu)
  expect(selectedDocument).toMatch(/\| Name\s+\| Value \|/u)
  expect(selectedDocument).toMatch(/\| Alpha \| One\s+\|/u)
  await selectionWindow.locator('.sticky-note-titlebar button').last().click()
})

test('persists material presets across a graceful Arknote restart', async () => {
  await openStickyNoteBox(true)
  await mainPage.locator('.sticky-note-create-card').click()
  const nameDialog = mainPage.locator('.sticky-note-name-dialog')
  await nameDialog.locator('input').fill('Material Persistence')
  const createdWindowPromise = waitForStickyWindow()
  await nameDialog.locator('button').last().click()
  let stickyPage = await createdWindowPromise
  const noteId = new URL(stickyPage.url()).searchParams.get('noteId')
  if (!noteId) throw new Error('Material persistence note id is missing from the window URL')

  const chooseMaterial = async (page: Page, name: 'Mica' | 'Acrylic') => {
    await page.locator('.sticky-note-editor .ProseMirror').click({ button: 'right' })
    const menuPage = await waitForContextMenuPage()
    await menuPage.getByRole('menuitem', { name: '材质', exact: true }).click()
    await menuPage.getByRole('menuitemcheckbox', { name, exact: true }).click()
  }

  await chooseMaterial(stickyPage, 'Mica')
  await expect(stickyPage.locator('.sticky-note-window'))
    .toHaveAttribute('data-material-preset', 'mica-light')

  const firstArkdownLifetime = application
  application = undefined
  await closeApplication(firstArkdownLifetime, runtime.executable)
  const firstArknoteLifetime = arknoteApplication
  arknoteApplication = undefined
  await closeApplication(firstArknoteLifetime, runtime.arknoteExecutable)

  arknoteApplication = await launchControlledArknote(false)
  stickyPage = await waitForStickyWindow(noteId)
  await expect(stickyPage.locator('.sticky-note-window'))
    .toHaveAttribute('data-material-preset', 'mica-light')

  await chooseMaterial(stickyPage, 'Acrylic')
  await expect(stickyPage.locator('.sticky-note-window'))
    .toHaveAttribute('data-material-preset', 'flowing-glass')

  const finalArknoteLifetime = arknoteApplication
  arknoteApplication = undefined
  await closeApplication(finalArknoteLifetime, runtime.arknoteExecutable)
})

test('closes Arkdown without claiming tray residency and exits through the app quit path', async () => {
  await openStickyNoteBox(false)
  const process = application!.process()
  const target = application!
  await shutdownElectronApplicationScope({
    application: target,
    executable: runtime.executable,
    requestClose: async () => await target.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().includes('surface=sticky-note'))
      if (!main) throw new Error('Main window not found')
      main.close()
    }),
  })
  expect(process.exitCode).not.toBeNull()
  application = undefined
})
