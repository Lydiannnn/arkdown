import { parseScreenTranslationBlocks, type ScreenTranslationBlock, type ScreenTranslationPreferences } from '../../shared/screen-translation'
import type { ScreenTranslationWorker } from './worker-client'
import { resolveScreenTranslationTarget } from './target-language'

/** Keep auto direction in the host; the packaged worker accepts fixed targets. */
export async function readScreenTranslationBlocks(
  worker: Pick<ScreenTranslationWorker, 'request'>,
  image: string,
  preferences: ScreenTranslationPreferences,
  signal: AbortSignal,
  assertCurrentContext: () => void = () => undefined,
): Promise<ScreenTranslationBlock[]> {
  signal.throwIfAborted()
  const automatic = preferences.target === 'auto'
  const fixedBaidu = preferences.backend === 'baidu' && !automatic
  // OCR never translates, but protocol v2 still validates its target field.
  // The placeholder is replaced by a locally resolved target before Baidu use.
  const recognized = await worker.request({ mode: fixedBaidu ? 'translate' : 'ocr', image,
    target: automatic ? 'zh' : preferences.target }, signal)
  signal.throwIfAborted()
  let blocks = parseScreenTranslationBlocks(recognized.blocks)
  if (!blocks) throw new Error('OCR 返回的文字位置不正确，请重试。')
  assertCurrentContext()
  if (automatic && preferences.backend === 'baidu' && blocks.some(block => block.text.trim())) {
    const translated = await worker.request({ mode: 'translate', image,
      target: resolveScreenTranslationTarget(blocks, preferences.target) }, signal)
    signal.throwIfAborted()
    blocks = parseScreenTranslationBlocks(translated.blocks)
    if (!blocks) throw new Error('翻译返回的文字位置不正确，请重试。')
    assertCurrentContext()
  }
  return blocks
}
