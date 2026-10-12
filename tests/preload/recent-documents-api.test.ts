import { expect, it, vi } from 'vitest'
import { createArkdownApi, type ApplicationMenuChangedTransport } from '../../src/preload/arkdown-api'
import { buildApplicationMenuModel } from '../../src/shared/application-menu-model'
import {
  APPLICATION_MENU_CHANGED_CHANNEL,
  IPC_CHANNELS,
} from '../../src/shared/contracts'

function createApiWithMenuTransport(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  transport: ApplicationMenuChangedTransport,
) {
  return createArkdownApi(
    invoke,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    transport,
  )
}

it('invokes only the fixed recent-document and window-menu-state channels', async () => {
  const paths = ['C:\\Docs\\one.md']
  const invoke = vi.fn(async (channel: string) => ({
    ok: true,
    value: channel === IPC_CHANNELS.recordRecentDocument ? paths : undefined,
  }))
  const api = createArkdownApi(invoke)
  const state = {
    hasPrintableDocument: true,
    spellCheckEnabled: false,
    showEditIndicators: true,
    editorZoomPercent: 100,
    fullscreen: false,
  }

  await expect(api.recordRecentDocument('C:\\Docs\\one.md')).resolves.toEqual({
    ok: true,
    value: paths,
  })
  await expect(api.updateApplicationMenuWindowState(state)).resolves.toEqual({
    ok: true,
    value: undefined,
  })
  expect(invoke.mock.calls).toEqual([
    [IPC_CHANNELS.recordRecentDocument, { absolutePath: 'C:\\Docs\\one.md' }],
    [IPC_CHANNELS.updateApplicationMenuWindowState, state],
  ])
})

it('fails closed on malformed recent-document responses', async () => {
  const api = createArkdownApi(vi.fn(async () => ({
    ok: true,
    value: ['relative.md', 'C:\\Docs\\one.pdf'],
  })))

  await expect(api.recordRecentDocument('C:\\Docs\\one.md')).resolves.toMatchObject({
    ok: false,
    error: { code: 'OPERATION_FAILED' },
  })
})

it('delivers validated rebuilt models and unsubscribes without exposing raw IPC', () => {
  let emit: ((payload: unknown) => void) | undefined
  const unsubscribe = vi.fn()
  const transport: ApplicationMenuChangedTransport = {
    subscribe: vi.fn((listener) => {
      emit = listener
      return unsubscribe
    }),
  }
  const api = createApiWithMenuTransport(vi.fn(), transport)
  const listener = vi.fn()
  const model = buildApplicationMenuModel({
    recentDocuments: [{
      id: 'file.recent.opaque-one',
      absolutePath: 'C:\\Docs\\one.md',
    }],
    hasPrintableDocument: true,
    spellCheckEnabled: false,
    showEditIndicators: true,
    editorZoomPercent: 100,
    fullscreen: false,
  })

  const stop = api.onApplicationMenuChanged(listener)
  emit?.(model)
  emit?.([{ id: 'file', label: '文件', items: [{ kind: 'recent-document', secret: true }]}])

  expect(listener).toHaveBeenCalledOnce()
  expect(listener).toHaveBeenCalledWith(model)
  expect(listener.mock.calls[0]?.[0]).not.toBe(model)
  stop()
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(api).not.toHaveProperty('ipcRenderer')
  expect(APPLICATION_MENU_CHANGED_CHANNEL).toBe('menu:application-model-changed')
})

it('requires an exact registered command on executable radio model items', () => {
  let emit: ((payload: unknown) => void) | undefined
  const api = createApiWithMenuTransport(vi.fn(), {
    subscribe(listener) {
      emit = listener
      return () => undefined
    },
  })
  const listener = vi.fn()
  api.onApplicationMenuChanged(listener)
  const section = (item: Record<string, unknown>) => [{ id: 'theme', label: '主题', items: [item] }]
  const valid = {
    kind: 'radio', id: 'theme.minimal', label: '简约', checked: true,
    command: 'select-editor-theme-minimal',
  }

  emit?.(section(valid))
  for (const malformed of [
    { ...valid, command: undefined },
    { ...valid, command: 'select-editor-theme-github' },
    { ...valid, extra: true },
  ]) emit?.(section(malformed))

  expect(listener).toHaveBeenCalledOnce()
  expect(listener).toHaveBeenCalledWith(section(valid))
})
