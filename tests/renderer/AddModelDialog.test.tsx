import { modelObservation, modelCommit } from '../helpers/model-observation'
import type { PublicModelMutationResult } from '../../src/shared/settings-observation'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { expect, it, vi } from 'vitest'
import { startModelRulesInitialization } from '../../src/renderer/settings/model-rules-runtime'
import { AddModelDialog } from '../../src/renderer/settings/AddModelDialog'
import { ContextMenuProvider } from '../../src/renderer/context-menu/ContextMenuProvider'
import { choosePreferencesOption } from './preferences-select-test-helpers'
import type { ArkdownApi } from '../../src/shared/contracts'
import type {
  LargeModelSettings,
  ModelConnectionSummary,
} from '../../src/shared/large-model-settings'

function readCss(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

function zIndex(css: string, selector: string): number {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 's'))?.[1]
  const value = rule?.match(/z-index:\s*(\d+)/)?.[1]
  if (!value) throw new Error(`Missing numeric z-index for ${selector}`)
  return Number(value)
}

function ruleDeclarations(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const declarations = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 's'))?.[1]
  if (!declarations) throw new Error(`Missing CSS rule for ${selector}`)
  return declarations
}

const largeModelCss = readCss('src/renderer/settings/large-model-settings.css')
const preferencesCss = readCss('src/renderer/settings/search-preferences.css')
const applicationMenuCss = readCss('src/renderer/chrome/application-menu-popover.css')
const contextMenuCss = readCss('src/renderer/context-menu/context-menu.css')
const preferencesSelectCss = readCss('src/renderer/settings/preferences-select.css')
const tooltipCss = readCss('src/renderer/tooltip/tooltip.css')

it('uses standard control dimensions for the model catalog loading button', () => {
  const declarations = ruleDeclarations(largeModelCss, '.large-model-catalog-controls > button')

  expect(declarations).toContain('height: 32px;')
  expect(declarations).toContain('border-radius: 8px;')
  expect(declarations).toContain('font-size: 13px;')
})

it('uses the neutral 32px dialog control system and a scroll-owned sticky footer', () => {
  const inputs = ruleDeclarations(largeModelCss, '.large-model-dialog input')
  const actions = ruleDeclarations(largeModelCss, '.large-model-dialog .preferences-actions')
  const buttons = ruleDeclarations(largeModelCss, '.large-model-dialog .preferences-actions button')
  const catalogMode = ruleDeclarations(largeModelCss, '.large-model-catalog-mode')
  const scrollLayout = ruleDeclarations(
    largeModelCss,
    '.large-model-dialog .arkdown-dialog__content',
  )

  expect(inputs).toContain('height: 32px;')
  expect(inputs).toContain('border-radius: 8px;')
  expect(inputs).toContain('font-size: 13px;')
  expect(buttons).toContain('height: 32px;')
  expect(buttons).toContain('border-radius: 8px;')
  expect(buttons).toContain('font-size: 13px;')
  expect(catalogMode).toContain('height: 32px;')
  expect(catalogMode).toContain('border-radius: 8px;')
  expect(catalogMode).toContain('font-size: 13px;')
  expect(scrollLayout).toContain('overflow-y: auto;')
  expect(actions).toContain('position: sticky;')
  expect(actions).toContain('bottom: 0;')
  expect(actions).toContain('background: #fff;')
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

const connected: ModelConnectionSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '主模型',
  provider: 'deepseek',
  accessType: 'standard-api',
  protocol: 'openai',
  baseUrl: 'https://api.deepseek.com',
  modelId: 'deepseek-chat',
  apiKeyHint: '••••7A9F',
  status: 'connected',
  lastTestedAt: '2026-07-30T01:02:03.000Z',
  capabilityOverride: null,
}

const connectedSettings: LargeModelSettings = {
  version: 6,
  codexCli: null,
  connections: [connected],
  selectionTranslation: {
    connectionId: connected.id,
    thinkingMode: 'default' as const, reasoningEffort: 'default',
    targetLanguage: 'ja',
    privacyNoticeAccepted: true,
  },
  screenshotTranslation: {
    connectionId: connected.id,
    thinkingMode: 'default' as const, reasoningEffort: 'default',
    targetLanguage: 'ja',
  },
  aiConversation: {
    connectionId: null,
    thinkingMode: 'default' as const, reasoningEffort: 'default',
    writePolicy: 'ask-every-time',
  },
}

function successfulConnect(): ArkdownApi['connectModel'] {
  return vi.fn(async () => ({ ok: true as const, value: modelCommit(connectedSettings) }))
}

it('rejects form submission of capability settings while initial rules are pending', async () => {
  let resolve!: (value: { ok: true; value: { rules: null; bundledRevision: string; warning: null } }) => void
  const session = startModelRulesInitialization({ getModelCapabilityRules: () => new Promise(done => { resolve = done }) })
  const connectModel = successfulConnect()
  try {
    render(<AddModelDialog observed={modelObservation(connectedSettings)} connection={connected} connectModel={connectModel} testCodexCliConnection={successfulCodexCliConnection()} onCancel={vi.fn()} onConnected={vi.fn()} />)
    const submit = screen.getByRole('button', { name: '连接' })
    expect(submit).toBeDisabled()
    fireEvent.submit(submit.closest('form')!)
    expect(connectModel).not.toHaveBeenCalled()
    await act(async () => { resolve({ ok: true, value: { rules: null, bundledRevision: '2026-09-12', warning: null } }); await session.ready })
    expect(submit).toBeEnabled()
  } finally { act(() => session.dispose()) }
})

it('saves thinking-only overrides and reopens them independently of token limits', async () => {
  const connectModel=successfulConnect()
  const props={connection:{...connected,modelId:'future-model'},connectModel,testCodexCliConnection:successfulCodexCliConnection(),onCancel:vi.fn(),onConnected:vi.fn()}
  const view=render(<AddModelDialog observed={modelObservation(connectedSettings)} {...props} />)
  choosePreferencesOption('思考能力识别','手动：可开关')
  choosePreferencesOption('思考参数格式','enable_thinking（true / false）')
  fireEvent.click(screen.getByRole('button',{name:'连接'}))
  await waitFor(()=>expect(connectModel).toHaveBeenCalledOnce())
  const override=vi.mocked(connectModel).mock.calls[0][0].capabilityOverride!
  expect(override).toEqual({thinking:{thinking:'toggle',encoding:'enable-thinking',efforts:[],disabledEfforts:[],defaultThinking:'enabled',defaultEffort:'default'}})
  view.unmount()
  render(<AddModelDialog observed={modelObservation(connectedSettings)} {...props} connection={{...props.connection,capabilityOverride:override}} />)
  expect(screen.getByRole('combobox',{name:'思考能力识别'})).toHaveTextContent('手动：可开关')
  expect(screen.getByRole('combobox',{name:'思考参数格式'})).toHaveTextContent('enable_thinking')
  fireEvent.change(screen.getByRole('textbox',{name:'模型 ID'}),{target:{value:'different-model'}})
  expect(screen.getByRole('combobox',{name:'思考能力识别'})).toHaveTextContent('自动识别')
})

function successfulCodexCliConnection() {
  return vi.fn(async () => ({
    ok: true as const,
    value: { status: 'connected' as const, mutation: modelCommit(connectedSettings) },
  }))
}

function successfulListModels(): ArkdownApi['listModels'] {
  return vi.fn(async () => ({
    ok: true as const,
    value: { status: 'catalog' as const, catalog: {
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      recommendedModelId: 'deepseek-v4-flash',
    } },
  }))
}

function deferredResult<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

it('orders connection fields for the setup flow and groups access type with protocol', () => {
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connectModel={successfulConnect()}
      testCodexCliConnection={successfulCodexCliConnection()}
      onCancel={() => undefined}
      onConnected={() => undefined}
    />,
  )

  const labels = screen.getAllByTestId('model-field-label')
    .map((label) => label.textContent)
  expect(labels).toEqual([
    '服务商',
    '接入类型',
    '接口协议',
    'Base URL',
    'API Key',
    '模型 ID',
    '配置名称',
  ])

  const accessType = screen.getByLabelText('接入类型').closest('.preferences-field')
  const protocol = screen.getByLabelText('接口协议').closest('.preferences-field')
  expect(accessType?.parentElement).toBe(protocol?.parentElement)
  expect(accessType?.parentElement).toHaveClass('large-model-connection-kind-row')
  expect(screen.getByRole('combobox', { name: '服务商' })).toHaveFocus()
})

