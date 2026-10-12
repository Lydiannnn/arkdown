import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { saveWithNativeShortcut } from './support/native-shortcuts'
import {
  cleanupRuntime,
  createRuntimeInstance,
  runE2eStage,
  shutdownElectronApplicationScope,
} from './support/runtime'

const NOTE_TEXT = '# Deletion fixture\n\nKeep this removable'
const SECOND_TEXT = '# Second document\n'
const CLEAN_NOTE_TITLE = 'note.md — Arkdown'
const DIRTY_NOTE_TITLE = '● note.md — Arkdown'

let application: ElectronApplication | undefined
let page: Page
let runtimeApplication = ''
let runtimeExecutable = ''
let runtimeRoot = ''
let workspace = ''

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

async function openDocument(name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.locator('.ProseMirror')).toBeVisible()
}

async function clickDocumentImmediately(name: string): Promise<string> {
  return await page.getByRole('button', { name, exact: true }).evaluate((button) => {
    const title = document.title
    ;(button as HTMLElement).click()
    return title
  })
}

async function closeWindowImmediately(editorSelector: string): Promise<{
  editorText: string
  title: string
}> {
  return await page.evaluate((selector) => {
    const editor = document.querySelector(selector)
    if (!editor) throw new Error('Editor missing before immediate close')
    const closeButton = document.querySelector<HTMLButtonElement>('.window-close-button')
    if (!closeButton) throw new Error('Arkdown window close control missing')
    const editorText = editor.textContent ?? ''
    const title = document.title
    closeButton.click()
    return { editorText, title }
  }, editorSelector)
}

async function chooseUnsavedDecision(
  label: '保存' | '不保存' | '取消',
  waitForDialogUnmount = true,
): Promise<void> {
  const dialog = page.getByRole('dialog', { name: '是否保存对“note.md”的更改？' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: label, exact: true }).click()
  if (waitForDialogUnmount) await expect(dialog).toHaveCount(0)
}

async function launchApplication(): Promise<void> {
  application = await runE2eStage('连接未保存删除保护 Electron 主进程', async () =>
    await electron.launch({
      executablePath: runtimeExecutable,
      cwd: runtimeApplication,
      timeout: 30_000,
      args: [
        '--disable-gpu',
        `--user-data-dir=${path.join(runtimeRoot, 'user-data')}`,
      ],
      env: {
        ...process.env,
        APPDATA: runtimeRoot,
        LOCALAPPDATA: runtimeRoot,
        ARKDOWN_E2E: '1',
        ARKDOWN_E2E_RECOVER: '1',
        ARKDOWN_E2E_WORKSPACE: workspace,
      },
    }))
  page = await runE2eStage('等待未保存删除保护窗口', async () =>
    await application!.firstWindow({ timeout: 15_000 }))
  await expect(page.getByRole('button', { name: 'note.md', exact: true }))
    .toBeVisible({ timeout: 10_000 })
}

test.beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'arkdown-unsaved-deletion-e2e-workspace-'))
  await Promise.all([
    writeFile(path.join(workspace, 'note.md'), NOTE_TEXT, 'utf8'),
    writeFile(path.join(workspace, 'second.md'), SECOND_TEXT, 'utf8'),
  ])
  const sharedApplication = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!sharedApplication) throw new Error('Electron E2E shared runtime is not prepared')
  const runtime = await createRuntimeInstance(
    sharedApplication,
    'arkdown-unsaved-deletion-e2e-runtime-',
  )
  runtimeRoot = runtime.root
  runtimeApplication = runtime.application
  runtimeExecutable = runtime.executable
})

