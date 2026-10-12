import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { forwardRef, useImperativeHandle } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/app/App'
import type { ArkdownApi } from '../../src/shared/contracts'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import { modelCommit } from '../helpers/model-observation'
import { stickyNoteApiStubs } from './sticky-note-api-stubs'
import { applicationMenuApiStubs } from './application-menu-api-stubs'
import {
  documentPreviewLines,
  extractOutline,
  searchWorkspaceDocuments,
  visibleOutlineItems,
} from '../../src/renderer/workspace/workspace-navigation'

const searchFindBridge = vi.hoisted(() => ({ request: null as null | {
  id: number; documentKey: string; query: string; isCurrent(): boolean
} }))

vi.mock('../../src/renderer/editor/EditorPane', () => ({
  EditorPane: forwardRef<
    { flush: () => string | null },
    { markdown: string; onChange: (markdown: string) => void; findRequest?: typeof searchFindBridge.request }
  >(function EditorPane({ markdown, onChange, findRequest }, ref) {
    searchFindBridge.request = findRequest ?? null
    useImperativeHandle(ref, () => ({ flush: () => null }))
    return <textarea
      aria-label="Markdown editor"
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

function installApi(overrides: Partial<ArkdownApi> = {}) {
  window.arkdown = {
    claimWorkspaceIntroduction: vi.fn(async () => ({ ok: true as const, value: { showIntroduction: false } })),
    restoreWorkspace: vi.fn(async () => ({ ok: true as const, value: workspace })),
    chooseWorkspace: vi.fn(async () => ({ ok: true as const, value: workspace })),
    listDirectory: vi.fn(async (relativePath: string) => ({
      ok: true as const,
      value: relativePath === ''
        ? [
            { name: 'docs', relativePath: 'docs', kind: 'directory' as const },
            { name: 'root.md', relativePath: 'root.md', kind: 'document' as const },
          ]
        : [{ name: 'guide.md', relativePath: 'docs/guide.md', kind: 'document' as const }],
    })),
    readDocument: vi.fn(async (relativePath: string) => ({
      ok: true as const,
      value: {
        relativePath,
        markdown: '# Title\n\n## Details\n\nworkspace keyword',
        revision: 'a'.repeat(64),
        encoding: 'utf8' as const,
        newline: 'lf' as const,
        mtimeMs: 1,
      },
    })),
    peekDocument: vi.fn(async (relativePath: string) => ({
      ok: true as const,
      value: {
        relativePath,
        markdown: '# Title\n\n## Details\n\nworkspace keyword',
        revision: 'a'.repeat(64),
        encoding: 'utf8' as const,
        newline: 'lf' as const,
        mtimeMs: 1,
      },
    })),
    saveDocument: vi.fn(async () => ({
      ok: true as const,
      value: { revision: 'b'.repeat(64), mtimeMs: 2 },
    })),
    openDroppedPath: vi.fn(async () => ({
      ok: true as const, value: { workspace, document: null },
    })),
    pathForDroppedFile: vi.fn(() => ''),
    createDocument: vi.fn(async (relativePath: string) => ({
      ok: true as const,
      value: { relativePath, markdown: '', revision: 'a'.repeat(64),
        encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 1 },
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
  } satisfies ArkdownApi
}

beforeEach(installApi)

it('hands body-search queries to the successful document and invalidates earlier clicks', async () => {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: '搜索工作区' }))
  await user.type(screen.getByRole('searchbox', { name: '搜索工作区' }), 'keyword{Enter}')
  const result = await screen.findByRole('button', { name: /root.md.*workspace keyword/ })
  await user.click(result)
  await waitFor(() => expect(searchFindBridge.request).toMatchObject({
    documentKey: 'C:/Notes/root.md', query: 'keyword',
  }))
  const first = searchFindBridge.request!
  expect(first.isCurrent()).toBe(true)
  await user.click(result)
  await waitFor(() => expect(searchFindBridge.request?.id).not.toBe(first.id))
  expect(first.isCurrent()).toBe(false)
  const second = searchFindBridge.request!
  await user.click(screen.getByRole('button', { name: '取消搜索' }))
  await user.click(screen.getByRole('button', { name: '搜索工作区' }))
  await user.type(screen.getByRole('searchbox', { name: '搜索工作区' }), 'root{Enter}')
  await user.click(await screen.findByRole('button', { name: /root.md.*workspace keyword/ }))
  expect(searchFindBridge.request).toBeNull()
  expect(second.isCurrent()).toBe(false)
})

it('marks filename-only and body matches independently, including unreadable files', async () => {
  const result = await searchWorkspaceDocuments({
    query: 'keyword',
    listDirectory: async () => ({ ok: true, value: ['body.md', 'keyword.md', 'keyword-failed.md'].map((relativePath) => ({
      name: relativePath, relativePath, kind: 'document' as const,
    })) }),
    readDocument: async (relativePath) => relativePath.endsWith('failed.md')
      ? { ok: false, error: { code: 'READ_FAILED', message: 'failed' } }
      : { ok: true, value: { relativePath, markdown: relativePath === 'body.md' ? 'KEYWORD' : 'other', revision: 'a'.repeat(64), encoding: 'utf8', newline: 'lf', mtimeMs: 1 } },
  })
  expect(result.matches.map((match) => [match.relativePath, match.contentMatches])).toEqual([
    ['body.md', true], ['keyword.md', false], ['keyword-failed.md', false],
  ])
})

it('does not hand off failed opens or a slow result superseded by another click', async () => {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: '搜索工作区' }))
  await user.type(screen.getByRole('searchbox', { name: '搜索工作区' }), 'keyword{Enter}')
  const root = await screen.findByRole('button', { name: /root.md.*workspace keyword/ })
  window.arkdown.readDocument = vi.fn(async () => ({ ok: false as const, error: { code: 'READ_FAILED', message: 'open failed' } }))
  await user.click(root)
  expect(searchFindBridge.request).toBeNull()
  let resolveSlow!: (result: Awaited<ReturnType<ArkdownApi['readDocument']>>) => void
  const slow = new Promise<Awaited<ReturnType<ArkdownApi['readDocument']>>>((resolve) => { resolveSlow = resolve })
  window.arkdown.readDocument = vi.fn((path) => path === 'root.md' ? slow : window.arkdown.peekDocument(path))
  await user.click(root)
  await user.click(screen.getByRole('button', { name: '搜索更多层级文件夹' }))
  await user.click(await screen.findByRole('button', { name: /guide.md.*workspace keyword/ }))
  await waitFor(() => expect(searchFindBridge.request?.documentKey).toBe('C:/Notes/docs/guide.md'))
  const latest = searchFindBridge.request
  await act(async () => resolveSlow(await window.arkdown.peekDocument('root.md')))
  expect(searchFindBridge.request).toBe(latest)
  expect(latest?.isCurrent()).toBe(true)
})

it('cancels dirty search navigation without finding in the retained document', async () => {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'root.md' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown editor' }), { target: { value: '# dirty' } })
  await user.click(screen.getByRole('button', { name: '搜索工作区' }))
  await user.type(screen.getByRole('searchbox', { name: '搜索工作区' }), 'keyword{Enter}')
  await user.click(await screen.findByRole('button', { name: '搜索更多层级文件夹' }))
  await user.click(await screen.findByRole('button', { name: /guide.md.*workspace keyword/ }))
  const dialog = await screen.findByRole('dialog', { name: '是否保存对“root.md”的更改？' })
  await user.click(within(dialog).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  expect(searchFindBridge.request).toBeNull()
  expect(screen.getByRole('textbox', { name: 'Markdown editor' })).toHaveValue('# dirty')
})

it('invalidates a ready-to-find request when leaving its workspace', async () => {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: '搜索工作区' }))
  await user.type(screen.getByRole('searchbox', { name: '搜索工作区' }), 'keyword{Enter}')
  await user.click(await screen.findByRole('button', { name: /root.md.*workspace keyword/ }))
  await waitFor(() => expect(searchFindBridge.request?.isCurrent()).toBe(true))
  const request = searchFindBridge.request!
  window.arkdown.chooseWorkspace = vi.fn(async () => ({ ok: true as const, value: { name: 'Other', absolutePath: 'C:/Other' } }))
  await user.click(screen.getByRole('button', { name: 'Notes' }))
  await screen.findByRole('button', { name: 'Other' })
  expect(request.isCurrent()).toBe(false)
})

