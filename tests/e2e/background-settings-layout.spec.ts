import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

let vite: ViteDevServer | undefined
test.beforeAll(async () => {
  vite = await createServer({ configFile: 'vite.renderer.config.ts', logLevel: 'error',
    server: { host: '127.0.0.1', port: 4174, strictPort: true } })
  await vite.listen()
})
test.afterAll(async () => { await vite?.close() })

test('uses the selected theme for sliders and primary actions while keeping secondary and close semantics', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 600, height: 1000 })
  await page.addInitScript((settings) => {
    Object.defineProperty(window, 'arkdown', { value: {
      getBackgroundPresentation: async () => ({ ok: true, value: { settings, imageUrl: null } }),
    } })
  }, DEFAULT_BACKGROUND_SETTINGS)
  for (const theme of ['minimal', 'dark']) {
    await page.goto(`/?surface=background-settings&target=main&theme=${theme}`)
    const apply = page.getByRole('button', { name: '应用', exact: true })
    for (const rgb of [[128, 0, 128], [24, 134, 75], [255, 255, 0]]) {
      await page.evaluate(channels => document.documentElement.style.setProperty('--theme-color-rgb', channels.join(' ')), rgb)
      await page.mouse.move(0, 0)
      await expect(apply).toHaveCSS('background-color', `rgb(${rgb.join(', ')})`)
      const foreground = await apply.evaluate(element => getComputedStyle(element).color)
      expect(foreground).toBe(rgb[0] === 255 ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)')
      const slider = page.getByRole('slider', { name: '图片不透明度', exact: true })
      const image = await slider.screenshot()
      const hasThemePixels = await page.evaluate(async ({ bytes, rgb }) => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }))
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const context = canvas.getContext('2d')!
        context.drawImage(bitmap, 0, 0)
        const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data
        bitmap.close()
        let count = 0
        for (let offset = 0; offset < pixels.length; offset += 4) {
          if (rgb.every((value, index) => pixels[offset + index] === value)) count++
        }
        return count > 20
      }, { bytes: [...image], rgb })
      expect(hasThemePixels).toBe(true)
      const cancel = page.getByRole('button', { name: '取消', exact: true })
      await expect(cancel).not.toHaveCSS('background-color', `rgb(${rgb.join(', ')})`)
      await cancel.hover()
      await expect(cancel).toHaveCSS('background-color', `rgba(${rgb.join(', ')}, 0.08)`)
      await apply.hover()
      await expect(apply).not.toHaveCSS('background-color', `rgb(${rgb.join(', ')})`)
    }
    const close = page.getByRole('button', { name: '关闭', exact: true })
    await close.hover()
    await expect(close).toHaveCSS('background-color', 'rgb(196, 43, 28)')
    await expect(close).toHaveCSS('color', 'rgb(255, 255, 255)')
    await page.mouse.move(0, 0)
    await expect(close).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await page.evaluate(() => document.documentElement.style.setProperty('--theme-color-rgb', '128 0 128'))
    await page.screenshot({ path: testInfo.outputPath(`background-themed-${theme}.png`) })
  }
})

test('keeps native select borders without an extra focus outline on click', async ({ page }) => {
  await page.addInitScript((settings) => {
    Object.defineProperty(window, 'arkdown', { value: {
      getBackgroundPresentation: async () => ({ ok: true, value: { settings, imageUrl: null } }),
    } })
  }, DEFAULT_BACKGROUND_SETTINGS)
  for (const theme of ['minimal', 'dark']) {
    await page.goto(`/?surface=background-settings&target=main&theme=${theme}`)
    for (const label of ['图片对齐方式', '遮罩类型']) {
      const select = page.getByRole('combobox', { name: label })
      const borderColor = await select.evaluate(element => getComputedStyle(element).borderTopColor)
      await select.click()
      await page.keyboard.press('Escape')
      await expect(select).toBeFocused()
      await expect(select).toHaveCSS('outline-style', 'none')
      await expect(select).toHaveCSS('box-shadow', 'none')
      await expect(select).toHaveCSS('border-top-style', 'solid')
      await expect(select).toHaveCSS('border-top-width', '1px')
      await expect(select).toHaveCSS('border-top-color', borderColor)
    }
  }
})

