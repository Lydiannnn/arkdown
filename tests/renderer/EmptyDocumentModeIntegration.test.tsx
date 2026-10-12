import { act, cleanup, render, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { undo } from '@codemirror/commands'
import { createRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ArkdownApi } from '../../src/shared/contracts'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import { EditorPane, type EditorPaneHandle } from '../../src/renderer/editor/EditorPane'
import { useDocumentSession } from '../../src/renderer/editor/use-document-session'

// Exercise both production editors and the real session reducer; only the host boundary
// and absent jsdom geometry are substituted. No Electron/user files are accessed.
const originalApi = window.arkdown
const descriptors: Array<[object, string, PropertyDescriptor | undefined]> = []
let api: { saveDraft: ReturnType<typeof vi.fn>; cleanDraft: ReturnType<typeof vi.fn> }
let session: ReturnType<typeof useDocumentSession>
const pane = createRef<EditorPaneHandle>()
const changed = vi.fn()
const confirm = vi.fn(async () => 'cancel' as const)

beforeEach(() => {
  changed.mockClear(); confirm.mockClear()
  const rect = { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 20, width: 800, height: 20, toJSON: () => ({}) } as DOMRect
  const rects = { 0: rect, length: 1, item: () => rect, *[Symbol.iterator]() { yield rect } } as DOMRectList
  for (const [target, key, value] of [
    [Range.prototype, 'getBoundingClientRect', () => rect],
    [Range.prototype, 'getClientRects', () => rects],
    [Element.prototype, 'getClientRects', () => rects],
    [Element.prototype, 'scrollIntoView', () => undefined],
    [document, 'elementFromPoint', () => null],
  ] as const) {
    descriptors.push([target, key, Object.getOwnPropertyDescriptor(target, key)])
    Object.defineProperty(target, key, { configurable: true, value })
  }
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  api = {
    saveDraft: vi.fn(async () => ({ ok: true, value: null })),
    cleanDraft: vi.fn(async () => ({ ok: true, value: null })),
  }
  window.arkdown = {
    ...api,
    onAiConversationEvent: () => () => undefined,
    onTranslationEvent: () => () => undefined,
    getLargeModelSettings: async () => ({ ok: true, value: DEFAULT_LARGE_MODEL_SETTINGS }),
  } as unknown as ArkdownApi
})

afterEach(() => {
  cleanup()
  window.arkdown = originalApi
  for (const [target, key, descriptor] of descriptors.splice(0)) {
    if (descriptor) Object.defineProperty(target, key, descriptor)
    else Reflect.deleteProperty(target, key)
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

function Harness({ markdown }: { markdown: string }) {
  session = useDocumentSession(() => { pane.current?.flush() }, undefined, undefined, { confirm }, undefined, undefined, { markdown, displayName: 'synthetic-empty.md' })
  return <EditorPane ref={pane} documentKey="synthetic-empty" markdown={session.state.markdown}
    documentDisplayName="synthetic-empty.md" documentDirty={session.dirty}
    onChange={value => { changed(value); session.change(value) }} onOpenLargeModelSettings={() => undefined} />
}

function toggle() {
  act(() => { window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: 'toggle-source-mode' })) })
}

it.each(['', '\n\n  '])('roundtrips untouched empty/whitespace Markdown without edits, backups or a close prompt (%j)', async markdown => {
  const mounted = render(<Harness markdown={markdown} />)
  await waitFor(() => expect(mounted.container.querySelector('.ProseMirror')).not.toBeNull(), { timeout: 10_000 })
  toggle()
  await waitFor(() => expect(mounted.container.querySelector('.cm-editor')).not.toBeNull())
  const source = EditorView.findFromDOM(mounted.container.querySelector('.cm-editor') as HTMLElement)!
  expect(source.state.doc.toString()).toBe(markdown)
  toggle()
  await waitFor(() => expect(mounted.container.querySelector('.ProseMirror')).not.toBeNull())
  act(() => { pane.current!.flush() })
  await act(async () => { await session.backupDraft(); expect(await session.persistCurrentDocument('transition')).toEqual({ status: 'clean' }) })
  expect(changed).not.toHaveBeenCalled()
  expect(session.state.markdown).toBe(markdown)
  expect(session.dirty).toBe(false)
  expect(api.saveDraft).not.toHaveBeenCalled()
  expect(confirm).not.toHaveBeenCalled()
})

it('can type and undo back to empty in the real source editor, then return to visual mode cleanly', async () => {
  const mounted = render(<Harness markdown="" />)
  await waitFor(() => expect(mounted.container.querySelector('.ProseMirror')).not.toBeNull(), { timeout: 10_000 })
  toggle()
  await waitFor(() => expect(mounted.container.querySelector('.cm-editor')).not.toBeNull())
  const source = EditorView.findFromDOM(mounted.container.querySelector('.cm-editor') as HTMLElement)!
  act(() => { source.dispatch({ changes: { from: 0, insert: 'synthetic edit' } }) })
  expect(session.dirty).toBe(true)
  expect(session.state.markdown).toBe('synthetic edit')
  act(() => { expect(undo(source)).toBe(true) })
  expect(session.state.markdown).toBe('')
  expect(session.dirty).toBe(false)
  toggle()
  await waitFor(() => expect(mounted.container.querySelector('.ProseMirror')).not.toBeNull())
  act(() => { pane.current!.flush() })
  expect(session.state.markdown).toBe('')
  expect(session.dirty).toBe(false)
  expect(api.saveDraft).not.toHaveBeenCalled()
})
