import { history, undoDepth } from '@codemirror/commands'
import { codeFolding, foldEffect, foldedRanges, foldService } from '@codemirror/language'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { expect, it } from 'vitest'
import { reconfigureSourceSpellCheck } from '../../src/renderer/editor/SourceEditor'

it('reconfigures a real CodeMirror view without losing document editing state', () => {
  const parent = document.body.appendChild(document.createElement('div'))
  const compartment = new Compartment()
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '# Heading\nfolded body\nlast line',
      selection: { anchor: 2, head: 7 },
      extensions: [
        history(),
        codeFolding(),
        foldService.of((state, lineStart) => lineStart === 0
          ? { from: state.doc.line(1).to, to: state.doc.line(2).to }
          : null),
        EditorView.lineWrapping,
        compartment.of(EditorView.contentAttributes.of({ spellcheck: 'false' })),
      ],
    }),
  })
  view.dispatch({ changes: { from: view.state.doc.length, insert: '!' } })
  view.dispatch({ selection: { anchor: 2, head: 7 } })
  const fold = view.state.facet(foldService)[0]?.(view.state, 0, view.state.doc.line(1).to)
  expect(fold).toEqual({ from: 9, to: 21 })
  view.dispatch({ effects: foldEffect.of(fold!) })
  const identity = view
  const documentBefore = view.state.doc.toString()
  const selectionBefore = view.state.selection
  const historyBefore = undoDepth(view.state)
  const foldsBefore: Array<{ from: number, to: number }> = []
  foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
    foldsBefore.push({ from, to })
  })
  view.scrollDOM.scrollTop = 43

  reconfigureSourceSpellCheck(view, compartment, true)

  expect(view).toBe(identity)
  expect(view.contentDOM).toHaveAttribute('spellcheck', 'true')
  expect(view.state.doc.toString()).toBe(documentBefore)
  expect(view.state.selection.eq(selectionBefore)).toBe(true)
  expect(undoDepth(view.state)).toBe(historyBefore)
  const foldsAfter: Array<{ from: number, to: number }> = []
  foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
    foldsAfter.push({ from, to })
  })
  expect(foldsAfter).toEqual(foldsBefore)
  expect(foldsAfter).toEqual([{ from: 9, to: 21 }])
  expect(view.scrollDOM.scrollTop).toBe(43)
  expect(view.contentDOM).toHaveClass('cm-lineWrapping')

  view.destroy()
  parent.remove()
})
