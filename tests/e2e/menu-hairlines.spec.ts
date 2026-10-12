import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { inflateSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  cleanupRuntime,
  createRuntimeInstance,
  shutdownElectronApplicationScope,
  type RuntimeInstance,
} from './support/runtime'

interface DecodedPng {
  channels: number
  height: number
  pixels: Uint8Array
  width: number
}

interface DividerGeometry {
  box: { height: number; width: number; x: number; y: number }
  color: [number, number, number]
  label: string
  stroke: { height: number; top: number }
}

let application: ElectronApplication | undefined
let page: Page
let runtime: RuntimeInstance
let requestedDpr = 1.5

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft
  const distances = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upperLeft)]
  return distances[0]! <= distances[1]! && distances[0]! <= distances[2]!
    ? left
    : distances[1]! <= distances[2]! ? up : upperLeft
}

function decodePng(buffer: Buffer): DecodedPng {
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('Menu screenshot is not a PNG')
  }
  let width = 0
  let height = 0
  let channels = 0
  const compressed: Buffer[] = []
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset)
    const kind = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0
      if (data[8] !== 8 || data[12] !== 0 || channels === 0) {
        throw new Error('Unsupported screenshot PNG encoding')
      }
    } else if (kind === 'IDAT') compressed.push(data)
    offset += length + 12
    if (kind === 'IEND') break
  }
  const source = inflateSync(Buffer.concat(compressed))
  const stride = width * channels
  const pixels = new Uint8Array(stride * height)
  let sourceOffset = 0
  for (let y = 0; y < height; y += 1) {
    const filter = source[sourceOffset++] ?? 0
    for (let x = 0; x < stride; x += 1) {
      const raw = source[sourceOffset++] ?? 0
      const offset = y * stride + x
      const left = x >= channels ? pixels[offset - channels] ?? 0 : 0
      const up = y > 0 ? pixels[offset - stride] ?? 0 : 0
      const upperLeft = y > 0 && x >= channels ? pixels[offset - stride - channels] ?? 0 : 0
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
        : filter === 2 ? up
        : filter === 3 ? Math.floor((left + up) / 2)
        : filter === 4 ? paeth(left, up, upperLeft)
        : Number.NaN
      if (!Number.isFinite(predictor)) throw new Error(`Unsupported PNG filter ${filter}`)
      pixels[offset] = (raw + predictor) & 0xff
    }
  }
  return { channels, height, pixels, width }
}

function matchingRows(image: DecodedPng, sample: DividerGeometry, dpr: number): number[] {
  const x = Math.floor((sample.box.x + sample.box.width / 2) * dpr)
  const from = Math.max(0, Math.floor((sample.box.y - 1) * dpr))
  const to = Math.min(image.height - 1, Math.ceil((sample.box.y + sample.box.height + 1) * dpr))
  const rows: number[] = []
  for (let y = from; y <= to; y += 1) {
    const offset = (y * image.width + x) * image.channels
    const rgb = [image.pixels[offset], image.pixels[offset + 1], image.pixels[offset + 2]]
    if (rgb.every((channel, index) => Math.abs((channel ?? 0) - sample.color[index]!) <= 4)) rows.push(y)
  }
  return rows
}

async function dividerGeometry(locator: Locator): Promise<DividerGeometry[]> {
  return await locator.evaluateAll((elements) => elements.map((element, index) => {
    const wrapper = (element as HTMLElement).getBoundingClientRect()
    const stroke = element.querySelector<HTMLElement>('.menu-hairline-stroke')
    if (!stroke) throw new Error('Menu separator has no hairline stroke')
    const strokeBox = stroke.getBoundingClientRect()
    const match = getComputedStyle(stroke).backgroundColor.match(/[\d.]+/gu)?.map(Number) ?? []
    if (match.length < 3) throw new Error('Menu separator has no RGB stroke color')
    return {
      box: { x: wrapper.x, y: wrapper.y, width: wrapper.width, height: wrapper.height },
      color: [match[0]!, match[1]!, match[2]!] as [number, number, number],
      label: `${element.className}-${index}`,
      stroke: { height: strokeBox.height, top: strokeBox.top },
    }
  }))
}

