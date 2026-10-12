import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_STICKY_NOTE_PREFERENCES } from '../../src/shared/sticky-note-preferences'
import { createRef, forwardRef, useImperativeHandle } from 'react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { ContextMenuProvider } from '../../src/renderer/context-menu/ContextMenuProvider'
import { BusinessDialogProvider } from '../../src/renderer/modal/BusinessDialogProvider'
import { StickyNoteEditor } from '../../src/renderer/sticky-notes/StickyNoteEditor'
import type { VisualEditorHandle } from '../../src/renderer/editor/VisualEditor'

const contextMenuStyle = document.createElement('style')
contextMenuStyle.textContent = readFileSync(
  path.join(process.cwd(), 'src/renderer/context-menu/context-menu.css'),
  'utf8',
)

beforeAll(() => document.head.append(contextMenuStyle))
afterAll(() => contextMenuStyle.remove())

const visualEditorHandle = vi.hoisted(() => ({
  whenRenderIdle: vi.fn(async () => undefined),
  captureSelection: vi.fn(() => true),
  insertMarkdown: vi.fn(() => true),
  selectedBlockStyle: vi.fn<VisualEditorHandle['selectedBlockStyle']>(() => 'paragraph'),
  setSelectedBlockStyle: vi.fn(() => true),
  revealTranslationHistoryRecord: vi.fn(() => true),
  flushTranslationHistoryAnchors: vi.fn(() => []),
  capturePendingTranslationAnchor: vi.fn(() => true),
  bindPendingTranslationAnchor: vi.fn(),
  promotePendingTranslationAnchor: vi.fn(() => ({
    mode: 'visual' as const,
    from: 1,
    to: 6,
    blockStart: 0,
    fingerprint: { before: '', selected: 'alpha', after: '' },
    status: 'valid' as const,
  })),
  discardPendingTranslationAnchor: vi.fn(),
  domRange: null as Range | null,
}))

vi.mock('../../src/renderer/editor/VisualEditor', () => ({
  VisualEditor: forwardRef<VisualEditorHandle, { markdown: string; onChange(markdown: string): void }>(
    function FakeVisualEditor({ markdown }, ref) {
      useImperativeHandle(ref, () => ({
        flush: () => markdown,
        whenRenderIdle: visualEditorHandle.whenRenderIdle,
        captureSelection: () => {
          const selection = window.getSelection()
          if (!visualEditorHandle.domRange && selection?.rangeCount === 1) {
            visualEditorHandle.domRange = selection.getRangeAt(0).cloneRange()
          }
          const captured = visualEditorHandle.captureSelection()
          if (visualEditorHandle.domRange && selection) {
            selection.removeAllRanges()
            selection.addRange(visualEditorHandle.domRange)
          }
          return captured
        },
        insertMarkdown: visualEditorHandle.insertMarkdown,
        selectedBlockStyle: visualEditorHandle.selectedBlockStyle,
        setSelectedBlockStyle: visualEditorHandle.setSelectedBlockStyle,
        revealTranslationHistoryRecord: visualEditorHandle.revealTranslationHistoryRecord,
        flushTranslationHistoryAnchors: visualEditorHandle.flushTranslationHistoryAnchors,
        capturePendingTranslationAnchor: visualEditorHandle.capturePendingTranslationAnchor,
        bindPendingTranslationAnchor: visualEditorHandle.bindPendingTranslationAnchor,
        promotePendingTranslationAnchor: visualEditorHandle.promotePendingTranslationAnchor,
        discardPendingTranslationAnchor: visualEditorHandle.discardPendingTranslationAnchor,
      }))
      return <div
        aria-label="content"
        className="ProseMirror"
        contentEditable
        onFocus={() => {
          const selection = window.getSelection()
          if (!selection || !visualEditorHandle.domRange) return
          selection.removeAllRanges()
          selection.addRange(visualEditorHandle.domRange)
        }}
        suppressContentEditableWarning
      ><p><span>alpha</span> <span>beta</span></p><p data-single-text="true">alpha beta</p><p data-empty="true"><br /></p><hr data-arkdown-style="blue" data-arkdown-height="2" data-arkdown-opacity="40" /></div>
    },
  ),
}))

