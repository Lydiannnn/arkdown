import { defaultValueCtx, Editor, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import { afterEach, describe, expect, it } from 'vitest'
import { frontmatterEditorPlugins } from '../../src/renderer/editor/frontmatter-code-block'
import {
  buildMermaidPasteTransaction,
  normalizeMermaidClipboardSource,
  serializeMermaidMarkdown,
} from '../../src/renderer/editor/mermaid/mermaid-clipboard'

const editors: Editor[] = []

afterEach(async () => {
  await Promise.all(editors.splice(0).map((editor) => editor.destroy()))
})

async function createState(markdown = 'replace this') {
  const editor = Editor.make()
  editor.use(commonmark)
  for (const plugin of frontmatterEditorPlugins) editor.use(plugin)
  editor.config((ctx) => {
    ctx.set(defaultValueCtx, markdown)
  })
  await editor.create()
  editors.push(editor)
  return editor.ctx.get(editorViewCtx).state
}

describe('normalizeMermaidClipboardSource', () => {
  it('removes a leading BOM and normalizes CRLF and CR to LF', () => {
    expect(normalizeMermaidClipboardSource('\uFEFFflowchart TD\r\n  A-->B\rB-->C')).toBe(
      'flowchart TD\n  A-->B\nB-->C',
    )
  })

  it.each([
    ['a Mermaid fence', '```mermaid\nflowchart TD\n  A-->B\n```', 'flowchart TD\n  A-->B'],
    ['another language fence', '```typescript\nconst value = 1\n```', 'const value = 1'],
    ['a tilde fence', '~~~text\nflowchart LR\n  A-->B\n~~~', 'flowchart LR\n  A-->B'],
    ['a fence surrounded by whitespace', ' \n\t```anything here\nA-->B\n```\n \t', 'A-->B'],
  ])('unwraps %s when it is the complete clipboard content', (_name, raw, expected) => {
    expect(normalizeMermaidClipboardSource(raw)).toBe(expected)
  })

  it('keeps internal shorter fences inside a longer enclosing fence', () => {
    expect(normalizeMermaidClipboardSource('````mermaid\nA-->B\n```\nB-->C\n````')).toBe(
      'A-->B\n```\nB-->C',
    )
  })

  it('does not extract a fence embedded in ordinary clipboard text', () => {
    const raw = 'Paste this explanation:\n```mermaid\nA-->B\n```\nThen edit it.'

    expect(normalizeMermaidClipboardSource(raw)).toBe(raw)
  })

  it('returns null only for an exactly empty clipboard value and preserves whitespace', () => {
    expect(normalizeMermaidClipboardSource('')).toBeNull()
    expect(normalizeMermaidClipboardSource(' \t\n ')).toBe(' \t\n ')
  })

  it('does not truncate a 20,001-character diagram source', () => {
    const source = `flowchart TD\n${'x'.repeat(20_001)}`

    expect(normalizeMermaidClipboardSource(source)).toBe(source)
  })
})

describe('buildMermaidPasteTransaction', () => {
  it('replaces a real ProseMirror selection with one Mermaid code block and scrolls it into view', async () => {
    const state = await createState('replace this')
    const selection = TextSelection.create(state.doc, 1, state.doc.content.size - 1)
    const selectedState = state.apply(state.tr.setSelection(selection))
    const transaction = buildMermaidPasteTransaction(selectedState, '```mermaid\r\nflowchart TD\r\n  A-->B\r\n```')

    expect(transaction).not.toBeNull()
    expect(transaction?.scrolledIntoView).toBe(true)

    const nextState = selectedState.apply(transaction!)
    expect(nextState.doc.childCount).toBe(1)
    expect(nextState.doc.firstChild?.type.name).toBe('code_block')
    expect(nextState.doc.firstChild?.attrs).toMatchObject({
      language: 'mermaid',
      frontmatter: false,
    })
    expect(nextState.doc.firstChild?.textContent).toBe('flowchart TD\n  A-->B')
  })

  it('selects the inserted Mermaid block instead of placing the caret inside its source', async () => {
    const source = 'flowchart LR\n  Inserted-->Block'
    const state = await createState('```mermaid\nflowchart TD\n  Existing-->Block\n```\n\nreplace this')
    let replacementFrom: number | null = null
    let replacementTo: number | null = null
    state.doc.descendants((node, position) => {
      if (node.type.name !== 'paragraph' || node.textContent !== 'replace this') return true
      replacementFrom = position + 1
      replacementTo = replacementFrom + node.content.size
      return false
    })
    expect(replacementFrom).not.toBeNull()
    expect(replacementTo).not.toBeNull()
    const selectedState = state.apply(state.tr.setSelection(
      TextSelection.create(state.doc, replacementFrom!, replacementTo!),
    ))
    const transaction = buildMermaidPasteTransaction(selectedState, source)

    expect(transaction).not.toBeNull()
    const nextState = selectedState.apply(transaction!)
    let insertedPosition: number | null = null
    nextState.doc.descendants((node, position) => {
      if (node.type.name === 'code_block' && node.textContent === source) {
        insertedPosition = position
        return false
      }
      return true
    })
    expect(nextState.selection).toBeInstanceOf(NodeSelection)
    expect(nextState.selection.from).toBe(insertedPosition)
    expect((nextState.selection as NodeSelection).node).toMatchObject({
      attrs: expect.objectContaining({ language: 'mermaid' }),
      textContent: source,
    })
  })

  it('returns null for an empty raw clipboard value', async () => {
    const state = await createState()

    expect(buildMermaidPasteTransaction(state, '')).toBeNull()
  })

  it('returns null with a real ProseMirror schema that has no code_block node', () => {
    const schema = new Schema({
      nodes: {
        doc: { content: 'paragraph+' },
        paragraph: { content: 'text*' },
        text: {},
      },
    })
    const state = EditorState.create({ schema })

    expect(buildMermaidPasteTransaction(state, 'flowchart TD\nA-->B')).toBeNull()
  })
})

describe('serializeMermaidMarkdown', () => {
  it('round-trips source through the Mermaid clipboard normalizer', () => {
    const source = 'flowchart TD\n  A-->B\n\n  B-->C\n'

    expect(normalizeMermaidClipboardSource(serializeMermaidMarkdown(source))).toBe(source)
  })

  it('uses a fence longer than the longest backtick run in the source', () => {
    const source = 'flowchart TD\n  A[`````` label]-->B'
    const serialized = serializeMermaidMarkdown(source)

    expect(serialized.startsWith('```````mermaid\n')).toBe(true)
    expect(normalizeMermaidClipboardSource(serialized)).toBe(source)
  })
})
