import type { CSSProperties } from 'react'
import type { FileIconKind } from '../../shared/file-icon-kind'
import closedFolderIcon from '../assets/file-icons/folder-closed-22px.png'
import openFolderIcon from '../assets/file-icons/folder-open-22px.png'
import markdownIcon from '../assets/file-icons/md.svg'
import textIcon from '../assets/file-icons/txt.svg'
import docxIcon from '../assets/file-icons/docx.svg'
import pdf from '../assets/file-icons/pdf.svg'
import xlsx from '../assets/file-icons/xlsx.svg'
import pptx from '../assets/file-icons/pptx.svg'
import epub from '../assets/file-icons/epub.svg'
import markdownOther from '../assets/file-icons/markdown-other.svg'
import documentIcon from '../assets/file-icons/document-22px.png'
import './file-type-icon.css'

const ICONS: Record<FileIconKind, string> = {
  folder: closedFolderIcon,
  markdown: markdownIcon,
  text: textIcon,
  docx: docxIcon,
  pdf,
  xlsx,
  pptx,
  epub,
  'markdown-other': markdownOther,
  document: documentIcon,
}

export interface FileTypeIconProps {
  kind: FileIconKind
  className?: string
  folderOpen?: boolean
}

export function FileTypeIcon({ kind, className = '', folderOpen = false }: FileTypeIconProps) {
  const size = 22 / (window.devicePixelRatio || 1)
  const style = { width: size, height: size } satisfies CSSProperties
  const source = kind === 'folder' && folderOpen ? openFolderIcon : ICONS[kind]
  const folderClass = kind === 'folder' ? 'file-type-icon--folder' : ''
  return (
    <img
      alt=""
      aria-hidden="true"
      className={`file-type-icon ${folderClass} ${className}`.trim()}
      data-testid="file-type-icon"
      draggable={false}
      src={source}
      style={style}
    />
  )
}