afterEach(() => {
  window.getSelection()?.removeAllRanges()
  visualEditorHandle.whenRenderIdle.mockClear().mockResolvedValue(undefined)
  visualEditorHandle.captureSelection.mockClear().mockReturnValue(true)
  visualEditorHandle.insertMarkdown.mockClear().mockReturnValue(true)
  visualEditorHandle.selectedBlockStyle.mockClear().mockReturnValue('paragraph')
  visualEditorHandle.setSelectedBlockStyle.mockClear().mockReturnValue(true)
  visualEditorHandle.revealTranslationHistoryRecord.mockClear().mockReturnValue(true)
  visualEditorHandle.flushTranslationHistoryAnchors.mockClear().mockReturnValue([])
  visualEditorHandle.capturePendingTranslationAnchor.mockClear().mockReturnValue(true)
  visualEditorHandle.bindPendingTranslationAnchor.mockClear()
  visualEditorHandle.promotePendingTranslationAnchor.mockClear()
  visualEditorHandle.discardPendingTranslationAnchor.mockClear()
  visualEditorHandle.domRange = null
  vi.restoreAllMocks()
})

it('forwards the required Mermaid render-idle barrier to the inner visual editor', async () => {
  const ref = createRef<VisualEditorHandle>()
  render(<StickyNoteEditor ref={ref} markdown="alpha" onChange={vi.fn()} />)

  expect(ref.current?.whenRenderIdle).toBeTypeOf('function')
  await ref.current!.whenRenderIdle()
  expect(visualEditorHandle.whenRenderIdle).toHaveBeenCalledOnce()
})

