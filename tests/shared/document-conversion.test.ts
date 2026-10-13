import { describe, expect, it } from 'vitest'
import {
  MAX_DOCUMENT_CONVERSION_INPUT_BYTES,
  MAX_DOCUMENT_CONVERSION_OUTPUT_BYTES,
  documentConversionTimeoutMs,
  parseConvertedDocument,
  parseDocumentConversionComponentDescriptor,
  parseDocumentConversionComponentState,
} from '../../src/shared/document-conversion'
import { DOCUMENT_CONVERSION_COMPONENT_MANIFEST } from '../../src/shared/document-conversion-component-manifest'

const SHA256 = 'd375e42d98cdecdce653b35f2e94a97a0844cf872da0b1fb629eff9c5bd2edec'

const descriptor = (overrides: Record<string, unknown> = {}) => ({
  source: 'packaged',
  version: '0.1.7-py3.12.10',
  archiveName: 'arkdown-markitdown-0.1.7-py3.12.10-win-x64.tar.gz',
  bytes: 75_859_983,
  sha256: SHA256,
  url: null,
  ...overrides,
})

const state = (overrides: Record<string, unknown> = {}) => ({
  revision: 0,
  source: 'packaged',
  status: 'absent',
  installedVersion: null,
  availableVersion: '0.1.7-py3.12.10',
  progress: null,
  errorCode: null,
  busy: false,
  ...overrides,
})

const convertedDocument = (overrides: Record<string, unknown> = {}) => ({
  source: {
    absolutePath: 'C:\\workspace\\report.pdf',
    fileName: 'report.pdf',
    format: 'pdf',
    bytes: 42,
    modifiedAtMs: 1_725_000_000_000,
  },
  markdown: '# Report',
  converterVersion: '0.1.7-py3.12.10',
  fingerprint: SHA256,
  warnings: ['图片未提取'],
  ...overrides,
})

describe('document conversion component descriptor', () => {
  it('publishes the exact approved Tencent COS component manifest', () => {
    expect(DOCUMENT_CONVERSION_COMPONENT_MANIFEST).toEqual(descriptor({
      source: 'https',
      url: 'https://arkdown-downloads-1257382433.cos.ap-guangzhou.myqcloud.com/components/markitdown-0.1.7-py3.12.10/arkdown-markitdown-0.1.7-py3.12.10-win-x64.tar.gz',
    }))
  })

  it('accepts exact packaged and HTTPS descriptors', () => {
    expect(parseDocumentConversionComponentDescriptor(descriptor())).toEqual(descriptor())
    const https = descriptor({
      source: 'https',
      url: 'https://downloads.example.test/arkdown-markitdown.tar.gz',
    })
    expect(parseDocumentConversionComponentDescriptor(https)).toEqual(https)
  })

  it('rejects non-exact, unsafe, uppercase-hash, and source-contradictory descriptors', () => {
    const inherited = Object.create(descriptor())
    const invalid = [
      { ...descriptor(), extra: 'C:\\private\\component' },
      (() => { const { url: _missing, ...missing } = descriptor(); return missing })(),
      descriptor({ bytes: 0 }),
      descriptor({ bytes: Number.MAX_SAFE_INTEGER + 1 }),
      descriptor({ sha256: SHA256.toUpperCase() }),
      descriptor({ source: 'ftp' }),
      descriptor({ source: 'packaged', url: 'https://downloads.example.test/component.tar.gz' }),
      descriptor({ source: 'https', url: null }),
      descriptor({ source: 'https', url: 'http://downloads.example.test/component.tar.gz' }),
      inherited,
    ]

    for (const candidate of invalid) {
      expect(parseDocumentConversionComponentDescriptor(candidate)).toBeUndefined()
    }
  })
})

