import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { expect, test, type Locator } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

let vite: ViteDevServer
let url: string
const fixtureEntry = path.resolve('tests/e2e/fixtures/ai-conversation-layout-fixture.tsx').replaceAll('\\', '/')
test.beforeAll(async () => {
  vite = await createServer({ configFile: path.resolve('vite.renderer.config.ts'), root: path.resolve('src/renderer'), logLevel: 'error',
    cacheDir: path.resolve('.native-cache/vite-ai-conversation-layout', String(process.pid)),
    optimizeDeps: { entries: [fixtureEntry] },
    server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'ai-conversation-layout-fixture', configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== '/__ai-layout') return next()
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end(await server.transformIndexHtml('/__ai-layout', `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*; img-src 'self' data:; object-src 'none'; base-uri 'none'"></head><body class="app-shell" style="--theme-color-rgb:128 0 128"><main id="fixture-root"></main><script type="module" src="/@fs/${fixtureEntry}"></script></body></html>`))
      })
    },
  }] })
  await vite.listen()
  url = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}/__ai-layout`
})
test.afterAll(async () => { await vite?.close() })
test.beforeEach(async ({ page }) => { await page.goto(url); await expect(page.getByRole('log')).toBeVisible() })

async function bounds(locator: Locator) { const value = await locator.boundingBox(); expect(value).not.toBeNull(); return value! }

test('left-aligns every composer menu label and keeps a neutral shared check at the trailing edge in both themes', async ({ page }, testInfo) => {
  for (const theme of ['minimal', 'dark']) {
    await page.goto(url + '?thinking&wide')
    await expect(page.getByRole('log')).toBeVisible()
    await page.addStyleTag({ path: 'src/renderer/app/main-window-theme.css' })
    await page.evaluate((value) => document.documentElement.dataset.arkdownTheme = value, theme)
    const triggers = [
      page.getByRole('button', { name: '写入策略：每次询问' }),
      page.getByRole('combobox', { name: 'AI 对话思考' }),
      page.getByRole('combobox', { name: 'AI 对话推理强度' }),
      page.getByRole('combobox', { name: 'AI 对话快速模型选择' }),
    ]
    for (const [index, trigger] of triggers.entries()) {
      await trigger.click()
      const menu = index === 0 ? page.locator('.ai-conversation-write-policy-menu') : page.locator('.ai-composer-menu')
      await expect(menu).toBeVisible()
      const rows = menu.locator('button')
      await expect(rows.first()).toHaveCSS('text-align', 'left')
      const metrics = await rows.evaluateAll((elements) => elements.map((row) => {
        const label = row.querySelector('.preferences-select-option-label, .ai-conversation-write-policy-label')
        const check = row.querySelector('.preferences-select-check, .ai-composer-menu-check')
        const rect = row.getBoundingClientRect()
        const labelRect = label?.getBoundingClientRect()
        const checkRect = check?.getBoundingClientRect()
        return { hasLabel: !!label, hasCheck: !!check, left: labelRect ? labelRect.left - rect.left : null,
          right: checkRect ? rect.right - checkRect.right : null, textAlign: getComputedStyle(row).textAlign,
          labelRight: labelRect?.right, checkLeft: checkRect?.left, checkColor: check ? getComputedStyle(check).color : null,
          iconWidth: check?.querySelector('svg')?.getAttribute('width'),
          checked: row.getAttribute('aria-checked') === 'true' || row.getAttribute('aria-selected') === 'true' }
      }))
      for (const row of metrics) {
        expect(row.hasLabel).toBe(true)
        expect(row.hasCheck).toBe(true)
        expect(row.textAlign, `${theme} menu ${index}: ${JSON.stringify(metrics)}`).toBe('left')
        expect(row.left).toBeCloseTo(10, 0)
        expect(row.right).toBeCloseTo(10, 0)
        expect(row.labelRight!).toBeLessThan(row.checkLeft!)
        expect(row.checkColor).toBe(theme === 'dark' ? 'rgb(181, 181, 181)' : 'rgb(102, 102, 102)')
        expect(row.iconWidth).toBe(row.checked ? '16' : undefined)
      }
      expect(metrics.filter((row) => row.checked)).toHaveLength(1)
      // Locator screenshots scroll the target; that intentionally dismisses selects.
      await page.screenshot({ clip: await bounds(menu), path: testInfo.outputPath(`composer-menu-${theme}-${index}.png`) })
      await page.keyboard.press('Escape')
      await expect(menu).not.toBeVisible()
    }
  }
})

test('uses 13 CSS px and adjacent composer controls with bounded accessible resizing', async ({ page }) => {
  await expect(page.getByRole('tab', { name: 'AI 对话' })).toHaveCSS('font-size', '14px')
  const composer = page.getByRole('textbox', { name: '发送消息给 AI' })
  await expect(composer).toHaveCSS('font-size', '13px')
  await expect(page.getByRole('article').last()).toHaveCSS('font-size', '13px')
  await expect(composer).toHaveCSS('resize', 'none')
  const send = page.getByRole('button', { name: '发送', exact: true })
  await expect(send).toHaveCSS('font-size', '13px')
  const policy = page.getByRole('button', { name: '写入策略：每次询问' })
  const inputBox = await bounds(composer), sendBox = await bounds(send), policyBox = await bounds(policy)
  expect(sendBox.y).toBeCloseTo(policyBox.y, 0)
  expect(sendBox.x + sendBox.width).toBeLessThanOrEqual(inputBox.x + inputBox.width + 1)
  expect(sendBox.width).toBe(30)
  expect(sendBox.y).toBeGreaterThan(inputBox.y + inputBox.height)
  const handle = page.getByRole('separator', { name: '调整 AI 输入框高度' })
  await handle.focus(); await page.keyboard.press('ArrowUp')
  expect((await bounds(composer)).height).toBeGreaterThan(inputBox.height)
  await page.keyboard.press('End')
  expect((await bounds(composer)).height).toBeLessThanOrEqual(240)
  const handleBox = await bounds(handle)
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
  await page.mouse.down(); await page.mouse.move(handleBox.x + 10, 810, { steps: 8 }); await page.mouse.up()
  expect((await bounds(composer)).height).toBeGreaterThanOrEqual(36)
  await composer.focus()
  await expect(composer).toHaveCSS('outline-style', 'none')
  await expect(composer).toHaveCSS('outline-offset', '0px')
})

test('uses the production RGB theme with contrasting send and stop icons in every interaction state', async ({ page }, testInfo) => {
  await page.goto(url + '?theme')
  const composer = page.getByRole('textbox', { name: '发送消息给 AI' })
  const measurements: Array<{ theme: string; label: string; state: string; background: number[]; contrast: number }> = []
  for (const [theme, channels] of [
    ['#c62828', [198, 40, 40]], ['#800080', [128, 0, 128]],
    ['#ffffff', [255, 255, 255]], ['#ffff00', [255, 255, 0]],
  ] as const) {
    await page.getByLabel('验收主题颜色').fill(theme)
    await composer.fill('Theme contrast check')
    for (const label of ['发送', '停止生成']) {
      const button = page.getByRole('button', { name: label, exact: true })
      await expect(button).toBeEnabled()
      for (const state of ['normal', 'hover', 'active'] as const) {
        if (state === 'normal') await page.mouse.move(0, 0)
        else if (state === 'hover') await button.hover()
        else await page.mouse.down()
        const colors = await button.evaluate((element) => {
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = 1
          const context = canvas.getContext('2d')!
          const rgb = (color: string) => {
            context.clearRect(0, 0, 1, 1)
            context.fillStyle = color
            context.fillRect(0, 0, 1, 1)
            return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
          }
          const background = rgb(getComputedStyle(element).backgroundColor)
          const foreground = rgb(getComputedStyle(element.querySelector('svg')!).color)
          const luminance = (color: number[]) => color.map((channel) => {
            const value = channel / 255
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
          }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0)
          const a = luminance(background), b = luminance(foreground)
          return { background, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
        })
        expect(colors.contrast, `${theme} ${label} ${state}`).toBeGreaterThanOrEqual(4.5)
        if (state === 'normal') colors.background.forEach((channel, index) => {
          expect(Math.abs(channel - channels[index]!), `${theme} ${label} ${state}`).toBeLessThanOrEqual(1)
        })
        else expect(Math.max(...colors.background) - Math.min(...colors.background)).toBeLessThanOrEqual(1)
        measurements.push({ theme, label, state, ...colors })
      }
      await page.mouse.move(0, 0)
      await page.mouse.up()
      await button.click()
    }
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible()
  }
  await testInfo.attach('primary-theme-contrast.json', {
    body: JSON.stringify({ browser: page.context().browser()?.version(), measurements }, null, 2),
    contentType: 'application/json',
  })
})

for (const clickTarget of ['below the final paragraph', 'inside the selected text'] as const) {
  test(`does not reopen the selection capsule after clicking ${clickTarget}`, async ({ page }) => {
    await page.goto(url + '?selection')
    const paragraph = page.locator('.ProseMirror p').last()
    await paragraph.click({ clickCount: 3, position: { x: 100, y: 10 } })
    await expect(page.getByRole('button', { name: '引用到 AI 对话', exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(false)
    const paragraphBox = await bounds(paragraph)
    const editorBox = await bounds(page.locator('.ProseMirror'))
    await page.mouse.click(
      clickTarget === 'below the final paragraph' ? editorBox.x + editorBox.width / 2 : paragraphBox.x + 100,
      clickTarget === 'below the final paragraph' ? paragraphBox.y + paragraphBox.height + 20 : paragraphBox.y + 10,
    )
    await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true)
    // Wait for the selection report's rendering opportunity: dismissal at pointerdown alone
    // must not pass while a stale report is still scheduled for the end of this click.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(page.getByRole('button', { name: '翻译选中的文本', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '引用到 AI 对话', exact: true })).toHaveCount(0)
  })
}

for (const reverse of [false, true]) {
  test(`preserves the ${reverse ? 'reverse' : 'forward'} drag selection when clicking translate`, async ({ page }) => {
    await page.goto(url + '?selection')
    await page.evaluate(() => {
      const readSettings = window.arkdown.getLargeModelSettings
      window.arkdown.getLargeModelSettings = async () => {
        const result = await readSettings()
        if (!result.ok) return result
        return { ...result, value: { ...result.value, selectionTranslation: {
          ...result.value.selectionTranslation, connectionId: result.value.connections[0]!.id,
        } } }
      }
      const readObservedSettings = window.arkdown.getModelSettingsSnapshot
      window.arkdown.getModelSettingsSnapshot = async () => {
        const result = await readObservedSettings()
        if (!result.ok) return result
        const settings = result.value.settings
        return { ...result, value: { ...result.value, settings: { ...settings, selectionTranslation: {
          ...settings.selectionTranslation, connectionId: settings.connections[0]!.id,
        } } } }
      }
      window.arkdown.startTranslation = async (input) => {
        document.body.dataset.translationRequest = JSON.stringify(input)
        return new Promise(() => {})
      }
    })
    const paragraph = await bounds(page.locator('.ProseMirror p').first())
    const left = paragraph.x + 5, right = paragraph.x + 130
    const y = paragraph.y + paragraph.height / 2
    await page.mouse.move(reverse ? right : left, y)
    await page.mouse.down()
    await page.mouse.move(reverse ? left : right, y, { steps: 8 })
    await page.mouse.up()
    await expect(page.getByRole('button', { name: '翻译选中的文本', exact: true })).toBeVisible()
    const selectedText = await page.evaluate(() => window.getSelection()!.toString())
    expect(selectedText.length).toBeGreaterThan(0)
    await page.getByRole('button', { name: '翻译选中的文本', exact: true }).click()
    await expect.poll(() => page.evaluate(() => {
      const request = document.body.dataset.translationRequest
      return request ? JSON.parse(request).content.plainText : null
    })).toBe(selectedText)
  })
}

test('selection quotes open the real AI composer in visual and source mode and survive settings', async ({ page }, testInfo) => {
  await page.goto(url + '?selection')
  await expect(page.getByRole('textbox', { name: '发送消息给 AI' })).toBeVisible()
  const quoteParagraph = page.locator('.ProseMirror p').first()
  await expect(quoteParagraph).toBeVisible()
  await quoteParagraph.click({ clickCount: 3 })
  await page.getByRole('button', { name: '引用到 AI 对话', exact: true }).click()
  const composer = page.getByRole('textbox', { name: '发送消息给 AI' })
  await expect(composer).toHaveValue('结合上下文分析文本片段')
  await expect(composer).toBeFocused()
  const chip = page.getByRole('button', { name: '预览引用：A.md · 片段 1', exact: true })
  const restingChipColor = await chip.evaluate((element) => getComputedStyle(element).backgroundColor)
  await chip.hover()
  expect(await chip.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(restingChipColor)
  await expect(page.getByRole('tooltip')).toContainText('选择这段原始文本')
  await page.getByRole('tooltip').hover()
  await expect(page.getByRole('tooltip')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await page.getByRole('button', { name: '设置往返', exact: true }).click()
  await page.getByRole('button', { name: '设置往返', exact: true }).click()
  await expect(composer).toHaveValue('结合上下文分析文本片段')
  await expect(chip).toBeVisible()
  await page.getByRole('button', { name: '切换源码', exact: true }).click()
  const line = page.locator('.cm-content .cm-line').filter({ hasText: '选择这段原始文本' })
  await expect(line).toBeVisible()
  await line.click({ clickCount: 3, position: { x: 25, y: 8 } })
  expect(await page.evaluate(() => window.getSelection()?.toString().trimEnd()))
    .toBe('选择这段原始文本加入 AI 对话。👨‍👩‍👧‍👦')
  await page.getByRole('button', { name: '引用到 AI 对话', exact: true }).click()
  await expect(page.getByRole('button', { name: '预览引用：A.md · 片段 2', exact: true })).toBeVisible()
  const longLine = page.locator('.cm-content .cm-line').filter({ hasText: '长引用文本' })
  await longLine.click({ clickCount: 3, position: { x: 25, y: 8 } })
  expect(await page.evaluate(() => window.getSelection()?.toString().trimEnd()))
    .toBe('长引用文本'.repeat(80) + '👨‍👩‍👧‍👦')
  await page.getByRole('button', { name: '引用到 AI 对话', exact: true }).click()
  const longChip = page.getByRole('button', { name: '预览引用：A.md · 片段 3', exact: true })
  await longChip.focus()
  await expect(page.getByRole('tooltip')).toBeVisible()
  const preview = await page.getByRole('tooltip').textContent()
  expect(preview!.split('\n')).toHaveLength(10)
  expect(preview).toMatch(/\.\.\.$/u)
  const visibleRows = await page.locator('.ai-quote-tooltip-content').evaluate((element) => {
    const style = getComputedStyle(element)
    const contentHeight = element.getBoundingClientRect().height - parseFloat(style.paddingTop)
      - parseFloat(style.paddingBottom) - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth)
    return Math.round(contentHeight / parseFloat(style.lineHeight))
  })
  expect(visibleRows).toBeLessThanOrEqual(10)
  await page.getByRole('tooltip').screenshot({ path: testInfo.outputPath('quote-tooltip.png') })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '切换来源文档', exact: true }).click()
  await expect(quoteParagraph).toBeVisible()
  await page.getByRole('button', { name: '切换源码', exact: true }).click()
  await line.click({ clickCount: 3, position: { x: 25, y: 8 } })
  await page.getByRole('button', { name: '引用到 AI 对话', exact: true }).click()
  await expect(page.getByRole('button', { name: '预览引用：B.md · 片段 4', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '收起展开', exact: true }).click()
  await page.getByRole('button', { name: '收起展开', exact: true }).click()
  await expect(composer).toHaveValue('结合上下文分析文本片段')
  await expect(page.getByTestId('editor-right-sidebar-motion-track')).toHaveAttribute('data-phase', 'open')
  for (const panelWidth of [530, 240]) {
    const resize = page.getByRole('separator', { name: '调整右侧栏宽度' })
    await resize.focus()
    await page.keyboard.press('Home')
    for (let width = 240; width < panelWidth; width += 10) await page.keyboard.press('ArrowLeft')
    await expect.poll(async () => Math.round((await bounds(page.getByTestId('editor-right-sidebar-motion-track'))).width)).toBe(panelWidth)
    const send = await bounds(page.getByRole('button', { name: '发送', exact: true }))
    const policy = await bounds(page.getByRole('button', { name: '写入策略：每次询问' }))
    const form = await bounds(page.locator('.ai-conversation-composer'))
    expect(send.x + send.width).toBeLessThanOrEqual(form.x + form.width)
    expect(send.width).toBe(30)
    if (panelWidth === 240) expect(send.y).toBeGreaterThan(policy.y + policy.height)
    else expect(send.y).toBeCloseTo(policy.y, 0)
    await page.getByRole('tabpanel').screenshot({ path: testInfo.outputPath(`quotes-${panelWidth}-light.png`) })
    if (panelWidth === 240) {
      const list = page.locator('.ai-quote-list')
      expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
      const lastRemove = page.getByRole('button', { name: '移除引用：B.md · 片段 4', exact: true })
      await lastRemove.scrollIntoViewIfNeeded()
      await expect(lastRemove).toBeVisible()
    }
    await page.getByRole('button', { name: '浅深主题', exact: true }).click()
    await page.getByRole('tabpanel').screenshot({ path: testInfo.outputPath(`quotes-${panelWidth}-dark.png`) })
    await page.getByRole('button', { name: '浅深主题', exact: true }).click()
  }
})

for (const viewportWidth of [1100, 320]) test(`bounds complex quote tooltip to ten rendered rows at ${viewportWidth}px viewport`, async ({ page }, testInfo) => {
  await page.goto(url + '?selection&complex')
  const paragraph = page.locator('.ProseMirror p').last()
  await expect(paragraph).toContainText('😀\u200d😀')
  await paragraph.click({ clickCount: 3 })
  await page.getByRole('button', { name: '引用到 AI 对话', exact: true }).click()
  await page.setViewportSize({ width: viewportWidth, height: 820 })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.getByRole('button', { name: '预览引用：A.md · 片段 1', exact: true }).focus()
  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  const layout = await tooltip.evaluate((element) => {
    const content = element.querySelector('.ai-quote-tooltip-content')!
    const style = getComputedStyle(content), rect = element.getBoundingClientRect()
    const contentHeight = content.getBoundingClientRect().height
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    return { rows: contentHeight / parseFloat(style.lineHeight), left: rect.left, right: rect.right,
      lineLengths: content.textContent!.split('\n').map((line) => [...segmenter.segment(line)].length) }
  })
  expect(layout.rows).toBeLessThanOrEqual(10)
  expect(layout.lineLengths.every((length) => length <= 30)).toBe(true)
  expect(layout.left).toBeGreaterThanOrEqual(12)
  expect(layout.right).toBeLessThanOrEqual(viewportWidth - 12)
  await expect(tooltip).toContainText('😀\u200d😀')
  await expect(tooltip).toContainText('👨‍👩‍👧‍👦')
  expect(await tooltip.textContent()).toMatch(/\.\.\.$/u)
  await tooltip.screenshot({ path: testInfo.outputPath(`complex-quote-${viewportWidth}.png`) })
})

for (const panelWidth of [240, 390, 530]) test(`aligns shared notices at ${panelWidth}px and preserves identical theme states and actions`, async ({ page }, testInfo) => {
  const resize = page.getByRole('separator', { name: '调整右侧栏宽度' })
  await resize.focus()
  await page.keyboard.press('Home')
  for (let width = 240; width < panelWidth; width += 10) await page.keyboard.press('ArrowLeft')
  await page.getByRole('button', { name: '未配置模型' }).click()
  const positions: number[][] = [], states: string[][] = []
  for (const tab of ['AI 对话', '翻译']) {
    await page.getByRole('tab', { name: tab, exact: true }).click()
    await resize.focus()
    await page.keyboard.press('Home')
    for (let width = 240; width < panelWidth; width += 10) await page.keyboard.press('ArrowLeft')
    const panel = await bounds(page.getByRole('tabpanel'))
    const notice = page.locator('.model-configuration-notice')
    const title = notice.getByRole('heading', { name: '尚未配置大模型', exact: true })
    const body = notice.getByText('请先配置大模型，再使用此功能。', { exact: true })
    const primary = notice.getByRole('button', { name: '前往配置', exact: true })
    const secondary = notice.getByRole('button', { name: '暂不', exact: true })
    const coordinates: number[] = []
    for (const [element, size] of [[title, '14px'], [body, '14px'], [primary, '13px'], [secondary, '12px']] as const) {
      await expect(element).toHaveCSS('font-size', size)
      const box = await bounds(element)
      coordinates.push(box.x - panel.x, box.y - panel.y)
    }
    positions.push(coordinates)
    console.log(JSON.stringify({ panelWidth, tab, panel, coordinates }))
    await page.getByRole('tabpanel').screenshot({ path: testInfo.outputPath(tab === '翻译' ? 'translation-notice.png' : 'ai-notice.png') })
    for (const button of [primary, secondary]) await expect(button).toHaveCSS('height', '32px')
    expect((await bounds(primary)).width).toBeGreaterThanOrEqual(117)
    await page.mouse.move(0, 0)
    const colors = [await primary.evaluate(element => getComputedStyle(element).backgroundColor)]
    await primary.hover(); colors.push(await primary.evaluate(element => getComputedStyle(element).backgroundColor))
    await page.mouse.down(); colors.push(await primary.evaluate(element => getComputedStyle(element).backgroundColor))
    await page.mouse.move(0, 0); await page.mouse.up()
    expect(new Set(colors).size).toBe(3)
    states.push(colors)
    await primary.click()
    await expect(page.getByRole('main', { name: '偏好设置' })).toBeVisible()
    await page.locator('.preferences-page-actions').getByRole('button', { name: '关闭', exact: true }).click()
  }
  positions[0].forEach((value, index) => expect(positions[1][index]).toBeCloseTo(value, 0))
  expect(states[0]).toEqual(states[1])
  await page.getByRole('button', { name: '暂不', exact: true }).click()
  await expect(page.getByRole('tabpanel')).toHaveCount(0)
  await page.getByRole('button', { name: '未配置模型' }).click()
  await page.getByRole('tab', { name: 'AI 对话' }).click()
  await page.getByRole('button', { name: '暂不', exact: true }).click()
  await expect(page.getByRole('tabpanel')).toHaveCount(0)
})

test('hides the unconfigured live translation guide while viewing saved history and restores its centering', async ({ page }) => {
  await page.getByRole('tab', { name: '翻译' }).click()
  const live = page.locator('.translation-sidebar-live-scroll')
  const guide = live.locator('.translation-sidebar-result')
  await expect(guide).toBeVisible()
  const retainedLive = await live.elementHandle()
  await page.getByRole('button', { name: '查看翻译记录' }).click()
  await expect(live).toHaveCSS('display', 'none')
  await expect(guide).toBeHidden()
  const history = page.locator('.translation-sidebar-history-scroll')
  await expect(history.getByText('Saved translation from the previous configured model.')).toBeInViewport()
  const historyBox = await bounds(history)
  const contentBox = await bounds(page.locator('.translation-sidebar-content'))
  const footerBox = await bounds(page.locator('.translation-sidebar-footer'))
  expect(historyBox.y).toBeCloseTo(contentBox.y, 0)
  expect(historyBox.y + historyBox.height).toBeCloseTo(footerBox.y, 0)
  expect(await live.evaluate((element, original) => element === original, retainedLive)).toBe(true)
  await page.getByRole('button', { name: '返回当前翻译' }).click()
  await expect(history).toHaveCount(0)
  await expect(guide).toBeVisible()
  const guideBox = await bounds(guide), liveBox = await bounds(live)
  expect(guideBox.y + guideBox.height / 2).toBeCloseTo(liveBox.y + liveBox.height / 2, 0)
  expect(guideBox.x + guideBox.width / 2).toBeCloseTo(liveBox.x + liveBox.width / 2, 0)
  expect(await live.evaluate((element, original) => element === original, retainedLive)).toBe(true)
})

test('restores a middle-message anchor through keyed document and checking remounts without jumping on new messages', async ({ page }) => {
  await page.evaluate(() => document.fonts.ready)
  const log = page.getByRole('log')
  const anchor = page.getByRole('article').filter({ hasText: 'Message 18:' })
  await anchor.scrollIntoViewIfNeeded()
  await log.evaluate((element) => { element.scrollTop += 28 })
  await expect.poll(() => anchor.evaluate((element) => element.getBoundingClientRect().y)).toBeLessThan(700)
  const before = (await bounds(anchor)).y
  await page.getByRole('button', { name: '切换文档并检查' }).click()
  await expect(page.getByText('正在检查 AI 对话配置…')).toBeVisible()
  await page.getByRole('button', { name: '配置检查完成' }).click()
  await expect.poll(async () => (await bounds(anchor)).y).toBeCloseTo(before, 0)
  await page.getByRole('button', { name: '新增消息' }).click()
  await expect.poll(async () => (await bounds(anchor)).y).toBeCloseTo(before, 0)
})

test('continues following the latest message after a bottom-position remount', async ({ page }) => {
  const log = page.getByRole('log')
  await log.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await page.getByRole('button', { name: '切换文档并检查' }).click()
  await page.getByRole('button', { name: '配置检查完成' }).click()
  await page.getByRole('button', { name: '新增消息' }).click()
  await expect(page.getByText('Latest message 0')).toBeInViewport()
  expect(await log.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(1)
})

test('selects a quick model while keeping the visible conversation and revoking read grants', async ({ page }) => {
  await expect(page.getByRole('article').last()).toBeInViewport()
  const picker = page.getByRole('combobox', { name: 'AI 对话快速模型选择' })
  const usage = page.getByLabel('上下文占用')
  expect((await bounds(picker)).x).toBeLessThan((await bounds(usage)).x)
  await picker.click(); await page.getByRole('option', { name: '备用模型', exact: true }).click()
  await expect(picker).toContainText('备用模型')
  await expect(page.getByRole('article')).toHaveCount(42)
  await expect(page.getByRole('button', { name: '让 AI 查看文档' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#read-authority')).toHaveText('{"currentDocument":false,"workspace":false}')
})

test('allows real text selection, context-menu copy, web and local-link clicks and copies', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const message = page.getByRole('article').last()
  const text = message.locator('p').first()
  await text.click({ clickCount: 3 })
  const selected = await page.evaluate(() => getSelection()?.toString())
  expect(selected).toContain('preserved conversation text')
  await text.click({ button: 'right' }); await page.getByRole('menuitem', { name: '复制', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n'))).toBe(selected)
  await page.evaluate(() => getSelection()?.removeAllRanges())
  for (const [name, result, label] of [['Website', 'web:https://example.com/guide', '复制链接'], ['Local note', 'local:C:\\notes\\example.md', '复制路径']]) {
    const link = message.getByRole('link', { name, exact: true })
    await link.click(); await expect(page.locator('#link-result')).toHaveText(result)
    await link.click({ button: 'right' }); await page.getByRole('menuitem', { name: label, exact: true }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(result.slice(result.indexOf(':') + 1))
  }
})

test('opens model cards by keyboard and returns through immediate preferences navigation', async ({ page }) => {
  await page.getByRole('button', { name: '偏好设置', exact: true }).click()
  await page.getByRole('link', { name: '管理大模型', exact: true }).click()
  await expect(page.getByRole('button', { name: '返回偏好设置' })).toHaveCSS('width', '32px')
  await expect(page.getByRole('button', { name: '添加大模型', exact: true })).toHaveCSS('min-width', '136.5px')
  const disclosure = page.getByRole('button', { name: 'DeepSeek 主模型详情' })
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  const caret = disclosure.locator('svg.large-model-card-caret')
  const backArrow = page.getByRole('button', { name: '返回偏好设置' }).locator('svg.app-icon')
  await expect(caret).toHaveCount(1)
  await expect(backArrow).toHaveCount(1)
  await page.mouse.move(0, 0)
  const backArrowStyle = await backArrow.evaluate((element) => {
    const style = getComputedStyle(element)
    return { color: style.color, opacity: style.opacity }
  })
  await expect(caret).toHaveCSS('color', backArrowStyle.color)
  await expect(caret).toHaveCSS('opacity', backArrowStyle.opacity)
  await disclosure.focus(); await page.keyboard.press('Enter')
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('group', { name: 'DeepSeek 主模型连接详情' })).toBeVisible()
  await page.keyboard.press('Space'); await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  await page.getByRole('button', { name: '添加大模型', exact: true }).click()
  const advanced = page.getByRole('group', { name: '高级模型参数' })
  expect((await bounds(advanced)).y).toBeLessThan((await bounds(page.getByRole('textbox', { name: '配置名称' }))).y)
  for (const label of ['上下文窗口', '最大输入', '最大输出']) {
    expect((await bounds(page.getByRole('spinbutton', { name: label, exact: true }))).width).toBeLessThanOrEqual(120)
  }
  await page.getByRole('button', { name: '取消', exact: true }).click()
  const back = page.locator('.preferences-page-actions').getByRole('button', { name: '返回', exact: true })
  const before = await bounds(back)
  await back.click()
  const close = page.locator('.preferences-page-actions').getByRole('button', { name: '关闭', exact: true })
  expect((await bounds(close)).x).toBeCloseTo(before.x, 0)
  await close.click(); await expect(page.getByRole('main', { name: '偏好设置' })).toHaveCount(0)
})

test('shows a pill with separate translation and AI targets and no composer focus ring', async ({ page }) => {
  const input = page.getByRole('textbox', { name: '发送消息给 AI' })
  await input.focus()
  await expect(input).toHaveCSS('outline-style', 'none')
  await page.goto(url + '?selection')
  const paragraph = page.locator('.ProseMirror p').first()
  await expect(paragraph).toBeVisible()
  const box = await bounds(paragraph)
  await page.mouse.move(box.x + 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 95, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
  const translate = page.getByRole('button', { name: '翻译选中的文本' })
  const ai = page.getByRole('button', { name: '引用到 AI 对话' })
  await expect(translate).toBeVisible()
  const left = await bounds(translate), right = await bounds(ai)
  expect(left.x + left.width).toBeLessThanOrEqual(right.x + 1)
  await expect(page.locator('.translation-popover--dual')).toHaveCSS('border-radius', '999px')
  await ai.click()
  const quote = page.getByRole('button', { name: /^预览引用：/ }).first()
  await quote.hover()
  const tip = page.getByRole('tooltip')
  await expect(tip).toContainText('引用内容：')
  expect((await bounds(tip)).width).toBeLessThan(260)
})


test('aligns AI composer capsules with neutral hover, keyboard thinking choices and disabled clear text', async ({ page }, testInfo) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto(url + '?thinking&wide')
    await page.evaluate((scheme) => {
      const dark = scheme === 'dark'
      const tokens = { '--text-primary': dark ? '#eeeeee' : '#171717', '--text-secondary': dark ? '#bbbbbb' : '#666666',
        '--surface-raised': dark ? '#292929' : '#ffffff', '--surface-background': dark ? '#202020' : '#ffffff',
        '--control-background': dark ? '#292929' : '#ffffff', '--border-subtle': dark ? '#505050' : '#dddddd' }
      Object.entries(tokens).forEach(([name, value]) => document.body.style.setProperty(name, value))
      document.body.style.background = dark ? '#202020' : '#ffffff'
    }, scheme)
    await page.getByRole('textbox', { name: '发送消息给 AI' }).fill('Capsule hover verification')
    const controls = [page.getByRole('button', { name: '写入策略：每次询问' }),
      page.getByRole('combobox', { name: 'AI 对话思考' }), page.getByRole('combobox', { name: 'AI 对话推理强度' }),
      page.getByRole('combobox', { name: 'AI 对话快速模型选择' }), page.getByRole('button', { name: '发送', exact: true })]
    const boxes = await Promise.all(controls.map(bounds))
    expect(boxes.map(({ height }) => height)).toEqual([30, 30, 30, 30, 30])
    expect(new Set(boxes.map(({ y, height }) => y + height / 2)).size).toBe(1)
    const hoverColors = []
    for (const control of controls) {
      await control.hover()
      const style = await control.evaluate((element) => {
        const computed = getComputedStyle(element)
        return { background: computed.backgroundColor, radius: Number.parseFloat(computed.borderRadius) }
      })
      expect(style.radius).toBeGreaterThanOrEqual(15)
      hoverColors.push(style.background)
    }
    expect(new Set(hoverColors).size).toBe(1)
    const thinking = controls[1]
    await thinking.focus(); await thinking.press('ArrowDown')
    await expect(page.getByRole('option', { name: '开', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
    await expect(thinking).toContainText('关')
    await expect(thinking).toBeFocused()
    await thinking.press('ArrowDown'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter')
    await page.getByRole('textbox', { name: '发送消息给 AI' }).click()
    await controls[3].hover()
    await page.locator('.ai-conversation-sidebar').screenshot({ path: testInfo.outputPath(`composer-${scheme}-wide.png`) })
    await page.getByRole('button', { name: '清空对话' }).click()
    const clear = page.getByRole('button', { name: '清空对话' })
    await expect(clear).toBeDisabled()
    expect(await clear.evaluate((element) => getComputedStyle(element).color)).not.toBe(
      await clear.evaluate((element) => getComputedStyle(element.parentElement!).color))
  }
})

test('keeps thinking controls separate at the 240 px sidebar minimum without model or input tips', async ({ page }, testInfo) => {
  await page.goto(url + '?thinking')
  const toggle = page.getByRole('combobox', { name: 'AI 对话思考' })
  await expect(toggle).toBeVisible()
  const model = page.getByRole('combobox', { name: 'AI 对话快速模型选择' })
  for (const control of [model, page.getByRole('textbox', { name: '发送消息给 AI' })]) {
    expect(await control.evaluate((element) => Boolean(element.closest('[data-tooltip], [title]')))).toBe(false)
  }
  const controls = [toggle, page.getByRole('combobox', { name: 'AI 对话推理强度' }), model,
    page.getByRole('button', { name: '发送', exact: true })]
  const boxes = await Promise.all(controls.map(bounds))
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j]
    expect(a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1).toBe(true)
  }
  await toggle.click()
  await page.getByRole('option', { name: '关', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'AI 对话推理强度' })).toHaveCount(0)
  await toggle.click()
  await page.getByRole('option', { name: '开', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'AI 对话推理强度' })).toBeVisible()
  await page.locator('.ai-conversation-sidebar').screenshot({ path: testInfo.outputPath('composer-narrow.png') })
  await page.getByRole('tab', { name: '翻译', exact: true }).click()
  const translationToggle = page.getByRole('switch', { name: '翻译思考' })
  await expect(translationToggle).toBeVisible()
  await translationToggle.click()
  await expect(page.getByText('Existing translation')).toBeVisible()
  const left = await bounds(translationToggle), history = await bounds(page.getByRole('button', { name: '查看翻译记录' }))
  expect(left.x + left.width <= history.x + 1 || left.y + left.height <= history.y + 1 || history.y + history.height <= left.y + 1).toBe(true)
})