it('shows exact official capability limits as read-only values', () => {
  const exactGlm: ModelConnectionSummary = {
    ...connected,
    provider: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    modelId: 'glm-5.3',
  }
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connection={exactGlm}
      connectModel={successfulConnect()}
      testCodexCliConnection={successfulCodexCliConnection()}
      onCancel={() => undefined}
      onConnected={() => undefined}
    />,
  )

  const advanced = screen.getByRole('group', { name: '高级模型参数' })
  expect(within(advanced).getByText('上下文窗口')).toBeVisible()
  expect(within(advanced).getByText('1000000')).toBeVisible()
  expect(within(advanced).queryByRole('spinbutton', { name: '上下文窗口' }))
    .not.toBeInTheDocument()
})

it('clears a legacy override when saving an exact official profile', async () => {
  const submittedInputs: Parameters<ArkdownApi['connectModel']>[0][] = []
  const connectModel: ArkdownApi['connectModel'] = async (input) => {
    submittedInputs.push(input)
    return { ok: true as const, value: modelCommit(connectedSettings) }
  }
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connection={{
        ...connected,
        provider: 'zhipu',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        modelId: 'glm-5.3',
        capabilityOverride: { contextWindowTokens: 2048 },
      }}
      connectModel={connectModel}
      onCancel={() => undefined}
      testCodexCliConnection={successfulCodexCliConnection()}
      onConnected={() => undefined}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: '连接' }))

  await waitFor(() => expect(submittedInputs).toHaveLength(1))
  expect(submittedInputs[0]).toMatchObject({ capabilityOverride: null })
})

it('serializes a custom capability override without blank optional limits', async () => {
  const customConnection: ModelConnectionSummary = {
    ...connected,
    provider: 'other',
    baseUrl: 'https://api.example.com/v1',
    modelId: 'custom-model',
  }
  const submittedInputs: Parameters<ArkdownApi['connectModel']>[0][] = []
  const connectModel: ArkdownApi['connectModel'] = async (input) => {
    submittedInputs.push(input)
    return { ok: true as const, value: modelCommit(connectedSettings) }
  }
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connection={customConnection}
      connectModel={connectModel}
      onCancel={() => undefined}
      testCodexCliConnection={successfulCodexCliConnection()}
      onConnected={() => undefined}
    />,
  )

  const advanced = screen.getByRole('group', { name: '高级模型参数' })
  fireEvent.change(within(advanced).getByRole('spinbutton', { name: '上下文窗口' }), {
    target: { value: '100000' },
  })
  fireEvent.click(screen.getByRole('button', { name: '连接' }))

  await waitFor(() => expect(submittedInputs).toHaveLength(1))
  const submitted = submittedInputs[0]
  expect(submitted).toMatchObject({
    capabilityOverride: { contextWindowTokens: 100000 },
  })
  expect(submitted?.capabilityOverride).not.toHaveProperty('maxInputTokens')
  expect(submitted?.capabilityOverride).not.toHaveProperty('maxOutputTokens')
})

it('rejects optional custom limits that exceed the context window', () => {
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connection={{
        ...connected,
        provider: 'other',
        baseUrl: 'https://api.example.com/v1',
        modelId: 'custom-model',
      }}
      connectModel={successfulConnect()}
      onCancel={() => undefined}
      testCodexCliConnection={successfulCodexCliConnection()}
      onConnected={() => undefined}
    />,
  )

  const advanced = screen.getByRole('group', { name: '高级模型参数' })
  fireEvent.change(within(advanced).getByRole('spinbutton', { name: '上下文窗口' }), {
    target: { value: '1000' },
  })
  fireEvent.change(within(advanced).getByRole('spinbutton', { name: '最大输入' }), {
    target: { value: '1001' },
  })

  expect(within(advanced).getByRole('alert')).toHaveTextContent('高级模型参数无效。')
  expect(screen.getByRole('button', { name: '连接' })).toBeDisabled()
})

