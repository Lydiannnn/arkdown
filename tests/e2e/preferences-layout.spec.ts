import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import { DEFAULT_ARKNOTE_PREFERENCES, type ArknotePreferences } from '../../src/shared/arknote-preferences'
import { DEFAULT_EDITOR_APPEARANCE, type EditorAppearancePreferences } from '../../src/shared/editor-appearance-preferences'
import { DEFAULT_LARGE_MODEL_SETTINGS, type LargeModelSettings } from '../../src/shared/large-model-settings'
import type { BrowserSearchPreferences } from '../../src/shared/search-preferences'
import { DEFAULT_LAYOUT_PREFERENCES } from '../../src/shared/layout-preferences'
import type { PreferenceGroup, PreferencePatchInput, PublicPreferenceSnapshot } from '../../src/shared/preference-observation'
import type { ObservedShellIntegrationUpdate } from '../../src/shared/shell-integration-preferences'
import type { ObservedOcrPreference, ScreenshotOcrModelState } from '../../src/shared/screenshot-ocr-models'
import { modelObservation } from '../helpers/model-observation'

let vite: ViteDevServer | undefined

function rgbChannels(value: string): [number, number, number] {
  const channels = value.match(/[\d.]+/gu)?.slice(0, 3).map(Number)
  if (!channels || channels.length !== 3) throw new Error(`Unsupported color: ${value}`)
  return (value.startsWith('color(srgb')
    ? channels.map((channel) => channel * 255)
    : channels) as [number, number, number]
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (value: string) => {
    const channels = rgbChannels(value).map((channel) => {
      const normalized = channel / 255
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  }
  const lighter = Math.max(luminance(foreground), luminance(background))
  const darker = Math.min(luminance(foreground), luminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

test.beforeAll(async () => {
  vite = await createServer({
    configFile: 'vite.renderer.config.ts',
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 4174, strictPort: true },
  })
  await vite.listen()
})

test.afterAll(async () => {
  await vite?.close()
})

async function openCompiledPreferences(page: Page, preferences?: ArknotePreferences) {
  await page.addInitScript((preferences) => {
    Object.defineProperty(window, 'arkdown', {
      configurable: true,
      value: {
        getArknotePreferences: async () => preferences ? ({ ok: true, value: preferences }) : ({
          error: { message: 'Layout fixture does not load persisted settings.' },
          ok: false,
        }),
      },
    })
  }, preferences)
  await page.goto('/?surface=arknote-settings')
  await expect(page.getByRole('navigation', { name: 'Arknote 设置目录' })).toBeVisible()
  expect((await page.locator('.preferences-page-content').boundingBox())!.height).toBeGreaterThan(0)
}

async function openCompiledArkdownPreferences(page: Page, models: LargeModelSettings = DEFAULT_LARGE_MODEL_SETTINGS) {
  await page.addInitScript((fixture) => {
    const screenshotStateEvent = 'arkdown-test-ocr-model-state'
    const menuCommandEvent = 'arkdown-test-menu-command'
    let menuCommandListeners = 0
    let downloadCalls = 0
    let resolveDownload: ((result: unknown) => void) | undefined
    let searchPreferences: BrowserSearchPreferences = { provider: 'bing', customTemplate: '' }
    let appearanceSnapshot = { appearance: fixture.appearance, revision: 0 }
    let layoutPreferences = fixture.layout
    let preferenceRevision = 0
    const preferenceFields: Record<string, Record<string, number>> = { search: {}, appearance: {}, layout: {} }
    const preferenceSnapshot = (group: PreferenceGroup): PublicPreferenceSnapshot => {
      if (group !== 'search' && group !== 'appearance' && group !== 'layout') throw new Error(`Unsupported layout preference group: ${group}`)
      return structuredClone({ group, values: group === 'search' ? searchPreferences
        : group === 'appearance' ? appearanceSnapshot.appearance : layoutPreferences,
      observation: { version: 1, revision: preferenceRevision, minimumBaseRevision: 0, fields: preferenceFields[group] } }) as PublicPreferenceSnapshot
    }
    let arknotePreferences = fixture.arknote
    let screenshotState: ScreenshotOcrModelState = fixture.screenshot
    let ocrObservation: ObservedOcrPreference = { revision: 0, preferredTier: screenshotState.activeTier, tierRevision: 0 }
    const acceptsOcrObservation = (observed: ObservedOcrPreference) => observed
      && observed.tierRevision === ocrObservation.tierRevision && observed.preferredTier === ocrObservation.preferredTier
    let shellPreferences = { documentOpenMenu: false, markdownShellNew: false }
    let shellRevision = 0
    const shellSnapshot = () => structuredClone({ values: shellPreferences, unavailable: [],
      observation: { version: 1, revision: shellRevision, minimumBaseRevision: 0,
        fields: { documentOpenMenu: shellRevision, markdownShellNew: shellRevision } } })
    let defaultApplications = { markdown: false, text: false }
    let holdDefaultApplications = false
    let resolveDefaultApplications: (() => void) | undefined
    let conversionState = {
      status: 'absent', source: 'https', installedVersion: null, availableVersion: '1.0.0',
      progress: null, errorCode: null, busy: false, revision: 0,
    }
    Object.defineProperty(window, 'arkdown', {
      configurable: true,
      value: {
        openBackgroundSettings: async () => ({ ok: false, error: { message: '背景窗口无法打开' } }),
        getShellIntegrationPreferences: async () => ({ ok: true, value: shellSnapshot() }),
        getDefaultApplicationsStatus: async () => ({ ok: true, value: defaultApplications }),
        getDocumentConversionComponentState: async () => ({ ok: true, value: conversionState }),
        onDocumentConversionComponentState: (listener: (state: unknown) => void) => {
          const relay = (event: Event) => listener((event as CustomEvent).detail)
          window.addEventListener('arkdown-test-conversion-state', relay)
          return () => window.removeEventListener('arkdown-test-conversion-state', relay)
        },
        openDefaultApplicationsSettings: async () => {
          if (holdDefaultApplications) await new Promise<void>((resolve) => { resolveDefaultApplications = resolve })
          return { ok: true, value: null }
        },
        setDefaultApplicationsEnabled: async (_enabled: boolean) => {
          if (holdDefaultApplications) await new Promise<void>((resolve) => { resolveDefaultApplications = resolve })
          return { ok: true, value: { ...defaultApplications } }
        },
        updateShellIntegrationPreference: async (update: ObservedShellIntegrationUpdate) => {
          if (!update.observed || update.observed.values[update.feature] !== shellPreferences[update.feature]) {
            return { ok: false, error: { code: 'OPERATION_FAILED', message: 'Synthetic shell observation is stale' } }
          }
          shellPreferences = { ...shellPreferences, [update.feature]: update.enabled }
          shellRevision += 1
          return { ok: true, value: shellSnapshot() }
        },
        restoreWorkspace: async () => ({ ok: true, value: null }),
        getPreferenceSnapshot: async (group: PreferenceGroup) => ({ ok: true, value: preferenceSnapshot(group) }),
        patchPreferences: async ({ observed, changes }: PreferencePatchInput) => {
          const group = observed.group
          if (group === 'search') searchPreferences = { ...searchPreferences, ...changes } as BrowserSearchPreferences
          else if (group === 'appearance') appearanceSnapshot = {
            appearance: { ...appearanceSnapshot.appearance, ...changes } as EditorAppearancePreferences,
            revision: appearanceSnapshot.revision + 1,
          }
          else if (group === 'layout') layoutPreferences = { ...layoutPreferences, ...changes } as typeof layoutPreferences
          else throw new Error(`Unsupported layout preference patch: ${group}`)
          preferenceRevision += 1
          for (const field of Object.keys(changes)) preferenceFields[group]![field] = preferenceRevision
          return { ok: true, value: { status: 'committed', snapshot: preferenceSnapshot(group) } }
        },
        getKeyboardShortcuts: async () => ({ ok: true, value: {
          bindings: {}, revision: 0, observation: { version: 1, minimumBaseRevision: 0, fields: {} },
        } }),
        getSearchPreferences: async () => ({ ok: true, value: searchPreferences }),
        setSearchPreferences: async (value: BrowserSearchPreferences) => {
          searchPreferences = value
          return { ok: true, value: searchPreferences }
        },
        getEditorAppearancePreferences: async () => ({ ok: true, value: appearanceSnapshot }),
        setEditorAppearancePreferences: async (value: EditorAppearancePreferences) => {
          appearanceSnapshot = { appearance: value, revision: appearanceSnapshot.revision + 1 }
          return { ok: true, value: appearanceSnapshot }
        },
        compareAndSetEditorAppearancePreferences: async (
          expectedRevision: number,
          expected: EditorAppearancePreferences,
          replacement: EditorAppearancePreferences,
        ) => {
          if (
            appearanceSnapshot.revision === expectedRevision
            && Object.entries(expected).every(([key, value]) => (
              appearanceSnapshot.appearance[key as keyof EditorAppearancePreferences] === value
            ))
          ) {
            appearanceSnapshot = {
              appearance: replacement,
              revision: appearanceSnapshot.revision + 1,
            }
          }
          return { ok: true, value: appearanceSnapshot }
        },
        getSystemFonts: async () => ({ ok: true, value: ['Arial', 'Microsoft YaHei'] }),
        getLargeModelSettings: async () => ({ ok: true, value: fixture.largeModels }),
        getModelSettingsSnapshot: async () => ({ ok: true, value: structuredClone(fixture.modelSnapshot) }),
        getArknotePreferences: async () => ({ ok: true, value: arknotePreferences }),
        setArknotePreferences: async (value: ArknotePreferences) => {
          arknotePreferences = { ...arknotePreferences, ...value }
          return { ok: true, value: arknotePreferences }
        },
        getScreenshotOcrModelState: async () => ({ ok: true, value: structuredClone({ state: screenshotState, observed: ocrObservation }) }),
        downloadScreenshotOcrMedium: async (observed: ObservedOcrPreference) => {
          if (!acceptsOcrObservation(observed)) return { ok: true, value: { status: 'conflict' } }
          downloadCalls += 1
          return new Promise((resolve) => { resolveDownload = resolve })
        },
        cancelScreenshotOcrMediumDownload: async () => ({ ok: true, value: screenshotState }),
        removeScreenshotOcrMedium: async (observed: ObservedOcrPreference) => {
          if (!acceptsOcrObservation(observed)) return { ok: true, value: { status: 'conflict' } }
          screenshotState = { ...screenshotState, activeTier: 'small', mediumVersion: null, status: 'medium-absent', progress: null }
          ocrObservation = { revision: ocrObservation.revision + 1, preferredTier: 'small', tierRevision: ocrObservation.revision + 1 }
          return { ok: true, value: screenshotState }
        },
        onScreenshotOcrModelState: (listener: (state: unknown) => void) => {
          const relay = (event: Event) => listener((event as CustomEvent).detail)
          window.addEventListener(screenshotStateEvent, relay)
          return () => window.removeEventListener(screenshotStateEvent, relay)
        },
        onMenuCommand: (listener: (command: string) => void) => {
          const relay = (event: Event) => listener((event as CustomEvent).detail)
          menuCommandListeners += 1
          window.addEventListener(menuCommandEvent, relay)
          return () => {
            menuCommandListeners -= 1
            window.removeEventListener(menuCommandEvent, relay)
          }
        },
        onApplicationMenuChanged: () => () => undefined,
        onWindowStateChanged: () => () => undefined,
        onPrepareClose: () => () => undefined,
        onEditorAppearancePreferencesChanged: () => () => undefined,
        onAiConversationEvent: () => () => undefined,
        onTranslationEvent: () => () => undefined,
        onRecoverDraft: () => () => undefined,
        onOpenIntent: () => () => undefined,
        onImportDocxIntent: () => () => undefined,
        updateApplicationMenuWindowState: async () => ({ ok: true, value: undefined }),
        getWindowState: async () => ({ ok: true, value: { maximized: false, fullscreen: false, revision: 0 } }),
        recordRecentDocument: async () => ({ ok: true, value: [] }),
      },
    })
    Object.defineProperty(window, '__arkdownTestOcr', {
      configurable: true,
      value: {
        defaultApplications: (value: typeof defaultApplications) => {
          defaultApplications = value
          window.dispatchEvent(new Event('focus'))
        },
        holdDefaultApplications: () => { holdDefaultApplications = true },
        finishDefaultApplications: () => { holdDefaultApplications = false; resolveDefaultApplications?.() },
        conversion: (value: Partial<typeof conversionState>) => {
          conversionState = { ...conversionState, ...value, revision: conversionState.revision + 1 }
          window.dispatchEvent(new CustomEvent('arkdown-test-conversion-state', { detail: conversionState }))
        },
        emit: (state: ScreenshotOcrModelState) => {
          screenshotState = state
          window.dispatchEvent(new CustomEvent(screenshotStateEvent, { detail: state }))
        },
        finishDownload: (state: ScreenshotOcrModelState) => {
          screenshotState = state
          ocrObservation = { revision: ocrObservation.revision + 1, preferredTier: state.activeTier, tierRevision: ocrObservation.revision + 1 }
          resolveDownload?.({ ok: true, value: state })
        },
        openPreferences: () => window.dispatchEvent(new CustomEvent(menuCommandEvent, { detail: 'preferences' })),
        menuReady: () => menuCommandListeners > 0,
        downloadCalls: () => downloadCalls,
      },
    })
  }, {
    appearance: DEFAULT_EDITOR_APPEARANCE,
    layout: DEFAULT_LAYOUT_PREFERENCES,
    arknote: DEFAULT_ARKNOTE_PREFERENCES,
    largeModels: models,
    modelSnapshot: modelObservation(models),
    screenshot: {
      activeTier: 'medium',
      bundledVersion: '1.0.0',
      mediumVersion: '1.0.0',
      availableMediumVersion: '1.1.0',
      status: 'medium-update-available',
      progress: null,
      errorCode: null,
    } as ScreenshotOcrModelState,
  })
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as { __arkdownTestOcr: { menuReady(): boolean } }).__arkdownTestOcr.menuReady()
  ))).toBe(true)
  await page.evaluate(() => {
    ;(window as unknown as { __arkdownTestOcr: { openPreferences(): void } })
      .__arkdownTestOcr.openPreferences()
  })
  await expect(page.getByRole('main', { name: '偏好设置' })).toBeVisible()
}

