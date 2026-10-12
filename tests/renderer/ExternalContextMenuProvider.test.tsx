import { readFileSync } from 'node:fs'
import path from 'node:path'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import {
  useContextMenu,
  type ContextMenuController,
} from '../../src/renderer/context-menu/ContextMenuProvider'
import { ExternalContextMenuProvider } from '../../src/renderer/context-menu/ExternalContextMenuProvider'
import { ExternalContextMenuSurface } from '../../src/renderer/context-menu/ExternalContextMenuSurface'
import { createVisualContextMenuHandler } from '../../src/renderer/editor/context-menu/visual-context-menu'
import type { StickyNoteContextMenuShowPayload } from '../../src/shared/sticky-note-context-menu'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const contextMenuStyle = document.createElement('style')
contextMenuStyle.textContent = readFileSync(
  path.join(process.cwd(), 'src/renderer/context-menu/context-menu.css'),
  'utf8',
)

beforeAll(() => document.head.append(contextMenuStyle))
afterAll(() => contextMenuStyle.remove())

function Harness({ execute, restoreFocus }: { execute: (id: string) => void; restoreFocus: () => void }) {
  const menu = useContextMenu()
  return <button onClick={() => menu.openMenu({
    x: 40,
    y: 50,
    widthCssPx: 200,
    submenuWidthCssPx: 300,
    rootIconGutter: 'none',
    items: [{ kind: 'command', id: 'copy', label: '复制', onSelect: vi.fn() }],
    execute,
    restoreFocus,
  })}>打开</button>
}

function ControllerHarness({ capture }: { capture(value: ContextMenuController): void }) {
  capture(useContextMenu())
  return null
}

