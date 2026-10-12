import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const appStyle = document.createElement('style')
appStyle.textContent = readFileSync(
  path.join(process.cwd(), 'src/renderer/app/styles.css'),
  'utf8',
)

const stickyCss = readFileSync(
  path.join(process.cwd(), 'src/renderer/sticky-notes/sticky-note-window.css'),
  'utf8',
).replace(/\r\n/g, '\n')

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 's'))
  if (!match) throw new Error(`Missing CSS rule for ${selector}`)
  return match[1].replace(/\s+/g, ' ')
}

beforeAll(() => document.head.append(appStyle))
afterEach(() => document.body.replaceChildren())
afterAll(() => appStyle.remove())

function appendStyle(relativePath: string): HTMLStyleElement {
  const style = document.createElement('style')
  style.textContent = readFileSync(path.join(process.cwd(), relativePath), 'utf8')
  document.head.append(style)
  return style
}

function editorMarkup(): string {
  return `<div class="visual-editor"><div class="milkdown"><div class="ProseMirror">
    <h4 data-target="heading">Heading</h4>
    <p data-target="paragraph">Paragraph</p>
    <blockquote data-target="quote"><p data-target="quote-paragraph">Annotation</p></blockquote>
    <ul><li class="milkdown-list-item-block"><div class="list-item"><div class="children"><div data-content-dom><p>One</p></div></div></div></li><li class="milkdown-list-item-block" data-target="adjacent-item"><div class="list-item"><div class="children"><div data-content-dom><p data-target="list-paragraph">Two</p></div></div></div></li></ul>
    <hr data-target="rule">
  </div></div></div>`
}

function windowFixture(mode: 'compact' | 'standard'): HTMLElement {
  const root = document.createElement('main')
  root.className = 'sticky-note-window'
  root.dataset.lineSpacingMode = mode
  root.style.backgroundColor = 'rgb(255, 243, 179)'
  root.innerHTML = `<section class="sticky-note-editor-shell"><div class="sticky-note-editor">${editorMarkup()}</div></section><div class="sticky-note-toolbar"><button class="sticky-note-toolbar-toggle"><img alt=""></button></div>`
  document.body.append(root)
  return root
}

function archiveFixture(mode: 'compact' | 'standard'): HTMLElement {
  const surface = document.createElement('div')
  surface.className = 'archived-sticky-note-preview-surface'
  surface.dataset.lineSpacingMode = mode
  surface.style.backgroundColor = 'rgb(255, 243, 179)'
  surface.innerHTML = editorMarkup()
  document.body.append(surface)
  return surface
}

function expectCompactTypography(root: HTMLElement): void {
  const proseMirror = root.querySelector<HTMLElement>('.ProseMirror')!
  const paragraph = root.querySelector<HTMLElement>('[data-target="paragraph"]')!
  const heading = root.querySelector<HTMLElement>('[data-target="heading"]')!
  const quote = root.querySelector<HTMLElement>('[data-target="quote"]')!
  const quoteParagraph = root.querySelector<HTMLElement>('[data-target="quote-paragraph"]')!
  const listParagraph = root.querySelector<HTMLElement>('[data-target="list-paragraph"]')!
  const adjacentItem = root.querySelector<HTMLElement>('[data-target="adjacent-item"]')!
  const horizontalRule = root.querySelector<HTMLElement>('[data-target="rule"]')!

  expect(getComputedStyle(proseMirror).lineHeight).toBe('1.5')
  expect(getComputedStyle(heading).lineHeight).toBe('1.5')
  expect(getComputedStyle(heading).marginTop).toBe('0.25em')
  expect(getComputedStyle(heading).marginBottom).toBe('0.05em')
  expect(getComputedStyle(paragraph).lineHeight).toBe('1.5')
  expect(getComputedStyle(paragraph).marginTop).toBe('0px')
  expect(getComputedStyle(paragraph).marginBottom).toBe('0px')
  expect(getComputedStyle(quote).lineHeight).toBe('1.5')
  expect(getComputedStyle(quote).fontSize).toBe('13px')
  expect(getComputedStyle(quoteParagraph).marginTop).toBe('0px')
  expect(getComputedStyle(quoteParagraph).marginBottom).toBe('0px')
  expect(getComputedStyle(listParagraph).lineHeight).toBe('1.5')
  expect(getComputedStyle(adjacentItem).marginTop).toBe('0px')
  expect(getComputedStyle(horizontalRule).marginTop).toBe('calc(16px - 0.3em)')
  expect(getComputedStyle(horizontalRule).marginBottom).toBe('calc(16px - 0.3em)')
}

function expectStandardTypography(root: HTMLElement): void {
  const proseMirror = root.querySelector<HTMLElement>('.ProseMirror')!
  const paragraph = root.querySelector<HTMLElement>('[data-target="paragraph"]')!
  const heading = root.querySelector<HTMLElement>('[data-target="heading"]')!
  const quoteParagraph = root.querySelector<HTMLElement>('[data-target="quote-paragraph"]')!
  const adjacentItem = root.querySelector<HTMLElement>('[data-target="adjacent-item"]')!
  const horizontalRule = root.querySelector<HTMLElement>('[data-target="rule"]')!

  expect(getComputedStyle(proseMirror).lineHeight).toBe('1.65')
  expect(getComputedStyle(paragraph).marginTop).toBe('0.8em')
  expect(getComputedStyle(paragraph).marginBottom).toBe('0.8em')
  expect(getComputedStyle(heading).marginTop).toBe('0.9em')
  expect(getComputedStyle(heading).marginBottom).toBe('0.7em')
  expect(getComputedStyle(quoteParagraph).marginTop).toBe('0.8em')
  expect(getComputedStyle(quoteParagraph).marginBottom).toBe('0.8em')
  expect(getComputedStyle(adjacentItem).marginTop).toBe('10px')
  expect(getComputedStyle(horizontalRule).marginTop).toBe('calc(16px - 0.3em)')
  expect(getComputedStyle(horizontalRule).marginBottom).toBe('calc(16px - 0.3em)')
}