it('pastes into API Key and configuration name from the shared right-click menu', async () => {
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const readText = vi.fn()
    .mockResolvedValueOnce('sk-pasted')
    .mockResolvedValueOnce('主配置')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText },
  })
  try {
    render(
      <ContextMenuProvider>
        <AddModelDialog observed={modelObservation(connectedSettings)}
          connectModel={successfulConnect()}
          testCodexCliConnection={successfulCodexCliConnection()}
          onCancel={() => undefined}
          onConnected={() => undefined}
        />
      </ContextMenuProvider>,
    )

    const apiKey = screen.getByLabelText('API Key') as HTMLInputElement
    fireEvent.contextMenu(apiKey, { clientX: 24, clientY: 32 })
    fireEvent.click(screen.getByRole('menuitem', { name: '粘贴' }))
    await waitFor(() => expect(apiKey).toHaveValue('sk-pasted'))

    const name = screen.getByLabelText('配置名称') as HTMLInputElement
    fireEvent.contextMenu(name, { clientX: 28, clientY: 36 })
    fireEvent.click(screen.getByRole('menuitem', { name: '粘贴' }))
    await waitFor(() => expect(name).toHaveValue('主配置'))
    expect(readText).toHaveBeenCalledTimes(2)
  } finally {
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

it('routes packaged input paste through the focused window application role', async () => {
  const previousApi = window.arkdown
  const executeApplicationMenuItem = vi.fn(async () => ({
    ok: true as const,
    value: null,
  }))
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const readText = vi.fn(async () => 'must-not-use-browser-clipboard')
  window.arkdown = { executeApplicationMenuItem } as unknown as ArkdownApi
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText },
  })
  try {
    render(
      <ContextMenuProvider>
        <AddModelDialog observed={modelObservation(connectedSettings)}
          connectModel={successfulConnect()}
          testCodexCliConnection={successfulCodexCliConnection()}
          onCancel={() => undefined}
          onConnected={() => undefined}
        />
      </ContextMenuProvider>,
    )

    for (const label of ['API Key', '配置名称']) {
      const input = screen.getByLabelText(label)
      fireEvent.contextMenu(input, { clientX: 24, clientY: 32 })
      fireEvent.click(screen.getByRole('menuitem', { name: '粘贴' }))
      await waitFor(() => expect(input).toHaveFocus())
    }

    expect(executeApplicationMenuItem).toHaveBeenNthCalledWith(1, 'edit.paste')
    expect(executeApplicationMenuItem).toHaveBeenNthCalledWith(2, 'edit.paste')
    expect(readText).not.toHaveBeenCalled()
  } finally {
    window.arkdown = previousApi
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

it('renders the shared paste menu above the add-model modal and settings selects', () => {
  const modalLayer = zIndex(largeModelCss, '.large-model-modal-layer')
  const selectLayer = zIndex(preferencesSelectCss, '.preferences-select-menu')
  const contextRoot = zIndex(contextMenuCss, '.context-menu-list')
  const contextSubmenu = zIndex(contextMenuCss, '.context-menu-submenu')

  expect(selectLayer).toBeGreaterThan(modalLayer)
  expect(contextRoot).toBeGreaterThan(modalLayer)
  expect(contextRoot).toBeGreaterThan(selectLayer)
  expect(contextSubmenu).toBeGreaterThan(contextRoot)
})

it('lets Escape close the paste menu without closing the add-model dialog', async () => {
  const cancel = vi.fn()
  render(
    <ContextMenuProvider>
      <AddModelDialog observed={modelObservation(connectedSettings)}
        connectModel={successfulConnect()}
        testCodexCliConnection={successfulCodexCliConnection()}
        onCancel={cancel}
        onConnected={() => undefined}
      />
    </ContextMenuProvider>,
  )

  const apiKey = screen.getByLabelText('API Key') as HTMLInputElement
  fireEvent.contextMenu(apiKey, { clientX: 24, clientY: 32 })
  expect(screen.getByRole('menuitem', { name: '粘贴' })).toBeVisible()

  fireEvent.keyDown(window, { key: 'Escape' })

  await waitFor(() => expect(screen.queryByRole('menuitem', { name: '粘贴' })).not.toBeInTheDocument())
  expect(screen.getByRole('dialog', { name: '添加大模型' })).toBeVisible()
  expect(cancel).not.toHaveBeenCalled()
  expect(apiKey).toHaveFocus()
})

it.each([
  ['Base URL', '', '请输入 Base URL。', 'https://api.example.com/v1'],
  ['Base URL', 'http://api.example.com', 'Base URL 必须是 HTTPS，或使用本机回环地址。', 'https://api.example.com/v1'],
  ['API Key', '', '请输入 API Key。', 'sk-private'],
  ['模型 ID', '', '请输入模型 ID。', 'moonshot-v1'],
  ['配置名称', '', '请输入配置名称。', '主模型'],
])(
  'places the %s blur error below its field and clears only that error on change',
  (label, invalidValue, message, validValue) => {
    render(
      <AddModelDialog observed={modelObservation(connectedSettings)}
        connectModel={successfulConnect()}
        testCodexCliConnection={successfulCodexCliConnection()}
        onCancel={() => undefined}
        onConnected={() => undefined}
      />,
    )

    const control = screen.getByLabelText(label)
    fireEvent.change(control, { target: { value: invalidValue } })
    fireEvent.blur(control)

    const field = control.closest<HTMLElement>('.preferences-field')!
    const error = within(field).getByRole('alert')
    expect(error).toHaveTextContent(message)
    expect(error.parentElement).toBe(field)
    expect(error).toHaveAttribute('data-ui-selectable', 'true')
    expect(error).toHaveAttribute('tabindex', '0')
    expect(control.getAttribute('aria-describedby')?.split(' ')).toContain(error.id)

    fireEvent.change(control, { target: { value: validValue } })

    expect(within(field).queryByRole('alert')).not.toBeInTheDocument()
    expect(control.getAttribute('aria-describedby')?.split(' ') ?? [])
      .not.toContain(error.id)
  },
)

it('connects persistent helper text to the controls it describes', () => {
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connection={connected}
      connectModel={successfulConnect()}
      testCodexCliConnection={successfulCodexCliConnection()}
      onCancel={() => undefined}
      onConnected={() => undefined}
    />,
  )

  const apiKey = screen.getByLabelText('API Key')
  const apiKeyHelper = screen.getByText('留空表示继续使用已加密保存的 API Key。')
  const modelId = screen.getByLabelText('模型 ID')
  const modelIdHelper = screen.getByText('可以手动输入模型 ID，也可以从服务商获取模型列表。')

  expect(apiKey.getAttribute('aria-describedby')?.split(' ')).toContain(apiKeyHelper.id)
  expect(modelId.getAttribute('aria-describedby')?.split(' ')).toContain(modelIdHelper.id)
})

