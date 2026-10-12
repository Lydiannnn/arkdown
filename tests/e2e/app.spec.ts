import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { saveWithNativeShortcut } from './support/native-shortcuts'
import { CLIPBOARD_IMAGE_SENTINEL, expectNativePng, installNativeClipboardImage } from './support/clipboard-image'
import {
  cleanupRuntime,
  createRuntimeInstance,
  runE2eStage,
  shutdownElectronApplicationScope,
} from './support/runtime'


const NOTE_TEXT = '# Hello\n\n1. ordered one\n2. ordered two\n\n- bullet one\n- bullet two\n'
const HORIZONTAL_RULE_TEXT = [
  '# Horizontal rules',
  '',
  '---',
  '',
  '<hr data-arkdown-style="black-80" />',
  '',
  '<hr data-arkdown-style="black-40-double" />',
  '',
  '<hr data-arkdown-style="black-40-quadruple" />',
  '',
].join('\n')
const TABLE_TEXT = [
  '# 表格验证',
  '',
  '| 事项 | 交付物与验收标准 | 优先级 | 负责人 | 状态 |',
  '| --- | --- | --- | --- | --- |',
  '| 普通导入回归 | 字段只按完整表头或明确归一化词导入，不发生跨列污染 | 高 |  |  |',
  '| 去重与覆盖回归 | SKU 冲突提示、无 SKU 产品名称去重和覆盖确认符合规则书 | 高 |  |  |',
  '| 导入撤销回归 | 新增记录可删除、覆盖记录可恢复，发生后续修改的条目会跳过并导出记录 | 高 |  |  |',
  '| 报价登记回归 | 单条、批量、自动识别和询价单添加均正确处理重复 SKU 与数量 | 中 |  |  |',
  '',
].join('\n')

const UNTOUCHED_BYTES = Buffer.from('\ufeff# Untouched\r\n\r\nNo edits.\r\n', 'utf8')

let application: ElectronApplication | undefined
let page: Page
let runtimeApplication: string
let runtimeExecutable: string
let runtimeRoot: string
let workspace: string
let assetSources: string

async function readWorkspaceFile(name: string): Promise<string> {
  return await readFile(path.join(workspace, name), 'utf8')
}

async function expectActiveDraftForNote(marker: string): Promise<void> {
  const recordsDirectory = path.join(runtimeApplication, 'temp', 'records')
  const expectedOriginal = path.resolve(workspace, 'note.md')
  await expect.poll(async () => {
    const entries = await readdir(recordsDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    let matching = 0
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const source = await readFile(path.join(recordsDirectory, entry.name), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (source === null) continue
      const record = JSON.parse(source.replace(/^\uFEFF/u, '')) as {
        version?: unknown; state?: unknown; markdown?: unknown
        manifest?: { version?: unknown; draftId?: unknown; originalAbsolutePath?: unknown; bodySha256?: unknown }
      }
      if (record.version !== 2 || record.state !== 'active' || typeof record.markdown !== 'string'
        || record.manifest?.version !== 1 || typeof record.manifest.originalAbsolutePath !== 'string'
        || entry.name !== `${record.manifest.draftId}.json`
        || path.resolve(record.manifest.originalAbsolutePath) !== expectedOriginal
        || !record.markdown.includes(marker)) continue
      expect(record.manifest.bodySha256).toBe(createHash('sha256').update(record.markdown).digest('hex'))
      matching += 1
    }
    return matching
  }, { timeout: 10_000, message: 'Expected one committed active draft for note.md containing the current edit' }).toBe(1)
  await expect(page.locator('.document-save-controls')).toHaveAttribute('data-state', 'dirty')
  await expect(page.locator('.document-save-state')).toHaveText('未保存')
  await expect(page).toHaveTitle('● note.md — Arkdown')
}

async function expectNoteSaved(): Promise<void> {
  await expect(page.locator('.document-save-controls')).toHaveAttribute('data-state', 'saved')
  await expect(page.locator('.document-save-state')).toHaveText('已保存')
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await expect(page).toHaveTitle('note.md — Arkdown')
}

function silentWav(): Buffer {
  const dataBytes = 8_000
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(8_000, 24)
  buffer.writeUInt32LE(8_000, 28)
  buffer.writeUInt16LE(1, 32)
  buffer.writeUInt16LE(8, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)
  buffer.fill(128, 44)
  return buffer
}

async function dropFromExplorer(sourcePath: string): Promise<void> {
  const inputId = 'e2e-drop-source'
  await page.evaluate((id) => {
    const input = document.createElement('input')
    input.id = id
    input.type = 'file'
    input.hidden = true
    document.body.append(input)
  }, inputId)
  const input = page.locator('#' + inputId)
  await input.setInputFiles(sourcePath)
  const nativePath = await page.evaluate((id) => {
    const picker = document.querySelector<HTMLInputElement>('#' + id)!
    const file = picker.files?.[0]
    if (!file) throw new Error('E2E drop file is unavailable')
    const resolved = window.arkdown.pathForDroppedFile(file)
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const target = document.querySelector<HTMLElement>('.editor-host')!
    target.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }))
    target.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }))
    picker.remove()
    return resolved
  }, inputId)
  expect(path.normalize(nativePath)).toBe(path.normalize(sourcePath))
}

