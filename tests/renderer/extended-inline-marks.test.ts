import { defaultValueCtx, Editor, editorViewCtx, serializerCtx } from '@milkdown/kit/core'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyExtendedVisualInlineCommand,
  extendedInlineMarkPlugins,
} from '../../src/renderer/editor/extended-inline-marks'

const editors: Editor[] = []

afterEach(async () => {
  await Promise.all(editors.splice(0).map((editor) => editor.destroy()))
})

async function createEditor(markdown: string) {
  const editor = Editor.make().use(commonmark)
  for (const plugin of extendedInlineMarkPlugins) editor.use(plugin)
  editor.config((ctx) => ctx.set(defaultValueCtx, markdown))
  await editor.create()
  editors.push(editor)
  return editor
}

describe('extended inline mark Markdown round trips', () => {
  it('parses, edits, and serializes all exact HTML-backed mark syntaxes', async () => {
    const markdown = '<u>under</u> <mark>highlight</mark> <sup>2</sup> <sub>3</sub>'
    const editor = await createEditor(markdown)
    const view = editor.ctx.get(editorViewCtx)
    const serializer = editor.ctx.get(serializerCtx)
    const marks = new Set<string>()
    view.state.doc.descendants((node) => node.marks.forEach((mark) => marks.add(mark.type.name)))

    expect(marks).toEqual(new Set(['underline', 'highlight', 'superscript', 'subscript']))
    expect(serializer(view.state.doc).trimEnd()).toBe(markdown)
  })

  it('uses one transaction for marks and clears only approved inline styles', () => {
    const schema = new Schema({
      nodes: {
        doc: { content: 'paragraph+' },
        paragraph: { content: 'inline*' },
        text: { group: 'inline' },
        math_inline: { group: 'inline', inline: true, atom: true, attrs: { value: { default: '' } } },
      },
      marks: Object.fromEntries([
        'strong', 'emphasis', 'strike_through', 'inline_code',
        'underline', 'highlight', 'superscript', 'subscript',
      ].map((name) => [name, {}]).concat([['link', { attrs: { href: {} }, inclusive: false }]])),
    })
    const marks = schema.marks
    const text = schema.text('styled', [
      marks.strong!.create(),
      marks.underline!.create(),
      marks.link!.create({ href: 'https://example.com' }),
    ])
    const doc = schema.node('doc', null, schema.node('paragraph', null, text))
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, 7),
    })
    let dispatches = 0
    expect(applyExtendedVisualInlineCommand(state, (transaction) => {
      dispatches += 1
      state = state.apply(transaction)
    }, 'clear-inline-formatting')).toBe(true)
    expect(dispatches).toBe(1)
    expect(state.doc.nodeAt(1)?.marks.map((mark) => mark.type.name)).toEqual(['link'])
  })

  it('inserts and removes an inline formula deterministically', () => {
    const schema = new Schema({
      nodes: {
        doc: { content: 'paragraph+' },
        paragraph: { content: 'inline*' },
        text: { group: 'inline' },
        math_inline: { group: 'inline', inline: true, atom: true, attrs: { value: { default: '' } } },
      },
    })
    const doc = schema.node('doc', null, schema.node('paragraph', null, schema.text('x+y')))
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 4) })
    expect(applyExtendedVisualInlineCommand(state, (transaction) => {
      state = state.apply(transaction)
    }, 'toggle-inline-formula')).toBe(true)
    expect(state.selection).toBeInstanceOf(NodeSelection)
    expect((state.selection as NodeSelection).node.attrs.value).toBe('x+y')
    expect(applyExtendedVisualInlineCommand(state, (transaction) => {
      state = state.apply(transaction)
    }, 'toggle-inline-formula')).toBe(true)
    expect(state.doc.textContent).toBe('x+y')

    const collapsed = schema.node('doc', null, schema.node('paragraph'))
    state = EditorState.create({ doc: collapsed, selection: TextSelection.create(collapsed, 1) })
    expect(applyExtendedVisualInlineCommand(state, (transaction) => {
      state = state.apply(transaction)
    }, 'toggle-inline-formula')).toBe(true)
    expect(state.selection).toBeInstanceOf(NodeSelection)
    expect(applyExtendedVisualInlineCommand(state, (transaction) => {
      state = state.apply(transaction)
    }, 'toggle-inline-formula')).toBe(true)
    expect(state.doc.firstChild?.childCount).toBe(0)
    expect(state.selection.from).toBe(1)
  })
})
