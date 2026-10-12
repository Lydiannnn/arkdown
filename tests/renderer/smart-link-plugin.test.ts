import { defaultValueCtx, Editor, editorViewCtx, serializerCtx } from '@milkdown/kit/core'
import { splitBlock } from '@milkdown/kit/prose/commands'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { $prose } from '@milkdown/kit/utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyManualLink,
  createSmartLinkPlugin,
} from '../../src/renderer/editor/smart-link-plugin'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
  marks: {
    link: {
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
      toDOM: (mark) => ['a', { href: mark.attrs.href }, 0],
    },
  },
})

let view: EditorView | null = null
const markdownEditors: Editor[] = []

afterEach(async () => {
  view?.destroy()
  view = null
  await Promise.all(markdownEditors.splice(0).map((editor) => editor.destroy()))
  document.body.replaceChildren()
})

async function markdownEditor(markdown: string): Promise<Editor> {
  const editor = Editor.make()
    .use(commonmark)
    .use($prose(createSmartLinkPlugin))
    .config((context) => context.set(defaultValueCtx, markdown))
  await editor.create()
  markdownEditors.push(editor)
  return editor
}

function mount(text: string, href?: string): EditorView {
  const mark = href ? schema.marks.link!.create({ href, title: null }) : null
  const doc = schema.nodes.doc!.create(undefined, [
    schema.nodes.paragraph!.create(undefined, text ? schema.text(text, mark ? [mark] : []) : undefined),
  ])
  view = new EditorView(document.body.appendChild(document.createElement('div')), {
    state: EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, text.length + 1),
      plugins: [createSmartLinkPlugin()],
    }),
  })
  return view
}

function linkSnapshot(editor: EditorView): { text: string; href: string } | null {
  const paragraph = editor.state.doc.firstChild!
  const linked = paragraph.firstChild
  const mark = linked?.marks.find((candidate) => candidate.type === schema.marks.link)
  return mark ? { text: linked!.textContent, href: String(mark.attrs.href) } : null
}

