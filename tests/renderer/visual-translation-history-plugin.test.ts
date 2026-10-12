import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { DecorationSet, EditorView } from '@milkdown/kit/prose/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranslationHistoryRecord } from '../../src/renderer/editor/translation-history'
import { createVisualTranslationHistoryAnchor } from '../../src/renderer/editor/translation-history-anchor'
import {
  TRANSLATION_HISTORY_ANCHOR_ATTRIBUTE,
  TRANSLATION_HISTORY_HIGHLIGHT_CLASS,
  createTranslationHistoryDomAnchor,
} from '../../src/renderer/editor/translation-history-marker'
import {
  bindPendingTranslationAnchor,
  capturePendingTranslationAnchor,
  createVisualTranslationHistoryPlugin,
  discardPendingTranslationAnchor,
  flushTranslationHistoryAnchors,
  promotePendingTranslationAnchor,
  revealTranslationHistoryRecord,
  visualTranslationHistoryPluginKey,
} from '../../src/renderer/editor/visual-translation-history-plugin'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0] },
    text: {},
  },
})

function docFor(text: string) {
  return schema.node('doc', null, schema.node('paragraph', null, schema.text(text)))
}

function record(id: string, createdAt: number, text = 'selected'): TranslationHistoryRecord {
  const doc = docFor(`before ${text} after`)
  return {
    id,
    requestId: `request-${id}`,
    documentKey: 'doc-a',
    workspaceAbsolutePath: null,
    documentRelativePath: null,
    documentAbsolutePath: null,
    documentRevision: null,
    mode: 'visual',
    source: { markdown: text, plainText: text },
    translatedMarkdown: `translated ${text}`,
    modelId: 'model',
    targetLanguage: 'en',
    terminal: 'completed',
    createdAt,
    anchor: createVisualTranslationHistoryAnchor(doc, 8, 8 + text.length),
  }
}

