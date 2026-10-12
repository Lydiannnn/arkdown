import { describe, expect, it, vi } from 'vitest'
import {
  adjustedColorForDarkSurface,
  installStructuredBlockAppearance,
  shouldUseDarkStructuredBlockMode,
} from '../../src/renderer/editor/structured-block-appearance'

function blockMarkup(tokenColor = 'rgb(245, 245, 245)'): HTMLElement {
  const block = document.createElement('div')
  block.className = 'milkdown-code-block'
  block.style.backgroundColor = 'rgb(250, 247, 247)'
  block.innerHTML = `
    <div class="tools">
      <button type="button" class="language-button">Text</button>
      <div class="tools-button-group"><button type="button" class="copy-button">复制</button></div>
    </div>
    <div class="cm-content" style="color: rgb(32, 32, 32)">
      <div class="cm-line"><span style="color: ${tokenColor}">token</span></div>
    </div>
  `
  return block
}

async function flushAppearance() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('structured block appearance', () => {
  it('continues observing newly inserted code blocks when the root also owns the theme', async () => {
    const content = document.createElement('div')
    content.className = 'editor-content'
    const root = document.createElement('div')
    root.dataset.editorTheme = 'minimal'
    content.append(root)
    document.body.append(content)
    const dispose = installStructuredBlockAppearance(root)
    const block = blockMarkup('rgb(20, 24, 28)')
    root.append(block)
    await flushAppearance()
    expect(block.querySelector('.arkdown-block-theme-toggle')).not.toBeNull()
    expect(block.dataset.arkdownColorMode).toBe('theme')
    root.dataset.editorTheme = 'dark'
    await flushAppearance()
    expect(block.dataset.arkdownColorMode).toBe('dark')
    root.dataset.editorTheme = 'minimal'
    await flushAppearance()
    expect(block.dataset.arkdownColorMode).toBe('theme')
    dispose()
    content.remove()
  })
  it('detects very light syntax tokens that are unreadable on the theme surface', () => {
    const block = blockMarkup()
    document.body.append(block)

    expect(shouldUseDarkStructuredBlockMode(block)).toBe(true)

    block.remove()
  })

  it('raises low-contrast dark tokens to readable colors on #17191A', () => {
    expect(adjustedColorForDarkSurface('rgb(20, 24, 28)')).toMatch(/^rgb\(/)
    expect(adjustedColorForDarkSurface('rgb(244, 246, 248)')).toBe('rgb(244, 246, 248)')
  })

  it('adds one accessible palette button and lets it override automatic dark mode', async () => {
    const root = document.createElement('div')
    const block = blockMarkup()
    root.append(block)
    document.body.append(root)

    const dispose = installStructuredBlockAppearance(root)
    await flushAppearance()

    const toggle = block.querySelector<HTMLButtonElement>('.arkdown-block-theme-toggle')
    expect(toggle).not.toBeNull()
    expect(toggle).toHaveAttribute('aria-label', '切换为主题色模式')
    expect(toggle).toHaveAttribute('data-tooltip', '切换为主题色模式')
    expect(toggle).not.toHaveAttribute('title')
    expect(block).toHaveAttribute('data-arkdown-color-mode', 'dark')

    toggle!.click()
    expect(block).toHaveAttribute('data-arkdown-color-mode', 'theme')
    expect(toggle).toHaveAttribute('aria-label', '切换为深色模式')
    expect(toggle).toHaveAttribute('data-tooltip', '切换为深色模式')
    expect(block.querySelector('[data-arkdown-readable-token]')).toBeNull()
    expect(block.querySelector('[data-arkdown-dark-token]')).toBeNull()

    dispose()
    expect(block.querySelector('.arkdown-block-theme-toggle')).toBeNull()
    root.remove()
  })

  it('does not add the code/formula theme control to YAML Front Matter', () => {
    const root = document.createElement('div')
    const block = blockMarkup()
    block.dataset.arkdownFrontmatter = 'true'
    root.append(block)
    document.body.append(root)

    const dispose = installStructuredBlockAppearance(root)

    expect(block.querySelector('.arkdown-block-theme-toggle')).toBeNull()
    expect(block).not.toHaveAttribute('data-arkdown-color-mode')

    dispose()
    root.remove()
  })

  it('adds one Mermaid conversion control to editable ordinary code blocks and emits its DOM event', async () => {
    const root = document.createElement('div')
    const block = blockMarkup()
    root.append(block)
    document.body.append(root)
    const convert = vi.fn()
    root.addEventListener('arkdown:convert-code-block-to-mermaid', convert)

    const dispose = installStructuredBlockAppearance(root)
    await flushAppearance()

    const button = block.querySelector<HTMLButtonElement>('.arkdown-mermaid-convert-button')
    expect(button).toBeInstanceOf(HTMLButtonElement)
    expect(button).toHaveAttribute('aria-label', '将此代码块转换为 Mermaid 图形')
    expect(button).toHaveAttribute('data-tooltip', '将此代码块转换为 Mermaid 图形')
    expect(button?.querySelector('svg')).toHaveAttribute('viewBox', '0 0 32 32')
    expect(button?.querySelector('path')).toHaveAttribute('stroke-width', '1.75')
    expect(button?.querySelector('path')).toHaveAttribute('d', 'M16 13.25C13.9 9.6 10.75 10.4 7 8.9C4.65 8 3.15 6.5 2.25 4.5C1.75 10.15 4.25 14.75 9.65 17.65C12.65 19.25 14.15 21.4 13.65 25.65Q16 26.75 18.35 25.65C17.85 21.4 19.35 19.25 22.35 17.65C27.75 14.75 30.25 10.15 29.75 4.5C28.85 6.5 27.35 8 25 8.9C21.25 10.4 18.1 9.6 16 13.25Z')
    expect(button?.querySelector('svg')).toHaveAttribute('fill', 'none')
    expect(button?.querySelector('svg')).toHaveAttribute('stroke', 'currentColor')

    button!.click()
    expect(convert).toHaveBeenCalledTimes(1)

    block.remove()
    await flushAppearance()
    root.append(block)
    await flushAppearance()
    expect(block.querySelectorAll('.arkdown-mermaid-convert-button')).toHaveLength(1)

    dispose()
    expect(block.querySelector('.arkdown-mermaid-convert-button')).toBeNull()
    root.remove()
  })

  it('does not add Mermaid conversion controls to front matter or a reliably read-only editor', async () => {
    const root = document.createElement('div')
    const editor = document.createElement('div')
    editor.className = 'ProseMirror'
    editor.setAttribute('contenteditable', 'false')
    const ordinaryBlock = blockMarkup()
    const frontmatterBlock = blockMarkup()
    frontmatterBlock.dataset.arkdownFrontmatter = 'true'
    editor.append(ordinaryBlock, frontmatterBlock)
    root.append(editor)
    document.body.append(root)

    const dispose = installStructuredBlockAppearance(root)
    await flushAppearance()

    expect(ordinaryBlock.querySelector('.arkdown-mermaid-convert-button')).toBeNull()
    expect(frontmatterBlock.querySelector('.arkdown-mermaid-convert-button')).toBeNull()

    dispose()
    root.remove()
  })

  it('adds one explanation control to editable ordinary code blocks and emits only the DOM request event', async () => {
    const root = document.createElement('div')
    const block = blockMarkup()
    root.append(block)
    document.body.append(root)
    const received = vi.fn()
    root.addEventListener('arkdown:request-code-explanation', received)

    const dispose = installStructuredBlockAppearance(root)
    await flushAppearance()

    const button = block.querySelector<HTMLButtonElement>('.arkdown-code-explanation-button')
    expect(button).toBeInstanceOf(HTMLButtonElement)
    expect(button).toHaveAttribute('aria-label', '使用 AI 解读此代码块')
    expect(button).toHaveAttribute('data-tooltip', '使用 AI 解读此代码块')
    expect(button?.querySelector('svg')).toHaveAttribute('viewBox', '0 0 24 24')
    expect(button?.querySelector('svg')).toHaveAttribute('fill', 'none')
    expect(button?.querySelector('svg')).toHaveAttribute('stroke', 'currentColor')

    button!.click()
    expect(received).toHaveBeenCalledTimes(1)
    expect(received.mock.calls[0]?.[0]).toBeInstanceOf(CustomEvent)
    expect((received.mock.calls[0]?.[0] as CustomEvent).detail).toBeNull()

    dispose()
    root.remove()
  })

  it('does not add explanation controls to front matter or a reliably read-only editor', async () => {
    const root = document.createElement('div')
    const editor = document.createElement('div')
    editor.className = 'ProseMirror'
    editor.setAttribute('contenteditable', 'false')
    const ordinaryBlock = blockMarkup()
    const frontmatterBlock = blockMarkup()
    frontmatterBlock.dataset.arkdownFrontmatter = 'true'
    editor.append(ordinaryBlock, frontmatterBlock)
    root.append(editor)
    document.body.append(root)

    const dispose = installStructuredBlockAppearance(root)
    await flushAppearance()

    expect(ordinaryBlock.querySelector('.arkdown-code-explanation-button')).toBeNull()
    expect(frontmatterBlock.querySelector('.arkdown-code-explanation-button')).toBeNull()

    dispose()
    root.remove()
  })

  it('deduplicates the explanation control across refreshes, keeps it ordered after Mermaid conversion, and removes it on dispose', async () => {
    const root = document.createElement('div')
    const block = blockMarkup()
    root.append(block)
    document.body.append(root)

    const dispose = installStructuredBlockAppearance(root)
    await flushAppearance()

    const mermaidButton = block.querySelector('.arkdown-mermaid-convert-button')
    const explanationButton = block.querySelector('.arkdown-code-explanation-button')
    expect(mermaidButton?.nextElementSibling).toBe(explanationButton)

    block.remove()
    await flushAppearance()
    root.append(block)
    await flushAppearance()

    expect(block.querySelectorAll('.arkdown-code-explanation-button')).toHaveLength(1)
    expect(block.querySelectorAll('.arkdown-mermaid-convert-button')).toHaveLength(1)

    dispose()
    expect(block.querySelector('.arkdown-code-explanation-button')).toBeNull()
    root.remove()
  })

  it('settles after observer refreshes when the explanation control is already correctly placed', async () => {
    const root = document.createElement('div')
    const block = blockMarkup()
    root.append(block)
    document.body.append(root)
    const insert = vi.spyOn(Element.prototype, 'insertAdjacentElement')
    let dispose: (() => void) | undefined

    try {
      dispose = installStructuredBlockAppearance(root)
      await flushAppearance()
      const explanationButton = block.querySelector('.arkdown-code-explanation-button')
      const initialPlacements = insert.mock.calls.filter(([, element]) => (
        element === explanationButton
      )).length

      block.querySelector('.cm-content')?.append(document.createElement('span'))
      await flushAppearance()

      expect(block.querySelector('.arkdown-mermaid-convert-button')?.nextElementSibling)
        .toBe(explanationButton)
      expect(insert.mock.calls.filter(([, element]) => element === explanationButton))
        .toHaveLength(initialPlacements)
    } finally {
      dispose?.()
      insert.mockRestore()
      root.remove()
    }
  })

  it('cleans up picker animation frames and viewport listeners on disposal', () => {
    const root = document.createElement('div')
    root.append(blockMarkup())
    document.body.append(root)
    const addListener = vi.spyOn(window, 'addEventListener')
    const removeListener = vi.spyOn(window, 'removeEventListener')
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(41)
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)

    const dispose = installStructuredBlockAppearance(root)
    expect(requestFrame).toHaveBeenCalled()
    expect(addListener).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(addListener).toHaveBeenCalledWith('scroll', expect.any(Function), true)

    dispose()
    expect(cancelFrame).toHaveBeenCalledWith(41)
    expect(removeListener).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(removeListener).toHaveBeenCalledWith('scroll', expect.any(Function), true)

    requestFrame.mockRestore()
    cancelFrame.mockRestore()
    addListener.mockRestore()
    removeListener.mockRestore()
    root.remove()
  })

  it('watches the editor scroll boundary and releases its resize observer', () => {
    const scrollBoundary = document.createElement('div')
    scrollBoundary.style.overflowX = 'auto'
    scrollBoundary.style.overflowY = 'auto'
    const root = document.createElement('div')
    root.append(blockMarkup())
    scrollBoundary.append(root)
    document.body.append(scrollBoundary)

    let resizeCallback: ResizeObserverCallback | undefined
    const observe = vi.fn()
    const disconnect = vi.fn()
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback
      }

      observe = observe
      disconnect = disconnect
      unobserve = vi.fn()
    }
    const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(window, 'ResizeObserver')
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: TestResizeObserver,
    })
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(51)
    let dispose: (() => void) | undefined

    try {
      dispose = installStructuredBlockAppearance(root)
      expect(observe).toHaveBeenCalledWith(scrollBoundary)

      requestFrame.mockClear()
      resizeCallback?.([], {} as ResizeObserver)
      expect(requestFrame).toHaveBeenCalledTimes(1)

      dispose()
      dispose = undefined
      expect(disconnect).toHaveBeenCalledTimes(1)
    } finally {
      dispose?.()
      requestFrame.mockRestore()
      if (resizeObserverDescriptor) {
        Object.defineProperty(window, 'ResizeObserver', resizeObserverDescriptor)
      } else {
        delete (window as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
      }
      scrollBoundary.remove()
    }
  })
})
