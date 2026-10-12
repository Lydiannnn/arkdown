import { describe, expect, it } from 'vitest'
import { buildArchivedStickyNoteMenu } from '../../src/renderer/sticky-notes/archived-sticky-note-menu-model'
import type { StickyNoteSummary } from '../../src/shared/sticky-notes'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

function archivedNote(): StickyNoteSummary {
  return {
    record: {
      id: '10000000-0000-4000-8000-000000000001',
      name: '已归档计划',
      status: 'archived',
      markdownRelativePath: 'archive/id/已归档计划.md',
      resourcesRelativePath: 'archive/id/resources',
      style: { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
      background: { ...DEFAULT_BACKGROUND_SETTINGS },
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z',
      archivedAt: '2026-07-31T00:00:00.000Z',
      released: false,
      pinned: false,
      windowBounds: null,
      lastOpenedAt: null,
      fontSizePx: 13,
      lineSpacingMode: 'compact',
    },
    excerpt: '归档内容',
  }
}

describe('archived sticky note menu', () => {
  it('contains restore, rename and permanent delete in the approved order', () => {
    expect(buildArchivedStickyNoteMenu(archivedNote(), 1)).toEqual([
      {
        kind: 'command',
        id: 'sticky-restore',
        label: '恢复到便签盒子',
        disabled: false,
      },
      { kind: 'command', id: 'sticky-rename', label: '重命名' },
      {
        kind: 'command',
        id: 'sticky-delete',
        label: '删除',
        danger: true,
      },
    ])
  })

  it('disables restore when the active box is full', () => {
    expect(buildArchivedStickyNoteMenu(archivedNote(), 0)[0]).toMatchObject({
      id: 'sticky-restore',
      disabled: true,
      disabledReason: '剩余 0 个位置，已选 1 个便签',
    })
  })

  it('disables rename while multiple archived notes are selected', () => {
    expect(buildArchivedStickyNoteMenu(archivedNote(), 3, 3)[1]).toMatchObject({
      id: 'sticky-rename',
      disabled: true,
      disabledReason: '多选时不可重命名',
    })
  })

  it('explains insufficient remaining capacity for the selected archive group', () => {
    expect(buildArchivedStickyNoteMenu(archivedNote(), 1, 3)[0]).toMatchObject({
      id: 'sticky-restore', disabled: true,
      disabledReason: '剩余 1 个位置，已选 3 个便签',
    })
    expect(buildArchivedStickyNoteMenu(archivedNote(), 3, 3)[0]).toMatchObject({ disabled: false })
  })
})
