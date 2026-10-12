import type { DocumentEncoding, NewlineStyle } from '../../shared/contracts'

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

export function decodeDocument(bytes: Buffer, options: { preserveNewlines?: boolean } = {}): {
  markdown: string
  encoding: DocumentEncoding
  newline: NewlineStyle
} {
  const hasBom = bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)
  const body = hasBom ? bytes.subarray(UTF8_BOM.length) : bytes

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body)
  } catch {
    throw Object.assign(new Error('Unsupported document encoding'), { code: 'DOCUMENT_ENCODING_UNSUPPORTED' })
  }

  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(text)) {
    throw Object.assign(new Error('Unsupported binary document'), { code: 'DOCUMENT_BINARY' })
  }

  const newline: NewlineStyle = text.includes('\r\n') ? 'crlf' : 'lf'
  return {
    markdown: options.preserveNewlines ? text : text.replace(/\r\n/g, '\n'),
    encoding: hasBom ? 'utf8-bom' : 'utf8',
    newline,
  }
}

export function encodeDocument(
  markdown: string,
  encoding: DocumentEncoding,
  newline: NewlineStyle,
  options: { preserveNewlines?: boolean } = {},
): Buffer {
  if (typeof markdown !== 'string') throw new Error('Invalid document markdown')
  if (encoding !== 'utf8' && encoding !== 'utf8-bom') {
    throw new Error('Unsupported document encoding')
  }
  if (newline !== 'lf' && newline !== 'crlf') {
    throw new Error('Unsupported newline style')
  }

  const normalized = markdown.replace(/\r\n/g, '\n')
  const text = options.preserveNewlines ? markdown
    : newline === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized
  const body = Buffer.from(text, 'utf8')
  return encoding === 'utf8-bom' ? Buffer.concat([UTF8_BOM, body]) : body
}
