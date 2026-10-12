import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, defaultClientConditions, type InlineConfig } from 'vite'
import { SCREENSHOT_OCR_PACKAGE_MANIFEST } from '../src/shared/screenshot-ocr-manifest.ts'
import { prepareScreenshotOcrDevelopmentResources } from './package-screenshot-ocr-models.ts'
import { componentTreeFiles } from './package-optional-components.ts'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baseManifest = { ...SCREENSHOT_OCR_PACKAGE_MANIFEST,
  artifacts: SCREENSHOT_OCR_PACKAGE_MANIFEST.artifacts.filter(({ name }) => !name.startsWith('opencv/')) }

export function screenshotOcrRuntimeBuildConfig(outputRoot: string): InlineConfig {
  return {
    configFile: false,
    root: repositoryRoot,
    plugins: [{
      name: 'arkdown-direct-ocr-only', enforce: 'pre',
      transform(code, id) {
        if (!id.replaceAll('\\', '/').endsWith('/@paddleocr/paddleocr-js/dist/index.mjs')) return
        const start = code.indexOf('function createDefaultWorker() {')
        const end = code.indexOf('class WorkerBackedPaddleOCR {', start)
        if (start < 0 || end < 0 || !code.slice(start, end).includes('./assets/worker-entry-')) {
          throw new Error('Unsupported PaddleOCR worker factory')
        }
        // Arkdown owns the worker and uses the SDK direct pipeline; never bundle its unused nested worker.
        return code.slice(0, start) + 'function createDefaultWorker() { throw new Error("OCR_UNAVAILABLE"); }\n' + code.slice(end)
      },
    }],
    resolve: { conditions: [...defaultClientConditions, 'onnxruntime-web-use-extern-wasm'] },
    build: {
      outDir: outputRoot,
      emptyOutDir: false,
      minify: true,
      sourcemap: false,
      rolldownOptions: {
        input: path.join(repositoryRoot, 'src/renderer/screenshot/screenshot-ocr-worker.ts'),
        output: { format: 'es', entryFileNames: 'worker.js', codeSplitting: false },
      },
    },
  }
}

export async function buildScreenshotOcrRuntime(options: {
  outputRoot?: string
  sourceRoot?: string
  licensesRoot?: string
} = {}): Promise<string> {
  const outputRoot = path.resolve(options.outputRoot ?? path.join(repositoryRoot, '.components/ocr-base/runtime'))
  const parent = path.dirname(outputRoot)
  if (outputRoot === parent || path.basename(outputRoot) !== 'runtime') throw new Error('Invalid OCR runtime output')
  await mkdir(parent, { recursive: true })
  const staging = await mkdtemp(path.join(parent, '.runtime-build-'))
  const previous = path.join(parent, `.runtime-previous-${randomUUID()}`)
  let previousMoved = false
  try {
    const sourceRoot = options.sourceRoot ?? path.join(await prepareScreenshotOcrDevelopmentResources({
      developmentRoot: repositoryRoot, manifest: baseManifest,
    }), 'screenshot-ocr')
    for (const artifact of baseManifest.artifacts) {
      const source = path.join(sourceRoot, ...artifact.name.split('/'))
      const info = await lstat(source)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.bytes) throw new Error('Invalid OCR runtime source')
      const bytes = await readFile(source)
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Invalid OCR runtime source')
      const target = path.join(staging, ...artifact.name.split('/'))
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, bytes, { flag: 'wx' })
    }
    const licensesRoot = path.resolve(options.licensesRoot ?? path.join(parent, 'licenses'))
    const licenseInfo = await lstat(licensesRoot)
    if (!licenseInfo.isDirectory() || licenseInfo.isSymbolicLink()) throw new Error('Invalid OCR runtime licenses')
    const licenses = await readdir(licensesRoot, { withFileTypes: true })
    if (licenses.length === 0 || licenses.length > 64) throw new Error('Invalid OCR runtime licenses')
    await mkdir(path.join(staging, 'licenses'))
    for (const license of licenses) {
      if (!license.isFile() || license.isSymbolicLink() || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(license.name)) throw new Error('Invalid OCR runtime license')
      const source = path.join(licensesRoot, license.name)
      const info = await lstat(source)
      if (info.size <= 0 || info.size > 4 * 1024 * 1024) throw new Error('Invalid OCR runtime license')
      await writeFile(path.join(staging, 'licenses', license.name), await readFile(source), { flag: 'wx' })
    }
    await build(screenshotOcrRuntimeBuildConfig(staging))
    const worker = await lstat(path.join(staging, 'worker.js'))
    if (!worker.isFile() || worker.size <= 0 || worker.size > 32 * 1024 * 1024) throw new Error('Invalid OCR worker build')
    await writeFile(path.join(staging, 'component-manifest.json'), JSON.stringify({
      schemaVersion: 1, version: '1.0.0', entry: 'worker.js', files: await componentTreeFiles(staging),
    }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    const old = await lstat(outputRoot).catch(() => undefined)
    if (old) {
      if (!old.isDirectory() || old.isSymbolicLink()) throw new Error('Invalid OCR runtime output')
      await rename(outputRoot, previous)
      previousMoved = true
    }
    try { await rename(staging, outputRoot) } catch (error) {
      if (previousMoved) await rename(previous, outputRoot)
      throw error
    }
    if (previousMoved) await rm(previous, { recursive: true, force: true })
    return outputRoot
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await buildScreenshotOcrRuntime())
}
