import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  computeEditorRightSidebarWidth,
  EditorRightSidebar,
  type EditorRightSidebarProps,
  type EditorRightSidebarTab,
} from '../../src/renderer/editor/EditorRightSidebar'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function installMotionPreference(reduced = false) {
  const media = {
    matches: reduced,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList
  vi.stubGlobal('matchMedia', vi.fn(() => media))
  return media
}

function installAnimationFrame() {
  let callback: FrameRequestCallback | null = null
  vi.stubGlobal('requestAnimationFrame', vi.fn((next: FrameRequestCallback) => {
    callback = next
    return 1
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn(() => {
    callback = null
  }))
  return () => {
    const next = callback
    callback = null
    act(() => next?.(performance.now()))
  }
}

function renderSidebar(overrides: Partial<EditorRightSidebarProps> = {}) {
  const props: EditorRightSidebarProps = {
    activeTab: 'translation',
    containerWidth: 1200,
    onActiveTabChange: vi.fn(),
    panels: {
      translation: <p>translation content</p>,
      'ai-chat': <p>ai chat content</p>,
    },
    ...overrides,
  }
  return render(<EditorRightSidebar {...props} />)
}

it('owns the generic aside, translation tab, splitter, and tab panel', () => {
  renderSidebar()

  const sidebar = screen.getByRole('complementary', { name: '右侧栏' })
  const tab = screen.getByRole('tab', { name: '翻译' })
  const panel = screen.getByRole('tabpanel', { name: '翻译' })
  expect(sidebar).toBeVisible()
  expect(tab).toHaveAttribute('aria-selected', 'true')
  expect(panel).toHaveTextContent('translation content')
  const track = screen.getByTestId('editor-right-sidebar-motion-track')
  const splitter = screen.getByRole('separator', { name: '调整右侧栏宽度' })
  expect(track).toContainElement(splitter)
  expect(sidebar).not.toContainElement(splitter)
  expect(sidebar.parentElement).toHaveClass('editor-right-sidebar-motion-clip')
})

it('uses the restored persisted right sidebar width and follows later snapshots', () => {
  const view = renderSidebar({ initialWidth: 760 })
  const splitter = screen.getByRole('separator', { name: '调整右侧栏宽度' })
  expect(splitter).toHaveAttribute('aria-valuenow', '760')

  view.rerender(<EditorRightSidebar
    activeTab="translation"
    containerWidth={1200}
    initialWidth={880}
    onActiveTabChange={vi.fn()}
    panels={{ translation: 'content', 'ai-chat': 'ai chat content' }}
  />)
  expect(splitter).toHaveAttribute('aria-valuenow', '880')
})

it('selects the AI chat tab and renders only its panel while exposing roving tab state', async () => {
  const user = userEvent.setup()
  const onActiveTabChange = vi.fn()
  renderSidebar({
    activeTab: 'ai-chat',
    onActiveTabChange,
    panels: {
      translation: <div>译文</div>,
      'ai-chat': <div>对话</div>,
    },
  })

  const aiChatTab = screen.getByRole('tab', { name: 'AI 对话' })
  const translationTab = screen.getByRole('tab', { name: '翻译' })
  expect(aiChatTab).toHaveAttribute('aria-selected', 'true')
  expect(aiChatTab).toHaveAttribute('tabindex', '0')
  expect(aiChatTab).toHaveAttribute('aria-controls', 'editor-right-sidebar-panel-ai-chat')
  expect(translationTab).toHaveAttribute('aria-selected', 'false')
  expect(translationTab).toHaveAttribute('tabindex', '-1')
  expect(translationTab).not.toHaveAttribute('aria-controls')
  expect(screen.getByRole('tabpanel', { name: 'AI 对话' })).toHaveTextContent('对话')
  expect(screen.queryByRole('tabpanel', { name: '翻译' })).not.toBeInTheDocument()

  await user.click(translationTab)
  expect(onActiveTabChange).toHaveBeenCalledWith('translation')
})

it('places AI conversation before translation in the right-sidebar tab order', () => {
  renderSidebar({ activeTab: 'ai-chat' })

  expect(screen.getAllByRole('tab').map((tab) => tab.textContent))
    .toEqual(['AI 对话', '翻译', '文档查看'])
})

it('moves tab selection and focus with arrow, Home, and End keys', () => {
  function KeyboardTabs() {
    const [activeTab, setActiveTab] = useState<EditorRightSidebarTab>('translation')
    return (
      <EditorRightSidebar
        activeTab={activeTab}
        containerWidth={1200}
        onActiveTabChange={setActiveTab}
        panels={{
          translation: <p>translation content</p>,
          'ai-chat': <p>ai chat content</p>,
        }}
      />
    )
  }

  render(<KeyboardTabs />)
  const translationTab = screen.getByRole('tab', { name: '翻译' })
  const aiChatTab = screen.getByRole('tab', { name: 'AI 对话' })
  translationTab.focus()

  fireEvent.keyDown(translationTab, { key: 'ArrowRight' })
  const documentTab = screen.getByRole('tab', { name: '文档查看' })
  expect(documentTab).toHaveFocus()
  expect(documentTab).toHaveAttribute('aria-selected', 'true')
  fireEvent.keyDown(documentTab, { key: 'ArrowRight' })
  expect(aiChatTab).toHaveFocus()
  expect(aiChatTab).toHaveAttribute('aria-selected', 'true')

  fireEvent.keyDown(aiChatTab, { key: 'ArrowLeft' })
  expect(documentTab).toHaveFocus()
  expect(documentTab).toHaveAttribute('aria-selected', 'true')

  fireEvent.keyDown(documentTab, { key: 'Home' })
  expect(aiChatTab).toHaveFocus()
  expect(aiChatTab).toHaveAttribute('aria-selected', 'true')

  fireEvent.keyDown(aiChatTab, { key: 'End' })
  expect(documentTab).toHaveFocus()
  expect(documentTab).toHaveAttribute('aria-selected', 'true')
})

it('tabs from the editor to the splitter before sidebar controls and dynamic content', async () => {
  installMotionPreference()
  const user = userEvent.setup()
  render(
    <>
      <button type="button">编辑器操作</button>
      <EditorRightSidebar
        activeTab="translation"
        containerWidth={1200}
        onActiveTabChange={vi.fn()}
        panels={{
          translation: <button type="button">动态侧栏操作</button>,
          'ai-chat': <div>AI chat content</div>,
        }}
      />
    </>,
  )

  const editorAction = screen.getByRole('button', { name: '编辑器操作' })
  const splitter = screen.getByRole('separator', { name: '调整右侧栏宽度' })
  const tab = screen.getByRole('tab', { name: '翻译' })
  const sidebarAction = screen.getByRole('button', { name: '动态侧栏操作' })
  editorAction.focus()

  await user.tab()
  expect(splitter).toHaveFocus()
  await user.tab()
  expect(tab).toHaveFocus()
  await user.tab()
  expect(sidebarAction).toHaveFocus()
})

it('keeps the translation tab width while using the compact active typography', () => {
  const style = document.createElement('style')
  style.textContent = readFileSync(
    path.join(process.cwd(), 'src/renderer/editor/editor-right-sidebar.css'),
    'utf8',
  )
  document.head.append(style)
  try {
    render(
      <EditorRightSidebar
        activeTab="translation"
        containerWidth={1200}
        onActiveTabChange={vi.fn()}
        panels={{
          translation: 'content',
          'ai-chat': 'ai chat content',
        }}
      />,
    )
    const tab = screen.getByRole('tab', { name: '翻译' })
    expect(getComputedStyle(tab).width).toBe('36px')
    expect(getComputedStyle(tab).fontSize).toBe('14px')
  } finally {
    style.remove()
  }
})

it('starts at 530 CSS px regardless of the available container width', () => {
  expect(computeEditorRightSidebarWidth(600)).toBe(530)
  expect(computeEditorRightSidebarWidth(1200)).toBe(530)
  expect(computeEditorRightSidebarWidth(2000)).toBe(530)
})

it('supports keyboard resizing from 240 to 1800 CSS px without changing the active tab', () => {
  const onWidthChange = vi.fn()
  renderSidebar({ onWidthChange, panels: { translation: 'content', 'ai-chat': 'ai chat content' } })

  const splitter = screen.getByRole('separator', { name: '调整右侧栏宽度' })
  expect(splitter).toHaveAttribute('aria-valuemin', '240')
  expect(splitter).toHaveAttribute('aria-valuemax', '1800')
  expect(splitter).toHaveAttribute('aria-valuenow', '530')
  fireEvent.keyDown(splitter, { key: 'ArrowLeft' })
  expect(onWidthChange).toHaveBeenLastCalledWith(540)
  fireEvent.keyDown(splitter, { key: 'Home' })
  expect(onWidthChange).toHaveBeenLastCalledWith(240)
  fireEvent.keyDown(splitter, { key: 'End' })
  expect(onWidthChange).toHaveBeenLastCalledWith(1800)
  expect(screen.getByRole('tab', { name: '翻译' })).toHaveAttribute('aria-selected', 'true')
})

it('keeps a focused splitter exposed to assistive technology until closing completes', () => {
  installMotionPreference()
  const onExitComplete = vi.fn()
  const view = renderSidebar({
    onExitComplete,
    open: true,
    panels: { translation: 'content', 'ai-chat': 'ai chat content' },
  })
  const splitter = screen.getByRole('separator', { name: '调整右侧栏宽度' })
  splitter.focus()

  view.rerender(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      onExitComplete={onExitComplete}
      open={false}
      panels={{
        translation: 'content',
        'ai-chat': 'ai chat content',
      }}
    />,
  )

  expect(splitter).toHaveFocus()
  expect(splitter).toHaveAttribute('tabindex', '-1')
  expect(splitter).not.toHaveAttribute('aria-hidden')

  fireEvent.transitionEnd(screen.getByTestId('editor-right-sidebar-motion-track'), {
    propertyName: 'width',
  })
  expect(onExitComplete).toHaveBeenCalledWith(true)
})

it('ignores keyboard resizing while the focused splitter is closing', () => {
  installMotionPreference()
  const onWidthChange = vi.fn()
  const view = renderSidebar({
    onWidthChange,
    open: true,
    panels: { translation: 'content', 'ai-chat': 'ai chat content' },
  })
  const splitter = screen.getByRole('separator', { name: '调整右侧栏宽度' })
  splitter.focus()

  view.rerender(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      onWidthChange={onWidthChange}
      open={false}
      panels={{
        translation: 'content',
        'ai-chat': 'ai chat content',
      }}
    />,
  )
  fireEvent.keyDown(splitter, { key: 'ArrowLeft' })

  expect(onWidthChange).not.toHaveBeenCalled()
  expect(splitter).toHaveAttribute('aria-valuenow', '530')
})

it('removes active pointer listeners when the sidebar unmounts', () => {
  const removeListener = vi.spyOn(document, 'removeEventListener')
  const rendered = renderSidebar({
    panels: { translation: 'content', 'ai-chat': 'ai chat content' },
  })
  const splitter = screen.getByRole('separator', { name: '调整右侧栏宽度' })
  const releasePointerCapture = vi.fn()
  Object.defineProperties(splitter, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    releasePointerCapture: { configurable: true, value: releasePointerCapture },
  })
  fireEvent.pointerDown(splitter, {
    button: 0,
    clientX: 400,
    pointerId: 7,
  })

  rendered.unmount()

  expect(removeListener).toHaveBeenCalledWith('pointermove', expect.any(Function))
  expect(removeListener).toHaveBeenCalledWith('pointerup', expect.any(Function))
  expect(removeListener).toHaveBeenCalledWith('pointercancel', expect.any(Function))
  expect(releasePointerCapture).toHaveBeenCalledOnce()
  expect(releasePointerCapture).toHaveBeenCalledWith(7)
})

it('opens from a zero-width motion track while its inner sidebar keeps the persisted width', () => {
  installMotionPreference()
  const runAnimationFrame = installAnimationFrame()
  const view = renderSidebar({
    open: false,
    panels: { translation: 'content', 'ai-chat': 'ai chat content' },
  })
  expect(screen.queryByRole('complementary', { name: '右侧栏' })).not.toBeInTheDocument()

  view.rerender(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      open
      panels={{
        translation: 'content',
        'ai-chat': 'ai chat content',
      }}
    />,
  )

  const track = screen.getByTestId('editor-right-sidebar-motion-track')
  const sidebar = screen.getByRole('complementary', { name: '右侧栏' })
  expect(track).toHaveAttribute('data-phase', 'entering')
  expect(track).toHaveStyle({ width: '0px' })
  expect(sidebar).toHaveStyle({ width: '530px' })

  runAnimationFrame()
  expect(track).toHaveAttribute('data-phase', 'opening')
  expect(track).toHaveStyle({ width: '530px' })
  expect(sidebar).toHaveStyle({ width: '530px' })
})

it('keeps closing content mounted and non-interactive until its width transition ends', () => {
  installMotionPreference()
  const view = render(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      open
    >
      content
    </EditorRightSidebar>,
  )

  view.rerender(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      open={false}
    >
      content
    </EditorRightSidebar>,
  )

  const track = screen.getByTestId('editor-right-sidebar-motion-track')
  expect(track).toHaveAttribute('data-phase', 'closing')
  expect(track).toHaveStyle({ pointerEvents: 'none', width: '0px' })
  expect(screen.getByRole('complementary', { name: '右侧栏' })).toBeInTheDocument()

  fireEvent.transitionEnd(track, { propertyName: 'opacity' })
  expect(screen.getByRole('complementary', { name: '右侧栏' })).toBeInTheDocument()

  fireEvent.transitionEnd(track, { propertyName: 'width' })
  expect(screen.queryByRole('complementary', { name: '右侧栏' })).not.toBeInTheDocument()
})

it('uses a bounded exit fallback and cancels it when closing reverses', () => {
  vi.useFakeTimers()
  installMotionPreference()
  const runAnimationFrame = installAnimationFrame()
  const view = render(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      open
    >
      content
    </EditorRightSidebar>,
  )
  view.rerender(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      open={false}
    >
      content
    </EditorRightSidebar>,
  )
  expect(screen.getByTestId('editor-right-sidebar-motion-track'))
    .toHaveAttribute('data-phase', 'closing')

  view.rerender(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      open
    >
      content
    </EditorRightSidebar>,
  )
  expect(screen.getByTestId('editor-right-sidebar-motion-track'))
    .toHaveAttribute('data-phase', 'opening')
  act(() => vi.advanceTimersByTime(1000))
  expect(screen.getByRole('complementary', { name: '右侧栏' })).toBeInTheDocument()
  runAnimationFrame()

  view.rerender(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      open={false}
    >
      content
    </EditorRightSidebar>,
  )
  act(() => vi.advanceTimersByTime(321))
  expect(screen.queryByRole('complementary', { name: '右侧栏' })).not.toBeInTheDocument()
})

it('ignores an opening width transition end queued before the current closing generation', () => {
  installMotionPreference()
  const runAnimationFrame = installAnimationFrame()
  const view = render(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      open={false}
    >
      content
    </EditorRightSidebar>,
  )
  view.rerender(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      open
    >
      content
    </EditorRightSidebar>,
  )
  runAnimationFrame()
  const track = screen.getByTestId('editor-right-sidebar-motion-track')
  expect(track).toHaveAttribute('data-phase', 'opening')
  const staleOpeningEnd = new Event('transitionend', { bubbles: true })
  Object.defineProperties(staleOpeningEnd, {
    propertyName: { value: 'width' },
    timeStamp: { value: 0 },
  })

  view.rerender(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      open={false}
    >
      content
    </EditorRightSidebar>,
  )
  expect(track).toHaveAttribute('data-phase', 'closing')
  fireEvent(track, staleOpeningEnd)
  expect(screen.getByRole('complementary', { name: '右侧栏' })).toBeInTheDocument()

  fireEvent.transitionEnd(track, { propertyName: 'width' })
  expect(screen.queryByRole('complementary', { name: '右侧栏' })).not.toBeInTheDocument()
})

it('waits for the current closing width endpoint and tolerates browser subpixels', () => {
  installMotionPreference()
  const view = render(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      open
    >
      content
    </EditorRightSidebar>,
  )
  view.rerender(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      open={false}
    >
      content
    </EditorRightSidebar>,
  )
  const track = screen.getByTestId('editor-right-sidebar-motion-track')
  track.style.width = '12px'
  fireEvent.transitionEnd(track, { propertyName: 'width' })
  expect(screen.getByRole('complementary', { name: '右侧栏' })).toBeInTheDocument()

  track.style.width = '0.000061px'
  fireEvent.transitionEnd(track, { propertyName: 'width' })
  expect(screen.queryByRole('complementary', { name: '右侧栏' })).not.toBeInTheDocument()
})

it('ignores bubbled child width transition ends during the current close', () => {
  installMotionPreference()
  const view = render(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      open
    >
      content
    </EditorRightSidebar>,
  )
  view.rerender(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      open={false}
    >
      content
    </EditorRightSidebar>,
  )
  const track = screen.getByTestId('editor-right-sidebar-motion-track')
  fireEvent.transitionEnd(screen.getByRole('complementary', { name: '右侧栏' }), {
    propertyName: 'width',
  })
  expect(screen.getByRole('complementary', { name: '右侧栏' })).toBeInTheDocument()

  fireEvent.transitionEnd(track, { propertyName: 'width' })
  expect(screen.queryByRole('complementary', { name: '右侧栏' })).not.toBeInTheDocument()
})

it('marks pointer resizing only for the active gesture and cleans up on cancel or pointer up', () => {
  installMotionPreference()
  render(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
    >
      content
    </EditorRightSidebar>,
  )
  const splitter = screen.getByRole('separator', { name: '调整右侧栏宽度' })
  const track = screen.getByTestId('editor-right-sidebar-motion-track')
  fireEvent.pointerDown(splitter, { button: 0, clientX: 400, pointerId: 9 })
  expect(track).toHaveAttribute('data-resizing', 'true')

  fireEvent.pointerCancel(document, { pointerId: 8 })
  expect(track).toHaveAttribute('data-resizing', 'true')
  fireEvent.pointerCancel(document, { pointerId: 9 })
  expect(track).not.toHaveAttribute('data-resizing')

  fireEvent.pointerDown(splitter, { button: 0, clientX: 400, pointerId: 10 })
  expect(track).toHaveAttribute('data-resizing', 'true')
  fireEvent.pointerUp(document, { pointerId: 10 })
  expect(track).not.toHaveAttribute('data-resizing')
})

it('captures one active pointer and ignores unrelated move, up, cancel, and capture-loss events', () => {
  installMotionPreference()
  const onWidthChange = vi.fn()
  render(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      onWidthChange={onWidthChange}
    >
      content
    </EditorRightSidebar>,
  )
  const splitter = screen.getByRole('separator', { name: '调整右侧栏宽度' })
  const setPointerCapture = vi.fn()
  const releasePointerCapture = vi.fn()
  Object.defineProperties(splitter, {
    setPointerCapture: { configurable: true, value: setPointerCapture },
    releasePointerCapture: { configurable: true, value: releasePointerCapture },
  })
  const track = screen.getByTestId('editor-right-sidebar-motion-track')

  fireEvent.pointerDown(splitter, { button: 0, clientX: 400, pointerId: 9 })
  expect(setPointerCapture).toHaveBeenCalledWith(9)
  expect(track).toHaveAttribute('data-resizing', 'true')

  fireEvent.pointerDown(splitter, { button: 0, clientX: 200, pointerId: 10 })
  expect(setPointerCapture).toHaveBeenCalledOnce()

  fireEvent.pointerMove(document, { clientX: 300, pointerId: 8 })
  fireEvent.pointerUp(document, { pointerId: 8 })
  fireEvent.pointerCancel(document, { pointerId: 8 })
  fireEvent.lostPointerCapture(splitter, { pointerId: 8 })
  expect(onWidthChange).not.toHaveBeenCalled()
  expect(track).toHaveAttribute('data-resizing', 'true')
  expect(releasePointerCapture).not.toHaveBeenCalled()

  fireEvent.pointerMove(document, { clientX: 380, pointerId: 9 })
  expect(onWidthChange).toHaveBeenLastCalledWith(550)
  fireEvent.pointerUp(document, { pointerId: 9 })
  expect(track).not.toHaveAttribute('data-resizing')
  expect(releasePointerCapture).toHaveBeenCalledOnce()
  expect(releasePointerCapture).toHaveBeenCalledWith(9)
})

it('cleans pointer ownership idempotently on capture loss and window blur', () => {
  installMotionPreference()
  render(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
    >
      content
    </EditorRightSidebar>,
  )
  const splitter = screen.getByRole('separator', { name: '调整右侧栏宽度' })
  const releasePointerCapture = vi.fn()
  Object.defineProperties(splitter, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    releasePointerCapture: { configurable: true, value: releasePointerCapture },
  })
  const track = screen.getByTestId('editor-right-sidebar-motion-track')

  fireEvent.pointerDown(splitter, { button: 0, clientX: 400, pointerId: 11 })
  fireEvent.lostPointerCapture(splitter, { pointerId: 11 })
  fireEvent.pointerUp(document, { pointerId: 11 })
  fireEvent(window, new Event('blur'))
  expect(track).not.toHaveAttribute('data-resizing')
  expect(releasePointerCapture).toHaveBeenCalledOnce()

  fireEvent.pointerDown(splitter, { button: 0, clientX: 400, pointerId: 12 })
  fireEvent(window, new Event('blur'))
  fireEvent.pointerCancel(document, { pointerId: 12 })
  expect(track).not.toHaveAttribute('data-resizing')
  expect(releasePointerCapture).toHaveBeenCalledTimes(2)
  expect(releasePointerCapture).toHaveBeenLastCalledWith(12)
})

it('ends an active resize when the sidebar starts closing', () => {
  installMotionPreference()
  const view = render(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      open
    >
      content
    </EditorRightSidebar>,
  )
  const splitter = screen.getByRole('separator', { name: '调整右侧栏宽度' })
  const releasePointerCapture = vi.fn()
  Object.defineProperties(splitter, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    releasePointerCapture: { configurable: true, value: releasePointerCapture },
  })
  fireEvent.pointerDown(splitter, { button: 0, clientX: 400, pointerId: 13 })

  view.rerender(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      open={false}
    >
      content
    </EditorRightSidebar>,
  )

  expect(screen.getByTestId('editor-right-sidebar-motion-track'))
    .not.toHaveAttribute('data-resizing')
  expect(releasePointerCapture).toHaveBeenCalledOnce()
  fireEvent.pointerUp(document, { pointerId: 13 })
  expect(releasePointerCapture).toHaveBeenCalledOnce()
})