async function launchWorkspace(startupDocument?: string): Promise<void> {
  application = await runE2eStage('连接 Electron 主进程', async () => {
    return await electron.launch({
      executablePath: path.join(runtimeApplication, 'Arkdown.exe'),
      cwd: runtimeApplication,
      timeout: 30_000,
      args: [
        ...(startupDocument ? [startupDocument] : []),
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
    })
  })
  page = await runE2eStage('等待首个窗口', async () => {
    return await application!.firstWindow({ timeout: 15_000 })
  })
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('E2E renderer console', message.text())
  })
  page.on('pageerror', (error) => {
    console.error('E2E renderer page error', error.stack ?? error.message)
  })
  const noteButton = page.getByRole('button', { name: 'note.md', exact: true })
  try {
    await expect(noteButton).toBeVisible({ timeout: 10_000 })
  } catch (error) {
    console.error('E2E window diagnostic', {
      title: await page.title(),
      url: page.url(),
      body: await page.locator('body').innerText().catch(() => '<unavailable>'),
    })
    throw error
  }
}

async function openDocument(name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.locator('.ProseMirror')).toBeVisible()
}

async function executeFileMenuItem(name: RegExp): Promise<void> {
  await page.getByRole('navigation', { name: '应用程序菜单' })
    .getByRole('button', { name: '文件', exact: true }).click()
  await page.getByRole('menuitem', { name }).click()
}

async function expectRenderedClipboardImages(images: Locator, count: number) {
  await expect(images).toHaveCount(count)
  await expect.poll(() => images.evaluateAll((elements) => elements.map((element) => {
    const image = element as HTMLImageElement
    return image.complete && image.naturalWidth > 0
  }))).toEqual(Array<boolean>(count).fill(true))
}

for (const mode of ['source', 'visual'] as const) {
  for (const entry of ['keyboard', 'context'] as const) {
    test(`persists native clipboard PNG in ${mode} through ${entry}, undo/redo and reopen`, async () => {
      await openDocument('note.md')
      if (mode === 'source') await page.locator('.source-mode-toolbar-button').click()
      const editor = page.locator(mode === 'source' ? '.cm-content' : '.ProseMirror')
      await editor.click()
      await page.keyboard.press('Control+a')
      await page.keyboard.insertText('beforeafter')
      await page.keyboard.press('Control+Home')
      for (let index = 0; index < 6; index += 1) await page.keyboard.press('ArrowRight')
      const restoreClipboard = await installNativeClipboardImage(application!)
      try {
        if (entry === 'keyboard') await page.keyboard.press('Control+v')
        else {
          await editor.click({ button: 'right' })
          await page.getByRole('menuitem', { name: '粘贴', exact: true }).click()
        }
        const imagePresent = async () => mode === 'source'
          ? ((await editor.innerText()).match(/clipboard-[0-9a-f-]+\.png/gu) ?? []).length
          : await editor.locator('.arkdown-local-image > img').count()
        await expect.poll(imagePresent).toBe(1)
        if (mode === 'visual') await expectRenderedClipboardImages(editor.locator('.arkdown-local-image > img'), 1)
        await expect(editor).not.toContainText(CLIPBOARD_IMAGE_SENTINEL)
        await page.keyboard.press('Control+z')
        await expect.poll(imagePresent).toBe(0)
        await expect(editor).toContainText('beforeafter')
        await page.keyboard.press('Control+y')
        await expect.poll(imagePresent).toBe(1)
        if (mode === 'visual') await expectRenderedClipboardImages(editor.locator('.arkdown-local-image > img'), 1)
        await page.keyboard.press('Control+s')
        await expect.poll(() => readWorkspaceFile('note.md')).toContain('assets/clipboard-')
        const saved = await readWorkspaceFile('note.md')
        expect(saved).not.toContain(CLIPBOARD_IMAGE_SENTINEL)
        const resource = /assets\/clipboard-[0-9a-f-]+\.png/u.exec(saved)![0]
        await expectNativePng(application!, path.join(workspace, resource))
        await openDocument('untouched.md')
        await openDocument('note.md')
        await expectRenderedClipboardImages(page.locator('.ProseMirror .arkdown-local-image > img'), 1)
        await expectNativePng(application!, path.join(workspace, resource))
      } finally { await restoreClipboard() }
    })
  }
}

