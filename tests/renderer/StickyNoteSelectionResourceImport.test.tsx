import { forwardRef } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ArkdownApi, StickyNoteImportResult } from '../../src/shared/contracts'
import { stickyNoteApiStubs } from './sticky-note-api-stubs'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

vi.mock('../../src/renderer/editor/VisualEditor', () => ({
  VisualEditor: forwardRef(function FakeVisualEditor(props: {
    onStickyNoteSelection?(selection: unknown): void
    onCreateStickyNote?(): void
  }, _ref) {
    return (
      <button
        type="button"
        onClick={() => {
          props.onStickyNoteSelection?.({
            markdown: '![图片](C:\\workspace\\image.png)',
            localResources: [{
              originalReference: 'C:\\workspace\\image.png',
              absolutePath: 'C:\\workspace\\image.png',
            }],
            warnings: [],
          })
          props.onCreateStickyNote?.()
        }}
      >建立便签测试</button>
    )
  }),
}))

import { EditorPane } from '../../src/renderer/editor/EditorPane'

const NOTE_ID = '10000000-0000-4000-8000-000000000001'

function createAiConversationApiStubs() {
  return {
    startAiConversation: vi.fn(async (input: Parameters<ArkdownApi['startAiConversation']>[0]) => ({
      ok: true as const,
      value: { requestId: input.requestId, modelId: 'test-model', transcriptRevision: 1 },
    })),
    cancelAiConversation: vi.fn(async (_input: Parameters<ArkdownApi['cancelAiConversation']>[0]) => ({ ok: true as const, value: null })),
    getAiWorkspaceState: vi.fn(async () => ({
      ok: true as const,
      value: { workspaceId: 'test-workspace', workspaceGeneration: '1' },
    })),
    setAiConversationCapabilities: vi.fn(async (_input: Parameters<ArkdownApi['setAiConversationCapabilities']>[0]) => ({ ok: true as const, value: null })),
    submitAiAuthorizationResult: vi.fn(async (_input: Parameters<ArkdownApi['submitAiAuthorizationResult']>[0]) => ({ ok: true as const, value: null })),
    clearAiConversation: vi.fn(async (_input: Parameters<ArkdownApi['clearAiConversation']>[0]) => ({ ok: true as const, value: null })),
    notifyAiCurrentDocumentChanged: vi.fn(async (_input: Parameters<ArkdownApi['notifyAiCurrentDocumentChanged']>[0]) => ({ ok: true as const, value: null })),
    registerAiCurrentDocumentPort: vi.fn(async (_port: Parameters<ArkdownApi['registerAiCurrentDocumentPort']>[0]) => ({
      ok: true as const,
      value: { portGeneration: 1 },
    })),
    unregisterAiCurrentDocumentPort: vi.fn(async () => ({ ok: true as const, value: null })),
    registerAiOpenDocumentPort: vi.fn(async (_port: Parameters<ArkdownApi['registerAiOpenDocumentPort']>[0]) => ({
      ok: true as const,
      value: { documentHandle: 'test-document' },
    })),
    unregisterAiOpenDocumentPort: vi.fn(async (_documentHandle: string) => ({ ok: true as const, value: null })),
    openAiMessageLink: vi.fn(async (_target: string) => ({ ok: true as const, value: null })),
    onAiConversationEvent: vi.fn(() => () => undefined),
  }
}

function imported(): StickyNoteImportResult {
  const timestamp = '2026-08-01T00:00:00.000Z'
  return {
    note: {
      record: {
        id: NOTE_ID,
        name: '便签260801-壹',
        status: 'active',
        markdownRelativePath: `active/${NOTE_ID}/便签260801-壹.md`,
        resourcesRelativePath: `active/${NOTE_ID}/resources`,
        style: { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
        background: { ...DEFAULT_BACKGROUND_SETTINGS },
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: null,
        released: false,
        pinned: false,
        windowBounds: null,
        lastOpenedAt: null,
        fontSizePx: 13,
        lineSpacingMode: 'compact',
      },
      markdown: '![图片](resources/image.png)',
    },
    warnings: [],
  }
}

beforeEach(() => {
  window.arkdown = {
    ...window.arkdown,
    ...createAiConversationApiStubs(),
    ...stickyNoteApiStubs,
    onTranslationEvent: () => () => undefined,
  } as ArkdownApi
})

it('passes the frozen resource snapshot through main import before releasing the note', async () => {
  const calls: string[] = []
  const importStickyNoteSelection = vi.fn(async () => {
    calls.push('import')
    return { ok: true as const, value: imported() }
  })
  const releaseStickyNote = vi.fn(async () => {
    calls.push('release')
    return { ok: true as const, value: null }
  })
  window.arkdown = {
    ...window.arkdown,
    importStickyNoteSelection,
    releaseStickyNote,
  }

  render(
    <EditorPane
      documentKey="test.md"
      markdown="selection"
      onChange={() => undefined}
      onOpenLargeModelSettings={() => undefined}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: '建立便签测试' }))

  await waitFor(() => expect(releaseStickyNote).toHaveBeenCalledWith(NOTE_ID))
  expect(importStickyNoteSelection).toHaveBeenCalledWith({
    markdown: '![图片](C:\\workspace\\image.png)',
    localResources: [{
      originalReference: 'C:\\workspace\\image.png',
      absolutePath: 'C:\\workspace\\image.png',
    }],
  })
  expect(calls).toEqual(['import', 'release'])
})
