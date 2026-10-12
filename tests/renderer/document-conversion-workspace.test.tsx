import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { forwardRef, useImperativeHandle } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ArkdownApi } from '../../src/shared/contracts'
import type { ConvertedDocument } from '../../src/shared/document-conversion'
import type { DocumentConversionState } from '../../src/renderer/document-conversion/use-document-conversion'

const workspace = { name: 'Notes', absolutePath: 'C:/Notes' }

function convertedDocument(fileName = 'slides.pptx'): ConvertedDocument {
  return Object.freeze({
    source: Object.freeze({
      absolutePath: `C:\\Notes\\${fileName}`,
      fileName,
      format: fileName.toLocaleLowerCase('en-US').endsWith('.epub') ? 'epub' : 'pptx',
      bytes: 128,
      modifiedAtMs: 1,
    }),
    markdown: '# Converted\n\nBody',
    converterVersion: '0.1.7-py3.12.10',
    fingerprint: 'f'.repeat(64),
    warnings: Object.freeze([]),
  })
}

const sessionBridge = vi.hoisted(() => ({
  session: null as unknown as ReturnType<
    typeof import('../../src/renderer/editor/use-document-session').useDocumentSession
  >,
}))

const conversionBridge = vi.hoisted(() => ({
  initialState: { status: 'idle' } as DocumentConversionState,
  begin: vi.fn<(relativePath: string) => void>(),
  cancel: vi.fn<() => void>(),
  latest: null as import('../../src/renderer/document-conversion/use-document-conversion').DocumentConversionController | null,
}))

const workspaceBridge = vi.hoisted(() => ({
  initial: { name: 'Notes', absolutePath: 'C:/Notes' },
  adoptWorkspace: vi.fn(),
}))

const intentBridge = vi.hoisted(() => ({
  open: null as Parameters<NonNullable<ArkdownApi['onOpenIntent']>>[0] | null,
  importDocx: null as Parameters<NonNullable<ArkdownApi['onImportDocxIntent']>>[0] | null,
}))

const editorBridge = vi.hoisted(() => ({
  insertDroppedLink: vi.fn(() => true),
  insertDroppedMarkdown: vi.fn(() => true),
}))

vi.mock('../../src/renderer/editor/use-document-session', () => ({
  useDocumentSession: () => sessionBridge.session,
}))

vi.mock('../../src/renderer/document-conversion/use-document-conversion', async () => {
  const { useMemo, useState } = await import('react')
  return {
    useDocumentConversion: () => {
      const [state, setState] = useState<DocumentConversionState>(conversionBridge.initialState)
      const controller = useMemo(() => ({
        state,
        begin: (relativePath: string) => conversionBridge.begin(relativePath),
        install: vi.fn(),
        retry: vi.fn(),
        cancel: () => {
          conversionBridge.cancel()
          setState({ status: 'idle' })
        },
        accept: () => state.status === 'preview' ? state.converted : null,
      }), [state])
      conversionBridge.latest = controller
      return controller
    },
  }
})

vi.mock('../../src/renderer/workspace/use-workspace', async () => {
  const { useCallback, useState } = await import('react')
  return {
    useWorkspace: () => {
      const [currentWorkspace, setCurrentWorkspace] = useState(workspaceBridge.initial)
      const adoptWorkspace = useCallback((nextWorkspace: typeof workspaceBridge.initial) => {
        workspaceBridge.adoptWorkspace(nextWorkspace)
        setCurrentWorkspace(nextWorkspace)
      }, [])
      return {
        workspace: currentWorkspace,
        chooseWorkspace: vi.fn(async () => undefined),
        adoptWorkspace,
        error: null,
        isChoosing: false,
      }
    },
  }
})

vi.mock('../../src/renderer/workspace/ContextWorkspaceSidebar', () => ({
  ContextWorkspaceSidebar: ({ onOpenDocument, currentDocument }: {
    onOpenDocument(path: string): void
    currentDocument: string | null
  }) => <nav aria-label="workspace" data-current-document={currentDocument ?? ''}>
    {['note.md', 'report.docx', 'guide.pdf', 'slides.pptx', 'sheet.xlsx', 'book.epub']
      .map((path) => <button key={path} onClick={() => onOpenDocument(path)}>{path}</button>)}
  </nav>,
}))

