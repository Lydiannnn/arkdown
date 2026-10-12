import { act, render, screen, waitFor } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArkdownApi, BackgroundPresentationEvent } from '../../src/shared/contracts'
import { DEFAULT_ARKNOTE_PREFERENCES } from '../../src/shared/arknote-preferences'
import { DEFAULT_EDITOR_APPEARANCE } from '../../src/shared/editor-appearance-preferences'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'
import { stickyNoteApiStubs } from './sticky-note-api-stubs'

vi.mock('../../src/renderer/editor/edit-indicators/use-edit-indicator-model', () => ({
  useEditIndicatorModel: () => ({
    lineStates: [], status: 'idle', markdownVersion: 0, modelVersion: 0,
  }),
}))

vi.mock('../../src/renderer/editor/EditorPane', () => ({
  EditorPane: forwardRef(function EditorPane(_props, ref) {
    useImperativeHandle(ref, () => ({ flush: () => null }))
    return <div className="editor-pane" data-testid="main-editor-pane">
      <div className="editor-surface"><div className="visual-editor">
        <div className="milkdown"><div className="ProseMirror">Editor</div></div>
      </div></div>
    </div>
  }),
}))

vi.mock('../../src/renderer/backgrounds/BackgroundImageLayer', () => ({
  BackgroundImageLayer: (props: {
    anchor: string
    imageUrl: string | null
    settings: typeof DEFAULT_BACKGROUND_SETTINGS
  }) => <div
    data-anchor={props.anchor}
    data-image-url={props.imageUrl ?? ''}
    data-mask-type={props.settings.maskType}
    data-testid="background-image-layer"
  />,
}))

import { App } from '../../src/renderer/app/App'

const workspace = { name: 'Notes', absolutePath: 'C:/Notes' }
const revision = 'a'.repeat(64)
let backgroundListener: ((event: BackgroundPresentationEvent) => void) | null = null

function ok<T>(value: T) {
  return { ok: true as const, value }
}

function installApi(overrides: Partial<ArkdownApi>) {
  window.arkdown = {
    chooseWorkspace: vi.fn(async () => ok(workspace)),
    restoreWorkspace: vi.fn(async () => ok(null)),
    listDirectory: vi.fn(async () => ok([])),
    openDroppedPath: vi.fn(async () => ok({ workspace, document: null })),
    inspectDroppedPath: vi.fn(async (absolutePath: string) => ok({ kind: 'file' as const, absolutePath })),
    pathForDroppedFile: vi.fn(() => ''),
    createDocument: vi.fn(async (relativePath: string) => ok({ relativePath, markdown: '', revision, encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 1 })),
    readDocument: vi.fn(async (relativePath: string) => ok({ relativePath, markdown: '', revision, encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 1 })),
    peekDocument: vi.fn(async (relativePath: string) => ok({ relativePath, markdown: '', revision, encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 1 })),
    saveDocument: vi.fn(async () => ok({ revision, mtimeMs: 1 })),
    saveDraft: vi.fn(async () => ok(null)),
    discardDraft: vi.fn(async () => ok(null)),
    revealDocument: vi.fn(async () => ok(null)),
    trashDocument: vi.fn(async () => ok(null)),
    getArknotePreferences: vi.fn(async () => ok(DEFAULT_ARKNOTE_PREFERENCES)),
    setArknotePreferences: vi.fn(async (value) => ok(value)),
    getSearchPreferences: vi.fn(async () => ok({ preferExternalBrowser: false })),
    setSearchPreferences: vi.fn(async (value) => ok(value)),
    getEditorAppearancePreferences: vi.fn(async () => ok({ appearance: DEFAULT_EDITOR_APPEARANCE, revision: 0 })),
    setEditorAppearancePreferences: vi.fn(async (appearance) => ok({ appearance, revision: 1 })),
    compareAndSetEditorAppearancePreferences: vi.fn(async (_revision, _expected, appearance) => ok({ appearance, revision: 1 })),
    getSystemFonts: vi.fn(async () => ok([])),
    getLargeModelSettings: vi.fn(async () => ({ ok: false as const, error: { code: 'UNAVAILABLE', message: 'Unavailable' } })),
    connectModel: vi.fn(async () => ({ ok: false as const, error: { code: 'UNAVAILABLE', message: 'Unavailable' } })),
    listModels: vi.fn(async () => ({ ok: false as const, error: { code: 'UNAVAILABLE', message: 'Unavailable' } })),
    testModel: vi.fn(async () => ({ ok: false as const, error: { code: 'UNAVAILABLE', message: 'Unavailable' } })),
    deleteModel: vi.fn(async () => ({ ok: false as const, error: { code: 'UNAVAILABLE', message: 'Unavailable' } })),
    setSelectionTranslationSettings: vi.fn(async () => ({ ok: false as const, error: { code: 'UNAVAILABLE', message: 'Unavailable' } })),
    setScreenshotTranslationSettings: vi.fn(async () => ({ ok: false as const, error: { code: 'UNAVAILABLE', message: 'Unavailable' } })),
    acceptTranslationPrivacyNotice: vi.fn(async () => ({ ok: false as const, error: { code: 'UNAVAILABLE', message: 'Unavailable' } })),
    startTranslation: vi.fn(async () => ({ ok: false as const, error: { code: 'UNAVAILABLE', message: 'Unavailable' } })),
    cancelTranslation: vi.fn(async () => ({ ok: false as const, error: { code: 'UNAVAILABLE', message: 'Unavailable' } })),
    onTranslationEvent: vi.fn(() => () => undefined),
    ...stickyNoteApiStubs,
    onRecoverDraft: vi.fn(() => () => undefined),
    onMenuCommand: vi.fn(() => () => undefined),
    recordRecentDocument: vi.fn(async () => ok([])),
    updateApplicationMenuWindowState: vi.fn(async () => ok(undefined)),
    onApplicationMenuChanged: vi.fn(() => () => undefined),
    onEditorAppearancePreferencesChanged: vi.fn(() => () => undefined),
    printDocument: vi.fn(async () => ok(null)),
    takePrintDocument: vi.fn(async () => ({ ok: false as const, error: { code: 'UNAVAILABLE', message: 'Unavailable' } })),
    readyPrintDocument: vi.fn(async () => ok(null)),
    controlWindow: vi.fn(async () => ok({ maximized: false, fullscreen: false, revision: 0 })),
    getWindowState: vi.fn(async () => ok({ maximized: false, fullscreen: false, revision: 0 })),
    onWindowStateChanged: vi.fn(() => () => undefined),
    onPrepareClose: vi.fn(() => () => undefined),
    ...overrides,
  } as ArkdownApi
}