it('retains the current file selection without remounting the tree container after reload', async () => {
  const user = userEvent.setup()
  const listDirectory = vi.fn(async (relativePath: string) => ({
    ok: true as const,
    value: relativePath === ''
      ? [{ name: 'root.md', relativePath: 'root.md', kind: 'document' as const }]
      : [],
  }))
  installApi({ listDirectory })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  const rootDocument = await screen.findByRole('button', { name: 'root.md' })
  await user.click(rootDocument)
  expect(await screen.findByRole('button', { name: 'root.md' }))
    .toHaveAttribute('aria-current', 'page')
  const treeContainer = document.querySelector('.workspace-tree-context')
  listDirectory.mockClear()

  await user.click(screen.getByRole('button', { name: '从磁盘重新加载' }))

  await waitFor(() => expect(listDirectory).toHaveBeenCalledOnce())
  expect(await screen.findByRole('button', { name: 'root.md' }))
    .toHaveAttribute('aria-current', 'page')
  expect(document.querySelector('.workspace-tree-context')).toBe(treeContainer)
})

it('keeps the expanded ancestors and nested current file visible after reload', async () => {
  const user = userEvent.setup()
  const listDirectory = vi.fn(async (relativePath: string) => ({
    ok: true as const,
    value: relativePath === ''
      ? [{ name: 'docs', relativePath: 'docs', kind: 'directory' as const }]
      : [{ name: 'note.md', relativePath: 'docs/note.md', kind: 'document' as const }],
  }))
  installApi({ listDirectory })
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))
  await user.click(await screen.findByRole('button', { name: 'docs' }))
  await user.click(await screen.findByRole('button', { name: 'note.md' }))
  expect(screen.getByRole('button', { name: 'note.md' }))
    .toHaveAttribute('aria-current', 'page')
  listDirectory.mockClear()

  await user.click(screen.getByRole('button', { name: '从磁盘重新加载' }))

  await waitFor(() => {
    expect(listDirectory).toHaveBeenCalledWith('')
    expect(listDirectory).toHaveBeenCalledWith('docs')
  })
  expect(await screen.findByRole('button', { name: 'docs' }))
    .toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('button', { name: 'note.md' }))
    .toHaveAttribute('aria-current', 'page')
})

