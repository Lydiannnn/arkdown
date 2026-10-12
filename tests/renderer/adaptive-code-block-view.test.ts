import { Crepe } from '@milkdown/crepe'
import { editorViewCtx } from '@milkdown/kit/core'
import { codeBlockView } from '@milkdown/kit/component/code-block'
import { redo, undo } from '@milkdown/kit/prose/history'
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { afterEach, expect, it, vi } from 'vitest'
import { frontmatterEditorPlugins } from '../../src/renderer/editor/frontmatter-code-block'
import {
  CODE_EXPLANATION_REQUEST_EVENT,
  createAdaptiveMermaidCodeBlockView,
} from '../../src/renderer/editor/mermaid/adaptive-code-block-view'
import type {
  MermaidAppearance,
  MermaidRegistryPort,
  MermaidRenderable,
  MermaidRenderer,
} from '../../src/renderer/editor/mermaid/mermaid-types'

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

const appearance: MermaidAppearance = {
  revision: 1,
  editorTheme: 'minimal',
  colorScheme: 'light',
  themeColor: '#336699',
  bodyFontFamily: 'sans-serif',
}

function createRegistry(): MermaidRegistryPort {
  return {
    appearance: () => appearance,
    register: (_view: MermaidRenderable) => () => {},
    track: () => {},
    refreshAppearance: () => {},
    renderAll: async () => {},
    whenIdle: async () => {},
    dispose: () => {},
  }
}

const renderer: MermaidRenderer = {
  render: async () => ({ status: 'ready', dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }),
}

const editors: Crepe[] = []

async function createEditor(defaultValue: string) {
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
  for (const plugin of frontmatterEditorPlugins) crepe.editor.use(plugin)
  crepe.editor.use(createAdaptiveMermaidCodeBlockView({
    registry: createRegistry(),
    renderer,
  }))
  await crepe.create()
  editors.push(crepe)
  return crepe.editor.ctx.get(editorViewCtx)
}

function codeBlockPosition(doc: ProseMirrorNode): number {
  let position = -1
  doc.descendants((node, nodePosition) => {
    if (node.type.name === 'code_block') position = nodePosition
  })
  expect(position).toBeGreaterThanOrEqual(0)
  return position
}

function requestCodeExplanation(root: HTMLElement): void {
  root.querySelector<HTMLElement>('.milkdown-code-block')?.dispatchEvent(
    new CustomEvent('arkdown:request-code-explanation', { bubbles: true }),
  )
}

afterEach(async () => {
  await Promise.all(editors.splice(0).map((crepe) => crepe.destroy()))
  document.body.replaceChildren()
})

it.each(['typescript', 'latex'])(
  'delegates %s blocks to the public Crepe code-block NodeView',
  async (language) => {
    const view = await createEditor(`\`\`\`${language}\nconst value = 1\n\`\`\``)

    expect(typeof codeBlockView.view).toBe('function')
    expect(view.dom.querySelector('.milkdown-code-block')).toBeInstanceOf(HTMLElement)
    expect(view.dom.querySelector('.arkdown-mermaid-block')).toBeNull()
  },
)

it('keeps the wrapper for same-class updates and lets ProseMirror rebuild across the Mermaid boundary', async () => {
  const view = await createEditor('```typescript\nconst value = 1\n```')
  const position = codeBlockPosition(view.state.doc)
  const initialWrapper = view.dom.querySelector('.arkdown-adaptive-code-block')

  view.dispatch(view.state.tr.setNodeAttribute(position, 'language', 'javascript'))
  expect(view.dom.querySelector('.arkdown-adaptive-code-block')).toBe(initialWrapper)
  expect(initialWrapper).toHaveClass('milkdown-code-block')

  view.dispatch(view.state.tr.setNodeAttribute(position, 'language', 'mermaid'))
  const mermaidWrapper = view.dom.querySelector('.arkdown-adaptive-code-block')
  expect(mermaidWrapper).not.toBe(initialWrapper)
  expect(mermaidWrapper).toHaveClass('arkdown-mermaid-block')

  view.dispatch(view.state.tr.setNodeAttribute(position, 'language', ' MERMAID '))
  expect(view.dom.querySelector('.arkdown-adaptive-code-block')).toBe(mermaidWrapper)

  view.dispatch(view.state.tr.setNodeAttribute(position, 'language', 'latex'))
  const latexWrapper = view.dom.querySelector('.arkdown-adaptive-code-block')
  expect(latexWrapper).not.toBe(mermaidWrapper)
  expect(latexWrapper).toHaveClass('milkdown-code-block')
})

it('converts a normal code block to Mermaid through its bubbling DOM event and supports history', async () => {
  const view = await createEditor('```typescript\nconst value = 1\n```')
  const position = codeBlockPosition(view.state.doc)
  const stockBlock = view.dom.querySelector<HTMLElement>('.milkdown-code-block')!

  stockBlock.dispatchEvent(new CustomEvent('arkdown:convert-code-block-to-mermaid', { bubbles: true }))

  expect(view.state.doc.nodeAt(position)?.attrs.language).toBe('mermaid')
  expect(view.state.doc.nodeAt(position)?.textContent).toBe('const value = 1')
  expect(view.dom.querySelector('.arkdown-mermaid-block')).toBeInstanceOf(HTMLElement)

  expect(undo(view.state, view.dispatch)).toBe(true)
  expect(view.state.doc.nodeAt(position)?.attrs.language).toBe('typescript')
  expect(redo(view.state, view.dispatch)).toBe(true)
  expect(view.state.doc.nodeAt(position)?.attrs.language).toBe('mermaid')
})