describe('document conversion component state', () => {
  it('accepts every valid status shape for packaged and HTTPS sources', () => {
    const variants = [
      state(),
      state({ status: 'installing', progress: { phase: 'reading', receivedBytes: 4, totalBytes: 10 }, busy: true }),
      state({ status: 'installed', installedVersion: '0.1.7-py3.12.10' }),
      state({ status: 'installed', installedVersion: '0.1.7-py3.12.10', busy: true }),
      state({ status: 'update-available', installedVersion: '0.1.6-py3.12.10' }),
      state({ status: 'update-available', installedVersion: '0.1.6-py3.12.10', busy: true }),
      state({ status: 'failed', errorCode: 'DOCUMENT_CONVERSION_INSTALL_FAILED' }),
    ]

    for (const source of ['packaged', 'https']) {
      for (const candidate of variants) {
        const expected = { ...candidate, source }
        expect(parseDocumentConversionComponentState(expected)).toEqual(expected)
      }
    }
  })

  it.each(['reading', 'downloading', 'verifying', 'extracting'])(
    'accepts %s install progress',
    (phase) => {
      const candidate = state({
        status: 'installing',
        progress: { phase, receivedBytes: 0, totalBytes: 10 },
        busy: true,
      })
      expect(parseDocumentConversionComponentState(candidate)).toEqual(candidate)
    },
  )

  it('rejects extra keys, unsafe progress, unknown values, and contradictory states', () => {
    const installing = state({
      status: 'installing',
      progress: { phase: 'reading', receivedBytes: 4, totalBytes: 10 },
      busy: true,
    })
    const invalid = [
      (() => { const { revision: _missing, ...missing } = state(); return missing })(),
      { ...state(), extra: true },
      state({ revision: -1 }),
      state({ revision: 0.5 }),
      state({ revision: Number.MAX_SAFE_INTEGER + 1 }),
      { ...state(), source: 'local' },
      { ...state(), status: 'unknown' },
      { ...state(), availableVersion: '' },
      { ...installing, progress: { phase: 'reading', receivedBytes: -1, totalBytes: 10 } },
      { ...installing, progress: { phase: 'reading', receivedBytes: 11, totalBytes: 10 } },
      { ...installing, progress: { phase: 'reading', receivedBytes: 0.5, totalBytes: 10 } },
      { ...installing, progress: { phase: 'reading', receivedBytes: 1, totalBytes: Number.MAX_SAFE_INTEGER + 1 } },
      { ...installing, progress: { phase: 'copying', receivedBytes: 1, totalBytes: 10 } },
      state({ busy: true }),
      state({ status: 'installing', progress: null, busy: true }),
      state({ status: 'installing', progress: { phase: 'reading', receivedBytes: 1, totalBytes: 10 }, busy: false }),
      state({ status: 'installed', installedVersion: null }),
      state({ status: 'installed', installedVersion: '0.1.6-py3.12.10' }),
      state({ status: 'update-available', installedVersion: null }),
      state({ status: 'update-available', installedVersion: '0.1.7-py3.12.10' }),
      state({ status: 'failed', errorCode: null }),
      state({ status: 'failed', errorCode: 'OPERATION_FAILED', busy: true }),
      state({ errorCode: 'DOCUMENT_CONVERSION_FAILED' }),
      Object.create(state()),
    ]

    for (const candidate of invalid) {
      expect(parseDocumentConversionComponentState(candidate)).toBeUndefined()
    }
  })
})

describe('converted document contract', () => {
  it.each(['pdf', 'pptx', 'xlsx', 'epub'])(
    'accepts an exact converted %s document',
    (format) => {
      const fileName = `report.${format}`
      const candidate = convertedDocument({
        source: {
          ...convertedDocument().source,
          absolutePath: `C:\\workspace\\${fileName}`,
          fileName,
          format,
        },
      })
      expect(parseConvertedDocument(candidate)).toEqual(candidate)
    },
  )

  it('rejects extra keys, unsafe numbers, uppercase fingerprints, and unknown formats', () => {
    const invalid = [
      { ...convertedDocument(), extra: true },
      convertedDocument({ source: { ...convertedDocument().source, extra: true } }),
      convertedDocument({ source: { ...convertedDocument().source, format: 'docx' } }),
      convertedDocument({ source: { ...convertedDocument().source, bytes: -1 } }),
      convertedDocument({ source: { ...convertedDocument().source, bytes: Number.MAX_SAFE_INTEGER + 1 } }),
      convertedDocument({ source: { ...convertedDocument().source, modifiedAtMs: 0.5 } }),
      convertedDocument({ fingerprint: SHA256.toUpperCase() }),
      convertedDocument({ warnings: ['valid', 42] }),
      Object.create(convertedDocument()),
    ]

    for (const candidate of invalid) expect(parseConvertedDocument(candidate)).toBeUndefined()
  })

  it.each([
    ['an HTTPS URL', {
      ...convertedDocument().source,
      absolutePath: 'https://documents.example.test/report.pdf',
    }],
    ['a relative path', {
      ...convertedDocument().source,
      absolutePath: 'report.pdf',
    }],
    ['a format that contradicts the file extension', {
      ...convertedDocument().source,
      absolutePath: 'C:\\workspace\\report.txt',
      fileName: 'report.txt',
    }],
    ['a file name that contradicts the path basename', {
      ...convertedDocument().source,
      fileName: 'renamed.pdf',
    }],
  ])('rejects converted source metadata with %s', (_description, source) => {
    expect(parseConvertedDocument(convertedDocument({ source }))).toBeUndefined()
  })

  it.each((() => {
    const warningsWithExtraProperty = ['valid'] as string[] & { extra?: boolean }
    warningsWithExtraProperty.extra = true
    const warningsWithTamperedEvery = ['valid']
    Object.defineProperty(warningsWithTamperedEvery, 'every', { value: null })
    return [
      ['a sparse slot', new Array<string>(1)],
      ['an extra property', warningsWithExtraProperty],
      ['a tampered every method', warningsWithTamperedEvery],
    ]
  })())('rejects warnings arrays with %s without throwing', (_description, warnings) => {
    let result: ReturnType<typeof parseConvertedDocument>
    expect(() => {
      result = parseConvertedDocument(convertedDocument({ warnings }))
    }).not.toThrow()
    expect(result).toBeUndefined()
  })

  it('exports input/output limits and the per-format conversion timeout', () => {
    expect(MAX_DOCUMENT_CONVERSION_INPUT_BYTES).toBe(256 * 1024 * 1024)
    expect(MAX_DOCUMENT_CONVERSION_OUTPUT_BYTES).toBe(32 * 1024 * 1024)
    expect(documentConversionTimeoutMs('xlsx')).toBe(300_000)
    expect(documentConversionTimeoutMs('pdf')).toBe(120_000)
    expect(documentConversionTimeoutMs('pptx')).toBe(120_000)
    expect(documentConversionTimeoutMs('epub')).toBe(120_000)
  })
})