it('keeps custom select and text input hit areas independent from full-width field labels', () => {
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connectModel={successfulConnect()}
      testCodexCliConnection={successfulCodexCliConnection()}
      onCancel={() => undefined}
      onConnected={() => undefined}
    />,
  )

  for (const name of ['服务商', '接入类型', '接口协议']) {
    expect(screen.getByRole('combobox', { name }).closest('label')).toBeNull()
  }
  for (const name of ['Base URL', 'API Key', '配置名称']) {
    expect(screen.getByLabelText(name).closest('label')).toBeNull()
  }
})

it('keeps Connect disabled when a new connection has a model ID but no API key', () => {
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connectModel={successfulConnect()}
      testCodexCliConnection={successfulCodexCliConnection()}
      onCancel={() => undefined}
      onConnected={() => undefined}
    />,
  )

  fireEvent.change(screen.getByLabelText('模型 ID'), {
    target: { value: 'moonshot-v1' },
  })

  expect(screen.getByLabelText('配置名称')).toHaveValue('moonshot-v1')
  expect(screen.getByRole('button', { name: '连接' })).toBeDisabled()
})

it('fetches selectable model IDs and generates a readable connection name', async () => {
  const listModels = successfulListModels()
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connectModel={successfulConnect()}
      listModels={listModels}
      testCodexCliConnection={successfulCodexCliConnection()}
      onCancel={() => undefined}
      onConnected={() => undefined}
    />,
  )

  choosePreferencesOption('服务商', 'DeepSeek')
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-private' } })
  fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }))

  await waitFor(() => expect(listModels).toHaveBeenCalledWith({
    provider: 'deepseek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-private',
  }, modelObservation(connectedSettings)))
  expect(screen.getByText('已获取 2 个模型')).toBeVisible()
  const modelPicker = screen.getByRole('combobox', { name: '模型 ID' })
  const modelHelper = screen.getByText('已获取 2 个模型')
    .closest<HTMLElement>('#large-model-model-id-helper')!
  expect(modelPicker).toHaveTextContent('deepseek-v4-flash')
  expect(modelPicker.closest('label')).toBeNull()
  expect(modelPicker.getAttribute('aria-describedby')?.split(' '))
    .toContain(modelHelper.id)
  fireEvent.click(modelPicker)
  fireEvent.click(screen.getByRole('option', { name: 'deepseek-v4-pro' }))
  expect(screen.getByRole('combobox', { name: '模型 ID' }))
    .toHaveTextContent('deepseek-v4-pro')
  expect(screen.getByLabelText('配置名称')).toHaveValue('deepseek-v4-pro')
  expect(screen.getByRole('button', { name: '手动输入模型 ID' })).toBeVisible()
})

it('disables model loading while pending and ignores a duplicate request', async () => {
  const pendingList = deferredResult<Awaited<ReturnType<ArkdownApi['listModels']>>>()
  const listModels: ArkdownApi['listModels'] = vi.fn(() => pendingList.promise)
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connectModel={successfulConnect()}
      listModels={listModels}
      testCodexCliConnection={successfulCodexCliConnection()}
      onCancel={() => undefined}
      onConnected={() => undefined}
    />,
  )

  const loadButton = screen.getByRole('button', { name: '获取模型列表' })
  expect(loadButton).toBeDisabled()
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-private' } })
  expect(loadButton).toBeEnabled()

  fireEvent.click(loadButton)
  fireEvent.click(loadButton)

  expect(screen.getByRole('button', { name: '获取中…' })).toBeDisabled()
  expect(listModels).toHaveBeenCalledTimes(1)

  await act(async () => {
    pendingList.resolve({
      ok: true,
      value: { status: 'catalog' as const, catalog: { models: ['moonshot-v1'], recommendedModelId: 'moonshot-v1' } },
    })
    await pendingList.promise
  })

  expect(screen.getByRole('button', { name: '获取模型列表' })).toBeEnabled()
  expect(screen.getByRole('button', { name: '连接' })).toBeEnabled()
})

it('ignores a pending model catalog after request-defining fields change', async () => {
  const pendingList = deferredResult<Awaited<ReturnType<ArkdownApi['listModels']>>>()
  const listModels: ArkdownApi['listModels'] = vi.fn(() => pendingList.promise)
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connectModel={successfulConnect()}
      listModels={listModels}
      testCodexCliConnection={successfulCodexCliConnection()}
      onCancel={() => undefined}
      onConnected={() => undefined}
    />,
  )

  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-original' } })
  fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }))
  expect(screen.getByRole('button', { name: '获取中…' })).toBeDisabled()

  choosePreferencesOption('服务商', 'Kimi')
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-newer' } })

  await act(async () => {
    pendingList.resolve({
      ok: true,
      value: { status: 'catalog' as const, catalog: { models: ['stale-model'], recommendedModelId: 'stale-model' } },
    })
    await pendingList.promise
  })

  expect(listModels).toHaveBeenCalledWith({
    provider: 'deepseek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-original',
  }, modelObservation(connectedSettings))
  expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.moonshot.cn/v1/')
  expect(screen.getByLabelText('API Key')).toHaveValue('sk-newer')
  expect(screen.getByLabelText('模型 ID')).toHaveValue('')
  expect(screen.getByLabelText('配置名称')).toHaveValue('')
  expect(screen.queryByText('stale-model')).not.toBeInTheDocument()
})

it('keeps the key and manual model input available when catalog loading fails', async () => {
  const listModels: ArkdownApi['listModels'] = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'MODEL_INVALID_ENDPOINT', message: '大模型接口地址无效或不可用' },
  }))
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connectModel={successfulConnect()}
      listModels={listModels}
      testCodexCliConnection={successfulCodexCliConnection()}
      onCancel={() => undefined}
      onConnected={() => undefined}
    />,
  )

  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-remains-local' } })
  fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('大模型接口地址无效或不可用')
  expect(screen.getByRole('alert')).toHaveAttribute('data-ui-selectable', 'true')
  expect(screen.getByRole('alert')).toHaveAttribute('tabindex', '0')
  expect(screen.getByLabelText('API Key')).toHaveValue('sk-remains-local')
  fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'manual-model' } })
  expect(screen.getByLabelText('模型 ID')).toHaveValue('manual-model')
})

