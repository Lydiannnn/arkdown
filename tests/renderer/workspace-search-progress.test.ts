import { describe, expect, it, vi } from 'vitest'
import {
  searchCurrentDirectoryDocuments,
  searchDescendantDocuments,
  searchWorkspaceDocuments,
} from '../../src/renderer/workspace/workspace-navigation'

function readableDocument(relativePath: string, markdown = 'needle') {
  return {
    ok: true as const,
    value: {
      relativePath,
      markdown,
      revision: 'a'.repeat(64),
      encoding: 'utf8' as const,
      newline: 'lf' as const,
      mtimeMs: 1,
    },
  }
}

describe('workspace search progress', () => {
  it('reports a root listing failure instead of treating it as an empty search', async () => {
    const result = await searchCurrentDirectoryDocuments({
      query: 'needle',
      listDirectory: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'READ_FAILED', message: 'Unable to list directory' },
      })),
      readDocument: vi.fn(),
      root: 'notes',
    })

    expect(result).toMatchObject({
      matches: [],
      failedDirectories: ['notes'],
      failedDocuments: [],
    })
  })

  it('searches only direct documents and pauses before nested folders', async () => {
    const listDirectory = vi.fn(async (relativePath: string) => ({
      ok: true as const,
      value: relativePath === ''
        ? [
            { name: 'root.md', relativePath: 'root.md', kind: 'document' as const },
            { name: 'nested', relativePath: 'nested', kind: 'directory' as const },
          ]
        : [{
            name: 'child.md',
            relativePath: 'nested/child.md',
            kind: 'document' as const,
          }],
    }))
    const readDocument = vi.fn(async (relativePath: string) => readableDocument(relativePath))

    const result = await searchCurrentDirectoryDocuments({
      query: 'needle',
      listDirectory,
      readDocument,
    })

    expect(result).toMatchObject({
      scannedDocuments: 1,
      hasDescendants: true,
      truncated: false,
    })
    expect(result.matches.map((match) => match.relativePath)).toEqual(['root.md'])
    expect(listDirectory).not.toHaveBeenCalledWith('nested')
    expect(readDocument).not.toHaveBeenCalledWith('nested/child.md')
  })

  it('searches every descendant breadth-first without rereading direct documents', async () => {
    const listDirectory = vi.fn(async (relativePath: string) => {
      if (relativePath === '') {
        return {
          ok: true as const,
          value: [
            { name: 'root.md', relativePath: 'root.md', kind: 'document' as const },
            { name: 'nested', relativePath: 'nested', kind: 'directory' as const },
          ],
        }
      }
      if (relativePath === 'nested') {
        return {
          ok: true as const,
          value: [
            {
              name: 'child.md',
              relativePath: 'nested/child.md',
              kind: 'document' as const,
            },
            {
              name: 'deep',
              relativePath: 'nested/deep',
              kind: 'directory' as const,
            },
          ],
        }
      }
      return {
        ok: true as const,
        value: [{
          name: 'grandchild.md',
          relativePath: 'nested/deep/grandchild.md',
          kind: 'document' as const,
        }],
      }
    })
    const readDocument = vi.fn(async (relativePath: string) => readableDocument(relativePath))

    const result = await searchDescendantDocuments({
      query: 'needle',
      listDirectory,
      readDocument,
      remainingLimit: 500,
    })

    expect(result.matches.map((match) => match.relativePath)).toEqual([
      'nested/child.md',
      'nested/deep/grandchild.md',
    ])
    expect(readDocument).not.toHaveBeenCalledWith('root.md')
    expect(listDirectory.mock.calls.map(([relativePath]) => relativePath)).toEqual([
      '',
      'nested',
      'nested/deep',
    ])
  })

  it('keeps other descendant matches when a nested directory cannot be listed', async () => {
    const result = await searchDescendantDocuments({
      query: 'needle',
      remainingLimit: 500,
      listDirectory: vi.fn(async (relativePath: string) => {
        if (relativePath === '') {
          return {
            ok: true as const,
            value: [
              { name: 'available', relativePath: 'available', kind: 'directory' as const },
              { name: 'blocked', relativePath: 'blocked', kind: 'directory' as const },
            ],
          }
        }
        if (relativePath === 'blocked') {
          return {
            ok: false as const,
            error: { code: 'READ_FAILED', message: 'Unable to list directory' },
          }
        }
        return {
          ok: true as const,
          value: [{
            name: 'hit.md',
            relativePath: 'available/hit.md',
            kind: 'document' as const,
          }],
        }
      }),
      readDocument: vi.fn(async (relativePath: string) => readableDocument(relativePath)),
    })

    expect(result.matches.map((match) => match.relativePath)).toEqual(['available/hit.md'])
    expect(result.failedDirectories).toEqual(['blocked'])
  })

  it('reports a non-name-matching document whose body cannot be read', async () => {
    const result = await searchCurrentDirectoryDocuments({
      query: 'needle',
      listDirectory: vi.fn(async () => ({
        ok: true as const,
        value: [{ name: 'other.md', relativePath: 'other.md', kind: 'document' as const }],
      })),
      readDocument: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'READ_FAILED', message: 'Unable to read document' },
      })),
    })

    expect(result.matches).toEqual([])
    expect(result.failedDocuments).toEqual(['other.md'])
  })

  it('retains a filename match and marks its unreadable body in the diagnostic', async () => {
    const result = await searchCurrentDirectoryDocuments({
      query: 'needle',
      listDirectory: vi.fn(async () => ({
        ok: true as const,
        value: [{ name: 'needle.md', relativePath: 'needle.md', kind: 'document' as const }],
      })),
      readDocument: vi.fn(async () => Promise.reject(new Error('read failed'))),
    })

    expect(result.matches).toEqual([{
      relativePath: 'needle.md',
      title: 'needle.md',
      preview: '文件名匹配（正文读取失败）',
      contentMatches: false,
    }])
    expect(result.failedDocuments).toEqual(['needle.md'])
  })

  it('keeps a successful empty search distinct from a failed search', async () => {
    const result = await searchCurrentDirectoryDocuments({
      query: 'needle',
      listDirectory: vi.fn(async () => ({ ok: true as const, value: [] })),
      readDocument: vi.fn(),
    })

    expect(result).toMatchObject({
      matches: [],
      failedDirectories: [],
      failedDocuments: [],
    })
  })

  it('stops descendant continuation when its remaining document budget is exhausted', async () => {
    const readDocument = vi.fn(async (relativePath: string) => readableDocument(relativePath))
    const result = await searchDescendantDocuments({
      query: 'needle',
      remainingLimit: 1,
      listDirectory: vi.fn(async (relativePath: string) => ({
        ok: true as const,
        value: relativePath === ''
          ? [{ name: 'nested', relativePath: 'nested', kind: 'directory' as const }]
          : [
              { name: 'first.md', relativePath: 'nested/first.md', kind: 'document' as const },
              { name: 'second.md', relativePath: 'nested/second.md', kind: 'document' as const },
            ],
      })),
      readDocument,
    })

    expect(result.truncated).toBe(true)
    expect(result.matches.map((match) => match.relativePath)).toEqual(['nested/first.md'])
    expect(readDocument).not.toHaveBeenCalledWith('nested/second.md')
  })

  it('publishes current-folder matches before a nested folder finishes scanning', async () => {
    let releaseNested = () => {}
    let markNestedStarted = () => {}
    const nestedGate = new Promise<void>((resolve) => { releaseNested = resolve })
    const nestedStarted = new Promise<void>((resolve) => { markNestedStarted = resolve })
    const updates: string[][] = []

    const resultPromise = searchWorkspaceDocuments({
      query: 'needle',
      listDirectory: vi.fn(async (relativePath: string) => {
        if (relativePath === '') {
          return {
            ok: true as const,
            value: [
              { name: 'root.md', relativePath: 'root.md', kind: 'document' as const },
              { name: 'nested', relativePath: 'nested', kind: 'directory' as const },
            ],
          }
        }
        markNestedStarted()
        await nestedGate
        return {
          ok: true as const,
          value: [{
            name: 'child.md',
            relativePath: 'nested/child.md',
            kind: 'document' as const,
          }],
        }
      }),
      readDocument: vi.fn(async (relativePath: string) => ({
        ok: true as const,
        value: {
          relativePath,
          markdown: 'needle',
          revision: 'a'.repeat(64),
          encoding: 'utf8' as const,
          newline: 'lf' as const,
          mtimeMs: 1,
        },
      })),
      onProgress: (result) => {
        updates.push(result.matches.map((match) => match.relativePath))
      },
    })

    await nestedStarted
    const updatesBeforeNestedFinished = updates.map((paths) => [...paths])
    releaseNested()
    const result = await resultPromise

    expect(updatesBeforeNestedFinished).toEqual([['root.md']])
    expect(result.matches.map((match) => match.relativePath)).toEqual([
      'root.md',
      'nested/child.md',
    ])
  })
})
