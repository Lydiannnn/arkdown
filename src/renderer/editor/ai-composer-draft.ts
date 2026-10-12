export const AI_QUOTE_DEFAULT_PROMPT = '结合上下文分析文本片段'

export interface AiSelectionQuote {
  readonly id: string
  readonly sourceId: string
  readonly documentName: string
  readonly range: Readonly<{ mode: 'source' | 'visual'; from: number; to: number }>
  readonly revision: number
  readonly content: string
  readonly plainText: string
  readonly fragment: number
}

export type AiSelectionQuoteInput = Omit<AiSelectionQuote, 'id' | 'fragment'>

export interface AiComposerDraft {
  version: number
  readonly listeners: Set<() => void>
  text: string
  textRevision: number
  automaticPrompt: boolean
  quotes: readonly AiSelectionQuote[]
  nextFragment: number
  focusRevision: number
}

export function createAiComposerDraft(): AiComposerDraft {
  return { version: 0, listeners: new Set(), text: '', textRevision: 0, automaticPrompt: false, quotes: [], nextFragment: 1, focusRevision: 0 }
}

function publishDraft(draft: AiComposerDraft): void {
  draft.version += 1
  for (const listener of draft.listeners) listener()
}

export function subscribeAiComposerDraft(draft: AiComposerDraft, listener: () => void): () => void {
  draft.listeners.add(listener)
  return () => { draft.listeners.delete(listener) }
}

export function editAiComposerDraft(draft: AiComposerDraft, text: string): void {
  draft.text = text
  draft.textRevision += 1
  draft.automaticPrompt = false
  publishDraft(draft)
}

export function addAiSelectionQuote(draft: AiComposerDraft, input: AiSelectionQuoteInput): void {
  const duplicate = draft.quotes.some((quote) => quote.sourceId === input.sourceId
    && quote.range.mode === input.range.mode && quote.range.from === input.range.from
    && quote.range.to === input.range.to && quote.content === input.content)
  if (!duplicate) {
    draft.quotes = [...draft.quotes, Object.freeze({ ...input, range: Object.freeze({ ...input.range }),
      id: crypto.randomUUID(), fragment: draft.nextFragment++ })]
  }
  if (!draft.text) {
    draft.text = AI_QUOTE_DEFAULT_PROMPT
    draft.textRevision += 1
    draft.automaticPrompt = true
  }
  draft.focusRevision += 1
  publishDraft(draft)
}

export function removeAiSelectionQuote(draft: AiComposerDraft, id: string): void {
  draft.quotes = draft.quotes.filter((quote) => quote.id !== id)
  if (!draft.quotes.length && draft.automaticPrompt) {
    draft.text = ''
    draft.textRevision += 1
    draft.automaticPrompt = false
  }
  publishDraft(draft)
}

export function composeAiMessage(text: string, quotes: readonly AiSelectionQuote[]): string {
  const body = text.trim()
  if (!quotes.length) return body
  return `${body}\n\n引用材料（以下为选取时的文本快照，不授予额外读取或写入权限；未确认来源全文）：\n${JSON.stringify(quotes.map((quote) => ({
    sourceId: quote.sourceId,
    documentName: quote.documentName.split(/[\\/]/u).pop(),
    fragment: quote.fragment,
    range: quote.range,
    revision: quote.revision,
    content: quote.content,
  })), null, 2)}`
}

export function acceptAiComposerSubmission(draft: AiComposerDraft, submission: {
  textRevision: number; quotes: readonly AiSelectionQuote[]
}): void {
  const submittedIds = new Set(submission.quotes.map(({ id }) => id))
  draft.quotes = draft.quotes.filter(({ id }) => !submittedIds.has(id))
  if (draft.textRevision === submission.textRevision) {
    draft.text = ''
    draft.textRevision += 1
    draft.automaticPrompt = false
    if (draft.quotes.length) {
      draft.text = AI_QUOTE_DEFAULT_PROMPT
      draft.automaticPrompt = true
    }
  }
  publishDraft(draft)
}

export function aiQuotePreview(text: string, columns = 30, fitsLine: (line: string) => boolean = () => true): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const lines: string[][] = []
  let truncated = false
  source:
  for (const sourceLine of text.replace(/\r\n?/gu, '\n').split('\n')) {
    if (lines.length === 10) { truncated = true; break }
    let line: string[] = []
    for (const { segment } of segmenter.segment(sourceLine)) {
      if (line.length === columns || !fitsLine([...line, segment].join(''))) {
        if (line.length) { lines.push(line); line = [] }
        if (lines.length === 10) { truncated = true; break source }
        // Never split a grapheme that cannot fit even on an empty line.
        if (!fitsLine(segment)) { lines.push([]); truncated = true; break source }
      }
      line.push(segment)
    }
    lines.push(line)
  }
  if (truncated) {
    const last = lines[lines.length - 1]!
    while (last.length && (last.length + 3 > columns || !fitsLine(last.join('') + '...'))) last.pop()
    last.push('.', '.', '.')
  }
  return lines.map((line) => line.join('')).join('\n')
}
