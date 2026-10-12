import { describe, expect, it } from 'vitest'
import { acceptAiComposerSubmission, addAiSelectionQuote, aiQuotePreview, AI_QUOTE_DEFAULT_PROMPT,
  composeAiMessage, createAiComposerDraft, editAiComposerDraft, removeAiSelectionQuote,
  type AiSelectionQuoteInput } from '../../src/renderer/editor/ai-composer-draft'

const quote: AiSelectionQuoteInput = { sourceId: 'source-A', documentName: 'A.md', revision: 1,
  range: { mode: 'source', from: 0, to: 3 }, content: '共同文本', plainText: '共同文本' }

describe('AI composer draft', () => {
  it('accumulates sources, deduplicates only the same source/range/content, and keeps immutable snapshots', () => {
    const draft = createAiComposerDraft()
    addAiSelectionQuote(draft, quote)
    addAiSelectionQuote(draft, { ...quote, revision: 2 })
    addAiSelectionQuote(draft, { ...quote, sourceId: 'source-B', documentName: 'B.md' })
    addAiSelectionQuote(draft, { ...quote, range: { ...quote.range, from: 5, to: 8 } })
    addAiSelectionQuote(draft, { ...quote, content: '编辑后的文本' })
    expect(draft.quotes.map(({ content }) => content)).toEqual(['共同文本', '共同文本', '共同文本', '编辑后的文本'])
    expect(draft.quotes.map(({ fragment }) => fragment)).toEqual([1, 2, 3, 4])
    expect(Object.isFrozen(draft.quotes[0])).toBe(true)
    expect(draft.text).toBe(AI_QUOTE_DEFAULT_PROMPT)
  })

  it('removes only untouched automatic text when the last quote is removed', () => {
    const draft = createAiComposerDraft()
    addAiSelectionQuote(draft, quote)
    removeAiSelectionQuote(draft, draft.quotes[0]!.id)
    expect(draft.text).toBe('')
    editAiComposerDraft(draft, '我的问题')
    addAiSelectionQuote(draft, quote)
    expect(draft.text).toBe('我的问题')
    editAiComposerDraft(draft, AI_QUOTE_DEFAULT_PROMPT)
    removeAiSelectionQuote(draft, draft.quotes[0]!.id)
    expect(draft.text).toBe(AI_QUOTE_DEFAULT_PROMPT)
  })

  it('accepts only the frozen submission while newly staged references and text survive', () => {
    const draft = createAiComposerDraft()
    addAiSelectionQuote(draft, quote)
    const submitted = { textRevision: draft.textRevision, quotes: [...draft.quotes] }
    editAiComposerDraft(draft, 'next question')
    addAiSelectionQuote(draft, { ...quote, sourceId: 'source-B' })
    acceptAiComposerSubmission(draft, submitted)
    expect(draft.text).toBe('next question')
    expect(draft.quotes.map(({ sourceId }) => sourceId)).toEqual(['source-B'])
    expect(composeAiMessage(draft.text, draft.quotes)).not.toContain('source-A')
  })

  it('bounds previews by graphemes and preserves full content in the submitted envelope', () => {
    const text = ('文👨‍👩‍👧‍👦é'.repeat(300)) + '\nfinal sentinel'
    const draft = createAiComposerDraft()
    addAiSelectionQuote(draft, { ...quote, content: text, plainText: text })
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    const lines = aiQuotePreview(text).split('\n')
    expect(lines).toHaveLength(10)
    expect(lines.every((line) => [...segmenter.segment(line)].length <= 30)).toBe(true)
    expect(lines[9]).toMatch(/\.\.\.$/u)
    expect(aiQuotePreview('a\nb')).toBe('a\nb')
    expect(aiQuotePreview('文'.repeat(300)).split('\n')[9]).toBe('文'.repeat(30))
    const composed = composeAiMessage('question', draft.quotes)
    const envelope = JSON.parse(composed.slice(composed.indexOf('[\n')))
    expect(envelope[0].content).toBe(text)
    expect(composed.match(/question/gu)).toHaveLength(1)
  })

  it('wraps by measured line width and reserves width for the final ellipsis', () => {
    const wideGrapheme = '😀\u200d😀'
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    const width = (line: string) => [...segmenter.segment(line)]
      .reduce((sum, { segment }) => sum + (segment === wideGrapheme ? 30 : segment === '.' ? 4 : 13), 0)
    const fits = (line: string) => width(line) <= 52
    const lines = aiQuotePreview((wideGrapheme + '文').repeat(30), 30, fits).split('\n')
    expect(lines).toHaveLength(10)
    expect(lines.every(fits)).toBe(true)
    expect(lines.slice(0, 9)).toEqual(Array(9).fill(wideGrapheme + '文'))
    expect(lines[9]).toBe(wideGrapheme + '...')
  })

  it('keeps explicit blank lines and stops before a grapheme wider than the available line', () => {
    const fits = (line: string) => !line.includes('😀') && line.length <= 8
    expect(aiQuotePreview('a\n\nb', 30, fits)).toBe('a\n\nb')
    expect(aiQuotePreview('abc😀\u200d😀tail', 30, fits)).toBe('abc\n...')
  })
})
