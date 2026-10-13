import { expect, it } from 'vitest'
import { isUpdateArtifactUrl, parseUpdateDecision } from '../../src/main/updates/update-protocol'
import { updateFixture } from '../helpers/app-update-fixture'

const identity = { version: '1.0.4', channel: 'stable', edition: 'Full', kind: 'portable' } as const
const cosOrigin = 'https://arkdown-downloads-1257382433.cos.ap-guangzhou.myqcloud.com'
function standardFixture(kind: 'installer' | 'portable' = 'portable') {
  const fixture = updateFixture()
  fixture.release.packages = fixture.release.packages.filter(item => item.edition === 'Lite')
  for (const item of fixture.release.packages) item.url = `${cosOrigin}/releases/1.0.5-cos-r1/${item.filename}`
  Object.assign(fixture.release, fixture.release.packages.find(item => item.kind === kind))
  return fixture
}
it.each(['installer', 'portable'] as const)('accepts a complete standard-only manifest for the matching %s installation', kind => {
  expect(parseUpdateDecision(standardFixture(kind), { ...identity, edition: 'Lite', kind })).toMatchObject({
    artifact: { version: '1.0.5', edition: 'Lite', kind, url: `${cosOrigin}/releases/1.0.5-cos-r1/Arkdown-1.0.5-Lite-${kind}.${kind === 'installer' ? 'exe' : 'zip'}` },
  })
})
it('keeps existing download.cotax.tech URLs compatible with a standard-only manifest', () => {
  const fixture = standardFixture()
  for (const item of fixture.release.packages) item.url = 'https://download.cotax.tech/package.zip'
  fixture.release.url = 'https://download.cotax.tech/package.zip'
  expect(parseUpdateDecision(fixture, { ...identity, edition: 'Lite' })?.artifact?.edition).toBe('Lite')
})
it('keeps a complete four-package manifest compatible when its selected package uses COS', () => {
  const fixture = updateFixture()
  fixture.release.url = `${cosOrigin}/releases/1.0.5/${fixture.release.filename}`
  fixture.release.packages[1].url = fixture.release.url
  expect(parseUpdateDecision(fixture, identity)?.artifact?.url)
    .toBe(`${cosOrigin}/releases/1.0.5/Arkdown-1.0.5-Full-portable.zip`)
})
it.each([
  (x: ReturnType<typeof standardFixture>) => { x.release.packages.pop() },
  x => { x.release.packages.push(updateFixture().release.packages[0]) },
  x => { x.release.packages[1] = { ...x.release.packages[0] } },
  x => { x.release.packages[0].edition = 'Full' },
  x => { x.release.packages[0].url = 'https://evil.example/package.exe' },
  x => { x.release.packages[0].sha256 = 'bad' },
  x => { x.release.bytes++ },
  x => { x.release.filename = 'different.zip' },
  x => { x.release.url = `${cosOrigin}/releases/1.0.5/different.zip` },
])('rejects an incomplete, duplicate, invalid or mismatched standard-only manifest %#', change => {
  const fixture = standardFixture(); change(fixture)
  expect(parseUpdateDecision(fixture, { ...identity, edition: 'Lite' })).toBeUndefined()
})
it('does not offer standard-only packages to a Full installation', () => {
  expect(parseUpdateDecision(standardFixture(), identity)).toBeUndefined()
})
it('rejects a two-package Full-only manifest', () => {
  const fixture = updateFixture(); fixture.release.packages = fixture.release.packages.filter(item => item.edition === 'Full')
  expect(parseUpdateDecision(fixture, identity)).toBeUndefined()
})
it('rejects duplicated identities in the existing four-package manifest', () => {
  const fixture = updateFixture(); fixture.release.packages[3] = { ...fixture.release.packages[2] }
  expect(parseUpdateDecision(fixture, identity)).toBeUndefined()
})
it.each([
  '/releases/1.0.5/Arkdown-1.0.5-Lite-Windows-x64.zip',
  '/releases/1.0.4-cos-r1/Arkdown-1.0.4-Lite-Windows-x64-Setup.exe',
  '/releases/v1.0.5/Arkdown-1.0.5-Lite-Windows-x64.zip',
])('trusts a canonical COS release artifact %s', pathname => {
  expect(isUpdateArtifactUrl(`${cosOrigin}${pathname}`)).toBe(true)
})
it.each([
  '/components/1.0.5/Arkdown.zip', '/releases/Arkdown.zip', '/releases/1.0.5/nested/Arkdown.zip',
  '/releases/latest/Arkdown.zip', '/releases/../releases/1.0.5/Arkdown.zip',
  '/releases/1.0.5/../1.0.6/Arkdown.zip', '/releases/%31.0.5/Arkdown.zip',
  '/releases/1.0.5/%2e%2e/1.0.6/Arkdown.zip', '/releases/1.0.5/Arkdown%2fother.zip',
  '/releases/1.0.5/Arkdown%5cother.zip', '/releases/1.0.5/Arkdown%252fother.zip',
  '/releases/1.0.5/Arkdown.zip?token=test', '/releases/1.0.5/Arkdown.zip?',
  '/releases/1.0.5/Arkdown.zip#hash', '/releases/1.0.5/Arkdown.zip#',
  '/releases/1.0.5/CON.zip', '/releases/1.0.5/Arkdown.tar.gz',
  '/releases/1.0.5/.Arkdown.zip', '/releases/1.0.5/Arkdown..zip',
])('rejects unsafe or non-release COS paths %s', pathname => {
  expect(isUpdateArtifactUrl(`${cosOrigin}${pathname}`)).toBe(false)
})
it.each([
  `${cosOrigin}.evil.example/releases/1.0.5/Arkdown.zip`,
  cosOrigin.replace('1257382433', '1257382434') + '/releases/1.0.5/Arkdown.zip',
  cosOrigin.replace('https:', 'http:') + '/releases/1.0.5/Arkdown.zip',
  cosOrigin.replace('https://', 'https://user:password@') + '/releases/1.0.5/Arkdown.zip',
  `${cosOrigin}:443/releases/1.0.5/Arkdown.zip`, `${cosOrigin}:8443/releases/1.0.5/Arkdown.zip`,
  `${cosOrigin}/releases/1.0.5\\Arkdown.zip`, ` ${cosOrigin}/releases/1.0.5/Arkdown.zip`,
])('rejects a noncanonical or different COS origin %s', url => {
  expect(isUpdateArtifactUrl(url)).toBe(false)
})
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
