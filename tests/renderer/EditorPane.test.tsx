import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef, StrictMode, useEffect, useState } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ArkdownApi } from '../../src/shared/contracts'
import type { AiConversationEvent } from '../../src/shared/ai-conversation'
import { createWorkspaceAiSessionStore } from '../../src/renderer/editor/workspace-ai-session-store'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import { modelObservation } from '../helpers/model-observation'
import {
  EditorPane,
  type EditorPaneHandle,
} from '../../src/renderer/editor/EditorPane'
import type { MermaidAppearance } from '../../src/renderer/editor/mermaid/mermaid-types'
import {
  WorkspaceAiConversationProvider,
  useWorkspaceAiConversationController,
} from '../../src/renderer/editor/WorkspaceAiConversationProvider'

function createAiConversationApiStubs() {
  return {
    startAiConversation: vi.fn(async (input: { requestId: string }) => ({
      ok: true as const,
      value: { requestId: input.requestId, modelId: 'test-model', transcriptRevision: 1 },
    })),
    cancelAiConversation: vi.fn(async () => ({ ok: true as const, value: null })),
    clearAiConversation: vi.fn(async () => ({ ok: true as const, value: null })),
    setAiConversationCapabilities: vi.fn(async () => ({ ok: true as const, value: null })),
    submitAiAuthorizationResult: vi.fn(async () => ({ ok: true as const, value: null })),
    getAiWorkspaceState: vi.fn(async () => ({
      ok: true as const,
      value: { workspaceId: 'workspace-a', workspaceGeneration: 'generation-1' },
    })),
    registerAiCurrentDocumentPort: vi.fn(async () => ({
      ok: true as const, value: { portGeneration: 1 },
    })),
    unregisterAiCurrentDocumentPort: vi.fn(async () => ({ ok: true as const, value: null })),
    registerAiOpenDocumentPort: vi.fn(async () => ({
      ok: true as const,
      value: { documentHandle: '550e8400-e29b-41d4-a716-446655440010' },
    })),
    unregisterAiOpenDocumentPort: vi.fn(async () => ({ ok: true as const, value: null })),
    notifyAiCurrentDocumentChanged: vi.fn(async () => ({ ok: true as const, value: null })),
    openAiMessageLink: vi.fn(async () => ({ ok: true as const, value: null })),
    setAiConversationSettings: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'OPERATION_FAILED' as const, message: 'not configured' },
    })),
    onAiConversationEvent: vi.fn(() => () => undefined),
  }
}

const editIndicatorBridge = vi.hoisted(() => ({
  revealLine: vi.fn(),
  revealAnchor: vi.fn(() => true),
  openDocumentLink: undefined as ((href: string) => void | Promise<void>) | undefined,
  findReady: [] as Array<() => void>,
  visualInputs: [] as unknown[],
  mermaidAppearances: [] as Array<MermaidAppearance | undefined>,
  sourceInputs: [] as Array<{ lineIndicators: readonly string[]; showEditIndicators: boolean }>,
  visualModeTargets: [] as Array<string | undefined>,
  visualModePosition: { blockIndex: 3, blockFingerprint: 'visual', lineOffset: 1, column: 4 } as unknown,
  visualModeSwitchThrows: false,
  sourceModePosition: { blockIndex: 5, blockFingerprint: 'source', lineOffset: 2, column: 7 } as unknown,
  visualMarginPortReady: true,
  sourceMarginPortReady: true,
  visualAiPort: {
    captureReadSnapshot: vi.fn(),
    planReplacement: vi.fn(),
    applyTransaction: vi.fn(),
    queryOutcome: vi.fn(),
  },
  sourceAiPort: {
    captureReadSnapshot: vi.fn(),
    planReplacement: vi.fn(),
    applyTransaction: vi.fn(),
    queryOutcome: vi.fn(),
  },
  visualMarginPort: {
    isEligibleMarginStart: vi.fn(() => true),
    activationPositionAtPoint: vi.fn(({ clientX }: { clientX: number }) => clientX < 20 ? null : 5),
    positionAtPoint: vi.fn(({ clientX }: { clientX: number }) => clientX < 20 ? 1 : 5),
    applySelection: vi.fn(),
    focus: vi.fn(),
    scrollContainer: vi.fn(() => null),
    beginPointerSelection: vi.fn(),
    cancelPointerSelection: vi.fn(),
  },
  sourceMarginPort: {
    isEligibleMarginStart: vi.fn(() => true),
    activationPositionAtPoint: vi.fn(({ clientX }: { clientX: number }) => clientX < 20 ? null : 8),
    positionAtPoint: vi.fn(({ clientX }: { clientX: number }) => clientX < 20 ? 2 : 8),
    applySelection: vi.fn(),
    focus: vi.fn(),
    scrollContainer: vi.fn(() => null),
    beginPointerSelection: vi.fn(),
    cancelPointerSelection: vi.fn(),
  },
}))

vi.mock('../../src/renderer/editor/VisualEditor', async () => {
  const { forwardRef, useImperativeHandle, useRef } = await import('react')

  return {
    VisualEditor: forwardRef<
      { flush: () => string | null; marginSelectionPort: () => unknown },
      {
        documentAbsolutePath: string | null
        initialModePosition?: unknown
        markdown: string
        mermaidAppearance?: MermaidAppearance
        spellCheckEnabled: boolean
        editIndicators?: unknown
        onChange: (markdown: string) => void
        onFindReady?(): void
        onDocumentLink?(href: string): void | Promise<void>
      }
    >(function DelayedVisualEditor({ documentAbsolutePath, initialModePosition, markdown, mermaidAppearance, spellCheckEnabled, editIndicators, onChange, onFindReady, onDocumentLink }, ref) {
      editIndicatorBridge.openDocumentLink = onDocumentLink
      editIndicatorBridge.findReady.push(() => onFindReady?.())
      const latestMarkdown = useRef(markdown)
      const pending = useRef(false)
      if (!pending.current) latestMarkdown.current = markdown
      editIndicatorBridge.visualInputs.push(editIndicators)
      editIndicatorBridge.mermaidAppearances.push(mermaidAppearance)

      useImperativeHandle(ref, () => ({
        flush: () => {
          if (!pending.current) return null
          pending.current = false
          onChange(latestMarkdown.current)
          return latestMarkdown.current
        },
        captureModePosition: (targetMarkdown?: string) => {
          editIndicatorBridge.visualModeTargets.push(targetMarkdown)
          return editIndicatorBridge.visualModePosition
        },
        captureModeSwitch: (fallbackMarkdown: string) => {
          if (editIndicatorBridge.visualModeSwitchThrows) {
            throw new Error('atomic capture unavailable')
          }
          const checkpoint = pending.current ? latestMarkdown.current : fallbackMarkdown
          if (pending.current) {
            pending.current = false
            onChange(checkpoint)
          }
          editIndicatorBridge.visualModeTargets.push(checkpoint)
          return { checkpoint, position: editIndicatorBridge.visualModePosition }
        },
        marginSelectionPort: () => editIndicatorBridge.visualMarginPortReady
          ? editIndicatorBridge.visualMarginPort
          : null,
        createWorkspaceAiEditorPort: () => editIndicatorBridge.visualAiPort,
      }), [onChange])

      return <div className="visual-editor"><textarea
          aria-label="visual editor"
          data-document-absolute-path={documentAbsolutePath ?? ''}
          data-mode-position={JSON.stringify(initialModePosition ?? null)}
          data-mermaid-appearance={JSON.stringify(mermaidAppearance ?? null)}
          data-spellcheck={String(spellCheckEnabled)}
          data-testid="visual-editor"
          value={pending.current ? latestMarkdown.current : markdown}
          onChange={(event) => {
            latestMarkdown.current = event.target.value
            pending.current = true
            // Milkdown's real markdownUpdated callback is still inside its 200ms window.
          }}
        /></div>
    }),
  }
})

