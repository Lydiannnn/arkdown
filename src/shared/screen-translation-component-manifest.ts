import type { DocumentConversionComponentDescriptor } from './document-conversion'

export const SCREEN_TRANSLATION_COMPONENT_RELEASE_BASE_URL =
  'https://arkdown-downloads-1257382433.cos.ap-guangzhou.myqcloud.com/components/screen-translation-engine-1.0.0/'

export const SCREEN_TRANSLATION_COMPONENT_MANIFEST_URL =
  `${SCREEN_TRANSLATION_COMPONENT_RELEASE_BASE_URL}manifest.json`

export const SCREEN_TRANSLATION_COMPONENT_TREE_SHA256 =
  'b6c267858992f6fd72e67ed4865f5d22fb6a9c3fc32a9b71813407b3d1dd5cd2'

// Pinned to the verified standalone artifact; update only with a new verified release.
export const SCREEN_TRANSLATION_COMPONENT_DESCRIPTOR: DocumentConversionComponentDescriptor = Object.freeze({
  source: 'https',
  version: '1.0.0',
  archiveName: 'arkdown-screen-translation-engine-1.0.0-win-x64.tar.gz',
  bytes: 108_063_168,
  sha256: '7feff5127df97869e3752130251f58e25be6cd391b57bceeeffbc8f6196d65c7',
  url: `${SCREEN_TRANSLATION_COMPONENT_RELEASE_BASE_URL}arkdown-screen-translation-engine-1.0.0-win-x64.tar.gz`,
})
