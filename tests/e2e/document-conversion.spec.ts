import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { crc32 } from 'node:zlib'
import {
  cleanupRuntime,
  createRuntimeInstance,
  runE2eStage,
  shutdownElectronApplicationScope,
  type RuntimeInstance,
} from './support/runtime'

const EPUB_NAME = 'document-conversion-fixture.epub'
const NOTE_NAME = 'existing-note.md'
const NOTE_MARKER = 'Existing document remains intact'
const ORIGINAL_MARKER = 'Arkdown document conversion fixture'
const MODIFIED_MARKER = 'Arkdown modified conversion fixture'

interface ZipEntry {
  name: string
  bytes: Buffer
}

function zipStored(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const checksum = crc32(entry.bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(entry.bytes.length, 18)
    local.writeUInt32LE(entry.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, entry.bytes)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(entry.bytes.length, 20)
    central.writeUInt32LE(entry.bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + entry.bytes.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, end])
}

async function writeEpub(destination: string, marker: string): Promise<void> {
  const entries: ZipEntry[] = [
    { name: 'mimetype', bytes: Buffer.from('application/epub+zip', 'utf8') },
    {
      name: 'META-INF/container.xml',
      bytes: Buffer.from([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
        '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>',
        '</container>',
      ].join(''), 'utf8'),
    },
    {
      name: 'OEBPS/content.opf',
      bytes: Buffer.from([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0">',
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
        '<dc:identifier id="book-id">arkdown-e2e</dc:identifier>',
        '<dc:title>Arkdown conversion fixture</dc:title>',
        '<dc:language>en</dc:language>',
        '</metadata>',
        '<manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest>',
        '<spine><itemref idref="chapter"/></spine>',
        '</package>',
      ].join(''), 'utf8'),
    },
    {
      name: 'OEBPS/chapter.xhtml',
      bytes: Buffer.from([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Fixture</title></head>',
        `<body><h1>${marker}</h1><p>Local conversion content.</p></body></html>`,
      ].join(''), 'utf8'),
    },
  ]
  await writeFile(destination, zipStored(entries))
}

async function directoryEntries(directory: string): Promise<string[]> {
  return await readdir(directory).catch(() => [])
}

async function observeConversionTask(
  taskRoot: string,
  operation: () => Promise<void>,
): Promise<boolean> {
  let complete = false
  let observed = false
  const monitor = (async () => {
    while (!complete) {
      if ((await directoryEntries(taskRoot)).some((entry) => entry.startsWith('arkdown-markitdown-'))) {
        observed = true
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  })()
  try {
    await operation()
  } finally {
    complete = true
    await monitor
  }
  return observed
}

async function waitForComponentRemoval(runtime: RuntimeInstance): Promise<void> {
  const componentRoot = path.join(runtime.portableData, 'document-conversion')
  await expect.poll(async () => ({
    active: await stat(path.join(componentRoot, 'active')).then(() => true, () => false),
    backup: await directoryEntries(path.join(componentRoot, 'backup')),
    staging: await directoryEntries(path.join(componentRoot, 'staging')),
  }), { timeout: 45_000 }).toEqual({ active: false, backup: [], staging: [] })
}

async function launch(runtime: RuntimeInstance, workspace: string): Promise<{
  application: ElectronApplication
  page: Page
}> {
  const temporary = path.join(runtime.root, 'temp')
  await mkdir(temporary, { recursive: true })
  const application = await runE2eStage('连接文档转换 Electron 主进程', async () => await electron.launch({
    executablePath: runtime.executable,
    cwd: runtime.application,
    timeout: 30_000,
    args: [
      '--disable-gpu',
      `--user-data-dir=${runtime.userData}`,
    ],
    env: {
      ...process.env,
      APPDATA: runtime.root,
      LOCALAPPDATA: runtime.root,
      TEMP: temporary,
      TMP: temporary,
      TMPDIR: temporary,
      ARKDOWN_E2E: '1',
      ARKDOWN_E2E_RECOVER: '1',
      ARKDOWN_E2E_WORKSPACE: workspace,
    },
  }))
  const page = await runE2eStage('等待文档转换窗口', async () => (
    await application.firstWindow({ timeout: 15_000 })
  ))
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('Document conversion E2E renderer console', message.text())
  })
  page.on('pageerror', (error) => {
    console.error('Document conversion E2E renderer page error', error.stack ?? error.message)
  })
  await expect(page.getByRole('button', { name: EPUB_NAME, exact: true })).toBeVisible()
  return { application, page }
}

