import { describe, expect, it } from 'vitest'
import {
  createLogicalBlockSemanticFingerprint,
  scanMarkdownLogicalBlocks,
} from '../../src/renderer/editor/edit-indicators/markdown-logical-blocks'

describe('scanMarkdownLogicalBlocks', () => {
  it('keeps intraword underscores in filenames when matching task semantics', () => {
    const markdown = '- [x] **Package**: read THIRD_PARTY_NOTICES.md and __bold__ text.'
    expect(scanMarkdownLogicalBlocks(markdown, ['unsaved'])[0]?.semanticFingerprint)
      .toBe('["list-item",["Package: read THIRD_PARTY_NOTICES.md and bold text."],0]')
  })
  it('keeps emphasis boundaries before adjacent links while retaining underscores in link labels', () => {
    const markdown = '- [ ] _a_[b](https://example.com)c [THIRD_PARTY](https://example.com)'
    expect(scanMarkdownLogicalBlocks(markdown, ['none'])[0]?.semanticFingerprint)
      .toBe('["list-item",["abc THIRD_PARTY"],0]')
  })
  it('requires one state per visible line and treats an empty document as one blank line', () => {
    expect(() => scanMarkdownLogicalBlocks('one\ntwo', ['none'])).toThrow(/visible line/i)
    expect(scanMarkdownLogicalBlocks('', ['none'])).toEqual([])
  })

  it('describes paragraphs and ATX/Setext headings with inclusive source ranges', () => {
    expect(scanMarkdownLogicalBlocks([
      '# Heading',
      'first paragraph',
      'continues here',
      '',
      'Setext heading',
      '===',
      'last paragraph',
    ].join('\n'), [
      'none', 'saved', 'unsaved', 'none', 'none', 'saved', 'none',
    ])).toEqual([
      {
        index: 0,
        kind: 'heading',
        fromLine: 0,
        toLine: 0,
        semanticFingerprint: '["heading",["Heading"],0]',
        state: 'none',
      },
      {
        index: 1,
        kind: 'paragraph',
        fromLine: 1,
        toLine: 2,
        semanticFingerprint: '["paragraph",["first paragraph continues here"],0]',
        state: 'unsaved',
        lineStates: ['saved', 'unsaved'],
      },
      {
        index: 2,
        kind: 'heading',
        fromLine: 4,
        toLine: 5,
        semanticFingerprint: '["heading",["Setext heading"],0]',
        state: 'saved',
      },
      {
        index: 3,
        kind: 'paragraph',
        fromLine: 6,
        toLine: 6,
        semanticFingerprint: '["paragraph",["last paragraph"],0]',
        state: 'none',
      },
    ])
  })

  it('preserves physical line states inside a source-contiguous paragraph', () => {
    expect(scanMarkdownLogicalBlocks(
      'alpha\nbeta\ngamma',
      ['none', 'unsaved', 'none'],
    )).toEqual([{
      index: 0,
      kind: 'paragraph',
      fromLine: 0,
      toLine: 2,
      semanticFingerprint: '["paragraph",["alpha beta gamma"],0]',
      state: 'unsaved',
      lineStates: ['none', 'unsaved', 'none'],
    }])
  })

  it('groups list continuations and outer blockquotes while keeping items distinct', () => {
    const markdown = [
      '- [x] first **item**',
      '  continuation',
      '* second item',
      '',
      '> quoted [label](https://example.com)',
      '> continues with ![alt](image.png)',
    ].join('\n')

    expect(scanMarkdownLogicalBlocks(markdown, [
      'none', 'saved', 'none', 'none', 'saved', 'unsaved',
    ])).toEqual([
      {
        index: 0,
        kind: 'list-item',
        fromLine: 0,
        toLine: 1,
        semanticFingerprint: '["list-item",["first item continuation"],0]',
        state: 'saved',
      },
      {
        index: 1,
        kind: 'list-item',
        fromLine: 2,
        toLine: 2,
        semanticFingerprint: '["list-item",["second item"],0]',
        state: 'none',
      },
      {
        index: 2,
        kind: 'blockquote',
        fromLine: 4,
        toLine: 5,
        semanticFingerprint: '["blockquote",["quoted label continues with alt"],0]',
        state: 'unsaved',
      },
    ])
  })

  it('keeps a blank-separated indented paragraph inside its loose list item', () => {
    const markdown = [
      '1. first item',
      '',
      '   continuation paragraph',
      '2. second item',
    ].join('\n')

    expect(scanMarkdownLogicalBlocks(markdown, [
      'none', 'none', 'saved', 'none',
    ])).toEqual([
      {
        index: 0,
        kind: 'list-item',
        fromLine: 0,
        toLine: 2,
        semanticFingerprint: '["list-item",["first item continuation paragraph"],0]',
        state: 'saved',
      },
      {
        index: 1,
        kind: 'list-item',
        fromLine: 3,
        toLine: 3,
        semanticFingerprint: '["list-item",["second item"],0]',
        state: 'none',
      },
    ])
  })

  it('normalizes fenced and indented code to code content while preserving whitespace', () => {
    const fenced = scanMarkdownLogicalBlocks([
      '```ts',
      'const  value = 1',
      '```',
    ].join('\n'), ['saved', 'none', 'none'])
    const tilde = scanMarkdownLogicalBlocks([
      '~~~javascript',
      'const  value = 1',
      '~~~',
    ].join('\n'), ['none', 'none', 'none'])
    const indented = scanMarkdownLogicalBlocks('    const  value = 1', ['unsaved'])

    expect(fenced).toEqual([{
      index: 0,
      kind: 'code-block',
      fromLine: 0,
      toLine: 2,
      semanticFingerprint: '["code-block",["const  value = 1"],0]',
      state: 'saved',
    }])
    expect(tilde[0]?.semanticFingerprint).toBe(fenced[0]?.semanticFingerprint)
    expect(indented).toEqual([{
      index: 0,
      kind: 'code-block',
      fromLine: 0,
      toLine: 0,
      semanticFingerprint: '["code-block",["const  value = 1"],0]',
      state: 'unsaved',
    }])
  })

  it('emits table content rows as separate cell parts and skips separator rows', () => {
    const markdown = [
      '| Name | Value |',
      '| :--- | ---: |',
      '| A \\| B | `x|y` |',
    ].join('\n')

    expect(scanMarkdownLogicalBlocks(markdown, ['saved', 'unsaved', 'none'])).toEqual([
      {
        index: 0,
        kind: 'table-row',
        fromLine: 0,
        toLine: 0,
        semanticFingerprint: '["table-row",["Name","Value"],0]',
        state: 'saved',
      },
      {
        index: 1,
        kind: 'table-row',
        fromLine: 2,
        toLine: 2,
        semanticFingerprint: '["table-row",["A | B","x|y"],0]',
        state: 'none',
      },
    ])
  })

  it('keeps repeated semantic peers distinct and canonicalizes equivalent Markdown spellings', () => {
    const blocks = scanMarkdownLogicalBlocks([
      '## Cafe\u0301 **bold** and [label](url)',
      '',
      'Café bold   and label',
      '-------------------------',
      '',
      '1. same',
      '+ same',
      '- same',
    ].join('\n'), Array(8).fill('none'))

    expect(blocks.map(({ kind, semanticFingerprint }) => ({ kind, semanticFingerprint })))
      .toEqual([
        { kind: 'heading', semanticFingerprint: '["heading",["Café bold and label"],0]' },
        { kind: 'heading', semanticFingerprint: '["heading",["Café bold and label"],1]' },
        { kind: 'list-item', semanticFingerprint: '["list-item",["same"],0]' },
        { kind: 'list-item', semanticFingerprint: '["list-item",["same"],1]' },
        { kind: 'list-item', semanticFingerprint: '["list-item",["same"],2]' },
      ])
  })

  it('creates unambiguous canonical fingerprints without collapsing code whitespace', () => {
    expect(createLogicalBlockSemanticFingerprint({
      kind: 'paragraph',
      semanticParts: ['  Cafe\u0301   `x  y`  '],
      occurrence: 2,
    })).toBe('["paragraph",["Café `x y`"],2]')
    expect(createLogicalBlockSemanticFingerprint({
      kind: 'code-block',
      semanticParts: ['  Cafe\u0301   x  y  '],
      occurrence: 2,
    })).toBe('["code-block",["  Café   x  y  "],2]')
  })

  it('preserves escaped emphasis markers and code-span punctuation without collisions', () => {
    const fingerprint = (markdown: string) => (
      scanMarkdownLogicalBlocks(markdown, ['none'])[0]?.semanticFingerprint
    )

    expect(fingerprint('\\*literal\\*'))
      .toBe('["paragraph",["*literal*"],0]')
    expect(fingerprint('*literal*')).toBe(fingerprint('literal'))
    expect(fingerprint('`a_b`')).toBe('["paragraph",["a_b"],0]')
    expect(fingerprint('`a_b`')).not.toBe(fingerprint('ab'))
  })

  it('canonicalizes CommonMark autolinks without collapsing escaped angle-bracket text', () => {
    const delAutolink = `<https://example.com/${String.fromCharCode(0x7f)}>`
    const markdown = [
      '<https://example.com/docs>',
      '',
      '[https://example.com/docs](https://example.com/docs)',
      '',
      '<user@example.com>',
      '',
      '<mailto:user@example.com>',
      '',
      '<https://example.com/a_b~c?q=x_y>',
      '',
      '<foo_bar@example.com>',
      '',
      '<mailto:foo_bar@example.com>',
      '',
      '<https://example.com/\\_x>',
      '',
      delAutolink,
      '',
      '<foo!bar@example.com>',
      '',
      '`<https://example.com/docs>`',
      '',
      '\\<https://example.com/docs\\>',
      '',
      '<https://example.com/docs>',
    ].join('\n')
    const blocks = scanMarkdownLogicalBlocks(
      markdown,
      markdown.split('\n').map(() => 'none'),
    )

    expect(blocks.map(({ semanticFingerprint }) => semanticFingerprint)).toEqual([
      '["paragraph",["https://example.com/docs"],0]',
      '["paragraph",["https://example.com/docs"],1]',
      '["paragraph",["user@example.com"],0]',
      '["paragraph",["mailto:user@example.com"],0]',
      '["paragraph",["https://example.com/a_b~c?q=x_y"],0]',
      '["paragraph",["foo_bar@example.com"],0]',
      '["paragraph",["mailto:foo_bar@example.com"],0]',
      '["paragraph",["https://example.com/\\\\_x"],0]',
      JSON.stringify(['paragraph', [delAutolink], 0]),
      '["paragraph",["<foo!bar@example.com>"],0]',
      '["paragraph",["<https://example.com/docs>"],0]',
      '["paragraph",["<https://example.com/docs>"],1]',
      '["paragraph",["https://example.com/docs"],2]',
    ])
  })

  it('removes every structural marker from nested blockquote semantics', () => {
    const nested = scanMarkdownLogicalBlocks('> > nested', ['none'])
    const equivalent = scanMarkdownLogicalBlocks('> nested', ['none'])

    expect(nested[0]?.semanticFingerprint)
      .toBe('["blockquote",["nested"],0]')
    expect(nested[0]?.semanticFingerprint).toBe(equivalent[0]?.semanticFingerprint)
  })

  it('keeps literal user PUA token text while resolving an escaped value', () => {
    const userToken = '\uE0000\uE001'
    const block = scanMarkdownLogicalBlocks(`${userToken} \\*x\\*`, ['none'])[0]

    expect(block?.semanticFingerprint).toBe(JSON.stringify([
      'paragraph', [`${userToken} *x*`], 0,
    ]))
  })

  it('does not recursively replace token-shaped text restored from protected code', () => {
    const laterToken = '\uE0001\uE001'
    const block = scanMarkdownLogicalBlocks(`\`${laterToken}\` \\*`, ['none'])[0]

    expect(block?.semanticFingerprint).toBe(JSON.stringify([
      'paragraph', [`${laterToken} *`], 0,
    ]))
  })
})
