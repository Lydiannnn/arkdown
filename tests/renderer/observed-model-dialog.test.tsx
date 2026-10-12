import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { AddModelDialog } from '../../src/renderer/settings/AddModelDialog'
import { DEFAULT_LARGE_MODEL_SETTINGS, type ModelConnectionSummary } from '../../src/shared/large-model-settings'
import type { ArkdownApi } from '../../src/shared/contracts'
import type { PublicModelSettingsSnapshot } from '../../src/shared/settings-observation'

const connection: ModelConnectionSummary = { id: '11111111-1111-4111-8111-111111111111', name: 'Original',
  provider: 'deepseek', accessType: 'standard-api', protocol: 'openai', baseUrl: 'https://api.deepseek.com',
  modelId: 'deepseek-chat', apiKeyHint: '••••test', status: 'connected', lastTestedAt: null, capabilityOverride: null }
const observed = (revision: number): PublicModelSettingsSnapshot => ({
  settings: { ...structuredClone(DEFAULT_LARGE_MODEL_SETTINGS), connections: [{ ...connection }] },
  observation: { version: 1, revision, minimumBaseRevision: 0, fields: {}, connections: { [connection.id]: { entity: revision } } },
})

it('sends the dialog opening observation after parent refresh and retains edited inputs on conflict', async () => {
  const connect = vi.fn<ArkdownApi['connectModel']>(async () => ({ ok: true, value: {
    status: 'conflict', snapshot: observed(9), reason: 'field-changed', conflicts: [],
  } }))
  const onConnected = vi.fn(), onFieldsChange = vi.fn()
  const props = { connection, observed: observed(1), connectModel: connect, testCodexCliConnection: vi.fn(),
    onCancel: vi.fn(), onConnected, onFieldsChange }
  const view = render(<AddModelDialog {...props} />)
  fireEvent.change(screen.getByRole('textbox', { name: '配置名称' }), { target: { value: 'Unfinished local name' } })
  view.rerender(<AddModelDialog {...props} observed={observed(9)} connection={{ ...connection, name: 'Remote name' }} />)
  fireEvent.click(screen.getByRole('button', { name: '连接' }))
  await waitFor(() => expect(connect).toHaveBeenCalledOnce())
  expect(connect.mock.calls[0]?.[1].observation.revision).toBe(1)
  expect(screen.getByRole('textbox', { name: '配置名称' })).toHaveValue('Unfinished local name')
  expect(onConnected).not.toHaveBeenCalled()
  expect(onFieldsChange).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Unfinished local name' }))
})
