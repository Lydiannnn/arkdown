import { describe, expect, it, vi } from 'vitest'
import {
  listRootDocumentCards,
  streamNestedDocumentCards,
} from '../../src/renderer/workspace/workspace-navigation'

const snapshot = (relativePath: string) => ({
  ok: true as const,
  value: {
    relativePath,
    markdown: `# ${relativePath}\n\n正文`,
    revision: 'a'.repeat(64),
    encoding: 'utf8' as const,
    newline: 'lf' as const,
    mtimeMs: 1,
  },
})

describe('staged workspace document loading', () => {
  it('loads direct documents without entering child directories', async () => {
    const listDirectory = vi.fn(async () => ({
      ok: true as const,
      value: [
        { name: 'nested', relativePath: 'nested', kind: 'directory' as const },
        { name: 'root.md', relativePath: 'root.md', kind: 'document' as const },
      ],
    }))
    const readDocument = vi.fn(async (path: string) => snapshot(path))
    const result = await listRootDocumentCards(listDirectory, readDocument)
    expect(result.cards.map((card) => card.relativePath)).toEqual(['root.md'])
    expect(result.hasNested).toBe(true)
    expect(listDirectory).toHaveBeenCalledTimes(1)
    expect(listDirectory).toHaveBeenCalledWith('')
  })

  it('streams nested cards breadth-first and omits direct documents', async () => {
    const listDirectory = vi.fn(async (path: string) => ({
      ok: true as const,
      value: path === ''
        ? [
            { name: 'a', relativePath: 'a', kind: 'directory' as const },
            { name: 'root.md', relativePath: 'root.md', kind: 'document' as const },
          ]
        : path === 'a'
          ? [
              { name: 'b', relativePath: 'a/b', kind: 'directory' as const },
              { name: 'a.md', relativePath: 'a/a.md', kind: 'document' as const },
            ]
          : [{ name: 'b.md', relativePath: 'a/b/b.md', kind: 'document' as const }],
    }))
    const batches: string[][] = []
    for await (const batch of streamNestedDocumentCards({
      listDirectory,
      readDocument: vi.fn(async (path: string) => snapshot(path)),
    })) {
      batches.push(batch.map((card) => card.relativePath))
    }
    expect(batches).toEqual([['a/a.md'], ['a/b/b.md']])
  })
})
