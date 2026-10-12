import { Schema } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { describe, expect, it, vi } from 'vitest'
import {
  deleteImageAtPosition,
  replaceImageSyntaxAtPosition,
  updateLinkAtPosition,
} from '../../src/renderer/editor/context-menu/object-transactions'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    image: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: {
        src: { default: '' },
        alt: { default: '' },
        title: { default: '' },
      },
    },
    html: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: { value: { default: '' } },
    },
  },
  marks: {
    link: {
      attrs: {
        href: {},
        title: { default: null },
      },
    },
  },
})

function testView(state: EditorState) {
  let current = state
  const dispatch = vi.fn((transaction: ReturnType<typeof state.tr.setMeta>) => {
    current = current.apply(transaction)
  })
  return {
    get state() { return current },
    dispatch,
  }
}

describe('image syntax transactions', () => {
  it('replaces the existing HTML image atom with one Markdown image atom', () => {
    const html = schema.nodes.html!.create({
      value: '<img src="C:\\Photos\\photo.png" alt="照片" style="zoom:100%;" />',
    })
    const view = testView(EditorState.create({
      schema,
      doc: schema.nodes.doc!.create(undefined, [
        schema.nodes.paragraph!.create(undefined, html),
      ]),
    }))

    expect(replaceImageSyntaxAtPosition(
      view,
      1,
      'markdown',
      'C:\\Photos\\photo.png',
      '照片',
      100,
    )).toBe(true)

    expect(view.state.doc.child(0).childCount).toBe(1)
    expect(view.state.doc.child(0).child(0).type.name).toBe('image')
    expect(view.state.doc.child(0).child(0).attrs).toMatchObject({
      src: 'C:\\Photos\\photo.png',
      alt: '照片',
    })
  })

  it('replaces a Markdown image atom with one canonical HTML image atom', () => {
    const image = schema.nodes.image!.create({
      src: 'C:\\Photos\\photo.png',
      alt: '照片',
      title: '',
    })
    const view = testView(EditorState.create({
      schema,
      doc: schema.nodes.doc!.create(undefined, [
        schema.nodes.paragraph!.create(undefined, image),
      ]),
    }))

    expect(replaceImageSyntaxAtPosition(
      view,
      1,
      'html',
      'C:\\Photos\\photo.png',
      '照片',
      null,
    )).toBe(true)

    const converted = view.state.doc.child(0).child(0)
    expect(converted.type.name).toBe('html')
    expect(converted.attrs.value).toBe(
      '<img src="C:\\Photos\\photo.png" alt="照片" '
      + 'style="display:block;margin-left:auto;margin-right:auto;" />',
    )
  })

  it('deletes only the selected image atom', () => {
    const image = schema.nodes.image!.create({
      src: 'C:\\Photos\\photo.png',
      alt: '照片',
      title: '',
    })
    const view = testView(EditorState.create({
      schema,
      doc: schema.nodes.doc!.create(undefined, [
        schema.nodes.paragraph!.create(undefined, [
          schema.text('前'),
          image,
          schema.text('后'),
        ]),
      ]),
    }))

    expect(deleteImageAtPosition(view, 2)).toBe(true)
    expect(view.state.doc.textContent).toBe('前后')
    expect(view.state.doc.child(0).childCount).toBe(1)
  })
})

describe('link transactions', () => {
  it('updates and removes the complete link mark range', () => {
    const link = schema.marks.link!.create({
      href: 'https://old.example',
      title: null,
    })
    const view = testView(EditorState.create({
      schema,
      doc: schema.nodes.doc!.create(undefined, [
        schema.nodes.paragraph!.create(undefined, [
          schema.text('链接文字', [link]),
        ]),
      ]),
    }))

    expect(updateLinkAtPosition(view, 2, 'https://new.example')).toBe(true)
    expect(view.state.doc.child(0).child(0).marks[0]?.attrs.href)
      .toBe('https://new.example')

    expect(updateLinkAtPosition(view, 2, null)).toBe(true)
    expect(view.state.doc.child(0).child(0).marks).toHaveLength(0)
  })

  it('rejects dangerous link schemes without changing the document', () => {
    const link = schema.marks.link!.create({ href: 'https://safe.example' })
    const view = testView(EditorState.create({
      schema,
      doc: schema.nodes.doc!.create(undefined, [
        schema.nodes.paragraph!.create(undefined, schema.text('链接', [link])),
      ]),
    }))
    const before = view.state.doc.toJSON()

    expect(updateLinkAtPosition(view, 2, 'javascript:alert(1)')).toBe(false)
    expect(view.state.doc.toJSON()).toEqual(before)
    expect(view.dispatch).not.toHaveBeenCalled()
  })
})
