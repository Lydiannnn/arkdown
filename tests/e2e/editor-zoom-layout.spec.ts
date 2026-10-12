import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'

const applicationStyles = readFileSync(
  path.resolve('src/renderer/app/styles.css'),
  'utf8',
)

const zoomCases = [
  { percent: 70, factor: 0.7 },
  { percent: 100, factor: 1 },
  { percent: 200, factor: 2 },
] as const

function visualDocument(factor: number): string {
  return `
    <style>
      ${applicationStyles}
      * { scrollbar-width: auto; }
      html, body { width: 100%; height: 100%; margin: 0; }
      .test-shell { width: 1000px; height: 600px; }
      .test-chrome { width: 100px; height: 32px; }
      .translation-popover { width: 100px; height: 40px; }
      .visual-editor .ProseMirror { padding: 0; }
      .arkdown-local-image .arkdown-image-alignment-toolbar { display: flex; }
      .arkdown-local-image .arkdown-image-resize-handle { display: block; }
    </style>
    <div class="test-chrome" id="chrome"></div>
    <main
      class="test-shell editor-surface"
      id="surface"
      style="--editor-minimum-margin:30px;--editor-maximum-width:1200px;--editor-zoom-factor:${factor}"
    >
      <div class="visual-editor">
        <div class="milkdown" id="document">
          <div class="ProseMirror" id="content">
            <p><span id="zoom-probe" style="display:inline-block;font-size:20px;line-height:20px">Zoomed</span></p>
            <div class="tableWrapper" id="table-wrapper">
              <table id="table" style="width:1400px"><tbody><tr><td style="position:relative">cell<span class="column-resize-handle" id="table-handle"></span></td></tr></tbody></table>
            </div>
            <span class="arkdown-local-image" id="image-wrapper">
              <img id="image" alt="preview" style="width:1600px;height:100px">
              <span class="arkdown-image-alignment-toolbar"><button id="image-toolbar-button"></button></span>
              <button class="arkdown-image-resize-handle is-south-east" id="image-handle"></button>
            </span>
          </div>
        </div>
      </div>
    </main>
    <div class="translation-popover" id="translation-popover"></div>
  `
}

function sourceDocument(factor: number): string {
  return `
    <style>
      ${applicationStyles}
      html, body { width: 100%; height: 100%; margin: 0; }
      .test-shell { width: 1000px; height: 600px; }
      .source-editor .cm-editor { box-sizing: border-box; }
      .source-editor .cm-scroller { display: flex; width: 100%; height: 100%; }
      .source-editor .cm-gutters { box-sizing: border-box; flex: 0 0 48px; }
      .source-editor .cm-content { box-sizing: border-box; min-width: 0; flex: 1 1 auto; white-space: pre-wrap; overflow-wrap: anywhere; }
      .source-editor .cm-line { line-height: 20px; }
    </style>
    <main
      class="test-shell editor-surface"
      id="surface"
      style="--editor-zoom-factor:${factor}"
    >
      <div class="source-editor-context">
        <div class="source-editor">
          <div class="cm-editor" id="source-document">
            <div class="cm-scroller" id="source-scroller">
              <div class="cm-gutters" id="source-gutter">1</div>
              <div class="cm-content" id="source-content"><div class="cm-line" id="source-line">${'wrapped-source-content-'.repeat(100)}</div></div>
            </div>
          </div>
        </div>
      </div>
    </main>
  `
}

