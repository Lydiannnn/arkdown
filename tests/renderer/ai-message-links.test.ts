import { describe, expect, it } from 'vitest'
import {
  classifyAiMessageLink,
  linkifyAiMessageLocalPaths,
} from '../../src/renderer/editor/ai-message-links'

describe('AI message links', () => {
  it('accepts only credential-free HTTP(S) web targets', () => {
    expect(classifyAiMessageLink('https://example.com/a'))
      .toEqual({ kind: 'web', target: 'https://example.com/a', revealOnly: false })
    expect(classifyAiMessageLink('http://example.com/a')).not.toBeNull()
    expect(classifyAiMessageLink('https://user:pass@example.com/a')).toBeNull()
    expect(classifyAiMessageLink('https://example.com/%00hidden')).toBeNull()
    expect(classifyAiMessageLink('http:\\\\example.com\\report')).toBeNull()
    expect(classifyAiMessageLink('javascript:alert(1)')).toBeNull()
    expect(classifyAiMessageLink('data:text/plain,secret')).toBeNull()
  })

  it('recognizes bare drive-local paths while rejecting file schemes, network, and device paths', () => {
    expect(classifyAiMessageLink('C:\\Work\\report.md'))
      .toEqual({ kind: 'local', target: 'C:\\Work\\report.md', revealOnly: false })
    expect(classifyAiMessageLink('file:///C:/Work/report.md')).toBeNull()
    expect(classifyAiMessageLink('C:\\Work\\run.ps1'))
      .toEqual({ kind: 'local', target: 'C:\\Work\\run.ps1', revealOnly: true })
    expect(classifyAiMessageLink('C:\\Work\\installer.msi'))
      .toEqual({ kind: 'local', target: 'C:\\Work\\installer.msi', revealOnly: true })
    expect(classifyAiMessageLink('C:\\Work\\help.chm'))
      .toEqual({ kind: 'local', target: 'C:\\Work\\help.chm', revealOnly: true })
    expect(classifyAiMessageLink('C:\\Work\\unknown.bin'))
      .toEqual({ kind: 'local', target: 'C:\\Work\\unknown.bin', revealOnly: true })
    expect(classifyAiMessageLink('C:\\Work.\\report.md'))
      .toEqual({ kind: 'local', target: 'C:\\Work.\\report.md', revealOnly: true })
    expect(classifyAiMessageLink('C:\\Work\\report.md.'))
      .toEqual({ kind: 'local', target: 'C:\\Work\\report.md.', revealOnly: true })
    expect(classifyAiMessageLink('\\\\server\\share\\report.md')).toBeNull()
    expect(classifyAiMessageLink('\\\\?\\C:\\Work\\report.md')).toBeNull()
    expect(classifyAiMessageLink('C:\\Work\\report.md:stream'))
      .toEqual({ kind: 'local', target: 'C:\\Work\\report.md:stream', revealOnly: true })
    expect(classifyAiMessageLink('file:///C:/Work/report%00.md')).toBeNull()
    expect(classifyAiMessageLink('file:///C:/Work./report.md')).toBeNull()
    expect(classifyAiMessageLink('file:///C:/Work/report.md%20')).toBeNull()
    expect(classifyAiMessageLink('file:///C:/Work/report.md%3Astream')).toBeNull()
    expect(classifyAiMessageLink('file://server/share/report.md')).toBeNull()
  })

  it.each([
    'com', 'scr', 'msi', 'hta', 'cpl', 'reg', 'vbs', 'js', 'jse',
    'wsf', 'wsh', 'url', 'scf', 'chm',
  ])('never exposes .%s paths as openable links', (extension) => {
    expect(classifyAiMessageLink(`C:\\Work\\unsafe.${extension}`))
      .toEqual({ kind: 'local', target: `C:\\Work\\unsafe.${extension}`, revealOnly: true })
    expect(classifyAiMessageLink(`file:///C:/Work/unsafe.${extension}`)).toBeNull()
  })

  it.each([
    'CON', 'con.txt', 'PRN.md', 'aux .txt', 'NUL.', 'clock$.md',
    'COM1.txt', 'com9...', 'LPT1.md', 'lpt9 .pdf', 'CONIN$.txt', 'conout$.MD',
  ])('marks the DOS device path segment %s as copy-only', (segment) => {
    expect(classifyAiMessageLink(`C:\\Work\\${segment}`))
      .toEqual({ kind: 'local', target: `C:\\Work\\${segment}`, revealOnly: true })
  })

  it('checks DOS device basenames in every bare path segment', () => {
    expect(classifyAiMessageLink('C:\\Work\\con.txt\\report.md')?.revealOnly).toBe(true)
    expect(classifyAiMessageLink('C:\\Work\\LPT9...\\report.md')?.revealOnly).toBe(true)
  })

  it('linkifies standalone local paths without changing fenced code', () => {
    expect(linkifyAiMessageLocalPaths([
      'Created:',
      'C:\\Work Space\\notes.md',
      '```text',
      'C:\\not-a-link.md',
      '```',
    ].join('\n'))).toBe([
      'Created:',
      '[C:\\\\Work Space\\\\notes.md](<C:/Work Space/notes.md>)',
      '```text',
      'C:\\not-a-link.md',
      '```',
    ].join('\n'))
  })

  it('does not close a longer code fence with a shorter run of the same marker', () => {
    expect(linkifyAiMessageLocalPaths([
      '````markdown',
      '```',
      'C:\\inside-backticks.md',
      '`````',
      'C:\\outside-backticks.md',
      '~~~~~',
      '~~~~',
      'C:\\inside-tildes.md',
      '~~~~~~',
      'C:\\outside-tildes.md',
    ].join('\n'))).toBe([
      '````markdown',
      '```',
      'C:\\inside-backticks.md',
      '`````',
      '[C:\\\\outside-backticks.md](<C:/outside-backticks.md>)',
      '~~~~~',
      '~~~~',
      'C:\\inside-tildes.md',
      '~~~~~~',
      '[C:\\\\outside-tildes.md](<C:/outside-tildes.md>)',
    ].join('\n'))
  })

  it('does not turn a path with trailing normalization characters into an openable link', () => {
    expect(linkifyAiMessageLocalPaths('C:\\Work\\report.md ')).toBe('C:\\Work\\report.md ')
    expect(linkifyAiMessageLocalPaths('C:\\Work\\report.md.')).toContain('<C:/Work/report.md.>')
    expect(classifyAiMessageLink('C:\\Work\\report.md.')?.revealOnly).toBe(true)
  })

  it('leaves CommonMark indented code paths unchanged', () => {
    expect(linkifyAiMessageLocalPaths('    C:\\Work\\four-spaces.md'))
      .toBe('    C:\\Work\\four-spaces.md')
    expect(linkifyAiMessageLocalPaths('\tC:\\Work\\tab.md'))
      .toBe('\tC:\\Work\\tab.md')
    expect(linkifyAiMessageLocalPaths('   C:\\Work\\three-spaces.md'))
      .toContain('<C:/Work/three-spaces.md>')
  })
})
