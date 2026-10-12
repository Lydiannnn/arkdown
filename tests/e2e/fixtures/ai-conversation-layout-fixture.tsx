import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AiConversationSidebar } from '../../../src/renderer/editor/AiConversationSidebar'
import { EditorPane } from '../../../src/renderer/editor/EditorPane'
import { TranslationSidebar, type TranslationSidebarView } from '../../../src/renderer/editor/TranslationSidebar'
import type { TranslationHistoryRecord } from '../../../src/renderer/editor/translation-history'
import { EditorRightSidebar } from '../../../src/renderer/editor/EditorRightSidebar'
import { useAiConversation } from '../../../src/renderer/editor/use-ai-conversation'
import { activateWorkspaceAiSession, createWorkspaceAiSessionStore } from '../../../src/renderer/editor/workspace-ai-session-store'
import { ContextMenuProvider } from '../../../src/renderer/context-menu/ContextMenuProvider'
import { PreferencesPage } from '../../../src/renderer/settings/PreferencesPage'
import { ModelPreferenceDraft } from '../../../src/renderer/settings/model-preference-draft'
import { createPreferencePersistence } from '../../../src/renderer/settings/preference-update-queue'
import { DEFAULT_LARGE_MODEL_SETTINGS, type LargeModelSettings } from '../../../src/shared/large-model-settings'
import { modelObservation, modelCommit } from '../../helpers/model-observation'
import type { ModelFeaturePatches } from '../../../src/shared/model-settings-commands'
import type { PublicModelSettingsSnapshot } from '../../../src/shared/settings-observation'
import { DEFAULT_EDITOR_APPEARANCE } from '../../../src/shared/editor-appearance-preferences'
import { DEFAULT_ARKNOTE_PREFERENCES } from '../../../src/shared/arknote-preferences'
import { themeColorRgbChannels } from '../../../src/shared/theme-color'
import '../../../src/renderer/app/styles.css'

const workspace = { workspaceId: 'layout-workspace', workspaceGeneration: 'generation-1' }
const store = createWorkspaceAiSessionStore()
const session = activateWorkspaceAiSession(store, workspace)
session.messages = Array.from({ length: 42 }, (_, index) => ({
  id: `message-${index}`, role: 'assistant' as const,
  content: `Message ${index}: preserved conversation text.\n\n[Website](https://example.com/guide) and [Local note](C:/notes/example.md).`,
}))
session.usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 0, estimated: false }
session.contextWindowTokens = 128_000
const first = {
  id: '11111111-1111-4111-8111-111111111111', name: 'DeepSeek 主模型', provider: 'deepseek' as const,
  accessType: 'standard-api' as const, protocol: 'openai' as const, baseUrl: 'https://api.deepseek.com',
  modelId: location.search.includes('thinking') ? 'deepseek-v4-pro' : 'deepseek-chat', apiKeyHint: '••••TEST', status: 'connected' as const,
  lastTestedAt: null, capabilityOverride: null,
}
let settings: LargeModelSettings = {
  ...DEFAULT_LARGE_MODEL_SETTINGS,
  connections: [first, { ...first, id: '22222222-2222-4222-8222-222222222222', name: '备用模型' }],
  codexCli: { status: 'connected', cliVersion: 'codex-cli test', lastTestedAt: '2026-09-06T00:00:00.000Z' },
  aiConversation: { connectionId: first.id, thinkingMode: 'default' as const, reasoningEffort: 'default', writePolicy: 'ask-every-time' },
}
const ok = async () => ({ ok: true as const, value: null })
let modelRevision = 1
const api = {
  onTranslationEvent: () => () => undefined, cancelTranslation: ok,
  readClipboardFormats: async () => ({ ok: true, value: [] }),
  cancelAiConversation: ok, clearAiConversation: ok, startAiConversation: ok,
  submitAiAuthorizationResult: ok, onAiConversationEvent: () => () => undefined,
  setAiConversationCapabilities: async (input: { capabilities: unknown }) => ({ ok: true, value: input.capabilities }),
  getLargeModelSettings: async () => ({ ok: true, value: settings }),
  getModelSettingsSnapshot: async () => ({ ok: true, value: modelObservation(settings, modelRevision) }),
  setAiConversationSettings: async (input: ModelFeaturePatches['aiConversation'], observed: PublicModelSettingsSnapshot) => {
    if (!observed) throw new Error('Layout fixture requires the original model observation')
    settings = { ...settings, aiConversation: { ...settings.aiConversation, ...input } }
    return { ok: true, value: modelCommit(settings, ++modelRevision) }
  },
}
Object.defineProperty(window, 'arkdown', { value: api, configurable: true })

