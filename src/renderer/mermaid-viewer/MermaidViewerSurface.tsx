import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WindowControlAction } from '../../shared/contracts'
import { themeColorRgbChannels } from '../../shared/theme-color'
import { applyMainWindowTheme } from '../app/main-window-theme'
import { AppIcon } from '../icons/AppIcon'
import { ContextMenuProvider, useContextMenu } from '../context-menu/ContextMenuProvider'
import { rasterizeMermaidSvgDataUrl } from '../editor/mermaid/mermaid-image-export'
import { chooseViewerScales, clampViewerScale, VIEWER_GUTTER, zoomScrollPosition, type ViewerSize } from './viewer-geometry'
import { decodeViewerSvg, measureSmallestVisibleText, naturalSvgSize } from './viewer-svg'
import './mermaid-viewer.css'

interface Diagram { size: ViewerSize; smallestText: number | null }
type ViewMode = 'fit' | 'reading' | 'manual'

export function MermaidViewerSurface() {
  return <ContextMenuProvider><MermaidViewerContent /></ContextMenuProvider>
}

function MermaidViewerContent() {
  const contextMenu = useContextMenu()
  const viewportRef = useRef<HTMLDivElement>(null)
  const svgHostRef = useRef<HTMLDivElement>(null)
  const diagramRef = useRef<Diagram | null>(null)
  const scaleRef = useRef(1)
  const modeRef = useRef<ViewMode>('reading')
  const pendingScroll = useRef<{ left: number; top: number } | null>(null)
  const dragRef = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null)
  const [diagram, setDiagram] = useState<Diagram | null>(null)
  const [scale, setScale] = useState(1)
  const [error, setError] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const svgDataUrlRef = useRef<string | null>(null)
  const savingRef = useRef(false)
  const mountedRef = useRef(true)
  const [saveError, setSaveError] = useState<string | null>(null)

  async function saveImage() {
    const svgDataUrl = svgDataUrlRef.current
    if (!svgDataUrl || !diagramRef.current || savingRef.current) return
    savingRef.current = true
    setSaveError(null)
    try {
      // Rasterize the complete immutable snapshot, independent of viewport zoom and pan.
      const pngDataUrl = await rasterizeMermaidSvgDataUrl(svgDataUrl)
      if (!mountedRef.current) return
      const result = await window.arkdown?.saveMermaidImage?.({ svgDataUrl, pngDataUrl })
      if (!result?.ok) throw new Error(result && !result.ok ? result.error.message : '请稍后重试。')
    } catch (error) {
      if (mountedRef.current) setSaveError(`保存图片失败：${error instanceof Error ? error.message : '请稍后重试。'}`)
    } finally { savingRef.current = false }
  }

  function control(action: WindowControlAction) {
    if (!window.arkdown?.controlWindow) {
      if (action === 'close') window.close()
      return
    }
    void window.arkdown.controlWindow(action).then(result => {
      if (result.ok) setMaximized(result.value.maximized)
    }).catch(() => {})
  }

  function applyScale(next: number, mode: ViewMode, anchor?: { x: number; y: number }) {
    const viewport = viewportRef.current
    const current = diagramRef.current
    if (!viewport || !current) return
    const bounded = clampViewerScale(next, current.size)
    modeRef.current = mode
    const point = anchor ?? { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }
    pendingScroll.current = {
      left: zoomScrollPosition(viewport.scrollLeft, point.x, viewport.clientWidth, current.size.width, scaleRef.current, bounded),
      top: zoomScrollPosition(viewport.scrollTop, point.y, viewport.clientHeight, current.size.height, scaleRef.current, bounded),
    }
    scaleRef.current = bounded
    setScale(bounded)
  }

  function chooseMode(mode: 'fit' | 'reading') {
    const viewport = viewportRef.current
    const current = diagramRef.current
    if (!viewport || !current) return
    const scales = chooseViewerScales(current.size, { width: viewport.clientWidth, height: viewport.clientHeight }, current.smallestText)
    applyScale(scales[mode], mode)
  }

  useEffect(() => {
    mountedRef.current = true
    let disposed = false
    let frame = 0
    const host = svgHostRef.current!
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    async function load() {
      try {
        const result = await window.arkdown?.getMermaidViewerSnapshot?.()
        if (disposed) return
        if (!result?.ok) throw new Error('Snapshot unavailable')
        svgDataUrlRef.current = result.value.svgDataUrl
        applyMainWindowTheme(result.value.colorScheme === 'dark' ? 'dark' : 'minimal')
        document.documentElement.style.setProperty('--theme-color-rgb', themeColorRgbChannels(result.value.themeColor))
        const parsed = new DOMParser().parseFromString(decodeViewerSvg(result.value.svgDataUrl), 'image/svg+xml')
        const svg = document.importNode(parsed.documentElement, true) as unknown as SVGSVGElement
        const size = naturalSvgSize(svg)
        svg.style.setProperty('width', `${size.width}px`, 'important')
        svg.style.setProperty('height', `${size.height}px`, 'important')
        svg.style.setProperty('max-width', 'none', 'important')
        svg.style.setProperty('max-height', 'none', 'important')
        svg.style.display = 'block'
        host.style.width = `${size.width}px`
        host.style.height = `${size.height}px`
        shadow.replaceChildren(svg)
        // Trigger layout before waiting: SVG fonts must have been requested first.
        svg.getBoundingClientRect()
        await document.fonts?.ready
        if (disposed) return
        frame = requestAnimationFrame(() => {
          if (disposed) return
          const current = { size, smallestText: measureSmallestVisibleText(svg) }
          diagramRef.current = current
          const viewport = viewportRef.current!
          const initial = chooseViewerScales(size, { width: viewport.clientWidth, height: viewport.clientHeight }, current.smallestText).initial
          scaleRef.current = initial
          setDiagram(current)
          setScale(initial)
        })
      } catch {
        if (!disposed) setError(true)
      }
    }
    void load()
    return () => { disposed = true; mountedRef.current = false; cancelAnimationFrame(frame); shadow.replaceChildren() }
  }, [])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (viewport && pendingScroll.current) {
      viewport.scrollLeft = pendingScroll.current.left
      viewport.scrollTop = pendingScroll.current.top
      pendingScroll.current = null
    }
  }, [scale])

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); control('close') }
    }
    window.addEventListener('keydown', keydown)
    const unsubscribe = window.arkdown?.onWindowStateChanged?.(state => setMaximized(state.maximized))
    void window.arkdown?.getWindowState?.().then(result => { if (result.ok) setMaximized(result.value.maximized) }).catch(() => {})
    return () => { window.removeEventListener('keydown', keydown); unsubscribe?.() }
  }, [])

  useEffect(() => {
    const viewport = viewportRef.current!
    const wheel = (event: WheelEvent) => {
      if (!diagramRef.current) return
      event.preventDefault()
      const rect = viewport.getBoundingClientRect()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1)
      applyScale(scaleRef.current * Math.exp(-Math.max(-500, Math.min(500, delta)) * 0.002), 'manual', {
        x: event.clientX - rect.left, y: event.clientY - rect.top,
      })
    }
    const resize = () => { if (modeRef.current !== 'manual') chooseMode(modeRef.current) }
    viewport.addEventListener('wheel', wheel, { passive: false })
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null
    observer?.observe(viewport)
    window.addEventListener('resize', resize)
    return () => { viewport.removeEventListener('wheel', wheel); observer?.disconnect(); window.removeEventListener('resize', resize) }
  }, [])

  const contentWidth = (diagram?.size.width ?? 0) * scale
  const contentHeight = (diagram?.size.height ?? 0) * scale
  return <main className="mermaid-viewer" aria-label="Mermaid 图表查看器">
    <header className="mermaid-viewer-titlebar" onDoubleClick={() => control('toggle-maximize')}>
      <span><AppIcon name="image" size={16} />Mermaid 图表</span>
      <div className="mermaid-viewer-window-controls" onDoubleClick={event => event.stopPropagation()}>
        <button type="button" aria-label="最小化" data-tooltip="最小化" onClick={() => control('minimize')}><AppIcon name="minimize" /></button>
        <button type="button" aria-label={maximized ? '还原' : '最大化'} data-tooltip={maximized ? '还原' : '最大化'} onClick={() => control('toggle-maximize')}><AppIcon name={maximized ? 'restore' : 'maximize'} /></button>
        <button type="button" className="mermaid-viewer-close" aria-label="关闭" data-tooltip="关闭（Esc）" onClick={() => control('close')}><AppIcon name="close" /></button>
      </div>
    </header>
    <nav className="mermaid-viewer-toolbar" aria-label="图表缩放">
      <button type="button" disabled={!diagram} onClick={() => chooseMode('fit')}>适合窗口</button>
      <button type="button" disabled={!diagram} data-tooltip="最小文字达到 14 CSS 像素" onClick={() => chooseMode('reading')}>阅读大小</button>
      <span className="mermaid-viewer-divider" />
      <button type="button" disabled={!diagram} aria-label="缩小" data-tooltip="缩小" onClick={() => applyScale(scaleRef.current / 1.2, 'manual')}>−</button>
      <output aria-label="缩放比例">{Math.round(scale * 100)}%</output>
      <button type="button" disabled={!diagram} aria-label="放大" data-tooltip="放大" onClick={() => applyScale(scaleRef.current * 1.2, 'manual')}>+</button>
      <span className="mermaid-viewer-hint">滚轮缩放 · 拖动平移</span>
    </nav>
    <div ref={viewportRef} className={`mermaid-viewer-viewport${dragging ? ' is-dragging' : ''}`} tabIndex={0} aria-label="图表画布"
      onContextMenu={event => {
        event.preventDefault()
        if (!diagram) return
        contextMenu.openMenu({
          x: event.clientX, y: event.clientY, rootIconGutter: 'none',
          items: [{ kind: 'command', id: 'save-image', label: '保存为图片', disabled: savingRef.current }],
          execute: () => saveImage(),
          restoreFocus: () => viewportRef.current?.focus(),
        })
      }}
      onPointerDown={event => {
        if (event.button !== 0 || !diagram) return
        const viewport = event.currentTarget
        // Leave native scrollbar interaction to the browser.
        const bounds = viewport.getBoundingClientRect()
        if (event.clientX - bounds.left >= viewport.clientWidth || event.clientY - bounds.top >= viewport.clientHeight) return
        dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop }
        viewport.setPointerCapture(event.pointerId)
        setDragging(true)
        event.preventDefault()
      }}
      onPointerMove={event => {
        const drag = dragRef.current
        if (!drag || drag.id !== event.pointerId) return
        event.currentTarget.scrollLeft = drag.left + drag.x - event.clientX
        event.currentTarget.scrollTop = drag.top + drag.y - event.clientY
      }}
      onPointerUp={event => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        dragRef.current = null; setDragging(false)
      }}
      onPointerCancel={() => { dragRef.current = null; setDragging(false) }}
      onLostPointerCapture={() => { dragRef.current = null; setDragging(false) }}>
      <div className="mermaid-viewer-stage" style={{ width: contentWidth + VIEWER_GUTTER * 2, height: contentHeight + VIEWER_GUTTER * 2 }}>
        <div className="mermaid-viewer-image" style={{ width: contentWidth, height: contentHeight, opacity: diagram ? 1 : 0 }}>
          <div ref={svgHostRef} className="mermaid-viewer-svg" style={{ transform: `scale(${scale})` }} />
        </div>
      </div>
    </div>
    {!diagram && <div className="mermaid-viewer-status" role={error ? 'alert' : 'status'}>{error ? '无法加载图表，请关闭窗口后重试。' : '正在加载图表…'}</div>}
    {saveError && <div className="mermaid-viewer-save-error" role="alert">{saveError}</div>}
  </main>
}
