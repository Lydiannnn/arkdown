import { expect, it } from 'vitest'
import { resolveEditorActiveBlocks } from '../../src/renderer/editor/context-menu/editor-active-blocks'

function doc(nodes: Array<{ type: { name: string }; attrs: Record<string, unknown> }>) {
  return {
    resolve: () => ({
      depth: nodes.length - 1,
      node: (depth: number) => nodes[depth]!,
    }),
  }
}

it('resolves code, quote and list ancestors at the clicked editor position', () => {
  expect(resolveEditorActiveBlocks(doc([
    { type: { name: 'doc' }, attrs: {} },
    { type: { name: 'blockquote' }, attrs: {} },
    { type: { name: 'bullet_list' }, attrs: {} },
    { type: { name: 'list_item' }, attrs: { checked: null } },
    { type: { name: 'paragraph' }, attrs: {} },
  ]), 1)).toEqual({
    blockquote: true,
    codeBlock: false,
    bulletList: true,
    orderedList: false,
    taskList: false,
    paragraphStyle: 'paragraph',
  })
})

it('shows task-list state instead of the underlying bullet-list state', () => {
  expect(resolveEditorActiveBlocks(doc([
    { type: { name: 'doc' }, attrs: {} },
    { type: { name: 'bullet_list' }, attrs: {} },
    { type: { name: 'list_item' }, attrs: { checked: false } },
    { type: { name: 'paragraph' }, attrs: {} },
  ]), 1)).toMatchObject({
    bulletList: false,
    taskList: true,
  })
})

it('resolves the current paragraph style', () => {
  expect(resolveEditorActiveBlocks(doc([
    { type: { name: 'doc' }, attrs: {} },
    { type: { name: 'paragraph' }, attrs: {} },
  ]), 1)).toMatchObject({
    paragraphStyle: 'paragraph',
  })
})

it('resolves the current heading level', () => {
  expect(resolveEditorActiveBlocks(doc([
    { type: { name: 'doc' }, attrs: {} },
    { type: { name: 'heading' }, attrs: { level: 4 } },
  ]), 1)).toMatchObject({
    paragraphStyle: 'heading-4',
  })
})

it('leaves the paragraph style empty for non-text blocks', () => {
  expect(resolveEditorActiveBlocks(doc([
    { type: { name: 'doc' }, attrs: {} },
    { type: { name: 'code_block' }, attrs: {} },
  ]), 1)).toMatchObject({
    paragraphStyle: null,
  })
})