it('updates a verified protocol preset and preserves a manual Base URL', () => {
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connectModel={successfulConnect()}
      testCodexCliConnection={successfulCodexCliConnection()}
      onCancel={() => undefined}
      onConnected={() => undefined}
    />,
  )

  expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.deepseek.com')
  choosePreferencesOption('接口协议', 'Anthropic 兼容')
  expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.deepseek.com/anthropic/v1')

  choosePreferencesOption('服务商', 'DeepSeek')
  expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.deepseek.com/anthropic/v1')
  choosePreferencesOption('接口协议', 'OpenAI 兼容')
  expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.deepseek.com')

  fireEvent.change(screen.getByLabelText('Base URL'), {
    target: { value: 'https://proxy.example.com/v1' },
  })
  expect(screen.getByLabelText('Base URL')).toHaveValue('https://proxy.example.com/v1')

  choosePreferencesOption('服务商', 'Mimo')
  expect(screen.getByLabelText('Base URL')).toHaveValue('https://proxy.example.com/v1')
  choosePreferencesOption('服务商', '其他')
  expect(screen.getByLabelText('Base URL')).toHaveValue('https://proxy.example.com/v1')
})

it('marks the Base URL validation alert as selectable', () => {
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connectModel={successfulConnect()}
      testCodexCliConnection={successfulCodexCliConnection()}
      onCancel={() => undefined}
      onConnected={() => undefined}
    />,
  )

  const baseUrl = screen.getByLabelText('Base URL')
  fireEvent.change(baseUrl, { target: { value: 'http://api.example.com' } })
  fireEvent.blur(baseUrl)

  const alert = screen.getByRole('alert')
  expect(alert).toHaveTextContent('Base URL 必须是 HTTPS')
  expect(alert).toBeVisible()
  expect(alert).toHaveAttribute('data-ui-selectable', 'true')
  expect(alert).toHaveAttribute('tabindex', '0')
  expect(screen.getByRole('button', { name: '连接' })).toBeDisabled()
})

it('keeps the real modal and its portaled controls in the global layer order', () => {
  document.body.classList.add('app-shell')
  try {
    render(
      <AddModelDialog observed={modelObservation(connectedSettings)}
        connectModel={successfulConnect()}
        testCodexCliConnection={successfulCodexCliConnection()}
        onCancel={() => undefined}
        onConnected={() => undefined}
      />,
    )

    const layer = screen.getByRole('dialog', { name: '添加大模型' }).parentElement
    expect(layer).toHaveClass('large-model-modal-layer')
    expect(layer).toHaveAttribute('data-ui-selection-portal', 'true')
    expect(layer).toHaveAttribute('data-tooltip-layer', 'modal')

    fireEvent.click(screen.getByRole('combobox', { name: '服务商' }))
    expect(screen.getByRole('listbox', { name: '服务商' }))
      .toHaveClass('preferences-select-menu')

    const modalLayer = zIndex(largeModelCss, '.large-model-modal-layer')
    const preferencesLayer = zIndex(preferencesCss, '.preferences-page')
    const applicationMenuLayer = zIndex(applicationMenuCss, '.application-menu-popover')
    const baseTooltipLayer = zIndex(tooltipCss, '.global-tooltip')
    const selectLayer = zIndex(preferencesSelectCss, '.preferences-select-menu')
    const modalTooltipLayer = zIndex(
      tooltipCss,
      '.global-tooltip[data-tooltip-layer="modal"]',
    )
    const contextRootLayer = zIndex(contextMenuCss, '.context-menu-list')
    const contextSubmenuLayer = zIndex(contextMenuCss, '.context-menu-submenu')
    const contextTooltipLayer = zIndex(
      tooltipCss,
      '.global-tooltip[data-tooltip-layer="context-menu"]',
    )

    expect(applicationMenuLayer).toBeGreaterThan(preferencesLayer)
    expect(modalLayer).toBeGreaterThan(Math.max(applicationMenuLayer, baseTooltipLayer))
    expect(selectLayer).toBeGreaterThan(modalLayer)
    expect(modalTooltipLayer).toBeGreaterThan(modalLayer)
    expect(contextRootLayer).toBeGreaterThan(Math.max(selectLayer, modalTooltipLayer))
    expect(contextSubmenuLayer).toBeGreaterThan(contextRootLayer)
    expect(contextTooltipLayer).toBeGreaterThan(contextSubmenuLayer)
  } finally {
    document.body.classList.remove('app-shell')
  }
})

it('offers the accepted provider order and links ChatGPT to Codex CLI without an API credential', () => {
  render(<AddModelDialog observed={modelObservation(connectedSettings)} connectModel={successfulConnect()} testCodexCliConnection={successfulCodexCliConnection()} onCancel={() => undefined} onConnected={() => undefined} />)
  fireEvent.click(screen.getByRole('combobox', { name: '服务商' }))
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
    'DeepSeek', 'Qwen', 'Zcode', 'Kimi', 'Doubao', 'Mimo', 'MiniMax', 'Hy', 'ChatGPT', '其他',
  ])
  fireEvent.click(screen.getByRole('option', { name: 'ChatGPT' }))
  expect(screen.getByRole('combobox', { name: '接入类型' })).toHaveTextContent('Codex CLI')
  expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
  choosePreferencesOption('服务商', 'Qwen')
  expect(screen.getByRole('combobox', { name: '接入类型' })).toHaveTextContent('标准 API')
  expect(screen.getByRole('combobox', { name: '服务商' })).toHaveTextContent('Qwen')
  expect(screen.getByLabelText('API Key')).toBeVisible()
})

it('places advanced model parameters immediately above the configuration name', () => {
  render(<AddModelDialog observed={modelObservation(connectedSettings)} connectModel={successfulConnect()} testCodexCliConnection={successfulCodexCliConnection()} onCancel={() => undefined} onConnected={() => undefined} />)
  const parameters = screen.getByRole('group', { name: '高级模型参数' })
  expect(parameters.nextElementSibling).toContainElement(screen.getByLabelText('配置名称'))
})