describe('smart typed and pasted link recognition', () => {
  it.each([
    ['https://example.com/guide', ' ', 'https://example.com/guide'],
    ['www.example.com/guide', ' ', 'https://www.example.com/guide'],
    ['C:\\Workspace\\guide.md', ' ', 'C:\\Workspace\\guide.md'],
  ])('links the complete typed target %s when Space is entered', (text, delimiter, href) => {
    const editor = mount(text)
    const plugin = createSmartLinkPlugin()
    const handled = plugin.props.handleTextInput!.call(
      plugin,
      editor,
      text.length + 1,
      text.length + 1,
      delimiter,
      () => editor.state.tr,
    )

    expect(handled).toBe(true)
    expect(editor.state.doc.textContent).toBe(`${text}${delimiter}`)
    expect(linkSnapshot(editor)).toEqual({ text, href })
  })

  it('links a quoted local path containing spaces when Enter is pressed', () => {
    const text = '"C:\\Workspace\\My Guide.md"'
    const editor = mount(text)
    const plugin = createSmartLinkPlugin()
    const handled = plugin.props.handleKeyDown!.call(
      plugin,
      editor,
      new KeyboardEvent('keydown', { key: 'Enter' }),
    )

    expect(handled).toBe(false)
    expect(linkSnapshot(editor)).toEqual({
      text,
      href: 'C:\\Workspace\\My Guide.md',
    })
  })

  it.each([
    { delimiter: 'Space', text: ' ' },
    { delimiter: 'Enter', text: '' },
  ])('preserves a manual destination when a URL-shaped label is followed by $delimiter', async ({
    delimiter,
    text,
  }) => {
    const label = 'https://label.example/path'
    const destination = 'https://destination.example/manual'
    const editor = await markdownEditor(`[${label}](${destination})`)
    const editorView = editor.ctx.get(editorViewCtx)
    const linkType = editorView.state.schema.marks.link!
    const manualMark = linkType.isInSet(editorView.state.doc.firstChild!.firstChild!.marks)!
    const position = label.length + 1
    editorView.dispatch(editorView.state.tr
      .setSelection(TextSelection.create(editorView.state.doc, position))
      .setStoredMarks([manualMark]))
    const plugin = createSmartLinkPlugin()

    if (delimiter === 'Space') {
      expect(plugin.props.handleTextInput!.call(
        plugin,
        editorView,
        position,
        position,
        text,
        () => editorView.state.tr,
      )).toBe(true)
    } else {
      expect(plugin.props.handleKeyDown!.call(
        plugin,
        editorView,
        new KeyboardEvent('keydown', { key: delimiter }),
      )).toBe(false)
      expect(splitBlock(editorView.state, (transaction) => editorView.dispatch(transaction)))
        .toBe(true)
    }

    const firstParagraph = editorView.state.doc.firstChild!
    const linkedLabel = firstParagraph.firstChild!
    expect(linkedLabel.textContent).toBe(label)
    expect(linkType.isInSet(linkedLabel.marks)?.attrs.href).toBe(destination)
    expect(linkType.isInSet(editorView.state.storedMarks ?? [])).toBeUndefined()
    if (delimiter === 'Space') {
      expect(firstParagraph.lastChild!.textContent).toBe(' ')
      expect(linkType.isInSet(firstParagraph.lastChild!.marks)).toBeUndefined()
    } else {
      expect(editorView.state.doc.childCount).toBe(2)
      expect(editorView.state.doc.child(1).textContent).toBe('')
    }
  })

  it('links one exact plain-text pasted target while preserving its visible spaces', () => {
    const text = 'C:\\Workspace\\My Guide.md'
    const editor = mount('')
    const event = {
      clipboardData: {
        types: ['text/plain'],
        getData: (type: string) => type === 'text/plain' ? text : '',
      },
    } as unknown as ClipboardEvent

    const plugin = createSmartLinkPlugin()
    const handled = plugin.props.handlePaste!.call(plugin, editor, event, null as never)

    expect(handled).toBe(true)
    expect(editor.state.doc.textContent).toBe(text)
    expect(linkSnapshot(editor)).toEqual({ text, href: text })
  })

  it('leaves a link mark inline so a caret can move between its letters', () => {
    const text = 'https://example.com'
    const editor = mount(text)
    const plugin = createSmartLinkPlugin()
    plugin.props.handleTextInput!.call(
      plugin,
      editor,
      text.length + 1,
      text.length + 1,
      ' ',
      () => editor.state.tr,
    )

    editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 5)))

    expect(editor.state.selection.from).toBe(5)
    expect(editor.state.selection.empty).toBe(true)
    expect(editor.state.doc.nodeAt(4)?.isText).toBe(true)
  })
})

