import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { forwardRef, useImperativeHandle } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/app/App'
import { ContextMenuProvider } from '../../src/renderer/context-menu/ContextMenuProvider'
import type { DocumentSnapshot, ArkdownApi, AiWorkspaceState } from '../../src/shared/contracts'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import { modelCommit } from '../helpers/model-observation'
import { stickyNoteApiStubs } from './sticky-note-api-stubs'
import { applicationMenuApiStubs } from './application-menu-api-stubs'

const editorMocks = vi.hoisted(() => ({
  insertDroppedLink: vi.fn(() => true),
  insertDroppedMarkdown: vi.fn(() => true),
  workspace: null as AiWorkspaceState | null,
  onWorkspaceFilesChanged: undefined as ((workspace: AiWorkspaceState) => void) | undefined,
}))

vi.mock('../../src/renderer/editor/EditorPane', () => ({
  EditorPane: forwardRef<
    {
      flush: () => string | null
      insertDroppedLink: typeof editorMocks.insertDroppedLink
      insertDroppedMarkdown: typeof editorMocks.insertDroppedMarkdown
    },
    { markdown: string; onChange: (markdown: string) => void; aiWorkspace?: AiWorkspaceState | null; onWorkspaceFilesChanged?: (workspace: AiWorkspaceState) => void }
  >(function EditorPane({ markdown, onChange, aiWorkspace, onWorkspaceFilesChanged }, ref) {
    editorMocks.workspace = aiWorkspace ?? null
    editorMocks.onWorkspaceFilesChanged = onWorkspaceFilesChanged
    useImperativeHandle(ref, () => ({
      flush: () => null,
      insertDroppedLink: editorMocks.insertDroppedLink,
      insertDroppedMarkdown: editorMocks.insertDroppedMarkdown,
    }))
    return <textarea
      aria-label="Markdown editor"
      className="ProseMirror"
      ref={element => { if (element) element.getBoundingClientRect = () => new DOMRect(0, 0, 600, 400) }}
      onChange={(event) => onChange(event.target.value)}
      value={markdown}
    />
  }),
}))

const workspace = { name: 'Notes', absolutePath: 'C:/Notes' }

const modelApiFailure = async () => ({
  ok: false as const,
  error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
})

function snapshot(relativePath: string, markdown = '# Disk'): DocumentSnapshot {
  return {
    relativePath,
    markdown,
    revision: 'a'.repeat(64),
    encoding: 'utf8',
    newline: 'lf',
    mtimeMs: 1,
  }
}

async function selectGreenColor() {
  const parent = await screen.findByRole('menuitem', { name: '标记颜色' })
  fireEvent.mouseEnter(parent)
  const green = await screen.findByRole('menuitemradio', { name: '绿色' })
  // user-event omits relatedTarget on mouseout; include the real portal destination.
  fireEvent.mouseLeave(parent, { relatedTarget: green })
  expect(green).toBeInTheDocument()
  fireEvent.click(green)
}

function installApi(overrides: Partial<ArkdownApi> = {}) {
  const api: ArkdownApi = {
    restoreWorkspace: vi.fn(async () => ({ ok: true as const, value: workspace })),
    chooseWorkspace: vi.fn(async () => ({ ok: true as const, value: workspace })),
    claimWorkspaceIntroduction: vi.fn(async () => ({ ok: true as const, value: { showIntroduction: false } })),
    listDirectory: vi.fn(async () => ({
      ok: true as const,
      value: [{ name: 'note.md', relativePath: 'note.md', kind: 'document' as const }],
    })),
    openDroppedPath: vi.fn(async () => ({
      ok: true as const, value: { workspace, document: null },
    })),
    pathForDroppedFile: vi.fn(() => ''),
    inspectDroppedPath: vi.fn(async (absolutePath: string) => ({
      ok: true as const,
      value: { kind: 'file' as const, absolutePath },
    })),
    createDocument: vi.fn(async (relativePath) => ({
      ok: true as const,
      value: snapshot(relativePath, ''),
    })),
    readDocument: vi.fn(async (relativePath) => ({
      ok: true as const,
      value: snapshot(relativePath),
    })),
    peekDocument: vi.fn(async (relativePath) => ({
      ok: true as const,
      value: snapshot(relativePath),
    })),
    saveDocument: vi.fn(async () => ({
      ok: true as const,
      value: { revision: 'b'.repeat(64), mtimeMs: 2 },
    })),
    revealDocument: vi.fn(async () => ({ ok: true as const, value: null })),
    trashDocument: vi.fn(async () => ({ ok: true as const, value: null })),
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
    ...overrides,
    onWindowStateChanged: overrides.onWindowStateChanged
      ?? applicationMenuApiStubs.onWindowStateChanged,
  }
  window.arkdown = api
  return api
}

