import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef, StrictMode, Suspense, startTransition, useState } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { SourceEditor, type SourceEditorHandle } from '../../src/renderer/editor/SourceEditor'
import {
  sourceEditIndicatorGutter,
} from '../../src/renderer/editor/edit-indicators/source-edit-indicator-gutter'
import { codeMirrorTooltips } from '../../src/renderer/editor/codemirror-tooltips'
import { sourceFoldGutter } from '../../src/renderer/editor/edit-indicators/source-fold-gutter'

const codeMirror = vi.hoisted(() => ({
  extension: { name: 'markdown-extension' },
  lineWrapping: { name: 'line-wrapping-extension' },
  lineNumbers: { name: 'line-numbers-extension' },
  searchExtension: { name: 'search-extension' },
  languageCalls: 0,
  props: [] as Array<Record<string, unknown>>,
  dispatch: vi.fn(),
  findNext: vi.fn(),
  findPrevious: vi.fn(),
  setSearchQuery: vi.fn((query: unknown) => ({ query })),
  source: '',
  coords: new Map<number, { left: number; top: number; right: number; bottom: number }>(),
  focus: vi.fn(),
  sliceDoc: vi.fn(),
  coordsAtPos: vi.fn(),
  coordsForChar: vi.fn(),
  posAtCoords: vi.fn(),
  selection: { from: 0, to: 0, anchor: 0, head: 0 },
  view: null as null | {
    contentDOM: HTMLElement
    dom: HTMLElement
    scrollDOM: HTMLElement
    dispatch: typeof vi.fn
    focus: typeof vi.fn
    coordsAtPos: typeof vi.fn
    coordsForChar: typeof vi.fn
    posAtCoords: typeof vi.fn
    defaultCharacterWidth: number
    state: Record<string, unknown>
  },
}))

const sourceHistory = vi.hoisted(() => ({
  extension: { name: 'source-history-extension' },
  configure: vi.fn(),
  sync: vi.fn(),
  reveal: vi.fn(() => false),
  flush: vi.fn(() => []),
  capture: vi.fn(() => false),
  bind: vi.fn(),
  promote: vi.fn(() => null),
  discard: vi.fn(),
}))

vi.mock('../../src/renderer/editor/source-translation-history', () => ({
  sourceTranslationHistoryExtension: sourceHistory.extension,
  configureSourceTranslationHistoryView: sourceHistory.configure,
  syncSourceTranslationHistoryRecords: sourceHistory.sync,
  revealSourceTranslationHistoryRecord: sourceHistory.reveal,
  flushSourceTranslationHistoryAnchors: sourceHistory.flush,
  capturePendingSourceTranslationAnchor: sourceHistory.capture,
  bindPendingSourceTranslationAnchor: sourceHistory.bind,
  promotePendingSourceTranslationAnchor: sourceHistory.promote,
  discardPendingSourceTranslationAnchor: sourceHistory.discard,
}))

vi.mock('@codemirror/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@codemirror/state')>()
  return {
  ...actual,
  Compartment: class Compartment {
    of(extension: unknown) {
      return { kind: 'compartment', compartment: this, extension }
    }

    reconfigure(extension: unknown) {
      return { kind: 'reconfigure', compartment: this, extension }
    }
  },
}})

vi.mock('@codemirror/lang-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@codemirror/lang-markdown')>()
  return {
  ...actual,
  markdown: () => {
    codeMirror.languageCalls += 1
    return codeMirror.extension
  },
}})

vi.mock('@codemirror/view', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@codemirror/view')>()
  return {
  ...actual,
  EditorView: {
    lineWrapping: codeMirror.lineWrapping,
    contentAttributes: {
      of: (attributes: Record<string, string>) => ({
        kind: 'content-attributes',
        attributes,
      }),
    },
  },
  lineNumbers: () => codeMirror.lineNumbers,
}})

vi.mock('@codemirror/search', () => ({
  SearchQuery: class SearchQuery {
    constructor(public spec: unknown) {}
  },
  findNext: codeMirror.findNext,
  findPrevious: codeMirror.findPrevious,
  search: () => codeMirror.searchExtension,
  setSearchQuery: {
    of: codeMirror.setSearchQuery,
  },
}))

vi.mock('@uiw/react-codemirror', () => ({
  default: (props: {
    value?: string
    onChange?: (value: string, update: unknown) => void
    onCreateEditor?: (view: unknown) => void
    extensions?: unknown[]
    basicSetup?: unknown
    className?: string
  }) => {
    codeMirror.props.push(props)
    codeMirror.sliceDoc.mockImplementation(
      (from: number, to: number) => codeMirror.source.slice(from, to),
    )
    codeMirror.coordsAtPos.mockImplementation(
      (position: number) => codeMirror.coords.get(position) ?? null,
    )
    return (
      <textarea
        aria-label="Markdown source"
        className={`${props.className ?? ''} cm-content`}
        ref={(contentDOM) => {
          if (!contentDOM) return
          const compartment = props.extensions?.find((candidate) => (
            typeof candidate === 'object'
            && candidate !== null
            && (candidate as { kind?: string }).kind === 'compartment'
          )) as { extension?: { attributes?: Record<string, string> } } | undefined
          const spellcheck = compartment?.extension?.attributes?.spellcheck
          if (spellcheck) contentDOM.setAttribute('spellcheck', spellcheck)
          codeMirror.view ??= {
            contentDOM,
            dom: contentDOM,
            scrollDOM: contentDOM,
            dispatch: codeMirror.dispatch,
            focus: codeMirror.focus,
            coordsAtPos: codeMirror.coordsAtPos,
            coordsForChar: codeMirror.coordsForChar,
            posAtCoords: codeMirror.posAtCoords,
            defaultCharacterWidth: 8,
            state: {
              doc: {
                get length() { return Math.max(codeMirror.source.length, props.value?.length ?? 0) },
              },
              selection: { main: codeMirror.selection },
              sliceDoc: codeMirror.sliceDoc,
              historyToken: { id: 'history' },
              foldToken: { id: 'folds' },
            },
          }
          codeMirror.view.contentDOM = contentDOM
          codeMirror.view.dom = contentDOM
          codeMirror.view.scrollDOM = contentDOM
          props.onCreateEditor?.(codeMirror.view)
        }}
        value={props.value}
        onChange={(event) => props.onChange?.(event.target.value, {})}
      />
    )
  },
}))

