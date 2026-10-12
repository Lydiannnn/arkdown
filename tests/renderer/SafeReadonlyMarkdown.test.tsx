import { render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SafeReadonlyMarkdown,
  sanitizeReadonlyMarkdownUrl,
} from '../../src/renderer/editor/SafeReadonlyMarkdown'

describe('SafeReadonlyMarkdown', () => {
  it('renders link and image titles as standard tips and clears them after content updates', () => {
    const { container, rerender } = render(<SafeReadonlyMarkdown markdown={'[Guide](https://example.com "Help")\n\n![Photo](photo.png "Caption")'} />)
    expect(screen.getByRole('link', { name: 'Guide' })).toHaveAttribute('data-tooltip', 'Help')
    expect(screen.getByAltText('Photo')).toHaveAttribute('data-tooltip', 'Caption')
    expect(container.querySelector('[title]')).toBeNull()
    rerender(<SafeReadonlyMarkdown markdown={'[Guide](https://example.com)\n\n![Photo](photo.png)'} />)
    expect(container.querySelector('[data-tooltip]')).toBeNull()
  })

  it('renders lists, GFM tables, and fenced code as semantic read-only content', () => {
    const { container } = render(<SafeReadonlyMarkdown markdown={[
      '- first',
      '- second',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| One | 1 |',
      '',
      '```ts',
      'const value = 1',
      '```',
    ].join('\n')} />)

    expect(screen.getAllByRole('listitem').map((item) => item.textContent))
      .toEqual(['first', 'second'])
    const table = screen.getByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'Name' })).toBeVisible()
    expect(within(table).getByRole('cell', { name: '1' })).toBeVisible()
    expect(container.querySelector('pre > code')).toHaveTextContent('const value = 1')
  })

  it('skips raw HTML and omits navigation or loading attributes for dangerous targets', () => {
    const { container } = render(<SafeReadonlyMarkdown markdown={[
      '<script>window.__unsafe = true</script>',
      '<img src="https://attacker.invalid/pixel" onerror="window.__unsafe = true">',
      '[danger](javascript:alert(1))',
      '![danger image](data:text/html,bad)',
      String.raw`[mixed slash](/\\evil.example/path)`,
      String.raw`![mixed slash image](/\\evil.example/pixel.png)`,
      '[safe](https://example.com/path)',
      '![safe image](images/cover.png)',
    ].join('\n\n')} />)

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('[onerror]')).toBeNull()
    expect(container).not.toHaveTextContent('window.__unsafe')
    expect(screen.getByText('danger').closest('a')).not.toHaveAttribute('href')
    expect(screen.getByAltText('danger image')).not.toHaveAttribute('src')
    expect(screen.getByText('mixed slash').closest('a')).not.toHaveAttribute('href')
    expect(screen.getByAltText('mixed slash image')).not.toHaveAttribute('src')
    expect(screen.getByRole('link', { name: 'safe' })).toHaveAttribute(
      'href',
      'https://example.com/path',
    )
    expect(screen.getByAltText('safe image')).toHaveAttribute('src', 'images/cover.png')
  })

  it('can suppress every image resource while preserving safe link navigation', () => {
    const { container } = render(<SafeReadonlyMarkdown
      allowImages={false}
      markdown={[
        '![remote](https://example.com/pixel.png)',
        '![local](images/cover.png)',
        '[documentation](https://example.com/docs)',
      ].join('\n\n')}
    />)

    expect(container.querySelectorAll('img')).toHaveLength(2)
    expect(container.querySelector('img[src]')).toBeNull()
    expect(screen.getByRole('link', { name: 'documentation' }))
      .toHaveAttribute('href', 'https://example.com/docs')
  })

  it('keeps the mark sentinel as an ordinary link unless mark rendering is enabled', () => {
    const { container } = render(
      <SafeReadonlyMarkdown markdown="[ordinary](#arkdown-safe-readonly-mark)" />,
    )

    expect(screen.getByRole('link', { name: 'ordinary' }))
      .toHaveAttribute('href', '#arkdown-safe-readonly-mark')
    expect(container.querySelector('mark')).toBeNull()
  })

  it.each([
    ['http://example.com', 'http://example.com'],
    ['https://example.com', 'https://example.com'],
    ['mailto:user@example.com', 'mailto:user@example.com'],
    ['#section', '#section'],
    ['docs/page.md', 'docs/page.md'],
    ['/docs/page.md', '/docs/page.md'],
    ['./page.md', './page.md'],
    ['../page.md', '../page.md'],
    ['//evil.example/path', undefined],
    [String.raw`\evil.example\path`, undefined],
    [String.raw`/\evil.example/path`, undefined],
    ['javascript:alert(1)', undefined],
    ['data:text/html,bad', undefined],
    ['file:///C:/secret.txt', undefined],
    ['ftp://example.com/file', undefined],
    ['custom:value', undefined],
    ['https://exa\u0000mple.com', undefined],
  ])('sanitizes %j to %j', (input, expected) => {
    expect(sanitizeReadonlyMarkdownUrl(input)).toBe(expected)
  })

  it('keeps structured whitespace semantics when legacy output CSS loads later', () => {
    const style = document.createElement('style')
    style.textContent = [
      readFileSync(join(process.cwd(), 'src/renderer/editor/safe-readonly-markdown.css'), 'utf8'),
      readFileSync(join(process.cwd(), 'src/renderer/editor/selection-translation.css'), 'utf8'),
    ].join('\n')
    document.head.append(style)
    try {
      const { container } = render(
        <SafeReadonlyMarkdown className="translation-output" markdown="first\n\nsecond" />,
      )
      expect(getComputedStyle(container.querySelector('.translation-output')!).whiteSpace)
        .toBe('normal')
    } finally {
      style.remove()
    }
  })
})
