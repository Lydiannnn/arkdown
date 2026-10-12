import { copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { BRANDING_RUNTIME_FILES } from '../src/shared/branding.ts'

const sourceRoot = path.resolve(import.meta.dirname, '../assets/branding')
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export async function auditBrandingResources(directory: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, 'manifest.json'), 'utf8')) as {
    files: { path: string; sha256: string }[]
  }
  const findings: string[] = []
  const metadata = await lstat(directory).catch(() => null)
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) return ['missing or invalid branding resources']
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !BRANDING_RUNTIME_FILES.some((file) => file === entry.name)) {
      findings.push(`unexpected branding resource: ${entry.name}`)
    }
  }
  for (const file of BRANDING_RUNTIME_FILES) {
    const canonical = manifest.files.find((entry) => entry.path === `assets/branding/${file}`)
    if (!entries.some((entry) => entry.name === file && entry.isFile() && !entry.isSymbolicLink())) {
      findings.push(`missing branding resource: ${file}`)
    } else if (!canonical || sha256(await readFile(path.join(directory, file))) !== canonical.sha256) {
      findings.push(`modified branding resource: ${file}`)
    }
  }
  return findings
}

export async function copyBrandingToPackages(outputPaths: readonly string[]): Promise<void> {
  for (const output of outputPaths) {
    const directory = path.join(output, 'resources', 'branding')
    await mkdir(directory, { recursive: true })
    await Promise.all(BRANDING_RUNTIME_FILES.map((file) => copyFile(path.join(sourceRoot, file), path.join(directory, file))))
    const findings = await auditBrandingResources(directory)
    if (findings.length) throw new Error(findings.join('\n'))
  }
}
