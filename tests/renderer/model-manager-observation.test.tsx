import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ModelManagerPage } from '../../src/renderer/settings/ModelManagerPage'
import { ModelPreferenceDraft } from '../../src/renderer/settings/model-preference-draft'
import { createPreferencePersistence } from '../../src/renderer/settings/preference-update-queue'
import { DEFAULT_LARGE_MODEL_SETTINGS, type ModelConnectionSummary } from '../../src/shared/large-model-settings'
import type { ArkdownApi } from '../../src/shared/contracts'
import type { PublicModelSettingsSnapshot } from '../../src/shared/settings-observation'
import { choosePreferencesOption } from './preferences-select-test-helpers'

const connection: ModelConnectionSummary = { id: '11111111-1111-4111-8111-111111111111', name: 'Original',
  provider: 'deepseek', accessType: 'standard-api', protocol: 'openai', baseUrl: 'https://api.deepseek.com',
  modelId: 'deepseek-chat', apiKeyHint: '••••test', status: 'connected', lastTestedAt: null, capabilityOverride: null }
const observed = (revision: number): PublicModelSettingsSnapshot => ({
  settings: { ...structuredClone(DEFAULT_LARGE_MODEL_SETTINGS), connections: [{ ...connection }] },
  observation: { version: 1, revision, minimumBaseRevision: 0, fields: {}, connections: { [connection.id]: { entity: revision } } },
})
function fixture() {
  const persistence = createPreferencePersistence(), owner = new ModelPreferenceDraft(persistence)
  owner.accept(observed(1))
  const conflict = { status: 'conflict' as const, snapshot: observed(8), reason: 'field-changed' as const, conflicts: [] }
  const props = { modelPreferences: owner, settings: observed(1).settings,
    connectModel: vi.fn<ArkdownApi['connectModel']>(async () => ({ ok: true, value: conflict })),
    listModels: vi.fn<ArkdownApi['listModels']>(), testModel: vi.fn<ArkdownApi['testModel']>(),
    deleteModel: vi.fn<ArkdownApi['deleteModel']>(), testCodexCliConnection: vi.fn<ArkdownApi['testCodexCliConnection']>(),
    removeCodexCliConnection: vi.fn<ArkdownApi['removeCodexCliConnection']>(),
    setAiConversationSettings: vi.fn<ArkdownApi['setAiConversationSettings']>(),
    setSelectionTranslationSettings: vi.fn<ArkdownApi['setSelectionTranslationSettings']>(async () => ({ ok: true, value: conflict })),
    setScreenshotTranslationSettings: vi.fn<ArkdownApi['setScreenshotTranslationSettings']>(),
    setFloatingTranslationSettings: vi.fn<ArkdownApi['setFloatingTranslationSettings']>(), onSettingsChange: vi.fn() }
  return { persistence, owner, props }
}

it('submits only the changed feature field and retains its failure and selected value across page remount', async () => {
  const h = fixture(), first = render(<ModelManagerPage {...h.props} />)
  choosePreferencesOption('目标语言', '日语')
  await waitFor(() => expect(h.props.setSelectionTranslationSettings).toHaveBeenCalledOnce())
  expect(h.props.setSelectionTranslationSettings.mock.calls[0]).toEqual([{ targetLanguage: 'ja' }, observed(1)])
  expect((await h.persistence.drain()).ok).toBe(false)
  first.unmount()
  h.owner.accept(observed(9))
  render(<ModelManagerPage {...h.props} />)
  expect(screen.getByRole('combobox', { name: '目标语言' })).toHaveTextContent('日语')
  expect(screen.getByRole('button', { name: '重新加载大模型设置' })).toBeEnabled()
})

it('keeps an edit form and its original observation when the remote connection disappears', async () => {
  const h = fixture(), first = render(<ModelManagerPage {...h.props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Original详情' }))
  fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  fireEvent.change(screen.getByRole('textbox', { name: '配置名称' }), { target: { value: 'Still editing' } })
  const remote = observed(9)
  remote.settings.connections = []; remote.observation.connections = {}
  act(() => h.owner.accept(remote))
  expect(screen.getByRole('textbox', { name: '配置名称' })).toHaveValue('Still editing')
  first.unmount()
  render(<ModelManagerPage {...h.props} />)
  expect(screen.getByRole('textbox', { name: '配置名称' })).toHaveValue('Still editing')
  fireEvent.click(screen.getByRole('button', { name: '连接' }))
  await waitFor(() => expect(h.props.connectModel).toHaveBeenCalledOnce())
  expect(h.props.connectModel.mock.calls[0]?.[1].observation.revision).toBe(1)
  expect((await h.persistence.drain()).ok).toBe(false)
})
