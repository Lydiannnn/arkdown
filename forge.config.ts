import { buildStickyNoteNativeSurface } from './scripts/build-sticky-note-native-surface.ts'
import { buildScreenTranslation } from './scripts/build-screen-translation.ts'
import { copyScreenTranslationToPackages } from './scripts/package-screen-translation.ts'
import { buildApplicationUpdater, APPLICATION_UPDATER_TRUST_ENV } from './scripts/build-application-updater.ts'
import { packageApplicationUpdater } from './scripts/package-application-updater.ts'
import { writeUpdateManagedManifest } from './scripts/package-update-manifest.ts'
import { copyFile } from 'node:fs/promises'
import path from 'node:path'
import packageMetadata from './package.json'
import { copyStickyNoteNativeSurface } from './scripts/package-sticky-note-native-surface.ts'
import type { ForgeConfig } from '@electron-forge/shared-types'
import { copyBrandingToPackages } from './scripts/package-branding.ts'
import { FusesPlugin } from '@electron-forge/plugin-fuses'
import { VitePlugin } from '@electron-forge/plugin-vite'
import { FuseV1Options, FuseVersion } from '@electron/fuses'
import { copyUserGuideToPackages } from './scripts/package-user-guide.ts'
import { copyInitialWorkspaceToPackages } from './scripts/package-initial-workspace.ts'
import { copyArknoteExecutable } from './scripts/package-arknote.ts'
import { copyScreenshotTranslationBridges } from './scripts/package-screenshot-translation-bridges.ts'
import { packageEditionResources, parsePackageEdition } from './scripts/package-editions.ts'
import type { PackageEdition } from './scripts/package-editions.ts'
import {
  buildWorkspaceCommitHelper,
  WORKSPACE_COMMIT_HELPER_TRUST_ENV,
  workspaceCommitHelperTrustRecord,
} from './scripts/build-workspace-commit-helper.ts'
import { copyWorkspaceCommitHelperToPackages } from './scripts/package-workspace-commit-helper.ts'
import {
  captureCleanPackageSource,
  writePackageProvenance,
} from './scripts/package-provenance.ts'

let packagingSource: Awaited<ReturnType<typeof captureCleanPackageSource>> | undefined
let workspaceCommitArtifact: Awaited<ReturnType<typeof buildWorkspaceCommitHelper>> | undefined
let packagingEdition: PackageEdition | undefined
let applicationUpdater: Awaited<ReturnType<typeof buildApplicationUpdater>> | undefined

function ignorePackageSource(file: string): boolean {
  if (!file) return false
  const viteOutput = file === '/.vite' || file.startsWith('/.vite/')
  return file !== '/THIRD_PARTY_NOTICES.md' && !viteOutput
}

const config: ForgeConfig = {
  outDir: path.resolve('out', process.env.ARKDOWN_PACKAGE_EDITION ?? 'unconfigured'),
  packagerConfig: {
    asar: true,
    executableName: 'Arkdown',
    win32metadata: { CompanyName: 'Miterh' },
    appCopyright: 'Copyright (c) 2026 Miterh',
    icon: 'assets/branding/arkdown-app-rounded.ico',
    ignore: ignorePackageSource,
  },
  makers: [],
  hooks: {
    preStart: async () => {
      if (process.platform === 'win32' && (process.arch === 'x64' || process.arch === 'arm64')) {
        await buildWorkspaceCommitHelper({ repoRoot: process.cwd(), arch: process.arch })
      }
    },
    prePackage: async (_forgeConfig, platform, arch) => {
      if (platform !== 'win32' || (arch !== 'x64' && arch !== 'arm64')) {
        throw new Error('Workspace commit helper packaging requires Windows x64 or arm64')
      }
      packagingSource = await captureCleanPackageSource(process.cwd())
      packagingEdition = parsePackageEdition(process.env.ARKDOWN_PACKAGE_EDITION)
      if (arch !== 'x64') throw new Error('Screen translation runtime currently requires a Windows x64 package')
      await buildScreenTranslation({ repoRoot: process.cwd() })
      applicationUpdater = await buildApplicationUpdater(process.cwd())
      process.env[APPLICATION_UPDATER_TRUST_ENV] = JSON.stringify(applicationUpdater.trust)
      if (arch === 'x64') await buildStickyNoteNativeSurface({ architecture: arch })
      workspaceCommitArtifact = await buildWorkspaceCommitHelper({ repoRoot: process.cwd(), arch })
      process.env[WORKSPACE_COMMIT_HELPER_TRUST_ENV] = JSON.stringify(
        workspaceCommitHelperTrustRecord(workspaceCommitArtifact),
      )
    },
    postPackage: async (_forgeConfig, packageResult) => {
      if (!packagingSource) throw new Error('Package source identity was not captured before packaging')
      if (!workspaceCommitArtifact) throw new Error('Workspace commit helper was not built before packaging')
      if (!packagingEdition) throw new Error('Package edition was not captured before packaging')
      if (!applicationUpdater) throw new Error('Application updater was not built before packaging')
      const updater = applicationUpdater
      const edition = packagingEdition
      const source = packagingSource
      const helperArtifact = workspaceCommitArtifact
      if (packageResult.platform !== 'win32' || packageResult.arch !== helperArtifact.arch) {
        throw new Error('Workspace commit helper architecture does not match the package')
      }
      packagingSource = undefined
      workspaceCommitArtifact = undefined
      packagingEdition = undefined
      applicationUpdater = undefined
      delete process.env[APPLICATION_UPDATER_TRUST_ENV]
      delete process.env[WORKSPACE_COMMIT_HELPER_TRUST_ENV]
      const currentSource = await captureCleanPackageSource(process.cwd())
      if (
        currentSource.commit !== source.commit
        || currentSource.tree !== source.tree
      ) throw new Error('Package source identity changed while packaging')
      await Promise.all([
        ...packageResult.outputPaths.map((outputPath) => copyFile(
          path.resolve('THIRD_PARTY_NOTICES.md'), path.join(outputPath, 'THIRD_PARTY_NOTICES.md'),
        )),
        ...(packageResult.arch === 'x64' ? [copyStickyNoteNativeSurface(packageResult.outputPaths)] : []),
        copyBrandingToPackages(packageResult.outputPaths),
        copyArknoteExecutable(packageResult.outputPaths),
        copyUserGuideToPackages(packageResult.outputPaths),
        copyInitialWorkspaceToPackages(packageResult.outputPaths),
        copyScreenshotTranslationBridges(packageResult.outputPaths),
        copyScreenTranslationToPackages(packageResult.outputPaths),
        copyWorkspaceCommitHelperToPackages(packageResult.outputPaths, helperArtifact),
        packageApplicationUpdater(packageResult.outputPaths, updater),
      ])
      for (const outputPath of packageResult.outputPaths) await packageEditionResources(outputPath, edition)
      await writePackageProvenance(packageResult.outputPaths, source)
      for (const outputPath of packageResult.outputPaths) await writeUpdateManagedManifest(outputPath, packageMetadata.version, edition)
    },
  },
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/main.ts', config: 'vite.main.config.ts' },
        { entry: 'src/main/shell-integration/registry-worker.ts', config: 'vite.main.config.ts' },
        { entry: 'src/main/screenshot-translation/screenshot-ocr-validation-worker.ts', config: 'vite.main.config.ts' },
        { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts' },
        { entry: 'src/preload/screen-translation-preload.ts', config: 'vite.preload.config.ts' },
        { entry: 'src/preload/runtime-installer-preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
}

export default config
