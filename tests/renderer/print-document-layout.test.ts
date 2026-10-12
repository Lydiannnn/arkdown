import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'

const css = readFileSync(
  path.join(process.cwd(), 'src/renderer/printing/print-document.css'),
  'utf8',
)

afterEach(() => {
  document.head.querySelectorAll('[data-test="print-layout-css"]').forEach((node) => node.remove())
  document.body.replaceChildren()
})

it('keeps captured width and margin constraints active in the print cascade', () => {
  const source = document.head.appendChild(document.createElement('style'))
  source.dataset.test = 'print-layout-css'
  source.textContent = css
  const printMedia = Array.from(source.sheet?.cssRules ?? []).find((rule): rule is CSSMediaRule => (
    rule instanceof CSSMediaRule && rule.conditionText === 'print'
  ))
  expect(printMedia).toBeDefined()

  // JSDOM does not switch media, so activate the stylesheet's real print-rule bodies
  // after the base sheet to exercise the same cascade order as Chromium print media.
  const activePrint = document.head.appendChild(document.createElement('style'))
  activePrint.dataset.test = 'print-layout-css'
  activePrint.textContent = Array.from(printMedia!.cssRules).map((rule) => rule.cssText).join('\n')

  document.body.innerHTML = `
    <main
      class="print-document-surface"
      style="--editor-maximum-width: 640px; --editor-minimum-margin: 72px"
    >
      <div class="visual-editor">
        <div class="milkdown">
          <div class="ProseMirror">Printed body</div>
        </div>
      </div>
    </main>
  `
  const surface = document.querySelector<HTMLElement>('.print-document-surface')!
  const milkdown = document.querySelector<HTMLElement>('.milkdown')!
  const proseMirror = document.querySelector<HTMLElement>('.ProseMirror')!
  const surfaceStyle = getComputedStyle(surface)
  const milkdownStyle = getComputedStyle(milkdown)
  const proseMirrorStyle = getComputedStyle(proseMirror)

  expect(surfaceStyle.getPropertyValue('--editor-maximum-width').trim()).toBe('640px')
  expect(surfaceStyle.getPropertyValue('--editor-minimum-margin').trim()).toBe('72px')
  expect(milkdownStyle.width).toBe('min(100%, var(--editor-maximum-width, 800px))')
  expect(milkdownStyle.maxWidth).toBe('var(--editor-maximum-width, 800px)')
  expect(milkdownStyle.marginLeft).toBe('auto')
  expect(milkdownStyle.marginRight).toBe('auto')
  expect(proseMirrorStyle.paddingInline).toBe(
    'min(var(--editor-minimum-margin, 30px), 12.5%)',
  )
})

it('prints Mermaid images and errors without source controls or splitting the block', () => {
  const source = document.head.appendChild(document.createElement('style'))
  source.dataset.test = 'print-layout-css'
  source.textContent = css
  document.body.innerHTML = `
    <main class="print-document-surface">
      <div class="visual-editor">
        <div class="arkdown-mermaid-block">
          <div class="arkdown-mermaid-toolbar"><button>编辑源码</button></div>
          <div class="arkdown-mermaid-preview" role="alert">
            <img alt="Mermaid diagram" src="data:image/svg+xml;base64,PHN2Zy8+" />
            <span>Mermaid 语法错误</span>
          </div>
          <div class="arkdown-mermaid-source">graph TD</div>
        </div>
      </div>
    </main>
  `

  const block = document.querySelector<HTMLElement>('.arkdown-mermaid-block')!
  const toolbar = document.querySelector<HTMLElement>('.arkdown-mermaid-toolbar')!
  const sourceHost = document.querySelector<HTMLElement>('.arkdown-mermaid-source')!
  const image = document.querySelector<HTMLImageElement>('.arkdown-mermaid-preview img')!
  const error = document.querySelector<HTMLElement>('[role="alert"]')!

  expect(getComputedStyle(block).breakInside).toBe('avoid-page')
  expect(getComputedStyle(toolbar).display).toBe('none')
  expect(getComputedStyle(sourceHost).display).toBe('none')
  expect(getComputedStyle(image).display).toBe('block')
  expect(getComputedStyle(error).display).not.toBe('none')
})