beforeEach(() => {
  editorMocks.insertDroppedLink.mockClear()
  editorMocks.insertDroppedMarkdown.mockClear()
  editorMocks.workspace = null
  editorMocks.onWorkspaceFilesChanged = undefined
  installApi()
})

it('refreshes the visible tree for AI file mutations only in its current workspace binding', async () => {
  const user = userEvent.setup()
  const binding = { workspaceId: 'notes-root', workspaceGeneration: 'generation-1' }
  let documentName = 'note.md'
  const listDirectory = vi.fn(async () => ({ ok: true as const, value: [
    { name: documentName, relativePath: documentName, kind: 'document' as const },
  ] }))
  const api = installApi({ listDirectory, getAiWorkspaceState: vi.fn(async () => ({ ok: true as const, value: binding })) })
  render(<ContextMenuProvider><App /></ContextMenuProvider>)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await screen.findByRole('button', { name: 'note.md' })
  await waitFor(() => expect(editorMocks.workspace).toEqual(binding))
  const initialReads = listDirectory.mock.calls.length

  documentName = 'created.md'
  act(() => editorMocks.onWorkspaceFilesChanged?.({ ...binding, workspaceId: 'another-root' }))
  act(() => editorMocks.onWorkspaceFilesChanged?.({ ...binding, workspaceGeneration: 'old-generation' }))
  expect(listDirectory).toHaveBeenCalledTimes(initialReads)
  expect(screen.queryByRole('button', { name: 'created.md' })).not.toBeInTheDocument()

  act(() => editorMocks.onWorkspaceFilesChanged?.(binding))
  await screen.findByRole('button', { name: 'created.md' })
  expect(listDirectory).toHaveBeenCalledTimes(initialReads + 1)
  documentName = 'renamed.md'
  act(() => editorMocks.onWorkspaceFilesChanged?.(binding))
  await screen.findByRole('button', { name: 'renamed.md' })
  expect(screen.queryByRole('button', { name: 'created.md' })).not.toBeInTheDocument()
  expect(listDirectory).toHaveBeenCalledTimes(initialReads + 2)
  expect(api.createDocument).not.toHaveBeenCalled()
  expect(api.saveDocument).not.toHaveBeenCalled()
  expect(api.trashDocument).not.toHaveBeenCalled()
})

it('creates a Markdown document from the workspace root context menu', async () => {
  const user = userEvent.setup()
  const createDocument = vi.fn(async (relativePath: string) => ({
    ok: true as const,
    value: snapshot(relativePath, ''),
  }))
  const listDirectory = vi.fn(async () => ({
    ok: true as const,
    value: [
      { name: 'note.md', relativePath: 'note.md', kind: 'document' as const },
      ...(createDocument.mock.calls.length
        ? [{ name: 'draft.md', relativePath: 'draft.md', kind: 'document' as const }]
        : []),
    ],
  }))
  installApi({ createDocument, listDirectory })
  const prompt = vi.spyOn(window, 'prompt')
  render(<ContextMenuProvider><App /></ContextMenuProvider>)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))

  fireEvent.contextMenu(document.querySelector('.workspace-tree-context')!, {
    clientX: 40,
    clientY: 60,
  })
  await user.click(await screen.findByRole('menuitem', { name: '新建文档' }))

  const dialog = await screen.findByRole('dialog', { name: '新建文档' })
  const input = within(dialog).getByRole('textbox', { name: '名称' })
  await user.clear(input)
  await user.type(input, 'draft')
  await user.click(within(dialog).getByRole('button', { name: '创建' }))

  expect(window.arkdown.createDocument).toHaveBeenCalledWith('draft.md')
  expect(prompt).not.toHaveBeenCalled()
  expect(await screen.findByRole('textbox', { name: 'Markdown editor' })).toHaveValue('')
  expect(document.title).toContain('draft.md')
  const located = await screen.findByRole('button', { name: 'draft.md' })
  await waitFor(() => expect(located).toHaveFocus())
  expect(located).not.toHaveAttribute('data-located')
})

