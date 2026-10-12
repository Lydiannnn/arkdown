import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_EDITOR_APPEARANCE } from '../../src/shared/editor-appearance-preferences'
import type { PrintSurfaceDocumentInput } from '../../src/shared/printing'
import { externalAssetUrl } from '../../src/shared/local-resource-path'

const visualEditor = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  attachHandle: true,
  handle: { whenRenderIdle: vi.fn<() => Promise<void>>() },
}))

vi.mock('../../src/renderer/editor/VisualEditor', async () => {
  const React = await import('react')
  return {
    VisualEditor: React.forwardRef((props: Record<string, unknown>, ref) => {
      visualEditor.props = props
      React.useImperativeHandle(ref, () => visualEditor.attachHandle ? visualEditor.handle : null, [])
      return React.createElement(
        'section',
        { 'aria-label': 'Rendered Markdown document' },
        String(props.markdown),
        React.createElement('img', { alt: 'document asset', 'data-testid': 'print-image' }),
      )
    }),
  }
})

import {
  PrintDocumentSurface,
  replaceNonPrintableMedia,
} from '../../src/renderer/printing/PrintDocumentSurface'

const token = '00000000-0000-4000-8000-000000000001'
const input: PrintSurfaceDocumentInput = {
  markdown: '# Printed title\n\nRendered body',
  documentName: 'plan.md',
  documentAbsolutePath: 'C:\\Docs\\plan.md',
  appearance: {
    ...DEFAULT_EDITOR_APPEARANCE,
    minimumContentMarginPx: 40,
    maximumContentWidthPx: 900,
    headingLatinFont: 'Arial',
    headingCjkFont: 'SimHei',
    bodyLatinFont: 'Arial',
    bodyCjkFont: 'SimSun',
    themeColor: '#2563EB',
  },
  surfaceDeadlineEpochMs: 1_788_048_030_000,
}

const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts')
const originalRequestAnimationFrame = globalThis.requestAnimationFrame

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function mockImageComplete(value: boolean) {
  Object.defineProperty(screen.getByTestId('print-image'), 'complete', {
    configurable: true,
    value,
  })
}

function completeLayoutImmediately() {
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0)
    return 1
  }) as typeof requestAnimationFrame
}

function triggerReady(): Promise<void> {
  return (visualEditor.props?.onReady as (() => Promise<void>))()
}

beforeEach(() => {
  visualEditor.props = null
  visualEditor.attachHandle = true
  visualEditor.handle.whenRenderIdle.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts)
  else Reflect.deleteProperty(document, 'fonts')
  if (originalRequestAnimationFrame) globalThis.requestAnimationFrame = originalRequestAnimationFrame
  else Reflect.deleteProperty(globalThis, 'requestAnimationFrame')
})

