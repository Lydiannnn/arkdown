import { Schema } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { EditorView, type NodeViewConstructor } from '@milkdown/kit/prose/view'
import { expect, it, vi } from 'vitest'
import { createLocalMediaHtmlView, createLocalMarkdownImageView } from '../../src/renderer/editor/local-media-view'

vi.mock('@milkdown/kit/utils', () => ({ $view: (_schema: unknown, factory: () => unknown) => factory() }))

const schema = new Schema({ nodes: {
  doc: { content: 'paragraph+' }, paragraph: { content: 'inline*', toDOM: () => ['p', 0] },
  text: { group: 'inline' },
  html: { inline: true, group: 'inline', attrs: { value: {} }, toDOM: () => ['span'] },
  image: { inline: true, group: 'inline', attrs: { src: {} }, toDOM: () => ['img'] },
} })

it.each(['html', 'markdown'] as const)('uses the current document base on %s image view creation and update', (syntax) => {
  let path = 'C:\\Notes\\note.md'
  const factory = (syntax === 'html'
    ? createLocalMediaHtmlView(undefined, true, () => path)
    : createLocalMarkdownImageView(undefined, () => path)) as unknown as NodeViewConstructor
  const node = syntax === 'html'
    ? schema.node('html', { value: '<img src="assets/a.png" width="240" height="120">' })
    : schema.node('image', { src: 'assets/a.png' })
  const view = new EditorView(document.createElement('div'), { state: EditorState.create({ doc: schema.node('doc', null, schema.node('paragraph', null, node)) }) })
  const created = factory(node, view, () => 1, [], {} as never)
  const image = (created.dom as HTMLElement).querySelector('img')!
  expect(image?.dataset.source).toBe('C:\\Notes\\assets\\a.png')
  if (syntax === 'html') {
    expect(image?.getAttribute('width')).toBe('240')
    expect(image.style.width).toBe('240px')
    expect(image.style.height).toBe('120px')
  }
  path = 'D:\\Copies\\saved.md'
  expect(created.update?.(node, [], {} as never)).toBe(true)
  expect(image.dataset.source).toBe('D:\\Copies\\assets\\a.png')
  expect((created.dom as HTMLElement).querySelector('img')?.getAttribute('src')).toContain('D%3A%5CCopies%5Cassets%5Ca.png')
  created.destroy?.()
  view.destroy()
})