it('fails safe when pointer capture and release APIs throw', () => {
  installMotionPreference()
  const onWidthChange = vi.fn()
  render(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      onWidthChange={onWidthChange}
    >
      content
    </EditorRightSidebar>,
  )
  const splitter = screen.getByRole('separator', { name: '调整右侧栏宽度' })
  Object.defineProperties(splitter, {
    setPointerCapture: {
      configurable: true,
      value: vi.fn(() => { throw new Error('capture failed') }),
    },
    releasePointerCapture: {
      configurable: true,
      value: vi.fn(() => { throw new Error('release failed') }),
    },
  })
  const track = screen.getByTestId('editor-right-sidebar-motion-track')

  expect(() => {
    fireEvent.pointerDown(splitter, { button: 0, clientX: 400, pointerId: 14 })
  }).not.toThrow()
  expect(track).toHaveAttribute('data-resizing', 'true')
  fireEvent.pointerMove(document, { clientX: 390, pointerId: 14 })
  expect(onWidthChange).toHaveBeenLastCalledWith(540)
  expect(() => fireEvent(window, new Event('blur'))).not.toThrow()
  expect(track).not.toHaveAttribute('data-resizing')
})

it('completes close synchronously when reduced motion is requested', () => {
  installMotionPreference(true)
  const onExitComplete = vi.fn()
  const view = render(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      onExitComplete={onExitComplete}
      open
    >
      content
    </EditorRightSidebar>,
  )

  view.rerender(
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={1200}
      onActiveTabChange={vi.fn()}
      onExitComplete={onExitComplete}
      open={false}
    >
      content
    </EditorRightSidebar>,
  )

  expect(screen.queryByRole('complementary', { name: '右侧栏' })).not.toBeInTheDocument()
  expect(onExitComplete).toHaveBeenCalledOnce()
})
