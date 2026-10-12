import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Allow raw Node to execute the same extensionless source imports used by Vite.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context) } catch (error) {
    if (specifier.startsWith('.') && !path.extname(specifier)
      && context.parentURL?.startsWith(new URL('../src/', import.meta.url).href)
      && (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      return nextResolve(`${specifier}.ts`, context)
    }
    throw error
  }
} })

const { GitHubReleaseArtifactSource } = await import('../src/main/document-conversion/component-artifact-source.ts')
const { createDocumentConversionComponentManager } = await import('../src/main/document-conversion/component-manager.ts')
const { DOCUMENT_CONVERSION_COMPONENT_MANIFEST: descriptor, DOCUMENT_CONVERSION_COMPONENT_RELEASE_BASE_URL: base } =
  await import('../src/shared/document-conversion-component-manifest.ts')
const root = await mkdtemp(path.join(tmpdir(), 'arkdown-github-verification-'))
const requests: { host: string; path: string; status: number }[] = []
const networkFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input))
  const response = await fetch(input, init)
  // Signed CDN query parameters are deliberately excluded from the report.
  requests.push({ host: url.hostname, path: url.pathname, status: response.status })
  return response
}
const source = new GitHubReleaseArtifactSource(descriptor, base, networkFetch)
const controller = new AbortController()
const cancelledTarget = path.join(root, 'cancelled.tar.gz')
let cancelled = false
try {
  try {
    await source.copyTo(cancelledTarget, controller.signal, progress => {
      if (progress.receivedBytes > 0) controller.abort()
    })
  } catch (error) {
    if (!controller.signal.aborted || (error as Error).name !== 'AbortError') throw error
    cancelled = true
  }
  if (!cancelled) throw new Error('Real download cancellation failed')
  await access(cancelledTarget).then(() => { throw new Error('Partial archive remained') }, error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
  const archive = path.join(root, descriptor.archiveName)
  await source.copyTo(archive, new AbortController().signal, () => undefined)
  const bytes = await readFile(archive)
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (bytes.length !== descriptor.bytes || hash !== descriptor.sha256) throw new Error('Real archive identity mismatch')
  const manager = await createDocumentConversionComponentManager({ userData: path.join(root, 'user-data'), descriptor, source })
  try {
    const installed = await manager.install('github-verification')
    if (installed.status !== 'installed') throw new Error(`Install failed: ${installed.errorCode}`)
    await manager.ensureVerified()
    const runtime = manager.resolveRuntime()
    if (runtime?.version !== descriptor.version) throw new Error('Installed runtime identity mismatch')
    const report = { verifiedAt: new Date().toISOString(), version: descriptor.version, bytes: bytes.length, sha256: hash,
      cancelledPartialRemoved: cancelled, retryDownloaded: true, installed: true, treeVerified: true, requests }
    const reportPath = path.join(repoRoot, '.components/github-markitdown-verification.json')
    await mkdir(path.dirname(reportPath), { recursive: true })
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
    process.stdout.write(JSON.stringify(report) + '\n')
  } finally { await manager.dispose() }
} finally {
  await rm(root, { recursive: true, force: true })
}
