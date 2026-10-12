import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArkdownApi, StickyNoteImportResult, StickyNoteSummary } from '../../src/shared/contracts'
import { StickyNoteBoxPanel } from '../../src/renderer/sticky-notes/StickyNoteBoxPanel'
import { stickyNoteApiStubs } from './sticky-note-api-stubs'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const imported = (name: string, warnings: StickyNoteImportResult['warnings'] = []): StickyNoteImportResult => ({
  note: {
    record: {
      id: '10000000-0000-4000-8000-000000000001',
      name,
      status: 'active',
      markdownRelativePath: `active/id/${name}.md`,
      resourcesRelativePath: 'active/id/assets',
      style: { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
      background: { ...DEFAULT_BACKGROUND_SETTINGS },
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z',
      archivedAt: null,
      released: false,
      pinned: false,
      windowBounds: null,
      lastOpenedAt: null,
      fontSizePx: 13,
      lineSpacingMode: 'compact',
    },
    markdown: '# 内容',
  },
  warnings,
})

function installApi(active: StickyNoteSummary[] = []) {
  const importStickyNote = vi.fn(async (path: string) => ({
    ok: true as const,
    value: imported(typeof path === 'string' ? (path.split(/[\\/]/).at(-1) ?? '便签') : '无路径'),
  }))
  window.arkdown = {
    ...stickyNoteApiStubs,
    listStickyNotes: vi.fn(async (status) => ({
      ok: true as const,
      value: status === 'active' ? active : [],
    })),
    pathForDroppedFile: vi.fn((file: File) => `C:\\Notes\\${file.name}`),
    importStickyNote,
  } as unknown as ArkdownApi
  return importStickyNote
}

describe('sticky note file import drop', () => {
  beforeEach(() => installApi())

  it('imports Markdown and text files, but reports unsupported files', async () => {
    const importStickyNote = installApi()
    render(<StickyNoteBoxPanel onClose={vi.fn()} />)
    const grid = await screen.findByRole('grid', { name: '便签' })
    fireEvent.drop(grid, {
      dataTransfer: {
        files: [
          new File(['# A'], 'a.md', { type: 'text/markdown' }),
          new File(['B'], 'b.txt', { type: 'text/plain' }),
          new File(['x'], 'image.png', { type: 'image/png' }),
        ],
        types: ['Files'],
      },
    })

    await waitFor(() => expect(importStickyNote).toHaveBeenCalledTimes(2))
    expect(importStickyNote.mock.calls.map(([path]) => path)).toEqual([
      'C:\\Notes\\a.md',
      'C:\\Notes\\b.txt',
    ])
    expect(screen.getByText('不支持导入：image.png')).toBeVisible()
  })

  it('contains file drops inside the sticky-note box', async () => {
    const outerDrop = vi.fn()
    render(<div onDrop={outerDrop}><StickyNoteBoxPanel onClose={vi.fn()} /></div>)
    const grid = await screen.findByRole('grid', { name: '便签' })

    fireEvent.drop(grid, {
      dataTransfer: {
        files: [new File(['# A'], 'a.md', { type: 'text/markdown' })],
        types: ['Files'],
      },
    })

    expect(outerDrop).not.toHaveBeenCalled()
  })

  it('accepts .markdown and shows resource-copy warnings', async () => {
    const importStickyNote = vi.fn(async () => ({
      ok: true as const,
      value: imported('引用', [{
        source: 'C:\\Notes\\missing.png',
        reason: 'missing' as const,
      }]),
    }))
    window.arkdown = {
      ...stickyNoteApiStubs,
      listStickyNotes: vi.fn(async () => ({ ok: true as const, value: [] })),
      pathForDroppedFile: vi.fn(() => 'C:\\Notes\\note.markdown'),
      importStickyNote,
    } as unknown as ArkdownApi

    render(<StickyNoteBoxPanel onClose={vi.fn()} />)
    fireEvent.drop(await screen.findByRole('grid', { name: '便签' }), {
      dataTransfer: {
        files: [new File(['![x](missing.png)'], 'note.markdown')],
        types: ['Files'],
      },
    })
    expect(await screen.findByText('部分引用资源未能复制：missing.png')).toBeVisible()
  })

  it('does not import beyond the 35-note active limit', async () => {
    const summaries = Array.from({ length: 35 }, (_, index) => imported(`便签${index}`).note)
      .map((note, index) => ({
        record: {
          ...note.record,
          id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        },
        excerpt: '',
      }))
    const importStickyNote = installApi(summaries)
    render(<StickyNoteBoxPanel onClose={vi.fn()} />)
    fireEvent.drop(await screen.findByRole('grid', { name: '便签' }), {
      dataTransfer: {
        files: [new File(['x'], 'extra.md')],
        types: ['Files'],
      },
    })
    expect(importStickyNote).not.toHaveBeenCalled()
    expect(screen.getByText('标签盒子已满，建议将不常用标签进行归档')).toBeVisible()
  })
})
