import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_TYPES,
  documentTextKindForPath,
  isCodeDocumentPath,
  isAiWorkspaceDocumentPath,
  documentTypeForPath,
  isEditableDocumentPath,
  isPandocImportPath,
  isInsertableAssetPath,
  isMarkItDownConversionPath,
  isVisibleWorkspacePath,
} from '../../src/shared/document-types'

describe('document type registry', () => {
  it.each([
    'a.md',
    'a.MARKDOWN',
    'a.mmd',
    'a.mkd',
    'a.mdwn',
    'a.mdown',
    'a.mdx',
  ])('classifies %s as a Markdown document', (name) => {
    expect(documentTypeForPath(name)).toMatchObject({
      category: 'document',
      openAsDocument: true,
      showInTree: true,
    })
  })

  it.each([
    'a.mdtxt',
    'a.mdtext',
    'a.apib',
    'a.rmarkdown',
    'a.rmd',
    'a.qmd',
    'a.txt',
    'a.text',
  ])('classifies %s as an editable text document', (name) => {
    expect(isEditableDocumentPath(name)).toBe(true)
  })

  it('registers DOCX as a visible Pandoc import without treating it as editable text', () => {
    expect(documentTypeForPath('report.DOCX')).toMatchObject({
      category: 'document',
      showInTree: true,
      openAsDocument: false,
      importWithPandoc: true,
      insertInEditor: false,
    })
    expect(isPandocImportPath('report.docx')).toBe(true)
    expect(isVisibleWorkspacePath('report.docx')).toBe(true)
  })

  it.each([
    ['a.png', 'image', 'markdown-image'],
    ['a.avif', 'image', 'markdown-image'],
    ['a.mp3', 'audio', 'html-audio'],
    ['a.mp4', 'video', 'html-video'],
    ['a.pdf', 'pdf', 'markdown-link'],
  ] as const)('classifies %s as insertable %s', (name, category, serialization) => {
    expect(documentTypeForPath(name)).toMatchObject({
      category,
      insertInEditor: true,
      openAsDocument: false,
      serialization,
    })
    expect(isInsertableAssetPath(name)).toBe(true)
    expect(isEditableDocumentPath(name)).toBe(false)
  })

  it('registers PDF and XLSX for conversion without changing their drag categories', () => {
    expect(documentTypeForPath('paper.PDF')).toMatchObject({
      category: 'pdf',
      showInTree: true,
      convertWithMarkItDown: true,
      insertInEditor: true,
      serialization: 'markdown-link',
    })
    expect(documentTypeForPath('table.XLSX')).toMatchObject({
      category: 'attachment',
      showInTree: true,
      convertWithMarkItDown: true,
      insertInEditor: true,
      serialization: 'markdown-link',
    })
  })

  it('registers PPTX and EPUB for conversion with the existing path-link fallback', () => {
    expect(documentTypeForPath('slides.pptx')).toMatchObject({
      category: 'attachment',
      showInTree: true,
      convertWithMarkItDown: true,
      insertInEditor: false,
      serialization: 'markdown-link',
    })
    expect(documentTypeForPath('book.epub')).toMatchObject({
      category: 'attachment',
      showInTree: true,
      convertWithMarkItDown: true,
      insertInEditor: false,
      serialization: 'markdown-link',
    })
  })

  it.each(['paper.pdf', 'slides.pptx', 'table.xlsx', 'book.epub'])(
    'recognizes %s as a MarkItDown conversion path',
    (pathname) => expect(isMarkItDownConversionPath(pathname)).toBe(true),
  )

  it.each(['notes.md', 'report.docx', 'image.png', 'unknown.bin'])(
    'does not route %s to MarkItDown',
    (pathname) => expect(isMarkItDownConversionPath(pathname)).toBe(false),
  )

  it.each(['a.exe', 'README', 'a.dll', 'a.zip', 'a.rar', 'a.db', 'a.pyc', 'a.class', 'a.ipynb'])(
    'rejects unsupported %s',
    (name) => expect(documentTypeForPath(name)).toBeNull(),
  )

  it.each(('js mjs cjs jsx ts tsx mts cts json jsonc json5 yaml yml toml ini conf cfg properties xml html htm css scss sass less vue svelte astro svg py pyi r sql c h cc cpp cxx hpp cs java kt kts go rs swift dart rb php lua sh bash zsh fish ps1 psm1 psd1 bat cmd cmake csv tsv log diff patch graphql gql proto tex').split(' '))(
    'supports %s as code without extending AI document access', (extension) => {
      const name = `C:/project/file.${extension.toUpperCase()}`
      expect(documentTextKindForPath(name)).toBe('code')
      expect(isCodeDocumentPath(name)).toBe(true)
      expect(isEditableDocumentPath(name)).toBe(true)
      expect(isAiWorkspaceDocumentPath(name)).toBe(false)
    },
  )

  it.each(['Dockerfile', 'Makefile', 'CMakeLists.txt', '.gitignore', '.gitattributes', '.editorconfig', '.env', '.env.local'])(
    'supports special source filename %s', (name) => {
      expect(documentTextKindForPath(`folder/${name}`)).toBe('code')
      expect(isVisibleWorkspacePath(name)).toBe(true)
      expect(isAiWorkspaceDocumentPath(name)).toBe(false)
    },
  )

  it('keeps legacy text and SVG asset capabilities separate', () => {
    expect(documentTextKindForPath('a.md')).toBe('markdown')
    expect(documentTextKindForPath('a.rmd')).toBe('markdown')
    expect(documentTextKindForPath('a.txt')).toBe('text')
    expect(isAiWorkspaceDocumentPath('a.txt')).toBe(true)
    expect(documentTextKindForPath('unknown')).toBeNull()
    expect(documentTypeForPath('a.svg')).toMatchObject({ category: 'image', openAsDocument: false, insertInEditor: true, serialization: 'markdown-image' })
  })

  it('uses one unique normalized entry per extension', () => {
    const extensions = DOCUMENT_TYPES.map((entry) => entry.extension)
    expect(new Set(extensions).size).toBe(extensions.length)
    expect(extensions.every((extension) => extension === extension.toLocaleLowerCase('en-US')))
      .toBe(true)
  })
})
