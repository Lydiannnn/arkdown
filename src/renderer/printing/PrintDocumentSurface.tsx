import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { ArkdownApi } from '../../shared/contracts'
import { editorFontFamilyCss } from '../../shared/editor-appearance-preferences'
import {
  PRINT_DOCUMENT_LAYOUT_RESERVE_MS,
  type PrintSurfaceDocumentInput,
} from '../../shared/printing'
import { isPrintDocumentToken } from '../../shared/printing'
import { normalizeThemeColor, themeColorRgbChannels } from '../../shared/theme-color'
import { externalAssetPathFromUrl } from '../../shared/local-resource-path'
import { VisualEditor, type VisualEditorHandle } from '../editor/VisualEditor'
import './print-document.css'

type PrintSurfaceApi = Pick<
  ArkdownApi,
  'takePrintDocument' | 'readyPrintDocument'
>

export interface PrintDocumentSurfaceProps {
  token: string
  api?: PrintSurfaceApi
}

function waitForImage(image: HTMLImageElement, signal: AbortSignal): Promise<void> {
  if (image.complete || signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const finish = () => {
      image.removeEventListener('load', finish)
      image.removeEventListener('error', finish)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    image.addEventListener('load', finish)
    image.addEventListener('error', finish)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}

function nextLayoutFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve()
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

export function replaceNonPrintableMedia(root: ParentNode): void {
  for (const media of root.querySelectorAll<HTMLAudioElement | HTMLVideoElement>('audio, video')) {
    const kind = media.tagName === 'AUDIO' ? 'Audio' : 'Video'
    const source = media.currentSrc || media.getAttribute('src') || 'Unavailable source'
    const readableSource = externalAssetPathFromUrl(source) ?? source
    const fallback = media.ownerDocument.createElement('p')
    fallback.className = 'print-media-fallback'
    fallback.textContent = `${kind}: ${readableSource}`
    media.replaceWith(fallback)
  }
}

async function preparePrintLayout(root: HTMLElement, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  replaceNonPrintableMedia(root)
  if (signal.aborted) return
  const fonts = root.ownerDocument.fonts
  if (fonts) await fonts.ready.catch(() => undefined)
  if (signal.aborted) return
  await Promise.all([...root.querySelectorAll('img')].map((image) => waitForImage(image, signal)))
  if (signal.aborted) return
  await nextLayoutFrame()
  if (signal.aborted) return
  await nextLayoutFrame()
}

export function PrintDocumentSurface({
  token,
  api = window.arkdown,
}: PrintDocumentSurfaceProps) {
  const [input, setInput] = useState<PrintSurfaceDocumentInput | null>(null)
  const [failed, setFailed] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const editorRef = useRef<VisualEditorHandle>(null)
  const readyStarted = useRef(false)
  const mounted = useRef(true)
  const layoutAbort = useRef<AbortController | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      layoutAbort.current?.abort()
      layoutAbort.current = null
    }
  }, [])

  useEffect(() => {
    let active = true
    if (!isPrintDocumentToken(token)) {
      setFailed(true)
      return () => { active = false }
    }
    void api.takePrintDocument(token).then((result) => {
      if (!active) return
      if (!result.ok) {
        setFailed(true)
        return
      }
      document.title = result.value.documentName
      setInput(result.value)
    }, () => {
      if (active) setFailed(true)
    })
    return () => { active = false }
  }, [api, token])

  const reportReady = useCallback(async () => {
    const root = rootRef.current
    if (readyStarted.current) return
    if (!root) {
      if (mounted.current) setFailed(true)
      return
    }
    readyStarted.current = true
    const controller = new AbortController()
    layoutAbort.current = controller
    const editor = editorRef.current
    if (!editor) {
      if (mounted.current) setFailed(true)
      return
    }
    try {
      try {
        await editor.whenRenderIdle()
      } catch {
        // A diagram error has reached a terminal state; the print layout can continue.
      }
      if (controller.signal.aborted) return
      await preparePrintLayout(root, controller.signal)
      if (controller.signal.aborted) return
      const result = await api.readyPrintDocument(token)
      if (controller.signal.aborted) return
      if (!result.ok) setFailed(true)
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      if (layoutAbort.current === controller) layoutAbort.current = null
    }
  }, [api, token])

  if (failed) {
    return <main className="print-document-error" role="alert">
      Unable to prepare document for printing
    </main>
  }
  if (!input) return <main aria-busy="true" className="print-document-loading" />

  const mermaidAppearance = {
    revision: 0,
    editorTheme: 'minimal' as const,
    colorScheme: 'light' as const,
    themeColor: normalizeThemeColor(input.appearance.themeColor),
    bodyFontFamily: [input.appearance.bodyLatinFont, input.appearance.bodyCjkFont]
      .map((font) => JSON.stringify(font))
      .join(', '),
  }

  return <main
    aria-label="Rendered document for printing"
    data-editor-theme="minimal"
    className={[
      'print-document-surface',
      input.appearance.preserveSingleLineBreaks ? 'preserve-single-line-breaks' : '',
    ].filter(Boolean).join(' ')}
    ref={rootRef}
    style={{
      '--theme-color-rgb': themeColorRgbChannels(input.appearance.themeColor),
      '--editor-minimum-margin': `${input.appearance.minimumContentMarginPx}px`,
      '--editor-maximum-width': `${input.appearance.maximumContentWidthPx}px`,
      '--heading-latin-font': editorFontFamilyCss(input.appearance.headingLatinFont),
      '--heading-cjk-font': JSON.stringify(input.appearance.headingCjkFont),
      '--body-latin-font': editorFontFamilyCss(input.appearance.bodyLatinFont),
      '--body-cjk-font': JSON.stringify(input.appearance.bodyCjkFont),
    } as CSSProperties}
  >
    <VisualEditor
      documentAbsolutePath={input.documentAbsolutePath ?? null}
      editorTheme="minimal"
      markdown={input.markdown}
      mermaidAppearance={mermaidAppearance}
      mermaidPrintDeadlineEpochMs={
        input.surfaceDeadlineEpochMs - PRINT_DOCUMENT_LAYOUT_RESERVE_MS
      }
      onChange={() => undefined}
      onReady={reportReady}
      readOnly
      ref={editorRef}
    />
  </main>
}
