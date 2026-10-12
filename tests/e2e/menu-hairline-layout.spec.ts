import type { AddressInfo } from 'node:net'
import { inflateSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

const FIXTURE_PATH = '/__menu-hairline-fixture'
const VIRTUAL_FIXTURE_ID = 'virtual:menu-hairline-fixture'
const RESOLVED_FIXTURE_ID = `\0${VIRTUAL_FIXTURE_ID}`

const fixtureModule = String.raw`
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ContextMenu } from '/src/renderer/context-menu/ContextMenu.tsx'
import { ApplicationMenuPopover } from '/src/renderer/chrome/ApplicationMenuPopover.tsx'
import { TooltipProvider } from '/src/renderer/tooltip/TooltipProvider.tsx'
import '/src/renderer/app/styles.css'
import '/src/renderer/context-menu/context-menu.css'
import '/src/renderer/tooltip/tooltip.css'

const h = React.createElement
const command = (id, label) => ({ kind: 'command', id, label })
const separator = (id) => ({ kind: 'separator', id })

const contextItems = [
  command('context-before', 'Context before'),
  {
    ...command('disabled-explained', 'Disabled explained'),
    disabled: true,
    disabledReason: 'Disabled ordinary explanation',
    tooltip: 'Enabled ordinary explanation',
  },
  {
    ...command('disabled-silent', 'Disabled silent'),
    disabled: true,
    disabledReason: 'Silent disabled reason',
  },
  {
    kind: 'icon-grid',
    id: 'root-icons',
    columns: 2,
    items: [
      { ...command('root-icon', 'Root icon'), icon: h('span', null, 'R') },
      {
        ...command('disabled-root-icon', 'Disabled root icon'),
        icon: h('span', null, 'D'),
        disabled: true,
        disabledReason: 'Root icon unavailable',
        disabledTooltip: 'Disabled root icon reason',
      },
    ],
  },
  separator('context-separator-one'),
  command('context-middle', 'Context middle'),
  separator('context-separator-two'),
  {
    kind: 'submenu',
    id: 'context-more',
    label: 'Context more',
    items: [
      {
        kind: 'icon-grid',
        id: 'nested-icons',
        columns: 1,
        items: [{ ...command('nested-icon', 'Nested icon'), icon: h('span', null, 'N') }],
      },
      command('context-nested-before', 'Context nested before'),
      separator('context-nested-separator-one'),
      command('context-nested-middle', 'Context nested middle'),
      separator('context-nested-separator-two'),
      command('context-nested-after', 'Context nested after'),
    ],
  },
]

const applicationSection = {
  id: 'file',
  label: 'Application',
  items: [
    { ...command('application-before', 'Application before'), command: 'save' },
    separator('application-separator-one'),
    { ...command('application-middle', 'Application middle'), command: 'save' },
    separator('application-separator-two'),
    {
      kind: 'submenu',
      id: 'application-more',
      label: 'Application more',
      items: [
        { ...command('application-nested-before', 'Application nested before'), command: 'save' },
        separator('application-nested-separator-one'),
        { ...command('application-nested-middle', 'Application nested middle'), command: 'save' },
        separator('application-nested-separator-two'),
        { ...command('application-nested-after', 'Application nested after'), command: 'save' },
      ],
    },
  ],
}

function Fixture() {
  return h(TooltipProvider, null,
    h(React.Fragment, null,
      h(ContextMenu, {
        close() {},
        request: {
          x: 24,
          y: 164.2,
          widthCssPx: 236,
          autoFocus: false,
          execute() {},
          restoreFocus() {},
          items: contextItems,
        },
      }),
      h(ApplicationMenuPopover, {
        section: applicationSection,
        left: 620.4,
        onClose() {},
        onExecute() {},
        onSwitch() {},
      }),
    ),
  )
}

const root = createRoot(document.querySelector('#fixture-root'))
window.mountMenuHairlineFixture = () => root.render(h(Fixture))
`

interface DecodedPng {
  width: number
  height: number
  channels: number
  pixels: Uint8Array
}

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const upDistance = Math.abs(estimate - up)
  const upperLeftDistance = Math.abs(estimate - upperLeft)
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left
  return upDistance <= upperLeftDistance ? up : upperLeft
}

