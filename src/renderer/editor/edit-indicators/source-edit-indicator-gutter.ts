import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { GutterMarker, gutter, type BlockInfo, type EditorView, type ViewUpdate } from '@codemirror/view'
import type { EditIndicatorState } from './line-diff'
import './edit-indicators.css'

const EMPTY_STATES: readonly EditIndicatorState[] = Object.freeze([])

export interface SourceEditIndicatorPayload {
  states: readonly EditIndicatorState[]
  visible: boolean
}

const EMPTY_PAYLOAD: SourceEditIndicatorPayload = Object.freeze({
  states: EMPTY_STATES,
  visible: false,
})

export const setSourceEditIndicators = StateEffect.define<SourceEditIndicatorPayload>()

const sourceEditIndicatorState = StateField.define<SourceEditIndicatorPayload>({
  create: () => EMPTY_PAYLOAD,
  update(value, transaction) {
    if (transaction.docChanged) return EMPTY_PAYLOAD
    for (const effect of transaction.effects) {
      if (effect.is(setSourceEditIndicators)) return effect.value
    }
    return value
  },
})

type Rounding = 'none' | 'start' | 'middle' | 'end' | 'single'

function roundingFor(
  states: readonly EditIndicatorState[],
  lineIndex: number,
  state: EditIndicatorState,
): Rounding {
  if (state === 'none') return 'none'
  const previous = states[lineIndex - 1] === state
  const next = states[lineIndex + 1] === state
  if (!previous && !next) return 'single'
  if (!previous) return 'start'
  if (!next) return 'end'
  return 'middle'
}

class SourceEditIndicatorMarker extends GutterMarker {
  constructor(
    private readonly state: EditIndicatorState,
    private readonly rounding: Rounding,
  ) {
    super()
  }

  eq(other: GutterMarker): boolean {
    return other instanceof SourceEditIndicatorMarker
      && other.state === this.state
      && other.rounding === this.rounding
  }

  toDOM(): HTMLElement {
    const marker = document.createElement('span')
    marker.className = [
      'arkdown-source-edit-indicator',
      `arkdown-source-edit-indicator--${this.state}`,
      `arkdown-source-edit-indicator--${this.rounding}`,
    ].join(' ')
    marker.dataset.state = this.state
    marker.dataset.rounding = this.rounding
    marker.setAttribute('aria-hidden', 'true')
    return marker
  }
}

class SourceEditIndicatorSpacer extends GutterMarker {
  eq(other: GutterMarker): boolean {
    return other instanceof SourceEditIndicatorSpacer
  }

  toDOM(): HTMLElement {
    const spacer = document.createElement('span')
    spacer.className = 'arkdown-source-edit-indicator-spacer'
    spacer.setAttribute('aria-hidden', 'true')
    return spacer
  }
}

function lineMarker(view: EditorView, block: BlockInfo): GutterMarker {
  const payload = view.state.field(sourceEditIndicatorState)
  const lineIndex = view.state.doc.lineAt(block.from).number - 1
  const state = payload.visible ? payload.states[lineIndex] ?? 'none' : 'none'
  return new SourceEditIndicatorMarker(
    state,
    roundingFor(payload.visible ? payload.states : EMPTY_STATES, lineIndex, state),
  )
}

function indicatorChanged(update: ViewUpdate): boolean {
  return update.transactions.some((transaction) => (
    transaction.effects.some((effect) => effect.is(setSourceEditIndicators))
    || transaction.docChanged
  ))
}

export const sourceEditIndicatorGutter: Extension = [
  sourceEditIndicatorState,
  gutter({
    class: 'arkdown-source-edit-indicator-gutter',
    initialSpacer: () => new SourceEditIndicatorSpacer(),
    lineMarker,
    lineMarkerChange: indicatorChanged,
    renderEmptyElements: true,
  }),
]