vi.mock('../../src/renderer/editor/EditorPane', () => ({
  EditorPane: forwardRef(function TestEditorPane({
    documentKey,
    markdown,
    onChange,
    onModeChange,
  }: {
    documentKey: string
    markdown: string
    onChange(markdown: string): void
    onModeChange?(mode: 'visual' | 'source'): void
  }, ref) {
    useImperativeHandle(ref, () => ({
      flush: () => null,
      insertDroppedLink: editorBridge.insertDroppedLink,
      insertDroppedMarkdown: editorBridge.insertDroppedMarkdown,
      revealTranslationHistoryRecord: () => false,
      flushTranslationHistoryAnchors: () => [],
      capturePendingTranslationAnchor: () => false,
      bindPendingTranslationAnchor: () => undefined,
      promotePendingTranslationAnchor: () => null,
      discardPendingTranslationAnchor: () => undefined,
    }), [])
    return <>
      <textarea
        aria-label="Markdown editor"
        data-document-key={documentKey}
        onChange={(event) => onChange(event.target.value)}
        value={markdown}
      />
      <button onClick={() => onModeChange?.('visual')}>Visual mode</button>
      <button onClick={() => onModeChange?.('source')}>Source mode</button>
    </>
  }),
}))

vi.mock('../../src/renderer/editor/edit-indicators/use-edit-indicator-model', () => ({
  useEditIndicatorModel: () => ({
    lineStates: [], status: 'idle', markdownVersion: 0, modelVersion: 0,
  }),
}))

vi.mock('../../src/renderer/app/use-translation-history', () => ({
  useTranslationHistory: () => ({
    records: [],
    selectedRecordId: null,
    finalize: vi.fn(() => null),
    selectLatest: vi.fn(() => null),
    selectById: vi.fn(() => null),
    selectPrevious: vi.fn(() => null),
    selectNext: vi.fn(() => null),
    updateAnchor: vi.fn(),
    updateDocumentIdentity: vi.fn(),
  }),
}))

vi.mock('../../src/renderer/app/use-sidebar-resize', () => ({
  useSidebarResize: () => ({ width: 260, separatorProps: {} }),
}))

vi.mock('../../src/renderer/chrome/AppTitleBar', () => ({ AppTitleBar: () => null }))
vi.mock('../../src/renderer/chrome/DocumentHeader', () => ({ DocumentHeader: () => null }))
vi.mock('../../src/renderer/chrome/FullscreenHint', () => ({ FullscreenHint: () => null }))
vi.mock('../../src/renderer/screenshot/ScreenshotOcrHost', () => ({ ScreenshotOcrHost: () => null }))
vi.mock('../../src/renderer/sticky-notes/StickyNoteBoxPanel', () => ({ StickyNoteBoxPanel: () => null }))
vi.mock('../../src/renderer/settings/PreferencesPage', () => ({ PreferencesPage: () => null }))
vi.mock('../../src/renderer/workspace/WorkspaceNameDialog', () => ({ WorkspaceNameDialog: () => null }))
vi.mock('../../src/renderer/workspace/FolderDropDialog', () => ({
  FolderDropDialog: ({ onChoose }: { onChoose(choice: 'workspace' | 'path' | 'cancel'): void }) => (
    <button onClick={() => onChoose('workspace')}>Open dropped workspace</button>
  ),
}))
vi.mock('../../src/renderer/app/ui-selection-guard', () => ({ installUiSelectionGuard: () => () => undefined }))

import { App } from '../../src/renderer/app/App'

function createSession(): typeof sessionBridge.session {
  return {
    setInteractionLocked: vi.fn(),
    prepareForClose: vi.fn(async () => ({ status: 'ready' as const })),
    readClipboardImage: async () => null,
    state: {
      status: 'ready',
    relativePath: null,
    sourceRelativePath: null,
    displayName: null,
    persistenceKind: 'unsaved-document',
    openingMarkdown: '',
      markdown: '# Current',
      savedMarkdown: '# Current',
      draftMarkdown: '# Current',
      revision: null,
      encoding: 'utf8',
      newline: 'lf',
      mtimeMs: null,
      error: null,
      recovered: false,
      hasSavedThisOpen: false,
    },
    dirty: false,
    savePresentation: 'saved',
    draftId: 'draft-current',
    documentExportSessionId: 'export-current',
    open: vi.fn(async () => ({ status: 'opened' as const })),
    importDocx: vi.fn(async () => undefined),
    create: vi.fn(async () => true),
    reload: vi.fn(async () => true),
    recover: vi.fn(),
    adopt: vi.fn(),
    adoptSavedAs: vi.fn(() => true),
    adoptImportedDocx: vi.fn(),
    adoptConverted: vi.fn(async () => true),
    supersedePendingOpen: vi.fn(),
    clear: vi.fn(),
    change: vi.fn(),
    setDisplayName: vi.fn(),
    rebindPath: vi.fn(),
    getDocumentChangeGeneration: vi.fn(() => 0),
    getDocumentLifecycle: vi.fn(() => 0),
    getDocumentTransitionGeneration: vi.fn(() => 0),
    persistCurrentDocument: vi.fn(async () => ({ status: 'clean' as const })),
    save: vi.fn(async () => true),
    saveAs: vi.fn(async () => null),
    backupDraft: vi.fn(async () => true),
    discard: vi.fn(async () => true),
    transitionAfterSave: vi.fn(async (transition: () => void | Promise<void>) => {
      await transition()
      return true
    }),
  }
}

