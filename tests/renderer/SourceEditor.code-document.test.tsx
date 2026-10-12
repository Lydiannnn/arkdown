import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { undo, redo } from '@codemirror/commands'
import { createRef, useState } from 'react'
import { expect, it, vi } from 'vitest'
import { SourceEditor, type SourceEditorHandle } from '../../src/renderer/editor/SourceEditor'
import { ContextMenuProvider } from '../../src/renderer/context-menu/ContextMenuProvider'
import { dispatchDocumentFind } from '../../src/renderer/editor/document-find-events'

Object.assign(Range.prototype, {
  getClientRects: () => [new DOMRect(0, 0, 1, 1)],
  getBoundingClientRect: () => new DOMRect(0, 0, 1, 1),
})

it('edits mixed-newline source without changing other boundaries after rerenders', async () => {
  let saved = ''
  function Editor() {
    const [text, setText] = useState('one\r\n\ttwo\nthree\r')
    saved = text
    return <SourceEditor markdown={text} documentPath="code.ts" plainText onChange={setText} />
  }
  const result = render(<Editor />)
  const view = EditorView.findFromDOM(result.container.querySelector('.cm-content')!)!
  act(() => view.dispatch({ changes: { from: 0, to: 3, insert: 'ONE' } }))
  expect(saved).toBe('ONE\r\n\ttwo\nthree\r')
  act(() => view.dispatch({ changes: { from: 4, insert: 'new\n' } }))
  expect(saved).toBe('ONE\r\nnew\r\n\ttwo\nthree\r')
})

it('returns to a Markdown source heading using live text and duplicate slugs without editing', () => {
  const ref = createRef<SourceEditorHandle>()
  const changed = vi.fn()
  const result = render(<SourceEditor ref={ref} markdown={'# Same\n\nBody\n\n## Same\n'} onChange={changed} />)
  const view = EditorView.findFromDOM(result.container.querySelector('.cm-content')!)!
  act(() => { expect(ref.current?.revealAnchor?.('same-1')).toBe(true) })
  expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(5)
  expect(ref.current?.revealAnchor?.('missing')).toBe(false)
  expect(changed).not.toHaveBeenCalled()
})

it('restores original mixed terminators when undoing a multi-line deletion', () => {
  let saved = ''
  function Editor() {
    const [text, setText] = useState('a\r\nb\nc\r')
    saved = text
    return <SourceEditor markdown={text} documentPath="code.ts" plainText onChange={setText} />
  }
  const result = render(<Editor />)
  const view = EditorView.findFromDOM(result.container.querySelector('.cm-content')!)!
  act(() => view.dispatch({ changes: { from: 0, to: 4, insert: '' } }))
  expect(saved).toBe('c\r')
  act(() => { undo(view) })
  expect(saved).toBe('a\r\nb\nc\r')
  act(() => { redo(view) })
  expect(saved).toBe('c\r')
})

it('finds code after CRLF boundaries using editor offsets and ignores preview focus', () => {
  const result = render(<SourceEditor markdown={'a\r\nb\r\nneedle'} documentPath="code.ts" plainText onChange={() => undefined} />)
  const view = EditorView.findFromDOM(result.container.querySelector('.cm-content')!)!
  act(() => dispatchDocumentFind({ type: 'query', query: 'needle' }))
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('needle')
  const preview = document.createElement('div')
  preview.className = 'document-view-panel'
  const input = preview.appendChild(document.createElement('input'))
  document.body.append(preview)
  input.focus()
  act(() => dispatchDocumentFind({ type: 'query', query: 'a' }))
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('needle')
  preview.remove()
})

it('pastes plain source from mixed clipboard data and rejects Markdown drop insertion', async () => {
  const ref = createRef<SourceEditorHandle>()
  const image = vi.fn(async () => '![](image.png)')
  const result = render(<SourceEditor ref={ref} markdown="" documentPath="a.json" plainText onChange={() => undefined} readClipboardImage={image} />)
  const content = result.container.querySelector<HTMLElement>('.cm-content')!
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { types: ['image/png', 'text/plain', 'text/html'], items: [{ kind: 'file', type: 'image/png' }], getData: (type: string) => type === 'text/plain' ? '<script>const a = `x`;</script>' : '' } })
  fireEvent(content, event)
  await waitFor(() => expect(EditorView.findFromDOM(content)!.state.doc.toString()).toBe('<script>const a = `x`;</script>'))
  expect(image).not.toHaveBeenCalled()
  expect(ref.current!.insertDroppedLink({ absolutePath: 'C:/x.md', kind: 'file', clientX: 0, clientY: 0 })).toBe(false)
  expect(ref.current!.insertDroppedMarkdown({ markdown: '**x**', clientX: 0, clientY: 0 })).toBe(false)
})

it('offers text commands without Markdown formatting commands for code', async () => {
  const result = render(<ContextMenuProvider><SourceEditor markdown="const a = 1" documentPath="a.ts" plainText onChange={() => undefined} /></ContextMenuProvider>)
  fireEvent.contextMenu(result.container.querySelector('.cm-content')!)
  await waitFor(() => expect(screen.getByRole('menuitem', { name: /^复制/ })).toBeInTheDocument())
  expect(screen.queryByRole('menuitem', { name: '加粗' })).not.toBeInTheDocument()
  expect(screen.queryByRole('menuitem', { name: '粘贴为 Markdown' })).not.toBeInTheDocument()
})