describe('automatic versus manual link reconstruction', () => {
  it('removes an automatic link when its displayed target becomes invalid', () => {
    const editor = mount('https://example.com', 'https://example.com/')

    editor.dispatch(editor.state.tr.insertText(' ', 8))

    expect(editor.state.doc.textContent).toBe('https:/ /example.com')
    expect(linkSnapshot(editor)).toBeNull()
  })

  it('preserves an adjacent manual link when its automatic predecessor is deleted', () => {
    const automatic = schema.marks.link!.create({ href: 'https://example.com/', title: null })
    const manual = schema.marks.link!.create({ href: 'https://example.com/guide', title: null })
    const automaticLabel = 'https://example.com'
    const doc = schema.nodes.doc!.create(undefined, [
      schema.nodes.paragraph!.create(undefined, [
        schema.text(automaticLabel, [automatic]),
        schema.text('guide', [manual]),
      ]),
    ])
    view = new EditorView(document.body.appendChild(document.createElement('div')), {
      state: EditorState.create({ schema, doc, plugins: [createSmartLinkPlugin()] }),
    })

    view.dispatch(view.state.tr.delete(1, automaticLabel.length + 1))

    expect(view.state.doc.textContent).toBe('guide')
    expect(view.state.doc.firstChild!.firstChild!.marks).toEqual([manual])
  })

  it('revalidates every old automatic remnant after a linked middle replacement', () => {
    const automaticHref = 'https://example.com/'
    const replacementHref = 'https://replacement.example/'
    const manualHref = 'https://manual-destination.example/path'
    const automatic = schema.marks.link!.create({ href: automaticHref, title: null })
    const replacement = schema.marks.link!.create({ href: replacementHref, title: null })
    const manual = schema.marks.link!.create({ href: manualHref, title: null })
    const automaticLabel = 'https://example.com'
    const replacementLabel = 'https://replacement.example'
    const manualLabel = 'https://manual-label.example/path'
    const doc = schema.nodes.doc!.create(undefined, [
      schema.nodes.paragraph!.create(undefined, [
        schema.text(automaticLabel, [automatic]),
        schema.text(' '),
        schema.text(manualLabel, [manual]),
      ]),
    ])
    view = new EditorView(document.body.appendChild(document.createElement('div')), {
      state: EditorState.create({ schema, doc, plugins: [createSmartLinkPlugin()] }),
    })
    const replaceFrom = 1 + 'https://'.length
    const replaceTo = replaceFrom + 'example'.length

    view.dispatch(view.state.tr.replaceWith(
      replaceFrom,
      replaceTo,
      schema.text(replacementLabel, [replacement]),
    ))

    const runs: Array<{ text: string; href: string | null }> = []
    view.state.doc.descendants((node) => {
      if (!node.isText) return
      const mark = schema.marks.link!.isInSet(node.marks)
      runs.push({ text: node.textContent, href: mark ? String(mark.attrs.href) : null })
    })
    expect(view.state.doc.textContent).toBe(
      `https://${replacementLabel}.com ${manualLabel}`,
    )
    expect(runs.filter((run) => run.href === automaticHref)).toEqual([])
    expect(runs).toContainEqual({ text: replacementLabel, href: replacementHref })
    expect(runs).toContainEqual({ text: manualLabel, href: manualHref })
  })

  it('preserves a manual link when its non-target label is edited after a Markdown round-trip', async () => {
    const first = await markdownEditor('[guide](https://example.com/)')
    const markdown = first.ctx.get(serializerCtx)(first.ctx.get(editorViewCtx).state.doc)
    const second = await markdownEditor(markdown)
    const secondView = second.ctx.get(editorViewCtx)

    secondView.dispatch(secondView.state.tr.insertText('!', 3))

    expect(markdown.trimEnd()).toBe('[guide](https://example.com/)')
    expect(secondView.state.doc.textContent).toBe('gu!ide')
    expect(secondView.state.doc.firstChild!.firstChild!.marks[0]?.attrs.href)
      .toBe('https://example.com/')
  })

  it('reconstructs a literal self-target link as automatic after a Markdown round-trip', async () => {
    const first = await markdownEditor('[www.example.com](https://www.example.com/)')
    const firstView = first.ctx.get(editorViewCtx)
    const markdown = first.ctx.get(serializerCtx)(firstView.state.doc)
    const second = await markdownEditor(markdown)
    const secondView = second.ctx.get(editorViewCtx)

    secondView.dispatch(secondView.state.tr.insertText(' ', 5))

    expect(markdown.trimEnd()).toBe('[www.example.com](https://www.example.com/)')
    expect(secondView.state.doc.firstChild!.firstChild!.marks).toHaveLength(0)
  })

  it('applies a normalized manual target without replacing selected text', () => {
    const editor = mount('selected label')
    const before = editor.state.doc.textContent

    expect(applyManualLink(editor, 1, 15, 'www.example.com/guide')).toBe(true)

    expect(editor.state.doc.textContent).toBe(before)
    expect(linkSnapshot(editor)).toEqual({
      text: 'selected label',
      href: 'https://www.example.com/guide',
    })
  })

  it('does not extend a manual link when typing at its right edge with the real Milkdown schema', async () => {
    const editor = await markdownEditor('123456')
    const editorView = editor.ctx.get(editorViewCtx)
    const linkType = editorView.state.schema.marks.link!

    expect(applyManualLink(editorView, 5, 7, 'https://example.com/56')).toBe(true)
    editorView.dispatch(editorView.state.tr.insertText('789'))

    const runs: Array<{ text: string; linked: boolean }> = []
    editorView.state.doc.descendants((node) => {
      if (!node.isText) return
      runs.push({ text: node.textContent, linked: Boolean(linkType.isInSet(node.marks)) })
    })
    expect(editorView.state.doc.textContent).toBe('123456789')
    expect(runs).toEqual([
      { text: '1234', linked: false },
      { text: '56', linked: true },
      { text: '789', linked: false },
    ])
  })
})
