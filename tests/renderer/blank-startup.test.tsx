import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ArkdownApi } from '../../src/shared/contracts'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import { modelCommit } from '../helpers/model-observation'
import { stickyNoteApiStubs } from './sticky-note-api-stubs'
import { applicationMenuApiStubs } from './application-menu-api-stubs'
import type { MenuCommand } from '../../src/shared/menu-commands'
import type { DroppedPathResult, RecoveryIntent, ImportedDocx } from '../../src/shared/contracts'
import startWritingSource from '../../initial-workspace/01-欢迎使用.md?raw'
const startWritingMarkdown = startWritingSource.replace(/\r\n/g, '\n')

let command: (command: MenuCommand) => void
let openIntent: (intent: DroppedPathResult) => void
let recoverIntent: (intent: RecoveryIntent) => void
let importIntent: (intent: { workspace: typeof workspace; imported: ImportedDocx }) => void

vi.mock('../../src/renderer/editor/EditorPane', () => ({
  EditorPane: forwardRef<
    { flush: () => string | null },
    {
      documentKey: string
      markdown: string
      onChange: (markdown: string) => void
    }
  >(function TestEditor({ documentKey, markdown, onChange }, ref) {
    useImperativeHandle(ref, () => ({ flush: () => null }))
    return <textarea
      aria-label="Markdown 编辑器"
      data-document-key={documentKey}
      onChange={(event) => onChange(event.target.value)}
      value={markdown}
    />
  }),
}))

import { App } from '../../src/renderer/app/App'

const modelApiFailure = async () => ({
  ok: false as const,
  error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
})

function installApi() {
  window.history.replaceState(null, '', '/')
  window.arkdown = {
    chooseWorkspace: vi.fn(async () => ({ ok: true as const, value: null })),
    restoreWorkspace: vi.fn(async () => ({ ok: true as const, value: null })),
    listDirectory: vi.fn(async () => ({ ok: true as const, value: [] })),
    openDroppedPath: vi.fn(async () => ({
      ok: true as const,
      value: { workspace: { name: 'Notes', absolutePath: 'C:/Notes' }, document: null },
    })),
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
    onMenuCommand: (handler) => { command = handler; return () => {} },
    onOpenIntent: (handler) => { openIntent = handler; return () => {} },
    onRecoverDraft: (handler) => { recoverIntent = handler; return () => {} },
    claimRecoveredDraft: vi.fn(async () => ({ ok: true as const, value: recovery() })),
    releaseDraftRecovery: vi.fn(async () => ({ ok: true as const, value: null })),
    onImportDocxIntent: (handler) => { importIntent = handler; return () => {} },
    recordRecentDocument: vi.fn(applicationMenuApiStubs.recordRecentDocument),
    saveDraft: vi.fn(),
    onPrepareClose: vi.fn(() => () => {}),
  } as ArkdownApi
}

beforeEach(installApi)

