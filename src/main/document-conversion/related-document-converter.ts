import type { ConvertedDocument } from '../../shared/document-conversion'
import type { DocumentConversionService } from './document-conversion-service'

export class RelatedDocumentConverter {
  constructor(private readonly conversions: Pick<DocumentConversionService, 'convertLocal'>) {}

  convert(absolutePath: string, signal: AbortSignal): Promise<ConvertedDocument> {
    return this.conversions.convertLocal(absolutePath, signal)
  }
}