beforeEach(() => {
  codeMirror.source = ''
  codeMirror.coords.clear()
  codeMirror.selection = { from: 0, to: 0, anchor: 0, head: 0 }
  codeMirror.view = null
  codeMirror.dispatch.mockReset()
  codeMirror.posAtCoords.mockReset()
  codeMirror.coordsForChar.mockReset()
  sourceHistory.configure.mockReset()
  sourceHistory.sync.mockReset()
  codeMirror.dispatch.mockImplementation((spec: { effects?: unknown }) => {
    const effect = spec.effects as { kind?: string; extension?: { attributes?: Record<string, string> } }
    if (effect?.kind !== 'reconfigure' || !codeMirror.view) return
    const spellcheck = effect.extension?.attributes?.spellcheck
    if (spellcheck) codeMirror.view.contentDOM.setAttribute('spellcheck', spellcheck)
  })
})

function firePointer(
  target: Element | Document,
  type: 'pointerdown' | 'pointerup',
  pointerId = 1,
  clientX = 0,
  clientY = 0,
): void {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY })
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: pointerId },
    pointerType: { value: 'mouse' },
  })
  fireEvent(target, event)
}

function firePointerMove(
  target: Element,
  clientX: number,
  clientY: number,
): void {
  const event = new MouseEvent('pointermove', { bubbles: true, clientX, clientY })
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: 1 },
    pointerType: { value: 'mouse' },
  })
  fireEvent(target, event)
}

it('passes live Markdown changes through a stable CodeMirror configuration', () => {
  const onChange = vi.fn()
  const view = render(<SourceEditor markdown="# One" onChange={onChange} />)
  const editor = screen.getByRole('textbox', { name: 'Markdown source' })
  const firstProps = codeMirror.props.at(-1)!

  fireEvent.change(editor, { target: { value: '# Typed' } })
  expect(onChange).toHaveBeenLastCalledWith('# Typed')

  view.rerender(<SourceEditor markdown="# External" onChange={onChange} />)
  const latestProps = codeMirror.props.at(-1)!

  expect(screen.getByRole('textbox', { name: 'Markdown source' })).toBe(editor)
  expect(editor).toHaveValue('# External')
  expect(latestProps.extensions).toBe(firstProps.extensions)
  expect(latestProps.basicSetup).toBe(firstProps.basicSetup)
  expect(codeMirror.languageCalls).toBe(1)
})

it('inserts a serialized dropped local link at the CodeMirror release point', () => {
  const ref = createRef<SourceEditorHandle>()
  render(<SourceEditor ref={ref} markdown="before after" onChange={vi.fn()} />)
  codeMirror.posAtCoords.mockReturnValue(7)

  expect(ref.current?.insertDroppedLink({
    absolutePath: 'C:\\Files\\raw file.bin',
    clientX: 90,
    clientY: 140,
    kind: 'file',
  })).toBe(true)

  expect(codeMirror.posAtCoords).toHaveBeenCalledWith({ x: 90, y: 140 })
  expect(codeMirror.dispatch).toHaveBeenCalledWith({
    changes: {
      from: 7,
      to: 7,
      insert: '[raw file.bin](<C:\\Files\\raw file.bin>)',
    },
    selection: { anchor: 7 + '[raw file.bin](<C:\\Files\\raw file.bin>)'.length },
  })
})

it('inserts dropped asset Markdown at the CodeMirror release point after the selection moves', () => {
  const ref = createRef<SourceEditorHandle>()
  render(<SourceEditor ref={ref} markdown="before after" onChange={vi.fn()} />)
  codeMirror.posAtCoords.mockReturnValue(7)
  codeMirror.selection = { from: 0, to: 6, anchor: 0, head: 6 }
  const handle = ref.current as (SourceEditorHandle & {
    insertDroppedMarkdown?(input: {
      markdown: string
      clientX: number
      clientY: number
      visualDropRequestId?: number
    }): boolean
  }) | null

  expect(handle?.insertDroppedMarkdown?.({
    markdown: '![photo](arkdown-asset:photo.png)',
    clientX: 90,
    clientY: 140,
  })).toBe(true)

  expect(codeMirror.posAtCoords).toHaveBeenCalledWith({ x: 90, y: 140 })
  expect(codeMirror.dispatch).toHaveBeenCalledWith({
    changes: {
      from: 7,
      to: 7,
      insert: '![photo](arkdown-asset:photo.png)',
    },
    selection: { anchor: 7 + '![photo](arkdown-asset:photo.png)'.length },
  })
})

it('keeps the full folder path as the source link label and href', () => {
  const ref = createRef<SourceEditorHandle>()
  render(<SourceEditor ref={ref} markdown="before after" onChange={vi.fn()} />)
  codeMirror.posAtCoords.mockReturnValue(7)

  expect(ref.current?.insertDroppedLink({
    absolutePath: 'C:\\Workspace Folder',
    clientX: 44,
    clientY: 88,
    kind: 'folder',
  })).toBe(true)

  const markdown = '[C:\\\\Workspace Folder](<C:\\Workspace Folder>)'
  expect(codeMirror.dispatch).toHaveBeenCalledWith({
    changes: { from: 7, to: 7, insert: markdown },
    selection: { anchor: 7 + markdown.length },
  })
})

it('keeps the source indicator payload out of its extension identity and dispatches it hot', () => {
  const view = render(
    <SourceEditor
      markdown="# One"
      lineIndicators={['saved']}
      showEditIndicators
      onChange={vi.fn()}
    />,
  )
  const firstProps = codeMirror.props.at(-1)!
  codeMirror.dispatch.mockClear()

  view.rerender(
    <SourceEditor
      markdown="# One"
      lineIndicators={['unsaved']}
      showEditIndicators={false}
      onChange={vi.fn()}
    />,
  )

  expect(codeMirror.props.at(-1)!.extensions).toBe(firstProps.extensions)
  expect(codeMirror.props.at(-1)!.basicSetup).toEqual(expect.objectContaining({
    lineNumbers: false,
    foldGutter: false,
  }))
  expect(codeMirror.dispatch).toHaveBeenCalledOnce()
})

