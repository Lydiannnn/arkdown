import { createRuntimeComponentManager, type RuntimeComponentManager } from '../components/runtime-component-manager'
import type { DocumentConversionComponentDescriptor } from '../../shared/document-conversion'
import type { ComponentArtifactSource } from '../document-conversion/component-artifact-source'
import { SCREEN_TRANSLATION_COMPONENT_DESCRIPTOR, SCREEN_TRANSLATION_COMPONENT_TREE_SHA256 } from '../../shared/screen-translation-component-manifest'

export type ScreenTranslationComponentManager = RuntimeComponentManager
export interface ScreenTranslationComponentManagerOptions {
  dataRoot: string
  descriptor?: DocumentConversionComponentDescriptor
  artifactSource?: ComponentArtifactSource
  treeManifestSha256?: string
  bundledRoot?: string
  rename?(from: string, to: string): Promise<void>
}
export function createScreenTranslationComponentManager(options: ScreenTranslationComponentManagerOptions): Promise<ScreenTranslationComponentManager> {
  return createRuntimeComponentManager({
    ...options,
    definition: { id: 'screen-translation', label: '悬浮翻译引擎', entry: 'ArkTranslateEngine.exe',
      descriptor: options.descriptor ?? SCREEN_TRANSLATION_COMPONENT_DESCRIPTOR,
      treeManifestSha256: options.treeManifestSha256 ?? SCREEN_TRANSLATION_COMPONENT_TREE_SHA256 },
  }).catch(() => { throw new Error('悬浮翻译引擎校验失败，请重新下载安装') })
}
