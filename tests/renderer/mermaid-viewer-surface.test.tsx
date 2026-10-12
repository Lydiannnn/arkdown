import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MermaidViewerSurface } from '../../src/renderer/mermaid-viewer/MermaidViewerSurface'
import { rasterizeMermaidSvgDataUrl } from '../../src/renderer/editor/mermaid/mermaid-image-export'

vi.mock('../../src/renderer/editor/mermaid/mermaid-image-export', () => ({ rasterizeMermaidSvgDataUrl: vi.fn() }))

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 400"><text x="20" y="30" font-size="16">Snapshot</text></svg>'
const snapshot = { svgDataUrl: `data:image/svg+xml;base64,${btoa(svg)}`, colorScheme: 'dark', themeColor: '#c62828' }
afterEach(() => { vi.unstubAllGlobals(); delete document.documentElement.dataset.arkdownTheme })

describe('Mermaid readonly viewer', () => {
  it('saves the complete snapshot from the canvas menu after zoom and pan, and Escape only dismisses the menu', async () => {
    const pngDataUrl = 'data:image/png;base64,cG5n'
    vi.mocked(rasterizeMermaidSvgDataUrl).mockResolvedValue(pngDataUrl)
    const saveMermaidImage = vi.fn().mockResolvedValue({ ok: true, value: null })
    const controlWindow = vi.fn().mockResolvedValue({ ok: true, value: { maximized: false } })
    vi.stubGlobal('arkdown', { getMermaidViewerSnapshot: async () => ({ ok: true, value: snapshot }), saveMermaidImage, controlWindow })
    render(<MermaidViewerSurface />)
    await waitFor(() => expect(screen.getByRole('button', { name: '放大' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    const viewport = screen.getByLabelText('图表画布')
    viewport.scrollLeft = 350
    fireEvent.contextMenu(viewport, { clientX: 200, clientY: 160 })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(controlWindow).not.toHaveBeenCalled()
    fireEvent.contextMenu(viewport, { clientX: 200, clientY: 160 })
    fireEvent.click(screen.getByRole('menuitem', { name: '保存为图片' }))
    await waitFor(() => expect(saveMermaidImage).toHaveBeenCalledExactlyOnceWith({ svgDataUrl: snapshot.svgDataUrl, pngDataUrl }))
    expect(rasterizeMermaidSvgDataUrl).toHaveBeenCalledWith(snapshot.svgDataUrl)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('reports a failed save and allows a later successful or cancelled save without leaving an error', async () => {
    vi.mocked(rasterizeMermaidSvgDataUrl).mockResolvedValue('data:image/png;base64,cG5n')
    const saveMermaidImage = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'OPERATION_FAILED', message: '文件无法写入' } })
      .mockResolvedValue({ ok: true, value: null })
    vi.stubGlobal('arkdown', { getMermaidViewerSnapshot: async () => ({ ok: true, value: snapshot }), saveMermaidImage })
    render(<MermaidViewerSurface />)
    await waitFor(() => expect(screen.getByRole('button', { name: '放大' })).toBeEnabled())
    const save = () => {
      fireEvent.contextMenu(screen.getByLabelText('图表画布'))
      fireEvent.click(screen.getByRole('menuitem', { name: '保存为图片' }))
    }
    save()
    expect(await screen.findByRole('alert')).toHaveTextContent('文件无法写入')
    save()
    await waitFor(() => expect(saveMermaidImage).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('mounts a sanitized vector snapshot in an isolated shadow and supports zoom, fit and Escape', async () => {
    const controlWindow = vi.fn().mockResolvedValue({ ok: true, value: { maximized: false } })
    vi.stubGlobal('arkdown', { getMermaidViewerSnapshot: async () => ({ ok: true, value: snapshot }), controlWindow })
    const { container } = render(<MermaidViewerSurface />)
    await waitFor(() => expect(screen.getByRole('button', { name: '放大' })).toBeEnabled())
    const host = container.querySelector('.mermaid-viewer-svg')!
    expect(host.shadowRoot!.querySelector('text')?.textContent).toBe('Snapshot')
    expect(container.querySelector('svg text')).toBeNull()
    expect(document.documentElement.dataset.arkdownTheme).toBe('dark')
    const previous = screen.getByLabelText('缩放比例').textContent
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    expect(screen.getByLabelText('缩放比例').textContent).not.toBe(previous)
    fireEvent.click(screen.getByRole('button', { name: '适合窗口' }))
    expect(screen.getByLabelText('缩放比例').textContent).toBe(previous)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(controlWindow).toHaveBeenCalledWith('close')
  })
  it('shows a recoverable error and keeps close available when loading fails', async () => {
    vi.stubGlobal('arkdown', { getMermaidViewerSnapshot: async () => ({ ok: false, error: { message: 'failed' } }) })
    render(<MermaidViewerSurface />)
    expect(await screen.findByRole('alert')).toHaveTextContent('无法加载图表')
    expect(screen.getByRole('button', { name: '关闭' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '放大' })).toBeDisabled()
  })
  it('zooms with the wheel and pans the overflow with captured pointer movement', async () => {
    vi.stubGlobal('arkdown', { getMermaidViewerSnapshot: async () => ({ ok: true, value: snapshot }) })
    const { container } = render(<MermaidViewerSurface />)
    await waitFor(() => expect(screen.getByRole('button', { name: '放大' })).toBeEnabled())
    const viewport = container.querySelector<HTMLDivElement>('.mermaid-viewer-viewport')!
    Object.defineProperties(viewport, { clientWidth: { value: 600 }, clientHeight: { value: 400 } })
    const before = screen.getByLabelText('缩放比例').textContent
    fireEvent.wheel(viewport, { deltaY: -200, clientX: 300, clientY: 200 })
    expect(screen.getByLabelText('缩放比例').textContent).not.toBe(before)
    let captured = false
    viewport.setPointerCapture = () => { captured = true }
    viewport.hasPointerCapture = () => captured
    viewport.releasePointerCapture = () => { captured = false }
    // jsdom lacks PointerEvent; construct the actual event fields at that boundary.
    const pointer = (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      fireEvent(viewport, event)
    }
    viewport.scrollLeft = 100
    pointer('pointerdown', 300, 200)
    pointer('pointermove', 250, 170)
    expect(viewport.scrollLeft).toBe(150)
    expect(viewport).toHaveClass('is-dragging')
    pointer('pointerup', 250, 170)
    expect(viewport).not.toHaveClass('is-dragging')
  })
})