it('creates a folder from the workspace root context menu', async () => {
  const user = userEvent.setup()
  const prompt = vi.spyOn(window, 'prompt')
  const createWorkspaceFolder = vi.fn(async () => ({
    ok: true as const,
    value: { name: '资料', relativePath: '资料', kind: 'directory' as const },
  }))
  const listDirectory = vi.fn(async () => ({
    ok: true as const,
    value: [
      { name: 'note.md', relativePath: 'note.md', kind: 'document' as const },
      ...(createWorkspaceFolder.mock.calls.length
        ? [{ name: '资料', relativePath: '资料', kind: 'directory' as const }]
        : []),
    ],
  }))
  installApi({ createWorkspaceFolder, listDirectory })
  render(<ContextMenuProvider><App /></ContextMenuProvider>)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))

  fireEvent.contextMenu(document.querySelector('.workspace-tree-context')!, {
    clientX: 40,
    clientY: 60,
  })
  await user.click(await screen.findByRole('menuitem', { name: '新建文件夹' }))

  const dialog = await screen.findByRole('dialog', { name: '新建文件夹' })
  const input = within(dialog).getByRole('textbox', { name: '名称' })
  await user.clear(input)
  await user.type(input, '资料')
  await user.click(within(dialog).getByRole('button', { name: '创建' }))

  await waitFor(() => expect(createWorkspaceFolder).toHaveBeenCalledWith('', '资料'))
  expect(prompt).not.toHaveBeenCalled()
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: '新建文件夹' })).not.toBeInTheDocument()
  })
  const located = await screen.findByRole('button', { name: '资料' })
  await waitFor(() => expect(located).toHaveFocus())
  expect(located).not.toHaveAttribute('data-located')
})

it('renames a document from its context menu', async () => {
  const user = userEvent.setup()
  const prompt = vi.spyOn(window, 'prompt')
  const renameWorkspaceEntry = vi.fn(async () => ({
    ok: true as const,
    value: {
      entry: { name: 'renamed.md', relativePath: 'renamed.md', kind: 'document' as const },
      colorMarks: { marks: { 'renamed.md': '#2563EB' as const } },
    },
  }))
  const listDirectory = vi.fn(async () => ({
    ok: true as const,
    value: renameWorkspaceEntry.mock.calls.length
      ? [{ name: 'renamed.md', relativePath: 'renamed.md', kind: 'document' as const }]
      : [{ name: 'note.md', relativePath: 'note.md', kind: 'document' as const }],
  }))
  const moveWorkspaceColorMark = vi.fn()
  installApi({
    renameWorkspaceEntry,
    listDirectory,
    getWorkspaceColorMarks: vi.fn(async () => ({
      ok: true as const,
      value: { marks: { 'note.md': '#2563EB' as const } },
    })),
    moveWorkspaceColorMark,
  })
  render(<ContextMenuProvider><App /></ContextMenuProvider>)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))

  const row = await screen.findByRole('button', { name: 'note.md' })
  fireEvent.contextMenu(row, { clientX: 40, clientY: 60 })
  await user.click(await screen.findByRole('menuitem', { name: '重命名…' }))

  const dialog = await screen.findByRole('dialog', { name: '重命名' })
  const input = within(dialog).getByRole('textbox', { name: '名称' })
  expect(input).toHaveValue('note.md')
  await user.clear(input)
  await user.type(input, 'renamed.md')
  await user.click(within(dialog).getByRole('button', { name: '重命名' }))

  await waitFor(() => expect(renameWorkspaceEntry).toHaveBeenCalledWith(
    'note.md',
    'renamed.md',
  ))
  expect(prompt).not.toHaveBeenCalled()
  expect(moveWorkspaceColorMark).not.toHaveBeenCalled()
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: '重命名' })).not.toBeInTheDocument()
  })
  const located = await screen.findByRole('button', { name: 'renamed.md' })
  await waitFor(() => expect(located).toHaveFocus())
  expect(located).toHaveAttribute('data-color-mark', '#2563EB')
  expect(located).not.toHaveAttribute('data-located')
})

