import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { useEffect, useLayoutEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type {
  AiCurrentDocumentRendererPort, ApiResult, AiWorkspaceState,
} from '../../src/shared/contracts'
import {
  WorkspaceAiConversationProvider,
  useWorkspaceAiConversationController,
} from '../../src/renderer/editor/WorkspaceAiConversationProvider'

type AuthoritativeWorkspaceController = ReturnType<typeof useWorkspaceAiConversationController> & {
  acceptWorkspaceAuthority(binding: AiWorkspaceState): void
}

function success<T>(value: T): ApiResult<T> {
  return { ok: true, value }
}

describe('WorkspaceAiConversationProvider', () => {
  it('starts without a fallback session so the first workspace selection is never gated', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <WorkspaceAiConversationProvider api={{
        getAiWorkspaceState: vi.fn(async () => success({
          workspaceId: 'workspace-a', workspaceGeneration: 'generation-1',
        })),
      }}>
        {children}
      </WorkspaceAiConversationProvider>
    )
    const { result } = renderHook(useWorkspaceAiConversationController, { wrapper })

    expect(result.current.activeWorkspace).toBeNull()
    expect(result.current.store.sessions.size).toBe(0)
    expect(result.current.hasNonEmptyActiveConversation()).toBe(false)
  })

  it('keeps workspace sessions above child remounts and restores by stable workspaceId', async () => {
    const getAiWorkspaceState = vi.fn()
      .mockResolvedValueOnce(success<AiWorkspaceState>({
        workspaceId: 'workspace-a',
        workspaceGeneration: 'generation-1',
      }))
      .mockResolvedValueOnce(success<AiWorkspaceState>({
        workspaceId: 'workspace-b',
        workspaceGeneration: 'generation-1',
      }))
      .mockResolvedValueOnce(success<AiWorkspaceState>({
        workspaceId: 'workspace-a',
        workspaceGeneration: 'generation-2',
      }))
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <WorkspaceAiConversationProvider api={{ getAiWorkspaceState }}>
        {children}
      </WorkspaceAiConversationProvider>
    )
    const { result } = renderHook(useWorkspaceAiConversationController, { wrapper })

    await act(async () => { await result.current.activateCurrentWorkspace() })
    result.current.activeSession!.messages.push({
      id: 'message-a', role: 'user', content: 'workspace A history',
    })
    await act(async () => { await result.current.activateCurrentWorkspace() })
    expect(result.current.activeSession?.workspaceId).toBe('workspace-b')
    await act(async () => { await result.current.activateCurrentWorkspace() })

    expect(result.current.activeSession?.workspaceId).toBe('workspace-a')
    expect(result.current.activeSession?.workspaceGeneration).toBe('generation-2')
    expect(result.current.activeSession?.messages.map(({ content }) => content))
      .toEqual(['workspace A history'])
  })

  it('revokes pending workspace authority when the active workspace becomes null', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <WorkspaceAiConversationProvider api={{
        getAiWorkspaceState: vi.fn(async () => success({
          workspaceId: 'workspace-a', workspaceGeneration: 'generation-1',
        })),
      }}>
        {children}
      </WorkspaceAiConversationProvider>
    )
    const { result } = renderHook(useWorkspaceAiConversationController, { wrapper })
    await act(async () => { await result.current.activateCurrentWorkspace() })
    result.current.activeSession!.clearing = true
    result.current.activeSession!.capabilities = { currentDocument: true, workspace: true }

    act(() => result.current.deactivateWorkspace())

    expect(result.current.activeWorkspace).toBeNull()
    const retained = result.current.store.sessions.get('workspace-a')!
    expect(retained.clearing).toBe(false)
    expect(retained.capabilities).toEqual({ currentDocument: true, workspace: true })
    expect(retained.authoritativeCapabilities).toEqual({ currentDocument: false, workspace: false })
  })

  it('deactivates the old binding before resolving a replacement and stays inactive on failure', async () => {
    let rejectReplacement!: (value: ApiResult<AiWorkspaceState>) => void
    const replacement = new Promise<ApiResult<AiWorkspaceState>>((resolve) => {
      rejectReplacement = resolve
    })
    const getAiWorkspaceState = vi.fn()
      .mockResolvedValueOnce(success<AiWorkspaceState>({
        workspaceId: 'workspace-a', workspaceGeneration: 'generation-1',
      }))
      .mockReturnValueOnce(replacement)
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <WorkspaceAiConversationProvider api={{ getAiWorkspaceState }}>
        {children}
      </WorkspaceAiConversationProvider>
    )
    const { result } = renderHook(useWorkspaceAiConversationController, { wrapper })
    await act(async () => { await result.current.activateCurrentWorkspace() })
    const retained = result.current.activeSession!
    retained.messages.push({ id: 'kept', role: 'user', content: 'workspace A' })

    let activation!: Promise<ApiResult<AiWorkspaceState>>
    act(() => { activation = result.current.activateCurrentWorkspace() })
    expect(result.current.activeWorkspace).toBeNull()
    expect(result.current.store.sessions.get('workspace-a')).toBe(retained)
    expect(retained.messages.map(({ content }) => content)).toEqual(['workspace A'])

    rejectReplacement({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: 'workspace lookup failed' },
    })
    await act(async () => { await activation })
    expect(result.current.activeWorkspace).toBeNull()
    expect(result.current.store.sessions.get('workspace-a')).toBe(retained)
  })

  it('synchronously accepts committed authority without clearing either workspace transcript', async () => {
    const getAiWorkspaceState = vi.fn()
      .mockResolvedValueOnce(success<AiWorkspaceState>({
        workspaceId: 'workspace-a', workspaceGeneration: 'generation-1',
      }))
      .mockResolvedValueOnce(success<AiWorkspaceState>({
        workspaceId: 'workspace-b', workspaceGeneration: 'generation-1',
      }))
      .mockResolvedValueOnce(success<AiWorkspaceState>({
        workspaceId: 'workspace-a', workspaceGeneration: 'generation-2',
      }))
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <WorkspaceAiConversationProvider api={{ getAiWorkspaceState }}>
        {children}
      </WorkspaceAiConversationProvider>
    )
    const hook = renderHook(useWorkspaceAiConversationController, { wrapper })

    await act(async () => { await hook.result.current.activateCurrentWorkspace() })
    const source = hook.result.current.activeSession!
    source.messages.push({ id: 'source-complete', role: 'assistant', content: 'source history' })
    source.capabilities = { currentDocument: true, workspace: true }
    await act(async () => { await hook.result.current.activateCurrentWorkspace() })
    const target = hook.result.current.activeSession!
    target.messages.push({ id: 'target-complete', role: 'user', content: 'target history' })
    await act(async () => { await hook.result.current.activateCurrentWorkspace() })

    act(() => {
      (hook.result.current as AuthoritativeWorkspaceController).acceptWorkspaceAuthority({
        workspaceId: 'workspace-b', workspaceGeneration: 'generation-2',
      })
    })

    expect(hook.result.current.activeWorkspace).toEqual({
      workspaceId: 'workspace-b', workspaceGeneration: 'generation-2',
    })
    expect(hook.result.current.activeSession).toBe(target)
    expect(target.messages.map(({ content }) => content)).toEqual(['target history'])
    expect(source.messages.map(({ content }) => content)).toEqual(['source history'])
    expect(source.capabilities).toEqual({ currentDocument: true, workspace: true })
    expect(source.authoritativeCapabilities).toEqual({ currentDocument: false, workspace: false })
  })

  it('keeps one current-document port across keyed panes, retries preload transitions, and preserves loaded policy', async () => {
    const workspace: AiWorkspaceState = {
      workspaceId: 'workspace-a',
      workspaceGeneration: 'generation-1',
    }
    let registeredPort: AiCurrentDocumentRendererPort | null = null
    const registerAiCurrentDocumentPort = vi.fn(async (port: AiCurrentDocumentRendererPort) => {
      registeredPort = port
      if (registerAiCurrentDocumentPort.mock.calls.length === 1) {
        return {
          ok: false as const,
          error: { code: 'OPERATION_FAILED' as const, message: 'transition in progress' },
        }
      }
      return success({ portGeneration: 1 })
    })
    const unregisterAiCurrentDocumentPort = vi.fn(async () => success(null))
    const api = {
      getAiWorkspaceState: vi.fn(async () => success(workspace)),
      notifyAiCurrentDocumentChanged: vi.fn(async () => success(null)),
      registerAiCurrentDocumentPort,
      unregisterAiCurrentDocumentPort,
    }

    function Pane({ markdown }: { markdown: string }) {
      const controller = useWorkspaceAiConversationController()
      useLayoutEffect(() => controller.bindCurrentDocumentSource(() => ({
        markdown,
        displayName: 'note.md',
        sourceFormat: 'md',
        dirty: true,
      }), workspace), [controller.bindCurrentDocumentSource, markdown])
      return null
    }
    function Harness({ paneKey, markdown }: { paneKey: string; markdown: string }) {
      const controller = useWorkspaceAiConversationController()
      useEffect(() => { void controller.activateCurrentWorkspace() }, [
        controller.activateCurrentWorkspace,
      ])
      useEffect(() => controller.setGlobalWritePolicy('document-grant'), [
        controller.setGlobalWritePolicy,
      ])
      return <>
        <output data-testid="write-policy">{controller.globalWritePolicy ?? 'loading'}</output>
        <Pane key={paneKey} markdown={markdown} />
      </>
    }

    const view = render(
      <WorkspaceAiConversationProvider api={api}>
        <Harness paneKey="one" markdown="# first" />
      </WorkspaceAiConversationProvider>,
    )
    await waitFor(() => expect(registerAiCurrentDocumentPort).toHaveBeenCalledTimes(2))
    expect(registerAiCurrentDocumentPort.mock.calls[0]![0])
      .toBe(registerAiCurrentDocumentPort.mock.calls[1]![0])
    expect(screen.getByTestId('write-policy')).toHaveTextContent('document-grant')

    view.rerender(
      <WorkspaceAiConversationProvider api={api}>
        <Harness paneKey="two" markdown="# second unsaved" />
      </WorkspaceAiConversationProvider>,
    )
    await waitFor(async () => {
      const snapshot = await registeredPort!.openSnapshot({ cursor: 0, maxChars: 100 })
      expect(snapshot).toMatchObject({ status: 'captured', content: '# second unsaved' })
    })
    expect(unregisterAiCurrentDocumentPort).not.toHaveBeenCalled()

    view.unmount()
    await waitFor(() => expect(unregisterAiCurrentDocumentPort).toHaveBeenCalledOnce())
  })

  it('keeps a replacement document unavailable until its main-process epoch is acknowledged', async () => {
    const workspace: AiWorkspaceState = {
      workspaceId: 'workspace-a', workspaceGeneration: 'generation-1',
    }
    const replacementNotification = (() => {
      let resolve!: (value: ApiResult<null>) => void
      const promise = new Promise<ApiResult<null>>((complete) => { resolve = complete })
      return { promise, resolve }
    })()
    let notifyCount = 0
    let registeredPort: AiCurrentDocumentRendererPort | null = null
    const api = {
      getAiWorkspaceState: vi.fn(async () => success(workspace)),
      notifyAiCurrentDocumentChanged: vi.fn(async () => {
        notifyCount += 1
        return notifyCount === 1 ? success(null) : replacementNotification.promise
      }),
      registerAiCurrentDocumentPort: vi.fn(async (port: AiCurrentDocumentRendererPort) => {
        registeredPort = port
        return success({ portGeneration: 1 })
      }),
      unregisterAiCurrentDocumentPort: vi.fn(async () => success(null)),
    }
    function Harness({ markdown }: { markdown: string }) {
      const controller = useWorkspaceAiConversationController()
      useEffect(() => { void controller.activateCurrentWorkspace() }, [
        controller.activateCurrentWorkspace,
      ])
      const activeWorkspace = controller.activeWorkspace
      useLayoutEffect(() => {
        if (!activeWorkspace) return
        return controller.bindCurrentDocumentSource(() => ({
          markdown, displayName: `${markdown}.md`, sourceFormat: 'md', dirty: true,
          sourceId: markdown,
        }), activeWorkspace, markdown)
      }, [
        activeWorkspace?.workspaceGeneration,
        activeWorkspace?.workspaceId,
        controller.bindCurrentDocumentSource,
        markdown,
      ])
      return null
    }
    const view = render(
      <WorkspaceAiConversationProvider api={api}>
        <Harness markdown="A" />
      </WorkspaceAiConversationProvider>,
    )
    await waitFor(() => expect(registeredPort).not.toBeNull())
    let first!: Awaited<ReturnType<AiCurrentDocumentRendererPort['openSnapshot']>>
    await waitFor(async () => {
      first = await registeredPort!.openSnapshot({ cursor: 0, maxChars: 1 })
      expect(first).toMatchObject({ status: 'captured', content: 'A' })
    })
    expect(first).toMatchObject({ status: 'captured', content: 'A' })
    if (first.status !== 'captured') throw new Error('expected captured snapshot')

    view.rerender(
      <WorkspaceAiConversationProvider api={api}>
        <Harness markdown="B" />
      </WorkspaceAiConversationProvider>,
    )
    await waitFor(() => expect(api.notifyAiCurrentDocumentChanged).toHaveBeenCalledTimes(2))
    expect(await registeredPort!.openSnapshot({ cursor: 0, maxChars: 1 }))
      .toEqual({ status: 'unavailable' })
    expect(await registeredPort!.readPage({
      snapshotId: first.snapshotId, cursor: 0, maxChars: 1,
    })).toMatchObject({ status: 'captured', content: 'A' })

    replacementNotification.resolve(success(null))
    await waitFor(async () => expect(await registeredPort!.openSnapshot({ cursor: 0, maxChars: 1 }))
      .toMatchObject({ status: 'captured', content: 'B' }))
    // A request already submitted with A's identity must not capture B even after B is acknowledged.
    expect(await registeredPort!.openSnapshot({ cursor: 0, maxChars: 1, expectedDocumentId: 'A' }))
      .toEqual({ status: 'unavailable' })
    expect(await registeredPort!.openSnapshot({ cursor: 0, maxChars: 1, expectedDocumentId: 'B' }))
      .toMatchObject({ status: 'captured', content: 'B' })
  })
})
