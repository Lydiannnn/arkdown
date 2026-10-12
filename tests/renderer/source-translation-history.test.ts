import { defaultKeymap } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranslationHistoryRecord } from '../../src/renderer/editor/translation-history'
import {
  TRANSLATION_HISTORY_ANCHOR_ATTRIBUTE,
  TRANSLATION_HISTORY_HIGHLIGHT_CLASS,
} from '../../src/renderer/editor/translation-history-marker'
import {
  bindPendingSourceTranslationAnchor,
  capturePendingSourceTranslationAnchor,
  configureSourceTranslationHistoryView,
  createSourceTranslationHistoryAnchor,
  discardPendingSourceTranslationAnchor,
  flushSourceTranslationHistoryAnchors,
  promotePendingSourceTranslationAnchor,
  revealSourceTranslationHistoryRecord,
  sourceTranslationHistoryExtension,
  sourceTranslationHistoryStateField,
  syncSourceTranslationHistoryRecords,
} from '../../src/renderer/editor/source-translation-history'

function sourceRecord(
  id: string,
  createdAt: number,
  document = 'before selected after',
  from = 7,
  to = 15,
): TranslationHistoryRecord {
  const state = EditorState.create({ doc: document })
  return {
    id,
    requestId: `request-${id}`,
    documentKey: 'doc-a',
    workspaceAbsolutePath: null,
    documentRelativePath: null,
    documentAbsolutePath: null,
    documentRevision: null,
    mode: 'source',
    source: { markdown: document.slice(from, to), plainText: document.slice(from, to) },
    translatedMarkdown: `translated ${id}`,
    modelId: 'model',
    targetLanguage: 'en',
    terminal: 'completed',
    createdAt,
    anchor: createSourceTranslationHistoryAnchor(state.doc, from, to),
  }
}

function createView(
  records: readonly TranslationHistoryRecord[] = [],
  callbacks: Parameters<typeof configureSourceTranslationHistoryView>[1] = {},
  document = 'before selected after',
): EditorView {
  const mount = documentBody().appendChild(globalThis.document.createElement('div'))
  const state = EditorState.create({
    doc: document,
    extensions: [keymap.of(defaultKeymap), sourceTranslationHistoryExtension],
  })
  const view = new EditorView({ state, parent: mount })
  configureSourceTranslationHistoryView(view, callbacks)
  syncSourceTranslationHistoryRecords(view, records)
  return view
}

function documentBody(): HTMLElement {
  return globalThis.document.body
}

afterEach(() => {
  documentBody().replaceChildren()
  vi.restoreAllMocks()
})

