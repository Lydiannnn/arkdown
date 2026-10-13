import { modelObservation, modelCommit } from '../helpers/model-observation'
import { ModelPreferenceDraft } from '../../src/renderer/settings/model-preference-draft'
import { createPreferencePersistence } from '../../src/renderer/settings/preference-update-queue'
import type { PublicModelMutationResult } from '../../src/shared/settings-observation'
let modelPreferences: ModelPreferenceDraft
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRef, forwardRef, useImperativeHandle, useState, type Ref } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { startModelRulesInitialization } from '../../src/renderer/settings/model-rules-runtime'
import type {
  ApiResult,
  ArkdownApi,
} from '../../src/shared/contracts'
import type { LargeModelSettings } from '../../src/shared/large-model-settings'
import type { PublicErrorCode } from '../../src/shared/public-errors'
import type {
  AiConversationEvent,
} from '../../src/shared/ai-conversation'
import { AI_CONVERSATION_MESSAGE_MAX_CHARS } from '../../src/shared/ai-conversation'
import type {
  CodeExplanationRequestDetail,
} from '../../src/renderer/editor/mermaid/adaptive-code-block-view'
import type {
  SelectionAnchorRect,
  TranslationEvent,
  TranslationSelection,
  TranslationStarted,
} from '../../src/shared/selection-translation'
import {
  reduceTranslationUiState,
  type TranslationUiStateEvent,
  type TranslationUiState,
} from '../../src/renderer/editor/translation-ui-state'

type TranslationSelectionGeometry = {
  anchorRect: SelectionAnchorRect
  focusRect: SelectionAnchorRect
}

const editorBridge = vi.hoisted(() => ({
  source: null as ((selection: TranslationSelection | null) => void) | null,
  visual: null as ((selection: TranslationSelection | null) => void) | null,
  sourceAnchor: null as ((geometry: TranslationSelectionGeometry | null) => void) | null,
  visualAnchor: null as ((geometry: TranslationSelectionGeometry | null) => void) | null,
  sourceRefreshKey: undefined as number | string | undefined,
  visualRefreshKey: undefined as number | string | undefined,
  sourceHistoryReady: null as null | ((documentKey: string) => void),
  visualHistoryReady: null as null | ((documentKey: string) => void),
  visualTheme: undefined as string | undefined,
  railCenterRequest: null as null | { recordId: string; token: number },
  codeExplanation: null as null | ((detail: CodeExplanationRequestDetail) => void),
  visualChange: null as null | ((markdown: string) => void),
  visualFlushMarkdown: null as string | null,
  visualFlushEmitsChange: false,
}))

const historyEditorHandle = vi.hoisted(() => ({
  revealTranslationHistoryRecord: vi.fn(() => true),
  flushTranslationHistoryAnchors: vi.fn(() => []),
  capturePendingTranslationAnchor: vi.fn<(pendingKey: string) => boolean>(() => true),
  bindPendingTranslationAnchor: vi.fn<(pendingKey: string, requestId: string) => void>(),
  promotePendingTranslationAnchor: vi.fn<(requestId: string) => {
    mode: 'visual'
    from: number
    to: number
    blockStart: number
    fingerprint: { before: string; selected: string; after: string }
    status: 'valid'
  } | null>(() => ({
    mode: 'visual' as const,
    from: 4,
    to: 10,
    blockStart: 1,
    fingerprint: { before: 'a', selected: 'source', after: 'b' },
    status: 'valid' as const,
  })),
  discardPendingTranslationAnchor: vi.fn<(key: string) => void>(),
}))

vi.mock('../../src/renderer/editor/VisualEditor', () => ({
  VisualEditor: forwardRef<
    { flush(): string | null } & typeof historyEditorHandle,
    {
      markdown: string
      onChange(markdown: string): void
      onTranslationSelection?(selection: TranslationSelection | null): void
      onTranslationAnchorChange?(geometry: TranslationSelectionGeometry | null): void
      translationAnchorRefreshKey?: number | string
      documentKey?: string
      translationHistory?: {
        recordsForDocument(documentKey: string): readonly { id: string }[]
        onOpenRecord(recordId: string): void
      }
      onTranslationHistoryReady?(documentKey: string): void
      onCodeExplanationRequest?(detail: CodeExplanationRequestDetail): void
      editorTheme?: 'minimal'
    }
  >(function VisualEditorMock({
    markdown,
    onTranslationSelection,
    onTranslationAnchorChange,
    translationAnchorRefreshKey,
    documentKey,
    translationHistory,
    onTranslationHistoryReady,
    onCodeExplanationRequest,
    onChange,
    editorTheme,
  }, ref) {
    editorBridge.visual = onTranslationSelection ?? null
    editorBridge.visualAnchor = onTranslationAnchorChange ?? null
    editorBridge.visualRefreshKey = translationAnchorRefreshKey
    editorBridge.visualHistoryReady = onTranslationHistoryReady ?? null
    editorBridge.visualTheme = editorTheme
    editorBridge.codeExplanation = onCodeExplanationRequest ?? null
    editorBridge.visualChange = onChange
    useImperativeHandle(ref, () => ({
      flush: () => {
        const flushedMarkdown = editorBridge.visualFlushMarkdown ?? markdown
        if (editorBridge.visualFlushEmitsChange) onChange(flushedMarkdown)
        return flushedMarkdown
      },
      ...historyEditorHandle,
    }), [markdown])
    return <div className="visual-editor">
      <div className="ProseMirror" data-testid="visual-editor" tabIndex={0}>{markdown}</div>
    </div>
  }),
}))

vi.mock('../../src/renderer/editor/SourceEditor', () => ({
  SourceEditor: forwardRef(function SourceEditorMock({
    markdown,
    onTranslationSelection,
    onTranslationAnchorChange,
    translationAnchorRefreshKey,
    onTranslationHistoryReady,
  }: {
    markdown: string
    onChange(markdown: string): void
    onTranslationSelection?(selection: TranslationSelection | null): void
    onTranslationAnchorChange?(geometry: TranslationSelectionGeometry | null): void
    translationAnchorRefreshKey?: number | string
    onTranslationHistoryReady?(documentKey: string): void
  }, ref) {
    editorBridge.source = onTranslationSelection ?? null
    editorBridge.sourceAnchor = onTranslationAnchorChange ?? null
    editorBridge.sourceRefreshKey = translationAnchorRefreshKey
    editorBridge.sourceHistoryReady = onTranslationHistoryReady ?? null
    useImperativeHandle(ref, () => historyEditorHandle, [])
    return <div className="cm-content" data-testid="source-editor" tabIndex={0}>{markdown}</div>
  }),
}))

vi.mock('../../src/renderer/editor/TranslationHistoryRail', () => ({
  TranslationHistoryRail: ({
    mode,
    records,
    onOpenRecord,
    centerRequest,
  }: {
    mode: 'visual' | 'source'
    records: readonly { id: string; mode: 'visual' | 'source'; anchor: { status: string } }[]
    onOpenRecord(recordId: string, initiator: HTMLElement): void
    centerRequest?: { recordId: string; token: number } | null
  }) => {
    editorBridge.railCenterRequest = centerRequest ?? null
    return <div data-testid={`translation-history-rail-${mode}`}>
    {records
      .filter((record) => record.mode === mode && record.anchor.status === 'valid')
      .map((record) => <button
        aria-label="编辑器翻译记录标记"
        className="translation-history-rail-button"
        key={record.id}
        onClick={(event) => onOpenRecord(record.id, event.currentTarget)}
        type="button"
      >
        翻译
      </button>)}
    </div>
  },
}))

vi.mock('../../src/renderer/editor/TranslationPopover', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/editor/TranslationPopover')>()
  const ActualTranslationPopover = actual.TranslationPopover
  return {
    ...actual,
    TranslationPopover(props: Parameters<typeof ActualTranslationPopover>[0]) {
      return (
        <>
          <ActualTranslationPopover {...props} />
          <output data-testid="translation-ui-state">{JSON.stringify(props.state)}</output>
        </>
      )
    },
  }
})

vi.mock('../../src/renderer/editor/TranslationSidebar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/editor/TranslationSidebar')>()
  const ActualTranslationSidebar = actual.TranslationSidebar
  return {
    ...actual,
    TranslationSidebar(props: Parameters<typeof ActualTranslationSidebar>[0]) {
      return (
        <>
          <ActualTranslationSidebar {...props} />
          <output data-testid="translation-ui-state">{JSON.stringify(props.state)}</output>
        </>
      )
    },
  }
})

import { EditorPane, type EditorPaneHandle } from '../../src/renderer/editor/EditorPane'
import { createAiConversationStore } from '../../src/renderer/editor/use-ai-conversation'
import { activateWorkspaceAiSession } from '../../src/renderer/editor/workspace-ai-session-store'
import { useTranslationHistory } from '../../src/renderer/app/use-translation-history'
import type { TranslationHistoryRecord } from '../../src/renderer/editor/translation-history'

const REQUEST_ONE = '11111111-1111-4111-8111-111111111111'
const REQUEST_TWO = '22222222-2222-4222-8222-222222222222'
const STALE_REQUEST = '33333333-3333-4333-8333-333333333333'
const APP_STYLES = readFileSync(
  join(process.cwd(), 'src', 'renderer', 'app', 'styles.css'),
  'utf8',
)
const GENERIC_ERROR = '操作未能完成，请重试。'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, reject, resolve }
}

function settings(
  privacyNoticeAccepted: boolean,
  configured = false,
): LargeModelSettings {
  const connectionId = '11111111-1111-4111-8111-111111111111'
  return {
    version: 6,
    codexCli: null,
    connections: configured
      ? [{
          id: connectionId,
          name: 'Configured model',
          provider: 'deepseek',
          accessType: 'standard-api',
          protocol: 'openai',
          baseUrl: 'https://example.invalid',
          modelId: 'configured-model',
          apiKeyHint: '••••test',
          status: 'connected',
          lastTestedAt: null,
          capabilityOverride: null,
        }]
      : [],
    selectionTranslation: {
      connectionId: configured ? connectionId : null,
      privacyNoticeAccepted,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      targetLanguage: 'auto',
    },
    screenshotTranslation: {
      connectionId: null,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      targetLanguage: 'auto',
    },
    aiConversation: {
      connectionId: configured ? connectionId : null,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      writePolicy: 'ask-every-time',
    },
  }
}

function started(
  requestId = REQUEST_ONE,
): ApiResult<TranslationStarted> {
  return {
    ok: true,
    value: { requestId, targetLanguage: 'zh-CN', modelId: 'chat-model' },
  }
}

function apiFailure(
  message: string,
  code: PublicErrorCode = 'OPERATION_FAILED',
): ApiResult<never> {
  return { ok: false, error: { code, message } }
}

function installTranslationApi({
  accepted = true,
  configured = true,
  start = vi.fn(async () => started()),
}: {
  accepted?: boolean
  configured?: boolean
  start?: ReturnType<typeof vi.fn>
} = {}) {
  let eventHandler: ((event: TranslationEvent) => void) | null = null
  let aiEventHandler: ((event: AiConversationEvent) => void) | null = null
  const unsubscribe = vi.fn()
  const startAiConversation = vi.fn(async (input) => {
    const requestId = (input as typeof input & { requestId?: string }).requestId ?? REQUEST_ONE
    aiEventHandler?.({ requestId, type: 'started', transcriptRevision: 1 })
    aiEventHandler?.({
      requestId,
      type: 'user-message-accepted',
      messageId: input.messages[0]!.id,
      transcriptRevision: 1,
    })
    return {
      ok: true as const,
      value: { requestId, modelId: 'chat-model', transcriptRevision: 1 },
    }
  })
  const api = {
    acceptTranslationPrivacyNotice: vi.fn(async () => ({
      ok: true as const,
      value: settings(true, configured),
    })),
    cancelTranslation: vi.fn(async () => ({ ok: true as const, value: null })),
    getLargeModelSettings: vi.fn(async () => ({
      ok: true as const,
      value: settings(accepted, configured),
    })),
    onTranslationEvent: vi.fn((handler: (event: TranslationEvent) => void) => {
      eventHandler = handler
      return unsubscribe
    }),
    startTranslation: start,
    startAiConversation,
    cancelAiConversation: vi.fn(async () => ({ ok: true as const, value: null })),
    setAiConversationCapabilities: vi.fn(async () => ({ ok: true as const, value: null })),
    onAiConversationEvent: vi.fn((handler: (event: AiConversationEvent) => void) => {
      aiEventHandler = handler
      return vi.fn()
    }),
  } as unknown as ArkdownApi
  api.getModelSettingsSnapshot = vi.fn<ArkdownApi['getModelSettingsSnapshot']>(async () => {
    const result = await api.getLargeModelSettings()
    return result.ok ? { ok: true, value: modelObservation(result.value) } : result
  })
  Object.defineProperty(window, 'arkdown', {
    configurable: true,
    value: api,
  })
  return {
    api,
    emit(event: TranslationEvent) {
      act(() => eventHandler?.(event))
    },
    emitAi(event: AiConversationEvent) {
      act(() => aiEventHandler?.(event))
    },
    startAiConversation,
    unsubscribe,
  }
}

function selection(
  content: string,
  mode: 'visual' | 'source' = 'visual',
  top = 120,
): TranslationSelection {
  return {
    content: { markdown: content, plainText: content },
    mode,
    anchorRect: {
      bottom: top + 20,
      height: 20,
      left: 40,
      right: 160,
      top,
      width: 120,
    },
    focusRect: {
      bottom: top + 20,
      height: 20,
      left: 160,
      right: 160,
      top,
      width: 0,
    },
    releaseRect: {
      bottom: top + 20,
      height: 0,
      left: 180,
      right: 180,
      top: top + 20,
      width: 0,
    },
  }
}

function reportSelection(snapshot: TranslationSelection | null) {
  const callback = snapshot?.mode === 'source'
    ? editorBridge.source
    : editorBridge.visual
  act(() => callback?.(snapshot))
}

function toggleMode() {
  act(() => window.dispatchEvent(new CustomEvent('arkdown:editor-command', {
    detail: 'toggle-source-mode',
  })))
}

function renderPane(
  documentKey = 'note.md',
  onOpenLargeModelSettings: () => void = () => undefined,
  onChange: (markdown: string) => void = vi.fn(),
) {
  return render(
    <>
      <style>{APP_STYLES}</style>
      <div className="app-shell">
        <EditorPane modelPreferences={modelPreferences}
          documentKey={documentKey}
          markdown={'# Whole document\n\nDo not send this paragraph.'}
          onChange={onChange}
          onOpenLargeModelSettings={onOpenLargeModelSettings}
        />
      </div>
    </>,
  )
}

function finishRightSidebarExit() {
  const track = screen.getByTestId('editor-right-sidebar-motion-track')
  expect(track).toHaveAttribute('data-phase', 'closing')
  fireEvent.transitionEnd(track, { propertyName: 'width' })
}

function finishRightSidebarExitIfPresent() {
  if (screen.queryByTestId('editor-right-sidebar-motion-track')) {
    finishRightSidebarExit()
  }
}

function renderPaneWithHistory(editorPaneRef?: Ref<EditorPaneHandle>) {
  function Harness() {
    const translationHistory = useTranslationHistory({
      createId: (() => {
        let id = 0
        return () => `record-${++id}`
      })(),
      now: () => 100,
    })
    return <>
      <EditorPane modelPreferences={modelPreferences}
        ref={editorPaneRef}
        documentKey="C:/Notes/note.md"
        documentAbsolutePath="C:/Notes/note.md"
        markdown="# Whole document"
        onChange={vi.fn()}
        onOpenLargeModelSettings={() => undefined}
        translationHistory={translationHistory}
        translationHistoryRecords={translationHistory.records}
        translationHistoryIdentity={{
          workspaceAbsolutePath: 'C:/Notes',
          documentRelativePath: 'note.md',
          documentRevision: 'revision-a',
        }}
      />
      <output data-testid="translation-history-records">
        {JSON.stringify(translationHistory.records)}
      </output>
    </>
  }
  return render(<Harness />)
}

function historyRecords() {
  return JSON.parse(screen.getByTestId('translation-history-records').textContent ?? '[]') as Array<{
    id: string
    requestId: string
    terminal: string
    translatedMarkdown: string
    documentKey: string
    anchor: { status: string; from: number; to: number }
  }>
}

function historyRecord(
  id: string,
  translatedMarkdown: string,
  createdAt: number,
  documentKey = 'note.md',
): TranslationHistoryRecord {
  return {
    id,
    requestId: `request-${id}`,
    documentKey,
    workspaceAbsolutePath: null,
    documentRelativePath: null,
    documentAbsolutePath: null,
    documentRevision: null,
    mode: 'visual',
    source: { markdown: id, plainText: id },
    translatedMarkdown,
    modelId: 'chat-model',
    targetLanguage: 'zh-CN',
    terminal: 'completed',
    createdAt,
    anchor: {
      mode: 'visual',
      from: 1,
      to: 2,
      blockStart: 0,
      fingerprint: { before: '', selected: id, after: '' },
      status: 'valid',
    },
  }
}

