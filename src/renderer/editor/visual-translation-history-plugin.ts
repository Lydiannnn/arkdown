import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import type {
  TranslationHistoryAnchor,
  TranslationHistoryAnchorUpdate,
  TranslationHistoryRecord,
  TranslationHistoryRevealAlignment,
} from './translation-history'
import {
  createVisualTranslationHistoryAnchor,
  mapVisualTranslationHistoryAnchor,
  matchesVisualTranslationAnchorFingerprint,
} from './translation-history-anchor'
import {
  TRANSLATION_HISTORY_ANCHOR_ATTRIBUTE,
  TRANSLATION_HISTORY_HIGHLIGHT_CLASS,
  createTranslationHistoryDomAnchor,
} from './translation-history-marker'

interface PendingTranslationAnchor {
  pendingKey: string
  requestId: string | null
  anchor: Extract<TranslationHistoryAnchor, { mode: 'visual' }>
}

export interface VisualTranslationHistoryPluginState {
  records: ReadonlyMap<string, TranslationHistoryRecord>
  pending: ReadonlyMap<string, PendingTranslationAnchor>
  dirty: ReadonlyMap<string, TranslationHistoryAnchorUpdate>
  emission: readonly TranslationHistoryAnchorUpdate[]
  decorations: DecorationSet
}

export interface VisualTranslationHistoryPluginOptions {
  records: readonly TranslationHistoryRecord[]
  onOpenRecord(recordId: string): void
  onAnchorsChanged?(updates: readonly TranslationHistoryAnchorUpdate[]): void
}

type PluginMeta =
  | { type: 'capture'; pending: PendingTranslationAnchor }
  | { type: 'bind'; pendingKey: string; requestId: string }
  | { type: 'remove-pending'; key: string }
  | { type: 'clear-dirty' }
  | { type: 'sync-records'; records: readonly TranslationHistoryRecord[] }

export const visualTranslationHistoryPluginKey = new PluginKey<VisualTranslationHistoryPluginState>(
  'visual-translation-history',
)

function anchorsEqual(left: TranslationHistoryAnchor, right: TranslationHistoryAnchor): boolean {
  return left.mode === right.mode
    && left.from === right.from
    && left.to === right.to
    && left.status === right.status
    && left.fingerprint.before === right.fingerprint.before
    && left.fingerprint.selected === right.fingerprint.selected
    && left.fingerprint.after === right.fingerprint.after
    && (left.mode === 'visual' && right.mode === 'visual'
      ? left.blockStart === right.blockStart
      : left.mode === 'source' && right.mode === 'source' && left.lineStart === right.lineStart)
}

function buildDecorations(
  doc: EditorState['doc'],
  records: ReadonlyMap<string, TranslationHistoryRecord>,
): DecorationSet {
  const decorations: Decoration[] = []
  const ordered = [...records.values()].sort((left, right) => (
    left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  ))
  for (const record of ordered) {
    if (
      record.anchor.mode !== 'visual'
      || !matchesVisualTranslationAnchorFingerprint(doc, record.anchor)
    ) continue
    decorations.push(
      Decoration.inline(record.anchor.from, record.anchor.to, {
        class: TRANSLATION_HISTORY_HIGHLIGHT_CLASS,
      }),
      Decoration.widget(
        record.anchor.to,
        () => createTranslationHistoryDomAnchor(record.id),
        { key: `translation-history:${record.id}`, side: 1 },
      ),
    )
  }
  return DecorationSet.create(doc, decorations)
}

function applyMeta(
  value: VisualTranslationHistoryPluginState,
  meta: PluginMeta,
  transaction: Transaction,
  onOpenRecord: (recordId: string) => void,
): VisualTranslationHistoryPluginState {
  if (meta.type === 'clear-dirty') return { ...value, dirty: new Map(), emission: [] }
  if (meta.type === 'sync-records') {
    const records = new Map(meta.records.map((record) => [record.id, record]))
    const dirty = new Map(
      [...value.dirty].filter(([recordId]) => records.has(recordId)),
    )
    return {
      ...value,
      records,
      dirty,
      decorations: buildDecorations(transaction.doc, records),
    }
  }
  const pending = new Map(value.pending)
  if (meta.type === 'capture') pending.set(meta.pending.pendingKey, meta.pending)
  if (meta.type === 'bind') {
    const current = pending.get(meta.pendingKey)
    if (current) pending.set(meta.pendingKey, { ...current, requestId: meta.requestId })
  }
  if (meta.type === 'remove-pending') {
    for (const [pendingKey, current] of pending) {
      if (pendingKey === meta.key || current.requestId === meta.key) pending.delete(pendingKey)
    }
  }
  return { ...value, pending }
}

function mapPluginState(
  value: VisualTranslationHistoryPluginState,
  transaction: Transaction,
  onOpenRecord: (recordId: string) => void,
): VisualTranslationHistoryPluginState {
  const records = new Map(value.records)
  const dirty = new Map(value.dirty)
  const emission: TranslationHistoryAnchorUpdate[] = []
  for (const [recordId, record] of records) {
    if (record.anchor.mode !== 'visual') continue
    const anchor = mapVisualTranslationHistoryAnchor(record.anchor, transaction)
    if (!anchorsEqual(record.anchor, anchor)) {
      records.set(recordId, { ...record, anchor })
      const update = { recordId, anchor }
      dirty.set(recordId, update)
      emission.push(update)
    }
  }
  const pending = new Map(value.pending)
  for (const [pendingKey, current] of pending) {
    pending.set(pendingKey, {
      ...current,
      anchor: mapVisualTranslationHistoryAnchor(current.anchor, transaction),
    })
  }
  return {
    records,
    pending,
    dirty,
    emission,
    decorations: buildDecorations(transaction.doc, records),
  }
}