it('installs the exact stable source extension order and immediately synchronizes its payload', () => {
  render(<SourceEditor markdown="# One" lineIndicators={['saved']} showEditIndicators onChange={vi.fn()} />)
  const extensions = codeMirror.props.at(-1)!.extensions as unknown[]
  expect(extensions).toEqual([
    expect.objectContaining({ value: expect.any(Function) }),
    sourceFoldGutter,
    codeMirrorTooltips,
    codeMirror.lineNumbers,
    sourceEditIndicatorGutter,
    codeMirror.extension,
    codeMirror.lineWrapping,
    codeMirror.searchExtension,
    expect.objectContaining({ kind: 'compartment' }),
    sourceHistory.extension,
  ])
  expect(codeMirror.dispatch).toHaveBeenCalledOnce()
  expect(codeMirror.dispatch.mock.calls[0]![0]).toEqual(expect.objectContaining({
    effects: expect.objectContaining({ value: { states: ['saved'], visible: true } }),
  }))
})

it('dispatches exactly one indicator effect for each independent model and visibility update', () => {
  const savedStates = Object.freeze(['saved'] as const)
  const unsavedStates = Object.freeze(['unsaved'] as const)
  const view = render(
    <SourceEditor markdown="# One" lineIndicators={savedStates} showEditIndicators onChange={vi.fn()} />,
  )
  codeMirror.dispatch.mockClear()

  view.rerender(
    <SourceEditor markdown="# One" lineIndicators={unsavedStates} showEditIndicators onChange={vi.fn()} />,
  )
  expect(codeMirror.dispatch).toHaveBeenCalledOnce()
  expect(codeMirror.dispatch.mock.calls[0]![0]).toEqual(expect.objectContaining({
    effects: expect.objectContaining({ value: { states: ['unsaved'], visible: true } }),
  }))

  codeMirror.dispatch.mockClear()
  view.rerender(
    <SourceEditor markdown="# One" lineIndicators={unsavedStates} showEditIndicators={false} onChange={vi.fn()} />,
  )
  expect(codeMirror.dispatch).toHaveBeenCalledOnce()
  expect(codeMirror.dispatch.mock.calls[0]![0]).toEqual(expect.objectContaining({
    effects: expect.objectContaining({ value: { states: ['unsaved'], visible: false } }),
  }))
})

it('keeps the editor, selection, undo/fold tokens and scroll while the indicator model changes hot', () => {
  codeMirror.source = '# unchanged'
  codeMirror.selection = { from: 2, to: 7, anchor: 2, head: 7 }
  const view = render(
    <SourceEditor markdown={codeMirror.source} lineIndicators={['saved']} showEditIndicators onChange={vi.fn()} />,
  )
  const editor = screen.getByRole<HTMLElement>('textbox', { name: 'Markdown source' })
  const editorView = codeMirror.view!
  const state = editorView.state
  editor.scrollTop = 47
  codeMirror.dispatch.mockClear()

  view.rerender(
    <SourceEditor markdown={codeMirror.source} lineIndicators={['unsaved']} showEditIndicators onChange={vi.fn()} />,
  )
  expect(screen.getByRole('textbox', { name: 'Markdown source' })).toBe(editor)
  expect(codeMirror.view).toBe(editorView)
  expect(codeMirror.view?.state).toBe(state)
  expect((codeMirror.view?.state.selection as { main: unknown }).main).toBe(codeMirror.selection)
  expect(codeMirror.view?.state.historyToken).toBe(state.historyToken)
  expect(codeMirror.view?.state.foldToken).toBe(state.foldToken)
  expect(editor.scrollTop).toBe(47)
  expect(codeMirror.dispatch).toHaveBeenCalledOnce()
})

it('does not dispatch an indicator update after SourceEditor unmounts', () => {
  function Host() {
    const [mounted, setMounted] = useState(true)
    const [states, setStates] = useState<readonly ('none' | 'saved' | 'unsaved')[]>(['saved'])
    return <>
      <button onClick={() => setMounted(false)}>unmount source</button>
      <button onClick={() => setStates(['unsaved'])}>change indicator model</button>
      {mounted && <SourceEditor markdown="# One" lineIndicators={states} showEditIndicators onChange={vi.fn()} />}
    </>
  }
  render(<Host />)
  fireEvent.click(screen.getByRole('button', { name: 'unmount source' }))
  codeMirror.dispatch.mockClear()
  fireEvent.click(screen.getByRole('button', { name: 'change indicator model' }))

  expect(codeMirror.dispatch).not.toHaveBeenCalled()
})

it('keeps CodeMirror onChange identity stable while invoking the newest parent callback', () => {
  const firstChange = vi.fn()
  const secondChange = vi.fn()
  const view = render(<SourceEditor markdown="# One" onChange={firstChange} />)
  const firstOnChange = codeMirror.props.at(-1)!.onChange as (value: string) => void

  view.rerender(<SourceEditor markdown="# One" onChange={secondChange} />)
  const latestOnChange = codeMirror.props.at(-1)!.onChange as (value: string) => void
  latestOnChange('# Newest')

  expect(latestOnChange).toBe(firstOnChange)
  expect(firstChange).not.toHaveBeenCalled()
  expect(secondChange).toHaveBeenCalledWith('# Newest')
})

it('owns one source scroll recorder and removes it when the real wrapper unmounts', () => {
  const add = vi.spyOn(HTMLElement.prototype, 'addEventListener')
  const remove = vi.spyOn(HTMLElement.prototype, 'removeEventListener')
  const view = render(<SourceEditor markdown="# One" onChange={vi.fn()} />)
  const editor = screen.getByRole('textbox', { name: 'Markdown source' })
  const addedScroll = add.mock.calls.filter((args, index) => (
    args[0] === 'scroll' && add.mock.contexts[index] === editor
  ))

  expect(addedScroll).toHaveLength(1)
  view.unmount()
  const removedScroll = remove.mock.calls.filter((args, index) => (
    args[0] === 'scroll' && remove.mock.contexts[index] === editor
  ))
  expect(removedScroll).toHaveLength(1)
})

it('reads hot source history ports without rebuilding the CodeMirror configuration', () => {
  const firstPort = {
    recordsForDocument: vi.fn(() => []),
    onAnchorsChanged: vi.fn(),
    onOpenRecord: vi.fn(),
  }
  const secondPort = {
    recordsForDocument: vi.fn(() => []),
    onAnchorsChanged: vi.fn(),
    onOpenRecord: vi.fn(),
  }
  const mounted = render(
    <SourceEditor
      documentKey="doc-a"
      markdown="# One"
      onChange={vi.fn()}
      translationHistory={firstPort}
    />,
  )
  const firstExtensions = codeMirror.props.at(-1)!.extensions

  mounted.rerender(
    <SourceEditor
      documentKey="doc-a"
      markdown="# One"
      onChange={vi.fn()}
      translationHistory={secondPort}
    />,
  )

  expect(firstPort.recordsForDocument).toHaveBeenCalledWith('doc-a')
  expect(secondPort.recordsForDocument).toHaveBeenCalledWith('doc-a')
  expect(codeMirror.props.at(-1)!.extensions).toBe(firstExtensions)
  expect(codeMirror.view).not.toBeNull()
})