describe('window translation history finalization', () => {
  it('keeps editing available while rules are pending and disables selection translation until ready', async () => {
    let resolve!: (value: { ok: true; value: { rules: null; bundledRevision: string; warning: null } }) => void
    const session = startModelRulesInitialization({ getModelCapabilityRules: () => new Promise(done => { resolve = done }) })
    const { api } = installTranslationApi()
    const onChange = vi.fn()
    try {
      renderPane('note.md', vi.fn(), onChange)
      act(() => editorBridge.visualChange?.('edited while rules load'))
      expect(onChange).toHaveBeenCalledWith('edited while rules load')
      reportSelection(selection('pending selection'))
      expect(screen.getByRole('button', { name: '翻译选中的文本' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
      expect(api.startTranslation).not.toHaveBeenCalled()
      await act(async () => { resolve({ ok: true, value: { rules: null, bundledRevision: '2026-09-12', warning: null } }); await session.ready })
      expect(api.startTranslation).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
      await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
    } finally { act(() => session.dispose()) }
  })
  it('shows and navigates only the active document history records', async () => {
    installTranslationApi()
    const records = [
      historyRecord('a-older', 'A older', 10, 'a.md'),
      historyRecord('b-only', 'B only', 15, 'b.md'),
      historyRecord('a-latest', 'A latest', 20, 'a.md'),
    ]
    const selectById = vi.fn(() => null)
    render(
      <EditorPane modelPreferences={modelPreferences}
        documentKey="a.md"
        markdown="# A"
        onChange={() => undefined}
        onOpenLargeModelSettings={() => undefined}
        translationHistory={{
          selectedRecordId: null,
          finalize: vi.fn(() => null),
          selectById,
          updateAnchor: vi.fn(),
        }}
        translationHistoryRecords={records}
        rightSidebarState={{ activeTab: 'translation', open: true }}
      />,
    )

    expect(screen.getByText('A latest')).toBeVisible()
    expect(screen.queryByText('B only')).not.toBeInTheDocument()
    expect(screen.getByText('2/2')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '上一条' }))
    expect(screen.getByText('A older')).toBeVisible()
    expect(screen.queryByText('B only')).not.toBeInTheDocument()
    expect(editorBridge.railCenterRequest).toEqual({ recordId: 'a-older', token: 1 })
  })

  it('shows no history when only other documents have records', () => {
    installTranslationApi()
    render(
      <EditorPane modelPreferences={modelPreferences}
        documentKey="b.md"
        markdown="# B"
        onChange={() => undefined}
        onOpenLargeModelSettings={() => undefined}
        translationHistoryRecords={[historyRecord('a-only', 'A only', 10, 'a.md')]}
        rightSidebarState={{ activeTab: 'translation', open: true }}
      />,
    )

    expect(screen.getByText('暂无翻译记录')).toBeVisible()
    expect(screen.queryByText('A only')).not.toBeInTheDocument()
  })

  it.each([
    ['latest current-document record even when an older record was selected', 'older', 'latest translation'],
    ['latest record when current is unavailable', 'outside-document', 'latest translation'],
  ])('opens the %s from a filtered record list', (_label, selectedRecordId, expected) => {
    installTranslationApi()
    const records = [
      historyRecord('older', 'older translation', 10),
      historyRecord('latest', 'latest translation', 20),
    ]
    const selectById = vi.fn(() => null)
    render(
      <EditorPane modelPreferences={modelPreferences}
        documentKey="note.md"
        markdown="# Note"
        onChange={() => undefined}
        onOpenLargeModelSettings={() => undefined}
        translationHistory={{
          selectedRecordId,
          finalize: vi.fn(() => null),
          selectById,
          updateAnchor: vi.fn(),
        }}
        translationHistoryRecords={records}
        rightSidebarState={{ activeTab: 'translation', open: true }}
      />,
    )

    expect(screen.getByText(expected)).toBeVisible()
    expect(selectById).toHaveBeenCalledWith('latest')
  })

  it('opens history from the sidebar without cancelling or clearing the live request and restores entry focus', async () => {
    const { api, emit } = installTranslationApi()
    renderPaneWithHistory()

    reportSelection(selection('first source'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
    emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'first result' })
    emit({ requestId: REQUEST_ONE, type: 'completed' })

    vi.mocked(api.startTranslation).mockResolvedValueOnce(started(REQUEST_TWO))
    reportSelection(selection('second source'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledTimes(2))
    emit({ requestId: REQUEST_TWO, type: 'delta', delta: 'still streaming' })

    const initiator = screen.getByRole('button', { name: '查看翻译记录' })
    const liveScroll = document.querySelector<HTMLElement>('.translation-sidebar-live-scroll')!
    const liveOutput = screen.getByText('still streaming').closest<HTMLElement>('.translation-output')!
    liveScroll.scrollTop = 23
    fireEvent.click(initiator)

    expect(screen.getByRole('region', { name: '翻译记录' })).toHaveFocus()
    expect(liveScroll).not.toBeVisible()
    expect(liveScroll).toContainElement(liveOutput)
    expect(liveScroll.scrollTop).toBe(23)
    expect(screen.getByText('first result')).toBeVisible()
    expect(api.cancelTranslation).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '停止翻译' })).toBeVisible()

    emit({ requestId: REQUEST_TWO, type: 'delta', delta: ' grows' })
    fireEvent.click(screen.getByRole('button', { name: '返回当前翻译' }))

    await waitFor(() => expect(initiator).toHaveFocus())
    expect(screen.getByText('still streaming grows').closest('.translation-output')).toBe(liveOutput)
    expect(liveScroll.scrollTop).toBe(23)
    expect(screen.getByText('still streaming grows')).toBeVisible()
    expect(api.cancelTranslation).not.toHaveBeenCalled()
  })

  it('captures before trusted start, binds its result, and promotes the mapped anchor exactly once at terminal', async () => {
    const pendingStart = deferred<ApiResult<TranslationStarted>>()
    const { api, emit } = installTranslationApi({
      start: vi.fn(() => pendingStart.promise),
    })
    renderPaneWithHistory()
    reportSelection(selection('source'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))

    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
    expect(historyEditorHandle.capturePendingTranslationAnchor).toHaveBeenCalledOnce()
    expect(historyEditorHandle.capturePendingTranslationAnchor.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(api.startTranslation).mock.invocationCallOrder[0])
    expect(historyEditorHandle.promotePendingTranslationAnchor).not.toHaveBeenCalled()

    act(() => pendingStart.resolve(started()))
    await waitFor(() => expect(historyEditorHandle.bindPendingTranslationAnchor).toHaveBeenCalledWith(
      historyEditorHandle.capturePendingTranslationAnchor.mock.calls[0][0],
      REQUEST_ONE,
    ))
    expect(historyEditorHandle.promotePendingTranslationAnchor).not.toHaveBeenCalled()

    emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'translated' })
    emit({ requestId: REQUEST_ONE, type: 'completed' })
    emit({ requestId: REQUEST_ONE, type: 'completed' })

    expect(historyEditorHandle.promotePendingTranslationAnchor).toHaveBeenCalledOnce()
    expect(historyEditorHandle.promotePendingTranslationAnchor).toHaveBeenCalledWith(REQUEST_ONE)
    expect(historyRecords()).toEqual([expect.objectContaining({
      anchor: expect.objectContaining({ from: 4, to: 10 }),
      modelId: 'chat-model',
      targetLanguage: 'zh-CN',
      source: { markdown: 'source', plainText: 'source' },
    })])
  })

  it.each([
    ['capture misses the source', false],
    ['promotion loses the mapped source', true],
    ['promotion is ambiguous for a duplicate request id', true],
  ])('stores an unrevealable changed-location anchor when %s', async (_reason, captured) => {
    const editorPaneRef = createRef<EditorPaneHandle>()
    historyEditorHandle.capturePendingTranslationAnchor.mockReturnValue(captured)
    historyEditorHandle.promotePendingTranslationAnchor.mockReturnValue(null)
    const { api, emit } = installTranslationApi()
    renderPaneWithHistory(editorPaneRef)
    reportSelection(selection('unmapped source'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
    emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'translation kept' })
    emit({ requestId: REQUEST_ONE, type: 'completed' })

    const [record] = historyRecords()
    expect(record).toEqual(expect.objectContaining({
      translatedMarkdown: 'translation kept',
      anchor: expect.objectContaining({ status: 'location-changed' }),
    }))
    let revealed = true
    act(() => {
      revealed = editorPaneRef.current?.revealTranslationHistoryRecord(record.id) ?? true
    })
    expect(revealed).toBe(false)
    expect(historyEditorHandle.revealTranslationHistoryRecord).not.toHaveBeenCalled()
    expect(screen.getByText('原文位置已变化')).toBeVisible()
  })

  it('restores focus to the same retained Sidebar history entry', async () => {
    const { api, emit } = installTranslationApi()
    renderPaneWithHistory()
    reportSelection(selection('first source'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
    emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'first result' })
    emit({ requestId: REQUEST_ONE, type: 'completed' })

    vi.mocked(api.startTranslation).mockResolvedValueOnce(started(REQUEST_TWO))
    reportSelection(selection('s'.repeat(100)))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledTimes(2))
    const initiator = screen.getByRole('button', { name: '查看翻译记录' })
    fireEvent.click(initiator)
    expect(screen.getByRole('region', { name: '翻译记录' })).toHaveFocus()
    expect(screen.queryByRole('button', { name: '查看翻译记录' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '返回当前翻译' }))

    expect(screen.getByRole('button', { name: '查看翻译记录' })).toBe(initiator)
    expect(initiator).toHaveFocus()
  })

  it('does not restore focus to an initiator that is no longer keyboard-focusable', async () => {
    const { api, emit } = installTranslationApi()
    renderPaneWithHistory()
    reportSelection(selection('source'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
    emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'result' })
    emit({ requestId: REQUEST_ONE, type: 'completed' })

    vi.mocked(api.startTranslation).mockResolvedValueOnce(started(REQUEST_TWO))
    reportSelection(selection('s'.repeat(100)))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledTimes(2))
    const initiator = screen.getByRole('button', { name: '查看翻译记录' })
    fireEvent.click(initiator)
    initiator.tabIndex = -1
    fireEvent.click(screen.getByRole('button', { name: '返回当前翻译' }))

    expect(initiator).not.toHaveFocus()
  })

  it('restores focus to the editor after closing history from inside the sidebar', async () => {
    const { api, emit } = installTranslationApi()
    renderPaneWithHistory()
    reportSelection(selection('source'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
    emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'result' })
    emit({ requestId: REQUEST_ONE, type: 'completed' })
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    const marker = screen.getByRole('button', { name: '编辑器翻译记录标记' })
    marker.focus()

    fireEvent.click(marker)
    expect(screen.getByRole('region', { name: '翻译记录' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: '关闭翻译记录' }))

    finishRightSidebarExit()
    expect(screen.getByTestId('visual-editor')).toHaveFocus()
  })

  it('lets a history-only sidebar own Escape before fullscreen and restores editor focus after exit', async () => {
    const { api, emit } = installTranslationApi()
    renderPaneWithHistory()
    reportSelection(selection('source'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
    emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'result' })
    emit({ requestId: REQUEST_ONE, type: 'completed' })
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    const marker = screen.getByRole('button', { name: '编辑器翻译记录标记' })
    marker.focus()
    fireEvent.click(marker)
    expect(screen.getByRole('region', { name: '翻译记录' })).toHaveFocus()
    const editor = screen.getByTestId('visual-editor')

    const fullscreenExit = vi.fn()
    const onLowerEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) fullscreenExit()
    }
    window.addEventListener('keydown', onLowerEscape)
    try {
      expect(fireEvent.keyDown(window, { key: 'Escape' })).toBe(false)
      expect(screen.getByRole('complementary', { name: '右侧栏' })).toBeInTheDocument()
      finishRightSidebarExit()
      expect(screen.queryByRole('complementary', { name: '右侧栏' })).not.toBeInTheDocument()
      await waitFor(() => expect(editor).toHaveFocus())
      expect(fullscreenExit).not.toHaveBeenCalled()

      fireEvent.keyDown(window, { key: 'Escape' })
      expect(fullscreenExit).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('keydown', onLowerEscape)
    }
  })

  it('gives document find the first Escape before initial history, then restores editor focus', async () => {
    installTranslationApi()
    const record = historyRecord('initial-history', 'translated', 10)
    render(
      <EditorPane modelPreferences={modelPreferences}
        documentKey="note.md"
        initialTranslationHistoryRecordId={record.id}
        markdown="# Note"
        onChange={() => undefined}
        onOpenLargeModelSettings={() => undefined}
        translationHistory={{
          selectedRecordId: record.id,
          finalize: vi.fn(() => null),
          selectById: vi.fn(() => record),
          updateAnchor: vi.fn(),
        }}
        translationHistoryRecords={[record]}
      />,
    )
    const editor = screen.getByTestId('visual-editor')
    expect(document.querySelector('.editor-right-sidebar')).not.toBeNull()

    act(() => window.dispatchEvent(new CustomEvent('arkdown:editor-command', {
      detail: 'find-in-document',
    })))
    expect(document.querySelector('.document-find-bar')).not.toBeNull()
    expect(document.querySelector('.editor-right-sidebar')).not.toBeNull()

    expect(fireEvent.keyDown(window, { key: 'Escape' })).toBe(false)
    expect(document.querySelector('.document-find-bar')).toBeNull()
    expect(document.querySelector('.editor-right-sidebar')).not.toBeNull()

    expect(fireEvent.keyDown(window, { key: 'Escape' })).toBe(false)
    expect(document.querySelector('.editor-right-sidebar')).not.toBeNull()
    finishRightSidebarExit()
    expect(document.querySelector('.editor-right-sidebar')).toBeNull()
    await waitFor(() => expect(editor).toHaveFocus())
  })

  it.each([
    ['modal', 'aria-modal', 'true'],
    ['menu', 'role', 'menu'],
  ])('leaves history Escape to a visible %s owner', (_label, attribute, value) => {
    installTranslationApi()
    const record = historyRecord('blocked-history', 'translated', 10)
    render(
      <EditorPane modelPreferences={modelPreferences}
        documentKey="note.md"
        initialTranslationHistoryRecordId={record.id}
        markdown="# Note"
        onChange={() => undefined}
        onOpenLargeModelSettings={() => undefined}
        translationHistoryRecords={[record]}
      />,
    )
    const blocker = document.createElement('div')
    blocker.setAttribute(attribute, value)
    document.body.append(blocker)
    try {
      expect(fireEvent.keyDown(window, { key: 'Escape' })).toBe(true)
      expect(document.querySelector('.editor-right-sidebar')).not.toBeNull()
    } finally {
      blocker.remove()
    }
    expect(fireEvent.keyDown(window, { key: 'Escape' })).toBe(false)
    expect(document.querySelector('.editor-right-sidebar')).not.toBeNull()
    finishRightSidebarExit()
    expect(document.querySelector('.editor-right-sidebar')).toBeNull()
  })

  it.each([
    ['empty stop', { requestId: REQUEST_ONE, type: 'stopped' as const }],
    ['empty timeout', {
      requestId: REQUEST_ONE,
      type: 'failed' as const,
      code: 'MODEL_TIMEOUT' as const,
      message: '大模型请求超时',
    }],
    ['ordinary failure', {
      requestId: REQUEST_ONE,
      type: 'failed' as const,
      code: 'OPERATION_FAILED' as const,
      message: '操作未能完成',
    }],
  ])('discards the bound pending anchor for %s', async (_label, terminal) => {
    const { api, emit } = installTranslationApi()
    renderPaneWithHistory()
    reportSelection(selection('source'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())

    emit(terminal)

    expect(historyEditorHandle.discardPendingTranslationAnchor).toHaveBeenCalledWith(REQUEST_ONE)
    expect(historyEditorHandle.promotePendingTranslationAnchor).not.toHaveBeenCalled()
    expect(historyRecords()).toEqual([])
  })

  it('promotes without later discarding the same anchor on UI stop with output', async () => {
    const { api, emit } = installTranslationApi()
    renderPaneWithHistory()
    reportSelection(selection('source'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(historyEditorHandle.bindPendingTranslationAnchor)
      .toHaveBeenCalledWith(expect.any(String), REQUEST_ONE))
    emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'partial' })

    fireEvent.click(screen.getByRole('button', { name: '停止翻译' }))

    expect(historyEditorHandle.promotePendingTranslationAnchor).toHaveBeenCalledOnce()
    expect(historyEditorHandle.discardPendingTranslationAnchor.mock.calls)
      .not.toContainEqual([REQUEST_ONE])
    expect(api.cancelTranslation).toHaveBeenCalledWith(REQUEST_ONE)
  })

  it('discards the bound anchor exactly once on UI stop without output', async () => {
    installTranslationApi()
    renderPaneWithHistory()
    reportSelection(selection('source'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(historyEditorHandle.bindPendingTranslationAnchor)
      .toHaveBeenCalledWith(expect.any(String), REQUEST_ONE))

    fireEvent.click(screen.getByRole('button', { name: '停止翻译' }))

    expect(historyEditorHandle.discardPendingTranslationAnchor.mock.calls
      .filter(([key]) => key === REQUEST_ONE)).toHaveLength(1)
    expect(historyEditorHandle.promotePendingTranslationAnchor).not.toHaveBeenCalled()
  })

  it('discards the sole pending key when explicit UI cleanup invalidates a start', async () => {
    const pendingStart = deferred<ApiResult<TranslationStarted>>()
    const { api } = installTranslationApi({ start: vi.fn(() => pendingStart.promise) })
    renderPaneWithHistory()
    reportSelection(selection('source'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(historyEditorHandle.capturePendingTranslationAnchor).toHaveBeenCalledOnce())
    const pendingKey = historyEditorHandle.capturePendingTranslationAnchor.mock.calls[0][0]

    fireEvent.keyDown(window, { key: 'Escape' })
    act(() => pendingStart.resolve(started()))

    await waitFor(() => expect(api.cancelTranslation).toHaveBeenCalledWith(REQUEST_ONE))
    expect(historyEditorHandle.discardPendingTranslationAnchor.mock.calls
      .filter(([key]) => key === pendingKey)).toHaveLength(1)
    expect(historyEditorHandle.capturePendingTranslationAnchor).toHaveBeenCalledOnce()
  })

  it.each([
    ['completed', { requestId: REQUEST_ONE, type: 'completed' as const }],
    ['stopped', { requestId: REQUEST_ONE, type: 'stopped' as const }],
    ['timeout-partial', {
      requestId: REQUEST_ONE,
      type: 'failed' as const,
      code: 'MODEL_TIMEOUT' as const,
      message: '大模型请求超时',
    }],
  ])('replays a buffered delta before %s history finalization', async (terminal, event) => {
    const pendingStart = deferred<ApiResult<TranslationStarted>>()
    const { api, emit } = installTranslationApi({
      start: vi.fn(() => pendingStart.promise),
    })
    renderPaneWithHistory()
    reportSelection(selection(`buffered ${terminal}`))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())

    emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'complete buffered output' })
    emit(event)
    act(() => pendingStart.resolve(started()))

    await waitFor(() => expect(historyRecords()).toEqual([expect.objectContaining({
      requestId: REQUEST_ONE,
      terminal,
      translatedMarkdown: 'complete buffered output',
    })]))
  })

  it('finalizes completed, stopped-with-output, and timeout-with-output requests once each', async () => {
    const { api, emit } = installTranslationApi()
    renderPaneWithHistory()

    reportSelection(selection('completed source'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
    emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'completed output' })
    emit({ requestId: REQUEST_ONE, type: 'completed' })
    emit({ requestId: REQUEST_ONE, type: 'completed' })
    expect(historyRecords()).toEqual([expect.objectContaining({
      requestId: REQUEST_ONE,
      terminal: 'completed',
      translatedMarkdown: 'completed output',
      documentKey: 'C:/Notes/note.md',
    })])

    vi.mocked(api.startTranslation).mockResolvedValueOnce(started(REQUEST_TWO))
    reportSelection(selection('stopped source'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledTimes(2))
    emit({ requestId: REQUEST_TWO, type: 'delta', delta: 'stopped output' })
    emit({ requestId: REQUEST_TWO, type: 'stopped' })

    vi.mocked(api.startTranslation).mockResolvedValueOnce(started(STALE_REQUEST))
    reportSelection(selection('timeout source'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledTimes(3))
    emit({ requestId: STALE_REQUEST, type: 'delta', delta: 'partial output' })
    emit({
      requestId: STALE_REQUEST,
      type: 'failed',
      code: 'MODEL_TIMEOUT',
      message: '大模型请求超时',
    })

    expect(historyRecords().map(({ terminal, translatedMarkdown }) => ({
      terminal,
      translatedMarkdown,
    }))).toEqual([
      { terminal: 'completed', translatedMarkdown: 'completed output' },
      { terminal: 'stopped', translatedMarkdown: 'stopped output' },
      { terminal: 'timeout-partial', translatedMarkdown: 'partial output' },
    ])
    expect(historyEditorHandle.promotePendingTranslationAnchor.mock.calls.map(([requestId]) => requestId))
      .toEqual([REQUEST_ONE, REQUEST_TWO, STALE_REQUEST])
  })

  it('does not finalize empty stops, empty timeouts, or ordinary failures', async () => {
    const { api, emit } = installTranslationApi()
    renderPaneWithHistory()

    reportSelection(selection('empty stop'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
    emit({ requestId: REQUEST_ONE, type: 'stopped' })

    vi.mocked(api.startTranslation).mockResolvedValueOnce(started(REQUEST_TWO))
    reportSelection(selection('empty timeout'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledTimes(2))
    emit({ requestId: REQUEST_TWO, type: 'failed', code: 'MODEL_TIMEOUT', message: '大模型请求超时' })

    vi.mocked(api.startTranslation).mockResolvedValueOnce(started(STALE_REQUEST))
    reportSelection(selection('ordinary failure'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledTimes(3))
    emit({ requestId: STALE_REQUEST, type: 'delta', delta: 'must not persist' })
    emit({ requestId: STALE_REQUEST, type: 'failed', code: 'OPERATION_FAILED', message: '操作未能完成' })

    expect(historyRecords()).toEqual([])
  })

  it('does not finalize an unconfigured translation attempt', async () => {
    const start = vi.fn(async () => apiFailure('未配置模型', 'MODEL_NOT_CONFIGURED'))
    const { api } = installTranslationApi({ accepted: true, start })
    renderPaneWithHistory()
    reportSelection(selection('unconfigured'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await screen.findByRole('alert')
    expect(historyRecords()).toEqual([])
    expect(historyEditorHandle.capturePendingTranslationAnchor).toHaveBeenCalledOnce()
    expect(historyEditorHandle.discardPendingTranslationAnchor).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(historyEditorHandle.discardPendingTranslationAnchor).toHaveBeenCalledWith(
      historyEditorHandle.capturePendingTranslationAnchor.mock.calls[0][0],
    )

  })

  it('closes a controlled empty right sidebar on Escape before fullscreen', () => {
    installTranslationApi()
    const onCloseRightSidebar = vi.fn()
    function Harness() {
      const [rightSidebarState, setRightSidebarState] = useState({
        open: true,
        activeTab: 'translation' as 'translation' | 'ai-chat' | 'document-view',
      })
      return <EditorPane modelPreferences={modelPreferences}
        documentKey="note.md"
        markdown="# Note"
        onChange={() => undefined}
        onCloseRightSidebar={() => {
          onCloseRightSidebar()
          setRightSidebarState((current) => ({ ...current, open: false }))
        }}
        onOpenLargeModelSettings={() => undefined}
        rightSidebarState={rightSidebarState}
      />
    }
    render(<Harness />)
    const fullscreenExit = vi.fn()
    const onLowerEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) fullscreenExit()
    }
    window.addEventListener('keydown', onLowerEscape)
    try {
      expect(fireEvent.keyDown(window, { key: 'Escape' })).toBe(false)
      expect(screen.getByRole('complementary', { name: '右侧栏' })).toBeInTheDocument()
      finishRightSidebarExit()
      expect(screen.queryByRole('complementary', { name: '右侧栏' })).not.toBeInTheDocument()
      expect(onCloseRightSidebar).toHaveBeenCalledOnce()
      expect(fullscreenExit).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', onLowerEscape)
    }
  })

  it('keeps a controlled history sidebar mounted through exit and restores internal focus to the editor', () => {
    installTranslationApi()
    const record = historyRecord('controlled-history', 'translated', 10)
    const onCloseRightSidebar = vi.fn()
    function Harness() {
      const [rightSidebarState, setRightSidebarState] = useState({
        open: true,
        activeTab: 'translation' as 'translation' | 'ai-chat' | 'document-view',
      })
      return <EditorPane modelPreferences={modelPreferences}
        documentKey="note.md"
        initialTranslationHistoryRecordId={record.id}
        markdown="# Note"
        onChange={() => undefined}
        onCloseRightSidebar={() => {
          onCloseRightSidebar()
          setRightSidebarState((current) => ({ ...current, open: false }))
        }}
        onOpenLargeModelSettings={() => undefined}
        rightSidebarState={rightSidebarState}
        translationHistoryRecords={[record]}
      />
    }
    render(<Harness />)

    const editor = screen.getByTestId('visual-editor')
    const close = screen.getByRole('button', { name: '关闭翻译记录' })
    close.focus()
    fireEvent.click(close)

    expect(screen.getByRole('complementary', { name: '右侧栏' })).toBeInTheDocument()
    expect(close).toHaveFocus()
    finishRightSidebarExit()
    expect(screen.queryByRole('complementary', { name: '右侧栏' })).not.toBeInTheDocument()
    expect(editor).toHaveFocus()
    expect(onCloseRightSidebar).toHaveBeenCalledOnce()
  })

  it('closes a controlled live translation sidebar on Escape', async () => {
    installTranslationApi()
    const onCloseRightSidebar = vi.fn()
    function Harness() {
      const [rightSidebarState, setRightSidebarState] = useState({
        open: false,
        activeTab: 'translation' as 'translation' | 'ai-chat' | 'document-view',
      })
      return <EditorPane modelPreferences={modelPreferences}
        documentKey="note.md"
        markdown="# Note"
        onChange={() => undefined}
        onCloseRightSidebar={() => {
          onCloseRightSidebar()
          setRightSidebarState((current) => ({ ...current, open: false }))
        }}
        onOpenLargeModelSettings={() => undefined}
        onOpenRightSidebar={(activeTab) => setRightSidebarState({ open: true, activeTab })}
        rightSidebarState={rightSidebarState}
      />
    }
    render(<Harness />)
    reportSelection(selection('x'.repeat(100)))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await screen.findByRole('complementary', { name: '右侧栏' })

    expect(fireEvent.keyDown(window, { key: 'Escape' })).toBe(false)

    expect(screen.getByRole('complementary', { name: '右侧栏' })).toBeInTheDocument()
    finishRightSidebarExit()
    expect(screen.queryByRole('complementary', { name: '右侧栏' })).not.toBeInTheDocument()
    expect(onCloseRightSidebar).toHaveBeenCalledOnce()
  })
})

function translationUiErrorCode(): string | null | undefined {
  return (JSON.parse(screen.getByTestId('translation-ui-state').textContent ?? '{}') as {
    errorCode?: string | null
  }).errorCode
}

const staleCodeClearingEvents = [
  ['completed', { type: 'completed' }],
  ['stopped', { type: 'stopped' }],
] as const satisfies readonly [string, TranslationUiStateEvent][]

it.each(staleCodeClearingEvents)(
  'clears a stale public code for the %s reducer event',
  (_transition, event) => {
    const staleState: TranslationUiState = {
      requestId: REQUEST_ONE,
      status: 'failed',
      output: 'partial output',
      errorCode: 'MODEL_NOT_CONFIGURED',
      error: '尚未配置划词翻译使用的大模型',
    }

    expect(reduceTranslationUiState(staleState, event).errorCode).toBeNull()
  },
)

class TestResizeObserver {
  static instances: TestResizeObserver[] = []
  readonly disconnect = vi.fn()
  readonly observe = vi.fn()
  readonly unobserve = vi.fn()

  constructor(readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this)
  }

  emit() {
    this.callback([], this as unknown as ResizeObserver)
  }
}

beforeEach(() => {
  modelPreferences = new ModelPreferenceDraft(createPreferencePersistence())
  editorBridge.source = null
  editorBridge.visual = null
  editorBridge.sourceAnchor = null
  editorBridge.visualAnchor = null
  editorBridge.sourceRefreshKey = undefined
  editorBridge.visualRefreshKey = undefined
  editorBridge.sourceHistoryReady = null
  editorBridge.visualHistoryReady = null
  editorBridge.railCenterRequest = null
  editorBridge.visualFlushMarkdown = null
  editorBridge.visualFlushEmitsChange = false
  historyEditorHandle.revealTranslationHistoryRecord.mockClear().mockReturnValue(true)
  historyEditorHandle.flushTranslationHistoryAnchors.mockClear().mockReturnValue([])
  historyEditorHandle.capturePendingTranslationAnchor.mockClear().mockReturnValue(true)
  historyEditorHandle.bindPendingTranslationAnchor.mockClear()
  historyEditorHandle.promotePendingTranslationAnchor.mockClear().mockReturnValue({
    mode: 'visual',
    from: 4,
    to: 10,
    blockStart: 1,
    fingerprint: { before: 'a', selected: 'source', after: 'b' },
    status: 'valid',
  })
  historyEditorHandle.discardPendingTranslationAnchor.mockClear()
  TestResizeObserver.instances = []
  vi.restoreAllMocks()
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: TestResizeObserver,
  })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  })
})