async function geometry(page: Page) {
  return page.locator('.preferences-page-layout').evaluate((layout) => {
    const bounds = (selector: string) => {
      const rect = layout.querySelector(selector)!.getBoundingClientRect()
      return { x: rect.x, left: rect.left, right: rect.right, width: rect.width }
    }
    const root = document.documentElement
    return {
      content: bounds('.preferences-settings'),
      offset: getComputedStyle(layout).getPropertyValue('--preferences-toc-offset').trim(),
      toc: bounds('.preferences-toc'),
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
    }
  })
}

test('context menu choices remain readable at wide and narrow widths', async ({ page }, testInfo) => {
  await openCompiledArkdownPreferences(page)
  const section = page.getByRole('region', { name: '右键菜单', exact: true })
  await expect(section.getByRole('checkbox')).toHaveCount(4)
  await expect(section.getByRole('heading', { name: 'md/txt默认程序', level: 3 })).toBeVisible()
  const open = section.getByRole('checkbox', { name: 'md/txt文档上右键增加“使用Arkdown打开”' })
  await open.check()
  await expect(open).toBeChecked()
  for (const width of [1280, 480]) {
    await page.setViewportSize({ width, height: 720 })
    await section.scrollIntoViewIfNeeded()
    const metrics = await section.evaluate((element) => ({
      overflow: element.scrollWidth - element.clientWidth,
      choices: [...element.querySelectorAll('.preferences-shell-menu-copy')].map((copy) => {
        const range = document.createRange()
        range.selectNodeContents(copy)
        return {
          width: copy.getBoundingClientRect().width,
          lines: [...range.getClientRects()].map((rect) => ({ width: rect.width, height: rect.height })),
        }
      }),
    }))
    expect(metrics.overflow).toBe(0)
    expect(metrics.choices).toHaveLength(4)
    expect(metrics.choices.every((choice) => choice.width > 0 && choice.lines.length > 0
      && choice.lines.every((line) => line.width > 0 && line.width <= choice.width + 1 && line.height > 0))).toBe(true)
    if (width === 1280) expect(metrics.choices.every((choice) => choice.lines.length === 1)).toBe(true)
    await section.screenshot({ path: testInfo.outputPath(`context-menu-${width}.png`) })
  }
})

