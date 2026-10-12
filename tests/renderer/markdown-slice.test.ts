import { Schema } from '@milkdown/kit/prose/model'
import { describe, expect, it } from 'vitest'
import { parseMarkdownInsertionSlice } from '../../src/renderer/editor/markdown-slice'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
  },
})

const parser = (markdown: string) => schema.node(
  'doc',
  null,
  markdown.split(/\r?\n/u).map((line) => schema.node(
    'paragraph',
    null,
    line ? schema.text(line) : undefined,
  )),
)

describe('parseMarkdownInsertionSlice', () => {
  it('inserts a single logical line as inline content without a paragraph break', () => {
    const slice = parseMarkdownInsertionSlice(parser, schema, 'alpha')
    expect(slice.openStart).toBe(0)
    expect(slice.openEnd).toBe(0)
    expect(slice.content.childCount).toBe(1)
    expect(slice.content.firstChild?.isText).toBe(true)
  })

  it('preserves each real clipboard newline as a block boundary', () => {
    const slice = parseMarkdownInsertionSlice(parser, schema, 'alpha\nbeta')
    expect(slice.openStart).toBe(1)
    expect(slice.openEnd).toBe(1)
    expect(slice.content.childCount).toBe(2)
    expect(slice.content.child(0).textContent).toBe('alpha')
    expect(slice.content.child(1).textContent).toBe('beta')
  })
})
