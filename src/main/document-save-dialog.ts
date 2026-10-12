import type { SaveDialogOptions } from 'electron'
import { isCodeDocumentPath } from '../shared/document-types'

export function documentSaveDialogOptions(suggestedFileName = '未命名.md'): SaveDialogOptions {
  if (isCodeDocumentPath(suggestedFileName)) {
    const name = suggestedFileName.split(/[\\/]/).at(-1) ?? suggestedFileName
    const dot = name.lastIndexOf('.')
    const extension = dot > 0 ? name.slice(dot + 1) : '*'
    return {
      title: '另存为',
      defaultPath: suggestedFileName,
      filters: [
        { name: '源代码 / 配置文件', extensions: [extension] },
        ...(extension === '*' ? [] : [{ name: '所有文件', extensions: ['*'] }]),
      ],
    }
  }
  return {
    title: '另存为',
    defaultPath: suggestedFileName,
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
  }
}
