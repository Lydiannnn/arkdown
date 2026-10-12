import { expect, it } from 'vitest'
import { collectEnabledCommandIds } from '../../src/renderer/context-menu/context-menu-types'
import { buildVisualEditorMenu } from '../../src/renderer/editor/context-menu/editor-menu-model'
import { resolveEditorDomContext } from '../../src/renderer/editor/context-menu/editor-context'

it('uses the regular text menu for code blocks and exposes the active toggle', () => {
  const menu = buildVisualEditorMenu({
    kind: 'code',
    selectionText: '',
    activeBlocks: {
      blockquote: false,
      codeBlock: true,
      bulletList: false,
      orderedList: false,
      taskList: false,
      paragraphStyle: null,
    },
  })
  const ids = collectEnabledCommandIds(menu)
  const buttons = menu.flatMap((item) => item.kind === 'icon-grid' ? item.items : [])
  expect(ids).toContain('toggle-code-block')
  expect(ids).not.toContain('code-copy')
  expect(ids).toContain('code-language')
  expect(buttons.find((item) => item.id === 'toggle-code-block')).toMatchObject({
    checked: true,
  })
})

it.each(['<pre><code>value</code></pre>', '<div class="milkdown-code-block"><div class="cm-content">value</div></div>'])(
  'recognizes a code block from its actual DOM for the language menu: %s', (html) => {
    const host = document.createElement('div')
    host.innerHTML = html
    expect(resolveEditorDomContext(host.firstElementChild!.firstElementChild!, '').kind).toBe('code')
  },
)

it('keeps inline code in the regular text context', () => {
  const code = document.createElement('code')
  expect(resolveEditorDomContext(code, '').kind).toBe('text')
})