function select(node: Node, start: number, end: number) {
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

Object.assign(Range.prototype, {
  getClientRects(this: Range) {
    const text = this.startContainer instanceof Text ? this.startContainer.data : ''
    if (text === 'alpha beta') {
      const left = this.startOffset * 10
      const right = this.collapsed ? left : this.endOffset * 10
      return [{ left, top: 0, right, bottom: 20, width: right - left, height: 20 }]
    }
    const left = text === 'beta' ? 60 : 0
    const right = this.collapsed ? left : left + 50
    return [{ left, top: 0, right, bottom: 20, width: right - left, height: 20 }]
  },
})

function installCaretRange(node: Node, offset: number) {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  Object.defineProperty(document, 'caretRangeFromPoint', { configurable: true, value: () => range })
}

it('forwards every translation history handle method to the inner visual editor', () => {
  const ref = createRef<VisualEditorHandle>()
  render(<StickyNoteEditor ref={ref} markdown="alpha" onChange={vi.fn()} />)

  expect.soft(ref.current?.revealTranslationHistoryRecord).toBeTypeOf('function')
  expect.soft(ref.current?.flushTranslationHistoryAnchors).toBeTypeOf('function')
  expect.soft(ref.current?.capturePendingTranslationAnchor).toBeTypeOf('function')
  expect.soft(ref.current?.bindPendingTranslationAnchor).toBeTypeOf('function')
  expect.soft(ref.current?.promotePendingTranslationAnchor).toBeTypeOf('function')
  expect.soft(ref.current?.discardPendingTranslationAnchor).toBeTypeOf('function')
  if (
    !ref.current?.revealTranslationHistoryRecord
    || !ref.current.flushTranslationHistoryAnchors
    || !ref.current.capturePendingTranslationAnchor
    || !ref.current.bindPendingTranslationAnchor
    || !ref.current.promotePendingTranslationAnchor
    || !ref.current.discardPendingTranslationAnchor
  ) return

  expect(ref.current.revealTranslationHistoryRecord('record-1')).toBe(true)
  expect(ref.current.flushTranslationHistoryAnchors()).toEqual([])
  expect(ref.current.capturePendingTranslationAnchor('pending-1')).toBe(true)
  ref.current.bindPendingTranslationAnchor('pending-1', 'request-1')
  expect(ref.current.promotePendingTranslationAnchor('request-1')).toMatchObject({ from: 1, to: 6 })
  ref.current.discardPendingTranslationAnchor('pending-1')

  expect(visualEditorHandle.revealTranslationHistoryRecord).toHaveBeenCalledWith('record-1')
  expect(visualEditorHandle.flushTranslationHistoryAnchors).toHaveBeenCalledOnce()
  expect(visualEditorHandle.capturePendingTranslationAnchor).toHaveBeenCalledWith('pending-1')
  expect(visualEditorHandle.bindPendingTranslationAnchor).toHaveBeenCalledWith('pending-1', 'request-1')
  expect(visualEditorHandle.promotePendingTranslationAnchor).toHaveBeenCalledWith('request-1')
  expect(visualEditorHandle.discardPendingTranslationAnchor).toHaveBeenCalledWith('pending-1')
})

it('places a caret and opens the blank menu when right-clicking outside the current selection', () => {
  render(<ContextMenuProvider><StickyNoteEditor markdown="alpha beta" onChange={vi.fn()} /></ContextMenuProvider>)
  const editor = screen.getByLabelText('content')
  const alpha = editor.querySelector('span')!.firstChild!
  const beta = editor.querySelectorAll('span')[1]!.firstChild!
  select(alpha, 0, 5)
  installCaretRange(beta, 2)

  fireEvent.contextMenu(editor.querySelectorAll('span')[1]!, { clientX: 70, clientY: 10 })

  expect(window.getSelection()?.isCollapsed).toBe(true)
  expect(screen.getByRole('menu')).toHaveStyle({ width: '200px', left: '76px' })
  expect(screen.getByRole('menu')).not.toHaveClass('context-menu-root-no-icon-gutter')
  const insertImage = screen.getByRole('menuitem', { name: '\u63d2\u5165\u56fe\u7247' })
  expect(getComputedStyle(insertImage).gridTemplateColumns).toBe('24px minmax(0, 1fr) auto')
  expect(screen.getByRole('menuitem', { name: '插入图片' })).toBeVisible()
  expect(screen.queryByRole('menuitem', { name: '复制' })).not.toBeInTheDocument()
})
it('captures the ProseMirror selection and executes checked paragraph commands', async () => {
  visualEditorHandle.selectedBlockStyle.mockReturnValue('heading-4')
  render(<ContextMenuProvider><StickyNoteEditor markdown="alpha beta" onChange={vi.fn()} /></ContextMenuProvider>)
  const editor = screen.getByLabelText('content')

  const openParagraphMenu = () => {
    fireEvent.contextMenu(editor, { clientX: 200, clientY: 120 })
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: '段落' }).parentElement!)
  }
  openParagraphMenu()
  expect(visualEditorHandle.captureSelection).toHaveBeenCalledOnce()
  const menus = screen.getAllByRole('menu')
  expect(menus).toHaveLength(2)
  expect(menus[1]).toHaveStyle({ width: '200px' })
  expect(visualEditorHandle.selectedBlockStyle).toHaveBeenCalledOnce()
  expect(screen.getByRole('menuitemcheckbox', { name: '标题' })).toHaveAttribute('aria-checked', 'true')
  expect(screen.getByRole('menuitemcheckbox', { name: '正文' })).toHaveAttribute('aria-checked', 'false')
  expect(screen.getByRole('menuitemcheckbox', { name: '附注' })).toHaveAttribute('aria-checked', 'false')

  screen.getByRole('menuitemcheckbox', { name: '标题' }).click()
  await waitFor(() => expect(visualEditorHandle.setSelectedBlockStyle).toHaveBeenLastCalledWith('heading-4'))
  openParagraphMenu()
  screen.getByRole('menuitemcheckbox', { name: '正文' }).click()
  await waitFor(() => expect(visualEditorHandle.setSelectedBlockStyle).toHaveBeenLastCalledWith('paragraph'))
  openParagraphMenu()
  screen.getByRole('menuitemcheckbox', { name: '附注' }).click()
  await waitFor(() => expect(visualEditorHandle.setSelectedBlockStyle).toHaveBeenLastCalledWith('blockquote'))
})

it('inserts the clipboard text exactly through the captured editor handle', async () => {
  const readText = vi.fn().mockResolvedValue('alpha\nbeta')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } })
  const onChange = vi.fn()
  const globalInsert = vi.fn()
  window.addEventListener('arkdown:insert-markdown', globalInsert)
  try {
    render(<ContextMenuProvider><StickyNoteEditor markdown="unchanged" onChange={onChange} /></ContextMenuProvider>)
    fireEvent.contextMenu(screen.getByLabelText('content'), { clientX: 200, clientY: 120 })
    screen.getByRole('menuitem', { name: '粘贴' }).click()

    await waitFor(() => expect(visualEditorHandle.insertMarkdown).toHaveBeenCalledWith('alpha\nbeta'))
    expect(readText).toHaveBeenCalledOnce()
    expect(globalInsert).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  } finally {
    window.removeEventListener('arkdown:insert-markdown', globalInsert)
  }
})