for (const { percent, factor } of zoomCases) {
  test(`real Chromium keeps visual document geometry and edit affordances usable at ${percent}%`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.setContent(visualDocument(factor))

    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
      const surface = rect('#surface')
      const documentRect = rect('#document')
      const content = rect('#content')
      const tableWrapper = rect('#table-wrapper')
      const table = rect('#table')
      const imageWrapper = rect('#image-wrapper')
      const image = rect('#image')
      const chrome = rect('#chrome')
      const popover = rect('#translation-popover')
      const zoomProbe = rect('#zoom-probe')
      const toolbarButton = rect('#image-toolbar-button')
      const imageHandle = rect('#image-handle')
      const tableHandle = rect('#table-handle')
      const tableCell = rect('#table-handle').width > 0
        ? document.querySelector('#table-handle')!.parentElement!.getBoundingClientRect()
        : rect('#table')
      const hit = document.elementFromPoint(surface.left + surface.width / 2, surface.bottom - 1)
      return {
        surface: { left: surface.left, right: surface.right, width: surface.width, height: surface.height },
        document: { left: documentRect.left, right: documentRect.right, width: documentRect.width, height: documentRect.height },
        content: { left: content.left, right: content.right, width: content.width },
        tableWrapper: { left: tableWrapper.left, right: tableWrapper.right, width: tableWrapper.width },
        table: { left: table.left, right: table.right, width: table.width },
        imageWrapper: { left: imageWrapper.left, right: imageWrapper.right, width: imageWrapper.width },
        image: { left: image.left, right: image.right, width: image.width },
        chrome: { width: chrome.width, height: chrome.height },
        popover: { width: popover.width, height: popover.height },
        zoomProbeHeight: zoomProbe.height,
        toolbarButton: { width: toolbarButton.width, height: toolbarButton.height },
        imageHandle: { width: imageHandle.width, height: imageHandle.height },
        imageHandleCenter: {
          x: imageHandle.left + imageHandle.width / 2,
          y: imageHandle.top + imageHandle.height / 2,
        },
        imageBottomRight: { x: imageWrapper.right, y: imageWrapper.bottom },
        toolbarCenterX: toolbarButton.left + toolbarButton.width / 2,
        imageCenterX: imageWrapper.left + imageWrapper.width / 2,
        tableHandleWidth: tableHandle.width,
        tableHandleCenterX: tableHandle.left + tableHandle.width / 2,
        tableCellRight: tableCell.right,
        tableHandleIsHitTarget: document.elementFromPoint(
          tableHandle.left + tableHandle.width / 2,
          tableHandle.top + tableHandle.height / 2,
        )?.id === 'table-handle',
        imageHandleIsHitTarget: document.elementFromPoint(
          imageHandle.left + imageHandle.width / 2,
          imageHandle.top + imageHandle.height / 2,
        )?.id === 'image-handle',
        surfaceScrollWidth: document.querySelector<HTMLElement>('#surface')!.scrollWidth,
        bottomHitIsDocument: Boolean(hit?.closest('#document')),
      }
    })

    expect(geometry.surface).toMatchObject({ width: 1000, height: 600 })
    expect(geometry.document.width).toBeCloseTo(940, 3)
    expect(geometry.document.left - geometry.surface.left).toBeCloseTo(30, 3)
    expect(geometry.surface.right - geometry.document.right).toBeCloseTo(30, 3)
    expect(geometry.document.height).toBeGreaterThanOrEqual(600)
    expect(geometry.content.width).toBeCloseTo(geometry.document.width, 3)
    expect(geometry.surfaceScrollWidth).toBe(1000)
    expect(geometry.bottomHitIsDocument).toBe(true)
    expect(geometry.tableWrapper.width).toBeLessThanOrEqual(geometry.content.width + 0.01)
    expect(geometry.table.right).toBeLessThanOrEqual(geometry.tableWrapper.right + 0.01)
    expect(geometry.imageWrapper.width).toBeLessThanOrEqual(geometry.content.width + 0.01)
    expect(geometry.image.right).toBeLessThanOrEqual(geometry.imageWrapper.right + 0.01)
    expect(geometry.zoomProbeHeight).toBeCloseTo(20 * factor, 3)
    expect(geometry.toolbarButton).toMatchObject({ width: 30, height: 30 })
    expect(geometry.imageHandle).toMatchObject({ width: 10, height: 10 })
    expect(geometry.imageHandleCenter.x).toBeCloseTo(geometry.imageBottomRight.x, 3)
    expect(geometry.imageHandleCenter.y).toBeCloseTo(geometry.imageBottomRight.y, 3)
    expect(geometry.toolbarCenterX).toBeCloseTo(geometry.imageCenterX, 3)
    expect(geometry.imageHandleIsHitTarget).toBe(true)
    expect(geometry.tableHandleWidth).toBeCloseTo(4, 3)
    expect(Math.abs(geometry.tableHandleCenterX - geometry.tableCellRight)).toBeLessThanOrEqual(1)
    expect(geometry.tableHandleIsHitTarget).toBe(true)
    expect(geometry.chrome).toMatchObject({ width: 100, height: 32 })
    expect(geometry.popover).toMatchObject({ width: 100, height: 40 })

    await page.locator('#surface').evaluate((element) => {
      element.style.width = '1500px'
    })
    const wide = await page.evaluate(() => {
      const surface = document.querySelector('#surface')!.getBoundingClientRect()
      const documentRect = document.querySelector('#document')!.getBoundingClientRect()
      return {
        width: documentRect.width,
        leftMargin: documentRect.left - surface.left,
        rightMargin: surface.right - documentRect.right,
      }
    })
    expect(wide.width).toBeCloseTo(1200, 3)
    expect(wide.leftMargin).toBeCloseTo(150, 3)
    expect(wide.rightMargin).toBeCloseTo(150, 3)
  })

  test(`real Chromium keeps source viewport, wrapping, and gutter alignment at ${percent}%`, async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 })
    await page.setContent(sourceDocument(factor))

    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
      const surface = rect('#surface')
      const editor = rect('#source-document')
      const scroller = rect('#source-scroller')
      const gutter = rect('#source-gutter')
      const content = rect('#source-content')
      const line = rect('#source-line')
      const hit = document.elementFromPoint(surface.right - 1, surface.bottom - 1)
      return {
        surface: { width: surface.width, height: surface.height },
        editor: { width: editor.width, height: editor.height },
        scroller: { left: scroller.left, right: scroller.right, top: scroller.top, bottom: scroller.bottom },
        gutter: { left: gutter.left, right: gutter.right, top: gutter.top },
        content: { left: content.left, right: content.right, top: content.top },
        line: { left: line.left, right: line.right, width: line.width, height: line.height },
        scrollWidth: document.querySelector<HTMLElement>('#source-scroller')!.scrollWidth,
        clientWidth: document.querySelector<HTMLElement>('#source-scroller')!.clientWidth,
        bottomHitIsEditor: Boolean(hit?.closest('#source-document')),
      }
    })

    expect(geometry.surface).toEqual({ width: 1000, height: 600 })
    expect(geometry.editor.width).toBeCloseTo(1000, 3)
    expect(geometry.editor.height).toBeCloseTo(600, 3)
    expect(geometry.scroller.right - geometry.scroller.left).toBeCloseTo(1000, 3)
    expect(geometry.scroller.bottom - geometry.scroller.top).toBeCloseTo(600, 3)
    expect(geometry.gutter.top).toBeCloseTo(geometry.content.top, 3)
    expect(geometry.gutter.right).toBeCloseTo(geometry.content.left, 3)
    expect(geometry.line.left).toBeGreaterThanOrEqual(geometry.content.left)
    expect(geometry.line.right).toBeLessThanOrEqual(geometry.content.right + 0.01)
    expect(geometry.line.height).toBeGreaterThan(20 * factor)
    expect(geometry.scrollWidth).toBe(geometry.clientWidth)
    expect(geometry.bottomHitIsEditor).toBe(true)
  })
}