it('does not let an earlier workspace color load overwrite a rename transaction snapshot', async () => {
  const user = userEvent.setup()
  let resolveInitialColors!: (value: {
    ok: true
    value: { marks: { 'note.md': '#18864B' } }
  }) => void
  const getWorkspaceColorMarks = vi.fn(() => new Promise<{
    ok: true
    value: { marks: { 'note.md': '#18864B' } }
  }>((resolve) => { resolveInitialColors = resolve }))
  const renameWorkspaceEntry = vi.fn(async () => ({
    ok: true as const,
    value: {
      entry: { name: 'renamed.md', relativePath: 'renamed.md', kind: 'document' as const },
      colorMarks: { marks: { 'renamed.md': '#2563EB' as const } },
    },
  }))
  const listDirectory = vi.fn(async () => ({
    ok: true as const,
    value: renameWorkspaceEntry.mock.calls.length
      ? [{ name: 'renamed.md', relativePath: 'renamed.md', kind: 'document' as const }]
      : [{ name: 'note.md', relativePath: 'note.md', kind: 'document' as const }],
  }))
  installApi({ getWorkspaceColorMarks, listDirectory, renameWorkspaceEntry })
  render(<ContextMenuProvider><App /></ContextMenuProvider>)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  const row = await screen.findByRole('button', { name: 'note.md' })

  fireEvent.contextMenu(row, { clientX: 40, clientY: 60 })
  await user.click(await screen.findByRole('menuitem', { name: '重命名…' }))
  const dialog = await screen.findByRole('dialog', { name: '重命名' })
  const input = within(dialog).getByRole('textbox', { name: '名称' })
  await user.clear(input)
  await user.type(input, 'renamed.md')
  await user.click(within(dialog).getByRole('button', { name: '重命名' }))

  const renamed = await screen.findByRole('button', { name: 'renamed.md' })
  await waitFor(() => expect(renamed).toHaveAttribute('data-color-mark', '#2563EB'))
  await act(async () => resolveInitialColors({
    ok: true,
    value: { marks: { 'note.md': '#18864B' } },
  }))
  expect(renamed).toHaveAttribute('data-color-mark', '#2563EB')
})

it('commits an earlier header rename when a later color mutation resolves first', async () => {
  const user = userEvent.setup()
  let resolveRename!: (value: {
    ok: true
    value: {
      entry: { name: string; relativePath: string; kind: 'document' }
      colorMarks: { marks: Record<string, '#18864B'> }
    }
  }) => void
  const renameWorkspaceEntry = vi.fn(() => new Promise<{
    ok: true
    value: {
      entry: { name: string; relativePath: string; kind: 'document' }
      colorMarks: { marks: Record<string, '#18864B'> }
    }
  }>((resolve) => { resolveRename = resolve }))
  let resolveColor!: (value: {
    ok: true
    value: { marks: Record<string, '#18864B'> }
  }) => void
  const colorResult = new Promise<{
    ok: true
    value: { marks: Record<string, '#18864B'> }
  }>((resolve) => { resolveColor = resolve })
  const setWorkspaceColorMark = vi.fn(() => colorResult)
  const listDirectory = vi.fn(async () => ({
    ok: true as const,
    value: [
      renameWorkspaceEntry.mock.calls.length
        ? { name: 'renamed.md', relativePath: 'renamed.md', kind: 'document' as const }
        : { name: 'note.md', relativePath: 'note.md', kind: 'document' as const },
      { name: 'second.md', relativePath: 'second.md', kind: 'document' as const },
    ],
  }))
  installApi({
    getWorkspaceColorMarks: vi.fn(async () => ({ ok: true as const, value: { marks: {} } })),
    listDirectory,
    renameWorkspaceEntry,
    setWorkspaceColorMark,
  })
  render(<ContextMenuProvider><App /></ContextMenuProvider>)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))

  fireEvent.click(await screen.findByRole('heading', { name: 'note.md' }))
  const nameInput = screen.getByRole('textbox', { name: '修改文件名' })
  fireEvent.change(nameInput, { target: { value: 'renamed.md' } })
  fireEvent.keyDown(nameInput, { key: 'Enter' })
  await waitFor(() => expect(renameWorkspaceEntry).toHaveBeenCalledWith('note.md', 'renamed.md'))

  const second = await screen.findByRole('button', { name: 'second.md' })
  fireEvent.contextMenu(second, { clientX: 40, clientY: 60 })
  await selectGreenColor()
  expect(setWorkspaceColorMark).not.toHaveBeenCalled()

  await act(async () => resolveColor({
    ok: true,
    value: { marks: { 'second.md': '#18864B' } },
  }))
  await act(async () => resolveRename({
    ok: true,
    value: {
      entry: { name: 'renamed.md', relativePath: 'renamed.md', kind: 'document' },
      colorMarks: { marks: {} },
    },
  }))
  await waitFor(() => expect(setWorkspaceColorMark).toHaveBeenCalledWith(
    'second.md',
    '#18864B',
  ))

  expect(await screen.findByRole('heading', { name: 'renamed.md' })).toBeVisible()
  const renamed = await screen.findByRole('button', { name: 'renamed.md' })
  const recolored = await screen.findByRole('button', { name: 'second.md' })
  await waitFor(() => expect(recolored).toHaveAttribute('data-color-mark', '#18864B'))
  expect(renamed).not.toHaveAttribute('data-color-mark')
})

