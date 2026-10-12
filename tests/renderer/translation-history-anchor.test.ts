import { Schema } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { describe, expect, it } from 'vitest'
import {
  createVisualTranslationHistoryAnchor,
  mapVisualTranslationHistoryAnchor,
  matchesVisualTranslationAnchorFingerprint,
} from '../../src/renderer/editor/translation-history-anchor'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0] },
    text: {},
  },
})

function stateFor(text: string): EditorState {
  return EditorState.create({
    doc: schema.node('doc', null, schema.node('paragraph', null, schema.text(text))),
  })
}

describe('visual translation history anchors', () => {
  it('maps an insertion before the selection and keeps the anchor valid', () => {
    const state = stateFor('before selected after')
    const anchor = createVisualTranslationHistoryAnchor(state.doc, 8, 16)
    const transaction = state.tr.insertText('new ', 1)

    const mapped = mapVisualTranslationHistoryAnchor(anchor, transaction)

    expect(mapped).toMatchObject({ from: 12, to: 20, blockStart: 0, status: 'valid' })
    expect(mapped.fingerprint.selected).toBe('selected')
    expect(matchesVisualTranslationAnchorFingerprint(transaction.doc, mapped)).toBe(true)
  })

  it('does not move an anchor when text is inserted after it', () => {
    const state = stateFor('before selected after')
    const anchor = createVisualTranslationHistoryAnchor(state.doc, 8, 16)
    const transaction = state.tr.insertText(' later', 17)

    expect(mapVisualTranslationHistoryAnchor(anchor, transaction)).toMatchObject({
      from: 8,
      to: 16,
      blockStart: 0,
      status: 'valid',
    })
  })

  it('marks an anchor location-changed when a deletion crosses the selection', () => {
    const state = stateFor('before selected after')
    const anchor = createVisualTranslationHistoryAnchor(state.doc, 8, 16)
    const transaction = state.tr.delete(10, 18)

    expect(mapVisualTranslationHistoryAnchor(anchor, transaction).status).toBe('location-changed')
  })

  it('requires an exact bounded fingerprint match', () => {
    const state = stateFor('before selected after')
    const anchor = createVisualTranslationHistoryAnchor(state.doc, 8, 16)
    const mismatched = {
      ...anchor,
      fingerprint: { ...anchor.fingerprint, after: 'different' },
    }

    expect(matchesVisualTranslationAnchorFingerprint(state.doc, anchor)).toBe(true)
    expect(matchesVisualTranslationAnchorFingerprint(state.doc, mismatched)).toBe(false)
  })

  it('permanently invalidates an initial fingerprint mismatch before mapping an unrelated edit', () => {
    const state = stateFor(`before selected ${'x'.repeat(80)}`)
    const anchor = createVisualTranslationHistoryAnchor(state.doc, 8, 16)
    const mismatched = {
      ...anchor,
      fingerprint: { ...anchor.fingerprint, selected: 'persisted mismatch' },
    }
    const transaction = state.tr.insertText('!', state.doc.content.size - 1)

    const mapped = mapVisualTranslationHistoryAnchor(mismatched, transaction)

    expect(mapped.status).toBe('location-changed')
    expect(mapped.fingerprint.selected).toBe('persisted mismatch')
    expect(matchesVisualTranslationAnchorFingerprint(transaction.doc, mapped)).toBe(false)
  })
})
