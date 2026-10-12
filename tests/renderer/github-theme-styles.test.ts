import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const css = readFileSync(
  path.join(process.cwd(), 'src/renderer/app/styles.css'),
  'utf8',
).replace(/\r\n/g, '\n')

const contextMenuCss = readFileSync(
  path.join(process.cwd(), 'src/renderer/context-menu/context-menu.css'),
  'utf8',
)

const preferencesCss = readFileSync(
  path.join(process.cwd(), 'src/renderer/settings/search-preferences.css'),
  'utf8',
)

const arkdownDialogCss = readFileSync(
  path.join(process.cwd(), 'src/renderer/modal/arkdown-dialog.css'),
  'utf8',
)

const preferencesSelectCss = readFileSync(
  path.join(process.cwd(), 'src/renderer/settings/preferences-select.css'),
  'utf8',
)

const largeModelCss = readFileSync(
  path.join(process.cwd(), 'src/renderer/settings/large-model-settings.css'),
  'utf8',
)
const visualEditorSource = readFileSync(
  path.join(process.cwd(), 'src/renderer/editor/VisualEditor.tsx'),
  'utf8',
)

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 's'))
  if (!match) throw new Error(`Missing CSS rule for ${selector}`)
  return match[1].replace(/\s+/g, ' ')
}

function lastRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'gs'))]
  const match = matches.at(-1)
  if (!match) throw new Error(`Missing CSS rule for ${selector}`)
  return match[1].replace(/\s+/g, ' ')
}

function sourceRule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`^\\s*${escaped}\\s*\\{([^}]+)\\}`, 'ms'))
  if (!match) throw new Error(`Missing CSS rule for ${selector}`)
  return match[1].replace(/\s+/g, ' ')
}

