// @vitest-environment node
import { createContext, runInContext } from 'node:vm'
import { build } from 'vite'
import { expect, it, vi } from 'vitest'
import type { ScreenTranslationApi } from '../../src/shared/screen-translation'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import type { PublicModelSettingsSnapshot } from '../../src/shared/settings-observation'

it('bundles a sandbox-compatible screen-only bridge with fixed IPC channels', async () => {
  const bundled = await build({ configFile: 'vite.preload.config.ts', logLevel: 'silent', build: {
    write: false, minify: false, copyPublicDir: false, rollupOptions: {
      input: 'src/preload/screen-translation-preload.ts', external: ['electron'],
      output: { format: 'cjs', codeSplitting: false, entryFileNames: '[name].js' },
    },
  } })
  if (Array.isArray(bundled) || !('output' in bundled)) throw new Error('Expected preload bundle')
  const entry = bundled.output.find(output => output.type === 'chunk' && output.isEntry)
  if (!entry || entry.type !== 'chunk') throw new Error('Missing preload entry')
  expect(entry.fileName).toBe('screen-translation-preload.js')
  let api!: ScreenTranslationApi
  const invoke = vi.fn(async () => ({ ok: true, value: {} }))
  const on = vi.fn(), removeListener = vi.fn()
  const expose = vi.fn((name: string, value: ScreenTranslationApi) => { expect(name).toBe('arkScreenTranslation'); api = value })
  runInContext(entry.code, createContext({ require: (name: string) => {
    if (name !== 'electron') throw new Error(`Unsupported sandbox require: ${name}`)
    return { contextBridge: { exposeInMainWorld: expose }, ipcRenderer: { invoke, on, removeListener } }
  } }))
  expect(expose).toHaveBeenCalledOnce()
  expect(Object.keys(api).sort()).toEqual(['command', 'getState', 'onState', 'saveBaiduCredentials', 'updateSettings'])
  await api.command('pause')
  expect(invoke).toHaveBeenCalledWith('screen-translation:request', { method: 'command', action: 'pause' })
  const observed: PublicModelSettingsSnapshot = { settings: structuredClone(DEFAULT_LARGE_MODEL_SETTINGS),
    observation: { version: 1, revision: 7, minimumBaseRevision: 0, fields: {}, connections: {} } }
  await api.updateSettings({ target: 'en' }, observed)
  expect(invoke).toHaveBeenLastCalledWith('screen-translation:request', { method: 'settings', patch: { target: 'en' }, observed })
  await api.getState()
  expect(invoke).toHaveBeenLastCalledWith('screen-translation:request', { method: 'state' })
  await api.getState({ reloadSettings: true })
  expect(invoke).toHaveBeenLastCalledWith('screen-translation:request', { method: 'state', reloadSettings: true })
  const listener = vi.fn(), stop = api.onState(listener)
  expect(on.mock.calls[0]?.[0]).toBe('screen-translation:state')
  on.mock.calls[0]?.[1]({ sender: 'private' }, { engineReady: true })
  expect(listener).toHaveBeenCalledWith({ engineReady: true })
  stop()
  expect(removeListener).toHaveBeenCalledWith('screen-translation:state', on.mock.calls[0]?.[1])
})
