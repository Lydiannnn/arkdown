import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AppIcon } from '../../src/renderer/icons/AppIcon'

describe('AppIcon', () => {
  it('renders a decorative current-color outline icon at the requested size', () => {
    render(<AppIcon data-testid="app-icon" name="search" size={18} />)

    const icon = screen.getByTestId('app-icon')
    expect(icon).toHaveAttribute('aria-hidden', 'true')
    expect(icon).toHaveAttribute('width', '18')
    expect(icon).toHaveAttribute('height', '18')
    expect(icon).toHaveAttribute('fill', 'currentColor')
    expect(icon).toHaveClass('app-icon')
  })

  it('provides the complete icon vocabulary required by the UI consolidation', () => {
    const names = [
      'minimize', 'maximize', 'restore', 'close', 'search', 'reload', 'sticky-note',
      'archive', 'trash', 'check', 'copy', 'paste', 'cut', 'delete', 'paragraph',
      'heading-1', 'heading-2', 'heading-3', 'heading-4', 'heading-5', 'heading-6',
      'clear-format', 'image', 'link-reference', 'horizontal-rule', 'table',
      'code-block', 'formula', 'yaml', 'paragraph-before', 'paragraph-after', 'pin',
      'sidebar',
      'history',
    ] as const

    const { container } = render(<>{names.map((name) => (
      <AppIcon key={name} name={name} />
    ))}</>)
    expect(container.querySelectorAll('svg')).toHaveLength(names.length)
  })
})