it('reloads the current document from disk without saving the displayed version', async () => {
  const user = userEvent.setup()
  const api = installApi()
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))

  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const editor = await screen.findByRole('textbox', { name: 'Markdown editor' })
  await user.clear(editor)
  await user.type(editor, '# In memory')
  vi.mocked(api.readDocument).mockResolvedValueOnce({
    ok: true,
    value: snapshot('note.md', '# Reloaded'),
  })
  await user.click(screen.getByRole('button', { name: '从磁盘重新加载' }))
  const dialog = await screen.findByRole('dialog', { name: '从磁盘重新加载' })
  await user.click(within(dialog).getByRole('button', { name: '继续' }))

  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Reloaded'))
  expect(api.saveDocument).not.toHaveBeenCalled()
})

it('reveals and trashes a document from its context menu', async () => {
  const user = userEvent.setup()
  const revealWorkspaceEntry = vi.fn(async () => ({ ok: true as const, value: null }))
  const trashWorkspaceEntry = vi.fn(async () => ({
    ok: true as const,
    value: { colorMarks: { marks: {} } },
  }))
  const deleteWorkspaceColorMarks = vi.fn()
  installApi({
    revealWorkspaceEntry,
    trashWorkspaceEntry,
    deleteWorkspaceColorMarks,
    getWorkspaceColorMarks: vi.fn(async () => ({
      ok: true as const,
      value: { marks: { 'note.md': '#2563EB' as const } },
    })),
  })
  render(<ContextMenuProvider><App /></ContextMenuProvider>)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))

  let row = await screen.findByRole('button', { name: 'note.md' })
  fireEvent.contextMenu(row, { clientX: 40, clientY: 60 })
  expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual([
    '在新窗口中打开',
    '打开所在的文件夹',
    '复制绝对路径',
    '标记颜色›',
    '重命名…',
    '创建副本',
    '移到回收站',
    '属性',
  ])
  expect(screen.queryByRole('menuitem', { name: '打开' })).not.toBeInTheDocument()
  await user.click(await screen.findByRole('menuitem', { name: '打开所在的文件夹' }))
  expect(revealWorkspaceEntry).toHaveBeenCalledWith('note.md')

  row = await screen.findByRole('button', { name: 'note.md' })
  fireEvent.contextMenu(row, { clientX: 40, clientY: 60 })
  await user.click(await screen.findByRole('menuitem', { name: '移到回收站' }))
  const dialog = await screen.findByRole('dialog', { name: '移到回收站' })
  await user.click(within(dialog).getByRole('button', { name: '移到回收站' }))
  await waitFor(() => expect(trashWorkspaceEntry).toHaveBeenCalledWith('note.md'))
  expect(trashWorkspaceEntry).toHaveBeenCalledWith('note.md')
  expect(deleteWorkspaceColorMarks).not.toHaveBeenCalled()
})

