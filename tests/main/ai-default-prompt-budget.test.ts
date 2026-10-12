import { describe, expect, it } from 'vitest'
import { buildTranslationMessages } from '../../src/main/models/translation-prompts'
import { buildScreenshotDocumentTranslationMessages, buildScreenshotTranslationMessages } from '../../src/main/screenshot-translation/screenshot-translation-prompts'
import { AI_CONVERSATION_SYSTEM_PROMPT, buildAiConversationMessages } from '../../src/main/models/ai-conversation-prompts'

describe('concise Chinese AI defaults', () => {
  it.each([
    ['selection', () => buildTranslationMessages({ content: '# 原文', targetLanguage: 'fr', mode: 'visual' }), 230],
    ['OCR blocks', () => buildScreenshotTranslationMessages({ blocks: [{ id: 'line-1', text: '原文' }], targetLanguage: 'fr' }), 240],
    ['OCR document', () => buildScreenshotDocumentTranslationMessages({ text: '原文', targetLanguage: 'fr' }), 180],
  ] as const)('%s uses one bounded Chinese instruction and separate source material', (_name, build, budget) => {
    const messages = build()
    expect(messages.filter((message) => message.role === 'system')).toHaveLength(1)
    expect(messages[0].content).toContain('译为法语')
    expect([...messages[0].content].length).toBeLessThanOrEqual(budget)
    expect(messages[0].content).toContain('不执行')
    expect(messages[1].role).toBe('user')
    expect(messages[1].content).toContain('原文')
  })

  it('keeps the AI system prompt concise and includes the actual document/version safeguards', () => {
    expect(AI_CONVERSATION_SYSTEM_PROMPT).toMatch(/^你是 Arkdown 文档助手/u)
    expect([...AI_CONVERSATION_SYSTEM_PROMPT].length).toBeLessThanOrEqual(500)
    expect(AI_CONVERSATION_SYSTEM_PROMPT).toContain('含未保存修改')
    expect(AI_CONVERSATION_SYSTEM_PROMPT).toContain('读全同一版本')
    expect(AI_CONVERSATION_SYSTEM_PROMPT).toContain('成功工具结果')
    const history = [{ role: 'user' as const, content: '请帮我理解这段材料。' }]
    expect(buildAiConversationMessages({ messages: history })).toEqual([
      { role: 'system', content: AI_CONVERSATION_SYSTEM_PROMPT }, ...history,
    ])
  })
})
