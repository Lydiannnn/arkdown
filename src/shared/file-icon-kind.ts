import { documentTypeForPath } from './document-types'
import { OTHER_MARKDOWN_EXTENSIONS } from './branding'

export type FileIconKind = 'folder' | 'markdown' | 'text' | 'docx' | 'pdf' | 'xlsx' | 'pptx' | 'epub' | 'markdown-other' | 'document'
export type DocumentFileIconKind = Exclude<FileIconKind, 'folder'>

export function fileIconKindForPath(pathname: string): DocumentFileIconKind {
  const definition = documentTypeForPath(pathname)
  if (definition?.extension === 'md') return 'markdown'
  if (OTHER_MARKDOWN_EXTENSIONS.some((extension) => extension === definition?.extension)) return 'markdown-other'
  if (definition?.extension === 'txt' || definition?.extension === 'text') return 'text'
  if (definition?.extension === 'docx') return 'docx'
  if (definition?.extension === 'pdf') return 'pdf'
  if (definition?.extension === 'xlsx') return 'xlsx'
  if (definition?.extension === 'pptx') return 'pptx'
  if (definition?.extension === 'epub') return 'epub'
  return 'document'
}
