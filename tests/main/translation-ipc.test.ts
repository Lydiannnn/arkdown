import { expect, it, vi } from 'vitest'
import { createIpcOperations, registerIpcHandlers } from '../../src/main/ipc/register-ipc'
import { IPC_CHANNELS } from '../../src/shared/contracts'

const requestId = '123e4567-e89b-42d3-a456-426614174000'

function translationOperations(translations: {
  start: (input: unknown) => Promise<unknown>
  cancel: (requestId: string) => Promise<void>
}) {
  return createIpcOperations({
    chooseDirectory: vi.fn(),
    workspace: {} as never,
    documents: {} as never,
    translations,
    getLastWorkspace: () => null,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
  } as never)
}

function registrar() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  }
}

it('validates and forwards strict translation start and cancel inputs', async () => {
  const translations = {
    start: vi.fn().mockResolvedValue({ requestId, targetLanguage: 'en', modelId: 'chat-model' }),
    cancel: vi.fn().mockResolvedValue(undefined),
  }
  const operations = translationOperations(translations)
  const input = {
    documentKey: 'notes/note.md',
    content: { markdown: '**你好**', plainText: '你好' },
    mode: 'visual',
  }

  await expect(operations.startTranslation(input)).resolves.toEqual({
    ok: true,
    value: { requestId, targetLanguage: 'en', modelId: 'chat-model' },
  })
  await expect(operations.cancelTranslation({ requestId })).resolves.toEqual({
    ok: true,
    value: null,
  })
  expect(translations.start).toHaveBeenCalledWith(input)
  expect(translations.cancel).toHaveBeenCalledWith(requestId)
})

it('rejects non-own, unknown, missing, mistyped, empty, and oversized start fields', async () => {
  const translations = { start: vi.fn(), cancel: vi.fn() }
  const operations = translationOperations(translations)
  const valid = {
    documentKey: 'notes/note.md',
    content: { markdown: '**hello**', plainText: 'hello' },
    mode: 'source',
  }
  const inherited = Object.create({ documentKey: valid.documentKey })
  Object.assign(inherited, { content: valid.content, mode: valid.mode })
  const inheritedContent = Object.create({ markdown: valid.content.markdown })
  Object.assign(inheritedContent, { plainText: valid.content.plainText })

  for (const input of [
    inherited,
    { ...valid, extra: 'secret' },
    { content: valid.content, mode: valid.mode },
    { ...valid, documentKey: 42 },
    { ...valid, documentKey: ' \t ' },
    { ...valid, documentKey: 'a'.repeat(32_768) },
    { ...valid, content: inheritedContent },
    { ...valid, content: { ...valid.content, extra: 'secret' } },
    { ...valid, content: { markdown: valid.content.markdown } },
    { ...valid, content: { plainText: valid.content.plainText } },
    { ...valid, content: null },
    { ...valid, content: [] },
    { ...valid, content: { markdown: 42, plainText: valid.content.plainText } },
    { ...valid, content: { markdown: valid.content.markdown, plainText: 42 } },
    { ...valid, content: { markdown: '\r\n\t ', plainText: valid.content.plainText } },
    { ...valid, content: { markdown: 'a'.repeat(200_001), plainText: 'valid' } },
    { ...valid, content: { markdown: 'valid', plainText: 'a'.repeat(200_001) } },
    { ...valid, mode: 'markdown' },
  ]) {
    const result = await operations.startTranslation(input)
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain(valid.documentKey)
  }
  expect(translations.start).not.toHaveBeenCalled()
})

it.each([
  ['empty', ''],
  ['whitespace-only', ' \r\n\t '],
] as const)('accepts and preserves %s plain-text summary', async (_label, plainText) => {
  const translations = {
    start: vi.fn().mockResolvedValue({ requestId, targetLanguage: 'fr', modelId: 'chat-model' }),
    cancel: vi.fn().mockResolvedValue(undefined),
  }
  const operations = translationOperations(translations)
  const input = {
    documentKey: 'note.md',
    content: { markdown: '---', plainText },
    mode: 'source',
  }

  await expect(operations.startTranslation(input)).resolves.toMatchObject({ ok: true })
  expect(translations.start).toHaveBeenCalledWith(input)
})

it('accepts start boundary lengths and rejects noncanonical cancel request IDs', async () => {
  const translations = {
    start: vi.fn().mockResolvedValue({ requestId, targetLanguage: 'fr', modelId: 'chat-model' }),
    cancel: vi.fn().mockResolvedValue(undefined),
  }
  const operations = translationOperations(translations)

  await expect(operations.startTranslation({
    documentKey: 'd'.repeat(32_767),
    content: { markdown: 'm'.repeat(200_000), plainText: 'plain' },
    mode: 'visual',
  })).resolves.toMatchObject({ ok: true })
  await expect(operations.startTranslation({
    documentKey: 'document.md',
    content: { markdown: 'markdown', plainText: 'p'.repeat(200_000) },
    mode: 'source',
  })).resolves.toMatchObject({ ok: true })

  for (const candidate of [
    '',
    requestId.toUpperCase(),
    '123e4567-e89b-02d3-a456-426614174000',
    `${requestId}x`,
    42,
  ]) {
    await expect(operations.cancelTranslation({ requestId: candidate }))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  }
  const inherited = Object.create({ requestId })
  await expect(operations.cancelTranslation(inherited))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  await expect(operations.cancelTranslation({ requestId, extra: true }))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(translations.cancel).not.toHaveBeenCalled()
})

it('routes translation invokes only to the requesting window service', async () => {
  const ipcMain = registrar()
  const firstWebContents = { mainFrame: {} }
  const secondWebContents = { mainFrame: {} }
  const firstStart = vi.fn().mockResolvedValue({
    ok: true, value: { requestId, targetLanguage: 'en', modelId: 'first-model' },
  })
  const secondStart = vi.fn().mockResolvedValue({
    ok: true, value: { requestId, targetLanguage: 'fr', modelId: 'second-model' },
  })
  const first = registerIpcHandlers({
    ipcMain,
    window: { webContents: firstWebContents },
    operations: { startTranslation: firstStart },
  })
  const second = registerIpcHandlers({
    ipcMain,
    window: { webContents: secondWebContents },
    operations: { startTranslation: secondStart },
  })
  const handler = ipcMain.handlers.get(IPC_CHANNELS.startTranslation)!
  const input = {
    documentKey: 'note.md',
    content: { markdown: 'hello', plainText: 'hello' },
    mode: 'visual',
  }

  await handler({ sender: firstWebContents, senderFrame: firstWebContents.mainFrame }, input)
  await handler({ sender: secondWebContents, senderFrame: secondWebContents.mainFrame }, input)

  expect(firstStart).toHaveBeenCalledTimes(1)
  expect(secondStart).toHaveBeenCalledTimes(1)
  first.dispose()
  second.dispose()
})
