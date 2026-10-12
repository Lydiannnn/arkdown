import {
  EditorSelection,
  StateEffect,
  StateField,
  type ChangeDesc,
  type Text,
  type Transaction,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import type {
  TranslationHistoryAnchor,
  TranslationHistoryAnchorUpdate,
  TranslationHistoryRecord,
  TranslationHistoryRevealAlignment,
} from './translation-history'
import { TRANSLATION_ANCHOR_FINGERPRINT_LIMIT } from './translation-history-anchor'
import {
  TRANSLATION_HISTORY_HIGHLIGHT_CLASS,
  createTranslationHistoryDomAnchor,
} from './translation-history-marker'

interface PendingSourceTranslationAnchor {
  pendingKey: string
  requestId: string | null
  anchor: Extract<TranslationHistoryAnchor, { mode: 'source' }>
}

interface SourceTranslationHistoryState {
  records: ReadonlyMap<string, TranslationHistoryRecord>
  pending: ReadonlyMap<string, PendingSourceTranslationAnchor>
  dirty: ReadonlyMap<string, TranslationHistoryAnchorUpdate>
  emission: readonly TranslationHistoryAnchorUpdate[]
  onOpenRecord(recordId: string): void
}

export interface SourceTranslationHistoryViewOptions {
  onOpenRecord?(recordId: string): void
  onAnchorsChanged?(updates: readonly TranslationHistoryAnchorUpdate[]): void
}

const EMPTY_STATE: SourceTranslationHistoryState = {
  records: new Map(),
  pending: new Map(),
  dirty: new Map(),
  emission: [],
  onOpenRecord: () => undefined,
}

const stateByDecorations = new WeakMap<DecorationSet, SourceTranslationHistoryState>()
const optionsByView = new WeakMap<EditorView, SourceTranslationHistoryViewOptions>()

export const replaceSourceTranslationHistoryRecordsEffect = StateEffect.define<
  readonly TranslationHistoryRecord[]
>()
export const configureSourceTranslationHistoryEffect = StateEffect.define<
  (recordId: string) => void
>()
export const capturePendingSourceTranslationAnchorEffect = StateEffect.define<
  PendingSourceTranslationAnchor
>()
export const bindPendingSourceTranslationAnchorEffect = StateEffect.define<{
  pendingKey: string
  requestId: string
}>()
export const removePendingSourceTranslationAnchorEffect = StateEffect.define<string>()
export const clearDirtySourceTranslationHistoryAnchorsEffect = StateEffect.define<null>()

function boundedFingerprint(
  doc: Text,
  from: number,
  to: number,
): Extract<TranslationHistoryAnchor, { mode: 'source' }>['fingerprint'] {
  return {
    before: doc.sliceString(
      Math.max(0, from - TRANSLATION_ANCHOR_FINGERPRINT_LIMIT),
      from,
    ),
    selected: doc.sliceString(from, to),
    after: doc.sliceString(
      to,
      Math.min(doc.length, to + TRANSLATION_ANCHOR_FINGERPRINT_LIMIT),
    ),
  }
}

export function createSourceTranslationHistoryAnchor(
  doc: Text,
  from: number,
  to: number,
): Extract<TranslationHistoryAnchor, { mode: 'source' }> {
  const start = Math.max(0, Math.min(doc.length, Math.min(from, to)))
  const end = Math.max(start, Math.min(doc.length, Math.max(from, to)))
  return {
    mode: 'source',
    from: start,
    to: end,
    lineStart: doc.lineAt(start).from,
    fingerprint: boundedFingerprint(doc, start, end),
    status: 'valid',
  }
}

function matchesSourceTranslationAnchorFingerprint(
  doc: Text,
  anchor: Extract<TranslationHistoryAnchor, { mode: 'source' }>,
): boolean {
  if (
    anchor.status !== 'valid'
    || !Number.isSafeInteger(anchor.from)
    || !Number.isSafeInteger(anchor.to)
    || anchor.from < 0
    || anchor.to <= anchor.from
    || anchor.to > doc.length
  ) return false
  const current = boundedFingerprint(doc, anchor.from, anchor.to)
  return current.before === anchor.fingerprint.before
    && current.selected === anchor.fingerprint.selected
    && current.after === anchor.fingerprint.after
}

function mapSourceTranslationHistoryAnchor(
  anchor: Extract<TranslationHistoryAnchor, { mode: 'source' }>,
  changes: ChangeDesc,
  oldDoc: Text,
  newDoc: Text,
): Extract<TranslationHistoryAnchor, { mode: 'source' }> {
  let deletedThrough = anchor.status === 'location-changed'
    || !matchesSourceTranslationAnchorFingerprint(oldDoc, anchor)
  changes.iterChangedRanges((fromA, toA) => {
    if (toA > fromA && fromA < anchor.to && toA > anchor.from) {
      deletedThrough = true
    }
  })
  const from = Math.max(0, Math.min(newDoc.length, changes.mapPos(anchor.from, 1)))
  const to = Math.max(from, Math.min(newDoc.length, changes.mapPos(anchor.to, -1)))
  const status = deletedThrough || from === to ? 'location-changed' : 'valid'
  return {
    ...anchor,
    from,
    to,
    lineStart: status === 'valid'
      ? newDoc.lineAt(from).from
      : Math.max(0, Math.min(newDoc.length, changes.mapPos(anchor.lineStart, -1))),
    fingerprint: status === 'valid'
      ? boundedFingerprint(newDoc, from, to)
      : anchor.fingerprint,
    status,
  }
}

function anchorsEqual(left: TranslationHistoryAnchor, right: TranslationHistoryAnchor): boolean {
  return left.mode === right.mode
    && left.from === right.from
    && left.to === right.to
    && left.status === right.status
    && left.fingerprint.before === right.fingerprint.before
    && left.fingerprint.selected === right.fingerprint.selected
    && left.fingerprint.after === right.fingerprint.after
    && (left.mode === 'source' && right.mode === 'source'
      ? left.lineStart === right.lineStart
      : left.mode === 'visual' && right.mode === 'visual' && left.blockStart === right.blockStart)
}

class SourceTranslationHistoryAnchorWidget extends WidgetType {
  constructor(readonly recordId: string) {
    super()
  }

  eq(other: SourceTranslationHistoryAnchorWidget): boolean {
    return this.recordId === other.recordId
  }

  toDOM(): HTMLElement {
    return createTranslationHistoryDomAnchor(this.recordId)
  }

  ignoreEvent(): boolean {
    return true
  }

  get estimatedHeight(): number {
    return 0
  }
}

function buildDecorations(
  doc: Text,
  state: SourceTranslationHistoryState,
): DecorationSet {
  const ranges = [...state.records.values()]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .flatMap((record) => {
      if (
        record.anchor.mode !== 'source'
        || !matchesSourceTranslationAnchorFingerprint(doc, record.anchor)
      ) return []
      return [
        Decoration.mark({ class: TRANSLATION_HISTORY_HIGHLIGHT_CLASS })
          .range(record.anchor.from, record.anchor.to),
        Decoration.widget({
          side: 1,
          widget: new SourceTranslationHistoryAnchorWidget(record.id),
        }).range(record.anchor.to),
      ]
    })
  // Decoration.none is a shared singleton. A no-op line decoration gives each
  // field value its own identity so its metadata cannot leak between views.
  const identity = Decoration.line({}).range(0)
  return Decoration.set([identity, ...ranges], true)
}

function storeState(doc: Text, state: SourceTranslationHistoryState): DecorationSet {
  const decorations = buildDecorations(doc, state)
  stateByDecorations.set(decorations, state)
  return decorations
}

function mappedState(
  state: SourceTranslationHistoryState,
  transaction: Transaction,
): SourceTranslationHistoryState {
  const records = new Map(state.records)
  const dirty = new Map(state.dirty)
  const emission: TranslationHistoryAnchorUpdate[] = []
  for (const [recordId, record] of records) {
    if (record.anchor.mode !== 'source') continue
    const anchor = mapSourceTranslationHistoryAnchor(
      record.anchor,
      transaction.changes,
      transaction.startState.doc,
      transaction.newDoc,
    )
    if (!anchorsEqual(record.anchor, anchor)) {
      records.set(recordId, { ...record, anchor })
      const update = { recordId, anchor }
      dirty.set(recordId, update)
      emission.push(update)
    }
  }
  const pending = new Map(state.pending)
  for (const [pendingKey, current] of pending) {
    pending.set(pendingKey, {
      ...current,
      anchor: mapSourceTranslationHistoryAnchor(
        current.anchor,
        transaction.changes,
        transaction.startState.doc,
        transaction.newDoc,
      ),
    })
  }
  return { ...state, records, pending, dirty, emission }
}

export const sourceTranslationHistoryStateField = StateField.define<DecorationSet>({
  create: (_state) => storeState(_state.doc, EMPTY_STATE),
  update: (decorations, transaction) => {
    let state = stateByDecorations.get(decorations) ?? EMPTY_STATE
    let changed = transaction.docChanged
    if (transaction.docChanged) state = mappedState(state, transaction)

    for (const effect of transaction.effects) {
      if (effect.is(configureSourceTranslationHistoryEffect)) {
        state = { ...state, onOpenRecord: effect.value, emission: [] }
        changed = true
      } else if (effect.is(replaceSourceTranslationHistoryRecordsEffect)) {
        const records = new Map(
          effect.value
            .filter((record) => record.anchor.mode === 'source')
            .map((record) => [record.id, record]),
        )
        state = {
          ...state,
          records,
          dirty: new Map([...state.dirty].filter(([recordId]) => records.has(recordId))),
          emission: [],
        }
        changed = true
      } else if (effect.is(capturePendingSourceTranslationAnchorEffect)) {
        const pending = new Map(state.pending)
        pending.set(effect.value.pendingKey, effect.value)
        state = { ...state, pending, emission: [] }
        changed = true
      } else if (effect.is(bindPendingSourceTranslationAnchorEffect)) {
        const current = state.pending.get(effect.value.pendingKey)
        if (current) {
          const pending = new Map(state.pending)
          pending.set(effect.value.pendingKey, { ...current, requestId: effect.value.requestId })
          state = { ...state, pending, emission: [] }
          changed = true
        }
      } else if (effect.is(removePendingSourceTranslationAnchorEffect)) {
        const pending = new Map(state.pending)
        for (const [pendingKey, current] of pending) {
          if (pendingKey === effect.value || current.requestId === effect.value) {
            pending.delete(pendingKey)
          }
        }
        state = { ...state, pending, emission: [] }
        changed = true
      } else if (effect.is(clearDirtySourceTranslationHistoryAnchorsEffect)) {
        state = { ...state, dirty: new Map(), emission: [] }
        changed = true
      }
    }

    return changed ? storeState(transaction.newDoc, state) : decorations
  },
  provide: (field) => EditorView.decorations.from(field),
})

const sourceTranslationHistoryCallbacks = ViewPlugin.fromClass(class {
  update(update: ViewUpdate): void {
    const previous = stateByDecorations.get(
      update.startState.field(sourceTranslationHistoryStateField),
    )
    const current = stateByDecorations.get(
      update.state.field(sourceTranslationHistoryStateField),
    )
    if (!current || current.emission === previous?.emission || current.emission.length === 0) return
    optionsByView.get(update.view)?.onAnchorsChanged?.(current.emission)
  }
})

export const sourceTranslationHistoryExtension = [
  sourceTranslationHistoryStateField,
  sourceTranslationHistoryCallbacks,
] as const

function sourceState(view: EditorView): SourceTranslationHistoryState | null {
  if (typeof (view.state as { field?: unknown }).field !== 'function') return null
  const decorations = view.state.field(sourceTranslationHistoryStateField, false)
  return decorations ? stateByDecorations.get(decorations) ?? EMPTY_STATE : null
}

export function configureSourceTranslationHistoryView(
  view: EditorView,
  options: SourceTranslationHistoryViewOptions,
): void {
  optionsByView.set(view, options)
  if (!sourceState(view)) return
  view.dispatch({
    effects: configureSourceTranslationHistoryEffect.of(
      (recordId) => optionsByView.get(view)?.onOpenRecord?.(recordId),
    ),
  })
}

export function syncSourceTranslationHistoryRecords(
  view: EditorView,
  records: readonly TranslationHistoryRecord[],
): void {
  const current = sourceState(view)?.records
  if (!current) return
  if (
    current.size === records.length
    && records.every((record) => current.get(record.id) === record)
  ) return
  view.dispatch({ effects: replaceSourceTranslationHistoryRecordsEffect.of(records) })
}

export function revealSourceTranslationHistoryRecord(
  view: EditorView,
  recordId: string,
  alignment: TranslationHistoryRevealAlignment = 'nearest',
): boolean {
  if (!view.dom.isConnected) return false
  const record = sourceState(view)?.records.get(recordId)
  if (
    !record
    || record.anchor.mode !== 'source'
    || !matchesSourceTranslationAnchorFingerprint(view.state.doc, record.anchor)
  ) return false
  const selection = EditorSelection.range(record.anchor.from, record.anchor.to)
  view.dispatch({
    selection,
    effects: EditorView.scrollIntoView(
      selection,
      alignment === 'center' ? { y: 'center' } : undefined,
    ),
  })
  view.focus()
  return true
}

export function flushSourceTranslationHistoryAnchors(
  view: EditorView,
): readonly TranslationHistoryAnchorUpdate[] {
  const current = sourceState(view)
  if (!current || current.dirty.size === 0) return []
  const updates = [...current.dirty.values()]
  view.dispatch({ effects: clearDirtySourceTranslationHistoryAnchorsEffect.of(null) })
  return updates
}

export function capturePendingSourceTranslationAnchor(
  view: EditorView,
  pendingKey: string,
): boolean {
  if (!sourceState(view) || !pendingKey || view.state.selection.main.empty) return false
  const { from, to } = view.state.selection.main
  view.dispatch({ effects: capturePendingSourceTranslationAnchorEffect.of({
    pendingKey,
    requestId: null,
    anchor: createSourceTranslationHistoryAnchor(view.state.doc, from, to),
  }) })
  return true
}

export function bindPendingSourceTranslationAnchor(
  view: EditorView,
  pendingKey: string,
  requestId: string,
): void {
  if (!sourceState(view)) return
  view.dispatch({
    effects: bindPendingSourceTranslationAnchorEffect.of({ pendingKey, requestId }),
  })
}

export function promotePendingSourceTranslationAnchor(
  view: EditorView,
  requestId: string,
): TranslationHistoryAnchor | null {
  const matches = [...(sourceState(view)?.pending.values() ?? [])]
    .filter((candidate) => candidate.requestId === requestId)
  if (matches.length === 0) return null
  view.dispatch({ effects: removePendingSourceTranslationAnchorEffect.of(requestId) })
  return matches.length === 1 ? matches[0]!.anchor : null
}

export function discardPendingSourceTranslationAnchor(
  view: EditorView,
  key: string,
): void {
  if (!sourceState(view)) return
  view.dispatch({ effects: removePendingSourceTranslationAnchorEffect.of(key) })
}
