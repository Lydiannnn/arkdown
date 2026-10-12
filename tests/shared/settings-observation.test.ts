import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import { parsePublicModelSettingsSnapshot } from '../../src/shared/settings-observation'

const id = '550e8400-e29b-41d4-a716-446655440000'
const otherId = '550e8400-e29b-41d4-a716-446655440001'
const fixture = () => ({
  settings: { ...structuredClone(DEFAULT_LARGE_MODEL_SETTINGS), connections: [{ id, name: 'Observed', provider: 'other', accessType: 'standard-api', protocol: 'openai', baseUrl: 'https://example.com/v1', modelId: 'synthetic', apiKeyHint: '••••test', status: 'connected', lastTestedAt: null, capabilityOverride: null }] },
  observation: { version: 1, revision: 5, minimumBaseRevision: 0, fields: { 'models.aiConversation.writePolicy': 2 }, connections: { [id]: { entity: 4, credential: 4, name: 3 } } },
})
function parse(value: unknown) {
  return parsePublicModelSettingsSnapshot(value)
}

describe('public model settings observations', () => {
  it('keeps settings and the observed revisions together without sharing mutable objects', () => {
    const source = fixture()
    const decoded = parse(source)
    expect(decoded).toEqual(source)
    decoded!.settings.connections[0]!.name = 'changed'
    decoded!.observation.connections[id]!.credential = 5
    expect(source.settings.connections[0]!.name).toBe('Observed')
    expect(source.observation.connections[id]!.credential).toBe(4)
  })

  it.each([-1, Number.MAX_SAFE_INTEGER + 1, 1.5, NaN])('rejects an unsafe snapshot revision %s', revision => {
    const source = fixture()
    source.observation.revision = revision
    expect(parse(source)).toBeUndefined()
  })

  it('rejects watermark/future-field inconsistencies and a field newer than its entity', () => {
    expect(parse({ ...fixture(), observation: { ...fixture().observation, minimumBaseRevision: 6 } })).toBeUndefined()
    expect(parse({ ...fixture(), observation: { ...fixture().observation, fields: { 'models.aiConversation.writePolicy': 6 } } })).toBeUndefined()
    expect(parse({ ...fixture(), observation: { ...fixture().observation, connections: { [id]: { entity: 3, credential: 4 } } } })).toBeUndefined()
  })

  it('requires exactly the active stable IDs and fixed fields, with no dead-ID or secret payloads', () => {
    expect(parse({ ...fixture(), observation: { ...fixture().observation, connections: {} } })).toBeUndefined()
    expect(parse({ ...fixture(), observation: { ...fixture().observation, connections: { ...fixture().observation.connections, [otherId]: { entity: 0 } } } })).toBeUndefined()
    expect(parse({ ...fixture(), observation: { ...fixture().observation, fields: { 'models.arbitrary.path': 1 } } })).toBeUndefined()
    expect(parse({ ...fixture(), observation: { ...fixture().observation, connections: { [id]: { entity: 4, apiKey: 'forbidden' } } } })).toBeUndefined()
    expect(parse({ ...fixture(), ciphertext: 'forbidden' })).toBeUndefined()
  })

  it('rejects accessors without invoking them and rejects a bare unobserved settings response', () => {
    const source = fixture()
    const getter = vi.fn(() => 5)
    Object.defineProperty(source.observation, 'revision', { enumerable: true, get: getter })
    expect(parse(source)).toBeUndefined()
    expect(getter).not.toHaveBeenCalled()
    expect(parse(fixture().settings)).toBeUndefined()
  })
})
