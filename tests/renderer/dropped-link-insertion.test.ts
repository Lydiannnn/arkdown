import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { describe, expect, it } from 'vitest'
import {
  buildVisualDroppedLinkTransaction,
  droppedLocalFileDisplayName,
  isDroppedDocumentLinkPath,
  serializeDroppedLocalLink,
} from '../../src/renderer/editor/dropped-link-insertion'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
  },
  marks: {
    link: { attrs: { href: {}, title: { default: null } } },
  },
})

describe('dropped local-link insertion', () => {
  it('classifies only the approved dropped document extensions as path links', () => {
    for (const path of [
      'C:\\Work Folder\\chapter.md',
      '\\\\server\\share\\chapter.markdown',
      'C:\\文档\\notes.txt',
      'file:///C:/Work/source.docx',
    ]) expect(isDroppedDocumentLinkPath(path)).toBe(true)

    for (const path of ['chapter.mdx', 'guide.pdf', 'sheet.xlsx', 'folder']) {
      expect(isDroppedDocumentLinkPath(path)).toBe(false)
    }
  })

  it('uses only the filename as the display name across path separator styles', () => {
    expect(droppedLocalFileDisplayName(
      'C:\\Users\\miter\\Desktop\\Arkdown\\华味产品数据库测试与上线准备清单 - 副本.md',
    )).toBe('华味产品数据库测试与上线准备清单 - 副本.md')
    expect(droppedLocalFileDisplayName('/home/miter/Work Folder/notes.md'))
      .toBe('notes.md')
  })

  it('serializes a filename-only Markdown label while preserving the exact absolute href', () => {
    const path = 'C:\\Users\\miter\\Desktop\\Arkdown\\华味产品数据库测试与上线准备清单 - 副本.md'
    expect(serializeDroppedLocalLink(path)).toBe(
      '[华味产品数据库测试与上线准备清单 - 副本.md](<C:\\Users\\miter\\Desktop\\Arkdown\\华味产品数据库测试与上线准备清单 - 副本.md>)',
    )
    expect(serializeDroppedLocalLink('C:\\Docs\\a[b].md'))
      .toBe('[a\\[b\\].md](<C:\\Docs\\a[b].md>)')
  })

  it('inserts a filename-only visual link, then leaves the caret unmarked', () => {
    const doc = schema.node('doc', null, schema.node(
      'paragraph',
      null,
      schema.text('before after'),
    ))
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1),
    })

    const transaction = buildVisualDroppedLinkTransaction(
      state,
      8,
      'C:\\Files\\raw file.bin',
    )
    const next = state.apply(transaction!)
    const linked = next.doc.nodeAt(8)

    expect(next.doc.textContent).toBe('before raw file.binafter')
    expect(linked?.textContent).toBe('raw file.bin')
    expect(schema.marks.link!.isInSet(linked?.marks ?? [])?.attrs.href)
      .toBe('C:\\Files\\raw file.bin')
    expect(next.selection.from).toBe(8 + 'raw file.bin'.length)

    const afterTyping = next.apply(next.tr.insertText('!'))
    expect(afterTyping.doc.textContent).toBe('before raw file.bin!after')
    expect(schema.marks.link!.isInSet(afterTyping.doc.nodeAt(next.selection.from)?.marks ?? []))
      .toBeUndefined()
  })

  it('keeps typing after a visually dropped local link outside the link mark', () => {
    const doc = schema.node('doc', null, schema.node('paragraph', null, schema.text('before')))
    const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 7) })
    const inserted = state.apply(buildVisualDroppedLinkTransaction(
      state,
      7,
      'C:\\Files\\slides.pptx',
    )!)
    const typed = inserted.apply(inserted.tr.insertText(' plain'))
    const plain = typed.doc.nodeAt(7 + 'slides.pptx'.length)

    expect(typed.doc.textContent).toBe('beforeslides.pptx plain')
    expect(schema.marks.link!.isInSet(plain?.marks ?? [])).toBeUndefined()
  })
})
