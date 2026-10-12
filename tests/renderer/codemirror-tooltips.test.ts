import { afterEach, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { foldEffect, unfoldEffect, foldGutter } from '@codemirror/language'
import { codeMirrorTooltips } from '../../src/renderer/editor/codemirror-tooltips'

let view: EditorView | undefined
afterEach(() => { view?.destroy(); document.body.replaceChildren() })

it('adapts real fold placeholders after folding and recreating them', async () => {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: 'first\nsecond\nthird', extensions: [foldGutter(), codeMirrorTooltips] }),
  })
  for (let attempt = 0; attempt < 2; attempt++) {
    view.dispatch({ effects: foldEffect.of({ from: 5, to: 12 }) })
    await Promise.resolve()
    const placeholder = view.dom.querySelector('.cm-foldPlaceholder')
    expect(placeholder).toHaveAttribute('data-tooltip', '展开代码')
    expect(placeholder).not.toHaveAttribute('title')
    expect(view.state.doc.toString()).toBe('first\nsecond\nthird')
    view.dispatch({ effects: unfoldEffect.of({ from: 5, to: 12 }) })
    await Promise.resolve()
  }
})

it('adapts dynamic gutter labels without touching unrelated titles and disconnects on destroy', async () => {
  view = new EditorView({ parent: document.body, extensions: [codeMirrorTooltips] })
  const gutter = document.createElement('div')
  gutter.className = 'cm-foldGutter'
  gutter.innerHTML = '<span title="Fold line">⌄</span>'
  const unrelated = document.createElement('span')
  unrelated.title = 'Document content'
  view.dom.append(gutter, unrelated)
  await Promise.resolve()
  const marker = gutter.firstElementChild as HTMLElement
  expect(marker).toHaveAttribute('data-tooltip', '折叠代码')
  expect(marker).not.toHaveAttribute('title')
  marker.title = 'Unfold line'
  await Promise.resolve()
  expect(marker).toHaveAttribute('data-tooltip', '展开代码')
  expect(unrelated.title).toBe('Document content')
  view.destroy()
  view = undefined
  marker.title = 'Fold line'
  await Promise.resolve()
  expect(marker.title).toBe('Fold line')
})