test('keeps the wide settings directory within its viewport and scrolls it independently', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 480 })
  await openCompiledArkdownPreferences(page)
  const toc = page.locator('.preferences-toc')
  const content = page.locator('.preferences-page-content')
  const bounds = await toc.boundingBox()
  const viewport = await content.boundingBox()
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport!.y + viewport!.height + 1)
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + 90)
  await page.mouse.wheel(0, 2000)
  await expect.poll(() => toc.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  expect(await content.evaluate((element) => element.scrollTop)).toBe(0)
  const lastLink = toc.getByRole('link').last()
  await expect(lastLink).toBeInViewport()
  await lastLink.click()
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect(lastLink).toHaveAttribute('aria-current', 'location')
  await expect(lastLink).toBeInViewport()
  const target = page.locator((await lastLink.getAttribute('href'))!)
  await expect(target).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('settings-directory-wide.png') })
  await page.setViewportSize({ width: 760, height: 480 })
  await expect(toc).toBeHidden()
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
  }))
  expect(widths.scroll).toBeLessThanOrEqual(widths.client)
})

for (const entry of ['standalone', 'embedded'] as const) {
  test(`sticky defaults use material radios and retain color on ${entry}`, async ({ page }, testInfo) => {
    if (entry === 'standalone') await openCompiledPreferences(page, DEFAULT_ARKNOTE_PREFERENCES)
    else await openCompiledArkdownPreferences(page)
    const section = page.locator('.sticky-note-preferences-section')
    await section.scrollIntoViewIfNeeded()
    await expect(section.getByRole('radio', { name: 'Mica', exact: true })).toBeChecked()
    await expect(section.getByLabel('自定义颜色')).toBeDisabled()
    await expect(section.getByRole('tablist')).toHaveCount(0)
    await expect(page.locator('a[href="#preferences-arknote-textures-heading"]')).toHaveCount(0)
    await expect(page.locator('a[href="#preferences-arknote-materials-heading"]')).toHaveText('默认材质')
    await section.getByRole('radio', { name: '颜色', exact: true }).check()
    await section.getByLabel('自定义颜色').fill('#123456')
    await section.getByRole('radio', { name: 'Acrylic', exact: true }).check()
    await expect(section.getByLabel('自定义颜色')).toBeDisabled()
    await expect(section.getByLabel('自定义颜色')).toHaveValue('#123456')
    await section.getByRole('radio', { name: '颜色', exact: true }).check()
    await expect(section.getByLabel('自定义颜色')).toHaveValue('#123456')
    const labels = await section.locator('.sticky-note-material-options label').evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect()
      const radio = element.querySelector('input')!.getBoundingClientRect()
      const text = element.querySelector('span')!.getBoundingClientRect()
      return { height: box.height, fontSize: getComputedStyle(element).fontSize, radioWidth: radio.width, radioHeight: radio.height, aligned: Math.abs((radio.top + radio.bottom) / 2 - (text.top + text.bottom) / 2) < 1 }
    }))
    expect(labels.every(label => label.height >= 32 && label.fontSize === '13px'), JSON.stringify(labels)).toBe(true)
    expect(labels.every(label => label.height === 32 && label.radioWidth === 14 && label.radioHeight === 14 && label.aligned)).toBe(true)
    await section.screenshot({ path: testInfo.outputPath(`sticky-defaults-${entry}.png`) })
    await section.getByRole('button', { name: '恢复便签默认样式' }).click()
    await expect(section.getByRole('radio', { name: 'Mica', exact: true })).toBeChecked()
    await expect(section.getByLabel('自定义颜色')).toHaveValue('#f9e78b')
    await expect(section.getByLabel('自定义颜色')).toBeDisabled()
  })
}

test('sticky material cards and archive previews consume white Mica preview without changing fallback', async ({ page }, testInfo) => {
  await openCompiledPreferences(page)
  await page.evaluate(async (url) => {
    const fixture = await import(/* @vite-ignore */ url)
    fixture.mountPreviewFixture()
  }, '/@fs/' + path.resolve('tests/e2e/fixtures/sticky-note-preview-fixture.tsx').replaceAll('\\', '/'))
  const host = page.locator('#sticky-preview-fixture')
  for (const selector of ['.sticky-note-card', '.archived-sticky-note-preview-surface']) {
    const mica = host.locator(`${selector}[data-material-preset="mica-light"]`)
    await expect(mica).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    expect(await mica.evaluate(element => getComputedStyle(element).getPropertyValue('--sticky-note-background-color').trim())).toBe('#F3F3F3')
    await expect(host.locator(`${selector}[data-material-preset="flowing-glass"]`)).toHaveCSS('background-color', 'rgb(233, 238, 242)')
  }
  await expect(host.locator('.archived-sticky-note-preview-surface').first()).toContainText('Readable content')
  await host.screenshot({ path: testInfo.outputPath('sticky-material-previews.png') })
})

