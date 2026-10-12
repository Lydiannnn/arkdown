import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LARGE_MODEL_SETTINGS,
  migrateLargeModelSettings,
  normalizeLargeModelSettings,
  parseCodexCliConnectionTestResult,
  parseLargeModelSettings,
  parseModelCapabilityOverride,
  parseReasoningEffort,
  type LargeModelSettings,
} from '../../src/shared/large-model-settings'

  const connectedCodex = {
    cliVersion: 'codex-cli 0.144.1',
    status: 'connected',
    lastTestedAt: '2026-09-01T00:00:00.000Z',
  } as const

  const versionThreeSettings = (codexCli: unknown = connectedCodex) => ({
    version: 6,
    codexCli,
    connections: [],
    selectionTranslation: DEFAULT_LARGE_MODEL_SETTINGS.selectionTranslation,
    screenshotTranslation: DEFAULT_LARGE_MODEL_SETTINGS.screenshotTranslation,
    aiConversation: DEFAULT_LARGE_MODEL_SETTINGS.aiConversation,
  })

const CONNECTION_ID = '550e8400-e29b-41d4-a716-446655440000'
const AI_CONNECTION_ID = '550e8400-e29b-41d4-a716-446655440001'

// Literal persisted shapes: v3 was independently shipped by the CLI and AI branches.
const CLI_V3_FIXTURE = {
  version: 3,
  codexCli: { cliVersion: 'codex-cli 0.100.0', status: 'connected', lastTestedAt: '2026-09-06T08:00:00.000Z' },
  connections: [{
    id: '550e8400-e29b-41d4-a716-446655440000', name: 'Saved API', provider: 'other',
    accessType: 'standard-api', protocol: 'anthropic', baseUrl: 'https://api.example.com/v1',
    modelId: 'saved-model', apiKeyHint: '••••ABCD', status: 'connected',
    lastTestedAt: '2026-09-05T08:00:00.000Z',
  }],
  selectionTranslation: { connectionId: '550e8400-e29b-41d4-a716-446655440000', reasoningEffort: 'high', targetLanguage: 'fr', privacyNoticeAccepted: true },
  screenshotTranslation: { connectionId: '550e8400-e29b-41d4-a716-446655440000', reasoningEffort: 'medium', targetLanguage: 'ja' },
}

const AI_V3_FIXTURE = {
  version: 3,
  connections: [{
    id: '550e8400-e29b-41d4-a716-446655440000', name: 'Saved API', provider: 'other',
    accessType: 'standard-api', protocol: 'anthropic', baseUrl: 'https://api.example.com/v1',
    modelId: 'saved-model', apiKeyHint: '••••ABCD', status: 'connected',
    lastTestedAt: '2026-09-05T08:00:00.000Z',
  }],
  selectionTranslation: { connectionId: '550e8400-e29b-41d4-a716-446655440000', reasoningEffort: 'high', targetLanguage: 'fr', privacyNoticeAccepted: true },
  screenshotTranslation: { connectionId: '550e8400-e29b-41d4-a716-446655440000', reasoningEffort: 'medium', targetLanguage: 'ja' },
  aiConversation: { connectionId: '550e8400-e29b-41d4-a716-446655440000', reasoningEffort: 'high' },
}

const AI_V4_FIXTURE = {
  version: 4,
  connections: [{
    id: '550e8400-e29b-41d4-a716-446655440000', name: 'Saved API', provider: 'other',
    accessType: 'standard-api', protocol: 'anthropic', baseUrl: 'https://api.example.com/v1',
    modelId: 'saved-model', apiKeyHint: '••••ABCD', status: 'connected',
    lastTestedAt: '2026-09-05T08:00:00.000Z',
    capabilityOverride: { contextWindowTokens: 200000, maxInputTokens: 180000, maxOutputTokens: 20000 },
  }],
  selectionTranslation: { connectionId: '550e8400-e29b-41d4-a716-446655440000', reasoningEffort: 'high', targetLanguage: 'fr', privacyNoticeAccepted: true },
  screenshotTranslation: { connectionId: '550e8400-e29b-41d4-a716-446655440000', reasoningEffort: 'medium', targetLanguage: 'ja' },
  aiConversation: { connectionId: '550e8400-e29b-41d4-a716-446655440000', reasoningEffort: 'max', writePolicy: 'workspace-grant' },
}