it('renders the payload through a read-only VisualEditor with print appearance and no app chrome', async () => {
  const normalizedInput: PrintSurfaceDocumentInput = {
    ...input,
    appearance: { ...input.appearance, themeColor: '#2563eb' },
  }
  const api = {
    takePrintDocument: vi.fn(async () => ({ ok: true as const, value: normalizedInput })),
    readyPrintDocument: vi.fn(async () => ({ ok: true as const, value: null })),
  }
  const { container } = render(<PrintDocumentSurface api={api} token={token} />)

  expect(await screen.findByLabelText('Rendered Markdown document')).toHaveTextContent('Printed title')
  expect(api.takePrintDocument).toHaveBeenCalledWith(token)
  expect(visualEditor.props).toMatchObject({
    markdown: normalizedInput.markdown,
    documentAbsolutePath: normalizedInput.documentAbsolutePath,
    editorTheme: 'minimal',
    readOnly: true,
    mermaidAppearance: {
      revision: 0,
      editorTheme: 'minimal',
      colorScheme: 'light',
      themeColor: '#2563EB',
      bodyFontFamily: '"Arial", "SimSun"',
    },
    mermaidPrintDeadlineEpochMs: input.surfaceDeadlineEpochMs - 10_000,
  })
  const surface = screen.getByRole('main', { name: 'Rendered document for printing' })
  expect(surface).toHaveAttribute('data-editor-theme', 'minimal')
  expect(surface).toHaveClass('preserve-single-line-breaks')
  expect(surface).toHaveStyle({
    '--editor-minimum-margin': '40px',
    '--editor-maximum-width': '900px',
    '--heading-latin-font': '"Arial"',
    '--body-cjk-font': '"SimSun"',
  })
  expect(document.title).toBe('plan.md')
  expect(container.querySelector('.app-shell')).toBeNull()
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

it('waits for Mermaid idle before fonts, images, and exactly two layout frames', async () => {
  const api = {
    takePrintDocument: vi.fn(async () => ({ ok: true as const, value: input })),
    readyPrintDocument: vi.fn(async () => ({ ok: true as const, value: null })),
  }
  const events: string[] = []
  const mermaid = deferred<void>()
  const fonts = deferred<FontFaceSet>()
  const frames: FrameRequestCallback[] = []
  visualEditor.handle.whenRenderIdle.mockImplementation(() => {
    events.push('mermaid-start')
    return mermaid.promise
  })
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    get: () => {
      events.push('fonts')
      return { ready: fonts.promise }
    },
  })
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  }) as typeof requestAnimationFrame
  render(<PrintDocumentSurface api={api} token={token} />)
  await screen.findByLabelText('Rendered Markdown document')
  mockImageComplete(false)
  expect(api.readyPrintDocument).not.toHaveBeenCalled()

  events.push('crepe-ready')
  const onReady = visualEditor.props?.onReady as (() => Promise<void>)
  let readiness!: Promise<void>
  act(() => {
    readiness = onReady()
  })
  expect(events).toEqual(['crepe-ready', 'mermaid-start'])
  expect(api.readyPrintDocument).not.toHaveBeenCalled()

  await act(async () => {
    mermaid.resolve()
    await Promise.resolve()
  })
  expect(events).toEqual(['crepe-ready', 'mermaid-start', 'fonts'])
  expect(api.readyPrintDocument).not.toHaveBeenCalled()

  await act(async () => {
    fonts.resolve({} as FontFaceSet)
    await Promise.resolve()
  })
  screen.getByTestId('print-image').dispatchEvent(new Event('load'))
  await act(async () => { await Promise.resolve() })
  expect(api.readyPrintDocument).not.toHaveBeenCalled()

  await act(async () => {
    frames.shift()?.(0)
    await Promise.resolve()
  })
  expect(api.readyPrintDocument).not.toHaveBeenCalled()

  await act(async () => {
    frames.shift()?.(16)
    await readiness
  })
  expect(api.readyPrintDocument).toHaveBeenCalledTimes(1)
  expect(api.readyPrintDocument).toHaveBeenCalledWith(token)
})

