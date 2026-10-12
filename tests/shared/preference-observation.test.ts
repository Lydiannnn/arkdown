import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_EDITOR_APPEARANCE } from '../../src/shared/editor-appearance-preferences'
import { DEFAULT_STICKY_NOTE_PREFERENCES } from '../../src/shared/sticky-note-preferences'
import { parsePublicPreferenceSnapshot, parsePublicPreferenceMutation } from '../../src/shared/preference-observation'

const fixture = () => ({ group: 'appearance', values: { ...DEFAULT_EDITOR_APPEARANCE }, observation: { version: 1, revision: 4, minimumBaseRevision: 0, fields: { bodyLatinFont: 2 } } })
const parse = parsePublicPreferenceSnapshot

describe('finite public preference observations', () => {
  it('keeps the values and bounded field revisions together and clones them', async () => {
    const source = fixture(), parsed = await parse(source)
    expect(parsed).toEqual(source)
    if (parsed?.group !== 'appearance') throw new Error('Expected appearance snapshot')
    parsed.values.bodyLatinFont = 'changed'
    expect(source.values.bodyLatinFont).toBe(DEFAULT_EDITOR_APPEARANCE.bodyLatinFont)
  })

  it.each([-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe global revision %s', async revision => {
    const source = fixture(); source.observation.revision = revision
    expect(await parse(source)).toBeUndefined()
  })

  it('rejects foreign fields, future revisions, incomplete observations and raw settings', async () => {
    expect(await parse({ ...fixture(), group: 'secrets' })).toBeUndefined()
    expect(await parse({ ...fixture(), observation: { ...fixture().observation, fields: { 'models.codexCli': 1 } } })).toBeUndefined()
    expect(await parse({ ...fixture(), observation: { ...fixture().observation, fields: { bodyLatinFont: 5 } } })).toBeUndefined()
    expect(await parse({ ...fixture(), observation: { ...fixture().observation, minimumBaseRevision: 5 } })).toBeUndefined()
    expect(await parse({ group: 'appearance', values: fixture().values })).toBeUndefined()
    expect(await parse(fixture().values)).toBeUndefined()
    expect(await parse({ ...fixture(), ciphertext: 'private' })).toBeUndefined()
  })

  it('rejects root and nested accessors before reading them', async () => {
    const getter = vi.fn(() => 'Arial'), source = fixture()
    Object.defineProperty(source.values, 'bodyLatinFont', { enumerable: true, get: getter })
    expect(await parse(source)).toBeUndefined()
    const sticky = { group: 'stickyNotes', values: structuredClone(DEFAULT_STICKY_NOTE_PREFERENCES), observation: { version: 1, revision: 0, minimumBaseRevision: 0, fields: {} } }
    Object.defineProperty(sticky.values.colorPresets[0]!, 'name', { enumerable: true, get: getter })
    expect(await parse(sticky)).toBeUndefined()
    expect(getter).not.toHaveBeenCalled()
  })

  it('rejects implicit normalization, oversized search input and forged mutation envelopes', async () => {
    expect(await parse({ ...fixture(), values: { ...fixture().values, themeColor: '#ffffff' } })).toBeUndefined()
    expect(await parse({ group: 'search', values: { provider: 'bing', customTemplate: 'ignored' }, observation: fixture().observation })).toBeUndefined()
    expect(await parse({ group: 'search', values: { provider: 'custom', customTemplate: 'https://example.com/?q={query}&x=' + 'x'.repeat(2000) }, observation: { ...fixture().observation, fields: {} } })).toBeUndefined()
    expect(parsePublicPreferenceMutation({ status: 'committed', snapshot: fixture() })).toEqual({ status: 'committed', snapshot: fixture() })
    expect(parsePublicPreferenceMutation({ status: 'committed', snapshot: fixture(), cleanupPath: 'private' })).toBeUndefined()
    expect(parsePublicPreferenceMutation({ status: 'conflict', snapshot: fixture(), reason: 'field-changed', fields: ['apiKey'] })).toBeUndefined()
  })
})