async function captureAndAssert(
  testInfo: TestInfo,
  label: string,
  separators: Locator,
  extra: Record<string, unknown>,
): Promise<void> {
  const samples = await dividerGeometry(separators)
  const screenshot = await page.screenshot()
  const image = decodePng(screenshot)
  const actualDpr = await page.evaluate(() => devicePixelRatio)
  const native = await application!.evaluate(({ BrowserWindow, screen }) => ({
    systemScale: screen.getPrimaryDisplay().scaleFactor,
    windowBounds: BrowserWindow.getAllWindows()[0]?.getBounds() ?? null,
  }))
  expect(native.systemScale).toBe(1.5)
  expect(actualDpr).toBe(requestedDpr)
  const sampled = samples.map((sample) => ({
    ...sample,
    physicalRows: matchingRows(image, sample, actualDpr),
  }))
  for (const sample of sampled) {
    expect(sample.stroke.height * actualDpr).toBeCloseTo(1, 4)
    expect(sample.stroke.top * actualDpr).toBeCloseTo(Math.round(sample.stroke.top * actualDpr), 4)
    expect(sample.physicalRows, `${label}: ${sample.label}`).toHaveLength(1)
  }
  await testInfo.attach(`${label}.png`, { body: screenshot, contentType: 'image/png' })
  await testInfo.attach(`${label}.json`, {
    body: Buffer.from(JSON.stringify({ requestedDpr, actualDpr, ...native, samples: sampled, ...extra }, null, 2)),
    contentType: 'application/json',
  })
}

test.beforeEach(async ({}, testInfo) => {
  requestedDpr = Number(testInfo.project.metadata.requestedDpr)
  const sharedApplication = process.env.ARKDOWN_E2E_SHARED_APPLICATION
  if (!sharedApplication) throw new Error('Electron E2E shared runtime is not prepared')
  runtime = await createRuntimeInstance(sharedApplication, 'arkdown-menu-hairlines-e2e-runtime-')
  const workspace = path.join(runtime.root, 'workspace')
  await mkdir(workspace, { recursive: true })
  await writeFile(
    path.join(workspace, 'hairlines.md'),
    '# Hairlines\n\nParagraph one\n\nParagraph two\n\nParagraph three\n',
    'utf8',
  )
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
      ARKDOWN_E2E_WORKSPACE: workspace,
    },
  })
  page = await application.firstWindow({ timeout: 15_000 })
  await page.getByRole('button', { name: 'hairlines.md', exact: true }).click()
  await expect(page.locator('.ProseMirror')).toBeVisible()
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

test('samples one physical divider row in real application and context menu trees', async ({}, testInfo) => {
  const titlebar = page.getByTestId('app-titlebar')
  await titlebar.getByRole('button', { name: '文件', exact: true }).click()
  await page.getByRole('menuitem', { name: '最近编辑的文档…', exact: true }).hover()
  const applicationSubmenu = page.locator('.application-menu-submenu')
  await expect(applicationSubmenu).toBeVisible()
  await captureAndAssert(
    testInfo,
    'application-menu-root-submenu',
    page.locator('.application-menu-separator'),
    {
      rootBounds: await page.locator('.application-menu-popover:not(.application-menu-submenu)').boundingBox(),
      submenuBounds: await applicationSubmenu.boundingBox(),
    },
  )
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  const editor = page.locator('.ProseMirror')
  const editorBox = await editor.boundingBox()
  if (!editorBox) throw new Error('Editor geometry is unavailable')
  const contextYs = [editorBox.y + 48, Math.min(editorBox.y + editorBox.height - 32, editorBox.y + 340)]
  for (const [index, y] of contextYs.entries()) {
    await page.mouse.click(editorBox.x + 160, y, { button: 'right' })
    const contextRoot = page.locator('.context-menu-list:not(.context-menu-submenu)')
    await expect(contextRoot).toBeVisible()
    await contextRoot.getByRole('menuitem', { name: '插入', exact: true }).hover()
    const contextSubmenu = page.locator('.context-menu-submenu')
    await expect(contextSubmenu).toBeVisible()
    await captureAndAssert(
      testInfo,
      `context-menu-y-${index}`,
      page.locator('.context-menu-separator'),
      {
        requestedY: y,
        rootBounds: await contextRoot.boundingBox(),
        submenuBounds: await contextSubmenu.boundingBox(),
      },
    )
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  }
})