function expectTransparent(element: Element | null): void {
  expect(element).not.toBeNull()
  expect(getComputedStyle(element!).backgroundColor).toBe('rgba(0, 0, 0, 0)')
}

describe('sticky note window editor presentation', () => {
  it('owns compact list geometry and task hit-target sizing only inside the sticky window', () => {
    expect(rule(
      stickyCss,
      '.sticky-note-window .visual-editor .ProseMirror .list-item > .label-wrapper',
    )).toContain('width: 14px')
    expect(rule(
      stickyCss,
      '.sticky-note-window .visual-editor .ProseMirror .list-item',
    )).toContain('gap: 2px')
    const taskLabel = rule(
      stickyCss,
      '.sticky-note-window .visual-editor .ProseMirror .milkdown-list-item-block\n  > .list-item\n  > .label-wrapper\n  > .label:is(.checked, .unchecked)',
    )
    expect(taskLabel).toContain('width: 22px')
    expect(taskLabel).toContain('height: 22px')
    const taskIcon = rule(
      stickyCss,
      '.sticky-note-window .visual-editor .ProseMirror .milkdown-list-item-block\n  > .list-item\n  > .label-wrapper\n  > .label:is(.checked, .unchecked)\n  > svg',
    )
    expect(taskIcon).toContain('width: 14px')
    expect(taskIcon).toContain('height: 14px')
    expect(stickyCss).toMatch(
      /\.sticky-note-window \.visual-editor \.ProseMirror > ul[\s\S]*?> \.label\.bullet\s*\{\s*transform:\s*translate\(1px,\s*0\)/u,
    )
  })

  it('applies compact and standard typography while keeping every editor layer transparent', () => {
    const style = appendStyle('src/renderer/sticky-notes/sticky-note-window.css')
    try {
      const compact = windowFixture('compact')
      expectCompactTypography(compact)
      expectTransparent(compact.querySelector('.sticky-note-editor-shell'))
      expectTransparent(compact.querySelector('.sticky-note-editor'))
      expectTransparent(compact.querySelector('.visual-editor'))
      expectTransparent(compact.querySelector('.milkdown'))
      expectTransparent(compact.querySelector('.ProseMirror'))
      const toolbarStyle = getComputedStyle(compact.querySelector('.sticky-note-toolbar')!)
      expect(toolbarStyle.right).toBe('0px')
      expect(toolbarStyle.width).toBe('100%')
      expect(toolbarStyle.justifyContent).toBe('flex-start')

      compact.remove()
      expectStandardTypography(windowFixture('standard'))
    } finally {
      style.remove()
    }
  })

  it('collapses the toolbar to a transparent positioning layer with one right-aligned reveal control', () => {
    const style = appendStyle('src/renderer/sticky-notes/sticky-note-window.css')
    try {
      const root = windowFixture('compact')
      const toolbar = root.querySelector<HTMLElement>('.sticky-note-toolbar')!
      const toggle = root.querySelector<HTMLElement>('.sticky-note-toolbar-toggle')!
      toolbar.dataset.collapsed = 'true'

      expect(getComputedStyle(toolbar).left).toBe('0px')
      expect(getComputedStyle(toolbar).right).toBe('0px')
      expect(getComputedStyle(toolbar).width).toBe('100%')
      expect(getComputedStyle(toolbar).justifyContent).toBe('flex-end')
      expect(getComputedStyle(toolbar).backgroundColor).toBe('rgba(0, 0, 0, 0)')
      expect(getComputedStyle(toolbar).borderTopColor).toBe('rgba(0, 0, 0, 0)')
      expect(getComputedStyle(toolbar).pointerEvents).toBe('none')
      expect(getComputedStyle(toggle).marginLeft).toBe('auto')
      expect(getComputedStyle(toggle).pointerEvents).toBe('auto')
    } finally {
      style.remove()
    }
  })

  it('uses material body and toolbar tokens instead of global editor colors', () => {
    const style = appendStyle('src/renderer/sticky-notes/sticky-note-window.css')
    try {
      const root = windowFixture('compact')
      root.dataset.materialPreset = 'mica-light'
      root.dataset.colorScheme = 'light'
      root.style.setProperty('--sticky-note-text-color', '#242629')
      root.style.setProperty('--sticky-note-toolbar-layer', '#F3F3F3')
      const proseMirror = root.querySelector<HTMLElement>('.ProseMirror')!
      const toolbar = root.querySelector<HTMLElement>('.sticky-note-toolbar')!

      expect(getComputedStyle(proseMirror).color).toBe('var(--sticky-note-text-color)')
      expect(getComputedStyle(toolbar).backgroundColor).toBe('var(--sticky-note-toolbar-layer)')
    } finally {
      style.remove()
    }
  })
})

describe('archived sticky note editor presentation', () => {
  it('applies the saved mode from the preview surface without window stylesheet support', () => {
    const style = appendStyle('src/renderer/sticky-notes/sticky-note-box.css')
    try {
      const compact = archiveFixture('compact')
      expectCompactTypography(compact)
      expectTransparent(compact.querySelector('.visual-editor'))
      expectTransparent(compact.querySelector('.milkdown'))
      expectTransparent(compact.querySelector('.ProseMirror'))

      compact.remove()
      expectStandardTypography(archiveFixture('standard'))
    } finally {
      style.remove()
    }
  })
})
