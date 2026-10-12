import { describe, expect, it, vi } from 'vitest'
import { StickyNoteSearchIndex } from '../../src/main/sticky-notes/sticky-note-search-index'
import type {
  StickyNoteDocument,
  StickyNoteStatus,
  StickyNoteSummary,
} from '../../src/shared/sticky-notes'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const timestamp = '2026-07-31T00:00:00.000Z'
function note(
  idSuffix: number,
  name: string,
  markdown: string,
  status: StickyNoteStatus = 'active',
): StickyNoteDocument {
  const id = `10000000-0000-4000-8000-${String(idSuffix).padStart(12, '0')}`
  return {
    record: {
      id,
      name,
      status,
      markdownRelativePath: `${status === 'active' ? 'active' : 'archive'}/${id}/${name}.md`,
      resourcesRelativePath: `${status === 'active' ? 'active' : 'archive'}/${id}/resources`,
      style: { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
      background: { ...DEFAULT_BACKGROUND_SETTINGS },
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: status === 'archived' ? timestamp : null,
      released: false,
      pinned: false,
      windowBounds: null,
      lastOpenedAt: null,
      fontSizePx: 13,
      lineSpacingMode: 'compact',
    },
    markdown,
  }
}

function harness() {
  const documents = new Map([
    [note(1, 'Release Plan', '# Heading\n\nAlpha beta').record.id, note(1, 'Release Plan', '# Heading\n\nAlpha beta')],
    [note(2, '中文便签', '今天检查搜索功能').record.id, note(2, '中文便签', '今天检查搜索功能')],
    [note(3, '旧计划', '归档的 Alpha 内容', 'archived').record.id, note(3, '旧计划', '归档的 Alpha 内容', 'archived')],
  ])
  const list = vi.fn(async (status: StickyNoteStatus): Promise<StickyNoteSummary[]> =>
    [...documents.values()]
      .filter((document) => document.record.status === status)
      .map((document) => ({ record: document.record, excerpt: document.markdown })))
  const get = vi.fn(async (noteId: string) => documents.get(noteId)!)
  return { documents, list, get, index: new StickyNoteSearchIndex({ list, get }) }
}

describe('StickyNoteSearchIndex', () => {
  it('matches names and Markdown content case-insensitively with useful snippets', async () => {
    const { index } = harness()

    await expect(index.search({ status: 'active', query: 'release' }))
      .resolves.toMatchObject([{ name: 'Release Plan' }])
    await expect(index.search({ status: 'active', query: 'ALPHA' }))
      .resolves.toMatchObject([{ name: 'Release Plan', excerpt: expect.stringContaining('Alpha') }])
    await expect(index.search({ status: 'active', query: '搜索功能' }))
      .resolves.toMatchObject([{ name: '中文便签' }])
    await expect(index.search({ status: 'active', query: '归档' })).resolves.toEqual([])
  })

  it('lazily loads archive documents only on the first archived search', async () => {
    const { index, list, get } = harness()

    await index.search({ status: 'active', query: 'plan' })
    expect(list).toHaveBeenCalledWith('active')
    expect(list).not.toHaveBeenCalledWith('archived')

    await index.search({ status: 'archived', query: 'alpha' })
    await index.search({ status: 'archived', query: '旧计划' })
    expect(list.mock.calls.filter(([status]) => status === 'archived')).toHaveLength(1)
    expect(get.mock.calls.filter(([id]) => id.endsWith('000000000003'))).toHaveLength(1)
  })

  it('refreshes one cached note after a save without rebuilding the status index', async () => {
    const { index, documents, list } = harness()
    const selected = [...documents.values()][0]!
    await index.search({ status: 'active', query: 'before' })
    documents.set(selected.record.id, { ...selected, markdown: '内容已经变为 after' })

    await index.refresh(selected.record.id)

    await expect(index.search({ status: 'active', query: 'after' }))
      .resolves.toMatchObject([{ noteId: selected.record.id }])
    expect(list.mock.calls.filter(([status]) => status === 'active')).toHaveLength(1)
  })
})
