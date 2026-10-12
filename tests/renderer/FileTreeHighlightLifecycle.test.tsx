import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { forwardRef, useImperativeHandle } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/app/App'
import { ContextMenuProvider } from '../../src/renderer/context-menu/ContextMenuProvider'
import { ContextWorkspaceSidebar } from '../../src/renderer/workspace/ContextWorkspaceSidebar'
import type { DocumentSnapshot, ArkdownApi } from '../../src/shared/contracts'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import { modelCommit } from '../helpers/model-observation'
import { stickyNoteApiStubs } from './sticky-note-api-stubs'
import { applicationMenuApiStubs } from './application-menu-api-stubs'

vi.mock('../../src/renderer/editor/EditorPane', () => ({
  EditorPane: forwardRef<
    { flush: () => string | null },
    { markdown: string; onChange: (markdown: string) => void }
  >(function EditorPane({ markdown, onChange }, ref) {
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

function snapshot(relativePath: string): DocumentSnapshot {
  return {
    relativePath,
    markdown: `# ${relativePath}`,
    revision: 'a'.repeat(64),
    encoding: 'utf8',
    newline: 'lf',
    mtimeMs: 1,
  }
}

function installApi(readDocument: ArkdownApi['readDocument']) {
  window.arkdown = {
    restoreWorkspace: vi.fn(async () => ({ ok: true as const, value: workspace })),
    chooseWorkspace: vi.fn(async () => ({ ok: true as const, value: workspace })),
    claimWorkspaceIntroduction: vi.fn(async () => ({ ok: true as const, value: { showIntroduction: false } })),
    listDirectory: vi.fn(async () => ({
      ok: true as const,
      value: [
        { name: 'first.md', relativePath: 'first.md', kind: 'document' as const },
        { name: 'large.md', relativePath: 'large.md', kind: 'document' as const },
      ],
    })),
    openDroppedPath: vi.fn(async () => ({
      ok: true as const,
      value: { workspace, document: null },
    })),
    pathForDroppedFile: vi.fn(() => ''),
    createDocument: vi.fn(async (relativePath) => ({
      ok: true as const,
      value: snapshot(relativePath),
    })),
    readDocument,
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
  }
}

beforeEach(() => {
  installApi(vi.fn(async (relativePath) => ({
    ok: true as const,
    value: snapshot(relativePath),
  })))
})

it('clears the workspace context selection when its menu closes', async () => {
  const user = userEvent.setup()
  render(
    <ContextMenuProvider>
      <ContextWorkspaceSidebar
        chooseWorkspace={vi.fn(async () => undefined)}
        currentDocument={null}
        isChoosing={false}
        listDirectory={vi.fn(async () => ({
          ok: true as const,
          value: [{ name: 'note.md', relativePath: 'note.md', kind: 'document' as const }],
        }))}
        markdown=""
        onCreateDocument={vi.fn(async () => true)}
        onOpenDocument={vi.fn()}
        onReloadDocument={vi.fn()}
        onRevealDocument={vi.fn()}
        onTrashDocument={vi.fn()}
        onWorkspaceMenuCommand={vi.fn(async () => undefined)}
        readDocument={vi.fn()}
        refreshVersion={0}
        workspace={{ name: 'notes', absolutePath: 'C:\\notes' }}
        workspaceError={null}
      />
    </ContextMenuProvider>,
  )

  const row = await screen.findByRole('button', { name: 'note.md' })
  fireEvent.contextMenu(row, { clientX: 80, clientY: 90 })
  expect(row).toHaveAttribute('data-context-selected', 'true')

  await user.keyboard('{Escape}')

  await waitFor(() => expect(row).not.toHaveAttribute('data-context-selected'))
})

it('highlights only the requested document while a large file is still loading', async () => {
  const user = userEvent.setup()
  let finishLargeRead!: (value: Awaited<ReturnType<ArkdownApi['readDocument']>>) => void
  const largeRead = new Promise<Awaited<ReturnType<ArkdownApi['readDocument']>>>((resolve) => {
    finishLargeRead = resolve
  })
  installApi(vi.fn(async (relativePath) => {
    if (relativePath === 'large.md') return largeRead
    return { ok: true as const, value: snapshot(relativePath) }
  }))

  render(<App />)
  await user.click(screen.getByRole('button', { name: '选择工作区' }))

  const first = await screen.findByRole('button', { name: 'first.md' })
  const large = await screen.findByRole('button', { name: 'large.md' })
  await user.click(first)
  await waitFor(() => expect(first).toHaveAttribute('aria-current', 'page'))

  await user.click(large)

  expect(first).not.toHaveAttribute('aria-current')
  expect(large).toHaveAttribute('aria-current', 'page')

  finishLargeRead({ ok: true, value: snapshot('large.md') })
  await waitFor(() => expect(large).toHaveAttribute('aria-current', 'page'))
})
