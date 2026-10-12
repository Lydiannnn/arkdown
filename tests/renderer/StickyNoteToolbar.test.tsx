import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { StickyNoteToolbar } from '../../src/renderer/sticky-notes/StickyNoteToolbar'
import '../../src/renderer/sticky-notes/sticky-note-window.css'

it('collapses to one accessible reveal control and resets after remount', () => {
  const first = render(<StickyNoteToolbar />)
  const toolbar = screen.getByRole('toolbar', { name: '便签格式工具栏' })
  const collapse = screen.getByRole('button', { name: '收起工具栏' })

  expect(toolbar).toHaveAttribute('data-collapsed', 'false')
  expect(collapse).toHaveAttribute('data-tooltip', '收起工具栏')
  expect(collapse).not.toHaveAttribute('data-tooltip-placement')
  expect(collapse.querySelector('.app-icon')).not.toBeNull()

  fireEvent.click(collapse)

  expect(toolbar).toHaveAttribute('data-collapsed', 'true')
  expect(screen.queryByRole('button', { name: '加粗' })).not.toBeInTheDocument()
  const expand = screen.getByRole('button', { name: '展开工具栏' })
  expect(expand).toHaveAttribute('data-tooltip', '展开工具栏')
  expect(expand).not.toHaveAttribute('data-tooltip-placement')
  const expandIcon = expand.querySelector<SVGElement>('.app-icon')
  expect(expandIcon).not.toBeNull()
  expect(getComputedStyle(expandIcon!).opacity).toBe('0.9')

  first.unmount()
  render(<StickyNoteToolbar />)
  expect(screen.getByRole('toolbar', { name: '便签格式工具栏' }))
    .toHaveAttribute('data-collapsed', 'false')
  expect(screen.getByRole('button', { name: '加粗' })).toBeInTheDocument()
})
