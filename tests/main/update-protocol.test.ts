import { expect, it } from 'vitest'
import { parseUpdateDecision } from '../../src/main/updates/update-protocol'
import { updateFixture } from '../helpers/app-update-fixture'

const identity = { version: '1.0.4', channel: 'stable', edition: 'Full', kind: 'portable' } as const
it('admits a matching higher candidate without using its URLs or notes as actions', () => {
  expect(parseUpdateDecision(updateFixture(), identity)).toMatchObject({ candidate: {
    version: '1.0.5', mode: 'optional', required: false, message: '',
  } })
})
it('retains the exact matching artifact for verification without leaking release notes', () => {
  const fixture = updateFixture()
  expect(parseUpdateDecision(fixture, identity)).toEqual({
    candidate: { version: '1.0.5', mode: 'optional', required: false, message: '' },
    artifact: { version: '1.0.5', channel: 'stable', ...fixture.release.packages[1] },
  })
})
it.each([
  { url: 'https://evil.example/package.zip' },
  { url: 'https://download.cotax.tech.evil.example/package.zip' },
  { url: 'https://github.com/another/repo/releases/download/v1/a.zip' },
  { url: 'https://download.cotax.tech:8443/package.zip' },
  { filename: '../Arkdown.exe' }, { filename: 'a\\b.zip' }, { filename: 'a.zip:evil' },
  { filename: 'CON.zip' }, { filename: 'a.zip.' }, { filename: 'a.zip\n' },
  { filename: 'setup.exe' }, { bytes: 64 * 1024 ** 3 },
])('rejects an unsafe selected artifact %#', patch => {
  const fixture = updateFixture()
  Object.assign(fixture.release, patch)
  Object.assign(fixture.release.packages[1], patch)
  expect(parseUpdateDecision(fixture, identity)).toBeUndefined()
})
it('does not display the candidate version retained by an up-to-date response', () => {
  expect(parseUpdateDecision({ ...updateFixture(), available: false, release: null, reason: 'up_to_date' }, identity))
    .toEqual({ candidate: null })
})
it.each([
  (x: ReturnType<typeof updateFixture>) => { x.schemaVersion = 2 },
  x => { x.version = '1.0.3'; x.release.version = '1.0.3' },
  x => { x.version = '1.0.4'; x.release.version = '1.0.4' },
  x => { x.release.version = '1.0.6' }, x => { x.release.channel = 'beta' },
  x => { x.release.kind = 'installer' }, x => { x.release.edition = 'Lite' },
  x => { x.websiteUrl = 'https://evil.example/' }, x => { x.release.websiteUrl = 'https://evil.example/' },
  x => { x.deadline = 'not a date' as never }, x => { x.required = 'true' as never },
  x => { x.mode = 'unknown' }, x => { x.reason = 'unknown' },
  x => { x.message = 'x'.repeat(4097) }, x => { x.release.packages = [] },
  x => { x.version = '1.0.5-beta.1'; x.release.version = x.version },
])('ignores malformed or mismatched decisions (%#)', change => {
  const value = updateFixture(); change(value)
  expect(parseUpdateDecision(value, identity)).toBeUndefined()
})
it('uses the required boolean, never the local deadline or mode', () => {
  const value = { ...updateFixture(), mode: 'required', deadline: '2000-01-01T00:00:00Z' }
  expect(parseUpdateDecision(value, identity)?.candidate?.required).toBe(false)
  expect(parseUpdateDecision({ ...value, required: true }, identity)?.candidate?.required).toBe(true)
})
it('rejects a no-update response trying to demand forced updating', () => {
  expect(parseUpdateDecision({ ...updateFixture(), available: false, release: null, required: true }, identity)).toBeUndefined()
})
it('accepts beta only for an explicitly matching channel', () => {
  const value = updateFixture('1.0.5-beta.2'); value.channel = 'beta'; value.release.channel = 'beta'
  expect(parseUpdateDecision(value, { ...identity, channel: 'beta' })?.candidate?.version).toBe('1.0.5-beta.2')
})
