import { describe, expect, it } from 'vitest'
import { parseDocumentViewLink } from '../../src/shared/document-view-link'

describe('parseDocumentViewLink', () => {
  it.each([
    ['browser.json', { kind: 'relative', path: 'browser.json' }],
    ['../报告/有 空格.md', { kind: 'relative', path: '../报告/有 空格.md' }],
    ['./dir/space%20name.md', { kind: 'relative', path: './dir/space name.md' }],
    ['../%E4%B8%AD%E6%96%87.md#%E6%A0%87%E9%A2%98', { kind: 'relative', path: '../中文.md', anchor: '标题' }],
    ['file%2520.md', { kind: 'relative', path: 'file%20.md' }],
    ['../src/app.ts#L42', { kind: 'relative', path: '../src/app.ts', line: 42 }],
    ['../src/app.ts:42', { kind: 'relative', path: '../src/app.ts', line: 42 }],
    ['#heading', { kind: 'anchor', anchor: 'heading' }],
    ['folder/', { kind: 'relative', path: 'folder/' }],
    ['..\\sibling.md', { kind: 'relative', path: '..\\sibling.md' }],
  ])('parses %s without normalizing the caller href', (href, want) => {
    expect(parseDocumentViewLink(href)).toEqual(want)
  })

  it.each([
    '', null, 4, 'https://example.com/a.md', 'http://example.com', 'www.example.com',
    'file:///C:/a.md', 'C:/a.md', 'C:a.md', '/root/a.md', '\\root\\a.md',
    '//server/share/a.md', '\\\\server\\share\\a.md', '\\\\?\\C:\\a.md',
    'javascript:alert(1)', 'javascript:42', 'mailto:42', 'a.md%3a42', 'a.md:stream', 'a.md::$DATA', './C:/a.md', 'a.md:0',
    'a.md:9007199254740992', 'CON.md', 'dir/AUX.txt', 'dir/NUL', 'COM¹.txt',
    'dir/PRN .txt', 'trailing./a.md', 'trailing /a.md', 'bad?.md', 'bad*.md',
    'a%00.md', 'a\u0000.md', 'a%ZZ.md', '%2froot/a.md', '%5c%5cserver/a.md',
    'dir%2fa.md', '%43%3a/a.md', 'a%3aevil.md', 'a.md?download=1',
    'a.md\n', '#bad%00', 'a.md#bad%ZZ',
  ])('rejects unsafe or non-relative input %s', (href) => {
    expect(parseDocumentViewLink(href)).toBeNull()
  })
})
