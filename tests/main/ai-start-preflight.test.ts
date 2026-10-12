import { expect, it, vi } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import { ModelProtocolError } from '../../src/main/models/model-errors'
import { PublicError } from '../../src/shared/public-errors'

it.each(['service-unavailable', 'network', 'cli-unavailable', 'cli-authentication', 'protocol-malformed'] as const)(
  'transports finite preflight %s evidence without provider prose', async reason => {
    const detail = { version: 1 as const, reason, stage: 'connect' as const, source: 'local' as const }
    const error = new ModelProtocolError('incompatible-response', undefined, detail)
    error.message = 'SECRET provider prose C:/private/key'
    const operations = createIpcOperations({
      chooseDirectory: async () => null, workspace: {} as never, documents: {} as never,
      getLastWorkspace: () => null, setLastWorkspace: vi.fn(), reportError: vi.fn(),
      desktopAi: { ownerId: 17, getWorkspaceAuthority: async () => ({ workspaceId: 'workspace.1', workspaceGeneration: 'generation.1' }) },
      aiConversations: { start: async () => { throw error } } as never,
    })
    const input = { requestId: '550e8400-e29b-41d4-a716-446655440003', conversationId: '550e8400-e29b-41d4-a716-446655440001',
      workspaceKey: 'workspace.1', acknowledgedTranscriptRevision: 0,
      messages: [{ id: '550e8400-e29b-41d4-a716-446655440002', role: 'user', content: 'synthetic question' }],
      capabilities: { currentDocument: false, workspace: false }, writePolicy: 'ask-every-time' }
    const response = await operations.startAiConversation(input)
    expect(response).toEqual({ ok: false, error: { code: 'MODEL_INCOMPATIBLE_RESPONSE', message: '大模型服务返回的响应格式不兼容', detail } })
    expect(JSON.stringify(response)).not.toContain('SECRET')
  },
)

it('keeps an unconfigured model distinct without adding speculative protocol detail', async () => {
  const operations = createIpcOperations({
    chooseDirectory: async () => null, workspace: {} as never, documents: {} as never,
    getLastWorkspace: () => null, setLastWorkspace: vi.fn(), reportError: vi.fn(),
    desktopAi: { ownerId: 17, getWorkspaceAuthority: async () => ({ workspaceId: 'workspace.1', workspaceGeneration: 'generation.1' }) },
    aiConversations: { start: async () => { throw new PublicError('AI_MODEL_NOT_CONFIGURED') } } as never,
  })
  expect(await operations.startAiConversation({ requestId: '550e8400-e29b-41d4-a716-446655440003',
    conversationId: '550e8400-e29b-41d4-a716-446655440001', workspaceKey: 'workspace.1', acknowledgedTranscriptRevision: 0,
    messages: [{ id: '550e8400-e29b-41d4-a716-446655440002', role: 'user', content: 'synthetic' }],
    capabilities: { currentDocument: false, workspace: false }, writePolicy: 'ask-every-time' })).toEqual({
    ok: false, error: { code: 'AI_MODEL_NOT_CONFIGURED', message: '尚未配置 AI 对话使用的大模型' },
  })
})