function installApi(overrides: Partial<ArkdownApi> = {}): void {
  const ok = async () => ({ ok: true as const, value: null })
  window.arkdown = {
    getAiWorkspaceState: vi.fn(async () => ({
      ok: true as const,
      value: { workspaceId: 'workspace-notes', workspaceGeneration: 'generation-1' },
    })),
    listDirectory: vi.fn(async () => ({ ok: true as const, value: [] })),
    peekDocument: vi.fn(async () => ({ ok: false as const, error: { code: 'FILE_NOT_FOUND', message: 'missing' } })),
    pathForDroppedFile: vi.fn((file: File) => `C:\\Drops\\${file.name}`),
    inspectDroppedPath: vi.fn(async (absolutePath: string) => ({
      ok: true as const,
      value: { kind: 'file' as const, absolutePath },
    })),
    importAsset: vi.fn(async (absolutePath: string) => {
      const fileName = absolutePath.split('\\').at(-1)!
      return {
        ok: true as const,
        value: {
          assetId: `asset-${fileName}`,
          category: fileName.endsWith('.pdf') ? 'pdf' as const : 'attachment' as const,
          fileName,
          relativePath: `.arkdown-assets/${fileName}`,
          previewUrl: `arkdown-asset://${fileName}`,
          markdown: `[${fileName}](arkdown-asset:${fileName})`,
        },
      }
    }),
    onPrepareClose: vi.fn(() => () => undefined),
    onOpenIntent: vi.fn((handler) => {
      intentBridge.open = handler
      return () => { if (intentBridge.open === handler) intentBridge.open = null }
    }),
    onImportDocxIntent: vi.fn((handler) => {
      intentBridge.importDocx = handler
      return () => { if (intentBridge.importDocx === handler) intentBridge.importDocx = null }
    }),
    onRecoverDraft: vi.fn(() => () => undefined),
    onWindowStateChanged: vi.fn(() => () => undefined),
    getWindowState: vi.fn(async () => ({
      ok: true as const,
      value: { maximized: false, fullscreen: false, revision: 0 },
    })),
    onApplicationMenuChanged: vi.fn(() => () => undefined),
    updateApplicationMenuWindowState: vi.fn(ok),
    onEditorAppearancePreferencesChanged: vi.fn(() => () => undefined),
    onArknoteServiceEvent: vi.fn(() => () => undefined),
    onMenuCommand: vi.fn(() => () => undefined),
    recordRecentDocument: vi.fn(async () => ({ ok: true as const, value: [] })),
    ...overrides,
  } as unknown as ArkdownApi
}

function dropFileAt(target: Element, fileName: string): void {
  const event = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 40, clientY: 80 })
  Object.defineProperty(event, 'dataTransfer', {
    value: { files: [new File(['content'], fileName)], types: ['Files'] },
  })
  fireEvent(target, event)
}

beforeEach(() => {
  sessionBridge.session = createSession()
  conversionBridge.initialState = { status: 'idle' }
  conversionBridge.begin.mockReset()
  conversionBridge.cancel.mockReset()
  conversionBridge.latest = null
  workspaceBridge.initial = workspace
  workspaceBridge.adoptWorkspace.mockReset()
  intentBridge.open = null
  intentBridge.importDocx = null
  editorBridge.insertDroppedLink.mockReset().mockReturnValue(true)
  installApi()
})