test('pastes a native PNG as the first edit in a fresh blank document and survives Save As', async () => {
  // Execute real New; no draft/typing action precedes the first native PNG paste.
  await executeFileMenuItem(/^新建文档/)
  const editor = page.locator('.ProseMirror')
  await expect(editor).toBeVisible()
  await expect(editor).toBeEmpty()
  await editor.click()
  const restoreClipboard = await installNativeClipboardImage(application!)
  const target = path.join(workspace, 'clipboard-first-save.md')
  try {
    await page.keyboard.press('Control+v')
    await expectRenderedClipboardImages(editor.locator('.arkdown-local-image > img'), 1)
    await expect(editor).not.toContainText(CLIPBOARD_IMAGE_SENTINEL)
    await application!.evaluate(({ dialog }, filePath) => {
      const holder = dialog as typeof dialog & { __clipboardOriginalSave?: typeof dialog.showSaveDialog }
      holder.__clipboardOriginalSave = dialog.showSaveDialog
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    }, target)
    await executeFileMenuItem(/^另存为/)
    await expect.poll(async () => readFile(target, 'utf8').catch(() => '')).toContain('assets/clipboard-')
    const resource = /assets\/clipboard-[0-9a-f-]+\.png/u.exec(await readFile(target, 'utf8'))![0]
    await expectNativePng(application!, path.join(workspace, resource))
    await expect(page.getByRole('button', { name: 'clipboard-first-save.md', exact: true })).toBeVisible()
    await openDocument('untouched.md')
    await expect(page.locator('.ProseMirror').getByRole('heading', { name: 'Untouched', exact: true })).toBeVisible()
    await openDocument('clipboard-first-save.md')
    await expectRenderedClipboardImages(page.locator('.ProseMirror .arkdown-local-image > img'), 1)
  } finally {
    await application!.evaluate(({ dialog }) => {
      const holder = dialog as typeof dialog & { __clipboardOriginalSave?: typeof dialog.showSaveDialog }
      if (holder.__clipboardOriginalSave) dialog.showSaveDialog = holder.__clipboardOriginalSave
      delete holder.__clipboardOriginalSave
    })
    await restoreClipboard()
  }
})

test('packaged empty startup shows an editable start-writing document', async () => {
  const guide = page.locator('.ProseMirror')
  await expect(guide).toBeVisible()
  await expect(guide).toHaveAttribute('contenteditable', 'true')
  await expect(page).toHaveTitle('欢迎使用.md — Arkdown')
  await expect(guide.getByRole('heading', { level: 1, name: '把想法写下来' })).toBeVisible()
  await expect(guide.locator('.label.unchecked, .label.checked')).toHaveCount(3)
  await expect(guide.getByRole('table')).toBeVisible()
  await expect(page.getByRole('toolbar', { name: '编辑工具栏' })).toBeVisible()
  await executeFileMenuItem(/^新建文档/)
  await expect(page.locator('.ProseMirror')).toBeEmpty()
})

