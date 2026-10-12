// @vitest-environment node
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { createRuntimeComponentManager } from '../../src/main/components/runtime-component-manager'
import { createScreenshotOcrProtocolHandler } from '../../src/main/screenshot-translation/screenshot-ocr-resources'
import { createScreenshotOcrModelManager } from '../../src/main/screenshot-translation/screenshot-ocr-model-manager'
import { createGitHubMediumPreparer } from '../../src/main/screenshot-translation/screenshot-ocr-medium-source'
import { RUNTIME_COMPONENT_DEFINITIONS } from '../../src/shared/optional-component-catalog'
import { SCREENSHOT_OCR_MEDIUM_COMPONENT_DESCRIPTOR } from '../../src/shared/screenshot-ocr-medium-component-manifest'
import { SettingsAuthority } from '../../src/main/settings/settings-authority'
import { SettingsTransactionStore } from '../../src/main/settings/settings-transaction-store'

it.skipIf(process.env.ARKDOWN_VALIDATE_OCR_COMPONENTS !== '1')('validates the actual pinned Base and Medium archives, protocol, restart, and offline Full layout', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'arkdown-ocr-final-components-'))
  const archiveSource = (archive: string) => ({ kind: 'https' as const,
    copyTo: async (target: string, signal: AbortSignal) => { signal.throwIfAborted(); await copyFile(archive, target); signal.throwIfAborted() } })
  let base: Awaited<ReturnType<typeof createRuntimeComponentManager>> | undefined
  let medium: Awaited<ReturnType<typeof createScreenshotOcrModelManager>> | undefined
  let full: Awaited<ReturnType<typeof createScreenshotOcrModelManager>> | undefined
  try {
    const definition = RUNTIME_COMPONENT_DEFINITIONS['ocr-base']
    base = await createRuntimeComponentManager({ dataRoot, definition, artifactSource: archiveSource(path.resolve('.components/public-ocr-base-release', definition.descriptor.archiveName)) })
    expect(await base.ensureRuntime()).toBeUndefined()
    await base.install()
    const entry = await base.ensureRuntime()
    expect(entry).toBeDefined()
    expect(base.getState().status).toBe('installed')
    const handler = createScreenshotOcrProtocolHandler({ resourcesPath: dataRoot, resolveBaseRoot: async () => {
      const worker = await base!.ensureRuntime(); return worker ? path.dirname(worker) : undefined
    } })
    const worker = await handler({ url: 'arkdown-ocr://bundle/worker.js' })
    expect(worker.status).toBe(200)
    expect(Number(worker.headers.get('content-length'))).toBeLessThan(11_000_000)
    expect((await handler({ url: 'arkdown-ocr://bundle/small-det.tar' })).status).toBe(200)
    const settings = new SettingsAuthority(new SettingsTransactionStore(dataRoot, {
      isAvailable: () => false, encrypt: () => { throw new Error('unused') },
      decrypt: () => { throw new Error('unused') },
    }))
    const network = vi.fn(async () => { throw new Error('No network allowed for artifact reuse') })
    const mediumOptions = { dataRoot, settings, fetch: network,
      prepareMedium: createGitHubMediumPreparer({ artifactSource: archiveSource(path.resolve('.components/public-ocr-medium-release', SCREENSHOT_OCR_MEDIUM_COMPONENT_DESCRIPTOR.archiveName)) }) }
    medium = await createScreenshotOcrModelManager(mediumOptions)
    expect((await medium.downloadMedium((await medium.getObservedState()).observed)).status).toBe('medium-installed')
    expect((await medium.resolveActiveResource('medium-rec.tar'))?.byteLength).toBe(76_718_080)
    await medium.dispose()
    medium = await createScreenshotOcrModelManager(mediumOptions)
    expect(medium.getState()).toMatchObject({ activeTier: 'medium', status: 'medium-installed' })
    const bundledMediumRoot = path.join(dataRoot, 'full-medium')
    await mkdir(bundledMediumRoot)
    for (const name of ['medium-det.tar', 'medium-rec.tar', 'manifest.json']) await copyFile(path.resolve('.components/ocr-medium/runtime', name), path.join(bundledMediumRoot, name))
    full = await createScreenshotOcrModelManager({ ...mediumOptions, dataRoot: path.join(dataRoot, 'full-data'), bundledMediumRoot })
    expect(full.getState()).toMatchObject({ activeTier: 'medium', status: 'medium-installed' })
    expect((await full.resolveActiveResource('medium-det.tar'))?.byteLength).toBe(62_044_160)
    expect(network).not.toHaveBeenCalled()
  } finally {
    await base?.dispose(); await medium?.dispose(); await full?.dispose()
    await rm(dataRoot, { recursive: true, force: true })
  }
}, 60_000)