const COMBINED_V5_FIXTURE = {
  version: 5,
  codexCli: { cliVersion: 'codex-cli 0.100.0', status: 'not-logged-in', lastTestedAt: '2026-09-06T08:00:00.000Z' },
  connections: [{
    id: '550e8400-e29b-41d4-a716-446655440000', name: 'Saved API', provider: 'other',
    accessType: 'standard-api', protocol: 'anthropic', baseUrl: 'https://api.example.com/v1',
    modelId: 'saved-model', apiKeyHint: '••••ABCD', status: 'connected',
    lastTestedAt: '2026-09-05T08:00:00.000Z',
    capabilityOverride: { contextWindowTokens: 200000, maxInputTokens: 180000, maxOutputTokens: 20000 },
  }],
  selectionTranslation: { connectionId: '550e8400-e29b-41d4-a716-446655440000', reasoningEffort: 'high', targetLanguage: 'fr', privacyNoticeAccepted: true },
  screenshotTranslation: { connectionId: '550e8400-e29b-41d4-a716-446655440000', reasoningEffort: 'medium', targetLanguage: 'ja' },
  aiConversation: { connectionId: '550e8400-e29b-41d4-a716-446655440000', reasoningEffort: 'max', writePolicy: 'document-grant' },
}

describe('combined settings exact-shape migration', () => {
  it.each([
    ['CLI-v3', CLI_V3_FIXTURE, null, 'default', 'ask-every-time', null,
      { cliVersion: 'codex-cli 0.100.0', status: 'connected', lastTestedAt: '2026-09-06T08:00:00.000Z' }],
    ['AI-v3', AI_V3_FIXTURE, '550e8400-e29b-41d4-a716-446655440000', 'high', 'ask-every-time', null, null],
    ['AI-v4', AI_V4_FIXTURE, '550e8400-e29b-41d4-a716-446655440000', 'max', 'workspace-grant',
      { contextWindowTokens: 200000, maxInputTokens: 180000, maxOutputTokens: 20000 }, null],
    ['combined-v5', COMBINED_V5_FIXTURE, '550e8400-e29b-41d4-a716-446655440000', 'max', 'document-grant',
      { contextWindowTokens: 200000, maxInputTokens: 180000, maxOutputTokens: 20000 },
      { cliVersion: 'codex-cli 0.100.0', status: 'not-logged-in', lastTestedAt: '2026-09-06T08:00:00.000Z' }],
  ])('preserves every persisted assignment and connection field from %s', (
    _name, input, aiConnectionId, aiReasoning, writePolicy, capabilityOverride, codexCli,
  ) => {
    expect(normalizeLargeModelSettings(input)).toEqual({
      version: 6,
      codexCli,
      connections: [{
        id: '550e8400-e29b-41d4-a716-446655440000', name: 'Saved API', provider: 'other',
        accessType: 'standard-api', protocol: 'anthropic', baseUrl: 'https://api.example.com/v1',
        modelId: 'saved-model', apiKeyHint: '••••ABCD', status: 'connected',
        lastTestedAt: '2026-09-05T08:00:00.000Z', capabilityOverride,
      }],
      selectionTranslation: { connectionId: '550e8400-e29b-41d4-a716-446655440000', thinkingMode: 'enabled', reasoningEffort: 'high', targetLanguage: 'fr', privacyNoticeAccepted: true },
      screenshotTranslation: { connectionId: '550e8400-e29b-41d4-a716-446655440000', thinkingMode: 'enabled', reasoningEffort: 'medium', targetLanguage: 'ja' },
      aiConversation: { connectionId: aiConnectionId, thinkingMode: aiReasoning === 'default' ? 'default' : 'enabled', reasoningEffort: aiReasoning, writePolicy },
    })
  })

  it('accepts only the combined version on the current IPC schema', () => {
    expect(parseLargeModelSettings(normalizeLargeModelSettings(COMBINED_V5_FIXTURE))).toBeDefined()
    for (const historical of [CLI_V3_FIXTURE, AI_V3_FIXTURE, AI_V4_FIXTURE, COMBINED_V5_FIXTURE]) {
      expect(parseLargeModelSettings(historical)).toBeUndefined()
      expect(migrateLargeModelSettings(historical)).toBeDefined()
    }
  })

  it.each([
    { ...CLI_V3_FIXTURE, aiConversation: AI_V3_FIXTURE.aiConversation },
    { ...AI_V3_FIXTURE, aiConversation: AI_V4_FIXTURE.aiConversation },
    { ...AI_V4_FIXTURE, codexCli: null },
    { ...AI_V4_FIXTURE, connections: AI_V3_FIXTURE.connections },
    { ...CLI_V3_FIXTURE, codexCli: { ...CLI_V3_FIXTURE.codexCli, token: 'private' } },
    { ...AI_V3_FIXTURE, aiConversation: { ...AI_V3_FIXTURE.aiConversation, connectionId: '550e8400-e29b-41d4-a716-446655440001' } },
    { ...COMBINED_V5_FIXTURE, codexCli: { ...COMBINED_V5_FIXTURE.codexCli, status: 'unknown' } },
    { ...COMBINED_V5_FIXTURE, aiConversation: { ...COMBINED_V5_FIXTURE.aiConversation, writePolicy: 'always-write' } },
  ])('rejects malformed and cross-version hybrid shapes %#', (input) => {
    expect(parseLargeModelSettings(input)).toBeUndefined()
    expect(migrateLargeModelSettings(input)).toBeUndefined()
  })
})

