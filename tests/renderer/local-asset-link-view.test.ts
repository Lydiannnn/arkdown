import { describe, expect, it } from 'vitest'
import { applyLinkAttributes } from '../../src/renderer/editor/local-asset-link-view'

describe('link target attributes', () => {
  it.each([
    ['www.example.com/guide', 'https://www.example.com/guide', 'arkdown-web-link'],
    ['C:\\Workspace\\assets\\guide.pdf', 'C:\\Workspace\\assets\\guide.pdf', 'arkdown-local-link'],
    ['file:///C:/Workspace/My%20Guide.pdf', 'C:\\Workspace\\My Guide.pdf', 'arkdown-local-link'],
  ])('normalizes %s and applies its target class', (input, href, className) => {
    const anchor = document.createElement('a')

    applyLinkAttributes(anchor, input, null)

    expect(anchor.getAttribute('href')).toBe(href)
    expect(anchor).toHaveClass(className)
    expect(anchor).not.toHaveAttribute('title')
    expect(anchor.dataset.tooltip).toBe('Ctrl+单击打开')
  })

  it('preserves the Markdown title on a supported web link', () => {
    const anchor = document.createElement('a')

    applyLinkAttributes(anchor, 'https://example.com/guide', 'Guide')

    expect(anchor.getAttribute('href')).toBe('https://example.com/guide')
    expect(anchor).toHaveClass('arkdown-web-link')
    expect(anchor).not.toHaveAttribute('title')
    expect(anchor.dataset.tooltip).toBe('Guide')
  })

  it('removes stale target state when the next href is unsupported', () => {
    const anchor = document.createElement('a')
    applyLinkAttributes(anchor, 'C:\\Workspace\\guide.pdf', null)
    anchor.classList.add('arkdown-link-openable')

    applyLinkAttributes(anchor, 'javascript:alert(1)', null)

    expect(anchor.hasAttribute('href')).toBe(false)
    expect(anchor.hasAttribute('title')).toBe(false)
    expect(anchor).not.toHaveAttribute('data-tooltip')
    expect(anchor).not.toHaveClass('arkdown-web-link')
    expect(anchor).not.toHaveClass('arkdown-local-link')
    expect(anchor).not.toHaveClass('arkdown-link-openable')
  })
})
