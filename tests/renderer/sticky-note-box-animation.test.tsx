import { readFileSync } from 'node:fs'
import path from 'node:path'
import { act, fireEvent, render } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArkdownApi } from '../../src/shared/contracts'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import { modelCommit } from '../helpers/model-observation'
import { stickyNoteApiStubs } from './sticky-note-api-stubs'
import { applicationMenuApiStubs } from './application-menu-api-stubs'

vi.mock('../../src/renderer/editor/EditorPane', () => ({
  EditorPane: forwardRef<{ flush: () => string | null }, {
    documentKey: string
    markdown: string
    onChange: (markdown: string) => void
  }>(function TestEditor({ documentKey, markdown, onChange }, ref) {
    useImperativeHandle(ref, () => ({ flush: () => null }))
    return <textarea aria-label="Markdown editor" data-document-key={documentKey} onChange={(event) => onChange(event.target.value)} value={markdown} />
  }),
}))

import { App } from '../../src/renderer/app/App'

const appCss = readFileSync(path.join(process.cwd(), 'src/renderer/app/styles.css'), 'utf8')
const css = readFileSync(path.join(process.cwd(), 'src/renderer/sticky-notes/sticky-note-box.css'), 'utf8')
const modelApiFailure = async () => ({
  ok: false as const,
  error: { code: 'OPERATION_FAILED' as const, message: 'Unavailable in test' },
})

function installApi() {
  window.arkdown = {
    chooseWorkspace: vi.fn(async () => ({ ok: true as const, value: null })),
    restoreWorkspace: vi.fn(async () => ({ ok: true as const, value: null })),
    listDirectory: vi.fn(async () => ({ ok: true as const, value: [] })),
    openDroppedPath: vi.fn(),
    pathForDroppedFile: vi.fn(() => ''),
    createDocument: vi.fn(),
    readDocument: vi.fn(),
    peekDocument: vi.fn(),
    saveDocument: vi.fn(),
    revealDocument: vi.fn(),
    trashDocument: vi.fn(),
    getLargeModelSettings: vi.fn(modelApiFailure),
    getModelSettingsSnapshot: vi.fn(modelApiFailure),
    connectModel: vi.fn(modelApiFailure),
    listModels: vi.fn(modelApiFailure),
    testModel: vi.fn(modelApiFailure),
    deleteModel: vi.fn(modelApiFailure),
    setAiConversationSettings: vi.fn(modelApiFailure),
    testCodexCliConnection: vi.fn(async () => ({ ok: true as const, value: { status: 'not-found' as const, mutation: modelCommit(DEFAULT_LARGE_MODEL_SETTINGS) } })),
    removeCodexCliConnection: vi.fn(async () => ({ ok: true as const, value: modelCommit(DEFAULT_LARGE_MODEL_SETTINGS) })),
    setSelectionTranslationSettings: vi.fn(modelApiFailure),
    setScreenshotTranslationSettings: vi.fn(modelApiFailure),
    setFloatingTranslationSettings: vi.fn(modelApiFailure),
    acceptTranslationPrivacyNotice: vi.fn(modelApiFailure),
    startAiConversation: vi.fn(modelApiFailure),
    cancelAiConversation: vi.fn((_input: Parameters<ArkdownApi['cancelAiConversation']>[0]) => modelApiFailure()),
    getAiWorkspaceState: vi.fn(modelApiFailure),
    setAiConversationCapabilities: vi.fn(modelApiFailure),
    submitAiAuthorizationResult: vi.fn(modelApiFailure),
    clearAiConversation: vi.fn(modelApiFailure),
    notifyAiCurrentDocumentChanged: vi.fn(modelApiFailure),
    registerAiCurrentDocumentPort: vi.fn(modelApiFailure),
    unregisterAiCurrentDocumentPort: vi.fn(modelApiFailure),
    registerAiOpenDocumentPort: vi.fn(modelApiFailure),
    unregisterAiOpenDocumentPort: vi.fn(modelApiFailure),
    openAiMessageLink: vi.fn(modelApiFailure),
    onAiConversationEvent: vi.fn(() => () => undefined),
    startTranslation: vi.fn(modelApiFailure),
    cancelTranslation: vi.fn(modelApiFailure),
    onTranslationEvent: vi.fn(() => () => undefined),
    ...stickyNoteApiStubs,
    ...applicationMenuApiStubs,
    onPrepareClose: vi.fn(() => () => undefined),
  } as ArkdownApi
}

