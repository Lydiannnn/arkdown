import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes } from 'mdast'
import type { TargetLanguage } from '../../shared/large-model-settings'

const LETTER = /\p{L}/u
const HAN = /\p{Script=Han}/u
const KANA_OR_HANGUL = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const SENTENCE_OR_QUOTE = /[。！？!?；;."“”‘’「」『』«»]+|\n\s*\n/u
const CHINESE_MAJORITY = 0.6

export const TRANSLATION_LANGUAGE_NAMES: Readonly<Record<Exclude<TargetLanguage, 'auto'>, string>> = {
  'zh-CN': '简体中文', 'zh-TW': '繁体中文', en: '英语', ja: '日语', ko: '韩语',
  fr: '法语', de: '德语', es: '西班牙语', pt: '葡萄牙语', ru: '俄语', it: '意大利语', ar: '阿拉伯语',
}

function markdownProse(markdown: string): string {
  // Front matter is metadata, not prose. Leave an unclosed delimiter untouched.
  const body = markdown.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u, '')
  const text = (node: Nodes): string => {
    if (node.type === 'text') return node.value
    if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? ''
    if (node.type === 'break') return '\n'
    if ('children' in node) {
      const separator = ['root', 'blockquote', 'list', 'listItem'].includes(node.type) ? '\n\n' : ''
      return node.children.map(text).join(separator)
    }
    return ' '
  }
  return text(fromMarkdown(body))
}

function withoutTechnicalSpans(text: string): string {
  return text
    .replace(/\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"“”「」，。；！？]+/giu, ' ')
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/giu, ' ')
    .replace(/\b[a-z]:[\\/][^\s<>"“”「」，。；！？]+/giu, ' ')
    .replace(/\\\\[^\s<>"“”「」，。；！？]+/gu, ' ')
    .replace(/(?<![\p{L}\p{N}])(?:\.{1,2}[\\/]|\/)[^\s<>"“”「」，。；！？]+/gu, ' ')
    .replace(/\b(?:[\w.-]+[\\/])+[\w.-]+\.[a-z0-9]{1,12}\b/giu, ' ')
}

/** Local direction heuristic, not a semantic source-language detector. */
export function resolveTranslationTargetLanguage(
  content: string,
  configured: TargetLanguage,
  format: 'markdown' | 'text' = 'text',
): Exclude<TargetLanguage, 'auto'> {
  if (configured !== 'auto') return configured
  const prose = format === 'markdown' ? markdownProse(content) : content
  const sample = withoutTechnicalSpans(prose.normalize('NFKC'))
  let chinese = 0
  let letters = 0
  for (const unit of sample.split(SENTENCE_OR_QUOTE)) {
    const characters = [...unit].filter((character) => LETTER.test(character))
    letters += characters.length
    // Kana/Hangul ties the Han in this sentence to non-Chinese prose. Single
    // OCR line breaks remain inside the sentence; explicit quotes split it.
    if (!characters.some((character) => KANA_OR_HANGUL.test(character))) {
      chinese += characters.filter((character) => HAN.test(character)).length
    }
  }
  // Pure Han intentionally retains the historical English fallback: isolated
  // 東京/学校 remain ambiguous. Empty/technical-only samples default to Chinese.
  return letters > 0 && chinese / letters > CHINESE_MAJORITY ? 'en' : 'zh-CN'
}
