import { fireEvent } from '@testing-library/dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyLinkAttributes } from '../../src/renderer/editor/local-asset-link-view'
import {
  installLinkInteraction,
  openLinkTarget,
} from '../../src/renderer/editor/local-link-handler'

function link(href: string, label = href): HTMLAnchorElement {
  const anchor = document.createElement('a')
  anchor.textContent = label
  applyLinkAttributes(anchor, href, null)
  return anchor
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('link interaction', () => {
  it('dispatches an explicit welcome action on an ordinary click without opening a URL', () => {
    const root = document.createElement('div')
    const anchor = link('arkdown:choose-workspace')
    root.append(anchor); document.body.append(root)
    const action = vi.fn(), open = vi.fn()
    window.addEventListener('arkdown:welcome-action', action)
    const cleanup = installLinkInteraction(root, open, vi.fn())
    fireEvent.click(anchor)
    expect(action.mock.calls[0]?.[0].detail).toBe('choose-workspace')
    expect(open).not.toHaveBeenCalled()
    cleanup(); window.removeEventListener('arkdown:welcome-action', action)
  })
  it.each([
    ['www.example.com/menu', 'https://www.example.com/menu'],
    ['file:///C:/Workspace/Menu%20Target.md', 'C:\\Workspace\\Menu Target.md'],
  ])('normalizes the context-menu target %s before dispatch', async (input, expected) => {
    const open = vi.fn(async () => ({ ok: true as const, value: null }))

    await expect(openLinkTarget(input, open, vi.fn())).resolves.toBe(true)

    expect(open).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith(expected)
  })

  it('keeps an ordinary click in the editor without opening the target', async () => {
    const root = document.createElement('div')
    const anchor = link('https://example.com/guide')
    root.append(anchor)
    document.body.append(root)
    const open = vi.fn(async () => ({ ok: true as const, value: null }))
    const cleanup = installLinkInteraction(root, open, vi.fn())

    const nativeClick = new MouseEvent('click', { bubbles: true, cancelable: true })
    anchor.dispatchEvent(nativeClick)

    expect(nativeClick.defaultPrevented).toBe(true)
    expect(open).not.toHaveBeenCalled()
    cleanup()
  })

  it.each([
    ['www.example.com/guide', 'https://www.example.com/guide'],
    ['file:///C:/Workspace/My%20Guide.pdf', 'C:\\Workspace\\My Guide.pdf'],
  ])('opens %s exactly once on Ctrl+click', async (href, normalized) => {
    const root = document.createElement('div')
    const anchor = link(href)
    root.append(anchor)
    document.body.append(root)
    const open = vi.fn(async () => ({ ok: true as const, value: null }))
    const cleanup = installLinkInteraction(root, open, vi.fn())

    fireEvent.click(anchor, { ctrlKey: true })
    await Promise.resolve()

    expect(open).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith(normalized)
    cleanup()
  })

  it('does not refocus an Arkdown element after the system opener settles', async () => {
    const root = document.createElement('div')
    const anchor = link('https://example.com/guide')
    const focusOwner = document.createElement('button')
    root.append(anchor)
    document.body.append(root, focusOwner)
    focusOwner.focus()
    let settle!: () => void
    const open = vi.fn(() => new Promise<{ ok: true; value: null }>((resolve) => {
      settle = () => resolve({ ok: true, value: null })
    }))
    const cleanup = installLinkInteraction(root, open, vi.fn())

    fireEvent.click(anchor, { ctrlKey: true })
    expect(document.activeElement).toBe(focusOwner)

    settle()
    await Promise.resolve()
    await Promise.resolve()

    expect(document.activeElement).toBe(focusOwner)
    cleanup()
  })

  it('does not open after a Ctrl+drag selection gesture', async () => {
    const root = document.createElement('div')
    const anchor = link('https://example.com/guide')
    root.append(anchor)
    document.body.append(root)
    const open = vi.fn(async () => ({ ok: true as const, value: null }))
    const cleanup = installLinkInteraction(root, open, vi.fn())

    fireEvent.pointerDown(anchor, { clientX: 4, clientY: 4, ctrlKey: true })
    fireEvent.pointerMove(root, { clientX: 28, clientY: 4, ctrlKey: true })
    fireEvent.pointerUp(anchor, { clientX: 28, clientY: 4, ctrlKey: true })
    fireEvent.click(anchor, { ctrlKey: true })

    expect(open).not.toHaveBeenCalled()
    cleanup()
  })

  it('shows a hand only on the hovered link while Control is held', async () => {
    const root = document.createElement('div')
    const first = link('https://first.example')
    const second = link('C:\\Workspace\\second.md')
    root.append(first, second)
    document.body.append(root)
    const cleanup = installLinkInteraction(root, vi.fn(), vi.fn())

    fireEvent.mouseOver(first)
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true })

    expect(first).toHaveClass('arkdown-link-openable')
    expect(second).not.toHaveClass('arkdown-link-openable')

    fireEvent.mouseOver(second, { relatedTarget: first })
    expect(first).not.toHaveClass('arkdown-link-openable')
    expect(second).toHaveClass('arkdown-link-openable')

    fireEvent.keyUp(window, { key: 'Control' })
    expect(second).not.toHaveClass('arkdown-link-openable')

    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true })
    expect(second).toHaveClass('arkdown-link-openable')
    fireEvent.blur(window)
    expect(second).not.toHaveClass('arkdown-link-openable')
    cleanup()
  })

  it('forgets the hovered link on blur before Control is pressed after refocus', () => {
    const root = document.createElement('div')
    const anchor = link('https://example.com/guide')
    root.append(anchor)
    document.body.append(root)
    const cleanup = installLinkInteraction(root, vi.fn(), vi.fn())

    fireEvent.mouseOver(anchor)
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true })
    expect(anchor).toHaveClass('arkdown-link-openable')

    fireEvent.blur(window)
    fireEvent.pointerMove(document.body, { clientX: 200, clientY: 200 })
    window.dispatchEvent(new Event('focus'))
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true })

    expect(anchor).not.toHaveClass('arkdown-link-openable')
    cleanup()
  })

  it.each([
    ['its href becomes invalid', (anchor: HTMLAnchorElement) => {
      anchor.setAttribute('href', 'javascript:alert(1)')
    }],
    ['it leaves the interaction root', (anchor: HTMLAnchorElement) => {
      anchor.remove()
    }],
  ])('does not restore the remembered cursor when %s', (_reason, invalidate) => {
    const root = document.createElement('div')
    const anchor = link('https://example.com/guide')
    root.append(anchor)
    document.body.append(root)
    const cleanup = installLinkInteraction(root, vi.fn(), vi.fn())

    fireEvent.mouseOver(anchor)
    invalidate(anchor)
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true })

    expect(anchor).not.toHaveClass('arkdown-link-openable')
    cleanup()
  })

  it('reports a bounded opener error and cleanup removes listeners and cursor state', async () => {
    const root = document.createElement('div')
    const anchor = link('C:\\Workspace\\missing.pdf')
    root.append(anchor)
    document.body.append(root)
    const reportError = vi.fn()
    const open = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'FILE_NOT_FOUND', message: '文件已被移动或删除' },
    }))
    const cleanup = installLinkInteraction(root, open, reportError)

    fireEvent.mouseOver(anchor)
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true })
    expect(anchor).toHaveClass('arkdown-link-openable')
    cleanup()
    expect(anchor).not.toHaveClass('arkdown-link-openable')

    const clickAfterCleanup = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    })
    clickAfterCleanup.preventDefault()
    anchor.dispatchEvent(clickAfterCleanup)
    expect(open).not.toHaveBeenCalled()

    const secondCleanup = installLinkInteraction(root, open, reportError)
    fireEvent.click(anchor, { ctrlKey: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(reportError).toHaveBeenCalledWith('文件已被移动或删除')
    secondCleanup()
  })
})
