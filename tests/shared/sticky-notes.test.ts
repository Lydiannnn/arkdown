import { describe, expect, it } from 'vitest'
import {
  MAX_ACTIVE_STICKY_NOTES,
  STICKY_NOTE_SCHEMA_VERSION,
  STICKY_NOTE_WINDOW_OPACITY_PERCENT,
  copyStickyNoteIndex,
  parseStickyNoteEvent,
  parseStickyNoteIndex,
  parseStickyNoteRecord,
  upgradeStickyNoteIndex,
  type StickyNoteRecord,
} from '../../src/shared/sticky-notes'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const NOTE_ID = '9b6d8d86-7a68-4cab-951c-6a25e09dd14b'
const SECOND_NOTE_ID = '35b6c454-8f24-453a-9666-6c62d3a95d20'
const CREATED_AT = '2026-07-31T00:00:00.000Z'

function record(overrides: Partial<StickyNoteRecord> = {}): StickyNoteRecord {
  return {
    id: NOTE_ID,
    name: '便签260731-壹',
    status: 'active',
    markdownRelativePath: `active/${NOTE_ID}/便签260731-壹.md`,
    resourcesRelativePath: `active/${NOTE_ID}/resources`,
    style: {
      mode: 'preset',
      colorPresetId: 'yellow',
      texturePresetId: 'plain',
    },
    background: DEFAULT_BACKGROUND_SETTINGS,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    archivedAt: null,
    released: false,
    pinned: false,
    windowBounds: null,
    lastOpenedAt: null,
    fontSizePx: 13,
    lineSpacingMode: 'compact',
    ...overrides,
  }
}

