// @vitest-environment node
import { expect, it, vi } from 'vitest'
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<object>(), spawn: vi.fn(() => { throw new Error('synthetic launch stop') }) }))
vi.mock('../../src/main/codex/codex-cli-executable', () => ({ discoverCodexCliExecutables: vi.fn(async () => ['C:\\external\\codex.exe']) }))
import { spawn } from 'node:child_process'
import { discoverCodexCliExecutables } from '../../src/main/codex/codex-cli-executable'
import { createCodexCliModelAdapter } from '../../src/main/codex/codex-cli-model-adapter'
import type { ModelChatInput } from '../../src/main/models/model-protocol-client'
const request = () => ({ signal: new AbortController().signal } as ModelChatInput)

it('launches the same selected managed executable without rediscovering another CLI', async () => {
  const removeWorkspace = vi.fn(async () => {})
  const adapter = createCodexCliModelAdapter({ resolveExecutable: async () => 'C:\\managed\\codex.exe', createWorkspace: async () => 'C:\\synthetic', removeWorkspace })
  await expect(adapter.streamChat(request())).rejects.toBeTruthy()
  expect(spawn).toHaveBeenCalledWith('C:\\managed\\codex.exe', expect.arrayContaining(['app-server', 'features.shell_tool=false']), expect.objectContaining({ shell: false, windowsHide: true }))
  expect(discoverCodexCliExecutables).not.toHaveBeenCalled()
  expect(removeWorkspace).toHaveBeenCalledWith('C:\\synthetic')
})
it('reports a missing managed runtime instead of silently selecting an external installation', async () => {
  const adapter = createCodexCliModelAdapter({ resolveExecutable: async () => undefined, createWorkspace: async () => 'C:\\synthetic', removeWorkspace: async () => {} })
  await expect(adapter.streamChat(request())).rejects.toBeTruthy()
  expect(spawn).not.toHaveBeenCalled()
  expect(discoverCodexCliExecutables).not.toHaveBeenCalled()
})
