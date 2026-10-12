import { describe, expect, it } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import {
  buildStructuredBlockInsertionTransaction,
  supportsYamlFrontmatterForDocument,
} from '../../src/renderer/editor/structured-block-insertion'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    code_block: {
      attrs: {
        language: { default: '' },
        frontmatter: { default: false },
      },
      content: 'text*',
      group: 'block',
      code: true,
      defining: true,
      marks: '',
    },
    text: { group: 'inline' },
  },
})

function stateWithCursor(text: string, position: number): EditorState {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, text ? schema.text(text) : undefined),
  ])
  return EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, position),
  })
}

function stateWithSelection(text: string, from: number, to: number): EditorState {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, text ? schema.text(text) : undefined),
  ])
  return EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, from, to),
  })
}

describe('buildStructuredBlockInsertionTransaction', () => {
  it.each([
    ['code', { language: '', frontmatter: false }],
    ['math', { language: 'LaTeX', frontmatter: false }],
  ] as const)('inserts a closed %s block and places the cursor inside it', (_label, descriptor) => {
    const state = stateWithCursor('alpha', 3)
    const transaction = buildStructuredBlockInsertionTransaction(state, descriptor)

    expect(transaction).not.toBeNull()
    const next = state.apply(transaction!)
    const inserted = Array.from({ length: next.doc.childCount }, (_, index) => next.doc.child(index))
      .find((node) => node.type.name === 'code_block')
    expect(inserted?.attrs).toMatchObject(descriptor)
    expect(next.selection.$from.parent.type.name).toBe('code_block')
    expect(next.selection.empty).toBe(true)
  })

  it.each([
    ['code', { language: '', frontmatter: false }],
    ['math', { language: 'LaTeX', frontmatter: false }],
  ] as const)('moves selected text into a newly inserted %s block', (_label, descriptor) => {
    const state = stateWithSelection('alpha beta', 1, 6)
    const transaction = buildStructuredBlockInsertionTransaction(state, descriptor)

    expect(transaction).not.toBeNull()
    const next = state.apply(transaction!)
    const inserted = Array.from({ length: next.doc.childCount }, (_, index) => next.doc.child(index))
      .find((node) => node.type.name === 'code_block')
    expect(inserted?.textContent).toBe('alpha')
    expect(next.selection.$from.parent).toBe(inserted)
    expect(next.selection.$from.parentOffset).toBe('alpha'.length)
  })

  it('splits an existing code block around text moved into a new formula block', () => {
    const doc = schema.node('doc', null, [
      schema.node(
        'code_block',
        { language: 'JavaScript', frontmatter: false },
        schema.text('alpha beta'),
      ),
    ])
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 7, 11),
    })

    const transaction = buildStructuredBlockInsertionTransaction(state, {
      language: 'LaTeX',
      frontmatter: false,
    })

    expect(transaction).not.toBeNull()
    const next = state.apply(transaction!)
    expect(next.doc.childCount).toBe(2)
    expect(next.doc.child(0).attrs).toMatchObject({ language: 'JavaScript' })
    expect(next.doc.child(0).textContent).toBe('alpha ')
    expect(next.doc.child(1).attrs).toMatchObject({ language: 'LaTeX' })
    expect(next.doc.child(1).textContent).toBe('beta')
    expect(next.selection.$from.parent).toBe(next.doc.child(1))
    expect(next.selection.$from.parentOffset).toBe('beta'.length)
  })

  it('inserts Front Matter only when the document is structurally empty', () => {
    const empty = stateWithCursor('', 1)
    const transaction = buildStructuredBlockInsertionTransaction(empty, {
      language: 'YAML',
      frontmatter: true,
    })

    expect(transaction).not.toBeNull()
    expect(empty.apply(transaction!).doc.firstChild?.attrs).toMatchObject({
      language: 'YAML',
      frontmatter: true,
    })
    expect(buildStructuredBlockInsertionTransaction(stateWithCursor('body', 2), {
      language: 'YAML',
      frontmatter: true,
    })).toBeNull()
  })

  it.each([
    [null, true],
    ['C:\\notes\\draft.md', true],
    ['C:\\notes\\draft.MARKDOWN', true],
    ['C:\\notes\\draft.txt', false],
    ['C:\\notes\\draft.docx', false],
  ] as const)('limits Front Matter insertion to Markdown documents (%s)', (documentPath, expected) => {
    expect(supportsYamlFrontmatterForDocument(documentPath)).toBe(expected)
  })

  it('fails closed when the schema has no code block', () => {
    const plainSchema = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { content: 'text*', group: 'block' },
        text: { group: 'inline' },
      },
    })
    const doc = plainSchema.node('doc', null, [plainSchema.node('paragraph')])
    const state = EditorState.create({ schema: plainSchema, doc })

    expect(buildStructuredBlockInsertionTransaction(state, { language: '' })).toBeNull()
    expect(state.doc.eq(doc)).toBe(true)
  })

  it('fails closed when the descriptor is invalid for the schema', () => {
    const state = stateWithCursor('', 1)
    expect(buildStructuredBlockInsertionTransaction(
      state,
      { language: null as unknown as string },
    )).toBeNull()
    expect(state.doc.childCount).toBe(1)
  })

  it('places the cursor in the newly inserted block when an identical block already exists', () => {
    const doc = schema.node('doc', null, [
      schema.node('code_block', { language: '', frontmatter: false }),
      schema.node('paragraph', null, schema.text('alpha')),
    ])
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 4),
    })

    const transaction = buildStructuredBlockInsertionTransaction(state, {
      language: '',
      frontmatter: false,
    })
    const next = state.apply(transaction!)

    expect(next.selection.$from.parent.type.name).toBe('code_block')
    expect(next.selection.from).toBeGreaterThan(doc.child(0).nodeSize)
  })
})