it('starts with an untitled editable page without restoring the previous workspace', async () => {
  render(<App />)

  expect(await screen.findByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue('')
  expect(screen.queryByText('请选择文件夹')).not.toBeInTheDocument()
  expect(screen.getByRole('complementary')).toBeVisible()
  expect(screen.getByRole('separator', { name: '调整侧边栏宽度' })).toBeVisible()
  expect(document.querySelector('.titlebar')).toBeNull()
  expect(window.arkdown.restoreWorkspace).not.toHaveBeenCalled()
  await waitFor(() => expect(document.title).toBe('未命名 — Arkdown'))
})

function startWithGuide() {
  window.history.replaceState(null, '', '/?startup=guide')
  render(<App />)
}

const workspace = { name: 'Notes', absolutePath: 'C:/Notes' }
const emptyDocument = {
  relativePath: 'empty.md', markdown: '', revision: 'a'.repeat(64),
  encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 1,
}

it('edits the startup document and preserves changes when Save As is cancelled', async () => {
  window.arkdown.saveDraft = vi.fn(async () => ({ ok: true as const, value: recovery().manifest }))
  window.arkdown.beginSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown.commitSaveDocumentAs = vi.fn()
  window.arkdown.abortSaveDocumentAs = vi.fn()
  startWithGuide()
  const editor = await screen.findByRole('textbox', { name: 'Markdown 编辑器' })
  expect(editor).toHaveValue(startWritingMarkdown)
  expect(screen.getByRole('heading', { name: '欢迎使用.md' })).toBeVisible()
  expect(screen.getByRole('button', { name: '加粗' })).toBeVisible()
  expect(screen.queryByText(/只读/)).not.toBeInTheDocument()
  fireEvent.change(editor, { target: { value: startWritingMarkdown + '\n我的想法' } })
  await act(async () => command('save'))
  await waitFor(() => expect(window.arkdown.beginSaveDocumentAs).toHaveBeenCalledWith(expect.objectContaining({
    suggestedFileName: '欢迎使用.md', markdown: startWritingMarkdown + '\n我的想法',
  })))
  expect(editor).toHaveValue(startWritingMarkdown + '\n我的想法')
})

it('saves the startup text as a real Markdown document and adopts the saved file', async () => {
  const markdown = startWritingMarkdown + '\n保存我的第一篇笔记'
  window.arkdown.saveDraft = vi.fn(async () => ({ ok: true as const, value: recovery().manifest }))
  window.arkdown.beginSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: {
    intentId: 'save-start-writing', targetWorkspace: workspace, targetFileName: '第一篇.md',
    targetRelativePath: '第一篇.md', changesWorkspace: true,
  } }))
  window.arkdown.commitSaveDocumentAs = vi.fn(async () => ({ ok: true as const, value: {
    workspace, document: { ...emptyDocument, relativePath: '第一篇.md', markdown },
    changesWorkspace: true, aiWorkspace: { workspaceId: 'notes', workspaceGeneration: '1' },
  } }))
  window.arkdown.abortSaveDocumentAs = vi.fn()
  startWithGuide()
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown 编辑器' }), { target: { value: markdown } })
  await act(async () => command('save'))
  await waitFor(() => expect(window.arkdown.commitSaveDocumentAs).toHaveBeenCalledWith('save-start-writing'))
  await waitFor(() => expect(screen.getByRole('heading', { name: '第一篇.md' })).toBeVisible())
  expect(screen.getByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue(markdown)
  expect(window.arkdown.abortSaveDocumentAs).not.toHaveBeenCalled()
})