const linkSchema = new Schema({
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

let liveView: EditorView | null = null

describe('ExternalContextMenuProvider', () => {
  let emitCommand: ((value: unknown) => void) | undefined
  let emitClosed: ((value: unknown) => void) | undefined

  beforeEach(() => {
    emitCommand = undefined
    emitClosed = undefined
    Object.defineProperty(window, 'screenX', { configurable: true, value: 300 })
    Object.defineProperty(window, 'screenY', { configurable: true, value: 200 })
    window.arkdown = {
      openStickyNoteContextMenu: vi.fn(async () => ({ ok: true, value: null })),
      closeStickyNoteContextMenu: vi.fn(async () => ({ ok: true, value: null })),
      onStickyNoteContextMenuCommand: vi.fn((handler) => { emitCommand = handler; return () => undefined }),
      onStickyNoteContextMenuClosed: vi.fn((handler) => { emitClosed = handler; return () => undefined }),
    } as never
  })

  afterEach(() => {
    document.querySelectorAll<HTMLInputElement>('.arkdown-link-editor-popover input')
      .forEach((input) => input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      })))
    liveView?.destroy()
    liveView = null
  })

  it('opens in screen coordinates, executes in the owner and restores focus after close', async () => {
    const execute = vi.fn()
    const restoreFocus = vi.fn()
    const { container } = render(
      <div
        className="sticky-note-window"
        data-color-scheme="dark"
        style={{ '--theme-color-rgb': '37 99 235' } as import('react').CSSProperties}
      >
        <ExternalContextMenuProvider><Harness execute={execute} restoreFocus={restoreFocus} /></ExternalContextMenuProvider>
      </div>,
    )
    expect(container.querySelector('.sticky-note-window')).not.toBeNull()

    fireEvent.click(screen.getByText('打开'))
    await waitFor(() => expect(window.arkdown.openStickyNoteContextMenu).toHaveBeenCalledWith({
      requestId: expect.any(String),
      screenX: 340,
      screenY: 250,
      widthCssPx: 200,
      submenuWidthCssPx: 300,
      rootIconGutter: 'none',
      themeColorRgb: '37 99 235',
      colorScheme: 'dark',
      items: [{ kind: 'command', id: 'copy', label: '复制' }],
    }))
    const requestId = vi.mocked(window.arkdown.openStickyNoteContextMenu!).mock.calls[0]![0].requestId

    emitCommand?.({ requestId, commandId: 'copy' })
    expect(execute).toHaveBeenCalledWith('copy')
    emitClosed?.({ requestId })
    expect(restoreFocus).toHaveBeenCalledOnce()
  })

  it('keeps the real visual link editor focused when the external menu closes', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const link = linkSchema.marks.link!.create({
      href: 'https://old.example/path',
      title: null,
    })
    liveView = new EditorView(host, {
      state: EditorState.create({
        schema: linkSchema,
        doc: linkSchema.node('doc', null, linkSchema.node(
          'paragraph',
          null,
          linkSchema.text('visible label', [link]),
        )),
      }),
    })
    vi.spyOn(liveView, 'posAtCoords').mockReturnValue({ pos: 3, inside: 1 })
    const focus = vi.spyOn(liveView, 'focus')
    let menu: ContextMenuController | null = null
    render(
      <ExternalContextMenuProvider>
        <ControllerHarness capture={(value) => { menu = value }} />
      </ExternalContextMenuProvider>,
    )
    expect(menu).not.toBeNull()
    const handler = createVisualContextMenuHandler({
      crepe: {
        editor: {
          action: (run: (context: { get(): EditorView }) => void) => run({ get: () => liveView! }),
        },
      } as never,
      menu: menu!,
      commit: vi.fn(),
      getMarkdown: () => '',
    })
    liveView.dom.addEventListener('contextmenu', handler)

    liveView.dom.querySelector('a')!.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 16,
      clientY: 20,
    }))
    await waitFor(() => expect(window.arkdown.openStickyNoteContextMenu).toHaveBeenCalledOnce())
    const requestId = vi.mocked(window.arkdown.openStickyNoteContextMenu!).mock.calls[0]![0].requestId

    act(() => emitCommand?.({ requestId, commandId: 'link-edit' }))
    const input = document.querySelector<HTMLInputElement>('.arkdown-link-editor-popover input')
    expect(input).not.toBeNull()
    expect(document.activeElement).toBe(input)

    act(() => emitClosed?.({ requestId }))
    expect(document.activeElement).toBe(input)
    expect(focus).not.toHaveBeenCalled()
  })

  it('closes the external menu when Escape is pressed in the focused owner', async () => {
    render(<ExternalContextMenuProvider><Harness execute={vi.fn()} restoreFocus={vi.fn()} /></ExternalContextMenuProvider>)

    fireEvent.click(screen.getByText('\u6253\u5f00'))
    await waitFor(() => expect(window.arkdown.openStickyNoteContextMenu).toHaveBeenCalledOnce())
    const requestId = vi.mocked(window.arkdown.openStickyNoteContextMenu!).mock.calls[0]![0].requestId

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(window.arkdown.closeStickyNoteContextMenu).toHaveBeenCalledWith(requestId)
  })

  it('wraps the shared menu once and forwards external layout metadata', () => {
    let show: ((payload: StickyNoteContextMenuShowPayload) => void) | undefined
    let reset: ((payload: { requestId: string }) => void) | undefined
    window.arkdown = {
      onStickyNoteContextMenuShow: vi.fn((handler) => { show = handler; return () => undefined }),
      readyStickyNoteContextMenu: vi.fn(async () => ({ ok: true, value: null })),
      onStickyNoteContextMenuReset: vi.fn((handler) => { reset = handler; return () => undefined }),
      closeStickyNoteContextMenu: vi.fn(async () => ({ ok: true, value: null })),
      executeStickyNoteContextMenuCommand: vi.fn(async () => ({ ok: true, value: null })),
    } as never

    render(<ExternalContextMenuSurface />)
    act(() => show?.({
      requestId: 'menu-surface',
      x: 12,
      y: 18,
      widthCssPx: 200,
      submenuWidthCssPx: 300,
      rootIconGutter: 'none',
      themeColorRgb: '37 99 235',
      colorScheme: 'dark',
      items: [
        { kind: 'command', id: 'copy', label: 'Copy', checked: true, checkedAppearance: 'theme-text' },
        { kind: 'separator', id: 'root-separator' },
        {
          kind: 'submenu',
          id: 'more',
          label: 'More',
          items: [
            {
              kind: 'command', id: 'nested', label: 'Nested',
              checked: true, checkedAppearance: 'theme-text',
            },
            { kind: 'separator', id: 'nested-separator' },
            { kind: 'command', id: 'nested-after', label: 'Nested after' },
          ],
        },
      ],
    }))

    expect(window.arkdown.readyStickyNoteContextMenu).toHaveBeenCalledWith('menu-surface')
    act(() => reset?.({ requestId: 'another-menu' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    const wrappers = document.querySelectorAll('.external-context-menu')
    expect(wrappers).toHaveLength(1)
    expect(wrappers[0]?.querySelectorAll('.context-menu-list')).toHaveLength(1)
    expect(screen.getByRole('menu')).toHaveStyle({ width: '200px' })
    expect(wrappers[0]).toHaveStyle({ '--theme-color-rgb': '37 99 235' })
    expect(screen.getByRole('menuitemcheckbox', { name: 'Copy' }))
      .toHaveClass('context-menu-checked-theme-text')
    expect(wrappers[0]).toHaveAttribute('data-color-scheme', 'dark')
    const menu = screen.getByRole('menu')
    expect(menu).toHaveClass('context-menu-root-no-icon-gutter')
    const rootSeparator = menu.querySelector<HTMLElement>(':scope > .context-menu-separator')!
    expect(rootSeparator).toHaveClass('menu-hairline')
    expect(rootSeparator.querySelectorAll('.menu-hairline-stroke')).toHaveLength(1)
    const animationRule = Array.from(contextMenuStyle.sheet!.cssRules)
      .find((rule) => rule instanceof CSSStyleRule
        && rule.selectorText === '.external-context-menu .context-menu-list')
    expect(animationRule).toBeUndefined()

    const keyframes = Array.from(contextMenuStyle.sheet!.cssRules)
      .find((rule) => rule instanceof CSSKeyframesRule && rule.name === 'arknote-menu-fade-in')
    expect(keyframes).toBeUndefined()

    const expectNoAnimation = (element: Element) => {
      const style = getComputedStyle(element)
      expect(style.animationName).toBe('none')
      expect(style.transform).toBe('none')
    }
    expectNoAnimation(menu)
    expect(getComputedStyle(menu).backgroundColor).toBe('rgba(31, 33, 36, 0.97)')
    expect(getComputedStyle(menu).color).toBe('rgb(245, 247, 250)')
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'More' }).parentElement!)
    const submenu = screen.getAllByRole('menu')
      .find((candidate) => candidate.classList.contains('context-menu-submenu'))!
    expect(submenu).toBeVisible()
    expect(wrappers[0]?.contains(submenu)).toBe(true)
    expect(screen.getByRole('menuitemcheckbox', { name: 'Nested' }))
      .toHaveClass('context-menu-checked-theme-text')
    expect(submenu).toHaveStyle({ width: '300px' })
    const submenuSeparator = submenu.querySelector<HTMLElement>(':scope > .context-menu-separator')!
    expect(submenuSeparator).toHaveClass('menu-hairline')
    expect(submenuSeparator.querySelectorAll('.menu-hairline-stroke')).toHaveLength(1)
    expectNoAnimation(submenu)
    act(() => reset?.({ requestId: 'menu-surface' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(window.arkdown.closeStickyNoteContextMenu).not.toHaveBeenCalled()
  })
})
