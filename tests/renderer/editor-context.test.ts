import { describe, expect, it } from 'vitest'
import { resolveEditorDomContext } from '../../src/renderer/editor/context-menu/editor-context'

describe('resolveEditorDomContext', () => {
  it('treats a Mermaid preview image as Mermaid before the generic image menu', () => {
    const host = document.createElement('div')
    host.innerHTML = `
      <div class="arkdown-mermaid-block"
        data-arkdown-mermaid-mode="source"
        data-arkdown-mermaid-render-state="ready">
        <div class="arkdown-mermaid-preview">
          <img src="data:image/svg+xml;base64,QQ==" alt="Mermaid diagram">
        </div>
      </div>
    `

    expect(resolveEditorDomContext(host.querySelector('img'), '')).toMatchObject({
      kind: 'mermaid',
      mermaidMode: 'source',
      mermaidRenderState: 'ready',
      mermaidImageDataUrl: 'data:image/svg+xml;base64,QQ==',
    })
  })

  it('uses the documented object priority for nested editor elements', () => {
    const host = document.createElement('div')
    host.innerHTML = `
      <table><tbody><tr><td>
        <a href="https://example.com"><img src="C:\\notes\\photo.png" alt="Photo"></a>
      </td></tr></tbody></table>
    `
    expect(resolveEditorDomContext(host.querySelector('img'), 'selected')).toMatchObject({
      kind: 'image',
      source: 'C:\\notes\\photo.png',
      selectionText: 'selected',
    })
    expect(resolveEditorDomContext(host.querySelector('td'), '')).toEqual({
      kind: 'table',
      selectionText: '',
      table: {
        rowIndex: 0,
        rowCount: 1,
        columnIndex: 0,
        columnCount: 1,
      },
    })
  })

  it('identifies code blocks while preserving link, task list and plain text contexts', () => {
    const host = document.createElement('div')
    host.innerHTML = `
      <pre class="arkdown-code-wrap"><code>const answer = 42</code></pre>
      <p><a href="https://example.com">Example</a></p>
      <ul><li data-checked="true">Done</li></ul>
      <p class="plain">Plain</p>
    `
    expect(resolveEditorDomContext(host.querySelector('code'), '')).toEqual({
      kind: 'code',
      selectionText: '',
    })
    expect(resolveEditorDomContext(host.querySelector('a'), '')).toMatchObject({
      kind: 'link',
      href: 'https://example.com',
    })
    expect(resolveEditorDomContext(host.querySelector('li'), '')).toEqual({
      kind: 'text',
      selectionText: '',
    })
    expect(resolveEditorDomContext(host.querySelector('.plain'), 'text')).toEqual({
      kind: 'text',
      selectionText: 'text',
    })
  })

  it('keeps the fixed YAML frontmatter language outside the code language menu', () => {
    const host = document.createElement('div')
    host.innerHTML = '<div class="milkdown-code-block" data-arkdown-frontmatter="true"><pre><code>title: Note</code></pre></div>'
    expect(resolveEditorDomContext(host.querySelector('code'), '').kind).toBe('text')
  })
})