it('maps the default system theme through EditorPane into VisualEditor', () => {
  installTranslationApi()
  renderPane()

  expect(screen.getByRole('region', { name: 'Markdown editor' }))
    .toHaveAttribute('data-editor-theme', 'system')
  expect(editorBridge.visualTheme).toBe('system')
})

it('forwards history ready only from the currently mounted editor mode', () => {
  installTranslationApi()
  const ready = vi.fn()
  render(
    <EditorPane modelPreferences={modelPreferences}
      documentKey="doc-ready"
      markdown="# Ready"
      onChange={vi.fn()}
      onOpenLargeModelSettings={vi.fn()}
      onTranslationHistoryReady={ready}
    />,
  )
  const staleVisualReady = editorBridge.visualHistoryReady!
  act(() => staleVisualReady('doc-ready'))
  expect(ready).toHaveBeenLastCalledWith('doc-ready', 'visual')

  act(() => window.dispatchEvent(new CustomEvent('arkdown:editor-command', {
    detail: 'toggle-source-mode',
  })))
  expect(editorBridge.sourceHistoryReady).not.toBeNull()
  act(() => editorBridge.sourceHistoryReady?.('doc-ready'))
  expect(ready).toHaveBeenLastCalledWith('doc-ready', 'source')
  expect(ready).toHaveBeenCalledTimes(2)

  act(() => staleVisualReady('doc-ready'))
  expect(ready).toHaveBeenCalledTimes(2)
})

describe('selection and presentation routing', () => {
  it.each(['visual', 'source'] as const)('freezes %s selection into the AI draft before sidebar focus without sending', async (mode) => {
    const { startAiConversation } = installTranslationApi({ configured: true })
    function Harness() {
      const [sidebar, setSidebar] = useState<{ open: boolean; activeTab: 'ai-chat' | 'translation' | 'document-view' }>({
        open: false, activeTab: 'translation',
      })
      return <EditorPane modelPreferences={modelPreferences} documentKey="C:/private/A.md" markdown="# document A" onChange={vi.fn()}
        onOpenLargeModelSettings={() => undefined} rightSidebarState={sidebar}
        onOpenRightSidebar={(activeTab) => setSidebar({ open: true, activeTab })} />
    }
    render(<Harness />)
    if (mode === 'source') toggleMode()
    reportSelection({ ...selection('frozen quotation', mode), range: { from: 2, to: 18 } })
    fireEvent.click(screen.getByRole('button', { name: '引用到 AI 对话' }))
    const composer = await screen.findByRole('textbox', { name: '发送消息给 AI' })
    expect(composer).toHaveValue('结合上下文分析文本片段')
    await waitFor(() => expect(composer).toHaveFocus())
    expect(screen.getByRole('button', { name: '预览引用：A.md · 片段 1' })).toBeVisible()
    expect(startAiConversation).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(startAiConversation).toHaveBeenCalledOnce())
    const sent = startAiConversation.mock.calls[0]![0]
    expect(sent.messages[0].content).toContain('frozen quotation')
    expect(sent.messages[0].content).not.toContain('C:/private')
    expect(sent.expectedDocumentId).toMatch(/^[0-9a-f-]{36}$/u)
  })
  it('refreshes and replaces only an open popover anchor when editor zoom changes', () => {
    installTranslationApi()
    const mounted = renderPane()
    reportSelection(selection('anchored', 'visual', 120))
    const popover = screen.getByRole('dialog', { name: '划词翻译' })
    const initialTop = popover.style.top

    mounted.rerender(
      <>
        <style>{APP_STYLES}</style>
        <div className="app-shell">
          <EditorPane modelPreferences={modelPreferences}
            documentKey="note.md"
            markdown={'# Whole document\n\nDo not send this paragraph.'}
            zoomPercent={200}
            onChange={vi.fn()}
            onOpenLargeModelSettings={() => undefined}
          />
        </div>
      </>,
    )

    expect(editorBridge.visualRefreshKey).toBe('200:0')
    act(() => editorBridge.visualAnchor?.({
      anchorRect: {
        left: 80,
        top: 260,
        right: 260,
        bottom: 300,
        width: 180,
        height: 40,
      },
      focusRect: {
        left: 260,
        top: 280,
        right: 260,
        bottom: 300,
        width: 0,
        height: 20,
      },
    }))
    expect(popover.style.top).not.toBe(initialTop)
    // The text capsule keeps its anchor while applying the approved 10 CSS px offset.
    expect(popover.style.top).toBe('298px')
    expect(screen.getByRole('button', { name: '翻译选中的文本' })).toHaveClass(
      'translation-popover-trigger',
    )
    expect(document.querySelector('.translation-popover')?.parentElement).toHaveClass('editor-pane')
  })

  it('remeasures the active endpoint after sidebar width changes', async () => {
    installTranslationApi()
    let surfaceWidth = 1_000
    render(
      <EditorPane modelPreferences={modelPreferences}
        documentKey="note.md"
        markdown="# Note"
        onChange={() => undefined}
        onOpenLargeModelSettings={() => undefined}
        rightSidebarState={{ activeTab: 'translation', open: true }}
      />,
    )
    const pane = document.querySelector<HTMLElement>('.editor-pane')!
    const surface = document.querySelector<HTMLElement>('.editor-surface')!
    vi.spyOn(pane, 'getBoundingClientRect').mockImplementation(() => ({
      bottom: 500,
      height: 500,
      left: 0,
      right: 1_000,
      top: 0,
      width: 1_000,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }))
    vi.spyOn(surface, 'getBoundingClientRect').mockImplementation(() => ({
      bottom: 500,
      height: 500,
      left: 0,
      right: surfaceWidth,
      top: 0,
      width: surfaceWidth,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }))
    Object.defineProperty(surface, 'clientHeight', { configurable: true, value: 500 })

    reportSelection(selection('wrapped selection', 'visual', 120))
    await waitFor(() => expect(TestResizeObserver.instances.some((observer) => (
      observer.observe.mock.calls.some(([target]) => target === pane)
    ))).toBe(true))
    act(() => TestResizeObserver.instances.forEach((observer) => observer.emit()))
    await waitFor(() => expect(editorBridge.visualRefreshKey).toBe('100:1000'))

    surfaceWidth = 700
    act(() => TestResizeObserver.instances.forEach((observer) => observer.emit()))
    await waitFor(() => expect(editorBridge.visualRefreshKey).toBe('100:700'))

    act(() => editorBridge.visualAnchor?.({
      anchorRect: selection('wrapped selection', 'visual', 120).anchorRect,
      focusRect: {
        bottom: 320,
        height: 20,
        left: 120,
        right: 120,
        top: 300,
        width: 0,
      },
    }))

    expect(screen.getByTestId('translation-sidebar-result')).toHaveStyle({ marginTop: '252px' })
  })

  it('opens a ready visual popover and replaces its unstarted selection', async () => {
    const { api } = installTranslationApi()
    renderPane()

    reportSelection(selection('first'))
    expect(screen.getByRole('dialog', { name: '划词翻译' })).toBeVisible()
    expect(screen.getByRole('button', { name: '翻译选中的文本' })).toHaveClass(
      'translation-popover-trigger',
    )

    reportSelection(selection('second'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))

    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
    expect(screen.queryByRole('dialog', { name: '划词翻译' })).not.toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: '右侧栏' })).toBeVisible()
    expect(api.startTranslation).toHaveBeenCalledWith({
      documentKey: 'note.md',
      content: { markdown: 'second', plainText: 'second' },
      mode: 'visual',
    })
  })

  it('labels a document-wide shortcut action and starts it through the existing translation path', async () => {
    const { api } = installTranslationApi()
    renderPane()
    const documentSelection = {
      ...selection('# Whole document', 'visual', 180),
      scope: 'document',
    } as TranslationSelection

    reportSelection(documentSelection)

    const translate = screen.getByRole('button', { name: '全文翻译' })
    expect(translate).toHaveTextContent('全文翻译')
    expect(translate).toHaveClass('translation-popover-trigger--document')
    fireEvent.click(translate)

    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
    expect(api.startTranslation).toHaveBeenCalledWith({
      documentKey: 'note.md',
      content: { markdown: '# Whole document', plainText: '# Whole document' },
      mode: 'visual',
    })
  })

  it('lets the translation popover consume Escape', () => {
    installTranslationApi()
    renderPane()
    reportSelection(selection('selected words'))
    expect(screen.getByRole('dialog', { name: '划词翻译' })).toBeVisible()

    const dispatched = fireEvent.keyDown(window, { key: 'Escape' })

    expect(dispatched).toBe(false)
    expect(screen.queryByRole('dialog', { name: '划词翻译' })).not.toBeInTheDocument()
  })

  it('lets the translation sidebar consume Escape', async () => {
    installTranslationApi()
    renderPane()
    reportSelection(selection('a'.repeat(100)))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    expect(await screen.findByRole('complementary', { name: '右侧栏' })).toBeVisible()

    const dispatched = fireEvent.keyDown(window, { key: 'Escape' })

    expect(dispatched).toBe(false)
    expect(screen.getByRole('complementary', { name: '右侧栏' })).toBeInTheDocument()
    finishRightSidebarExit()
    expect(screen.queryByRole('complementary', { name: '右侧栏' })).not.toBeInTheDocument()
  })

  it('rejects a snapshot from the inactive editor mode', () => {
    installTranslationApi()
    renderPane()

    act(() => editorBridge.visual?.(selection('wrong mode', 'source')))

    expect(screen.queryByRole('dialog', { name: '划词翻译' })).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: '右侧栏' })).not.toBeInTheDocument()
  })

  it.each([
    { label: '99 visible characters', content: 'a'.repeat(99) },
    { label: '100 visible characters', content: 'a'.repeat(100) },
    { label: 'a real newline', content: 'first\nsecond' },
  ])('routes visual $label to the sidebar after the trigger', async ({ content }) => {
    installTranslationApi()
    renderPane()
    reportSelection(selection(content))

    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))

    await waitFor(() => expect(screen.getByRole('complementary', { name: '右侧栏' })).toBeVisible())
    expect(screen.queryByRole('dialog', { name: '划词翻译' })).not.toBeInTheDocument()
  })

  it('always routes source selections to the sidebar', async () => {
    installTranslationApi()
    renderPane()
    toggleMode()
    reportSelection(selection('short', 'source'))

    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))

    await waitFor(() => expect(screen.getByRole('complementary', { name: '右侧栏' })).toBeVisible())
  })
})