function decodeScreenshotPng(buffer: Buffer): DecodedPng {
  const signature = buffer.subarray(0, 8).toString('hex')
  if (signature !== '89504e470d0a1a0a') throw new Error('Screenshot is not a PNG')

  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const compressed: Buffer[] = []
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8] ?? 0
      colorType = data[9] ?? 0
      interlace = data[12] ?? 0
    } else if (type === 'IDAT') {
      compressed.push(data)
    }
    offset += length + 12
    if (type === 'IEND') break
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (bitDepth !== 8 || channels === 0 || interlace !== 0) {
    throw new Error(`Unsupported screenshot PNG: depth=${bitDepth}, color=${colorType}, interlace=${interlace}`)
  }
  const scanlines = inflateSync(Buffer.concat(compressed))
  const stride = width * channels
  const pixels = new Uint8Array(stride * height)
  let sourceOffset = 0
  for (let y = 0; y < height; y += 1) {
    const filter = scanlines[sourceOffset++] ?? 0
    const rowOffset = y * stride
    const priorOffset = rowOffset - stride
    for (let x = 0; x < stride; x += 1) {
      const raw = scanlines[sourceOffset++] ?? 0
      const left = x >= channels ? pixels[rowOffset + x - channels] ?? 0 : 0
      const up = y > 0 ? pixels[priorOffset + x] ?? 0 : 0
      const upperLeft = y > 0 && x >= channels
        ? pixels[priorOffset + x - channels] ?? 0
        : 0
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
        : filter === 2 ? up
        : filter === 3 ? Math.floor((left + up) / 2)
        : filter === 4 ? paeth(left, up, upperLeft)
        : Number.NaN
      if (!Number.isFinite(predictor)) throw new Error(`Unsupported PNG filter ${filter}`)
      pixels[rowOffset + x] = (raw + predictor) & 0xff
    }
  }
  return { width, height, channels, pixels }
}

function isDividerPixel(image: DecodedPng, x: number, y: number): boolean {
  if (x < 0 || x >= image.width || y < 0 || y >= image.height) return false
  const offset = (y * image.width + x) * image.channels
  const red = image.pixels[offset] ?? 0
  const green = image.pixels[offset + 1] ?? 0
  const blue = image.pixels[offset + 2] ?? 0
  return red > 240 && blue > 240 && green < 245
}

function paintedPhysicalRows(
  image: DecodedPng,
  box: { x: number; y: number; width: number; height: number },
  dpr: number,
): number[] {
  const physicalXs = [0.25, 0.5, 0.75].map((fraction) => (
    Math.floor((box.x + box.width * fraction) * dpr)
  ))
  const from = Math.max(0, Math.floor((box.y - 1) * dpr))
  const to = Math.min(image.height - 1, Math.ceil((box.y + box.height + 1) * dpr))
  const rows: number[] = []
  for (let y = from; y <= to; y += 1) {
    const matches = physicalXs.filter((x) => isDividerPixel(image, x, y)).length
    if (matches >= 2) rows.push(y)
  }
  return rows
}

function sampledPhysicalRowColors(
  image: DecodedPng,
  box: { x: number; y: number; width: number; height: number },
  dpr: number,
): Array<{ y: number; rgb: [number, number, number] }> {
  const x = Math.floor((box.x + box.width / 2) * dpr)
  const from = Math.max(0, Math.floor((box.y - 1) * dpr))
  const to = Math.min(image.height - 1, Math.ceil((box.y + box.height + 1) * dpr))
  const values: Array<{ y: number; rgb: [number, number, number] }> = []
  for (let y = from; y <= to; y += 1) {
    const offset = (y * image.width + x) * image.channels
    values.push({
      y,
      rgb: [
        image.pixels[offset] ?? 0,
        image.pixels[offset + 1] ?? 0,
        image.pixels[offset + 2] ?? 0,
      ],
    })
  }
  return values
}

let vite: ViteDevServer
let fixtureUrl: string