test('Esc dismisses a native select first, then cancels the background preview through the close path', async ({ page }) => {
  await page.addInitScript((settings) => {
    Object.defineProperty(window, 'arkdown', { value: {
      getBackgroundPresentation: async () => ({ ok: true, value: { settings, imageUrl: null } }),
      previewBackground: async () => { document.documentElement.dataset.previewed = 'true'; return { ok: true, value: null } },
      cancelBackgroundSettings: async () => {
        document.documentElement.dataset.cancelCount = String(Number(document.documentElement.dataset.cancelCount ?? 0) + 1)
        return { ok: true, value: null }
      },
    } })
  }, DEFAULT_BACKGROUND_SETTINGS)
  await page.goto('/?surface=background-settings&target=main')
  const opacity = page.getByRole('slider', { name: '图片不透明度', exact: true })
  await opacity.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('html')).toHaveAttribute('data-previewed', 'true')
  await page.getByRole('combobox', { name: '图片对齐方式' }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('html')).not.toHaveAttribute('data-cancel-count')
  await page.keyboard.press('Escape')
  await expect(page.locator('html')).toHaveAttribute('data-cancel-count', '1')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-cancel-count', '2')
})

test('uses Arkdown appearance instead of an unconditional OS dark media rule', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 600, height: 1000 })
  await page.addInitScript((settings) => {
    Object.defineProperty(window, 'arkdown', { value: {
      getBackgroundPresentation: async () => ({ ok: true, value: { settings, imageUrl: null } }),
    } })
  }, DEFAULT_BACKGROUND_SETTINGS)
  for (const scenario of [
    { system: 'dark', selected: 'minimal', background: 'rgb(255, 255, 255)', text: 'rgb(51, 51, 51)' },
    { system: 'light', selected: 'dark', background: 'rgb(24, 24, 24)', text: 'rgb(227, 227, 227)' },
    { system: 'dark', selected: 'system', background: 'rgb(24, 24, 24)', text: 'rgb(227, 227, 227)' },
    { system: 'light', selected: 'system', background: 'rgb(255, 255, 255)', text: 'rgb(51, 51, 51)' },
  ] as const) {
    await page.emulateMedia({ colorScheme: scenario.system })
    await page.goto(`/?surface=background-settings&target=main&theme=${scenario.selected}`)
    const panel = page.getByRole('main', { name: '背景设置' })
    await expect(panel).toHaveCSS('background-color', scenario.background)
    await expect(panel).toHaveCSS('color', scenario.text)
    for (const label of ['图片不透明度', '遮罩区域不透明度', '遮罩过渡速度', '遮罩强度', '图片对齐方式', '遮罩类型']) {
      await expect(panel.getByText(label, { exact: true })).toHaveCSS('color', scenario.text)
    }
    await expect(page.getByRole('button', { name: '取消', exact: true })).toHaveCSS('color', scenario.text)
    if (scenario.selected !== 'system') await panel.screenshot({ path: testInfo.outputPath(`background-${scenario.selected}.png`) })
  }
})

test('keeps the 60 CSS px header and footer visible with scrolling confined to small-screen content', async ({ page }) => {
  await page.addInitScript((settings) => {
    Object.defineProperty(window, 'arkdown', { value: {
      getBackgroundPresentation: async () => ({ ok: true, value: { settings, imageUrl: null } }),
    } })
  }, DEFAULT_BACKGROUND_SETTINGS)
  await page.goto('/?surface=background-settings&target=main')
  await expect(page.getByRole('main', { name: '背景设置' })).toBeVisible()
  for (const height of [1000, 560]) {
    await page.setViewportSize({ width: 600, height })
    const geometry = await page.locator('.background-settings-page').evaluate((root) => {
      const header = root.querySelector('header')!.getBoundingClientRect()
      const footer = root.querySelector('footer')!.getBoundingClientRect()
      const content = root.querySelector('.background-settings-page__content')!
      const preview = root.querySelector('.background-settings-page__preview')!
      return {
        headerHeight: header.height, footerBottom: footer.bottom,
        scrollHeight: content.scrollHeight, clientHeight: content.clientHeight,
        rootBottom: root.getBoundingClientRect().bottom,
        gradient: getComputedStyle(preview).backgroundImage,
      }
    })
    expect(geometry.headerHeight).toBe(60)
    expect(geometry.footerBottom).toBeLessThanOrEqual(height)
    expect(geometry.rootBottom).toBe(height)
    expect(geometry.gradient).toBe('none')
    if (height === 1000) expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight)
    else expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight)
    await expect(page.getByRole('button', { name: '应用', exact: true })).toBeInViewport()
    await expect(page.getByRole('button', { name: '取消', exact: true })).toBeInViewport()
  }
})
