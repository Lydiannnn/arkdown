import { describe, expect, it } from 'vitest'
import {
  chooseStartupWindowIntent,
  startupDocumentIntent,
} from '../../src/main/startup-document-intent'

describe('Windows startup document intent', () => {
  it.each(['data.json', 'config.cjs', 'source.ts', 'icon.svg', 'Dockerfile', '.env.local'])(
    'accepts explicit startup source %s', name => {
      const target = `C:\\Notes\\${name}`
      expect(startupDocumentIntent(['C:\\Apps\\Arkdown.exe', target], true)).toBe(target)
    },
  )
  it('selects the supported absolute Markdown path passed to a packaged executable', () => {
    expect(startupDocumentIntent([
      'C:\\Apps\\Arkdown\\Arkdown.exe',
      'C:\\Notes\\方案.md',
    ], true)).toBe('C:\\Notes\\方案.md')
  })

  it('skips the Electron development entry and accepts a DOCX import path', () => {
    expect(startupDocumentIntent([
      'C:\\Electron\\electron.exe',
      '.',
      '--inspect=0',
      'C:\\Notes\\report.docx',
    ], false)).toBe('C:\\Notes\\report.docx')
  })

  it('ignores flags, directories, relative values, and unsupported files', () => {
    expect(startupDocumentIntent([
      'C:\\Apps\\Arkdown\\Arkdown.exe',
      '--verbose',
      'C:\\Notes',
      'relative.md',
      'C:\\Notes\\malware.exe',
    ], true)).toBeNull()
  })
})

describe('startup window intent priority', () => {
  it('restores the most recent valid document when there is no explicit or recovered document', () => {
    expect(chooseStartupWindowIntent({
      explicitDocument: null,
      recoveredDraftCount: 0,
      recentDocuments: ['C:\\Notes\\latest.md', 'C:\\Notes\\older.md'],
    })).toEqual({ kind: 'document', absolutePath: 'C:\\Notes\\latest.md' })
  })

  it('keeps explicit startup arguments ahead of drafts and recent documents', () => {
    expect(chooseStartupWindowIntent({
      explicitDocument: 'C:\\Notes\\explicit.md',
      recoveredDraftCount: 2,
      recentDocuments: ['C:\\Notes\\latest.md'],
    })).toEqual({ kind: 'document', absolutePath: 'C:\\Notes\\explicit.md' })
  })

  it('does not create another ordinary window when drafts were recovered', () => {
    expect(chooseStartupWindowIntent({
      explicitDocument: null,
      recoveredDraftCount: 2,
      recentDocuments: ['C:\\Notes\\latest.md'],
    })).toEqual({ kind: 'none' })
  })

  it('opens a blank window when no restorable document exists', () => {
    expect(chooseStartupWindowIntent({
      explicitDocument: null,
      recoveredDraftCount: 0,
      recentDocuments: [],
    })).toEqual({ kind: 'blank' })
  })
})