it('does not migrate color metadata when the filesystem rename fails', async () => {
  const user = userEvent.setup()
  const moveWorkspaceColorMark = vi.fn()
  const getWorkspaceColorMarks = vi.fn()
    .mockResolvedValueOnce({
      ok: true as const,
      value: { marks: { 'note.md': '#2563EB' as const } },
    })
    .mockResolvedValueOnce({
      ok: true as const,
      value: { marks: { 'note.md': '#18864B' as const } },
    })
  installApi({
    getWorkspaceColorMarks,
    moveWorkspaceColorMark,
    renameWorkspaceEntry: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'OPERATION_FAILED', message: '重命名失败' },
    })),
  })
  render(<ContextMenuProvider><App /></ContextMenuProvider>)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  const row = await screen.findByRole('button', { name: 'note.md' })
  await waitFor(() => expect(row).toHaveAttribute('data-color-mark', '#2563EB'))
  fireEvent.contextMenu(row, { clientX: 40, clientY: 60 })
  await user.click(await screen.findByRole('menuitem', { name: '重命名…' }))
  const dialog = await screen.findByRole('dialog', { name: '重命名' })
  const input = within(dialog).getByRole('textbox', { name: '名称' })
  await user.clear(input)
  await user.type(input, 'renamed.md')
  await user.click(within(dialog).getByRole('button', { name: '重命名' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('重命名失败')
  expect(moveWorkspaceColorMark).not.toHaveBeenCalled()
  await waitFor(() => expect(row).toHaveAttribute('data-color-mark', '#18864B'))
  expect(getWorkspaceColorMarks).toHaveBeenCalledTimes(2)
})

it('loads color marks and rolls an optimistic color change back when persistence fails', async () => {
  const user = userEvent.setup()
  let resolveSet!: (value: Awaited<ReturnType<NonNullable<ArkdownApi['setWorkspaceColorMark']>>>) => void
  const setWorkspaceColorMark = vi.fn(() => new Promise<
    Awaited<ReturnType<NonNullable<ArkdownApi['setWorkspaceColorMark']>>>
  >((resolve) => { resolveSet = resolve }))
  installApi({
    getWorkspaceColorMarks: vi.fn(async () => ({
      ok: true as const,
      value: { marks: { 'note.md': '#2563EB' as const } },
    })),
    setWorkspaceColorMark,
  })
  render(<ContextMenuProvider><App /></ContextMenuProvider>)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  const row = await screen.findByRole('button', { name: 'note.md' })
  await waitFor(() => expect(row).toHaveAttribute('data-color-mark', '#2563EB'))

  fireEvent.contextMenu(row, { clientX: 40, clientY: 60 })
  await selectGreenColor()
  await waitFor(() => expect(row).toHaveAttribute('data-color-mark', '#18864B'))
  resolveSet({
    ok: false,
    error: { code: 'OPERATION_FAILED', message: '写入失败' },
  })
  await waitFor(() => expect(row).toHaveAttribute('data-color-mark', '#2563EB'))
  expect(setWorkspaceColorMark).toHaveBeenCalledWith('note.md', '#18864B')
  expect(await screen.findByRole('alert')).toHaveTextContent('写入失败')
})

it('rolls an optimistic color change back when the IPC invocation rejects', async () => {
  const user = userEvent.setup()
  installApi({
    getWorkspaceColorMarks: vi.fn(async () => ({
      ok: true as const,
      value: { marks: { 'note.md': '#2563EB' as const } },
    })),
    setWorkspaceColorMark: vi.fn(async () => {
      throw new Error('颜色服务暂时不可用')
    }),
  })
  render(<ContextMenuProvider><App /></ContextMenuProvider>)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  const row = await screen.findByRole('button', { name: 'note.md' })
  await waitFor(() => expect(row).toHaveAttribute('data-color-mark', '#2563EB'))

  fireEvent.contextMenu(row, { clientX: 40, clientY: 60 })
  await selectGreenColor()
  await waitFor(() => expect(row).toHaveAttribute('data-color-mark', '#2563EB'))
  expect(await screen.findByRole('alert')).toHaveTextContent('颜色服务暂时不可用')
})

it('does not add a visual overlay state while a file is dragged over the window', async () => {
  render(<App />)

  const shell = (await screen.findByTestId('editor-host')).closest('.app-shell')!
  const file = new File(['# Dragging'], 'dragging.md', { type: 'text/markdown' })
  fireEvent.dragEnter(shell, { dataTransfer: { files: [file] } })

  expect(shell).not.toHaveClass('is-file-dragging')
})

it('leaves selected-text drag and drop to the editor', async () => {
  render(<App />)

  const shell = (await screen.findByTestId('editor-host')).closest('.app-shell')!
  const transfer = {
    files: [] as File[],
    types: ['text/plain'],
  }

  const dragOverWasNotCancelled = fireEvent.dragOver(shell, {
    dataTransfer: transfer,
  })
  const dropWasNotCancelled = fireEvent.drop(shell, {
    dataTransfer: transfer,
  })

  expect(dragOverWasNotCancelled).toBe(true)
  expect(dropWasNotCancelled).toBe(true)
})


it('inserts a Markdown file dropped from Windows Explorer as a path link', async () => {
  const api = installApi({
    pathForDroppedFile: vi.fn(() => 'C:\\external\\guide.md'),
  })
  render(<App />)

  const shell = (await screen.findByTestId('editor-host')).closest('.app-shell')!
  const file = new File(['# Dropped'], 'guide.md', { type: 'text/markdown' })
  fireEvent.dragOver(shell, { dataTransfer: { files: [file] } })
  const drop = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 })
  Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [file] } })
  fireEvent(screen.getByRole('textbox', { name: 'Markdown editor' }), drop)

  expect(api.pathForDroppedFile).toHaveBeenCalledWith(file)
  await waitFor(() => expect(editorMocks.insertDroppedLink).toHaveBeenCalledWith(
    expect.objectContaining({ absolutePath: 'C:\\external\\guide.md' }),
  ))
  expect(api.openDroppedPath).not.toHaveBeenCalled()
})


