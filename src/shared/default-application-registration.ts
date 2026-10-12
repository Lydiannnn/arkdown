import { OTHER_MARKDOWN_EXTENSIONS } from './branding.ts'

/** Shared by application registration and the installer-owned uninstall cleanup. */
export const DEFAULT_APPLICATION_CANDIDATES = [
  ['Arkdown.Document.Markdown', 'Markdown 文档', 'ark-md.ico', ['md']],
  ['Arkdown.Document.Text', '文本文档', 'ark-txt.ico', ['txt', 'text']],
  ['Arkdown.Document.Docx', 'Word 文档', 'ark-docx.ico', ['docx']],
  ['Arkdown.Document.OtherMarkdown', 'Markdown 文档', 'ark-markdown-other.ico', OTHER_MARKDOWN_EXTENSIONS],
] as const