it('keeps Standard API as the enabled default and preserves its untouched form after Codex CLI is dismissed', () => {
  const testCodexCliConnection = vi.fn()
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connectModel={successfulConnect()}
      testCodexCliConnection={testCodexCliConnection}
      onCancel={() => undefined}
      onConnected={() => undefined}
    />,
  )

  const accessType = screen.getByRole('combobox', { name: '接入类型' })
  expect(accessType).toHaveTextContent('标准 API')
  expect(accessType).toBeEnabled()
  expect(screen.getByRole('button', { name: '连接' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '连接' }))
    .toHaveClass('preferences-primary-action')
  expect(screen.getByRole('button', { name: '取消' }))
    .not.toHaveClass('preferences-primary-action')

  choosePreferencesOption('服务商', 'DeepSeek')
  fireEvent.change(screen.getByLabelText('Base URL'), {
    target: { value: 'https://proxy.example.com/v1' },
  })
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-private' } })
  fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'deepseek-chat' } })
  fireEvent.change(screen.getByLabelText('配置名称'), { target: { value: '保持不变的配置' } })

  choosePreferencesOption('接入类型', 'Codex CLI')

  expect(screen.getByRole('combobox', { name: '服务商' })).toHaveTextContent('ChatGPT')
  expect(screen.queryByLabelText('接口协议')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Base URL')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('模型 ID')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('配置名称')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '检测连接' })).toBeEnabled()

  choosePreferencesOption('接入类型', '标准 API')

  expect(screen.getByRole('combobox', { name: '服务商' })).toHaveTextContent('DeepSeek')
  expect(screen.getByLabelText('Base URL')).toHaveValue('https://proxy.example.com/v1')
  expect(screen.getByLabelText('API Key')).toHaveValue('sk-private')
  expect(screen.getByLabelText('模型 ID')).toHaveValue('deepseek-chat')
  expect(screen.getByLabelText('配置名称')).toHaveValue('保持不变的配置')
  expect(testCodexCliConnection).not.toHaveBeenCalled()
})

it('tests Codex CLI without arguments and closes only after a connected result', async () => {
  const testCodexCliConnection = vi.fn(async () => ({
    ok: true as const,
    value: { status: 'connected' as const, mutation: modelCommit(connectedSettings) },
  }))
  const onConnected = vi.fn()
  const onCancel = vi.fn()
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connectModel={successfulConnect()}
      testCodexCliConnection={testCodexCliConnection}
      onCancel={onCancel}
      onConnected={onConnected}
    />,
  )

  choosePreferencesOption('接入类型', 'Codex CLI')
  fireEvent.click(screen.getByRole('button', { name: '检测连接' }))

  await waitFor(() => expect(testCodexCliConnection).toHaveBeenCalledWith(modelObservation(connectedSettings)))
  expect(onConnected).toHaveBeenCalledWith(connectedSettings)
  await waitFor(() => expect(screen.getByRole('dialog').parentElement)
    .toHaveAttribute('data-state', 'closing'))
})

it('suppresses duplicate Codex CLI connection tests while the request is pending', async () => {
  const pending = deferredResult<{
    ok: true
    value: { status: 'connected'; mutation: PublicModelMutationResult }
  }>()
  const testCodexCliConnection = vi.fn(() => pending.promise)
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connectModel={successfulConnect()}
      testCodexCliConnection={testCodexCliConnection}
      onCancel={() => undefined}
      onConnected={() => undefined}
    />,
  )

  choosePreferencesOption('接入类型', 'Codex CLI')
  const testButton = screen.getByRole('button', { name: '检测连接' })
  fireEvent.click(testButton)
  fireEvent.click(testButton)

  expect(screen.getByRole('button', { name: '检测中…' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
  expect(testCodexCliConnection).toHaveBeenCalledTimes(1)

  await act(async () => {
    pending.resolve({
      ok: true,
      value: { status: 'connected', mutation: modelCommit(connectedSettings) },
    })
    await pending.promise
  })
})

it.each([
  ['not-found', 'Codex 组件尚未就绪，请重新检测以完成安装。'],
  ['launch-failed', 'Codex CLI 无法启动，请先在终端确认它能够正常运行。'],
  ['timeout', 'Codex CLI 连接检测超时，请确认 CLI 能够正常运行后重试。'],
  ['incompatible-response', 'Codex CLI 返回了不兼容的响应，请更新后重试。'],
] as const)('keeps the Codex CLI dialog open and maps %s to its actionable public message', async (
  status,
  message,
) => {
  const testCodexCliConnection = vi.fn(async () => ({
    ok: true as const,
    value: { status, mutation: modelCommit(connectedSettings) },
  }))
  const onConnected = vi.fn()
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connectModel={successfulConnect()}
      testCodexCliConnection={testCodexCliConnection}
      onCancel={() => undefined}
      onConnected={onConnected}
    />,
  )

  choosePreferencesOption('接入类型', 'Codex CLI')
  fireEvent.click(screen.getByRole('button', { name: '检测连接' }))

  expect(await screen.findByRole('alert')).toHaveTextContent(message)
  expect(screen.getByRole('dialog', { name: '添加大模型' })).toBeVisible()
  expect(onConnected).not.toHaveBeenCalled()
})

it('offers explicit browser login after a logged-out probe and cancels immediately when closing', async () => {
  let finish!: (value: unknown) => void
  const startCodexCliLogin = vi.fn(() => new Promise(resolve => { finish = resolve }))
  const cancelCodexCliLogin = vi.fn(async () => ({ ok: true, value: null }))
  vi.stubGlobal('arkdown', { startCodexCliLogin, cancelCodexCliLogin })
  const onConnected = vi.fn()
  try {
    render(<AddModelDialog observed={modelObservation(connectedSettings)} connectModel={successfulConnect()}
      testCodexCliConnection={async () => ({ ok: true, value: { status: 'not-logged-in', mutation: modelCommit(connectedSettings) } })}
      onCancel={vi.fn()} onConnected={onConnected} />)
    choosePreferencesOption('接入类型', 'Codex CLI')
    fireEvent.click(screen.getByRole('button', { name: '检测连接' }))
    const login = await screen.findByRole('button', { name: '登录 ChatGPT' })
    expect(startCodexCliLogin).not.toHaveBeenCalled()
    fireEvent.click(login)
    expect(screen.getByRole('button', { name: '检测连接' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(cancelCodexCliLogin).toHaveBeenCalledOnce())
    await act(async () => { finish({ ok: true, value: { status: 'completed', connection: { status: 'connected', mutation: modelCommit(connectedSettings) } } }) })
    expect(onConnected).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})

it('preserves an untouched Standard API key after a failed Codex CLI detection and switching back', async () => {
  const testCodexCliConnection = vi.fn(async () => ({
    ok: true as const,
    value: { status: 'timeout' as const, mutation: modelCommit(connectedSettings) },
  }))
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connectModel={successfulConnect()}
      testCodexCliConnection={testCodexCliConnection}
      onCancel={() => undefined}
      onConnected={() => undefined}
    />,
  )

  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-preserve-me' } })
  choosePreferencesOption('接入类型', 'Codex CLI')
  fireEvent.click(screen.getByRole('button', { name: '检测连接' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Codex CLI 连接检测超时，请确认 CLI 能够正常运行后重试。',
  )

  choosePreferencesOption('接入类型', '标准 API')

  expect(screen.getByLabelText('API Key')).toHaveValue('sk-preserve-me')
})

it('keeps a failed connection dialog open, shows only the public error, and retains the masked local key', async () => {
  const connectModel: ArkdownApi['connectModel'] = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'AUTHENTICATION_FAILED', message: '认证失败，请检查 API Key。' },
  }))
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connectModel={connectModel}
      testCodexCliConnection={successfulCodexCliConnection()}
      onCancel={() => undefined}
      onConnected={() => undefined}
    />,
  )

  fireEvent.change(screen.getByLabelText('配置名称'), { target: { value: '测试模型' } })
  fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'moonshot-v1' } })
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'secret-never-render' } })
  fireEvent.click(screen.getByRole('button', { name: '连接' }))

  const alert = await screen.findByRole('alert')
  const actions = screen.getByRole('button', { name: '取消' }).parentElement!
  expect(alert).toHaveTextContent('认证失败，请检查 API Key。')
  expect(alert).toHaveClass('large-model-connection-error')
  expect(alert).toHaveAttribute('data-ui-selectable', 'true')
  expect(alert).toHaveAttribute('tabindex', '0')
  expect(alert.nextElementSibling).toBe(actions)
  expect(screen.getByRole('dialog', { name: '添加大模型' })).toBeVisible()
  expect(screen.getByLabelText('API Key')).toHaveValue('secret-never-render')
  expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'password')
  expect(screen.queryByText('secret-never-render')).not.toBeInTheDocument()
})

