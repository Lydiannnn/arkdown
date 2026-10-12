import type { DocumentConversionComponentDescriptor } from './document-conversion'

export const DOCUMENT_CONVERSION_COMPONENT_TREE_SHA256 =
  'f3a1dc705f8c76a5fab3d06c9b945ae43a826faab8ae5039759b0f200b979028'

export const DOCUMENT_CONVERSION_COMPONENT_RELEASE_BASE_URL =
  'https://github.com/Lydiannnn/arkdown-releases/releases/download/markitdown-0.1.7-py3.12.10/'

export const DOCUMENT_CONVERSION_COMPONENT_MANIFEST: DocumentConversionComponentDescriptor = Object.freeze({
  source: 'https',
  version: '0.1.7-py3.12.10',
  archiveName: 'arkdown-markitdown-0.1.7-py3.12.10-win-x64.tar.gz',
  bytes: 75_859_983,
  sha256: 'd375e42d98cdecdce653b35f2e94a97a0844cf872da0b1fb629eff9c5bd2edec',
  url: `${DOCUMENT_CONVERSION_COMPONENT_RELEASE_BASE_URL}arkdown-markitdown-0.1.7-py3.12.10-win-x64.tar.gz`,
})