it('continues through the error layout when the Mermaid barrier rejects', async () => {
  const api = {
    takePrintDocument: vi.fn(async () => ({ ok: true as const, value: input })),
    readyPrintDocument: vi.fn(async () => ({ ok: true as const, value: null })),
  }
  visualEditor.handle.whenRenderIdle.mockRejectedValue(new Error('diagram render failed'))
  completeLayoutImmediately()
  render(<PrintDocumentSurface api={api} token={token} />)
  await screen.findByLabelText('Rendered Markdown document')
  mockImageComplete(false)

  let readiness!: Promise<void>
  act(() => { readiness = triggerReady() })
  await act(async () => { await Promise.resolve() })
  expect(api.readyPrintDocument).not.toHaveBeenCalled()

  await act(async () => {
    screen.getByTestId('print-image').dispatchEvent(new Event('error'))
    await readiness
  })

  expect(api.readyPrintDocument).toHaveBeenCalledOnce()
  expect(api.readyPrintDocument).toHaveBeenCalledWith(token)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('deduplicates concurrent repeated Crepe readiness callbacks', async () => {
  const api = {
    takePrintDocument: vi.fn(async () => ({ ok: true as const, value: input })),
    readyPrintDocument: vi.fn(async () => ({ ok: true as const, value: null })),
  }
  completeLayoutImmediately()
  render(<PrintDocumentSurface api={api} token={token} />)
  await screen.findByLabelText('Rendered Markdown document')
  mockImageComplete(true)

  await act(async () => { await Promise.all([triggerReady(), triggerReady()]) })

  expect(visualEditor.handle.whenRenderIdle).toHaveBeenCalledOnce()
  expect(api.readyPrintDocument).toHaveBeenCalledOnce()
  expect(api.readyPrintDocument).toHaveBeenCalledWith(token)
})

it('fails visibly and never signals ready when Crepe calls onReady before its required handle attaches', async () => {
  const api = {
    takePrintDocument: vi.fn(async () => ({ ok: true as const, value: input })),
    readyPrintDocument: vi.fn(async () => ({ ok: true as const, value: null })),
  }
  visualEditor.attachHandle = false
  completeLayoutImmediately()
  render(<PrintDocumentSurface api={api} token={token} />)
  await screen.findByLabelText('Rendered Markdown document')
  mockImageComplete(true)

  await act(async () => { await expect(triggerReady()).resolves.toBeUndefined() })

  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to prepare document for printing')
  expect(api.readyPrintDocument).not.toHaveBeenCalled()
})

it('cancels the Mermaid-to-layout transition when the surface unmounts during the idle barrier', async () => {
  const api = {
    takePrintDocument: vi.fn(async () => ({ ok: true as const, value: input })),
    readyPrintDocument: vi.fn(async () => ({ ok: true as const, value: null })),
  }
  const mermaid = deferred<void>()
  const fonts = vi.fn(() => ({ ready: Promise.resolve() }))
  visualEditor.handle.whenRenderIdle.mockReturnValue(mermaid.promise)
  Object.defineProperty(document, 'fonts', { configurable: true, get: fonts })
  const rendered = render(<PrintDocumentSurface api={api} token={token} />)
  await screen.findByLabelText('Rendered Markdown document')

  act(() => { void triggerReady() })
  rendered.unmount()
  await act(async () => {
    mermaid.resolve()
    await Promise.resolve()
  })

  expect(fonts).not.toHaveBeenCalled()
  expect(api.readyPrintDocument).not.toHaveBeenCalled()
})

it('cancels remaining layout work when the surface unmounts while fonts are pending', async () => {
  const api = {
    takePrintDocument: vi.fn(async () => ({ ok: true as const, value: input })),
    readyPrintDocument: vi.fn(async () => ({ ok: true as const, value: null })),
  }
  const fonts = deferred<FontFaceSet>()
  const frames: FrameRequestCallback[] = []
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: fonts.promise },
  })
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  }) as typeof requestAnimationFrame
  const rendered = render(<PrintDocumentSurface api={api} token={token} />)
  await screen.findByLabelText('Rendered Markdown document')
  mockImageComplete(true)

  act(() => { void triggerReady() })
  await act(async () => { await Promise.resolve() })
  rendered.unmount()
  await act(async () => {
    fonts.resolve({} as FontFaceSet)
    await Promise.resolve()
  })

  expect(frames).toHaveLength(0)
  expect(api.readyPrintDocument).not.toHaveBeenCalled()
})

