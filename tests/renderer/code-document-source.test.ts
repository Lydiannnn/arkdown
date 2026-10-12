import { describe, expect, it } from 'vitest'
import { ChangeSet, EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { applyCodeDocumentChanges, normalizeCodeDocumentText, loadCodeDocumentLanguage } from '../../src/renderer/editor/code-document-language'

describe('faithful source text editing', () => {
  it('retains the original terminators, indentation and trailing newline across disjoint changes', () => {
    const raw = 'one\r\n\ttwo\nthree\rfour\r\n'
    const changes = ChangeSet.of([{ from: 0, to: 3, insert: 'ONE' }, { from: 9, to: 14, insert: 'THREE' }], normalizeCodeDocumentText(raw).length)
    expect(applyCodeDocumentChanges(raw, changes)).toBe('ONE\r\n\ttwo\nTHREE\rfour\r\n')
  })
  it('uses the first existing terminator for inserted lines and preserves untouched boundaries', () => {
    const raw = 'one\r\ntwo\nthree'
    const changes = ChangeSet.of({ from: 4, insert: 'new\n' }, normalizeCodeDocumentText(raw).length)
    expect(applyCodeDocumentChanges(raw, changes)).toBe('one\r\nnew\r\ntwo\nthree')
  })
  it('handles deletions spanning mixed terminators and empty files', () => {
    expect(applyCodeDocumentChanges('a\r\nb\nc', ChangeSet.of({ from: 1, to: 4 }, 5))).toBe('ac')
    expect(applyCodeDocumentChanges('', ChangeSet.of({ from: 0, insert: '\t<x>\n' }, 0))).toBe('\t<x>\n')
  })
})

it.each([
  ['a.json', '{"a":true}', 'JsonText'],
  ['a.cjs', 'const a = true', 'Script'],
  ['a.ts', 'const a: number = 1', 'Script'],
  ['a.py', 'print(1)', 'Script'],
  ['a.yaml', 'a: true', 'Stream'],
  ['a.html', '<p>text</p>', 'Document'],
  ['a.css', 'p { color: red }', 'StyleSheet'],
])('loads only the requested language support for %s', async (name, source, root) => {
  const state = EditorState.create({ doc: source, extensions: await loadCodeDocumentLanguage(name) })
  expect(syntaxTree(state).type.name).toBe(root)
})

it('keeps unknown code families as plain source', async () => {
  expect(await loadCodeDocumentLanguage('a.unknown')).toEqual([])
})
