import type { DocumentConversionComponentDescriptor } from './document-conversion'
import type { ScreenTranslationComponentState } from './screen-translation-component'

export interface RuntimeComponentDefinition {
  id: string
  label: string
  entry: string
  descriptor: DocumentConversionComponentDescriptor
  treeManifestSha256: string
}

export type RuntimeComponentState = ScreenTranslationComponentState

export interface RuntimeInstallSnapshot {
  label: string
  state: RuntimeComponentState
}

export interface RuntimeInstallerApi {
  getState(): Promise<RuntimeInstallSnapshot>
  retry(): Promise<void>
  cancel(): Promise<void>
  subscribe(listener: (snapshot: RuntimeInstallSnapshot) => void): () => void
}
