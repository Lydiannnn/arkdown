import { expect, it } from 'vitest'
import { decodeDocument, encodeDocument } from '../../src/main/documents/document-codec'

it('detects a UTF-8 BOM and CRLF and preserves both on encode', () => {
  const source = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('# 标题\r\n正文\r\n', 'utf8'),
  ])

  const decoded = decodeDocument(source)

  expect(decoded).toEqual({
    markdown: '# 标题\n正文\n',
    encoding: 'utf8-bom',
    newline: 'crlf',
  })
  expect(encodeDocument(decoded.markdown, decoded.encoding, decoded.newline)).toEqual(source)
})

it('preserves UTF-8 without a BOM and LF newlines', () => {
  const source = Buffer.from('# Plain\nBody\n', 'utf8')

  const decoded = decodeDocument(source)

  expect(decoded).toEqual({
    markdown: '# Plain\nBody\n',
    encoding: 'utf8',
    newline: 'lf',
  })
  expect(encodeDocument(decoded.markdown, decoded.encoding, decoded.newline)).toEqual(source)
})

it('rejects invalid UTF-8 instead of returning replacement characters', () => {
  expect(() => decodeDocument(Buffer.from([0xff, 0xfe, 0xfd]))).toThrow(
    'Unsupported document encoding',
  )
})

it('preserves a second UTF-8 BOM as the first document character', () => {
  const source = Buffer.from([
    0xef, 0xbb, 0xbf,
    0xef, 0xbb, 0xbf,
    0x78, 0x0a,
  ])

  const decoded = decodeDocument(source)

  expect(decoded).toEqual({
    markdown: '\ufeffx\n',
    encoding: 'utf8-bom',
    newline: 'lf',
  })
  expect(encodeDocument(decoded.markdown, decoded.encoding, decoded.newline)).toEqual(source)
})

it('rejects invalid runtime encode inputs at the codec boundary', () => {
  expect(() => encodeDocument(
    42 as unknown as string,
    'utf8',
    'lf',
  )).toThrow('Invalid document markdown')
  expect(() => encodeDocument(
    '# Text\n',
    'utf16' as never,
    'lf',
  )).toThrow('Unsupported document encoding')
  expect(() => encodeDocument(
    '# Text\n',
    'utf8',
    'cr' as never,
  )).toThrow('Unsupported newline style')
})

it.each(['', '\tconst x = `<tag>`;', 'a\r\nb\r\n', 'a\nb\n', 'a\r\nb\nc\r', '\ufeffa\r\nb\n'])('roundtrips code source with exact whitespace: %j', text => {
  const source = Buffer.from(text, 'utf8')
  const decoded = decodeDocument(source, { preserveNewlines: true })
  expect(encodeDocument(decoded.markdown, decoded.encoding, decoded.newline, { preserveNewlines: true })).toEqual(source)
})

it('rejects binary control characters instead of treating UTF-16 or binary as editable text', () => {
  expect(() => decodeDocument(Buffer.from([0x61, 0, 0x62, 0]))).toThrow(/binary/i)
})