test('moves only the desktop directory tree left by 30 CSS px', async ({ page }) => {
  await openCompiledPreferences(page)
  await expect.poll(async () => (await geometry(page)).offset).toBe('30px')

  const layout = page.locator('.preferences-page-layout')
  const appliedOffset = await layout.evaluate((element) => (
    (element as HTMLElement).style.getPropertyValue('--preferences-toc-offset')
  ))
  await layout.evaluate((element) => {
    ;(element as HTMLElement).style.setProperty('--preferences-toc-offset', '0px')
  })
  const before = await geometry(page)
  await layout.evaluate((element, value) => {
    ;(element as HTMLElement).style.setProperty('--preferences-toc-offset', value)
  }, appliedOffset)
  const after = await geometry(page)
  const gapBefore = before.content.x - before.toc.right

  expect(after.content.x).toBeCloseTo(before.content.x, 1)
  expect(after.toc.x).toBeCloseTo(before.toc.x - 30, 1)
  expect(after.content.x - after.toc.right).toBeCloseTo(gapBefore + 30, 1)
  expect(after.scrollWidth).toBeLessThanOrEqual(after.clientWidth)
})

test('hides the directory tree in the single-column layout', async ({ page }) => {
  await openCompiledPreferences(page)
  for (const width of [900, 760, 480]) {
    await page.setViewportSize({ width, height: 720 })
    await expect(page.locator('.preferences-toc')).toBeHidden()
    const bounds = await geometry(page)
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth)
  }
})

test('applies search changes immediately with a Close footer and keeps both manager returns inside preferences', async ({ page }) => {
  await openCompiledArkdownPreferences(page)
  const preferences = page.getByRole('main', { name: '偏好设置' })
  const assertSummaryCloseFooterFits = async () => {
    await expect(preferences.getByRole('heading', { name: '偏好设置', exact: true })).toBeVisible()
    const close = preferences.locator('.preferences-page-actions').getByRole('button', { name: '关闭', exact: true })
    await expect(close).toBeVisible()
    await expect(close).toBeInViewport()
    await expect(preferences.getByRole('button', { name: /^(保存|取消|确认)$/u })).toHaveCount(0)
    const bounds = await preferences.evaluate((element) => {
      const page = element.getBoundingClientRect()
      const content = element.querySelector('.preferences-page-content')!.getBoundingClientRect()
      const footer = element.querySelector('.preferences-page-actions')!.getBoundingClientRect()
      return {
        pageBottom: page.bottom,
        contentBottom: content.bottom,
        contentHeight: content.height,
        footerTop: footer.top,
        footerBottom: footer.bottom,
        footerLeft: footer.left,
        footerRight: footer.right,
        pageLeft: page.left,
        pageRight: page.right,
      }
    })
    expect(bounds.contentHeight).toBeGreaterThan(0)
    expect(bounds.contentBottom).toBeLessThanOrEqual(bounds.footerTop)
    expect(Math.abs(bounds.contentBottom - bounds.footerTop)).toBeLessThanOrEqual(1)
    expect(Math.abs(bounds.pageBottom - bounds.footerBottom)).toBeLessThanOrEqual(1)
    expect(bounds.footerLeft).toBeGreaterThanOrEqual(bounds.pageLeft)
    expect(bounds.footerRight).toBeLessThanOrEqual(bounds.pageRight)
  }
  await assertSummaryCloseFooterFits()
  await page.setViewportSize({ width: 760, height: 720 })
  await assertSummaryCloseFooterFits()
  await page.setViewportSize({ width: 1280, height: 720 })

  const provider = preferences.getByRole('combobox', { name: '搜索提供商' })
  await provider.click()
  await page.getByRole('option', { name: 'Google', exact: true }).click()
  await expect(provider).toContainText('Google')
  const topBack = preferences.locator('.preferences-page-header')
    .getByRole('button', { name: /返回/u })

  await preferences.getByRole('button', { name: '管理大模型', exact: true }).click()
  await expect(preferences.getByRole('heading', { name: '管理大模型', exact: true })).toBeVisible()
  const bottomBack = preferences.locator('.preferences-page-actions')
    .getByRole('button', { name: '返回', exact: true })
  await expect(bottomBack).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(bottomBack).toHaveCSS('color', 'rgb(51, 51, 51)')
  await expect(bottomBack).toHaveCSS('border-color', 'rgb(201, 201, 201)')
  await bottomBack.click()
  await assertSummaryCloseFooterFits()
  await expect(provider).toContainText('Google')

  await preferences.getByRole('button', { name: '管理大模型', exact: true }).click()
  await topBack.click()
  await assertSummaryCloseFooterFits()
  await expect(provider).toContainText('Google')
  await topBack.click()
  await expect(preferences).toHaveCount(0)
  await page.evaluate(() => {
    ;(window as unknown as { __arkdownTestOcr: { openPreferences(): void } })
      .__arkdownTestOcr.openPreferences()
  })
  await assertSummaryCloseFooterFits()
  await expect(provider).toContainText('Google')
})

