import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  normalizeImportedDocxMarkdown,
  normalizeMarkdownForDocxExport,
} from '../../src/main/docx/docx-markdown'

const importRoot = path.join('C:\\', 'Arkdown', 'temp', 'docx', 'operation-id')

describe('normalizeImportedDocxMarkdown', () => {
  it('normalizes a Pandoc HTML image inside the imported media directory', () => {
    expect(normalizeImportedDocxMarkdown(
      '<img src="media/media/rId9.png" alt="像素图片" />',
      importRoot,
    )).toBe(
      `<img src="${path.join(importRoot, 'media', 'media', 'rId9.png')}" alt="像素图片" style="zoom:100%;" />`,
    )
  })

  it('continues to normalize Pandoc Markdown image syntax', () => {
    expect(normalizeImportedDocxMarkdown(
      '![图 & 文](<media/media/图%20片.png>){width="10"}',
      importRoot,
    )).toBe(
      `<img src="${path.join(importRoot, 'media', 'media', '图 片.png')}" alt="图 &amp; 文" style="zoom:100%;" />`,
    )
  })

  it('reads single-quoted HTML attributes and sanitizes normalized output', () => {
    expect(normalizeImportedDocxMarkdown(
      "<img title='ignored' alt='A &amp; B' src='media/media/图 &amp; 片.png' onerror='ignored'>",
      importRoot,
    )).toBe(
      `<img src="${path.join(importRoot, 'media', 'media', '图 & 片.png').replaceAll('&', '&amp;')}" alt="A &amp; B" style="zoom:100%;" />`,
    )
  })

  it.each([
    '../outside.png',
    'media/../outside.png',
    'media/../../outside.png',
    'media2/outside.png',
    'C:\\outside.png',
    'file:///C:/outside.png',
    'https://example.com/outside.png',
    'media/note.txt',
  ])('leaves unsafe or non-image HTML sources unchanged: %s', (source) => {
    const input = `<img src="${source}" alt="blocked" />`
    expect(normalizeImportedDocxMarkdown(input, importRoot)).toBe(input)
  })

  it('leaves HTML images without a source unchanged', () => {
    const input = '<img alt="missing source" />'
    expect(normalizeImportedDocxMarkdown(input, importRoot)).toBe(input)
  })
})

describe('normalizeMarkdownForDocxExport', () => {
  it('continues to convert absolute local HTML images for Pandoc export', () => {
    expect(normalizeMarkdownForDocxExport(
      '<img src="C:\\docs\\图 片.png" alt="图 &amp; 文" style="zoom:50%;" />',
    )).toBe('![图 & 文](<C:/docs/图 片.png>)')
  })
})
