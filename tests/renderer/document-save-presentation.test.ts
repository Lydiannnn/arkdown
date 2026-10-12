import { describe, expect, it } from 'vitest'
import { deriveDocumentSavePresentation } from '../../src/renderer/editor/document-save-presentation'

describe('deriveDocumentSavePresentation', () => {
  it.each([
    { dirty: false, hasSavedThisOpen: false, expected: 'pristine' },
    { dirty: true, hasSavedThisOpen: false, expected: 'dirty' },
    { dirty: false, hasSavedThisOpen: true, expected: 'saved' },
    { dirty: true, hasSavedThisOpen: true, expected: 'dirty' },
  ] as const)('returns $expected for dirty=$dirty and saved=$hasSavedThisOpen', (input) => {
    expect(deriveDocumentSavePresentation(input)).toBe(input.expected)
  })
})