beforeEach(() => {
  backgroundListener = null
})

describe('main editor background integration', () => {
  it('loads the main presentation, ignores sticky events, and layers a main image only below editor content', async () => {
    const getBackgroundPresentation = vi.fn(async () => ok({
      settings: DEFAULT_BACKGROUND_SETTINGS,
      imageUrl: null,
    }))
    const onBackgroundPresentation = vi.fn((listener: (event: BackgroundPresentationEvent) => void) => {
      backgroundListener = listener
      return () => { if (backgroundListener === listener) backgroundListener = null }
    })
    installApi({ getBackgroundPresentation, onBackgroundPresentation })

    render(<App />)

    await waitFor(() => expect(getBackgroundPresentation).toHaveBeenCalledWith({ kind: 'main' }))
    expect(screen.queryByTestId('background-image-layer')).toBeNull()
    const content = document.querySelector('.editor-content')!
    expect(content).not.toHaveClass('background-image-present')

    act(() => backgroundListener?.({
      target: { kind: 'sticky-note', noteId: '00000000-0000-4000-8000-000000000001' },
      phase: 'preview',
      presentation: { settings: DEFAULT_BACKGROUND_SETTINGS, imageUrl: 'arkdown-background://sticky.png' },
    }))
    expect(screen.queryByTestId('background-image-layer')).toBeNull()

    act(() => backgroundListener?.({
      target: { kind: 'main' },
      phase: 'applied',
      presentation: {
        settings: {
          ...DEFAULT_BACKGROUND_SETTINGS,
          imageOpacityPercent: 43,
          imageAlignment: 'left-bottom',
        },
        imageUrl: 'arkdown-background://main.png',
      },
    }))

    const layer = screen.getByTestId('background-image-layer')
    expect(layer).toHaveAttribute('data-anchor', 'left-bottom')
    expect(layer).toHaveAttribute('data-image-url', 'arkdown-background://main.png')
    expect(content).toHaveClass('background-image-present')
    expect(content).toContainElement(layer)
    expect(document.querySelector('.document-header')).not.toContainElement(layer)
    expect(document.querySelector('.statusbar')).toBeNull()
  })
})