beforeEach(() => {
  vi.useFakeTimers()
  installApi()
})

afterEach(() => vi.useRealTimers())

function rule(selector: string, source = css): string {
  const selectorStart = source.indexOf(selector)
  if (selectorStart < 0) throw new Error('Missing CSS rule for ' + selector)
  const bodyStart = source.indexOf('{', selectorStart) + 1
  const bodyEnd = source.indexOf('}', bodyStart)
  return source.slice(bodyStart, bodyEnd).replace(/\s+/g, ' ')
}

describe('sticky note box motion', () => {
  it('keeps the box mounted after first open and closes through one stable DOM tree', () => {
    render(<App />)
    const toggle = document.querySelector<HTMLButtonElement>('.sticky-note-box-toolbar-button')!

    fireEvent.click(toggle)
    expect(document.querySelector('.sticky-note-box-motion')).toHaveAttribute('data-open', 'false')

    act(() => vi.advanceTimersByTime(20))
    expect(document.querySelector('.sticky-note-box-motion')).toHaveAttribute('data-open', 'false')

    act(() => vi.advanceTimersByTime(20))
    expect(document.querySelector('.sticky-note-box-motion')).toHaveAttribute('data-open', 'true')

    fireEvent.click(toggle)
    expect(document.querySelector('.sticky-note-box-motion')).toHaveAttribute('data-open', 'false')
    act(() => vi.advanceTimersByTime(500))
    expect(document.querySelector('.sticky-note-box-motion')).toBeInTheDocument()
  })

  it('cancels a pending open frame so closing cannot produce a stale flash', () => {
    render(<App />)
    const toggle = document.querySelector<HTMLButtonElement>('.sticky-note-box-toolbar-button')!

    fireEvent.click(toggle)
    fireEvent.click(document.querySelector<HTMLButtonElement>('.sticky-note-box-header button')!)
    act(() => vi.advanceTimersByTime(40))

    expect(document.querySelector('.sticky-note-box-motion')).toHaveAttribute('data-open', 'false')
  })

  it('clears the pending animation frame when the app unmounts', () => {
    const { unmount } = render(<App />)
    const toggle = document.querySelector<HTMLButtonElement>('.sticky-note-box-toolbar-button')!
    const timersBeforeOpen = vi.getTimerCount()

    fireEvent.click(toggle)
    expect(vi.getTimerCount()).toBeGreaterThan(timersBeforeOpen)
    unmount()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('owns the closed and open grid tracks in the main shell without import-order conflicts', () => {
    expect(rule('.app-shell', appCss)).toContain('grid-template-columns: var(--sidebar-width, 300px) 0 minmax(0, 1fr) 0px')
    expect(rule('.app-shell', appCss)).toContain('--sidebar-motion-duration: 240ms')
    expect(rule('.app-shell', appCss)).toContain('--sidebar-motion-easing: cubic-bezier(.2, .8, .2, 1)')
    expect(rule('.app-shell', appCss)).toContain(
      'transition: grid-template-columns var(--sidebar-motion-duration) var(--sidebar-motion-easing)',
    )
    expect(rule('.app-shell.sidebar-collapsed', appCss)).toContain('grid-template-columns: 0 0 minmax(0, 1fr) 0px')
    expect(css).not.toMatch(/\\.app-shell\\s*\\{/)
  })

  it('keeps a fixed-width panel inside the animated clipping track', () => {
    expect(rule('.app-shell .sticky-note-box-motion > .sticky-note-box-panel')).toContain('position: absolute')
    expect(rule('.app-shell .sticky-note-box-motion > .sticky-note-box-panel')).toContain('width: var(--sticky-note-box-width)')
    expect(rule('.sticky-note-box-motion')).not.toContain('transform:')
    expect(rule('.sticky-note-box-motion')).not.toContain('opacity:')
    expect(css).not.toContain('.sticky-note-box-motion[data-open="false"] { transform:')
  })

  it('removes the layout transition when reduced motion is requested', () => {
    expect(appCss).toContain('.app-shell { transition: none; }')
  })
})