vi.mock('../../src/renderer/editor/SourceEditor', async () => {
  const { forwardRef, useImperativeHandle } = await import('react')
  return {
  SourceEditor: forwardRef(({
    initialModePosition,
    markdown,
    spellCheckEnabled,
    lineIndicators = [],
    showEditIndicators = false,
    plainText = false,
    documentPath,
    onChange,
    onFindReady,
  }: {
    initialModePosition?: unknown
    markdown: string
    spellCheckEnabled: boolean
    lineIndicators?: readonly string[]
    showEditIndicators?: boolean
    plainText?: boolean
    documentPath?: string | null
    onChange: (markdown: string) => void
    onFindReady?(): void
  }, ref) => {
    editIndicatorBridge.findReady.push(() => onFindReady?.())
    useImperativeHandle(ref, () => ({
      revealLine: editIndicatorBridge.revealLine,
      revealAnchor: editIndicatorBridge.revealAnchor,
      captureModePosition: () => editIndicatorBridge.sourceModePosition,
      marginSelectionPort: () => editIndicatorBridge.sourceMarginPortReady
        ? editIndicatorBridge.sourceMarginPort
        : null,
      createWorkspaceAiEditorPort: () => editIndicatorBridge.sourceAiPort,
    }))
    editIndicatorBridge.sourceInputs.push({ lineIndicators, showEditIndicators })
    return <textarea
      aria-label="source editor"
      data-testid="source-editor"
      data-plain-text={String(plainText)}
      data-document-path={documentPath ?? ''}
      data-spellcheck={String(spellCheckEnabled)}
      data-line-indicators={lineIndicators.join(',')}
      data-show-edit-indicators={String(showEditIndicators)}
      data-mode-position={JSON.stringify(initialModePosition ?? null)}
      value={markdown}
      onChange={(event) => onChange(event.target.value)}
    />
  }),
}})

beforeEach(() => {
  editIndicatorBridge.revealLine.mockClear()
  editIndicatorBridge.revealAnchor.mockClear()
  editIndicatorBridge.visualInputs.length = 0
  editIndicatorBridge.mermaidAppearances.length = 0
  editIndicatorBridge.sourceInputs.length = 0
  editIndicatorBridge.visualModeTargets.length = 0
  editIndicatorBridge.visualModePosition = {
    blockIndex: 3,
    blockFingerprint: 'visual',
    lineOffset: 1,
    column: 4,
  }
  editIndicatorBridge.visualModeSwitchThrows = false
  editIndicatorBridge.sourceModePosition = {
    blockIndex: 5,
    blockFingerprint: 'source',
    lineOffset: 2,
    column: 7,
  }
  editIndicatorBridge.visualMarginPortReady = true
  editIndicatorBridge.sourceMarginPortReady = true
  for (const port of [editIndicatorBridge.visualMarginPort, editIndicatorBridge.sourceMarginPort]) {
    port.isEligibleMarginStart.mockClear()
    port.activationPositionAtPoint.mockClear()
    port.positionAtPoint.mockClear()
    port.applySelection.mockClear()
    port.focus.mockClear()
    port.scrollContainer.mockClear()
    port.beginPointerSelection.mockClear()
    port.cancelPointerSelection.mockClear()
  }
  Object.defineProperty(window, 'arkdown', {
    configurable: true,
    value: {
      ...createAiConversationApiStubs(),
      cancelTranslation: vi.fn(async () => ({ ok: true, value: null })),
      getLargeModelSettings: vi.fn(async () => ({
        ok: true,
        value: DEFAULT_LARGE_MODEL_SETTINGS,
      })),
      getModelSettingsSnapshot: vi.fn(async () => {
        const result = await window.arkdown.getLargeModelSettings()
        return result.ok ? { ok: true as const, value: modelObservation(result.value) } : result
      }),
      onTranslationEvent: vi.fn(() => () => undefined),
    } as unknown as ArkdownApi,
  })
})

it.each([false, true])('binds continued analysis to the currently displayed document (changed: %s)', async changed => {
  const api = window.arkdown, store = createWorkspaceAiSessionStore()
  let receive!: (event: AiConversationEvent) => void
  vi.mocked(api.onAiConversationEvent).mockImplementation(listener => { receive = listener; return () => undefined })
  const id = '550e8400-e29b-41d4-a716-446655440099'
  vi.mocked(api.getLargeModelSettings).mockResolvedValue({ ok: true, value: {
    ...DEFAULT_LARGE_MODEL_SETTINGS,
    connections: [{ id, name: 'Fixture model', provider: 'other', accessType: 'standard-api', protocol: 'openai',
      baseUrl: 'https://example.invalid/v1', modelId: 'gpt-4.1', apiKeyHint: '', status: 'connected', lastTestedAt: null, capabilityOverride: null }],
    aiConversation: { ...DEFAULT_LARGE_MODEL_SETTINGS.aiConversation, connectionId: id },
  } })
  const value = { markdown: '# Fixture', onChange: vi.fn(), onOpenLargeModelSettings: vi.fn(),
    documentKey: 'one.md', aiConversationStore: store,
    aiWorkspace: { workspaceId: 'workspace-a', workspaceGeneration: 'generation-1' },
    rightSidebarState: { open: true, activeTab: 'ai-chat' as const } }
  const view = render(<EditorPane {...value} />)
  const input = await screen.findByRole('textbox', { name: '发送消息给 AI' })
  fireEvent.change(input, { target: { value: 'inspect this document' } })
  await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).not.toBeDisabled())
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(api.startAiConversation).toHaveBeenCalledOnce())
  const first = vi.mocked(api.startAiConversation).mock.calls[0]![0]
  const messageId = '550e8400-e29b-41d4-a716-446655440098'
  const token = '550e8400-e29b-41d4-a716-446655440097'
  act(() => {
    receive({ requestId: first.requestId, type: 'started', transcriptRevision: 1 })
    receive({ requestId: first.requestId, type: 'user-message-accepted', messageId: first.messages[0]!.id, transcriptRevision: 1 })
    receive({ requestId: first.requestId, type: 'message-start', messageId, previousTranscriptRevision: 1 })
    receive({ requestId: first.requestId, type: 'message-completed', messageId, transcriptRevision: 2 })
    receive({ requestId: first.requestId, type: 'budget-paused', transcriptRevision: 2, continuationId: token, reason: 'read-budget',
      counts: { readAdmitted: 64, writeAdmitted: 0, rejectedNewCalls: 1, toolRounds: 32 },
      outcomes: { readSucceeded: 64, readFailed: 0, readDenied: 0, readUnavailable: 0,
        writeSucceeded: 0, writeFailed: 0, writeDenied: 0, writeUnavailable: 0, writeUnknown: 0, notExecuted: 1 },
      finalization: { status: 'context-limit' } })
  })
  if (changed) view.rerender(<EditorPane {...value} documentKey="two.md" />)
  const button = await screen.findByRole('button', { name: '继续分析' })
  await waitFor(() => expect(button).not.toBeDisabled())
  vi.mocked(api.startAiConversation).mockImplementation(async next => ({ ok: true,
    value: { requestId: next.requestId, modelId: 'test-model', transcriptRevision: next.acknowledgedTranscriptRevision + 1 } }))
  fireEvent.click(button)
  await waitFor(() => expect(api.startAiConversation).toHaveBeenCalledTimes(2))
  const next = vi.mocked(api.startAiConversation).mock.calls[1]![0]
  expect(next.expectedDocumentId).toBe(store.sessions.get('workspace-a')!.documentSourceIds.get(changed ? 'two.md' : 'one.md'))
  expect(next.expectedDocumentId).toEqual(expect.any(String))
  expect(next.expectedDocumentId === first.expectedDocumentId).toBe(!changed)
  expect(next.continuationOfSegmentId).toBe(token)
  expect(next.acknowledgedTranscriptRevision).toBe(2)
  expect(next.messages).toHaveLength(1)
  view.unmount()
})

