import { fireEvent, render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { LargeModelSettingsSection } from '../../src/renderer/settings/LargeModelSettingsSection'
import type { LargeModelSettings } from '../../src/shared/large-model-settings'
import { installUiSelectionGuard } from '../../src/renderer/app/ui-selection-guard'

const emptySettings: LargeModelSettings = {
  version: 6,
  codexCli: null,
  connections: [],
  selectionTranslation: {
    connectionId: null,
    thinkingMode: 'default' as const, reasoningEffort: 'default',
    targetLanguage: 'auto',
    privacyNoticeAccepted: false,
  },
  screenshotTranslation: {
    connectionId: null,
    thinkingMode: 'default' as const, reasoningEffort: 'default',
    targetLanguage: 'auto',
  },
  aiConversation: {
    connectionId: null,
    thinkingMode: 'default' as const, reasoningEffort: 'default',
    writePolicy: 'ask-every-time',
  },
}

function sendFocusedSelectAll(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    key: 'a',
  })
  document.activeElement?.dispatchEvent(event)
  return event
}

it('shows one neutral empty state, the AI conversation row, and the model manager action', () => {
  const manage = vi.fn()
  render(<LargeModelSettingsSection onManage={manage} settings={emptySettings} />)

  expect(screen.getByRole('heading', { name: '大模型设置' })).toBeVisible()
  expect(screen.getByText('尚未配置大模型应用')).toHaveClass('large-model-empty-state')
  expect(screen.getByRole('heading', { level: 3, name: '划词翻译' })).toBeVisible()
  expect(screen.getByRole('heading', { level: 3, name: '截图翻译' })).toBeVisible()
  expect(screen.getByRole('heading', { level: 3, name: 'AI 对话' })).toBeVisible()
  expect(screen.queryByText('代码解读')).not.toBeInTheDocument()

  const unconfigured = screen.getAllByRole('button', { name: '尚未配置' })[0]!
  expect(unconfigured).toHaveClass('large-model-unconfigured-link')
  const style = document.createElement('style')
  style.textContent = readFileSync(
    path.join(process.cwd(), 'src/renderer/settings/large-model-settings.css'),
    'utf8',
  )
  document.head.append(style)
  expect(getComputedStyle(unconfigured).fontSize).toBe('13px')
  expect(getComputedStyle(unconfigured).marginTop).toBe('8px')
  style.remove()
  fireEvent.click(unconfigured)
  expect(manage).toHaveBeenCalledOnce()

  fireEvent.click(screen.getByRole('button', { name: '管理大模型' }))
  expect(manage).toHaveBeenCalledTimes(2)
})

it('renders the configured translation hierarchy with textual connection status', () => {
  const settings: LargeModelSettings = {
    ...emptySettings,
    connections: [{
      id: '11111111-1111-4111-8111-111111111111',
      name: '主翻译模型',
      provider: 'deepseek',
      accessType: 'standard-api',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-chat',
      apiKeyHint: '••••7A9F',
      status: 'connected',
      lastTestedAt: '2026-07-30T01:02:03.000Z',
      capabilityOverride: null,
    }],
    selectionTranslation: {
      ...emptySettings.selectionTranslation,
      connectionId: '11111111-1111-4111-8111-111111111111',
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      targetLanguage: 'zh-CN',
    },
  }

  render(<LargeModelSettingsSection onManage={() => undefined} settings={settings} />)

  const translation = screen.getByRole('group', { name: '划词翻译' })
  const summary = within(translation).getByRole('group', { name: '当前划词翻译模型' })

  expect(within(translation).getByRole('status', { name: '连接正常' })).toBeVisible()
  expect(within(translation).getByText('DeepSeek / 主翻译模型')).toBeVisible()
  expect(within(translation).getByText('deepseek-chat')).toBeVisible()
  expect(within(translation).getByText('默认')).toBeVisible()
  expect(within(translation).getByText('简体中文')).toBeVisible()
  expect(translation.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
  expect(summary).toHaveAttribute('data-ui-selectable', 'true')
  expect(summary).toHaveAttribute('tabindex', '0')
  expect(summary.querySelectorAll('[tabindex]')).toHaveLength(0)
  expect(summary.querySelectorAll('dd[data-ui-selectable="true"]')).toHaveLength(0)
  expect(screen.queryByText('尚未配置大模型应用')).not.toBeInTheDocument()
})

it('renders the configured AI conversation summary without a target language field', () => {
  const settings: LargeModelSettings = {
    ...emptySettings,
    connections: [{
      id: '22222222-2222-4222-8222-222222222222',
      name: 'GPT 5',
      provider: 'other',
      accessType: 'standard-api',
      protocol: 'openai',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'gpt-5-mini',
      apiKeyHint: '••••7A9F',
      status: 'connected',
      lastTestedAt: '2026-07-30T01:02:03.000Z',
      capabilityOverride: null,
    }],
    aiConversation: {
      connectionId: '22222222-2222-4222-8222-222222222222',
      thinkingMode: 'enabled' as const, reasoningEffort: 'high',
      writePolicy: 'ask-every-time',
    },
  }

  render(<LargeModelSettingsSection onManage={() => undefined} settings={settings} />)

  const conversation = screen.getByRole('group', { name: 'AI 对话' })
  const summary = within(conversation).getByRole('group', { name: '当前 AI 对话模型' })

  expect(within(conversation).getByRole('status', { name: '连接正常' })).toBeVisible()
  expect(within(conversation).getByText('其他 / GPT 5')).toBeVisible()
  expect(within(conversation).getByText('gpt-5-mini')).toBeVisible()
  expect(within(conversation).getByText('高')).toBeVisible()
  expect(within(conversation).queryByText('目标语言')).toBeNull()
  expect(summary).toHaveAttribute('data-ui-selectable', 'true')
  expect(summary).toHaveAttribute('tabindex', '0')
})

it('focuses the model summary and routes Ctrl+A to that read-only region only', () => {
  const settings: LargeModelSettings = {
    ...emptySettings,
    connections: [{
      id: '11111111-1111-4111-8111-111111111111',
      name: '主翻译模型',
      provider: 'deepseek',
      accessType: 'standard-api',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-chat',
      apiKeyHint: '••••7A9F',
      status: 'connected',
      lastTestedAt: '2026-07-30T01:02:03.000Z',
      capabilityOverride: null,
    }],
    selectionTranslation: {
      ...emptySettings.selectionTranslation,
      connectionId: '11111111-1111-4111-8111-111111111111',
    },
  }
  const { container } = render(
    <div className="app-shell">
      <LargeModelSettingsSection onManage={() => undefined} settings={settings} />
    </div>,
  )
  const shell = container.querySelector<HTMLElement>('.app-shell')!
  const cleanup = installUiSelectionGuard(shell)
  const summary = screen.getByRole('group', { name: '当前划词翻译模型' })

  expect(summary).toHaveAttribute('data-ui-selectable', 'true')
  expect(summary).toHaveAttribute('tabindex', '0')
  summary.focus()
  const event = sendFocusedSelectAll()

  expect(document.activeElement).toBe(summary)
  expect(event.defaultPrevented).toBe(true)
  expect(window.getSelection()?.toString()).toContain('deepseek-chat')
  expect(window.getSelection()?.toString()).not.toContain('管理大模型')

  cleanup()
})
