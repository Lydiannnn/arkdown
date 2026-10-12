import { foldEffect, foldService } from '@codemirror/language'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import {
  setSourceEditIndicators,
  sourceEditIndicatorGutter,
} from '../../src/renderer/editor/edit-indicators/source-edit-indicator-gutter'
import { sourceFoldGutter } from '../../src/renderer/editor/edit-indicators/source-fold-gutter'

const mounted: EditorView[] = []

afterEach(() => {
  mounted.splice(0).forEach((view) => view.destroy())
  document.body.replaceChildren()
})

function mount(doc: string, extensions: readonly Extension[] = []): EditorView {
  const parent = document.body.appendChild(document.createElement('div'))
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [sourceEditIndicatorGutter, ...extensions],
    }),
  })
  mounted.push(view)
  return view
}

function indicatorStates(view: EditorView): string[] {
  return [...view.dom.querySelectorAll<HTMLElement>('.arkdown-source-edit-indicator')]
    .map((marker) => marker.dataset.state ?? '')
}

describe('source edit indicator gutter', () => {
  it('renders saved and unsaved logical runs with only their exterior ends rounded', () => {
    const view = mount('one\ntwo\nthree\nfour')

    view.dispatch({ effects: setSourceEditIndicators.of({
      states: ['saved', 'saved', 'saved', 'unsaved'], visible: true,
    }) })

    const markers = [...view.dom.querySelectorAll<HTMLElement>('.arkdown-source-edit-indicator')]
    expect(markers.map((marker) => marker.dataset.state)).toEqual([
      'saved', 'saved', 'saved', 'unsaved',
    ])
    expect(markers.map((marker) => marker.dataset.rounding)).toEqual([
      'start', 'middle', 'end', 'single',
    ])
    expect(markers[0]).toHaveClass('arkdown-source-edit-indicator--saved')
    expect(markers[3]).toHaveClass('arkdown-source-edit-indicator--unsaved')
  })

  it('renders one stable empty-document gutter row even without indicator state', () => {
    const view = mount('')

    expect(view.dom.querySelectorAll('.arkdown-source-edit-indicator')).toHaveLength(1)
    expect(view.dom.querySelectorAll('.arkdown-source-edit-indicator-spacer')).toHaveLength(1)
    expect(indicatorStates(view)).toEqual(['none'])
  })

  it('keeps a fixed empty column while hidden and reveals the latest hot state', () => {
    const view = mount('one\ntwo')
    const gutter = view.dom.querySelector<HTMLElement>('.arkdown-source-edit-indicator-gutter')!
    const columnBefore = gutter.getBoundingClientRect().width

    view.dispatch({ effects: setSourceEditIndicators.of({
      states: ['saved', 'unsaved'], visible: false,
    }) })
    expect(indicatorStates(view)).toEqual(['none', 'none'])
    expect(gutter.getBoundingClientRect().width).toBe(columnBefore)

    view.dispatch({ effects: setSourceEditIndicators.of({
      states: ['saved', 'unsaved'], visible: true,
    }) })
    expect(indicatorStates(view)).toEqual(['saved', 'unsaved'])
  })

  it('hides stale classifications after a document change until the next worker snapshot', () => {
    const view = mount('one\ntwo')
    view.dispatch({ effects: setSourceEditIndicators.of({
      states: ['saved', 'unsaved'], visible: true,
    }) })
    expect(indicatorStates(view)).toEqual(['saved', 'unsaved'])

    view.dispatch({ changes: { from: 0, insert: 'new\n' } })
    expect(indicatorStates(view)).toEqual(['none', 'none', 'none'])
  })

  it('maps marker state by document line after folding, rather than gutter order', () => {
    const view = mount('# Heading\nfolded line\nfinal line', [
      sourceFoldGutter,
      foldService.of((state, lineStart) => lineStart === 0
        ? { from: state.doc.line(1).to, to: state.doc.line(2).to }
        : null),
    ])
    view.dispatch({ effects: setSourceEditIndicators.of({
      states: ['none', 'saved', 'unsaved'], visible: true,
    }) })
    const folded = view.state.facet(foldService)[0]!(view.state, 0, view.state.doc.line(1).to)!
    view.dispatch({ effects: foldEffect.of(folded) })

    expect(indicatorStates(view)).toEqual(['none', 'unsaved'])
  })

  it('uses custom fold markers before its stable indicator column', async () => {
    const view = mount('# Heading\nbody', [
      sourceFoldGutter,
      foldService.of((state, lineStart) => lineStart === 0
        ? { from: state.doc.line(1).to, to: state.doc.line(2).to }
        : null),
    ])

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const gutters = [...view.dom.querySelectorAll<HTMLElement>('.cm-gutters > .cm-gutter')]
    expect(gutters.map((gutter) => gutter.className)).toEqual(expect.arrayContaining([
      expect.stringContaining('cm-foldGutter'),
      expect.stringContaining('arkdown-source-edit-indicator-gutter'),
    ]))
    expect([...view.dom.querySelectorAll<HTMLElement>('.arkdown-source-fold-triangle')]
      .some((triangle) => (
        triangle.dataset.folded === 'false'
        && triangle.classList.contains('arkdown-source-fold-triangle--down')
      ))).toBe(true)
  })

  it('shows a right triangle after folding and keeps exactly fold, line-number, indicator gutters', async () => {
    const parent = document.body.appendChild(document.createElement('div'))
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: '# Heading\nbody',
        extensions: [
          sourceFoldGutter,
          lineNumbers(),
          sourceEditIndicatorGutter,
          foldService.of((state, lineStart) => lineStart === 0
            ? { from: state.doc.line(1).to, to: state.doc.line(2).to }
            : null),
        ],
      }),
    })
    mounted.push(view)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    expect([...view.dom.querySelectorAll<HTMLElement>('.cm-gutters > .cm-gutter')]
      .map((gutter) => gutter.className)).toEqual([
      expect.stringContaining('cm-foldGutter'),
      expect.stringContaining('cm-lineNumbers'),
      expect.stringContaining('arkdown-source-edit-indicator-gutter'),
    ])

    const range = view.state.facet(foldService)[0]!(view.state, 0, view.state.doc.line(1).to)!
    view.dispatch({ effects: foldEffect.of(range) })
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    expect(view.dom.querySelector('.arkdown-source-fold-triangle--right')).toBeTruthy()
  })
})
