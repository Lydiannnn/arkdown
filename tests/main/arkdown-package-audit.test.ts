import { createPackage } from '@electron/asar'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import forgeConfig from '../../forge.config'
import { packageEditionResources } from '../../scripts/package-editions'
import { buildApplicationUpdater } from '../../scripts/build-application-updater'
import { packageApplicationUpdater } from '../../scripts/package-application-updater'
import { writeUpdateManagedManifest } from '../../scripts/package-update-manifest'
import { copyBrandingToPackages } from '../../scripts/package-branding'
import type { DocumentConversionComponentDescriptor } from '../../src/shared/document-conversion'
import { SCREEN_TRANSLATION_COMPONENT_DESCRIPTOR } from '../../src/shared/screen-translation-component-manifest'
import {
  auditArkdownPackage,
  auditDocumentConversionResources,
  auditPackagedApplication,
} from '../../scripts/audit-arkdown-package'
import {
  PACKAGE_PROVENANCE_FILENAME,
  writePackageProvenance,
} from '../../scripts/package-provenance'

// Filesystem audits exercise the comparison and failure path using inert text.
// The real PE transform is covered in memory in package-arknote.test.ts and by
// the final package audit; never emit synthetic, non-runnable PE files here.
const brandingTransform = vi.hoisted(() => vi.fn((source: Uint8Array) =>
  Buffer.concat([source, Buffer.from(':Arknote-icon')])))
vi.mock('../../scripts/package-arknote', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../scripts/package-arknote')>(),
  createArknoteExecutable: brandingTransform,
}))

const auditFsRace = {
  beforeDirectoryRead: null as null | ((filePath: string) => void | Promise<void>),
  beforeFileMetadata: null as null | ((filePath: string) => void | Promise<void>),
  beforeFileRead: null as null | ((filePath: string) => void | Promise<void>),
}

function raceFileSystem() {
  return {
    lstat: async (filePath: string) => {
      if (auditFsRace.beforeFileMetadata) await auditFsRace.beforeFileMetadata(filePath)
      return lstat(filePath)
    },
    open: async (filePath: string) => {
      if (auditFsRace.beforeFileRead) await auditFsRace.beforeFileRead(filePath)
      return open(filePath, 'r')
    },
    readdir: async (filePath: string) => {
      if (auditFsRace.beforeDirectoryRead) await auditFsRace.beforeDirectoryRead(filePath)
      return readdir(filePath, { withFileTypes: true })
    },
  }
}

const roots: string[] = []
const legacyAuditOptions = {
  allowMissingEditionMetadata: true,
  allowMissingScreenTranslationResources: true,
  allowMissingDocumentConversionResources: true,
  allowMissingScreenshotOcrResources: true,
  allowMissingWorkspaceCommitHelperResources: true,
}

const documentConversionArchive = Buffer.from('deterministic document conversion component fixture')

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function documentConversionDescriptor(
  bytes: Uint8Array = documentConversionArchive,
): DocumentConversionComponentDescriptor {
  return {
    source: 'packaged',
    version: 'fixture-1',
    archiveName: 'arkdown-document-conversion-fixture.tar.gz',
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    url: null,
  }
}

function documentConversionManifest(
  descriptor: DocumentConversionComponentDescriptor,
): Record<string, unknown> {
  return {
    version: descriptor.version,
    archiveName: descriptor.archiveName,
    bytes: descriptor.bytes,
    sha256: descriptor.sha256,
  }
}

afterEach(async () => {
  brandingTransform.mockClear()
  auditFsRace.beforeDirectoryRead = null
  auditFsRace.beforeFileMetadata = null
  auditFsRace.beforeFileRead = null
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })))
})

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}

async function createFakePackage(options: {
  arknoteBytes?: string
  asarEntries?: Readonly<Record<string, string>>
  provenance?: boolean
  rootEntries?: Readonly<Record<string, string>>
} = {}): Promise<string> {
  const root = await temporaryRoot('arkdown-package-acceptance-')
  const asarSource = await temporaryRoot('arkdown-package-asar-')
  const entries = options.asarEntries ?? {
    '.vite/build/main.js': 'console.log("Arkdown")',
    '.vite/renderer/main_window/assets/mermaid.core-D4YfB1k2.js': 'export default "Mermaid"',
    'THIRD_PARTY_NOTICES.md': 'third-party notices',
  }
  await Promise.all(Object.entries(entries).map(async ([relativePath, content]) => {
    const target = path.join(asarSource, ...relativePath.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }))
  await mkdir(path.join(root, 'resources'), { recursive: true })
  await copyBrandingToPackages([root])
  const launcher = Buffer.from('electron-launcher')
  await Promise.all([
    writeFile(path.join(root, 'Arkdown.exe'), launcher),
    writeFile(path.join(root, 'Arknote.exe'), options.arknoteBytes ?? 'electron-launcher:Arknote-icon'),
    writeFile(path.join(root, 'version'), '0.1.0\n', 'utf8'),
    writeFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), entries['THIRD_PARTY_NOTICES.md'] ?? 'third-party notices', 'utf8'),
  ])
  await Promise.all(Object.entries(options.rootEntries ?? {}).map(async ([relativePath, content]) => {
    const target = path.join(root, ...relativePath.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }))
  const bridgeDirectory = path.join(root, 'resources', 'screenshot-translation')
  await mkdir(bridgeDirectory, { recursive: true })
  for (const name of ['windows-ocr.ps1', 'windows-window-hit-test.ps1']) {
    const override = options.rootEntries?.[`resources/screenshot-translation/${name}`]
    if (override === undefined) await writeFile(path.join(bridgeDirectory, name), await readFile(path.resolve('scripts', name)))
  }
  await createPackage(asarSource, path.join(root, 'resources', 'app.asar'))
  if (options.provenance !== false) {
    await writePackageProvenance([root], { commit: '1'.repeat(40), tree: '2'.repeat(40) })
  }
  return root
}