function Conversation({ configurationState, revision, onSettings, onClose }: {
  configurationState: 'configured' | 'checking' | 'unconfigured'; revision: number; onSettings(): void; onClose(): void
}) {
  const [profile, setProfile] = useState(settings.aiConversation.connectionId)
  const [generating, setGenerating] = useState(false)
  const [, refresh] = useState(0)
  const chat = useAiConversation({ store, workspace, profileFingerprint: profile, contextWindowTokens: 128_000 })
  void revision
  return <><output hidden id="read-authority">{JSON.stringify(session.authoritativeCapabilities)}</output><AiConversationSidebar
    {...chat} status={generating ? 'streaming' : chat.status} configurationState={configurationState} modelConnections={settings.connections}
    thinkingConnection={settings.connections.find(({ id }) => id === settings.aiConversation.connectionId)}
    thinkingPreference={settings.aiConversation}
    onThinkingChange={async (change) => {
      await api.setAiConversationSettings(change, modelObservation(settings, modelRevision))
      refresh((value) => value + 1)
    }}
    selectedModelId={profile} onModelChange={async (connectionId) => {
      await api.setAiConversationSettings({ connectionId }, modelObservation(settings, modelRevision))
      setProfile(connectionId)
    }}
    onClose={onClose} onClear={() => void chat.clearConversation()} onOpenSettings={onSettings} onRetryConfiguration={() => undefined}
    onSend={async () => { setGenerating(true); return true }} onStop={() => setGenerating(false)}
    onCurrentDocumentAccessChange={(value) => void chat.setCurrentDocumentAccess(value)}
    onWorkspaceAccessChange={(value) => void chat.setWorkspaceAccess(value)}
    onWritePolicyChange={(value) => void chat.setWritePolicy(value, modelObservation(settings, modelRevision))}
    onAuthorizationDecision={() => undefined}
    onOpenLink={(target) => { document.querySelector('#link-result')!.textContent = `${target.kind}:${target.target}` }}
  /></>
}

const savedTranslation: TranslationHistoryRecord = {
  id: 'record-1', requestId: 'request-1', documentKey: 'note.md',
  workspaceAbsolutePath: null, documentRelativePath: null, documentAbsolutePath: null, documentRevision: null,
  mode: 'visual', source: { markdown: 'source', plainText: 'source' },
  translatedMarkdown: 'Saved translation from the previous configured model.',
  modelId: 'chat-model', targetLanguage: 'zh-CN', terminal: 'completed', createdAt: 1,
  anchor: { mode: 'visual', from: 1, to: 7, blockStart: 0,
    fingerprint: { before: '', selected: 'source', after: '' }, status: 'valid' },
}