export function createVisualTranslationHistoryPlugin(
  options: VisualTranslationHistoryPluginOptions,
): Plugin<VisualTranslationHistoryPluginState> {
  return new Plugin<VisualTranslationHistoryPluginState>({
    key: visualTranslationHistoryPluginKey,
    state: {
      init: (_config, state) => {
        const records = new Map(options.records.map((record) => [record.id, record]))
        return {
          records,
          pending: new Map(),
          dirty: new Map(),
          emission: [],
          decorations: buildDecorations(state.doc, records),
        }
      },
      apply: (transaction, value) => {
        let next = transaction.docChanged
          ? mapPluginState(value, transaction, options.onOpenRecord)
          : value
        const meta = transaction.getMeta(visualTranslationHistoryPluginKey) as PluginMeta | undefined
        if (meta) next = applyMeta(next, meta, transaction, options.onOpenRecord)
        return next
      },
    },
    props: {
      decorations: (state) => visualTranslationHistoryPluginKey.getState(state)?.decorations ?? null,
    },
    view: () => ({
      update: (view, previousState) => {
        const previous = visualTranslationHistoryPluginKey.getState(previousState)
        const current = visualTranslationHistoryPluginKey.getState(view.state)
        if (!current || current.emission === previous?.emission || current.emission.length === 0) return
        options.onAnchorsChanged?.(current.emission)
      },
      destroy: () => undefined,
    }),
  })
}

function pluginState(view: EditorView): VisualTranslationHistoryPluginState | null {
  return visualTranslationHistoryPluginKey.getState(view.state) ?? null
}

function isInlineTextSelectionRange(
  doc: EditorState['doc'],
  from: number,
  to: number,
): boolean {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return false
  if (from < 0 || to <= from || to > doc.content.size) return false
  return doc.resolve(from).parent.inlineContent && doc.resolve(to).parent.inlineContent
}

export function revealTranslationHistoryRecord(
  view: EditorView,
  recordId: string,
  alignment: TranslationHistoryRevealAlignment = 'nearest',
): boolean {
  if (view.isDestroyed) return false
  const record = pluginState(view)?.records.get(recordId)
  if (
    !record
    || record.anchor.mode !== 'visual'
    || !matchesVisualTranslationAnchorFingerprint(view.state.doc, record.anchor)
    || !isInlineTextSelectionRange(view.state.doc, record.anchor.from, record.anchor.to)
  ) return false
  const selection = TextSelection.create(view.state.doc, record.anchor.from, record.anchor.to)
  const transaction = view.state.tr.setSelection(selection)
  view.dispatch(alignment === 'center' ? transaction : transaction.scrollIntoView())
  if (alignment === 'center') {
    const anchor = [...view.dom.querySelectorAll<HTMLElement>(
      `[${TRANSLATION_HISTORY_ANCHOR_ATTRIBUTE}]`,
    )].find((element) => (
      element.getAttribute(TRANSLATION_HISTORY_ANCHOR_ATTRIBUTE) === recordId
    ))
    if (anchor) anchor.scrollIntoView({ block: 'center', inline: 'nearest' })
    else view.dispatch(view.state.tr.scrollIntoView())
  }
  view.focus()
  return true
}

export function flushTranslationHistoryAnchors(
  view: EditorView,
): readonly TranslationHistoryAnchorUpdate[] {
  const current = pluginState(view)
  if (!current || current.dirty.size === 0) return []
  const updates = [...current.dirty.values()]
  view.dispatch(view.state.tr.setMeta(visualTranslationHistoryPluginKey, { type: 'clear-dirty' } satisfies PluginMeta))
  return updates
}

export function syncTranslationHistoryRecords(
  view: EditorView,
  records: readonly TranslationHistoryRecord[],
): void {
  const current = pluginState(view)?.records
  if (
    current
    && current.size === records.length
    && records.every((record) => current.get(record.id) === record)
  ) return
  view.dispatch(view.state.tr.setMeta(visualTranslationHistoryPluginKey, {
    type: 'sync-records',
    records,
  } satisfies PluginMeta))
}

export function capturePendingTranslationAnchor(view: EditorView, pendingKey: string): boolean {
  if (!pendingKey || view.state.selection.empty) return false
  const { from, to } = view.state.selection
  const pending: PendingTranslationAnchor = {
    pendingKey,
    requestId: null,
    anchor: createVisualTranslationHistoryAnchor(view.state.doc, from, to),
  }
  view.dispatch(view.state.tr.setMeta(visualTranslationHistoryPluginKey, { type: 'capture', pending } satisfies PluginMeta))
  return true
}

export function bindPendingTranslationAnchor(
  view: EditorView,
  pendingKey: string,
  requestId: string,
): void {
  view.dispatch(view.state.tr.setMeta(visualTranslationHistoryPluginKey, {
    type: 'bind',
    pendingKey,
    requestId,
  } satisfies PluginMeta))
}

export function promotePendingTranslationAnchor(
  view: EditorView,
  requestId: string,
): TranslationHistoryAnchor | null {
  const matches = [...(pluginState(view)?.pending.values() ?? [])]
    .filter((candidate) => candidate.requestId === requestId)
  if (matches.length === 0) return null
  view.dispatch(view.state.tr.setMeta(visualTranslationHistoryPluginKey, {
    type: 'remove-pending',
    key: requestId,
  } satisfies PluginMeta))
  return matches.length === 1 ? matches[0]!.anchor : null
}

export function discardPendingTranslationAnchor(view: EditorView, key: string): void {
  view.dispatch(view.state.tr.setMeta(visualTranslationHistoryPluginKey, {
    type: 'remove-pending',
    key,
  } satisfies PluginMeta))
}
