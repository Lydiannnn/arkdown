import { describe, expect, it } from 'vitest'
import {
  normalizeAutomaticLinkText,
  parseAiMessageLinkTarget,
  parseLinkTarget,
} from '../../src/shared/link-target'

describe('parseLinkTarget', () => {
  it.each([
    ['https://example.com/docs?q=arkdown#links', {
      kind: 'web', url: 'https://example.com/docs?q=arkdown#links',
    }],
    ['http://example.com/', { kind: 'web', url: 'http://example.com/' }],
    ['www.example.com/docs', { kind: 'web', url: 'https://www.example.com/docs' }],
  ] as const)('normalizes the supported web target %s', (value, expected) => {
    expect(parseLinkTarget(value)).toEqual(expected)
  })

  it.each([
    ['C:\\Workspace\\notes\\road map.md', 'C:\\Workspace\\notes\\road map.md'],
    ['C:/Workspace/notes.md', 'C:\\Workspace\\notes.md'],
    ['\\\\server\\share\\team notes.md', '\\\\server\\share\\team notes.md'],
  ])('normalizes the absolute Windows path %s without rewriting spaces', (value, expected) => {
    expect(parseLinkTarget(value)).toEqual({ kind: 'local', path: expected })
  })

  it.each([
    ['file:///C:/Workspace/team%20notes.md', 'C:\\Workspace\\team notes.md'],
    ['file://server/share/team%20notes.md', '\\\\server\\share\\team notes.md'],
  ])('converts the Windows file URL %s to a native path', (value, expected) => {
    expect(parseLinkTarget(value)).toEqual({ kind: 'local', path: expected })
  })

  it.each([
    'mailto:hello@example.com',
    'javascript:alert(1)',
    'https:example.com',
    'https:\\example.com',
    'relative\\note.md',
    'https://user:secret@example.com/',
    'file:///C:/notes.md?download=1',
    'file:///C:/notes.md#section',
    'file:///C:/bad%ZZ.md',
    'file:///home/user/notes.md',
    'file://user:secret@server/share/notes.md',
  ])('rejects unsupported or unsafe target %s', (value) => {
    expect(parseLinkTarget(value)).toBeNull()
  })

  it.each([
    'https:///example.com',
    'https:////example.com',
    String.raw`https://\\example.com`,
  ])('rejects the malformed raw web authority %s', (value) => {
    expect(parseLinkTarget(value)).toBeNull()
  })

  it.each([
    'file:///C|/Windows/file.txt',
    'file://C:/Windows/file.txt',
    String.raw`file:///C:\Windows/file.txt`,
    String.raw`file://server\share/file.txt`,
  ])('rejects the malformed raw Windows file URL %s before browser repair', (value) => {
    expect(parseLinkTarget(value)).toBeNull()
  })

  it('rejects malformed and oversized values', () => {
    expect(parseLinkTarget('https://example.com/%ZZ')).toBeNull()
    expect(parseLinkTarget(`https://example.com/${'a'.repeat(32_768)}`)).toBeNull()
    expect(parseLinkTarget(null)).toBeNull()
  })
})

describe('parseAiMessageLinkTarget', () => {
  it.each([
    ['https://example.com/docs?q=arkdown', {
      kind: 'web', url: 'https://example.com/docs?q=arkdown',
    }],
    ['C:/Workspace/notes/report.pdf', {
      kind: 'local', path: 'C:\\Workspace\\notes\\report.pdf', scope: 'absolute',
    }],
    ['notes/report.pdf', {
      kind: 'local', path: 'notes\\report.pdf', scope: 'workspace-relative',
    }],
  ] as const)('normalizes the safe AI message target %s', (value, expected) => {
    expect(parseAiMessageLinkTarget(value)).toEqual(expected)
  })

  it.each([
    '\\\\server\\share\\report.pdf',
    'file://server/share/report.pdf',
    '\\\\?\\C:\\Workspace\\report.pdf',
    '\\\\.\\C:\\Workspace\\report.pdf',
    '\\??\\C:\\Workspace\\report.pdf',
    'C:\\Workspace\\report.pdf:payload.exe',
    'notes/report.pdf:payload.exe',
    'C:\\Workspace\\CON.txt',
    'notes\\nul.md',
    'notes\\CLOCK$.txt',
    'notes\\NUL .md',
    'notes\\CLOCK$ .pdf',
    'notes\\report.pdf.',
    'notes\\report.pdf ',
    'notes\\..\\report.pdf',
    'notes\\.\\report.pdf',
    'notes\\bad\0name.pdf',
    'javascript:alert(1)',
    'mailto:test@example.com',
    'file:///C:/Workspace/team%20notes.pdf',
    'file:///C:/Workspace/%2e%2e/secret.pdf',
  ])('rejects the unsafe AI message target %s', (value) => {
    expect(parseAiMessageLinkTarget(value)).toBeNull()
  })
})

describe('normalizeAutomaticLinkText', () => {
  it('recognizes a quoted local path with spaces and removes only the delimiter quotes', () => {
    expect(normalizeAutomaticLinkText('"C:\\Workspace\\team notes.md"')).toEqual({
      kind: 'local',
      path: 'C:\\Workspace\\team notes.md',
    })
  })

  it.each([
    '"C:\\Workspace\\unterminated.md',
    '"https://example.com/"',
    "'C:\\Workspace\\team notes.md'",
  ])('rejects invalid automatic quote form %s', (value) => {
    expect(normalizeAutomaticLinkText(value)).toBeNull()
  })
})