test('packaged explicit empty startup file takes precedence over the guide', async () => {
  await expect(page.locator('.ProseMirror')).toBeVisible()
  await expect(page.locator('.ProseMirror')).toBeEmpty()
  await expect(page.getByRole('region', { name: '开始写作' })).toHaveCount(0)
  await expect(page).toHaveTitle('explicit-empty.md — Arkdown')
  expect(await readWorkspaceFile('explicit-empty.md')).toBe('')
})

test.beforeEach(async ({}, testInfo) => {
  workspace = await mkdtemp(path.join(tmpdir(), 'arkdown-e2e-'))
  assetSources = await mkdtemp(path.join(tmpdir(), 'arkdown-e2e-assets-'))
  const sharedApplication = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!sharedApplication) throw new Error('Electron E2E shared runtime is not prepared')
  const runtime = await createRuntimeInstance(sharedApplication)
  runtimeRoot = runtime.root
  runtimeApplication = runtime.application
  runtimeExecutable = runtime.executable

  await writeFile(path.join(workspace, 'note.md'), NOTE_TEXT, 'utf8')
  await writeFile(path.join(workspace, 'rules.md'), HORIZONTAL_RULE_TEXT, 'utf8')
  const tableAttachment = process.env.ARKDOWN_E2E_TABLE_ATTACHMENT
  if (tableAttachment) {
    await cp(tableAttachment, path.join(workspace, 'table.md'))
  } else {
    await writeFile(path.join(workspace, 'table.md'), TABLE_TEXT, 'utf8')
  }
  await writeFile(path.join(workspace, 'untouched.md'), UNTOUCHED_BYTES)
  await writeFile(
    path.join(assetSources, 'source.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  await writeFile(path.join(assetSources, 'source.wav'), silentWav())
  await cp(path.resolve('tests/fixtures/media/preview.webm'), path.join(assetSources, 'source.webm'))
  await writeFile(
    path.join(assetSources, 'source.pdf'),
    Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'),
  )
  const explicitDocument = testInfo.title === 'packaged explicit empty startup file takes precedence over the guide'
    ? path.join(workspace, 'explicit-empty.md') : undefined
  if (explicitDocument) await writeFile(explicitDocument, '', 'utf8')
  await launchWorkspace(explicitDocument)
})

test.afterEach(async () => {
  const target = application
  application = undefined
  if (runtimeExecutable) {
    await shutdownElectronApplicationScope({
      application: target,
      executable: runtimeExecutable,
      requestClose: async (targetApplication) => await targetApplication.close(),
    })
  }
  if (workspace) {
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  if (assetSources) {
    await rm(assetSources, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  if (runtimeRoot) {
    await runE2eStage('清理隔离运行实例', async () => {
      await cleanupRuntime(runtimeRoot)
    })
  }
})

test('renders ordinary and controlled horizontal rules from one style registry', async () => {
  await openDocument('rules.md')
  const rules = page.locator('.ProseMirror hr')
  await expect(rules).toHaveCount(4)

  expect(await rules.evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element)
    return {
      id: (element as HTMLElement).dataset.arkdownStyle ?? null,
      heightPx: (element as HTMLElement).dataset.arkdownHeight ?? null,
      opacityPercent: (element as HTMLElement).dataset.arkdownOpacity ?? null,
      backgroundColor: style.backgroundColor,
      inlineBackgroundColor: (element as HTMLElement).style.backgroundColor,
      inlineBlockSize: (element as HTMLElement).style.blockSize,
      blockSize: style.blockSize,
      height: style.height,
    }
  }))).toEqual([
    {
      id: 'black',
      heightPx: '2',
      opacityPercent: '40',
      backgroundColor: 'rgba(0, 0, 0, 0.4)',
      inlineBackgroundColor: 'rgba(0, 0, 0, 0.4)',
      inlineBlockSize: '2px',
      blockSize: '2px',
      height: '2px',
    },
    {
      id: 'black',
      heightPx: '2',
      opacityPercent: '80',
      backgroundColor: 'rgba(0, 0, 0, 0.8)',
      inlineBackgroundColor: 'rgba(0, 0, 0, 0.8)',
      inlineBlockSize: '2px',
      blockSize: '2px',
      height: '2px',
    },
    {
      id: 'black',
      heightPx: '4',
      opacityPercent: '40',
      backgroundColor: 'rgba(0, 0, 0, 0.4)',
      inlineBackgroundColor: 'rgba(0, 0, 0, 0.4)',
      inlineBlockSize: '4px',
      blockSize: '4px',
      height: '4px',
    },
    {
      id: 'black',
      heightPx: '8',
      opacityPercent: '40',
      backgroundColor: 'rgba(0, 0, 0, 0.4)',
      inlineBackgroundColor: 'rgba(0, 0, 0, 0.4)',
      inlineBlockSize: '8px',
      blockSize: '8px',
      height: '8px',
    },
  ])
})