test('renders screenshot OCR progress and actions without overflow while preserving action focus', async ({ page }) => {
  await openCompiledArkdownPreferences(page)
  const screenshotSection = page.locator('.preferences-screenshot-section')
  await screenshotSection.scrollIntoViewIfNeeded()
  await expect(screenshotSection.getByRole('button', { name: '下载并更新' })).toBeVisible()
  await expect(screenshotSection.getByText('可下载')).toHaveCount(0)

  const download = screenshotSection.getByRole('button', { name: '下载并更新' })
  await download.focus()
  await download.evaluate((button) => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  expect(await page.evaluate(() => (
    (window as unknown as { __arkdownTestOcr: { downloadCalls(): number } }).__arkdownTestOcr.downloadCalls()
  ))).toBe(1)
  await page.evaluate(() => {
    ;(window as unknown as { __arkdownTestOcr: { emit(state: unknown): void } }).__arkdownTestOcr.emit({
      activeTier: 'medium',
      bundledVersion: '1.0.0',
      mediumVersion: '1.0.0',
      availableMediumVersion: '1.1.0',
      status: 'medium-downloading',
      progress: { receivedBytes: 25, totalBytes: 100 },
      errorCode: null,
    })
  })

  await expect(screenshotSection.getByRole('progressbar', { name: '下载进度' })).toHaveAttribute('aria-valuenow', '25')
  await expect(screenshotSection.getByRole('button', { name: '正在下载' })).toBeFocused()
  await expect(screenshotSection.getByRole('button', { name: '正在下载' })).toHaveAttribute('aria-disabled', 'true')
  await screenshotSection.getByRole('button', { name: '正在下载' }).click({ force: true })
  expect(await page.evaluate(() => (
    (window as unknown as { __arkdownTestOcr: { downloadCalls(): number } }).__arkdownTestOcr.downloadCalls()
  ))).toBe(1)
  const aligned = await screenshotSection.evaluate((section) => {
    const row = section.querySelector('.preferences-screenshot-row')!.getBoundingClientRect()
    const button = section.querySelector('.preferences-screenshot-action')!.getBoundingClientRect()
    const progress = section.querySelector('progress')!.getBoundingClientRect()
    return {
      buttonRight: button.right,
      progressRight: progress.right,
      rowRight: row.right,
    }
  })
  expect(aligned.buttonRight).toBeCloseTo(aligned.rowRight, 1)
  expect(aligned.progressRight).toBeCloseTo(aligned.rowRight, 1)
  const horizontal = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(horizontal.scrollWidth).toBeLessThanOrEqual(horizontal.clientWidth)

  await page.evaluate(() => {
    const installedState = {
      activeTier: 'medium',
      bundledVersion: '1.0.0',
      mediumVersion: '1.1.0',
      availableMediumVersion: '1.1.0',
      status: 'medium-installed',
      progress: null,
      errorCode: null,
    }
    const fixture = (window as unknown as {
      __arkdownTestOcr: {
        emit(state: unknown): void
        finishDownload(state: unknown): void
      }
    }).__arkdownTestOcr
    fixture.emit(installedState)
    fixture.finishDownload(installedState)
  })
  const installed = screenshotSection.getByRole('button', { name: '已安装' })
  await installed.click()
  const dialog = page.getByRole('dialog', { name: '是否删除PP-OCRv6 Medium模型？' })
  await expect(dialog).toContainText('删除后将恢复使用PP-OCRv6轻度模型')
  await dialog.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished))
  })
  expect(await dialog.evaluate((element) => element.getBoundingClientRect().width))
    .toBeCloseTo(360, 1)
  await expect(dialog).toHaveCSS('border-radius', '10px')
  expect(await dialog.evaluate((element) => element.getAnimations().map(
    (animation) => animation.effect?.getTiming().duration,
  ))).toContain(160)
  await expect(page.locator('.preferences-confirm-backdrop')).toHaveCSS(
    'background-color', 'rgba(0, 0, 0, 0.48)',
  )
  const no = dialog.getByRole('button', { name: '否' })
  const yes = dialog.getByRole('button', { name: '是' })
  await expect(no).toBeFocused()
  expect(await page.locator('.preferences-page').evaluate(
    (element) => (element as HTMLElement).inert,
  )).toBe(true)
  await no.press('Shift+Tab')
  await expect(yes).toBeFocused()
  expect(await yes.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      boxShadow: style.boxShadow,
      outlineColor: style.outlineColor,
      outlineStyle: style.outlineStyle,
    }
  })).toEqual(expect.objectContaining({
    boxShadow: 'rgb(65, 131, 196) 0px 0px 0px 1px inset',
    outlineStyle: 'none',
  }))
  expect(await yes.evaluate((element) => {
    const style = getComputedStyle(element)
    return `${style.outlineColor} ${style.boxShadow}`
  })).not.toMatch(/198,\s*40,\s*40/u)
  await yes.press('Tab')
  await expect(no).toBeFocused()
  await no.click()
  await expect(page.locator('.preferences-confirm-backdrop')).toHaveAttribute('data-state', 'closing')
  expect(await page.locator('.preferences-confirm-backdrop').evaluate((element) => (
    element.getAnimations().map((animation) => animation.effect?.getTiming().duration)
  ))).toContain(120)
  await expect(dialog).toHaveCount(0)
  await expect(installed).toBeFocused()
  expect(await page.locator('.preferences-page').evaluate(
    (element) => (element as HTMLElement).inert,
  )).toBe(false)
})

test('keeps shared modal semantic colors readable in dark mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await openCompiledArkdownPreferences(page)
  await page.evaluate(() => {
    ;(window as unknown as { __arkdownTestOcr: { emit(state: unknown): void } })
      .__arkdownTestOcr.emit({
        activeTier: 'medium',
        bundledVersion: '1.0.0',
        mediumVersion: '1.1.0',
        availableMediumVersion: '1.1.0',
        status: 'medium-installed',
        progress: null,
        errorCode: null,
      })
  })
  const screenshotSection = page.locator('.preferences-screenshot-section')
  await screenshotSection.scrollIntoViewIfNeeded()
  await screenshotSection.getByRole('button', { name: '已安装' }).click()
  const dialog = page.getByRole('dialog', { name: '是否删除PP-OCRv6 Medium模型？' })
  const colors = await dialog.evaluate((element) => {
    const style = getComputedStyle(element)
    const helper = getComputedStyle(element.querySelector('.arkdown-dialog__description')!)
    const cancel = getComputedStyle(element.querySelector('button')!)
    const danger = getComputedStyle(element.querySelector('.arkdown-dialog__danger')!)
    return {
      actionSurface: cancel.backgroundColor,
      actionText: cancel.color,
      border: style.borderColor,
      dangerSurface: danger.backgroundColor,
      dangerText: danger.color,
      helper: helper.color,
      surface: style.backgroundColor,
      text: style.color,
    }
  })

  expect(colors.surface).toBe('rgb(32, 33, 36)')
  expect(colors.text).toBe('rgb(241, 243, 244)')
  expect(colors.helper).toBe('rgb(181, 181, 181)')
  expect(colors.border).toBe('rgba(255, 255, 255, 0.36)')
  expect(contrastRatio(colors.text, colors.surface)).toBeGreaterThanOrEqual(4.5)
  expect(contrastRatio(colors.helper, colors.surface)).toBeGreaterThanOrEqual(4.5)
  expect(contrastRatio(colors.actionText, colors.actionSurface)).toBeGreaterThanOrEqual(4.5)
  expect(contrastRatio(colors.dangerText, colors.dangerSurface)).toBeGreaterThanOrEqual(4.5)
})

test('keeps primary actions on the fixed preference palette across themes and color schemes', async ({ page }) => {
  await openCompiledArkdownPreferences(page)
  await page.getByRole('button', { name: '管理大模型' }).click()
  await expect(page.getByRole('heading', { name: '管理大模型' })).toBeVisible()
  const addModel = page.getByRole('button', { name: '添加大模型' })
  await addModel.scrollIntoViewIfNeeded()

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    for (const theme of ['198 40 40', '0 0 0', '255 255 255', '255 255 0', '96 125 139']) {
      await addModel.evaluate((element, value) => {
        ;(element as HTMLElement).style.setProperty('--theme-color-rgb', value)
        ;(element as HTMLElement).focus()
        ;(element as HTMLElement).click()
      }, theme)
      const dialog = page.getByRole('dialog', { name: '添加大模型' })
      const primary = dialog.getByRole('button', { name: '连接' })
      await primary.evaluate((element) => element.removeAttribute('disabled'))
      await expect(primary).toBeVisible()

      const states = await primary.evaluate((element) => {
        const style = getComputedStyle(element)
        const text = style.color
        const normal = style.backgroundColor
        element.style.setProperty(
          'background-color',
          'var(--arkdown-dialog-primary-hover)',
          'important',
        )
        const hover = getComputedStyle(element).backgroundColor
        element.style.setProperty(
          'background-color',
          'var(--arkdown-dialog-primary-pressed)',
          'important',
        )
        const pressed = getComputedStyle(element).backgroundColor
        element.style.removeProperty('background-color')
        return { hover, normal, pressed, text }
      })

      expect(states, `${scheme} ${theme}`).toEqual({
        normal: 'rgb(65, 131, 196)',
        hover: 'rgb(54, 119, 183)',
        pressed: 'rgb(47, 105, 159)',
        text: 'rgb(255, 255, 255)',
      })

      await dialog.getByRole('button', { name: '取消' }).evaluate((element) => {
        ;(element as HTMLElement).click()
      })
      await expect(dialog).toHaveCount(0)
    }
  }
})