function settingsWithBaseUrl(baseUrl: string): LargeModelSettings {
  return {
    version: 6 as const,
    codexCli: null,
    connections: [{
      id: CONNECTION_ID,
      name: 'Connection',
      provider: 'other' as const,
      accessType: 'standard-api' as const,
      protocol: 'openai' as const,
      baseUrl,
      modelId: 'model',
      apiKeyHint: '••••',
      status: 'untested' as const,
      lastTestedAt: null,
      capabilityOverride: null,
    }],
    selectionTranslation: {
      connectionId: null,
      thinkingMode: 'default' as const, reasoningEffort: 'default' as const,
      targetLanguage: 'auto' as const,
      privacyNoticeAccepted: false,
    },
    screenshotTranslation: {
      connectionId: null,
      thinkingMode: 'default' as const, reasoningEffort: 'default' as const,
      targetLanguage: 'auto' as const,
    },
    aiConversation: {
      connectionId: null,
      thinkingMode: 'default' as const, reasoningEffort: 'default' as const,
      writePolicy: 'ask-every-time' as const,
    },
  }
}

function version2Settings() {
  return {
    version: 2 as const,
    connections: [{
      id: CONNECTION_ID,
      name: 'Connection',
      provider: 'other' as const,
      accessType: 'standard-api' as const,
      protocol: 'openai' as const,
      baseUrl: 'https://api.example.com/v1',
      modelId: 'model',
      apiKeyHint: '••••',
      status: 'untested' as const,
      lastTestedAt: null,
    }],
    selectionTranslation: {
      connectionId: CONNECTION_ID,
      reasoningEffort: 'low' as const,
      targetLanguage: 'fr' as const,
      privacyNoticeAccepted: true,
    },
    screenshotTranslation: {
      connectionId: null,
      reasoningEffort: 'off' as const,
      targetLanguage: 'auto' as const,
    },
  }
}

