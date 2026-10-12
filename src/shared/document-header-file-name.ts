import { isCodeDocumentPath, isEditableDocumentPath } from './document-types'

export type HeaderFileNameResult =
  | { ok: true; value: string }
  | { ok: false; message: string }

const INVALID_WINDOWS_NAME = /[<>:"/\\|?*\u0000-\u001f]/
const RESERVED_WINDOWS_NAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

export function hasInvalidWindowsFileNameCharacters(fileName: string): boolean {
  return INVALID_WINDOWS_NAME.test(fileName)
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 && dot < fileName.length - 1
    ? fileName.slice(dot)
    : ''
}

function stemOf(fileName: string): string {
  const extension = extensionOf(fileName)
  return extension ? fileName.slice(0, -extension.length) : fileName
}

function isSaveDialogFileName(fileName: string): boolean {
  return /\.(?:md|txt)$/i.test(fileName) || isCodeDocumentPath(fileName)
}

export function fileNameForHeaderEditing(
  fileName: string,
  hasOriginal: boolean,
): string {
  if (hasOriginal || !extensionOf(fileName) || isSaveDialogFileName(fileName)) {
    return fileName
  }
  return `${stemOf(fileName)}.md`
}

export function normalizeHeaderFileName(
  input: string,
  currentFileName: string,
  hasOriginal: boolean,
): HeaderFileNameResult {
  const trimmed = input.trim()
  if (!trimmed) return { ok: false, message: '文件名不能为空' }
  if (trimmed.length > 255) return { ok: false, message: '文件名不能超过 255 个字符' }
  if (hasInvalidWindowsFileNameCharacters(trimmed) || RESERVED_WINDOWS_NAME.test(trimmed)) {
    return { ok: false, message: '文件名包含 Windows 不允许使用的字符或名称' }
  }
  if (/[ .]$/.test(input)) {
    return { ok: false, message: '文件名不能以空格或句点结尾' }
  }

  const extension = extensionOf(trimmed)
  const normalized = extension || isCodeDocumentPath(trimmed)
    ? trimmed
    : `${trimmed}${hasOriginal ? extensionOf(currentFileName) || '.md' : '.md'}`

  if (hasOriginal) {
    return isEditableDocumentPath(normalized)
      ? { ok: true, value: normalized }
      : { ok: false, message: '请选择 Arkdown 支持的文档扩展名' }
  }

  return isSaveDialogFileName(normalized)
    ? { ok: true, value: normalized }
    : { ok: false, message: '请选择 Arkdown 支持的文档扩展名' }
}