it('cancels conversion before adopting a dropped ordinary document in the same workspace', async () => {
  const snapshot = {
    relativePath: 'replacement.md',
    markdown: '# Replacement',
    revision: 'a'.repeat(64),
    encoding: 'utf8' as const,
    newline: 'lf' as const,
    mtimeMs: 2,
  }
  sessionBridge.session.state.markdown = ''
  conversionBridge.initialState = {
    status: 'preview',
    relativePath: 'slides.pptx',
    fileName: 'slides.pptx',
    format: 'pptx',
    converted: convertedDocument(),
  }
  installApi({
    pathForDroppedFile: vi.fn(() => 'C:\\Notes\\replacement-folder'),
    inspectDroppedPath: vi.fn(async (absolutePath: string) => ({
      ok: true as const,
      value: { kind: 'directory' as const, absolutePath },
    })),
    openDroppedPath: vi.fn(async () => ({
      ok: true as const,
      value: { workspace, document: snapshot },
    })),
  })
  render(<App />)

  dropFileAt(
    screen.getByRole('textbox', { name: 'Markdown editor', hidden: true }),
    'replacement-folder',
  )
  await waitFor(() => expect(screen.getByRole('button', {
    name: 'Open dropped workspace', hidden: true,
  })).toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: 'Open dropped workspace', hidden: true }))

  await waitFor(() => expect(sessionBridge.session.adopt).toHaveBeenCalledWith(snapshot))
  expect(conversionBridge.cancel).toHaveBeenCalledOnce()
  expect(conversionBridge.cancel.mock.invocationCallOrder[0])
    .toBeLessThan(vi.mocked(sessionBridge.session.adopt).mock.invocationCallOrder[0]!)
})

it.each([
  ['ordinary open intent', 'open'],
  ['Pandoc import intent', 'importDocx'],
] as const)('cancels conversion before same-workspace %s adoption', async (_label, kind) => {
  const snapshot = {
    relativePath: 'replacement.md',
    markdown: '# Replacement',
    revision: 'b'.repeat(64),
    encoding: 'utf8' as const,
    newline: 'lf' as const,
    mtimeMs: 3,
  }
  const imported = {
    sourceAbsolutePath: 'C:\\Notes\\replacement.docx',
    sourceFileName: 'replacement.docx',
    markdown: '# Imported replacement',
  }
  conversionBridge.initialState = {
    status: 'preview',
    relativePath: 'slides.pptx',
    fileName: 'slides.pptx',
    format: 'pptx',
    converted: convertedDocument(),
  }
  render(<App />)
  await waitFor(() => expect(intentBridge[kind]).not.toBeNull())

  act(() => {
    if (kind === 'open') intentBridge.open?.({ workspace, document: snapshot })
    else intentBridge.importDocx?.({ workspace, imported })
  })

  const adoption = kind === 'open'
    ? vi.mocked(sessionBridge.session.adopt)
    : vi.mocked(sessionBridge.session.adoptImportedDocx)
  await waitFor(() => expect(adoption).toHaveBeenCalledWith(kind === 'open' ? snapshot : imported))
  expect(conversionBridge.cancel).toHaveBeenCalledOnce()
  expect(conversionBridge.cancel.mock.invocationCallOrder[0])
    .toBeLessThan(adoption.mock.invocationCallOrder[0]!)
})

it('does not explicitly cancel conversion for initial mount or a different-workspace keyed adoption', async () => {
  const otherWorkspace = { name: 'Other', absolutePath: 'D:/Other' }
  const snapshot = {
    relativePath: 'other.md',
    markdown: '# Other',
    revision: 'c'.repeat(64),
    encoding: 'utf8' as const,
    newline: 'lf' as const,
    mtimeMs: 4,
  }
  render(<App />)
  await waitFor(() => expect(intentBridge.open).not.toBeNull())
  expect(conversionBridge.cancel).not.toHaveBeenCalled()

  act(() => intentBridge.open?.({ workspace: otherWorkspace, document: snapshot }))

  await waitFor(() => expect(sessionBridge.session.adopt).toHaveBeenCalledWith(snapshot))
  expect(workspaceBridge.adoptWorkspace).toHaveBeenCalledWith(otherWorkspace)
  expect(conversionBridge.cancel).not.toHaveBeenCalled()
})

it('routes all convertible workspace clicks to one conversion controller and preserves Markdown and DOCX routes', async () => {
  const user = userEvent.setup()
  render(<App />)

  for (const path of ['guide.pdf', 'slides.pptx', 'sheet.xlsx', 'book.epub']) {
    await user.click(screen.getByRole('button', { name: path }))
  }
  expect(conversionBridge.begin.mock.calls.map(([path]) => path)).toEqual([
    'guide.pdf', 'slides.pptx', 'sheet.xlsx', 'book.epub',
  ])
  expect(sessionBridge.session.supersedePendingOpen).toHaveBeenCalledTimes(4)
  expect(sessionBridge.session.open).not.toHaveBeenCalled()
  expect(sessionBridge.session.importDocx).not.toHaveBeenCalled()

  await user.click(screen.getByRole('button', { name: 'note.md' }))
  await user.click(screen.getByRole('button', { name: 'report.docx' }))
  expect(conversionBridge.cancel).toHaveBeenCalledTimes(2)
  expect(sessionBridge.session.open).toHaveBeenCalledWith('note.md')
  expect(sessionBridge.session.importDocx).toHaveBeenCalledWith('report.docx')
  expect(vi.mocked(sessionBridge.session.supersedePendingOpen).mock.invocationCallOrder[0])
    .toBeLessThan(conversionBridge.begin.mock.invocationCallOrder[0]!)
  expect(conversionBridge.cancel.mock.invocationCallOrder.at(-2))
    .toBeLessThan(vi.mocked(sessionBridge.session.open).mock.invocationCallOrder[0]!)
  expect(conversionBridge.cancel.mock.invocationCallOrder.at(-1))
    .toBeLessThan(vi.mocked(sessionBridge.session.importDocx).mock.invocationCallOrder[0]!)
})