function Fixture() {
  const [modelPreferences] = useState(() => {
    const owner = new ModelPreferenceDraft(createPreferencePersistence())
    owner.accept(modelObservation(settings, modelRevision))
    return owner
  })
  const sidebarWidth = location.search.includes('wide') ? 520 : location.search.includes('thinking') ? 240 : 390
  const [open, setOpen] = useState(true)
  const [translationView, setTranslationView] = useState<TranslationSidebarView>({ kind: 'live' })
  const [documentKey, setDocumentKey] = useState(0)
  const [configuration, setConfiguration] = useState<'configured' | 'checking' | 'unconfigured'>('configured')
  const [revision, setRevision] = useState(0)
  const [preferences, setPreferences] = useState(false)
  const [tab, setTab] = useState<'ai-chat' | 'translation' | 'document-view'>('ai-chat')
  if (preferences) return <ContextMenuProvider>
    <div style={{ height: '100vh', display: 'grid' }}>
      <PreferencesPage modelPreferences={modelPreferences} initialAppearance={DEFAULT_EDITOR_APPEARANCE} initialLargeModels={settings}
        initialArknote={DEFAULT_ARKNOTE_PREFERENCES} initialSearch={{ provider: 'bing', customTemplate: '' }}
        systemFonts={['Arial']} onAppearanceChange={() => undefined} onSearchChange={() => undefined}
        onArknoteChange={() => undefined} onClose={() => setPreferences(false)} />
    </div>
  </ContextMenuProvider>
  return <ContextMenuProvider>
    <div className="fixture-controls">
      <button onClick={() => { setConfiguration('checking'); setDocumentKey((value) => value + 1) }}>切换文档并检查</button>
      <button onClick={() => setConfiguration('configured')}>配置检查完成</button>
      <button onClick={() => { setConfiguration('unconfigured'); setOpen(true) }}>未配置模型</button>
      <button onClick={() => { session.messages = [...session.messages, { id: `latest-${revision}`, role: 'assistant', content: `Latest message ${revision}` }]; setRevision((value) => value + 1) }}>新增消息</button>
      <button onClick={() => setPreferences(true)}>偏好设置</button>
      {location.search.includes('theme') && <input aria-label="验收主题颜色" type="color" defaultValue="#800080"
        onChange={(event) => document.body.style.setProperty('--theme-color-rgb', themeColorRgbChannels(event.target.value))} />}
      <output id="link-result" />
    </div>
    <div style={{ height: 720, width: sidebarWidth, margin: '20px auto', display: 'flex' }}>
      <EditorRightSidebar open={open} activeTab={tab} containerWidth={location.search.includes('wide') ? 1560 : 1170} initialWidth={sidebarWidth} onActiveTabChange={setTab} panels={{
        'ai-chat': <Conversation key={documentKey} configurationState={configuration} revision={revision} onClose={() => setOpen(false)} onSettings={() => setPreferences(true)} />, translation: <TranslationSidebar
          thinkingConnection={first} thinkingPreference={settings.selectionTranslation}
          onThinkingChange={(change) => { settings = { ...settings, selectionTranslation: { ...settings.selectionTranslation, ...change } }; setRevision((value) => value + 1) }}
          state={location.search.includes('thinking') ? { requestId: null, status: 'completed', output: 'Existing translation', errorCode: null, error: null } : { requestId: null, status: 'failed', output: '', errorCode: 'MODEL_NOT_CONFIGURED', error: '未配置' }}
          view={translationView} historyRecords={[savedTranslation]} historyRecordId={savedTranslation.id}
          onOpenHistory={(recordId) => setTranslationView({ kind: 'history', recordId })}
          onReturnToLive={() => setTranslationView({ kind: 'live' })}
          mode="visual" selectionTop={410} surfaceTop={0} alignmentHeight={680} resultHeight={140}
          onTranslate={() => undefined} onStop={() => undefined} onCopy={() => undefined} onClose={() => setOpen(false)} onOpenSettings={() => setPreferences(true)}
        />,
      }} />
    </div>
  </ContextMenuProvider>
}
function SelectionFixture() {
  const [documentName, setDocumentName] = useState('A.md')
  const [markdown, setMarkdown] = useState('# 引用验收\n\n选择这段原始文本加入 AI 对话。👨‍👩‍👧‍👦\n\n' +
    (location.search.includes('complex') ? '长引用文本' + '😀\u200d😀文👨‍👩‍👧‍👦é'.repeat(80) : '长引用文本'.repeat(80) + '👨‍👩‍👧‍👦'))
  const [sidebar, setSidebar] = useState<{ open: boolean; activeTab: 'ai-chat' | 'translation' | 'document-view' }>({ open: true, activeTab: 'ai-chat' })
  const [dark, setDark] = useState(false)
  const [mounted, setMounted] = useState(true)
  return <>
    <div className="fixture-controls">
      <button onClick={() => window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: 'toggle-source-mode' }))}>切换源码</button>
      <button onClick={() => setDocumentName((name) => name === 'A.md' ? 'B.md' : 'A.md')}>切换来源文档</button>
      <button onClick={() => setMounted((value) => !value)}>设置往返</button>
      <button onClick={() => setSidebar((current) => ({ ...current, open: !current.open }))}>收起展开</button>
      <button onClick={() => { setDark((value) => !value)
        document.body.style.setProperty('--text-primary', dark ? '#171717' : '#eeeeee')
        document.body.style.setProperty('--text-secondary', dark ? '#666666' : '#aaaaaa')
        document.body.style.setProperty('--surface-raised', dark ? '#ffffff' : '#292929')
        document.body.style.setProperty('--surface-background', dark ? '#ffffff' : '#202020')
        document.body.style.setProperty('--control-background', dark ? '#ffffff' : '#292929')
        document.body.style.setProperty('--border-subtle', dark ? '#dddddd' : '#505050')
      }}>浅深主题</button>
    </div>
    <div style={{ height: 735, width: 'calc(100vw - 24px)', margin: 12, background: dark ? '#202020' : '#ffffff' }}>
      {mounted ? <EditorPane documentKey={documentName} documentDisplayName={documentName}
        aiConversationStore={store} markdown={markdown} onChange={setMarkdown}
        rightSidebarWidth={390} rightSidebarState={sidebar}
        onOpenRightSidebar={(activeTab) => setSidebar({ open: true, activeTab })}
        onCloseRightSidebar={() => setSidebar((current) => ({ ...current, open: false }))}
        onOpenLargeModelSettings={() => setMounted(false)} /> : <p>设置页面</p>}
    </div>
  </>
}

createRoot(document.querySelector('#fixture-root')!).render(
  location.search.includes('selection') ? <SelectionFixture /> : <Fixture />,
)