it('returns a disconnected fallback while exposing unexpected source history errors', () => {
  const ref = createRef<SourceEditorHandle>()
  const translationHistory = {
    recordsForDocument: vi.fn(() => []),
    onAnchorsChanged: vi.fn(),
    onOpenRecord: vi.fn(),
  }
  render(
    <SourceEditor
      ref={ref}
      documentKey="doc-a"
      markdown="# One"
      onChange={vi.fn()}
      translationHistory={translationHistory}
    />,
  )
  const failure = new Error('source history reveal failed')
  sourceHistory.reveal.mockImplementationOnce(() => { throw failure })

  expect(() => ref.current?.revealTranslationHistoryRecord('record')).toThrow(failure)

  sourceHistory.reveal.mockClear()
  codeMirror.view!.dom.remove()
  expect(ref.current?.revealTranslationHistoryRecord('record')).toBe(false)
  expect(sourceHistory.reveal).not.toHaveBeenCalled()
})

it('reconfigures only spelling while preserving the CodeMirror view and editing state', () => {
  codeMirror.source = '# unchanged'
  codeMirror.selection = { from: 2, to: 7, anchor: 2, head: 7 }
  const onChange = vi.fn()
  const view = render(
    <SourceEditor markdown={codeMirror.source} onChange={onChange} spellCheckEnabled={false} />,
  )
  const content = document.querySelector<HTMLElement>('.cm-content')!
  const editorView = codeMirror.view!
  const state = editorView.state
  const selection = (state.selection as { main: unknown }).main
  const history = state.historyToken
  const folds = state.foldToken
  content.scrollTop = 47
  const extensions = codeMirror.props.at(-1)!.extensions
  codeMirror.dispatch.mockClear()

  view.rerender(
    <SourceEditor markdown={codeMirror.source} onChange={onChange} spellCheckEnabled />,
  )

  expect(document.querySelector('.cm-content')).toBe(content)
  expect(content).toHaveAttribute('spellcheck', 'true')
  expect(codeMirror.view).toBe(editorView)
  expect(codeMirror.view?.state).toBe(state)
  expect((codeMirror.view?.state.selection as { main: unknown }).main).toBe(selection)
  expect(codeMirror.view?.state.historyToken).toBe(history)
  expect(codeMirror.view?.state.foldToken).toBe(folds)
  expect(content.scrollTop).toBe(47)
  expect(codeMirror.props.at(-1)!.extensions).toBe(extensions)
  expect(codeMirror.props.at(-1)!.extensions).toContain(codeMirror.lineWrapping)
  expect(codeMirror.dispatch).toHaveBeenCalledOnce()
  expect(onChange).not.toHaveBeenCalled()
})

it('enables visual line wrapping without changing the Markdown value', () => {
  const onChange = vi.fn()
  const longLine = '这是一行只在显示区域内自动折行、但源码不应增加换行符的内容'
  render(<SourceEditor markdown={longLine} onChange={onChange} />)
  const props = codeMirror.props.at(-1)!

  expect(props.extensions).toContain(codeMirror.lineWrapping)
  expect(screen.getByRole('textbox', { name: 'Markdown source' })).toHaveValue(longLine)
})

it('searches the current source document and cycles matches', () => {
  const snapshots: unknown[] = []
  const onSnapshot = (event: Event) => snapshots.push((event as CustomEvent<unknown>).detail)
  window.addEventListener('arkdown:document-find-snapshot', onSnapshot)
  const view = render(<SourceEditor markdown="Alpha beta alpha" onChange={vi.fn()} />)

  window.dispatchEvent(new CustomEvent('arkdown:document-find', {
    detail: { type: 'query', query: 'alpha' },
  }))
  expect(codeMirror.setSearchQuery).toHaveBeenLastCalledWith(expect.objectContaining({
    spec: expect.objectContaining({
      search: 'alpha',
      caseSensitive: false,
      literal: true,
    }),
  }))
  expect(snapshots.at(-1)).toMatchObject({ query: 'alpha', current: 1, total: 2 })
  expect(codeMirror.dispatch).toHaveBeenCalledWith(expect.objectContaining({
    scrollIntoView: true,
    selection: { anchor: 0, head: 5 },
  }))

  window.dispatchEvent(new CustomEvent('arkdown:document-find', {
    detail: { type: 'next' },
  }))
  expect(snapshots.at(-1)).toMatchObject({ query: 'alpha', current: 2, total: 2 })

  window.dispatchEvent(new CustomEvent('arkdown:document-find', {
    detail: { type: 'previous' },
  }))
  expect(snapshots.at(-1)).toMatchObject({ query: 'alpha', current: 1, total: 2 })

  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown source' }), {
    target: { value: 'alpha only' },
  })
  expect(snapshots.at(-1)).toMatchObject({ query: 'alpha', current: 1, total: 1 })

  view.rerender(<SourceEditor markdown="alpha alpha alpha" onChange={vi.fn()} />)
  expect(snapshots.at(-1)).toMatchObject({ query: 'alpha', current: 1, total: 3 })

  window.dispatchEvent(new CustomEvent('arkdown:document-find', {
    detail: { type: 'close' },
  }))
  expect(codeMirror.setSearchQuery).toHaveBeenLastCalledWith(expect.objectContaining({
    spec: expect.objectContaining({ search: '' }),
  }))

  expect(codeMirror.props.at(-1)?.extensions).toContain(codeMirror.searchExtension)
  expect(codeMirror.props.at(-1)?.basicSetup).toEqual(expect.objectContaining({
    searchKeymap: false,
  }))
  view.unmount()
  window.removeEventListener('arkdown:document-find-snapshot', onSnapshot)
})

it('replaces a source selection when a dropped document lands inside it', () => {
  const ref = createRef<SourceEditorHandle>()
  codeMirror.selection = { from: 7, to: 12, anchor: 7, head: 12 }
  render(<SourceEditor ref={ref} markdown="before after" onChange={vi.fn()} />)
  codeMirror.posAtCoords.mockReturnValue(9)

  expect(ref.current?.insertDroppedLink({
    absolutePath: 'C:\\Files\\chapter.md',
    clientX: 90,
    clientY: 140,
    kind: 'file',
  })).toBe(true)

  const markdown = '[chapter.md](<C:\\Files\\chapter.md>)'
  expect(codeMirror.dispatch).toHaveBeenCalledWith({
    changes: { from: 7, to: 12, insert: markdown },
    selection: { anchor: 7 + markdown.length },
  })
})