async function writeDocumentConversionResources(
  packageRoot: string,
  descriptor = documentConversionDescriptor(),
  bytes: Uint8Array = documentConversionArchive,
): Promise<string> {
  const resourceRoot = path.join(packageRoot, 'resources', 'document-conversion')
  await mkdir(resourceRoot, { recursive: true })
  await Promise.all([
    writeFile(path.join(resourceRoot, descriptor.archiveName), bytes),
    writeFile(
      path.join(resourceRoot, 'manifest.json'),
      `${JSON.stringify(documentConversionManifest(descriptor))}\n`,
      'utf8',
    ),
  ])
  return resourceRoot
}

describe('Arkdown package audit', () => {
  it.each(['valid', 'extra', 'forbidden'] as const)('audits screen translation with verified-only approval (%s)', async mode => {
    const root = await createFakePackage(), source = await temporaryRoot('arkdown-screen-audit-source-')
    const resource = path.join(root, 'resources/screen-translation')
    const put = async (target: string, data: string) => { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, data) }
    const manifest = JSON.stringify(SCREEN_TRANSLATION_COMPONENT_DESCRIPTOR)
    await put(path.join(resource, 'manifest.json'), manifest)
    for (const name of ['Arkdown.ScreenTranslation.exe', 'Arkdown.ScreenTranslation.exe.config']) {
      await put(path.join(source, '.native-cache/screen-translation', name), name)
      await put(path.join(resource, name), name)
    }
    if (mode === 'forbidden') await put(path.join(resource, 'engine/tests/unwanted.py'), 'unwanted source')
    if (mode === 'extra') await put(path.join(resource, 'engine/unlisted.dll'), 'unexpected')
    const report = await auditPackagedApplication(root, { ...legacyAuditOptions, screenTranslationSourceRoot: source })
    if (mode === 'valid') expect(report.findings).toEqual([])
    else if (mode === 'forbidden') expect(report.findings).toContain(path.join('forbidden package entry', 'resources', 'screen-translation', 'engine', 'tests', 'unwanted.py'))
    else {
      expect(report.findings).toContain('unexpected screen translation asset: engine')
      expect(report.findings).toContain(path.join('unapproved package entry', 'resources', 'screen-translation', 'engine', 'unlisted.dll'))
    }
  })
  it('lets only Vite output and the exact third-party notice enter app.asar', () => {
    const ignore = forgeConfig.packagerConfig?.ignore
    expect(ignore).toEqual(expect.any(Function))
    if (typeof ignore !== 'function') throw new Error('packager ignore filter is unavailable')

    expect(ignore('')).toBe(false)
    expect(ignore('/.vite/renderer/main_window/index.html')).toBe(false)
    expect(ignore('/.vite-shadow/index.js')).toBe(true)
    expect(ignore('/THIRD_PARTY_NOTICES.md')).toBe(false)
    expect(ignore('/third_party_notices.md')).toBe(true)
    expect(ignore('/README.md')).toBe(true)
  })

  it('requires the exact in-asar third-party notice and Mermaid renderer chunk', async () => {
    const clean = await createFakePackage()
    await expect(auditPackagedApplication(clean, legacyAuditOptions)).resolves.toMatchObject({ findings: [] })

    const missingNotice = await createFakePackage({
      asarEntries: {
        '.vite/build/main.js': 'console.log("Arkdown")',
        '.vite/renderer/main_window/assets/mermaid.core-D4YfB1k2.js': 'export default "Mermaid"',
      },
    })
    await expect(auditPackagedApplication(missingNotice, legacyAuditOptions)).resolves.toMatchObject({
      findings: expect.arrayContaining(['missing asar entry: THIRD_PARTY_NOTICES.md']),
    })

    const missingChunk = await createFakePackage({
      asarEntries: {
        '.vite/build/main.js': 'console.log("Arkdown")',
        'THIRD_PARTY_NOTICES.md': 'third-party notices',
      },
    })
    await expect(auditPackagedApplication(missingChunk, legacyAuditOptions)).resolves.toMatchObject({
      findings: expect.arrayContaining(['missing Mermaid renderer chunk']),
    })
  })

  it('rejects notice path aliases and directory substitutes instead of widening the asar allowlist', async () => {
    const root = await createFakePackage({
      asarEntries: {
        '.vite/build/main.js': 'console.log("Arkdown")',
        '.vite/renderer/main_window/assets/mermaid.core-D4YfB1k2.js': 'export default "Mermaid"',
        'third-party-notices.md': 'path alias',
        'THIRD_PARTY_NOTICES.md/extra.txt': 'directory substitute',
      },
    })

    const report = await auditPackagedApplication(root, legacyAuditOptions)

    expect(report.findings).toEqual(expect.arrayContaining([
      'missing asar entry: THIRD_PARTY_NOTICES.md',
      path.join('unapproved asar entry', 'third-party-notices.md'),
      path.join('unapproved asar entry', 'THIRD_PARTY_NOTICES.md', 'extra.txt'),
    ]))
  })

  it('requires the readable notice to match the notice preserved in app.asar', async () => {
    const root = await createFakePackage()
    const noticePath = path.join(root, 'THIRD_PARTY_NOTICES.md')
    await writeFile(noticePath, 'incomplete notice', 'utf8')
    await expect(auditPackagedApplication(root, legacyAuditOptions)).resolves.toMatchObject({
      findings: expect.arrayContaining(['modified package file: THIRD_PARTY_NOTICES.md']),
    })
    await rm(noticePath)
    await expect(auditPackagedApplication(root, legacyAuditOptions)).resolves.toMatchObject({
      findings: expect.arrayContaining(['missing package file: THIRD_PARTY_NOTICES.md']),
    })
  })

  it('ships runtime dependency licensing with the generated production-closure inventory', async () => {
    const notice = await readFile('THIRD_PARTY_NOTICES.md', 'utf8').catch(() => '')

    for (const required of [
      'mermaid@11.17.2',
      'Copyright (c) 2014 - 2022 Knut Sveidqvist',
      'Permission is hereby granted, free of charge, to any person obtaining a copy',
      'dompurify@3.4.12',
      '(MPL-2.0 OR Apache-2.0)',
      'Mozilla Public License Version 2.0',
      'Apache License',
      'Version 2.0, January 2004',
      'es-toolkit@1.52.0',
      'Lodash',
      'khroma@2.1.0',
      'fastdom@1.0.12',
      'strictdom@1.0.1',
      'saxes@6.0.0',
      'Copyright (c) Isaac Z. Schlueter and Contributors',
      'xmlchars@2.2.0',
      'zod@4.4.3',
      'onnxruntime-web@1.27.0',
      '@techstark/opencv-js@4.10.0-release.1',
      '@phosphor-icons/react@2.1.10',
      'Copyright (c) Microsoft Corporation',
      'Copyright (c) 2020 Phosphor Icons',
      'Noto Sans SC variable font retained in source',
      'Copyright Louis-Dominique Dubeau and contributors to xmlchars',
      '115 package instances',
      'package-lock.json',
    ]) expect(notice).toContain(required)
  })

  it('accepts exactly the descriptor-named document conversion archive and public manifest', async () => {
    const root = await createFakePackage()
    const descriptor = documentConversionDescriptor()
    await writeDocumentConversionResources(root, descriptor)

    await expect(auditDocumentConversionResources(root, descriptor)).resolves.toEqual([])
    await expect(auditPackagedApplication(root, {
      ...legacyAuditOptions,
      allowMissingDocumentConversionResources: false,
      documentConversionDescriptor: descriptor,
    })).resolves.toMatchObject({ findings: [] })
  })

  it('audits Lite without optional payloads and retains exactly ten initial workspace guides', async () => {
    const updater = await buildApplicationUpdater(process.cwd())
    const root = await createFakePackage({ asarEntries: {
      '.vite/build/main.js': 'const updater = ' + JSON.stringify(updater.trust),
      '.vite/renderer/main_window/assets/mermaid.core-D4YfB1k2.js': 'export default "Mermaid"',
      'THIRD_PARTY_NOTICES.md': 'third-party notices', 'package.json': JSON.stringify({ version: '1.0.4' }),
    } })
    await packageEditionResources(root, 'lite')
    await cp(path.resolve('initial-workspace'), path.join(root, '初始工作区'), { recursive: true })
    await packageApplicationUpdater([root], updater)
    await writeUpdateManagedManifest(root, '1.0.4', 'lite')
    const options = { ...legacyAuditOptions, allowMissingEditionMetadata: false }
    expect((await auditPackagedApplication(root, options)).findings).toEqual([])
    await rm(path.join(root, '初始工作区/01-欢迎使用.md'))
    expect((await auditPackagedApplication(root, options)).findings).toContain('initial workspace must contain exactly the ten unchanged guide documents')
    await mkdir(path.join(root, 'pandoc'))
    await writeFile(path.join(root, 'pandoc/pandoc.exe'), 'unexpected bundled program')
    expect((await auditPackagedApplication(root, options)).findings).toContain('unexpected legacy component resources: pandoc')
  })

  it('requires an HTTPS component package to omit bundled conversion resources', async () => {
    const root = await createFakePackage()
    const descriptor = { ...documentConversionDescriptor(), source: 'https' as const, url: 'https://github.com/Lydiannnn/arkdown-releases/releases/download/tag/component.tar.gz' }
    await expect(auditDocumentConversionResources(root, descriptor)).resolves.toEqual([])
    await writeDocumentConversionResources(root, descriptor)
    await expect(auditDocumentConversionResources(root, descriptor)).resolves.toEqual([
      'unexpected bundled document conversion resources for HTTPS component',
    ])
  })

  it('reports a missing, non-directory, or junction-backed document conversion root', async () => {
    const descriptor = documentConversionDescriptor()
    const missing = await createFakePackage()
    await expect(auditDocumentConversionResources(missing, descriptor)).resolves.toEqual([
      'missing document conversion resources',
    ])

    const nonDirectory = await createFakePackage()
    const nonDirectoryRoot = path.join(nonDirectory, 'resources', 'document-conversion')
    await writeFile(nonDirectoryRoot, 'not a directory', 'utf8')
    await expect(auditDocumentConversionResources(nonDirectory, descriptor)).resolves.toEqual([
      'invalid document conversion resource root',
    ])

    const linked = await createFakePackage()
    const linkTarget = await temporaryRoot('arkdown-document-conversion-link-target-')
    await symlink(linkTarget, path.join(linked, 'resources', 'document-conversion'), 'junction')
    await expect(auditDocumentConversionResources(linked, descriptor)).resolves.toEqual([
      'invalid document conversion resource root',
    ])
  })

  it('rejects extra entries, case aliases, and unpacked runtime directories', async () => {
    const root = await createFakePackage()
    const descriptor = documentConversionDescriptor()
    const resourceRoot = await writeDocumentConversionResources(root, descriptor)
    const alias = descriptor.archiveName.toLocaleUpperCase('en-US')
    await rm(path.join(resourceRoot, descriptor.archiveName))
    await writeFile(path.join(resourceRoot, alias), documentConversionArchive)
    await writeFile(path.join(resourceRoot, 'extra.bin'), 'extra', 'utf8')
    await mkdir(path.join(resourceRoot, 'runtime'))
    await writeFile(path.join(resourceRoot, 'runtime', 'python.exe'), 'unpacked runtime')

    const findings = await auditDocumentConversionResources(root, descriptor)
    expect(findings).toEqual(expect.arrayContaining([
      path.join('missing document conversion asset', descriptor.archiveName),
      path.join('unexpected document conversion asset', alias),
      path.join('unexpected document conversion asset', 'extra.bin'),
      path.join('unexpected document conversion asset', 'runtime'),
    ]))

    const integrated = await auditPackagedApplication(root, {
      ...legacyAuditOptions,
      allowMissingDocumentConversionResources: false,
      documentConversionDescriptor: descriptor,
    })
    expect(integrated.findings).toEqual(expect.arrayContaining([
      path.join('unapproved package entry', 'resources', 'document-conversion', alias),
      path.join('unapproved package entry', 'resources', 'document-conversion', 'runtime'),
      path.join('unapproved package entry', 'resources', 'document-conversion', 'runtime', 'python.exe'),
    ]))
  })

  it.each([
    ['byte count', (descriptor: DocumentConversionComponentDescriptor) => ({
      ...descriptor,
      bytes: descriptor.bytes + 1,
    })],
    ['SHA-256', (descriptor: DocumentConversionComponentDescriptor) => ({
      ...descriptor,
      sha256: '0'.repeat(64),
    })],
  ])('rejects a document conversion archive with the wrong %s', async (_label, mutate) => {
    const root = await createFakePackage()
    const descriptor = mutate(documentConversionDescriptor())
    await writeDocumentConversionResources(root, descriptor, documentConversionArchive)

    await expect(auditDocumentConversionResources(root, descriptor)).resolves.toContain(
      path.join('modified document conversion archive', descriptor.archiveName),
    )
  })

  it.each([
    ['an extra field', (manifest: Record<string, unknown>) => ({ ...manifest, extra: true })],
    ['different content', (manifest: Record<string, unknown>) => ({ ...manifest, version: 'other' })],
    ['a non-object value', () => ['invalid']],
  ])('rejects a document conversion manifest with %s', async (_label, mutate) => {
    const root = await createFakePackage()
    const descriptor = documentConversionDescriptor()
    const resourceRoot = await writeDocumentConversionResources(root, descriptor)
    await writeFile(
      path.join(resourceRoot, 'manifest.json'),
      JSON.stringify(mutate(documentConversionManifest(descriptor))),
      'utf8',
    )

    await expect(auditDocumentConversionResources(root, descriptor)).resolves.toContain(
      'invalid document conversion manifest',
    )
  })

  it('turns a document conversion directory enumeration failure into a stable root finding', async () => {
    const root = await createFakePackage()
    const descriptor = documentConversionDescriptor()
    const resourceRoot = await writeDocumentConversionResources(root, descriptor)
    auditFsRace.beforeDirectoryRead = async (filePath) => {
      if (path.resolve(filePath) !== path.resolve(resourceRoot)) return
      auditFsRace.beforeDirectoryRead = null
      throw new Error('deterministic enumeration failure')
    }

    await expect(auditDocumentConversionResources(root, descriptor, raceFileSystem())).resolves.toEqual([
      'invalid document conversion resource root',
    ])
  })

  it('turns document conversion root removal during enumeration into a stable root finding', async () => {
    const root = await createFakePackage()
    const descriptor = documentConversionDescriptor()
    const resourceRoot = await writeDocumentConversionResources(root, descriptor)
    auditFsRace.beforeDirectoryRead = async (filePath) => {
      if (path.resolve(filePath) !== path.resolve(resourceRoot)) return
      auditFsRace.beforeDirectoryRead = null
      await rm(resourceRoot, { recursive: true, force: true })
    }

    await expect(auditDocumentConversionResources(root, descriptor, raceFileSystem())).resolves.toEqual([
      'invalid document conversion resource root',
    ])
  })

  it('rejects a document conversion root replaced by a junction before enumeration', async () => {
    const root = await createFakePackage()
    const descriptor = documentConversionDescriptor()
    const resourceRoot = await writeDocumentConversionResources(root, descriptor)
    const replacementPackage = await createFakePackage()
    const replacementRoot = await writeDocumentConversionResources(replacementPackage, descriptor)
    auditFsRace.beforeDirectoryRead = async (filePath) => {
      if (path.resolve(filePath) !== path.resolve(resourceRoot)) return
      auditFsRace.beforeDirectoryRead = null
      await rm(resourceRoot, { recursive: true, force: true })
      await symlink(replacementRoot, resourceRoot, 'junction')
    }

    await expect(auditDocumentConversionResources(root, descriptor, raceFileSystem())).resolves.toEqual([
      'invalid document conversion resource root',
    ])
  })

  it('rejects a document conversion root replaced by an exact junction after enumeration', async () => {
    const root = await createFakePackage()
    const descriptor = documentConversionDescriptor()
    const resourceRoot = await writeDocumentConversionResources(root, descriptor)
    const replacementPackage = await createFakePackage()
    const replacementRoot = await writeDocumentConversionResources(replacementPackage, descriptor)
    const archivePath = path.join(resourceRoot, descriptor.archiveName)
    auditFsRace.beforeFileMetadata = async (filePath) => {
      if (path.resolve(filePath) !== path.resolve(archivePath)) return
      auditFsRace.beforeFileMetadata = null
      await rm(resourceRoot, { recursive: true, force: true })
      await symlink(replacementRoot, resourceRoot, 'junction')
    }

    await expect(auditDocumentConversionResources(root, descriptor, raceFileSystem())).resolves.toEqual([
      'invalid document conversion resource root',
    ])
  })

  it.each([
    ['archive', 'archive-symlink'],
    ['manifest', 'manifest-symlink'],
    ['archive', 'archive-directory'],
    ['manifest', 'manifest-unreadable'],
  ] as const)('contains a %s %s replacement during its actual read', async (kind, replacement) => {
    const root = await createFakePackage()
    const descriptor = documentConversionDescriptor()
    const resourceRoot = await writeDocumentConversionResources(root, descriptor)
    const targetPath = path.join(
      resourceRoot,
      kind === 'archive' ? descriptor.archiveName : 'manifest.json',
    )
    const replacementRoot = await temporaryRoot('arkdown-document-conversion-read-race-')
    const replacementPath = path.join(replacementRoot, path.basename(targetPath))
    if (kind === 'archive') await writeFile(replacementPath, documentConversionArchive)
    else {
      await writeFile(
        replacementPath,
        `${JSON.stringify(documentConversionManifest(descriptor))}\n`,
        'utf8',
      )
    }
    auditFsRace.beforeFileRead = async (filePath) => {
      if (path.resolve(filePath) !== path.resolve(targetPath)) return
      auditFsRace.beforeFileRead = null
      if (replacement === 'manifest-unreadable') {
        throw new Error('deterministic manifest read failure')
      }
      await rm(targetPath, { recursive: true, force: true })
      if (replacement === 'archive-directory') await mkdir(targetPath)
      else await symlink(replacementPath, targetPath, 'file')
    }

    const expected = kind === 'archive'
      ? path.join('modified document conversion archive', descriptor.archiveName)
      : 'invalid document conversion manifest'
    await expect(auditDocumentConversionResources(root, descriptor, raceFileSystem())).resolves.toContain(expected)
  })

  it('requires an exact regular package provenance record bound to app.asar', async () => {
    const root = await createFakePackage({ provenance: false })

    const report = await auditPackagedApplication(root, legacyAuditOptions)

    expect(report.findings).toContain('missing package provenance')
  })

  it('rejects extra provenance fields and an app.asar changed after provenance was written', async () => {
    const root = await createFakePackage()
    const provenancePath = path.join(root, 'resources', PACKAGE_PROVENANCE_FILENAME)
    const provenance = JSON.parse(await readFile(provenancePath, 'utf8')) as Record<string, unknown>
    await writeFile(provenancePath, JSON.stringify({ ...provenance, extra: true }), 'utf8')

    const extra = await auditPackagedApplication(root, legacyAuditOptions)
    expect(extra.findings).toContain('invalid package provenance schema')

    await rm(provenancePath)
    await writePackageProvenance([root], { commit: '3'.repeat(40), tree: '4'.repeat(40) })
    await writeFile(path.join(root, 'resources', 'app.asar'), 'changed after provenance', 'utf8')
    const changed = await auditPackagedApplication(root, legacyAuditOptions)
    expect(changed.findings).toContain('package provenance app.asar hash mismatch')
  })

  it('requires exactly the two source-matching screenshot translation bridges', async () => {
    const sourceDirectory = path.resolve('scripts')
    const ocr = await readFile(path.join(sourceDirectory, 'windows-ocr.ps1'))
    const hit = await readFile(path.join(sourceDirectory, 'windows-window-hit-test.ps1'))
    const root = await createFakePackage({ rootEntries: {
      'resources/screenshot-translation/windows-ocr.ps1': ocr.toString('utf8'),
      'resources/screenshot-translation/windows-window-hit-test.ps1': hit.toString('utf8'),
    } })

    const clean = await auditPackagedApplication(root, { screenshotBridgeSourceDirectory: sourceDirectory, ...legacyAuditOptions })
    expect(clean.findings).toEqual([])

    await writeFile(path.join(root, 'resources', 'screenshot-translation', 'windows-ocr.ps1'), 'modified')
    await writeFile(path.join(root, 'resources', 'screenshot-translation', 'extra.ps1'), 'extra')
    const changed = await auditPackagedApplication(root, { screenshotBridgeSourceDirectory: sourceDirectory, ...legacyAuditOptions })
    expect(changed.findings).toEqual(expect.arrayContaining([
      path.join('modified screenshot translation bridge', 'windows-ocr.ps1'),
      path.join('unexpected screenshot translation bridge', 'extra.ps1'),
    ]))
    await rm(path.join(root, 'resources', 'screenshot-translation', 'windows-window-hit-test.ps1'))
    const missing = await auditPackagedApplication(root, { screenshotBridgeSourceDirectory: sourceDirectory, ...legacyAuditOptions })
    expect(missing.findings).toContain(path.join('missing screenshot translation bridge', 'windows-window-hit-test.ps1'))
  })

  it('requires the screenshot OCR resource root in a normal package audit', async () => {
    const root = await createFakePackage()

    const report = await auditPackagedApplication(root)

    expect(report.findings).toContain('missing screenshot OCR resources')
  })

  it('rejects noncanonical bridge casing and non-file bridge entries', async () => {
    const sourceDirectory = path.resolve('scripts')
    const root = await createFakePackage()
    const bridgeDirectory = path.join(root, 'resources', 'screenshot-translation')
    await rm(path.join(bridgeDirectory, 'windows-ocr.ps1'))
    await writeFile(path.join(bridgeDirectory, 'WINDOWS-OCR.ps1'), await readFile(path.join(sourceDirectory, 'windows-ocr.ps1')))
    await rm(path.join(bridgeDirectory, 'windows-window-hit-test.ps1'))
    await mkdir(path.join(bridgeDirectory, 'windows-window-hit-test.ps1'))

    const report = await auditPackagedApplication(root, { screenshotBridgeSourceDirectory: sourceDirectory, ...legacyAuditOptions })
    expect(report.findings).toEqual(expect.arrayContaining([
      path.join('missing screenshot translation bridge', 'windows-ocr.ps1'),
      path.join('unexpected screenshot translation bridge', 'WINDOWS-OCR.ps1'),
      path.join('missing screenshot translation bridge', 'windows-window-hit-test.ps1'),
      path.join('unexpected screenshot translation bridge', 'windows-window-hit-test.ps1'),
    ]))
  })

  it('reports forbidden legacy brands in ASCII and UTF-16LE files', async () => {
    const root = await temporaryRoot('arkdown-package-audit-')
    await mkdir(path.join(root, 'resources'))
    await writeFile(path.join(root, 'clean.txt'), 'Arkdown')
    await writeFile(path.join(root, 'resources', 'legacy-ascii.bin'), ['Ty', 'pora', 'Lite'].join(''))
    await writeFile(
      path.join(root, 'resources', 'legacy-utf16.bin'),
      Buffer.from(['Local', 'MD'].join(''), 'utf16le'),
    )

    await expect(auditArkdownPackage(root)).resolves.toEqual([
      path.join('resources', 'legacy-ascii.bin'),
      path.join('resources', 'legacy-utf16.bin'),
    ])
  })

  it('accepts independently branded launchers sharing one clean app.asar without writable profile data', async () => {
    const root = await createFakePackage()

    const report = await auditPackagedApplication(root, legacyAuditOptions)

    expect(report.findings).toEqual([])
    expect(report.version).toBe('0.1.0')
    expect(report.executables.map(({ name }) => name)).toEqual(['Arkdown.exe', 'Arknote.exe'])
    expect(report.executables[0]?.sha256).not.toBe(report.executables[1]?.sha256)
  })

  it('rejects any second app.asar outside the one shared resources archive', async () => {
    const root = await createFakePackage()
    const duplicate = path.join(root, 'duplicate', 'app.asar')
    await mkdir(path.dirname(duplicate), { recursive: true })
    await writeFile(duplicate, 'duplicate archive', 'utf8')

    const report = await auditPackagedApplication(root)

    expect(report.findings).toContain(path.join('unexpected app.asar', 'duplicate', 'app.asar'))
  })

  it('rejects non-branding launcher differences, runtime tokens, test data, SDD files, and temporary manuals', async () => {
    const root = await createFakePackage({
      arknoteBytes: 'different-launcher',
      asarEntries: {
        '.vite/build/main.js': 'console.log("Arkdown")',
        '.superpowers/sdd/task-11-brief.md': 'temporary requirements',
        'tests/fixtures/token.txt': 'test data',
        'docs/testing/便签功能黑盒测试手册.md': 'manual',
        'docs/user-guide/便签功能用户说明书.md': 'manual',
        'docs/待测试项目.md': 'manual',
      },
    })
    const token = path.join(root, 'portable-data', 'arknote', 'service-token')
    await mkdir(path.dirname(token), { recursive: true })
    await writeFile(token, 'a'.repeat(64), 'utf8')

    const report = await auditPackagedApplication(root)

    expect(report.findings).toEqual(expect.arrayContaining([
      'Arknote executable differs from the approved branding transform',
      path.join('forbidden package entry', 'portable-data'),
      path.join('forbidden package entry', 'portable-data', 'arknote', 'service-token'),
      path.join('forbidden asar entry', '.superpowers', 'sdd', 'task-11-brief.md'),
      path.join('forbidden asar entry', 'tests'),
      path.join('forbidden asar entry', 'tests', 'fixtures', 'token.txt'),
      path.join('forbidden asar entry', 'docs', 'testing', '便签功能黑盒测试手册.md'),
      path.join('forbidden asar entry', 'docs', 'user-guide', '便签功能用户说明书.md'),
      path.join('forbidden asar entry', 'docs', '待测试项目.md'),
    ]))
  })

  it('accepts only approved app.asar top-level content while allowing nested runtime dependencies', async () => {
    const root = await createFakePackage({
      asarEntries: {
        '.vite/build/main.js': 'console.log("Arkdown")',
        '.vite/renderer/main_window/index.html': '<main>Arkdown</main>',
        '.vite/renderer/main_window/assets/mermaid.core-D4YfB1k2.js': 'export default "Mermaid"',
        'node_modules/runtime-dependency/package.json': '{"name":"runtime-dependency"}',
        'node_modules/runtime-dependency/index.js': 'export default true',
        'package.json': '{"name":"arkdown","main":".vite/build/main.js"}',
        'THIRD_PARTY_NOTICES.md': 'third-party notices',
      },
    })

    const report = await auditPackagedApplication(root, legacyAuditOptions)

    expect(report.findings).toEqual([])
  })

  it('keeps ExcelJS inside app.asar and rejects an unpacked duplicate', async () => {
    const packed = await createFakePackage({
      asarEntries: {
        '.vite/build/main.js': 'import "exceljs"',
        '.vite/renderer/main_window/assets/mermaid.core-D4YfB1k2.js': 'export default "Mermaid"',
        'node_modules/exceljs/package.json': '{"name":"exceljs","version":"4.4.0"}',
        'node_modules/exceljs/lib/exceljs.nodejs.js': 'module.exports = {}',
        'package.json': '{"name":"arkdown","main":".vite/build/main.js"}',
        'THIRD_PARTY_NOTICES.md': 'third-party notices',
      },
    })
    expect((await auditPackagedApplication(packed, legacyAuditOptions)).findings).toEqual([])

    const unpacked = await createFakePackage({
      rootEntries: {
        'resources/app.asar.unpacked/node_modules/exceljs/package.json': '{"name":"exceljs"}',
      },
    })
    expect((await auditPackagedApplication(unpacked, legacyAuditOptions)).findings).toEqual(
      expect.arrayContaining([
        path.join('unapproved package entry', 'resources', 'app.asar.unpacked'),
        path.join(
          'unapproved package entry',
          'resources',
          'app.asar.unpacked',
          'node_modules',
          'exceljs',
          'package.json',
        ),
      ]),
    )
  })

  it('rejects every unapproved app.asar top-level source or generated artifact', async () => {
    const root = await createFakePackage({
      asarEntries: {
        '.vite/build/main.js': 'console.log("Arkdown")',
        'coverage/index.html': 'coverage',
        'docs/roadmap.md': 'roadmap',
        'src/main.ts': 'source',
      },
    })

    const report = await auditPackagedApplication(root, legacyAuditOptions)

    expect(report.findings).toEqual(expect.arrayContaining([
      path.join('unapproved asar entry', 'coverage'),
      path.join('unapproved asar entry', 'coverage', 'index.html'),
      path.join('unapproved asar entry', 'docs'),
      path.join('unapproved asar entry', 'docs', 'roadmap.md'),
      path.join('unapproved asar entry', 'src'),
      path.join('unapproved asar entry', 'src', 'main.ts'),
    ]))
  })

  it('accepts the Electron 43 runtime, locales, resources, Pandoc, and guide roots', async () => {
    const root = await createFakePackage({
      rootEntries: {
        'LICENSE': 'Electron license',
        'LICENSES.chromium.html': 'Chromium licenses',
        'chrome_100_percent.pak': 'one',
        'chrome_200_percent.pak': 'two',
        'd3dcompiler_47.dll': 'dll',
        'dxcompiler.dll': 'dll',
        'dxil.dll': 'dll',
        'ffmpeg.dll': 'dll',
        'icudtl.dat': 'data',
        'libEGL.dll': 'dll',
        'libGLESv2.dll': 'dll',
        'locales/en-US.pak': 'locale',
        'locales/zh-CN.pak': 'locale',
        'pandoc/pandoc.exe': 'pandoc',
        'resources.pak': 'resources',
        'snapshot_blob.bin': 'snapshot',
        'v8_context_snapshot.bin': 'snapshot',
        'vk_swiftshader.dll': 'dll',
        'vk_swiftshader_icd.json': '{}',
        'vulkan-1.dll': 'dll',
        '使用说明书.html': '<main>Guide</main>',
        '使用说明书/assets/guide.css': 'body{}',
        '初始工作区/01-欢迎使用.md': '# 欢迎使用',
        '初始工作区/10-常用快捷键.md': '# 常用快捷键',
      },
    })

    const report = await auditPackagedApplication(root, legacyAuditOptions)

    expect(report.findings).toEqual([])
  })

  it('rejects unapproved package-root files and content inside constrained runtime directories', async () => {
    const root = await createFakePackage({
      rootEntries: {
        'debug.log': 'diagnostic',
        'locales/notes.txt': 'not a locale pack',
        'pandoc/cache.bin': 'runtime cache',
        'resources/app.asar.unpacked/debug.js': 'unpacked source',
        'temp/session.json': '{}',
        '初始工作区/debug.log': 'diagnostic',
        '初始工作区/11-把夏天骑进海风里.md': 'retired example',
        '初始工作区/notes.md': 'unindexed document',
        '初始工作区/nested/01-欢迎使用.md': 'nested document',
        '初始工作区/assets/debug.log': 'diagnostic',
        '初始工作区/assets/other/image.png': 'unapproved image',
        '初始工作区/assets/summer-sea-breeze/05-extra.png': 'unapproved image',
        '初始工作区/assets/summer-sea-breeze/01-coastal-ride.png/payload.txt': 'directory disguised as image',
      },
    })

    const report = await auditPackagedApplication(root, legacyAuditOptions)

    expect(report.findings).toEqual(expect.arrayContaining([
      path.join('unapproved package entry', 'debug.log'),
      path.join('unapproved package entry', 'locales', 'notes.txt'),
      path.join('unapproved package entry', 'pandoc', 'cache.bin'),
      path.join('unapproved package entry', 'resources', 'app.asar.unpacked'),
      path.join('unapproved package entry', 'resources', 'app.asar.unpacked', 'debug.js'),
      path.join('unapproved package entry', 'temp'),
      path.join('unapproved package entry', 'temp', 'session.json'),
      path.join('unapproved package entry', '初始工作区', 'debug.log'),
      path.join('unapproved package entry', '初始工作区', '11-把夏天骑进海风里.md'),
      path.join('unapproved package entry', '初始工作区', 'notes.md'),
      path.join('unapproved package entry', '初始工作区', 'nested'),
      path.join('unapproved package entry', '初始工作区', 'nested', '01-欢迎使用.md'),
      path.join('unapproved package entry', '初始工作区', 'assets', 'debug.log'),
      path.join('unapproved package entry', '初始工作区', 'assets', 'other'),
      path.join('unapproved package entry', '初始工作区', 'assets', 'other', 'image.png'),
      path.join('unapproved package entry', '初始工作区', 'assets', 'summer-sea-breeze', '05-extra.png'),
      path.join('unapproved package entry', '初始工作区', 'assets', 'summer-sea-breeze', '01-coastal-ride.png'),
      path.join('unapproved package entry', '初始工作区', 'assets', 'summer-sea-breeze', '01-coastal-ride.png', 'payload.txt'),
    ]))
  })

  it('rejects unapproved screenshot OCR resources instead of allowing arbitrary package files', async () => {
    const root = await createFakePackage({
      rootEntries: {
        'resources/screenshot-ocr/unapproved.bin': 'unapproved',
      },
    })

    const report = await auditPackagedApplication(root, legacyAuditOptions)

    expect(report.findings).toContain(path.join('unexpected screenshot OCR asset', 'unapproved.bin'))
  })

  it('rejects incomplete and noncanonical screenshot OCR resource trees', async () => {
    const root = await createFakePackage({
      rootEntries: {
        'resources/screenshot-ocr/SMALL-DET.TAR': 'wrong case',
      },
    })
    await mkdir(path.join(root, 'resources', 'screenshot-ocr', 'small-rec.tar'))

    const report = await auditPackagedApplication(root, legacyAuditOptions)

    expect(report.findings).toEqual(expect.arrayContaining([
      path.join('unexpected screenshot OCR asset', 'SMALL-DET.TAR'),
      path.join('unexpected screenshot OCR asset', 'small-rec.tar'),
      path.join('missing screenshot OCR asset', 'manifest.json'),
      path.join('missing screenshot OCR asset', 'small-det.tar'),
      path.join('missing screenshot OCR asset', 'small-rec.tar'),
    ]))
  })
})