test('renders a content-responsive table and the shared five-group table menu', async () => {
  await openDocument('table.md')
  const table = page.locator('.ProseMirror table').first()
  await expect(table).toBeVisible()

  const tableStyle = await table.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      layout: style.tableLayout,
      width: style.width,
    }
  })
  expect(tableStyle.layout).toBe('auto')
  expect(Number.parseFloat(tableStyle.width)).toBeGreaterThan(0)

  const firstCell = table.locator('th').first()
  const cellStyle = await firstCell.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      paddingTop: style.paddingTop,
      paddingBottom: style.paddingBottom,
    }
  })
  expect(cellStyle).toEqual({ paddingTop: '6px', paddingBottom: '6px' })
  expect(await firstCell.locator(':scope > p').first().evaluate((element) => ({
    top: getComputedStyle(element).marginTop,
    bottom: getComputedStyle(element).marginBottom,
  }))).toEqual({ top: '0px', bottom: '0px' })

  const columnWidths = await table.locator('tr').first().locator('th').evaluateAll(
    (cells) => cells.map((cell) => cell.getBoundingClientRect().width),
  )
  expect(columnWidths).toHaveLength(5)
  expect(columnWidths[1]).toBeGreaterThan(columnWidths[3] * 2)
  expect(columnWidths[1]).toBeGreaterThan(columnWidths[4] * 2)

  await firstCell.click({ button: 'right' })
  const rootMenu = page.locator('.context-menu-list:not(.context-menu-submenu)')
  await expect(rootMenu).toBeVisible()
  await expect(rootMenu.getByRole('menuitem', { name: /^复制/ }).first()).toBeVisible()
  await expect(rootMenu.getByText('段落', { exact: true })).toHaveCount(0)

  const tableGroupLabels = await rootMenu
    .locator(':scope > .context-menu-entry > button[aria-haspopup="menu"] .context-menu-label')
    .evaluateAll((labels) => labels.map((label) => label.textContent?.trim() ?? ''))
  expect(tableGroupLabels.slice(-5)).toEqual(['插入', '删除', '对齐', '移动', '复制为'])

  await rootMenu.getByRole('menuitem', { name: '移动', exact: true }).hover()
  const moveUp = page.getByRole('menuitem', { name: '上移一行', exact: true })
  await expect(moveUp).toBeVisible()
  await expect(moveUp).toBeDisabled()
  expect(await moveUp.evaluate((element) => getComputedStyle(element).opacity)).toBe('0.4')
})