it('waits for the actual source editor before applying a matching location once without editing text', () => {
  const location = { absolutePath: 'C:\\notes\\sample.ts', line: 8 }
  const handled = vi.fn()
  const props = { markdown: 'unsaved source', onChange: vi.fn(), onOpenLargeModelSettings: vi.fn(), documentKey: 'code', documentAbsolutePath: 'C:\\notes\\sample.ts', documentLocation: location, onDocumentLocationHandled: handled }
  const { rerender } = render(<EditorPane {...props} />)
  expect(editIndicatorBridge.revealLine).not.toHaveBeenCalled()
  act(editIndicatorBridge.findReady.at(-1)!)
  expect(editIndicatorBridge.revealLine).toHaveBeenCalledExactlyOnceWith(8)
  expect(handled).toHaveBeenCalledWith(location)
  rerender(<EditorPane {...props} />)
  expect(editIndicatorBridge.revealLine).toHaveBeenCalledOnce()
  expect(props.onChange).not.toHaveBeenCalled()
  expect(screen.getByLabelText('source editor')).toHaveValue('unsaved source')
})

it('never applies a location belonging to a different current document', () => {
  const handled = vi.fn()
  render(<EditorPane markdown="unsaved" onChange={vi.fn()} onOpenLargeModelSettings={vi.fn()} documentKey="code"
    documentAbsolutePath="C:\\notes\\sample.ts" documentLocation={{ absolutePath: 'C:\\notes\\other.ts', line: 8 }} onDocumentLocationHandled={handled} />)
  act(editIndicatorBridge.findReady.at(-1)!)
  expect(editIndicatorBridge.revealLine).not.toHaveBeenCalled()
  expect(handled).not.toHaveBeenCalled()
})

it('reveals a visual heading only after the lazy editor is ready and preserves dirty text', () => {
  const location = { absolutePath: 'C:\\notes\\target.md', anchor: 'destination' }
  const handled = vi.fn()
  const change = vi.fn()
  const { container } = render(<EditorPane markdown="# Destination\nunsaved" onChange={change} onOpenLargeModelSettings={vi.fn()} documentKey="target"
    documentAbsolutePath="c:/notes/target.md" documentLocation={location} onDocumentLocationHandled={handled} />)
  const document = window.document.createElement('div')
  document.className = 'ProseMirror'
  const heading = window.document.createElement('h1')
  heading.textContent = 'Destination'
  heading.scrollIntoView = vi.fn()
  document.append(heading)
  container.querySelector('.visual-editor')!.append(document)
  expect(heading.scrollIntoView).not.toHaveBeenCalled()
  act(editIndicatorBridge.findReady.at(-1)!)
  expect(heading.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'center', behavior: 'smooth' })
  expect(handled).toHaveBeenCalledWith(location)
  expect(change).not.toHaveBeenCalled()
})

it('waits for the target find adapter, ignores stale readiness, and consumes each request once', async () => {
  const props = { markdown: 'needle', onChange: vi.fn(), onOpenLargeModelSettings: vi.fn() }
  const firstRequest = { id: 1, documentKey: 'old.md', query: 'needle', isCurrent: () => true }
  const { rerender } = render(<EditorPane {...props} documentKey="old.md" findRequest={firstRequest} />)
  expect(screen.queryByRole('searchbox', { name: '在文档中搜索' })).not.toBeInTheDocument()
  const oldReady = editIndicatorBridge.findReady.at(-1)!
  const request = { id: 2, documentKey: 'new.md', query: 'needle', isCurrent: () => true }
  rerender(<EditorPane {...props} documentKey="new.md" findRequest={request} />)
  act(oldReady)
  expect(screen.queryByRole('searchbox', { name: '在文档中搜索' })).not.toBeInTheDocument()
  act(editIndicatorBridge.findReady.at(-1)!)
  expect(await screen.findByRole('searchbox', { name: '在文档中搜索' })).toHaveValue('needle')
  fireEvent.click(screen.getByRole('button', { name: '关闭文档搜索' }))
  act(editIndicatorBridge.findReady.at(-1)!)
  expect(screen.queryByRole('searchbox', { name: '在文档中搜索' })).not.toBeInTheDocument()
  rerender(<EditorPane {...props} documentKey="new.md" findRequest={{ ...request, id: 3 }} />)
  expect(await screen.findByRole('searchbox', { name: '在文档中搜索' })).toHaveValue('needle')
})

it('does not consume an invalidated request even when its target becomes ready', () => {
  render(<EditorPane markdown="needle" onChange={vi.fn()} onOpenLargeModelSettings={vi.fn()}
    documentKey="new.md" findRequest={{ id: 1, documentKey: 'new.md', query: 'needle', isCurrent: () => false }} />)
  act(editIndicatorBridge.findReady.at(-1)!)
  expect(screen.queryByRole('searchbox', { name: '在文档中搜索' })).not.toBeInTheDocument()
})

function ControlledPane({
  documentAbsolutePath = 'C:\\Workspace\\note.md',
  documentKey = 'note.md',
  onModeChange,
  spellCheckEnabled = false,
  zoomPercent = 100,
}: {
  documentAbsolutePath?: string | null
  documentKey?: string
  onModeChange?: (mode: 'visual' | 'source') => void
  spellCheckEnabled?: boolean
  zoomPercent?: number
}) {
  const [markdown, setMarkdown] = useState('# Initial')
  return <>
    <button onClick={() => setMarkdown('# External')}>external update</button>
    <output>{markdown}</output>
    <EditorPane
      documentAbsolutePath={documentAbsolutePath}
      documentKey={documentKey}
      markdown={markdown}
      spellCheckEnabled={spellCheckEnabled}
      zoomPercent={zoomPercent}
      onChange={setMarkdown}
      onOpenLargeModelSettings={() => undefined}
      onModeChange={onModeChange}
    />
  </>
}

function toggleEditorMode() {
  act(() => window.dispatchEvent(new CustomEvent('arkdown:editor-command', {
    detail: 'toggle-source-mode',
  })))
}

