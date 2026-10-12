import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { describe, expect, it } from 'vitest'
import {
  resolveSourceInlineFormatStates,
  resolveVisualInlineFormatStates,
} from '../../src/renderer/editor/context-menu/inline-format-state'

const formatNames = [
  'strike',
  'underline',
  'highlight',
  'superscript',
  'subscript',
] as const

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    hard_break: { inline: true, group: 'inline' },
  },
  marks: {
    strike_through: {},
    underline: {},
    highlight: {},
    superscript: {},
    subscript: {},
  },
})

describe('resolveVisualInlineFormatStates', () => {
  it('reports all five current marks at a collapsed caret', () => {
    const marks = Object.values(schema.marks).map((mark) => mark.create())
    const doc = schema.node('doc', null, schema.node(
      'paragraph',
      null,
      schema.text('xy', marks),
    ))
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 2),
    })

    expect(resolveVisualInlineFormatStates(state)).toEqual({
      strike: 'on',
      underline: 'on',
      highlight: 'on',
      superscript: 'on',
      subscript: 'on',
    })
  })

  it('prefers stored marks for a collapsed caret', () => {
    const doc = schema.node('doc', null, schema.node('paragraph', null, schema.text('xy')))
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 2),
      storedMarks: [schema.marks.highlight!.create()],
    })

    expect(resolveVisualInlineFormatStates(state).highlight).toBe('on')
    expect(resolveVisualInlineFormatStates(state).underline).toBe('off')
  })

  it.each(formatNames)('reports a fully selected %s range as on', (format) => {
    const markName = format === 'strike' ? 'strike_through' : format
    const doc = schema.node('doc', null, schema.node(
      'paragraph',
      null,
      schema.text('marked', [schema.marks[markName]!.create()]),
    ))
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1, 7),
    })

    expect(resolveVisualInlineFormatStates(state)[format]).toBe('on')
  })

  it('reports a marked and unmarked textual range as mixed', () => {
    const doc = schema.node('doc', null, schema.node('paragraph', null, [
      schema.text('yes', [schema.marks.underline!.create()]),
      schema.text(' no'),
    ]))
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1, 7),
    })

    expect(resolveVisualInlineFormatStates(state).underline).toBe('mixed')
  })

  it('does not infer on from a range containing no textual segment', () => {
    const doc = schema.node('doc', null, schema.node('paragraph', null, schema.node('hard_break')))
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1, 2),
    })

    expect(resolveVisualInlineFormatStates(state)).toEqual({
      strike: 'off',
      underline: 'off',
      highlight: 'off',
      superscript: 'off',
      subscript: 'off',
    })
  })
})

describe('resolveSourceInlineFormatStates', () => {
  it.each([
    ['strike', '~~text~~', 2, 6],
    ['underline', '<u>text</u>', 3, 7],
    ['highlight', '<mark>text</mark>', 6, 10],
    ['superscript', '<sup>text</sup>', 5, 9],
    ['subscript', '<sub>text</sub>', 5, 9],
  ] as const)('reports a selection wholly inside a balanced %s wrapper as on', (
    format,
    markdown,
    from,
    to,
  ) => {
    expect(resolveSourceInlineFormatStates(markdown, from, to)[format]).toBe('on')
    expect(resolveSourceInlineFormatStates(markdown, from + 1, from + 1)[format]).toBe('on')
  })

  it('reports every nested balanced wrapper as on at the caret', () => {
    const markdown = '~~<u><mark><sup><sub>x</sub></sup></mark></u>~~'
    const caret = markdown.indexOf('x')

    expect(resolveSourceInlineFormatStates(markdown, caret, caret)).toEqual({
      strike: 'on',
      underline: 'on',
      highlight: 'on',
      superscript: 'on',
      subscript: 'on',
    })
  })

  it.each([
    ['opening', String.raw`\~~text~~`, 'off'],
    ['opening', String.raw`\\~~text~~`, 'on'],
    ['closing', String.raw`~~text\~~`, 'mixed'],
    ['closing', String.raw`~~text\\~~`, 'on'],
  ] as const)('uses backslash parity for an escaped %s strike delimiter', (
    _delimiter,
    markdown,
    expected,
  ) => {
    const caret = markdown.indexOf('text') + 1

    expect(resolveSourceInlineFormatStates(markdown, caret, caret).strike).toBe(expected)
  })

  it.each([
    ['opening', String.raw`\<u>text</u>`, 'off'],
    ['opening', String.raw`\\<u>text</u>`, 'on'],
    ['closing', String.raw`<u>text\</u>`, 'mixed'],
    ['closing', String.raw`<u>text\\</u>`, 'on'],
  ] as const)('uses backslash parity for an escaped HTML %s token', (
    _token,
    markdown,
    expected,
  ) => {
    const caret = markdown.indexOf('text') + 1

    expect(resolveSourceInlineFormatStates(markdown, caret, caret).underline).toBe(expected)
  })

  it('distinguishes partial and ambiguous overlaps from no containment', () => {
    expect(resolveSourceInlineFormatStates('before <u>text</u> after', 4, 12).underline)
      .toBe('mixed')
    expect(resolveSourceInlineFormatStates('before <u>text', 10, 13).underline)
      .toBe('mixed')
    expect(resolveSourceInlineFormatStates('before <u>text</u>', 0, 6).underline)
      .toBe('off')
  })

  it('treats crossed HTML wrappers as ambiguous instead of balanced', () => {
    const markdown = '<u><mark>x</u></mark>'
    const caret = markdown.indexOf('x')

    expect(resolveSourceInlineFormatStates(markdown, caret, caret)).toMatchObject({
      underline: 'mixed',
      highlight: 'mixed',
    })
  })

  it('recovers after crossed HTML wrappers before a later balanced wrapper', () => {
    const markdown = '<u><mark>x</u></mark> <u>y</u>'
    const malformedCaret = markdown.indexOf('x')
    const recoveredCaret = markdown.indexOf('y')

    expect(resolveSourceInlineFormatStates(markdown, malformedCaret, malformedCaret))
      .toMatchObject({ underline: 'mixed', highlight: 'mixed' })
    expect(resolveSourceInlineFormatStates(markdown, recoveredCaret, recoveredCaret))
      .toMatchObject({ underline: 'on', highlight: 'off' })
  })
})
