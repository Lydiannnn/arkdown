import { Crepe } from '@milkdown/crepe'
import { editorViewCtx, serializerCtx } from '@milkdown/kit/core'
import { TextSelection } from '@milkdown/kit/prose/state'
import { remarkPreserveEmptyLinePlugin } from '@milkdown/kit/preset/commonmark'
import { $prose } from '@milkdown/kit/utils'
import { afterEach, expect, it, vi } from 'vitest'
import { createAdaptiveMermaidCodeBlockView } from '../../src/renderer/editor/mermaid/adaptive-code-block-view'
import type {
  MermaidAppearance,
  MermaidRegistryPort,
  MermaidRenderer,
} from '../../src/renderer/editor/mermaid/mermaid-types'
import { createVisualParagraphEnterPlugin } from '../../src/renderer/editor/visual-paragraph-enter'

class IntersectionObserverStub {
  root = null
  rootMargin = '0px'
  thresholds = [0]
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] { return [] }
}

vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
const editors: Crepe[] = []

const mermaidAppearance: MermaidAppearance = {
  revision: 1,
  editorTheme: 'minimal',
  colorScheme: 'light',
  themeColor: '#336699',
  bodyFontFamily: 'sans-serif',
}

const mermaidRegistry: MermaidRegistryPort = {
  appearance: () => mermaidAppearance,
  register: () => () => {},
  track: () => {},
  refreshAppearance: () => {},
  renderAll: async () => {},
  whenIdle: async () => {},
  dispose: () => {},
}

const mermaidRenderer: MermaidRenderer = {
  render: async () => ({ status: 'ready', dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }),
}

async function createEditor(defaultValue: string, withMermaid = false) {
  const root = document.createElement('div')
  document.body.append(root)
  const crepe = new Crepe({
    root,
    defaultValue,
    features: {
      [Crepe.Feature.AI]: false,
      [Crepe.Feature.BlockEdit]: false,
      [Crepe.Feature.Cursor]: false,
      [Crepe.Feature.ImageBlock]: false,
      [Crepe.Feature.LinkTooltip]: false,
      [Crepe.Feature.Placeholder]: false,
      [Crepe.Feature.Table]: false,
      [Crepe.Feature.Toolbar]: false,
      [Crepe.Feature.TopBar]: false,
      [Crepe.Feature.CodeMirror]: true,
      [Crepe.Feature.Latex]: true,
    },
  })
  if (withMermaid) {
    crepe.editor.use(createAdaptiveMermaidCodeBlockView({
      registry: mermaidRegistry,
      renderer: mermaidRenderer,
    }))
  }
  crepe.editor.use($prose(createVisualParagraphEnterPlugin))
  await crepe.editor.remove(remarkPreserveEmptyLinePlugin).then(() => crepe.create())
  editors.push(crepe)
  return {
    view: crepe.editor.ctx.get(editorViewCtx),
    serializer: crepe.editor.ctx.get(serializerCtx),
  }
}

function textStart(view: Awaited<ReturnType<typeof createEditor>>['view'], value: string): number {
  let position = -1
  view.state.doc.descendants((node, nodePosition) => {
    if (node.isText && node.text === value) position = nodePosition
  })
  expect(position).toBeGreaterThan(0)
  return position
}

afterEach(async () => {
  await Promise.all(editors.splice(0).map((crepe) => crepe.destroy()))
  document.body.replaceChildren()
})

it('serializes Ctrl+Enter in a paragraph as one inline newline', async () => {
  const { view, serializer } = await createEditor('firstline\nsecondline\nthirdline')
  const secondLineStart = textStart(view, 'secondline')
  view.dispatch(view.state.tr.setSelection(TextSelection.create(
    view.state.doc,
    secondLineStart + 'second'.length,
  )))

  view.dom.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  }))

  expect(view.state.doc.childCount).toBe(1)
  expect(serializer(view.state.doc)).toBe('firstline\nsecond\nline\nthirdline\n')
})

it('serializes ordinary Enter in a source-contiguous paragraph with one blank separator line', async () => {
  const { view, serializer } = await createEditor('firstline\nsecondline\nthirdline')
  const secondLineStart = textStart(view, 'secondline')
  view.dispatch(view.state.tr.setSelection(TextSelection.create(
    view.state.doc,
    secondLineStart + 'second'.length,
  )))

  view.dom.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  }))

  expect(view.state.doc.childCount).toBe(2)
  expect(serializer(view.state.doc)).toBe('firstline\nsecond\n\nline\nthirdline\n')
})

it('uses ordinary Enter to create the next ordered-list item', async () => {
  const { view, serializer } = await createEditor('1. alphabeta')
  const lineStart = textStart(view, 'alphabeta')
  view.dispatch(view.state.tr.setSelection(TextSelection.create(
    view.state.doc,
    lineStart + 'alpha'.length,
  )))

  view.dom.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  }))

  expect(serializer(view.state.doc)).toBe('1. alpha\n2. beta\n\n')
})

it('keeps Ctrl+Enter inside the current ordered-list item without a blank source line', async () => {
  const { view, serializer } = await createEditor('1. alphabeta')
  const lineStart = textStart(view, 'alphabeta')
  view.dispatch(view.state.tr.setSelection(TextSelection.create(
    view.state.doc,
    lineStart + 'alpha'.length,
  )))

  view.dom.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  }))

  expect(view.state.doc.textContent).toBe('alpha\nbeta')
  expect(serializer(view.state.doc)).toBe('1. alpha\n   beta\n\n')
})

it('serializes space-only and deletion-only edits without requiring later text input', async () => {
  const { view, serializer } = await createEditor('firstline\nsecondline')
  const secondLineStart = textStart(view, 'secondline')

  const splitWordPosition = secondLineStart + 'second'.length
  view.dispatch(view.state.tr.insertText(' ', splitWordPosition))
  expect(serializer(view.state.doc)).toBe('firstline\nsecond line\n')

  view.dispatch(view.state.tr.delete(secondLineStart + 2, secondLineStart + 6))
  expect(serializer(view.state.doc)).toBe('firstline\nse line\n')
})

it('keeps Mermaid fenced source unchanged while the visual NodeView owns its preview', async () => {
  const source = '```mermaid\ngraph TD\n  A --> B\n```'
  const { view, serializer } = await createEditor(source, true)

  expect(view.dom.querySelector('.arkdown-mermaid-block')).toBeInstanceOf(HTMLElement)
  expect(serializer(view.state.doc)).toBe(`${source}\n`)
})