it('searches document names and Markdown content across nested folders', async () => {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))

  await user.click(await screen.findByRole('button', { name: '搜索工作区' }))
  const search = screen.getByRole('searchbox', { name: '搜索工作区' })
  await user.type(search, 'keyword')
  expect(window.arkdown.readDocument).not.toHaveBeenCalled()
  expect(window.arkdown.peekDocument).not.toHaveBeenCalled()
  await user.keyboard('{Enter}')

  expect(await screen.findByRole('button', { name: /root\.md/ })).toBeVisible()
  expect(window.arkdown.peekDocument).toHaveBeenCalledWith('root.md')
  expect(window.arkdown.peekDocument).not.toHaveBeenCalledWith('docs/guide.md')
  await user.click(screen.getByRole('button', { name: '搜索更多层级文件夹' }))
  expect(await screen.findByRole('button', { name: /docs\/guide\.md/ })).toBeVisible()
  expect(window.arkdown.peekDocument).toHaveBeenCalledWith('docs/guide.md')
  expect(window.arkdown.readDocument).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '取消搜索' }))
  expect(screen.queryByRole('searchbox', { name: '搜索工作区' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /docs\/guide\.md/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('navigation', { name: '侧边栏视图' })).not.toBeInTheDocument()
  expect(document.querySelector('.workspace-tree-context')).toBeVisible()
})


