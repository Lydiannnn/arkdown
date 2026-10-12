import { describe, expect, it } from 'vitest'
import { documentSaveDialogOptions } from '../../src/main/document-save-dialog'

describe('document save dialog', () => {
  it('shows Markdown and plain text as separate canonical save types', () => {
    expect(documentSaveDialogOptions()).toEqual({
      title: '另存为',
      defaultPath: '未命名.md',
      filters: [
        {
          name: 'Markdown 文档',
          extensions: ['md'],
        },
        {
          name: '文本文件',
          extensions: ['txt'],
        },
      ],
    })
  })

  it('uses an edited document name as the default path', () => {
    expect(documentSaveDialogOptions('计划.md').defaultPath).toBe('计划.md')
  })

  it.each(['data.json', 'code.cjs', 'source.ts', 'image.svg'])('preserves the current source extension for %s', name => {
    expect(documentSaveDialogOptions(name).filters?.[0].extensions).toEqual([name.split('.').at(-1)])
  })

  it.each(['Dockerfile', '.env', '.gitignore'])('does not append an extension to %s', name => {
    expect(documentSaveDialogOptions(name).filters?.[0].extensions).toEqual(['*'])
  })
})