test.beforeAll(async () => {
  vite = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'menu-hairline-playwright-fixture',
      resolveId(id) {
        return id === VIRTUAL_FIXTURE_ID ? RESOLVED_FIXTURE_ID : undefined
      },
      load(id) {
        return id === RESOLVED_FIXTURE_ID ? fixtureModule : undefined
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url?.split('?')[0] !== FIXTURE_PATH) {
            next()
            return
          }
          const html = await server.transformIndexHtml(FIXTURE_PATH, `<!doctype html>
            <html style="--menu-divider-color:#ff00ff">
              <head><meta charset="UTF-8"></head>
              <body style="margin:0;overflow:hidden;background:#fff">
                <main id="fixture-root"></main>
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

async function mountFixture(page: Page, openSubmenus = true) {
  await page.goto(fixtureUrl)
  await page.evaluate(() => {
    (window as typeof window & { mountMenuHairlineFixture(): void })
      .mountMenuHairlineFixture()
  })
  await expect(page.locator('.context-menu-list:not(.context-menu-submenu)')).toBeVisible()
  await expect(page.locator('.application-menu-popover:not(.application-menu-submenu)')).toBeVisible()
  if (openSubmenus) {
    await page.getByRole('menuitem', { name: 'Context more' }).hover()
    await page.getByRole('menuitem', { name: 'Application more' }).hover()
    await expect(page.locator('.context-menu-submenu')).toBeVisible()
    await expect(page.locator('.application-menu-submenu')).toBeVisible()
  }
}

test('real menu components paint every root and submenu separator on one physical row', async ({ page }) => {
  await mountFixture(page)
  const dpr = await page.evaluate(() => window.devicePixelRatio)
  const samples = await page.locator([
    '.context-menu-list:not(.context-menu-submenu) > .context-menu-separator',
    '.context-menu-submenu > .context-menu-separator',
    '.application-menu-popover:not(.application-menu-submenu) > .application-menu-separator',
    '.application-menu-submenu > .application-menu-separator',
  ].join(',')).evaluateAll((elements) => elements.map((element, index) => {
    const box = element.getBoundingClientRect()
    const stroke = element.querySelector<HTMLElement>('.menu-hairline-stroke')
    const strokeBox = stroke?.getBoundingClientRect()
    const wrapperStyle = getComputedStyle(element)
    const strokeStyle = stroke ? getComputedStyle(stroke) : null
    return {
      label: `${element.className}-${index}`,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      wrapperPaint: {
        background: wrapperStyle.backgroundColor,
        border: wrapperStyle.borderTopWidth,
        boxShadow: wrapperStyle.boxShadow,
      },
      stroke: strokeBox ? {
        top: strokeBox.top,
        height: strokeBox.height,
        background: strokeStyle!.backgroundColor,
        transform: strokeStyle!.transform,
      } : null,
    }
  }))
  expect(samples).toHaveLength(8)

  const image = decodeScreenshotPng(await page.screenshot())
  for (const sample of samples) {
    const rows = paintedPhysicalRows(image, sample.box, dpr)
    const colors = sampledPhysicalRowColors(image, sample.box, dpr)
    expect(
      rows,
      `${sample.label} at DPR ${dpr} painted rows ${rows.join(',')}; geometry=${JSON.stringify(sample)}; colors=${JSON.stringify(colors)}`,
    ).toHaveLength(1)
    const paintedColor = colors.find(({ y }) => y === rows[0])
    expect(
      paintedColor?.rgb[1],
      `${sample.label} at DPR ${dpr} painted an ineffective divider color; colors=${JSON.stringify(colors)}`,
    ).toBeLessThanOrEqual(127)
  }

  const strokeGeometry = samples.flatMap((sample) => sample.stroke ? [sample.stroke] : [])
  expect(strokeGeometry).toHaveLength(8)
  for (const geometry of strokeGeometry) {
    expect(geometry.height * dpr).toBeCloseTo(1, 4)
    expect(geometry.top * dpr).toBeCloseTo(Math.round(geometry.top * dpr), 4)
  }
})

test('real context-menu icon tooltips avoid menus and dismiss disabled reasons on press', async ({ page }) => {
  await mountFixture(page, false)

  const menuGeometry = async () => page.locator('.context-menu-list').evaluateAll((menus) => (
    menus.map((menu) => {
      const box = menu.getBoundingClientRect()
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }
    })
  ))
  const expectTooltipClearOfMenus = async () => {
    const tooltip = page.getByRole('tooltip')
    await expect(tooltip).toBeVisible()
    const state = await tooltip.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return {
        box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
        zIndex: Number.parseInt(getComputedStyle(element).zIndex, 10),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        menus: Array.from(document.querySelectorAll<HTMLElement>('.context-menu-list'))
          .filter((menu) => getComputedStyle(menu).visibility !== 'hidden')
          .map((menu) => {
            const menuBox = menu.getBoundingClientRect()
            return {
              left: menuBox.left,
              top: menuBox.top,
              right: menuBox.right,
              bottom: menuBox.bottom,
              zIndex: Number.parseInt(getComputedStyle(menu).zIndex, 10),
            }
          }),
      }
    })
    expect(state.box.left).toBeGreaterThanOrEqual(8)
    expect(state.box.top).toBeGreaterThanOrEqual(8)
    expect(state.box.right).toBeLessThanOrEqual(state.viewport.width - 8)
    expect(state.box.bottom).toBeLessThanOrEqual(state.viewport.height - 8)
    for (const menu of state.menus) {
      const intersects = state.box.left < menu.right
        && state.box.right > menu.left
        && state.box.top < menu.bottom
        && state.box.bottom > menu.top
      expect(intersects).toBe(false)
      expect(state.zIndex).toBeGreaterThan(menu.zIndex)
    }
  }

  const rootBefore = await menuGeometry()
  await page.getByRole('menuitem', { name: 'Root icon', exact: true }).hover()
  await page.waitForTimeout(410)
  await expectTooltipClearOfMenus()
  expect(await menuGeometry()).toEqual(rootBefore)

  await page.getByRole('menuitem', { name: 'Context more' }).hover()
  await expect(page.locator('.context-menu-submenu')).toBeVisible()
  const bothMenusBefore = await menuGeometry()
  await page.getByRole('menuitem', { name: 'Nested icon' }).hover()
  await page.waitForTimeout(410)
  await expectTooltipClearOfMenus()
  expect(await menuGeometry()).toEqual(bothMenusBefore)

  const disabled = page.getByRole('menuitem', { name: 'Disabled root icon' })
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await disabled.hover()
  await page.waitForTimeout(410)
  await expect(page.getByRole('tooltip')).toHaveText('Disabled root icon reason')
  await expect(disabled).toBeDisabled()

  const disabledBounds = await disabled.boundingBox()
  expect(disabledBounds).not.toBeNull()
  await page.mouse.move(
    disabledBounds!.x + 4,
    disabledBounds!.y + 4,
  )
  await expect(page.getByRole('tooltip')).toBeVisible()
  await page.mouse.down()
  await page.mouse.up()

  await expect(page.getByRole('tooltip')).toBeHidden()
  await expect(disabled).toBeDisabled()
  await expect(disabled).not.toBeFocused()
})

test('real disabled ordinary rows expose only explicit explanations and stay out of Tab order', async ({ page }) => {
  await mountFixture(page, false)

  const before = page.getByRole('menuitem', { name: 'Context before' })
  const explained = page.getByRole('menuitem', { name: 'Disabled explained' })
  const silent = page.getByRole('menuitem', { name: 'Disabled silent' })
  const nextEnabled = page.getByRole('menuitem', { name: 'Root icon', exact: true })

  await expect(explained).toBeDisabled()
  await expect(silent).toBeDisabled()
  expect(await explained.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('auto')
  expect(await silent.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none')

  await explained.hover()
  await page.waitForTimeout(410)
  await expect(page.getByRole('tooltip')).toHaveText('Disabled ordinary explanation')

  const explainedBounds = await explained.boundingBox()
  expect(explainedBounds).not.toBeNull()
  await page.mouse.move(explainedBounds!.x + 4, explainedBounds!.y + 4)
  await page.mouse.down()
  await page.mouse.up()
  await expect(page.getByRole('tooltip')).toBeHidden()
  await expect(explained).toBeDisabled()
  await expect(explained).not.toBeFocused()

  await before.focus()
  await page.keyboard.press('Tab')
  await expect(nextEnabled).toBeFocused()
})