it('leaves Markdown unchanged and prompts for Ctrl+V when clipboard reading fails', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText: vi.fn().mockRejectedValue(new Error('denied')) },
  })
  const onChange = vi.fn()
  render(
    <BusinessDialogProvider>
      <ContextMenuProvider><StickyNoteEditor markdown="unchanged" onChange={onChange} /></ContextMenuProvider>
    </BusinessDialogProvider>,
  )
  fireEvent.contextMenu(screen.getByLabelText('content'), { clientX: 200, clientY: 120 })
  screen.getByRole('menuitem', { name: '粘贴' }).click()

  expect(await screen.findByRole('alertdialog', { name: '请使用 Ctrl+V 粘贴' })).toBeVisible()
  expect(visualEditorHandle.insertMarkdown).not.toHaveBeenCalled()
  expect(onChange).not.toHaveBeenCalled()
})

it('leaves Markdown unchanged and prompts for Ctrl+V when direct insertion fails', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText: vi.fn().mockResolvedValue('clipboard text') },
  })
  visualEditorHandle.insertMarkdown.mockReturnValue(false)
  const onChange = vi.fn()
  render(
    <BusinessDialogProvider>
      <ContextMenuProvider><StickyNoteEditor markdown="unchanged" onChange={onChange} /></ContextMenuProvider>
    </BusinessDialogProvider>,
  )
  fireEvent.contextMenu(screen.getByLabelText('content'), { clientX: 200, clientY: 120 })
  screen.getByRole('menuitem', { name: '粘贴' }).click()

  expect(await screen.findByRole('alertdialog', { name: '请使用 Ctrl+V 粘贴' })).toBeVisible()
  expect(visualEditorHandle.insertMarkdown).toHaveBeenCalledWith('clipboard text')
  expect(onChange).not.toHaveBeenCalled()
})

it('preserves an existing selection when right-clicking anywhere inside its visible range', () => {
  render(<ContextMenuProvider><StickyNoteEditor markdown="alpha beta" onChange={vi.fn()} /></ContextMenuProvider>)
  const editor = screen.getByLabelText('content')
  const paragraph = editor.querySelector<HTMLElement>('[data-single-text="true"]')!
  const text = paragraph.firstChild!
  select(text, 0, 10)
  installCaretRange(text, 5)

  fireEvent.contextMenu(paragraph, { clientX: 55, clientY: 10 })

  const copy = screen.getByRole('menuitem', { name: '\u590d\u5236' })
  expect(copy).toBeVisible()
  expect(screen.queryByRole('menuitem', { name: '\u63d2\u5165\u56fe\u7247' })).not.toBeInTheDocument()
  const command = vi.fn(() => { expect(window.getSelection()?.toString()).toBe('alpha beta'); return true })
  Object.assign(document, { execCommand: command })
  copy.click()
  expect(command).toHaveBeenCalledWith('copy')
})

it('keeps blank pointerdown native and only places the caret after a short click', () => {
  render(<ContextMenuProvider><StickyNoteEditor markdown="alpha beta" onChange={vi.fn()} /></ContextMenuProvider>)
  const editor = screen.getByLabelText('content')
  const paragraph = editor.querySelector<HTMLElement>('[data-single-text="true"]')!
  const text = paragraph.firstChild!
  select(text, 0, 5)
  installCaretRange(text, 5)
  const event = new Event('pointerdown', { bubbles: true, cancelable: true })
  Object.assign(event, { button: 0, clientX: 55, clientY: 10, isPrimary: true, pointerId: 1 })

  expect(paragraph.dispatchEvent(event)).toBe(true)
  expect(window.getSelection()?.toString()).toBe('alpha')
  fireEvent.pointerUp(paragraph, { button: 0, clientX: 55, clientY: 10, isPrimary: true, pointerId: 1 })
  expect(document.activeElement).toBe(editor)
  expect(window.getSelection()?.isCollapsed).toBe(true)
})

it('preserves a native multi-line selection when dragging from editor whitespace', () => {
  render(<ContextMenuProvider><StickyNoteEditor markdown="alpha beta" onChange={vi.fn()} /></ContextMenuProvider>)
  const editor = screen.getByLabelText('content')
  const paragraph = editor.querySelector<HTMLElement>('[data-single-text="true"]')!
  const text = paragraph.firstChild!
  installCaretRange(text, 5)

  fireEvent.pointerDown(paragraph, { button: 0, clientX: 55, clientY: 10, isPrimary: true, pointerId: 2 })
  select(text, 0, text.textContent!.length)
  fireEvent.pointerUp(paragraph, { button: 0, clientX: 95, clientY: 40, isPrimary: true, pointerId: 2 })

  expect(window.getSelection()?.toString()).toBe('alpha beta')
})

