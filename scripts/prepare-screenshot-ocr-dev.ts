import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { prepareScreenshotOcrDevelopmentResources } from './package-screenshot-ocr-models.ts'
import { validateScreenshotOcrPackageManifest } from './package-screenshot-ocr-models.ts'
import { buildScreenshotOcrRuntime } from './build-screenshot-ocr-runtime.ts'
import { auditComponentTree } from './package-optional-components.ts'
import { RUNTIME_COMPONENT_DEFINITIONS } from '../src/shared/optional-component-catalog.ts'

const { values } = parseArgs({
  options: {
    'development-root': { type: 'string' },
    'source-root': { type: 'string' },
    manifest: { type: 'string' },
  },
  strict: true,
  allowPositionals: false,
})

if ((values['source-root'] === undefined) !== (values.manifest === undefined)) {
  throw new Error('Offline source and manifest must be provided together')
}

let manifest
if (values.manifest) {
  manifest = JSON.parse(await readFile(values.manifest, 'utf8')) as unknown
  validateScreenshotOcrPackageManifest(manifest)
}

if (manifest) {
  // Explicit fixture manifests retain the standalone legacy resource-audit utility.
  await prepareScreenshotOcrDevelopmentResources({
    developmentRoot: values['development-root'], sourceRoot: values['source-root'], manifest,
  })
} else {
  const root = await buildScreenshotOcrRuntime({ outputRoot: path.resolve(values['development-root'] ?? process.cwd(), '.components/ocr-base/runtime') })
  if ((await auditComponentTree(root, RUNTIME_COMPONENT_DEFINITIONS['ocr-base'].treeManifestSha256)).length > 0) {
    throw new Error('OCR development component differs from the pinned release; regenerate its release manifest before use')
  }
  console.log('Verified OCR development component is ready')
}
