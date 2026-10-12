import { defaultValueCtx, Editor, editorViewCtx, remarkCtx, serializerCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { type Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { afterEach, describe, expect, it } from 'vitest'
import { createTaskCheckboxSerializer } from '../../src/renderer/editor/task-checkbox-serialization'
import { computeLineEditIndicators } from '../../src/renderer/editor/edit-indicators/line-diff'
import { frontmatterEditorPlugins } from '../../src/renderer/editor/frontmatter-code-block'
import { scanMarkdownLogicalBlocks } from '../../src/renderer/editor/edit-indicators/markdown-logical-blocks'
import { describeVisualLogicalBlocks } from '../../src/renderer/editor/visual-logical-blocks'

const editors: Editor[] = []
afterEach(async () => {
  await Promise.all(editors.splice(0).map(editor => editor.destroy()))
  document.body.replaceChildren()
})

async function fixture(markdown: string) {
  const editor = Editor.make().use(commonmark).use(gfm)
    .config(ctx => ctx.set(defaultValueCtx, markdown))
  for (const plugin of frontmatterEditorPlugins) editor.use(plugin)
  await editor.create()
  editors.push(editor)
  const view = editor.ctx.get(editorViewCtx)
  const fallback = editor.ctx.get(serializerCtx)
  const serialize = createTaskCheckboxSerializer(view.state.doc, markdown, fallback, source => editor.ctx.get(remarkCtx).parse(source))
  const toggle = (index: number, checked: boolean) => {
    let taskIndex = 0
    view.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'list_item' || typeof node.attrs.checked !== 'boolean') return
      if (taskIndex++ === index) view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked }))
    })
    return serialize(view.state.doc)
  }
  return { view, fallback, serialize, toggle }
}

describe('task checkbox source preservation', () => {
  it('changes one checkbox in a 106-item tight list without reformatting other lines', async () => {
    const opening = '# 手测清单\n\n' + Array.from({ length: 106 }, (_, i) =>
      `- [ ] **${i + 1}｜验收**：确认 \`Ctrl+S\` 与 [链接](https://example.com) 正常。`,
    ).join('\n') + '\n'
    const { toggle, view } = await fixture(opening)
    const current = toggle(52, true)
    expect(current).toBe(opening.replace('- [ ] **53｜', '- [x] **53｜'))
    const snapshot = computeLineEditIndicators({ openingMarkdown: opening, savedMarkdown: opening, currentMarkdown: current })
    expect(snapshot.states.filter(state => state === 'unsaved')).toHaveLength(1)
    expect(scanMarkdownLogicalBlocks(current, snapshot.states).map(block => block.semanticFingerprint))
      .toEqual(describeVisualLogicalBlocks(view.state.doc).map(block => block.semanticFingerprint))
    expect(toggle(53, true)).toBe(current.replace('- [ ] **54｜', '- [x] **54｜'))
    expect(toggle(52, false)).toBe(opening.replace('- [ ] **54｜', '- [x] **54｜'))
    expect(toggle(53, false)).toBe(opening)
  })

  it('ignores checkbox examples inside YAML frontmatter using the editor parser', async () => {
    const opening = '---\ndescription: |\n  - [ ] Fake task\n---\n\n- [ ] Real one\n- [ ] Real two\n'
    const { toggle } = await fixture(opening)
    expect(toggle(0, true)).toBe(opening.replace('- [ ] Real one', '- [x] Real one'))
  })

  it('preserves CRLF, marker styles, nesting, quotes, uppercase X and literal checkbox text', async () => {
    const opening = ['# Tasks', '', '> + [X] Parent', '>   - [ ] Child', '',
      '1. [ ] **Ordered**', '2. Ordinary', '', '```md', '- [ ] code sample', '```', '',
      'Literal \\[ \\] text', '', '* [ ] Last', ''].join('\r\n')
    const { toggle } = await fixture(opening)
    const changed = toggle(1, true)
    expect(changed).toBe(opening.replace('- [ ] Child', '- [x] Child'))
    expect(toggle(0, false)).toBe(changed.replace('+ [X]', '+ [ ]'))
    expect(toggle(0, true)).toBe(changed)
    expect(toggle(2, true)).toBe(changed.replace('1. [ ]', '1. [x]'))
  })

  it('serializes actual text edits and uses that result as the next checkbox baseline', async () => {
    const { view, serialize, fallback, toggle } = await fixture('- [ ] First\n- [ ] Second\n')
    view.dispatch(view.state.tr.insertText(' edited', 8))
    const changed = serialize(view.state.doc)
    expect(changed).toBe(fallback(view.state.doc))
    expect(changed).toContain('edited')
    expect(toggle(1, true)).toBe(changed.replace('[ ] Second', '[x] Second'))
  })

  it('falls back safely when the source and parsed tasks cannot be matched', async () => {
    const { view, fallback } = await fixture('- [ ] Actual\n')
    const serialize = createTaskCheckboxSerializer(view.state.doc, 'different source', fallback)
    const item = view.state.doc.firstChild!.firstChild!
    const changed = view.state.tr.setNodeMarkup(1, undefined, { ...item.attrs, checked: true }).doc
    expect(serialize(changed)).toBe(fallback(changed))
  })

  it('does not hide structural or formatting changes accompanying a checkbox change', async () => {
    const { view, serialize, fallback } = await fixture('- [ ] First\n- [ ] Second\n')
    let tr = view.state.tr
    view.state.doc.descendants((node: ProseMirrorNode, pos: number) => {
      if (node.type.name === 'list_item') tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: true })
    })
    tr = tr.addMark(3, 8, view.state.schema.marks.strong!.create())
    expect(serialize(tr.doc)).toBe(fallback(tr.doc))
  })
})
