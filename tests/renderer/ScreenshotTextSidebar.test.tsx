import { fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ScreenshotTextSidebar } from '../../src/renderer/screenshot/ScreenshotTextSidebar'
import type { ScreenshotOcrBlock } from '../../src/shared/screenshot-translation'

const blocks: readonly ScreenshotOcrBlock[] = [
  { id: 'line-1', text: '第一行', rectPx: { x: 0, y: 0, width: 30, height: 10 }, words: [{ text: '第一行', rectPx: { x: 0, y: 0, width: 30, height: 10 } }] },
  { id: 'line-2', text: 'Second line', rectPx: { x: 0, y: 20, width: 80, height: 10 }, words: [{ text: 'Second line', rectPx: { x: 0, y: 20, width: 80, height: 10 } }] },
]

function selectNode(node: Node) {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

afterEach(() => { vi.restoreAllMocks(); window.getSelection()?.removeAllRanges() })

it('disables copy without a local selection and focuses select-all instead', () => {
  window.getSelection()?.removeAllRanges()
  render(<ScreenshotTextSidebar open blocks={blocks} />)
  fireEvent.contextMenu(screen.getByRole('complementary'))
  expect(screen.getByRole('menuitem', { name: '复制' })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: '全选' })).toHaveFocus()
})

it('keeps the measured menu inside the viewport near the bottom-right corner', () => {
  const measure = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('screenshot-text-context-menu')
      ? { x: 0, y: 0, left: 0, top: 0, right: 120, bottom: 74, width: 120, height: 74, toJSON: () => ({}) }
      : measure.call(this)
  })
  render(<ScreenshotTextSidebar open blocks={blocks} />)
  fireEvent.contextMenu(screen.getByRole('complementary'), { clientX: window.innerWidth - 2, clientY: window.innerHeight - 2 })
  expect(screen.getByRole('menu')).toHaveStyle({ left: `${window.innerWidth - 128}px`, top: `${window.innerHeight - 82}px` })
  expect(screen.getByRole('menuitem', { name: '全选' })).toHaveFocus()
})

it.each(['mouse', 'keyboard'])('restarts the OCR menu on repeated %s opens and closes immediately', (input) => {
  render(<ScreenshotTextSidebar open blocks={blocks} />)
  const sidebar = screen.getByRole('complementary')
  const openMenu = () => input === 'mouse'
    ? fireEvent.contextMenu(sidebar, { clientX: 20, clientY: 30 })
    : fireEvent.keyDown(sidebar, { key: 'F10', shiftKey: true })
  openMenu()
  const previous = screen.getByRole('menu')
  openMenu()
  expect(screen.getByRole('menu')).not.toBe(previous)
  expect(previous).not.toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: '复制' })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: '全选' })).toHaveFocus()
  fireEvent.keyDown(screen.getByRole('menuitem', { name: '全选' }), { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(sidebar).toHaveFocus()
})

it('renders OCR blocks in reading order and an empty fixed message', () => {
  const { rerender } = render(<ScreenshotTextSidebar open blocks={blocks} />)
  expect([...screen.getByRole('complementary').querySelectorAll('p')].map((node) => node.textContent)).toEqual([
    '第一行', 'Second line',
  ])
  rerender(<ScreenshotTextSidebar open blocks={[]} />)
  expect(screen.getByText('未识别到文字')).toBeVisible()
})

it('copies only a non-empty selection fully contained in the sidebar', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  render(<><div data-testid="outside">外部文字</div><ScreenshotTextSidebar open blocks={blocks} /></>)
  const sidebar = screen.getByRole('complementary')
  selectNode(screen.getByText('第一行'))
  fireEvent.contextMenu(sidebar, { clientX: 20, clientY: 30 })
  fireEvent.click(screen.getByRole('menuitem', { name: '复制' }))
  expect(writeText).toHaveBeenCalledWith('第一行')

  writeText.mockClear()
  selectNode(screen.getByTestId('outside'))
  fireEvent.contextMenu(sidebar, { clientX: 20, clientY: 30 })
  fireEvent.click(screen.getByRole('menuitem', { name: '复制' }))
  expect(writeText).not.toHaveBeenCalled()
})

it('selects only sidebar contents and dismisses its local two-command menu', () => {
  render(<ScreenshotTextSidebar open blocks={blocks} />)
  const sidebar = screen.getByRole('complementary')
  fireEvent.contextMenu(sidebar, { clientX: 20, clientY: 30 })
  expect(screen.getAllByRole('menuitem').map((button) => button.textContent)).toEqual(['复制', '全选'])
  fireEvent.click(screen.getByRole('menuitem', { name: '全选' }))
  expect(window.getSelection()?.toString()).toContain('第一行')
  expect(window.getSelection()?.toString()).toContain('Second line')
  expect(screen.queryByRole('menu')).toBeNull()
})

it('restores focus to the extraction toggle when the sidebar closes', () => {
  const toggleRef = createRef<HTMLButtonElement>()
  const { rerender } = render(<>
    <button ref={toggleRef}>提取文字</button>
    <ScreenshotTextSidebar open blocks={blocks} returnFocusRef={toggleRef} />
  </>)
  rerender(<>
    <button ref={toggleRef}>提取文字</button>
    <ScreenshotTextSidebar open={false} blocks={blocks} returnFocusRef={toggleRef} />
  </>)
  expect(toggleRef.current).toHaveFocus()
})

it('skips disabled copy during keyboard navigation and restores sidebar focus', () => {
  render(<ScreenshotTextSidebar open blocks={blocks} />)
  const sidebar = screen.getByRole('complementary')
  sidebar.focus()
  fireEvent.keyDown(sidebar, { key: 'F10', shiftKey: true })
  const copy = screen.getByRole('menuitem', { name: '复制' })
  const selectAll = screen.getByRole('menuitem', { name: '全选' })
  expect(copy).toBeDisabled()
  expect(selectAll).toHaveFocus()
  fireEvent.keyDown(selectAll, { key: 'ArrowDown' })
  expect(selectAll).toHaveFocus()
  fireEvent.keyDown(selectAll, { key: 'Home' })
  expect(selectAll).toHaveFocus()
  fireEvent.keyDown(selectAll, { key: 'End' })
  expect(selectAll).toHaveFocus()
  fireEvent.keyDown(selectAll, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(sidebar).toHaveFocus()
})

it.each([
  { loading: true, blocks: blocks, message: '识别文字中…' },
  { loading: false, blocks: [], message: '未识别到文字' },
] as const)('does not expose copy, select-all, or a context menu for $message', ({ loading, blocks: stateBlocks, message }) => {
  render(<ScreenshotTextSidebar open blocks={stateBlocks} loading={loading} />)
  const sidebar = screen.getByRole('complementary')
  selectNode(screen.getByText(message))

  fireEvent.contextMenu(sidebar, { clientX: 20, clientY: 30 })
  expect(screen.queryByRole('menu')).toBeNull()
  sidebar.focus()
  fireEvent.keyDown(sidebar, { key: 'F10', shiftKey: true })
  expect(screen.queryByRole('menuitem', { name: '复制' })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: '全选' })).toBeNull()
})

it('closes an existing OCR context menu when OCR text is replaced by a non-text state', () => {
  const { rerender } = render(<ScreenshotTextSidebar open blocks={blocks} />)
  fireEvent.contextMenu(screen.getByRole('complementary'), { clientX: 20, clientY: 30 })
  expect(screen.getByRole('menu')).toBeVisible()

  rerender(<ScreenshotTextSidebar open blocks={[]} />)
  expect(screen.queryByRole('menu')).toBeNull()
})