it.each([
  { name: 'inside a wide CJK glyph', x: 79, y: 28, captures: true },
  { name: 'in the blank area after the glyph', x: 96, y: 28, captures: false },
  { name: 'above the glyph', x: 79, y: 12, captures: false },
])('uses rendered character bounds for a source selection starting $name', ({ x, y, captures }) => {
  codeMirror.source = '选择'
  codeMirror.selection = { from: 0, to: 2, anchor: 0, head: 2 }
  codeMirror.coords.set(0, { left: 60, right: 60, top: 20, bottom: 38 })
  codeMirror.coords.set(1, { left: 74, right: 74, top: 20, bottom: 38 })
  codeMirror.coords.set(2, { left: 88, right: 88, top: 20, bottom: 38 })
  const onTranslationSelection = vi.fn()
  render(<SourceEditor markdown={codeMirror.source} onChange={vi.fn()} onTranslationSelection={onTranslationSelection} />)
  codeMirror.view!.defaultCharacterWidth = 6.37
  codeMirror.posAtCoords.mockReturnValue(1)
  codeMirror.coordsForChar.mockImplementation((position: number) => position === 1
    ? { left: 74, right: 88, top: 20, bottom: 38 } : null)

  firePointer(screen.getByRole('textbox', { name: 'Markdown source' }), 'pointerdown', 11, x, y)
  firePointer(document, 'pointerup', 11, 88, 28)

  if (captures) {
    expect(onTranslationSelection).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      content: { markdown: '选择', plainText: '选择' },
      range: { from: 0, to: 2 }, mode: 'source',
    }))
  } else {
    expect(onTranslationSelection).not.toHaveBeenCalled()
  }
})

it('reports the exact Markdown slice and CodeMirror coordinate union without mutation', () => {
  codeMirror.source = 'Before **bold** after'
  codeMirror.selection = { from: 7, to: 15, anchor: 7, head: 15 }
  codeMirror.coords.set(7, { left: 10, top: 20, right: 11, bottom: 38 })
  codeMirror.coords.set(15, { left: 70, top: 20, right: 71, bottom: 38 })
  const onTranslationSelection = vi.fn()
  render(
    <SourceEditor
      markdown={codeMirror.source}
      onChange={vi.fn()}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  const editor = screen.getByRole('textbox', { name: 'Markdown source' })
  codeMirror.dispatch.mockClear()
  codeMirror.posAtCoords.mockReturnValue(7)

  firePointer(editor, 'pointerdown', 11, 10, 28)
  firePointer(document, 'pointerup', 11, 286, 174)

  expect(onTranslationSelection).toHaveBeenCalledWith({
    content: { markdown: '**bold**', plainText: 'bold' },
    range: { from: 7, to: 15 },
    mode: 'source',
    anchorRect: {
      left: 10,
      top: 20,
      right: 71,
      bottom: 38,
      width: 61,
      height: 18,
    },
    focusRect: {
      left: 70,
      top: 20,
      right: 71,
      bottom: 38,
      width: 1,
      height: 18,
    },
    releaseRect: {
      left: 286,
      top: 174,
      right: 286,
      bottom: 174,
      width: 0,
      height: 0,
    },
  })
  expect(codeMirror.dispatch).not.toHaveBeenCalled()
  expect(codeMirror.focus).not.toHaveBeenCalled()
})

it('reports a full-document translation beside the latest pointer immediately after Ctrl+A', async () => {
  codeMirror.source = '# Whole document'
  codeMirror.selection = {
    from: 0,
    to: codeMirror.source.length,
    anchor: 0,
    head: codeMirror.source.length,
  }
  codeMirror.coords.set(0, { left: 10, top: 20, right: 11, bottom: 38 })
  codeMirror.coords.set(codeMirror.source.length, {
    left: 140,
    top: 20,
    right: 141,
    bottom: 38,
  })
  const onTranslationSelection = vi.fn()
  render(
    <SourceEditor
      markdown={codeMirror.source}
      onChange={vi.fn()}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  const editor = screen.getByRole('textbox', { name: 'Markdown source' })

  firePointerMove(editor, 312, 188)
  fireEvent.keyDown(editor, { key: 'a', ctrlKey: true })
  await waitFor(() => expect(onTranslationSelection).toHaveBeenCalledOnce())

  expect(onTranslationSelection).toHaveBeenCalledOnce()
  expect(onTranslationSelection).toHaveBeenCalledWith(expect.objectContaining({
    content: { markdown: '# Whole document', plainText: 'Whole document' },
    mode: 'source',
    scope: 'document',
    releaseRect: {
      left: 312,
      top: 188,
      right: 312,
      bottom: 188,
      width: 0,
      height: 0,
    },
  }))

  onTranslationSelection.mockClear()
  fireEvent.keyDown(editor, { key: 'x' })

  expect(onTranslationSelection).toHaveBeenCalledOnce()
  expect(onTranslationSelection).toHaveBeenCalledWith(null)
})

it.each(['start', 'end', 'both'] as const)(
  'offers full-document translation with a virtualized %s endpoint using visible geometry',
  async (missing) => {
    codeMirror.source = Array.from({ length: 4000 }, (_, index) => `Line ${index}\n`).join('')
    codeMirror.selection = { from: 0, to: codeMirror.source.length, anchor: 0, head: codeMirror.source.length }
    if (missing === 'end') codeMirror.coords.set(0, { left: 10, top: 20, right: 11, bottom: 38 })
    if (missing === 'start') codeMirror.coords.set(codeMirror.source.length, { left: 10, top: 300, right: 11, bottom: 318 })
    const onTranslationSelection = vi.fn()
    render(<SourceEditor markdown={codeMirror.source} onChange={vi.fn()} onTranslationSelection={onTranslationSelection} />)
    const editor = screen.getByRole('textbox', { name: 'Markdown source' })
    vi.spyOn(codeMirror.view!.scrollDOM, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 600, 400))
    codeMirror.dispatch.mockClear()
    fireEvent.keyDown(editor, { key: 'a', ctrlKey: true })
    await waitFor(() => expect(onTranslationSelection).toHaveBeenCalled())
    expect(onTranslationSelection).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: 'document',
      content: expect.objectContaining({ markdown: codeMirror.source }),
      anchorRect: { left: 10, top: 20, right: 610, bottom: 420, width: 600, height: 400 },
    }))
    expect(codeMirror.dispatch).not.toHaveBeenCalled()
  },
)