describe('sticky note domain', () => {
  it('defines the first-release limits and an opaque note window', () => {
    expect(STICKY_NOTE_SCHEMA_VERSION).toBe(5)
    expect(MAX_ACTIVE_STICKY_NOTES).toBe(35)
    expect(STICKY_NOTE_WINDOW_OPACITY_PERCENT).toBe(100)
  })

  it('parses an active preset-style note', () => {
    expect(parseStickyNoteRecord(record())).toEqual(record())
  })

  it('upgrades every schema v2 note to compact line spacing and schema v5', () => {
    const {
      lineSpacingMode: _lineSpacingMode,
      background: _background,
      ...v2Record
    } = record()
    const upgraded = upgradeStickyNoteIndex({
      schemaVersion: 2,
      notes: [v2Record],
      openNoteIdsAtLastSession: [NOTE_ID],
      defaultHelpNoteCreated: true,
    })

    expect(upgraded?.schemaVersion).toBe(5)
    expect(upgraded?.notes.every((note) => note.lineSpacingMode === 'compact')).toBe(true)
  })

  it('upgrades a schema-v3 classic index to schema version 5 without changing its style', () => {
    const { background: _background, ...v3Record } = record()
    const upgraded = upgradeStickyNoteIndex({
      schemaVersion: 3,
      notes: [v3Record],
      openNoteIdsAtLastSession: [NOTE_ID],
      defaultHelpNoteCreated: true,
    })

    expect(upgraded?.schemaVersion).toBe(5)
    expect(upgraded?.notes[0]?.style).toEqual({
      mode: 'preset',
      colorPresetId: 'yellow',
      texturePresetId: 'plain',
    })
  })

  it('rejects a schema-v3 index with a v4-only material style', () => {
    expect(upgradeStickyNoteIndex({
      schemaVersion: 3,
      notes: [record({
        style: { mode: 'material', materialPresetId: 'mica-light' },
      })],
      openNoteIdsAtLastSession: [NOTE_ID],
      defaultHelpNoteCreated: true,
    })).toBeUndefined()
  })

  it('round-trips a schema-v5 material note with background settings', () => {
    const parsed = parseStickyNoteIndex({
      schemaVersion: 5,
      notes: [record({
        style: { mode: 'material', materialPresetId: 'mica-dark' as never },
        background: {
          imageRelativePath: 'resources/background.webp',
          imageOpacityPercent: 35,
          maskType: 'circle',
          maskOpacityPercent: 40,
          maskTransitionPercent: 60,
        } as never,
      })],
      openNoteIdsAtLastSession: [NOTE_ID],
      defaultHelpNoteCreated: true,
    })

    expect(parsed?.notes[0]?.style).toEqual({
      mode: 'material',
      materialPresetId: 'mica-light',
    })
    expect(parsed?.notes[0]?.background).toEqual({
      imageRelativePath: 'resources/background.webp',
      imageOpacityPercent: 35,
      imageAlignment: 'right-bottom',
      maskType: 'circle',
      maskOpacityPercent: 40,
      maskTransitionPercent: 60,
      maskStrengthPercent: 50,
    })
  })

  it('upgrades every schema-v4 note with default background settings', () => {
    const { background: _background, ...v4Record } = record()

    const upgraded = upgradeStickyNoteIndex({
      schemaVersion: 4,
      notes: [v4Record],
      openNoteIdsAtLastSession: [NOTE_ID],
      defaultHelpNoteCreated: true,
    })

    expect(upgraded).toMatchObject({
      schemaVersion: 5,
      notes: [{ background: DEFAULT_BACKGROUND_SETTINGS }],
    })
  })

  it.each([
    ['an incomplete background', { imageRelativePath: null }],
    ['a non-integer opacity', {
      ...DEFAULT_BACKGROUND_SETTINGS,
      imageOpacityPercent: 20.5,
    }],
    ['an unknown mask', {
      ...DEFAULT_BACKGROUND_SETTINGS,
      maskType: 'spotlight',
    }],
  ])('rejects %s', (_label, background) => {
    expect(parseStickyNoteRecord(record({ background } as Partial<StickyNoteRecord>)))
      .toBeUndefined()
  })

  it('rejects a v3 record with an unknown line spacing mode', () => {
    expect(parseStickyNoteRecord({
      ...record(),
      lineSpacingMode: 'dense',
    })).toBeUndefined()
  })

  it('parses only strict line-spacing change events', () => {
    expect(parseStickyNoteEvent({
      type: 'note-line-spacing-changed',
      noteId: NOTE_ID,
      revision: 1,
      lineSpacingMode: 'standard',
    })).toEqual({
      type: 'note-line-spacing-changed',
      noteId: NOTE_ID,
      revision: 1,
      lineSpacingMode: 'standard',
    })
    expect(parseStickyNoteEvent({
      type: 'note-line-spacing-changed',
      noteId: NOTE_ID,
      revision: 1,
      lineSpacingMode: 'dense',
    })).toBeUndefined()
    expect(parseStickyNoteEvent({
      type: 'note-line-spacing-changed',
      noteId: NOTE_ID,
      revision: 1,
      lineSpacingMode: 'standard',
      unexpected: true,
    })).toBeUndefined()
  })

  it('parses an archived independent-style note', () => {
    const archived = record({
      status: 'archived',
      markdownRelativePath: `archive/${NOTE_ID}/旧便签.md`,
      resourcesRelativePath: `archive/${NOTE_ID}/resources`,
      style: {
        mode: 'independent',
        color: '#202020',
        texture: {
          pattern: 'dots',
          foregroundColor: '#FFFFFF',
          opacityPercent: 20,
          scalePx: 12,
        },
      },
      archivedAt: '2026-07-31T01:00:00.000Z',
    })

    expect(parseStickyNoteRecord(archived)).toEqual(archived)
  })

  it.each([
    ['non-canonical UUID', { id: NOTE_ID.toUpperCase() }],
    ['blank name', { name: '   ' }],
    ['traversing markdown path', { markdownRelativePath: '../outside.md' }],
    ['absolute resource path', { resourcesRelativePath: 'C:/outside/resources' }],
    ['non-canonical timestamp', { updatedAt: '2026-07-31' }],
    ['active note with archive timestamp', { archivedAt: CREATED_AT }],
    ['archived note without archive timestamp', { status: 'archived' }],
    ['pin without release', { pinned: true }],
    ['font size below the display range', { fontSizePx: 10 }],
    ['non-integer font size', { fontSizePx: 13.5 }],
    ['too-small window', {
      windowBounds: { x: 0, y: 0, width: 179, height: 180 },
    }],
    ['unknown preset', {
      style: {
        mode: 'preset',
        colorPresetId: 'unknown',
        texturePresetId: 'plain',
      },
    }],
  ] as const)('rejects %s', (_label, overrides) => {
    expect(parseStickyNoteRecord(record(overrides as Partial<StickyNoteRecord>))).toBeUndefined()
  })

  it('rejects extra record fields', () => {
    expect(parseStickyNoteRecord({ ...record(), unexpected: true })).toBeUndefined()
  })

  it('parses an index and returns a detached copy', () => {
    const first = record()
    const second = record({
      id: SECOND_NOTE_ID,
      name: '便签260731-贰',
      markdownRelativePath: `active/${SECOND_NOTE_ID}/便签260731-贰.md`,
      resourcesRelativePath: `active/${SECOND_NOTE_ID}/resources`,
      released: true,
      pinned: true,
      windowBounds: { x: -900, y: 40, width: 320, height: 320 },
      lastOpenedAt: '2026-07-31T02:00:00.000Z',
    })
    const source = {
      schemaVersion: 5,
      notes: [first, second],
      openNoteIdsAtLastSession: [NOTE_ID, SECOND_NOTE_ID],
      defaultHelpNoteCreated: true,
    }

    const parsed = parseStickyNoteIndex(source)
    expect(parsed).toEqual(source)
    expect(parsed).not.toBe(source)
    expect(parsed?.notes[0]).not.toBe(first)

    const copied = copyStickyNoteIndex(parsed!)
    copied.notes[0].name = '已修改副本'
    copied.notes[0].background.imageRelativePath = 'resources/replaced.png'
    expect(parsed?.notes[0].name).toBe('便签260731-壹')
    expect(parsed?.notes[0].background.imageRelativePath).toBeNull()
  })

  it.each([
    ['duplicate ids', [
      record(),
      record({ name: '另一个便签' }),
    ], []],
    ['case-insensitive duplicate names', [
      record({ name: 'Note' }),
      record({
        id: SECOND_NOTE_ID,
        name: 'note',
        markdownRelativePath: `active/${SECOND_NOTE_ID}/note.md`,
        resourcesRelativePath: `active/${SECOND_NOTE_ID}/resources`,
      }),
    ], []],
    ['unknown open note id', [record()], [SECOND_NOTE_ID]],
    ['archived open note id', [
      record({
        status: 'archived',
        markdownRelativePath: `archive/${NOTE_ID}/旧便签.md`,
        resourcesRelativePath: `archive/${NOTE_ID}/resources`,
        archivedAt: CREATED_AT,
      }),
    ], [NOTE_ID]],
  ] as const)('rejects an index with %s', (_label, notes, openNoteIdsAtLastSession) => {
    expect(parseStickyNoteIndex({
      schemaVersion: 5,
      notes,
      openNoteIdsAtLastSession,
      defaultHelpNoteCreated: true,
    })).toBeUndefined()
  })
})
