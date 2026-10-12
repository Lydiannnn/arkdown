import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContextMenuRequest } from '../../src/renderer/context-menu/context-menu-types'
import { createVisualContextMenuHandler } from '../../src/renderer/editor/context-menu/visual-context-menu'
import { createLinkEditorPopover } from '../../src/renderer/editor/link-editor-popover'
import type { ArkdownApi } from '../../src/shared/contracts'
import type { BusinessDialogController } from '../../src/renderer/modal/BusinessDialogProvider'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
  marks: {
    link: {
      attrs: {
        href: {},
        title: { default: null },
      },
      toDOM: (mark) => ['a', { href: mark.attrs.href }, 0],
    },
  },
})

const originalArkdown = window.arkdown
let view: EditorView | null = null

afterEach(() => {
  view?.destroy()
  view = null
  window.arkdown = originalArkdown
  document.body.replaceChildren()
})

function openLinkMenu(
  href: string,
  openExternal: NonNullable<ArkdownApi['openExternal']>,
  openLinkEditor?: typeof createLinkEditorPopover,
  createStickyNote?: () => void,
  dialogs?: BusinessDialogController,
): { event: MouseEvent; request: ContextMenuRequest } {
  const host = document.body.appendChild(document.createElement('div'))
  const link = schema.marks.link!.create({ href, title: null })
  view = new EditorView(host, {
    state: EditorState.create({
      schema,
      doc: schema.nodes.doc!.create(undefined, [
        schema.nodes.paragraph!.create(undefined, schema.text('链接', [link])),
      ]),
    }),
  })
  vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 2, inside: 1 })
  window.arkdown = { openExternal } as unknown as ArkdownApi

  let request: ContextMenuRequest | null = null
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
    commit: vi.fn(),
    getMarkdown: () => '',
    openLinkEditor,
    createStickyNote,
    dialogs,
  })
  view.dom.addEventListener('contextmenu', handler)

  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 8,
    clientY: 8,
    ctrlKey: false,
  })
  view.dom.querySelector('a')!.dispatchEvent(event)

  return { event, request: request! }
}

describe('visual context-menu link opening', () => {
  it.each(['../notes/target.md', 'C:/notes/target.md', 'file:///C:/notes/target.md'])(
    'reveals the clicked local link %s without opening or editing it', async (href) => {
      const openExternal = vi.fn()
      const { request } = openLinkMenu(href, openExternal)
      const revealLocalFileLink = vi.fn(async () => ({ ok: true as const, value: null }))
      window.arkdown.revealLocalFileLink = revealLocalFileLink
      expect(request.items).toContainEqual(expect.objectContaining({ id: 'link-reveal', label: '打开文件位置' }))
      await request.execute('link-reveal')
      expect(revealLocalFileLink).toHaveBeenCalledExactlyOnceWith({ href })
      expect(openExternal).not.toHaveBeenCalled()
      expect(view!.state.doc.textContent).toBe('链接')
    },
  )

  it.each(['https://example.com/a.md', '#section'])('omits file-location commands for %s', (href) => {
    const { request } = openLinkMenu(href, vi.fn())
    expect(request.items).not.toContainEqual(expect.objectContaining({ id: 'link-reveal' }))
  })

  it('uses an Arkdown dialog for a missing linked file', async () => {
    const alert = vi.fn(async () => {})
    const { request } = openLinkMenu('../missing.md', vi.fn(), undefined, undefined, { alert, confirm: vi.fn(), prompt: vi.fn() })
    window.arkdown.revealLocalFileLink = vi.fn(async () => ({ ok: false as const, error: {
      code: 'LOCAL_FILE_NOT_FOUND', message: '无法找到文件。目标文件已不在原位置，或当前文档已被移动到新位置。',
    } }))
    await request.execute('link-reveal')
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ description: '无法找到文件。目标文件已不在原位置，或当前文档已被移动到新位置。' }))
  })

  it.each([
    ['www.example.com/menu', 'https://www.example.com/menu'],
    ['file:///C:/Workspace/Menu%20Target.md', 'C:\\Workspace\\Menu Target.md'],
  ])('opens %s without Control and sends the normalized target to preload', async (
    href,
    normalized,
  ) => {
    const openExternal = vi.fn(async () => ({ ok: true as const, value: null }))
    const { event, request } = openLinkMenu(href, openExternal)

    expect(event.ctrlKey).toBe(false)
    await request.execute('link-open')

    expect(openExternal).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith(normalized)
  })

  it('opens the manual editor for selected text and preserves the label on confirm', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const doc = schema.nodes.doc!.create(undefined, [
      schema.nodes.paragraph!.create(undefined, schema.text('selected label')),
    ])
    view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 1, 15),
      }),
    })
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 5, inside: 1 })
    let request: ContextMenuRequest | null = null
    let ownedController: ReturnType<typeof createLinkEditorPopover> | null = null
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
      commit: vi.fn(),
      getMarkdown: () => '',
      openLinkEditor: (options) => {
        ownedController = createLinkEditorPopover(options)
        return ownedController
      },
    })
    view.dom.addEventListener('contextmenu', handler)
    view.dom.querySelector('p')!.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 24,
      clientY: 32,
    }))

    await request!.execute('insert-link-reference')
    const input = document.querySelector<HTMLInputElement>('.arkdown-link-editor-popover input')!
    expect(input).not.toBeNull()
    expect(ownedController).not.toBeNull()
    expect(ownedController!.element).toContain(input)
    input.value = 'www.example.com/guide'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(view.state.doc.textContent).toBe('selected label')
    expect(view.state.doc.firstChild!.firstChild!.marks[0]?.attrs.href)
      .toBe('https://www.example.com/guide')
  })

  it('uses the same manual editor for an existing link without calling prompt', async () => {
    const prompt = vi.spyOn(window, 'prompt')
    let ownedController: ReturnType<typeof createLinkEditorPopover> | null = null
    const { request } = openLinkMenu(
      'https://old.example/',
      vi.fn(),
      (options) => {
        ownedController = createLinkEditorPopover(options)
        return ownedController
      },
    )

    await request.execute('link-edit')

    const input = document.querySelector<HTMLInputElement>('.arkdown-link-editor-popover input')!
    expect(ownedController).not.toBeNull()
    expect(ownedController!.element).toContain(input)
    expect(input.value).toBe('https://old.example/')
    input.value = 'https://new.example/guide'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(view!.state.doc.textContent).toBe('链接')
    expect(view!.state.doc.firstChild!.firstChild!.marks[0]?.attrs.href)
      .toBe('https://new.example/guide')
    expect(prompt).not.toHaveBeenCalled()
  })

  it('selects the complete clicked link before creating a sticky note', async () => {
    let selectedText = ''
    const createStickyNote = vi.fn(() => {
      selectedText = view!.state.doc.textBetween(
        view!.state.selection.from,
        view!.state.selection.to,
      )
    })
    const { request } = openLinkMenu(
      'https://example.com/guide',
      vi.fn(),
      undefined,
      createStickyNote,
    )

    await request.execute('create-sticky-note')

    expect(createStickyNote).toHaveBeenCalledOnce()
    expect(selectedText).toBe('链接')
  })
})