it('keeps the exact preview and untitled editor identity after a declined adoption, then closes after retry succeeds', async () => {
  const preview = convertedDocument()
  conversionBridge.initialState = {
    status: 'preview',
    relativePath: 'slides.pptx',
    fileName: 'slides.pptx',
    format: 'pptx',
    converted: preview,
  }
  vi.mocked(sessionBridge.session.adoptConverted)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true)
  const user = userEvent.setup()
  render(<App />)
  const originalKey = screen.getByRole('textbox', { name: 'Markdown editor', hidden: true })
    .getAttribute('data-document-key')

  expect(sessionBridge.session.adoptConverted).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '新建 Markdown' }))
  await waitFor(() => expect(sessionBridge.session.adoptConverted).toHaveBeenCalledWith(preview))
  expect(screen.getByRole('dialog', { name: '转换文档预览' })).toBeVisible()
  expect(screen.getByRole('textbox', { name: 'Markdown editor', hidden: true }))
    .toHaveAttribute('data-document-key', originalKey)
  expect(conversionBridge.cancel).not.toHaveBeenCalled()

  await user.click(screen.getByRole('button', { name: '新建 Markdown' }))
  await waitFor(() => expect(conversionBridge.cancel).toHaveBeenCalledOnce())
  expect(screen.queryByRole('dialog', { name: '转换文档预览' })).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .not.toHaveAttribute('data-document-key', originalKey)
  expect(sessionBridge.session.adoptConverted).toHaveBeenNthCalledWith(2, preview)
})

it.each([
  ['visual', 'slides.pptx'],
  ['source', 'slides.pptx'],
  ['visual', 'book.epub'],
  ['source', 'book.epub'],
])('drops %s-mode %s through the existing precise local-link insertion path', async (mode, fileName) => {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: `${mode[0]!.toUpperCase()}${mode.slice(1)} mode` }))
  dropFileAt(screen.getByRole('textbox', { name: 'Markdown editor' }), fileName)

  await waitFor(() => expect(editorBridge.insertDroppedLink).toHaveBeenCalledWith({
    absolutePath: `C:\\Drops\\${fileName}`,
    clientX: 40,
    clientY: 80,
    kind: 'file',
  }))
  expect(window.arkdown.inspectDroppedPath).toHaveBeenCalledWith(`C:\\Drops\\${fileName}`)
  expect(window.arkdown.importAsset).not.toHaveBeenCalled()
  expect(conversionBridge.begin).not.toHaveBeenCalled()
})

it.each(['guide.pdf', 'sheet.xlsx'])('keeps dropped %s on the asset import route', async (fileName) => {
  render(<App />)
  dropFileAt(screen.getByRole('textbox', { name: 'Markdown editor' }), fileName)

  await waitFor(() => expect(window.arkdown.importAsset).toHaveBeenCalledWith(`C:\\Drops\\${fileName}`))
  expect(window.arkdown.inspectDroppedPath).not.toHaveBeenCalled()
  expect(editorBridge.insertDroppedLink).not.toHaveBeenCalled()
  expect(conversionBridge.begin).not.toHaveBeenCalled()
})

it('keeps a dropped convertible file outside the editor on the existing guarded error path', async () => {
  render(<App />)
  dropFileAt(screen.getByRole('navigation', { name: 'workspace' }), 'slides.pptx')

  await waitFor(() => expect(window.arkdown.inspectDroppedPath)
    .toHaveBeenCalledWith('C:\\Drops\\slides.pptx'))
  expect(editorBridge.insertDroppedLink).not.toHaveBeenCalled()
  expect(window.arkdown.importAsset).not.toHaveBeenCalled()
  expect(conversionBridge.begin).not.toHaveBeenCalled()
  expect(document.querySelector('.document-error-notice')).toHaveTextContent('请将文件拖入编辑区域')
})