it('uses the ordinary title and enabled save menu for explicit blank startup', async () => {
  startWithGuide()
  expect(await screen.findByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue(startWritingMarkdown)
  expect(document.title).toBe('欢迎使用.md — Arkdown')
  fireEvent.click(document.querySelector('.app-menu-button')!)
  expect(screen.getByRole('menuitem', { name: /^保存Ctrl/ })).toBeEnabled()
  expect(screen.getByRole('menuitem', { name: /^另存为/ })).toBeEnabled()
  expect(window.arkdown.recordRecentDocument).not.toHaveBeenCalled()
  expect(window.arkdown.saveDraft).not.toHaveBeenCalled()
})

it('retains the startup text across workspace-only open and creates an empty New', async () => {
  startWithGuide()
  await act(async () => openIntent({ workspace, document: null }))
  expect(screen.getByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue(startWritingMarkdown)
  await act(async () => command('new-document'))
  const editor = screen.getByRole('textbox', { name: 'Markdown 编辑器' })
  expect(editor).toHaveValue('')
  fireEvent.change(editor, { target: { value: 'hello' } })
  fireEvent.change(editor, { target: { value: '' } })
  expect(screen.queryByRole('region', { name: '开始写作' })).not.toBeInTheDocument()
})

it('keeps the full editor and toolbar when opening and closing sticky notes from startup', async () => {
  const connectArknote = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown.connectArknote = connectArknote
  window.arkdown.listStickyNotes = vi.fn(async () => ({ ok: true as const, value: [] }))
  startWithGuide()

  const toggle = screen.getByRole('button', { name: '便签盒子' })
  expect(toggle).toHaveAttribute('aria-pressed', 'false')
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'true'))
  expect(screen.getByRole('complementary', { name: '便签盒子' })).toBeVisible()
  expect(connectArknote).toHaveBeenCalledOnce()
  expect(screen.getByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue(startWritingMarkdown)

  fireEvent.click(screen.getByRole('button', { name: '关闭便签盒子' }))
  expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue(startWritingMarkdown)
  expect(screen.queryByRole('textbox', { name: '修改文件名' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '加粗' })).toBeVisible()
  expect(window.arkdown.saveDocument).not.toHaveBeenCalled()
  expect(window.arkdown.saveDraft).not.toHaveBeenCalled()
  expect(window.arkdown.recordRecentDocument).not.toHaveBeenCalled()

  await act(async () => command('new-document'))
  expect(screen.getByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue('')
})

it('lets an explicit empty document beat the guide', async () => {
  startWithGuide()
  await act(async () => openIntent({ workspace, document: emptyDocument }))
  expect(screen.getByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue('')
  expect(screen.queryByRole('region', { name: '开始写作' })).not.toBeInTheDocument()
})

function recovery(originalAbsolutePath: string | null = null): RecoveryIntent {
  return {
    draftId: '123e4567-e89b-42d3-a456-426614174222', markdown: '',
    manifest: {
      draftId: '123e4567-e89b-42d3-a456-426614174222', originalAbsolutePath,
      workspaceAbsolutePath: originalAbsolutePath ? workspace.absolutePath : null,
      originalRevision: null, updatedAt: '2026-09-07T00:00:00.000Z',
      originalMtimeMs: null, encoding: 'utf8', newline: 'lf', ignoredAt: null,
    },
  }
}

it('lets even an empty recovered draft beat the guide', async () => {
  startWithGuide()
  await act(async () => recoverIntent(recovery()))
  expect(screen.getByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue('')
  expect(screen.queryByRole('region', { name: '开始写作' })).not.toBeInTheDocument()
})

it('keeps the current editor and releases the grant when main refuses recovery ownership', async () => {
  window.arkdown.claimRecoveredDraft = vi.fn<NonNullable<ArkdownApi['claimRecoveredDraft']>>(async () => ({ ok: false, error: { code: 'INVALID_INPUT', message: '请求参数无效' } }))
  startWithGuide()
  await act(async () => recoverIntent(recovery()))
  expect(await screen.findByRole('alertdialog', { name: '无法恢复草稿' })).toBeVisible()
  expect(screen.getByRole('textbox', { name: 'Markdown 编辑器', hidden: true })).toHaveValue(startWritingMarkdown)
  fireEvent.click(screen.getByRole('button', { name: '确定' }))
  await waitFor(() => expect(window.arkdown.releaseDraftRecovery).toHaveBeenCalledWith(recovery().draftId))
})

it('consumes the guide on real imported document adoption', async () => {
  startWithGuide()
  await act(async () => importIntent({ workspace, imported: {
    markdown: 'Imported body', sourceFileName: 'report.docx', sourceAbsolutePath: 'C:/Notes/report.docx',
  } as ImportedDocx }))
  expect(screen.getByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue('Imported body')
  expect(screen.queryByRole('region', { name: '开始写作' })).not.toBeInTheDocument()
})

it('retains the guide after a failed file open, then consumes it on a successful empty file open', async () => {
  vi.mocked(window.arkdown.listDirectory).mockResolvedValue({ ok: true, value: [{
    kind: 'document', name: 'empty.md', relativePath: 'empty.md',
  }] })
  vi.mocked(window.arkdown.readDocument).mockResolvedValueOnce({ ok: false, error: { code: 'READ_FAILED', message: 'Read failed' } })
  startWithGuide()
  await act(async () => openIntent({ workspace, document: null }))
  fireEvent.click(await screen.findByRole('button', { name: 'empty.md' }))
  await waitFor(() => expect(window.arkdown.readDocument).toHaveBeenCalledOnce())
  expect(screen.getByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue(startWritingMarkdown)
  vi.mocked(window.arkdown.readDocument).mockResolvedValueOnce({ ok: true, value: emptyDocument })
  fireEvent.click(screen.getByRole('button', { name: 'empty.md' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue(''))
  expect(screen.queryByRole('region', { name: '开始写作' })).not.toBeInTheDocument()
})

it('does not let delayed startup recovery cover a newer New document', async () => {
  let resolve!: (result: Awaited<ReturnType<ArkdownApi['openDroppedPath']>>) => void
  vi.mocked(window.arkdown.openDroppedPath).mockReturnValue(new Promise((done) => { resolve = done }))
  startWithGuide()
  await act(async () => recoverIntent(recovery('C:/Notes/old.md')))
  await act(async () => command('new-document'))
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown 编辑器' }), { target: { value: 'new work' } })
  await act(async () => resolve({ ok: true, value: { workspace, document: { ...emptyDocument, markdown: 'old work' } } }))
  expect(screen.getByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue('new work')
})
