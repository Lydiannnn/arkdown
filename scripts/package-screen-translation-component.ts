import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as tar from 'tar'
import type { DocumentConversionComponentDescriptor } from '../src/shared/document-conversion.ts'
import { verifyScreenTranslationRuntime } from './package-screen-translation.ts'

const prefix = 'runtime/ArkTranslateEngine/'
const duplicatePrefix = '_internal/rapidocr/models/'
const version = '1.0.0'
const archiveName = `arkdown-screen-translation-engine-${version}-win-x64.tar.gz`

/** Publish only verified inventory members; never archive a directory recursively. */
export async function packageScreenTranslationComponent(options: { repoRoot?: string; outputDirectory?: string } = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd())
  const files = (await verifyScreenTranslationRuntime(repoRoot)).map(file => ({ ...file, path: file.path.slice(prefix.length) }))
  const byPath = new Map(files.map(file => [file.path, file]))
  const payload = files.filter(file => {
    // OpenCV documents this exact plugin as optional video I/O; OCR uses image arrays.
    // https://raw.githubusercontent.com/opencv/opencv_3rdparty/ffmpeg/5.x/readme.txt
    if (file.path === '_internal/cv2/opencv_videoio_ffmpeg500_64.dll') return false
    if (!file.path.startsWith(duplicatePrefix)) return true
    if (file.path === duplicatePrefix+'.gitkeep' && file.bytes === 0
      && file.sha256 === createHash('sha256').update('').digest('hex')) return false
    const counterpart = byPath.get('_internal/models/'+file.path.slice(duplicatePrefix.length))
    if (!counterpart || counterpart.bytes !== file.bytes || counterpart.sha256 !== file.sha256) {
      throw new Error('Redundant model does not match retained model: '+file.path)
    }
    return false
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const output = path.resolve(options.outputDirectory ?? path.join(repoRoot, '.components/public-screen-translation-release'))
  await mkdir(output, { recursive: true })
  const staging = await mkdtemp(path.join(output, '.payload-'))
  const archivePath = path.join(output, archiveName), manifestPath = path.join(output, 'manifest.json')
  try {
    for (const file of payload) {
      const destination = path.join(staging, file.path)
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(path.join(repoRoot, '.components/screen-translation/runtime/ArkTranslateEngine', file.path), destination)
      const bytes = await readFile(destination)
      if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
        throw new Error('Screen translation staged resource mismatch: '+file.path)
      }
    }
    const treeManifest = JSON.stringify({
      schemaVersion: 1, version, entry: 'ArkTranslateEngine.exe', files: payload,
    }, null, 2)+'\n'
    await writeFile(path.join(staging, 'component-manifest.json'), treeManifest, 'utf8')
    await tar.c({ file: archivePath, cwd: staging, gzip: { level: 9 }, portable: true,
      mtime: new Date('2026-01-01T00:00:00Z'), noDirRecurse: true,
    }, [...payload.map(file => file.path), 'component-manifest.json'])
    const bytes = await readFile(archivePath)
    const descriptor: DocumentConversionComponentDescriptor = {
      source: 'https', version, archiveName, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      url: `https://github.com/Lydiannnn/arkdown-releases/releases/download/screen-translation-engine-${version}/${archiveName}`,
    }
    await writeFile(manifestPath, JSON.stringify(descriptor, null, 2)+'\n', 'utf8')
    return { descriptor, archivePath, manifestPath, payloadFiles: payload.length,
      treeManifestSha256: createHash('sha256').update(treeManifest).digest('hex'),
      payloadBytes: payload.reduce((sum, file) => sum + file.bytes, 0),
      removedBytes: files.reduce((sum, file) => sum + file.bytes, 0) - payload.reduce((sum, file) => sum + file.bytes, 0) }
  } finally {
    // staging is the exact mkdtemp result within the explicitly selected output.
    await rm(staging, { recursive: true, force: true })
  }
}

/** Required third-party material only. Application Python source stays private. */
export async function packageScreenTranslationThirdPartySources(options: {
  repoRoot?: string; outputDirectory?: string; sourceArchive?: { path: string; sha256: string }
} = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd())
  const source = options.sourceArchive ?? {
    path: path.join(repoRoot, '.components/screen-translation-source-inputs/geos-3.13.1.tar.bz2'),
    sha256: 'df2c50503295f325e7c8d7b783aca8ba4773919cde984193850cf9e361dfd28c',
  }
  const sourceBytes = await readFile(source.path)
  if (createHash('sha256').update(sourceBytes).digest('hex') !== source.sha256) throw new Error('Third-party source hash mismatch')
  const inventory = (await verifyScreenTranslationRuntime(repoRoot)).map(file => ({ ...file, path: file.path.slice(prefix.length) }))
    .filter(file => file.path.startsWith('licenses/') || file.path === '_internal/certifi/cacert.pem')
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const output = path.resolve(options.outputDirectory ?? path.join(repoRoot, '.components/public-screen-translation-release'))
  await mkdir(output, { recursive: true })
  const staging = await mkdtemp(path.join(output, '.third-party-'))
  const archivePath = path.join(output, `arkdown-screen-translation-engine-${version}-third-party-sources.tar.gz`)
  try {
    await writeFile(path.join(staging, 'geos-3.13.1.tar.bz2'), sourceBytes)
    for (const file of inventory) {
      const data = await readFile(path.join(repoRoot, '.components/screen-translation/runtime/ArkTranslateEngine', file.path))
      if (data.length !== file.bytes || createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error('Third-party inventory mismatch')
      await mkdir(path.dirname(path.join(staging, file.path)), { recursive: true })
      await writeFile(path.join(staging, file.path), data)
    }
    await tar.c({ file: archivePath, cwd: staging, gzip: { level: 9 }, portable: true,
      mtime: new Date('2026-01-01T00:00:00Z'), noDirRecurse: true,
    }, ['geos-3.13.1.tar.bz2', ...inventory.map(file => file.path)])
    for (const name of ['README.md', 'THIRD_PARTY_NOTICES.md']) {
      await copyFile(path.join(repoRoot, 'components/screen-translation/release', name), path.join(output, name))
    }
    const bytes = await readFile(archivePath)
    return { archivePath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  } finally { await rm(staging, { recursive: true, force: true }) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const operation = process.argv.includes('--third-party-sources')
    ? packageScreenTranslationThirdPartySources() : packageScreenTranslationComponent()
  operation.then(result => process.stdout.write(JSON.stringify(result, null, 2)+'\n')).catch(error => {
    process.stderr.write(String(error)+'\n'); process.exitCode = 1
  })
}