test('resizes one table column and persists rich cell paragraphs as controlled HTML', async () => {
  await openDocument('table.md')
  const table = page.locator('.ProseMirror table').first()
  const firstHeader = table.locator('th').first()
  const beforeWidths = await table.locator('tr').first().locator('th').evaluateAll(
    (cells) => cells.map((cell) => cell.getBoundingClientRect().width),
  )
  const beforeTotal = await table.evaluate((element) => element.getBoundingClientRect().width)
  const bounds = await firstHeader.boundingBox()
  if (!bounds) throw new Error('Table header bounds are unavailable')

  const wrapper = page.locator('.tableWrapper').first()
  const beforeHoverHeight = await wrapper.evaluate(
    (element) => element.getBoundingClientRect().height,
  )
  await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2)
  const handle = page.locator('.column-resize-handle').first()
  await expect(handle).toBeVisible()
  const afterHoverHeight = await wrapper.evaluate(
    (element) => element.getBoundingClientRect().height,
  )
  expect(afterHoverHeight).toBe(beforeHoverHeight)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width - 39, bounds.y + bounds.height / 2)
  await page.mouse.up()

  const afterWidths = await table.locator('tr').first().locator('th').evaluateAll(
    (cells) => cells.map((cell) => cell.getBoundingClientRect().width),
  )
  const afterTotal = await table.evaluate((element) => element.getBoundingClientRect().width)
  expect(afterWidths[0]).toBeLessThan(beforeWidths[0] - 25)
  expect(Math.abs(afterWidths[1] - beforeWidths[1])).toBeLessThanOrEqual(2)
  expect(afterTotal).toBeLessThan(beforeTotal - 25)

  const firstBodyCell = table.locator('tbody td').first()
  await firstBodyCell.click()
  await firstBodyCell.evaluate((element) => {
    const paragraph = element.querySelector('p')!
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    range.collapse(false)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await page.keyboard.press('Enter')
  await page.keyboard.type('格内第二段')
  await expect(firstBodyCell.locator(':scope > p')).toHaveCount(2)

  await page.keyboard.press('Control+s')
  await expect.poll(async () => await readWorkspaceFile('table.md')).toContain(
    '<table data-arkdown-table="1">',
  )
  const saved = await readWorkspaceFile('table.md')
  expect(saved).toContain('<colgroup>')
  expect(saved).toContain('<p>格内第二段</p>')
})
test('aligns lists and renders dropped image, audio, video, and PDF assets', async () => {
  await openDocument('note.md')
  try {
    const sourceNames = ['source.png', 'source.wav', 'source.webm', 'source.pdf']
    const sourceBefore = await Promise.all(sourceNames.map(async (name) => {
      const source = path.join(assetSources, name)
      const metadata = await stat(source)
      return {
        source,
        bytes: await readFile(source),
        mtimeMs: metadata.mtimeMs,
      }
    }))

    const alignments = await page.locator('.milkdown-list-item-block').evaluateAll((items) =>
      items.slice(0, 4).map((item) => {
        const label = item.querySelector<HTMLElement>('.label')!
        const paragraph = item.querySelector<HTMLElement>('.children p')!
        const labelRange = document.createRange()
        labelRange.selectNodeContents(label)
        const paragraphRange = document.createRange()
        paragraphRange.selectNodeContents(paragraph)
        return {
          labelTextTop: labelRange.getBoundingClientRect().top,
          paragraphTextTop: paragraphRange.getBoundingClientRect().top,
          paragraphMarginTop: getComputedStyle(paragraph).marginTop,
        }
      }),
    )
    expect(alignments).toHaveLength(4)
    for (const alignment of alignments) {
      expect(alignment.paragraphMarginTop).toBe('0px')
      expect(Math.abs(alignment.labelTextTop - alignment.paragraphTextTop)).toBeLessThanOrEqual(3)
    }
    const listMargins = await page.locator('.milkdown-list-item-block').evaluateAll(
      (items) => items.slice(0, 4).map((item) => getComputedStyle(item).marginTop),
    )
    expect(listMargins).toEqual(['0px', '10px', '0px', '10px'])

    await dropFromExplorer(path.join(assetSources, 'source.png'))
    const image = page.locator('.ProseMirror img[alt="source"]')
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)

    await dropFromExplorer(path.join(assetSources, 'source.wav'))
    const audio = page.locator('.ProseMirror audio.arkdown-audio').last()
    await expect(audio).toBeVisible()
    await expect.poll(() => audio.evaluate((element) => (element as HTMLAudioElement).readyState), {
      timeout: 10_000,
    }).toBeGreaterThanOrEqual(1)
    const audioPlayback = await audio.evaluate(async (element) => {
      const media = element as HTMLAudioElement
      media.muted = true
      await media.play()
      await new Promise((resolve) => setTimeout(resolve, 300))
      const result = {
        currentTime: media.currentTime,
        errorCode: media.error?.code ?? null,
      }
      media.pause()
      return result
    })
    expect(audioPlayback.errorCode).toBeNull()
    expect(audioPlayback.currentTime).toBeGreaterThan(0)
    expect(await audio.evaluate((element) => (element as HTMLAudioElement).controls)).toBe(true)

    await dropFromExplorer(path.join(assetSources, 'source.webm'))
    const video = page.locator('.ProseMirror video.arkdown-video').last()
    await expect(video).toBeVisible()
    await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState), {
      timeout: 10_000,
    }).toBeGreaterThanOrEqual(1)
    const videoMetadata = await video.evaluate((element) => {
      const media = element as HTMLVideoElement
      return { duration: media.duration, width: media.videoWidth, height: media.videoHeight }
    })
    expect(videoMetadata.duration).toBeGreaterThan(0)
    expect(videoMetadata.width).toBeGreaterThan(0)
    expect(videoMetadata.height).toBeGreaterThan(0)
    const videoPlayback = await video.evaluate(async (element) => {
      const media = element as HTMLVideoElement
      media.muted = true
      await media.play()
      await new Promise((resolve) => setTimeout(resolve, 300))
      const result = {
        currentTime: media.currentTime,
        errorCode: media.error?.code ?? null,
      }
      media.pause()
      return result
    })
    expect(videoPlayback.errorCode).toBeNull()
    expect(videoPlayback.currentTime).toBeGreaterThan(0)
    expect(await video.evaluate((element) => (element as HTMLVideoElement).controls)).toBe(false)
    await video.hover()
    expect(await video.evaluate((element) => (element as HTMLVideoElement).controls)).toBe(true)
    await page.locator('.sidebar-title').hover()
    expect(await video.evaluate((element) => (element as HTMLVideoElement).controls)).toBe(false)

    await dropFromExplorer(path.join(assetSources, 'source.pdf'))
    const pdf = page.locator('a.arkdown-local-link').filter({ hasText: 'source.pdf' })
    await expect(pdf).toBeVisible()
    await expect(pdf).toHaveAttribute('title', 'Ctrl+单击打开')
    expect(await pdf.evaluate((element) => getComputedStyle(element).cursor)).toBe('text')

    await pdf.hover()
    await page.keyboard.down('Control')
    await expect(pdf).toHaveClass(/arkdown-link-openable/)
    expect(await pdf.evaluate((element) => getComputedStyle(element).cursor)).toBe('pointer')
    await page.keyboard.up('Control')
    await expect(pdf).not.toHaveClass(/arkdown-link-openable/)
    expect(await pdf.evaluate((element) => getComputedStyle(element).cursor)).toBe('text')

    await saveWithNativeShortcut(application!, page)
    await expectNoteSaved()
    const savedMarkdown = await readWorkspaceFile('note.md')
    for (const source of sourceBefore) {
      expect(savedMarkdown).toContain(source.source)
      expect(await readFile(source.source)).toEqual(source.bytes)
      expect((await stat(source.source)).mtimeMs).toBe(source.mtimeMs)
    }
    await expect(stat(path.join(workspace, 'assets'))).rejects.toMatchObject({
      code: 'ENOENT',
    })

    await rm(path.join(assetSources, 'source.pdf'), { force: true })
    const dialogHandled = new Promise<string>((resolve) => {
      page.once('dialog', async (dialog) => {
        const message = dialog.message()
        await dialog.dismiss()
        resolve(message)
      })
    })
    await pdf.click({ modifiers: ['Control'] })
    expect(await dialogHandled).toBe('文件已被移动或删除')
  } finally {
    await saveWithNativeShortcut(application!, page).catch(() => undefined)
    await expectNoteSaved().catch(() => undefined)
  }
})

