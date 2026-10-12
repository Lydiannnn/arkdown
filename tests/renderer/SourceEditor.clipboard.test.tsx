import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { undo, redo } from '@codemirror/commands'
import { expect, it, vi } from 'vitest'
import { SourceEditor } from '../../src/renderer/editor/SourceEditor'

function mixedPaste(element: HTMLElement) {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { types: ['image/png', 'text/html', 'text/plain'], items: [{ kind: 'file', type: 'image/png' }], getData: () => 'UNWANTED' } })
  fireEvent(element, event)
  return event
}

it('inserts mixed clipboard image once at the captured range, in one undo step', async () => {
  let resolve!: (markdown: string) => void
  const readClipboardImage = vi.fn(() => new Promise<string>((done) => { resolve = done }))
  const rendered = render(<SourceEditor markdown="before after" documentKey="a" onChange={vi.fn()} readClipboardImage={readClipboardImage} />)
  const content = rendered.container.querySelector('.cm-content') as HTMLElement
  const view = EditorView.findFromDOM(content)!
  act(() => view.dispatch({ selection: { anchor: 7 } }))
  const event = mixedPaste(content)
  expect(event.defaultPrevented).toBe(true)
  expect(readClipboardImage).toHaveBeenCalledOnce()
  act(() => view.dispatch({ selection: { anchor: 0 } }))
  await act(async () => resolve('![](assets/clip.png)'))
  expect(view.state.doc.toString()).toBe('before ![](assets/clip.png)after')
  expect(readClipboardImage).toHaveBeenCalledOnce()
  act(() => { undo(view) })
  expect(view.state.doc.toString()).toBe('before after')
  act(() => { redo(view) })
  expect(view.state.doc.toString()).toBe('before ![](assets/clip.png)after')
})

it.each(['switch', 'switch-back', 'edit', 'unmount'] as const)('cancels delayed image paste after %s', async (change) => {
  let resolve!: (markdown: string) => void
  const readClipboardImage = vi.fn(() => new Promise<string>((done) => { resolve = done }))
  const onChange = vi.fn()
  const rendered = render(<SourceEditor markdown="before" documentKey="a" onChange={onChange} readClipboardImage={readClipboardImage} />)
  const content = rendered.container.querySelector('.cm-content') as HTMLElement
  const view = EditorView.findFromDOM(content)!
  mixedPaste(content)
  expect(readClipboardImage).toHaveBeenCalledOnce()
  if (change === 'switch') rendered.rerender(<SourceEditor markdown="other" documentKey="b" onChange={onChange} readClipboardImage={readClipboardImage} />)
  if (change === 'switch-back') {
    rendered.rerender(<SourceEditor markdown="before" documentKey="b" onChange={onChange} readClipboardImage={readClipboardImage} />)
    rendered.rerender(<SourceEditor markdown="before" documentKey="a" onChange={onChange} readClipboardImage={readClipboardImage} />)
  }
  if (change === 'edit') act(() => view.dispatch({ changes: { from: 0, insert: 'new ' } }))
  if (change === 'unmount') rendered.unmount()
  onChange.mockClear()
  await act(async () => resolve('![](assets/clip.png)'))
  expect(view.state.doc.toString()).not.toContain('clip.png')
  expect(onChange).not.toHaveBeenCalled()
})

it('demonstrates why a clipboard save must retire redo history, including an undone image', async () => {
  const props = { markdown: 'before', onChange: vi.fn(), readClipboardImage: async () => '![](temporary/clip.png)' }
  const rendered = render(<SourceEditor key="before-save" {...props} />)
  let content = rendered.container.querySelector('.cm-content') as HTMLElement
  let view = EditorView.findFromDOM(content)!
  await act(async () => { mixedPaste(content) })
  act(() => { undo(view) })
  rendered.rerender(<SourceEditor key="before-save" {...props} />)
  act(() => { redo(view) })
  expect(view.state.doc.toString()).toContain('temporary/clip.png')
  act(() => { undo(view) })
  rendered.rerender(<SourceEditor key="after-save" {...props} />)
  content = rendered.container.querySelector('.cm-content') as HTMLElement
  view = EditorView.findFromDOM(content)!
  act(() => { expect(redo(view)).toBe(false) })
  expect(view.state.doc.toString()).toBe('before')
})