it.each(['escape', 'document-switch', 'unmount', 'partial-selection'] as const)(
  'discards a queued full-document shortcut after %s',
  (invalidation) => {
    codeMirror.source = 'Whole document'
    codeMirror.selection = { from: 0, to: codeMirror.source.length, anchor: 0, head: codeMirror.source.length }
    const onTranslationSelection = vi.fn()
    const rendered = render(<SourceEditor documentKey="first.md" markdown={codeMirror.source} onChange={vi.fn()} onTranslationSelection={onTranslationSelection} />)
    let frame!: FrameRequestCallback
    const schedule = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frame = callback
      return 1
    })
    try {
      const editor = screen.getByRole('textbox', { name: 'Markdown source' })
      fireEvent.keyDown(editor, { key: 'a', ctrlKey: true })
      if (invalidation === 'escape') fireEvent.keyDown(editor, { key: 'Escape' })
      if (invalidation === 'document-switch') rendered.rerender(<SourceEditor documentKey="second.md" markdown={codeMirror.source} onChange={vi.fn()} onTranslationSelection={onTranslationSelection} />)
      if (invalidation === 'unmount') rendered.unmount()
      if (invalidation === 'partial-selection') codeMirror.selection.to -= 1
      act(() => frame(0))
      expect(onTranslationSelection.mock.calls.some(([selection]) => selection?.scope === 'document')).toBe(false)
    } finally {
      schedule.mockRestore()
    }
  },
)

it('exposes CodeMirror margin geometry without treating the full content width as text', () => {
  const ref = createRef<SourceEditorHandle>()
  render(<SourceEditor ref={ref} markdown="alpha omega" onChange={vi.fn()} />)
  const editor = screen.getByRole('textbox', { name: 'Markdown source' })
  const wrapper = editor.closest('.source-editor-context')!
  Object.defineProperties(editor, {
    clientWidth: { configurable: true, value: 388 },
    clientHeight: { configurable: true, value: 188 },
    scrollWidth: { configurable: true, value: 388 },
    scrollHeight: { configurable: true, value: 188 },
    getBoundingClientRect: {
      configurable: true,
      value: () => new DOMRect(0, 0, 400, 200),
    },
  })
  codeMirror.posAtCoords.mockReturnValue(5)
  codeMirror.coordsAtPos.mockReturnValue({ left: 100, top: 20, right: 101, bottom: 38 })
  const makeEvent = (x: number) => {
    const event = new MouseEvent('pointerdown', {
      bubbles: true, button: 0, clientX: x, clientY: 28,
    })
    Object.defineProperties(event, {
      isPrimary: { value: true }, pointerId: { value: 71 }, pointerType: { value: 'mouse' },
    })
    wrapper.dispatchEvent(event)
    return event as unknown as PointerEvent
  }
  const port = ref.current?.marginSelectionPort?.()

  expect(port).not.toBeNull()
  expect(port?.isEligibleMarginStart(makeEvent(300))).toBe(true)
  expect(port?.isEligibleMarginStart(makeEvent(102))).toBe(false)
  const activationPositionAtPoint = port?.activationPositionAtPoint
  expect(activationPositionAtPoint).toBeTypeOf('function')
  expect(activationPositionAtPoint?.({ clientX: 300, clientY: 28 })).toBeNull()
  expect(activationPositionAtPoint?.({ clientX: 102, clientY: 28 })).toBe(5)
  expect(port?.positionAtPoint({ clientX: 300, clientY: 28 })).toBe(5)
  expect(codeMirror.posAtCoords).toHaveBeenLastCalledWith({ x: 300, y: 28 }, false)

  codeMirror.dispatch.mockClear()
  port?.focus()
  port?.applySelection(2, 9)
  expect(codeMirror.focus).toHaveBeenCalled()
  expect(codeMirror.dispatch).toHaveBeenCalledWith({ selection: { anchor: 2, head: 9 } })
})