test.afterEach(async () => {
  const target = application
  application = undefined
  if (runtimeExecutable) await closeApplication(target, runtimeExecutable)
  if (workspace) {
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  if (runtimeRoot) {
    await runE2eStage('清理未保存删除保护隔离运行实例', async () => {
      await cleanupRuntime(runtimeRoot)
    })
  }
  runtimeApplication = ''
  runtimeExecutable = ''
  runtimeRoot = ''
  workspace = ''
})

test('keeps a visual Backspace deletion when immediate document switch is cancelled', async () => {
  await launchApplication()
  await openDocument('note.md')
  const editor = page.locator('.ProseMirror')
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Control+Shift+ArrowLeft')
  await page.keyboard.press('Backspace')
  const titleBeforeSwitch = await clickDocumentImmediately('second.md')

  expect(titleBeforeSwitch).toBe(CLEAN_NOTE_TITLE)
  await chooseUnsavedDecision('取消')
  await expect(page).toHaveTitle(DIRTY_NOTE_TITLE)
  await expect(editor).not.toContainText('removable')
  await saveWithNativeShortcut(application!, page)
  await expect(page).toHaveTitle(CLEAN_NOTE_TITLE)
})

test('keeps a visual range deletion when immediate window close is cancelled', async () => {
  await launchApplication()
  await openDocument('note.md')
  const editor = page.locator('.ProseMirror')
  await editor.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  const closeSnapshot = await closeWindowImmediately('.ProseMirror')

  expect(closeSnapshot.title).toBe(CLEAN_NOTE_TITLE)
  expect(closeSnapshot.editorText).toBe('')
  await chooseUnsavedDecision('取消')
  expect(page.isClosed()).toBe(false)
  await expect(page).toHaveTitle(DIRTY_NOTE_TITLE)
  await expect(editor).toHaveText('')
  expect(await readFile(path.join(workspace, 'note.md'), 'utf8')).toBe(NOTE_TEXT)
  await saveWithNativeShortcut(application!, page)
  await expect(page).toHaveTitle(CLEAN_NOTE_TITLE)
  expect(await readFile(path.join(workspace, 'note.md'), 'utf8')).toBe('')
})

test('saves a visual range deletion before immediate window close', async () => {
  await launchApplication()
  await openDocument('note.md')
  const editor = page.locator('.ProseMirror')
  await editor.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')

  let closeSnapshot: Awaited<ReturnType<typeof closeWindowImmediately>> | undefined
  await shutdownElectronApplicationScope({
    application,
    executable: runtimeExecutable,
    requestClose: async () => {
      const closed = page.waitForEvent('close')
      closeSnapshot = await closeWindowImmediately('.ProseMirror')
      await chooseUnsavedDecision('保存', false)
      await closed
    },
  })
  application = undefined

  expect(closeSnapshot?.editorText).toBe('')
  expect(await readFile(path.join(workspace, 'note.md'), 'utf8')).toBe('')
})

test('discards a visual range deletion before immediate window close', async () => {
  await launchApplication()
  const originalBytes = await readFile(path.join(workspace, 'note.md'))
  await openDocument('note.md')
  const editor = page.locator('.ProseMirror')
  await editor.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.waitForTimeout(2_100)

  let closeSnapshot: Awaited<ReturnType<typeof closeWindowImmediately>> | undefined
  await shutdownElectronApplicationScope({
    application,
    executable: runtimeExecutable,
    requestClose: async () => {
      const closed = page.waitForEvent('close')
      closeSnapshot = await closeWindowImmediately('.ProseMirror')
      await chooseUnsavedDecision('不保存', false)
      await closed
    },
  })
  application = undefined

  expect(closeSnapshot?.editorText).toBe('')
  expect(await readFile(path.join(workspace, 'note.md'))).toEqual(originalBytes)
})

test('discards a settled visual deletion once when switching documents', async () => {
  await launchApplication()
  const originalBytes = await readFile(path.join(workspace, 'note.md'))
  await openDocument('note.md')
  const editor = page.locator('.ProseMirror')
  await editor.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.waitForTimeout(2_100)

  await page.getByRole('button', { name: 'second.md', exact: true }).click()
  await chooseUnsavedDecision('不保存')

  await expect(page.locator('.ProseMirror')).toContainText('Second document')
  expect(await readFile(path.join(workspace, 'note.md'))).toEqual(originalBytes)
  await page.waitForTimeout(1_200)
  await expect(page.getByRole('dialog', { name: '是否保存对“note.md”的更改？' }))
    .toHaveCount(0)
})

test('keeps a source deletion when immediate document switch is cancelled', async () => {
  await launchApplication()
  await openDocument('note.md')
  await page.locator('.source-mode-toolbar-button').click()
  const editor = page.locator('.cm-content')
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Control+Shift+ArrowLeft')
  await page.keyboard.press('Delete')
  await clickDocumentImmediately('second.md')

  await chooseUnsavedDecision('取消')
  await expect(page).toHaveTitle(DIRTY_NOTE_TITLE)
  await expect(editor).not.toContainText('removable')
  await saveWithNativeShortcut(application!, page)
  await expect(page).toHaveTitle(CLEAN_NOTE_TITLE)
})

test('keeps a source deletion when immediate window close is cancelled', async () => {
  await launchApplication()
  await openDocument('note.md')
  await page.locator('.source-mode-toolbar-button').click()
  const editor = page.locator('.cm-content')
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Control+Shift+ArrowLeft')
  await page.keyboard.press('Delete')
  const closeSnapshot = await closeWindowImmediately('.cm-content')

  expect(closeSnapshot.editorText).not.toContain('removable')
  await chooseUnsavedDecision('取消')
  expect(page.isClosed()).toBe(false)
  await expect(page).toHaveTitle(DIRTY_NOTE_TITLE)
  await expect(editor).not.toContainText('removable')
  expect(await readFile(path.join(workspace, 'note.md'), 'utf8')).toBe(NOTE_TEXT)
  await saveWithNativeShortcut(application!, page)
  await expect(page).toHaveTitle(CLEAN_NOTE_TITLE)
  expect(await readFile(path.join(workspace, 'note.md'), 'utf8')).not.toContain('removable')
})

test('keeps a visual cut when immediate document switch is cancelled', async () => {
  await launchApplication()
  await openDocument('note.md')
  const editor = page.locator('.ProseMirror')
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Control+Shift+ArrowLeft')
  await page.keyboard.press('Control+x')
  const titleBeforeSwitch = await clickDocumentImmediately('second.md')

  expect(titleBeforeSwitch).toBe(CLEAN_NOTE_TITLE)
  await chooseUnsavedDecision('取消')
  await expect(page).toHaveTitle(DIRTY_NOTE_TITLE)
  await expect(editor).not.toContainText('removable')
  await saveWithNativeShortcut(application!, page)
  await expect(page).toHaveTitle(CLEAN_NOTE_TITLE)
})
