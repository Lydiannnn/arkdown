import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const applicationStyles = readFileSync(
  resolve(process.cwd(), 'src/renderer/app/styles.css'),
  'utf8',
)

function mountZoomLayout(percent: 70 | 100 | 200) {
  const factor = percent / 100
  document.head.innerHTML = `<style>${applicationStyles}</style>`
  document.body.innerHTML = `
    <div class="app-shell" style="--editor-minimum-margin: 30px; --editor-maximum-width: 1200px">
      <header class="app-titlebar"></header>
      <aside class="sidebar"></aside>
      <main class="editor-host" style="--editor-zoom-factor: ${factor}">
        <header class="document-header"></header>
        <div class="editor-content">
          <section class="editor-pane" style="--editor-zoom-factor: ${factor}">
            <div class="document-find-bar"></div>
            <div class="editor-surface">
              <div class="visual-editor">
                <div class="milkdown">
                  <div class="ProseMirror">
                    <div class="tableWrapper"><table><tbody><tr><td>cell<span class="column-resize-handle"></span></td></tr></tbody></table></div>
                    <span class="arkdown-local-image"><img alt="preview"><span class="arkdown-image-alignment-toolbar"><button></button></span><button class="arkdown-image-resize-handle"></button></span>
                  </div>
                </div>
              </div>
              <div class="source-editor">
                <div class="cm-editor">
                  <div class="cm-scroller">
                    <div class="cm-gutters"><div class="cm-lineNumbers">1</div><div class="cm-foldGutter">⌄</div></div>
                    <div class="cm-content"><div class="cm-line">wrapped source line</div></div>
                  </div>
                </div>
              </div>
            </div>
            <div class="translation-popover"></div>
          </section>
        </div>
        <footer class="statusbar"></footer>
      </main>
      <div class="context-menu"></div>
    </div>
  `

  return {
    chrome: Array.from(document.querySelectorAll<HTMLElement>(
      '.app-titlebar, .sidebar, .document-header, .statusbar, .context-menu, .document-find-bar, .translation-popover',
    )),
    milkdown: document.querySelector<HTMLElement>('.milkdown')!,
    table: document.querySelector<HTMLElement>('table')!,
    tableWrapper: document.querySelector<HTMLElement>('.tableWrapper')!,
    image: document.querySelector<HTMLElement>('.arkdown-local-image img')!,
    imageToolbar: document.querySelector<HTMLElement>('.arkdown-image-alignment-toolbar')!,
    imageHandle: document.querySelector<HTMLElement>('.arkdown-image-resize-handle')!,
    tableHandle: document.querySelector<HTMLElement>('.column-resize-handle')!,
    codeMirror: document.querySelector<HTMLElement>('.cm-editor')!,
    sourceContent: document.querySelector<HTMLElement>('.cm-content')!,
    sourceGutters: document.querySelector<HTMLElement>('.cm-gutters')!,
  }
}

afterEach(() => {
  document.head.replaceChildren()
  document.body.replaceChildren()
})

describe.each([70, 100, 200] as const)('editor zoom layout at %i percent', (percent) => {
  it('keeps the production selectors that back the real Chromium geometry contract', () => {
    const layout = mountZoomLayout(percent)
    const factor = String(percent / 100)
    const visual = getComputedStyle(layout.milkdown)
    const source = getComputedStyle(layout.codeMirror)

    expect(visual.getPropertyValue('--editor-zoom-factor').trim()).toBe(factor)
    expect(visual.zoom).toBe('var(--editor-zoom-factor, 1)')
    expect(visual.width).toContain('var(--editor-maximum-width, 1200px)')
    expect(visual.width).toContain('var(--editor-minimum-margin, 30px)')
    expect(visual.width).toContain('var(--editor-zoom-factor, 1)')
    expect(visual.maxWidth).toBe('100%')
    expect(visual.minHeight).toBe('100%')

    expect(source.getPropertyValue('--editor-zoom-factor').trim()).toBe(factor)
    expect(source.zoom).toBe('var(--editor-zoom-factor, 1)')
    expect(source.width).toBe('100%')
    expect(source.height).toBe('100%')
    expect(source.minHeight).toBe('100%')
    expect(layout.codeMirror.contains(layout.sourceGutters)).toBe(true)
    expect(layout.codeMirror.contains(layout.sourceContent)).toBe(true)

    expect(getComputedStyle(layout.tableWrapper)).toMatchObject({
      width: '100%',
      maxWidth: '100%',
      overflowX: 'hidden',
    })
    expect(getComputedStyle(layout.table).maxWidth).toBe('100%')
    expect(getComputedStyle(layout.image).maxWidth).toBe('100%')
    expect(getComputedStyle(layout.imageToolbar).zoom)
      .toBe('calc(1 / var(--editor-zoom-factor, 1))')
    expect(getComputedStyle(layout.imageHandle).zoom)
      .toBe('calc(1 / var(--editor-zoom-factor, 1))')
    expect(getComputedStyle(layout.tableHandle).zoom)
      .toBe('calc(1 / var(--editor-zoom-factor, 1))')
    expect(layout.chrome.every((element) => getComputedStyle(element).zoom === '1')).toBe(true)
  })
})
