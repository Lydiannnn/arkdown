import { describe, expect, it } from 'vitest'
import {
  fileNameForHeaderEditing,
  normalizeHeaderFileName,
} from '../../src/shared/document-header-file-name'

describe('document header file name policy', () => {
  it('uses a Markdown suggestion when an unsaved DOCX import enters editing', () => {
    expect(fileNameForHeaderEditing('report.docx', false)).toBe('report.md')
    expect(fileNameForHeaderEditing('计划.md', false)).toBe('计划.md')
    expect(fileNameForHeaderEditing('report.docx', true)).toBe('report.docx')
  })

  it('adds the correct extension when the edited name omits one', () => {
    expect(normalizeHeaderFileName('计划', '未命名', false))
      .toEqual({ ok: true, value: '计划.md' })
    expect(normalizeHeaderFileName('新名称', '旧名称.txt', true))
      .toEqual({ ok: true, value: '新名称.txt' })
    expect(normalizeHeaderFileName('新名称', '旧名称.markdown', true))
      .toEqual({ ok: true, value: '新名称.markdown' })
  })

  it('accepts supported explicit extensions for the corresponding document state', () => {
    expect(normalizeHeaderFileName('说明.txt', '未命名', false))
      .toEqual({ ok: true, value: '说明.txt' })
    expect(normalizeHeaderFileName('说明.mdx', '旧名称.md', true))
      .toEqual({ ok: true, value: '说明.mdx' })
  })

  it.each([
    '',
    '   ',
    'CON.md',
    'aux.txt',
    '../escape.md',
    'folder/name.md',
    'bad?.md',
    'trailing. ',
  ])('rejects the invalid Windows file name %j', (input) => {
    expect(normalizeHeaderFileName(input, '旧名称.md', true).ok).toBe(false)
  })

  it('rejects a raw trailing space before any otherwise-valid input is trimmed', () => {
    expect(normalizeHeaderFileName('name.md ', '旧名称.md', true)).toEqual({
      ok: false,
      message: '文件名不能以空格或句点结尾',
    })
  })

  it('rejects a non-saveable extension for a new document', () => {
    expect(normalizeHeaderFileName('report.docx', '未命名', false).ok).toBe(false)
    expect(normalizeHeaderFileName('archive.markdown', '未命名', false).ok).toBe(false)
  })

  it.each(['Dockerfile', '.env', '.env.local', 'source.ts', 'data.json'])('keeps source filenames in header rename and save-as: %s', name => {
    expect(normalizeHeaderFileName(name, 'source.ts', true)).toEqual({ ok: true, value: name })
    expect(fileNameForHeaderEditing(name, false)).toBe(name)
    expect(normalizeHeaderFileName(name, name, false)).toEqual({ ok: true, value: name })
  })
})
