import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { RUNTIME_COMPONENT_DEFINITIONS, runtimeComponentSourceDirectory } from '../src/shared/optional-component-catalog.ts'
import { DOCUMENT_CONVERSION_COMPONENT_MANIFEST, DOCUMENT_CONVERSION_COMPONENT_TREE_SHA256 } from '../src/shared/document-conversion-component-manifest.ts'
import { SCREEN_TRANSLATION_COMPONENT_DESCRIPTOR, SCREEN_TRANSLATION_COMPONENT_TREE_SHA256 } from '../src/shared/screen-translation-component-manifest.ts'
import { SCREENSHOT_OCR_MEDIUM_COMPONENT_DESCRIPTOR, SCREENSHOT_OCR_MEDIUM_COMPONENT_TREE_SHA256 } from '../src/shared/screenshot-ocr-medium-component-manifest.ts'
import { auditComponentTree, componentTreeFiles } from './package-optional-components.ts'
import type { ComponentTreeFile } from './package-optional-components.ts'

export type PackageEdition = 'full' | 'lite'
export const PACKAGE_EDITION_FILENAME = 'package-edition.json'
export interface EditionComponent {
  id: string; version: string; sourceRoot: string; resourcePath: string; treeManifestSha256: string
  /** Medium's existing manager owns a strict three-file activation layout. */
  selectedFiles?: readonly string[]
  selectedInventory?: readonly ComponentTreeFile[]
}
export function parsePackageEdition(input: unknown): PackageEdition {
  if (input !== 'full' && input !== 'lite') throw new Error('Set ARKDOWN_PACKAGE_EDITION explicitly to full or lite')
  return input
}
export function editionComponents(repoRoot = path.resolve(import.meta.dirname, '..')): EditionComponent[] {
  return [
    ...Object.values(RUNTIME_COMPONENT_DEFINITIONS).map(definition => ({
      id: definition.id, version: definition.descriptor.version,
      sourceRoot: path.join(repoRoot, '.components', runtimeComponentSourceDirectory(definition.id), 'runtime'),
      resourcePath: 'components/'+definition.id, treeManifestSha256: definition.treeManifestSha256,
    })),
    { id: 'screen-translation', version: SCREEN_TRANSLATION_COMPONENT_DESCRIPTOR.version,
      sourceRoot: path.join(repoRoot, '.components/screen-translation-curated/runtime'),
      resourcePath: 'screen-translation/runtime', treeManifestSha256: SCREEN_TRANSLATION_COMPONENT_TREE_SHA256 },
    { id: 'document-conversion', version: DOCUMENT_CONVERSION_COMPONENT_MANIFEST.version,
      sourceRoot: path.join(repoRoot, '.components/markitdown/runtime'),
      resourcePath: 'document-conversion/runtime', treeManifestSha256: DOCUMENT_CONVERSION_COMPONENT_TREE_SHA256 },
    { id: 'ocr-medium', version: SCREENSHOT_OCR_MEDIUM_COMPONENT_DESCRIPTOR.version,
      sourceRoot: path.join(repoRoot, '.components/ocr-medium/runtime'), resourcePath: 'components/ocr-medium',
      treeManifestSha256: SCREENSHOT_OCR_MEDIUM_COMPONENT_TREE_SHA256,
      selectedFiles: ['manifest.json', 'medium-det.tar', 'medium-rec.tar'],
      selectedInventory: [
        { path: 'licenses/PaddleOCR-LICENSE.txt', bytes: 11_376, sha256: '3840c5c0c61c294264d2dd77b8777be6ddd90121ef4e0e64abcd22edea581d6e' },
        { path: 'manifest.json', bytes: 352, sha256: '94820b272a23796a71cddec9b6a8c58a6615d3cd6c23f06de37d2b1462bc0354' },
        { path: 'medium-det.tar', bytes: 62_044_160, sha256: 'c5adb0b15de1b1838934eba1dd72e7529e7d80132216c6ee6d26eba6fa054fcf' },
        { path: 'medium-rec.tar', bytes: 76_718_080, sha256: 'd8cc46c7163c83a151aef8fce5856b965860df90a875029216d605b0f607eaec' },
      ] },
  ]
}
function metadata(edition: PackageEdition, components: EditionComponent[]) {
  return { schemaVersion: 1, edition, components: edition === 'full' ? components.map(component => ({
    id: component.id, version: component.version, treeManifestSha256: component.treeManifestSha256,
  })) : [] }
}
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')
async function regularAncestors(root: string, relative: string) {
  let current = path.resolve(root)
  for (const part of ['', ...relative.split('/').filter(Boolean)]) {
    current = path.join(current, part)
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid resource ancestor')
  }
}
function approve(entries: Map<string, 'file' | 'directory'>, relative: string) {
  entries.set(relative, 'file')
  const segments = relative.split('/')
  for (let i = 1; i < segments.length; i += 1) entries.set(segments.slice(0, i).join('/'), 'directory')
}
async function pinnedFiles(component: EditionComponent): Promise<ComponentTreeFile[]> {
  const findings = await auditComponentTree(component.sourceRoot, component.treeManifestSha256)
  if (findings.length) throw new Error(component.id+': '+findings.join(', '))
  return componentTreeFiles(component.sourceRoot)
}
/** Source validation precedes all mutations; Full never activates into writable user cache. */
export async function packageEditionResources(packageRoot: string, edition: PackageEdition,
  options: { components?: EditionComponent[]; repoRoot?: string } = {}): Promise<void> {
  parsePackageEdition(edition)
  const components = options.components ?? editionComponents(options.repoRoot)
  const inventories = new Map<string, ComponentTreeFile[]>()
  if (edition === 'full') for (const component of components) inventories.set(component.id, await pinnedFiles(component))
  const resources = path.join(packageRoot, 'resources')
  await mkdir(resources, { recursive: true })
  if (edition === 'full') for (const component of components) {
    for (const file of inventories.get(component.id)!) {
      let destination: string
      if (!component.selectedFiles || component.selectedFiles.includes(file.path)) destination = component.resourcePath+'/'+file.path
      else if (file.path.startsWith('licenses/')) destination = 'licenses/'+component.id+'/'+file.path.slice('licenses/'.length)
      else continue
      const target = path.join(resources, destination)
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(path.join(component.sourceRoot, file.path), target)
      const copied = await readFile(target)
      if (copied.length !== file.bytes || hash(copied) !== file.sha256) throw new Error('Copied component changed: '+component.id)
    }
  }
  await writeFile(path.join(resources, PACKAGE_EDITION_FILENAME), JSON.stringify(metadata(edition, components), null, 2)+'\n', 'utf8')
  const audit = await auditEditionResources(packageRoot, { components })
  if (audit.findings.length) throw new Error(audit.findings.join('\n'))
}
export async function auditEditionResources(packageRoot: string,
  options: { components?: EditionComponent[]; repoRoot?: string } = {}) {
  const components = options.components ?? editionComponents(options.repoRoot)
  const findings: string[] = [], approvedEntries = new Map<string, 'file' | 'directory'>()
  const resources = path.join(packageRoot, 'resources')
  let edition: PackageEdition | undefined
  try {
    await regularAncestors(packageRoot, 'resources')
    const file = path.join(resources, PACKAGE_EDITION_FILENAME), info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) throw new Error('Invalid edition metadata')
    const parsed = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, ''))
    edition = parsePackageEdition(parsed.edition)
    if (JSON.stringify(parsed) !== JSON.stringify(metadata(edition, components))) throw new Error('Edition inventory mismatch')
    approve(approvedEntries, 'resources/'+PACKAGE_EDITION_FILENAME)
  } catch { findings.push('invalid or missing package edition metadata'); return { edition, findings, approvedEntries } }
  for (const old of ['pandoc', 'resources/screenshot-ocr', 'resources/screenshot-ocr-medium']) {
    if (await lstat(path.join(packageRoot, old)).catch(() => null)) findings.push('unexpected legacy component resources: '+old)
  }
  if (edition === 'lite') {
    for (const location of ['components', 'document-conversion', 'screen-translation/runtime', 'licenses']) {
      if (await lstat(path.join(resources, location)).catch(() => null)) findings.push('unexpected Lite component resources: '+location)
    }
    return { edition, findings, approvedEntries }
  }
  for (const component of components) {
    const root = path.join(resources, component.resourcePath)
    try { await regularAncestors(resources, component.resourcePath) }
    catch { findings.push(component.id+': invalid component directory'); continue }
    if (!component.selectedFiles) {
      const result = await auditComponentTree(root, component.treeManifestSha256)
      if (result.length) { findings.push(...result.map(value => component.id+': '+value)); continue }
      for (const file of await componentTreeFiles(root)) approve(approvedEntries, 'resources/'+component.resourcePath+'/'+file.path)
    } else {
      // Compare the legacy subset against the pinned public inventory, never a self-authored packaged manifest.
      try {
        const files = component.selectedInventory
        if (!files) throw new Error('Compiled subset inventory missing')
        const expected = files.filter(file => component.selectedFiles!.includes(file.path))
        const actual = await componentTreeFiles(root)
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Payload subset mismatch')
        for (const file of actual) approve(approvedEntries, 'resources/'+component.resourcePath+'/'+file.path)
        for (const file of files.filter(value => value.path.startsWith('licenses/'))) {
          const name = 'licenses/'+component.id+'/'+file.path.slice('licenses/'.length)
          const target = path.join(resources, name), info = await lstat(target)
          if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes || hash(await readFile(target)) !== file.sha256) throw new Error('License mismatch')
          approve(approvedEntries, 'resources/'+name)
        }
      } catch (error) { findings.push(component.id+': '+(error instanceof Error ? error.message : 'Invalid subset')) }
    }
  }
  // Every directory and file in module roots must be covered, including empty directories.
  for (const location of ['components', 'document-conversion', 'screen-translation/runtime', 'licenses']) {
    const root = path.join(resources, location)
    if (!await lstat(root).catch(() => null)) continue
    async function visit(directory: string) {
      const info = await lstat(directory), relative = path.relative(packageRoot, directory).replace(/\\/gu, '/')
      if (!info.isDirectory() || info.isSymbolicLink()) { findings.push('invalid component directory: '+relative); return }
      if (approvedEntries.get(relative) !== 'directory') findings.push('unexpected component directory: '+relative)
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name), name = path.relative(packageRoot, target).replace(/\\/gu, '/')
        if (entry.isSymbolicLink()) findings.push('invalid component link: '+name)
        else if (entry.isDirectory()) await visit(target)
        else if (!entry.isFile() || approvedEntries.get(name) !== 'file') findings.push('unexpected component file: '+name)
      }
    }
    await visit(root)
  }
  return { edition, findings, approvedEntries }
}
