import { describe, expect, it } from 'vitest'
import { fileIconKindForPath } from '../../src/shared/file-icon-kind'

describe('fileIconKindForPath', () => {
  it.each([
    ['note.md', 'markdown'],
    ['note.markdown', 'markdown-other'],
    ['note.txt', 'text'],
    ['note.text', 'text'],
    ['note.docx', 'docx'],
    ['note.qmd', 'markdown-other'],
    ['note.MD', 'markdown'],
    ['note.MDX', 'markdown-other'],
    ['note.Rmd', 'markdown-other'],
    ['note.PDF', 'pdf'],
    ['note.xlsx', 'xlsx'],
    ['note.pptx', 'pptx'],
    ['note.epub', 'epub'],
    ['note.unknown', 'document'],
  ] as const)('maps %s to the %s icon', (pathname, expected) => {
    expect(fileIconKindForPath(pathname)).toBe(expected)
  })
})