test('edits Chinese in both modes, backs up drafts, saves explicitly, and keeps native undo local', async () => {
  await openDocument('note.md')
  const visual = page.locator('.ProseMirror')
  await visual.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(' Immediate-\u4e2d\u6587')
  await saveWithNativeShortcut(application!, page)

  await expect.poll(() => readWorkspaceFile('note.md')).toContain('Immediate-\u4e2d\u6587')

  await visual.click()
  await page.keyboard.press('Control+End')
  const beforeDraftBytes = await readFile(path.join(workspace, 'note.md'))
  const beforeDraftMetadata = await stat(path.join(workspace, 'note.md'))
  await page.keyboard.insertText(' DraftBacked')
  await expectActiveDraftForNote('DraftBacked')
  expect(await readWorkspaceFile('note.md')).not.toContain('DraftBacked')
  expect(await readFile(path.join(workspace, 'note.md'))).toEqual(beforeDraftBytes)
  expect((await stat(path.join(workspace, 'note.md'))).mtimeMs).toBe(beforeDraftMetadata.mtimeMs)
  await saveWithNativeShortcut(application!, page)
  await expect.poll(() => readWorkspaceFile('note.md')).toContain('DraftBacked')
  await expectNoteSaved()

  await page.locator('.source-mode-toolbar-button').click()
  const source = page.locator('.cm-content')
  await expect(source).toContainText('Immediate-\u4e2d\u6587 DraftBacked')

  await source.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(' SourceCommitted')
  await saveWithNativeShortcut(application!, page)
  await expect.poll(() => readWorkspaceFile('note.md')).toContain('SourceCommitted')

  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.insertText(' UndoMe')
  await expect(source).toContainText('UndoMe')
  await page.keyboard.press('Control+Z')
  await expect(source).not.toContainText('UndoMe')
  await expect(source).toContainText('SourceCommitted')

  await page.locator('.source-mode-toolbar-button').click()
  const visualAgain = page.locator('.ProseMirror')
  await expect(visualAgain).toContainText('Immediate-\u4e2d\u6587')
  await expect(visualAgain).toContainText('DraftBacked')
  await expect(visualAgain).toContainText('SourceCommitted')
  await expect(visualAgain).not.toContainText('UndoMe')
})

