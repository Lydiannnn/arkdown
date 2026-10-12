import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FileTypeIcon } from '../../src/renderer/icons/FileTypeIcon'

describe('FileTypeIcon', () => {
  const originalDevicePixelRatio = window.devicePixelRatio

  afterEach(() => {
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: originalDevicePixelRatio,
    })
  })

  it('preserves the 22px source canvas at 100% scaling', () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 })
    render(<FileTypeIcon kind="folder" />)
    const icon = screen.getByTestId('file-type-icon')
    expect(icon).toHaveStyle({ width: '22px', height: '22px' })
    expect(icon.getAttribute('src')).toContain('folder-closed-22px.png')
  })

  it('converts the source canvas through the Windows display scale', () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1.5 })
    render(<FileTypeIcon kind="markdown" />)
    expect(screen.getByTestId('file-type-icon')).toHaveStyle({
      width: '14.666666666666666px',
      height: '14.666666666666666px',
    })
  })
})
