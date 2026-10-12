import type { ScreenTranslationBlock } from '../../shared/screen-translation'
import { resolveTranslationTargetLanguage } from '../models/translation-target-language'

/** One direction per OCR request, before batching or deduplicating any text. */
export function resolveScreenTranslationTarget(blocks: readonly ScreenTranslationBlock[], configured: string): string {
  if (configured !== 'auto') return configured
  return resolveTranslationTargetLanguage(blocks.map(block => block.text).join('\n'), 'auto', 'text') === 'en' ? 'en' : 'zh'
}
