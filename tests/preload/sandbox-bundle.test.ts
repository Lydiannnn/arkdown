// @vitest-environment node
import { builtinModules, createRequire } from 'node:module'
import { createContext, runInContext } from 'node:vm'
import { build } from 'vite'
import { expect, it, vi } from 'vitest'
import type { ArkdownApi } from '../../src/shared/contracts'

it('starts the actual preload bundle with only Electron sandbox-supported requires', async () => {
  const bundled = await build({
    configFile: 'vite.preload.config.ts',
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      copyPublicDir: false,
      rollupOptions: {
        input: 'src/preload/index.ts',
        external: ['electron', ...builtinModules.flatMap((name) => [name, `node:${name}`])],
        output: { format: 'cjs', codeSplitting: false },
      },
    },
  })
  if (Array.isArray(bundled) || !('output' in bundled)) throw new Error('Expected one preload bundle')
  const entry = bundled.output.find((output) => output.type === 'chunk' && output.isEntry)
  if (!entry || entry.type !== 'chunk') throw new Error('Missing preload bundle entry')
  const registrations = new Map<string, (event: unknown, payload: unknown) => void>()
  let api: ArkdownApi | undefined
  let boxThemeApi: Record<string, unknown> | undefined
  let closeRecoveryApi: Record<string, unknown> | undefined
  let messageApi: Record<string, unknown> | undefined
  const electron = {
    contextBridge: { exposeInMainWorld: (key: string, value: ArkdownApi) => {
      expect(['arkdown', 'arknoteBoxTheme', 'arkdownClose', 'arkdownMessage']).toContain(key)
      if (key === 'arkdown') api = value
      else if (key === 'arknoteBoxTheme') boxThemeApi = value as unknown as Record<string, unknown>
      else if (key === 'arkdownMessage') messageApi = value as unknown as Record<string, unknown>
      else closeRecoveryApi = value as unknown as Record<string, unknown>
    } },
    ipcRenderer: {
      on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
        registrations.set(channel, listener)
      },
      invoke: vi.fn(async () => ({ ok: true, value: null })),
      removeListener: vi.fn(),
      send: vi.fn(),
    },
    webUtils: { getPathForFile: vi.fn(() => '') },
  }
  const hostRequire = createRequire(import.meta.url)
  const supported = new Set(['events', 'node:events', 'timers', 'node:timers', 'url', 'node:url'])
  const sandbox = createContext({
    Buffer, TextEncoder, URL, console, setTimeout, clearTimeout, setInterval, clearInterval,
    window: { addEventListener: vi.fn() },
    process: { platform: 'win32', sandboxed: true, contextIsolated: true },
    require: (name: string) => {
      if (name === 'electron') return electron
      if (supported.has(name)) return hostRequire(name)
      throw new Error(`Electron sandbox cannot require ${name}`)
    },
  })

  runInContext(entry.code, sandbox, { filename: 'preload.js' })
  expect(api?.startAiConversation).toBeTypeOf('function')
  expect(Object.keys(boxThemeApi!).sort()).toEqual(['get', 'subscribe'])
  expect(Object.keys(closeRecoveryApi!).sort()).toEqual(['act', 'get', 'ready', 'subscribe'])
  expect(Object.keys(messageApi!).sort()).toEqual(['get', 'ready', 'respond'])
  expect(api?.onPrepareCloseStructured).toBeTypeOf('function')
  expect(api?.onClosePreparationReleased).toBeTypeOf('function')
  expect(api?.registerAiCurrentDocumentPort).toBeTypeOf('function')
  expect(registrations.has('ai-conversation:renderer-port-request')).toBe(true)
})