it('settles image readiness and removes image listeners when unmounted after image waiting begins', async () => {
  const api = {
    takePrintDocument: vi.fn(async () => ({ ok: true as const, value: input })),
    readyPrintDocument: vi.fn(async () => ({ ok: true as const, value: null })),
  }
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve() },
  })
  const rendered = render(<PrintDocumentSurface api={api} token={token} />)
  await screen.findByLabelText('Rendered Markdown document')
  mockImageComplete(false)
  const image = screen.getByTestId('print-image')
  const removeEventListener = vi.spyOn(image, 'removeEventListener')
  let readiness!: Promise<void>
  let settled = false

  act(() => {
    readiness = triggerReady()
    void readiness.then(() => { settled = true })
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  rendered.unmount()
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  expect(settled).toBe(true)
  expect(removeEventListener.mock.calls.map(([type]) => type)).toEqual(
    expect.arrayContaining(['load', 'error']),
  )
  image.dispatchEvent(new Event('load'))
  image.dispatchEvent(new Event('error'))
  expect(api.readyPrintDocument).not.toHaveBeenCalled()
})

it('shows the failed surface when layout preparation unexpectedly rejects', async () => {
  const api = {
    takePrintDocument: vi.fn(async () => ({ ok: true as const, value: input })),
    readyPrintDocument: vi.fn(async () => ({ ok: true as const, value: null })),
  }
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    get: () => { throw new Error('fonts unavailable') },
  })
  render(<PrintDocumentSurface api={api} token={token} />)
  await screen.findByLabelText('Rendered Markdown document')

  await act(async () => { await expect(triggerReady()).resolves.toBeUndefined() })

  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to prepare document for printing')
  expect(api.readyPrintDocument).not.toHaveBeenCalled()
})

it('shows the failed surface when readyPrintDocument rejects', async () => {
  const api = {
    takePrintDocument: vi.fn(async () => ({ ok: true as const, value: input })),
    readyPrintDocument: vi.fn(async () => { throw new Error('ready IPC failed') }),
  }
  completeLayoutImmediately()
  render(<PrintDocumentSurface api={api} token={token} />)
  await screen.findByLabelText('Rendered Markdown document')
  mockImageComplete(true)

  await act(async () => { await expect(triggerReady()).resolves.toBeUndefined() })

  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to prepare document for printing')
  expect(api.readyPrintDocument).toHaveBeenCalledWith(token)
})

it('shows the failed surface when readyPrintDocument returns an error result', async () => {
  const api = {
    takePrintDocument: vi.fn(async () => ({ ok: true as const, value: input })),
    readyPrintDocument: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'OPERATION_FAILED', message: 'Operation failed' },
    })),
  }
  completeLayoutImmediately()
  render(<PrintDocumentSurface api={api} token={token} />)
  await screen.findByLabelText('Rendered Markdown document')
  mockImageComplete(true)

  await act(async () => { await triggerReady() })

  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to prepare document for printing')
  expect(api.readyPrintDocument).toHaveBeenCalledWith(token)
})

it('decodes internal audio and video asset URLs to readable source paths before print', () => {
  const root = document.createElement('div')
  const audioPath = 'C:\\Media\\meeting notes.mp3'
  const videoPath = '\\\\server\\share\\demo clip.mp4'
  root.innerHTML = [
    `<audio src="${externalAssetUrl(audioPath)}"></audio>`,
    `<video src="${externalAssetUrl(videoPath)}"></video>`,
  ].join('')

  replaceNonPrintableMedia(root)

  expect(root.querySelector('audio')).toBeNull()
  expect(root.querySelector('video')).toBeNull()
  expect(root.textContent).toContain(`Audio: ${audioPath}`)
  expect(root.textContent).toContain(`Video: ${videoPath}`)
  expect(root.textContent).not.toContain('%5C')
})

it('shows a stable surface error and never acknowledges an unavailable payload', async () => {
  const api = {
    takePrintDocument: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'OPERATION_FAILED', message: 'Operation failed' },
    })),
    readyPrintDocument: vi.fn(async () => ({ ok: true as const, value: null })),
  }
  render(<PrintDocumentSurface api={api} token={token} />)

  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to prepare document for printing')
  expect(api.readyPrintDocument).not.toHaveBeenCalled()
})