it('disables dialog actions and ignores duplicate connection submissions while pending', async () => {
  const pendingConnect = deferredResult<Awaited<ReturnType<ArkdownApi['connectModel']>>>()
  const connectModel: ArkdownApi['connectModel'] = vi.fn(() => pendingConnect.promise)
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connectModel={connectModel}
      listModels={successfulListModels()}
      testCodexCliConnection={successfulCodexCliConnection()}
      onCancel={() => undefined}
      onConnected={() => undefined}
    />,
  )

  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-private' } })
  fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'moonshot-v1' } })
  const connectButton = screen.getByRole('button', { name: '连接' })
  expect(connectButton).toBeEnabled()

  fireEvent.click(connectButton)
  fireEvent.click(connectButton)

  expect(screen.getByRole('button', { name: '连接中…' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '获取模型列表' })).toBeDisabled()
  expect(connectModel).toHaveBeenCalledTimes(1)

  await act(async () => {
    pendingConnect.resolve({ ok: true, value: modelCommit(connectedSettings) })
    await pendingConnect.promise
  })
})

it('omits an empty key when editing so the encrypted key is preserved', async () => {
  const connectModel = successfulConnect()
  const onConnected = vi.fn()
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connection={connected}
      connectModel={connectModel}
      testCodexCliConnection={successfulCodexCliConnection()}
      onCancel={() => undefined}
      onConnected={onConnected}
    />,
  )

  expect(screen.getByLabelText('API Key')).toHaveValue('')
  fireEvent.change(screen.getByLabelText('配置名称'), { target: { value: '更新后的模型' } })
  fireEvent.click(screen.getByRole('button', { name: '连接' }))

  await waitFor(() => expect(connectModel).toHaveBeenCalledWith({
    id: connected.id,
    name: '更新后的模型',
    provider: 'deepseek',
    accessType: 'standard-api',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    modelId: 'deepseek-chat',
    capabilityOverride: null,
  }, modelObservation(connectedSettings)))
  expect(onConnected).toHaveBeenCalledWith(connectedSettings)
})

it('keeps a successful connection submission locked throughout the close animation', async () => {
  vi.useFakeTimers()
  try {
    const connectModel = successfulConnect()
    const onConnected = vi.fn(async () => undefined)
    const onCancel = vi.fn()
    render(
      <AddModelDialog observed={modelObservation(connectedSettings)}
        connection={connected}
        connectModel={connectModel}
        testCodexCliConnection={successfulCodexCliConnection()}
        onCancel={onCancel}
        onConnected={onConnected}
      />,
    )
    const dialog = screen.getByRole('dialog', { name: '编辑大模型' })

    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(dialog.parentElement).toHaveAttribute('data-state', 'closing')

    fireEvent.keyDown(screen.getByLabelText('配置名称'), { key: 'Enter' })
    fireEvent.submit(dialog)
    expect(connectModel).toHaveBeenCalledOnce()
    expect(onConnected).toHaveBeenCalledOnce()

    act(() => { vi.advanceTimersByTime(120) })
    expect(onCancel).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})

it('clears an edit replacement key before awaiting slow parent reconciliation', async () => {
  const reconciliation = deferred()
  const onConnected = vi.fn(() => reconciliation.promise)
  render(
    <AddModelDialog observed={modelObservation(connectedSettings)}
      connection={connected}
      connectModel={successfulConnect()}
      testCodexCliConnection={successfulCodexCliConnection()}
      onCancel={() => undefined}
      onConnected={onConnected}
    />,
  )

  const keyInput = screen.getByLabelText('API Key')
  fireEvent.change(keyInput, { target: { value: 'replacement-secret' } })
  fireEvent.click(screen.getByRole('button', { name: '连接' }))

  await waitFor(() => expect(onConnected).toHaveBeenCalledWith(connectedSettings))
  expect(keyInput).toHaveValue('')
  expect(screen.getByRole('button', { name: '连接中…' })).toBeDisabled()

  await act(async () => {
    reconciliation.resolve()
    await reconciliation.promise
  })
  expect(screen.getByRole('dialog').parentElement).toHaveAttribute('data-state', 'closing')
  expect(screen.getByRole('button', { name: '连接中…' })).toBeDisabled()
})

it('traps focus, isolates the preference background, and restores the opener on close', async () => {
  function Harness() {
    const [open, setOpen] = useState(false)
    return (
      <main className="preferences-page">
        <button onClick={() => setOpen(true)} type="button">打开添加模型</button>
        {open && (
          <AddModelDialog observed={modelObservation(connectedSettings)}
            connectModel={successfulConnect()}
            testCodexCliConnection={successfulCodexCliConnection()}
            onCancel={() => setOpen(false)}
            onConnected={() => setOpen(false)}
          />
        )}
      </main>
    )
  }

  const { container } = render(<Harness />)
  const page = container.querySelector<HTMLElement>('.preferences-page')!
  const trigger = screen.getByRole('button', { name: '打开添加模型' })

  trigger.focus()
  fireEvent.click(trigger)
  expect(screen.getByRole('combobox', { name: '服务商' })).toHaveFocus()
  expect(page).toHaveAttribute('aria-hidden', 'true')
  expect(page.inert).toBe(true)

  const cancel = screen.getByRole('button', { name: '取消' })
  cancel.focus()
  fireEvent.keyDown(cancel, { key: 'Tab' })
  expect(screen.getByRole('combobox', { name: '服务商' })).toHaveFocus()
  fireEvent.keyDown(screen.getByRole('combobox', { name: '服务商' }), {
    key: 'Tab',
    shiftKey: true,
  })
  expect(cancel).toHaveFocus()

  fireEvent.click(cancel)
  expect(screen.getByRole('dialog').parentElement).toHaveAttribute('data-state', 'closing')
  await waitFor(() => expect(trigger).toHaveFocus())
  expect(page).not.toHaveAttribute('aria-hidden')
  expect(page.inert).toBe(false)

  fireEvent.click(trigger)
  expect(screen.getByRole('dialog', { name: '添加大模型' })).toBeVisible()
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '添加大模型' }))
    .not.toBeInTheDocument())
  await waitFor(() => expect(trigger).toHaveFocus())
})