it('collapses an old selection at blank right-click coordinates and always opens the blank menu', () => {
  render(<ContextMenuProvider><StickyNoteEditor markdown="alpha beta" onChange={vi.fn()} /></ContextMenuProvider>)
  const editor = screen.getByLabelText('content')
  const alpha = editor.querySelector('span')!.firstChild!
  select(alpha, 0, 5)
  installCaretRange(alpha, 1)

  fireEvent.contextMenu(editor, { clientX: 200, clientY: 120 })

  expect(window.getSelection()?.isCollapsed).toBe(true)
  expect(screen.getByRole('menuitem', { name: '插入图片' })).toBeVisible()
})

it('executes every blank-menu rule, color, material, and background choice with its concrete value', async () => {
  const onSetColor = vi.fn()
  const onSetMaterial = vi.fn()
  const onOpenBackgroundSettings = vi.fn()
  const onSetLineSpacingMode = vi.fn()
  const globalInsert = vi.fn()
  window.addEventListener('arkdown:insert-markdown', globalInsert)
  try {
    render(
      <ContextMenuProvider>
        <StickyNoteEditor
          markdown="alpha beta"
          lineSpacingMode="compact"
          onChange={vi.fn()}
          onSetColor={onSetColor}
          onSetLineSpacingMode={onSetLineSpacingMode}
          onSetMaterial={onSetMaterial}
          onOpenBackgroundSettings={onOpenBackgroundSettings}
          preferences={DEFAULT_STICKY_NOTE_PREFERENCES}
          style={{ mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' }}
        />
      </ContextMenuProvider>,
    )
    const editor = screen.getByLabelText('content')
    const openBlankMenu = () => fireEvent.contextMenu(editor, { clientX: 200, clientY: 120 })
    const choose = (
      parent: string,
      choice: string,
      role: 'menuitem' | 'menuitemcheckbox' = 'menuitem',
    ) => {
      fireEvent.mouseEnter(screen.getByRole('menuitem', { name: parent }).parentElement!)
      screen.getByRole(role, { name: choice }).click()
    }

    const rules = [
      ['黑色', 'black'], ['红色', 'red'], ['橙色', 'orange'], ['绿色', 'green'],
      ['青色', 'cyan'], ['蓝色', 'blue'], ['紫色', 'purple'], ['粉色', 'pink'],
    ] as const
    for (const [label, styleId] of rules) {
      openBlankMenu()
      choose('水平分割线', label)
      expect(visualEditorHandle.insertMarkdown).toHaveBeenLastCalledWith(
        '<hr data-arkdown-style="' + styleId
        + '" data-arkdown-height="1" data-arkdown-opacity="50" />',
      )
    }
    expect(globalInsert).not.toHaveBeenCalled()

    openBlankMenu()
    choose('\u884c\u95f4\u8ddd', '\u4f7f\u7528\u6807\u51c6\u884c\u95f4\u8ddd', 'menuitemcheckbox')
    await waitFor(() => expect(onSetLineSpacingMode).toHaveBeenCalledWith('standard'))

    for (const preset of DEFAULT_STICKY_NOTE_PREFERENCES.colorPresets) {
      openBlankMenu()
      choose('颜色', preset.name, 'menuitemcheckbox')
    }
    await waitFor(() => expect(onSetColor).toHaveBeenCalledTimes(8))
    expect(onSetColor.mock.calls.map(([value]) => value)).toEqual([
      'yellow', 'red', 'green', 'blue', 'purple', 'orange', 'gray', 'custom',
    ])

    const materials = [
      ['Mica', 'mica-light'],
      ['Acrylic', 'flowing-glass'],
    ] as const
    for (const [label] of materials) {
      openBlankMenu()
      choose('材质', label, 'menuitemcheckbox')
    }
    await waitFor(() => expect(onSetMaterial).toHaveBeenCalledTimes(2))
    expect(onSetMaterial.mock.calls.map(([value]) => value)).toEqual(
      materials.map(([, presetId]) => presetId),
    )

    openBlankMenu()
    screen.getByRole('menuitem', { name: '设置背景...' }).click()
    await waitFor(() => expect(onOpenBackgroundSettings).toHaveBeenCalledOnce())
  } finally {
    window.removeEventListener('arkdown:insert-markdown', globalInsert)
  }
})

it('focuses the editor and places a collapsed cursor at blank click coordinates', () => {
  render(<ContextMenuProvider><StickyNoteEditor markdown="alpha beta" onChange={vi.fn()} /></ContextMenuProvider>)
  const editor = screen.getByLabelText('content')
  const alpha = editor.querySelector('span')!.firstChild!
  select(alpha, 0, 5)
  installCaretRange(alpha, 1)

  fireEvent.pointerDown(editor, { button: 0, clientX: 200, clientY: 120, isPrimary: true, pointerId: 3 })
  fireEvent.pointerUp(editor, { button: 0, clientX: 200, clientY: 120, isPrimary: true, pointerId: 3 })

  expect(document.activeElement).toBe(editor)
  expect(window.getSelection()?.isCollapsed).toBe(true)
})

it('treats paragraph line-end whitespace as blank even when the browser reports the nearest word caret', () => {
  render(<ContextMenuProvider><StickyNoteEditor markdown="alpha beta" onChange={vi.fn()} /></ContextMenuProvider>)
  const editor = screen.getByLabelText('content')
  const paragraph = editor.querySelector('p')!
  const beta = editor.querySelectorAll('span')[1]!.firstChild!
  select(beta, 0, 4)
  installCaretRange(beta, 4)

  fireEvent.contextMenu(paragraph, { clientX: 160, clientY: 10 })

  expect(window.getSelection()?.isCollapsed).toBe(true)
  expect(screen.getByRole('menuitem', { name: '插入图片' })).toBeVisible()
})

it('focuses and collapses selection for empty paragraph and descendant whitespace clicks', () => {
  render(<ContextMenuProvider><StickyNoteEditor markdown="alpha beta" onChange={vi.fn()} /></ContextMenuProvider>)
  const editor = screen.getByLabelText('content')
  const alpha = editor.querySelector('span')!.firstChild!
  select(alpha, 0, 5)
  installCaretRange(alpha, 5)

  const empty = editor.querySelector('[data-empty="true"]')!
  fireEvent.pointerDown(empty, { button: 0, clientX: 160, clientY: 40, isPrimary: true, pointerId: 4 })
  fireEvent.pointerUp(empty, { button: 0, clientX: 160, clientY: 40, isPrimary: true, pointerId: 4 })

  expect(document.activeElement).toBe(editor)
  expect(window.getSelection()?.isCollapsed).toBe(true)
})

it('does not cancel ordinary pointerdown on a glyph when the caret range itself is zero width', () => {
  render(<ContextMenuProvider><StickyNoteEditor markdown="alpha beta" onChange={vi.fn()} /></ContextMenuProvider>)
  const editor = screen.getByLabelText('content')
  const beta = editor.querySelectorAll('span')[1]!.firstChild!
  installCaretRange(beta, 2)
  const event = new Event('pointerdown', { bubbles: true, cancelable: true })
  Object.assign(event, { clientX: 70, clientY: 10 })
  expect(editor.querySelectorAll('span')[1]!.dispatchEvent(event)).toBe(true)
})


it('uses the shared dedicated menu for an existing sticky-note horizontal rule', async () => {
  render(<ContextMenuProvider><StickyNoteEditor markdown="---" onChange={vi.fn()} /></ContextMenuProvider>)
  const rule = screen.getByLabelText('content').querySelector('hr')!
  const replacements: string[] = []
  rule.addEventListener('arkdown:horizontal-rule-change', (event) => {
    replacements.push((event as CustomEvent<{ markdown: string }>).detail.markdown)
  })

  fireEvent.contextMenu(rule, { clientX: 50, clientY: 50 })

  expect(screen.getByRole('menuitem', { name: '增加 1px' })).toBeVisible()
  expect(screen.getByRole('menuitem', { name: '减少 1px' })).toBeVisible()
  expect(screen.getByRole('menuitem', { name: '加深 10%' })).toBeVisible()
  expect(screen.getByRole('menuitem', { name: '减淡 10%' })).toBeVisible()
  expect(screen.getByRole('menuitem', { name: '复制分割线' })).toBeVisible()
  expect(screen.queryByRole('menuitem', { name: '插入图片' })).not.toBeInTheDocument()

  screen.getByRole('menuitem', { name: '增加 1px' }).click()
  await waitFor(() => expect(rule.dataset.arkdownHeight).toBe('3'))
  expect(replacements).toEqual([
    '<hr data-arkdown-style="blue" data-arkdown-height="3" data-arkdown-opacity="40" />',
  ])
})