it('builds three body preview lines without repeating headings', () => {
  expect(documentPreviewLines(
    '# Title\n\nFirst body line\n\n## Section\nSecond line\n- Third line\nFourth line',
  )).toEqual(['First body line', 'Second line', 'Third line'])
})

it('hides descendants of collapsed outline headings', () => {
  const outline = extractOutline('# One\n## Two\n### Three\n# Four')
  expect(visibleOutlineItems(outline, new Set([0])).map((item) => item.text))
    .toEqual(['One', 'Four'])
})

it('searches direct documents before nested folders when the limit is reached', async () => {
  const listDirectory = vi.fn(async (relativePath: string) => ({
    ok: true as const,
    value: relativePath === ''
      ? [
          { name: 'nested', relativePath: 'nested', kind: 'directory' as const },
          { name: 'root-hit.md', relativePath: 'root-hit.md', kind: 'document' as const },
          { name: 'root-other.md', relativePath: 'root-other.md', kind: 'document' as const },
        ]
      : [
          { name: 'nested-hit.md', relativePath: 'nested/nested-hit.md', kind: 'document' as const },
        ],
  }))
  const readDocument = vi.fn(async (relativePath: string) => ({
    ok: true as const,
    value: {
      relativePath,
      markdown: relativePath.includes('hit') ? 'needle' : 'other',
      revision: 'a'.repeat(64),
      encoding: 'utf8' as const,
      newline: 'lf' as const,
      mtimeMs: 1,
    },
  }))

  const result = await searchWorkspaceDocuments({
    query: 'needle',
    listDirectory,
    readDocument,
    limit: 2,
  })

  expect(result).toMatchObject({
    truncated: true,
    matches: [{ relativePath: 'root-hit.md' }],
  })
  expect(readDocument).toHaveBeenCalledWith('root-hit.md')
  expect(readDocument).toHaveBeenCalledWith('root-other.md')
  expect(readDocument).not.toHaveBeenCalledWith('nested/nested-hit.md')
})

it.each([
  [500, false],
  [501, true],
] as const)('reports whether a %i-document search exceeds the 500 document cap', async (
  documentCount,
  truncated,
) => {
  const entries = Array.from({ length: documentCount }, (_, index) => ({
    name: `doc-${String(index).padStart(3, '0')}.md`,
    relativePath: `doc-${String(index).padStart(3, '0')}.md`,
    kind: 'document' as const,
  }))
  const result = await searchWorkspaceDocuments({
    query: 'not-present',
    limit: 500,
    listDirectory: vi.fn(async () => ({ ok: true as const, value: entries })),
    readDocument: vi.fn(async (relativePath: string) => ({
      ok: true as const,
      value: {
        relativePath,
        markdown: '',
        revision: 'a'.repeat(64),
        encoding: 'utf8' as const,
        newline: 'lf' as const,
        mtimeMs: 1,
      },
    })),
  })

  expect(result.truncated).toBe(truncated)
  expect(result.matches).toEqual([])
})

it('keeps a filename match when document content cannot be read', async () => {
  const result = await searchWorkspaceDocuments({
    query: '华味',
    listDirectory: vi.fn(async () => ({
      ok: true as const,
      value: [{
        name: '华味资料.docx',
        relativePath: '华味资料.docx',
        kind: 'document' as const,
      }],
    })),
    readDocument: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'UNSUPPORTED_FILE_TYPE' as const, message: '不支持的文件类型' },
    })),
  })

  expect(result).toEqual({
    failedDirectories: [],
    failedDocuments: ['华味资料.docx'],
    truncated: false,
    matches: [{
      relativePath: '华味资料.docx',
      title: '华味资料.docx',
      preview: '文件名匹配（正文读取失败）',
      contentMatches: false,
    }],
  })
})