describe('source translation history anchors', () => {
  it('safely ignores a view without the history state field', () => {
    const viewWithoutField = {
      state: {},
      dispatch: vi.fn(),
    } as unknown as EditorView

    expect(() => configureSourceTranslationHistoryView(viewWithoutField, {})).not.toThrow()
    expect(viewWithoutField.dispatch).not.toHaveBeenCalled()
  })

  it('exposes an unexpected source state-field failure', () => {
    const failure = new Error('source history field failed')
    const brokenView = {
      state: { field: () => { throw failure } },
      dispatch: vi.fn(),
    } as unknown as EditorView

    expect(() => configureSourceTranslationHistoryView(brokenView, {})).toThrow(failure)
  })

  it('maps insertion before the exact source range and emits the update', () => {
    const onAnchorsChanged = vi.fn()
    const view = createView([sourceRecord('one', 1)], { onAnchorsChanged })

    view.dispatch({ changes: { from: 0, insert: 'new ' } })

    expect(view.state.field(sourceTranslationHistoryStateField)).toBeDefined()
    expect(flushSourceTranslationHistoryAnchors(view)).toEqual([
      expect.objectContaining({
        recordId: 'one',
        anchor: expect.objectContaining({ from: 11, to: 19, lineStart: 0, status: 'valid' }),
      }),
    ])
    expect(onAnchorsChanged).toHaveBeenCalledWith([
      expect.objectContaining({
        recordId: 'one',
        anchor: expect.objectContaining({ from: 11, to: 19, status: 'valid' }),
      }),
    ])
    view.destroy()
  })

  it('does not move the source range for insertion after it', () => {
    const view = createView([sourceRecord('one', 1)])

    view.dispatch({ changes: { from: 16, insert: ' later' } })

    expect(flushSourceTranslationHistoryAnchors(view)).toEqual([
      expect.objectContaining({
        recordId: 'one',
        anchor: expect.objectContaining({ from: 7, to: 15, status: 'valid' }),
      }),
    ])
    expect(revealSourceTranslationHistoryRecord(view, 'one')).toBe(true)
    expect(view.state.selection.main).toMatchObject({ from: 7, to: 15 })
    view.destroy()
  })

  it('invalidates a source range when a deletion crosses it', () => {
    const view = createView([sourceRecord('one', 1)])

    view.dispatch({ changes: { from: 9, to: 17 } })

    expect(flushSourceTranslationHistoryAnchors(view)).toEqual([
      expect.objectContaining({
        recordId: 'one',
        anchor: expect.objectContaining({ status: 'location-changed' }),
      }),
    ])
    view.destroy()
  })

  it('keeps same-line records as separate exact highlights and zero-width anchors', () => {
    const view = createView([
      sourceRecord('one', Date.UTC(2026, 0, 1)),
      sourceRecord('two', Date.UTC(2026, 0, 2)),
    ])

    expect(view.dom.querySelectorAll(`.${TRANSLATION_HISTORY_HIGHLIGHT_CLASS}`)).toHaveLength(2)
    expect(view.dom.querySelectorAll(`[${TRANSLATION_HISTORY_ANCHOR_ATTRIBUTE}]`)).toHaveLength(2)
    expect(view.dom.querySelector(`[${TRANSLATION_HISTORY_ANCHOR_ATTRIBUTE}="one"]`)).toBeTruthy()
    expect(view.dom.querySelector(`[${TRANSLATION_HISTORY_ANCHOR_ATTRIBUTE}="two"]`)).toBeTruthy()
    expect(view.dom.querySelector('.translation-history-marker-button')).toBeNull()
    view.destroy()
  })

  it('creates neither a highlight nor an anchor for a location-changed record', () => {
    const invalid = sourceRecord('invalid', 1)
    invalid.anchor = { ...invalid.anchor, status: 'location-changed' }
    const view = createView([invalid])

    expect(view.dom.querySelector(`.${TRANSLATION_HISTORY_HIGHLIGHT_CLASS}`)).toBeNull()
    expect(view.dom.querySelector(`[${TRANSLATION_HISTORY_ANCHOR_ATTRIBUTE}]`)).toBeNull()
    expect(view.dom.querySelector('.source-translation-history-widget')).toBeNull()
    view.destroy()
  })

  it('captures, maps, binds, and promotes a pending source anchor during edits', () => {
    const view = createView()
    view.dispatch({ selection: { anchor: 7, head: 15 } })

    expect(capturePendingSourceTranslationAnchor(view, 'pending-1')).toBe(true)
    view.dispatch({ changes: { from: 0, insert: 'new ' } })
    bindPendingSourceTranslationAnchor(view, 'pending-1', 'request-1')

    expect(promotePendingSourceTranslationAnchor(view, 'request-1')).toMatchObject({
      mode: 'source',
      from: 11,
      to: 19,
      lineStart: 0,
      status: 'valid',
    })
    expect(promotePendingSourceTranslationAnchor(view, 'request-1')).toBeNull()
    view.destroy()
  })

  it('fails closed and clears ambiguous duplicate request anchors', () => {
    const view = createView()
    view.dispatch({ selection: { anchor: 7, head: 15 } })
    capturePendingSourceTranslationAnchor(view, 'pending-a')
    bindPendingSourceTranslationAnchor(view, 'pending-a', 'request-duplicate')
    view.dispatch({ selection: { anchor: 8, head: 16 } })
    capturePendingSourceTranslationAnchor(view, 'pending-b')
    bindPendingSourceTranslationAnchor(view, 'pending-b', 'request-duplicate')
    view.dispatch({ selection: { anchor: 9, head: 17 } })
    capturePendingSourceTranslationAnchor(view, 'pending-c')
    bindPendingSourceTranslationAnchor(view, 'pending-c', 'request-unique')

    expect(promotePendingSourceTranslationAnchor(view, 'request-duplicate')).toBeNull()
    expect(promotePendingSourceTranslationAnchor(view, 'request-duplicate')).toBeNull()
    expect(promotePendingSourceTranslationAnchor(view, 'request-unique')).toMatchObject({
      from: 9,
      to: 17,
    })
    view.destroy()
  })

  it('promotes location-changed after deleting through a pending source anchor', () => {
    const view = createView()
    view.dispatch({ selection: { anchor: 7, head: 15 } })
    capturePendingSourceTranslationAnchor(view, 'pending-delete')
    bindPendingSourceTranslationAnchor(view, 'pending-delete', 'request-delete')

    view.dispatch({ changes: { from: 9, to: 17 } })

    expect(promotePendingSourceTranslationAnchor(view, 'request-delete')?.status)
      .toBe('location-changed')
    view.destroy()
  })

  it('discards a pending source anchor by pending key', () => {
    const view = createView()
    view.dispatch({ selection: { anchor: 7, head: 15 } })
    capturePendingSourceTranslationAnchor(view, 'pending-discard')
    bindPendingSourceTranslationAnchor(view, 'pending-discard', 'request-discard')

    discardPendingSourceTranslationAnchor(view, 'pending-discard')

    expect(promotePendingSourceTranslationAnchor(view, 'request-discard')).toBeNull()
    view.destroy()
  })

  it('keeps pending anchors isolated between editor views', () => {
    const first = createView()
    const second = createView()
    first.dispatch({ selection: { anchor: 7, head: 15 } })

    capturePendingSourceTranslationAnchor(first, 'pending-first')
    bindPendingSourceTranslationAnchor(first, 'pending-first', 'request-first')

    expect(promotePendingSourceTranslationAnchor(second, 'request-first')).toBeNull()
    expect(promotePendingSourceTranslationAnchor(first, 'request-first')).not.toBeNull()
    first.destroy()
    second.destroy()
  })

  it('reveals the exact original source range and scrolls it into view', () => {
    const view = createView([sourceRecord('one', 1)])
    view.dispatch({ selection: { anchor: 0 } })
    const scrollIntoView = vi.spyOn(EditorView, 'scrollIntoView')

    expect(revealSourceTranslationHistoryRecord(view, 'one', 'center')).toBe(true)

    expect(view.state.selection.main).toMatchObject({ from: 7, to: 15 })
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ from: 7, to: 15 }),
      { y: 'center' },
    )
    expect(view.hasFocus).toBe(true)
    view.destroy()
  })

  it('does not change selection for missing, invalid, or fingerprint-mismatched anchors', () => {
    const valid = sourceRecord('valid', 1)
    const invalid = sourceRecord('invalid', 2)
    invalid.anchor = { ...invalid.anchor, status: 'location-changed' }
    const mismatch = sourceRecord('mismatch', 3)
    mismatch.anchor = {
      ...mismatch.anchor,
      fingerprint: { ...mismatch.anchor.fingerprint, selected: 'wrong' },
    }
    const view = createView([valid, invalid, mismatch])
    view.dispatch({ selection: { anchor: 2 } })
    const selection = view.state.selection

    expect(revealSourceTranslationHistoryRecord(view, 'missing')).toBe(false)
    expect(revealSourceTranslationHistoryRecord(view, 'invalid')).toBe(false)
    expect(revealSourceTranslationHistoryRecord(view, 'mismatch')).toBe(false)
    expect(view.state.selection.eq(selection)).toBe(true)
    view.destroy()
  })

  it.each([
    ['NaN endpoints', Number.NaN, Number.NaN, { before: '', selected: '', after: '' }],
    [
      'fractional endpoints',
      7.5,
      15.5,
      createSourceTranslationHistoryAnchor(
        EditorState.create({ doc: 'before selected after' }).doc,
        7.5,
        15.5,
      ).fingerprint,
    ],
  ])('refuses to reveal an anchor with %s', (_label, from, to, fingerprint) => {
    const record = sourceRecord('unsafe-number', 1)
    record.anchor = {
      ...record.anchor,
      from,
      to,
      fingerprint,
    }
    const view = createView([record])
    const selection = view.state.selection
    const dispatch = vi.spyOn(view, 'dispatch')
    const focus = vi.spyOn(view, 'focus')

    expect(revealSourceTranslationHistoryRecord(view, record.id)).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(view.state.selection.eq(selection)).toBe(true)
    view.destroy()
  })

  it('refuses to reveal from a destroyed source view', () => {
    const view = createView([sourceRecord('one', 1)])
    const selection = view.state.selection
    view.destroy()

    expect(revealSourceTranslationHistoryRecord(view, 'one')).toBe(false)
    expect(view.state.selection.eq(selection)).toBe(true)
  })
})