describe('Minimal theme baseline', () => {
  test('keeps exactly one Crepe common and classic style import', () => {
    expect(visualEditorSource.match(/@milkdown\/crepe\/theme\/common\/style\.css/g)).toHaveLength(1)
    expect(visualEditorSource.match(/@milkdown\/crepe\/theme\/classic\.css/g)).toHaveLength(1)
  })

  test('uses the Minimal body typography', () => {
    const editor = rule('.visual-editor .ProseMirror')
    expect(editor).toContain('color: #333')
    expect(editor).toContain('font-family: var(--body-latin-font), var(--body-cjk-font), var(--ui-font-family)')
    expect(editor).toContain('font-size: 16px')
    expect(editor).toContain('line-height: 1.6')
  })

  test('uses independent minimum-margin and maximum-width constraints', () => {
    const write = rule('.visual-editor .milkdown')
    expect(write).toContain('var(--editor-maximum-width, 1200px)')
    expect(write).toContain('var(--editor-minimum-margin, 30px)')
    expect(write).toContain('max-width: 100%')
    expect(write).toContain(
      'var(--editor-minimum-margin, 30px) / var(--editor-zoom-factor, 1)',
    )
    expect(write).toContain('padding: 0')
    expect(rule('.visual-editor .ProseMirror')).toContain('padding: 90px 0 160px')
  })

  test('matches heading and paragraph rhythm', () => {
    const headings = rule('.visual-editor .ProseMirror h1,\n.visual-editor .ProseMirror h2,\n.visual-editor .ProseMirror h3,\n.visual-editor .ProseMirror h4,\n.visual-editor .ProseMirror h5,\n.visual-editor .ProseMirror h6')
    expect(headings).toContain('margin: 1rem 0')
    expect(headings).toContain('font-weight: var(--ui-font-weight-heading)')
    expect(headings).toContain('line-height: 1.4')
    expect(rule('.visual-editor .ProseMirror h1')).toContain('font-size: 2.25em')
    expect(rule('.visual-editor .ProseMirror h2')).toContain('font-size: 1.75em')
    expect(rule('.visual-editor .ProseMirror p')).toContain('margin: .8em 0')
    expect(rule('.visual-editor .ProseMirror p')).toContain('padding: 0')
    expect(rule('.visual-editor .ProseMirror p')).toContain('line-height: inherit')
    expect(headings).toContain('font-family: var(--heading-latin-font), var(--heading-cjk-font), var(--ui-font-family)')
  })

  test('renders Milkdown inline hardbreak placeholders as preserved source line breaks', () => {
    const preservedBreak = rule(
      '.preserve-single-line-breaks\n  .visual-editor\n  .ProseMirror\n  span[data-type="hardbreak"][data-is-inline="true"]::after',
    )
    expect(preservedBreak).toContain('content: "\\A"')
    expect(preservedBreak).toContain('white-space: pre')
  })

  test('matches Typora tables, quotes, code, links, and rules', () => {
    expect(rule('.visual-editor .ProseMirror blockquote')).toContain('border-left: 0')
    expect(rule('.visual-editor .ProseMirror blockquote::before'))
      .toContain('background: rgb(var(--theme-color-rgb, 198 40 40))')
    const table = lastRule('.visual-editor .ProseMirror table')
    expect(table).toContain('table-layout: auto')
    expect(table).toContain('overflow: visible')
    expect(table).toContain('width: max-content')
    expect(table).toContain('min-width: 0')
    expect(rule('.visual-editor .ProseMirror .tableWrapper')).toContain('overflow-x: hidden')
    const resizeHandle = rule('.visual-editor .ProseMirror .column-resize-handle')
    expect(resizeHandle).toContain('cursor: col-resize')
    const tableCell = rule('.visual-editor .ProseMirror th,\n.visual-editor .ProseMirror td')
    expect(tableCell).toContain('padding: 6px 13px')
    expect(tableCell).toContain('vertical-align: middle')
    expect(rule('.visual-editor .ProseMirror th > p:last-of-type,\n.visual-editor .ProseMirror td > p:last-of-type'))
      .toContain('margin-bottom: 0')
    expect(rule('.visual-editor .ProseMirror code')).toContain('font-size: .9em')
    expect(rule('.visual-editor .ProseMirror a')).toContain('color: #4183c4')
    const horizontalRule = rule('.visual-editor .ProseMirror hr')
    expect(horizontalRule).toContain('block-size: 2px')
    expect(horizontalRule).toContain('height: 2px')
    expect(horizontalRule).toContain('min-block-size: 0')
    expect(horizontalRule).toContain('padding: 0')
    expect(horizontalRule).toContain('background: rgb(0 0 0 / 40%)')
    expect(horizontalRule).toContain('opacity: 1')
    expect(rule('.visual-editor .ProseMirror hr[data-arkdown-style="black-40-double"]'))
      .toContain('block-size: 4px')
    expect(rule('.visual-editor .ProseMirror hr[data-arkdown-style="black-40-quadruple"]'))
      .toContain('block-size: 8px')
  })

  test('matches task-list spacing, edge-list rhythm, and table alignment', () => {
    expect(css).toMatch(/task-list-item[\s\S]*?margin-left:\s*-\.65em/)
    expect(rule('.visual-editor .ProseMirror ul,\n.visual-editor .ProseMirror ol'))
      .toContain('padding-left: 0')
    expect(css).toMatch(/ProseMirror\s*>\s*(?:ul|ol):first-child[\s\S]*?margin-top:\s*0/)
    expect(css).toContain('[align="center"]')
    expect(css).toContain('text-align: center')
    expect(css).toContain('[align="right"]')
    expect(css).toContain('text-align: right')
  })

  test('uses the editor line box and a visible gap between adjacent Crepe list items', () => {
    expect(css).not.toContain('calc(1.6em + 2px)')
    expect(rule('.visual-editor .ProseMirror .milkdown-list-item-block\n  + .milkdown-list-item-block'))
      .toContain('margin-top: 10px')
    const listItem = rule('.visual-editor .ProseMirror .list-item')
    expect(listItem).toContain('gap: 10px')
    const labelWrapper = rule('.visual-editor .ProseMirror .list-item > .label-wrapper')
    expect(labelWrapper).toContain('width: 24px')
    expect(rule('.visual-editor .ProseMirror .milkdown-list-item-block\n  > .list-item\n  > .label-wrapper')).toContain('height: 1.6em')
    const label = rule('.visual-editor .ProseMirror .milkdown-list-item-block\n  > .list-item\n  > .label-wrapper\n  > .label')
    expect(label).toContain('height: 1.6em')
    expect(label).toContain('padding: 0')
    expect(label).toContain('line-height: 1.6')
    expect(label).toContain('color: currentColor')
    expect(label).toContain('opacity: 1')
    const checkbox = rule('.visual-editor .ProseMirror .task-list-item > input[type="checkbox"]')
    expect(checkbox).toContain('width: var(--task-checkbox-size, 25px)')
    expect(checkbox).toContain('height: var(--task-checkbox-size, 25px)')
    expect(checkbox).toContain('color: currentColor')
    expect(checkbox).toContain('accent-color: currentColor')
    expect(checkbox).toContain('opacity: 1')
    expect(rule('.visual-editor .ProseMirror ol\n  > .milkdown-list-item-block\n  > .list-item\n  > .label-wrapper\n  > .label.ordered::before')).toContain('color: #000')
    expect(rule('.visual-editor .ProseMirror :is(ol, ul) ul\n  > .milkdown-list-item-block\n  > .list-item\n  > .label-wrapper\n  > .label.bullet::before')).toContain('color: currentColor')
    expect(rule('.visual-editor .ProseMirror > ul\n  > .milkdown-list-item-block\n  > .list-item\n  > .label-wrapper\n  > .label.bullet')).toContain('transform: translate(4px, 0)')
    expect(rule('.visual-editor .ProseMirror :is(ol, ul) ul\n  > .milkdown-list-item-block\n  > .list-item\n  > .label-wrapper\n  > .label.bullet')).toContain('transform: none')
    const taskLabel = rule('.visual-editor .ProseMirror .milkdown-list-item-block\n  > .list-item\n  > .label-wrapper\n  > .label:is(.checked, .unchecked)')
    expect(taskLabel).toContain('color: currentColor')
    expect(taskLabel).toContain('transform: translateX(3px)')
    expect(taskLabel).not.toContain('translateY')
    expect(rule('.visual-editor .ProseMirror .milkdown-list-item-block\n  > .list-item\n  > .label-wrapper\n  > .label:is(.checked, .unchecked)\n  > svg')).toContain('fill: currentColor')
    expect(rule('.visual-editor .ProseMirror .milkdown-list-item-block\n  > .list-item\n  > .label-wrapper\n  > .label.bullet\n  > svg')).toContain('fill: currentColor')
    expect(css).toMatch(/content:\s*"▸";\s*font-size:\s*calc\(1em \+ 2px\)/)
    expect(css).toMatch(/content:\s*"›";\s*font-size:\s*calc\(1em \+ 2px\)/)
  })

  test('aligns real Crepe list items and removes only table edge paragraph margins', () => {
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
    document.body.innerHTML = `
      <div class="visual-editor">
        <div class="ProseMirror">
          <p id="outside-paragraph">Outside table</p>
          <div class="milkdown-list-item-block" id="first-list-item">
            <li class="list-item">
              <div class="label-wrapper"><span class="label">1.</span></div>
              <div class="children">
                <div data-content-dom="true">
                  <p id="first">First paragraph</p>
                  <p id="second">Second paragraph</p>
                </div>
              </div>
            </li>
          </div>
          <div class="milkdown-list-item-block" id="second-list-item">
            <li class="list-item">
              <div class="label-wrapper"><span class="label">2.</span></div>
              <div class="children">
                <div data-content-dom="true">
                  <p>Second item</p>
                </div>
              </div>
            </li>
          </div>
          <table>
            <tbody>
              <tr>
                <td>
                  <p id="table-first">First cell paragraph</p>
                  <p id="table-last">Last cell paragraph</p>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `

    try {
      expect(getComputedStyle(document.querySelector('#first')!).marginTop).toBe('0px')
      expect(getComputedStyle(document.querySelector('#second')!).marginTop).toBe('0.8em')
      expect(getComputedStyle(document.querySelector('#second-list-item')!).marginTop).toBe('10px')
      expect(getComputedStyle(document.querySelector('#table-first')!).marginTop).toBe('0px')
      expect(getComputedStyle(document.querySelector('#table-last')!).marginBottom).toBe('0px')
      expect(getComputedStyle(document.querySelector('#table-last')!).marginTop).toBe('0.8em')
      expect(getComputedStyle(document.querySelector('#outside-paragraph')!).marginTop).toBe('0.8em')
      expect(getComputedStyle(document.querySelector('#outside-paragraph')!).marginBottom).toBe('0.8em')
    } finally {
      style.remove()
      document.body.replaceChildren()
    }
  })

  test('uses text cursors by default, a hand only for Ctrl-hover, and dark blue locally', () => {
    expect(rule('.visual-editor .ProseMirror a')).toContain('cursor: text')
    expect(rule('.visual-editor .ProseMirror a.arkdown-link-openable')).toContain('cursor: pointer')
    expect(rule('.visual-editor .ProseMirror a.arkdown-local-link')).toContain('color: #1f4f82')
  })

  test('presents the manual link editor as a fixed popover with visible validation', () => {
    expect(rule('.arkdown-link-editor-popover')).toContain('position: fixed')
    expect(rule('.arkdown-link-editor-popover')).toContain('z-index: 1200')
    expect(rule('.arkdown-link-editor-popover')).toContain('max-height: calc(100vh - 16px)')
    expect(rule('.arkdown-link-editor-popover')).toContain('overflow-y: auto')
    expect(rule('.arkdown-link-editor-error')).toContain('color: #cf222e')
    expect(rule('.arkdown-link-editor-popover input[aria-invalid="true"]')).toContain('border-color: #cf222e')
  })


  test('uses the approved preference control states, sizes, typography, and alignment', () => {
    expect(preferencesSelectCss).toMatch(
      /\.preferences-select-trigger\s*\{[^}]*box-sizing:\s*border-box;[^}]*height:\s*32px;[^}]*min-height:\s*32px;[^}]*border:\s*1px solid #e8e8e8;[^}]*border-radius:\s*8px;[^}]*background:\s*#fff;[^}]*color:\s*#333;[^}]*font-size:\s*13px;[^}]*\}/s,
    )
    expect(preferencesSelectCss).toMatch(
      /\.preferences-select-trigger:hover:not\(:disabled\),\s*\.preferences-select-trigger:focus-visible\s*\{[^}]*background:\s*var\(--control-hover-layer\);[^}]*\}/s,
    )
    expect(preferencesSelectCss).toMatch(
      /\.preferences-select-trigger:active:not\(:disabled\),\s*\.preferences-select-trigger\[aria-expanded="true"\]:not\(:disabled\)\s*\{[^}]*background:\s*var\(--control-pressed-layer\);[^}]*\}/s,
    )
    expect(preferencesSelectCss).toMatch(
      /\.preferences-select-menu button\s*\{[^}]*height:\s*32px;[^}]*min-height:\s*32px;[^}]*font-size:\s*13px;[^}]*\}/s,
    )
    expect(preferencesSelectCss).toMatch(
      /\.preferences-select-menu button:hover:not\(:disabled\),\s*\.preferences-select-menu button:focus-visible\s*\{[^}]*background:\s*var\(--control-hover-layer\);[^}]*\}/s,
    )
    expect(preferencesSelectCss).toMatch(
      /\.preferences-select-option-label\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;[^}]*\}/s,
    )
    expect(preferencesSelectCss).toMatch(
      /\.preferences-select-menu button:active:not\(:disabled\)\s*\{[^}]*background:\s*var\(--control-pressed-layer\);[^}]*\}/s,
    )
    expect(preferencesCss).toMatch(
      /\.preferences-dialog input:not\(\[type="checkbox"\]\):not\(\[type="color"\]\):not\(\[type="range"\]\),\s*\.preferences-section input:not\(\[type="checkbox"\]\):not\(\[type="color"\]\):not\(\[type="range"\]\)\s*\{[^}]*box-sizing:\s*border-box;[^}]*height:\s*32px;[^}]*min-height:\s*32px;[^}]*\}/s,
    )
    expect(preferencesCss).toMatch(
      /\.preferences-page-actions button\s*\{[^}]*box-sizing:\s*border-box;[^}]*height:\s*32px;[^}]*font-size:\s*14px;[^}]*\}/s,
    )
    expect(arkdownDialogCss).toMatch(
      /\.arkdown-dialog\.arkdown-dialog \.arkdown-dialog__actions > button\s*\{[^}]*box-sizing:\s*border-box;[^}]*height:\s*32px;[^}]*font:\s*var\(--ui-font-weight-normal, 400\) 14px\/1\.4 var\(--ui-font-family, sans-serif\);[^}]*\}/s,
    )
    expect(largeModelCss).toMatch(
      /\.preferences-section \.large-model-assignment-controls \.preferences-field,\s*\.large-model-readonly-setting\s*\{[^}]*grid-template-rows:\s*auto 32px;[^}]*\}/s,
    )
    expect(preferencesCss).toMatch(
      /\.preferences-font-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 240px\)\);[^}]*gap:\s*0 33\.333px;[^}]*max-width:\s*100%;[^}]*\}/s,
    )
  })
  test('uses the shared bundled UI font for application, menu, preferences, and shared dialog text', () => {
    const uiStack = 'font-family: var(--ui-font-family)'
    expect(rule(':root')).toContain(uiStack)
    expect(rule('.source-editor .cm-scroller')).toContain("font-family: 'Fira Code', Menlo, Monaco, 'Courier New', Courier, monospace")
    expect(contextMenuCss).toContain(uiStack)
    expect(sourceRule(preferencesCss, '.preferences-page')).toContain(uiStack)
    expect(sourceRule(arkdownDialogCss, '.arkdown-dialog')).toContain(uiStack)
  })
})
