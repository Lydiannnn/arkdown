import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SCREEN_TRANSLATION_COMPONENT_DESCRIPTOR } from '../src/shared/screen-translation-component-manifest.ts'

interface RuntimeFile { path: string; bytes: number; sha256: string }
const prefix = 'runtime/ArkTranslateEngine/'
export async function verifyScreenTranslationRuntime(repoRoot = process.cwd()): Promise<RuntimeFile[]> {
  const component = path.join(repoRoot, 'components', 'screen-translation')
  const manifest = JSON.parse(await readFile(path.join(component, 'manifest.json'), 'utf8')) as { protocol: number; files: RuntimeFile[] }
  if (manifest.protocol !== 2 || !Array.isArray(manifest.files)) throw new Error('Invalid screen translation runtime manifest')
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || /[\\:]/.test(file.path) || path.isAbsolute(file.path)
      || file.path.split('/').some(part => part === '..' || part === '.' || part === '')
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error('Invalid screen translation resource path')
    }
  }
  const runtime = manifest.files.filter(file => file.path.startsWith(prefix))
  if (!runtime.some(file => file.path === prefix + 'ArkTranslateEngine.exe')) throw new Error('Screen translation engine missing from manifest')
  for (const file of manifest.files.filter(file => file.path.startsWith('engine/'))) {
    const data = await readFile(path.join(component, file.path))
    if (createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error('Screen translation source changed: rebuild and update runtime manifest')
  }
  for (const file of runtime) {
    const relative = file.path.slice(prefix.length)
    if (relative.split(/[\\/]/).some(part => part === '..' || part === '') || path.isAbsolute(relative)
      || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid screen translation resource path')
    const source = path.join(repoRoot, '.components/screen-translation/runtime/ArkTranslateEngine', relative)
    const stat = await lstat(source)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes
      || createHash('sha256').update(await readFile(source)).digest('hex') !== file.sha256) throw new Error(`Screen translation resource mismatch: ${relative}`)
  }
  return runtime
}
export async function copyScreenTranslationToPackages(outputPaths: readonly string[], repoRoot = process.cwd()): Promise<void> {
  for (const outputPath of outputPaths) {
    const output = path.resolve(outputPath)
    const entries = await readdir(output, { withFileTypes: true })
    if (!entries.some(entry => entry.name === 'Arkdown.exe' && entry.isFile() && !entry.isSymbolicLink())
      || !entries.some(entry => entry.name === 'resources' && entry.isDirectory() && !entry.isSymbolicLink())) throw new Error('Invalid Arkdown package output')
    const target = path.join(output, 'resources', 'screen-translation')
    const staging = await mkdtemp(path.join(output, 'resources', '.screen-translation-'))
    try {
      for (const name of ['Arkdown.ScreenTranslation.exe', 'Arkdown.ScreenTranslation.exe.config']) {
        const source = path.join(repoRoot, '.native-cache', 'screen-translation', name)
        const metadata = await lstat(source)
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Invalid screen translation helper')
        await copyFile(source, path.join(staging, name))
      }
      await writeFile(path.join(staging, 'manifest.json'), JSON.stringify(SCREEN_TRANSLATION_COMPONENT_DESCRIPTOR, null, 2)+'\n', 'utf8')
      // Fixed child of the validated package resources directory; stale engines must not survive repackaging.
      await rm(target, { recursive: true, force: true })
      await rename(staging, target)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
}