test('aligns footer actions to settings in summary and manager at wide and narrow widths', async ({ page }, testInfo) => {
  await openCompiledArkdownPreferences(page)
  for (const width of [1440, 1000, 900, 760, 480]) {
    await page.setViewportSize({ width, height: 720 })
    for (const manager of [false, true]) {
      if (manager) await page.getByRole('button', { name: '管理大模型', exact: true }).click()
      const action = page.locator('.preferences-page-actions button').last()
      const settings = page.locator('.preferences-settings')
      const a = await action.boundingBox()
      const b = await settings.boundingBox()
      expect(Math.abs(a!.x + a!.width - b!.x - b!.width)).toBeLessThanOrEqual(1)
      if (width <= 900) await expect(page.locator('.preferences-toc')).toBeHidden()
      if (width === 1440 || width === 480) await page.screenshot({ path: testInfo.outputPath('footer-' + width + '-' + manager + '.png') })
      if (manager) await action.click()
    }
  }
})

test('sizes custom search fields and keeps background launch errors beside their entry', async ({ page }, testInfo) => {
  await openCompiledArkdownPreferences(page)
  await page.getByRole('combobox', { name: '搜索提供商' }).click()
  await page.getByRole('option', { name: '百度（默认）', exact: true }).waitFor()
  await page.getByRole('option', { name: '自定义', exact: true }).click()
  const input = page.getByRole('textbox', { name: '自定义搜索地址' })
  await input.fill('http://example.com/' + 'long'.repeat(180) + '?q={query}')
  for (const width of [1280, 480]) {
    await page.setViewportSize({ width, height: 720 })
    const sizes = await input.evaluate((element) => {
      const field = element.parentElement!
      const label = field.querySelector('span')!
      const helper = field.querySelector('small')!
      const error = field.querySelector('[role=alert]')!
      const provider = field.previousElementSibling!
      return {
        inputFont: getComputedStyle(element).fontSize,
        labelFont: getComputedStyle(label).fontSize,
        helperFont: getComputedStyle(helper).fontSize,
        errorFont: getComputedStyle(error).fontSize,
        height: element.getBoundingClientRect().height,
        gap: getComputedStyle(field).gap,
        sectionGap: field.getBoundingClientRect().top - provider.getBoundingClientRect().bottom,
        width: field.getBoundingClientRect().width,
        overflow: field.scrollWidth - field.clientWidth,
      }
    })
    expect(sizes).toMatchObject({ inputFont: '13px', labelFont: '13px', helperFont: '13px', errorFont: '13px', height: 32, gap: '8px', sectionGap: 16, overflow: 0 })
    expect(sizes.width).toBeLessThanOrEqual(520)
    await page.screenshot({ path: testInfo.outputPath('custom-' + width + '.png') })
  }
  const launch = page.getByRole('button', { name: '打开设置窗口' })
  await launch.click()
  await expect(launch).toHaveCSS('font-size', '13px')
  expect((await launch.boundingBox())!.height).toBe(32)
  await expect(launch.locator('..').getByRole('alert')).toHaveText('背景窗口无法打开')
})

test('normalizes real preferences across light dark wide narrow and short layouts', async ({ page }, testInfo) => {
  await openCompiledArkdownPreferences(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const expectedGroups = ['浏览器搜索', '主题', '编辑器', 'Arknote', '右键菜单', '大模型设置', '截图OCR识别', '文档转换']
  await expect(page.locator('.preferences-settings > .preferences-section > h2')).toHaveText(expectedGroups)
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    for (const [width, height] of [[1280, 720], [1280, 420], [900, 720], [760, 720], [390, 720]]) {
      await page.setViewportSize({ width, height })
      const metrics = await page.locator('.preferences-page').evaluate((element) => {
        const rect = (selector: string) => element.querySelector(selector)!.getBoundingClientRect()
        const style = (selector: string) => getComputedStyle(element.querySelector(selector)!)
        const content = rect('.preferences-settings')
        const close = rect('.preferences-page-actions button')
        return {
          width: content.width, footerDifference: close.right - content.right,
          heading: [style('h1').fontSize, style('h1').lineHeight, style('h1').fontWeight],
          section: [style('h2').fontSize, style('h2').lineHeight, style('h2').fontWeight],
          subgroup: [style('h3').fontSize, style('h3').lineHeight, style('h3').fontWeight],
          helper: [style('.preferences-section > p').fontSize, style('.preferences-section > p').lineHeight, style('.preferences-section > p').color],
          close: [close.height, style('.preferences-page-actions button').borderRadius],
          fontColumns: style('.preferences-font-grid').gridTemplateColumns.split(' ').length,
          horizontalOverflow: element.scrollWidth - element.clientWidth,
          tocBottom: rect('.preferences-toc').bottom,
          viewportBottom: rect('.preferences-page-content').bottom,
        }
      })
      expect(metrics.heading).toEqual(['28px', '40px', '500'])
      expect(metrics.section).toEqual(['16px', '24px', '500'])
      expect(metrics.subgroup).toEqual(['14px', '22px', '500'])
      expect(metrics.helper).toEqual(['13px', '22px', scheme === 'light' ? 'rgb(102, 102, 102)' : 'rgb(181, 181, 181)'])
      expect(metrics.close).toEqual([32, '8px'])
      expect(metrics.width).toBeLessThanOrEqual(760)
      expect(Math.abs(metrics.footerDifference)).toBeLessThanOrEqual(1)
      expect(metrics.horizontalOverflow).toBeLessThanOrEqual(0)
      expect(metrics.fontColumns).toBe(width === 390 ? 1 : 2)
      if (width <= 900) await expect(page.locator('.preferences-toc')).toBeHidden()
      else expect(metrics.tocBottom).toBeLessThanOrEqual(metrics.viewportBottom + 1)
      const conversion = page.locator('.document-conversion-preferences__meta')
      await conversion.scrollIntoViewIfNeeded()
      const row = await conversion.evaluate((element) => {
        const helper = element.children[0].getBoundingClientRect()
        const status = element.children[1].getBoundingClientRect()
        return { topDifference: helper.top - status.top, overlap: helper.right > status.left,
          statusHeight: status.height, overflow: element.scrollWidth - element.clientWidth }
      })
      expect(Math.abs(row.topDifference)).toBeLessThanOrEqual(1)
      expect(row.overlap).toBe(false)
      expect(row.statusHeight).toBe(22)
      expect(row.overflow).toBeLessThanOrEqual(0)
      if (width === 1280 && height === 720) {
        for (let index = 0; index < expectedGroups.length; index += 1) {
          await page.locator('.preferences-settings > .preferences-section').nth(index).scrollIntoViewIfNeeded()
          await page.screenshot({ path: testInfo.outputPath(`normalized-${scheme}-${index}.png`) })
        }
      }
      if (width === 390) await page.screenshot({ path: testInfo.outputPath(`normalized-${scheme}-390.png`) })
    }
  }
  expect(errors).toEqual([])
})

