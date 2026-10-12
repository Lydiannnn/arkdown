import { modelObservation, modelCommit } from '../helpers/model-observation'
import { version as packageVersion } from '../../package.json'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type ComponentProps } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClosePreparationBridge } from '../../src/preload/close-preparation'
import type { ClosePreparationAttempt, ClosePreparationEvent } from '../../src/shared/close-preparation'
import type {
  ApiResult,
  ArkdownApi,
  BeginSaveDocumentAsResult,
  CommitSaveDocumentAsResult,
  DocumentSnapshot,
  ExportDocxInput,
  ImportedAsset,
} from '../../src/shared/contracts'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import { DEFAULT_ARKNOTE_PREFERENCES } from '../../src/shared/arknote-preferences'
import { copyStickyNoteWallpaperAppearances } from '../../src/shared/sticky-note-glass-appearance'
import type { PreferencesPageProps } from '../../src/renderer/settings/PreferencesPage'
import type { BrowserSearchPreferences } from '../../src/shared/search-preferences'
import type { PublicPreferenceSnapshot } from '../../src/shared/preference-observation'
import {
  DEFAULT_EDITOR_APPEARANCE,
  type EditorAppearanceSnapshot,
} from '../../src/shared/editor-appearance-preferences'
import type { MermaidAppearance } from '../../src/renderer/editor/mermaid/mermaid-types'
import { DEFAULT_LAYOUT_PREFERENCES, type LayoutPreferencesSnapshot } from '../../src/shared/layout-preferences'
import type { AiConversationStore } from '../../src/renderer/editor/use-ai-conversation'
import { choosePreferencesOption } from './preferences-select-test-helpers'
import { stickyNoteApiStubs } from './sticky-note-api-stubs'
import {
  buildApplicationMenuModel,
  type ApplicationMenuSection,
} from '../../src/shared/application-menu-model'
import { ContextMenuProvider } from '../../src/renderer/context-menu/ContextMenuProvider'
import { registerVisualDropRequest } from '../../src/renderer/editor/visual-drop-insertion'
import { encodeWorkspaceDrag, WORKSPACE_ENTRY_MIME } from '../../src/renderer/workspace/workspace-drag'

let prepareClose: () => Promise<boolean> = async () => true
let recoveryHandler: ((intent: import('../../src/shared/contracts').RecoveryIntent) => void) | null = null
let menuCommand: ((command: import('../../src/shared/menu-commands').MenuCommand) => void) | null = null
let applicationMenuChanged: ((model: readonly ApplicationMenuSection[]) => void) | null = null
let editorAppearanceChanged: ((snapshot: EditorAppearanceSnapshot) => void) | null = null
let layoutPreferencesChanged: ((snapshot: LayoutPreferencesSnapshot) => void) | null = null
let windowStateChanged: ((state: { maximized: boolean; fullscreen: boolean; revision: number }) => void) | null = null
let currentWindowState = { maximized: false, fullscreen: false, revision: 0 }
const workspace = { name: 'Notes', absolutePath: 'C:/Notes' }
const revisionA = 'a'.repeat(64)

function saveAsIntent(
  targetWorkspace = workspace,
  changesWorkspace = false,
): BeginSaveDocumentAsResult {
  return {
    intentId: '123e4567-e89b-42d3-a456-426614174222',
    targetWorkspace,
    targetFileName: 'saved.md',
    targetRelativePath: 'saved.md',
    changesWorkspace,
  }
}

function committedSaveAs(
  targetWorkspace = workspace,
  changesWorkspace = false,
): CommitSaveDocumentAsResult {
  return {
    workspace: targetWorkspace,
    document: {
      relativePath: 'saved.md', markdown: '# Changed', revision: revisionA,
      encoding: 'utf8', newline: 'lf', mtimeMs: 2,
    },
    changesWorkspace,
    aiWorkspace: {
      workspaceId: changesWorkspace ? 'workspace-other' : 'workspace-notes',
      workspaceGeneration: changesWorkspace ? 'generation-7' : 'generation-1',
    },
  }
}

function twoPhaseSaveAsApi(
  committed: CommitSaveDocumentAsResult,
): Pick<ArkdownApi, 'beginSaveDocumentAs' | 'commitSaveDocumentAs' | 'abortSaveDocumentAs'> {
  const targetRelativePath = committed.document.relativePath
  const intent: BeginSaveDocumentAsResult = {
    ...saveAsIntent(committed.workspace, committed.changesWorkspace),
    targetFileName: targetRelativePath.split('/').at(-1) ?? targetRelativePath,
    targetRelativePath,
  }
  return {
    beginSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: intent })),
    commitSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: committed })),
    abortSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: null })),
  }
}

function appearanceSnapshot(
  appearance = DEFAULT_EDITOR_APPEARANCE,
  revision = 0,
): EditorAppearanceSnapshot {
  return { appearance, revision }
}

function observedAppearance(revision = 1): PublicPreferenceSnapshot<'appearance'> {
  return { group: 'appearance', values: { ...DEFAULT_EDITOR_APPEARANCE },
    observation: { version: 1, revision, minimumBaseRevision: 0, fields: { bodyLatinFont: revision, spellCheckEnabled: revision } } }
}

function installObservedPreferences() {
  let appearance = observedAppearance()
  const search: PublicPreferenceSnapshot<'search'> = { group: 'search', values: { provider: 'bing', customTemplate: '' },
    observation: { version: 1, revision: 1, minimumBaseRevision: 0, fields: {} } }
  const layout: PublicPreferenceSnapshot<'layout'> = { group: 'layout', values: { leftSidebarWidth: 300, rightSidebarWidth: 530 },
    observation: { version: 1, revision: 1, minimumBaseRevision: 0, fields: {} } }
  const patch = vi.fn<NonNullable<ArkdownApi['patchPreferences']>>(async input => {
    if (input.observed.group === 'appearance') return { ok: true, value: { status: 'conflict', snapshot: appearance, reason: 'field-changed', fields: [] } }
    if (input.observed.group === 'search') return { ok: true, value: { status: 'conflict', snapshot: search, reason: 'field-changed', fields: [] } }
    return { ok: true, value: { status: 'conflict', snapshot: layout, reason: 'field-changed', fields: [] } }
  })
  installApi({ getPreferenceSnapshot: vi.fn(async group => ({ ok: true as const,
    value: group === 'appearance' ? appearance : group === 'search' ? search : layout })), patchPreferences: patch,
    getLargeModelSettings: vi.fn(async () => ({ ok: true as const, value: DEFAULT_LARGE_MODEL_SETTINGS })),
    getSystemFonts: vi.fn(async () => ({ ok: true as const, value: ['Arial', 'Calibri'] })),
  })
  return { patch, layout, search, remote: () => { appearance = observedAppearance(3); appearance.values.bodyLatinFont = 'Calibri' } }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

const structuredCloseBridges: Array<{ dispose(): void }> = []
afterEach(() => { structuredCloseBridges.splice(0).forEach(bridge => bridge.dispose()) })
function installStructuredCloseApi(overrides: Partial<ArkdownApi> = {}) {
  const events: ClosePreparationEvent[] = []
  let receive!: (request: unknown) => void
  let release!: (attempt: ClosePreparationAttempt) => void
  const bridge = createClosePreparationBridge({ transport: {
    subscribe: listener => { receive = listener; return () => {} },
    send: event => { events.push(event) },
  } })
  structuredCloseBridges.push(bridge)
  installApi({ ...overrides, onPrepareCloseStructured: handler => bridge.setHandler(handler),
    onClosePreparationReleased: handler => { release = handler; return () => {} } })
  const request = { attemptId: '123e4567-e89b-42d3-a456-426614174001', generation: 1,
    requestId: '123e4567-e89b-42d3-a456-426614174002' }
  return { events, request, start: () => receive(request),
    release: (attempt = request) => release({ attemptId: attempt.attemptId, generation: attempt.generation }),
    result: () => events.find(event => event.type === 'result') }
}
const editorModeBridge = vi.hoisted(() => ({
  report: null as ((mode: 'visual' | 'source') => void) | null,
}))
const editorFlushBridge = vi.hoisted(() => ({
  lockMarkdown: null as string | null,
  pendingMarkdown: null as string | null,
}))
const editorDropBridge = vi.hoisted(() => ({
  insert: vi.fn(() => true),
  insertMarkdown: vi.fn(() => true),
}))
const editorChangeBridge = vi.hoisted(() => ({
  registrations: [] as Array<{ documentKey: string; onChange(markdown: string): void }>,
}))
const editorInstanceBridge = vi.hoisted(() => ({
  mounts: 0,
  stores: [] as AiConversationStore[],
  aiBindings: [] as Array<{
    documentKey: string
    workspaceId: string
    workspaceGeneration: string
  }>,
}))
const editIndicatorModelBridge = vi.hoisted(() => ({
  inputs: [] as Array<{
    documentKey: string
    openingMarkdown: string
    savedMarkdown: string
    currentMarkdown: string
    enabled: boolean
  }>,
  implementation: null as null | ((input: {
    documentKey: string
    openingMarkdown: string
    savedMarkdown: string
    currentMarkdown: string
    enabled: boolean
  }) => {
    lineStates: readonly ('none' | 'saved' | 'unsaved')[]
    status: 'idle' | 'computing' | 'ready' | 'failed'
    markdownVersion: number
    modelVersion: number
  }),
}))
const translationHistoryPortBridge = vi.hoisted(() => ({
  first: null as import('../../src/renderer/editor/translation-history').TranslationHistoryWindowPort | null,
  latest: null as import('../../src/renderer/editor/translation-history').TranslationHistoryWindowPort | null,
  nextRequest: 0,
  navigate: null as null | ((recordId: string, alignment?: 'nearest' | 'center') => void),
  ready: null as null | ((documentKey: string, mode: 'visual' | 'source') => void),
  reveal: vi.fn(() => true),
  flushAnchors: vi.fn(() => [] as import('../../src/renderer/editor/translation-history').TranslationHistoryAnchorUpdate[]),
}))
const preferencesPageBridge = vi.hoisted(() => ({
  props: null as PreferencesPageProps | null,
  initialTarget: null as null | import('../../src/renderer/settings/preferences-open-target').PreferencesOpenTarget,
}))
const workspaceSidebarBridge = vi.hoisted(() => ({
  lastRefreshVersion: null as number | null,
  refreshVersions: [] as number[],
  observe(refreshVersion: number) {
    if (this.lastRefreshVersion === refreshVersion) return
    this.lastRefreshVersion = refreshVersion
    this.refreshVersions.push(refreshVersion)
  },
}))
const mermaidAppearanceBridge = vi.hoisted(() => ({
  values: [] as MermaidAppearance[],
}))

const modelApiFailure = async () => ({
  ok: false as const,
  error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
})

vi.mock('../../src/renderer/editor/edit-indicators/use-edit-indicator-model', () => ({
  useEditIndicatorModel: (input: (typeof editIndicatorModelBridge.inputs)[number]) => {
    editIndicatorModelBridge.inputs.push(input)
    return editIndicatorModelBridge.implementation?.(input) ?? {
      lineStates: [],
      status: 'idle',
      markdownVersion: 0,
      modelVersion: 0,
    }
  },
}))

vi.mock('../../src/renderer/editor/EditorPane', () => ({
  EditorPane: forwardRef<
    {
      flush: () => string | null
      insertDroppedLink(input: {
        absolutePath: string
        clientX: number
        clientY: number
        kind: 'file' | 'folder'
        visualDropRequestId?: number
      }): boolean
      insertDroppedMarkdown(input: {
        markdown: string
        clientX: number
        clientY: number
        visualDropRequestId?: number
      }): boolean
      revealTranslationHistoryRecord(recordId: string, alignment?: 'nearest' | 'center'): boolean
      flushTranslationHistoryAnchors(): readonly import('../../src/renderer/editor/translation-history').TranslationHistoryAnchorUpdate[]
    },
    {
      documentAbsolutePath: string | null
      documentLocation?: import('../../src/shared/document-view').DocumentLocationIntent | null
      documentDisplayName?: string
      documentSourceFormat?: string
      documentDirty?: boolean
      aiConversationStore?: AiConversationStore
      aiWorkspace?: import('../../src/shared/contracts').AiWorkspaceState | null
      documentKey: string
      markdown: string
      interactionLocked?: boolean
      spellCheckEnabled: boolean
      editIndicatorModel?: {
        lineStates: readonly ('none' | 'saved' | 'unsaved')[]
        status: string
      }
      showEditIndicators?: boolean
      editorTheme?: 'minimal'
      mermaidAppearance?: MermaidAppearance
      zoomPercent: number
      onChange: (markdown: string) => void
      onModeChange?: (mode: 'visual' | 'source') => void
      onOpenLargeModelSettings(): void
      translationHistory: import('../../src/renderer/editor/translation-history').TranslationHistoryWindowPort
      translationHistoryRecords: readonly import('../../src/renderer/editor/translation-history').TranslationHistoryRecord[]
      translationHistoryIdentity: {
        workspaceAbsolutePath: string | null
        documentRelativePath: string | null
        documentRevision: string | null
      }
      initialMode?: 'visual' | 'source'
      initialTranslationHistoryRecordId?: string | null
      onNavigateTranslationHistoryRecord?(recordId: string, alignment?: 'nearest' | 'center'): void
      onTranslationHistoryReady?(documentKey: string, mode: 'visual' | 'source'): void
      rightSidebarState: import('../../src/renderer/editor/EditorRightSidebar').EditorRightSidebarState
      rightSidebarWidth?: number
      onOpenRightSidebar?(tab: import('../../src/renderer/editor/EditorRightSidebar').EditorRightSidebarTab): void
      onCloseRightSidebar?(): void
      onRightSidebarWidthChange?(width: number): void
      translationSettingsRevision?: number
    }
  >(function TestEditor({
    interactionLocked = false,
    documentAbsolutePath,
    documentLocation,
    documentDisplayName,
    documentSourceFormat,
    documentDirty,
    aiConversationStore,
    aiWorkspace,
    documentKey,
    markdown,
    spellCheckEnabled,
    editIndicatorModel = { lineStates: [], status: 'idle' },
    showEditIndicators = false,
    editorTheme,
    mermaidAppearance,
    zoomPercent,
    onChange,
    onModeChange,
    onOpenLargeModelSettings,
    translationHistory,
    translationHistoryRecords,
    translationHistoryIdentity,
    initialMode = 'visual',
    onNavigateTranslationHistoryRecord,
    onTranslationHistoryReady,
    rightSidebarState,
    rightSidebarWidth,
    onOpenRightSidebar,
    onRightSidebarWidthChange,
    translationSettingsRevision = 0,
  }, ref) {
    const [instanceId] = useState(() => {
      if (aiConversationStore) editorInstanceBridge.stores.push(aiConversationStore)
      return ++editorInstanceBridge.mounts
    })
    const [translationUnconfigured, setTranslationUnconfigured] = useState(false)
    const onChangeRef = useRef(onChange)
    onChangeRef.current = onChange
    editorModeBridge.report = onModeChange ?? null
    translationHistoryPortBridge.first ??= translationHistory
    translationHistoryPortBridge.latest = translationHistory
    translationHistoryPortBridge.navigate = onNavigateTranslationHistoryRecord ?? null
    translationHistoryPortBridge.ready = onTranslationHistoryReady ?? null
    if (mermaidAppearance) mermaidAppearanceBridge.values.push(mermaidAppearance)
    useLayoutEffect(() => {
      editorChangeBridge.registrations.push({ documentKey, onChange })
    }, [documentKey, onChange])
    useLayoutEffect(() => {
      editorInstanceBridge.aiBindings.push({
        documentKey,
        workspaceId: aiWorkspace?.workspaceId ?? '',
        workspaceGeneration: aiWorkspace?.workspaceGeneration ?? '',
      })
    }, [aiWorkspace?.workspaceGeneration, aiWorkspace?.workspaceId, documentKey])
    useLayoutEffect(() => {
      queueMicrotask(() => onTranslationHistoryReady?.(documentKey, initialMode))
    }, [documentKey, initialMode, onTranslationHistoryReady])
    useLayoutEffect(() => {
      if (!interactionLocked) return
      const markdown = editorFlushBridge.lockMarkdown
      editorFlushBridge.lockMarkdown = null
      if (markdown !== null) onChangeRef.current(markdown)
    }, [interactionLocked])
    useImperativeHandle(ref, () => ({
      flush: () => {
        const pendingMarkdown = editorFlushBridge.pendingMarkdown
        if (pendingMarkdown === null) return null
        editorFlushBridge.pendingMarkdown = null
        onChangeRef.current(pendingMarkdown)
        return pendingMarkdown
      },
      insertDroppedLink: editorDropBridge.insert,
      insertDroppedMarkdown: editorDropBridge.insertMarkdown,
      revealTranslationHistoryRecord: translationHistoryPortBridge.reveal,
      flushTranslationHistoryAnchors: translationHistoryPortBridge.flushAnchors,
      capturePendingTranslationAnchor: () => false,
      bindPendingTranslationAnchor: () => undefined,
      promotePendingTranslationAnchor: () => null,
      discardPendingTranslationAnchor: () => undefined,
    }), [])
    return <>
      <textarea
        aria-label="Markdown editor"
        className="editor-host ProseMirror"
        ref={(element) => { if (element) element.getBoundingClientRect = () => new DOMRect(0, 0, 2000, 2000) }}
        data-document-absolute-path={documentAbsolutePath ?? ''}
        data-document-location={JSON.stringify(documentLocation ?? null)}
        data-document-key={documentKey}
        data-document-display-name={documentDisplayName}
        data-document-source-format={documentSourceFormat}
        data-document-dirty={String(documentDirty)}
        data-ai-workspace-id={aiWorkspace?.workspaceId ?? ''}
        data-ai-workspace-generation={aiWorkspace?.workspaceGeneration ?? ''}
        data-editor-instance={instanceId}
        data-spellcheck={String(spellCheckEnabled)}
        data-edit-indicator-state={editIndicatorModel.lineStates[0] ?? 'empty'}
        data-edit-indicator-status={editIndicatorModel.status}
        data-show-edit-indicators={String(showEditIndicators)}
        data-editor-theme={editorTheme}
        data-mermaid-appearance={JSON.stringify(mermaidAppearance ?? null)}
        data-zoom-percent={zoomPercent}
        data-translation-settings-revision={translationSettingsRevision}
        onChange={(event) => onChange(event.target.value)}
        value={markdown}
      />
      <button onClick={() => {
        setTranslationUnconfigured(true)
        onOpenRightSidebar?.('translation')
      }} type="button">翻译</button>
      <button onClick={() => onOpenRightSidebar?.('ai-chat')} type="button">AI 对话</button>
      <button onClick={() => translationHistory.finalize({
        requestId: `app-request-${++translationHistoryPortBridge.nextRequest}`,
        documentKey,
        workspaceAbsolutePath: translationHistoryIdentity.workspaceAbsolutePath,
        documentRelativePath: translationHistoryIdentity.documentRelativePath,
        documentAbsolutePath,
        documentRevision: translationHistoryIdentity.documentRevision,
        mode: 'visual',
        source: { markdown: 'source', plainText: 'source' },
        translatedMarkdown: 'translated',
        modelId: 'chat-model',
        targetLanguage: 'zh-CN',
        terminal: 'completed',
        anchor: {
          mode: 'visual', from: 0, to: 6, blockStart: 0,
          fingerprint: { before: '', selected: 'source', after: '' }, status: 'valid',
        },
      })} type="button">记录翻译</button>
      <div data-testid="history-window-total">{translationHistory.records.length}</div>
      <div data-testid="editor-right-sidebar-state">
        {rightSidebarState.open ? 'open' : 'closed'}:{rightSidebarState.activeTab}
      </div>
      <div data-testid="editor-right-sidebar-width">{rightSidebarWidth}</div>
      <button onClick={() => onRightSidebarWidthChange?.(830)} type="button">调整右侧栏</button>
      {rightSidebarState.open && <div className="editor-right-sidebar" />}
      <div data-testid="history-document-total">
        {translationHistoryRecords.filter((record) => record.documentKey === documentKey).length}
      </div>
      {translationUnconfigured && (
        <button onClick={onOpenLargeModelSettings} type="button">前往设置</button>
      )}
    </>
  }),
}))

vi.mock('../../src/renderer/settings/PreferencesPage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/settings/PreferencesPage')>()
  return {
    ...actual,
    PreferencesPage: (props: ComponentProps<typeof actual.PreferencesPage>) => {
      preferencesPageBridge.props = props
      preferencesPageBridge.initialTarget = props.initialTarget ?? 'top'
      return <actual.PreferencesPage {...props} />
    },
  }
})

vi.mock('../../src/renderer/workspace/ContextWorkspaceSidebar', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/renderer/workspace/ContextWorkspaceSidebar')
  >()
  return {
    ...actual,
    ContextWorkspaceSidebar: (
      props: ComponentProps<typeof actual.ContextWorkspaceSidebar>,
    ) => {
      workspaceSidebarBridge.observe(props.refreshVersion)
      return <actual.ContextWorkspaceSidebar {...props} />
    },
  }
})

import { App } from '../../src/renderer/app/App'
import { WindowStateSnapshotController } from '../../src/renderer/app/window-state-snapshot-controller'

it('defers a required update for the entire run after an IME composition began before the candidate', async () => {
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  let receive!: (value: import('../../src/shared/app-update').UpdateSnapshot) => void
  const action = vi.fn(async () => ({ ok: true as const, value: null }))
  installApi({ performUpdateAction: action, onAppUpdateChanged: listener => { receive = listener; return () => {} } })
  render(<App />)
  await waitFor(() => expect(receive).toBeTypeOf('function'))
  fireEvent.compositionStart(document)
  act(() => receive({ revision: 2, status: 'available', currentVersion: '1.0.4', candidate: {
    version: '1.0.5', required: true, mode: 'required', message: 'test',
  }, bubbleVisible: false, requiredPrompt: 'visible' }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
  expect(screen.queryByRole('alertdialog')).toBeNull()
  fireEvent.compositionEnd(document)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(action).toHaveBeenCalledWith('work-started')
  expect(action).not.toHaveBeenCalledWith('claim-gate')
  focus.mockRestore()
})

function installApi(overrides: Partial<ArkdownApi> = {}) {
  let preparedDrop: import('../../src/shared/contracts').DroppedPathResult | null = null
  let pendingRecovery: import('../../src/shared/contracts').RecoveryIntent | null = null
  window.arkdown = {
    claimWorkspaceIntroduction: vi.fn(async () => ({ ok: true as const, value: { showIntroduction: false } })),
    chooseWorkspace: vi.fn(async () => ({ ok: true as const, value: workspace })),
    restoreWorkspace: vi.fn(async () => ({ ok: true as const, value: null })),
    listDirectory: vi.fn(async () => ({
      ok: true as const,
      value: [{ name: 'note.md', relativePath: 'note.md', kind: 'document' as const }],
    })),
    openDroppedPath: vi.fn(async () => ({ ok: true as const, value: { workspace, document: null } })),
    prepareDroppedPath: vi.fn(async (absolutePath: string) => {
      const result = await window.arkdown.openDroppedPath(absolutePath)
      if (!result.ok) return result
      preparedDrop = result.value
      return { ok: true as const, value: { ...result.value, token: '123e4567-e89b-42d3-a456-426614174000' } }
    }),
    settleDroppedPath: vi.fn(async (_token: string, accept: boolean) => ({ ok: true as const, value: accept ? preparedDrop : null })),
    inspectDroppedPath: vi.fn(async (absolutePath: string) => ({
      ok: true as const,
      value: { kind: 'file' as const, absolutePath },
    })),
    pathForDroppedFile: vi.fn(() => ''),
    createDocument: vi.fn(async (relativePath: string) => ({
      ok: true as const,
      value: { relativePath, markdown: '', revision: revisionA, encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 1 },
    })),
    readDocument: vi.fn(async (relativePath: string) => ({
      ok: true as const,
      value: { relativePath, markdown: '# Note', revision: revisionA, encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 1 },
    })),
    peekDocument: vi.fn(async (relativePath: string) => ({
      ok: true as const,
      value: { relativePath, markdown: '# Note', revision: revisionA, encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 1 },
    })),
    saveDocument: vi.fn(async () => ({ ok: true as const, value: { revision: 'b'.repeat(64), mtimeMs: 2 } })),
    saveDraft: vi.fn(async (input) => ({
      ok: true as const,
      value: {
        draftId: input.draftId,
        originalAbsolutePath: 'C:/Notes/note.md',
        workspaceAbsolutePath: 'C:/Notes',
        originalRevision: input.expectedOriginalRevision,
        originalMtimeMs: 1,
        encoding: input.encoding,
        newline: input.newline,
        updatedAt: '2026-07-24T00:00:00.000Z',
        ignoredAt: null,
      },
    })),
    discardDraft: vi.fn(async () => ({ ok: true as const, value: null })),
    revealDocument: vi.fn(async () => ({ ok: true as const, value: null })),
    trashDocument: vi.fn(async () => ({ ok: true as const, value: null })),
    getArknotePreferences: vi.fn(async () => ({ ok: true as const, value: DEFAULT_ARKNOTE_PREFERENCES })),
    setArknotePreferences: vi.fn(async (value) => ({ ok: true as const, value })),
    getShellIntegrationPreferences: vi.fn(async () => ({ ok: true as const, value: {
      values: { documentOpenMenu: false, markdownShellNew: false }, unavailable: [],
      observation: { version: 1 as const, revision: 0, minimumBaseRevision: 0, fields: {} },
    } })),
    getKeyboardShortcuts: vi.fn(async () => ({ ok: true as const, value: { bindings: {}, revision: 0,
      observation: { version: 1 as const, minimumBaseRevision: 0, fields: {} } } })),
    getModelSettingsSnapshot: vi.fn(modelApiFailure),
    getLargeModelSettings: vi.fn(modelApiFailure),
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
    cancelAiConversation: vi.fn(modelApiFailure),
    getAiWorkspaceState: vi.fn(async () => ({
      ok: true as const,
      value: { workspaceId: 'workspace-notes', workspaceGeneration: 'generation-1' },
    })),
    setAiConversationCapabilities: vi.fn(async (input) => ({
      ok: true as const,
      value: input.capabilities,
    })),
    submitAiAuthorizationResult: vi.fn(async () => ({ ok: true as const, value: null })),
    clearAiConversation: vi.fn(async () => ({ ok: true as const, value: null })),
    notifyAiCurrentDocumentChanged: vi.fn(async () => ({ ok: true as const, value: null })),
    registerAiCurrentDocumentPort: vi.fn(async () => ({ ok: true as const, value: { portGeneration: 1 } })),
    unregisterAiCurrentDocumentPort: vi.fn(async () => ({ ok: true as const, value: null })),
    registerAiOpenDocumentPort: vi.fn(async () => ({ ok: true as const, value: { documentHandle: 'doc-1' } })),
    unregisterAiOpenDocumentPort: vi.fn(async () => ({ ok: true as const, value: null })),
    openAiMessageLink: vi.fn(async () => ({ ok: true as const, value: null })),
    onAiConversationEvent: vi.fn(() => () => undefined),
    startTranslation: vi.fn(modelApiFailure),
    cancelTranslation: vi.fn(modelApiFailure),
    onTranslationEvent: vi.fn(() => () => undefined),
    ...stickyNoteApiStubs,
    onRecoverDraft: vi.fn((handler) => {
      const receive = (intent: import('../../src/shared/contracts').RecoveryIntent) => {
        pendingRecovery = intent
        handler(intent)
      }
      recoveryHandler = receive
      return () => { if (recoveryHandler === receive) recoveryHandler = null }
    }),
    claimRecoveredDraft: vi.fn(async () => ({ ok: true as const, value: pendingRecovery
      ? { manifest: pendingRecovery.manifest, markdown: pendingRecovery.markdown } : null })),
    releaseDraftRecovery: vi.fn(async () => ({ ok: true as const, value: null })),
    onMenuCommand: vi.fn((handler) => {
      menuCommand = handler
      return () => { if (menuCommand === handler) menuCommand = null }
    }),
    recordRecentDocument: vi.fn(async (absolutePath: string) => ({
      ok: true as const,
      value: [absolutePath],
    })),
    updateApplicationMenuWindowState: vi.fn(async () => ({
      ok: true as const,
      value: undefined,
    })),
    onApplicationMenuChanged: vi.fn((handler) => {
      applicationMenuChanged = handler
      return () => { if (applicationMenuChanged === handler) applicationMenuChanged = null }
    }),
    onEditorAppearancePreferencesChanged: vi.fn((handler) => {
      editorAppearanceChanged = handler
      return () => { if (editorAppearanceChanged === handler) editorAppearanceChanged = null }
    }),
    compareAndSetEditorAppearancePreferences: vi.fn(async (expectedRevision, _expected, replacement) => ({
      ok: true as const,
      value: appearanceSnapshot(replacement, expectedRevision + 1),
    })),
    printDocument: vi.fn(async () => ({ ok: true as const, value: null })),
    takePrintDocument: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'OPERATION_FAILED' as const, message: 'Print surface unavailable' },
    })),
    readyPrintDocument: vi.fn(async () => ({ ok: true as const, value: null })),
    controlWindow: vi.fn(async () => ({
      ok: true as const,
      value: { maximized: false, fullscreen: false, revision: 0 },
    })),
    getWindowState: vi.fn(async () => ({
      ok: true as const,
      value: currentWindowState,
    })),
    onWindowStateChanged: vi.fn((handler) => {
      const relay = (state: { maximized: boolean; fullscreen: boolean; revision: number }) => {
        currentWindowState = state
        handler(state)
      }
      windowStateChanged = relay
      return () => { if (windowStateChanged === relay) windowStateChanged = null }
    }),
    onPrepareClose: vi.fn((handler: () => Promise<boolean>) => {
      prepareClose = handler
      return () => { if (prepareClose === handler) prepareClose = async () => true }
    }),
    ...overrides,
  }
  // Migrate the existing presentation fixtures through the observed transport.
  // New protocol regressions override these methods directly; no production fallback exists.
  let appearance = appearanceSnapshot()
  let layout: LayoutPreferencesSnapshot = { layout: DEFAULT_LAYOUT_PREFERENCES, revision: 0 }
  if (!overrides.getModelSettingsSnapshot) window.arkdown.getModelSettingsSnapshot = vi.fn<ArkdownApi['getModelSettingsSnapshot']>(async () => {
    const result = await window.arkdown.getLargeModelSettings()
    return result.ok ? { ok: true, value: modelObservation(result.value) } : result
  })
  let appearanceHint = false
  let layoutHint = false
  let searchRevision = 0
  const appearanceObserved = (snapshot: EditorAppearanceSnapshot): PublicPreferenceSnapshot<'appearance'> => ({
    group: 'appearance', values: structuredClone(snapshot.appearance), observation: { version: 1,
      revision: snapshot.revision, minimumBaseRevision: 0,
      fields: Object.fromEntries(Object.keys(snapshot.appearance).map(field => [field, snapshot.revision])) },
  })
  const layoutObserved = (snapshot: LayoutPreferencesSnapshot): PublicPreferenceSnapshot<'layout'> => ({
    group: 'layout', values: { ...snapshot.layout }, observation: { version: 1,
      revision: snapshot.revision, minimumBaseRevision: 0,
      fields: { leftSidebarWidth: snapshot.revision, rightSidebarWidth: snapshot.revision } },
  })
  if (!overrides.getPreferenceSnapshot) {
    window.arkdown.getPreferenceSnapshot = vi.fn(async group => {
      if (group === 'appearance') {
        if (appearanceHint) return { ok: true as const, value: appearanceObserved(appearance) }
        const result = await window.arkdown.getEditorAppearancePreferences?.()
        if (result && !result.ok) return result
        if (result?.ok && result.value.revision >= appearance.revision) appearance = result.value
        return { ok: true as const, value: appearanceObserved(appearance) }
      }
      if (group === 'layout') {
        if (layoutHint) return { ok: true as const, value: layoutObserved(layout) }
        const result = await window.arkdown.getLayoutPreferences?.()
        if (result && !result.ok) return result
        if (result?.ok && result.value.revision >= layout.revision) layout = result.value
        return { ok: true as const, value: layoutObserved(layout) }
      }
      const result = await window.arkdown.getSearchPreferences?.()
      if (result && !result.ok) return result
      return { ok: true as const, value: { group: 'search' as const,
        values: result?.value ?? { provider: 'bing' as const, customTemplate: '' },
        observation: { version: 1 as const, revision: searchRevision, minimumBaseRevision: 0, fields: {} } } }
    })
    const registerAppearance = window.arkdown.onEditorAppearancePreferencesChanged
    window.arkdown.onEditorAppearancePreferencesChanged = handler => registerAppearance?.(snapshot => {
      if (snapshot.revision > appearance.revision) appearance = snapshot
      appearanceHint = true
      handler(snapshot)
    }) ?? (() => undefined)
    const registerLayout = window.arkdown.onLayoutPreferencesChanged
    window.arkdown.onLayoutPreferencesChanged = handler => registerLayout?.(snapshot => {
      if (snapshot.revision > layout.revision) layout = snapshot
      layoutHint = true
      handler(snapshot)
    }) ?? (() => undefined)
  }
  if (!overrides.patchPreferences) window.arkdown.patchPreferences = vi.fn(async input => {
    if (input.observed.group === 'appearance') {
      const changes = input.changes as Partial<typeof DEFAULT_EDITOR_APPEARANCE>
      const response = await window.arkdown.compareAndSetEditorAppearancePreferences?.(input.observed.observation.revision,
        input.observed.values, { ...input.observed.values, ...changes })
      if (!response) return modelApiFailure()
      if (!response.ok) return response
      const saved = response.value
      const matches = (Object.keys(changes) as Array<keyof typeof changes>).every(field => saved.appearance[field] === changes[field])
      if (saved.revision > appearance.revision) appearance = saved
      return { ok: true as const, value: matches ? { status: 'committed' as const, snapshot: appearanceObserved(saved) }
        : { status: 'conflict' as const, snapshot: appearanceObserved(saved), reason: 'field-changed' as const, fields: [] } }
    }
    if (input.observed.group === 'layout') {
      const response = await window.arkdown.compareAndSetLayoutPreferences?.(input.observed.observation.revision,
        input.observed.values, { ...input.observed.values, ...input.changes })
      if (!response) return modelApiFailure()
      if (!response.ok) return response
      if (response.value.snapshot.revision > layout.revision) layout = response.value.snapshot
      return { ok: true as const, value: response.value.applied
        ? { status: 'committed' as const, snapshot: layoutObserved(response.value.snapshot) }
        : { status: 'conflict' as const, snapshot: layoutObserved(response.value.snapshot), reason: 'field-changed' as const, fields: [] } }
    }
    if (input.observed.group === 'search') {
      const response = await window.arkdown.setSearchPreferences?.({ ...input.observed.values, ...input.changes })
      if (!response) return modelApiFailure()
      if (!response.ok) return response
      return { ok: true as const, value: { status: 'committed' as const, snapshot: { group: 'search' as const, values: response.value,
        observation: { version: 1 as const, revision: ++searchRevision, minimumBaseRevision: 0, fields: {} } } } }
    }
    return modelApiFailure()
  })
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  })
  prepareClose = async () => true
  menuCommand = null
  editorModeBridge.report = null
  editorFlushBridge.pendingMarkdown = null
  editorFlushBridge.lockMarkdown = null
  editorDropBridge.insert.mockClear().mockReturnValue(true)
  editorDropBridge.insertMarkdown.mockClear().mockReturnValue(true)
  editorChangeBridge.registrations = []
  editorInstanceBridge.mounts = 0
  editorInstanceBridge.stores = []
  editorInstanceBridge.aiBindings = []
  editIndicatorModelBridge.inputs = []
  editIndicatorModelBridge.implementation = null
  translationHistoryPortBridge.first = null
  translationHistoryPortBridge.latest = null
  translationHistoryPortBridge.nextRequest = 0
  translationHistoryPortBridge.navigate = null
  translationHistoryPortBridge.ready = null
  translationHistoryPortBridge.reveal.mockClear().mockReturnValue(true)
  translationHistoryPortBridge.flushAnchors.mockClear().mockReturnValue([])
  preferencesPageBridge.initialTarget = null
  preferencesPageBridge.props = null
  workspaceSidebarBridge.lastRefreshVersion = null
  workspaceSidebarBridge.refreshVersions = []
  mermaidAppearanceBridge.values = []
  recoveryHandler = null
  applicationMenuChanged = null
  editorAppearanceChanged = null
  layoutPreferencesChanged = null
  windowStateChanged = null
  currentWindowState = { maximized: false, fullscreen: false, revision: 0 }
  installApi()
})

it('opens one keyboard shortcut dialog from the edit command and closes it with Escape', async () => {
  render(<App />)
  await waitFor(() => expect(menuCommand).not.toBeNull())
  act(() => { menuCommand?.('shortcut-settings'); menuCommand?.('shortcut-settings') })
  expect(await screen.findByRole('dialog', { name: '快捷键' })).toBeInTheDocument()
  expect(screen.getAllByRole('dialog', { name: '快捷键' })).toHaveLength(1)
  fireEvent.keyDown(window, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '快捷键' })).not.toBeInTheDocument())
})

it('opens a single About dialog from the menu and preserves the current document', async () => {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })
  fireEvent.change(editor, { target: { value: '# Unsaved draft' } })
  editor.focus()
  await waitFor(() => expect(menuCommand).not.toBeNull())
  act(() => { menuCommand?.('about'); menuCommand?.('about') })
  expect(await screen.findByRole('dialog', { name: '关于 Arkdown' })).toHaveTextContent(`版本 ${packageVersion}`)
  expect(screen.getAllByRole('dialog', { name: '关于 Arkdown' })).toHaveLength(1)
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '关于 Arkdown' })).not.toBeInTheDocument())
  expect(editor).toHaveValue('# Unsaved draft')
  expect(editor).toHaveFocus()
})

function dropFileAt(
  target: Element,
  file: File,
  clientX: number,
  clientY: number,
  registerRequest = false,
): number | undefined {
  const event = new MouseEvent('drop', {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
  })
  Object.defineProperty(event, 'dataTransfer', {
    value: { files: [file], types: ['Files'] },
  })
  const requestId = registerRequest ? registerVisualDropRequest(event) : undefined
  fireEvent(target, event)
  return requestId
}

it.each(['保存', '不保存', '取消'] as const)('guards a blank-area document drop with %s', async (choice) => {
  const user = userEvent.setup()
  const openDroppedPath = vi.fn(async () => ({ ok: true as const, value: { workspace, document: { relativePath: 'target.txt', markdown: 'Dropped target', revision: revisionA, encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 2 } } }))
  installApi({ restoreWorkspace: vi.fn(async () => ({ ok: true as const, value: workspace })), pathForDroppedFile: vi.fn(() => 'C:\\Notes\\target.txt'), openDroppedPath })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), { target: { value: '# Changed' } })
  dropFileAt(screen.getByTestId('editor-host'), new File(['target'], 'target.txt'), 1, 1)
  const dialog = await screen.findByRole('dialog', { name: '打开新文档' })
  expect(dialog).toHaveTextContent('即将打开文档 target.txt，是否保存当前文档？')
  await user.click(within(dialog).getByRole('button', { name: choice }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  if (choice === '取消') {
    expect(openDroppedPath).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Changed')
  } else {
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('Dropped target'))
    expect(window.arkdown.saveDocument).toHaveBeenCalledTimes(choice === '保存' ? 1 : 0)
  }
  expect(editorDropBridge.insert).not.toHaveBeenCalled()
})

it.each(['保存', '不保存', '取消'] as const)('guards a blank-area document shortcut drop with %s', async (choice) => {
  const user = userEvent.setup()
  const targetPath = 'C:/Notes/实际 文档.md'
  const shortcutPath = 'C:/Desktop/文档入口.lnk'
  const openDroppedPath = vi.fn(async () => ({ ok: true as const, value: { workspace, document: {
    relativePath: '实际 文档.md', markdown: '# Shortcut target', revision: revisionA,
    encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 2,
  } } }))
  installApi({
    pathForDroppedFile: vi.fn(() => shortcutPath), openDroppedPath,
    inspectDroppedPath: vi.fn(async () => ({ ok: true as const, value: { kind: 'file' as const, absolutePath: targetPath } })),
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), { target: { value: '# Unsaved' } })
  dropFileAt(screen.getByRole('button', { name: 'note.md' }), new File([''], '文档入口.lnk'), 1, 1)
  const dialog = await screen.findByRole('dialog', { name: '打开新文档' })
  expect(dialog).toHaveTextContent('即将打开文档 实际 文档.md，是否保存当前文档？')
  await user.click(within(dialog).getByRole('button', { name: choice }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(window.arkdown.inspectDroppedPath).toHaveBeenCalledWith(shortcutPath, true)
  if (choice === '取消') {
    expect(openDroppedPath).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Unsaved')
  } else {
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Shortcut target'))
    expect(openDroppedPath).toHaveBeenCalledWith(targetPath)
    expect(window.arkdown.saveDocument).toHaveBeenCalledTimes(choice === '保存' ? 1 : 0)
  }
  expect(editorDropBridge.insert).not.toHaveBeenCalled()
})

it('does not resolve a shortcut dropped into the document body', async () => {
  const shortcutPath = 'C:/Desktop/文档入口.lnk'
  installApi({ pathForDroppedFile: vi.fn(() => shortcutPath) })
  render(<App />)
  dropFileAt(screen.getByRole('textbox', { name: 'Markdown editor' }), new File([''], '文档入口.lnk'), 50, 50, true)
  await waitFor(() => expect(editorDropBridge.insert).toHaveBeenCalledWith(expect.objectContaining({ absolutePath: shortcutPath })))
  expect(window.arkdown.inspectDroppedPath).toHaveBeenCalledWith(shortcutPath)
  expect(window.arkdown.prepareDroppedPath).not.toHaveBeenCalled()
})

it('keeps unsaved content when a dropped shortcut target has disappeared', async () => {
  installApi({
    pathForDroppedFile: vi.fn(() => 'C:/Desktop/文档入口.lnk'),
    inspectDroppedPath: vi.fn(async () => ({ ok: false as const, error: { code: 'FILE_NOT_FOUND', message: '文件已被移动或删除' } })),
  })
  render(<App />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), { target: { value: '# Unsaved' } })
  dropFileAt(screen.getByTestId('editor-host'), new File([''], '文档入口.lnk'), 1, 1)
  await screen.findByText('文件已被移动或删除')
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Unsaved')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(window.arkdown.prepareDroppedPath).not.toHaveBeenCalled()
})

it.each([false, true])('continues a real draft Save As before drop-open (workspace change: %s)', async (changesWorkspace) => {
  const user = userEvent.setup()
  const savedWorkspace = changesWorkspace ? { name: 'Other', absolutePath: 'D:/Other' } : workspace
  const saved = committedSaveAs(savedWorkspace, changesWorkspace)
  const openDroppedPath = vi.fn(async () => ({ ok: true as const, value: { workspace, document: { ...saved.document, relativePath: 'target.md', markdown: '# Target' } } }))
  installApi({ restoreWorkspace: vi.fn(async () => ({ ok: true as const, value: workspace })), ...twoPhaseSaveAsApi(saved), pathForDroppedFile: vi.fn(() => 'C:\\Notes\\target.md'), openDroppedPath })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await screen.findByRole('button', { name: 'note.md' })
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), { target: { value: '# Changed' } })
  dropFileAt(screen.getByTestId('editor-host'), new File(['target'], 'target.md'), 1, 1)
  const dialog = await screen.findByRole('dialog', { name: '打开新文档' })
  await user.click(within(dialog).getByRole('button', { name: '保存' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Target'))
  expect(window.arkdown.commitSaveDocumentAs).toHaveBeenCalledOnce()
  expect(openDroppedPath).toHaveBeenCalledWith('C:\\Notes\\target.md')
})

it('keeps a real saved draft in its saved workspace when drop-open fails', async () => {
  const user = userEvent.setup()
  const saved = committedSaveAs({ name: 'Other', absolutePath: 'D:/Other' }, true)
  installApi({ restoreWorkspace: vi.fn(async () => ({ ok: true as const, value: workspace })), ...twoPhaseSaveAsApi(saved), pathForDroppedFile: vi.fn(() => 'C:\\Notes\\target.md'), openDroppedPath: vi.fn(async () => ({ ok: false as const, error: { code: 'FILE_NOT_FOUND', message: '目标已移动' } })) })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await screen.findByRole('button', { name: 'note.md' })
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), { target: { value: '# Changed' } })
  dropFileAt(screen.getByTestId('editor-host'), new File(['target'], 'target.md'), 1, 1)
  await user.click(within(await screen.findByRole('dialog', { name: '打开新文档' })).getByRole('button', { name: '保存' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveAttribute('data-document-absolute-path', 'D:/Other/saved.md'))
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Changed')
})

it('replaces a pending drop confirmation with the newest filename and intent', async () => {
  const user = userEvent.setup()
  installApi({ pathForDroppedFile: vi.fn((file) => `C:\\Notes\\${file.name}`) })
  render(<App />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), { target: { value: '# Changed' } })
  dropFileAt(screen.getByTestId('editor-host'), new File(['a'], 'old.md'), 1, 1)
  await screen.findByRole('dialog', { name: '打开新文档' })
  dropFileAt(screen.getByTestId('editor-host'), new File(['b'], 'new & safe.txt'), 1, 1)
  await waitFor(() => expect(screen.getByRole('dialog', { name: '打开新文档' })).toHaveTextContent('即将打开文档 new & safe.txt，是否保存当前文档？'))
  await user.click(within(screen.getByRole('dialog', { name: '打开新文档' })).getByRole('button', { name: '不保存' }))
  await waitFor(() => expect(window.arkdown.openDroppedPath).toHaveBeenCalledWith('C:\\Notes\\new & safe.txt'))
  expect(window.arkdown.openDroppedPath).toHaveBeenCalledOnce()
})

it.each(['cancel-save-as', 'failed-save-as', 'failed-save'] as const)('does not open a blank drop after %s', async (failure) => {
  const user = userEvent.setup()
  installApi({
    ...twoPhaseSaveAsApi(committedSaveAs()),
    pathForDroppedFile: vi.fn(() => 'C:\\Notes\\target.md'),
    ...(failure === 'cancel-save-as' ? { beginSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: null })) } : {}),
    ...(failure === 'failed-save-as' ? { commitSaveDocumentAs: vi.fn(async () => ({ ok: false as const, error: { code: 'WRITE_FAILED', message: 'Cannot save' } })) } : {}),
    saveDocument: vi.fn(async () => ({ ok: false as const, error: { code: 'WRITE_FAILED', message: 'Cannot save' } })),
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  if (failure === 'failed-save') await user.click(await screen.findByRole('button', { name: 'note.md' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), { target: { value: '# Changed' } })
  dropFileAt(screen.getByTestId('editor-host'), new File(['target'], 'target.md'), 1, 1)
  await user.click(within(await screen.findByRole('dialog', { name: '打开新文档' })).getByRole('button', { name: '保存' }))
  if (failure === 'cancel-save-as') await waitFor(() => expect(window.arkdown.beginSaveDocumentAs).toHaveBeenCalledOnce())
  else await screen.findByText('Cannot save')
  expect(window.arkdown.openDroppedPath).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Changed')
})

it.each(['c:\\NOTES\\note.md', 'C:\\Desktop\\note.lnk'])('does not reload the current file when dropping %s on navigation', async (droppedPath) => {
  const user = userEvent.setup()
  installApi({
    pathForDroppedFile: vi.fn(() => droppedPath),
    inspectDroppedPath: vi.fn(async () => ({ ok: true as const, value: { kind: 'file' as const, absolutePath: 'c:\\NOTES\\note.md' } })),
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), { target: { value: '# Changed' } })
  dropFileAt(screen.getByRole('button', { name: 'note.md' }), new File(['target'], 'note.md'), 1, 1)
  await waitFor(() => expect(window.arkdown.inspectDroppedPath).toHaveBeenCalledOnce())
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(window.arkdown.openDroppedPath).not.toHaveBeenCalled()
})

it('keeps a rejected body insertion separate from blank-drop opening', async () => {
  installApi({ pathForDroppedFile: vi.fn(() => 'C:\\Notes\\target.md') })
  editorDropBridge.insert.mockReturnValueOnce(false)
  render(<App />)
  dropFileAt(screen.getByRole('textbox', { name: 'Markdown editor' }), new File(['target'], 'target.md'), 50, 50, true)
  await waitFor(() => expect(editorDropBridge.insert).toHaveBeenCalledOnce())
  expect(window.arkdown.openDroppedPath).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it.each([false, true])('routes internal md drops by body location (body: %s)', async (body) => {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  const event = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })
  Object.defineProperty(event, 'dataTransfer', { value: { types: [WORKSPACE_ENTRY_MIME], files: [], getData: () => encodeWorkspaceDrag('C:/Notes', 'target.md', 'document') } })
  fireEvent(body ? screen.getByRole('textbox', { name: 'Markdown editor' }) : screen.getByRole('button', { name: 'note.md' }), event)
  if (body) await waitFor(() => expect(editorDropBridge.insert).toHaveBeenCalledOnce())
  else await waitFor(() => expect(window.arkdown.openDroppedPath).toHaveBeenCalledWith('C:/Notes/target.md'))
  expect(body ? window.arkdown.openDroppedPath : editorDropBridge.insert).not.toHaveBeenCalled()
})

it.each(['body-drop', 'open-note'] as const)('does not let an old saved-draft drop overwrite a newer %s', async (intent) => {
  const user = userEvent.setup()
  const opening = deferred<ApiResult<{ workspace: typeof workspace; document: DocumentSnapshot | null }>>()
  const saved = committedSaveAs({ name: 'Other', absolutePath: 'D:/Other' }, true)
  installApi({ ...twoPhaseSaveAsApi(saved), pathForDroppedFile: vi.fn((file) => `D:\\Other\\${file.name}`), openDroppedPath: vi.fn(() => opening.promise) })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), { target: { value: '# Changed' } })
  dropFileAt(screen.getByTestId('editor-host'), new File(['old'], 'old.md'), 1, 1)
  await user.click(within(await screen.findByRole('dialog', { name: '打开新文档' })).getByRole('button', { name: '保存' }))
  await waitFor(() => expect(window.arkdown.openDroppedPath).toHaveBeenCalledOnce())
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveAttribute('data-document-absolute-path', 'D:/Other/saved.md')
  if (intent === 'body-drop') {
    dropFileAt(screen.getByRole('textbox', { name: 'Markdown editor' }), new File(['new'], 'new.md'), 50, 50)
    await waitFor(() => expect(editorDropBridge.insert).toHaveBeenCalledOnce())
  } else {
    await user.click(await screen.findByRole('button', { name: 'note.md' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Note'))
  }
  await act(async () => opening.resolve({ ok: true, value: { workspace, document: { ...saved.document, relativePath: 'old.md', markdown: '# OLD' } } }))
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue(intent === 'body-drop' ? '# Changed' : '# Note')
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveAttribute('data-document-absolute-path', intent === 'body-drop' ? 'D:/Other/saved.md' : 'D:/Other/note.md')
})

it('lets the latest blank drop own an in-flight draft save and releases the retained shell on opening', async () => {
  const user = userEvent.setup()
  const saving = deferred<ApiResult<CommitSaveDocumentAsResult>>()
  const saved = committedSaveAs({ name: 'Other', absolutePath: 'D:/Other' }, true)
  installApi({ ...twoPhaseSaveAsApi(saved), commitSaveDocumentAs: vi.fn(() => saving.promise),
    pathForDroppedFile: vi.fn(file => `D:\\Other\\${file.name}`),
    openDroppedPath: vi.fn(async () => ({ ok: true as const, value: { workspace: saved.workspace, document: { ...saved.document, relativePath: 'new.md', markdown: '# New' } } })),
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), { target: { value: '# Changed' } })
  dropFileAt(screen.getByTestId('editor-host'), new File(['old'], 'old.md'), 1, 1)
  await user.click(within(await screen.findByRole('dialog', { name: '打开新文档' })).getByRole('button', { name: '保存' }))
  await waitFor(() => expect(window.arkdown.commitSaveDocumentAs).toHaveBeenCalledOnce())
  dropFileAt(screen.getByTestId('editor-host'), new File(['new'], 'new.md'), 1, 1)
  await waitFor(() => expect(window.arkdown.inspectDroppedPath).toHaveBeenCalledTimes(2))
  await act(async () => saving.resolve({ ok: true, value: saved }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# New'))
  expect(window.arkdown.openDroppedPath).toHaveBeenCalledExactlyOnceWith('D:\\Other\\new.md')
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveAttribute('data-document-absolute-path', 'D:/Other/new.md')
  // A later ordinary workspace switch must create a new shell, not reuse the
  // original shell key retained only for the now completed Save As continuation.
  await user.click(screen.getByRole('button', { name: 'Other' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveAttribute('data-document-absolute-path', 'C:/Notes/note.md')
})

it.each([true, false])('locks editing and save shortcuts throughout delayed acceptance (success=%s)', async (success) => {
  const accepting = deferred<ApiResult<import('../../src/shared/contracts').DroppedPathResult | null>>()
  const target = { relativePath: 'target.md', markdown: '# Target', revision: revisionA, encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 1 }
  installApi({ pathForDroppedFile: vi.fn(() => 'C:/Notes/target.md'),
    openDroppedPath: vi.fn(async () => ({ ok: true as const, value: { workspace, document: target } })),
    settleDroppedPath: vi.fn(() => accepting.promise) })
  render(<App />)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const original = screen.getByRole('textbox', { name: 'Markdown editor' })
  dropFileAt(screen.getByTestId('editor-host'), new File([''], 'target.md'), 1, 1)
  await waitFor(() => expect(window.arkdown.settleDroppedPath).toHaveBeenCalledWith(expect.any(String), true))
  expect(original.isConnected).toBe(true)
  expect(screen.getByRole('textbox', { name: 'Markdown editor', hidden: true })).toBeInTheDocument()
  expect(screen.getByTestId('editor-host').closest('[inert]')).not.toBeNull()
  fireEvent.keyDown(window, { key: 's', ctrlKey: true })
  await act(async () => {})
  expect(window.arkdown.saveDocument).not.toHaveBeenCalled()
  await act(async () => accepting.resolve(success
    ? { ok: true, value: { workspace, document: target } }
    : { ok: false, error: { code: 'OPERATION_FAILED', message: '打开失败' } }))
  const editor = await screen.findByRole('textbox', { name: 'Markdown editor' })
  expect(editor).toHaveValue(success ? '# Target' : '# Note')
  expect(editor.closest('[inert]')).toBeNull()
  fireEvent.change(editor, { target: { value: '# Still editable' } })
  expect(editor).toHaveValue('# Still editable')
})

it('an old prepared reply cannot release the newer acceptance lock', async () => {
  const first = deferred<ApiResult<import('../../src/shared/contracts').PreparedDroppedPathResult>>()
  const accepted = deferred<ApiResult<import('../../src/shared/contracts').DroppedPathResult | null>>()
  const document = { relativePath: 'new.md', markdown: '# New', revision: revisionA, encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 1 }
  installApi({ pathForDroppedFile: vi.fn(file => `C:/Notes/${file.name}`),
    prepareDroppedPath: vi.fn().mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ ok: true, value: { workspace, document, token: 'new' } }),
    settleDroppedPath: vi.fn((_token, accept) => accept ? accepted.promise : Promise.resolve({ ok: true as const, value: null })) })
  render(<App />)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  dropFileAt(screen.getByTestId('editor-host'), new File([''], 'old.md'), 1, 1)
  await waitFor(() => expect(window.arkdown.prepareDroppedPath).toHaveBeenCalledOnce())
  dropFileAt(screen.getByTestId('editor-host'), new File([''], 'new.md'), 1, 1)
  await waitFor(() => expect(window.arkdown.settleDroppedPath).toHaveBeenCalledWith('new', true))
  await act(async () => first.resolve({ ok: true, value: { workspace, document, token: 'old' } }))
  expect(window.arkdown.settleDroppedPath).toHaveBeenCalledWith('old', false)
  expect(screen.getByRole('textbox', { name: 'Markdown editor', hidden: true })).toBeInTheDocument()
  expect(screen.getByTestId('editor-host').closest('[inert]')).not.toBeNull()
  await act(async () => accepted.resolve({ ok: true, value: { workspace, document } }))
  expect(await screen.findByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# New')
})

it('keeps lock-boundary flush content and cancels before final acceptance', async () => {
  installApi({ pathForDroppedFile: vi.fn(() => 'C:/Notes/target.md') })
  render(<App />)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const original = screen.getByRole('textbox', { name: 'Markdown editor' })
  editorFlushBridge.lockMarkdown = '# Cleanup edit'
  dropFileAt(screen.getByTestId('editor-host'), new File([''], 'target.md'), 1, 1)
  await waitFor(() => expect(window.arkdown.settleDroppedPath).toHaveBeenCalledWith(expect.any(String), false))
  expect(window.arkdown.settleDroppedPath).not.toHaveBeenCalledWith(expect.any(String), true)
  expect(await screen.findByRole('textbox', { name: 'Markdown editor' })).toBe(original)
  expect(original).toHaveValue('# Cleanup edit')
})

it.each(['clean', 'saved', 'saved-as', 'pending-flush'] as const)('preserves edits made while a %s blank-drop read is pending', async (initial) => {
  const user = userEvent.setup()
  const opening = deferred<ApiResult<{ workspace: typeof workspace; document: DocumentSnapshot | null }>>()
  const saved = committedSaveAs({ name: 'Other', absolutePath: 'D:/Other' }, true)
  installApi({ ...twoPhaseSaveAsApi(saved), pathForDroppedFile: vi.fn(() => 'C:\\Notes\\target.md'), openDroppedPath: vi.fn(() => opening.promise) })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  if (initial !== 'saved-as') await user.click(await screen.findByRole('button', { name: 'note.md' }))
  if (initial === 'saved' || initial === 'saved-as') {
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), { target: { value: '# Changed' } })
  }
  dropFileAt(screen.getByTestId('editor-host'), new File(['target'], 'target.md'), 1, 1)
  if (initial === 'saved' || initial === 'saved-as') {
    await user.click(within(await screen.findByRole('dialog', { name: '打开新文档' })).getByRole('button', { name: '保存' }))
  }
  await waitFor(() => expect(window.arkdown.openDroppedPath).toHaveBeenCalledOnce())
  if (initial === 'pending-flush') editorFlushBridge.pendingMarkdown = '# Latest edit'
  else fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), { target: { value: '# Latest edit' } })
  await act(async () => opening.resolve({ ok: true, value: { workspace, document: { ...saved.document, relativePath: 'target.md', markdown: '# TARGET' } } }))
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Latest edit')
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveAttribute('data-document-absolute-path', initial === 'saved-as' ? 'D:/Other/saved.md' : 'C:/Notes/note.md')
})

it('inserts an unsupported dropped file as a full local-path link at the release point', async () => {
  const inspectDroppedPath = vi.fn(async (absolutePath: string) => ({
    ok: true as const,
    value: { kind: 'file' as const, absolutePath },
  }))
  installApi({
    pathForDroppedFile: vi.fn(() => 'C:\\Archive\\raw data.bin'),
    inspectDroppedPath,
  })
  render(<App />)

  dropFileAt(
    screen.getByRole('textbox', { name: 'Markdown editor' }),
    new File(['raw'], 'raw data.bin'),
    125,
    275,
  )

  await waitFor(() => expect(editorDropBridge.insert).toHaveBeenCalledWith({
    absolutePath: 'C:\\Archive\\raw data.bin',
    clientX: 125,
    clientY: 275,
    kind: 'file',
  }))
  expect(inspectDroppedPath).toHaveBeenCalledWith('C:\\Archive\\raw data.bin')
  expect(window.arkdown.openDroppedPath).not.toHaveBeenCalled()
})

it('inserts a delayed PDF import at its original visual drop request instead of the live selection', async () => {
  const inspectDroppedPath = vi.fn()
  const imported: ImportedAsset = {
    assetId: 'guide-pdf',
    category: 'pdf',
    fileName: 'guide.pdf',
    relativePath: '.arkdown-assets/guide.pdf',
    previewUrl: 'arkdown-asset://guide.pdf',
    markdown: '[guide.pdf](arkdown-asset:guide.pdf)',
  }
  const pendingImport = deferred<ApiResult<ImportedAsset>>()
  const importAsset = vi.fn(() => pendingImport.promise)
  installApi({
    pathForDroppedFile: vi.fn(() => 'C:\\Archive\\guide.pdf'),
    inspectDroppedPath,
    importAsset,
  })
  const legacySelectionInsert = vi.fn()
  window.addEventListener('arkdown:insert-markdown', legacySelectionInsert)
  render(<App />)

  const requestId = dropFileAt(
    screen.getByRole('textbox', { name: 'Markdown editor' }),
    new File(['pdf'], 'guide.pdf'),
    125,
    275,
    true,
  )

  await waitFor(() => expect(importAsset).toHaveBeenCalledWith('C:\\Archive\\guide.pdf'))
  expect(requestId).not.toBeUndefined()
  expect(editorDropBridge.insertMarkdown).not.toHaveBeenCalled()

  await act(async () => pendingImport.resolve({ ok: true, value: imported }))

  expect(inspectDroppedPath).not.toHaveBeenCalled()
  expect(editorDropBridge.insert).not.toHaveBeenCalled()
  expect(editorDropBridge.insertMarkdown).toHaveBeenCalledWith({
    markdown: '[guide.pdf](arkdown-asset:guide.pdf)',
    clientX: 125,
    clientY: 275,
    visualDropRequestId: requestId,
  })
  expect(legacySelectionInsert).not.toHaveBeenCalled()
  window.removeEventListener('arkdown:insert-markdown', legacySelectionInsert)
})

it('invalidates an older resource import when a newer visual drop starts', async () => {
  const firstImport = deferred<ApiResult<ImportedAsset>>()
  const secondImport = deferred<ApiResult<ImportedAsset>>()
  const importAsset = vi.fn()
    .mockImplementationOnce(() => firstImport.promise)
    .mockImplementationOnce(() => secondImport.promise)
  installApi({
    pathForDroppedFile: vi.fn((file: File) => `C:\\Archive\\${file.name}`),
    importAsset,
  })
  const legacySelectionInsert = vi.fn()
  window.addEventListener('arkdown:insert-markdown', legacySelectionInsert)
  render(<App />)
  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })

  const firstRequestId = dropFileAt(editor, new File(['first'], 'first.pdf'), 10, 20, true)
  const secondRequestId = dropFileAt(editor, new File(['second'], 'second.pdf'), 30, 40, true)
  await waitFor(() => expect(importAsset).toHaveBeenCalledTimes(2))

  await act(async () => firstImport.resolve({
    ok: true,
    value: {
      assetId: 'first', category: 'pdf', fileName: 'first.pdf',
      relativePath: '.arkdown-assets/first.pdf', previewUrl: 'arkdown-asset://first.pdf',
      markdown: '[first.pdf](arkdown-asset:first.pdf)',
    },
  }))
  expect(editorDropBridge.insertMarkdown).not.toHaveBeenCalled()
  expect(legacySelectionInsert).not.toHaveBeenCalled()

  await act(async () => secondImport.resolve({
    ok: true,
    value: {
      assetId: 'second', category: 'pdf', fileName: 'second.pdf',
      relativePath: '.arkdown-assets/second.pdf', previewUrl: 'arkdown-asset://second.pdf',
      markdown: '[second.pdf](arkdown-asset:second.pdf)',
    },
  }))
  expect(firstRequestId).not.toBe(secondRequestId)
  expect(editorDropBridge.insertMarkdown).toHaveBeenCalledOnce()
  expect(editorDropBridge.insertMarkdown).toHaveBeenCalledWith({
    markdown: '[second.pdf](arkdown-asset:second.pdf)',
    clientX: 30,
    clientY: 40,
    visualDropRequestId: secondRequestId,
  })
  expect(legacySelectionInsert).not.toHaveBeenCalled()
  window.removeEventListener('arkdown:insert-markdown', legacySelectionInsert)
})

it.each(['document', 'mode'] as const)(
  'ignores a failed resource import after the active %s changes',
  async (lifecycleChange) => {
    const user = userEvent.setup()
    const pendingImport = deferred<ApiResult<ImportedAsset>>()
    const importAsset = vi.fn(() => pendingImport.promise)
    installApi({
      listDirectory: vi.fn(async () => ({
        ok: true as const,
        value: [
          { name: 'note.md', relativePath: 'note.md', kind: 'document' as const },
          { name: 'other.md', relativePath: 'other.md', kind: 'document' as const },
        ],
      })),
      readDocument: vi.fn(async (relativePath: string) => ({
        ok: true as const,
        value: {
          relativePath,
          markdown: `# ${relativePath}`,
          revision: revisionA,
          encoding: 'utf8' as const,
          newline: 'lf' as const,
          mtimeMs: 1,
        },
      })),
      pathForDroppedFile: vi.fn(() => 'C:\\Archive\\stale.pdf'),
      importAsset,
    })
    render(<App />)

    if (lifecycleChange === 'document') {
      await user.click(screen.getByRole('button', { name: '选择工作区' }))
      await user.click(await screen.findByRole('button', { name: 'note.md' }))
    }

    dropFileAt(
      screen.getByRole('textbox', { name: 'Markdown editor' }),
      new File(['stale'], 'stale.pdf'),
      55,
      66,
      true,
    )
    await waitFor(() => expect(importAsset).toHaveBeenCalledOnce())
    if (lifecycleChange === 'mode') {
      act(() => editorModeBridge.report?.('source'))
    } else {
      await user.click(await screen.findByRole('button', { name: 'other.md' }))
    }

    await act(async () => pendingImport.resolve({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: '过期资源导入失败' },
    }))

    expect(editorDropBridge.insertMarkdown).not.toHaveBeenCalled()
    expect(screen.queryByText('过期资源导入失败')).not.toBeInTheDocument()
  },
)

it.each(['resolve', 'reject'] as const)(
  'invalidates a resource import when a dirty document switch awaits confirmation before %s',
  async (settlement) => {
    const user = userEvent.setup()
    const pendingImport = deferred<ApiResult<ImportedAsset>>()
    const readDocument = vi.fn(async (relativePath: string) => ({
      ok: true as const,
      value: {
        relativePath,
        markdown: `# ${relativePath}`,
        revision: revisionA,
        encoding: 'utf8' as const,
        newline: 'lf' as const,
        mtimeMs: 1,
      },
    }))
    installApi({
      listDirectory: vi.fn(async () => ({
        ok: true as const,
        value: [
          { name: 'note.md', relativePath: 'note.md', kind: 'document' as const },
          { name: 'other.md', relativePath: 'other.md', kind: 'document' as const },
        ],
      })),
      readDocument,
      pathForDroppedFile: vi.fn(() => 'C:\\Archive\\pending-switch.pdf'),
      importAsset: vi.fn(() => pendingImport.promise),
    })
    render(<App />)

    await user.click(screen.getByRole('button', { name: '选择工作区' }))
    await user.click(await screen.findByRole('button', { name: 'note.md' }))
    await waitFor(() => expect(readDocument).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), {
      target: { value: '# Dirty note' },
    })
    dropFileAt(
      screen.getByRole('textbox', { name: 'Markdown editor' }),
      new File(['pending'], 'pending-switch.pdf'),
      55,
      66,
      true,
    )
    await waitFor(() => expect(window.arkdown.importAsset).toHaveBeenCalledOnce())

    await user.click(await screen.findByRole('button', { name: 'other.md' }))
    const dialog = await screen.findByRole('dialog', { name: '是否保存对“note.md”的更改？' })
    expect(readDocument).toHaveBeenCalledOnce()

    await act(async () => {
      if (settlement === 'resolve') {
        pendingImport.resolve({
          ok: true,
          value: {
            assetId: 'stale', category: 'pdf', fileName: 'pending-switch.pdf',
            relativePath: '.arkdown-assets/pending-switch.pdf',
            previewUrl: 'arkdown-asset://pending-switch.pdf',
            markdown: '[pending-switch.pdf](arkdown-asset:pending-switch.pdf)',
          },
        })
      } else {
        pendingImport.reject(new Error('过期资源异常'))
        await pendingImport.promise.catch(() => undefined)
      }
    })

    expect(editorDropBridge.insertMarkdown).not.toHaveBeenCalled()
    expect(screen.queryByText('过期资源异常')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
  },
)

it('reports a current resource import rejection without inserting content', async () => {
  const pendingImport = deferred<ApiResult<ImportedAsset>>()
  const importAsset = vi.fn(() => pendingImport.promise)
  installApi({
    pathForDroppedFile: vi.fn(() => 'C:\\Archive\\broken.pdf'),
    importAsset,
  })
  render(<App />)

  dropFileAt(
    screen.getByRole('textbox', { name: 'Markdown editor' }),
    new File(['broken'], 'broken.pdf'),
    55,
    66,
    true,
  )
  await waitFor(() => expect(importAsset).toHaveBeenCalledOnce())

  await act(async () => {
    pendingImport.reject(new Error('资源导入异常'))
    await pendingImport.promise.catch(() => undefined)
  })

  expect(screen.getByText('资源导入异常')).toBeInTheDocument()
  expect(editorDropBridge.insertMarkdown).not.toHaveBeenCalled()
})

it('ignores a resource import rejection after the editor mode changes', async () => {
  const pendingImport = deferred<ApiResult<ImportedAsset>>()
  const importAsset = vi.fn(() => pendingImport.promise)
  installApi({
    pathForDroppedFile: vi.fn(() => 'C:\\Archive\\stale-rejection.pdf'),
    importAsset,
  })
  render(<App />)

  dropFileAt(
    screen.getByRole('textbox', { name: 'Markdown editor' }),
    new File(['stale'], 'stale-rejection.pdf'),
    55,
    66,
    true,
  )
  await waitFor(() => expect(importAsset).toHaveBeenCalledOnce())
  act(() => editorModeBridge.report?.('source'))

  await act(async () => {
    pendingImport.reject(new Error('过期资源异常'))
    await pendingImport.promise.catch(() => undefined)
  })

  expect(screen.queryByText('过期资源异常')).not.toBeInTheDocument()
  expect(editorDropBridge.insertMarkdown).not.toHaveBeenCalled()
})

it('offers workspace, path, and cancel choices for a dropped folder', async () => {
  const user = userEvent.setup()
  const inspectDroppedPath = vi.fn(async (absolutePath: string) => ({
    ok: true as const,
    value: { kind: 'directory' as const, absolutePath },
  }))
  const openDroppedPath = vi.fn(async () => ({
    ok: true as const,
    value: { workspace, document: null },
  }))
  installApi({
    pathForDroppedFile: vi.fn(() => 'C:\\Workspace Folder'),
    inspectDroppedPath,
    openDroppedPath,
  })
  render(<App />)
  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })

  dropFileAt(editor, new File([], 'Workspace Folder'), 44, 88)

  const dialog = await screen.findByRole('dialog', { name: '添加文件夹' })
  expect(dialog).toHaveTextContent('将文件夹以工作区的方式打开，还是将文件夹路径加入正文？')
  expect(within(dialog).getByRole('button', { name: '工作区' })).toBeVisible()
  expect(within(dialog).getByRole('button', { name: '路径' })).toBeVisible()
  expect(within(dialog).getByRole('button', { name: '取消' })).toBeVisible()

  const insertPath = within(dialog).getByRole('button', { name: '路径' })
  await user.click(insertPath)
  expect(dialog.parentElement).toHaveAttribute('data-state', 'closing')
  expect(editorDropBridge.insert).not.toHaveBeenCalled()
  fireEvent.click(insertPath)
  expect(editorDropBridge.insert).not.toHaveBeenCalled()
  await waitFor(() => expect(editorDropBridge.insert).toHaveBeenCalledOnce())
  expect(editorDropBridge.insert).toHaveBeenLastCalledWith({
    absolutePath: 'C:\\Workspace Folder', clientX: 44, clientY: 88, kind: 'folder',
  })
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  expect(openDroppedPath).not.toHaveBeenCalled()

  dropFileAt(editor, new File([], 'Workspace Folder'), 22, 33)
  await user.click(await screen.findByRole('button', { name: '工作区' }))
  await waitFor(() => expect(openDroppedPath).toHaveBeenCalledWith('C:\\Workspace Folder'))
})

it('gates a dropped folder before opening another workspace and preserves the current AI session on cancel', async () => {
  const user = userEvent.setup()
  const otherWorkspace = { name: 'Other', absolutePath: 'D:/Other' }
  const openDroppedPath = vi.fn(async () => ({
    ok: true as const,
    value: { workspace: otherWorkspace, document: null },
  }))
  installApi({
    pathForDroppedFile: vi.fn(() => 'D:\\Other'),
    inspectDroppedPath: vi.fn(async () => ({
      ok: true as const,
      value: { kind: 'directory' as const, absolutePath: 'D:\\Other' },
    })),
    openDroppedPath,
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await waitFor(() => expect(editorInstanceBridge.stores.at(-1)?.activeWorkspaceId)
    .toBe('workspace-notes'))
  const store = editorInstanceBridge.stores.at(-1)!
  const currentSession = store.sessions.get('workspace-notes')!
  currentSession.messages.push({ id: 'drop-user', role: 'user', content: '保留当前会话' })

  dropFileAt(
    screen.getByRole('textbox', { name: 'Markdown editor' }),
    new File([], 'Other'),
    22,
    33,
  )
  await user.click(await screen.findByRole('button', { name: '工作区' }))
  const switchDialog = await screen.findByRole('dialog', {
    name: '切换工作区将创建新的AI对话',
  })

  expect(openDroppedPath).not.toHaveBeenCalled()
  await user.click(within(switchDialog).getByRole('button', { name: '取消' }))

  await waitFor(() => expect(switchDialog).not.toBeInTheDocument())
  expect(openDroppedPath).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Notes' })).toBeVisible()
  expect(store.activeWorkspaceId).toBe('workspace-notes')
  expect(store.sessions.get('workspace-notes')).toBe(currentSession)
  expect(currentSession.messages.map(({ content }) => content)).toEqual(['保留当前会话'])
})

it('opens the current dropped workspace without prompting even when its AI conversation is non-empty', async () => {
  const user = userEvent.setup()
  const openDroppedPath = vi.fn(async () => ({
    ok: true as const,
    value: { workspace, document: null },
  }))
  installApi({
    pathForDroppedFile: vi.fn(() => 'c:\\notes\\'),
    inspectDroppedPath: vi.fn(async () => ({
      ok: true as const,
      value: { kind: 'directory' as const, absolutePath: 'c:\\notes\\' },
    })),
    openDroppedPath,
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await waitFor(() => expect(editorInstanceBridge.stores.at(-1)?.activeWorkspaceId)
    .toBe('workspace-notes'))
  editorInstanceBridge.stores.at(-1)!.sessions.get('workspace-notes')!.messages.push({
    id: 'same-drop-user', role: 'user', content: '同一工作区',
  })

  dropFileAt(
    screen.getByRole('textbox', { name: 'Markdown editor' }),
    new File([], 'Notes'),
    22,
    33,
  )
  await user.click(await screen.findByRole('button', { name: '工作区' }))

  await waitFor(() => expect(openDroppedPath).toHaveBeenCalledWith('c:\\notes\\'))
  expect(screen.queryByRole('dialog', {
    name: '切换工作区将创建新的AI对话',
  })).not.toBeInTheDocument()
})

function addHistoryRecord(input: {
  requestId: string
  documentKey: string
  relativePath?: string | null
  revision?: string | null
  mode?: 'visual' | 'source'
  anchorStatus?: 'valid' | 'location-changed'
}) {
  const port = translationHistoryPortBridge.latest!
  return port.finalize({
    requestId: input.requestId,
    documentKey: input.documentKey,
    workspaceAbsolutePath: input.relativePath === null ? null : 'C:/Notes',
    documentRelativePath: input.relativePath === null
      ? null
      : input.relativePath ?? input.documentKey.split('/').at(-1)!,
    documentAbsolutePath: input.relativePath === null ? null : input.documentKey,
    documentRevision: input.revision === undefined ? revisionA : input.revision,
    mode: input.mode ?? 'visual',
    source: { markdown: 'source', plainText: 'source' },
    translatedMarkdown: input.requestId,
    modelId: 'model',
    targetLanguage: 'en',
    terminal: 'completed',
    anchor: input.mode === 'source'
      ? {
          mode: 'source', from: 0, to: 6, lineStart: 0,
          fingerprint: { before: '', selected: 'source', after: '' },
          status: input.anchorStatus ?? 'valid',
        }
      : {
          mode: 'visual', from: 0, to: 6, blockStart: 0,
          fingerprint: { before: '', selected: 'source', after: '' },
          status: input.anchorStatus ?? 'valid',
        },
  })!
}

it('owns one generic right-sidebar state shared by the header and editor', async () => {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))

  expect(screen.getByTestId('editor-right-sidebar-state')).toHaveTextContent('closed:ai-chat')
  await user.click(screen.getByRole('button', { name: '打开右侧栏' }))
  expect(screen.getByTestId('editor-right-sidebar-state')).toHaveTextContent('open:ai-chat')
  await user.click(screen.getByRole('button', { name: '关闭右侧栏' }))
  expect(screen.getByTestId('editor-right-sidebar-state')).toHaveTextContent('closed:ai-chat')

  await user.click(screen.getByRole('button', { name: 'AI 对话' }))
  expect(screen.getByTestId('editor-right-sidebar-state')).toHaveTextContent('open:ai-chat')
  await user.click(screen.getByRole('button', { name: '关闭右侧栏' }))
  await user.click(screen.getByRole('button', { name: '打开右侧栏' }))
  expect(screen.getByTestId('editor-right-sidebar-state')).toHaveTextContent('open:ai-chat')
})

it('persists each real resize after default, successful write, and equal broadcast snapshots', async () => {
  const user = userEvent.setup()
  let revision = 0
  const compareAndSetLayoutPreferences = vi.fn(async (
    expectedRevision: number,
    _expected: { leftSidebarWidth: number; rightSidebarWidth: number },
    replacement: { leftSidebarWidth: number; rightSidebarWidth: number },
  ) => {
    if (expectedRevision !== revision) {
      return { ok: true as const, value: {
        applied: false,
        snapshot: { layout: { leftSidebarWidth: 300, rightSidebarWidth: 530 }, revision },
      } }
    }
    revision += 1
    return { ok: true as const, value: {
      applied: true,
      snapshot: { layout: replacement, revision },
    } }
  })
  installApi({
    getLayoutPreferences: vi.fn(async () => ({
      ok: true as const,
      value: { layout: { leftSidebarWidth: 300, rightSidebarWidth: 530 }, revision: 0 },
    })),
    compareAndSetLayoutPreferences,
    onLayoutPreferencesChanged: vi.fn((handler) => {
      layoutPreferencesChanged = handler
      return () => { if (layoutPreferencesChanged === handler) layoutPreferencesChanged = null }
    }),
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))

  await waitFor(() => {
    expect(screen.getByTestId('editor-right-sidebar-width')).toHaveTextContent('530')
    expect(document.querySelector('.app-shell')).toHaveStyle({ '--sidebar-width': '300px' })
  })
  fireEvent.keyDown(screen.getByRole('separator', { name: '调整侧边栏宽度' }), { key: 'ArrowRight' })
  await waitFor(() => expect(compareAndSetLayoutPreferences).toHaveBeenCalledWith(
    0,
    { leftSidebarWidth: 300, rightSidebarWidth: 530 },
    { leftSidebarWidth: 310, rightSidebarWidth: 530 },
  ))
  await user.click(screen.getByRole('button', { name: '调整右侧栏' }))
  await waitFor(() => expect(compareAndSetLayoutPreferences).toHaveBeenLastCalledWith(
    1,
    { leftSidebarWidth: 310, rightSidebarWidth: 530 },
    { leftSidebarWidth: 310, rightSidebarWidth: 830 },
  ))

  await act(async () => layoutPreferencesChanged?.({
    layout: { leftSidebarWidth: 310, rightSidebarWidth: 830 },
    revision: 3,
  }))
  revision = 3
  fireEvent.keyDown(screen.getByRole('separator', { name: '调整侧边栏宽度' }), { key: 'ArrowRight' })
  await waitFor(() => expect(compareAndSetLayoutPreferences).toHaveBeenLastCalledWith(
    3,
    { leftSidebarWidth: 310, rightSidebarWidth: 830 },
    { leftSidebarWidth: 320, rightSidebarWidth: 830 },
  ))
  await new Promise((resolve) => window.setTimeout(resolve, 220))
  expect(compareAndSetLayoutPreferences).toHaveBeenCalledTimes(3)
})

it('submits only a dirty left width and adopts a merged remote right width in one transaction', async () => {
  const { patch, layout } = installObservedPreferences()
  patch.mockImplementationOnce(async input => {
    expect(input).toEqual({ observed: structuredClone(layout), changes: { leftSidebarWidth: 310 } })
    return { ok: true, value: { status: 'committed', snapshot: { ...layout,
      values: { leftSidebarWidth: 310, rightSidebarWidth: 760 },
      observation: { ...layout.observation, revision: 3, fields: { leftSidebarWidth: 3, rightSidebarWidth: 2 } } } } }
  })
  render(<App />)
  const separator = screen.getByRole('separator', { name: '调整侧边栏宽度' })
  await waitFor(() => expect(separator).toHaveAttribute('aria-disabled', 'false'))
  fireEvent.keyDown(separator, { key: 'ArrowRight' })
  await waitFor(() => expect(patch).toHaveBeenCalledOnce())
  await waitFor(() => expect(screen.getByTestId('editor-right-sidebar-width')).toHaveTextContent('760'))
  expect(document.querySelector('.app-shell')).toHaveStyle({ '--sidebar-width': '310px' })
})

it('keeps a conflicting right resize without retry and blocks close until explicit saved-layout reload', async () => {
  const { patch, layout } = installObservedPreferences()
  patch.mockImplementationOnce(async () => ({ ok: true, value: { status: 'conflict', reason: 'field-changed',
    fields: ['rightSidebarWidth'], snapshot: { ...layout, values: { leftSidebarWidth: 420, rightSidebarWidth: 600 },
      observation: { ...layout.observation, revision: 3, fields: { rightSidebarWidth: 3 } } } } }))
  render(<App />)
  await waitFor(() => expect(screen.getByRole('separator')).toHaveAttribute('aria-disabled', 'false'))
  fireEvent.click(screen.getByRole('button', { name: '调整右侧栏' }))
  await screen.findByRole('button', { name: '重新加载窗口布局' })
  expect(patch).toHaveBeenCalledOnce()
  expect(patch.mock.calls[0]![0].changes).toEqual({ rightSidebarWidth: 830 })
  expect(screen.getByTestId('editor-right-sidebar-width')).toHaveTextContent('830')
  await act(async () => { expect(await prepareClose()).toBe(false) })
  layout.values = { leftSidebarWidth: 420, rightSidebarWidth: 600 }
  layout.observation.revision = 3
  layout.observation.fields = { rightSidebarWidth: 3 }
  patch.mockImplementationOnce(async input => {
    if (input.observed.group !== 'layout') throw new Error('unexpected group')
    return { ok: true, value: { status: 'unchanged', snapshot: input.observed } }
  })
  fireEvent.click(screen.getByRole('button', { name: '重新加载窗口布局' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '重新加载窗口布局' })).not.toBeInTheDocument())
  expect(patch).toHaveBeenCalledTimes(2)
  expect(patch.mock.calls[1]![0]).toEqual({ observed: layout, changes: { rightSidebarWidth: 600 } })
  await act(async () => { expect(await prepareClose()).toBe(true) })
})

it('retains the original left observation while a separate right write is pending', async () => {
  const { patch, layout } = installObservedPreferences()
  const pending = deferred<ApiResult<import('../../src/shared/preference-observation').PublicPreferenceMutation>>()
  patch.mockImplementationOnce(() => pending.promise).mockImplementationOnce(async () => ({ ok: true,
    value: { status: 'committed', snapshot: { ...layout, values: { leftSidebarWidth: 310, rightSidebarWidth: 830 },
      observation: { ...layout.observation, revision: 3 } } } }))
  render(<App />)
  const separator = screen.getByRole('separator', { name: '调整侧边栏宽度' })
  await waitFor(() => expect(separator).toHaveAttribute('aria-disabled', 'false'))
  fireEvent.click(screen.getByRole('button', { name: '调整右侧栏' }))
  await waitFor(() => expect(patch).toHaveBeenCalledOnce())
  fireEvent.keyDown(separator, { key: 'ArrowRight' })
  expect(document.querySelector('.app-shell')).toHaveStyle({ '--sidebar-width': '310px' })
  await act(async () => pending.resolve({ ok: true, value: { status: 'committed', snapshot: { ...layout,
    values: { leftSidebarWidth: 300, rightSidebarWidth: 830 }, observation: { ...layout.observation, revision: 2 } } } }))
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
  expect(patch.mock.calls[1]![0]).toEqual({ observed: layout, changes: { leftSidebarWidth: 310 } })
  expect(screen.getByTestId('editor-right-sidebar-width')).toHaveTextContent('830')
})

it('preserves and persists a left-sidebar ABA while its earlier CAS succeeds', async () => {
  const user = userEvent.setup()
  let resolveFirstAttempt: ((value: unknown) => void) | undefined
  const compareAndSetLayoutPreferences = vi.fn()
    .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstAttempt = resolve }))
    .mockResolvedValueOnce({
      ok: true as const,
      value: {
        applied: true,
        snapshot: { layout: { leftSidebarWidth: 300, rightSidebarWidth: 530 }, revision: 2 },
      },
    })
  installApi({
    getLayoutPreferences: vi.fn(async () => ({
      ok: true as const,
      value: { layout: { leftSidebarWidth: 300, rightSidebarWidth: 530 }, revision: 0 },
    })),
    compareAndSetLayoutPreferences,
    onLayoutPreferencesChanged: vi.fn((handler) => {
      layoutPreferencesChanged = handler
      return () => { if (layoutPreferencesChanged === handler) layoutPreferencesChanged = null }
    }),
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))

  const separator = screen.getByRole('separator', { name: '调整侧边栏宽度' })
  fireEvent.keyDown(separator, { key: 'ArrowRight' })
  await waitFor(() => expect(compareAndSetLayoutPreferences).toHaveBeenCalledTimes(1))
  fireEvent.keyDown(separator, { key: 'ArrowLeft' })
  expect(document.querySelector('.app-shell')).toHaveStyle({ '--sidebar-width': '300px' })

  act(() => resolveFirstAttempt?.({
    ok: true,
    value: {
      applied: true,
      snapshot: { layout: { leftSidebarWidth: 310, rightSidebarWidth: 530 }, revision: 1 },
    },
  }))

  await waitFor(() => expect(compareAndSetLayoutPreferences).toHaveBeenCalledTimes(2))
  expect(compareAndSetLayoutPreferences.mock.calls).toEqual([
    [0, { leftSidebarWidth: 300, rightSidebarWidth: 530 }, { leftSidebarWidth: 310, rightSidebarWidth: 530 }],
    [1, { leftSidebarWidth: 310, rightSidebarWidth: 530 }, { leftSidebarWidth: 300, rightSidebarWidth: 530 }],
  ])
  expect(document.querySelector('.app-shell')).toHaveStyle({ '--sidebar-width': '300px' })
  await new Promise((resolve) => window.setTimeout(resolve, 220))
  expect(compareAndSetLayoutPreferences).toHaveBeenCalledTimes(2)
})

it('preserves and persists a left-sidebar ABA when success broadcasts before its response', async () => {
  const user = userEvent.setup()
  let resolveFirstAttempt: ((value: unknown) => void) | undefined
  const compareAndSetLayoutPreferences = vi.fn()
    .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstAttempt = resolve }))
    .mockResolvedValueOnce({
      ok: true as const,
      value: {
        applied: true,
        snapshot: { layout: { leftSidebarWidth: 300, rightSidebarWidth: 530 }, revision: 2 },
      },
    })
  installApi({
    getLayoutPreferences: vi.fn(async () => ({
      ok: true as const,
      value: { layout: { leftSidebarWidth: 300, rightSidebarWidth: 530 }, revision: 0 },
    })),
    compareAndSetLayoutPreferences,
    onLayoutPreferencesChanged: vi.fn((handler) => {
      layoutPreferencesChanged = handler
      return () => { if (layoutPreferencesChanged === handler) layoutPreferencesChanged = null }
    }),
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))

  const separator = screen.getByRole('separator', { name: '调整侧边栏宽度' })
  fireEvent.keyDown(separator, { key: 'ArrowRight' })
  await waitFor(() => expect(compareAndSetLayoutPreferences).toHaveBeenCalledTimes(1))
  fireEvent.keyDown(separator, { key: 'ArrowLeft' })

  act(() => {
    layoutPreferencesChanged?.({
      layout: { leftSidebarWidth: 310, rightSidebarWidth: 530 },
      revision: 1,
    })
    resolveFirstAttempt?.({
      ok: true,
      value: {
        applied: true,
        snapshot: { layout: { leftSidebarWidth: 310, rightSidebarWidth: 530 }, revision: 1 },
      },
    })
  })

  expect(document.querySelector('.app-shell')).toHaveStyle({ '--sidebar-width': '300px' })
  await waitFor(() => expect(compareAndSetLayoutPreferences).toHaveBeenCalledTimes(2))
  expect(compareAndSetLayoutPreferences.mock.calls).toEqual([
    [0, { leftSidebarWidth: 300, rightSidebarWidth: 530 }, { leftSidebarWidth: 310, rightSidebarWidth: 530 }],
    [1, { leftSidebarWidth: 310, rightSidebarWidth: 530 }, { leftSidebarWidth: 300, rightSidebarWidth: 530 }],
  ])
  expect(document.querySelector('.app-shell')).toHaveStyle({ '--sidebar-width': '300px' })
  await new Promise((resolve) => window.setTimeout(resolve, 220))
  expect(compareAndSetLayoutPreferences).toHaveBeenCalledTimes(2)
})

it('retains the latest same-side resize through consecutive conflicts without rebasing its observation', async () => {
  const { patch, layout } = installObservedPreferences()
  render(<App />)
  const separator = screen.getByRole('separator', { name: '调整侧边栏宽度' })
  await waitFor(() => expect(separator).toHaveAttribute('aria-disabled', 'false'))
  fireEvent.keyDown(separator, { key: 'ArrowRight' })
  await screen.findByRole('button', { name: '重新加载窗口布局' })
  fireEvent.keyDown(separator, { key: 'ArrowRight' })
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
  expect(patch.mock.calls.map(call => call[0].observed)).toEqual([layout, layout])
  expect(patch.mock.calls[1]![0].changes).toEqual({ leftSidebarWidth: 320 })
  expect(document.querySelector('.app-shell')).toHaveStyle({ '--sidebar-width': '320px' })
  await act(async () => { expect(await prepareClose()).toBe(false) })
})

it('does not retry when a conflict snapshot already contains the local right resize', async () => {
  const user = userEvent.setup()
  const compareAndSetLayoutPreferences = vi.fn()
    .mockResolvedValueOnce({
      ok: true as const,
      value: {
        applied: false,
        snapshot: { layout: { leftSidebarWidth: 300, rightSidebarWidth: 830 }, revision: 1 },
      },
    })
    .mockResolvedValue({ ok: false as const, error: { code: 'OPERATION_FAILED', message: 'unexpected retry' } })
  installApi({
    getLayoutPreferences: vi.fn(async () => ({
      ok: true as const,
      value: { layout: { leftSidebarWidth: 300, rightSidebarWidth: 530 }, revision: 0 },
    })),
    compareAndSetLayoutPreferences,
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))

  await user.click(screen.getByRole('button', { name: '调整右侧栏' }))
  await new Promise((resolve) => window.setTimeout(resolve, 220))

  expect(compareAndSetLayoutPreferences).toHaveBeenCalledTimes(1)
  expect(screen.getByTestId('editor-right-sidebar-width')).toHaveTextContent('830')
})

it('uses AI chat for documents without an explicit right-sidebar tab selection', async () => {
  const user = userEvent.setup()
  installApi({
    listDirectory: vi.fn(async () => ({
      ok: true as const,
      value: [
        { name: 'a.md', relativePath: 'a.md', kind: 'document' as const },
        { name: 'b.md', relativePath: 'b.md', kind: 'document' as const },
      ],
    })),
    readDocument: vi.fn(async (relativePath: string) => ({
      ok: true as const,
      value: {
        relativePath,
        markdown: `# ${relativePath}`,
        revision: revisionA,
        encoding: 'utf8' as const,
        newline: 'lf' as const,
        mtimeMs: 1,
      },
    })),
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'a.md' }))
  await user.click(screen.getByRole('button', { name: 'AI 对话' }))
  expect(screen.getByTestId('editor-right-sidebar-state')).toHaveTextContent('open:ai-chat')

  await user.click(screen.getByRole('button', { name: 'b.md' }))
  expect(screen.getByTestId('editor-right-sidebar-state')).toHaveTextContent('open:ai-chat')

  await user.click(screen.getByRole('button', { name: 'a.md' }))
  expect(screen.getByTestId('editor-right-sidebar-state')).toHaveTextContent('open:ai-chat')

  await user.click(screen.getByRole('button', { name: 'b.md' }))
  expect(screen.getByTestId('editor-right-sidebar-state')).toHaveTextContent('open:ai-chat')
})

it('keeps the explicitly selected right-sidebar tab across document switches', async () => {
  const user = userEvent.setup()
  installApi({
    listDirectory: vi.fn(async () => ({
      ok: true as const,
      value: [
        { name: 'a.md', relativePath: 'a.md', kind: 'document' as const },
        { name: 'b.md', relativePath: 'b.md', kind: 'document' as const },
      ],
    })),
    readDocument: vi.fn(async (relativePath: string) => ({
      ok: true as const,
      value: {
        relativePath, markdown: `# ${relativePath}`, revision: revisionA,
        encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 1,
      },
    })),
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'a.md' }))
  expect(screen.getByTestId('editor-right-sidebar-state')).toHaveTextContent('closed:ai-chat')

  await user.click(screen.getByRole('button', { name: '翻译' }))
  expect(screen.getByTestId('editor-right-sidebar-state')).toHaveTextContent('open:translation')
  await user.click(screen.getByRole('button', { name: 'b.md' }))
  expect(screen.getByTestId('editor-right-sidebar-state')).toHaveTextContent('open:translation')
  await user.click(screen.getByRole('button', { name: 'a.md' }))
  expect(screen.getByTestId('editor-right-sidebar-state')).toHaveTextContent('open:translation')

  await user.click(screen.getByRole('button', { name: 'AI 对话' }))
  expect(screen.getByTestId('editor-right-sidebar-state')).toHaveTextContent('open:ai-chat')
})

it('supplies AI document metadata and the current dirty state to EditorPane', async () => {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })

  expect(editor).toHaveAttribute('data-document-display-name', 'note.md')
  expect(editor).toHaveAttribute('data-document-source-format', 'markdown')
  expect(editor).toHaveAttribute('data-document-dirty', 'false')

  fireEvent.change(editor, { target: { value: '# Unsaved' } })
  expect(editor).toHaveAttribute('data-document-dirty', 'true')
})

it('remounts keyed editors while preserving the window AI conversation store', async () => {
  const user = userEvent.setup()
  installApi({
    listDirectory: vi.fn(async () => ({
      ok: true as const,
      value: [
        { name: 'note.md', relativePath: 'note.md', kind: 'document' as const },
        { name: 'other.md', relativePath: 'other.md', kind: 'document' as const },
      ],
    })),
    readDocument: vi.fn(async (relativePath: string) => ({
      ok: true as const,
      value: {
        relativePath,
        markdown: `# ${relativePath}`,
        revision: revisionA,
        encoding: 'utf8' as const,
        newline: 'lf' as const,
        mtimeMs: 1,
      },
    })),
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const firstInstance = screen.getByRole('textbox', { name: 'Markdown editor' })
    .getAttribute('data-editor-instance')
  const firstStore = editorInstanceBridge.stores.at(-1)
  expect(firstStore).toBeDefined()
  const mountsBeforeSwitch = editorInstanceBridge.mounts

  await user.click(screen.getByRole('button', { name: 'other.md' }))

  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .not.toHaveAttribute('data-editor-instance', firstInstance)
  expect(editorInstanceBridge.mounts).toBe(mountsBeforeSwitch + 1)
  expect(editorInstanceBridge.stores.at(-1)).toBe(firstStore)
})

it('keeps the AI conversation store across a real deferred document open', async () => {
  const user = userEvent.setup()
  const deferredOther = deferred<ApiResult<DocumentSnapshot>>()
  installApi({
    listDirectory: vi.fn(async () => ({
      ok: true as const,
      value: [
        { name: 'note.md', relativePath: 'note.md', kind: 'document' as const },
        { name: 'other.md', relativePath: 'other.md', kind: 'document' as const },
      ],
    })),
    readDocument: vi.fn((relativePath: string) => relativePath === 'other.md'
      ? deferredOther.promise
      : Promise.resolve({
          ok: true as const,
          value: {
            relativePath,
            markdown: '# note',
            revision: revisionA,
            encoding: 'utf8' as const,
            newline: 'lf' as const,
            mtimeMs: 1,
          },
        })),
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const firstEditor = screen.getByRole('textbox', { name: 'Markdown editor' })
  const firstStore = editorInstanceBridge.stores.at(-1)
  expect(firstStore).toBeDefined()

  await user.click(screen.getByRole('button', { name: 'other.md' }))
  expect(screen.queryByRole('textbox', { name: 'Markdown editor' })).not.toBeInTheDocument()
  expect(screen.getByText('正在读取文档…')).toBeVisible()

  deferredOther.resolve({
    ok: true,
    value: {
      relativePath: 'other.md',
      markdown: '# other',
      revision: revisionA,
      encoding: 'utf8',
      newline: 'lf',
      mtimeMs: 2,
    },
  })
  const nextEditor = await screen.findByRole('textbox', { name: 'Markdown editor' })
  expect(nextEditor).not.toBe(firstEditor)
  expect(editorInstanceBridge.stores.at(-1)).toBe(firstStore)
})

it('owns one edit-indicator model with real baselines, save transitions, and visibility', async () => {
  const user = userEvent.setup()
  editIndicatorModelBridge.implementation = (input) => ({
    lineStates: [input.currentMarkdown === input.openingMarkdown
      ? 'none'
      : input.currentMarkdown === input.savedMarkdown ? 'saved' : 'unsaved'],
    status: 'ready',
    markdownVersion: 1,
    modelVersion: 1,
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))

  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })
  expect(editIndicatorModelBridge.inputs.at(-1)).toEqual({
    documentKey: 'C:/Notes/note.md',
    openingMarkdown: '# Note',
    savedMarkdown: '# Note',
    currentMarkdown: '# Note',
    enabled: false,
  })
  expect(editor).toHaveAttribute('data-edit-indicator-state', 'none')
  expect(editor).toHaveAttribute('data-show-edit-indicators', 'true')
  act(() => editorModeBridge.report?.('source'))
  expect(editIndicatorModelBridge.inputs.at(-1)?.enabled).toBe(true)

  fireEvent.change(editor, { target: { value: '# Changed' } })
  expect(editor).toHaveAttribute('data-edit-indicator-state', 'unsaved')
  expect(editIndicatorModelBridge.inputs.at(-1)?.currentMarkdown).toBe('# Changed')

  act(() => menuCommand?.('save'))
  await waitFor(() => expect(window.arkdown.saveDocument).toHaveBeenCalledOnce())
  await waitFor(() => expect(editIndicatorModelBridge.inputs.at(-1)?.savedMarkdown).toBe('# Changed'))
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toBe(editor)
  expect(editor).toHaveAttribute('data-edit-indicator-state', 'saved')

  fireEvent.change(editor, { target: { value: '# Note' } })
  expect(editor).toHaveAttribute('data-edit-indicator-state', 'none')

  await act(async () => editorAppearanceChanged?.(appearanceSnapshot({
    ...DEFAULT_EDITOR_APPEARANCE,
    showEditIndicators: false,
  }, 1)))
  expect(editIndicatorModelBridge.inputs.at(-1)?.enabled).toBe(true)
  expect(editor).toHaveAttribute('data-show-edit-indicators', 'false')
})

it.each([
  ['chapter.md', 'C:\\Drafts\\chapter.md'],
  ['notes.txt', 'C:\\Drafts\\notes.txt'],
  ['source.docx', 'C:\\Drafts\\source.docx'],
])('inserts dropped document %s as a path link instead of opening or importing it', async (name, absolutePath) => {
  const inspectDroppedPath = vi.fn(async () => ({
    ok: true as const,
    value: { kind: 'file' as const, absolutePath },
  }))
  const importAsset = vi.fn()
  const openDocumentWindow = vi.fn()
  installApi({
    pathForDroppedFile: vi.fn(() => absolutePath),
    inspectDroppedPath,
    importAsset,
    openDocumentWindow,
  })
  render(<App />)

  dropFileAt(
    screen.getByRole('textbox', { name: 'Markdown editor' }),
    new File(['document'], name),
    88,
    144,
  )

  await waitFor(() => expect(editorDropBridge.insert).toHaveBeenCalledWith({
    absolutePath,
    clientX: 88,
    clientY: 144,
    kind: 'file',
  }))
  expect(inspectDroppedPath).toHaveBeenCalledWith(absolutePath)
  expect(importAsset).not.toHaveBeenCalled()
  expect(openDocumentWindow).not.toHaveBeenCalled()
  expect(window.arkdown.openDroppedPath).not.toHaveBeenCalled()
})

it('threads a visual drop request id through asynchronous path inspection', async () => {
  const inspection = deferred<{
    ok: true
    value: { kind: 'file'; absolutePath: string }
  }>()
  installApi({
    pathForDroppedFile: vi.fn(() => 'C:\\Drafts\\chapter.md'),
    inspectDroppedPath: vi.fn(() => inspection.promise),
  })
  render(<App />)

  const requestId = dropFileAt(
    screen.getByRole('textbox', { name: 'Markdown editor' }),
    new File(['document'], 'chapter.md'),
    88,
    144,
    true,
  )
  expect(requestId).not.toBeUndefined()

  await act(async () => inspection.resolve({
    ok: true,
    value: { kind: 'file', absolutePath: 'C:\\Drafts\\chapter.md' },
  }))
  expect(editorDropBridge.insert).toHaveBeenCalledWith({
    absolutePath: 'C:\\Drafts\\chapter.md',
    clientX: 88,
    clientY: 144,
    kind: 'file',
    visualDropRequestId: requestId,
  })
})

it.each([
  [
    'missing target',
    {
      ok: false as const,
      error: { code: 'FILE_NOT_FOUND' as const, message: '文件不存在或已被移动' },
    },
  ],
  [
    'symbolic link or non-regular target',
    {
      ok: false as const,
      error: { code: 'UNSUPPORTED_FILE_TYPE' as const, message: '不支持的文件类型' },
    },
  ],
  [
    'directory classification',
    {
      ok: true as const,
      value: { kind: 'directory' as const, absolutePath: 'C:\\Drafts\\chapter.md' },
    },
  ],
])('rejects a dropped document with an unsafe %s inspection', async (_case, inspection) => {
  const inspectDroppedPath = vi.fn(async () => inspection)
  installApi({
    pathForDroppedFile: vi.fn(() => 'C:\\Drafts\\chapter.md'),
    inspectDroppedPath,
  })
  render(<App />)

  dropFileAt(
    screen.getByRole('textbox', { name: 'Markdown editor' }),
    new File(['document'], 'chapter.md'),
    88,
    144,
  )

  await waitFor(() => expect(inspectDroppedPath).toHaveBeenCalledOnce())
  expect(editorDropBridge.insert).not.toHaveBeenCalled()
})

it('ignores a document inspection that resolves after a newer drop', async () => {
  const resolutions: Array<(value: {
    ok: true
    value: { kind: 'file'; absolutePath: string }
  }) => void> = []
  const inspectDroppedPath = vi.fn(() => new Promise<{
    ok: true
    value: { kind: 'file'; absolutePath: string }
  }>((resolveInspection) => resolutions.push(resolveInspection)))
  installApi({
    pathForDroppedFile: vi.fn((file: File) => `C:\\Drafts\\${file.name}`),
    inspectDroppedPath,
  })
  render(<App />)
  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })

  dropFileAt(editor, new File(['first'], 'first.md'), 10, 20)
  dropFileAt(editor, new File(['second'], 'second.md'), 30, 40)
  expect(inspectDroppedPath).toHaveBeenCalledTimes(2)

  await act(async () => resolutions[1]!({
    ok: true,
    value: { kind: 'file', absolutePath: 'C:\\Drafts\\second.md' },
  }))
  expect(editorDropBridge.insert).toHaveBeenCalledWith({
    absolutePath: 'C:\\Drafts\\second.md', clientX: 30, clientY: 40, kind: 'file',
  })

  await act(async () => resolutions[0]!({
    ok: true,
    value: { kind: 'file', absolutePath: 'C:\\Drafts\\first.md' },
  }))
  expect(editorDropBridge.insert).toHaveBeenCalledTimes(1)
})

it('ignores a document inspection from an editor lifecycle that has been replaced', async () => {
  const user = userEvent.setup()
  let resolveInspection!: (value: {
    ok: true
    value: { kind: 'file'; absolutePath: string }
  }) => void
  installApi({
    pathForDroppedFile: vi.fn(() => 'C:\\Drafts\\chapter.md'),
    inspectDroppedPath: vi.fn(() => new Promise<{
      ok: true
      value: { kind: 'file'; absolutePath: string }
    }>((resolve) => { resolveInspection = resolve })),
  })
  render(<App />)

  dropFileAt(
    screen.getByRole('textbox', { name: 'Markdown editor' }),
    new File(['document'], 'chapter.md'),
    88,
    144,
  )
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))

  await act(async () => resolveInspection({
    ok: true,
    value: { kind: 'file', absolutePath: 'C:\\Drafts\\chapter.md' },
  }))
  expect(editorDropBridge.insert).not.toHaveBeenCalled()
})

it('ignores a document inspection after the same document content changes', async () => {
  let resolveInspection!: (value: {
    ok: true
    value: { kind: 'file'; absolutePath: string }
  }) => void
  const inspectDroppedPath = vi.fn(() => new Promise<{
    ok: true
    value: { kind: 'file'; absolutePath: string }
  }>((resolve) => { resolveInspection = resolve }))
  installApi({
    pathForDroppedFile: vi.fn(() => 'C:\\Drafts\\chapter.md'),
    inspectDroppedPath,
  })
  render(<App />)
  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })

  dropFileAt(editor, new File(['document'], 'chapter.md'), 88, 144)
  await waitFor(() => expect(inspectDroppedPath).toHaveBeenCalledOnce())
  fireEvent.change(editor, { target: { value: '# Edited while inspecting' } })

  await act(async () => resolveInspection({
    ok: true,
    value: { kind: 'file', absolutePath: 'C:\\Drafts\\chapter.md' },
  }))
  expect(editorDropBridge.insert).not.toHaveBeenCalled()
})

it('retains a window location across asynchronous initial document and workspace adoption', async () => {
  let openIntent: Parameters<NonNullable<ArkdownApi['onOpenIntent']>>[0] | undefined
  let locate: Parameters<NonNullable<ArkdownApi['onDocumentLocation']>>[0] | undefined
  installApi({
    onOpenIntent: handler => { openIntent = handler; return () => {} },
    onDocumentLocation: handler => { locate = handler; return () => {} },
  })
  render(<App />)
  await waitFor(() => { expect(openIntent).toBeDefined(); expect(locate).toBeDefined() })
  const location = { absolutePath: 'C:\\Notes\\note.md', anchor: 'destination' }
  act(() => {
    openIntent!({ workspace, document: { relativePath: 'note.md', markdown: '# Destination', revision: 'a'.repeat(64), encoding: 'utf8', newline: 'lf', mtimeMs: 1 } })
    locate!(location)
  })
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Destination'))
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveAttribute('data-document-location', JSON.stringify(location))
})

it('ignores a document inspection after the same document is reloaded', async () => {
  const user = userEvent.setup()
  let resolveInspection!: (value: {
    ok: true
    value: { kind: 'file'; absolutePath: string }
  }) => void
  const inspectDroppedPath = vi.fn(() => new Promise<{
    ok: true
    value: { kind: 'file'; absolutePath: string }
  }>((resolve) => { resolveInspection = resolve }))
  let openIntent: Parameters<NonNullable<ArkdownApi['onOpenIntent']>>[0] | null = null
  installApi({
    pathForDroppedFile: vi.fn(() => 'C:\\Drafts\\chapter.md'),
    inspectDroppedPath,
    onOpenIntent: vi.fn((handler) => {
      openIntent = handler
      return () => { openIntent = null }
    }),
  })
  render(<App />)
  await waitFor(() => expect(openIntent).not.toBeNull())
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })

  dropFileAt(editor, new File(['document'], 'chapter.md'), 88, 144)
  await waitFor(() => expect(inspectDroppedPath).toHaveBeenCalledOnce())
  act(() => openIntent?.({
    workspace,
    document: {
      relativePath: 'note.md',
      markdown: '# Reloaded through open intent',
      revision: 'b'.repeat(64),
      encoding: 'utf8',
      newline: 'lf',
      mtimeMs: 2,
    },
  }))
  await waitFor(() => expect(editor).toHaveValue('# Reloaded through open intent'))

  await act(async () => resolveInspection({
    ok: true,
    value: { kind: 'file', absolutePath: 'C:\\Drafts\\chapter.md' },
  }))
  expect(editorDropBridge.insert).not.toHaveBeenCalled()
})

it('keeps a document inspection valid across cursor-only movement', async () => {
  let resolveInspection!: (value: {
    ok: true
    value: { kind: 'file'; absolutePath: string }
  }) => void
  installApi({
    pathForDroppedFile: vi.fn(() => 'C:\\Drafts\\chapter.md'),
    inspectDroppedPath: vi.fn(() => new Promise<{
      ok: true
      value: { kind: 'file'; absolutePath: string }
    }>((resolve) => { resolveInspection = resolve })),
  })
  render(<App />)
  const editor = screen.getByRole('textbox', { name: 'Markdown editor' }) as HTMLTextAreaElement

  dropFileAt(editor, new File(['document'], 'chapter.md'), 88, 144)
  editor.setSelectionRange(0, 0)
  fireEvent.select(editor)

  await act(async () => resolveInspection({
    ok: true,
    value: { kind: 'file', absolutePath: 'C:\\Drafts\\chapter.md' },
  }))
  expect(editorDropBridge.insert).toHaveBeenCalledWith({
    absolutePath: 'C:\\Drafts\\chapter.md',
    clientX: 88,
    clientY: 144,
    kind: 'file',
  })
})

it('ignores a document inspection after the editor mode changes', async () => {
  let resolveInspection!: (value: {
    ok: true
    value: { kind: 'file'; absolutePath: string }
  }) => void
  installApi({
    pathForDroppedFile: vi.fn(() => 'C:\\Drafts\\chapter.md'),
    inspectDroppedPath: vi.fn(() => new Promise<{
      ok: true
      value: { kind: 'file'; absolutePath: string }
    }>((resolve) => { resolveInspection = resolve })),
  })
  render(<App />)

  dropFileAt(
    screen.getByRole('textbox', { name: 'Markdown editor' }),
    new File(['document'], 'chapter.md'),
    88,
    144,
  )
  act(() => editorModeBridge.report?.('source'))

  await act(async () => resolveInspection({
    ok: true,
    value: { kind: 'file', absolutePath: 'C:\\Drafts\\chapter.md' },
  }))
  expect(editorDropBridge.insert).not.toHaveBeenCalled()
})

it('ignores a document inspection after the workspace shell unmounts', async () => {
  let resolveInspection!: (value: {
    ok: true
    value: { kind: 'file'; absolutePath: string }
  }) => void
  installApi({
    pathForDroppedFile: vi.fn(() => 'C:\\Drafts\\chapter.md'),
    inspectDroppedPath: vi.fn(() => new Promise<{
      ok: true
      value: { kind: 'file'; absolutePath: string }
    }>((resolve) => { resolveInspection = resolve })),
  })
  const rendered = render(<App />)

  dropFileAt(
    screen.getByRole('textbox', { name: 'Markdown editor' }),
    new File(['document'], 'chapter.md'),
    88,
    144,
  )
  rendered.unmount()

  await act(async () => resolveInspection({
    ok: true,
    value: { kind: 'file', absolutePath: 'C:\\Drafts\\chapter.md' },
  }))
  expect(editorDropBridge.insert).not.toHaveBeenCalled()
})

it('routes the header save button through the current document session', async () => {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))

  expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), {
    target: { value: '# Changed from header' },
  })

  const saveButton = await screen.findByRole('button', { name: '保存' })
  expect(saveButton).toBeEnabled()
  const saveControls = saveButton.closest('.document-save-controls')
  if (!saveControls) throw new Error('document save controls were not rendered')
  expect(within(saveControls as HTMLElement).getByText('未保存')).toBeVisible()
  await user.click(saveButton)

  await waitFor(() => expect(window.arkdown.saveDocument).toHaveBeenCalledOnce())
  await waitFor(() => expect(within(saveControls as HTMLElement).getByText('已保存')).toBeVisible())
  expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
})

it('keeps one App-owned history port across keyed editors and filters the active document', async () => {
  const user = userEvent.setup()
  render(<App />)
  const firstPort = translationHistoryPortBridge.first

  await user.click(screen.getByRole('button', { name: '记录翻译' }))
  expect(screen.getByTestId('history-window-total')).toHaveTextContent('1')
  expect(screen.getByTestId('history-document-total')).toHaveTextContent('1')

  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))

  expect(translationHistoryPortBridge.latest).toBe(firstPort)
  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-document-key', 'C:/Notes/note.md')
  expect(screen.getByTestId('history-window-total')).toHaveTextContent('1')
  expect(screen.getByTestId('history-document-total')).toHaveTextContent('0')
})

it('flushes anchors, opens a history document, and reveals exactly once after matching ready', async () => {
  const user = userEvent.setup()
  const readDocument = vi.fn(async (relativePath: string) => ({
    ok: true as const,
    value: {
      relativePath,
      markdown: `# ${relativePath}`,
      revision: revisionA,
      encoding: 'utf8' as const,
      newline: 'lf' as const,
      mtimeMs: 1,
    },
  }))
  installApi({ readDocument })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const port = translationHistoryPortBridge.latest!
  let record!: NonNullable<ReturnType<typeof port.finalize>>
  act(() => {
    record = port.finalize({
      requestId: 'cross-document-request',
      documentKey: 'c:\\notes\\other.md',
      workspaceAbsolutePath: 'c:\\notes',
      documentRelativePath: 'other.md',
      documentAbsolutePath: 'c:\\notes\\other.md',
      documentRevision: revisionA,
      mode: 'source',
      source: { markdown: 'source', plainText: 'source' },
      translatedMarkdown: 'translated other',
      modelId: 'model',
      targetLanguage: 'en',
      terminal: 'completed',
      anchor: {
        mode: 'source', from: 0, to: 6, lineStart: 0,
        fingerprint: { before: '', selected: 'source', after: '' }, status: 'valid',
      },
    })!
  })
  translationHistoryPortBridge.flushAnchors.mockReturnValueOnce([{
    recordId: record.id,
    anchor: record.anchor,
  }])

  act(() => translationHistoryPortBridge.navigate?.(record.id, 'center'))

  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-document-key', 'C:/Notes/other.md'))
  await waitFor(() => expect(translationHistoryPortBridge.reveal).toHaveBeenCalledWith(record.id, 'center'))
  expect(translationHistoryPortBridge.flushAnchors).toHaveBeenCalledOnce()
  expect(translationHistoryPortBridge.flushAnchors.mock.invocationCallOrder[0])
    .toBeLessThan(readDocument.mock.invocationCallOrder.at(-1)!)

  act(() => translationHistoryPortBridge.ready?.('C:/Notes/other.md', 'source'))
  expect(translationHistoryPortBridge.reveal).toHaveBeenCalledTimes(1)
})

it('centers history navigation inside the active imported DOCX document without a revision', async () => {
  const user = userEvent.setup()
  installApi({
    listDirectory: vi.fn(async () => ({
      ok: true as const,
      value: [{ name: 'report.docx', relativePath: 'report.docx', kind: 'document' as const }],
    })),
    importDocx: vi.fn(async () => ({
      ok: true as const,
      value: {
        sourceAbsolutePath: 'C:/Notes/report.docx',
        sourceFileName: 'report.docx',
        markdown: '# Imported report',
      },
    })),
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'report.docx' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-document-key', 'C:/Notes/report.docx'))
  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-document-source-format', 'docx')
  const record = addHistoryRecord({
    requestId: 'imported-docx-center',
    documentKey: 'C:/Notes/report.docx',
    relativePath: 'report.docx',
    revision: null,
  })

  act(() => translationHistoryPortBridge.navigate?.(record.id, 'center'))

  await waitFor(() => expect(translationHistoryPortBridge.reveal)
    .toHaveBeenCalledWith(record.id, 'center'))
})

it('restores tree keyboard navigation to the current file after cancelling an unsaved switch', async () => {
  const user = userEvent.setup()
  const readDocument = vi.fn(async (relativePath: string) => ({
    ok: true as const,
    value: { relativePath, markdown: `# ${relativePath}`, revision: revisionA,
      encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 1 },
  }))
  installApi({
    readDocument,
    listDirectory: vi.fn(async () => ({ ok: true as const, value: ['note.md', 'other.md', 'last.md'].map(relativePath => ({
      name: relativePath, relativePath, kind: 'document' as const,
    })) })),
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  const first = await screen.findByRole('button', { name: 'note.md' })
  const second = screen.getByRole('button', { name: 'other.md' })
  await user.click(first)
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-document-key', 'C:/Notes/note.md'))
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), { target: { value: '# Dirty note' } })
  first.focus()
  await user.keyboard('{ArrowDown}')
  const dialog = await screen.findByRole('dialog', { name: '是否保存对“note.md”的更改？' })
  expect(readDocument).toHaveBeenCalledTimes(1)
  await user.click(within(dialog).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  expect(first).toHaveAttribute('aria-current', 'page')
  expect(first).toHaveFocus()
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Dirty note')
  await user.keyboard('{ArrowDown}')
  const repeated = await screen.findByRole('dialog', { name: '是否保存对“note.md”的更改？' })
  expect(second).toHaveAttribute('aria-current', 'page')
  expect(readDocument).toHaveBeenCalledTimes(1)
  await user.click(within(repeated).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(repeated).not.toBeInTheDocument())
})

it.each([false, true])('restores failed keyboard navigation while respecting external focus (%s)', async (moveFocusOutside) => {
  const user = userEvent.setup()
  const pending = deferred<ApiResult<import('../../src/shared/contracts').DocumentSnapshot>>()
  installApi({
    readDocument: vi.fn(async (relativePath: string) => relativePath === 'other.md' ? pending.promise : {
      ok: true as const, value: { relativePath, markdown: '# Note', revision: revisionA,
        encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 1 },
    }),
    listDirectory: vi.fn(async () => ({ ok: true as const, value: ['note.md', 'other.md', 'last.md'].map(relativePath => ({
      name: relativePath, relativePath, kind: 'document' as const,
    })) })),
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  const first = await screen.findByRole('button', { name: 'note.md' })
  await user.click(first)
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-document-key', 'C:/Notes/note.md'))
  first.focus()
  await user.keyboard('{ArrowDown}')
  await waitFor(() => expect(window.arkdown.readDocument).toHaveBeenCalledWith('other.md'))
  const outside = screen.getByRole('button', { name: '搜索工作区' })
  if (moveFocusOutside) outside.focus()
  await act(async () => pending.resolve({ ok: false, error: { code: 'READ_FAILED', message: '无法读取目标文档' } }))
  await waitFor(() => expect(first).toHaveAttribute('aria-current', 'page'))
  expect(moveFocusOutside ? outside : first).toHaveFocus()
  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-document-key', 'C:/Notes/note.md')
})

it('keeps the selected history target visible when a dirty document switch is cancelled', async () => {
  const user = userEvent.setup()
  installApi()
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })
  fireEvent.change(editor, { target: { value: '# dirty' } })
  const port = translationHistoryPortBridge.latest!
  let record!: NonNullable<ReturnType<typeof port.finalize>>
  act(() => {
    record = port.finalize({
      requestId: 'cancelled-navigation', documentKey: 'C:/Notes/other.md',
      workspaceAbsolutePath: 'C:/Notes', documentRelativePath: 'other.md',
      documentAbsolutePath: 'C:/Notes/other.md', documentRevision: revisionA,
      mode: 'visual', source: { markdown: 'source', plainText: 'source' },
      translatedMarkdown: 'target', modelId: 'model', targetLanguage: 'en',
      terminal: 'completed',
      anchor: { mode: 'visual', from: 0, to: 6, blockStart: 0,
        fingerprint: { before: '', selected: 'source', after: '' }, status: 'valid' },
    })!
  })

  act(() => translationHistoryPortBridge.navigate?.(record.id))

  const dialog = await screen.findByRole('dialog', { name: '是否保存对“note.md”的更改？' })
  await user.click(within(dialog).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-document-key', 'C:/Notes/note.md')
  expect(port.selectedRecordId).toBe(record.id)
  expect(translationHistoryPortBridge.reveal).not.toHaveBeenCalled()
})

it('invalidates a pending history reveal when a manual new-document action supersedes it', async () => {
  const user = userEvent.setup()
  const pendingRead = deferred<ApiResult<import('../../src/shared/contracts').DocumentSnapshot>>()
  installApi({ readDocument: vi.fn(() => pendingRead.promise) })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const record = addHistoryRecord({
    requestId: 'manual-invalidation',
    documentKey: 'C:/Notes/other.md',
  })

  act(() => translationHistoryPortBridge.navigate?.(record.id))
  act(() => menuCommand?.('new-document'))
  pendingRead.resolve({
    ok: true,
    value: {
      relativePath: 'other.md', markdown: '# Other', revision: revisionA,
      encoding: 'utf8', newline: 'lf', mtimeMs: 1,
    },
  })
  await act(async () => { await pendingRead.promise })
  act(() => translationHistoryPortBridge.ready?.('C:/Notes/other.md', 'visual'))

  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-document-key', expect.stringMatching(/^__untitled__:/))
  expect(translationHistoryPortBridge.reveal).not.toHaveBeenCalled()
})

it('rejects wrong-key, stale-mode, invalid, mismatched-revision, and duplicate ready reveals', async () => {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))

  const invalid = addHistoryRecord({
    requestId: 'invalid-anchor', documentKey: 'C:/Notes/note.md', anchorStatus: 'location-changed',
  })
  act(() => translationHistoryPortBridge.navigate?.(invalid.id))
  expect(translationHistoryPortBridge.reveal).not.toHaveBeenCalled()

  const wrongRevision = addHistoryRecord({
    requestId: 'wrong-revision', documentKey: 'C:/Notes/note.md', revision: 'c'.repeat(64),
  })
  act(() => translationHistoryPortBridge.navigate?.(wrongRevision.id))
  act(() => translationHistoryPortBridge.ready?.('C:/Notes/note.md', 'visual'))
  expect(translationHistoryPortBridge.reveal).not.toHaveBeenCalled()

  const source = addHistoryRecord({
    requestId: 'source-ready-gates', documentKey: 'C:/Notes/note.md', mode: 'source',
  })
  act(() => translationHistoryPortBridge.navigate?.(source.id))
  act(() => translationHistoryPortBridge.ready?.('C:/Notes/wrong.md', 'source'))
  act(() => translationHistoryPortBridge.ready?.('C:/Notes/note.md', 'visual'))
  expect(translationHistoryPortBridge.reveal).not.toHaveBeenCalled()
  act(() => editorModeBridge.report?.('source'))
  act(() => translationHistoryPortBridge.ready?.('C:/Notes/note.md', 'source'))
  expect(translationHistoryPortBridge.reveal).toHaveBeenCalledOnce()
  expect(translationHistoryPortBridge.reveal).toHaveBeenCalledWith(source.id)
  act(() => translationHistoryPortBridge.ready?.('C:/Notes/note.md', 'source'))
  expect(translationHistoryPortBridge.reveal).toHaveBeenCalledOnce()

  translationHistoryPortBridge.reveal.mockClear().mockReturnValue(false)
  const fingerprintMismatch = addHistoryRecord({
    requestId: 'fingerprint-mismatch', documentKey: 'C:/Notes/note.md', mode: 'source',
  })
  act(() => translationHistoryPortBridge.navigate?.(fingerprintMismatch.id))
  expect(translationHistoryPortBridge.reveal).toHaveBeenCalledOnce()
  expect(translationHistoryPortBridge.reveal).toHaveBeenCalledWith(fingerprintMismatch.id)
  act(() => translationHistoryPortBridge.ready?.('C:/Notes/note.md', 'source'))
  expect(translationHistoryPortBridge.reveal).toHaveBeenCalledOnce()
})

it('allows only the newest overlapping history navigation to reveal', async () => {
  const user = userEvent.setup()
  const reads = new Map<string, ReturnType<typeof deferred<ApiResult<import('../../src/shared/contracts').DocumentSnapshot>>>>()
  installApi({
    readDocument: vi.fn((relativePath: string) => {
      const request = deferred<ApiResult<import('../../src/shared/contracts').DocumentSnapshot>>()
      reads.set(relativePath, request)
      return request.promise
    }),
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const recordA = addHistoryRecord({ requestId: 'overlap-a', documentKey: 'C:/Notes/a.md' })
  const recordB = addHistoryRecord({ requestId: 'overlap-b', documentKey: 'C:/Notes/b.md' })

  act(() => translationHistoryPortBridge.navigate?.(recordA.id))
  act(() => translationHistoryPortBridge.navigate?.(recordB.id))
  await waitFor(() => expect(reads.has('b.md')).toBe(true))
  reads.get('b.md')!.resolve({ ok: true, value: {
    relativePath: 'b.md', markdown: '# B', revision: revisionA,
    encoding: 'utf8', newline: 'lf', mtimeMs: 1,
  } })
  await waitFor(() => expect(translationHistoryPortBridge.reveal).toHaveBeenCalledWith(recordB.id))
  act(() => translationHistoryPortBridge.ready?.('C:/Notes/a.md', 'visual'))
  expect(translationHistoryPortBridge.reveal).not.toHaveBeenCalledWith(recordA.id)
})

it('contains a rejected cross-workspace history open and keeps the current document selected', async () => {
  const user = userEvent.setup()
  installApi({ openDroppedPath: vi.fn(async () => { throw new Error('history open rejected') }) })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const port = translationHistoryPortBridge.latest!
  const record = port.finalize({
    requestId: 'cross-workspace-rejection', documentKey: 'D:/Other/away.md',
    workspaceAbsolutePath: 'D:/Other', documentRelativePath: 'away.md',
    documentAbsolutePath: 'D:/Other/away.md', documentRevision: revisionA,
    mode: 'visual', source: { markdown: 'source', plainText: 'source' },
    translatedMarkdown: 'away', modelId: 'model', targetLanguage: 'en', terminal: 'completed',
    anchor: { mode: 'visual', from: 0, to: 6, blockStart: 0,
      fingerprint: { before: '', selected: 'source', after: '' }, status: 'valid' },
  })!

  act(() => translationHistoryPortBridge.navigate?.(record.id))

  await waitFor(() => expect(screen.getAllByText(/history open rejected/)).toHaveLength(1))
  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-document-key', 'C:/Notes/note.md')
  expect(port.selectedRecordId).toBe(record.id)
  expect(translationHistoryPortBridge.reveal).not.toHaveBeenCalled()
})

it('gates a cross-workspace history target before opening it and preserves the current document on cancel', async () => {
  const user = userEvent.setup()
  const openDroppedPath = vi.fn()
  installApi({ openDroppedPath })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const store = editorInstanceBridge.stores.at(-1)!
  await waitFor(() => expect(store.activeWorkspaceId).toBe('workspace-notes'))
  const currentSession = store.sessions.get('workspace-notes')!
  currentSession.messages.push({ id: 'history-user', role: 'user', content: '保留历史' })
  const port = translationHistoryPortBridge.latest!
  const record = port.finalize({
    requestId: 'cross-workspace-gate', documentKey: 'D:/Other/away.md',
    workspaceAbsolutePath: 'D:/Other', documentRelativePath: 'away.md',
    documentAbsolutePath: 'D:/Other/away.md', documentRevision: revisionA,
    mode: 'visual', source: { markdown: 'source', plainText: 'source' },
    translatedMarkdown: 'away', modelId: 'model', targetLanguage: 'en', terminal: 'completed',
    anchor: { mode: 'visual', from: 0, to: 6, blockStart: 0,
      fingerprint: { before: '', selected: 'source', after: '' }, status: 'valid' },
  })!

  act(() => translationHistoryPortBridge.navigate?.(record.id))
  const switchDialog = await screen.findByRole('dialog', {
    name: '切换工作区将创建新的AI对话',
  })
  expect(openDroppedPath).not.toHaveBeenCalled()
  await user.click(within(switchDialog).getByRole('button', { name: '取消' }))

  await waitFor(() => expect(switchDialog).not.toBeInTheDocument())
  expect(openDroppedPath).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-document-key', 'C:/Notes/note.md')
  expect(store.activeWorkspaceId).toBe('workspace-notes')
  expect(store.sessions.get('workspace-notes')).toBe(currentSession)
  expect(currentSession.messages.map(({ content }) => content)).toEqual(['保留历史'])
})

it('retains a pending history reveal across a cross-workspace keyed editor remount', async () => {
  const user = userEvent.setup()
  const otherWorkspace = { name: 'Other', absolutePath: 'D:/Other' }
  installApi({
    openDroppedPath: vi.fn(async () => ({
      ok: true as const,
      value: {
        workspace: otherWorkspace,
        document: {
          relativePath: 'away.md', markdown: '# Away', revision: revisionA,
          encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 1,
        },
      },
    })),
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const port = translationHistoryPortBridge.latest!
  const record = port.finalize({
    requestId: 'cross-workspace-remount', documentKey: 'D:/Other/away.md',
    workspaceAbsolutePath: 'D:/Other', documentRelativePath: 'away.md',
    documentAbsolutePath: 'D:/Other/away.md', documentRevision: revisionA,
    mode: 'visual', source: { markdown: 'source', plainText: 'source' },
    translatedMarkdown: 'away', modelId: 'model', targetLanguage: 'en', terminal: 'completed',
    anchor: { mode: 'visual', from: 0, to: 6, blockStart: 0,
      fingerprint: { before: '', selected: 'source', after: '' }, status: 'valid' },
  })!

  act(() => translationHistoryPortBridge.navigate?.(record.id))

  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-document-key', 'D:/Other/away.md'))
  await waitFor(() => expect(translationHistoryPortBridge.reveal).toHaveBeenCalledWith(record.id))
  expect(translationHistoryPortBridge.reveal).toHaveBeenCalledOnce()
})

it('does not reveal a pending target that is evicted before its document becomes ready', async () => {
  const user = userEvent.setup()
  const pendingRead = deferred<ApiResult<import('../../src/shared/contracts').DocumentSnapshot>>()
  installApi({ readDocument: vi.fn(() => pendingRead.promise) })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const target = addHistoryRecord({ requestId: 'evicted-target', documentKey: 'C:/Notes/away.md' })
  act(() => translationHistoryPortBridge.navigate?.(target.id))
  await waitFor(() => expect(window.arkdown.readDocument).toHaveBeenCalledWith('away.md'))
  act(() => {
    for (let index = 0; index < 99; index += 1) {
      addHistoryRecord({
        requestId: `replacement-${index}`,
        documentKey: 'C:/Notes/away.md',
      })
    }
  })
  expect(translationHistoryPortBridge.latest!.records.some(({ id }) => id === target.id)).toBe(false)
  pendingRead.resolve({ ok: true, value: {
    relativePath: 'away.md', markdown: '# Away', revision: revisionA,
    encoding: 'utf8', newline: 'lf', mtimeMs: 1,
  } })
  await act(async () => { await pendingRead.promise })
  act(() => translationHistoryPortBridge.ready?.('C:/Notes/away.md', 'visual'))
  expect(translationHistoryPortBridge.reveal).not.toHaveBeenCalled()
})

it('commits a same-workspace Save As without prompting or deactivating its conversation', async () => {
  const user = userEvent.setup()
  const intent = saveAsIntent(workspace, false)
  const committed = committedSaveAs(workspace, false)
  const abortSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: null }))
  installApi({
    beginSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: intent })),
    commitSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: committed })),
    abortSaveDocumentAs,
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const store = editorInstanceBridge.stores.at(-1)!
  await waitFor(() => expect(store.activeWorkspaceId).toBe('workspace-notes'))
  const conversation = store.sessions.get('workspace-notes')!
  conversation.messages.push({ id: 'same-user', role: 'user', content: 'keep same' })
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), {
    target: { value: '# Changed' },
  })

  act(() => menuCommand?.('save-as'))

  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-document-key', 'C:/Notes/saved.md'))
  expect(screen.queryByRole('dialog', {
    name: '切换工作区将创建新的AI对话',
  })).not.toBeInTheDocument()
  expect(store.activeWorkspaceId).toBe('workspace-notes')
  expect(store.sessions.get('workspace-notes')).toBe(conversation)
  expect(conversation.messages.map(({ content }) => content)).toEqual(['keep same'])
  expect(abortSaveDocumentAs).not.toHaveBeenCalled()
})

it.each([
  { directory: '', relativePath: 'saved.md' },
  { directory: 'drafts', relativePath: 'drafts/saved.md' },
])('shows $relativePath after same-workspace Save As without reloading the editor', async (target) => {
  const user = userEvent.setup()
  const pendingSave = deferred<ApiResult<CommitSaveDocumentAsResult>>()
  const committed = committedSaveAs()
  committed.document.relativePath = target.relativePath
  const saveAsApi = twoPhaseSaveAsApi(committed)
  let saved = false
  const commitSaveDocumentAs = vi.fn(async () => {
    const result = await pendingSave.promise
    if (result.ok) saved = true
    return result
  })
  const listDirectory = vi.fn(async (relativePath: string) => ({
    ok: true as const,
    value: [
      ...(relativePath === '' ? [
        { name: 'note.md', relativePath: 'note.md', kind: 'document' as const },
        ...(target.directory ? [
          { name: 'drafts', relativePath: 'drafts', kind: 'directory' as const },
        ] : []),
      ] : []),
      ...(saved && relativePath === target.directory ? [
        { name: 'saved.md', relativePath: target.relativePath, kind: 'document' as const },
      ] : []),
    ],
  }))
  const readDocument = vi.fn(async (relativePath: string) => ({
    ok: true as const,
    value: relativePath === target.relativePath ? committed.document : {
      relativePath: 'note.md', markdown: '# Note', revision: revisionA,
      encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 1,
    },
  }))
  installApi({ ...saveAsApi, commitSaveDocumentAs, listDirectory, readDocument })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  if (target.directory) {
    await user.click(screen.getByRole('button', { name: 'drafts' }))
  }
  const editor = () => screen.getByRole('textbox', { name: 'Markdown editor' })
  fireEvent.change(editor(), { target: { value: '# Changed' } })
  act(() => menuCommand?.('save-as'))
  await waitFor(() => expect(commitSaveDocumentAs).toHaveBeenCalledOnce())
  expect(screen.queryByRole('button', { name: 'saved.md' })).not.toBeInTheDocument()
  await act(async () => {
    pendingSave.resolve({ ok: true, value: committed })
    await pendingSave.promise
  })

  await screen.findByRole('button', { name: 'saved.md' })
  expect(editor()).toHaveValue('# Changed')
  expect(editor()).toHaveAttribute('data-document-key', `C:/Notes/${target.relativePath}`)
  expect(readDocument).toHaveBeenCalledOnce()
  if (target.directory) {
    expect(screen.getByRole('button', { name: 'drafts' })).toHaveAttribute('aria-expanded', 'true')
  }
  await user.click(screen.getByRole('button', { name: 'note.md' }))
  await waitFor(() => expect(editor()).toHaveValue('# Note'))
  await user.click(screen.getByRole('button', { name: 'saved.md' }))
  await waitFor(() => expect(editor()).toHaveValue('# Changed'))
  expect(readDocument).toHaveBeenLastCalledWith(target.relativePath)
})

it('aborts a cross-workspace Save As on AI-switch cancellation and preserves the old shell', async () => {
  const user = userEvent.setup()
  const otherWorkspace = { name: 'Other', absolutePath: 'D:/Other' }
  const intent = saveAsIntent(otherWorkspace, true)
  const commitSaveDocumentAs = vi.fn(async () => ({
    ok: true as const,
    value: committedSaveAs(otherWorkspace, true),
  }))
  const abortSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: null }))
  installApi({
    beginSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: intent })),
    commitSaveDocumentAs,
    abortSaveDocumentAs,
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })
  const store = editorInstanceBridge.stores.at(-1)!
  await waitFor(() => expect(store.activeWorkspaceId).toBe('workspace-notes'))
  const conversation = store.sessions.get('workspace-notes')!
  conversation.messages.push({ id: 'cross-user', role: 'user', content: 'keep source' })
  fireEvent.change(editor, { target: { value: '# Changed' } })

  act(() => menuCommand?.('save-as'))
  const dialog = await screen.findByRole('dialog', {
    name: '切换工作区将创建新的AI对话',
  })
  expect(commitSaveDocumentAs).not.toHaveBeenCalled()
  await user.click(within(dialog).getByRole('button', { name: '取消' }))

  await waitFor(() => expect(abortSaveDocumentAs).toHaveBeenCalledWith(intent.intentId))
  expect(commitSaveDocumentAs).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Notes' })).toBeVisible()
  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-document-key', 'C:/Notes/note.md')
  expect(store.activeWorkspaceId).toBe('workspace-notes')
  expect(store.sessions.get('workspace-notes')).toBe(conversation)
  expect(conversation.messages.map(({ content }) => content)).toEqual(['keep source'])
})

it('accepts committed cross-workspace authority before the replacement shell first renders', async () => {
  const user = userEvent.setup()
  const otherWorkspace = { name: 'Other', absolutePath: 'D:/Other' }
  const intent = saveAsIntent(otherWorkspace, true)
  const beginSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: intent }))
  const commitSaveDocumentAs = vi.fn(async () => ({
    ok: true as const,
    value: committedSaveAs(otherWorkspace, true),
  }))
  const getAiWorkspaceState = vi.fn(async () => ({
    ok: true as const,
    value: { workspaceId: 'workspace-notes', workspaceGeneration: 'generation-1' },
  }))
  installApi({
    beginSaveDocumentAs,
    commitSaveDocumentAs,
    abortSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: null })),
    getAiWorkspaceState,
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const store = editorInstanceBridge.stores.at(-1)!
  await waitFor(() => expect(store.activeWorkspaceId).toBe('workspace-notes'))
  const source = store.sessions.get('workspace-notes')!
  source.messages.push({ id: 'source-user', role: 'user', content: 'source transcript' })
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), {
    target: { value: '# Changed' },
  })

  act(() => menuCommand?.('save-as'))
  const dialog = await screen.findByRole('dialog', {
    name: '切换工作区将创建新的AI对话',
  })
  expect(commitSaveDocumentAs).not.toHaveBeenCalled()
  await user.click(within(dialog).getByRole('button', { name: '切换' }))

  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-document-key', 'D:/Other/saved.md'))
  const replacementBindings = editorInstanceBridge.aiBindings.filter(({ documentKey }) => (
    documentKey === 'D:/Other/saved.md'
  ))
  expect(replacementBindings.length).toBeGreaterThan(0)
  expect(replacementBindings).toEqual(replacementBindings.map(() => ({
    documentKey: 'D:/Other/saved.md',
    workspaceId: 'workspace-other',
    workspaceGeneration: 'generation-7',
  })))
  expect(beginSaveDocumentAs).toHaveBeenCalledOnce()
  expect(commitSaveDocumentAs).toHaveBeenCalledWith(intent.intentId)
  expect(getAiWorkspaceState).toHaveBeenCalledOnce()
  expect(store.activeWorkspaceId).toBe('workspace-other')
  expect(store.sessions.get('workspace-notes')).toBe(source)
  expect(source.messages.map(({ content }) => content)).toEqual(['source transcript'])
})

it('rebases an untitled history record onto the guarded Save As identity', async () => {
  const saveAsApi = twoPhaseSaveAsApi({
    ...committedSaveAs(),
    document: {
      relativePath: 'saved.md', markdown: '# Saved', revision: revisionA,
      encoding: 'utf8', newline: 'lf', mtimeMs: 1,
    },
  })
  installApi(saveAsApi)
  render(<App />)
  const untitledKey = screen.getByRole('textbox', { name: 'Markdown editor' })
    .getAttribute('data-document-key')!
  const port = translationHistoryPortBridge.first!
  fireEvent.click(screen.getByRole('button', { name: 'AI 对话' }))
  fireEvent.click(screen.getByRole('button', { name: '记录翻译' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), {
    target: { value: '# Saved' },
  })

  act(() => menuCommand?.('save-as'))

  await waitFor(() => expect(saveAsApi.commitSaveDocumentAs).toHaveBeenCalledOnce())
  await waitFor(() => expect(port.records[0]).toMatchObject({
    documentKey: 'C:/Notes/saved.md',
    workspaceAbsolutePath: 'C:/Notes',
    documentRelativePath: 'saved.md',
    documentAbsolutePath: 'C:/Notes/saved.md',
    documentRevision: revisionA,
  }))
  expect(translationHistoryPortBridge.latest).toBe(port)
  expect(screen.getByTestId('editor-right-sidebar-state')).toHaveTextContent('open:ai-chat')
})

it('preserves the workspace conversation and tab state across a same-workspace Save As', async () => {
  const user = userEvent.setup()
  const saveAsApi = twoPhaseSaveAsApi({
    ...committedSaveAs(),
    document: {
      relativePath: 'saved.md', markdown: '# Saved', revision: revisionA,
      encoding: 'utf8', newline: 'lf', mtimeMs: 1,
    },
  })
  installApi(saveAsApi)
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const chatStore = editorInstanceBridge.stores.at(-1)!
  await waitFor(() => expect(chatStore.activeWorkspaceId).toBe('workspace-notes'))
  const sourceChat = chatStore.sessions.get('workspace-notes')!
  sourceChat.messages.push({ id: 'source-u', role: 'user', content: 'source history' })
  await user.click(screen.getByRole('button', { name: 'AI 对话' }))
  expect(screen.getByTestId('editor-right-sidebar-state')).toHaveTextContent('open:ai-chat')

  act(() => menuCommand?.('save-as'))

  await waitFor(() => expect(saveAsApi.commitSaveDocumentAs).toHaveBeenCalledOnce())
  expect(chatStore.sessions.get('workspace-notes')).toBe(sourceChat)
  expect(sourceChat.messages.map(({ content }) => content)).toEqual(['source history'])
  expect(screen.getByTestId('editor-right-sidebar-state')).toHaveTextContent('open:ai-chat')
})

it('refreshes a saved document history record with the successful Save revision', async () => {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  fireEvent.click(screen.getByRole('button', { name: '记录翻译' }))
  const port = translationHistoryPortBridge.latest!
  expect(port.records[0]?.documentRevision).toBe(revisionA)
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), {
    target: { value: '# Changed' },
  })

  act(() => menuCommand?.('save'))

  await waitFor(() => expect(window.arkdown.saveDocument).toHaveBeenCalledOnce())
  await waitFor(() => expect(port.records[0]?.documentRevision).toBe('b'.repeat(64)))
  expect(port.records[0]).toMatchObject({
    workspaceAbsolutePath: 'C:/Notes',
    documentRelativePath: 'note.md',
    documentAbsolutePath: 'C:/Notes/note.md',
  })
})

it('isolates consecutive untitled document lifetimes and rebases only the current Save As record', async () => {
  const saveAsApi = twoPhaseSaveAsApi({
    ...committedSaveAs(),
    document: {
      relativePath: 'saved-b.md', markdown: '# B', revision: revisionA,
      encoding: 'utf8', newline: 'lf', mtimeMs: 1,
    },
  })
  installApi(saveAsApi)
  render(<App />)
  const editorA = screen.getByRole('textbox', { name: 'Markdown editor' })
  const keyA = editorA.getAttribute('data-document-key')
  fireEvent.click(screen.getByRole('button', { name: '记录翻译' }))
  const port = translationHistoryPortBridge.latest!
  expect(screen.getByTestId('history-document-total')).toHaveTextContent('1')

  act(() => menuCommand?.('new-document'))

  const editorB = await screen.findByRole('textbox', { name: 'Markdown editor' })
  const keyB = editorB.getAttribute('data-document-key')
  expect(editorB).not.toBe(editorA)
  expect(keyB).not.toBe(keyA)
  expect(screen.getByTestId('history-window-total')).toHaveTextContent('1')
  expect(screen.getByTestId('history-document-total')).toHaveTextContent('0')

  fireEvent.click(screen.getByRole('button', { name: '记录翻译' }))
  expect(screen.getByTestId('history-window-total')).toHaveTextContent('2')
  expect(screen.getByTestId('history-document-total')).toHaveTextContent('1')
  fireEvent.change(editorB, { target: { value: '# B' } })
  act(() => menuCommand?.('save-as'))

  await waitFor(() => expect(saveAsApi.commitSaveDocumentAs).toHaveBeenCalledOnce())
  await waitFor(() => expect(port.records.find(({ requestId }) => (
    requestId === 'app-request-2'
  ))).toMatchObject({
    documentKey: 'C:/Notes/saved-b.md',
    workspaceAbsolutePath: 'C:/Notes',
    documentRelativePath: 'saved-b.md',
    documentAbsolutePath: 'C:/Notes/saved-b.md',
    documentRevision: revisionA,
  }))
  expect(port.records.find(({ requestId }) => requestId === 'app-request-1')).toMatchObject({
    documentKey: keyA,
    workspaceAbsolutePath: null,
    documentRelativePath: null,
    documentAbsolutePath: null,
    documentRevision: null,
  })
})

it('continues the same structured close across the actual Save As remount and releases its new editor', async () => {
  const user = userEvent.setup()
  const saveAs = twoPhaseSaveAsApi(committedSaveAs({ name: 'Other', absolutePath: 'D:/Other' }, true))
  const transport = installStructuredCloseApi(saveAs)
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  const oldEditor = screen.getByRole('textbox', { name: 'Markdown editor' })
  fireEvent.change(oldEditor, { target: { value: '# Changed' } })
  act(() => { transport.start(); transport.start() })
  const dialog = await screen.findByRole('dialog', { name: /是否保存/ })
  await user.click(within(dialog).getByRole('button', { name: /^保存$/ }))
  await waitFor(() => expect(transport.result()).toMatchObject({ type: 'result', result: { status: 'ready' } }))
  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })
  expect(editor).not.toBe(oldEditor)
  expect(editor).toHaveAttribute('data-document-key', 'D:/Other/saved.md')
  expect(saveAs.commitSaveDocumentAs).toHaveBeenCalledOnce()
  expect(transport.events.filter(event => event.type === 'result')).toHaveLength(1)
  expect(editor.closest('.app-shell')).toHaveAttribute('inert')
  act(() => transport.release({ ...transport.request, generation: 2 }))
  fireEvent.change(editor, { target: { value: 'not released by another attempt' } })
  expect(editor).toHaveValue('# Changed')
  act(() => transport.release())
  fireEvent.change(editor, { target: { value: 'editable after safe return' } })
  expect(editor).toHaveValue('editable after safe return')
})

it('reports committed Save As draft-end failure through the structured remount without another commit', async () => {
  const user = userEvent.setup()
  const committed = { ...committedSaveAs({ name: 'Other', absolutePath: 'D:/Other' }, true), draftEndPending: true as const }
  const saveAs = twoPhaseSaveAsApi(committed)
  const retryDraftFinalization = vi.fn(async () => ({ ok: false as const, error: { code: 'OPERATION_FAILED', message: 'synthetic terminal error' } }))
  const transport = installStructuredCloseApi({ ...saveAs, retryDraftFinalization })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), { target: { value: '# Changed' } })
  act(() => transport.start())
  const dialog = await screen.findByRole('dialog', { name: /是否保存/ })
  await user.click(within(dialog).getByRole('button', { name: /^保存$/ }))
  await waitFor(() => expect(transport.result()).toMatchObject({ type: 'result', result: { status: 'failed', code: 'draft-end-failed' } }))
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveAttribute('data-document-key', 'D:/Other/saved.md')
  expect(saveAs.commitSaveDocumentAs).toHaveBeenCalledOnce()
  expect(retryDraftFinalization).not.toHaveBeenCalled()
})

it('rechecks a late edit in the adopted Save As session before structured close can succeed', async () => {
  const user = userEvent.setup()
  const committed = committedSaveAs({ name: 'Other', absolutePath: 'D:/Other' }, true)
  const response = deferred<ApiResult<CommitSaveDocumentAsResult>>()
  const commit = vi.fn(() => response.promise)
  const save = vi.fn(async () => ({ ok: true as const, value: { revision: 'c'.repeat(64), mtimeMs: 3 } }))
  const transport = installStructuredCloseApi({ ...twoPhaseSaveAsApi(committed), commitSaveDocumentAs: commit, saveDocument: save })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })
  fireEvent.change(editor, { target: { value: '# Changed' } })
  act(() => transport.start())
  await user.click(within(await screen.findByRole('dialog', { name: /是否保存/ })).getByRole('button', { name: /^保存$/ }))
  await waitFor(() => expect(commit).toHaveBeenCalledOnce())
  fireEvent.change(editor, { target: { value: '# Newer text during commit' } })
  await act(async () => { response.resolve({ ok: true, value: committed }); await response.promise })
  const secondConfirmation = await screen.findByRole('dialog', { name: /是否保存对“saved.md”/ })
  expect(transport.result()).toBeUndefined()
  await user.click(within(secondConfirmation).getByRole('button', { name: /^保存$/ }))
  await waitFor(() => expect(transport.result()).toMatchObject({ result: { status: 'ready' } }))
  expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    relativePath: 'saved.md', markdown: '# Newer text during commit', expectedRevision: revisionA,
  }))
  expect(commit).toHaveBeenCalledOnce()
})

it('does not transfer structured close authority to an unrelated document replacement', async () => {
  const user = userEvent.setup()
  const committed = committedSaveAs({ name: 'Other', absolutePath: 'D:/Other' }, true)
  const response = deferred<ApiResult<CommitSaveDocumentAsResult>>()
  const commit = vi.fn(() => response.promise)
  let openIntent!: Parameters<NonNullable<ArkdownApi['onOpenIntent']>>[0]
  const transport = installStructuredCloseApi({ ...twoPhaseSaveAsApi(committed), commitSaveDocumentAs: commit,
    onOpenIntent: handler => { openIntent = handler; return () => {} } })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), { target: { value: '# Changed' } })
  act(() => transport.start())
  await user.click(within(await screen.findByRole('dialog', { name: /是否保存/ })).getByRole('button', { name: /^保存$/ }))
  await waitFor(() => expect(commit).toHaveBeenCalledOnce())
  act(() => openIntent({ workspace: { name: 'Replacement', absolutePath: 'E:/Replacement' },
    document: { ...committed.document, relativePath: 'replacement.md', markdown: '# Replacement' } }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Replacement'))
  await act(async () => { response.resolve({ ok: true, value: committed }); await response.promise })
  await waitFor(() => expect(transport.result()).toMatchObject({ result: { status: 'cancelled' } }))
  const replacement = screen.getByRole('textbox', { name: 'Markdown editor' })
  expect(replacement).toHaveAttribute('data-document-key', 'E:/Replacement/replacement.md')
  fireEvent.change(replacement, { target: { value: 'replacement stays editable' } })
  expect(replacement).toHaveValue('replacement stays editable')
})

it('revokes structured close when a same-shell document lifetime changes during preference drain', async () => {
  const user = userEvent.setup()
  let openIntent!: Parameters<NonNullable<ArkdownApi['onOpenIntent']>>[0]
  const preference = installPreferencesPersistenceApi({ onOpenIntent: handler => { openIntent = handler; return () => {} } })
  const pending = deferred<ApiResult<typeof DEFAULT_ARKNOTE_PREFERENCES>>()
  preference.setArknotePreferences.mockImplementationOnce(() => pending.promise)
  const transport = installStructuredCloseApi(window.arkdown)
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await openPreferencesPage()
  fireEvent.click(screen.getByRole('checkbox', { name: '开机启动' }))
  await waitFor(() => expect(preference.setArknotePreferences).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: '返回编辑器' }))
  act(() => transport.start())
  await waitFor(() => expect(transport.events).toContainEqual(expect.objectContaining({ type: 'stage', stage: 'settle-preferences' })))
  act(() => openIntent({ workspace, document: { ...committedSaveAs().document, relativePath: 'replacement.md', markdown: '# Replacement' } }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Replacement'))
  await act(async () => pending.resolve({ ok: true, value: { ...DEFAULT_ARKNOTE_PREFERENCES, launchAtLogin: true } }))
  await waitFor(() => expect(transport.result()).toMatchObject({ result: { status: 'cancelled' } }))
  act(() => transport.release())
  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })
  fireEvent.change(editor, { target: { value: 'replacement editable after return' } })
  expect(editor).toHaveValue('replacement editable after return')
})

it('hands a cross-workspace Save As through one keyed shell and does not replay it later', async () => {
  const user = userEvent.setup()
  const otherWorkspace = { name: 'Other', absolutePath: 'D:/Other' }
  const laterWorkspace = { name: 'Later', absolutePath: 'E:/Later' }
  const chooseWorkspace = vi.fn()
    .mockResolvedValueOnce({ ok: true as const, value: workspace })
    .mockResolvedValueOnce({ ok: true as const, value: laterWorkspace })
  const saveAsApi = twoPhaseSaveAsApi({
    ...committedSaveAs(otherWorkspace, true),
    document: {
      relativePath: 'saved.md', markdown: '# Changed', revision: revisionA,
      encoding: 'utf8', newline: 'lf', mtimeMs: 2,
    },
  })
  installApi({ chooseWorkspace, ...saveAsApi })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), {
    target: { value: '# Changed' },
  })

  act(() => menuCommand?.('save-as'))

  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-document-key', 'D:/Other/saved.md'))
  expect(screen.queryByRole('dialog', {
    name: '切换工作区将创建新的AI对话',
  })).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Changed')
  expect(saveAsApi.commitSaveDocumentAs).toHaveBeenCalledOnce()

  act(() => menuCommand?.('open-workspace'))

  await waitFor(() => expect(screen.getByRole('button', { name: 'Later' })).toBeVisible())
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('')
  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .not.toHaveAttribute('data-document-key', 'D:/Other/saved.md')
  expect(saveAsApi.commitSaveDocumentAs).toHaveBeenCalledOnce()
})

it('carries a late Save As edit and pending terminal gate through the actual workspace shell remount', async () => {
  const user = userEvent.setup()
  const otherWorkspace = { name: 'Other', absolutePath: 'D:/Other' }
  const committed = { ...committedSaveAs(otherWorkspace, true), draftEndPending: true as const }
  const response = deferred<ApiResult<CommitSaveDocumentAsResult>>()
  const commitSaveDocumentAs = vi.fn(() => response.promise)
  const retryDraftFinalization = vi.fn<NonNullable<ArkdownApi['retryDraftFinalization']>>()
    .mockResolvedValue({ ok: false, error: { code: 'OPERATION_FAILED', message: 'terminal denied' } })
  const saveDocument = vi.fn(async () => ({ ok: true as const, value: { revision: 'c'.repeat(64), mtimeMs: 3 } }))
  installApi({ ...twoPhaseSaveAsApi(committed), commitSaveDocumentAs, retryDraftFinalization, saveDocument })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const sourceEditor = screen.getByRole('textbox', { name: 'Markdown editor' })
  fireEvent.change(sourceEditor, { target: { value: '# Changed' } })
  act(() => menuCommand?.('save-as'))
  await waitFor(() => expect(commitSaveDocumentAs).toHaveBeenCalledOnce())
  fireEvent.change(sourceEditor, { target: { value: '# Changed during commit' } })
  await act(async () => { response.resolve({ ok: true, value: committed }); await response.promise })
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-document-key', 'D:/Other/saved.md'))
  const targetEditor = screen.getByRole('textbox', { name: 'Markdown editor' })
  expect(targetEditor).not.toBe(sourceEditor)
  expect(targetEditor).toHaveValue('# Changed during commit')
  expect(window.arkdown.saveDraft).toHaveBeenLastCalledWith(expect.objectContaining({
    markdown: '# Changed during commit', expectedOriginalRevision: committed.document.revision,
  }))
  expect(editorInstanceBridge.aiBindings.at(-1)).toMatchObject({ workspaceId: 'workspace-other', workspaceGeneration: 'generation-7' })
  await act(async () => { expect(await prepareClose()).toBe(false) })
  expect(retryDraftFinalization).toHaveBeenCalledOnce()
  expect(saveDocument).not.toHaveBeenCalled()
  retryDraftFinalization.mockResolvedValue({ ok: true, value: null })
  act(() => menuCommand?.('save'))
  await waitFor(() => expect(saveDocument).toHaveBeenCalledOnce())
  expect(saveDocument).toHaveBeenLastCalledWith(expect.objectContaining({
    relativePath: 'saved.md', markdown: '# Changed during commit', expectedRevision: committed.document.revision,
  }))
  await act(async () => { expect(await prepareClose()).toBe(true) })
  expect(commitSaveDocumentAs).toHaveBeenCalledOnce()
})

it('flushes a buffered edit made during successor backup before the Save As shell remount', async () => {
  const user = userEvent.setup()
  const committed = { ...committedSaveAs({ name: 'Other', absolutePath: 'D:/Other' }, true), draftEndPending: true as const }
  const response = deferred<ApiResult<CommitSaveDocumentAsResult>>()
  const committing = deferred<void>()
  const backupEntered = deferred<void>()
  const releaseBackup = deferred<void>()
  const commitSaveDocumentAs = vi.fn(() => { committing.resolve(); return response.promise })
  const retryDraftFinalization = vi.fn<NonNullable<ArkdownApi['retryDraftFinalization']>>()
    .mockResolvedValue({ ok: false, error: { code: 'OPERATION_FAILED', message: 'terminal denied' } })
  const saveDocument = vi.fn(async () => ({ ok: true as const, value: { revision: 'c'.repeat(64), mtimeMs: 3 } }))
  installApi({ ...twoPhaseSaveAsApi(committed), commitSaveDocumentAs, retryDraftFinalization, saveDocument })
  const originalBackup = window.arkdown.saveDraft!
  const saveDraft = vi.fn<NonNullable<ArkdownApi['saveDraft']>>(async (input) => {
    const result = await originalBackup(input)
    if (input.markdown === 'B backed up') { backupEntered.resolve(); await releaseBackup.promise }
    return result
  })
  window.arkdown.saveDraft = saveDraft
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const sourceEditor = screen.getByRole('textbox', { name: 'Markdown editor' })
  vi.useFakeTimers()
  try {
    fireEvent.change(sourceEditor, { target: { value: '# Changed' } })
    await act(async () => { menuCommand?.('save-as'); await committing.promise })
    fireEvent.change(sourceEditor, { target: { value: 'B backed up' } })
    await act(async () => { response.resolve({ ok: true, value: committed }); await backupEntered.promise })
    const successorBackup = saveDraft.mock.calls.at(-1)![0]
    expect(successorBackup).toMatchObject({ markdown: 'B backed up', expectedOriginalRevision: committed.document.revision })
    // Models composition: the editor has C, but onChange still exposes B.
    editorFlushBridge.pendingMarkdown = 'C buffered during backup'
    await act(async () => { releaseBackup.resolve(); await releaseBackup.promise })
    const targetEditor = screen.getByRole('textbox', { name: 'Markdown editor' })
    expect(targetEditor).not.toBe(sourceEditor)
    expect(targetEditor).toHaveAttribute('data-document-key', 'D:/Other/saved.md')
    expect(targetEditor).toHaveValue('C buffered during backup')
    expect(editorFlushBridge.pendingMarkdown).toBeNull()
    expect(saveDraft.mock.calls.at(-1)![0]).toEqual(successorBackup)
    expect(editorInstanceBridge.aiBindings.at(-1)).toMatchObject({ workspaceId: 'workspace-other', workspaceGeneration: 'generation-7' })
    expect(editIndicatorModelBridge.inputs.at(-1)).toMatchObject({ savedMarkdown: '# Changed', currentMarkdown: 'C buffered during backup' })
    // C was not marked as backed up by the handoff: normal idle backup must
    // write it under the same successor id and committed destination revision.
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(saveDraft).toHaveBeenLastCalledWith(expect.objectContaining({
      draftId: successorBackup.draftId, markdown: 'C buffered during backup', expectedOriginalRevision: committed.document.revision,
    }))
    await act(async () => { expect(await prepareClose()).toBe(false) })
    expect(retryDraftFinalization).toHaveBeenCalledOnce()
    expect(saveDocument).not.toHaveBeenCalled()
    expect(commitSaveDocumentAs).toHaveBeenCalledOnce() // Includes main's body write/AI activation; never replayed.
  } finally { vi.useRealTimers() }
})

it('selects a fresh workspace conversation while retaining the source conversation after Save As', async () => {
  const user = userEvent.setup()
  const otherWorkspace = { name: 'Other', absolutePath: 'D:/Other' }
  const saveAsApi = twoPhaseSaveAsApi({
    ...committedSaveAs(otherWorkspace, true),
    document: {
      relativePath: 'saved.md', markdown: '# Changed', revision: revisionA,
      encoding: 'utf8', newline: 'lf', mtimeMs: 2,
    },
  })
  const getAiWorkspaceState = vi.fn(async () => ({
    ok: true as const,
    value: { workspaceId: 'workspace-notes', workspaceGeneration: 'generation-1' },
  }))
  installApi({ ...saveAsApi, getAiWorkspaceState })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const storeBeforeSaveAs = editorInstanceBridge.stores.at(-1)!
  await waitFor(() => expect(storeBeforeSaveAs.activeWorkspaceId).toBe('workspace-notes'))
  const conversation = storeBeforeSaveAs.sessions.get('workspace-notes')!
  conversation.messages.push({ id: 'cross-u', role: 'user', content: 'keep across workspaces' })
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), {
    target: { value: '# Changed' },
  })

  act(() => menuCommand?.('save-as'))
  const dialog = await screen.findByRole('dialog', {
    name: '切换工作区将创建新的AI对话',
  })
  await user.click(within(dialog).getByRole('button', { name: '切换' }))

  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-document-key', 'D:/Other/saved.md'))
  const storeAfterSaveAs = editorInstanceBridge.stores.at(-1)!
  await waitFor(() => expect(storeAfterSaveAs.activeWorkspaceId).toBe('workspace-other'))
  expect(storeAfterSaveAs).toBe(storeBeforeSaveAs)
  expect(storeAfterSaveAs.sessions.get('workspace-notes')).toBe(conversation)
  expect(conversation.messages.map(({ content }) => content)).toEqual(['keep across workspaces'])
  expect(storeAfterSaveAs.sessions.get('workspace-other')?.messages).toEqual([])
})

it('rejects an onChange captured by the prior keyed editor after same-workspace navigation', async () => {
  const user = userEvent.setup()
  installApi({
    listDirectory: vi.fn(async () => ({
      ok: true as const,
      value: [
        { name: 'a.md', relativePath: 'a.md', kind: 'document' as const },
        { name: 'b.md', relativePath: 'b.md', kind: 'document' as const },
      ],
    })),
    readDocument: vi.fn(async (relativePath: string) => ({
      ok: true as const,
      value: {
        relativePath,
        markdown: relativePath === 'a.md' ? 'A' : 'B',
        revision: revisionA,
        encoding: 'utf8' as const,
        newline: 'lf' as const,
        mtimeMs: 1,
      },
    })),
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'a.md' }))
  const oldRegistration = editorChangeBridge.registrations.find(({ documentKey }) => (
    documentKey === 'C:/Notes/a.md'
  ))
  expect(oldRegistration).toBeDefined()

  await user.click(screen.getByRole('button', { name: 'b.md' }))
  const currentEditor = await screen.findByRole('textbox', { name: 'Markdown editor' })
  expect(currentEditor).toHaveValue('B')
  act(() => oldRegistration?.onChange('late A'))

  expect(currentEditor).toHaveValue('B')
  expect(document.querySelector('.document-header')).not.toHaveTextContent('未保存')
})

it('exits fullscreen only when no higher Escape layer owns the key and restores focus', async () => {
  const controlWindow = vi.fn(async () => ({
    ok: true as const,
    value: { maximized: false, fullscreen: false, revision: 0 },
  }))
  installApi({ controlWindow })
  render(<App />)
  await waitFor(() => expect(windowStateChanged).not.toBeNull())

  fireEvent.keyDown(window, { key: 'Escape' })
  expect(controlWindow).not.toHaveBeenCalled()

  act(() => windowStateChanged?.({ maximized: false, fullscreen: true, revision: 1 }))
  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })
  editor.focus()
  expect(screen.getByText('按下 Esc 以退出全屏')).toBeVisible()

  fireEvent.keyDown(window, { key: 'Escape' })
  expect(controlWindow).toHaveBeenCalledOnce()
  expect(controlWindow).toHaveBeenCalledWith('exit-fullscreen')
  act(() => windowStateChanged?.({ maximized: false, fullscreen: false, revision: 2 }))
  expect(screen.queryByText('按下 Esc 以退出全屏')).not.toBeInTheDocument()
  await waitFor(() => expect(editor).toHaveFocus())
})

it('does not exit fullscreen while the generic right sidebar is visible', async () => {
  const controlWindow = vi.fn(async () => ({
    ok: true as const,
    value: { maximized: false, fullscreen: false, revision: 0 },
  }))
  installApi({ controlWindow })
  const user = userEvent.setup()
  render(<App />)
  await waitFor(() => expect(windowStateChanged).not.toBeNull())
  act(() => windowStateChanged?.({ maximized: false, fullscreen: true, revision: 1 }))
  await user.click(screen.getByRole('button', { name: '打开右侧栏' }))
  expect(document.querySelector('.editor-right-sidebar')).not.toBeNull()

  fireEvent.keyDown(window, { key: 'Escape' })

  expect(controlWindow).not.toHaveBeenCalled()
})

it('lets a modal close on Escape before a later Escape exits fullscreen', async () => {
  const controlWindow = vi.fn(async () => ({
    ok: true as const,
    value: { maximized: false, fullscreen: false, revision: 0 },
  }))
  installApi({ controlWindow })
  const user = userEvent.setup()
  render(<ContextMenuProvider><App /></ContextMenuProvider>)
  await waitFor(() => expect(windowStateChanged).not.toBeNull())
  act(() => windowStateChanged?.({ maximized: false, fullscreen: true, revision: 1 }))

  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  fireEvent.contextMenu(document.querySelector('.workspace-tree-context')!)
  await user.click(screen.getByRole('menuitem', { name: '新建文件夹' }))
  const dialog = screen.getByRole('dialog', { name: '新建文件夹' })
  expect(dialog).toBeVisible()

  fireEvent.keyDown(window, { key: 'Escape' })
  expect(dialog.parentElement).toHaveAttribute('data-state', 'closing')
  expect(dialog).toBeInTheDocument()
  expect(controlWindow).not.toHaveBeenCalled()

  fireEvent.keyDown(window, { key: 'Escape' })
  expect(dialog).toBeInTheDocument()
  expect(controlWindow).not.toHaveBeenCalled()
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  expect(controlWindow).not.toHaveBeenCalled()

  fireEvent.keyDown(window, { key: 'Escape' })
  await waitFor(() => expect(controlWindow).toHaveBeenCalledOnce())
  expect(controlWindow).toHaveBeenCalledWith('exit-fullscreen')
})

it('lets application and context menus each consume Escape before fullscreen exit', async () => {
  const controlWindow = vi.fn(async () => ({
    ok: true as const,
    value: { maximized: false, fullscreen: false, revision: 0 },
  }))
  installApi({ controlWindow })
  const user = userEvent.setup()
  render(<ContextMenuProvider><App /></ContextMenuProvider>)
  await waitFor(() => expect(windowStateChanged).not.toBeNull())
  act(() => windowStateChanged?.({ maximized: false, fullscreen: true, revision: 1 }))

  await user.click(within(screen.getByRole('navigation', { name: '应用程序菜单' }))
    .getByRole('button', { name: '文件' }))
  fireEvent.keyDown(screen.getByRole('menuitem', { name: '新建文档Ctrl+N' }), { key: 'Escape' })
  expect(screen.queryByRole('menu', { name: '文件菜单' })).not.toBeInTheDocument()
  expect(controlWindow).not.toHaveBeenCalled()

  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  fireEvent.contextMenu(document.querySelector('.workspace-tree-context')!)
  expect(screen.getByRole('menu')).toBeVisible()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(controlWindow).not.toHaveBeenCalled()

  fireEvent.keyDown(window, { key: 'Escape' })
  expect(controlWindow).toHaveBeenCalledOnce()
  expect(controlWindow).toHaveBeenCalledWith('exit-fullscreen')
})

it('lets Preferences consume Escape before a later Escape exits fullscreen', async () => {
  const controlWindow = vi.fn(async () => ({
    ok: true as const,
    value: { maximized: false, fullscreen: false, revision: 0 },
  }))
  installApi({
    controlWindow,
    getSearchPreferences: vi.fn(async () => ({
      ok: true as const,
      value: { provider: 'bing' as const, customTemplate: '' },
    })),
    getEditorAppearancePreferences: vi.fn(async () => ({
      ok: true as const,
      value: appearanceSnapshot(DEFAULT_EDITOR_APPEARANCE),
    })),
    getLargeModelSettings: vi.fn(async () => ({
      ok: true as const,
      value: DEFAULT_LARGE_MODEL_SETTINGS,
    })),
  })
  render(<App />)
  await waitFor(() => expect(windowStateChanged).not.toBeNull())
  act(() => windowStateChanged?.({ maximized: false, fullscreen: true, revision: 1 }))
  await waitFor(() => expect(menuCommand).not.toBeNull())
  act(() => menuCommand?.('preferences'))
  expect(await screen.findByRole('main', { name: '偏好设置' })).toBeVisible()

  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('main', { name: '偏好设置' })).not.toBeInTheDocument()
  expect(controlWindow).not.toHaveBeenCalled()

  fireEvent.keyDown(window, { key: 'Escape' })
  expect(controlWindow).toHaveBeenCalledOnce()
  expect(controlWindow).toHaveBeenCalledWith('exit-fullscreen')
})

it('restores a document surface after custom-menu fullscreen exit removes its focused item', async () => {
  const executeApplicationMenuItem = vi.fn(async () => ({
    ok: true as const,
    value: null,
  }))
  installApi({ executeApplicationMenuItem })
  const user = userEvent.setup()
  render(<App />)
  await waitFor(() => expect(windowStateChanged).not.toBeNull())
  act(() => windowStateChanged?.({ maximized: false, fullscreen: true, revision: 1 }))

  await user.click(within(screen.getByRole('navigation', { name: '应用程序菜单' }))
    .getByRole('button', { name: '视图' }))
  const fullscreenItem = screen.getByRole('menuitemcheckbox', { name: /退出全屏/ })
  fullscreenItem.focus()
  expect(fullscreenItem).toHaveFocus()
  await user.click(fullscreenItem)
  expect(executeApplicationMenuItem).toHaveBeenCalledWith('view.fullscreen')

  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })
  act(() => windowStateChanged?.({ maximized: false, fullscreen: false, revision: 2 }))
  await waitFor(() => expect(editor).toHaveFocus())
})

it('does not restart the fullscreen hint for duplicate or maximize-only true snapshots', async () => {
  vi.useFakeTimers()
  let view: ReturnType<typeof render> | null = null
  try {
    view = render(<App />)
    await act(async () => undefined)
    expect(windowStateChanged).not.toBeNull()

    act(() => windowStateChanged?.({ maximized: false, fullscreen: true, revision: 1 }))
    const hint = screen.getByText('按下 Esc 以退出全屏')
    act(() => vi.advanceTimersByTime(3_500))
    expect(hint).toHaveClass('is-fading')

    act(() => windowStateChanged?.({ maximized: true, fullscreen: true, revision: 2 }))
    expect(screen.getByText('按下 Esc 以退出全屏')).toBe(hint)
    expect(hint).toHaveClass('is-fading')

    act(() => windowStateChanged?.({ maximized: true, fullscreen: true, revision: 3 }))
    expect(screen.getByText('按下 Esc 以退出全屏')).toBe(hint)
    expect(hint).toHaveClass('is-fading')

    act(() => vi.advanceTimersByTime(500))
    expect(screen.queryByText('按下 Esc 以退出全屏')).not.toBeInTheDocument()

    act(() => windowStateChanged?.({ maximized: true, fullscreen: false, revision: 4 }))
    act(() => windowStateChanged?.({ maximized: true, fullscreen: true, revision: 5 }))
    expect(screen.getByText('按下 Esc 以退出全屏')).toBeVisible()
    expect(screen.getByText('按下 Esc 以退出全屏')).not.toHaveClass('is-fading')
  } finally {
    view?.unmount()
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})

it('keeps the fullscreen hint lifecycle stable across a keyed workspace remount', async () => {
  vi.useFakeTimers()
  let view: ReturnType<typeof render> | null = null
  try {
    view = render(<App />)
    await act(async () => undefined)
    expect(windowStateChanged).not.toBeNull()

    act(() => windowStateChanged?.({ maximized: false, fullscreen: true, revision: 1 }))
    const hint = screen.getByText('按下 Esc 以退出全屏')
    act(() => vi.advanceTimersByTime(3_500))
    expect(hint).toHaveClass('is-fading')

    fireEvent.click(screen.getByRole('button', { name: '选择工作区' }))
    await act(async () => undefined)
    expect(screen.getByRole('button', { name: 'Notes' })).toBeVisible()
    expect(screen.getByText('按下 Esc 以退出全屏')).toBe(hint)
    expect(hint).toHaveClass('is-fading')

    act(() => vi.advanceTimersByTime(500))
    expect(screen.queryByText('按下 Esc 以退出全屏')).not.toBeInTheDocument()

    act(() => windowStateChanged?.({ maximized: false, fullscreen: false, revision: 2 }))
    act(() => windowStateChanged?.({ maximized: false, fullscreen: true, revision: 3 }))
    expect(screen.getByText('按下 Esc 以退出全屏')).toBeVisible()
    act(() => windowStateChanged?.({ maximized: false, fullscreen: false, revision: 4 }))
    expect(screen.queryByText('按下 Esc 以退出全屏')).not.toBeInTheDocument()
  } finally {
    view?.unmount()
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})

it('owns one window-state read and subscription across keyed workspace remounts', async () => {
  const callOrder: string[] = []
  const cleanupOrder: string[] = []
  let listenerRegistered = false
  const originalDispose = WindowStateSnapshotController.prototype.dispose
  const dispose = vi.spyOn(WindowStateSnapshotController.prototype, 'dispose')
    .mockImplementation(function (this: WindowStateSnapshotController) {
      cleanupOrder.push('dispose')
      originalDispose.call(this)
    })
  const unsubscribe = vi.fn(() => cleanupOrder.push('unsubscribe'))
  const getWindowState = vi.fn(async () => {
    callOrder.push('get')
    expect(listenerRegistered).toBe(true)
    return {
      ok: true as const,
      value: { maximized: false, fullscreen: false, revision: 0 },
    }
  })
  const onWindowStateChanged = vi.fn((handler: typeof windowStateChanged) => {
    callOrder.push('subscribe')
    listenerRegistered = true
    windowStateChanged = handler
    return unsubscribe
  })
  installApi({ getWindowState, onWindowStateChanged })

  const view = render(<App />)
  await waitFor(() => expect(getWindowState).toHaveBeenCalledOnce())
  expect(onWindowStateChanged).toHaveBeenCalledOnce()
  expect(callOrder).toEqual(['subscribe', 'get'])

  fireEvent.click(screen.getByRole('button', { name: '选择工作区' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Notes' })).toBeVisible())
  expect(getWindowState).toHaveBeenCalledOnce()
  expect(onWindowStateChanged).toHaveBeenCalledOnce()

  view.unmount()
  expect(dispose).toHaveBeenCalledOnce()
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(cleanupOrder).toEqual(['dispose', 'unsubscribe'])
  dispose.mockRestore()
})

it('handles a rejected initial window-state read after unmount', async () => {
  const initial = deferred<ApiResult<{ maximized: boolean; fullscreen: boolean; revision: number }>>()
  const unsubscribe = vi.fn()
  const unhandled: PromiseRejectionEvent[] = []
  const onUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event)
  window.addEventListener('unhandledrejection', onUnhandled)
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const getWindowState = vi.fn(() => initial.promise)
  const onWindowStateChanged = vi.fn(() => unsubscribe)
  const controlWindow = vi.fn(async () => ({
    ok: true as const,
    value: { maximized: false, fullscreen: false, revision: 0 },
  }))
  installApi({ controlWindow, getWindowState, onWindowStateChanged })

  const view = render(<App />)
  await waitFor(() => expect(getWindowState).toHaveBeenCalledOnce())
  const menuUpdatesBeforeUnmount = vi.mocked(
    window.arkdown.updateApplicationMenuWindowState,
  ).mock.calls.length
  view.unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()

  initial.reject(new Error('late initial read'))
  await act(async () => undefined)

  expect(unhandled).toHaveLength(0)
  expect(consoleError).not.toHaveBeenCalled()
  expect(controlWindow).not.toHaveBeenCalled()
  expect(window.arkdown.updateApplicationMenuWindowState).toHaveBeenCalledTimes(
    menuUpdatesBeforeUnmount,
  )
  expect(screen.queryByText('按下 Esc 以退出全屏')).not.toBeInTheDocument()
  window.removeEventListener('unhandledrejection', onUnhandled)
  consoleError.mockRestore()
})

it('subscribes before the initial read and rejects a delayed stale snapshot', async () => {
  const initial = deferred<ApiResult<{ maximized: boolean; fullscreen: boolean; revision: number }>>()
  let emit: typeof windowStateChanged = null
  const getWindowState = vi.fn(() => initial.promise)
  const onWindowStateChanged = vi.fn((handler: NonNullable<typeof windowStateChanged>) => {
    emit = handler
    return vi.fn()
  })
  installApi({ getWindowState, onWindowStateChanged })

  render(<App />)
  await waitFor(() => expect(getWindowState).toHaveBeenCalledOnce())
  expect(onWindowStateChanged).toHaveBeenCalledOnce()

  act(() => emit?.({ maximized: true, fullscreen: true, revision: 2 }))
  expect(screen.getByRole('button', { name: '退出全屏' })).toBeVisible()
  expect(screen.getByRole('button', { name: '关闭' })).toBeVisible()
  expect(screen.queryByText('按下 Esc 以退出全屏')).not.toBeInTheDocument()

  initial.resolve({
    ok: true,
    value: { maximized: false, fullscreen: false, revision: 1 },
  })
  await act(async () => undefined)
  expect(screen.getByRole('button', { name: '退出全屏' })).toBeVisible()
  expect(screen.getByRole('button', { name: '关闭' })).toBeVisible()
  expect(screen.queryByText('按下 Esc 以退出全屏')).not.toBeInTheDocument()
})

it('gates fullscreen chrome and hint transitions by accepted revisions', async () => {
  vi.useFakeTimers()
  let view: ReturnType<typeof render> | null = null
  try {
    view = render(<App />)
    await act(async () => undefined)
    expect(windowStateChanged).not.toBeNull()

    act(() => windowStateChanged?.({ maximized: false, fullscreen: true, revision: 1 }))
    const hint = screen.getByText('按下 Esc 以退出全屏')
    act(() => vi.advanceTimersByTime(3_500))
    expect(hint).toHaveClass('is-fading')

    act(() => windowStateChanged?.({ maximized: true, fullscreen: false, revision: 1 }))
    expect(screen.getByText('按下 Esc 以退出全屏')).toBe(hint)
    expect(screen.getByRole('button', { name: '退出全屏' })).toBeVisible()
    expect(screen.getByRole('button', { name: '关闭' })).toBeVisible()

    act(() => windowStateChanged?.({ maximized: true, fullscreen: true, revision: 2 }))
    expect(screen.getByText('按下 Esc 以退出全屏')).toBe(hint)
    expect(hint).toHaveClass('is-fading')

    act(() => windowStateChanged?.({ maximized: true, fullscreen: false, revision: 3 }))
    expect(screen.queryByText('按下 Esc 以退出全屏')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭' })).toBeVisible()

    act(() => windowStateChanged?.({ maximized: false, fullscreen: true, revision: 4 }))
    expect(screen.getByText('按下 Esc 以退出全屏')).toBeVisible()
    expect(screen.getByText('按下 Esc 以退出全屏')).not.toBe(hint)
  } finally {
    view?.unmount()
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})

it('opens a chosen workspace and displays its document tree', async () => {
  const user = userEvent.setup()
  render(<App />)

  await user.click(screen.getByRole('button', { name: '选择工作区' }))

  expect(await screen.findByRole('button', { name: 'Notes' })).toBeVisible()
  expect(await screen.findByRole('button', { name: 'note.md' })).toBeVisible()
  expect(window.arkdown.restoreWorkspace).not.toHaveBeenCalled()
})

it('publishes printable menu state and routes the custom Print item through main', async () => {
  const user = userEvent.setup()
  const executeApplicationMenuItem = vi.fn(async () => ({ ok: true as const, value: null }))
  installApi({ executeApplicationMenuItem })
  render(<App />)

  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  expect(await screen.findByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Note')
  const applicationMenu = screen.getByRole('navigation', { name: '应用程序菜单' })
  await user.click(within(applicationMenu).getByRole('button', { name: '文件' }))

  const print = screen.getByRole('menuitem', { name: '打印…Ctrl+P' })
  expect(print).toBeEnabled()
  fireEvent.click(print)
  expect(executeApplicationMenuItem).toHaveBeenCalledWith('file.print')
})

it('prints the current source-mode Markdown as a rendered-document payload without mutating the session', async () => {
  const printDocument = vi.fn(async () => ({ ok: true as const, value: null }))
  installApi({ printDocument })
  const user = userEvent.setup()
  render(<App />)

  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const editor = await screen.findByRole('textbox', { name: 'Markdown editor' })
  fireEvent.change(editor, { target: { value: '# Source draft' } })
  act(() => editorModeBridge.report?.('source'))
  const modeButton = screen.getByRole('button', { name: '源码模式/渲染模式' })
  expect(modeButton).toHaveAttribute('aria-pressed', 'true')
  await waitFor(() => expect(document.title).toContain('●'))
  const titleBeforePrint = document.title
  vi.mocked(window.arkdown.recordRecentDocument).mockClear()

  act(() => menuCommand?.('print-document'))

  await waitFor(() => expect(printDocument).toHaveBeenCalledWith({
    markdown: '# Source draft',
    documentName: 'note.md',
    documentAbsolutePath: 'C:/Notes/note.md',
    appearance: DEFAULT_EDITOR_APPEARANCE,
  }))
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toBe(editor)
  expect(editor).toHaveValue('# Source draft')
  expect(modeButton).toHaveAttribute('aria-pressed', 'true')
  expect(document.title).toBe(titleBeforePrint)
  expect(window.arkdown.recordRecentDocument).not.toHaveBeenCalled()
})

it('exports the current Markdown directly to DOCX through a fresh target', async () => {
  const exportDocx = vi.fn(async () => ({
    ok: true as const,
    value: { fileName: 'note.docx', reusedTarget: false },
  }))
  installApi({ exportDocx })
  const user = userEvent.setup()
  render(<App />)

  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  expect(await screen.findByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Note')

  act(() => menuCommand?.('export-docx'))

  await waitFor(() => expect(exportDocx).toHaveBeenCalledWith({
    documentSessionId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    markdown: '# Note',
    mode: 'choose',
    suggestedBaseName: 'note',
  }))
})

it('exports the current Markdown to XLSX through the main-owned Save As flow', async () => {
  const exportXlsx = vi.fn(async () => ({
    ok: true as const,
    value: { fileName: 'note.xlsx' },
  }))
  installApi({ exportXlsx })
  const user = userEvent.setup()
  render(<App />)

  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  act(() => menuCommand?.('export-xlsx'))

  await waitFor(() => expect(exportXlsx).toHaveBeenCalledWith({
    markdown: '# Note',
    suggestedBaseName: 'note',
  }))
})

it('persists dark mode, updates the menu and portals, and returns to light without editing the document', async () => {
  installApi({
    getEditorAppearancePreferences: vi.fn(async () => ({ ok: true as const, value: appearanceSnapshot(DEFAULT_EDITOR_APPEARANCE) })),
  })
  const user = userEvent.setup()
  render(<App />)
  await waitFor(() => expect(menuCommand).not.toBeNull())
  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })
  const originalContent = (editor as HTMLTextAreaElement).value
  act(() => menuCommand?.('select-editor-theme-dark'))
  await waitFor(() => expect(document.documentElement).toHaveAttribute('data-arkdown-theme', 'dark'))
  expect(window.arkdown.compareAndSetEditorAppearancePreferences).toHaveBeenCalledWith(
    0, DEFAULT_EDITOR_APPEARANCE, { ...DEFAULT_EDITOR_APPEARANCE, editorTheme: 'dark' },
  )
  await user.click(screen.getByRole('button', { name: /^主题$/ }))
  expect(screen.getByRole('menuitemradio', { name: '深色模式' })).toHaveAttribute('aria-checked', 'true')
  expect((editor as HTMLTextAreaElement).value).toBe(originalContent)
  expect(mermaidAppearanceBridge.values.at(-1)?.colorScheme).toBe('dark')
  act(() => menuCommand?.('select-editor-theme-minimal'))
  await waitFor(() => expect(document.documentElement).toHaveAttribute('data-arkdown-theme', 'minimal'))
  expect(mermaidAppearanceBridge.values.at(-1)?.colorScheme).toBe('light')
})

it('persists the spelling menu command through field-level CAS before updating checked state', async () => {
  const persisted = { ...DEFAULT_EDITOR_APPEARANCE, spellCheckEnabled: true }
  const compareAndSetEditorAppearancePreferences = vi.fn(async () => ({
    ok: true as const,
    value: appearanceSnapshot(persisted, 1),
  }))
  installApi({
    getEditorAppearancePreferences: vi.fn(async () => ({
      ok: true as const,
      value: appearanceSnapshot({ ...DEFAULT_EDITOR_APPEARANCE }),
    })),
    compareAndSetEditorAppearancePreferences,
  })
  const user = userEvent.setup()
  render(<App />)
  await waitFor(() => expect(menuCommand).not.toBeNull())
  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })
  expect(editor).toHaveAttribute('data-spellcheck', 'false')

  act(() => menuCommand?.('toggle-spell-check'))

  await waitFor(() => expect(compareAndSetEditorAppearancePreferences).toHaveBeenCalledWith(
    0,
    DEFAULT_EDITOR_APPEARANCE,
    persisted,
  ))
  expect(window.arkdown.setEditorAppearancePreferences).toBeUndefined()
  await waitFor(() => expect(editor).toHaveAttribute('data-spellcheck', 'true'))
  await waitFor(() => expect(window.arkdown.updateApplicationMenuWindowState)
    .toHaveBeenLastCalledWith(expect.objectContaining({ spellCheckEnabled: true })))
  const applicationMenu = screen.getByRole('navigation', { name: '应用程序菜单' })
  await user.click(within(applicationMenu).getByRole('button', { name: '编辑' }))
  expect(screen.getByRole('menuitemcheckbox', { name: '拼写检查' }))
    .toHaveAttribute('aria-checked', 'true')
})

it('keeps spelling disabled and reports the existing error when persistence fails', async () => {
  const compareAndSetEditorAppearancePreferences = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'OPERATION_FAILED' as const, message: 'Spelling save failed' },
  }))
  installApi({
    getEditorAppearancePreferences: vi.fn(async () => ({
      ok: true as const,
      value: appearanceSnapshot({ ...DEFAULT_EDITOR_APPEARANCE }),
    })),
    compareAndSetEditorAppearancePreferences,
  })
  const user = userEvent.setup()
  render(<App />)
  await waitFor(() => expect(menuCommand).not.toBeNull())
  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })

  act(() => menuCommand?.('toggle-spell-check'))

  await waitFor(() => expect(compareAndSetEditorAppearancePreferences).toHaveBeenCalledOnce())
  await waitFor(() => expect(document.querySelector('.document-error-notice')).toHaveTextContent('Spelling save failed'))
  expect(editor).toHaveAttribute('data-spellcheck', 'false')
  expect(vi.mocked(window.arkdown.updateApplicationMenuWindowState).mock.calls)
    .not.toContainEqual([expect.objectContaining({ spellCheckEnabled: true })])
  const applicationMenu = screen.getByRole('navigation', { name: '应用程序菜单' })
  await user.click(within(applicationMenu).getByRole('button', { name: '编辑' }))
  expect(screen.getByRole('menuitemcheckbox', { name: '拼写检查' }))
    .toHaveAttribute('aria-checked', 'false')
})

it('derives initial native and custom edit-indicator checks from the confirmed preference', async () => {
  const hidden = { ...DEFAULT_EDITOR_APPEARANCE, showEditIndicators: false }
  installApi({
    getEditorAppearancePreferences: vi.fn(async () => ({
      ok: true as const,
      value: appearanceSnapshot(hidden, 3),
    })),
  })
  const user = userEvent.setup()
  render(<App />)

  await waitFor(() => expect(window.arkdown.updateApplicationMenuWindowState)
    .toHaveBeenLastCalledWith(expect.objectContaining({ showEditIndicators: false })))
  const applicationMenu = screen.getByRole('navigation', { name: '应用程序菜单' })
  await user.click(within(applicationMenu).getByRole('button', { name: '视图' }))
  expect(screen.getByRole('menuitemcheckbox', { name: '源码编辑提示' }))
    .toHaveAttribute('aria-checked', 'false')
})

it('confirms an edit-indicator CAS before updating menus and never dispatches an editor command', async () => {
  const initial = { ...DEFAULT_EDITOR_APPEARANCE, showEditIndicators: false }
  const persisted = { ...initial, showEditIndicators: true }
  const write = deferred<ApiResult<EditorAppearanceSnapshot>>()
  const compareAndSetEditorAppearancePreferences = vi.fn(() => write.promise)
  installApi({
    getEditorAppearancePreferences: vi.fn(async () => ({
      ok: true as const,
      value: appearanceSnapshot(initial, 3),
    })),
    compareAndSetEditorAppearancePreferences,
  })
  const editorCommand = vi.fn()
  window.addEventListener('arkdown:editor-command', editorCommand)
  const user = userEvent.setup()
  render(<App />)
  await waitFor(() => expect(menuCommand).not.toBeNull())
  await waitFor(() => expect(window.arkdown.updateApplicationMenuWindowState)
    .toHaveBeenLastCalledWith(expect.objectContaining({ showEditIndicators: false })))
  vi.mocked(window.arkdown.updateApplicationMenuWindowState).mockClear()
  const markdownBefore = screen.getByRole('textbox', { name: 'Markdown editor' }).getAttribute('value')

  act(() => menuCommand?.('toggle-edit-indicators'))

  await waitFor(() => expect(compareAndSetEditorAppearancePreferences).toHaveBeenCalledWith(
    3,
    initial,
    persisted,
  ))
  expect(window.arkdown.updateApplicationMenuWindowState).not.toHaveBeenCalled()
  expect(editorCommand).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox', { name: 'Markdown editor' }).getAttribute('value'))
    .toBe(markdownBefore)

  await act(async () => {
    write.resolve({ ok: true, value: appearanceSnapshot(persisted, 4) })
    await write.promise
  })
  await waitFor(() => expect(window.arkdown.updateApplicationMenuWindowState)
    .toHaveBeenLastCalledWith(expect.objectContaining({ showEditIndicators: true })))
  const applicationMenu = screen.getByRole('navigation', { name: '应用程序菜单' })
  await user.click(within(applicationMenu).getByRole('button', { name: '视图' }))
  expect(screen.getByRole('menuitemcheckbox', { name: '源码编辑提示' }))
    .toHaveAttribute('aria-checked', 'true')
  expect(editorCommand).not.toHaveBeenCalled()
  window.removeEventListener('arkdown:editor-command', editorCommand)
})

it('keeps the confirmed edit-indicator state and reports the existing error on CAS failure', async () => {
  const initial = { ...DEFAULT_EDITOR_APPEARANCE, showEditIndicators: false }
  const compareAndSetEditorAppearancePreferences = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'OPERATION_FAILED' as const, message: 'Indicator save failed' },
  }))
  installApi({
    getEditorAppearancePreferences: vi.fn(async () => ({
      ok: true as const,
      value: appearanceSnapshot(initial, 2),
    })),
    compareAndSetEditorAppearancePreferences,
  })
  const user = userEvent.setup()
  render(<App />)
  await waitFor(() => expect(menuCommand).not.toBeNull())
  await waitFor(() => expect(window.arkdown.updateApplicationMenuWindowState)
    .toHaveBeenLastCalledWith(expect.objectContaining({ showEditIndicators: false })))
  vi.mocked(window.arkdown.updateApplicationMenuWindowState).mockClear()

  act(() => menuCommand?.('toggle-edit-indicators'))

  await waitFor(() => expect(compareAndSetEditorAppearancePreferences).toHaveBeenCalledOnce())
  await waitFor(() => expect(document.querySelector('.document-error-notice')).toHaveTextContent('Indicator save failed'))
  expect(vi.mocked(window.arkdown.updateApplicationMenuWindowState).mock.calls)
    .not.toContainEqual([expect.objectContaining({ showEditIndicators: true })])
  const applicationMenu = screen.getByRole('navigation', { name: '应用程序菜单' })
  await user.click(within(applicationMenu).getByRole('button', { name: '视图' }))
  expect(screen.getByRole('menuitemcheckbox', { name: '源码编辑提示' }))
    .toHaveAttribute('aria-checked', 'false')
})

it('runs only one appearance menu transaction for rapid repeated or cross-field commands', async () => {
  const initial = { ...DEFAULT_EDITOR_APPEARANCE, showEditIndicators: false }
  const write = deferred<ApiResult<EditorAppearanceSnapshot>>()
  const compareAndSetEditorAppearancePreferences = vi.fn(() => write.promise)
  installApi({
    getEditorAppearancePreferences: vi.fn(async () => ({
      ok: true as const,
      value: appearanceSnapshot(initial, 1),
    })),
    compareAndSetEditorAppearancePreferences,
  })
  render(<App />)
  await waitFor(() => expect(menuCommand).not.toBeNull())

  act(() => {
    menuCommand?.('toggle-edit-indicators')
    menuCommand?.('toggle-edit-indicators')
    menuCommand?.('toggle-spell-check')
  })

  await waitFor(() => expect(compareAndSetEditorAppearancePreferences).toHaveBeenCalledOnce())
  write.resolve({
    ok: true,
    value: appearanceSnapshot({ ...initial, showEditIndicators: true }, 2),
  })
  await act(async () => { await write.promise })
  expect(compareAndSetEditorAppearancePreferences).toHaveBeenCalledOnce()
})

it('uses the latest confirmed full snapshot for sequential spelling and indicator mutations', async () => {
  const initial = {
    ...DEFAULT_EDITOR_APPEARANCE,
    showEditIndicators: false,
    spellCheckEnabled: false,
  }
  const compareAndSetEditorAppearancePreferences = vi.fn(async (
    expectedRevision,
    _expected,
    replacement,
  ) => ({
    ok: true as const,
    value: appearanceSnapshot(replacement, expectedRevision + 1),
  }))
  installApi({
    getEditorAppearancePreferences: vi.fn(async () => ({
      ok: true as const,
      value: appearanceSnapshot(initial, 1),
    })),
    compareAndSetEditorAppearancePreferences,
  })
  render(<App />)
  await waitFor(() => expect(menuCommand).not.toBeNull())

  act(() => menuCommand?.('toggle-edit-indicators'))
  await waitFor(() => expect(compareAndSetEditorAppearancePreferences).toHaveBeenCalledOnce())
  await waitFor(() => expect(window.arkdown.updateApplicationMenuWindowState)
    .toHaveBeenLastCalledWith(expect.objectContaining({ showEditIndicators: true })))
  act(() => menuCommand?.('toggle-spell-check'))

  await waitFor(() => expect(compareAndSetEditorAppearancePreferences).toHaveBeenCalledTimes(2))
  const afterIndicator = { ...initial, showEditIndicators: true }
  expect(compareAndSetEditorAppearancePreferences).toHaveBeenNthCalledWith(
    2,
    2,
    afterIndicator,
    { ...afterIndicator, spellCheckEnabled: true },
  )
  await waitFor(() => expect(window.arkdown.updateApplicationMenuWindowState)
    .toHaveBeenLastCalledWith(expect.objectContaining({
      showEditIndicators: true,
      spellCheckEnabled: true,
    })))
})

it('retains the intended edit-indicator draft after a conflict without automatic retry', async () => {
  const initial = { ...DEFAULT_EDITOR_APPEARANCE, showEditIndicators: false }
  const concurrent = {
    ...initial,
    themeColor: '#2563EB',
    spellCheckEnabled: true,
    maximumContentWidthPx: 960,
  }
  const replacement = { ...concurrent, showEditIndicators: true }
  const compareAndSetEditorAppearancePreferences = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: appearanceSnapshot(concurrent, 2) })
    .mockResolvedValueOnce({ ok: true, value: appearanceSnapshot(replacement, 3) })
  installApi({
    getEditorAppearancePreferences: vi.fn(async () => ({
      ok: true as const,
      value: appearanceSnapshot(initial, 1),
    })),
    compareAndSetEditorAppearancePreferences,
  })
  render(<App />)
  await waitFor(() => expect(menuCommand).not.toBeNull())

  act(() => menuCommand?.('toggle-edit-indicators'))

  await waitFor(() => expect(compareAndSetEditorAppearancePreferences).toHaveBeenCalledTimes(1))
  expect(compareAndSetEditorAppearancePreferences).toHaveBeenNthCalledWith(1, 1, initial, {
    ...initial,
    showEditIndicators: true,
  })
  expect(document.querySelector('.document-error-notice')).toHaveTextContent('其他窗口')
  expect(document.querySelector('.app-shell')).toHaveStyle({ '--theme-color-rgb': '37 99 235' })
  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-spellcheck', 'true')
})

it('does not write again when the CAS result is already at the intended target', async () => {
  const initial = { ...DEFAULT_EDITOR_APPEARANCE, showEditIndicators: false }
  const remoteAtTarget = {
    ...initial,
    showEditIndicators: true,
    themeColor: '#2563EB',
  }
  const compareAndSetEditorAppearancePreferences = vi.fn(async () => ({
    ok: true as const,
    value: appearanceSnapshot(remoteAtTarget, 2),
  }))
  installApi({
    getEditorAppearancePreferences: vi.fn(async () => ({
      ok: true as const,
      value: appearanceSnapshot(initial, 1),
    })),
    compareAndSetEditorAppearancePreferences,
  })
  render(<App />)
  await waitFor(() => expect(menuCommand).not.toBeNull())

  act(() => menuCommand?.('toggle-edit-indicators'))

  await waitFor(() => expect(compareAndSetEditorAppearancePreferences).toHaveBeenCalledOnce())
  await waitFor(() => expect(document.querySelector('.app-shell'))
    .toHaveStyle({ '--theme-color-rgb': '37 99 235' }))
  expect(compareAndSetEditorAppearancePreferences).toHaveBeenCalledOnce()
})

it('prevents a late older CAS response from reverting a newer appearance broadcast', async () => {
  const initial = { ...DEFAULT_EDITOR_APPEARANCE, showEditIndicators: false }
  const olderPersisted = { ...initial, showEditIndicators: true }
  const newerBroadcast = {
    ...initial,
    themeColor: '#2563EB',
    spellCheckEnabled: true,
  }
  const write = deferred<ApiResult<EditorAppearanceSnapshot>>()
  const rebased = { ...newerBroadcast, showEditIndicators: true }
  const compareAndSetEditorAppearancePreferences = vi.fn()
    .mockImplementationOnce(() => write.promise)
    .mockResolvedValueOnce({ ok: true, value: appearanceSnapshot(rebased, 4) })
  installApi({
    getEditorAppearancePreferences: vi.fn(async () => ({
      ok: true as const,
      value: appearanceSnapshot(initial, 1),
    })),
    compareAndSetEditorAppearancePreferences,
  })
  render(<App />)
  await waitFor(() => expect(menuCommand).not.toBeNull())

  act(() => menuCommand?.('toggle-edit-indicators'))
  await waitFor(() => expect(window.arkdown.compareAndSetEditorAppearancePreferences)
    .toHaveBeenCalledOnce())
  await act(async () => editorAppearanceChanged?.(appearanceSnapshot(newerBroadcast, 3)))
  await act(async () => {
    write.resolve({ ok: true, value: appearanceSnapshot(olderPersisted, 2) })
    await write.promise
  })

  await waitFor(() => expect(compareAndSetEditorAppearancePreferences).toHaveBeenCalledTimes(1))

  expect(document.querySelector('.app-shell')).toHaveStyle({ '--theme-color-rgb': '37 99 235' })
  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-spellcheck', 'true')
  expect(vi.mocked(window.arkdown.updateApplicationMenuWindowState))
    .toHaveBeenLastCalledWith(expect.objectContaining({ showEditIndicators: false }))
})

it('applies a successfully persisted spelling update broadcast by another window', async () => {
  const initialRead = deferred<ApiResult<EditorAppearanceSnapshot>>()
  installApi({
    getEditorAppearancePreferences: vi.fn(() => initialRead.promise),
  })
  render(<App />)
  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })
  await waitFor(() => expect(editorAppearanceChanged).not.toBeNull())

  await act(async () => editorAppearanceChanged?.(appearanceSnapshot({
    ...DEFAULT_EDITOR_APPEARANCE,
    spellCheckEnabled: true,
  }, 1)))

  expect(editor).toHaveAttribute('data-spellcheck', 'true')
  await waitFor(() => expect(window.arkdown.updateApplicationMenuWindowState)
    .toHaveBeenLastCalledWith(expect.objectContaining({ spellCheckEnabled: true })))

  initialRead.resolve({
    ok: true,
    value: appearanceSnapshot({ ...DEFAULT_EDITOR_APPEARANCE }),
  })
  await act(async () => { await initialRead.promise })
  expect(editor).toHaveAttribute('data-spellcheck', 'true')
})

it('zooms only the editor host, synchronizes runtime menu state, and preserves live editor state', async () => {
  const setEditorAppearancePreferences = vi.fn()
  installApi({ setEditorAppearancePreferences })
  const user = userEvent.setup()
  render(<App />)
  await waitFor(() => expect(menuCommand).not.toBeNull())

  const host = screen.getByTestId('editor-host')
  const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Markdown editor' })
  const titlebar = screen.getByTestId('app-titlebar')
  const sidebar = document.querySelector<HTMLElement>('.sidebar')!
  const header = document.querySelector<HTMLElement>('.document-header')!
  expect(document.querySelector('.document-error-notice')).toBeNull()
  const chrome = [titlebar, sidebar, header]
  fireEvent.change(editor, { target: { value: '# Draft' } })
  editor.focus()
  editor.setSelectionRange(0, 3)
  editor.scrollTop = 31
  const selectionBeforeZoom = [editor.selectionStart, editor.selectionEnd]

  act(() => menuCommand?.('editor-zoom-in'))

  expect(host.style.getPropertyValue('--editor-zoom-factor')).toBe('1.1')
  expect(editor).toHaveAttribute('data-zoom-percent', '110')
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toBe(editor)
  expect(editor).toHaveFocus()
  expect([editor.selectionStart, editor.selectionEnd]).toEqual(selectionBeforeZoom)
  expect(editor.scrollTop).toBe(31)
  expect(chrome.every((element) => element.style.getPropertyValue('--editor-zoom-factor') === ''))
    .toBe(true)
  await waitFor(() => expect(window.arkdown.updateApplicationMenuWindowState)
    .toHaveBeenLastCalledWith(expect.objectContaining({ editorZoomPercent: 110 })))
  expect(setEditorAppearancePreferences).not.toHaveBeenCalled()

  const applicationMenu = screen.getByRole('navigation', { name: '应用程序菜单' })
  await user.click(within(applicationMenu).getByRole('button', { name: '视图' }))
  expect(screen.getByRole('menuitem', { name: '仅放大编辑区' })).toBeEnabled()
  expect(screen.getByRole('menuitem', { name: '仅缩小编辑区' })).toBeEnabled()
  expect(screen.getByRole('menuitem', { name: '恢复编辑区大小' })).toBeEnabled()

  act(() => {
    for (let index = 0; index < 9; index += 1) menuCommand?.('editor-zoom-in')
  })
  expect(host.style.getPropertyValue('--editor-zoom-factor')).toBe('2')
  expect(editor).toHaveAttribute('data-zoom-percent', '200')
  expect(screen.getByRole('menuitem', { name: '仅放大编辑区' })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: '仅缩小编辑区' })).toBeEnabled()
  const updateCountAtMaximum = vi.mocked(window.arkdown.updateApplicationMenuWindowState).mock.calls.length

  act(() => menuCommand?.('editor-zoom-in'))
  expect(vi.mocked(window.arkdown.updateApplicationMenuWindowState)).toHaveBeenCalledTimes(
    updateCountAtMaximum,
  )

  act(() => menuCommand?.('editor-zoom-reset'))
  expect(host.style.getPropertyValue('--editor-zoom-factor')).toBe('1')
  expect(editor).toHaveAttribute('data-zoom-percent', '100')
  expect(screen.getByRole('menuitem', { name: '恢复编辑区大小' })).toBeDisabled()

  act(() => {
    for (let index = 0; index < 3; index += 1) menuCommand?.('editor-zoom-out')
  })
  expect(host.style.getPropertyValue('--editor-zoom-factor')).toBe('0.7')
  expect(editor).toHaveAttribute('data-zoom-percent', '70')
  expect(screen.getByRole('menuitem', { name: '仅放大编辑区' })).toBeEnabled()
  expect(screen.getByRole('menuitem', { name: '仅缩小编辑区' })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: '恢复编辑区大小' })).toBeEnabled()
})

it('keeps editor zoom isolated per renderer window and starts each new session at 100 percent', async () => {
  const handlers: Array<(command: import('../../src/shared/menu-commands').MenuCommand) => void> = []
  const onMenuCommand = vi.fn((handler: (command: import('../../src/shared/menu-commands').MenuCommand) => void) => {
    handlers.push(handler)
    return () => {
      const index = handlers.indexOf(handler)
      if (index >= 0) handlers.splice(index, 1)
    }
  })
  installApi({ onMenuCommand })
  const first = render(<App />)
  await screen.findByTestId('editor-host')
  const firstWindowHandlers = [...handlers]
  expect(firstWindowHandlers.length).toBeGreaterThan(0)
  const second = render(<App />)
  const hosts = screen.getAllByTestId('editor-host')

  act(() => firstWindowHandlers.forEach(handler => handler('editor-zoom-out')))

  expect(hosts[0].style.getPropertyValue('--editor-zoom-factor')).toBe('0.9')
  expect(hosts[1].style.getPropertyValue('--editor-zoom-factor')).toBe('1')

  first.unmount()
  second.unmount()
  expect(handlers).toHaveLength(0)
  render(<App />)
  await waitFor(() => expect(handlers.length).toBeGreaterThan(0))
  expect(screen.getByTestId('editor-host').style.getPropertyValue('--editor-zoom-factor')).toBe('1')
})

it('maps the Minimal theme without persisting, dispatching editor commands, or remounting', async () => {
  const compareAndSetEditorAppearancePreferences = vi.fn()
  installApi({ compareAndSetEditorAppearancePreferences, getEditorAppearancePreferences: vi.fn(async () => ({
    ok: true as const, value: appearanceSnapshot({ ...DEFAULT_EDITOR_APPEARANCE, editorTheme: 'minimal' }),
  })) })
  const editorCommands: string[] = []
  const recordCommand = (event: Event) => {
    editorCommands.push(String((event as CustomEvent<unknown>).detail))
  }
  window.addEventListener('arkdown:editor-command', recordCommand)
  const { container } = render(<App />)
  const editor = await screen.findByRole('textbox', {
    name: 'Markdown editor',
  }) as HTMLTextAreaElement
  await waitFor(() => expect(menuCommand).not.toBeNull())
  fireEvent.change(editor, { target: { value: 'minimal content' } })
  editor.setSelectionRange(2, 7)

  expect(container.querySelector('.app-shell')).toHaveAttribute('data-editor-theme', 'minimal')
  expect(editor).toHaveAttribute('data-editor-theme', 'minimal')
  act(() => {
    menuCommand?.('select-editor-theme-minimal' as never)
    menuCommand?.('select-editor-theme-minimal' as never)
  })

  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toBe(editor)
  expect(editor).toHaveProperty('selectionStart', 2)
  expect(editor).toHaveProperty('selectionEnd', 7)
  expect(compareAndSetEditorAppearancePreferences).not.toHaveBeenCalled()
  expect(editorCommands).toEqual([])
  window.removeEventListener('arkdown:editor-command', recordCommand)
})

it('routes only physical Ctrl+Backquote from the editor to the body paragraph command', async () => {
  render(<App />)
  const editor = await screen.findByRole('textbox', { name: 'Markdown editor' })
  const commands: string[] = []
  const listener = (event: Event) => commands.push((event as CustomEvent<string>).detail)
  window.addEventListener('arkdown:editor-command', listener)
  const visualContent = document.body.appendChild(document.createElement('div'))
  visualContent.className = 'ProseMirror'
  const sourceContent = document.body.appendChild(document.createElement('div'))
  sourceContent.className = 'cm-content'

  fireEvent.keyDown(editor, { key: '0', code: 'Digit0', ctrlKey: true })
  fireEvent.keyDown(editor, { key: '·', code: 'Backquote', ctrlKey: true })
  fireEvent.keyDown(visualContent, { key: '`', code: 'Backquote', ctrlKey: true })
  fireEvent.keyDown(sourceContent, { key: '§', code: 'Backquote', metaKey: true })
  fireEvent.keyDown(document.body, { key: '·', code: 'Backquote', ctrlKey: true })

  window.removeEventListener('arkdown:editor-command', listener)
  visualContent.remove()
  sourceContent.remove()
  expect(commands).toEqual(['paragraph', 'paragraph', 'paragraph'])
})

it('retains the window zoom when a workspace replacement remounts the editor session', async () => {
  const user = userEvent.setup()
  render(<App />)
  await waitFor(() => expect(menuCommand).not.toBeNull())

  act(() => menuCommand?.('editor-zoom-out'))
  expect(screen.getByTestId('editor-host').style.getPropertyValue('--editor-zoom-factor')).toBe('0.9')

  await user.click(screen.getByRole('button', { name: '选择工作区' }))

  expect(await screen.findByRole('button', { name: 'Notes' })).toBeVisible()
  expect(screen.getByTestId('editor-host').style.getPropertyValue('--editor-zoom-factor')).toBe('0.9')
  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-zoom-percent', '90')
})

it('ignores an out-of-order appearance event after accepting a newer revision', async () => {
  installApi({
    getEditorAppearancePreferences: vi.fn(async () => ({
      ok: true as const,
      value: appearanceSnapshot(DEFAULT_EDITOR_APPEARANCE),
    })),
  })
  render(<App />)
  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })
  await waitFor(() => expect(editorAppearanceChanged).not.toBeNull())

  const newer = {
    ...DEFAULT_EDITOR_APPEARANCE,
    spellCheckEnabled: true,
    themeColor: '#2563EB',
  }
  const older = {
    ...DEFAULT_EDITOR_APPEARANCE,
    spellCheckEnabled: false,
    themeColor: '#800080',
  }
  await act(async () => {
    editorAppearanceChanged?.(appearanceSnapshot(newer, 2))
    editorAppearanceChanged?.(appearanceSnapshot(older, 1))
  })

  expect(editor).toHaveAttribute('data-spellcheck', 'true')
  expect(document.querySelector('.app-shell')).toHaveStyle({ '--theme-color-rgb': '37 99 235' })
})

it('keeps Mermaid stable across OS changes and follows the saved Arkdown theme', async () => {
  const queryText = '(prefers-color-scheme: dark)'
  let dark = false
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const darkQuery = {
    media: queryText,
    get matches() { return dark },
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener)
    },
    addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    dispatchEvent: () => true,
  } as MediaQueryList
  const staticQuery = (media: string) => ({
    media,
    matches: false,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  } as MediaQueryList)
  const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => query === queryText ? darkQuery : staticQuery(query)),
  })
  const preferences = {
    ...DEFAULT_EDITOR_APPEARANCE,
    editorTheme: 'minimal' as const,
    bodyLatinFont: 'Arial',
    bodyCjkFont: 'Microsoft YaHei',
    themeColor: '#2563eb',
  }
  installApi({
    getEditorAppearancePreferences: vi.fn(async () => ({
      ok: true as const,
      value: appearanceSnapshot(preferences, 6),
    })),
  })

  try {
    render(<App />)
    await waitFor(() => expect(mermaidAppearanceBridge.values.at(-1)?.themeColor)
      .toBe('#2563EB'))
    const light = mermaidAppearanceBridge.values.at(-1)!
    expect(light).toMatchObject({
      editorTheme: 'minimal',
      colorScheme: 'light',
      themeColor: '#2563EB',
      bodyFontFamily: '"Arial", "Microsoft YaHei"',
    })
    expect(Object.isFrozen(light)).toBe(true)

    act(() => windowStateChanged?.({ maximized: true, fullscreen: false, revision: 1 }))
    expect(mermaidAppearanceBridge.values.at(-1)).toBe(light)

    act(() => {
      dark = true
      const event = { matches: true, media: queryText } as MediaQueryListEvent
      for (const listener of listeners) listener(event)
    })
    expect(mermaidAppearanceBridge.values.at(-1)).toBe(light)
    await act(async () => editorAppearanceChanged?.(appearanceSnapshot({ ...preferences, editorTheme: 'dark' }, 7)))
    await waitFor(() => expect(mermaidAppearanceBridge.values.at(-1)?.colorScheme).toBe('dark'))
    const darkAppearance = mermaidAppearanceBridge.values.at(-1)!
    expect(darkAppearance).not.toBe(light)
    expect(darkAppearance.revision).toBeGreaterThan(light.revision)
    expect(darkAppearance.themeColor).toBe('#2563EB')
    expect(darkAppearance.bodyFontFamily).toBe('"Arial", "Microsoft YaHei"')
  } finally {
    if (matchMediaDescriptor) Object.defineProperty(window, 'matchMedia', matchMediaDescriptor)
    else Reflect.deleteProperty(window, 'matchMedia')
  }
})

it('subscribes before publishing initial menu state and renders main-built menu changes', async () => {
  const order: string[] = []
  const updateApplicationMenuWindowState = vi.fn(async () => {
    order.push('update')
    return { ok: true as const, value: undefined }
  })
  installApi({
    updateApplicationMenuWindowState,
    onApplicationMenuChanged: vi.fn((handler) => {
      order.push('subscribe')
      applicationMenuChanged = handler
      return () => { if (applicationMenuChanged === handler) applicationMenuChanged = null }
    }),
  })
  const user = userEvent.setup()
  render(<App />)

  await waitFor(() => expect(updateApplicationMenuWindowState).toHaveBeenCalled())
  expect(order.slice(0, 2)).toEqual(['subscribe', 'update'])
  act(() => applicationMenuChanged?.(buildApplicationMenuModel({
    recentDocuments: [{
      id: 'file.recent.opaque-recent',
      absolutePath: 'C:\\Docs\\recent.md',
    }],
    hasPrintableDocument: false,
    spellCheckEnabled: false,
    showEditIndicators: true,
    editorZoomPercent: 100,
    fullscreen: false,
  })))
  const applicationMenu = screen.getByRole('navigation', { name: '应用程序菜单' })
  await user.click(within(applicationMenu).getByRole('button', { name: '文件' }))
  await user.hover(screen.getByRole('menuitem', { name: '最近编辑的文档…' }))
  expect(await screen.findByRole('menuitem', { name: 'C:\\Docs\\recent.md' })).toBeVisible()
})

it('reimports the current DOCX from its source path and refreshes only after it settles', async () => {
  const user = userEvent.setup()
  const pendingReload = deferred<Awaited<ReturnType<NonNullable<ArkdownApi['importDocx']>>>>()
  const listDirectory = vi.fn(async () => ({
    ok: true as const,
    value: [{ name: 'report.docx', relativePath: 'report.docx', kind: 'document' as const }],
  }))
  const importDocx = vi.fn()
    .mockResolvedValueOnce({
      ok: true as const,
      value: {
        sourceAbsolutePath: 'C:/Notes/report.docx',
        sourceFileName: 'report.docx',
        markdown: '# Imported once',
      },
    })
    .mockImplementationOnce(() => pendingReload.promise)
  installApi({ importDocx, listDirectory })
  render(<App />)

  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'report.docx' }))
  await waitFor(() => expect(importDocx).toHaveBeenCalledOnce())
  await waitFor(() => expect(listDirectory).toHaveBeenCalledOnce())
  listDirectory.mockClear()

  const reload = screen.getByRole('button', { name: '从磁盘重新加载' })
  await user.click(reload)
  await user.click(reload)

  await waitFor(() => expect(importDocx).toHaveBeenCalledTimes(2))
  expect(importDocx).toHaveBeenLastCalledWith('report.docx')
  expect(window.arkdown.readDocument).not.toHaveBeenCalled()
  expect(listDirectory).not.toHaveBeenCalled()
  expect(workspaceSidebarBridge.refreshVersions).toEqual([0])

  await act(async () => pendingReload.resolve({
    ok: true,
    value: {
      sourceAbsolutePath: 'C:/Notes/report.docx',
      sourceFileName: 'report.docx',
      markdown: '# Imported again',
    },
  }))

  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveValue('# Imported again'))
  await waitFor(() => expect(listDirectory).toHaveBeenCalledOnce())
  expect(workspaceSidebarBridge.refreshVersions).toEqual([0, 1])
})

it('leaves an edited imported DOCX and the workspace tree unchanged when reload is cancelled', async () => {
  const user = userEvent.setup()
  const listDirectory = vi.fn(async () => ({
    ok: true as const,
    value: [{ name: 'report.docx', relativePath: 'report.docx', kind: 'document' as const }],
  }))
  const importDocx = vi.fn(async () => ({
    ok: true as const,
    value: {
      sourceAbsolutePath: 'C:/Notes/report.docx',
      sourceFileName: 'report.docx',
      markdown: '# Imported',
    },
  }))
  installApi({ importDocx, listDirectory })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'report.docx' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), {
    target: { value: '# Edited import' },
  })
  listDirectory.mockClear()

  await user.click(screen.getByRole('button', { name: '从磁盘重新加载' }))
  const dialog = await screen.findByRole('dialog', { name: '从磁盘重新加载' })
  expect(dialog).toHaveTextContent('从磁盘重新加载会放弃当前未保存的修改。是否继续？')
  expect(within(dialog).getAllByRole('button').map((button) => button.textContent))
    .toEqual(['继续', '取消'])
  await user.click(within(dialog).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '从磁盘重新加载' }))
    .not.toBeInTheDocument())

  expect(importDocx).toHaveBeenCalledOnce()
  expect(listDirectory).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Edited import')
})

it('keeps an imported DOCX reload error and does not refresh the workspace tree', async () => {
  const user = userEvent.setup()
  const listDirectory = vi.fn(async () => ({
    ok: true as const,
    value: [{ name: 'report.docx', relativePath: 'report.docx', kind: 'document' as const }],
  }))
  const importDocx = vi.fn()
    .mockResolvedValueOnce({
      ok: true as const,
      value: {
        sourceAbsolutePath: 'C:/Notes/report.docx',
        sourceFileName: 'report.docx',
        markdown: '# Imported',
      },
    })
    .mockResolvedValueOnce({
      ok: false as const,
      error: { code: 'OPERATION_FAILED' as const, message: 'DOCX 重新导入失败' },
    })
  installApi({ importDocx, listDirectory })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'report.docx' }))
  await waitFor(() => expect(importDocx).toHaveBeenCalledOnce())
  listDirectory.mockClear()

  await user.click(screen.getByRole('button', { name: '从磁盘重新加载' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('DOCX 重新导入失败')
  expect(importDocx).toHaveBeenCalledTimes(2)
  expect(listDirectory).not.toHaveBeenCalled()
})

it('refreshes once only after the current document reload settles', async () => {
  const user = userEvent.setup()
  const pendingReload = deferred<ApiResult<DocumentSnapshot>>()
  const listDirectory = vi.fn(async () => ({
    ok: true as const,
    value: [{ name: 'note.md', relativePath: 'note.md', kind: 'document' as const }],
  }))
  const readDocument = vi.fn()
    .mockResolvedValueOnce({
      ok: true as const,
      value: {
        relativePath: 'note.md',
        markdown: '# Note',
        revision: revisionA,
        encoding: 'utf8' as const,
        newline: 'lf' as const,
        mtimeMs: 1,
      },
    })
    .mockImplementationOnce(() => pendingReload.promise)
  installApi({ listDirectory, readDocument })
  render(<App />)

  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  await waitFor(() => expect(readDocument).toHaveBeenCalledOnce())
  await waitFor(() => expect(listDirectory).toHaveBeenCalledOnce())
  readDocument.mockClear()
  listDirectory.mockClear()

  const reload = screen.getByRole('button', { name: '从磁盘重新加载' })
  await user.click(reload)
  await user.click(reload)

  await waitFor(() => expect(readDocument).toHaveBeenCalledOnce())
  expect(listDirectory).not.toHaveBeenCalled()
  expect(workspaceSidebarBridge.refreshVersions).toEqual([0])

  await act(async () => {
    pendingReload.resolve({
      ok: true,
      value: {
        relativePath: 'note.md',
        markdown: '# Reloaded',
        revision: 'b'.repeat(64),
        encoding: 'utf8',
        newline: 'lf',
        mtimeMs: 2,
      },
    })
    await pendingReload.promise
  })

  await waitFor(() => expect(listDirectory).toHaveBeenCalledOnce())
  expect(readDocument).toHaveBeenCalledOnce()
  expect(workspaceSidebarBridge.refreshVersions).toEqual([0, 1])
})

it('lets a newly opened document reload while the previous document reload is still pending', async () => {
  const user = userEvent.setup()
  const pendingFirstReload = deferred<ApiResult<DocumentSnapshot>>()
  const pendingSecondReload = deferred<ApiResult<DocumentSnapshot>>()
  const listDirectory = vi.fn(async () => ({
    ok: true as const,
    value: [
      { name: 'first.md', relativePath: 'first.md', kind: 'document' as const },
      { name: 'second.md', relativePath: 'second.md', kind: 'document' as const },
    ],
  }))
  const readDocument = vi.fn()
    .mockResolvedValueOnce({
      ok: true as const,
      value: {
        relativePath: 'first.md', markdown: '# First', revision: revisionA,
        encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 1,
      },
    })
    .mockImplementationOnce(() => pendingFirstReload.promise)
    .mockResolvedValueOnce({
      ok: true as const,
      value: {
        relativePath: 'second.md', markdown: '# Second', revision: 'b'.repeat(64),
        encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 2,
      },
    })
    .mockImplementationOnce(() => pendingSecondReload.promise)
  installApi({ listDirectory, readDocument })
  render(<App />)

  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'first.md' }))
  await waitFor(() => expect(readDocument).toHaveBeenCalledOnce())
  listDirectory.mockClear()

  const reload = screen.getByRole('button', { name: '从磁盘重新加载' })
  await user.click(reload)
  await waitFor(() => expect(readDocument).toHaveBeenCalledTimes(2))
  await user.click(await screen.findByRole('button', { name: 'second.md' }))
  await waitFor(() => expect(readDocument).toHaveBeenCalledTimes(3))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveValue('# Second'))

  await user.click(reload)
  await waitFor(() => expect(readDocument).toHaveBeenCalledTimes(4))

  await act(async () => pendingFirstReload.resolve({
    ok: true,
    value: {
      relativePath: 'first.md', markdown: '# Stale first', revision: 'c'.repeat(64),
      encoding: 'utf8', newline: 'lf', mtimeMs: 3,
    },
  }))
  await user.click(reload)
  expect(readDocument).toHaveBeenCalledTimes(4)
  expect(listDirectory).not.toHaveBeenCalled()

  await act(async () => pendingSecondReload.resolve({
    ok: true,
    value: {
      relativePath: 'second.md', markdown: '# Reloaded second', revision: 'd'.repeat(64),
      encoding: 'utf8', newline: 'lf', mtimeMs: 4,
    },
  }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveValue('# Reloaded second'))
  await waitFor(() => expect(listDirectory).toHaveBeenCalledOnce())
})

it('refreshes the workspace tree without reloading when no document is open', async () => {
  const user = userEvent.setup()
  const listDirectory = vi.fn(async () => ({ ok: true as const, value: [] }))
  const readDocument = vi.fn()
  installApi({ listDirectory, readDocument })
  render(<App />)

  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await waitFor(() => expect(listDirectory).toHaveBeenCalledOnce())
  listDirectory.mockClear()

  const reload = screen.getByRole('button', { name: '从磁盘重新加载' })
  expect(reload).toBeEnabled()
  await user.click(reload)

  await waitFor(() => expect(listDirectory).toHaveBeenCalledOnce())
  expect(readDocument).not.toHaveBeenCalled()
})

it('does not reload or refresh the workspace tree when dirty reload is cancelled', async () => {
  const user = userEvent.setup()
  const listDirectory = vi.fn(async () => ({
    ok: true as const,
    value: [{ name: 'note.md', relativePath: 'note.md', kind: 'document' as const }],
  }))
  const readDocument = vi.fn(async (relativePath: string) => ({
    ok: true as const,
    value: {
      relativePath,
      markdown: '# Note',
      revision: revisionA,
      encoding: 'utf8' as const,
      newline: 'lf' as const,
      mtimeMs: 1,
    },
  }))
  installApi({ listDirectory, readDocument })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), {
    target: { value: '# Dirty' },
  })
  readDocument.mockClear()
  listDirectory.mockClear()

  await user.click(screen.getByRole('button', { name: '从磁盘重新加载' }))
  const dialog = await screen.findByRole('dialog', { name: '从磁盘重新加载' })
  await user.click(within(dialog).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '从磁盘重新加载' }))
    .not.toBeInTheDocument())

  expect(readDocument).not.toHaveBeenCalled()
  expect(listDirectory).not.toHaveBeenCalled()
})

it('keeps the reload error channel and does not refresh the tree when reload fails', async () => {
  const user = userEvent.setup()
  const listDirectory = vi.fn(async () => ({
    ok: true as const,
    value: [{ name: 'note.md', relativePath: 'note.md', kind: 'document' as const }],
  }))
  const readDocument = vi.fn(async (relativePath: string): Promise<ApiResult<DocumentSnapshot>> => ({
    ok: true as const,
    value: {
      relativePath,
      markdown: '# Note',
      revision: revisionA,
      encoding: 'utf8' as const,
      newline: 'lf' as const,
      mtimeMs: 1,
    },
  }))
  installApi({ listDirectory, readDocument })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  readDocument.mockResolvedValueOnce({
    ok: false,
    error: { code: 'READ_FAILED', message: '磁盘读取失败' },
  })
  readDocument.mockClear()
  listDirectory.mockClear()

  await user.click(screen.getByRole('button', { name: '从磁盘重新加载' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('磁盘读取失败')
  expect(readDocument).toHaveBeenCalledOnce()
  expect(listDirectory).not.toHaveBeenCalled()
})

it('records a successful open and subsequent save once per successful revision', async () => {
  const user = userEvent.setup()
  const recordRecentDocument = vi.fn(async (absolutePath: string) => ({
    ok: true as const,
    value: [absolutePath],
  }))
  const updateApplicationMenuWindowState = vi.fn(async () => ({
    ok: true as const,
    value: undefined,
  }))
  installApi({ recordRecentDocument, updateApplicationMenuWindowState })
  render(<App />)

  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const editor = await screen.findByRole('textbox', { name: 'Markdown editor' })
  await waitFor(() => expect(recordRecentDocument).toHaveBeenCalledTimes(1))
  expect(recordRecentDocument).toHaveBeenLastCalledWith('C:/Notes/note.md')
  fireEvent.change(editor, { target: { value: '# Saved' } })
  await act(async () => {
    menuCommand?.('save')
    await vi.waitFor(() => expect(window.arkdown.saveDocument).toHaveBeenCalledOnce())
  })

  await waitFor(() => expect(recordRecentDocument).toHaveBeenCalledTimes(2))
  expect(recordRecentDocument).toHaveBeenLastCalledWith('C:/Notes/note.md')
  expect(updateApplicationMenuWindowState).toHaveBeenLastCalledWith(expect.objectContaining({
    hasPrintableDocument: true,
  }))
})

it('deduplicates an in-flight signature but retries it after a transient record failure', async () => {
  const user = userEvent.setup()
  const firstRecord = deferred<ApiResult<readonly string[]>>()
  const recordRecentDocument = vi.fn()
    .mockImplementationOnce(() => firstRecord.promise)
    .mockResolvedValue({ ok: true as const, value: ['C:/Notes/note.md'] })
  installApi({ recordRecentDocument })
  render(<App />)

  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  await waitFor(() => expect(recordRecentDocument).toHaveBeenCalledOnce())

  await user.click(screen.getByRole('button', { name: '从磁盘重新加载' }))
  await waitFor(() => expect(window.arkdown.readDocument).toHaveBeenCalledTimes(2))
  expect(recordRecentDocument).toHaveBeenCalledOnce()

  await act(async () => {
    firstRecord.resolve({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: 'temporary write failure' },
    })
    await firstRecord.promise
  })
  await user.click(screen.getByRole('button', { name: '从磁盘重新加载' }))

  await waitFor(() => expect(recordRecentDocument).toHaveBeenCalledTimes(2))
  expect(recordRecentDocument).toHaveBeenNthCalledWith(1, 'C:/Notes/note.md')
  expect(recordRecentDocument).toHaveBeenNthCalledWith(2, 'C:/Notes/note.md')
})

it('records successful DOCX import and save-as targets, but not cancelled save-as', async () => {
  const user = userEvent.setup()
  const recordRecentDocument = vi.fn(async (absolutePath: string) => ({
    ok: true as const,
    value: [absolutePath],
  }))
  installApi({
    recordRecentDocument,
    listDirectory: vi.fn(async () => ({
      ok: true as const,
      value: [{ name: 'report.docx', relativePath: 'report.docx', kind: 'document' as const }],
    })),
    importDocx: vi.fn(async () => ({
      ok: true as const,
      value: {
        sourceAbsolutePath: 'C:/Notes/report.docx',
        sourceFileName: 'report.docx',
        markdown: '# Imported',
      },
    })),
  })
  const view = render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'report.docx' }))
  await waitFor(() => expect(recordRecentDocument).toHaveBeenCalledWith('C:/Notes/report.docx'))
  view.unmount()

  recordRecentDocument.mockClear()
  const recentCommitted: CommitSaveDocumentAsResult = {
    ...committedSaveAs(workspace, true),
    document: {
      relativePath: 'saved.md', markdown: '# Saved', revision: revisionA,
      encoding: 'utf8', newline: 'lf', mtimeMs: 1,
    },
    aiWorkspace: {
      workspaceId: 'workspace-notes',
      workspaceGeneration: 'generation-1',
    },
  }
  const beginSaveDocumentAs = vi.fn()
    .mockResolvedValueOnce({
      ok: true as const,
      value: saveAsIntent(workspace, true),
    })
    .mockResolvedValueOnce({ ok: true as const, value: null })
  installApi({
    recordRecentDocument,
    beginSaveDocumentAs,
    commitSaveDocumentAs: vi.fn(async () => ({
      ok: true as const,
      value: recentCommitted,
    })),
    abortSaveDocumentAs: vi.fn(async () => ({ ok: true as const, value: null })),
  })
  render(<App />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), {
    target: { value: '# Saved' },
  })
  await act(async () => {
    menuCommand?.('save-as')
  })
  await waitFor(() => expect(recordRecentDocument).toHaveBeenCalledWith('C:/Notes/saved.md'))
  recordRecentDocument.mockClear()
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), {
    target: { value: '# Cancelled' },
  })
  await act(async () => {
    menuCommand?.('save-as')
  })
  await waitFor(() => expect(beginSaveDocumentAs).toHaveBeenCalledTimes(2))
  expect(recordRecentDocument).not.toHaveBeenCalled()
})

it('does not record failed document opens', async () => {
  const user = userEvent.setup()
  const recordRecentDocument = vi.fn(async () => ({ ok: true as const, value: [] }))
  installApi({
    recordRecentDocument,
    readDocument: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'FILE_NOT_FOUND', message: '文件已被移动或删除' },
    })),
  })
  render(<App />)

  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  await waitFor(() => expect(document.querySelector('.document-error-notice')).toHaveTextContent('文件已被移动或删除'))
  expect(recordRecentDocument).not.toHaveBeenCalled()
})

it('keeps app chrome non-selectable while the editor remains selectable', () => {
  const stylesheet = document.head.appendChild(document.createElement('style'))
  stylesheet.textContent = readFileSync(resolve(process.cwd(), 'src/renderer/app/styles.css'), 'utf8')
  const view = render(<App />)
  const shell = document.querySelector<HTMLElement>('.app-shell')!
  const editor = screen.getByRole('textbox', { name: 'Markdown editor' })

  expect(getComputedStyle(shell).userSelect).toBe('none')
  expect(getComputedStyle(editor).userSelect).toBe('text')

  view.unmount()
  stylesheet.remove()
})

it('keeps the current workspace when choosing another folder is cancelled', async () => {
  const user = userEvent.setup()
  const chooseWorkspace = vi.fn()
    .mockResolvedValueOnce({ ok: true as const, value: workspace })
    .mockResolvedValueOnce({ ok: true as const, value: null })
  installApi({ chooseWorkspace })
  render(<App />)

  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'Notes' }))

  expect(screen.getByRole('button', { name: 'Notes' })).toBeVisible()
})

it('asks before switching a workspace with a non-empty AI conversation and cancels cleanly', async () => {
  const user = userEvent.setup()
  const otherWorkspace = { name: 'Other', absolutePath: 'C:/Other' }
  const chooseWorkspace = vi.fn()
    .mockResolvedValueOnce({ ok: true as const, value: workspace })
    .mockResolvedValueOnce({ ok: true as const, value: otherWorkspace })
  installApi({ chooseWorkspace })
  render(<App />)

  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await waitFor(() => expect(editorInstanceBridge.stores.length).toBeGreaterThan(0))
  const store = editorInstanceBridge.stores.at(-1)!
  await waitFor(() => expect(store.activeWorkspaceId).toBe('workspace-notes'))
  store.sessions.get('workspace-notes')!.messages.push({
    id: 'user-1',
    role: 'user',
    content: '继续分析',
  })

  act(() => menuCommand?.('open-workspace'))
  const dialog = await screen.findByRole('dialog', {
    name: '切换工作区将创建新的AI对话',
  })
  expect(dialog).toHaveTextContent('之后再切回原先工作区可以继续之前的对话')
  expect(within(dialog).getByRole('button', { name: '切换' })).toBeVisible()
  await user.click(within(dialog).getByRole('button', { name: '取消' }))

  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  expect(chooseWorkspace).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Notes' })).toBeVisible()
})

it('never exposes the previous AI workspace binding in the replacement workspace shell', async () => {
  const user = userEvent.setup()
  const otherWorkspace = { name: 'Other', absolutePath: 'C:/Other' }
  const replacement = deferred<ApiResult<import('../../src/shared/contracts').AiWorkspaceState>>()
  const chooseWorkspace = vi.fn()
    .mockResolvedValueOnce({ ok: true as const, value: workspace })
    .mockResolvedValueOnce({ ok: true as const, value: otherWorkspace })
  const getAiWorkspaceState = vi.fn()
    .mockResolvedValueOnce({
      ok: true as const,
      value: { workspaceId: 'workspace-notes', workspaceGeneration: 'generation-1' },
    })
    .mockReturnValueOnce(replacement.promise)
  installApi({ chooseWorkspace, getAiWorkspaceState })
  render(<App />)

  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  const firstEditor = await screen.findByRole('textbox', { name: 'Markdown editor' })
  await waitFor(() => expect(firstEditor).toHaveAttribute('data-ai-workspace-id', 'workspace-notes'))

  act(() => menuCommand?.('open-workspace'))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Other' })).toBeVisible())
  const replacementEditor = screen.getByRole('textbox', { name: 'Markdown editor' })
  expect(replacementEditor).toHaveAttribute('data-ai-workspace-id', '')

  replacement.resolve({
    ok: false,
    error: { code: 'OPERATION_FAILED', message: 'replacement lookup failed' },
  })
  await act(async () => { await replacement.promise })
  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-ai-workspace-id', '')
})

it('refreshes AI authority for an authoritative same-path open intent and preserves its history', async () => {
  const user = userEvent.setup()
  let openIntent: Parameters<NonNullable<ArkdownApi['onOpenIntent']>>[0] | null = null
  const rotated = deferred<ApiResult<import('../../src/shared/contracts').AiWorkspaceState>>()
  const getAiWorkspaceState = vi.fn()
    .mockResolvedValueOnce({
      ok: true as const,
      value: { workspaceId: 'workspace-notes', workspaceGeneration: 'generation-1' },
    })
    .mockReturnValueOnce(rotated.promise)
  installApi({
    getAiWorkspaceState,
    onOpenIntent: vi.fn((handler) => {
      openIntent = handler
      return () => { if (openIntent === handler) openIntent = null }
    }),
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  const editor = await screen.findByRole('textbox', { name: 'Markdown editor' })
  await waitFor(() => expect(editor)
    .toHaveAttribute('data-ai-workspace-generation', 'generation-1'))
  const store = editorInstanceBridge.stores.at(-1)!
  const session = store.sessions.get('workspace-notes')!
  session.messages.push({ id: 'kept-history', role: 'assistant', content: 'keep me' })

  await act(async () => {
    openIntent?.({
      workspace,
      document: {
        relativePath: 'note.md', markdown: '# Authoritative reopen', revision: revisionA,
        encoding: 'utf8', newline: 'lf', mtimeMs: 2,
      },
    })
    await Promise.resolve()
  })

  await waitFor(() => expect(getAiWorkspaceState).toHaveBeenCalledTimes(2))
  expect(screen.queryByRole('dialog', {
    name: '切换工作区将创建新的AI对话',
  })).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-ai-workspace-generation', '')
  expect(store.sessions.get('workspace-notes')).toBe(session)
  expect(session.messages.map(({ content }) => content)).toContain('keep me')

  rotated.resolve({
    ok: true,
    value: { workspaceId: 'workspace-notes', workspaceGeneration: 'generation-2' },
  })
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-ai-workspace-generation', 'generation-2'))
  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveValue('# Authoritative reopen')
  expect(session.messages.map(({ content }) => content)).toContain('keep me')
})

it('gates cross-workspace open and import intents and leaves the current workspace on cancel', async () => {
  const user = userEvent.setup()
  const otherWorkspace = { name: 'Other', absolutePath: 'D:/Other' }
  let openIntent: Parameters<NonNullable<ArkdownApi['onOpenIntent']>>[0] | null = null
  let importIntent: Parameters<NonNullable<ArkdownApi['onImportDocxIntent']>>[0] | null = null
  installApi({
    onOpenIntent: vi.fn((handler) => {
      openIntent = handler
      return () => { if (openIntent === handler) openIntent = null }
    }),
    onImportDocxIntent: vi.fn((handler) => {
      importIntent = handler
      return () => { if (importIntent === handler) importIntent = null }
    }),
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await waitFor(() => expect(editorInstanceBridge.stores.length).toBeGreaterThan(0))
  const store = editorInstanceBridge.stores.at(-1)!
  await waitFor(() => expect(store.activeWorkspaceId).toBe('workspace-notes'))
  store.sessions.get('workspace-notes')!.messages.push({
    id: 'requires-gate', role: 'user', content: 'keep this workspace',
  })

  act(() => openIntent?.({
    workspace: otherWorkspace,
    document: {
      relativePath: 'other.md', markdown: '# Other', revision: revisionA,
      encoding: 'utf8', newline: 'lf', mtimeMs: 1,
    },
  }))
  let dialog = await screen.findByRole('dialog', {
    name: '切换工作区将创建新的AI对话',
  })
  expect(dialog).toHaveTextContent('之后再切回原先工作区可以继续之前的对话')
  await user.click(within(dialog).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  expect(screen.getByRole('button', { name: 'Notes' })).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Other' })).not.toBeInTheDocument()

  act(() => importIntent?.({
    workspace: otherWorkspace,
    imported: {
      sourceAbsolutePath: 'D:/Other/report.docx',
      sourceFileName: 'report.docx',
      markdown: '# Imported elsewhere',
    },
  }))
  dialog = await screen.findByRole('dialog', {
    name: '切换工作区将创建新的AI对话',
  })
  await user.click(within(dialog).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  expect(screen.getByRole('button', { name: 'Notes' })).toBeVisible()
  expect(screen.queryByText('# Imported elsewhere')).not.toBeInTheDocument()

  act(() => importIntent?.({
    workspace,
    imported: {
      sourceAbsolutePath: 'C:/Notes/report.docx',
      sourceFileName: 'report.docx',
      markdown: '# Imported here',
    },
  }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveValue('# Imported here'))
  expect(screen.queryByRole('dialog', {
    name: '切换工作区将创建新的AI对话',
  })).not.toBeInTheDocument()
})

it('opens a document and reports edits in the title and status', async () => {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))

  const editor = await screen.findByRole('textbox', { name: 'Markdown editor' })
  expect(editor).toHaveValue('# Note')
  expect(editor).toHaveAttribute('data-document-absolute-path', 'C:/Notes/note.md')
  expect(editor).toHaveAttribute('data-document-key', 'C:/Notes/note.md')
  expect(document.title).toBe('note.md — Arkdown')

  fireEvent.change(editor, { target: { value: '# Changed' } })
  await waitFor(() => expect(document.title).toBe('● note.md — Arkdown'))
  expect(document.querySelector('.document-header')).toHaveTextContent('未保存')
})

it('flushes a pending visual deletion before immediate document and workspace switches', async () => {
  const chooseWorkspace = vi.fn(async () => ({ ok: true as const, value: workspace }))
  installApi({
    chooseWorkspace,
    listDirectory: vi.fn(async () => ({
      ok: true as const,
      value: [
        { name: 'note.md', relativePath: 'note.md', kind: 'document' as const },
        { name: 'second.md', relativePath: 'second.md', kind: 'document' as const },
      ],
    })),
  })
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))

  editorFlushBridge.pendingMarkdown = '# Not'
  await user.click(screen.getByRole('button', { name: 'second.md' }))

  let dialog = await screen.findByRole('dialog', { name: '是否保存对“note.md”的更改？' })
  await user.click(within(dialog).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  expect(document.title).toBe('● note.md — Arkdown')
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Not')

  chooseWorkspace.mockClear()
  editorFlushBridge.pendingMarkdown = '# Workspace delete'
  act(() => menuCommand?.('open-workspace'))
  dialog = await screen.findByRole('dialog', { name: '是否保存对“note.md”的更改？' })
  await user.click(within(dialog).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  expect(chooseWorkspace).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Workspace delete')
})

it('propagates editor mode into the header while preserving the absolute document path', async () => {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))

  const editor = await screen.findByRole('textbox', { name: 'Markdown editor' })
  const modeButton = screen.getByRole('button', { name: '源码模式/渲染模式' })
  expect(editor).toHaveAttribute('data-document-absolute-path', 'C:/Notes/note.md')
  expect(modeButton).toHaveAttribute('aria-pressed', 'false')
  expect(editorModeBridge.report).not.toBeNull()

  act(() => editorModeBridge.report?.('source'))
  expect(modeButton).toHaveAttribute('aria-pressed', 'true')

  act(() => editorModeBridge.report?.('visual'))
  expect(modeButton).toHaveAttribute('aria-pressed', 'false')
})

it('renames the open document by clicking the header file name', async () => {
  const user = userEvent.setup()
  const renameWorkspaceEntry = vi.fn(async (_relativePath: string, newName: string) => ({
    ok: true as const,
    value: {
      entry: { name: newName, relativePath: newName, kind: 'document' as const },
      colorMarks: { marks: {} },
    },
  }))
  installApi({ renameWorkspaceEntry })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))

  fireEvent.click(await screen.findByRole('heading', { name: 'note.md' }))
  const input = screen.getByRole('textbox', { name: '修改文件名' })
  fireEvent.change(input, { target: { value: '计划.md' } })
  fireEvent.keyDown(input, { key: 'Enter' })

  await waitFor(() => expect(renameWorkspaceEntry).toHaveBeenCalledWith('note.md', '计划.md'))
  expect(await screen.findByRole('heading', { name: '计划.md' })).toBeVisible()
  expect(document.title).toBe('计划.md — Arkdown')
})

it('keeps an invalid header filename inline without renaming the workspace entry', async () => {
  const user = userEvent.setup()
  const renameWorkspaceEntry = vi.fn()
  installApi({ renameWorkspaceEntry })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))

  fireEvent.click(await screen.findByRole('heading', { name: 'note.md' }))
  const input = screen.getByRole('textbox', { name: '修改文件名' })
  fireEvent.change(input, { target: { value: '计划?.md' } })
  fireEvent.keyDown(input, { key: 'Enter' })

  expect(screen.getByRole('tooltip').textContent).toBe(String.raw`Windows系统文件名不能包含下列字符： \\ / : * ? " < > |`)
  expect(input).toBeInTheDocument()
  expect(input).toHaveValue('计划?.md')
  expect(renameWorkspaceEntry).not.toHaveBeenCalled()
  const sidebar = screen.getByRole('complementary')
  expect(within(sidebar).queryByRole('alert')).not.toBeInTheDocument()
  expect(sidebar.querySelector('.tree-error')).toBeNull()
})

it('uses an edited untitled name when opening the first save dialog', async () => {
  const beginSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: null }))
  installApi({
    beginSaveDocumentAs,
    commitSaveDocumentAs: vi.fn(),
    abortSaveDocumentAs: vi.fn(),
  })
  render(<App />)

  fireEvent.click(screen.getByRole('heading', { name: '未命名' }))
  const input = screen.getByRole('textbox', { name: '修改文件名' })
  fireEvent.change(input, { target: { value: '计划.md' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(screen.getByRole('heading', { name: '计划.md' })).toBeVisible())

  act(() => menuCommand?.('save'))
  await waitFor(() => expect(beginSaveDocumentAs).toHaveBeenCalledWith(expect.objectContaining({
    suggestedFileName: '计划.md',
  })))
})

it('prepares a clean window for closing', async () => {
  render(<App />)
  await waitFor(() => expect(window.arkdown.onPrepareClose).toHaveBeenCalled())
  await expect(prepareClose()).resolves.toBe(true)
})

it('shows a bounded workspace error in the sidebar', async () => {
  const user = userEvent.setup()
  installApi({ chooseWorkspace: vi.fn(async () => ({
    ok: false as const,
    error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
  })) })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('操作未能完成')
})


it('routes Chinese application-menu commands into the renderer', async () => {
  render(<App />)
  await waitFor(() => expect(menuCommand).not.toBeNull())

  menuCommand?.('open-workspace')
  expect(await screen.findByRole('button', { name: 'Notes' })).toBeVisible()
})

it('uses the fused titlebar renderer menu and toggles the sidebar', async () => {
  const executeApplicationMenuItem = vi.fn(async () => ({ ok: true as const, value: null }))
  installApi({ executeApplicationMenuItem })
  render(<App />)

  fireEvent.click(within(screen.getByTestId('app-titlebar')).getByRole('button', { name: '文件' }))
  const firstMenuItem = screen.getByRole('menu').querySelector<HTMLButtonElement>('button')
  fireEvent.click(firstMenuItem!)
  expect(executeApplicationMenuItem).toHaveBeenCalledWith('file.new-document')

  const shell = screen.getByTestId('editor-host').closest('.app-shell')
  expect(shell).not.toHaveClass('sidebar-collapsed')
  const titlebar = within(screen.getByTestId('app-titlebar'))
  expect(within(screen.getByTestId('editor-host')).queryByRole('button', { name: '隐藏侧边栏' })).not.toBeInTheDocument()
  fireEvent.click(titlebar.getByRole('button', { name: '隐藏侧边栏' }))
  expect(shell).toHaveClass('sidebar-collapsed')
  expect(titlebar.getByRole('button', { name: '显示侧边栏' })).toHaveAttribute('aria-pressed', 'false')
  fireEvent.click(titlebar.getByRole('button', { name: '显示侧边栏' }))
  expect(shell).not.toHaveClass('sidebar-collapsed')
  expect(titlebar.getByRole('button', { name: '隐藏侧边栏' })).toHaveAttribute('aria-pressed', 'true')
})


it('opens the sticky note box without showing or reading the startup prompt', async () => {
  const getDesktopLifecyclePreferences = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'OPERATION_FAILED' as const, message: 'should not be requested' },
  }))
  installApi({ getDesktopLifecyclePreferences })
  render(<App />)

  fireEvent.click(screen.getByRole('button', { name: '便签盒子' }))

  await waitFor(() => expect(document.querySelector('.sticky-note-box-motion')).toHaveAttribute('data-open', 'true'))
  expect(getDesktopLifecyclePreferences).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog', { name: '开启便签开机启动' })).not.toBeInTheDocument()
})

async function openAndQueueVisualDelete() {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  editorFlushBridge.pendingMarkdown = '# Change'
}

async function openAndEditImportedDocx(exportDocx: NonNullable<ArkdownApi['exportDocx']>) {
  installApi({
    listDirectory: vi.fn(async () => ({
      ok: true as const,
      value: [
        { name: 'report.docx', relativePath: 'report.docx', kind: 'document' as const },
        { name: 'second.md', relativePath: 'second.md', kind: 'document' as const },
      ],
    })),
    importDocx: vi.fn(async () => ({
      ok: true as const,
      value: {
        sourceAbsolutePath: 'C:/Notes/report.docx',
        sourceFileName: 'report.docx',
        markdown: '# Imported report',
      },
    })),
    exportDocx,
  })
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'report.docx' }))
  fireEvent.click(await screen.findByRole('heading', { name: 'report.docx' }))
  const nameInput = screen.getByRole('textbox', { name: '修改文件名' })
  fireEvent.change(nameInput, { target: { value: 'renamed.txt' } })
  fireEvent.keyDown(nameInput, { key: 'Enter' })
  await waitFor(() => expect(screen.getByRole('heading', { name: 'renamed.txt' })).toBeVisible())
  const editor = await screen.findByRole('textbox', { name: 'Markdown editor' })
  fireEvent.change(editor, { target: { value: '# Edited report' } })
  return user
}

const importedDocxPersistenceEntryPoints: readonly [
  string,
  (user: ReturnType<typeof userEvent.setup>) => Promise<unknown>,
][] = [
  ['native Ctrl+S command', async () => {
    act(() => menuCommand?.('save'))
    return undefined
  }],
  ['header save', async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: '保存' }))
    return undefined
  }],
  ['file-tree switch', async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'second.md' }))
    return undefined
  }],
  ['workspace switch', async () => {
    act(() => menuCommand?.('open-workspace'))
    return undefined
  }],
  ['window close preparation', async () => prepareClose()],
]

it.each(importedDocxPersistenceEntryPoints)('routes a renamed imported DOCX through shared persistence from %s', async (
  _entryPoint,
  invoke,
) => {
  const exportDocx = vi.fn(async (_input: ExportDocxInput) => ({
    ok: true as const,
    value: { fileName: 'report-export.docx', reusedTarget: false },
  }))
  const user = await openAndEditImportedDocx(exportDocx)

  const pendingOutcome = invoke(user)
  const dialog = await screen.findByRole('dialog', { name: '是否导出为新的docx文档？' })
  expect(within(dialog).getByText('Arkdown无法修改原docx文档。')).toBeVisible()
  expect(screen.queryByRole('dialog', { name: /是否保存对/u })).not.toBeInTheDocument()
  const transitionEntryPoint = ['file-tree switch', 'workspace switch', 'window close preparation']
    .includes(_entryPoint)
  expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(
    transitionEntryPoint ? ['导出', '不保存', '取消'] : ['导出', '取消'],
  )
  await user.click(within(dialog).getByRole('button', { name: '导出' }))
  const outcome = await pendingOutcome
  if (_entryPoint === 'window close preparation') expect(outcome).toBe(true)

  await waitFor(() => expect(exportDocx).toHaveBeenCalledWith(expect.objectContaining({
    markdown: '# Edited report',
    mode: 'choose',
    suggestedBaseName: 'renamed.txt',
  })))
})

it('saves the original only when the close dialog chooses 保存', async () => {
  const user = userEvent.setup()
  await openAndQueueVisualDelete()

  const closing = prepareClose()
  const dialog = await screen.findByRole('dialog', { name: '是否保存对“note.md”的更改？' })
  await user.click(within(dialog).getByRole('button', { name: '保存' }))
  await expect(closing).resolves.toBe(true)

  expect(window.arkdown.saveDraft).toHaveBeenCalled()
  expect(window.arkdown.saveDocument).toHaveBeenCalledTimes(1)
  expect(window.arkdown.saveDocument).toHaveBeenCalledWith(expect.objectContaining({
    markdown: '# Change',
  }))
  expect(window.arkdown.discardDraft).toHaveBeenCalledTimes(1)
})

it('discards the temporary draft without saving the original when close chooses 不保存', async () => {
  const user = userEvent.setup()
  await openAndQueueVisualDelete()

  const closing = prepareClose()
  const dialog = await screen.findByRole('dialog', { name: '是否保存对“note.md”的更改？' })
  await user.click(within(dialog).getByRole('button', { name: '不保存' }))
  await expect(closing).resolves.toBe(true)

  expect(window.arkdown.saveDocument).not.toHaveBeenCalled()
  expect(window.arkdown.discardDraft).toHaveBeenCalledTimes(1)
})

it('keeps the dirty window and draft when close chooses 取消', async () => {
  const user = userEvent.setup()
  await openAndQueueVisualDelete()

  const closing = prepareClose()
  const dialog = await screen.findByRole('dialog', { name: '是否保存对“note.md”的更改？' })
  await user.click(within(dialog).getByRole('button', { name: '取消' }))
  await act(async () => {
    await expect(closing).resolves.toBe(false)
  })

  expect(window.arkdown.saveDocument).not.toHaveBeenCalled()
  expect(window.arkdown.discardDraft).not.toHaveBeenCalled()
  expect(document.title).toBe('● note.md — Arkdown')
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Change')
})


it('remounts the visual editor with recovered unnamed contents and keeps it mounted during subsequent edits', async () => {
  installApi()
  render(<App />)
  await waitFor(() => expect(recoveryHandler).not.toBeNull())
  const mounts = editorInstanceBridge.mounts
  act(() => recoveryHandler?.({
    draftId: '123e4567-e89b-42d3-a456-426614174000',
    manifest: {
      draftId: '123e4567-e89b-42d3-a456-426614174000', originalAbsolutePath: null,
      workspaceAbsolutePath: null, originalRevision: null, originalMtimeMs: null,
      encoding: 'utf8', newline: 'lf', updatedAt: '2026-10-10T00:00:00.000Z', ignoredAt: null,
    },
    markdown: '# Recovered unnamed\n\n- [ ] Keep this task',
  }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Recovered unnamed\n\n- [ ] Keep this task'))
  expect(editorInstanceBridge.mounts).toBe(mounts + 1)
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), { target: { value: '# edited' } })
  expect(editorInstanceBridge.mounts).toBe(mounts + 1)
  expect(window.arkdown.saveDocument).not.toHaveBeenCalled()
})

it('restores a crash draft as dirty without overwriting the original', async () => {
  installApi({
    openDroppedPath: vi.fn(async () => ({
      ok: true as const,
      value: {
        workspace,
        document: {
          relativePath: 'note.md', markdown: '# Original', revision: revisionA,
          encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 1,
        },
      },
    })),
  })
  render(<App />)
  await waitFor(() => expect(recoveryHandler).not.toBeNull())

  recoveryHandler?.({
    draftId: '123e4567-e89b-42d3-a456-426614174000',
    manifest: {
      draftId: '123e4567-e89b-42d3-a456-426614174000',
      originalAbsolutePath: 'C:/Notes/note.md',
      workspaceAbsolutePath: 'C:/Notes',
      originalRevision: revisionA,
      originalMtimeMs: 1,
      encoding: 'utf8',
      newline: 'lf',
      updatedAt: '2026-07-24T00:00:00.000Z',
      ignoredAt: null,
    },
    markdown: '# Recovered',
  })

  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Recovered'))
  await waitFor(() => expect(document.title).toContain('●'))
  expect(window.arkdown.saveDocument).not.toHaveBeenCalled()
})

it('gates recovery into another workspace before opening its original document', async () => {
  const user = userEvent.setup()
  const openDroppedPath = vi.fn()
  installApi({ openDroppedPath })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  await waitFor(() => expect(recoveryHandler).not.toBeNull())
  const store = editorInstanceBridge.stores.at(-1)!
  await waitFor(() => expect(store.activeWorkspaceId).toBe('workspace-notes'))
  const currentSession = store.sessions.get('workspace-notes')!
  currentSession.messages.push({ id: 'recover-user', role: 'user', content: '保留恢复前会话' })

  act(() => recoveryHandler?.({
    draftId: '123e4567-e89b-42d3-a456-426614174001',
    manifest: {
      draftId: '123e4567-e89b-42d3-a456-426614174001',
      originalAbsolutePath: 'D:/Other/away.md',
      workspaceAbsolutePath: 'D:/Other',
      originalRevision: revisionA,
      originalMtimeMs: 1,
      encoding: 'utf8',
      newline: 'lf',
      updatedAt: '2026-07-24T00:00:00.000Z',
      ignoredAt: null,
    },
    markdown: '# Recovered elsewhere',
  }))
  const switchDialog = await screen.findByRole('dialog', {
    name: '切换工作区将创建新的AI对话',
  })

  expect(openDroppedPath).not.toHaveBeenCalled()
  await user.click(within(switchDialog).getByRole('button', { name: '取消' }))

  await waitFor(() => expect(switchDialog).not.toBeInTheDocument())
  expect(openDroppedPath).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-document-key', 'C:/Notes/note.md')
  expect(store.activeWorkspaceId).toBe('workspace-notes')
  expect(store.sessions.get('workspace-notes')).toBe(currentSession)
})

function installPreferencesPersistenceApi(overrides: Partial<ArkdownApi> = {}) {
  const persisted = {
    search: { provider: 'bing', customTemplate: '' } as BrowserSearchPreferences,
    appearance: appearanceSnapshot({
      ...DEFAULT_EDITOR_APPEARANCE,
      minimumContentMarginPx: 30, maximumContentWidthPx: 1200,
      themeColor: '#800080', spellCheckEnabled: false,
      preserveSingleLineBreaks: true, bodyLatinFont: 'Arial',
    }),
    arknote: structuredClone({ ...DEFAULT_ARKNOTE_PREFERENCES, registerDesktopContextMenu: false, themeColor: '#800080' }),
  }
  const getSearchPreferences = vi.fn<NonNullable<ArkdownApi['getSearchPreferences']>>(async () => ({
    ok: true as const, value: persisted.search,
  }))
  const setSearchPreferences = vi.fn<NonNullable<ArkdownApi['setSearchPreferences']>>(async (value) => {
    persisted.search = value
    return { ok: true, value }
  })
  const compareAndSetEditorAppearancePreferences =
    vi.fn<NonNullable<ArkdownApi['compareAndSetEditorAppearancePreferences']>>(
      async (expectedRevision, expected, replacement) => {
        if (
          expectedRevision === persisted.appearance.revision
          && JSON.stringify(expected) === JSON.stringify(persisted.appearance.appearance)
        ) {
          persisted.appearance = appearanceSnapshot(replacement, expectedRevision + 1)
        }
        return { ok: true, value: persisted.appearance }
      },
    )
  const setArknotePreferences = vi.fn<NonNullable<ArkdownApi['setArknotePreferences']>>(async (value) => {
    persisted.arknote = { ...persisted.arknote, ...value }
    return { ok: true, value: persisted.arknote }
  })
  installApi({
    getSearchPreferences,
    setSearchPreferences,
    getEditorAppearancePreferences: vi.fn(async () => ({
      ok: true as const, value: persisted.appearance,
    })),
    compareAndSetEditorAppearancePreferences,
    getArknotePreferences: vi.fn(async () => ({ ok: true as const, value: persisted.arknote })),
    setArknotePreferences,
    getSystemFonts: vi.fn(async () => ({ ok: true as const, value: ['Arial', 'Calibri', 'SimHei'] })),
    getLargeModelSettings: vi.fn(async () => ({ ok: true as const, value: DEFAULT_LARGE_MODEL_SETTINGS })),
    previewArknoteThemeColor: vi.fn(async () => ({ ok: true as const, value: null })),
    ...overrides,
  })
  return { persisted, getSearchPreferences, setSearchPreferences, compareAndSetEditorAppearancePreferences, setArknotePreferences }
}

async function openPreferencesPage() {
  await waitFor(() => expect(menuCommand).not.toBeNull())
  await act(async () => menuCommand?.('preferences'))
  expect(await screen.findByRole('main', { name: '偏好设置' })).toBeVisible()
}

it('retains an observed appearance draft on conflict without retrying against the refreshed value', async () => {
  const { patch, remote } = installObservedPreferences()
  render(<App />)
  await openPreferencesPage()
  remote()
  act(() => preferencesPageBridge.props!.onAppearanceChange({ bodyLatinFont: 'Arial' }))
  await waitFor(() => expect(patch).toHaveBeenCalledOnce())
  expect(patch.mock.calls[0]![0]).toEqual({ observed: observedAppearance(), changes: { bodyLatinFont: 'Arial' } })
  await waitFor(() => expect(preferencesPageBridge.props!.initialAppearance.bodyLatinFont).toBe('Arial'))
  expect(preferencesPageBridge.props!.persistenceError).toContain('其他窗口')
  await act(async () => { expect(await prepareClose()).toBe(false) })
  await act(async () => { expect(await prepareClose()).toBe(false) })
  await openPreferencesPage()
  expect(preferencesPageBridge.props!.initialAppearance.bodyLatinFont).toBe('Arial')
  expect(patch).toHaveBeenCalledOnce()
  patch.mockImplementationOnce(async input => {
    if (input.observed.group !== 'appearance') throw new Error('unexpected group')
    return { ok: true, value: { status: 'unchanged', snapshot: input.observed } }
  })
  fireEvent.click(screen.getByRole('button', { name: '重新加载已保存设置' }))
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(preferencesPageBridge.props!.persistenceError).toBeNull())
  expect(preferencesPageBridge.props!.initialAppearance.bodyLatinFont).toBe('Calibri')
  expect(patch.mock.calls[1]![0]).toMatchObject({ observed: { observation: { revision: 3 } }, changes: { bodyLatinFont: 'Calibri' } })
  await act(async () => { expect(await prepareClose()).toBe(false) })
  await act(async () => { expect(await prepareClose()).toBe(true) })
})

it('does not retry an observed appearance menu conflict or fall back to the legacy writer', async () => {
  const { patch } = installObservedPreferences()
  render(<App />)
  await waitFor(() => expect(window.arkdown.getPreferenceSnapshot).toHaveBeenCalledWith('appearance'))
  await act(async () => menuCommand?.('toggle-spell-check'))
  await waitFor(() => expect(patch).toHaveBeenCalledOnce())
  expect(window.arkdown.compareAndSetEditorAppearancePreferences).not.toHaveBeenCalled()
})

it('captures every category generation before an earlier category waits in the same batch', async () => {
  const { patch, search } = installObservedPreferences()
  const pendingSearch = deferred<void>()
  let saved = observedAppearance()
  patch.mockImplementation(async input => {
    if (input.observed.group === 'search') {
      await pendingSearch.promise
      return { ok: true, value: { status: 'committed', snapshot: { ...search, values: { ...search.values, ...input.changes },
        observation: { ...search.observation, revision: 2 } } } }
    }
    if (input.observed.group !== 'appearance') throw new Error('unexpected group')
    saved = { ...saved, values: { ...saved.values, ...input.changes }, observation: { ...saved.observation, revision: saved.observation.revision + 1 } }
    return { ok: true, value: { status: 'committed', snapshot: structuredClone(saved) } }
  })
  render(<App />)
  await openPreferencesPage()
  act(() => {
    preferencesPageBridge.props!.onSearchChange({ provider: 'google', customTemplate: '' })
    preferencesPageBridge.props!.onAppearanceChange({ bodyLatinFont: 'Arial' })
  })
  await waitFor(() => expect(patch).toHaveBeenCalledOnce())
  act(() => preferencesPageBridge.props!.onAppearanceChange({ bodyLatinFont: 'Calibri' }))
  await act(async () => pendingSearch.resolve())
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(3))
  expect(patch.mock.calls[1]![0]).toMatchObject({ observed: { observation: { revision: 1 } }, changes: { bodyLatinFont: 'Arial' } })
  expect(patch.mock.calls[2]![0]).toMatchObject({ observed: { observation: { revision: 2 } }, changes: { bodyLatinFont: 'Calibri' } })
  expect(preferencesPageBridge.props!.initialAppearance.bodyLatinFont).toBe('Calibri')
  expect(preferencesPageBridge.props!.persistenceError).toBeNull()
})

it('does not discard a newer local edit made while explicit saved-preference reload is reading', async () => {
  const { patch, remote } = installObservedPreferences()
  render(<App />)
  await openPreferencesPage()
  remote()
  act(() => preferencesPageBridge.props!.onAppearanceChange({ bodyLatinFont: 'Arial' }))
  await screen.findByRole('button', { name: '重新加载已保存设置' })
  const reading = deferred<ApiResult<PublicPreferenceSnapshot>>()
  const get = vi.mocked(window.arkdown.getPreferenceSnapshot!)
  const original = get.getMockImplementation()!
  get.mockImplementation(group => group === 'appearance' ? reading.promise : original(group))
  const before = get.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: '重新加载已保存设置' }))
  await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(before))
  act(() => preferencesPageBridge.props!.onAppearanceChange({ bodyLatinFont: 'Verdana' }))
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
  const latest = observedAppearance(3)
  latest.values.bodyLatinFont = 'Calibri'
  await act(async () => reading.resolve({ ok: true, value: latest }))
  expect(preferencesPageBridge.props!.initialAppearance.bodyLatinFont).toBe('Verdana')
  expect(patch).toHaveBeenCalledTimes(2)
})

it('keeps a failed desktop context menu change uncommitted through the real preferences queue', async () => {
  const save = vi.fn(async () => ({ ok: false as const, error: { code: 'SHELL_INTEGRATION_CONFLICT' as const, message: '桌面菜单已被其他程序修改' } }))
  const { persisted } = installPreferencesPersistenceApi({ setArknotePreferences: save })
  render(<App />)
  await openPreferencesPage()
  const section = screen.getByRole('region', { name: '右键菜单' })
  const checkbox = within(section).getByRole('checkbox', { name: '在桌面右键菜单中增加“创建新便签”' })
  fireEvent.click(checkbox)
  expect(checkbox).not.toBeChecked()
  await waitFor(() => expect(within(section).getByRole('alert')).toHaveTextContent('桌面菜单已被其他程序修改'))
  expect(checkbox).not.toBeChecked()
  expect(checkbox).toBeEnabled()
  expect(persisted.arknote.registerDesktopContextMenu).toBe(false)
  expect(save).toHaveBeenCalledTimes(1)
})

it.each(['success', 'failure', 'rejection'] as const)('retains saved material A after an apply failure and preserves it in the next material B write (refresh %s)', async (refresh) => {
  const { persisted, setArknotePreferences } = installPreferencesPersistenceApi()
  const getArknotePreferences = vi.mocked(window.arkdown.getArknotePreferences!)
  setArknotePreferences.mockImplementationOnce(async (value) => {
    persisted.arknote = { ...persisted.arknote, ...value }
    if (refresh === 'success') persisted.arknote = {
      ...persisted.arknote,
      micaAppearance: { ...persisted.arknote.micaAppearance, tintOpacity: 0.7654 },
    }
    if (refresh === 'failure') getArknotePreferences.mockResolvedValueOnce({
      ok: false, error: { code: 'OPERATION_FAILED', message: 'Read unavailable' },
    })
    if (refresh === 'rejection') getArknotePreferences.mockRejectedValueOnce(new Error('Read unavailable'))
    return { ok: false, error: { code: 'WALLPAPER_APPEARANCE_SAVED_NOT_APPLIED', message: '材料已保存，部分窗口应用失败' } }
  })
  render(<App />)
  await openPreferencesPage()
  const first = copyStickyNoteWallpaperAppearances(preferencesPageBridge.props!.initialArknote!)
  first.materialEffects['warm-frosted-glass'].transparency = 0.4321
  await act(async () => preferencesPageBridge.props!.onArknoteChange(first))
  await waitFor(() => expect(screen.getByRole('main', { name: '偏好设置' })).toHaveTextContent('材料已保存，部分窗口应用失败'))
  expect(preferencesPageBridge.props!.initialArknote!.materialEffects['warm-frosted-glass'].transparency).toBe(0.4321)
  expect(getArknotePreferences).toHaveBeenCalledTimes(3) // open, write rebase, saved-state refresh
  if (refresh === 'success') expect(preferencesPageBridge.props!.initialArknote!.micaAppearance.tintOpacity).toBe(0.7654)

  const second = copyStickyNoteWallpaperAppearances(preferencesPageBridge.props!.initialArknote!)
  second.materialEffects['clear-glass'].transparency = 0.2468
  await act(async () => preferencesPageBridge.props!.onArknoteChange(second))
  await waitFor(() => expect(setArknotePreferences).toHaveBeenCalledTimes(2))
  expect(setArknotePreferences.mock.calls[1]![0].materialEffects).toMatchObject({
    'warm-frosted-glass': { transparency: 0.4321 },
    'clear-glass': { transparency: 0.2468 },
  })
  expect(persisted.arknote.materialEffects['warm-frosted-glass'].transparency).toBe(0.4321)
  if (refresh === 'success') expect(setArknotePreferences.mock.calls[1]![0].micaAppearance?.tintOpacity).toBe(0.7654)
})

it('replays a newer queued material edit over the saved snapshot fetched after an apply failure', async () => {
  const { persisted, setArknotePreferences } = installPreferencesPersistenceApi()
  const refresh = deferred<ApiResult<typeof DEFAULT_ARKNOTE_PREFERENCES>>()
  const getArknotePreferences = vi.mocked(window.arkdown.getArknotePreferences!)
  setArknotePreferences.mockImplementationOnce(async (value) => {
    persisted.arknote = { ...persisted.arknote, ...value }
    getArknotePreferences.mockImplementationOnce(() => refresh.promise)
    return { ok: false, error: { code: 'WALLPAPER_APPEARANCE_SAVED_NOT_APPLIED', message: '材料应用失败' } }
  })
  const laterWrite = deferred<ApiResult<typeof DEFAULT_ARKNOTE_PREFERENCES>>()
  setArknotePreferences.mockImplementationOnce(() => laterWrite.promise)
  render(<App />)
  await openPreferencesPage()
  const first = copyStickyNoteWallpaperAppearances(preferencesPageBridge.props!.initialArknote!)
  first.materialEffects['warm-frosted-glass'].transparency = 0.41
  await act(async () => preferencesPageBridge.props!.onArknoteChange(first))
  await waitFor(() => expect(getArknotePreferences).toHaveBeenCalledTimes(3))
  const second = copyStickyNoteWallpaperAppearances(preferencesPageBridge.props!.initialArknote!)
  second.materialEffects['clear-glass'].transparency = 0.22
  await act(async () => preferencesPageBridge.props!.onArknoteChange(second))
  await act(async () => refresh.resolve({ ok: true, value: structuredClone(persisted.arknote) }))
  await waitFor(() => expect(setArknotePreferences).toHaveBeenCalledTimes(2))
  expect(preferencesPageBridge.props!.initialArknote!.materialEffects).toMatchObject({
    'warm-frosted-glass': { transparency: 0.41 }, 'clear-glass': { transparency: 0.22 },
  })
  const submitted = setArknotePreferences.mock.calls[1]![0]
  expect(submitted.materialEffects).toMatchObject({
    'warm-frosted-glass': { transparency: 0.41 }, 'clear-glass': { transparency: 0.22 },
  })
  persisted.arknote = { ...persisted.arknote, ...submitted }
  await act(async () => laterWrite.resolve({ ok: true, value: persisted.arknote }))
})

it('omits material recipes when the main preferences save an ordinary Arknote change', async () => {
  const { persisted, setArknotePreferences } = installPreferencesPersistenceApi()
  persisted.arknote.micaAppearance.tintOpacity = 0.5678
  render(<App />)
  await openPreferencesPage()
  fireEvent.click(screen.getByRole('checkbox', { name: '开机启动' }))
  await waitFor(() => expect(setArknotePreferences).toHaveBeenCalledOnce())
  const request = setArknotePreferences.mock.calls[0]![0]
  for (const key of ['micaAppearance', 'glassAppearances', 'materialEffects']) {
    expect(request).not.toHaveProperty(key)
  }
  expect(persisted.arknote.micaAppearance.tintOpacity).toBe(0.5678)
})

it('persists a browser search preference immediately without leaving Preferences', async () => {
  const setSearchPreferences = vi.fn(async (value) => ({ ok: true as const, value }))
  installApi({
    getSearchPreferences: vi.fn(async () => ({
      ok: true as const,
      value: { provider: 'bing' as const, customTemplate: '' },
    })),
    setSearchPreferences,
    getEditorAppearancePreferences: vi.fn(async () => ({
      ok: true as const,
      value: appearanceSnapshot(DEFAULT_EDITOR_APPEARANCE),
    })),
    getLargeModelSettings: vi.fn(async () => ({
      ok: true as const,
      value: DEFAULT_LARGE_MODEL_SETTINGS,
    })),
  })
  render(<App />)
  await waitFor(() => expect(menuCommand).not.toBeNull())
  act(() => menuCommand?.('preferences'))
  expect(await screen.findByRole('main', { name: '偏好设置' })).toBeVisible()

  choosePreferencesOption('搜索提供商', '百度（默认）')

  await waitFor(() => expect(setSearchPreferences).toHaveBeenCalledWith({
    provider: 'baidu', customTemplate: '',
  }))
  expect(screen.getByRole('main', { name: '偏好设置' })).toBeVisible()
})

it('applies and persists edited Preferences when returning and reopening', async () => {
  const { persisted } = installPreferencesPersistenceApi()
  render(<App />)
  await openPreferencesPage()

  choosePreferencesOption('搜索提供商', '百度（默认）')
  fireEvent.change(screen.getByLabelText('自定义主题颜色'), { target: { value: '#2563EB' } })
  choosePreferencesOption('正文英文', 'Calibri')
  fireEvent.change(screen.getByLabelText('最小边距'), { target: { value: '75' } })
  fireEvent.change(screen.getByLabelText('正文宽度'), { target: { value: '980' } })
  fireEvent.click(screen.getByRole('checkbox', { name: '保留单个换行' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '拼写检查' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '开机启动' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '在桌面右键菜单中增加“创建新便签”' }))

  expect(document.querySelector('.app-shell')).toHaveStyle({
    '--editor-minimum-margin': '75px',
    '--editor-maximum-width': '980px',
    '--theme-color-rgb': '37 99 235',
    '--body-latin-font': '"Calibri"',
  })
  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-spellcheck', 'true')
  await waitFor(() => {
    expect(persisted.search).toEqual({ provider: 'baidu', customTemplate: '' })
    expect(persisted.appearance.appearance).toMatchObject({
      themeColor: '#2563EB', bodyLatinFont: 'Calibri',
      minimumContentMarginPx: 75, maximumContentWidthPx: 980,
      preserveSingleLineBreaks: false, spellCheckEnabled: true,
    })
    expect(persisted.arknote).toMatchObject({
      launchAtLogin: true, registerDesktopContextMenu: true, themeColor: '#2563EB',
    })
  })
  expect(screen.getByRole('main', { name: '偏好设置' })).toBeVisible()
  expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument()
  expect(within(screen.getByLabelText('设置操作')).getByRole('button', { name: '关闭' })).toBeVisible()

  fireEvent.click(screen.getByRole('button', { name: '返回编辑器' }))
  expect(screen.queryByRole('main', { name: '偏好设置' })).not.toBeInTheDocument()
  expect(document.querySelector('.app-shell')).toHaveStyle({
    '--editor-minimum-margin': '75px', '--editor-maximum-width': '980px',
    '--theme-color-rgb': '37 99 235', '--body-latin-font': '"Calibri"',
  })
  await openPreferencesPage()

  expect(screen.getByRole('combobox', { name: '搜索提供商' })).toHaveTextContent('百度')
  expect(screen.getByLabelText('自定义主题颜色')).toHaveValue('#2563eb')
  expect(screen.getByRole('combobox', { name: '正文英文' })).toHaveTextContent('Calibri')
  expect(screen.getByLabelText('最小边距')).toHaveValue('75')
  expect(screen.getByLabelText('正文宽度')).toHaveValue('980')
  expect(screen.getByRole('checkbox', { name: '保留单个换行' })).not.toBeChecked()
  expect(screen.getByRole('checkbox', { name: '拼写检查' })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: '开机启动' })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: '在桌面右键菜单中增加“创建新便签”' })).toBeChecked()
})

it('opens the model manager for the owned screenshot translation settings command', async () => {
  installApi({
    getSearchPreferences: vi.fn(async () => ({
      ok: true as const,
      value: { provider: 'bing' as const, customTemplate: '' },
    })),
    getEditorAppearancePreferences: vi.fn(async () => ({
      ok: true as const,
      value: appearanceSnapshot(DEFAULT_EDITOR_APPEARANCE),
    })),
    getLargeModelSettings: vi.fn(async () => ({
      ok: true as const,
      value: DEFAULT_LARGE_MODEL_SETTINGS,
    })),
  })
  render(<App />)
  await waitFor(() => expect(menuCommand).not.toBeNull())
  act(() => menuCommand?.('screenshot-translation-settings'))
  expect(await screen.findByRole('main', { name: '偏好设置' })).toBeVisible()
  await waitFor(() => expect(preferencesPageBridge.initialTarget).toBe('large-model-manager'))
})

it('opens the large-model preferences section from an unconfigured translation', async () => {
  const requestFrame = vi.fn()
  vi.stubGlobal('requestAnimationFrame', requestFrame)
  installApi({
    getSearchPreferences: vi.fn(async () => ({
      ok: true as const,
      value: { provider: 'bing' as const, customTemplate: '' },
    })),
    getEditorAppearancePreferences: vi.fn(async () => ({
      ok: true as const,
      value: appearanceSnapshot({
        minimumContentMarginPx: 30,
        maximumContentWidthPx: 1200,
        preserveSingleLineBreaks: true,
        spellCheckEnabled: false,
        showEditIndicators: true,
        editorTheme: 'minimal',
        headingLatinFont: 'Arial',
        headingCjkFont: 'SimHei',
        bodyLatinFont: 'Arial',
        bodyCjkFont: 'SimHei',
        themeColor: '#2563EB',
        micaOpacityPercent: 0,
      }),
    })),
    getLargeModelSettings: vi.fn(async () => ({
      ok: true as const,
      value: DEFAULT_LARGE_MODEL_SETTINGS,
    })),
  })
  render(<App />)

  try {
    fireEvent.click(screen.getByRole('button', { name: '翻译' }))
    fireEvent.click(screen.getByRole('button', { name: '前往设置' }))

    const heading = await screen.findByRole('heading', { name: '大模型设置' })
    expect(heading).toBeVisible()
    expect(screen.getByRole('button', { name: '管理大模型' })).toBeVisible()
    await waitFor(() => expect(requestFrame).toHaveBeenCalledOnce())
    const viewport = screen.getByRole('region', { name: '设置内容' })
    Object.defineProperty(viewport, 'scrollTo', { configurable: true, value: vi.fn() })
    const frame = requestFrame.mock.calls[0]?.[0] as FrameRequestCallback | undefined
    act(() => frame?.(0))
    expect(document.activeElement).toBe(heading)

    fireEvent.click(screen.getByRole('button', { name: '返回编辑器' }))
    await waitFor(() => expect(screen.queryByRole('main', { name: '偏好设置' })).not.toBeInTheDocument())
    requestFrame.mockClear()
    await waitFor(() => expect(menuCommand).not.toBeNull())
    menuCommand?.('preferences')

    expect(await screen.findByRole('main', { name: '偏好设置' })).toBeVisible()
    expect(requestFrame).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
})

it('ignores a stale preferences open after a later normal open wins', async () => {
  let resolveFirstSearch: ((value: { ok: true, value: { provider: 'bing', customTemplate: '' } }) => void) | undefined
  let resolveSecondSearch: ((value: { ok: true, value: { provider: 'bing', customTemplate: '' } }) => void) | undefined
  const firstSearch = new Promise<{ ok: true, value: { provider: 'bing', customTemplate: '' } }>((resolve) => {
    resolveFirstSearch = resolve
  })
  const secondSearch = new Promise<{ ok: true, value: { provider: 'bing', customTemplate: '' } }>((resolve) => {
    resolveSecondSearch = resolve
  })
  const purpleAppearance = {
    minimumContentMarginPx: 30,
    maximumContentWidthPx: 1200,
    preserveSingleLineBreaks: true,
    spellCheckEnabled: false,
    showEditIndicators: true,
    editorTheme: 'minimal' as const,
    headingLatinFont: 'Arial',
    headingCjkFont: 'SimHei',
    bodyLatinFont: 'Arial',
    bodyCjkFont: 'SimHei',
    themeColor: '#800080',
    micaOpacityPercent: 0 as const,
  }
  const blueAppearance = { ...purpleAppearance, themeColor: '#2563EB' }
  const appearances = [purpleAppearance, blueAppearance]
  let activeOpen = -1
  installApi({
    getSearchPreferences: vi.fn(() => {
      activeOpen += 1
      return activeOpen === 0 ? firstSearch : secondSearch
    }),
    getEditorAppearancePreferences: vi.fn(() => Promise.resolve({
      ok: true as const,
      value: appearanceSnapshot(
        activeOpen < 0 ? blueAppearance : appearances[activeOpen]!,
        activeOpen < 0 ? 2 : activeOpen + 1,
      ),
    })),
    getLargeModelSettings: vi.fn(() => Promise.resolve({
      ok: true as const,
      value: DEFAULT_LARGE_MODEL_SETTINGS,
    })),
  })
  render(<App />)
  await waitFor(() => expect(menuCommand).not.toBeNull())

  fireEvent.click(screen.getByRole('button', { name: '翻译' }))
  fireEvent.click(screen.getByRole('button', { name: '前往设置' }))
  await waitFor(() => expect(window.arkdown.getSearchPreferences).toHaveBeenCalledOnce())
  act(() => menuCommand?.('preferences'))
  await waitFor(() => expect(window.arkdown.getSearchPreferences).toHaveBeenCalledTimes(2))
  resolveSecondSearch?.({ ok: true, value: { provider: 'bing', customTemplate: '' } })

  expect(await screen.findByRole('main', { name: '偏好设置' })).toBeVisible()
  expect(document.querySelector('.app-shell')).toHaveStyle({ '--theme-color-rgb': '37 99 235' })

  resolveFirstSearch?.({ ok: true, value: { provider: 'bing', customTemplate: '' } })
  await act(async () => {})

  expect(document.querySelector('.app-shell')).toHaveStyle({ '--theme-color-rgb': '37 99 235' })
})

it('opens preferences with a newer accepted appearance when an unrelated read delays the stale snapshot', async () => {
  const delayedSearch = deferred<ApiResult<{ provider: 'bing', customTemplate: '' }>>()
  const staleAppearance = {
    ...DEFAULT_EDITOR_APPEARANCE,
    themeColor: '#800080',
    spellCheckEnabled: false,
  }
  const acceptedAppearance = {
    ...staleAppearance,
    themeColor: '#2563EB',
    spellCheckEnabled: true,
  }
  installApi({
    getSearchPreferences: vi.fn(() => delayedSearch.promise),
    getEditorAppearancePreferences: vi.fn(async () => ({
      ok: true as const,
      value: appearanceSnapshot(staleAppearance),
    })),
    getLargeModelSettings: vi.fn(async () => ({
      ok: true as const,
      value: DEFAULT_LARGE_MODEL_SETTINGS,
    })),
  })
  render(<App />)
  await waitFor(() => expect(menuCommand).not.toBeNull())

  act(() => menuCommand?.('preferences'))
  await waitFor(() => expect(window.arkdown.getSearchPreferences).toHaveBeenCalledOnce())
  await act(async () => editorAppearanceChanged?.(appearanceSnapshot(acceptedAppearance, 1)))
  delayedSearch.resolve({
    ok: true,
    value: { provider: 'bing', customTemplate: '' },
  })

  await waitFor(() => expect(document.querySelector('.preferences-page')).toBeVisible())
  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-spellcheck', 'true')
  expect(document.querySelector('#preferences-spell-check input')).toBeChecked()
  expect(document.querySelector('.app-shell')).toHaveStyle({ '--theme-color-rgb': '37 99 235' })
})

it('does not replace a saved preference or its rollback baseline with a delayed replacement read', async () => {
  const delayedModels = deferred<ApiResult<typeof DEFAULT_LARGE_MODEL_SETTINGS>>()
  const { persisted, getSearchPreferences, setSearchPreferences } = installPreferencesPersistenceApi()
  render(<App />)
  await openPreferencesPage()
  vi.mocked(window.arkdown.getLargeModelSettings).mockReturnValueOnce(delayedModels.promise)

  act(() => menuCommand?.('preferences'))
  await waitFor(() => expect(getSearchPreferences).toHaveBeenCalledTimes(2))
  choosePreferencesOption('搜索提供商', '百度（默认）')
  await waitFor(() => expect(persisted.search).toEqual({ provider: 'baidu', customTemplate: '' }))
  await act(async () => {})
  await act(async () => delayedModels.resolve({ ok: true, value: DEFAULT_LARGE_MODEL_SETTINGS }))

  expect(screen.getByRole('combobox', { name: '搜索提供商' })).toHaveTextContent('百度')
  setSearchPreferences.mockResolvedValueOnce({
    ok: false, error: { code: 'OPERATION_FAILED', message: 'later search write failed' },
  })
  choosePreferencesOption('搜索提供商', 'Google')
  await waitFor(() => {
    expect(within(screen.getByRole('main', { name: '偏好设置' })).getByRole('alert'))
      .toHaveTextContent('later search write failed')
    expect(screen.getByRole('combobox', { name: '搜索提供商' })).toHaveTextContent('Google')
  })
  expect(persisted.search).toEqual({ provider: 'baidu', customTemplate: '' })
})

it('keeps the displayed Preferences usable when a replacement read fails', async () => {
  const { getSearchPreferences, setSearchPreferences } = installPreferencesPersistenceApi()
  render(<App />)
  await openPreferencesPage()
  getSearchPreferences.mockResolvedValueOnce({
    ok: false, error: { code: 'OPERATION_FAILED', message: 'replacement read failed' },
  })

  act(() => menuCommand?.('preferences'))
  await waitFor(() => expect(document.querySelector('.document-error-notice'))
    .toHaveTextContent('replacement read failed'))
  choosePreferencesOption('搜索提供商', '百度（默认）')

  await waitFor(() => expect(setSearchPreferences).toHaveBeenCalledWith({
    provider: 'baidu', customTemplate: '',
  }))
  expect(screen.getByRole('main', { name: '偏好设置' })).toBeVisible()
  expect(screen.getByRole('button', { name: '返回编辑器' })).toBeEnabled()
})

it('retains the failed setting and allows another explicit edit when Preferences transport rejects', async () => {
  const { setSearchPreferences, persisted } = installPreferencesPersistenceApi()
  setSearchPreferences.mockRejectedValueOnce(new Error('transport rejected'))
  render(<App />)
  await openPreferencesPage()

  choosePreferencesOption('搜索提供商', '百度（默认）')

  await waitFor(() => {
    expect(within(screen.getByRole('main', { name: '偏好设置' })).getByRole('alert'))
      .toHaveTextContent('操作未能完成')
    expect(screen.getByRole('combobox', { name: '搜索提供商' })).toHaveTextContent('百度')
  })
  expect(screen.getByRole('button', { name: '返回编辑器' })).toBeEnabled()
  choosePreferencesOption('搜索提供商', 'Google')
  await waitFor(() => expect(persisted.search).toEqual({
    provider: 'google', customTemplate: '',
  }))
  expect(within(screen.getByRole('main', { name: '偏好设置' })).queryByRole('alert')).not.toBeInTheDocument()
})

it('serializes rapid appearance edits and retains an A to B to A change while saving', async () => {
  const firstWrite = deferred<void>()
  const { patch } = installObservedPreferences()
  let saved = observedAppearance()
  patch.mockImplementation(async input => {
    if (input.observed.group !== 'appearance') throw new Error('unexpected group')
    if (patch.mock.calls.length === 1) await firstWrite.promise
    saved = { ...saved, values: { ...saved.values, ...input.changes },
      observation: { ...saved.observation, revision: saved.observation.revision + 1 } }
    return { ok: true, value: { status: 'committed', snapshot: structuredClone(saved) } }
  })
  render(<App />)
  await openPreferencesPage()
  fireEvent.change(screen.getByLabelText('正文宽度'), { target: { value: '980' } })
  await waitFor(() => expect(patch).toHaveBeenCalledOnce())
  fireEvent.change(screen.getByLabelText('正文宽度'), { target: { value: '900' } })
  fireEvent.change(screen.getByLabelText('最小边距'), { target: { value: '75' } })
  choosePreferencesOption('正文英文', 'Calibri')
  fireEvent.change(screen.getByLabelText('正文宽度'), { target: { value: '800' } })
  expect(patch).toHaveBeenCalledOnce()
  expect(document.querySelector('.app-shell')).toHaveStyle({
    '--editor-maximum-width': '800px', '--editor-minimum-margin': '75px', '--body-latin-font': '"Calibri"',
  })
  await act(async () => firstWrite.resolve())
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(3))
  expect(patch.mock.calls[1]![0]).toMatchObject({ observed: { observation: { revision: 2 } }, changes: { maximumContentWidthPx: 800 } })
  expect(patch.mock.calls[2]![0]).toEqual({ observed: observedAppearance(), changes: { minimumContentMarginPx: 75, bodyLatinFont: 'Calibri' } })
  expect(saved.values).toMatchObject({ maximumContentWidthPx: 800, minimumContentMarginPx: 75, bodyLatinFont: 'Calibri' })
  fireEvent.click(screen.getByRole('button', { name: '返回编辑器' }))
  await openPreferencesPage()
  expect(screen.getByLabelText('正文宽度')).toHaveValue('800')
  expect(screen.getByLabelText('最小边距')).toHaveValue('75')
  expect(screen.getByRole('combobox', { name: '正文英文' })).toHaveTextContent('Calibri')
  expect(patch).toHaveBeenCalledTimes(3)
})

it('returns during a pending preference write and reopens the latest requested target after persistence', async () => {
  const pending = deferred<ApiResult<EditorAppearanceSnapshot>>()
  const { persisted, compareAndSetEditorAppearancePreferences: write, getSearchPreferences } =
    installPreferencesPersistenceApi()
  write.mockImplementationOnce(() => pending.promise)
  render(<App />)
  await openPreferencesPage()
  fireEvent.change(screen.getByLabelText('正文宽度'), { target: { value: '980' } })
  await waitFor(() => expect(write).toHaveBeenCalledOnce())

  fireEvent.click(screen.getByRole('button', { name: '返回编辑器' }))
  expect(screen.queryByRole('main', { name: '偏好设置' })).not.toBeInTheDocument()
  expect(document.querySelector('.app-shell')).toHaveStyle({ '--editor-maximum-width': '980px' })
  act(() => menuCommand?.('preferences'))
  act(() => menuCommand?.('screenshot-translation-settings'))
  expect(getSearchPreferences).toHaveBeenCalledOnce()

  persisted.appearance = appearanceSnapshot(write.mock.calls[0]![2], 1)
  await act(async () => pending.resolve({ ok: true, value: persisted.appearance }))
  expect(await screen.findByRole('main', { name: '偏好设置' })).toBeVisible()
  await waitFor(() => expect(preferencesPageBridge.initialTarget).toBe('large-model-manager'))
  expect(getSearchPreferences).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: '返回偏好设置' }))
  expect(screen.getByLabelText('正文宽度')).toHaveValue('980')
})

it('restores only failed Arknote settings without undoing saved search and appearance', async () => {
  const pending = deferred<ApiResult<typeof DEFAULT_ARKNOTE_PREFERENCES>>()
  const { persisted, setArknotePreferences, setSearchPreferences, compareAndSetEditorAppearancePreferences } =
    installPreferencesPersistenceApi()
  setArknotePreferences.mockImplementationOnce(() => pending.promise)
  render(<App />)
  await openPreferencesPage()
  choosePreferencesOption('搜索提供商', '百度（默认）')
  fireEvent.change(screen.getByLabelText('正文宽度'), { target: { value: '980' } })
  fireEvent.click(screen.getByRole('checkbox', { name: '开机启动' }))
  await waitFor(() => {
    expect(persisted.search.provider).toBe('baidu')
    expect(persisted.appearance.appearance.maximumContentWidthPx).toBe(980)
    expect(setArknotePreferences).toHaveBeenCalledOnce()
  })

  await act(async () => pending.resolve({
    ok: false, error: { code: 'OPERATION_FAILED', message: 'Arknote save failed' },
  }))

  expect(within(screen.getByRole('main', { name: '偏好设置' })).getByRole('alert')).toHaveTextContent('Arknote save failed')
  expect(screen.getByRole('checkbox', { name: '开机启动' })).not.toBeChecked()
  expect(screen.getByRole('combobox', { name: '搜索提供商' })).toHaveTextContent('百度')
  expect(screen.getByLabelText('正文宽度')).toHaveValue('980')
  expect(document.querySelector('.app-shell')).toHaveStyle({ '--editor-maximum-width': '980px' })
  expect(setSearchPreferences).toHaveBeenCalledOnce()
  expect(compareAndSetEditorAppearancePreferences).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('checkbox', { name: '开机启动' }))
  await waitFor(() => expect(persisted.arknote.launchAtLogin).toBe(true))
  expect(within(screen.getByRole('main', { name: '偏好设置' })).queryByRole('alert')).not.toBeInTheDocument()
})

it('retains failed appearance drafts while other categories persist', async () => {
  const pending = deferred<ApiResult<EditorAppearanceSnapshot>>()
  const { persisted, compareAndSetEditorAppearancePreferences: write } = installPreferencesPersistenceApi()
  write.mockImplementationOnce(() => pending.promise)
  render(<App />)
  await openPreferencesPage()
  fireEvent.change(screen.getByLabelText('正文宽度'), { target: { value: '980' } })
  choosePreferencesOption('搜索提供商', '百度（默认）')
  fireEvent.click(screen.getByRole('checkbox', { name: '开机启动' }))
  expect(screen.getByRole('checkbox', { name: '开机启动' })).toBeChecked()
  await waitFor(() => expect(write).toHaveBeenCalledOnce())

  await act(async () => pending.resolve({
    ok: false, error: { code: 'OPERATION_FAILED', message: 'Appearance save failed' },
  }))

  await waitFor(() => {
    expect(persisted.search.provider).toBe('baidu')
    expect(persisted.arknote.launchAtLogin).toBe(true)
  })
  expect(within(screen.getByRole('main', { name: '偏好设置' })).getByRole('alert')).toHaveTextContent('Appearance save failed')
  expect(screen.getByLabelText('正文宽度')).toHaveValue('980')
  expect(document.querySelector('.app-shell')).toHaveStyle({ '--editor-maximum-width': '980px' })
  expect(screen.getByRole('combobox', { name: '搜索提供商' })).toHaveTextContent('百度')
  expect(screen.getByRole('checkbox', { name: '开机启动' })).toBeChecked()
})

it('retains the later failed search draft without replacing its confirmed baseline', async () => {
  const { setSearchPreferences } = installPreferencesPersistenceApi()
  render(<App />)
  await openPreferencesPage()
  choosePreferencesOption('搜索提供商', '百度（默认）')
  await waitFor(() => expect(setSearchPreferences).toHaveBeenCalledOnce())
  await act(async () => {})
  setSearchPreferences.mockResolvedValueOnce({
    ok: false, error: { code: 'OPERATION_FAILED', message: 'later write failed' },
  })

  choosePreferencesOption('搜索提供商', 'Google')

  await waitFor(() => {
    expect(within(screen.getByRole('main', { name: '偏好设置' })).getByRole('alert'))
      .toHaveTextContent('later write failed')
    expect(screen.getByRole('combobox', { name: '搜索提供商' })).toHaveTextContent('Google')
  })
  expect(setSearchPreferences).toHaveBeenCalledTimes(2)
})

it('preserves newer pending appearance edits after an earlier write fails', async () => {
  const pending = deferred<ApiResult<EditorAppearanceSnapshot>>()
  const { persisted, compareAndSetEditorAppearancePreferences: write } = installPreferencesPersistenceApi()
  write.mockImplementationOnce(() => pending.promise)
  render(<App />)
  await openPreferencesPage()
  fireEvent.change(screen.getByLabelText('正文宽度'), { target: { value: '980' } })
  await waitFor(() => expect(write).toHaveBeenCalledOnce())
  fireEvent.change(screen.getByLabelText('最小边距'), { target: { value: '75' } })

  await act(async () => pending.resolve({
    ok: false, error: { code: 'OPERATION_FAILED', message: 'first appearance write failed' },
  }))

  await waitFor(() => expect(persisted.appearance.appearance).toMatchObject({
    maximumContentWidthPx: 1200, minimumContentMarginPx: 75,
  }))
  expect(write).toHaveBeenCalledTimes(2)
  expect(write.mock.calls[1]![2]).toMatchObject({
    maximumContentWidthPx: 1200, minimumContentMarginPx: 75,
  })
  expect(screen.getByLabelText('正文宽度')).toHaveValue('980')
  expect(screen.getByLabelText('最小边距')).toHaveValue('75')
})

it('does not overwrite a newer cross-window appearance with a delayed successful reply', async () => {
  const pending = deferred<ApiResult<EditorAppearanceSnapshot>>()
  const { persisted, compareAndSetEditorAppearancePreferences: write } = installPreferencesPersistenceApi()
  write.mockImplementationOnce(() => pending.promise)
  render(<App />)
  await openPreferencesPage()
  fireEvent.click(screen.getByRole('checkbox', { name: '拼写检查' }))
  await waitFor(() => expect(write).toHaveBeenCalledOnce())
  const localReply = appearanceSnapshot(write.mock.calls[0]![2], 1)
  persisted.appearance = appearanceSnapshot({
    ...persisted.appearance.appearance, themeColor: '#2563EB', spellCheckEnabled: false,
  }, 2)
  await act(async () => editorAppearanceChanged?.(persisted.appearance))

  await act(async () => pending.resolve({ ok: true, value: localReply }))

  expect(document.querySelector('.app-shell')).toHaveStyle({ '--theme-color-rgb': '37 99 235' })
  expect(screen.getByRole('checkbox', { name: '拼写检查' })).not.toBeChecked()
  expect(screen.getByRole('textbox', { name: 'Markdown editor' }))
    .toHaveAttribute('data-spellcheck', 'false')
  expect(write).toHaveBeenCalledOnce()
  expect(screen.getByRole('main', { name: '偏好设置' })).toBeVisible()
})

it('merges a newer remote appearance while retaining the failed local field', async () => {
  const pending = deferred<ApiResult<EditorAppearanceSnapshot>>()
  const { persisted, compareAndSetEditorAppearancePreferences: write } = installPreferencesPersistenceApi()
  write.mockImplementationOnce(() => pending.promise)
  render(<App />)
  await openPreferencesPage()
  fireEvent.change(screen.getByLabelText('正文宽度'), { target: { value: '980' } })
  await waitFor(() => expect(write).toHaveBeenCalledOnce())
  persisted.appearance = appearanceSnapshot({
    ...persisted.appearance.appearance, themeColor: '#2563EB', maximumContentWidthPx: 900,
  }, 2)
  await act(async () => editorAppearanceChanged?.(persisted.appearance))

  await act(async () => pending.resolve({
    ok: false, error: { code: 'OPERATION_FAILED', message: 'local write failed' },
  }))

  expect(within(screen.getByRole('main', { name: '偏好设置' })).getByRole('alert')).toHaveTextContent('local write failed')
  expect(document.querySelector('.app-shell')).toHaveStyle({
    '--theme-color-rgb': '37 99 235', '--editor-maximum-width': '980px',
  })
  expect(screen.getByLabelText('正文宽度')).toHaveValue('980')
  expect(write).toHaveBeenCalledOnce()
})

it('retains a conflicting appearance field and adopts unrelated remote fields without retry', async () => {
  const { persisted, compareAndSetEditorAppearancePreferences: write } = installPreferencesPersistenceApi()
  write.mockImplementationOnce(async () => {
    persisted.appearance = appearanceSnapshot({
      ...persisted.appearance.appearance, themeColor: '#2563EB', minimumContentMarginPx: 60,
    }, 2)
    return { ok: true, value: persisted.appearance }
  })
  render(<App />)
  await openPreferencesPage()

  fireEvent.change(screen.getByLabelText('正文宽度'), { target: { value: '980' } })

  await waitFor(() => expect(persisted.appearance.appearance).toMatchObject({
    maximumContentWidthPx: 1200, minimumContentMarginPx: 60, themeColor: '#2563EB',
  }))
  expect(write).toHaveBeenCalledOnce()
  expect(within(screen.getByRole('main', { name: '偏好设置' })).getByRole('alert')).toHaveTextContent('其他窗口')
  expect(document.querySelector('.app-shell')).toHaveStyle({
    '--editor-maximum-width': '980px', '--editor-minimum-margin': '60px',
    '--theme-color-rgb': '37 99 235',
  })
})

it('does not expose old preference write failures or queued opens after a workspace remount', async () => {
  const pending = deferred<ApiResult<typeof DEFAULT_ARKNOTE_PREFERENCES>>()
  const { setArknotePreferences, getSearchPreferences } = installPreferencesPersistenceApi({
    chooseWorkspace: vi.fn(async () => ({
      ok: true as const, value: { name: 'Other', absolutePath: 'C:/Other' },
    })),
  })
  setArknotePreferences.mockImplementationOnce(() => pending.promise)
  render(<App />)
  await openPreferencesPage()
  fireEvent.click(screen.getByRole('checkbox', { name: '开机启动' }))
  await waitFor(() => expect(setArknotePreferences).toHaveBeenCalledOnce())
  act(() => menuCommand?.('preferences'))

  act(() => menuCommand?.('open-workspace'))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Other' })).toBeVisible())
  expect(screen.queryByRole('main', { name: '偏好设置' })).not.toBeInTheDocument()
  await act(async () => pending.resolve({
    ok: false, error: { code: 'OPERATION_FAILED', message: 'old workspace save failed' },
  }))

  expect(getSearchPreferences).toHaveBeenCalledOnce()
  expect(screen.queryByRole('main', { name: '偏好设置' })).not.toBeInTheDocument()
  expect(document.querySelector('.editor-host')).not.toHaveTextContent('old workspace save failed')
  expect(screen.getByRole('button', { name: 'Other' })).toBeVisible()
})

it.each(['preferences read', 'document close'] as const)(
  'waits for the old preference queue before %s after a workspace remount',
  async (boundary) => {
    const pendingArknote = deferred<ApiResult<typeof DEFAULT_ARKNOTE_PREFERENCES>>()
    const { persisted, setArknotePreferences, getSearchPreferences } = installPreferencesPersistenceApi({
      chooseWorkspace: vi.fn(async () => ({
        ok: true as const, value: { name: 'Other', absolutePath: 'C:/Other' },
      })),
    })
    setArknotePreferences.mockImplementationOnce(() => pendingArknote.promise)
    render(<App />)
    await openPreferencesPage()
    fireEvent.click(screen.getByRole('checkbox', { name: '开机启动' }))
    await waitFor(() => expect(setArknotePreferences).toHaveBeenCalledOnce())
    choosePreferencesOption('搜索提供商', '百度（默认）')
    fireEvent.change(screen.getByLabelText('正文宽度'), { target: { value: '980' } })
    act(() => menuCommand?.('open-workspace'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Other' })).toBeVisible())
    expect(screen.queryByRole('main', { name: '偏好设置' })).not.toBeInTheDocument()

    let closeResult: boolean | undefined
    let closePromise: Promise<boolean> | undefined
    if (boundary === 'preferences read') {
      await act(async () => menuCommand?.('preferences'))
      expect(getSearchPreferences).toHaveBeenCalledOnce()
      expect(screen.queryByRole('main', { name: '偏好设置' })).not.toBeInTheDocument()
    } else {
      await act(async () => {
        closePromise = prepareClose().then((result) => {
          closeResult = result
          return result
        })
      })
      expect(closeResult).toBeUndefined()
    }

    persisted.arknote = { ...persisted.arknote, ...setArknotePreferences.mock.calls[0]![0] }
    await act(async () => pendingArknote.resolve({ ok: true, value: persisted.arknote }))
    await waitFor(() => {
      expect(persisted.search).toEqual({ provider: 'baidu', customTemplate: '' })
      expect(persisted.appearance.appearance.maximumContentWidthPx).toBe(980)
    })
    if (boundary === 'preferences read') {
      expect(await screen.findByRole('main', { name: '偏好设置' })).toBeVisible()
      expect(screen.getByRole('combobox', { name: '搜索提供商' })).toHaveTextContent('百度')
      expect(screen.getByLabelText('正文宽度')).toHaveValue('980')
    } else {
      await expect(closePromise).resolves.toBe(true)
    }
  },
)

it.each(['same shell', 'replacement shell'] as const)('blocks close after a settled preference failure in the %s until that category succeeds', async shell => {
  const { setArknotePreferences } = installPreferencesPersistenceApi({
    chooseWorkspace: vi.fn(async () => ({ ok: true as const, value: { name: 'Other', absolutePath: 'C:/Other' } })),
  })
  setArknotePreferences.mockImplementationOnce(async () => ({ ok: false, error: { code: 'OPERATION_FAILED', message: 'preference failed' } }))
  render(<App />)
  await openPreferencesPage()
  fireEvent.click(screen.getByRole('checkbox', { name: '开机启动' }))
  await waitFor(() => expect(within(screen.getByRole('main', { name: '偏好设置' })).getByRole('alert')).toHaveTextContent('preference failed'))
  if (shell === 'replacement shell') {
    act(() => menuCommand?.('open-workspace'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Other' })).toBeVisible())
  } else fireEvent.click(screen.getByRole('button', { name: '返回编辑器' }))
  await act(async () => { expect(await prepareClose()).toBe(false) })
  await openPreferencesPage()
  choosePreferencesOption('搜索提供商', '百度（默认）')
  await waitFor(() => expect(screen.getByRole('combobox', { name: '搜索提供商' })).toHaveTextContent('百度'))
  fireEvent.click(screen.getByRole('button', { name: '返回编辑器' }))
  await act(async () => { expect(await prepareClose()).toBe(false) })
  await openPreferencesPage()
  fireEvent.click(screen.getByRole('checkbox', { name: '开机启动' }))
  await waitFor(() => expect(setArknotePreferences).toHaveBeenCalledTimes(2))
  fireEvent.click(screen.getByRole('button', { name: '返回编辑器' }))
  await act(async () => { expect(await prepareClose()).toBe(true) })
})

it('keeps the failed category message visible while its explicit retry is pending', async () => {
  const retry = deferred<ApiResult<typeof DEFAULT_ARKNOTE_PREFERENCES>>()
  const { setArknotePreferences } = installPreferencesPersistenceApi()
  setArknotePreferences.mockImplementationOnce(async () => ({ ok: false, error: { code: 'OPERATION_FAILED', message: 'preference failed' } }))
    .mockImplementationOnce(() => retry.promise)
  render(<App />)
  await openPreferencesPage()
  fireEvent.click(screen.getByRole('checkbox', { name: '开机启动' }))
  await waitFor(() => expect(within(screen.getByRole('main', { name: '偏好设置' })).getByRole('alert')).toHaveTextContent('preference failed'))
  fireEvent.click(screen.getByRole('checkbox', { name: '开机启动' }))
  await waitFor(() => expect(setArknotePreferences).toHaveBeenCalledTimes(2))
  expect(within(screen.getByRole('main', { name: '偏好设置' })).getByRole('alert')).toHaveTextContent('preference failed')
  await act(async () => retry.resolve({ ok: true, value: { ...DEFAULT_ARKNOTE_PREFERENCES, launchAtLogin: true } }))
  await waitFor(() => expect(within(screen.getByRole('main', { name: '偏好设置' })).queryByRole('alert')).not.toBeInTheDocument())
})

it('does not persist an invalid custom search draft and keeps the last valid provider', async () => {
  const { persisted, setSearchPreferences } = installPreferencesPersistenceApi()
  render(<App />)
  await openPreferencesPage()
  choosePreferencesOption('搜索提供商', '自定义')
  fireEvent.change(screen.getByRole('textbox', { name: '自定义搜索地址' }), {
    target: { value: 'http://example.com/search?q={query}' },
  })
  await act(async () => {})
  expect(within(screen.getByRole('main', { name: '偏好设置' })).getByRole('alert')).toBeVisible()
  expect(setSearchPreferences).not.toHaveBeenCalled()
  expect(persisted.search).toEqual({ provider: 'bing', customTemplate: '' })

  fireEvent.change(screen.getByRole('textbox', { name: '自定义搜索地址' }), {
    target: { value: 'https://example.com/search?q={query}' },
  })
  await waitFor(() => expect(persisted.search).toEqual({
    provider: 'custom', customTemplate: 'https://example.com/search?q={query}',
  }))
  fireEvent.change(screen.getByRole('textbox', { name: '自定义搜索地址' }), {
    target: { value: 'https://example.com/search' },
  })
  fireEvent.click(screen.getByRole('button', { name: '返回编辑器' }))
  await openPreferencesPage()

  expect(screen.getByRole('textbox', { name: '自定义搜索地址' }))
    .toHaveValue('https://example.com/search?q={query}')
  expect(setSearchPreferences).toHaveBeenCalledOnce()
})

it('blocks preferences when large-model settings cannot be loaded', async () => {
  const getSearchPreferences = vi.fn(async () => ({
    ok: true as const,
    value: { provider: 'bing' as const, customTemplate: '' },
  }))
  const getEditorAppearancePreferences = vi.fn(async () => ({
    ok: true as const,
    value: appearanceSnapshot({
      minimumContentMarginPx: 30,
      maximumContentWidthPx: 1200,
      preserveSingleLineBreaks: true,
      spellCheckEnabled: false,
      showEditIndicators: true,
      editorTheme: 'minimal',
      headingLatinFont: 'Arial',
      headingCjkFont: 'SimHei',
      bodyLatinFont: 'Arial',
      bodyCjkFont: 'SimHei',
      themeColor: '#2563EB',
      micaOpacityPercent: 0,
    }),
  }))
  const getLargeModelSettings = vi.fn(modelApiFailure)
  installApi({
    getSearchPreferences,
    getEditorAppearancePreferences,
    getLargeModelSettings,
  })
  render(<App />)
  await waitFor(() => expect(menuCommand).not.toBeNull())

  menuCommand?.('preferences')
  await waitFor(() => expect(getLargeModelSettings).toHaveBeenCalledOnce())
  expect(screen.queryByRole('main', { name: '偏好设置' })).not.toBeInTheDocument()
  expect(document.querySelector('.document-error-notice')).toHaveTextContent('操作未能完成')
})

it('keeps Mica renderer tint fixed and retains the persisted theme when returning', async () => {
  const { persisted } = installPreferencesPersistenceApi()
  render(<App />)
  await openPreferencesPage()
  expect(screen.queryByLabelText('Mica不透明度')).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('自定义主题颜色'), { target: { value: '#2563EB' } })
  await waitFor(() => expect(persisted.appearance.appearance.themeColor).toBe('#2563EB'))

  fireEvent.click(screen.getByRole('button', { name: '返回编辑器' }))

  expect(screen.queryByRole('main', { name: '偏好设置' })).not.toBeInTheDocument()
  expect(document.querySelector<HTMLElement>('.app-shell')?.style
    .getPropertyValue('--mica-shell-opacity')).toBe('')
  expect(document.querySelector('.app-shell')).toHaveStyle({ '--theme-color-rgb': '37 99 235' })
  expect(window.arkdown.previewArknoteThemeColor).toHaveBeenLastCalledWith('#2563EB')
})

it('returns from Preferences before document close without reverting a pending change', async () => {
  const pending = deferred<ApiResult<EditorAppearanceSnapshot>>()
  const { persisted, compareAndSetEditorAppearancePreferences: write } = installPreferencesPersistenceApi()
  write.mockImplementationOnce(() => pending.promise)
  render(<App />)
  await openPreferencesPage()
  fireEvent.change(screen.getByLabelText('正文宽度'), { target: { value: '980' } })
  await waitFor(() => expect(write).toHaveBeenCalledOnce())

  await act(async () => { expect(await prepareClose()).toBe(false) })

  expect(screen.queryByRole('main', { name: '偏好设置' })).not.toBeInTheDocument()
  expect(document.querySelector('.app-shell')).toHaveStyle({ '--editor-maximum-width': '980px' })
  expect(screen.queryByRole('dialog', { name: /是否保存对/u })).not.toBeInTheDocument()
  persisted.appearance = appearanceSnapshot(write.mock.calls[0]![2], 1)
  await act(async () => pending.resolve({ ok: true, value: persisted.appearance }))
  await expect(prepareClose()).resolves.toBe(true)
  expect(document.querySelector('.app-shell')).toHaveStyle({ '--editor-maximum-width': '980px' })
  expect(write).toHaveBeenCalledOnce()
})

it('reveals and centers the saved file after Save As switches to a new workspace', async () => {
  const user = userEvent.setup()
  const target = { name: 'Other', absolutePath: 'D:/Other' }
  const saved = committedSaveAs(target, true)
  saved.document.relativePath = 'drafts/saved.md'
  const scrollTargets: Element[] = []
  const priorScroll = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = function (options) {
    if (typeof options === 'object' && options.block === 'center') scrollTargets.push(this)
  }
  let committed = false
  installApi({ ...twoPhaseSaveAsApi(saved),
    commitSaveDocumentAs: vi.fn(async () => { committed = true; return { ok: true as const, value: saved } }),
    listDirectory: vi.fn(async (relativePath: string) => ({ ok: true as const, value: committed
      ? relativePath === 'drafts' ? [{ name: 'saved.md', relativePath: 'drafts/saved.md', kind: 'document' as const }]
        : [{ name: 'drafts', relativePath: 'drafts', kind: 'directory' as const }]
      : [{ name: 'note.md', relativePath: 'note.md', kind: 'document' as const }] })),
  })
  try {
    render(<App />)
    await user.click(screen.getByRole('button', { name: '选择工作区' }))
    await user.click(await screen.findByRole('button', { name: 'note.md' }))
    act(() => menuCommand?.('save-as'))
    await screen.findByRole('button', { name: 'Other' })
    const row = await screen.findByRole('button', { name: 'saved.md' })
    await waitFor(() => expect(scrollTargets).toContain(row))
    expect(row).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'drafts' })).toHaveAttribute('aria-expanded', 'true')
  } finally { HTMLElement.prototype.scrollIntoView = priorScroll }
})

it('T03 external preferences: retains a failed shell choice across page remount and blocks close until explicit reload', async () => {
  installPreferencesPersistenceApi()
  const observed = { values: { documentOpenMenu: false, markdownShellNew: false }, unavailable: [],
    observation: { version: 1 as const, revision: 3, minimumBaseRevision: 0, fields: { documentOpenMenu: 3 } } }
  const read = vi.fn(async () => ({ ok: true as const, value: structuredClone(observed) }))
  const write = vi.fn<NonNullable<ArkdownApi['updateShellIntegrationPreference']>>(async () =>
    ({ ok: false, error: { code: 'SHELL_INTEGRATION_CONFLICT', message: 'shell choice conflicted' } }))
  window.arkdown.getShellIntegrationPreferences = read
  window.arkdown.updateShellIntegrationPreference = write
  render(<App />)
  await openPreferencesPage()
  const label = 'md/txt文档上右键增加“使用Arkdown打开”'
  await waitFor(() => expect(screen.getByRole('checkbox', { name: label })).toBeEnabled())
  fireEvent.click(screen.getByRole('checkbox', { name: label }))
  await screen.findByText('shell choice conflicted')
  fireEvent.click(screen.getByRole('button', { name: '返回编辑器' }))
  await act(async () => { expect(await prepareClose()).toBe(false) })
  observed.observation.revision = 8
  observed.observation.fields.documentOpenMenu = 8
  await openPreferencesPage()
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  expect(screen.getByRole('checkbox', { name: label })).toBeChecked()
  expect(write.mock.calls[0]?.[0].observed.observation.revision).toBe(3)
  fireEvent.click(screen.getByRole('button', { name: '重新加载右键菜单设置' }))
  await waitFor(() => expect(screen.getByRole('checkbox', { name: label })).not.toBeChecked())
  fireEvent.click(screen.getByRole('button', { name: '返回编辑器' }))
  await act(async () => { expect(await prepareClose()).toBe(true) })
  expect(write).toHaveBeenCalledOnce()
})

it('T03 shortcut preferences: retains original failed intent across dialog remount and blocks close until explicit reload', async () => {
  const observed = { bindings: {}, revision: 3,
    observation: { version: 1 as const, minimumBaseRevision: 0, fields: { 'file.save': 3 } } }
  const read = vi.fn(async () => ({ ok: true as const, value: structuredClone(observed) }))
  const write = vi.fn<NonNullable<ArkdownApi['updateKeyboardShortcuts']>>(async () => ({ ok: true,
    value: { snapshot: structuredClone(observed), error: 'shortcut choice conflicted' } }))
  installApi({ getKeyboardShortcuts: read, updateKeyboardShortcuts: write,
    setShortcutRecording: vi.fn(async () => ({ ok: true as const, value: null })) })
  render(<App />)
  await waitFor(() => expect(menuCommand).not.toBeNull())
  act(() => menuCommand?.('shortcut-settings'))
  await waitFor(() => expect(screen.getByRole('button', { name: '清除 保存' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '清除 保存' }))
  await screen.findByText('shortcut choice conflicted')
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '快捷键' })).not.toBeInTheDocument())
  await act(async () => { expect(await prepareClose()).toBe(false) })
  observed.revision = 8
  observed.observation.fields['file.save'] = 8
  act(() => menuCommand?.('shortcut-settings'))
  await screen.findByText('shortcut choice conflicted')
  await waitFor(() => expect(screen.getByRole('button', { name: '重新加载快捷键' })).toBeEnabled())
  expect(screen.getByRole('button', { name: '清除 保存' })).toBeDisabled()
  expect(write.mock.calls[0]?.[0]).toEqual({ observed: { bindings: {}, revision: 3,
    observation: { version: 1, minimumBaseRevision: 0, fields: { 'file.save': 3 } } },
    change: { id: 'file.save', accelerator: null } })
  fireEvent.click(screen.getByRole('button', { name: '重新加载快捷键' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '清除 保存' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  await act(async () => { expect(await prepareClose()).toBe(true) })
  expect(write).toHaveBeenCalledOnce()
})

it('T03 model preferences: retains a failed field across page remount and blocks close until explicit reload', async () => {
  const models: typeof DEFAULT_LARGE_MODEL_SETTINGS = { ...structuredClone(DEFAULT_LARGE_MODEL_SETTINGS), connections: [{
    id: '11111111-1111-4111-8111-111111111111', name: 'Configured', provider: 'deepseek', accessType: 'standard-api',
    protocol: 'openai', baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-chat', apiKeyHint: '••••test',
    status: 'connected', lastTestedAt: null, capabilityOverride: null,
  }] }
  let observed = modelObservation(models, 3)
  const read = vi.fn<ArkdownApi['getModelSettingsSnapshot']>(async () => ({ ok: true, value: structuredClone(observed) }))
  const write = vi.fn<ArkdownApi['setSelectionTranslationSettings']>(async () => ({ ok: true,
    value: { status: 'conflict', snapshot: modelObservation(models, 5), reason: 'field-changed', conflicts: [] } }))
  installPreferencesPersistenceApi({ getModelSettingsSnapshot: read, setSelectionTranslationSettings: write })
  render(<App />)
  await openPreferencesPage()
  fireEvent.click(screen.getByRole('button', { name: '管理大模型' }))
  choosePreferencesOption('目标语言', '日语')
  await waitFor(() => expect(write).toHaveBeenCalledExactlyOnceWith({ targetLanguage: 'ja' }, modelObservation(models, 3)))
  fireEvent.click(screen.getByRole('button', { name: '返回' }))
  fireEvent.click(screen.getByRole('button', { name: '返回编辑器' }))
  let closing!: Promise<boolean>
  await act(async () => { closing = prepareClose() })
  expect(await screen.findByRole('dialog', { name: '大模型设置尚未保存' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '返回编辑' }))
  await act(async () => { expect(await closing).toBe(false) })
  observed = modelObservation(models, 9)
  await openPreferencesPage()
  fireEvent.click(screen.getByRole('button', { name: '管理大模型' }))
  expect(screen.getByRole('combobox', { name: '目标语言' })).toHaveTextContent('日语')
  fireEvent.click(screen.getByRole('button', { name: '重新加载大模型设置' }))
  await waitFor(() => expect(screen.getByRole('combobox', { name: '目标语言' })).toHaveTextContent('自动'))
  fireEvent.click(screen.getByRole('button', { name: '返回' }))
  fireEvent.click(screen.getByRole('button', { name: '返回编辑器' }))
  await act(async () => { expect(await prepareClose()).toBe(true) })
  expect(write).toHaveBeenCalledOnce()
})
