import type { DocxImportOptions, DocxService } from './docx-service'

export type DocxOperations = Pick<DocxService, 'import' | 'importText' | 'exportDocx' | 'canReuseTarget'>

export function bindDocxOwner(service: DocxOperations, getSignal: () => AbortSignal): DocxOperations {
  const optionsFor = (options: DocxImportOptions = {}): DocxImportOptions => ({
    ...options,
    signal: options.signal ? AbortSignal.any([getSignal(), options.signal]) : getSignal(),
  })
  return {
    import: (source, options) => service.import(source, optionsFor(options)),
    importText: (source, options) => service.importText(source, optionsFor(options)),
    exportDocx: (markdown, target, options) => service.exportDocx(markdown, target, optionsFor(options)),
    canReuseTarget: target => service.canReuseTarget(target),
  }
}
