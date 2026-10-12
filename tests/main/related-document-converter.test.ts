import { describe, expect, it, vi } from 'vitest'
import { RelatedDocumentConverter } from '../../src/main/document-conversion/related-document-converter'
import type { ConvertedDocument } from '../../src/shared/document-conversion'

describe('RelatedDocumentConverter', () => {
  it('delegates the unchanged local path and cancellation signal to the main-process conversion service', async () => {
    const signal = new AbortController().signal
    const expected = { markdown: '# result' } as ConvertedDocument
    const convertLocal = vi.fn().mockResolvedValue(expected)
    const converter = new RelatedDocumentConverter({ convertLocal })

    await expect(converter.convert('C:\\docs\\source.pdf', signal)).resolves.toBe(expected)
    expect(convertLocal).toHaveBeenCalledOnce()
    expect(convertLocal).toHaveBeenCalledWith('C:\\docs\\source.pdf', signal)
  })

  it('preserves conversion failures without fallback, chunking, or model work', async () => {
    const failure = new DOMException('cancelled', 'AbortError')
    const converter = new RelatedDocumentConverter({ convertLocal: vi.fn().mockRejectedValue(failure) })
    await expect(converter.convert('C:\\docs\\source.xlsx', new AbortController().signal)).rejects.toBe(failure)
  })
})