it('opens a code document as literal source and refuses Markdown mode switching', () => {
  const onChange = vi.fn()
  const onModeChange = vi.fn()
  render(<EditorPane documentKey="settings.json" documentAbsolutePath="C:/Workspace/settings.json"
    markdown={'{\r\n  "value": "**literal**"\n}\r\n'} onChange={onChange}
    onModeChange={onModeChange} onOpenLargeModelSettings={vi.fn()} />)
  expect(screen.getByTestId('source-editor')).toHaveAttribute('data-plain-text', 'true')
  expect(screen.getByTestId('source-editor')).toHaveAttribute('data-document-path', 'C:/Workspace/settings.json')
  expect(screen.queryByTestId('visual-editor')).not.toBeInTheDocument()
  expect(onModeChange).toHaveBeenCalledWith('source')
  toggleEditorMode()
  expect(screen.getByTestId('source-editor')).toBeInTheDocument()
  expect(screen.queryByTestId('visual-editor')).not.toBeInTheDocument()
  expect(onChange).not.toHaveBeenCalled()
})

it('keeps a dirty main editor intact while opening a relative preview, switching tabs and returning to its source', async () => {
  const navigate = vi.fn(async () => ({ ok: true as const, value: {
    kind: 'document' as const, document: {
      id: 'preview-1', absolutePath: 'C:/Workspace/result.md', displayName: 'result.md',
      kind: 'markdown' as const, text: '# Evidence\n\n[go](nested.json)', revision: 'a'.repeat(64),
    },
  } }))
  Object.assign(window.arkdown, {
    navigateDocumentView: navigate,
    refreshDocumentView: vi.fn(),
    inspectDocumentView: vi.fn(async () => ({ ok: true, value: { changed: false, exists: true } })),
    openDocumentView: vi.fn(),
  })
  const changed = vi.fn()
  const editor = createRef<EditorPaneHandle>()
  function Harness() {
    const [sidebar, setSidebar] = useState<{open: boolean; activeTab: 'translation'|'ai-chat'|'document-view'}>({ open: false, activeTab: 'translation' })
    return <EditorPane ref={editor} documentKey="report.md" documentDisplayName="report.md"
      documentAbsolutePath="C:/Workspace/report.md" markdown="# Main" onChange={changed}
      onOpenLargeModelSettings={vi.fn()} rightSidebarState={sidebar}
      onOpenRightSidebar={(activeTab) => setSidebar({ open: true, activeTab })}
      onCloseRightSidebar={() => setSidebar((state) => ({ ...state, open: false }))} />
  }
  render(<Harness />)
  fireEvent.change(screen.getByTestId('visual-editor'), { target: { value: '# Main unsaved' } })
  await act(async () => { await editIndicatorBridge.openDocumentLink?.('./result.md') })
  expect(navigate).toHaveBeenCalledWith({ href: './result.md' })
  expect(await screen.findByRole('heading', { name: 'Evidence' })).toBeInTheDocument()
  expect(changed).not.toHaveBeenCalled()
  expect(screen.getByTestId('visual-editor')).toHaveValue('# Main unsaved')
  fireEvent.click(screen.getByRole('tab', { name: '翻译' }))
  fireEvent.click(screen.getByRole('tab', { name: '文档查看' }))
  expect(await screen.findByRole('heading', { name: 'Evidence' })).toBeInTheDocument()
  expect(navigate).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'report.md' }))
  expect(screen.getByTestId('visual-editor')).toHaveFocus()
  expect(screen.getByTestId('visual-editor')).toHaveValue('# Main unsaved')
  expect(changed).not.toHaveBeenCalled()
  act(() => { expect(editor.current?.flush()).toBe('# Main unsaved') })
  expect(changed).toHaveBeenCalledWith('# Main unsaved')
})

function dispatchMarginPointer(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  pointerId: number,
  clientX: number,
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX,
    clientY: 40,
  })
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: pointerId },
    pointerType: { value: 'mouse' },
  })
  target.dispatchEvent(event)
}

it('registers dynamic current-document and open-editor AI ports and rebinds on document change', async () => {
  const api = window.arkdown
  const workspace = {
    workspaceId: 'workspace-a',
    workspaceGeneration: 'generation-1',
  }
  function Harness({
    absolutePath, displayName, documentKey, markdown,
  }: {
    absolutePath: string
    displayName: string
    documentKey: string
    markdown: string
  }) {
    const controller = useWorkspaceAiConversationController()
    useEffect(() => { void controller.activateCurrentWorkspace() }, [
      controller.activateCurrentWorkspace,
    ])
    return <EditorPane
      aiWorkspace={controller.activeWorkspace}
      documentAbsolutePath={absolutePath}
      documentDirty
      documentDisplayName={displayName}
      documentKey={documentKey}
      markdown={markdown}
      onChange={() => undefined}
      onOpenLargeModelSettings={() => undefined}
    />
  }
  const view = render(
    <WorkspaceAiConversationProvider api={api}>
      <Harness
        absolutePath="C:\\workspace\\one.md"
        displayName="one.md"
        documentKey="one.md"
        markdown="# First unsaved"
      />
    </WorkspaceAiConversationProvider>,
  )

  await waitFor(() => expect(api.registerAiCurrentDocumentPort).toHaveBeenCalledOnce())
  await waitFor(() => expect(api.registerAiOpenDocumentPort).toHaveBeenCalledOnce())
  const currentPort = vi.mocked(api.registerAiCurrentDocumentPort).mock.calls[0]![0]
  let first!: Awaited<ReturnType<typeof currentPort.openSnapshot>>
  await waitFor(async () => {
    first = await currentPort.openSnapshot({ cursor: 0, maxChars: 7 })
    expect(first.status).toBe('captured')
  })
  expect(first).toMatchObject({
    status: 'captured',
    displayName: 'one.md',
    dirty: true,
    content: '# First',
    hasMore: true,
  })

  view.rerender(
    <WorkspaceAiConversationProvider api={api}>
      <Harness
        absolutePath="C:\\workspace\\two.md"
        displayName="two.md"
        documentKey="two.md"
        markdown="# Second live"
      />
    </WorkspaceAiConversationProvider>,
  )
  let second!: Awaited<ReturnType<typeof currentPort.openSnapshot>>
  await waitFor(async () => {
    second = await currentPort.openSnapshot({ cursor: 0, maxChars: 20 })
    expect(second.status).toBe('captured')
  })
  expect(second).toMatchObject({
    status: 'captured',
    displayName: 'two.md',
    content: '# Second live',
  })
  await waitFor(() => expect(api.notifyAiCurrentDocumentChanged).toHaveBeenCalledWith(workspace))
  await waitFor(() => expect(api.unregisterAiOpenDocumentPort).toHaveBeenCalledWith(
    '550e8400-e29b-41d4-a716-446655440010',
  ))
  await waitFor(() => expect(api.registerAiOpenDocumentPort).toHaveBeenCalledTimes(2))
  expect(vi.mocked(api.registerAiOpenDocumentPort).mock.calls[1]![0])
    .toBe(editIndicatorBridge.visualAiPort)

  view.unmount()
  await waitFor(() => expect(api.unregisterAiCurrentDocumentPort).toHaveBeenCalledOnce())
})

