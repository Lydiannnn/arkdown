import { expect, it } from 'vitest'
import {
  CLIPBOARD_FORMAT_TOOLTIPS,
  clipboardFormatAvailability,
  plainTextFromHtml,
  sanitizeClipboardHtml,
} from '../../src/renderer/editor/context-menu/clipboard-formats'

it('defines the approved clipboard-format tooltips and exact availability', () => {
  expect(CLIPBOARD_FORMAT_TOOLTIPS).toEqual({
    plain: '仅粘贴文字，不解析 Markdown 或 HTML 格式',
    markdown: '按 Markdown 语法解析标题、列表、链接等格式',
    html: '读取并转换剪贴板中的 HTML 格式',
    htmlUnavailable: '剪贴板中没有 HTML 格式',
  })
  expect(clipboardFormatAvailability({
    plainText: '# 普通文本',
    markdown: null,
    html: null,
  })).toEqual({ plain: true, markdown: true, html: false })
  expect(clipboardFormatAvailability({
    plainText: '',
    markdown: '# 精确 Markdown',
    html: '<h1>HTML</h1>',
  })).toEqual({ plain: false, markdown: true, html: true })
})

it('removes executable, embedded and remote-loading clipboard content', () => {
  const sanitized = sanitizeClipboardHtml(`
    <p onclick="steal()">Safe <strong>text</strong></p>
    <script>alert(1)</script>
    <iframe src="https://evil.example"></iframe>
    <img src="https://tracker.example/pixel.png" onerror="steal()" alt="remote">
    <a href="javascript:steal()">bad link</a>
    <a href="https://example.com">safe link</a>
  `)

  expect(sanitized).toContain('<strong>text</strong>')
  expect(sanitized).toContain('href="https://example.com"')
  expect(sanitized).not.toMatch(/script|iframe|onclick|onerror|javascript:|tracker\.example/i)
})

it('keeps local image references without fetching them', () => {
  expect(sanitizeClipboardHtml(
    '<img src="C:\\notes\\assets\\photo.png" alt="Photo">',
  )).toContain('src="C:\\notes\\assets\\photo.png"')
})

it('converts block HTML to readable plain text', () => {
  expect(plainTextFromHtml(
    '<h2>Title</h2><p>First<br>Second</p><ul><li>One</li><li>Two</li></ul>',
  )).toBe('Title\nFirst\nSecond\nOne\nTwo')
})