function createView(
  records: readonly TranslationHistoryRecord[] = [],
  onAnchorsChanged?: (updates: ReturnType<typeof flushTranslationHistoryAnchors>) => void,
  doc = docFor('before selected after'),
) {
  const plugin = createVisualTranslationHistoryPlugin({
    records,
    onOpenRecord: vi.fn(),
    onAnchorsChanged,
  })
  const mount = document.body.appendChild(document.createElement('div'))
  const state = EditorState.create({ doc, plugins: [plugin] })
  return { plugin, view: new EditorView(mount, { state }) }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('visual translation history plugin', () => {
  it('captures, maps, binds, and promotes a pending anchor during edits', () => {
    const { view } = createView()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 8, 16)))

    expect(capturePendingTranslationAnchor(view, 'pending-1')).toBe(true)
    view.dispatch(view.state.tr.insertText('new ', 1))
    bindPendingTranslationAnchor(view, 'pending-1', 'request-1')

    expect(promotePendingTranslationAnchor(view, 'request-1')).toMatchObject({
      mode: 'visual',
      from: 12,
      to: 20,
      status: 'valid',
    })
    expect(promotePendingTranslationAnchor(view, 'request-1')).toBeNull()
    view.destroy()
  })

  it('fails closed and clears ambiguous duplicate request anchors', () => {
    const { view } = createView()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 8, 16)))
    capturePendingTranslationAnchor(view, 'pending-a')
    bindPendingTranslationAnchor(view, 'pending-a', 'request-duplicate')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 9, 17)))
    capturePendingTranslationAnchor(view, 'pending-b')
    bindPendingTranslationAnchor(view, 'pending-b', 'request-duplicate')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 10, 18)))
    capturePendingTranslationAnchor(view, 'pending-c')
    bindPendingTranslationAnchor(view, 'pending-c', 'request-unique')

    expect(promotePendingTranslationAnchor(view, 'request-duplicate')).toBeNull()
    expect(promotePendingTranslationAnchor(view, 'request-duplicate')).toBeNull()
    expect(promotePendingTranslationAnchor(view, 'request-unique')).toMatchObject({
      from: 10,
      to: 18,
    })
    view.destroy()
  })

  it('promotes location-changed after deletion through a pending anchor', () => {
    const { view } = createView()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 8, 16)))
    capturePendingTranslationAnchor(view, 'pending-delete')
    bindPendingTranslationAnchor(view, 'pending-delete', 'request-delete')

    view.dispatch(view.state.tr.delete(10, 18))

    expect(promotePendingTranslationAnchor(view, 'request-delete')?.status).toBe('location-changed')
    view.destroy()
  })

  it('discards a pending anchor by pending key', () => {
    const { view } = createView()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 8, 16)))
    capturePendingTranslationAnchor(view, 'pending-discard')
    bindPendingTranslationAnchor(view, 'pending-discard', 'request-discard')

    discardPendingTranslationAnchor(view, 'pending-discard')

    expect(promotePendingTranslationAnchor(view, 'request-discard')).toBeNull()
    view.destroy()
  })

  it('maps stored records through real transactions and flushes updates', () => {
    const { view } = createView([record('one', 1)])

    view.dispatch(view.state.tr.insertText('new ', 1))

    expect(flushTranslationHistoryAnchors(view)).toEqual([
      expect.objectContaining({
        recordId: 'one',
        anchor: expect.objectContaining({ from: 12, to: 20, status: 'valid' }),
      }),
    ])
    view.destroy()
  })

  it('emits mapped record anchors from the plugin view update', () => {
    const onAnchorsChanged = vi.fn()
    const { view } = createView([record('one', 1)], onAnchorsChanged)

    view.dispatch(view.state.tr.insertText('new ', 1))

    expect(onAnchorsChanged).toHaveBeenCalledOnce()
    expect(onAnchorsChanged).toHaveBeenCalledWith([
      expect.objectContaining({
        recordId: 'one',
        anchor: expect.objectContaining({ from: 12, to: 20, status: 'valid' }),
      }),
    ])
    view.destroy()
  })

  it('does not emit an old dirty update for a later unrelated document transaction', () => {
    const text = `before selected ${'x'.repeat(80)}`
    const doc = docFor(text)
    const anchored = {
      ...record('one', 1),
      anchor: createVisualTranslationHistoryAnchor(doc, 8, 16),
    }
    const onAnchorsChanged = vi.fn()
    const { view } = createView([anchored], onAnchorsChanged, doc)

    view.dispatch(view.state.tr.insertText('new ', 1))
    expect(onAnchorsChanged).toHaveBeenCalledOnce()

    view.dispatch(view.state.tr.insertText('!', view.state.doc.content.size - 1))
    expect(onAnchorsChanged).toHaveBeenCalledOnce()

    view.dispatch(view.state.tr.insertText('near ', 21))
    expect(onAnchorsChanged).toHaveBeenCalledTimes(2)
    expect(onAnchorsChanged.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({ recordId: 'one' }),
    ])
    expect(flushTranslationHistoryAnchors(view)).toEqual([
      expect.objectContaining({ recordId: 'one' }),
    ])
    view.destroy()
  })

  it('keeps a persisted mismatch invalid after a transaction and refuses reveal', () => {
    const persisted = record('mismatch', 1)
    persisted.anchor = {
      ...persisted.anchor,
      fingerprint: { ...persisted.anchor.fingerprint, selected: 'wrong' },
    }
    const { view } = createView([persisted])
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)))

    view.dispatch(view.state.tr.insertText('!', view.state.doc.content.size - 1))
    const selectionBeforeReveal = view.state.selection

    expect(visualTranslationHistoryPluginKey.getState(view.state)?.records.get('mismatch')?.anchor.status)
      .toBe('location-changed')
    expect(revealTranslationHistoryRecord(view, 'mismatch')).toBe(false)
    expect(view.state.selection.eq(selectionBeforeReveal)).toBe(true)
    view.destroy()
  })

  it('rejects non-inline history endpoints without a TextSelection diagnostic', () => {
    const doc = docFor('before selected after')
    const edge = record('edge', 1)
    edge.anchor = createVisualTranslationHistoryAnchor(doc, 0, 1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { view } = createView([edge], undefined, doc)
    const selection = view.state.selection

    expect(revealTranslationHistoryRecord(view, 'edge')).toBe(false)
    expect(view.state.selection.eq(selection)).toBe(true)
    expect(warn.mock.calls.flat().join(' ')).not.toContain(
      'TextSelection endpoint not pointing into a node with inline content',
    )
    view.destroy()
  })

  it('refuses to reveal from a destroyed visual view', () => {
    const { view } = createView([record('one', 1)])
    const selection = view.state.selection
    const dispatch = vi.spyOn(view, 'dispatch')
    view.destroy()

    expect(revealTranslationHistoryRecord(view, 'one')).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
    expect(view.state.selection.eq(selection)).toBe(true)
  })

  it('centers the exact visual history anchor when requested', () => {
    const { view } = createView([record('centered', 1)])
    const anchor = view.dom.querySelector<HTMLElement>(
      `[${TRANSLATION_HISTORY_ANCHOR_ATTRIBUTE}="centered"]`,
    )!
    const scrollIntoView = vi.fn()
    anchor.scrollIntoView = scrollIntoView

    expect(revealTranslationHistoryRecord(view, 'centered', 'center')).toBe(true)

    expect(view.state.selection).toMatchObject({ from: 8, to: 16 })
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' })
    expect(view.hasFocus()).toBe(true)
    view.destroy()
  })

  it('creates an inert zero-layout DOM anchor for one record', () => {
    const anchor = createTranslationHistoryDomAnchor('record-one')

    expect(anchor).toHaveAttribute(TRANSLATION_HISTORY_ANCHOR_ATTRIBUTE, 'record-one')
    expect(anchor).toHaveAttribute('aria-hidden', 'true')
    expect(anchor.contentEditable).toBe('false')
    expect(anchor.querySelector('button')).toBeNull()
  })

  it('creates one exact highlight and one independent anchor per valid same-block record', () => {
    const records = [record('one', 1), record('two', 2)]
    const { view } = createView(records)
    const pluginState = visualTranslationHistoryPluginKey.getState(view.state)
    const decorations = pluginState?.decorations.find() ?? []
    const highlights = decorations.filter((decoration) => (
      decoration.from === 8 && decoration.to === 16
    ))
    const anchors = decorations.filter((decoration) => decoration.from === 16 && decoration.to === 16)

    expect(decorations).toHaveLength(4)
    expect(highlights).toHaveLength(2)
    expect(anchors).toHaveLength(2)
    expect(pluginState?.decorations).toBeInstanceOf(DecorationSet)
    const renderedHighlight = view.dom.querySelector(`.${TRANSLATION_HISTORY_HIGHLIGHT_CLASS}`)
    expect(view.dom.querySelectorAll(`.${TRANSLATION_HISTORY_HIGHLIGHT_CLASS}`)).toHaveLength(1)
    expect(renderedHighlight).toHaveTextContent('selected')
    expect(view.dom.querySelectorAll(`[${TRANSLATION_HISTORY_ANCHOR_ATTRIBUTE}]`)).toHaveLength(2)
    expect(view.dom.querySelector(`[${TRANSLATION_HISTORY_ANCHOR_ATTRIBUTE}="one"]`)).toBeTruthy()
    expect(view.dom.querySelector(`[${TRANSLATION_HISTORY_ANCHOR_ATTRIBUTE}="two"]`)).toBeTruthy()
    expect(view.dom.querySelector('.translation-history-marker-button')).toBeNull()
    view.destroy()
  })

  it('creates neither a highlight nor an anchor for a location-changed record', () => {
    const invalid = record('invalid', 1)
    invalid.anchor = { ...invalid.anchor, status: 'location-changed' }
    const { view } = createView([invalid])

    expect(visualTranslationHistoryPluginKey.getState(view.state)?.decorations.find()).toHaveLength(0)
    expect(view.dom.querySelector(`.${TRANSLATION_HISTORY_HIGHLIGHT_CLASS}`)).toBeNull()
    expect(view.dom.querySelector(`[${TRANSLATION_HISTORY_ANCHOR_ATTRIBUTE}]`)).toBeNull()
    view.destroy()
  })
})