it('does not authorize a Source margin candidate that starts on the full-width content child', () => {
  codeMirror.source = 'Seeded source'
  codeMirror.selection = { from: 0, to: 6, anchor: 0, head: 6 }
  codeMirror.coords.set(0, { left: 5, top: 20, right: 6, bottom: 38 })
  codeMirror.coords.set(6, { left: 50, top: 20, right: 51, bottom: 38 })
  codeMirror.posAtCoords.mockReturnValue(6)
  codeMirror.coordsAtPos.mockReturnValue({ left: 50, top: 20, right: 51, bottom: 38 })
  const onTranslationSelection = vi.fn()
  render(
    <SourceEditor
      markdown={codeMirror.source}
      onChange={vi.fn()}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  const editor = screen.getByRole('textbox', { name: 'Markdown source' })
  const contentChild = editor.closest('.source-editor-context')!
    .appendChild(document.createElement('div'))
  contentChild.className = 'cm-content'
  if (!codeMirror.view) throw new Error('CodeMirror view unavailable')
  codeMirror.view.contentDOM = contentChild
  Object.defineProperties(editor, {
    clientWidth: { configurable: true, value: 388 },
    clientHeight: { configurable: true, value: 188 },
    scrollWidth: { configurable: true, value: 388 },
    scrollHeight: { configurable: true, value: 188 },
    getBoundingClientRect: {
      configurable: true,
      value: () => new DOMRect(0, 0, 400, 200),
    },
  })

  firePointer(contentChild, 'pointerdown', 73, 300, 28)
  firePointer(document, 'pointerup', 73, 300, 28)

  expect(onTranslationSelection).not.toHaveBeenCalled()
  expect(codeMirror.sliceDoc).not.toHaveBeenCalled()

  const preventedCandidate = new MouseEvent('pointerdown', {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX: 300,
    clientY: 28,
  })
  Object.defineProperties(preventedCandidate, {
    isPrimary: { value: true },
    pointerId: { value: 74 },
    pointerType: { value: 'mouse' },
  })
  preventedCandidate.preventDefault()
  fireEvent(contentChild, preventedCandidate)
  firePointer(document, 'pointerup', 74, 300, 28)

  expect(onTranslationSelection).not.toHaveBeenCalled()
  expect(codeMirror.sliceDoc).not.toHaveBeenCalled()
})

it('authorizes an activated source margin gesture for the existing translation exporter', () => {
  const ref = createRef<SourceEditorHandle>()
  codeMirror.source = 'Margin source'
  codeMirror.selection = { from: 0, to: 6, anchor: 0, head: 6 }
  codeMirror.coords.set(0, { left: 5, top: 8, right: 6, bottom: 24 })
  codeMirror.coords.set(6, { left: 50, top: 8, right: 51, bottom: 24 })
  const onTranslationSelection = vi.fn()
  render(
    <SourceEditor
      ref={ref}
      markdown={codeMirror.source}
      onChange={vi.fn()}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  const down = new MouseEvent('pointerdown', { bubbles: true, button: 0 })
  Object.defineProperties(down, {
    isPrimary: { value: true }, pointerId: { value: 72 }, pointerType: { value: 'mouse' },
  })

  ref.current?.marginSelectionPort?.()?.beginPointerSelection(down as unknown as PointerEvent)
  firePointer(document, 'pointerup', 72, 260, 170)

  expect(onTranslationSelection).toHaveBeenCalledWith(expect.objectContaining({
    content: { markdown: 'Margin', plainText: 'Margin' },
    mode: 'source',
  }))
})

it('reports short source selections in source mode', () => {
  codeMirror.source = 'x'
  codeMirror.selection = { from: 0, to: 1, anchor: 0, head: 1 }
  codeMirror.coords.set(0, { left: 4, top: 8, right: 5, bottom: 24 })
  codeMirror.coords.set(1, { left: 12, top: 8, right: 13, bottom: 24 })
  const onTranslationSelection = vi.fn()
  render(
    <SourceEditor
      markdown="x"
      onChange={vi.fn()}
      onTranslationSelection={onTranslationSelection}
    />,
  )

  const editor = screen.getByRole('textbox', { name: 'Markdown source' })
  codeMirror.posAtCoords.mockReturnValue(0)
  firePointer(editor, 'pointerdown', 1, 4, 16)
  firePointer(editor, 'pointerup')

  expect(onTranslationSelection).toHaveBeenCalledWith(expect.objectContaining({
    content: { markdown: 'x', plainText: 'x' },
    mode: 'source',
  }))
})

it('ignores programmatic and keyboard-originated source selections', () => {
  codeMirror.source = 'selected'
  codeMirror.selection = { from: 0, to: 8, anchor: 0, head: 8 }
  const onTranslationSelection = vi.fn()
  render(
    <SourceEditor
      markdown={codeMirror.source}
      onChange={vi.fn()}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  const editor = screen.getByRole('textbox', { name: 'Markdown source' })

  fireEvent(document, new Event('selectionchange', { bubbles: true }))
  firePointer(editor, 'pointerdown')
  fireEvent.keyDown(editor, { key: 'ArrowRight', shiftKey: true })
  firePointer(editor, 'pointerup')

  expect(onTranslationSelection).not.toHaveBeenCalled()
  expect(codeMirror.sliceDoc).not.toHaveBeenCalled()
})

it('does not capture a seeded source selection from a wrapper blank gesture', () => {
  codeMirror.source = 'Seeded source'
  codeMirror.selection = { from: 0, to: 6, anchor: 0, head: 6 }
  codeMirror.coords.set(0, { left: 5, top: 8, right: 6, bottom: 24 })
  codeMirror.coords.set(6, { left: 50, top: 8, right: 51, bottom: 24 })
  const onTranslationSelection = vi.fn()
  render(
    <SourceEditor
      markdown={codeMirror.source}
      onChange={vi.fn()}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  const editor = screen.getByRole('textbox', { name: 'Markdown source' })
  const wrapper = editor.closest('.source-editor-context')!

  firePointer(wrapper, 'pointerdown', 30)
  firePointer(wrapper, 'pointerup', 30)

  expect(onTranslationSelection).not.toHaveBeenCalled()
  expect(codeMirror.sliceDoc).not.toHaveBeenCalled()
})

it('keeps a source gesture armed across focus movement inside the editor', () => {
  codeMirror.source = 'Internal focus'
  codeMirror.selection = { from: 0, to: 8, anchor: 0, head: 8 }
  codeMirror.coords.set(0, { left: 5, top: 8, right: 6, bottom: 24 })
  codeMirror.coords.set(8, { left: 60, top: 8, right: 61, bottom: 24 })
  const onTranslationSelection = vi.fn()
  render(
    <SourceEditor
      markdown={codeMirror.source}
      onChange={vi.fn()}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  const editor = screen.getByRole('textbox', { name: 'Markdown source' })
  const wrapper = editor.closest('.source-editor-context')!
  const internalControl = wrapper.appendChild(document.createElement('button'))
  codeMirror.posAtCoords.mockReturnValue(0)

  firePointer(editor, 'pointerdown', 31, 5, 16)
  fireEvent.blur(editor, { relatedTarget: internalControl })
  firePointer(editor, 'pointerup', 31)

  expect(onTranslationSelection).toHaveBeenCalledOnce()
  expect(onTranslationSelection).toHaveBeenCalledWith(expect.objectContaining({
    content: { markdown: 'Internal', plainText: 'Internal' },
    mode: 'source',
  }))
})

it('invalidates a source gesture when focus leaves the editor', () => {
  codeMirror.source = 'External focus'
  codeMirror.selection = { from: 0, to: 8, anchor: 0, head: 8 }
  codeMirror.coords.set(0, { left: 5, top: 8, right: 6, bottom: 24 })
  codeMirror.coords.set(8, { left: 60, top: 8, right: 61, bottom: 24 })
  const onTranslationSelection = vi.fn()
  render(
    <SourceEditor
      markdown={codeMirror.source}
      onChange={vi.fn()}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  const editor = screen.getByRole('textbox', { name: 'Markdown source' })
  const externalControl = document.body.appendChild(document.createElement('button'))

  firePointer(editor, 'pointerdown', 32)
  fireEvent.blur(editor, { relatedTarget: externalControl })
  firePointer(editor, 'pointerup', 32)

  expect(onTranslationSelection).not.toHaveBeenCalled()
})

it('applies an AI replacement as one undoable CodeMirror transaction and makes stale plans inert', async () => {
  const ref = createRef<SourceEditorHandle>()
  const onChange = vi.fn()
  codeMirror.source = '# Before'
  const rendered = render(
    <SourceEditor ref={ref} documentKey="doc-a" markdown={codeMirror.source} onChange={onChange} />,
  )
  Object.defineProperty(codeMirror.view!.state.doc, 'toString', {
    configurable: true,
    value: () => codeMirror.source,
  })
  codeMirror.dispatch.mockClear()
  codeMirror.dispatch.mockImplementation((spec: { changes?: { from: number; to: number; insert: string } }) => {
    if (!spec.changes) return
    codeMirror.source = codeMirror.source.slice(0, spec.changes.from)
      + spec.changes.insert
      + codeMirror.source.slice(spec.changes.to)
    ;(codeMirror.props.at(-1)?.onChange as ((value: string, update: unknown) => void) | undefined)?.(
      codeMirror.source,
      {},
    )
  })
  const port = ref.current!.createWorkspaceAiEditorPort!()
  const capture = await port.captureReadSnapshot({})
  if (capture.status !== 'captured') throw new Error('capture failed')
  const input = {
    operationId: 'source-operation',
    expectedEditorRevision: capture.editorRevision,
    expectedContentHash: capture.contentHash,
    replacementMarkdown: '---\ntitle: AI\n---\n\n```ts\nconst answer = 42\n```\n',
  }
  expect((await port.planReplacement(input)).status).toBe('planned')

  const applied = await port.applyTransaction(input)

  expect(applied).toEqual(expect.objectContaining({
    status: 'applied',
    editorRevision: capture.editorRevision + 1,
    dirty: true,
  }))
  expect(codeMirror.dispatch).toHaveBeenCalledTimes(1)
  expect(codeMirror.dispatch).toHaveBeenCalledWith({
    changes: {
      from: 0,
      to: '# Before'.length,
      insert: input.replacementMarkdown,
    },
  })
  expect(onChange).toHaveBeenCalledOnce()
  expect(onChange).toHaveBeenCalledWith(input.replacementMarkdown)
  await expect(port.applyTransaction(input)).resolves.toEqual(applied)
  expect(codeMirror.dispatch).toHaveBeenCalledTimes(1)

  const nextCapture = await port.captureReadSnapshot({})
  expect(nextCapture).toEqual(expect.objectContaining({
    status: 'captured',
    editorRevision: capture.editorRevision + 1,
    markdown: input.replacementMarkdown,
    dirty: true,
  }))

  rendered.rerender(
    <SourceEditor ref={ref} documentKey="doc-b" markdown={input.replacementMarkdown} onChange={onChange} />,
  )
  await expect(port.captureReadSnapshot({}))
    .resolves.toEqual({ status: 'stale' })

  rendered.unmount()
  await act(async () => {
    await expect(port.captureReadSnapshot({}))
      .resolves.toEqual({ status: 'stale' })
  })
})

it('captures the trusted source session dirty state and observes a save reset', async () => {
  const ref = createRef<SourceEditorHandle>()
  codeMirror.source = 'dirty source'
  const rendered = render(
    <SourceEditor ref={ref} documentKey="doc-dirty" dirty markdown={codeMirror.source} onChange={vi.fn()} />,
  )
  Object.defineProperty(codeMirror.view!.state.doc, 'toString', {
    configurable: true,
    value: () => codeMirror.source,
  })
  const port = ref.current!.createWorkspaceAiEditorPort!()
  await expect(port.captureReadSnapshot({}))
    .resolves.toEqual(expect.objectContaining({ status: 'captured', dirty: true }))

  rendered.rerender(
    <SourceEditor ref={ref} documentKey="doc-dirty" dirty={false} markdown={codeMirror.source} onChange={vi.fn()} />,
  )
  await expect(port.captureReadSnapshot({}))
    .resolves.toEqual(expect.objectContaining({ status: 'captured', dirty: false }))
})

it('keeps a fresh AI port usable through the StrictMode effect replay and stales it on unmount', async () => {
  const ref = createRef<SourceEditorHandle>()
  codeMirror.source = 'Strict source'
  const rendered = render(
    <StrictMode>
      <SourceEditor ref={ref} documentKey="strict-doc" markdown={codeMirror.source} onChange={vi.fn()} />
    </StrictMode>,
  )
  Object.defineProperty(codeMirror.view!.state.doc, 'toString', {
    configurable: true,
    value: () => codeMirror.source,
  })
  codeMirror.dispatch.mockImplementation((spec: { changes?: { insert: string } }) => {
    if (spec.changes) codeMirror.source = spec.changes.insert
  })
  const port = ref.current!.createWorkspaceAiEditorPort!()
  const capture = await port.captureReadSnapshot({})
  if (capture.status !== 'captured') throw new Error(`strict capture: ${capture.status}`)
  const input = {
    operationId: 'strict-source-operation',
    expectedEditorRevision: capture.editorRevision,
    expectedContentHash: capture.contentHash,
    replacementMarkdown: 'Strict replacement',
  }
  expect((await port.planReplacement(input)).status).toBe('planned')
  expect((await port.applyTransaction(input)).status).toBe('applied')

  rendered.unmount()
  await expect(port.captureReadSnapshot({}))
    .resolves.toEqual({ status: 'stale' })
})

it('does not replace the committed source adapter during an abandoned suspended render', async () => {
  const ref = createRef<SourceEditorHandle>()
  let switchDocument!: (documentKey: string) => void
  const never = new Promise<void>(() => undefined)
  function SuspendOnNextDocument({ documentKey }: { documentKey: string }) {
    if (documentKey === 'doc-b') throw never
    return null
  }
  function Harness() {
    const [documentKey, setDocumentKey] = useState('doc-a')
    switchDocument = setDocumentKey
    return (
      <Suspense fallback={<div>loading</div>}>
        <SourceEditor ref={ref} documentKey={documentKey} markdown="committed" onChange={vi.fn()} />
        <SuspendOnNextDocument documentKey={documentKey} />
      </Suspense>
    )
  }
  codeMirror.source = 'committed'
  const rendered = render(<Harness />)
  Object.defineProperty(codeMirror.view!.state.doc, 'toString', {
    configurable: true,
    value: () => codeMirror.source,
  })
  const port = ref.current!.createWorkspaceAiEditorPort!()

  await act(async () => {
    startTransition(() => switchDocument('doc-b'))
    await Promise.resolve()
  })

  await expect(port.captureReadSnapshot({})).resolves.toEqual(expect.objectContaining({
    status: 'captured',
    markdown: 'committed',
  }))
  rendered.unmount()
  await expect(port.captureReadSnapshot({})).resolves.toEqual({ status: 'stale' })
})