test('preserves native checkbox mixed states keyboard selects sliders and theme controls', async ({ page }, testInfo) => {
  await openCompiledArkdownPreferences(page)
  const provider = page.getByRole('combobox', { name: '搜索提供商' })
  await provider.focus()
  await expect(provider).toHaveCSS('outline-style', 'none')
  await provider.press('ArrowDown')
  await expect(provider).toHaveAttribute('aria-expanded', 'true')
  const options = page.getByRole('listbox', { name: '搜索提供商' })
  await expect(options).toHaveCSS('border-radius', '8px')
  await expect(options).toHaveCSS('padding', '5px')
  await page.keyboard.press('End')
  await expect(page.getByRole('option', { name: '自定义', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(provider).toBeFocused()
  await page.getByRole('textbox', { name: '自定义搜索地址' }).fill('https://example.com/?q={query}')
  await provider.press('ArrowDown')
  await page.keyboard.press('Escape')
  await expect(provider).toBeFocused()
  await expect(provider).toHaveAttribute('aria-expanded', 'false')

  const shell = page.getByRole('checkbox', { name: 'md/txt文档上右键增加“使用Arkdown打开”' })
  await shell.check()
  await expect(shell).toBeChecked()
  const glyph = await shell.evaluate((input) => {
    const rect = input.getBoundingClientRect(), style = getComputedStyle(input, '::after')
    return { width: rect.width, height: rect.height, translateY: new DOMMatrix(style.transform).m42,
      offset: getComputedStyle(input).getPropertyValue('--preferences-check-offset-y').trim() }
  })
  expect(glyph.width).toBe(13)
  expect(glyph.height).toBe(13)
  expect(glyph.offset).toBe('-1px')
  expect(glyph.translateY).toBe(-1)
  await shell.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(shell).toBeFocused()
  await expect(shell).toHaveCSS('outline-style', 'solid')
  const defaultApp = page.getByRole('checkbox', { name: '将Arkdown设为Markdown文件和文本文档的默认程序' })
  await page.evaluate(() => {
    (window as unknown as { __arkdownTestOcr: { defaultApplications(state: unknown): void } }).__arkdownTestOcr.defaultApplications({ markdown: true, text: false })
  })
  await expect(defaultApp).toHaveAttribute('aria-checked', 'mixed')
  expect(await defaultApp.evaluate((input) => (input as HTMLInputElement).indeterminate)).toBe(true)
  await expect(defaultApp).toHaveAccessibleDescription('尚未设为文本文档的默认程序。包括 *.md 和 *.txt 格式文件。取消勾选将撤销当前 Arkdown 的关联。')
  await page.evaluate(() => {
    (window as unknown as { __arkdownTestOcr: { holdDefaultApplications(): void } }).__arkdownTestOcr.holdDefaultApplications()
  })
  await defaultApp.click()
  await expect(defaultApp).toBeDisabled()
  expect((await defaultApp.boundingBox())!.width).toBe(13)
  await page.evaluate(() => {
    (window as unknown as { __arkdownTestOcr: { finishDefaultApplications(): void } }).__arkdownTestOcr.finishDefaultApplications()
  })
  await expect(defaultApp).toHaveAttribute('aria-checked', 'mixed')
  await expect(defaultApp).toBeEnabled()
  expect(await defaultApp.evaluate((input) => (input as HTMLInputElement).indeterminate)).toBe(true)
  await page.locator('.preferences-shell-menu-choice').last().screenshot({ path: testInfo.outputPath('checkbox-mixed.png') })

  const slider = page.getByRole('slider', { name: '最小边距' })
  const before = Number(await slider.inputValue())
  await slider.focus()
  await slider.press('ArrowRight')
  await expect(slider).toHaveValue(String(before + 1))
  expect((await slider.boundingBox())!.height).toBe(20)
  const number = page.locator('.preferences-range-value').first()
  await expect(number).toHaveCSS('border-width', '0px')
  expect((await number.boundingBox())!.height).toBe(22)
  await page.locator('.preferences-editor-layout').screenshot({ path: testInfo.outputPath('sliders.png') })
  const swatches = page.locator('.preferences-theme-swatch')
  await swatches.nth(2).click()
  await expect(swatches.nth(2)).toHaveAttribute('aria-pressed', 'true')
  const colors = await swatches.first().evaluate((element) => {
    const style = getComputedStyle(element), paint = getComputedStyle(element, '::before')
    const rect = element.getBoundingClientRect(), next = element.nextElementSibling!.getBoundingClientRect()
    return { width: rect.width, swatch: paint.width, border: style.borderWidth, visibleGap: next.left - rect.left - Number.parseFloat(paint.width) }
  })
  expect(colors).toEqual({ width: 24, swatch: '20px', border: '0px', visibleGap: 10 })
  await expect(page.getByRole('button', { name: '恢复默认颜色' })).toHaveCount(0)
  const theme = page.getByLabel('自定义主题颜色', { exact: true })
  await theme.fill('#ffffff')
  await expect(page.getByLabel('当前主题颜色')).toHaveText('#FFFFFF')
  await page.getByRole('radio', { name: '颜色', exact: true }).check()
  await expect(page.getByLabel('自定义颜色', { exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '恢复便签默认样式' }).click()
  await expect(page.getByRole('radio', { name: 'Mica', exact: true })).toBeChecked()
  await expect(page.getByLabel('自定义颜色', { exact: true })).toBeDisabled()
})

test('retains configured model geometry and independent short-window navigation', async ({ page }, testInfo) => {
  const connection = {
    id: '11111111-1111-4111-8111-111111111111', name: '布局验证连接', provider: 'deepseek' as const,
    accessType: 'standard-api' as const, protocol: 'openai' as const, baseUrl: 'https://api.example.com/v1',
    modelId: 'deepseek-chat', apiKeyHint: '••••1234', status: 'connected' as const, lastTestedAt: null, capabilityOverride: null,
  }
  await openCompiledArkdownPreferences(page, {
    ...DEFAULT_LARGE_MODEL_SETTINGS, connections: [connection],
    selectionTranslation: { ...DEFAULT_LARGE_MODEL_SETTINGS.selectionTranslation, connectionId: connection.id },
  })
  await page.setViewportSize({ width: 1280, height: 420 })
  const nav = page.getByRole('navigation', { name: '偏好设置目录' })
  const content = page.getByRole('region', { name: '设置内容' })
  const before = await content.evaluate((element) => element.scrollTop)
  await nav.hover()
  await page.mouse.wheel(0, 1000)
  await expect.poll(() => nav.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  expect(await content.evaluate((element) => element.scrollTop)).toBe(before)
  await nav.getByRole('link', { name: '文档转换', exact: true }).click()
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect(nav.getByRole('link', { name: '文档转换', exact: true })).toHaveAttribute('aria-current', 'location')
  await page.getByRole('button', { name: '管理大模型', exact: true }).click()
  await expect(page.getByRole('heading', { name: '功能应用', exact: true })).toBeVisible()
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 720 })
      const card = page.getByRole('article', { name: connection.name })
      const disclosure = card.getByRole('button', { name: `${connection.name}详情` })
      if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click()
      await expect(card.getByRole('group', { name: /连接详情/u })).toBeVisible()
      await expect(card).toHaveCSS('padding', '17px')
      await expect(card).toHaveCSS('border-radius', '8px')
      await expect(page.locator('.large-model-assignment').first()).toHaveCSS('padding', '16px')
      const columns = await page.locator('.large-model-assignment-controls').first().evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)
      expect(columns).toBe(width === 390 ? 1 : 3)
      const layout = await card.evaluate((element) => ({ overflow: element.scrollWidth - element.clientWidth, helper: getComputedStyle(element.querySelector('dt')!).fontSize }))
      expect(layout).toEqual({ overflow: 0, helper: '13px' })
      await card.scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath(`manager-${scheme}-${width}.png`) })
    }
  }
  await page.locator('.preferences-page-actions').getByRole('button', { name: '返回', exact: true }).click()
  await expect(page.getByRole('heading', { name: '偏好设置', exact: true })).toBeVisible()
})