it('routes one margin-selection controller to the live editor and ignores a port that is not ready', () => {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  try {
    render(<ControlledPane />)
    const surface = screen.getByTestId('visual-editor').closest('.editor-surface')!
    dispatchMarginPointer(surface, 'pointerdown', 901, 10)
    dispatchMarginPointer(window, 'pointermove', 901, 40)
    act(() => frames.shift()?.(performance.now()))
    expect(editIndicatorBridge.visualMarginPort.beginPointerSelection).toHaveBeenCalledOnce()
    expect(editIndicatorBridge.visualMarginPort.applySelection).toHaveBeenCalledWith(1, 5)
    expect(editIndicatorBridge.sourceMarginPort.beginPointerSelection).not.toHaveBeenCalled()
    dispatchMarginPointer(window, 'pointerup', 901, 50)

    toggleEditorMode()
    const sourceSurface = screen.getByTestId('source-editor').closest('.editor-surface')!
    dispatchMarginPointer(sourceSurface, 'pointerdown', 902, 10)
    dispatchMarginPointer(window, 'pointermove', 902, 40)
    act(() => frames.shift()?.(performance.now()))
    expect(editIndicatorBridge.sourceMarginPort.beginPointerSelection).toHaveBeenCalledOnce()
    expect(editIndicatorBridge.sourceMarginPort.applySelection).toHaveBeenCalledWith(2, 8)
    dispatchMarginPointer(window, 'pointerup', 902, 50)

    editIndicatorBridge.sourceMarginPortReady = false
    dispatchMarginPointer(sourceSurface, 'pointerdown', 903, 10)
    dispatchMarginPointer(window, 'pointermove', 903, 40)
    act(() => frames.shift()?.(performance.now()))
    expect(editIndicatorBridge.sourceMarginPort.beginPointerSelection).toHaveBeenCalledOnce()
  } finally {
    vi.unstubAllGlobals()
  }
})