test('installs, converts, caches, invalidates, saves, removes, and shuts down cleanly', async () => {
  const sharedApplication = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!sharedApplication) throw new Error('Electron E2E shared runtime is not prepared')
  const workspace = await mkdtemp(path.join(tmpdir(), 'arkdown-document-conversion-workspace-'))
  const saveDestination = path.join(workspace, 'converted-fixture.md')
  const epubPath = path.join(workspace, EPUB_NAME)
  let runtime: RuntimeInstance | undefined
  let application: ElectronApplication | undefined
  try {
    runtime = await createRuntimeInstance(sharedApplication, 'arkdown-document-conversion-runtime-')
    await writeEpub(epubPath, ORIGINAL_MARKER)
    await writeFile(path.join(workspace, NOTE_NAME), `# Existing\n\n${NOTE_MARKER}\n`, 'utf8')
    const originalBytes = await readFile(epubPath)
    const launched = await launch(runtime, workspace)
    application = launched.application
    const { page } = launched

    await page.getByRole('button', { name: NOTE_NAME, exact: true }).click()
    await expect(page.locator('.ProseMirror')).toContainText(NOTE_MARKER)
    await page.getByRole('button', { name: EPUB_NAME, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '转换文档预览' })
    await expect(dialog).toContainText('转换此文档需要安装文档转换组件。')

    await dialog.getByRole('button', { name: '安装', exact: true }).click()
    await expect(dialog.getByRole('button', { name: '正在安装', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await waitForComponentRemoval(runtime)
    await expect(page.getByRole('heading', { name: NOTE_NAME, exact: true })).toBeVisible()
    await expect(page.locator('.ProseMirror')).toContainText(NOTE_MARKER)

    await page.getByRole('button', { name: EPUB_NAME, exact: true }).click()
    await expect(dialog).toContainText('转换此文档需要安装文档转换组件。')
    await dialog.getByRole('button', { name: '安装', exact: true }).click()
    await expect(dialog.getByRole('progressbar', { name: '文档转换组件安装进度' })).toBeVisible()
    const preview = dialog.getByLabel('转换后的 Markdown 预览')
    await expect(preview).toContainText(ORIGINAL_MARKER, { timeout: 90_000 })

    await application.evaluate(({ dialog: nativeDialog }, destination) => {
      nativeDialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: destination,
      })
    }, saveDestination)
    await dialog.getByRole('button', { name: '新建 Markdown', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'document-conversion-fixture.md', exact: true })).toBeVisible()
    await expect(page.locator('.document-save-controls[data-state="dirty"]')).toContainText('未保存')
    await expect(page.locator('.ProseMirror')).toContainText(ORIGINAL_MARKER)
    await page.keyboard.press('Control+Shift+S')
    await expect.poll(async () => await readFile(saveDestination, 'utf8').catch(() => '')).toContain(ORIGINAL_MARKER)
    await expect(page.getByRole('heading', { name: 'converted-fixture.md', exact: true })).toBeVisible()
    await expect(page.locator('.document-save-controls[data-state="saved"]')).toContainText('已保存')
    expect((await readFile(epubPath)).equals(originalBytes)).toBe(true)

    const conversionTaskRoot = path.join(runtime.application, 'temp', 'document-conversion')
    expect(await directoryEntries(conversionTaskRoot)).toEqual([])
    const warmSpawnedTask = await observeConversionTask(conversionTaskRoot, async () => {
      await page.getByRole('button', { name: EPUB_NAME, exact: true }).click()
      await expect(preview).toContainText(ORIGINAL_MARKER)
    })
    expect(warmSpawnedTask).toBe(false)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()

    await writeEpub(epubPath, MODIFIED_MARKER)
    const modifiedSpawnedTask = await observeConversionTask(conversionTaskRoot, async () => {
      await page.getByRole('button', { name: EPUB_NAME, exact: true }).click()
      await expect(preview).toContainText(MODIFIED_MARKER, { timeout: 45_000 })
    })
    expect(modifiedSpawnedTask).toBe(true)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()

    await page.getByTestId('app-titlebar').getByRole('button', { name: '文件', exact: true }).click()
    await page.getByRole('menuitem', { name: /偏好设置/u }).click()
    const preferences = page.getByRole('main', { name: '偏好设置' })
    const componentGroup = preferences.getByRole('group', { name: '文档转换组件' })
    await componentGroup.scrollIntoViewIfNeeded()
    await componentGroup.getByRole('button', { name: '已安装', exact: true }).click()
    const removeDialog = page.getByRole('dialog', { name: '是否删除文档转换组件？' })
    await removeDialog.getByRole('button', { name: '删除', exact: true }).click()
    await expect(componentGroup.getByRole('button', { name: '安装', exact: true })).toBeVisible()
    await waitForComponentRemoval(runtime)

    await page.keyboard.press('Escape')
    await expect(preferences).toHaveCount(0)
    await page.getByRole('button', { name: EPUB_NAME, exact: true }).click()
    await expect(dialog).toContainText('转换此文档需要安装文档转换组件。')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
  } finally {
    const target = application
    application = undefined
    try {
      if (runtime) {
        const ownedRuntime = runtime
        await shutdownElectronApplicationScope({
          application: target,
          executable: ownedRuntime.executable,
          requestClose: async (targetApplication) => await targetApplication.close(),
          afterQuiet: async () => {
            await expect.poll(async () => ({
              staging: await directoryEntries(path.join(
                ownedRuntime.portableData,
                'document-conversion',
                'staging',
              )),
              tasks: await directoryEntries(path.join(
                ownedRuntime.application,
                'temp',
                'document-conversion',
              )),
            })).toEqual({ staging: [], tasks: [] })
          },
        })
        await runE2eStage('清理文档转换隔离运行实例', async () => {
          await cleanupRuntime(ownedRuntime.root)
        })
      }
    } finally {
      await rm(workspace, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })
    }
  }
})