test('keeps conversion descriptions exactly 12 CSS px apart without idle control spacers', async ({ page }, testInfo) => {
  await openCompiledArkdownPreferences(page)
  const section = page.getByRole('region', { name: '文档转换', exact: true })
  for (const width of [1280, 900, 390]) {
    await page.setViewportSize({ width, height: 820 })
    await section.scrollIntoViewIfNeeded()
    const geometry = await section.evaluate((element) => {
      const description = element.querySelector('.document-conversion-preferences__description > p')!.getBoundingClientRect()
      const meta = element.querySelector('.document-conversion-preferences__meta')!
      const helper = meta.children[0].getBoundingClientRect()
      const status = meta.children[1].getBoundingClientRect()
      return { gap: helper.top - description.bottom, aligned: helper.top === status.top,
        overflow: element.scrollWidth - element.clientWidth,
        idleProgressHeight: element.querySelector('.document-conversion-preferences__progress-slot')!.getBoundingClientRect().height }
    })
    expect(geometry).toEqual({ gap: 12, aligned: true, overflow: 0, idleProgressHeight: 0 })
    await section.screenshot({ path: testInfo.outputPath(`conversion-gap-${width}.png`) })
  }
})

test('aligns three AI settings and expands model cards from their padding with motion and keyboard access', async ({ page }, testInfo) => {
  const connection = {
    id: '11111111-1111-4111-8111-111111111111', name: 'DeepSeek 验证模型', provider: 'deepseek' as const,
    accessType: 'standard-api' as const, protocol: 'openai' as const, baseUrl: 'https://api.deepseek.com',
    modelId: 'deepseek-v4-pro', apiKeyHint: '••••1234', status: 'connected' as const, lastTestedAt: null, capabilityOverride: null,
  }
  await openCompiledArkdownPreferences(page, { ...DEFAULT_LARGE_MODEL_SETTINGS, connections: [connection],
    aiConversation: { ...DEFAULT_LARGE_MODEL_SETTINGS.aiConversation, connectionId: connection.id, thinkingMode: 'enabled' } })
  await page.getByRole('button', { name: '管理大模型', exact: true }).click()
  const assignment = page.getByRole('group', { name: 'AI 对话配置', exact: true })
  const card = page.getByRole('article', { name: connection.name })
  const disclosure = card.getByRole('button', { name: `${connection.name}详情` })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 })
      const controls = await assignment.getByRole('combobox').evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect(); return { y: rect.y, height: rect.height }
      }))
      expect(controls).toHaveLength(3)
      if (width === 1280) expect(new Set(controls.map(({ y }) => y)).size).toBe(1)
      else expect(new Set(controls.map(({ y }) => y)).size).toBe(3)
      if (await disclosure.getAttribute('aria-expanded') === 'true') await disclosure.click()
      await card.scrollIntoViewIfNeeded()
      await disclosure.hover()
      await expect(disclosure).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      const rect = (await card.boundingBox())!
      await page.mouse.click(rect.x + 3, rect.y + 3)
      await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
      const details = card.locator('.large-model-card-details')
      const motion = await details.evaluate((element) => {
        const animation = element.getAnimations()[0]
        if (!animation) return null
        animation.pause(); animation.currentTime = 60
        const partial = element.getBoundingClientRect().height
        animation.finish()
        return { partial, expanded: element.getBoundingClientRect().height }
      })
      expect(motion).not.toBeNull()
      expect(motion!.partial).toBeLessThan(motion!.expanded)
      await card.getByRole('button', { name: '编辑', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '编辑大模型' })
      await dialog.getByLabel('模型 ID', { exact: true }).fill('test-model-edit')
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
      await page.screenshot({ path: testInfo.outputPath(`manager-${scheme}-${width}.png`) })
      await disclosure.focus(); await disclosure.press('Enter')
      await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await disclosure.focus(); await disclosure.press('Space')
  await expect(card.locator('.large-model-card-details')).toHaveCSS('animation-name', 'none')
  await expect(card.locator('.large-model-card-caret')).toHaveCSS('transition-duration', '0s')
})

test('keeps custom-theme actions readable and conversion feedback truthful in narrow layouts', async ({ page }, testInfo) => {
  await openCompiledArkdownPreferences(page)
  const theme = page.getByLabel('自定义主题颜色', { exact: true })
  const manage = page.getByRole('button', { name: '管理大模型', exact: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    for (const color of ['#ffffff', '#ffff00', '#000000', '#c62828']) {
      await theme.fill(color)
      const colors = await manage.evaluate((element) => {
        const style = getComputedStyle(element)
        return { text: style.color, background: style.backgroundColor, contrastSupported: CSS.supports('color', 'contrast-color(red)') }
      })
      expect(contrastRatio(colors.text, colors.background), JSON.stringify({ scheme, color, colors })).toBeGreaterThanOrEqual(4.5)
      const checkbox = page.getByRole('checkbox', { name: '在桌面右键菜单中增加“创建新便签”' })
      const checkboxColors = await checkbox.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        glyph: getComputedStyle(element, '::after').borderBottomColor,
      }))
      expect(contrastRatio(checkboxColors.glyph, checkboxColors.background)).toBeGreaterThanOrEqual(4.5)
    }
  }
  await page.setViewportSize({ width: 390, height: 720 })
  const section = page.getByRole('region', { name: '文档转换', exact: true })
  for (const state of [
    { status: 'installing', busy: true, progress: { phase: 'downloading', receivedBytes: 25, totalBytes: 100 } },
    { status: 'installed', busy: false, installedVersion: '1.0.0', progress: null },
    { status: 'failed', busy: false, installedVersion: null, progress: null, errorCode: 'DOCUMENT_CONVERSION_INSTALL_FAILED' },
  ]) {
    await page.evaluate((state) => {
      (window as unknown as { __arkdownTestOcr: { conversion(state: unknown): void } }).__arkdownTestOcr.conversion(state)
    }, state)
    await section.scrollIntoViewIfNeeded()
    if (state.status === 'installing') {
      await expect(section.getByRole('button', { name: '正在下载', exact: true })).toBeDisabled()
      await expect(section.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
    } else if (state.status === 'installed') {
      await expect(section.getByRole('status')).toContainText('1.0.0')
      await section.getByRole('button', { name: '已安装' }).click()
      const dialog = page.getByRole('dialog', { name: '是否删除文档转换组件？' })
      await expect(dialog).toContainText('源文件不会被删除')
      await dialog.getByRole('button', { name: '取消' }).click()
      await expect(dialog).toHaveCount(0)
    } else await expect(section.getByRole('alert')).toBeVisible()
    const geometry = await section.locator('.document-conversion-preferences__meta').evaluate((element) => ({
      overflow: element.scrollWidth - element.clientWidth,
      statusHeight: element.children[1].getBoundingClientRect().height,
      helperTop: element.children[0].getBoundingClientRect().top,
      statusTop: element.children[1].getBoundingClientRect().top,
    }))
    expect(geometry.overflow).toBeLessThanOrEqual(0)
    expect(geometry.statusHeight).toBe(22)
    expect(Math.abs(geometry.helperTop - geometry.statusTop)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: testInfo.outputPath(`conversion-${state.status}-390.png`) })
  }
})