it('ignores conversion events for front matter and read-only code blocks', async () => {
  const view = await createEditor('```typescript\nconst value = 1\n```')
  const position = codeBlockPosition(view.state.doc)
  const stockBlock = view.dom.querySelector<HTMLElement>('.milkdown-code-block')!

  view.dispatch(view.state.tr.setNodeAttribute(position, 'frontmatter', true))
  stockBlock.dispatchEvent(new CustomEvent('arkdown:convert-code-block-to-mermaid', { bubbles: true }))
  expect(view.state.doc.nodeAt(position)?.attrs.language).toBe('typescript')

  view.dispatch(view.state.tr.setNodeAttribute(position, 'frontmatter', false))
  Object.defineProperty(view, 'editable', { configurable: true, value: false })
  stockBlock.dispatchEvent(new CustomEvent('arkdown:convert-code-block-to-mermaid', { bubbles: true }))
  expect(view.state.doc.nodeAt(position)?.attrs.language).toBe('typescript')
})

it('keeps frontmatter nodes on the public code-block view even when their language is Mermaid', async () => {
  const view = await createEditor('```typescript\nconst value = 1\n```')
  const position = codeBlockPosition(view.state.doc)
  const initialStockView = view.dom.querySelector('.milkdown-code-block')

  const nodeType = view.state.schema.nodes.code_block!
  const insertedFrontmatter = nodeType.create(
    { language: 'mermaid', frontmatter: true },
    view.state.schema.text('title: Arkdown'),
  )
  view.dispatch(view.state.tr.insert(view.state.doc.content.size, insertedFrontmatter))

  expect(view.dom.querySelectorAll('.milkdown-code-block')).toHaveLength(2)
  expect(view.dom.querySelector('.arkdown-mermaid-block')).toBeNull()

  view.dispatch(
    view.state.tr
      .setNodeAttribute(position, 'frontmatter', true)
      .setNodeAttribute(position, 'language', 'mermaid'),
  )

  expect(view.dom.querySelector('.milkdown-code-block')).toBe(initialStockView)
  expect(view.dom.querySelectorAll('.milkdown-code-block')).toHaveLength(2)
  expect(view.dom.querySelector('.arkdown-mermaid-block')).toBeNull()
})

it('keeps frontmatter decorations on the stock milkdown-code-block DOM element', async () => {
  const view = await createEditor('---\ntitle: Arkdown\n---')
  const stockView = view.dom.querySelector<HTMLElement>('.milkdown-code-block')
  const adaptiveView = view.dom.querySelector<HTMLElement>('.arkdown-adaptive-code-block')

  expect(stockView).toBeInstanceOf(HTMLElement)
  expect(stockView).toHaveAttribute('data-arkdown-frontmatter', 'true')
  expect(adaptiveView).toBe(stockView)
})

it('reports code and language from the ProseMirror node when the DOM explanation request bubbles up', async () => {
  const view = await createEditor('```ts\nconst value = 1\n```')
  const received = vi.fn()
  view.dom.addEventListener(CODE_EXPLANATION_REQUEST_EVENT, received)

  requestCodeExplanation(view.dom)

  expect(received).toHaveBeenCalledWith(expect.objectContaining({
    detail: {
      language: 'ts',
      code: 'const value = 1',
    },
  }))
})

it('does not emit a code explanation request for read-only ordinary code blocks', async () => {
  const view = await createEditor('```ts\nconst value = 1\n```')
  const received = vi.fn()
  view.dom.addEventListener(CODE_EXPLANATION_REQUEST_EVENT, received)
  Object.defineProperty(view, 'editable', { configurable: true, value: false })

  requestCodeExplanation(view.dom)

  expect(received).not.toHaveBeenCalled()
})

it('attaches the explanation bridge when frontmatter becomes ordinary and stops emitting when it becomes frontmatter again', async () => {
  const view = await createEditor('---\ntitle: Arkdown\n---')
  const received = vi.fn()
  view.dom.addEventListener(CODE_EXPLANATION_REQUEST_EVENT, received)
  const position = codeBlockPosition(view.state.doc)

  view.dispatch(
    view.state.tr
      .setNodeAttribute(position, 'frontmatter', false)
      .setNodeAttribute(position, 'language', 'ts'),
  )
  requestCodeExplanation(view.dom)
  expect(received).toHaveBeenCalledWith(expect.objectContaining({
    detail: {
      language: 'ts',
      code: 'title: Arkdown',
    },
  }))

  received.mockClear()
  view.dispatch(view.state.tr.setNodeAttribute(position, 'frontmatter', true))
  requestCodeExplanation(view.dom)
  expect(received).not.toHaveBeenCalled()
})