describe('large model settings', () => {
  it('normalizes an absent value to the public defaults', () => {
    expect(normalizeLargeModelSettings(undefined)).toMatchObject({
      version: 6,
      codexCli: null,
      connections: [],
      selectionTranslation: {
        connectionId: null,
        thinkingMode: 'disabled', reasoningEffort: 'low',
        targetLanguage: 'auto',
        privacyNoticeAccepted: false,
      },
      screenshotTranslation: {
        connectionId: null,
        thinkingMode: 'disabled', reasoningEffort: 'low',
        targetLanguage: 'auto',
      },
      aiConversation: {
        connectionId: null,
        thinkingMode: 'default', reasoningEffort: 'default',
        writePolicy: 'ask-every-time',
      },
    })
  })

  it('parses an exact version-three Codex CLI summary as an independent public value', () => {
    const source = versionThreeSettings()

    const parsed = parseLargeModelSettings(source)

    expect(parsed).toEqual({
      ...source,
      codexCli: connectedCodex,
    })
    expect(parsed?.codexCli).not.toBe(source.codexCli)
  })

  it.each([
    ['unknown status', { ...connectedCodex, status: 'offline' }],
    ['padded CLI version', { ...connectedCodex, cliVersion: ' codex-cli 0.144.1 ' }],
    ['non-ISO timestamp', { ...connectedCodex, lastTestedAt: '2026-09-01T00:00:00Z' }],
    ['extra own key', { ...connectedCodex, diagnostic: 'private' }],
  ])('rejects a Codex CLI summary with %s', (_label, codexCli) => {
    expect(parseLargeModelSettings(versionThreeSettings(codexCli))).toBeUndefined()
  })

  it('rejects inherited version-three Codex CLI settings', () => {
    const inherited = Object.create(versionThreeSettings())

    expect(parseLargeModelSettings(inherited)).toBeUndefined()
  })

  it('migrates exact version-two settings directly to version three without a Codex card', () => {
    const legacy = {
      version: 2,
      connections: [],
      selectionTranslation: { connectionId: null, reasoningEffort: 'off', targetLanguage: 'auto', privacyNoticeAccepted: false },
      screenshotTranslation: { connectionId: null, reasoningEffort: 'off', targetLanguage: 'auto' },
    }

    expect(migrateLargeModelSettings(legacy)).toMatchObject({
      version: 6,
      codexCli: null,
      connections: [],
    })
  })

  it('parses an exact Codex CLI test result with an independent settings copy', () => {
    const source = versionThreeSettings()

    const result = parseCodexCliConnectionTestResult({ status: 'connected', settings: source }) as {
      status: string
      settings: typeof source
    } | undefined

    expect(result).toEqual({
      status: 'connected',
      settings: source,
    })
    expect(result?.settings).not.toBe(source)
  })

  it.each([
    [
      'a connected result without a connected summary',
      { status: 'connected', settings: versionThreeSettings(null) },
    ],
    [
      'a connected result with a failed summary',
      {
        status: 'connected',
        settings: versionThreeSettings({ ...connectedCodex, status: 'timeout' }),
      },
    ],
    [
      'a failed result with a differently failed summary',
      {
        status: 'not-logged-in',
        settings: versionThreeSettings({ ...connectedCodex, status: 'timeout' }),
      },
    ],
  ])('rejects %s', (_label, value) => {
    expect(parseCodexCliConnectionTestResult(value)).toBeUndefined()
  })

  it.each([
    [
      'a first failed test without a persisted summary',
      { status: 'not-found', settings: versionThreeSettings(null) },
    ],
    [
      'a failed re-test with the same persisted status',
      {
        status: 'timeout',
        settings: versionThreeSettings({ ...connectedCodex, status: 'timeout' }),
      },
    ],
  ])('accepts %s', (_label, value) => {
    expect(parseCodexCliConnectionTestResult(value)).toEqual(value)
  })

  it.each([
    ['unknown status', { status: 'offline', settings: versionThreeSettings() }],
    ['extra own key', { status: 'connected', settings: versionThreeSettings(), diagnostic: 'private' }],
    ['malformed settings', { status: 'connected', settings: { ...versionThreeSettings(), rawOutput: 'private' } }],
  ])('rejects a Codex CLI test result with %s', (_label, value) => {
    expect(parseCodexCliConnectionTestResult(value)).toBeUndefined()
  })

  it('migrates exact version-one settings to independent screenshot settings and an unassigned AI conversation', () => {
    const legacy = {
      version: 1,
      connections: [],
      selectionTranslation: {
        connectionId: null,
        reasoningEffort: 'low' as const,
        targetLanguage: 'fr' as const,
        privacyNoticeAccepted: true,
      },
    }

    const migrated = normalizeLargeModelSettings(legacy)

    expect(migrated).toMatchObject({
      version: 6,
      codexCli: null,
      selectionTranslation: legacy.selectionTranslation,
      screenshotTranslation: {
        connectionId: null,
        reasoningEffort: 'low',
        targetLanguage: 'fr',
      },
      aiConversation: {
        connectionId: null,
        thinkingMode: 'default', reasoningEffort: 'default',
        writePolicy: 'ask-every-time',
      },
    })
    expect(migrated.screenshotTranslation).not.toBe(migrated.selectionTranslation)
  })

  it('migrates version 2 settings without silently assigning an AI model', () => {
    const legacy = version2Settings()

    expect(normalizeLargeModelSettings(legacy)).toEqual({
      ...legacy,
      selectionTranslation: { ...legacy.selectionTranslation, thinkingMode: 'enabled' },
      screenshotTranslation: { ...legacy.screenshotTranslation, thinkingMode: 'disabled', reasoningEffort: 'low' },
      version: 6,
      codexCli: null,
      connections: legacy.connections.map((connection) => ({
        ...connection,
        capabilityOverride: null,
      })),
      aiConversation: {
        connectionId: null,
        thinkingMode: 'default', reasoningEffort: 'default',
        writePolicy: 'ask-every-time',
      },
    })
  })

  it('migrates v3 AI settings to v5 without persisting a grant', () => {
    const { codexCli: _codexCli, ...aiSettings } = settingsWithBaseUrl('https://api.example.com/v1')
    const legacy = {
      ...aiSettings,
      selectionTranslation: { connectionId: null, reasoningEffort: 'off', targetLanguage: 'auto', privacyNoticeAccepted: false },
      screenshotTranslation: { connectionId: null, reasoningEffort: 'off', targetLanguage: 'auto' },
      version: 3,
      connections: settingsWithBaseUrl('https://api.example.com/v1').connections.map((connection) => {
        const { capabilityOverride: _capabilityOverride, ...versionThreeConnection } = connection
        return versionThreeConnection
      }),
      aiConversation: { connectionId: null, reasoningEffort: 'high' },
    }

    const migrated = normalizeLargeModelSettings(legacy)

    expect(migrated.version).toBe(6)
    expect(migrated.connections[0]?.capabilityOverride).toBeNull()
    expect(migrated.aiConversation).toEqual({
      connectionId: null,
      thinkingMode: 'enabled', reasoningEffort: 'high',
      writePolicy: 'ask-every-time',
    })
    expect(migrated.aiConversation).not.toHaveProperty('workspaceGrant')
    expect(migrated.aiConversation).not.toHaveProperty('documentGrants')
  })

  it('accepts max reasoning and rejects unsafe capability overrides', () => {
    expect(parseReasoningEffort('max')).toBe('max')
    expect(parseModelCapabilityOverride({ contextWindowTokens: -1 })).toBeUndefined()
    expect(parseModelCapabilityOverride({
      contextWindowTokens: 100,
      maxInputTokens: 101,
    })).toBeUndefined()
    expect(parseModelCapabilityOverride({
      contextWindowTokens: 100,
      maxOutputTokens: 101,
    })).toBeUndefined()
    expect(parseModelCapabilityOverride({
      contextWindowTokens: 100,
      extra: 1,
    })).toBeUndefined()
    expect(parseModelCapabilityOverride({
      contextWindowTokens: 100,
      maxInputTokens: undefined,
    })).toBeUndefined()
    expect(parseModelCapabilityOverride({
      contextWindowTokens: 100,
      maxOutputTokens: undefined,
    })).toBeUndefined()
    expect(parseModelCapabilityOverride(Object.create({ contextWindowTokens: 100 }))).toBeUndefined()
  })

  it('rejects unsupported schema versions', () => {
    expect(parseLargeModelSettings({
      ...settingsWithBaseUrl('https://api.example.com/v1'),
      version: 7,
    })).toBeUndefined()
  })

  it('rejects an AI conversation connection that is not in connections', () => {
    expect(parseLargeModelSettings({
      ...settingsWithBaseUrl('https://api.example.com/v1'),
      aiConversation: {
        connectionId: AI_CONNECTION_ID,
        thinkingMode: 'enabled',
        reasoningEffort: 'high',
        writePolicy: 'ask-every-time',
      },
    })).toBeUndefined()
  })

  it('rejects unsupported reasoning effort values', () => {
    expect(parseLargeModelSettings({
      ...settingsWithBaseUrl('https://api.example.com/v1'),
      selectionTranslation: {
        connectionId: null,
        thinkingMode: 'default',
        reasoningEffort: 'extreme',
        targetLanguage: 'en',
        privacyNoticeAccepted: false,
      },
    })).toBeUndefined()
  })

  it('accepts each supported target language with valid selection settings', () => {
    expect(parseLargeModelSettings({
      ...settingsWithBaseUrl('https://api.example.com/v1'),
      selectionTranslation: {
        connectionId: null,
        thinkingMode: 'disabled', reasoningEffort: 'low',
        targetLanguage: 'ja',
        privacyNoticeAccepted: false,
      },
    })).toBeDefined()
  })

  it('rejects settings with unknown own keys or API key material', () => {
    expect(parseLargeModelSettings({
      ...settingsWithBaseUrl('https://api.example.com/v1'),
      apiKey: 'sk-secret',
    })).toBeUndefined()
  })

  it('rejects external HTTP endpoints while accepting HTTPS endpoints', () => {
    expect(parseLargeModelSettings(settingsWithBaseUrl('http://external.example'))).toBeUndefined()
    expect(parseLargeModelSettings(settingsWithBaseUrl('https://external.example/v1'))).toBeDefined()
  })

  it.each(['http://localhost:11434/v1', 'http://127.0.0.1:11434/v1', 'http://[::1]:11434/v1'])(
    'accepts HTTP loopback endpoints: %s', (baseUrl) => {
      expect(parseLargeModelSettings(settingsWithBaseUrl(baseUrl))).toBeDefined()
    },
  )

  it.each([
    'https://user:password@example.com/v1',
    'https://example.com/v1?token=secret',
    'https://example.com/v1#fragment',
    'file:///local/model',
    'data:text/plain,model',
    'not a url',
  ])('rejects unsafe endpoint URLs: %s', (baseUrl) => {
    expect(parseLargeModelSettings(settingsWithBaseUrl(baseUrl))).toBeUndefined()
  })

  it('rejects non-enumerable and symbol connection keys', () => {
    const hiddenKeySettings = settingsWithBaseUrl('https://example.com')
    Object.defineProperty(hiddenKeySettings.connections[0], 'apiKey', { value: 'sk-secret' })
    expect(parseLargeModelSettings(hiddenKeySettings)).toBeUndefined()

    const symbolKeySettings = settingsWithBaseUrl('https://example.com')
    Object.defineProperty(symbolKeySettings.connections[0], Symbol('apiKey'), { value: 'sk-secret' })
    expect(parseLargeModelSettings(symbolKeySettings)).toBeUndefined()
  })

  it('accepts only complete connection summaries with public fields', () => {
    expect(parseLargeModelSettings({
      version: 6,
      codexCli: null,
      connections: [{
        id: CONNECTION_ID,
        name: 'DeepSeek',
        provider: 'deepseek',
        accessType: 'standard-api',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com',
        modelId: 'deepseek-chat',
        apiKeyHint: '••••abcd',
        status: 'untested',
        lastTestedAt: null,
        capabilityOverride: null,
      }],
      selectionTranslation: {
        connectionId: CONNECTION_ID,
        thinkingMode: 'enabled', reasoningEffort: 'low',
        targetLanguage: 'zh-CN',
        privacyNoticeAccepted: true,
      },
      screenshotTranslation: {
        connectionId: CONNECTION_ID,
        thinkingMode: 'enabled', reasoningEffort: 'low',
        targetLanguage: 'zh-CN',
      },
      aiConversation: {
        connectionId: CONNECTION_ID,
        thinkingMode: 'enabled', reasoningEffort: 'high',
        writePolicy: 'ask-every-time',
      },
    })).toEqual({
      version: 6,
      codexCli: null,
      connections: [{
        id: CONNECTION_ID,
        name: 'DeepSeek',
        provider: 'deepseek',
        accessType: 'standard-api',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com',
        modelId: 'deepseek-chat',
        apiKeyHint: '••••abcd',
        status: 'untested',
        lastTestedAt: null,
        capabilityOverride: null,
      }],
      selectionTranslation: {
        connectionId: CONNECTION_ID,
        thinkingMode: 'enabled', reasoningEffort: 'low',
        targetLanguage: 'zh-CN',
        privacyNoticeAccepted: true,
      },
      screenshotTranslation: {
        connectionId: CONNECTION_ID,
        thinkingMode: 'enabled', reasoningEffort: 'low',
        targetLanguage: 'zh-CN',
      },
      aiConversation: {
        connectionId: CONNECTION_ID,
        thinkingMode: 'enabled', reasoningEffort: 'high',
        writePolicy: 'ask-every-time',
      },
    })
  })

  it('rejects connection summaries with unknown own keys', () => {
    expect(parseLargeModelSettings({
      version: 6,
      codexCli: null,
      connections: [{
        id: CONNECTION_ID,
        name: 'DeepSeek',
        provider: 'deepseek',
        accessType: 'standard-api',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com',
        modelId: 'deepseek-chat',
        apiKeyHint: '••••abcd',
        status: 'untested',
        lastTestedAt: null,
        capabilityOverride: null,
        apiKey: 'sk-secret',
      }],
      selectionTranslation: {
        connectionId: CONNECTION_ID,
        thinkingMode: 'default', reasoningEffort: 'default',
        targetLanguage: 'auto',
        privacyNoticeAccepted: false,
      },
      screenshotTranslation: {
        connectionId: CONNECTION_ID,
        thinkingMode: 'default', reasoningEffort: 'default',
        targetLanguage: 'auto',
      },
      aiConversation: {
        connectionId: CONNECTION_ID,
        thinkingMode: 'default', reasoningEffort: 'default',
        writePolicy: 'ask-every-time',
      },
    })).toBeUndefined()
  })

  it.each([
    'connection',
    '550E8400-E29B-41D4-A716-446655440000',
    '00000000-0000-0000-0000-000000000000',
    '550e8400-e29b-61d4-a716-446655440000',
    '550e8400-e29b-41d4-c716-446655440000',
  ])('rejects a non-canonical connection UUID: %s', (id) => {
    const candidate = settingsWithBaseUrl('https://api.example.com/v1')
    candidate.connections[0]!.id = id
    expect(parseLargeModelSettings(candidate)).toBeUndefined()
  })

  it.each([
    ['name', ' Connection '],
    ['name', ''],
    ['name', 'n'.repeat(121)],
    ['baseUrl', `https://api.example.com/${'x'.repeat(2025)}`],
    ['modelId', ' model '],
    ['modelId', ''],
    ['modelId', 'm'.repeat(513)],
    ['apiKeyHint', 'sk-private'],
  ] as const)('rejects non-canonical or overlong %s', (field, value) => {
    const candidate = settingsWithBaseUrl('https://api.example.com/v1')
    Object.assign(candidate.connections[0]!, { [field]: value })
    expect(parseLargeModelSettings(candidate)).toBeUndefined()
  })

  it('accepts exact field limits and a canonical timestamp', () => {
    const candidate = settingsWithBaseUrl('https://api.example.com/v1')
    candidate.connections[0]!.name = 'n'.repeat(120)
    candidate.connections[0]!.modelId = 'm'.repeat(512)
    candidate.connections[0]!.apiKeyHint = '••••ABCD'
    candidate.connections[0]!.lastTestedAt = '2026-07-30T08:00:00.000Z'

    expect(parseLargeModelSettings(candidate)).toBeDefined()
  })

  it.each([
    'not-a-date',
    '2026-07-30',
    '2026-07-30T08:00:00Z',
    '2026-07-30T08:00:00.000+00:00',
  ])('rejects a non-canonical last-tested timestamp: %s', (lastTestedAt) => {
    const candidate = settingsWithBaseUrl('https://api.example.com/v1')
    candidate.connections[0]!.lastTestedAt = lastTestedAt
    expect(parseLargeModelSettings(candidate)).toBeUndefined()
  })

  it('rejects duplicate connection IDs', () => {
    const candidate = settingsWithBaseUrl('https://api.example.com/v1')
    candidate.connections.push({
      ...candidate.connections[0]!,
      name: 'Duplicate',
    })

    expect(parseLargeModelSettings(candidate)).toBeUndefined()
  })

  it('rejects a feature binding that does not reference a persisted connection', () => {
    const candidate = settingsWithBaseUrl('https://api.example.com/v1')
    candidate.selectionTranslation.connectionId = AI_CONNECTION_ID

    expect(parseLargeModelSettings(candidate)).toBeUndefined()
  })

  it('rejects array subclasses and arrays with extra own properties', () => {
    class ConnectionArray<T> extends Array<T> {}
    const subclassed = settingsWithBaseUrl('https://api.example.com/v1')
    subclassed.connections = new ConnectionArray(...subclassed.connections)
    expect(parseLargeModelSettings(subclassed)).toBeUndefined()

    const extended = settingsWithBaseUrl('https://api.example.com/v1')
    Object.assign(extended.connections, { apiKey: 'sk-private' })
    expect(parseLargeModelSettings(extended)).toBeUndefined()
  })

  it('rejects more than 1000 persisted connections', () => {
    const candidate = settingsWithBaseUrl('https://api.example.com/v1')
    candidate.connections = Array.from({ length: 1001 }, (_, index) => ({
      ...candidate.connections[0]!,
      id: `550e8400-e29b-41d4-a716-${index.toString(16).padStart(12, '0')}`,
      name: `Connection ${index}`,
    }))

    expect(parseLargeModelSettings(candidate)).toBeUndefined()
  })

  it('publishes the exact combined default settings shape', () => {
    expect(DEFAULT_LARGE_MODEL_SETTINGS).toEqual({
      version: 6,
      codexCli: null,
      connections: [],
      selectionTranslation: {
        connectionId: null,
        thinkingMode: 'disabled', reasoningEffort: 'low',
        targetLanguage: 'auto',
        privacyNoticeAccepted: false,
      },
      screenshotTranslation: {
        connectionId: null,
        thinkingMode: 'disabled', reasoningEffort: 'low',
        targetLanguage: 'auto',
      },
      aiConversation: {
        connectionId: null,
        thinkingMode: 'default', reasoningEffort: 'default',
        writePolicy: 'ask-every-time',
      },
    })
  })
})

it.each([
  ['hy', 'https://tokenhub.tencentmaas.com/v1', 'openai'],
  ['hy', 'https://tokenhub.tencentmaas.com/v1', 'anthropic'],
  ['kimi', 'https://api.moonshot.ai/v1', 'openai'],
  ['kimi', 'https://custom.example.com/kimi/v1/', 'openai'],
] as const)('roundtrips saved %s settings without rewriting endpoint %s (%s)', (provider, baseUrl, protocol) => {
  const saved = {
    ...DEFAULT_LARGE_MODEL_SETTINGS,
    connections: [{ ...CLI_V3_FIXTURE.connections[0], provider, baseUrl, protocol, capabilityOverride: null }],
  }
  const parsed = parseLargeModelSettings(JSON.parse(JSON.stringify(saved)))
  expect(parsed).toEqual(saved)
  expect(normalizeLargeModelSettings(saved)).toEqual(saved)
})