it('offers Hy with the TokenHub URL across both protocols', () => {
  render(<AddModelDialog observed={modelObservation(connectedSettings)} connectModel={successfulConnect()} testCodexCliConnection={successfulCodexCliConnection()} onCancel={() => undefined} onConnected={() => undefined} />)
  choosePreferencesOption('服务商', 'Hy')
  expect(screen.getByLabelText('Base URL')).toHaveValue('https://tokenhub.tencentmaas.com/v1')
  choosePreferencesOption('接口协议', 'Anthropic 兼容')
  expect(screen.getByLabelText('Base URL')).toHaveValue('https://tokenhub.tencentmaas.com/v1')
})

it.each(['https://api.moonshot.ai/v1', 'https://custom.example.com/kimi/v1/'])('preserves an existing Kimi endpoint while editing: %s', (baseUrl) => {
  render(<AddModelDialog observed={modelObservation(connectedSettings)} connection={{ ...connected, provider: 'kimi', baseUrl }} connectModel={successfulConnect()} testCodexCliConnection={successfulCodexCliConnection()} onCancel={() => undefined} onConnected={() => undefined} />)
  expect(screen.getByLabelText('Base URL')).toHaveValue(baseUrl)
})

it('advances only Codex observation after its own acknowledged logged-out detection', async () => {
  const initial = modelObservation({ ...connectedSettings, codexCli: {
    cliVersion: 'codex-cli 0.144.1', status: 'connected', lastTestedAt: '2026-10-03T00:00:00.000Z',
  } }, 1)
  initial.observation.fields['models.codexCli'] = 1
  const next = structuredClone(initial)
  next.observation.revision = 2; next.observation.fields['models.codexCli'] = 2
  next.settings.codexCli = { ...initial.settings.codexCli!, status: 'not-logged-in', lastTestedAt: '2026-10-04T00:00:00.000Z' }
  const afterLogin = structuredClone(next)
  afterLogin.observation.revision = 3; afterLogin.observation.fields['models.codexCli'] = 3
  const external = modelObservation(connectedSettings, 9)
  const connect = successfulConnect()
  const acknowledged = vi.fn()
  const test = vi.fn<ArkdownApi['testCodexCliConnection']>()
    .mockResolvedValueOnce({ ok: true, value: { status: 'not-logged-in', mutation: { status: 'committed', snapshot: next } } })
    .mockResolvedValue({ ok: true, value: { mutation: { status: 'conflict', snapshot: external, reason: 'field-changed', conflicts: [] } } })
  const start = vi.fn<NonNullable<ArkdownApi['startCodexCliLogin']>>()
    .mockResolvedValueOnce({ ok: true, value: { status: 'completed', connection: {
      status: 'not-logged-in', mutation: { status: 'committed', snapshot: afterLogin },
    } } })
    .mockResolvedValue({ ok: true, value: { status: 'cancelled' } })
  const dialog = (observed = initial) => <AddModelDialog observed={observed} connectModel={connect}
    initialFields={{ name: 'Synthetic API form', modelId: 'deepseek-chat', apiKey: 'synthetic-key' }}
    testCodexCliConnection={test} startCodexCliLogin={start} onCodexObserved={acknowledged}
    onCancel={vi.fn()} onConnected={() => false} />
  const view = render(dialog())
  choosePreferencesOption('接入类型', 'Codex CLI')
  fireEvent.click(screen.getByRole('button', { name: '检测连接' }))
  fireEvent.click(await screen.findByRole('button', { name: '登录 ChatGPT' }))
  await waitFor(() => expect(start).toHaveBeenCalledOnce())
  expect(start).toHaveBeenNthCalledWith(1, next)
  await screen.findByText('登录后尚未连接成功，请重新检测连接。')
  view.rerender(dialog(external))
  fireEvent.click(screen.getByRole('button', { name: '登录 ChatGPT' }))
  await waitFor(() => expect(start).toHaveBeenNthCalledWith(2, afterLogin))
  await waitFor(() => expect(screen.getByRole('button', { name: '检测连接' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '检测连接' }))
  await screen.findByText('大模型设置已在其他窗口更改。你的输入仍保留，请重新加载后再调整。')
  expect(test).toHaveBeenNthCalledWith(2, afterLogin)
  expect(acknowledged.mock.calls.map(([value]) => value.observation.revision)).toEqual([2, 3])
  choosePreferencesOption('接入类型', '标准 API')
  fireEvent.click(screen.getByRole('button', { name: '连接' }))
  await waitFor(() => expect(connect).toHaveBeenCalledWith(expect.any(Object), initial))
})
