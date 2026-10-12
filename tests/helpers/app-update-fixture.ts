export function updateFixture(version = '1.0.5') {
  const packages = (['Full', 'Lite'] as const).flatMap(edition => (['installer', 'portable'] as const).map(kind => ({
    edition, kind, filename: `Arkdown-${version}-${edition}-${kind}.${kind === 'installer' ? 'exe' : 'zip'}`, bytes: 1024,
    sha256: 'a'.repeat(64), url: 'https://download.cotax.tech/package.zip',
  })))
  return { schemaVersion: 1, available: true, version, channel: 'stable', required: false,
    mode: 'optional', deadline: null, message: '', websiteUrl: 'https://arkdown.cotax.tech/', reason: 'update_available',
    release: { schemaVersion: 1, product: 'Arkdown', version, channel: 'stable', publishedAt: '2026-10-09T00:00:00Z',
      title: '更新', notes: '改进', websiteUrl: 'https://arkdown.cotax.tech/', platform: 'Windows x64',
      packages, ...packages[1] } }
}
