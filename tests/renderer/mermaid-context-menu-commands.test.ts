import { Schema } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContextMenuRequest } from '../../src/renderer/context-menu/context-menu-types'
import { createVisualContextMenuHandler } from '../../src/renderer/editor/context-menu/visual-context-menu'
import type { ArkdownApi } from '../../src/shared/contracts'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0] },
    code_block: {
      attrs: { language: { default: '' }, frontmatter: { default: false } },
      content: 'text*',
      group: 'block',
      code: true,
      marks: '',
      toDOM: () => ['pre', ['code', 0]],
    },
    text: { group: 'inline' },
  },
})

const originalArkdown = window.arkdown
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
let view: EditorView | null = null

afterEach(() => {
  view?.destroy()
  view = null
  window.arkdown = originalArkdown
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator, 'clipboard')
  document.body.replaceChildren()
})

function harness(options: {
  rasterizeMermaidImage?: (source: string) => Promise<string>
  clipboardAvailable?: boolean
  alert?: (input: { title: string }) => Promise<void>
} = {}) {
  const source = 'flowchart LR\n  A --> B'
  const doc = schema.node('doc', null, [
    schema.node('code_block', { language: 'mermaid', frontmatter: false }, schema.text(source)),
  ])
  const mount = document.body.appendChild(document.createElement('div'))
  let mermaidHost: HTMLElement | null = null
  view = new EditorView(mount, {
    state: EditorState.create({ schema, doc }),
    nodeViews: {
      code_block: () => {
        const dom = document.createElement('div')
        dom.className = 'arkdown-mermaid-block'
        dom.dataset.arkdownMermaidMode = 'preview'
        dom.dataset.arkdownMermaidRenderState = 'ready'
        dom.dataset.arkdownMermaidRenderGeneration = '1'
        dom.innerHTML = [
          '<div class="arkdown-mermaid-toolbar"></div>',
          '<div class="arkdown-mermaid-preview">',
          '<img alt="Mermaid diagram" src="data:image/svg+xml;base64,PHN2Zy8+">',
          '</div>',
          '<div class="arkdown-mermaid-source" hidden></div>',
        ].join('')
        mermaidHost = dom
        return { dom }
      },
    },
  })
  vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 1, inside: 0 })
  let request: ContextMenuRequest | null = null
  const commit = vi.fn()
  const copyMermaidImage = vi.fn(async () => ({ ok: true as const, value: null }))
  const saveMermaidImage = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = { copyMermaidImage, saveMermaidImage } as unknown as ArkdownApi
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: options.clipboardAvailable === false ? {} : { writeText },
  })
  const rasterizeMermaidImage = vi.fn(options.rasterizeMermaidImage
    ?? (async () => 'data:image/png;base64,UE5H'))
  const handler = createVisualContextMenuHandler({
    crepe: {
      editor: {
        action: (run: (context: { get(): EditorView }) => void) => run({ get: () => view! }),
      },
    } as never,
    menu: {
      openMenu(next) { request = next },
      closeMenu: () => undefined,
      isOpen: false,
    },
    commit,
    getMarkdown: () => `\`\`\`mermaid\n${source}\n\`\`\``,
    rasterizeMermaidImage,
    dialogs: options.alert ? {
      alert: options.alert,
      confirm: vi.fn(),
      prompt: vi.fn(),
    } as never : undefined,
  })
  view.dom.addEventListener('contextmenu', handler)
  mermaidHost!.querySelector('img')!.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    clientX: 8,
    clientY: 8,
  }))
  if (!request) throw new Error('Mermaid menu did not open synchronously')
  return {
    source,
    host: mermaidHost!,
    request: request as ContextMenuRequest,
    writeText,
    copyMermaidImage,
    saveMermaidImage,
    rasterizeMermaidImage,
    commit,
  }
}

describe('Mermaid context menu commands', () => {
  it('switches the existing Mermaid NodeView mode without committing document content', async () => {
    const { host, request, commit } = harness()
    const received: unknown[] = []
    host.addEventListener('arkdown:mermaid-set-mode', (event) => {
      received.push((event as CustomEvent).detail)
    })

    await request.execute('mermaid-toggle-source')

    expect(received).toEqual([{ mode: 'source' }])
    expect(commit).not.toHaveBeenCalled()
  })

  it('copies source and a complete Mermaid fence from the current code block', async () => {
    const { source, request, writeText } = harness()

    await request.execute('mermaid-copy-source')
    await request.execute('mermaid-copy-markdown')

    expect(writeText.mock.calls).toEqual([
      [source],
      [`\`\`\`mermaid\n${source}\n\`\`\``],
    ])
  })

  it('reports unavailable clipboard access instead of silently claiming a source copy', async () => {
    const alert = vi.fn(async () => undefined)
    const { request, writeText } = harness({ clipboardAvailable: false, alert })

    await request.execute('mermaid-copy-source')

    expect(writeText).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith({ title: '无法复制 Mermaid 源码。' })
  })

  it('rasterizes the current SVG and copies it through the Mermaid-only API', async () => {
    const { request, rasterizeMermaidImage, copyMermaidImage } = harness()

    await request.execute('mermaid-copy-image')

    expect(rasterizeMermaidImage).toHaveBeenCalledWith('data:image/svg+xml;base64,PHN2Zy8+')
    expect(copyMermaidImage).toHaveBeenCalledWith('data:image/png;base64,UE5H')
  })

  it('offers both the current SVG and a bounded PNG to the native save dialog', async () => {
    const { request, saveMermaidImage } = harness()

    await request.execute('mermaid-save-image')

    expect(saveMermaidImage).toHaveBeenCalledWith({
      svgDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
      pngDataUrl: 'data:image/png;base64,UE5H',
    })
  })

  it('does not export a stale SVG after its render generation changes during rasterization', async () => {
    let resolveRaster: ((value: string) => void) | null = null
    const rasterPromise = new Promise<string>((resolve) => { resolveRaster = resolve })
    const { request, host, rasterizeMermaidImage, copyMermaidImage } = harness({
      rasterizeMermaidImage: async () => rasterPromise,
    })

    const exporting = request.execute('mermaid-copy-image')
    await vi.waitFor(() => expect(rasterizeMermaidImage).toHaveBeenCalledTimes(1))
    host.dataset.arkdownMermaidRenderState = 'pending'
    host.dataset.arkdownMermaidRenderGeneration = '2'
    resolveRaster!('data:image/png;base64,UE5H')
    await exporting

    expect(copyMermaidImage).not.toHaveBeenCalled()
  })
})