test('preserves untouched bytes and mtime while remembering the workspace only in isolated portable settings', async () => {
  const untouchedPath = path.join(workspace, 'untouched.md')
  const beforeMetadata = await stat(untouchedPath)
  await openDocument('untouched.md')
  await page.getByRole('button', { name: 'note.md', exact: true }).click()
  await expect(page.locator('.ProseMirror')).toContainText('Hello')

  expect(await readFile(untouchedPath)).toEqual(UNTOUCHED_BYTES)
  expect((await stat(untouchedPath)).mtimeMs).toBe(beforeMetadata.mtimeMs)

  const target = application
  application = undefined
  if (runtimeExecutable) {
    await shutdownElectronApplicationScope({
      application: target,
      executable: runtimeExecutable,
      requestClose: async (targetApplication) => await targetApplication.close(),
    })
  }
  expect(path.resolve(runtimeApplication)).toBe(path.join(path.resolve(runtimeRoot), 'Arkdown'))
  const settingsPath = path.join(runtimeApplication, 'portable-data', 'settings.json')
  const settings = JSON.parse((await readFile(settingsPath, 'utf8')).replace(/^\uFEFF/u, ''))
  expect(settings.lastWorkspace).toBe(workspace)
  await expect(stat(path.join(runtimeRoot, 'user-data', 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(untouchedPath)).toEqual(UNTOUCHED_BYTES)
  expect((await stat(untouchedPath)).mtimeMs).toBe(beforeMetadata.mtimeMs)
})


test('recovers a temporary draft after forced termination without changing the original first', async () => {
  await openDocument('note.md')
  const beforeBytes = await readFile(path.join(workspace, 'note.md'))
  const beforeMetadata = await stat(path.join(workspace, 'note.md'))
  const visual = page.locator('.ProseMirror')
  await visual.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(' CrashRecovered-中文')
  await expectActiveDraftForNote('CrashRecovered-中文')

  expect(await readFile(path.join(workspace, 'note.md'))).toEqual(beforeBytes)
  expect((await stat(path.join(workspace, 'note.md'))).mtimeMs).toBe(beforeMetadata.mtimeMs)

  application = undefined
  await shutdownElectronApplicationScope<ElectronApplication>({
    application: undefined,
    executable: runtimeExecutable,
    requestClose: async () => undefined,
  })

  await launchWorkspace()
  await expect(page.locator('.ProseMirror')).toContainText('CrashRecovered-中文')
  expect(await readFile(path.join(workspace, 'note.md'))).toEqual(beforeBytes)

  await saveWithNativeShortcut(application!, page)
  await expect.poll(() => readWorkspaceFile('note.md')).toContain('CrashRecovered-中文')
  await expectNoteSaved()
  await expect(page).toHaveTitle(/^(?!● )/u)
  await page.waitForTimeout(500)
})
