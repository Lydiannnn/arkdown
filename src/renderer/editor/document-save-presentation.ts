export type DocumentSavePresentation = 'pristine' | 'dirty' | 'saved'

export function deriveDocumentSavePresentation(input: {
  dirty: boolean
  hasSavedThisOpen: boolean
}): DocumentSavePresentation {
  if (input.dirty) return 'dirty'
  return input.hasSavedThisOpen ? 'saved' : 'pristine'
}