describe('request start', () => {
  it('starts first-use translation directly without a privacy gate', async () => {
    const { api } = installTranslationApi({ accepted: false })
    renderPane()
    reportSelection(selection('direct selection'))

    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))

    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
    expect(api.getLargeModelSettings).toHaveBeenCalledTimes(2)
    expect(api.acceptTranslationPrivacyNotice).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: '划词翻译隐私提示' })).not.toBeInTheDocument()
  })

  it('sends an exact payload containing only the selected source slice', async () => {
    const { api } = installTranslationApi()
    renderPane()
    toggleMode()
    const selectedMarkdown = '[selected](https://example.com) `code`'
    reportSelection(selection(selectedMarkdown, 'source'))

    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))

    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
    const payload = vi.mocked(api.startTranslation).mock.calls[0][0]
    expect(payload).toEqual({
      documentKey: 'note.md',
      content: { markdown: selectedMarkdown, plainText: selectedMarkdown },
      mode: 'source',
    })
    expect(Object.keys(payload)).toEqual(['documentKey', 'content', 'mode'])
    expect(JSON.stringify(payload)).not.toContain('Do not send this paragraph.')
  })
})

describe('stream ordering and cancellation races', () => {
  it('renders a completed stream after the reducer transition', async () => {
    const { api, emit } = installTranslationApi()
    renderPane()
    reportSelection(selection('selected'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())

    emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'translated' })
    expect(screen.getByRole('button', { name: '停止翻译' })).toBeVisible()
    emit({ requestId: REQUEST_ONE, type: 'completed' })

    expect(screen.getByText('translated')).toBeVisible()
    expect(screen.getByRole('button', { name: '复制' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '停止翻译' })).not.toBeInTheDocument()
  })

  it('buffers events before the invoke result, replays matching deltas in order, and rejects stale IDs', async () => {
    const pendingStart = deferred<ApiResult<TranslationStarted>>()
    const start = vi.fn(() => pendingStart.promise)
    const { emit } = installTranslationApi({ start })
    renderPane()
    reportSelection(selection('selected'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(start).toHaveBeenCalledOnce())

    emit({ requestId: STALE_REQUEST, type: 'delta', delta: 'STALE' })
    emit({ requestId: REQUEST_ONE, type: 'started' })
    emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'first ' })
    emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'second' })
    emit({ requestId: REQUEST_ONE, type: 'completed' })
    pendingStart.resolve(started())

    expect(await screen.findByText('first second')).toBeVisible()
    expect(screen.queryByText(/STALE/u)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制' })).toBeVisible()
  })

  it('fails closed and cancels the returned request when the pending event buffer overflows', async () => {
    const pendingStart = deferred<ApiResult<TranslationStarted>>()
    const { api, emit } = installTranslationApi({
      start: vi.fn(() => pendingStart.promise),
    })
    renderPane()
    reportSelection(selection('selected'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())

    emit({ requestId: REQUEST_ONE, type: 'started' })
    for (let index = 0; index < 300; index += 1) {
      emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'x' })
    }
    pendingStart.resolve(started())

    expect(await screen.findByRole('alert')).toHaveTextContent(GENERIC_ERROR)
    await waitFor(() => expect(api.cancelTranslation).toHaveBeenCalledWith(REQUEST_ONE))
    expect(api.cancelTranslation).toHaveBeenCalledOnce()
  })

  it('fails closed when pending events exceed the UTF-8 byte budget', async () => {
    const pendingStart = deferred<ApiResult<TranslationStarted>>()
    const { api, emit } = installTranslationApi({
      start: vi.fn(() => pendingStart.promise),
    })
    renderPane()
    reportSelection(selection('selected'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())

    const boundedDelta = '译'.repeat(80_000)
    emit({ requestId: REQUEST_ONE, type: 'started' })
    for (let index = 0; index < 5; index += 1) {
      emit({ requestId: REQUEST_ONE, type: 'delta', delta: boundedDelta })
    }
    pendingStart.resolve(started())

    expect(await screen.findByRole('alert')).toHaveTextContent(GENERIC_ERROR)
    await waitFor(() => expect(api.cancelTranslation).toHaveBeenCalledWith(REQUEST_ONE))
    expect(api.cancelTranslation).toHaveBeenCalledOnce()
  })

  it('does not overwrite stopped UI when overflow cancellation settles late', async () => {
    const pendingStart = deferred<ApiResult<TranslationStarted>>()
    const cancellation = deferred<ApiResult<null>>()
    const { api, emit } = installTranslationApi({
      start: vi.fn(() => pendingStart.promise),
    })
    vi.mocked(api.cancelTranslation).mockImplementation(() => cancellation.promise)
    renderPane()
    reportSelection(selection('selected'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())

    emit({ requestId: REQUEST_ONE, type: 'started' })
    for (let index = 0; index < 300; index += 1) {
      emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'x' })
    }
    pendingStart.resolve(started())
    await waitFor(() => expect(api.cancelTranslation).toHaveBeenCalledWith(REQUEST_ONE))

    fireEvent.click(screen.getByRole('button', { name: '停止翻译' }))
    expect(screen.getByText('已停止')).toBeVisible()

    await act(async () => {
      cancellation.resolve({ ok: true, value: null })
      await cancellation.promise
      await Promise.resolve()
    })

    expect(screen.getByText('已停止')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(api.cancelTranslation).toHaveBeenCalledOnce()
  })

  it('does not overwrite a replacement ready selection when overflow cancellation settles late', async () => {
    const pendingStart = deferred<ApiResult<TranslationStarted>>()
    const cancellation = deferred<ApiResult<null>>()
    const { api, emit } = installTranslationApi({
      start: vi.fn(() => pendingStart.promise),
    })
    vi.mocked(api.cancelTranslation).mockImplementation(() => cancellation.promise)
    renderPane()
    reportSelection(selection('selected'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())

    emit({ requestId: REQUEST_ONE, type: 'started' })
    for (let index = 0; index < 300; index += 1) {
      emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'x' })
    }
    pendingStart.resolve(started())
    await waitFor(() => expect(api.cancelTranslation).toHaveBeenCalledWith(REQUEST_ONE))

    reportSelection(selection('replacement'))
    expect(screen.getByRole('button', { name: '翻译选中的文本' })).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await act(async () => {
      cancellation.resolve({ ok: true, value: null })
      await cancellation.promise
      await Promise.resolve()
    })

    expect(screen.getByRole('button', { name: '翻译选中的文本' })).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(api.startTranslation).toHaveBeenCalledOnce()
    expect(api.cancelTranslation).toHaveBeenCalledOnce()
  })

  it('stops exactly once, preserves partial output, and ignores late deltas', async () => {
    const { api, emit } = installTranslationApi()
    renderPane()
    reportSelection(selection('selected'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
    emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'partial' })

    fireEvent.click(screen.getByRole('button', { name: '停止翻译' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    emit({ requestId: REQUEST_ONE, type: 'delta', delta: ' late' })

    expect(api.cancelTranslation).toHaveBeenCalledOnce()
    expect(api.cancelTranslation).toHaveBeenCalledWith(REQUEST_ONE)
    expect(screen.queryByText('partial late')).not.toBeInTheDocument()
  })

  it('maps a matching stopped event to terminal UI and rejects later deltas', async () => {
    const { api, emit } = installTranslationApi()
    renderPane()
    reportSelection(selection('selected'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())

    emit({ requestId: REQUEST_ONE, type: 'stopped' })
    emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'late' })

    expect(screen.getByText('已停止')).toBeVisible()
    expect(screen.queryByText('late')).not.toBeInTheDocument()
    expect(api.cancelTranslation).not.toHaveBeenCalled()
  })

  it('waits for superseded-request cancellation before starting the replacement', async () => {
    const cancellation = deferred<ApiResult<null>>()
    const { api } = installTranslationApi()
    vi.mocked(api.cancelTranslation).mockImplementation(() => cancellation.promise)
    renderPane()
    reportSelection(selection('first'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())

    reportSelection(selection('second'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    expect(api.cancelTranslation).toHaveBeenCalledWith(REQUEST_ONE)
    expect(api.startTranslation).toHaveBeenCalledOnce()

    cancellation.resolve({ ok: true, value: null })
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.startTranslation).mock.calls[1][0].content).toEqual({
      markdown: 'second',
      plainText: 'second',
    })
  })

  it('clears a retained translation waiting on cancellation when the parent replaces the document', async () => {
    const cancellation = deferred<ApiResult<null>>()
    const { api } = installTranslationApi()
    vi.mocked(api.cancelTranslation).mockImplementation(() => cancellation.promise)
    const pane = (markdown: string) => <EditorPane modelPreferences={modelPreferences}
      documentKey="note.md" markdown={markdown} onChange={vi.fn()} onOpenLargeModelSettings={() => undefined} />
    const view = render(pane('# Before discard'))
    reportSelection(selection('first'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
    reportSelection(selection('second'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    expect(api.cancelTranslation).toHaveBeenCalledWith(REQUEST_ONE)
    view.rerender(pane('# Saved content'))
    await act(async () => { cancellation.resolve({ ok: true, value: null }) })
    expect(api.startTranslation).toHaveBeenCalledOnce()
    finishRightSidebarExitIfPresent()
    expect(screen.queryAllByTestId('translation-ui-state').map(state =>
      JSON.parse(state.textContent ?? '{}').status)).not.toContain('starting')
  })

  it('waits for an invalidated start and its late request cancellation before replacement invoke', async () => {
    const pendingStart = deferred<ApiResult<TranslationStarted>>()
    const cancellation = deferred<ApiResult<null>>()
    const start = vi.fn()
      .mockImplementationOnce(() => pendingStart.promise)
      .mockResolvedValueOnce(started(REQUEST_TWO))
    const { api, emit } = installTranslationApi({ start })
    vi.mocked(api.cancelTranslation).mockImplementation(() => cancellation.promise)
    renderPane()
    reportSelection(selection('first'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(start).toHaveBeenCalledOnce())

    reportSelection(selection('second'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    expect(start).toHaveBeenCalledOnce()

    pendingStart.resolve(started(REQUEST_ONE))
    await waitFor(() => expect(api.cancelTranslation).toHaveBeenCalledWith(REQUEST_ONE))
    expect(start).toHaveBeenCalledOnce()

    emit({ requestId: REQUEST_ONE, type: 'started' })
    emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'old result' })
    cancellation.resolve({ ok: true, value: null })

    await waitFor(() => expect(start).toHaveBeenCalledTimes(2))
    expect(start.mock.calls[1][0].content).toEqual({
      markdown: 'second',
      plainText: 'second',
    })
    emit({ requestId: REQUEST_TWO, type: 'started' })
    emit({ requestId: REQUEST_TWO, type: 'delta', delta: 'new result' })
    emit({ requestId: REQUEST_TWO, type: 'completed' })
    expect(await screen.findByText('new result')).toBeVisible()
    expect(screen.queryByText('old result')).not.toBeInTheDocument()
  })

  it.each(['failure', 'rejection'] as const)(
    'releases the invalidated start barrier after %s without issuing cancellation',
    async (settlement) => {
      const pendingStart = deferred<ApiResult<TranslationStarted>>()
      const start = vi.fn()
        .mockImplementationOnce(() => pendingStart.promise)
        .mockResolvedValueOnce(started(REQUEST_TWO))
      const { api } = installTranslationApi({ start })
      renderPane()
      reportSelection(selection('first'))
      fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
      await waitFor(() => expect(start).toHaveBeenCalledOnce())

      reportSelection(selection('second'))
      fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
      expect(start).toHaveBeenCalledOnce()

      if (settlement === 'failure') {
        pendingStart.resolve(apiFailure('start failed'))
      } else {
        pendingStart.reject(new Error('start rejected'))
      }

      await waitFor(() => expect(start).toHaveBeenCalledTimes(2))
      expect(start.mock.calls[1][0].content).toEqual({
        markdown: 'second',
        plainText: 'second',
      })
      expect(api.cancelTranslation).not.toHaveBeenCalled()
    },
  )

  it.each(['failure', 'rejection'] as const)(
    'releases the replacement barrier after late cancellation %s',
    async (settlement) => {
      const pendingStart = deferred<ApiResult<TranslationStarted>>()
      const cancellation = deferred<ApiResult<null>>()
      const start = vi.fn()
        .mockImplementationOnce(() => pendingStart.promise)
        .mockResolvedValueOnce(started(REQUEST_TWO))
      const { api } = installTranslationApi({ start })
      vi.mocked(api.cancelTranslation).mockImplementation(() => cancellation.promise)
      renderPane()
      reportSelection(selection('first'))
      fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
      await waitFor(() => expect(start).toHaveBeenCalledOnce())

      reportSelection(selection('second'))
      fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
      pendingStart.resolve(started(REQUEST_ONE))
      await waitFor(() => expect(api.cancelTranslation).toHaveBeenCalledWith(REQUEST_ONE))
      expect(start).toHaveBeenCalledOnce()

      if (settlement === 'failure') {
        cancellation.resolve(apiFailure('cancel failed'))
      } else {
        cancellation.reject(new Error('cancel rejected'))
      }

      await waitFor(() => expect(start).toHaveBeenCalledTimes(2))
      expect(start.mock.calls[1][0].content).toEqual({
        markdown: 'second',
        plainText: 'second',
      })
    },
  )


  it('uses a public start failure and retries the retained selection', async () => {
    const { api } = installTranslationApi({
      start: vi.fn()
        .mockResolvedValueOnce(apiFailure('公开启动错误'))
        .mockResolvedValueOnce(started(REQUEST_TWO)),
    })
    renderPane()
    reportSelection(selection('retry me'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('公开启动错误')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.startTranslation).mock.calls[1][0]).toEqual({
      documentKey: 'note.md',
      content: { markdown: 'retry me', plainText: 'retry me' },
      mode: 'visual',
    })
  })

  it('preserves MODEL_NOT_CONFIGURED from a failed start result', async () => {
    installTranslationApi({
      start: vi.fn().mockResolvedValue(apiFailure(
        '尚未配置划词翻译使用的大模型',
        'MODEL_NOT_CONFIGURED',
      )),
    })
    renderPane()
    reportSelection(selection('configure me'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('尚未配置大模型')
    expect(translationUiErrorCode()).toBe('MODEL_NOT_CONFIGURED')
  })

  it('checks model configuration before entering the translating state', async () => {
    const start = vi.fn(() => new Promise<ApiResult<TranslationStarted>>(() => undefined))
    installTranslationApi({ configured: false, start })
    renderPane()
    reportSelection(selection('configure me'))

    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '尚未配置大模型',
    )
    expect(screen.getByRole('button', { name: '前往配置' })).toBeVisible()
    expect(screen.queryByText('正在翻译…')).not.toBeInTheDocument()
    expect(start).not.toHaveBeenCalled()
  })

  it('keeps the model preflight current when opening the sidebar remeasures the selection', async () => {
    const settingsRead = deferred<ApiResult<LargeModelSettings>>()
    const start = vi.fn(() => new Promise<ApiResult<TranslationStarted>>(() => undefined))
    const { api } = installTranslationApi({ configured: false, start })
    vi.mocked(api.getLargeModelSettings).mockReturnValueOnce(settingsRead.promise)
    renderPane()
    const selected = selection('configure me')
    reportSelection(selected)

    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    expect(screen.queryByRole('complementary', { name: '右侧栏' })).not.toBeInTheDocument()

    act(() => editorBridge.visualAnchor?.({
      anchorRect: { ...selected.anchorRect, left: 32, right: 152 },
      focusRect: { ...selected.focusRect, left: 152, right: 152 },
    }))
    await act(async () => settingsRead.resolve({ ok: true, value: settings(true, false) }))

    const sidebar = await screen.findByRole('complementary', { name: '右侧栏' })
    expect(sidebar).toHaveTextContent('尚未配置大模型')
    expect(screen.queryByRole('button', { name: '翻译选中的文本' })).not.toBeInTheDocument()
    expect(start).not.toHaveBeenCalled()
  })

  it('keeps the unconfigured guide visible through the controlled App sidebar route', async () => {
    installTranslationApi({
      start: vi.fn().mockResolvedValue(apiFailure(
        '尚未配置划词翻译使用的大模型',
        'MODEL_NOT_CONFIGURED',
      )),
    })

    function Harness() {
      const [sidebar, setSidebar] = useState({
        activeTab: 'translation' as 'translation' | 'ai-chat' | 'document-view',
        open: false,
      })
      return <EditorPane modelPreferences={modelPreferences}
        documentKey="note.md"
        markdown="# Whole document"
        onChange={() => undefined}
        onCloseRightSidebar={() => setSidebar((current) => ({ ...current, open: false }))}
        onOpenLargeModelSettings={() => undefined}
        onOpenRightSidebar={(activeTab) => setSidebar({ activeTab, open: true })}
        rightSidebarState={sidebar}
      />
    }

    render(<Harness />)
    reportSelection(selection('configure me'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))

    const sidebar = await screen.findByRole('complementary', { name: '右侧栏' })
    expect(sidebar).toHaveTextContent('尚未配置大模型')
    expect(screen.getByRole('button', { name: '前往配置' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '划词翻译' })).not.toBeInTheDocument()
  })

  it('restores the model configuration guide when the translation sidebar opens directly', async () => {
    const { api } = installTranslationApi({ configured: false })
    render(
      <EditorPane modelPreferences={modelPreferences}
        documentKey="note.md"
        markdown="# Whole document"
        onChange={() => undefined}
        onOpenLargeModelSettings={() => undefined}
        rightSidebarState={{ activeTab: 'translation', open: true }}
      />,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '尚未配置大模型',
    )
    expect(screen.getByRole('button', { name: '前往配置' })).toBeVisible()
    expect(api.getLargeModelSettings).toHaveBeenCalledTimes(2)
  })

  it('refreshes a stale direct-sidebar configuration guide after preferences are saved', async () => {
    const { api } = installTranslationApi({ configured: false })
    const view = render(
      <EditorPane modelPreferences={modelPreferences}
        documentKey="note.md"
        markdown="# Whole document"
        onChange={() => undefined}
        onOpenLargeModelSettings={() => undefined}
        rightSidebarState={{ activeTab: 'translation', open: true }}
        translationSettingsRevision={0}
      />,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '尚未配置大模型',
    )

    const configured = settings(true)
    configured.connections = [{
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Configured model',
      provider: 'deepseek',
      accessType: 'standard-api',
      protocol: 'openai',
      baseUrl: 'https://example.invalid',
      modelId: 'configured-model',
      apiKeyHint: '••••test',
      status: 'connected',
      lastTestedAt: null,
      capabilityOverride: null,
    }]
    configured.selectionTranslation.connectionId = configured.connections[0].id
    vi.mocked(api.getLargeModelSettings).mockResolvedValueOnce({ ok: true, value: configured })

    view.rerender(
      <EditorPane modelPreferences={modelPreferences}
        documentKey="note.md"
        markdown="# Whole document"
        onChange={() => undefined}
        onOpenLargeModelSettings={() => undefined}
        rightSidebarState={{ activeTab: 'translation', open: true }}
        translationSettingsRevision={1}
      />,
    )

    expect(await screen.findByText('暂无翻译记录')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '翻译选中的文本' })).not.toBeInTheDocument()
  })

  it('does not replace an empty translation history with the guide when a model is configured', async () => {
    const { api } = installTranslationApi()
    const configured = settings(true)
    configured.connections = [{
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Configured model',
      provider: 'deepseek',
      accessType: 'standard-api',
      protocol: 'openai',
      baseUrl: 'https://example.invalid',
      modelId: 'configured-model',
      apiKeyHint: '••••test',
      status: 'connected',
      lastTestedAt: null,
      capabilityOverride: null,
    }]
    configured.selectionTranslation.connectionId = configured.connections[0].id
    vi.mocked(api.getLargeModelSettings).mockResolvedValueOnce({ ok: true, value: configured })

    render(
      <EditorPane modelPreferences={modelPreferences}
        documentKey="note.md"
        markdown="# Whole document"
        onChange={() => undefined}
        onOpenLargeModelSettings={() => undefined}
        rightSidebarState={{ activeTab: 'translation', open: true }}
      />,
    )

    expect(await screen.findByText('暂无翻译记录')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '前往配置' })).not.toBeInTheDocument()
  })

  it('preserves an unconfigured selection through settings and waits for explicit continuation', async () => {
    const openLargeModelSettings = vi.fn()
    const { api } = installTranslationApi({ configured: false })
    const pane = (revision = 0, markdown = '# Whole document', documentKey = 'note.md') => (
      <EditorPane modelPreferences={modelPreferences} documentKey={documentKey} markdown={markdown} onChange={vi.fn()}
        onOpenLargeModelSettings={openLargeModelSettings} translationSettingsRevision={revision} />
    )
    const view = render(pane())
    reportSelection(selection('configure me'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    fireEvent.click(await screen.findByRole('button', { name: '前往配置' }))
    expect(openLargeModelSettings).toHaveBeenCalledTimes(1)

    // Cancelling settings does not bump the settings revision or lose pending work.
    view.rerender(pane())
    expect(screen.getByRole('button', { name: '前往配置' })).toBeVisible()
    expect(api.startTranslation).not.toHaveBeenCalled()

    const configured = settings(true, true)
    configured.selectionTranslation.targetLanguage = 'fr'
    vi.mocked(api.getLargeModelSettings).mockResolvedValue({ ok: true, value: configured })
    view.rerender(pane(1))
    const continueButton = await screen.findByRole('button', { name: '翻译选中的文本' })
    expect(api.startTranslation).not.toHaveBeenCalled()
    reportSelection(null) // Blur/cursor collapse on the settings round trip is not a new intent.
    expect(continueButton).toBeInTheDocument()
    fireEvent.click(continueButton)
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledTimes(1))
    expect(api.startTranslation).toHaveBeenCalledWith({
      documentKey: 'note.md', mode: 'visual',
      content: { markdown: 'configure me', plainText: 'configure me' },
    })
    expect(historyEditorHandle.capturePendingTranslationAnchor).toHaveBeenCalledTimes(1)
    expect(historyEditorHandle.bindPendingTranslationAnchor).toHaveBeenCalledWith(
      historyEditorHandle.capturePendingTranslationAnchor.mock.calls[0][0], REQUEST_ONE,
    )
  })

  it.each(['return', 'continue', 'flush', 'revision'] as const)('requires reselection when the source changes before settings %s', async (stage) => {
    const { api } = installTranslationApi({ configured: false })
    const pane = (revision = 0, markdown = '# Original', documentRevision = 'original') => (
      <EditorPane modelPreferences={modelPreferences} documentKey="note.md" markdown={markdown} onChange={vi.fn()}
        translationHistoryIdentity={{ documentRevision, workspaceAbsolutePath: null, documentRelativePath: null }}
        onOpenLargeModelSettings={() => undefined} translationSettingsRevision={revision} />
    )
    const view = render(pane())
    reportSelection(selection('original selection'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    fireEvent.click(await screen.findByRole('button', { name: '前往配置' }))
    vi.mocked(api.getLargeModelSettings).mockResolvedValue({ ok: true, value: settings(true, true) })
    if (stage === 'return') {
      view.rerender(pane(1, '# Changed'))
    } else if (stage === 'revision') {
      view.rerender(pane(0, '# Original', 'changed'))
    } else {
      view.rerender(pane(1))
      await screen.findByRole('button', { name: '翻译选中的文本' })
      if (stage === 'flush') editorBridge.visualFlushMarkdown = '# Changed'
      else act(() => editorBridge.visualChange?.('# Changed'))
      fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    }
    expect(await screen.findByRole('alert')).toHaveTextContent('重新选择')
    expect(api.startTranslation).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '翻译选中的文本' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
  })

  it.each(['close', 'document', 'mode', 'unmount'] as const)('discards the retained settings selection on %s', async (action) => {
    const { api } = installTranslationApi({ configured: false })
    const pane = (revision = 0, documentKey = 'note.md') => (
      <EditorPane modelPreferences={modelPreferences} documentKey={documentKey} markdown="# Original" onChange={vi.fn()}
        onOpenLargeModelSettings={() => undefined} translationSettingsRevision={revision} />
    )
    const view = render(pane())
    reportSelection(selection('original selection'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    fireEvent.click(await screen.findByRole('button', { name: '前往配置' }))
    expect(historyEditorHandle.capturePendingTranslationAnchor).toHaveBeenCalledTimes(1)
    const anchorKey = historyEditorHandle.capturePendingTranslationAnchor.mock.calls[0][0]
    if (action === 'close') fireEvent.keyDown(window, { key: 'Escape' })
    if (action === 'document') view.rerender(pane(0, 'other.md'))
    if (action === 'mode') toggleMode()
    if (action === 'unmount') view.unmount()
    expect(historyEditorHandle.discardPendingTranslationAnchor).toHaveBeenCalledWith(anchorKey)
    vi.mocked(api.getLargeModelSettings).mockResolvedValue({ ok: true, value: settings(true, true) })
    if (action !== 'unmount') view.rerender(pane(1, action === 'document' ? 'other.md' : 'note.md'))
    expect(api.startTranslation).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '翻译选中的文本' })).not.toBeInTheDocument()
  })

  it('preserves MODEL_TIMEOUT from a stream failure and keeps retry presentation', async () => {
    const { api, emit } = installTranslationApi()
    renderPane()
    reportSelection(selection('time out'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())

    emit({
      requestId: REQUEST_ONE,
      type: 'failed',
      code: 'MODEL_TIMEOUT',
      message: '大模型请求超时',
    })

    expect(screen.getByRole('alert')).toHaveTextContent('大模型请求超时')
    expect(translationUiErrorCode()).toBe('MODEL_TIMEOUT')
    expect(screen.getByRole('button', { name: '重试' })).toBeVisible()
  })

  it('records OPERATION_FAILED when starting translation throws', async () => {
    installTranslationApi({
      start: vi.fn().mockRejectedValue(new Error('raw provider secret')),
    })
    renderPane()
    reportSelection(selection('selected'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(GENERIC_ERROR)
    expect(translationUiErrorCode()).toBe('OPERATION_FAILED')
    expect(historyEditorHandle.capturePendingTranslationAnchor).toHaveBeenCalledOnce()
    expect(historyEditorHandle.discardPendingTranslationAnchor).toHaveBeenCalledWith(
      historyEditorHandle.capturePendingTranslationAnchor.mock.calls[0][0],
    )
  })

  it('clears stale error codes for ready, retry, completed, and stopped states', async () => {
    const start = vi.fn()
      .mockResolvedValue(started(REQUEST_TWO))
      .mockResolvedValueOnce(apiFailure('启动失败', 'MODEL_NOT_CONFIGURED'))
    const { api, emit } = installTranslationApi({ start })
    renderPane()
    reportSelection(selection('first selection'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await screen.findByRole('alert')
    expect(translationUiErrorCode()).toBe('MODEL_NOT_CONFIGURED')

    reportSelection(selection('replacement selection'))
    finishRightSidebarExitIfPresent()
    expect(translationUiErrorCode()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledTimes(2))
    expect(translationUiErrorCode()).toBeNull()
    emit({ requestId: REQUEST_TWO, type: 'completed' })
    expect(translationUiErrorCode()).toBeNull()

    reportSelection(selection('stopped selection'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledTimes(3))
    emit({ requestId: REQUEST_TWO, type: 'stopped' })
    expect(translationUiErrorCode()).toBeNull()
  })

  it('collapses a thrown start error to the fixed public message', async () => {
    const { api } = installTranslationApi({
      start: vi.fn().mockRejectedValue(new Error('raw provider secret')),
    })
    renderPane()
    reportSelection(selection('selected'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(GENERIC_ERROR)
    expect(screen.getByRole('alert')).not.toHaveTextContent('raw provider secret')
    expect(api.cancelTranslation).not.toHaveBeenCalled()
  })
})

describe('document, mode, close, and unmount lifecycle', () => {
  it('cancels an active request on document-key change and mode switch', async () => {
    const { api } = installTranslationApi()
    const view = renderPane()
    reportSelection(selection('selected'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())

    view.rerender(
      <div className="app-shell">
        <EditorPane modelPreferences={modelPreferences}
          documentKey="other.md"
          markdown="# Other"
          onChange={vi.fn()}
          onOpenLargeModelSettings={() => undefined}
        />
      </div>,
    )
    await waitFor(() => expect(api.cancelTranslation).toHaveBeenCalledWith(REQUEST_ONE))

    reportSelection(selection('again'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledTimes(2))
    toggleMode()
    expect(api.cancelTranslation).toHaveBeenCalledWith(REQUEST_ONE)
    expect(api.cancelTranslation).toHaveBeenCalledTimes(2)
  })

  it('keeps an active request alive when document find opens', async () => {
    const { api, emit } = installTranslationApi()
    renderPane()
    reportSelection(selection('selected'))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())

    act(() => window.dispatchEvent(new CustomEvent('arkdown:editor-command', {
      detail: 'find-in-document',
    })))
    expect(screen.getByRole('searchbox', { name: '在文档中搜索' })).toBeVisible()
    expect(api.cancelTranslation).not.toHaveBeenCalled()
    emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'still active' })
    expect(screen.getByText('still active')).toBeVisible()

    const stop = screen.getByRole('button', { name: '停止翻译' })
    stop.focus()
    expect(fireEvent.keyDown(stop, { key: 'Escape' })).toBe(false)
    expect(screen.queryByRole('searchbox', { name: '在文档中搜索' })).not.toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: '右侧栏' })).toBeVisible()
    expect(api.cancelTranslation).not.toHaveBeenCalled()
    expect(stop).toHaveFocus()

    expect(fireEvent.keyDown(stop, { key: 'Escape' })).toBe(false)
    expect(screen.getByRole('complementary', { name: '右侧栏' })).toBeInTheDocument()
    finishRightSidebarExit()
    expect(screen.queryByRole('complementary', { name: '右侧栏' })).not.toBeInTheDocument()
    expect(screen.getByTestId('visual-editor')).toHaveFocus()
    expect(api.cancelTranslation).toHaveBeenCalledWith(REQUEST_ONE)
  })

  it.each(['document', 'mode', 'unmount'] as const)(
    'cancels a request whose invoke result resolves after %s invalidation without reviving UI',
    async (invalidation) => {
      const pendingStart = deferred<ApiResult<TranslationStarted>>()
      const { api } = installTranslationApi({
        start: vi.fn(() => pendingStart.promise),
      })
      const view = renderPane()
      reportSelection(selection('selected'))
      fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
      await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())

      if (invalidation === 'document') {
        view.rerender(
          <div className="app-shell">
            <EditorPane modelPreferences={modelPreferences}
              documentKey="other.md"
              markdown="# Other"
              onChange={vi.fn()}
              onOpenLargeModelSettings={() => undefined}
            />
          </div>,
        )
      } else if (invalidation === 'mode') {
        toggleMode()
      } else {
        view.unmount()
      }
      pendingStart.resolve(started())

      await waitFor(() => expect(api.cancelTranslation).toHaveBeenCalledWith(REQUEST_ONE))
      expect(api.cancelTranslation).toHaveBeenCalledOnce()
      finishRightSidebarExitIfPresent()
      expect(screen.queryByText('正在翻译…')).not.toBeInTheDocument()
    },
  )

  it('does not cancel a stopped sidebar twice when closing it', async () => {
    const { api } = installTranslationApi()
    renderPane()
    reportSelection(selection('a'.repeat(100)))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())

    fireEvent.click(screen.getByRole('button', { name: '停止翻译' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))

    expect(api.cancelTranslation).toHaveBeenCalledOnce()
    expect(screen.getByRole('complementary', { name: '右侧栏' })).toBeInTheDocument()
    finishRightSidebarExit()
    expect(screen.queryByRole('complementary', { name: '右侧栏' })).not.toBeInTheDocument()
  })
})

describe('sidebar application layout and measurement lifecycle', () => {
  it.each([
    ['visual', 'visual-editor'],
    ['source', 'source-editor'],
  ] as const)(
    'preserves %s editor identity, selection, scroll, and external toggle focus through reversal and exit',
    (initialMode, editorTestId) => {
      installTranslationApi({ configured: true })
      function Harness() {
        const [open, setOpen] = useState(true)
        return <>
          <button
            aria-label="切换右侧栏"
            onClick={() => setOpen((current) => !current)}
            type="button"
          >
            切换
          </button>
          <EditorPane modelPreferences={modelPreferences}
            documentKey="note.md"
            initialMode={initialMode}
            markdown="keep this selection"
            onChange={vi.fn()}
            onOpenLargeModelSettings={() => undefined}
            rightSidebarState={{ activeTab: 'translation', open }}
          />
        </>
      }
      render(<Harness />)
      const toggle = screen.getByRole('button', { name: '切换右侧栏' })
      const editor = screen.getByTestId(editorTestId)
      const surface = document.querySelector<HTMLElement>('.editor-surface')!
      surface.scrollTop = 83
      toggle.focus()
      const range = document.createRange()
      range.selectNodeContents(editor)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      fireEvent.click(toggle)
      expect(screen.getByTestId('editor-right-sidebar-motion-track'))
        .toHaveAttribute('data-phase', 'closing')
      expect(screen.getByTestId(editorTestId)).toBe(editor)
      expect(surface.scrollTop).toBe(83)

      fireEvent.click(toggle)
      expect(screen.getByTestId('editor-right-sidebar-motion-track'))
        .toHaveAttribute('data-phase', 'opening')
      expect(screen.getByTestId(editorTestId)).toBe(editor)

      fireEvent.click(toggle)
      finishRightSidebarExit()
      expect(screen.queryByRole('complementary', { name: '右侧栏' })).not.toBeInTheDocument()
      expect(screen.getByTestId(editorTestId)).toBe(editor)
      expect(surface.scrollTop).toBe(83)
      expect(editor.contains(selection.anchorNode)).toBe(true)
      expect(toggle).toHaveFocus()
    },
  )

  it('keeps the measured sidebar width stable as selection appears and clears', async () => {
    installTranslationApi({ configured: true })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const width = this.classList.contains('editor-pane')
        ? 1000
        : this.classList.contains('editor-surface')
          ? 650
          : 0
      return {
        bottom: 600,
        height: 600,
        left: 0,
        right: width,
        top: 0,
        width,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }
    })

    render(
      <EditorPane modelPreferences={modelPreferences}
        documentKey="note.md"
        markdown="# Note"
        onChange={vi.fn()}
        onOpenLargeModelSettings={() => undefined}
        rightSidebarState={{ activeTab: 'translation', open: true }}
      />,
    )

    const sidebar = screen.getByRole('complementary', { name: '右侧栏' })
    await waitFor(() => expect(sidebar).toHaveStyle({ width: '530px' }))

    reportSelection(selection('selected words'))
    expect(sidebar).toHaveStyle({ width: '530px' })

    reportSelection(null)
    await waitFor(() => expect(sidebar).toHaveStyle({ width: '530px' }))
  })

  it('reserves the source rail only for a valid current-document source record', () => {
    installTranslationApi()
    const source = historyRecord('source-record', 'translated', 1)
    source.mode = 'source'
    source.anchor = {
      mode: 'source',
      from: 1,
      to: 2,
      lineStart: 0,
      fingerprint: { before: '', selected: 's', after: '' },
      status: 'valid',
    }
    render(<EditorPane modelPreferences={modelPreferences}
      documentKey="note.md"
      initialMode="source"
      markdown="source"
      onChange={vi.fn()}
      onOpenLargeModelSettings={() => undefined}
      translationHistoryRecords={[source]}
    />)

    expect(document.querySelector('.editor-surface'))
      .toHaveClass('has-source-translation-history-rail')
    expect(screen.getByTestId('translation-history-rail-source')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '编辑器翻译记录标记' })).toBeVisible()
  })

  it('closes a controlled sidebar when the same editor marker is clicked twice', async () => {
    installTranslationApi()
    const record = historyRecord('toggle-record', 'toggle translation', 1)
    const onCloseRightSidebar = vi.fn()
    function Harness() {
      const [rightSidebarState, setRightSidebarState] = useState({
        open: false,
        activeTab: 'translation' as 'translation' | 'ai-chat' | 'document-view',
      })
      return <EditorPane modelPreferences={modelPreferences}
        documentKey="note.md"
        markdown="# Note"
        onChange={vi.fn()}
        onCloseRightSidebar={() => {
          onCloseRightSidebar()
          setRightSidebarState((current) => ({ ...current, open: false }))
        }}
        onOpenLargeModelSettings={() => undefined}
        onOpenRightSidebar={(activeTab) => setRightSidebarState({ open: true, activeTab })}
        rightSidebarState={rightSidebarState}
        translationHistoryRecords={[record]}
      />
    }
    render(<Harness />)
    const marker = screen.getByRole('button', { name: '编辑器翻译记录标记' })

    fireEvent.click(marker)
    expect(await screen.findByText('toggle translation')).toBeVisible()
    fireEvent.click(marker)

    expect(screen.getByRole('complementary', { name: '右侧栏' })).toBeInTheDocument()
    expect(marker).toHaveFocus()
    finishRightSidebarExit()
    expect(screen.queryByRole('complementary', { name: '右侧栏' })).not.toBeInTheDocument()
    expect(onCloseRightSidebar).toHaveBeenCalledOnce()
    await waitFor(() => expect(marker).toHaveFocus())
  })

  it('opens the latest current-document history when the toolbar reveals an idle sidebar', async () => {
    installTranslationApi()
    const records = [
      historyRecord('older', 'older translation', 1),
      historyRecord('latest', 'latest translation', 2),
    ]
    const selectById = vi.fn((recordId: string) => (
      records.find(({ id }) => id === recordId) ?? null
    ))
    const baseProps = {
      documentKey: 'note.md',
      markdown: '# Note',
      onChange: vi.fn(),
      onOpenLargeModelSettings: () => undefined,
      translationHistory: {
        selectedRecordId: null,
        finalize: vi.fn(() => null),
        selectById,
        updateAnchor: vi.fn(),
      },
      translationHistoryRecords: records,
    }
    const rendered = render(<EditorPane modelPreferences={modelPreferences}
      {...baseProps}
      rightSidebarState={{ activeTab: 'translation', open: false }}
    />)

    rendered.rerender(<EditorPane modelPreferences={modelPreferences}
      {...baseProps}
      rightSidebarState={{ activeTab: 'translation', open: true }}
    />)

    await waitFor(() => expect(screen.getByRole('region', { name: '翻译记录' })).toBeVisible())
    expect(screen.getByText('latest translation')).toBeVisible()
    expect(selectById).toHaveBeenCalledWith('latest')
  })

  it('shows the configuration guide when the toolbar opens without a configured model', async () => {
    installTranslationApi({ configured: false })
    const baseProps = {
      documentKey: 'note.md',
      markdown: '# Note',
      onChange: vi.fn(),
      onOpenLargeModelSettings: () => undefined,
      translationHistoryRecords: [] as TranslationHistoryRecord[],
    }
    const rendered = render(<EditorPane modelPreferences={modelPreferences}
      {...baseProps}
      rightSidebarState={{ activeTab: 'translation', open: false }}
    />)

    rendered.rerender(<EditorPane modelPreferences={modelPreferences}
      {...baseProps}
      rightSidebarState={{ activeTab: 'translation', open: true }}
    />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '尚未配置大模型',
    )
    expect(screen.getByRole('button', { name: '前往配置' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '翻译选中的文本' })).not.toBeInTheDocument()
  })

  it('requests the generic translation tab before showing a sidebar presentation', async () => {
    const onOpenRightSidebar = vi.fn()
    const { api } = installTranslationApi()
    render(
      <EditorPane modelPreferences={modelPreferences}
        documentKey="note.md"
        markdown="# Whole document"
        onChange={vi.fn()}
        onOpenLargeModelSettings={() => undefined}
        onOpenRightSidebar={onOpenRightSidebar}
        rightSidebarState={{ activeTab: 'translation', open: false }}
      />,
    )

    reportSelection(selection('a'.repeat(100)))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))

    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
    expect(onOpenRightSidebar).toHaveBeenCalledWith('translation')
    expect(screen.getByRole('complementary', { name: '右侧栏' })).toBeVisible()
    expect(screen.queryByRole('dialog', { name: '划词翻译' })).not.toBeInTheDocument()
  })

  it('switches the shared right sidebar between translation and AI chat', async () => {
    installTranslationApi({ configured: true })
    function Harness() {
      const [rightSidebarState, setRightSidebarState] = useState({
        open: true,
        activeTab: 'translation' as 'translation' | 'ai-chat' | 'document-view',
      })
      return <EditorPane modelPreferences={modelPreferences}
        documentKey="note.md"
        markdown="# Note"
        onChange={vi.fn()}
        onOpenLargeModelSettings={() => undefined}
        onOpenRightSidebar={(activeTab) => setRightSidebarState({ open: true, activeTab })}
        rightSidebarState={rightSidebarState}
      />
    }
    render(<Harness />)

    fireEvent.click(screen.getByRole('tab', { name: 'AI 对话' }))

    expect(await screen.findByRole('textbox', { name: '发送消息给 AI' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'AI 对话' })).toHaveAttribute('aria-selected', 'true')
  })

  it('opens web and local targets only through the dedicated safe link opener', async () => {
    const { api } = installTranslationApi({ configured: true })
    const openExternal = vi.fn(async () => ({ ok: true as const, value: null }))
    const openAiMessageLink = vi.fn(async () => ({ ok: true as const, value: null }))
    api.openExternal = openExternal
    api.openAiMessageLink = openAiMessageLink
    const store = createAiConversationStore()
    const session = activateWorkspaceAiSession(store, {
      workspaceId: '__workspace-unavailable__',
      workspaceGeneration: '__workspace-unavailable__',
    })
    session.messages = [{
        id: 'assistant-link',
        role: 'assistant',
        content: '[官网](https://example.com/guide)\n\nC:\\Work\\linked.md\n\nC:\\Work\\run.cmd\n\n[拒绝文件协议](file:///C:/Work/linked.md)\n\n[文档路径](C:/Work/report.md)',
      }]
    render(<EditorPane modelPreferences={modelPreferences}
      aiConversationStore={store}
      documentKey="note.md"
      markdown="# Note"
      onChange={vi.fn()}
      onOpenLargeModelSettings={() => undefined}
      onOpenRightSidebar={() => undefined}
      rightSidebarState={{ activeTab: 'ai-chat', open: true }}
    />)

    fireEvent.click(await screen.findByRole('link', { name: '官网' }))
    const localPath = screen.getByRole('link', { name: 'C:\\Work\\linked.md' })
    expect(localPath).toHaveAttribute('href', 'file:///C:/Work/linked.md')
    fireEvent.click(localPath)
    const revealOnlyPath = screen.getByRole('link', { name: 'C:\\Work\\run.cmd' })
    expect(revealOnlyPath).toHaveAttribute('href', 'file:///C:/Work/run.cmd')
    fireEvent.click(revealOnlyPath)
    fireEvent.click(screen.getByRole('link', { name: '文档路径' }))
    expect(screen.queryByRole('link', { name: '拒绝文件协议' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('拒绝文件协议'))

    expect(openAiMessageLink).toHaveBeenNthCalledWith(1, 'https://example.com/guide')
    expect(openAiMessageLink).toHaveBeenNthCalledWith(2, 'C:\\Work\\linked.md')
    expect(openAiMessageLink).toHaveBeenNthCalledWith(3, 'C:\\Work\\run.cmd')
    expect(openAiMessageLink).toHaveBeenNthCalledWith(4, 'C:\\Work\\report.md')
    expect(openAiMessageLink).toHaveBeenCalledTimes(4)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('quick-switches the real sidebar through persisted settings and preserves workspace history', async () => {
    const { api } = installTranslationApi({ configured: true })
    api.clearAiConversation = vi.fn(async () => ({ ok: true as const, value: null }))
    let current = settings(true, true)
    const second = { ...current.connections[0]!, id: '22222222-2222-4222-8222-222222222222', name: '备用模型' }
    current = { ...current, connections: [...current.connections, second], aiConversation: { ...current.aiConversation, writePolicy: 'document-grant' } }
    vi.mocked(api.getLargeModelSettings).mockImplementation(async () => ({ ok: true, value: current }))
    api.setAiConversationSettings = vi.fn(async (value) => {
      current = { ...current, aiConversation: { ...current.aiConversation, ...value } }
      return { ok: true as const, value: modelCommit(current) }
    })
    const store = createAiConversationStore()
    const session = activateWorkspaceAiSession(store, { workspaceId: '__workspace-unavailable__', workspaceGeneration: '__workspace-unavailable__' })
    session.messages = [{ id: 'kept', role: 'assistant', content: 'Keep this visible history' }]
    render(<EditorPane modelPreferences={modelPreferences} aiConversationStore={store} documentKey="note.md" markdown="# Note"
      onChange={vi.fn()} onOpenLargeModelSettings={() => undefined} onOpenRightSidebar={() => undefined}
      rightSidebarState={{ activeTab: 'ai-chat', open: true }} />)
    fireEvent.click(await screen.findByRole('combobox', { name: 'AI 对话快速模型选择' }))
    fireEvent.click(screen.getByRole('option', { name: '备用模型' }))
    await waitFor(() => expect(api.setAiConversationSettings).toHaveBeenCalledWith({
      connectionId: second.id, reasoningEffort: 'default',
    }, expect.objectContaining({ observation: expect.objectContaining({ revision: 1 }) })))
    expect(await screen.findByText('Keep this visible history')).toBeVisible()
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'AI 对话快速模型选择' })).toHaveTextContent('备用模型'))
    expect(session.capabilities).toEqual({ currentDocument: true, workspace: true })
    expect(session.authoritativeCapabilities).toEqual({ currentDocument: false, workspace: false })
    expect(api.clearAiConversation).not.toHaveBeenCalled()
  })

  it('saves AI thinking against its original observation, blocks send and overlapping changes, and reports a failed save', async () => {
    const { api } = installTranslationApi({ configured: true })
    let current = settings(true, true)
    current.connections[0] = { ...current.connections[0]!, provider: 'other', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', modelId: 'claude-opus-5' }
    current.aiConversation = { ...current.aiConversation, thinkingMode: 'disabled', reasoningEffort: 'max' }
    vi.mocked(api.getLargeModelSettings).mockImplementation(async () => ({ ok: true, value: current }))
    const save = deferred<ApiResult<PublicModelMutationResult>>()
    api.setAiConversationSettings = vi.fn(() => save.promise)
    render(<EditorPane modelPreferences={modelPreferences} documentKey="note.md" markdown="# Note" onChange={vi.fn()} onOpenLargeModelSettings={vi.fn()}
      rightSidebarState={{ activeTab: 'ai-chat', open: true }} />)
    const toggle = await screen.findByRole('combobox', { name: 'AI 对话思考' })
    current = { ...current, aiConversation: { ...current.aiConversation, writePolicy: 'document-grant' } }
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('option', { name: '开' }))
    await waitFor(() => expect(api.setAiConversationSettings).toHaveBeenCalledWith({ thinkingMode: 'enabled' }, expect.objectContaining({ settings: expect.objectContaining({ aiConversation: expect.objectContaining({ writePolicy: 'ask-every-time' }) }) })))
    expect(toggle).toBeDisabled()
    fireEvent.click(toggle)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(api.setAiConversationSettings).toHaveBeenCalledOnce()
    fireEvent.change(screen.getByRole('textbox', { name: '发送消息给 AI' }), { target: { value: 'wait for save' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: '发送消息给 AI' }), { key: 'Enter' })
    expect(api.startAiConversation).not.toHaveBeenCalled()
    await act(async () => save.resolve(apiFailure('保存失败，请重试')))
    expect(await screen.findByRole('alert')).toHaveTextContent('保存失败，请重试')
    expect(screen.getByRole('combobox', { name: 'AI 对话思考' })).toHaveTextContent('开')
    expect(screen.getByRole('combobox', { name: 'AI 对话思考' })).toBeEnabled()
  })

  it('keeps write policy changes available while AI is generating', async () => {
    const { api } = installTranslationApi({ configured: true })
    let current = settings(true, true)
    vi.mocked(api.getLargeModelSettings).mockImplementation(async () => ({ ok: true, value: current }))
    api.setAiConversationSettings = vi.fn(async (input) => {
      current = { ...current, aiConversation: { ...current.aiConversation, ...input } }
      return { ok: true as const, value: modelCommit(current) }
    })
    render(<EditorPane modelPreferences={modelPreferences} documentKey="note.md" markdown="# Note" onChange={vi.fn()} onOpenLargeModelSettings={vi.fn()}
      rightSidebarState={{ activeTab: 'ai-chat', open: true }} />)
    const composer = await screen.findByRole('textbox', { name: '发送消息给 AI' })
    fireEvent.change(composer, { target: { value: 'keep generating' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(api.startAiConversation).toHaveBeenCalledOnce())
    await screen.findByRole('button', { name: '停止生成' })
    fireEvent.click(screen.getByRole('button', { name: '写入策略：每次询问' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /按文档许可/ }))
    await waitFor(() => expect(api.setAiConversationSettings).toHaveBeenCalledWith({
      writePolicy: 'document-grant',
    }, expect.objectContaining({ observation: expect.objectContaining({ revision: 1 }) })))
    expect(await screen.findByRole('button', { name: '写入策略：按文档许可' })).toBeVisible()
  })

  it('recovers AI configuration after a save failure supersedes a pending refresh during generation', async () => {
    const { api, emitAi, startAiConversation } = installTranslationApi({ configured: true })
    const current = settings(true, true)
    vi.mocked(api.getLargeModelSettings).mockResolvedValue({ ok: true, value: current })
    api.setAiConversationSettings = vi.fn(async () => apiFailure('策略保存失败'))
    const pane = (revision: number) => <EditorPane modelPreferences={modelPreferences} documentKey="note.md" markdown="# Note" onChange={vi.fn()}
      onOpenLargeModelSettings={vi.fn()} translationSettingsRevision={revision}
      rightSidebarState={{ activeTab: 'ai-chat', open: true }} />
    const view = render(pane(0))
    const composer = await screen.findByRole('textbox', { name: '发送消息给 AI' })
    fireEvent.change(composer, { target: { value: 'preserve this conversation' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(startAiConversation).toHaveBeenCalledOnce())
    const requestId = startAiConversation.mock.lastCall![0].requestId
    await screen.findByRole('button', { name: '停止生成' })
    const oldRefresh = deferred<ApiResult<LargeModelSettings>>()
    const readsBeforeRefresh = vi.mocked(api.getLargeModelSettings).mock.calls.length
    vi.mocked(api.getLargeModelSettings).mockReturnValueOnce(oldRefresh.promise)
    view.rerender(pane(1))
    await waitFor(() => expect(api.getLargeModelSettings).toHaveBeenCalledTimes(readsBeforeRefresh + 1))
    fireEvent.click(screen.getByRole('button', { name: '写入策略：每次询问' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /按文档许可/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('策略保存失败')
    emitAi({ requestId, type: 'message-start', messageId: 'assistant-policy', previousTranscriptRevision: 1 })
    emitAi({ requestId, type: 'delta', messageId: 'assistant-policy', delta: 'Finished response' })
    emitAi({ requestId, type: 'message-completed', messageId: 'assistant-policy', transcriptRevision: 2 })
    emitAi({ requestId, type: 'completed' })
    // The confirmed model remains usable without replaying a failed preference.
    expect(screen.getByRole('button', { name: '重试保存设置' })).toBeVisible()
    expect(await screen.findByRole('textbox', { name: '发送消息给 AI' })).toBeVisible()
    expect(screen.getByText('preserve this conversation')).toBeVisible()
    await act(async () => oldRefresh.resolve({ ok: true, value: settings(true, false) }))
    expect(screen.getByRole('textbox', { name: '发送消息给 AI' })).toBeVisible()
    expect(screen.queryByText('正在检查 AI 对话配置…')).not.toBeInTheDocument()
  })

  it('saves live translation controls only to selection settings and keeps the displayed result', async () => {
    const { api, emit } = installTranslationApi({ configured: true })
    let current = settings(true, true)
    current.connections[0] = { ...current.connections[0]!, provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-v4-pro' }
    current.selectionTranslation = { ...current.selectionTranslation, thinkingMode: 'disabled', reasoningEffort: 'low' }
    vi.mocked(api.getLargeModelSettings).mockImplementation(async () => ({ ok: true, value: current }))
    api.setSelectionTranslationSettings = vi.fn(async (input) => {
      current = { ...current, selectionTranslation: { ...current.selectionTranslation, ...input } }
      return { ok: true as const, value: modelCommit(current) }
    })
    api.setScreenshotTranslationSettings = vi.fn()
    renderPane('note.md')
    reportSelection({ ...selection('# Whole document', 'visual', 180), scope: 'document' })
    fireEvent.click(screen.getByRole('button', { name: '全文翻译' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
    emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'Preserved translation' })
    emit({ requestId: REQUEST_ONE, type: 'completed' })
    fireEvent.click(await screen.findByRole('switch', { name: '翻译思考' }))
    await waitFor(() => expect(api.setSelectionTranslationSettings).toHaveBeenCalledWith(expect.objectContaining({
      thinkingMode: 'enabled',
    }), expect.objectContaining({ observation: expect.objectContaining({ revision: 1 }) })))
    expect(api.setScreenshotTranslationSettings).not.toHaveBeenCalled()
    expect(screen.getByText('Preserved translation')).toBeVisible()
  })

  it.each(['source', 'visual'] as const)('keeps %s Markdown unchanged when document translation is stopped and late output arrives', async (mode) => {
    const { api, emit } = installTranslationApi()
    const onChange = vi.fn()
    renderPane('note.md', () => undefined, onChange)
    if (mode === 'source') toggleMode()
    reportSelection({ ...selection('# Whole document', mode, 180), scope: 'document' })
    fireEvent.click(screen.getByRole('button', { name: '全文翻译' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
    emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'partial document output' })
    fireEvent.click(screen.getByRole('button', { name: '停止翻译' }))
    emit({ requestId: REQUEST_ONE, type: 'delta', delta: ' forbidden late document output' })
    emit({ requestId: REQUEST_ONE, type: 'completed' })
    expect(screen.queryByText(/forbidden late document output/)).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    expect(api.cancelTranslation).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('waits for confirmed AI configuration before submitting a structured visual-code explanation', async () => {
    const configuration = deferred<ApiResult<LargeModelSettings>>()
    const { api } = installTranslationApi({ configured: true })
    vi.mocked(api.getLargeModelSettings).mockReturnValueOnce(configuration.promise)
    function Harness() {
      const [rightSidebarState, setRightSidebarState] = useState({
        activeTab: 'translation' as 'translation' | 'ai-chat' | 'document-view',
        open: false,
      })
      return <EditorPane modelPreferences={modelPreferences}
        documentKey="note.md"
        markdown="# Note"
        onChange={vi.fn()}
        onOpenLargeModelSettings={() => undefined}
        onOpenRightSidebar={(activeTab) => setRightSidebarState({ activeTab, open: true })}
        rightSidebarState={rightSidebarState}
      />
    }
    render(<Harness />)

    act(() => editorBridge.codeExplanation?.({
      language: 'ts',
      code: 'const value = 1',
    }))

    expect(api.startAiConversation).not.toHaveBeenCalled()
    expect(await screen.findByRole('status')).toHaveTextContent('正在检查 AI 对话配置')

    configuration.resolve({ ok: true, value: settings(true, true) })
    await waitFor(() => expect(api.startAiConversation).toHaveBeenCalledWith(expect.objectContaining({
      workspaceKey: '__workspace-unavailable__',
      acknowledgedTranscriptRevision: 0,
      capabilities: { currentDocument: true, workspace: true },
      writePolicy: 'ask-every-time',
      messages: [expect.objectContaining({
        role: 'user',
        content: expect.stringMatching(/```ts\s+const value = 1\s+```/u),
      })],
    })))
  })

  it('drops a pending code explanation when the document changes during configuration', async () => {
    const configuration = deferred<ApiResult<LargeModelSettings>>()
    const { api } = installTranslationApi({ configured: true })
    vi.mocked(api.getLargeModelSettings).mockReturnValueOnce(configuration.promise)
    function Harness() {
      const [documentKey, setDocumentKey] = useState('one.md')
      const [rightSidebarState, setRightSidebarState] = useState({
        activeTab: 'translation' as 'translation' | 'ai-chat' | 'document-view',
        open: false,
      })
      return <>
        <button onClick={() => setDocumentKey('two.md')} type="button">切换文档</button>
        <EditorPane modelPreferences={modelPreferences}
          documentKey={documentKey}
          markdown={documentKey === 'one.md' ? '# One' : '# Two'}
          onChange={vi.fn()}
          onOpenLargeModelSettings={() => undefined}
          onOpenRightSidebar={(activeTab) => setRightSidebarState({ activeTab, open: true })}
          rightSidebarState={rightSidebarState}
        />
      </>
    }
    render(<Harness />)

    act(() => editorBridge.codeExplanation?.({
      language: 'ts',
      code: 'const belongsToOne = true',
    }))
    expect(await screen.findByRole('status')).toHaveTextContent('正在检查 AI 对话配置')

    fireEvent.click(screen.getByRole('button', { name: '切换文档' }))
    configuration.resolve({ ok: true, value: settings(true, true) })
    await act(async () => configuration.promise)

    expect(screen.getByTestId('visual-editor')).toHaveTextContent('# Two')
    expect(api.startAiConversation).not.toHaveBeenCalled()
  })

  it('preserves history but clears stale error through a real keyed EditorPane remount', async () => {
    const { emitAi, startAiConversation } = installTranslationApi({ configured: true })
    function Harness() {
      const [mounted, setMounted] = useState(true)
      const [store] = useState(createAiConversationStore)
      return <>
        <button onClick={() => setMounted((current) => !current)} type="button">
          {mounted ? '进入加载' : '返回文档'}
        </button>
        {mounted && <EditorPane modelPreferences={modelPreferences}
          key="note.md"
          aiConversationStore={store}
          documentKey="note.md"
          markdown="# Note"
          onChange={vi.fn()}
          onOpenLargeModelSettings={() => undefined}
          onOpenRightSidebar={() => undefined}
          rightSidebarState={{ activeTab: 'ai-chat', open: true }}
        />}
      </>
    }
    render(<Harness />)
    const composer = await screen.findByRole('textbox', { name: '发送消息给 AI' })
    fireEvent.change(composer, { target: { value: 'remember me' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(startAiConversation).toHaveBeenCalledOnce())
    const requestId = (startAiConversation.mock.lastCall?.[0] as { requestId: string }).requestId
    emitAi({
      requestId,
      type: 'failed',
      code: 'OPERATION_FAILED',
      message: 'temporary failure',
    })
    expect(screen.getByRole('alert')).toHaveTextContent('temporary failure')

    fireEvent.click(screen.getByRole('button', { name: '进入加载' }))
    fireEvent.click(screen.getByRole('button', { name: '返回文档' }))

    expect(await screen.findByText('remember me')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('activates and rebinds an open AI sidebar from confirmed cross-window snapshots', async () => {
    installTranslationApi({ configured: false })
    const store = createAiConversationStore()
    const session = activateWorkspaceAiSession(store, {
      workspaceId: '__workspace-unavailable__', workspaceGeneration: '__workspace-unavailable__',
    })
    render(<EditorPane modelPreferences={modelPreferences} aiConversationStore={store}
      documentKey="note.md" markdown="# Note" onChange={vi.fn()}
      onOpenLargeModelSettings={() => undefined}
      rightSidebarState={{ activeTab: 'ai-chat', open: true }} />)
    await waitFor(() => expect(modelPreferences.getSnapshot().observed).toBeDefined())
    expect(screen.queryByRole('textbox', { name: '发送消息给 AI' })).not.toBeInTheDocument()
    const first = settings(true, true)
    first.connections[0] = { ...first.connections[0]!, modelId: 'gpt-5',
      capabilityOverride: { contextWindowTokens: 128_000 } }
    act(() => modelPreferences.accept(modelObservation(first, 2)))
    const composer = await screen.findByRole('textbox', { name: '发送消息给 AI' })
    fireEvent.change(composer, { target: { value: 'UNSENT-MUST-STAY' } })
    expect(session.modelProfileFingerprint).toContain('gpt-5')
    expect(session.contextWindowTokens).toBe(128_000)
    const second = structuredClone(first)
    second.connections[0]!.modelId = 'gpt-5-mini'
    second.connections[0]!.capabilityOverride = { contextWindowTokens: 256_000 }
    second.aiConversation.writePolicy = 'workspace-grant'
    act(() => modelPreferences.accept(modelObservation(second, 3)))
    await waitFor(() => expect(session.modelProfileFingerprint).toContain('gpt-5-mini'))
    expect(session.contextWindowTokens).toBe(256_000)
    expect(screen.getByRole('textbox', { name: '发送消息给 AI' })).toHaveValue('UNSENT-MUST-STAY')
  })

  it('derives context-window usage from the configured AI model profile', async () => {
    const { api, emitAi, startAiConversation } = installTranslationApi({ configured: true })
    const configured = settings(true, true)
    configured.connections[0] = {
      ...configured.connections[0]!,
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-v4-pro',
    }
    vi.mocked(api.getLargeModelSettings).mockResolvedValue({ ok: true, value: configured })
    render(<EditorPane modelPreferences={modelPreferences}
      documentKey="note.md"
      markdown="# Note"
      onChange={vi.fn()}
      onOpenLargeModelSettings={() => undefined}
      onOpenRightSidebar={() => undefined}
      rightSidebarState={{ activeTab: 'ai-chat', open: true }}
    />)

    const composer = await screen.findByRole('textbox', { name: '发送消息给 AI' })
    fireEvent.change(composer, { target: { value: '继续' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(startAiConversation).toHaveBeenCalledOnce())
    const requestId = (startAiConversation.mock.lastCall?.[0] as { requestId: string }).requestId
    emitAi({
      requestId,
      type: 'message-start',
      messageId: 'assistant-usage',
      previousTranscriptRevision: 1,
    })
    emitAi({
      requestId,
      type: 'usage',
      usage: {
        inputTokens: 20_000,
        outputTokens: 3_410,
        totalTokens: 23_410,
        cachedInputTokens: null,
        estimated: false,
      },
    })

    expect(await screen.findByText('2% · 23,410 / 1,048,576')).toBeVisible()
  })

  it('revokes document access and old usage when the configured AI connection changes', async () => {
    const { api } = installTranslationApi({ configured: true })
    const firstProfile = settings(true, true)
    firstProfile.connections[0] = {
      ...firstProfile.connections[0]!,
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-v4-pro',
      capabilityOverride: { contextWindowTokens: 128_000 },
    }
    const secondProfile = settings(true, true)
    secondProfile.connections[0] = {
      ...secondProfile.connections[0]!,
      id: '22222222-2222-4222-8222-222222222222',
      provider: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com',
      modelId: 'qwen3.8-max',
      capabilityOverride: { contextWindowTokens: 256_000 },
    }
    secondProfile.aiConversation.connectionId = secondProfile.connections[0]!.id
    secondProfile.selectionTranslation.connectionId = secondProfile.connections[0]!.id
    vi.mocked(api.getModelSettingsSnapshot)
      .mockResolvedValueOnce({ ok: true, value: modelObservation(firstProfile, 1) })
      .mockResolvedValueOnce({ ok: true, value: modelObservation(secondProfile, 2) })
    const store = createAiConversationStore()
    const session = activateWorkspaceAiSession(store, {
      workspaceId: '__workspace-unavailable__',
      workspaceGeneration: '__workspace-unavailable__',
    })
    session.messages = [{ id: 'user-kept', role: 'user', content: '保留的对话' }]
    session.capabilities = { currentDocument: true, workspace: true }
    session.usage = {
      inputTokens: 23_000, outputTokens: 410, totalTokens: 23_410,
      cachedInputTokens: null, estimated: false,
    }

    const view = render(<EditorPane modelPreferences={modelPreferences}
      aiConversationStore={store}
      documentKey="note.md"
      markdown="# Note"
      onChange={vi.fn()}
      onOpenLargeModelSettings={() => undefined}
      onOpenRightSidebar={() => undefined}
      rightSidebarState={{ activeTab: 'ai-chat', open: true }}
      translationSettingsRevision={0}
    />)
    expect(await screen.findByRole('button', { name: '让 AI 查看文档' })).toBeVisible()
    expect(session.modelProfileFingerprint).toContain('deepseek-v4-pro')

    view.rerender(<EditorPane modelPreferences={modelPreferences}
      aiConversationStore={store}
      documentKey="note.md"
      markdown="# Note"
      onChange={vi.fn()}
      onOpenLargeModelSettings={() => undefined}
      onOpenRightSidebar={() => undefined}
      rightSidebarState={{ activeTab: 'ai-chat', open: true }}
      translationSettingsRevision={1}
    />)

    expect(await screen.findByRole('button', { name: '让 AI 查看文档' })).toBeVisible()
    await waitFor(() => expect(session.modelProfileFingerprint).toContain('qwen3.8-max'))
    expect(screen.queryByText(/23,410/u)).not.toBeInTheDocument()
    expect(screen.getByText('保留的对话')).toBeVisible()
  })

  it('treats protocol, capability overrides, and reasoning effort as AI profile identity', async () => {
    const { api } = installTranslationApi({ configured: true })
    const firstProfile = settings(true, true)
    firstProfile.connections[0] = {
      ...firstProfile.connections[0]!,
      baseUrl: 'https://api.example.invalid',
      modelId: 'same-model',
      capabilityOverride: { contextWindowTokens: 128_000, maxOutputTokens: 8_000 },
    }
    const secondProfile = settings(true, true)
    secondProfile.connections[0] = {
      ...secondProfile.connections[0]!,
      protocol: 'anthropic',
      baseUrl: 'https://api.example.invalid',
      modelId: 'same-model',
      capabilityOverride: { contextWindowTokens: 256_000, maxOutputTokens: 16_000 },
    }
    secondProfile.aiConversation.reasoningEffort = 'high'
    vi.mocked(api.getModelSettingsSnapshot)
      .mockResolvedValueOnce({ ok: true, value: modelObservation(firstProfile, 1) })
      .mockResolvedValueOnce({ ok: true, value: modelObservation(secondProfile, 2) })
    const store = createAiConversationStore()
    const session = activateWorkspaceAiSession(store, {
      workspaceId: '__workspace-unavailable__',
      workspaceGeneration: '__workspace-unavailable__',
    })
    session.messages = [{ id: 'kept', role: 'assistant', content: 'completed transcript' }]
    session.capabilities = { currentDocument: true, workspace: true }
    session.usage = {
      inputTokens: 100, outputTokens: 20, totalTokens: 120,
      cachedInputTokens: null, estimated: false,
    }

    const view = render(<EditorPane modelPreferences={modelPreferences}
      aiConversationStore={store}
      documentKey="note.md"
      markdown="# Note"
      onChange={vi.fn()}
      onOpenLargeModelSettings={() => undefined}
      onOpenRightSidebar={() => undefined}
      rightSidebarState={{ activeTab: 'ai-chat', open: true }}
      translationSettingsRevision={0}
    />)
    await screen.findByRole('button', { name: '让 AI 查看文档' })

    view.rerender(<EditorPane modelPreferences={modelPreferences}
      aiConversationStore={store}
      documentKey="note.md"
      markdown="# Note"
      onChange={vi.fn()}
      onOpenLargeModelSettings={() => undefined}
      onOpenRightSidebar={() => undefined}
      rightSidebarState={{ activeTab: 'ai-chat', open: true }}
      translationSettingsRevision={1}
    />)

    expect(await screen.findByRole('button', { name: '让 AI 查看文档' })).toBeVisible()
    await waitFor(() => expect(session.modelProfileFingerprint).toContain('anthropic'))
    expect(session.modelProfileFingerprint).toContain('high')
    expect(session.modelProfileFingerprint).toContain('256000')
    expect(screen.getByText('completed transcript')).toBeVisible()
    expect(screen.queryByText(/120/u)).not.toBeInTheDocument()
  })

  it('refreshes a previously configured preflight before submitting a code explanation', async () => {
    const { api } = installTranslationApi({ configured: true })
    const freshConfiguration = deferred<ApiResult<LargeModelSettings>>()
    render(<EditorPane modelPreferences={modelPreferences}
      documentKey="note.md"
      markdown="# Note"
      onChange={vi.fn()}
      onOpenLargeModelSettings={() => undefined}
      onOpenRightSidebar={() => undefined}
      rightSidebarState={{ activeTab: 'ai-chat', open: true }}
    />)
    await screen.findByRole('textbox', { name: '发送消息给 AI' })
    vi.mocked(api.getLargeModelSettings).mockReturnValueOnce(freshConfiguration.promise)

    act(() => editorBridge.codeExplanation?.({ language: 'ts', code: 'const fresh = true' }))

    expect(api.startAiConversation).not.toHaveBeenCalled()
    expect(await screen.findByRole('status')).toHaveTextContent('正在检查 AI 对话配置')
    freshConfiguration.resolve({ ok: true, value: settings(true, true) })
    await waitFor(() => expect(api.startAiConversation).toHaveBeenCalledOnce())
  })

  it('distinguishes a settings read failure and retries configuration', async () => {
    const { api } = installTranslationApi({ configured: true })
    vi.mocked(api.getLargeModelSettings).mockResolvedValueOnce(apiFailure('settings unavailable'))
    render(<EditorPane modelPreferences={modelPreferences}
      documentKey="note.md"
      markdown="# Note"
      onChange={vi.fn()}
      onOpenLargeModelSettings={() => undefined}
      onOpenRightSidebar={() => undefined}
      rightSidebarState={{ activeTab: 'ai-chat', open: true }}
    />)

    expect(await screen.findByRole('status')).toHaveTextContent('无法检查 AI 对话配置')
    vi.mocked(api.getLargeModelSettings).mockResolvedValueOnce({
      ok: true,
      value: settings(true, true),
    })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    expect(await screen.findByRole('textbox', { name: '发送消息给 AI' })).toBeVisible()
  })

  it('retains a pending code explanation through settings failure and retry', async () => {
    const { api, startAiConversation } = installTranslationApi({ configured: true })
    vi.mocked(api.getLargeModelSettings).mockResolvedValueOnce(apiFailure('settings unavailable'))
    function Harness() {
      const [rightSidebarState, setRightSidebarState] = useState({
        activeTab: 'translation' as 'translation' | 'ai-chat' | 'document-view',
        open: false,
      })
      return <EditorPane modelPreferences={modelPreferences}
        documentKey="note.md"
        markdown="# Note"
        onChange={vi.fn()}
        onOpenLargeModelSettings={() => undefined}
        onOpenRightSidebar={(activeTab) => setRightSidebarState({ activeTab, open: true })}
        rightSidebarState={rightSidebarState}
      />
    }
    render(<Harness />)

    act(() => editorBridge.codeExplanation?.({
      language: 'ts',
      code: 'const retryMe = true',
    }))
    expect(await screen.findByRole('status')).toHaveTextContent('无法检查 AI 对话配置')
    vi.mocked(api.getLargeModelSettings).mockResolvedValueOnce({
      ok: true,
      value: settings(true, true),
    })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    await waitFor(() => expect(api.startAiConversation).toHaveBeenCalledOnce())
    expect(startAiConversation.mock.lastCall?.[0].messages.at(-1)?.content)
      .toMatch(/```ts\s+const retryMe = true\s+```/u)
  })

  it('does not submit a code explanation when AI configuration is unconfigured', async () => {
    const { api } = installTranslationApi({ configured: false })
    function Harness() {
      const [rightSidebarState, setRightSidebarState] = useState({
        activeTab: 'translation' as 'translation' | 'ai-chat' | 'document-view',
        open: false,
      })
      return <EditorPane modelPreferences={modelPreferences}
        documentKey="note.md"
        markdown="# Note"
        onChange={vi.fn()}
        onOpenLargeModelSettings={() => undefined}
        onOpenRightSidebar={(activeTab) => setRightSidebarState({ activeTab, open: true })}
        rightSidebarState={rightSidebarState}
      />
    }
    render(<Harness />)

    act(() => editorBridge.codeExplanation?.({ language: 'ts', code: 'let unsafe = true' }))

    expect(await screen.findByRole('button', { name: '前往配置' })).toBeVisible()
    expect(api.startAiConversation).not.toHaveBeenCalled()
  })

  it('rejects an oversized code explanation without poisoning the next chat turn', async () => {
    const { api, startAiConversation } = installTranslationApi({ configured: true })
    render(<EditorPane modelPreferences={modelPreferences}
      documentKey="note.md"
      markdown="# Note"
      onChange={vi.fn()}
      onOpenLargeModelSettings={() => undefined}
      onOpenRightSidebar={() => undefined}
      rightSidebarState={{ activeTab: 'ai-chat', open: true }}
    />)
    await screen.findByRole('textbox', { name: '发送消息给 AI' })

    act(() => editorBridge.codeExplanation?.({
      language: 'ts',
      code: 'x'.repeat(AI_CONVERSATION_MESSAGE_MAX_CHARS),
    }))

    expect(await screen.findByRole('alert')).toHaveTextContent('48,000')
    expect(api.startAiConversation).not.toHaveBeenCalled()

    fireEvent.change(screen.getByRole('textbox', { name: '发送消息给 AI' }), {
      target: { value: 'short follow-up' },
    })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(api.startAiConversation).toHaveBeenCalledOnce())
    expect(startAiConversation.mock.lastCall?.[0].messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'short follow-up' }),
    ])
  })

  it('keeps a selection translation popover visible while AI chat is open', () => {
    installTranslationApi({ configured: true })
    render(<EditorPane modelPreferences={modelPreferences}
      documentKey="note.md"
      markdown="# Note"
      onChange={vi.fn()}
      onOpenLargeModelSettings={() => undefined}
      onOpenRightSidebar={() => undefined}
      rightSidebarState={{ activeTab: 'ai-chat', open: true }}
    />)

    reportSelection(selection('short selection'))

    expect(screen.getByRole('dialog', { name: '划词翻译' })).toBeVisible()
  })

  it('closes the actual right panel from the unconfigured AI notice', async () => {
    installTranslationApi({ configured: false })
    const close = vi.fn()
    function Harness() {
      const [open, setOpen] = useState(true)
      return <EditorPane modelPreferences={modelPreferences} documentKey="note.md" markdown="# Note" onChange={vi.fn()} onOpenLargeModelSettings={vi.fn()}
        onCloseRightSidebar={() => { close(); setOpen(false) }}
        rightSidebarState={{ activeTab: 'ai-chat', open }} />
    }
    render(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: '暂不' }))
    expect(close).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument())
  })

  it('opens large-model settings from an unconfigured AI chat panel', async () => {
    installTranslationApi({ configured: false })
    const onOpenLargeModelSettings = vi.fn()
    render(<EditorPane modelPreferences={modelPreferences}
      documentKey="note.md"
      markdown="# Note"
      onChange={vi.fn()}
      onOpenLargeModelSettings={onOpenLargeModelSettings}
      onOpenRightSidebar={() => undefined}
      rightSidebarState={{ activeTab: 'ai-chat', open: true }}
    />)

    fireEvent.click(await screen.findByRole('button', { name: '前往配置' }))

    expect(onOpenLargeModelSettings).toHaveBeenCalledOnce()
  })

  it('shrinks only the editor surface, preserves a content-space anchor, cleans observers, and copies only output', async () => {
    const resizeTo = vi.spyOn(window, 'resizeTo').mockImplementation(() => undefined)
    const { api, emit, unsubscribe } = installTranslationApi()
    renderPane()
    const pane = document.querySelector<HTMLElement>('.editor-pane')!
    const surface = document.querySelector<HTMLElement>('.editor-surface')!
    const addListener = vi.spyOn(surface, 'addEventListener')
    const removeListener = vi.spyOn(surface, 'removeEventListener')
    let surfaceTop = 50
    let surfaceScrollTop = 20
    Object.defineProperties(surface, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => 600 },
      scrollTop: {
        configurable: true,
        get: () => surfaceScrollTop,
        set: (value: number) => { surfaceScrollTop = value },
      },
    })
    vi.spyOn(surface, 'getBoundingClientRect').mockImplementation(() => ({
      bottom: surfaceTop + 400,
      height: 400,
      left: 0,
      right: 700,
      top: surfaceTop,
      width: 700,
      x: 0,
      y: surfaceTop,
      toJSON: () => ({}),
    }))
    vi.spyOn(pane, 'getBoundingClientRect').mockImplementation(() => ({
      bottom: 450,
      height: 400,
      left: 0,
      right: 1000,
      top: 50,
      width: 1000,
      x: 0,
      y: 50,
      toJSON: () => ({}),
    }))

    reportSelection(selection('a'.repeat(100), 'visual', 150))
    fireEvent.click(screen.getByRole('button', { name: '翻译选中的文本' }))
    await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
    const sidebar = screen.getByRole('complementary', { name: '右侧栏' })
    const result = screen.getByTestId('translation-sidebar-result')
    vi.spyOn(result, 'getBoundingClientRect').mockImplementation(() => ({
      bottom: 100,
      height: 100,
      left: 0,
      right: 320,
      top: 0,
      width: 320,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }))
    act(() => TestResizeObserver.instances.forEach((observer) => observer.emit()))

    expect(sidebar.parentElement).toHaveClass('editor-right-sidebar-motion-clip')
    expect(sidebar.parentElement?.parentElement)
      .toHaveClass('editor-right-sidebar-motion-track')
    expect(sidebar.parentElement?.parentElement?.parentElement).toBe(pane)
    expect(surface.parentElement).toBe(pane)
    expect(getComputedStyle(pane).display).toBe('flex')
    expect(getComputedStyle(surface).flexGrow).toBe('1')
    expect(result).toHaveStyle({ marginTop: '52px' })

    surfaceScrollTop = 70
    surfaceTop = 60
    fireEvent.scroll(surface)
    act(() => TestResizeObserver.instances.forEach((observer) => observer.emit()))
    expect(result).toHaveStyle({ marginTop: '2px' })

    emit({ requestId: REQUEST_ONE, type: 'delta', delta: 'translated only' })
    emit({ requestId: REQUEST_ONE, type: 'completed' })
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('translated only')
    expect(navigator.clipboard.writeText).toHaveBeenCalledOnce()
    expect(resizeTo).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    finishRightSidebarExit()
    expect(removeListener).toHaveBeenCalledWith('scroll', expect.any(Function))
    expect(TestResizeObserver.instances.every(
      (observer) => observer.disconnect.mock.calls.length === 1,
    )).toBe(true)
    expect(addListener).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true })
    expect(unsubscribe).not.toHaveBeenCalled()
  })

  it('subscribes once per mount and unsubscribes on unmount', () => {
    const { api, unsubscribe } = installTranslationApi()
    const view = renderPane()

    expect(api.onTranslationEvent).toHaveBeenCalledOnce()
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})


it('retains the original inline observation and dirty thinking selection across authoritative focus refresh', async () => {
  const { api } = installTranslationApi({ configured: true })
  const original = settings(true, true)
  original.connections[0] = { ...original.connections[0]!, provider: 'other', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', modelId: 'claude-opus-5' }
  original.aiConversation = { ...original.aiConversation, thinkingMode: 'disabled', reasoningEffort: 'max' }
  api.getModelSettingsSnapshot = vi.fn<ArkdownApi['getModelSettingsSnapshot']>(async () => ({ ok: true, value: modelObservation(original, 2) }))
  api.setAiConversationSettings = vi.fn<ArkdownApi['setAiConversationSettings']>(async () => ({ ok: true, value: {
    status: 'conflict', snapshot: modelObservation(original, 7), reason: 'field-changed', conflicts: [],
  } }))
  const pane = (revision: number) => <EditorPane modelPreferences={modelPreferences} documentKey="note.md" markdown="# Note"
    onChange={vi.fn()} onOpenLargeModelSettings={vi.fn()} translationSettingsRevision={revision}
    rightSidebarState={{ activeTab: 'ai-chat', open: true }} />
  const view = render(pane(0))
  fireEvent.click(await screen.findByRole('combobox', { name: 'AI 对话思考' }))
  fireEvent.click(screen.getByRole('option', { name: '开' }))
  await waitFor(() => expect(api.setAiConversationSettings).toHaveBeenCalledWith({ thinkingMode: 'enabled' }, modelObservation(original, 2)))
  expect(await screen.findByRole('alert')).toHaveTextContent('其他窗口')
  api.getModelSettingsSnapshot = vi.fn<ArkdownApi['getModelSettingsSnapshot']>(async () => ({ ok: true, value: modelObservation(original, 9) }))
  view.rerender(pane(1))
  await waitFor(() => expect(api.getModelSettingsSnapshot).toHaveBeenCalled())
  expect(screen.getByRole('combobox', { name: 'AI 对话思考' })).toHaveTextContent('开')
  expect(modelPreferences.getSnapshot().failedKeys).toEqual(['feature.aiConversation.thinkingMode'])
})

it('blocks actual request admission while sidebar shows a failed different model', async () => {
  const { api } = installTranslationApi({ configured: true })
  const confirmed = settings(true, true)
  const originalId = confirmed.aiConversation.connectionId!
  const second = { ...confirmed.connections[0]!, id: '22222222-2222-4222-8222-222222222222', name: 'Unsaved model B' }
  confirmed.connections.push(second)
  api.getModelSettingsSnapshot = vi.fn<ArkdownApi['getModelSettingsSnapshot']>(async () => ({ ok: true, value: modelObservation(confirmed) }))
  api.setAiConversationSettings = vi.fn(async () => apiFailure('synthetic model save failed'))
  const admissions: string[] = []
  api.startAiConversation = vi.fn(async input => {
    admissions.push(confirmed.aiConversation.connectionId!)
    return { ok: true as const, value: { requestId: input.requestId, modelId: 'model-A', transcriptRevision: 1 } }
  })
  render(<EditorPane modelPreferences={modelPreferences} documentKey="note.md" markdown="# Synthetic note"
    onChange={vi.fn()} onOpenLargeModelSettings={vi.fn()}
    rightSidebarState={{ activeTab: 'ai-chat', open: true }} />)
  fireEvent.click(await screen.findByRole('combobox', { name: 'AI 对话快速模型选择' }))
  fireEvent.click(screen.getByRole('option', { name: 'Unsaved model B' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('synthetic model save failed')
  expect(screen.getByRole('combobox', { name: 'AI 对话快速模型选择' })).toHaveTextContent('Unsaved model B')
  expect(modelPreferences.getSnapshot().observed?.settings.aiConversation.connectionId).toBe(originalId)
  const input = screen.getByRole('textbox', { name: '发送消息给 AI' })
  fireEvent.change(input, { target: { value: 'Synthetic content for selected model B' } })
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); await Promise.resolve() })
  expect(admissions).toEqual([])
})


it.each(['code explanation', 'translation'] as const)('does not admit %s from a feature with a retained failed draft and resumes after explicit reload', async entry => {
  const { api } = installTranslationApi({ configured: true })
  const observed = modelObservation(settings(true, true))
  modelPreferences.accept(observed)
  await modelPreferences.mutate(entry === 'translation' ? 'feature.selectionTranslation.targetLanguage' : 'feature.aiConversation.writePolicy', observed,
    async () => apiFailure('synthetic retained feature failure'), entry === 'translation'
      ? { feature: 'selectionTranslation', patch: { targetLanguage: 'ja' } }
      : { feature: 'aiConversation', patch: { writePolicy: 'workspace-grant' } })
  render(<EditorPane modelPreferences={modelPreferences} documentKey="note.md" markdown="# Synthetic note"
    onChange={vi.fn()} onOpenLargeModelSettings={vi.fn()}
    rightSidebarState={{ activeTab: entry === 'translation' ? 'translation' : 'ai-chat', open: true }} />)
  await screen.findByText('synthetic retained feature failure')
  if (entry === 'translation') {
    reportSelection(selection('Synthetic selection'))
    fireEvent.click(screen.getByRole('button', { name: /翻译选中的文本|翻译选中内容/ }))
  } else act(() => editorBridge.codeExplanation?.({ language: 'ts', code: 'const synthetic = true' }))
  await act(async () => { await Promise.resolve() })
  expect(api.startAiConversation).not.toHaveBeenCalled()
  expect(api.startTranslation).not.toHaveBeenCalled()
  await act(async () => modelPreferences.reload(api))
  if (entry === 'translation') fireEvent.click(screen.getByRole('button', { name: /翻译选中的文本|翻译选中内容/ }))
  await waitFor(() => expect(entry === 'translation' ? api.startTranslation : api.startAiConversation).toHaveBeenCalledOnce())
})

it('keeps budget continuation paused while an AI feature draft failed without disabling an unrelated translation', async () => {
  const { api, emitAi } = installTranslationApi({ configured: true })
  render(<EditorPane modelPreferences={modelPreferences} documentKey="note.md" markdown="# Synthetic note"
    onChange={vi.fn()} onOpenLargeModelSettings={vi.fn()} rightSidebarState={{ activeTab: 'ai-chat', open: true }} />)
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'AI 对话快速模型选择' })).toHaveTextContent('Configured model'))
  const input = await screen.findByRole('textbox', { name: '发送消息给 AI' })
  await waitFor(() => expect(input).toBeEnabled())
  fireEvent.change(input, { target: { value: 'Synthetic first request' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(api.startAiConversation).toHaveBeenCalledOnce())
  const requestId = vi.mocked(api.startAiConversation).mock.calls[0]![0].requestId
  await act(async () => { await Promise.resolve() })
  emitAi({ requestId, type: 'message-start', messageId: STALE_REQUEST, previousTranscriptRevision: 1 })
  emitAi({ requestId, type: 'delta', messageId: STALE_REQUEST, delta: 'Synthetic partial result' })
  emitAi({ requestId, type: 'budget-paused', transcriptRevision: 1, continuationId: REQUEST_TWO, reason: 'read-budget',
    counts: { readAdmitted: 64, writeAdmitted: 1, rejectedNewCalls: 1, toolRounds: 20 },
    outcomes: { readSucceeded: 62, readFailed: 1, readDenied: 1, readUnavailable: 0,
      writeSucceeded: 1, writeFailed: 0, writeDenied: 0, writeUnavailable: 0, writeUnknown: 0, notExecuted: 1 },
    finalization: { status: 'failed', code: 'MODEL_RATE_LIMITED' } })
  await act(async () => { await modelPreferences.mutate('feature.aiConversation.writePolicy', modelObservation(settings(true, true)),
    async () => apiFailure('synthetic policy failure'), { feature: 'aiConversation', patch: { writePolicy: 'workspace-grant' } }) })
  fireEvent.click(await screen.findByRole('button', { name: '继续分析' }))
  await act(async () => { await Promise.resolve() })
  expect(api.startAiConversation).toHaveBeenCalledOnce()
  reportSelection(selection('Unrelated translation'))
  fireEvent.click(screen.getByRole('button', { name: /翻译选中的文本|翻译选中内容/ }))
  await waitFor(() => expect(api.startTranslation).toHaveBeenCalledOnce())
})


it.each(['ai-chat', 'translation'] as const)('resolves an inline %s preference conflict only after explicit retry and preserves input', async tab => {
  const { api } = installTranslationApi({ configured: true })
  const persistence = createPreferencePersistence()
  modelPreferences = new ModelPreferenceDraft(persistence)
  const original = settings(true, true)
  original.connections[0] = { ...original.connections[0]!, provider: 'other', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', modelId: 'claude-opus-5' }
  const feature = tab === 'ai-chat' ? 'aiConversation' : 'selectionTranslation'
  original[feature].thinkingMode = 'disabled'
  let stored = modelObservation(original, 2)
  api.getModelSettingsSnapshot = vi.fn(async () => ({ ok: true as const, value: stored }))
  const revisions: number[] = []
  const save = vi.fn<ArkdownApi['setAiConversationSettings']>(async (patch, observed) => {
    revisions.push(observed.observation.revision)
    if (revisions.length === 1) {
      stored = modelObservation(original, 7)
      return { ok: true, value: { status: 'conflict', snapshot: stored, reason: 'field-changed', conflicts: [] } }
    }
    const saved = structuredClone(original)
    Object.assign(saved[feature], patch)
    stored = modelObservation(saved, 8)
    return { ok: true, value: { status: 'committed', snapshot: stored } }
  })
  if (tab === 'ai-chat') api.setAiConversationSettings = save
  else api.setSelectionTranslationSettings = save
  const openSettings = vi.fn()
  render(<EditorPane modelPreferences={modelPreferences} documentKey="note.md" markdown="# Keep document"
    onChange={vi.fn()} onOpenLargeModelSettings={openSettings}
    rightSidebarState={{ activeTab: tab, open: true }} />)
  if (tab === 'ai-chat') {
    const thinking = await screen.findByRole('combobox', { name: 'AI 对话思考' })
    fireEvent.change(screen.getByRole('textbox', { name: '发送消息给 AI' }), { target: { value: 'Keep unsent message' } })
    fireEvent.click(thinking)
    fireEvent.click(screen.getByRole('option', { name: '开' }))
  } else {
    reportSelection(selection('Keep selected text'))
    fireEvent.click(await screen.findByRole('switch', { name: '翻译思考' }))
  }
  expect(await screen.findByRole('alert')).toHaveTextContent('其他窗口')
  expect(await persistence.drain()).toEqual({ ok: false, failedCategories: ['models'] })
  expect(revisions).toEqual([2])
  fireEvent.click(screen.getByRole('button', { name: '打开设置处理' }))
  expect(openSettings).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '重试保存设置' }))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(revisions).toEqual([2, 7])
  expect(await persistence.drain()).toEqual({ ok: true })
  expect(modelPreferences.getSnapshot().settings?.[feature].thinkingMode).toBe('enabled')
  if (tab === 'ai-chat') expect(screen.getByRole('textbox', { name: '发送消息给 AI' })).toHaveValue('Keep unsent message')
})
