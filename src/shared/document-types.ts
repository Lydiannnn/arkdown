export type DocumentCategory =
  | 'document'
  | 'image'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'attachment'

export type AssetSerialization =
  | 'markdown-image'
  | 'html-audio'
  | 'html-video'
  | 'markdown-link'

export interface DocumentTypeDefinition {
  readonly extension: string
  readonly category: DocumentCategory
  readonly mime: string
  readonly showInTree: boolean
  readonly openAsDocument: boolean
  readonly importWithPandoc: boolean
  readonly convertWithMarkItDown: boolean
  readonly insertInEditor: boolean
  readonly serialization: AssetSerialization | null
}

function document(extension: string, mime = 'text/plain'): DocumentTypeDefinition {
  return {
    extension,
    category: 'document',
    mime,
    showInTree: true,
    openAsDocument: true,
    importWithPandoc: false,
    convertWithMarkItDown: false,
    insertInEditor: false,
    serialization: null,
  }
}

function importedDocument(extension: string, mime: string): DocumentTypeDefinition {
  return {
    extension,
    category: 'document',
    mime,
    showInTree: true,
    openAsDocument: false,
    importWithPandoc: true,
    convertWithMarkItDown: false,
    insertInEditor: false,
    serialization: null,
  }
}

function asset(
  extension: string,
  category: Exclude<DocumentCategory, 'document'>,
  mime: string,
  serialization: AssetSerialization,
): DocumentTypeDefinition {
  return {
    extension,
    category,
    mime,
    showInTree: false,
    openAsDocument: false,
    importWithPandoc: false,
    convertWithMarkItDown: false,
    insertInEditor: true,
    serialization,
  }
}

function convertibleAsset(
  extension: string,
  category: 'pdf' | 'attachment',
  mime: string,
  insertInEditor: boolean,
): DocumentTypeDefinition {
  return {
    extension,
    category,
    mime,
    showInTree: true,
    openAsDocument: false,
    importWithPandoc: false,
    convertWithMarkItDown: true,
    insertInEditor,
    serialization: 'markdown-link',
  }
}

const legacyDocumentExtensions = new Set('md markdown mmd mkd mdwn mdown mdx mdtxt mdtext apib rmarkdown rmd qmd txt text'.split(' '))
const codeExtensions = new Set('js mjs cjs jsx ts tsx mts cts json jsonc json5 yaml yml toml ini conf cfg properties xml html htm css scss sass less vue svelte astro svg py pyi r sql c h cc cpp cxx hpp cs java kt kts go rs swift dart rb php lua sh bash zsh fish ps1 psm1 psd1 bat cmd cmake csv tsv log diff patch graphql gql proto tex'.split(' '))
const codeFileNames = new Set(['dockerfile', 'makefile', 'cmakelists.txt', '.gitignore', '.gitattributes', '.editorconfig', '.env'])

function isSpecialCodeFileName(pathname: string): boolean {
  const name = (pathname.split(/[\\/]/).at(-1) ?? '').toLocaleLowerCase('en-US')
  return codeFileNames.has(name) || /^\.env\.[^.\\/].*$/u.test(name)
}

const definitions: DocumentTypeDefinition[] = [
  ...[...codeExtensions].filter(extension => extension !== 'svg').map(extension => document(extension)),
  ...['md', 'markdown', 'mmd', 'mkd', 'mdwn', 'mdown', 'mdx']
    .map((extension) => document(extension, 'text/markdown')),
  ...['mdtxt', 'mdtext', 'apib', 'rmarkdown', 'rmd', 'qmd', 'txt', 'text']
    .map((extension) => document(extension)),
  importedDocument(
    'docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ),
  asset('png', 'image', 'image/png', 'markdown-image'),
  asset('jpg', 'image', 'image/jpeg', 'markdown-image'),
  asset('jpeg', 'image', 'image/jpeg', 'markdown-image'),
  asset('gif', 'image', 'image/gif', 'markdown-image'),
  asset('webp', 'image', 'image/webp', 'markdown-image'),
  asset('avif', 'image', 'image/avif', 'markdown-image'),
  asset('bmp', 'image', 'image/bmp', 'markdown-image'),
  asset('svg', 'image', 'image/svg+xml', 'markdown-image'),
  asset('mp3', 'audio', 'audio/mpeg', 'html-audio'),
  asset('wav', 'audio', 'audio/wav', 'html-audio'),
  asset('ogg', 'audio', 'audio/ogg', 'html-audio'),
  asset('m4a', 'audio', 'audio/mp4', 'html-audio'),
  asset('aac', 'audio', 'audio/aac', 'html-audio'),
  asset('flac', 'audio', 'audio/flac', 'html-audio'),
  asset('mp4', 'video', 'video/mp4', 'html-video'),
  asset('webm', 'video', 'video/webm', 'html-video'),
  asset('ogv', 'video', 'video/ogg', 'html-video'),
  asset('mov', 'video', 'video/quicktime', 'html-video'),
  asset('m4v', 'video', 'video/x-m4v', 'html-video'),
  convertibleAsset('pdf', 'pdf', 'application/pdf', true),
  convertibleAsset(
    'xlsx',
    'attachment',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    true,
  ),
  convertibleAsset(
    'pptx',
    'attachment',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    false,
  ),
  convertibleAsset(
    'epub',
    'attachment',
    'application/epub+zip',
    false,
  ),
]

export const DOCUMENT_TYPES: readonly DocumentTypeDefinition[] = Object.freeze(
  definitions.map((definition) => Object.freeze(definition)),
)

const typeByExtension = new Map(
  DOCUMENT_TYPES.map((definition) => [definition.extension, definition]),
)

function extensionOf(pathname: string): string {
  const name = pathname.split(/[\\/]/).at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLocaleLowerCase('en-US')
}

export function documentTypeForPath(pathname: string): DocumentTypeDefinition | null {
  if (isSpecialCodeFileName(pathname)) return document('')
  return typeByExtension.get(extensionOf(pathname)) ?? null
}

export function isEditableDocumentPath(pathname: string): boolean {
  return documentTextKindForPath(pathname) !== null
}

export function documentTextKindForPath(pathname: string): 'markdown' | 'text' | 'code' | null {
  if (isSpecialCodeFileName(pathname) || codeExtensions.has(extensionOf(pathname))) return 'code'
  const extension = extensionOf(pathname)
  if (!legacyDocumentExtensions.has(extension)) return null
  return extension === 'txt' || extension === 'text' ? 'text' : 'markdown'
}

export function isCodeDocumentPath(pathname: string): boolean {
  return documentTextKindForPath(pathname) === 'code'
}

// AI workspace grants deliberately retain the pre-code-document allowlist.
export function isAiWorkspaceDocumentPath(pathname: string): boolean {
  return !isSpecialCodeFileName(pathname) && legacyDocumentExtensions.has(extensionOf(pathname))
}

export function isPandocImportPath(pathname: string): boolean {
  return documentTypeForPath(pathname)?.importWithPandoc === true
}

export function isVisibleWorkspacePath(pathname: string): boolean {
  return documentTypeForPath(pathname)?.showInTree === true
}

export function isInsertableAssetPath(pathname: string): boolean {
  return documentTypeForPath(pathname)?.insertInEditor === true
}

export function isMarkItDownConversionPath(pathname: string): boolean {
  return documentTypeForPath(pathname)?.convertWithMarkItDown === true
}