it('imports an image dropped into the editor instead of opening it as a document', async () => {
  const imported = {
    assetId: 'a'.repeat(64),
    category: 'image' as const,
    fileName: 'photo.png',
    relativePath: 'assets/photo.png',
    previewUrl: 'arkdown-asset://asset/token',
    markdown: '![photo.png](arkdown-asset://asset/token)',
  }
  const importAsset = vi.fn(async () => ({ ok: true as const, value: imported }))
  const api = installApi({
    pathForDroppedFile: vi.fn(() => 'C:\\external\\photo.png'),
    importAsset,
  })
  render(<App />)
  const file = new File(['png'], 'photo.png', { type: 'image/png' })

  fireEvent.drop(screen.getByTestId('editor-host'), { dataTransfer: { files: [file] } })

  await waitFor(() => expect(importAsset).toHaveBeenCalledWith('C:\\external\\photo.png'))
  expect(api.openDroppedPath).not.toHaveBeenCalled()
  expect(editorMocks.insertDroppedMarkdown).toHaveBeenCalledWith(expect.objectContaining({
    markdown: imported.markdown,
  }))
})


it('inserts a dropped text document as a path link when the current page has content', async () => {
  const user = userEvent.setup()
  const openDocumentWindow = vi.fn(async () => ({ ok: true as const, value: null }))
  const api = installApi({
    pathForDroppedFile: vi.fn(() => 'C:\\external\\other.txt'),
    openDocumentWindow,
  })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  const file = new File(['other'], 'other.txt', { type: 'text/plain' })

  const drop = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 })
  Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [file] } })
  fireEvent(screen.getByRole('textbox', { name: 'Markdown editor' }), drop)

  await waitFor(() => expect(editorMocks.insertDroppedLink).toHaveBeenCalledWith(expect.objectContaining({
    absolutePath: 'C:\\external\\other.txt',
  })))
  expect(openDocumentWindow).not.toHaveBeenCalled()
  expect(api.openDroppedPath).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# Disk')
})


it('opens a folder dropped from Windows Explorer as a workspace', async () => {
  const user = userEvent.setup()
  const droppedWorkspace = { name: 'notes', absolutePath: 'C:/external/notes' }
  const api = installApi({
    pathForDroppedFile: vi.fn(() => 'C:\\external\\notes'),
    inspectDroppedPath: vi.fn(async () => ({
      ok: true as const,
      value: { kind: 'directory' as const, absolutePath: 'C:\\external\\notes' },
    })),
    openDroppedPath: vi.fn(async () => ({
      ok: true as const,
      value: { workspace: droppedWorkspace, document: null },
    })),
  })
  render(<App />)

  const shell = (await screen.findByTestId('editor-host')).closest('.app-shell')!
  const folder = new File([], 'notes')
  fireEvent.drop(shell, { dataTransfer: { files: [folder] } })

  await user.click(await screen.findByRole('button', { name: '工作区' }))
  await waitFor(() => expect(api.openDroppedPath).toHaveBeenCalledWith('C:\\external\\notes'))
  expect(screen.queryByText('不支持的文件类型')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'notes' })).toBeVisible()
})