it('cancels an active margin selection on document, mode, sidebar-layout changes, and unmount', () => {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const start = (surface: Element, pointerId: number) => {
    dispatchMarginPointer(surface, 'pointerdown', pointerId, 10)
    dispatchMarginPointer(window, 'pointermove', pointerId, 40)
    act(() => frames.shift()?.(performance.now()))
  }
  try {
    const view = render(
      <EditorPane
        documentKey="first.md"
        markdown="first"
        onChange={vi.fn()}
        onOpenLargeModelSettings={() => undefined}
        rightSidebarState={{ open: false, activeTab: 'translation' }}
      />,
    )
    let surface = screen.getByTestId('visual-editor').closest('.editor-surface')!
    start(surface, 911)
    view.rerender(
      <EditorPane
        documentKey="second.md"
        markdown="second"
        onChange={vi.fn()}
        onOpenLargeModelSettings={() => undefined}
        rightSidebarState={{ open: false, activeTab: 'translation' }}
      />,
    )
    expect(editIndicatorBridge.visualMarginPort.cancelPointerSelection).toHaveBeenCalledTimes(1)

    surface = screen.getByTestId('visual-editor').closest('.editor-surface')!
    start(surface, 912)
    toggleEditorMode()
    expect(editIndicatorBridge.visualMarginPort.cancelPointerSelection).toHaveBeenCalledTimes(2)

    surface = screen.getByTestId('source-editor').closest('.editor-surface')!
    start(surface, 913)
    view.rerender(
      <EditorPane
        documentKey="second.md"
        markdown="second"
        initialMode="source"
        onChange={vi.fn()}
        onOpenLargeModelSettings={() => undefined}
        rightSidebarState={{ open: true, activeTab: 'translation' }}
      />,
    )
    expect(editIndicatorBridge.sourceMarginPort.cancelPointerSelection).toHaveBeenCalledTimes(1)

    view.unmount()
    frames.length = 0

    const unmountView = render(
      <EditorPane
        documentKey="third.md"
        markdown="third"
        initialMode="source"
        onChange={vi.fn()}
        onOpenLargeModelSettings={() => undefined}
        rightSidebarState={{ open: false, activeTab: 'translation' }}
      />,
    )
    surface = screen.getByTestId('source-editor').closest('.editor-surface')!
    start(surface, 914)
    unmountView.unmount()
    expect(editIndicatorBridge.sourceMarginPort.cancelPointerSelection).toHaveBeenCalledTimes(2)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('does not cancel an active margin selection for ordinary editor DOM updates', async () => {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  try {
    render(<ControlledPane />)
    const surface = screen.getByTestId('visual-editor').closest('.editor-surface')!
    dispatchMarginPointer(surface, 'pointerdown', 921, 10)
    dispatchMarginPointer(window, 'pointermove', 921, 40)
    act(() => frames.shift()?.(performance.now()))
    expect(editIndicatorBridge.visualMarginPort.beginPointerSelection).toHaveBeenCalledOnce()

    screen.getByTestId('visual-editor').append(document.createElement('span'))
    await act(async () => { await Promise.resolve() })

    expect(editIndicatorBridge.visualMarginPort.cancelPointerSelection).not.toHaveBeenCalled()
    dispatchMarginPointer(window, 'pointerup', 921, 50)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('reports initial and successful mode switches in order without stale duplicates', () => {
  const onModeChange = vi.fn()
  const view = render(<StrictMode><ControlledPane onModeChange={onModeChange} /></StrictMode>)

  expect(onModeChange.mock.calls).toEqual([['visual']])
  expect(screen.getByTestId('visual-editor'))
    .toHaveAttribute('data-document-absolute-path', 'C:\\Workspace\\note.md')

  act(() => {
    for (let index = 0; index < 2; index += 1) {
      window.dispatchEvent(new CustomEvent('arkdown:editor-command', {
        detail: 'toggle-source-mode',
      }))
    }
  })
  act(() => window.dispatchEvent(new CustomEvent('arkdown:editor-command', {
    detail: 'unrelated-command',
  })))
  view.rerender(<StrictMode><ControlledPane onModeChange={onModeChange} /></StrictMode>)

  expect(onModeChange.mock.calls).toEqual([
    ['visual'],
    ['source'],
    ['visual'],
  ])
})

it('passes one Mermaid appearance snapshot through without resetting visual mode or its checkpoint', () => {
  const initial: MermaidAppearance = Object.freeze({
    revision: 10,
    editorTheme: 'minimal',
    colorScheme: 'light',
    themeColor: '#336699',
    bodyFontFamily: '"Arial", "Microsoft YaHei"',
  })
  const next: MermaidAppearance = Object.freeze({
    ...initial,
    revision: 11,
    colorScheme: 'dark',
    themeColor: '#CC5500',
  })
  const common = {
    documentKey: 'note.md',
    markdown: '# Initial',
    onChange: vi.fn(),
    onOpenLargeModelSettings: () => undefined,
  }
  const view = render(<EditorPane {...common} mermaidAppearance={initial} />)
  const visual = screen.getByTestId('visual-editor')
  fireEvent.change(visual, { target: { value: '# Pending checkpoint' } })

  view.rerender(<EditorPane {...common} mermaidAppearance={next} />)

  expect(screen.getByTestId('visual-editor')).toBe(visual)
  expect(visual).toHaveValue('# Pending checkpoint')
  expect(editIndicatorBridge.mermaidAppearances.at(-1)).toBe(next)
  expect(visual).toHaveAttribute('data-mermaid-appearance', JSON.stringify(next))

  toggleEditorMode()
  expect(screen.getByTestId('source-editor')).toHaveValue('# Pending checkpoint')
})

it('resets and reports visual when documentKey changes without remounting', () => {
  const onChange = vi.fn()
  const onModeChange = vi.fn()
  const view = render(
    <EditorPane
      documentAbsolutePath={'C:\\Workspace\\first.md'}
      documentKey="first.md"
      markdown="# First"
      onChange={onChange}
      onOpenLargeModelSettings={() => undefined}
      onModeChange={onModeChange}
    />,
  )

  toggleEditorMode()
  expect(screen.getByTestId('source-editor')).toBeVisible()
  expect(onModeChange.mock.calls).toEqual([['visual'], ['source']])

  view.rerender(
    <EditorPane
      documentAbsolutePath={'C:\\Workspace\\second.md'}
      documentKey="second.md"
      markdown="# Second"
      onChange={onChange}
      onOpenLargeModelSettings={() => undefined}
      onModeChange={onModeChange}
    />,
  )

  expect(screen.queryByTestId('source-editor')).not.toBeInTheDocument()
  expect(screen.getByTestId('visual-editor'))
    .toHaveAttribute('data-document-absolute-path', 'C:\\Workspace\\second.md')
  expect(onModeChange.mock.calls).toEqual([
    ['visual'],
    ['source'],
    ['visual'],
  ])
})

it('starts visual without a duplicate mode button and checkpoints before switching', () => {
  render(<ControlledPane />)

  const firstVisual = screen.getByTestId('visual-editor')
  expect(firstVisual).toHaveValue('# Initial')
  expect(firstVisual).toHaveAttribute('data-document-absolute-path', 'C:\\Workspace\\note.md')
  expect(document.querySelector('.mode-toggle')).not.toBeInTheDocument()

  fireEvent.change(firstVisual, { target: { value: '# From visual' } })
  expect(screen.getByText('# Initial', { selector: 'output' })).toBeVisible()
  toggleEditorMode()

  const firstSource = screen.getByTestId('source-editor')
  expect(firstSource).toHaveValue('# From visual')

  fireEvent.change(firstSource, { target: { value: '# From source' } })
  toggleEditorMode()

  const secondVisual = screen.getByTestId('visual-editor')
  expect(secondVisual).toHaveValue('# From source')
  expect(secondVisual).not.toBe(firstVisual)
})

it('exposes a synchronous flush handle for document and workspace transitions', () => {
  const editorRef = createRef<EditorPaneHandle>()

  function Harness() {
    const [markdown, setMarkdown] = useState('# Initial')
    return <>
      <output>{markdown}</output>
      <EditorPane
        ref={editorRef}
        documentKey="note.md"
        markdown={markdown}
        onChange={setMarkdown}
        onOpenLargeModelSettings={() => undefined}
      />
    </>
  }

  render(<Harness />)
  fireEvent.change(screen.getByTestId('visual-editor'), {
    target: { value: '# Immediate transition' },
  })
  expect(screen.getByText('# Initial', { selector: 'output' })).toBeVisible()

  let checkpoint: string | null | undefined
  act(() => {
    checkpoint = editorRef.current?.flush()
  })

  expect(checkpoint).toBe('# Immediate transition')
  expect(screen.getByText('# Immediate transition', { selector: 'output' })).toBeVisible()
})

it('keeps the source editor controlled without remounting on parent updates', async () => {
  const user = userEvent.setup()
  render(<ControlledPane />)

  toggleEditorMode()
  const source = screen.getByTestId('source-editor')
  await user.click(screen.getByRole('button', { name: 'external update' }))

  expect(screen.getByTestId('source-editor')).toBe(source)
  expect(source).toHaveValue('# External')
})

it('creates fresh editor instances on every mode switch', () => {
  render(<ControlledPane />)

  const firstVisual = screen.getByTestId('visual-editor')
  toggleEditorMode()
  const firstSource = screen.getByTestId('source-editor')
  toggleEditorMode()
  const secondVisual = screen.getByTestId('visual-editor')
  toggleEditorMode()
  const secondSource = screen.getByTestId('source-editor')

  expect(secondVisual).not.toBe(firstVisual)
  expect(secondSource).not.toBe(firstSource)
})

it('hands the outgoing logical cursor position to the next mode and clears it for a new document', () => {
  const onChange = vi.fn()
  const view = render(
    <EditorPane
      documentKey="first.md"
      markdown="# First"
      onChange={onChange}
      onOpenLargeModelSettings={() => undefined}
    />,
  )

  toggleEditorMode()
  expect(screen.getByTestId('source-editor')).toHaveAttribute(
    'data-mode-position',
    JSON.stringify(editIndicatorBridge.visualModePosition),
  )

  toggleEditorMode()
  expect(screen.getByTestId('visual-editor')).toHaveAttribute(
    'data-mode-position',
    JSON.stringify(editIndicatorBridge.sourceModePosition),
  )

  toggleEditorMode()
  view.rerender(
    <EditorPane
      documentKey="second.md"
      markdown="# Second"
      onChange={onChange}
      onOpenLargeModelSettings={() => undefined}
    />,
  )
  expect(screen.getByTestId('visual-editor')).toHaveAttribute('data-mode-position', 'null')
})

it('captures the visual cursor against the flushed checkpoint used by source mode', () => {
  render(<ControlledPane />)
  fireEvent.change(screen.getByTestId('visual-editor'), {
    target: { value: '# Normalized imported DOCX' },
  })

  toggleEditorMode()

  expect(screen.getByTestId('source-editor')).toHaveValue('# Normalized imported DOCX')
  expect(editIndicatorBridge.visualModeTargets).toEqual(['# Normalized imported DOCX'])
})

it('falls back to the regular flush and cursor capture when atomic capture fails', () => {
  render(<ControlledPane />)
  fireEvent.change(screen.getByTestId('visual-editor'), {
    target: { value: '# Pending fallback' },
  })
  editIndicatorBridge.visualModeSwitchThrows = true

  toggleEditorMode()

  expect(screen.getByTestId('source-editor')).toHaveValue('# Pending fallback')
  expect(screen.getByTestId('source-editor')).toHaveAttribute(
    'data-mode-position',
    JSON.stringify(editIndicatorBridge.visualModePosition),
  )
  expect(editIndicatorBridge.visualModeTargets).toEqual(['# Pending fallback'])
})

it('keeps the chosen spelling state across visual and source mode switches', () => {
  function Harness() {
    const [spellCheckEnabled, setSpellCheckEnabled] = useState(false)
    return <>
      <button onClick={() => setSpellCheckEnabled(true)} type="button">enable spelling</button>
      <ControlledPane spellCheckEnabled={spellCheckEnabled} />
    </>
  }

  render(<Harness />)
  expect(screen.getByTestId('visual-editor')).toHaveAttribute('data-spellcheck', 'false')

  fireEvent.click(screen.getByRole('button', { name: 'enable spelling' }))
  expect(screen.getByTestId('visual-editor')).toHaveAttribute('data-spellcheck', 'true')
  toggleEditorMode()
  expect(screen.getByTestId('source-editor')).toHaveAttribute('data-spellcheck', 'true')
  toggleEditorMode()
  expect(screen.getByTestId('visual-editor')).toHaveAttribute('data-spellcheck', 'true')
})

it('changes zoom without recreating the active editor or losing focus, selection, history content, or scroll', () => {
  function Harness() {
    const [zoomPercent, setZoomPercent] = useState(100)
    const [markdown, setMarkdown] = useState('# Initial')
    return <>
      <button onClick={() => setZoomPercent(140)} type="button">zoom 140</button>
      <button onClick={() => setZoomPercent(70)} type="button">zoom 70</button>
      <output>{markdown}</output>
      <EditorPane
        documentKey="note.md"
        markdown={markdown}
        onChange={setMarkdown}
        onOpenLargeModelSettings={() => undefined}
        zoomPercent={zoomPercent}
      />
    </>
  }

  render(<Harness />)
  const visual = screen.getByTestId<HTMLTextAreaElement>('visual-editor')
  const pane = screen.getByRole('region', { name: 'Markdown editor' })
  visual.focus()
  visual.setSelectionRange(2, 6)
  visual.scrollTop = 43
  const selectionBeforeZoom = [visual.selectionStart, visual.selectionEnd]

  fireEvent.click(screen.getByRole('button', { name: 'zoom 140' }))

  expect(screen.getByTestId('visual-editor')).toBe(visual)
  expect(visual).toHaveFocus()
  expect([visual.selectionStart, visual.selectionEnd]).toEqual(selectionBeforeZoom)
  expect(visual.scrollTop).toBe(43)
  expect(pane.style.getPropertyValue('--editor-zoom-factor')).toBe('1.4')

  fireEvent.change(visual, { target: { value: '# Undo-preserved draft' } })
  toggleEditorMode()
  const source = screen.getByTestId<HTMLTextAreaElement>('source-editor')
  expect(source).toHaveValue('# Undo-preserved draft')
  expect(pane.style.getPropertyValue('--editor-zoom-factor')).toBe('1.4')
  fireEvent.change(source, { target: { value: '# Source session' } })

  fireEvent.click(screen.getByRole('button', { name: 'zoom 70' }))
  expect(screen.getByTestId('source-editor')).toBe(source)
  expect(source).toHaveValue('# Source session')
  expect(pane.style.getPropertyValue('--editor-zoom-factor')).toBe('0.7')

  toggleEditorMode()
  expect(screen.getByTestId('visual-editor')).toHaveValue('# Source session')
  expect(pane.style.getPropertyValue('--editor-zoom-factor')).toBe('0.7')
})

it('keeps rendering editable and mode switching intact without visual indicators', () => {
  const onChange = vi.fn()
  const firstModel = {
    lineStates: ['unsaved'] as const,
    status: 'ready' as const,
    markdownVersion: 1,
    modelVersion: 1,
  }
  const view = render(
    <EditorPane
      documentKey="note.md"
      editIndicatorModel={firstModel}
      markdown="draft"
      onChange={onChange}
      onOpenLargeModelSettings={() => undefined}
      showEditIndicators
    />,
  )
  const visual = screen.getByTestId('visual-editor')
  const surface = visual.closest('.editor-surface')!
  expect(surface.querySelector('.arkdown-visual-edit-indicator-layer')).toBeNull()
  expect(editIndicatorBridge.visualInputs.at(-1)).toBeUndefined()

  const failedModel = {
    lineStates: [] as const,
    status: 'failed' as const,
    markdownVersion: 2,
    modelVersion: 2,
  }
  view.rerender(
    <EditorPane
      documentKey="note.md"
      editIndicatorModel={failedModel}
      markdown="draft"
      onChange={onChange}
      onOpenLargeModelSettings={() => undefined}
      showEditIndicators={false}
    />,
  )
  expect(screen.getByTestId('visual-editor')).toBe(visual)
  expect(surface.querySelector('.arkdown-visual-edit-indicator-layer')).toBeNull()
  expect(editIndicatorBridge.visualInputs.at(-1)).toBeUndefined()

  fireEvent.change(visual, { target: { value: 'still editable' } })
  expect(visual).not.toBeDisabled()
  toggleEditorMode()
  expect(screen.getByTestId('source-editor')).toHaveValue('still editable')
  expect(surface.querySelector('.arkdown-visual-edit-indicator-layer')).toBeNull()
})

it('passes the Task 15 source line state and real visibility preference without changing the source key', () => {
  const model = {
    lineStates: ['saved', 'unsaved'] as const,
    status: 'ready' as const,
    markdownVersion: 3,
    modelVersion: 7,
  }
  const view = render(
    <EditorPane
      documentKey="note.md"
      editIndicatorModel={model}
      markdown="first\nsecond"
      onChange={vi.fn()}
      onOpenLargeModelSettings={() => undefined}
      showEditIndicators
      initialMode="source"
    />,
  )

  const source = screen.getByTestId('source-editor')
  expect(source).toHaveAttribute('data-line-indicators', 'saved,unsaved')
  expect(source).toHaveAttribute('data-show-edit-indicators', 'true')
  expect(editIndicatorBridge.sourceInputs.at(-1)).toEqual({
    lineIndicators: ['saved', 'unsaved'], showEditIndicators: true,
  })
  view.rerender(
    <EditorPane
      documentKey="note.md"
      editIndicatorModel={{ ...model, lineStates: ['none', 'saved'], modelVersion: 8 }}
      markdown="first\nsecond"
      onChange={vi.fn()}
      onOpenLargeModelSettings={() => undefined}
      showEditIndicators
      initialMode="source"
    />,
  )
  expect(screen.getByTestId('source-editor')).toBe(source)
  expect(editIndicatorBridge.sourceInputs.at(-1)).toEqual({
    lineIndicators: ['none', 'saved'], showEditIndicators: true,
  })
  view.rerender(
    <EditorPane
      documentKey="note.md"
      editIndicatorModel={{ ...model, lineStates: ['none', 'saved'], modelVersion: 8 }}
      markdown="first\nsecond"
      onChange={vi.fn()}
      onOpenLargeModelSettings={() => undefined}
      showEditIndicators={false}
      initialMode="source"
    />,
  )
  expect(screen.getByTestId('source-editor')).toBe(source)
  expect(editIndicatorBridge.sourceInputs.at(-1)).toEqual({
    lineIndicators: ['none', 'saved'], showEditIndicators: false,
  })
})

it('resets to a fresh visual editor when the keyed document changes', () => {
  const view = render(
    <EditorPane
      key="first.md"
      documentKey="first.md"
      markdown="# First"
      onChange={vi.fn()}
      onOpenLargeModelSettings={() => undefined}
    />,
  )
  toggleEditorMode()
  const firstSource = screen.getByTestId('source-editor')

  view.rerender(
    <EditorPane
      key="second.md"
      documentKey="second.md"
      markdown="# Second"
      onChange={vi.fn()}
      onOpenLargeModelSettings={() => undefined}
    />,
  )

  expect(screen.queryByTestId('source-editor')).not.toBeInTheDocument()
  expect(screen.getByTestId('visual-editor')).toHaveValue('# Second')
  expect(screen.getByTestId('visual-editor')).not.toBe(firstSource)
})


it('switches editor mode from the Chinese application menu command', () => {
  render(<ControlledPane />)
  expect(screen.getByTestId('visual-editor')).toBeVisible()

  toggleEditorMode()

  expect(screen.getByTestId('source-editor')).toBeVisible()
})

it('provides Codex-style current-document find interactions', async () => {
  const actions: unknown[] = []
  const onFind = (event: Event) => {
    actions.push((event as CustomEvent<unknown>).detail)
  }
  window.addEventListener('arkdown:document-find', onFind)

  try {
    render(<ControlledPane />)

    act(() => window.dispatchEvent(new CustomEvent('arkdown:editor-command', {
      detail: 'find-in-document',
    })))

    const input = screen.getByRole('searchbox', { name: '在文档中搜索' })
    expect(input).toHaveFocus()
    expect(input).toHaveAttribute('placeholder', '输入要查找的内容...')

    fireEvent.change(input, { target: { value: 'Initial' } })
    expect(actions.at(-1)).toEqual({ type: 'query', query: 'Initial' })
    act(() => window.dispatchEvent(new CustomEvent('arkdown:document-find-snapshot', {
      detail: { query: 'Initial', current: 2, total: 7, revision: 1 },
    })))
    expect(screen.getByText('2/7')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '上一条搜索结果' }))
    expect(actions.at(-1)).toEqual({ type: 'previous' })
    fireEvent.click(screen.getByRole('button', { name: '下一条搜索结果' }))
    expect(actions.at(-1)).toEqual({ type: 'next' })

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(actions.at(-1)).toEqual({ type: 'next' })

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(actions.at(-1)).toEqual({ type: 'previous' })

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(actions.at(-1)).toEqual({ type: 'close' })
    expect(screen.queryByRole('searchbox', { name: '在文档中搜索' }))
      .not.toBeInTheDocument()
    await waitFor(() => expect(
      screen.getByRole('textbox', { name: 'visual editor' }),
    ).toHaveFocus())

    act(() => window.dispatchEvent(new CustomEvent('arkdown:editor-command', {
      detail: 'find-in-document',
    })))
    fireEvent.click(screen.getByRole('button', { name: '关闭文档搜索' }))
    expect(actions.at(-1)).toEqual({ type: 'close' })
    expect(screen.queryByRole('searchbox', { name: '在文档中搜索' }))
      .not.toBeInTheDocument()
  } finally {
    window.removeEventListener('arkdown:document-find', onFind)
  }
})

it('lets document find consume Escape after focus moves outside before a lower owner runs', () => {
  const view = render(<ControlledPane />)
  act(() => window.dispatchEvent(new CustomEvent('arkdown:editor-command', {
    detail: 'find-in-document',
  })))

  const editor = screen.getByRole('textbox', { name: 'visual editor' })
  editor.focus()
  const lowerEscapeOwner = vi.fn()
  const onLowerEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !event.defaultPrevented) lowerEscapeOwner()
  }
  window.addEventListener('keydown', onLowerEscape)

  try {
    expect(fireEvent.keyDown(editor, { key: 'Escape' })).toBe(false)
    expect(screen.queryByRole('searchbox', { name: '在文档中搜索' }))
      .not.toBeInTheDocument()
    expect(lowerEscapeOwner).not.toHaveBeenCalled()
    expect(editor).toHaveFocus()

    fireEvent.keyDown(editor, { key: 'Escape' })
    expect(lowerEscapeOwner).toHaveBeenCalledOnce()

    act(() => window.dispatchEvent(new CustomEvent('arkdown:editor-command', {
      detail: 'find-in-document',
    })))
    expect(screen.getByRole('searchbox', { name: '在文档中搜索' })).toBeVisible()
    view.unmount()
    lowerEscapeOwner.mockClear()
    expect(fireEvent.keyDown(window, { key: 'Escape' })).toBe(true)
    expect(lowerEscapeOwner).toHaveBeenCalledOnce()
  } finally {
    window.removeEventListener('keydown', onLowerEscape)
  }
})

it('toggles document find from the toolbar but keeps Ctrl+F open and focused', () => {
  render(<ControlledPane />)

  act(() => window.dispatchEvent(new CustomEvent('arkdown:editor-command', {
    detail: 'toggle-document-find',
  })))
  const input = screen.getByRole('searchbox', { name: '在文档中搜索' })
  fireEvent.change(input, { target: { value: 'Initial' } })
  expect(input).toHaveValue('Initial')

  act(() => window.dispatchEvent(new CustomEvent('arkdown:editor-command', {
    detail: 'toggle-document-find',
  })))
  expect(screen.queryByRole('searchbox', { name: '在文档中搜索' })).not.toBeInTheDocument()

  act(() => window.dispatchEvent(new CustomEvent('arkdown:editor-command', {
    detail: 'find-in-document',
  })))
  const reopened = screen.getByRole<HTMLInputElement>('searchbox', { name: '在文档中搜索' })
  fireEvent.change(reopened, { target: { value: 'Initial' } })
  act(() => reopened.blur())
  expect(reopened).not.toHaveFocus()

  act(() => window.dispatchEvent(new CustomEvent('arkdown:editor-command', {
    detail: 'find-in-document',
  })))
  expect(reopened).toHaveFocus()
  expect(reopened.selectionStart).toBe(0)
  expect(reopened.selectionEnd).toBe('Initial'.length)
})

it.each([
  ['new', null, ''],
  ['zero-byte', 'C:/Workspace/empty.md', ''],
  ['whitespace', 'C:/Workspace/space.md', String.fromCharCode(10, 10) + '  '],
  ['note', 'C:/Workspace/note.md', ''],
] as const)('switches empty document modes without a content callback: %s', (documentKey, documentAbsolutePath, markdown) => {
  const onChange = vi.fn()
  const onModeChange = vi.fn()
  render(<EditorPane documentKey={documentKey} documentAbsolutePath={documentAbsolutePath}
    markdown={markdown} onChange={onChange} onModeChange={onModeChange} onOpenLargeModelSettings={vi.fn()} />)
  expect(screen.getByTestId('visual-editor')).toHaveValue(markdown)
  toggleEditorMode()
  expect(screen.getByTestId('source-editor')).toHaveValue(markdown)
  toggleEditorMode()
  expect(screen.getByTestId('visual-editor')).toHaveValue(markdown)
  expect(onChange).not.toHaveBeenCalled()
  expect(onModeChange.mock.calls.map(([mode]) => mode)).toEqual(['visual', 'source', 'visual'])
})

it('switches after deletion to empty and retains the interaction lock', () => {
  const onChange = vi.fn()
  const props = { documentKey: 'deleted.md', onChange, onOpenLargeModelSettings: vi.fn() }
  const { rerender } = render(<EditorPane {...props} markdown="before deletion" />)
  rerender(<EditorPane {...props} markdown="" />)
  toggleEditorMode()
  expect(screen.getByTestId('source-editor')).toHaveValue('')
  rerender(<EditorPane {...props} markdown="" interactionLocked />)
  toggleEditorMode()
  expect(screen.getByTestId('source-editor')).toBeInTheDocument()
  rerender(<EditorPane {...props} markdown="" interactionLocked={false} />)
  toggleEditorMode()
  expect(screen.getByTestId('visual-editor')).toHaveValue('')
  expect(onChange).not.toHaveBeenCalled()
})
